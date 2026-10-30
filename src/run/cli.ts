/**
 * The `hapi run` command line (design §3.1): its usage lines and argument
 * parsers, and the host-side defaults of `RunDeps` (./spec.ts): the real
 * docker runners, the run state dir, and the detached supervisor. The commands
 * themselves are ./lifecycle.ts's.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { REPO_ROOT } from "../generate/header";
import { loadPolicy } from "../policy/load";
import { composeServices } from "../stack/compose";
import { definedEnv, type Env, PROJECT, runCommand } from "../stack/up";
import { RUN_ID } from "./records";
import type { RunDeps } from "./spec";

export const START_USAGE = "usage: hapi run start --repo <path> --work-order <file> [--public] [--budget-usd <n>] [--retry-of <run-id>]";
export const STOP_USAGE = "usage: hapi run stop <run-id>";
export const SUPERVISE_USAGE = "usage: hapi run supervise <run-id>";

export interface StartOptions {
  /** A checkout (its .git dir is bound) or a bare repo: the run starts from its HEAD. */
  repo: string;
  workOrder: string;
  /** The operator's assertion that the repo is public (Plan 03's poller sets it from the forge). */
  public: boolean;
  /** Only lowers the work order's budget.usd; a value above it is a usage error, found once the work order is read. */
  budgetUsd?: number;
  /** The last run of the same work order and commit, which ended without succeeding. */
  retryOf?: string;
}

/** `hapi run start`'s flags, each at most once; undefined on any usage error. */
export function parseStart(args: string[]): StartOptions | undefined {
  let repo: string | undefined;
  let workOrder: string | undefined;
  const out: Omit<StartOptions, "repo" | "workOrder"> = { public: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) return undefined;
    seen.add(flag);
    if (flag === "--public") {
      out.public = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith("-")) return undefined;
    if (flag === "--repo") repo = value;
    else if (flag === "--work-order") workOrder = value;
    else if (flag === "--budget-usd") {
      if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) return undefined;
      out.budgetUsd = Number(value);
    } else if (flag === "--retry-of") {
      if (!RUN_ID.test(value)) return undefined;
      out.retryOf = value;
    } else return undefined;
  }
  return repo === undefined || workOrder === undefined ? undefined : { repo, workOrder, ...out };
}

/** The one run id `stop` and `supervise` take, or undefined. */
export function parseRunId(args: string[]): string | undefined {
  return args.length === 1 && RUN_ID.test(args[0]!) ? args[0] : undefined;
}

/** `${XDG_STATE_HOME:-~/.local/state}/hapi/runs`; a relative XDG_STATE_HOME is ignored, as the XDG spec says. */
export function stateDirOf(env: Env): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(env.HOME ?? homedir(), ".local", "state");
  return join(base, "hapi", "runs");
}

/** The real byte runner: stdout read whole as bytes (`arrayBuffer`), never decoded. */
export const runBytes: RunDeps["runBytes"] = async (cmd, env) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error(`cannot run ${cmd[0]}: is it installed and on PATH?`);
  }
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout: new Uint8Array(stdout), stderr };
};

/**
 * Starts `argv` in a session of its own (`detached`, so neither the caller's
 * exit nor its terminal's hangup ends it), from the checkout, with this
 * process's env. "hapi" is this CLI: the same bun and the same src/cli.ts.
 * Its output is appended to `<stateDir>/supervise.log` (0600). Settles once
 * the child has started (its `spawn` event), and rejects with its `error`:
 * `spawn` reports ENOENT, EACCES or EAGAIN that way, after it has returned.
 */
function spawnDetached(root: string, stateDir: string, env: Env): RunDeps["spawnDetached"] {
  return async (argv) => {
    const cmd = argv[0] === "hapi" ? [process.execPath, join(root, "src", "cli.ts"), ...argv.slice(1)] : argv;
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const log = openSync(join(stateDir, "supervise.log"), "a", 0o600);
    try {
      await new Promise<void>((started, failed) => {
        const child = spawn(cmd[0]!, cmd.slice(1), { cwd: root, env: definedEnv(env), detached: true, stdio: ["ignore", log, log] });
        child.once("spawn", started);
        child.once("error", failed);
        child.unref();
      });
    } catch (e) {
      throw new Error(`cannot start ${argv.join(" ")}: ${(e as Error).message}`);
    } finally {
      closeSync(log);
    }
  };
}

/** `p`, with every field it leaves out set to the host's: hapi's project, image, state dir, checkout and policy. */
export async function runDeps(p: Partial<RunDeps>): Promise<RunDeps> {
  const env = p.env ?? process.env;
  const root = p.root ?? REPO_ROOT;
  const project = p.project ?? PROJECT;
  const stateDir = p.stateDir ?? stateDirOf(env);
  const image = p.image ?? (await composeServices(root)).archon?.image;
  if (image === undefined) throw new Error("stack/compose.yaml's archon service has no image: the run container is made from it");
  return {
    run: p.run ?? runCommand,
    runBytes: p.runBytes ?? runBytes,
    env,
    user: p.user ?? userInfo().username,
    now: p.now ?? (() => new Date()),
    project,
    image,
    egress: p.egress ?? `${project}-egress-archon-1`,
    stateDir,
    root,
    buildDir: p.buildDir ?? join(root, "build"),
    packDir: p.packDir ?? join(root, "archon", "workflows", "hapi"),
    runs: p.runs ?? loadPolicy(join(root, "policy")).runs,
    spawnDetached: p.spawnDetached ?? spawnDetached(root, stateDir, env),
  };
}
