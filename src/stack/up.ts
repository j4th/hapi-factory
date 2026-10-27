/**
 * `hapi stack up` and `hapi stack down` (`mise run up`, `mise run down`): start
 * and stop the stack in stack/compose.yaml (spec §4.3, §11.3-11.5, §11.8).
 * docs/runbooks/stack.md is the operator's procedure.
 *
 * `up`, in order, aborting at the first failure:
 * 1. Run as the `hapi` user. Anyone else re-execs `mise run up` as hapi with
 *    `sudo -iu hapi`, in hapi's own checkout (~hapi/hapi-factory), with hapi's
 *    XDG_RUNTIME_DIR. HAPI_ALLOW_CURRENT_USER=1 skips that, for development
 *    and the stage-a tests only: a downgrade (no dedicated user, no rootless
 *    Docker) that it warns about, labels on every container
 *    (org.hapi.dev-override), and Task 6's audit reports (currentUserOverride).
 * 2. `buildAll`: policy/ into build/ (the configs the containers mount), and
 *    its digest (`buildDigest`), a label on every container: Compose recreates
 *    a container whose config changed, not one whose bind-mounted file did, so
 *    this is how a policy change reaches the running stack.
 * 3. Secrets, exactly as `hapi secrets resolve`: the local config
 *    (loadSecretsConfig), its provider (providerFor), then resolveSecrets
 *    into $XDG_RUNTIME_DIR/hapi/env/<zone>.env, all or nothing. A missing
 *    secret, a provider failure or a missing pinned age stops here.
 * 4. `docker compose up --no-start --build`: build the images, create the
 *    networks and containers, start nothing.
 * 5. Check the zone networks Docker made (`networkProblems`): internal, and
 *    inside the proxies' zone_clients ranges. Otherwise remove what step 4
 *    made, and stop.
 * 6. `docker compose up -d --wait`: start, and wait until every service is
 *    healthy.
 * Nothing starts unless steps 1-5 pass.
 *
 * `down` is `docker compose -p hapi down`, by project name, so it needs no
 * compose file, build/ or XDG_RUNTIME_DIR: it is kill switch 3 (spec §11.8)
 * and must work whatever state the checkout is in. Volumes are kept.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { CLIENT_RANGES } from "../generate/egress";
import { buildAll, ROSTERS } from "../generate/index";
import { loadPolicy } from "../policy/load";
import type { RosterName } from "../policy/types";
import { secretsResolve } from "../secrets/cli";
import { cidrContains } from "./cidr";

export type Env = Record<string, string | undefined>;

/** The dedicated host user that runs the stack (spec §4.3, §11.3). */
export const HAPI_USER = "hapi";
/** The Compose project: containers are hapi-<service>-1, networks hapi_<network>. */
export const PROJECT = "hapi";
export const COMPOSE_FILE = "stack/compose.yaml";
/** The zone networks, internal-only; `outbound` is the proxies' way out. */
export const ZONE_NETWORKS = ["hermes-net", "archon-net", "research-net"] as const;
/** hapi's checkout, relative to its home (scripts/host-setup.sh clones it there). */
export const HAPI_CHECKOUT = "hapi-factory";

/** Who is running hapi, and whether the dev bypass is on. */
export interface UserCheck {
  user: string;
  /** The normal case: the hapi user itself. */
  isHapi: boolean;
  /** HAPI_ALLOW_CURRENT_USER=1 as a user other than hapi: the dev-only downgrade. */
  override: boolean;
}

/**
 * Whether `env` turns on the dev bypass for `user` (default: the user this
 * process runs as; $USER is not trusted). Pure given `user`. Only exactly
 * HAPI_ALLOW_CURRENT_USER=1 turns it on, and it means nothing for hapi itself.
 * Task 6's audit uses it (H-024).
 */
export function currentUserOverride(env: Env, user: string = userInfo().username): UserCheck {
  const isHapi = user === HAPI_USER;
  return { user, isHapi, override: !isHapi && env.HAPI_ALLOW_CURRENT_USER === "1" };
}

/** A network as `docker network inspect` prints it (the fields read here). */
interface NetworkInfo {
  Name: string;
  Internal: boolean;
  IPAM?: { Config?: { Subnet?: string }[] | null };
}

/**
 * Problems with the zone networks Docker made for `project`: one that is
 * missing, isn't internal (it would have a route out around its proxy), or
 * has a subnet outside the proxies' `zone_clients` ranges (every request from
 * it would be refused; Docker's default pools are private, a host's
 * default-address-pools may not be). Empty when all is well.
 */
export function networkProblems(networks: unknown[], project: string): string[] {
  const byName = new Map((networks as NetworkInfo[]).map((n) => [n.Name, n]));
  const problems: string[] = [];
  for (const zone of ZONE_NETWORKS) {
    const name = `${project}_${zone}`;
    const n = byName.get(name);
    if (n === undefined) {
      problems.push(`zone network ${name} does not exist`);
      continue;
    }
    if (n.Internal !== true) problems.push(`zone network ${name} is not internal: it would have a route out around the proxy`);
    for (const { Subnet } of n.IPAM?.Config ?? []) {
      if (Subnet !== undefined && !CLIENT_RANGES.some((r) => cidrContains(r, Subnet))) {
        problems.push(
          `zone network ${name} has subnet ${Subnet}, outside the proxies' zone_clients ranges, so its requests would all be refused: set Docker's default-address-pools to private ranges`,
        );
      }
    }
  }
  return problems;
}

/** A SHA-256 over the generated files, each path and its contents, in path order. */
export function buildDigest(paths: string[]): string {
  const h = createHash("sha256");
  for (const p of [...paths].sort()) h.update(`${p}\0`).update(readFileSync(p)).update("\0");
  return h.digest("hex");
}

/** Runs a command: with `inherit`, its output goes to the terminal; otherwise stdout is captured. */
export type Runner = (cmd: string[], o: { env: Record<string, string>; inherit: boolean }) => Promise<{ code: number; stdout: string }>;

/** What `stackUp` and `stackDown` can be given instead of the real thing, for tests. */
export interface StackDeps {
  env?: Env;
  user?: string;
  run?: Runner;
  /** Step 2. Default: buildAll(loadPolicy("policy"), "build", { roster }). */
  build?: (roster: RosterName) => Promise<string[]>;
  /** Step 3, given resolve's args (`--config <file>` or none). Default: `hapi secrets resolve`. */
  resolve?: (args: string[]) => Promise<number>;
}

const runCommand: Runner = async (cmd, o) => {
  let proc: Bun.Subprocess<"ignore", "pipe" | "inherit", "inherit">;
  try {
    proc = Bun.spawn(cmd, { env: o.env, stdin: "ignore", stdout: o.inherit ? "inherit" : "pipe", stderr: "inherit" });
  } catch {
    throw new Error(`cannot run ${cmd[0]}: is it installed and on PATH?`);
  }
  const stdout = o.inherit ? "" : await new Response(proc.stdout as ReadableStream).text();
  return { code: await proc.exited, stdout };
};

const definedEnv = (env: Env): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/** A shell word: single-quoted, with any single quote written as '\''. */
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Re-run `mise run <task> [-- args]` as hapi: `sudo -iu hapi` (a login shell,
 * so hapi's own mise and PATH), in hapi's checkout, with XDG_RUNTIME_DIR set to
 * hapi's runtime dir when sudo has cleared it (lingering keeps it, H-004).
 */
async function reexec(task: "up" | "down", args: string[], run: Runner, env: Env, user: string): Promise<number> {
  console.error(
    `hapi stack ${task}: running as ${HAPI_USER} (sudo -iu ${HAPI_USER}), not ${user}. For development only, HAPI_ALLOW_CURRENT_USER=1 runs it as ${user} instead (docs/runbooks/stack.md).`,
  );
  const tail = args.length > 0 ? ` -- ${args.map(shellQuote).join(" ")}` : "";
  const script = `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; cd "$HOME/${HAPI_CHECKOUT}" && exec mise run ${task}${tail}`;
  const r = await run(["sudo", "-iu", HAPI_USER, "--", "sh", "-c", script], { env: definedEnv(env), inherit: true });
  return r.code;
}

const UP_USAGE = "usage: hapi stack up [--roster budget|anthropic|portable] [--config file]";

function parseUp(args: string[]): { roster: RosterName; config?: string } | undefined {
  const out: { roster: RosterName; config?: string } = { roster: "anthropic" };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!["--roster", "--config"].includes(flag) || seen.has(flag) || value === undefined || value.startsWith("-")) return undefined;
    seen.add(flag);
    if (flag === "--roster") {
      if (!(ROSTERS as readonly string[]).includes(value)) return undefined;
      out.roster = value as RosterName;
    } else out.config = value;
  }
  return out;
}

/** `hapi stack up [--roster name] [--config file]`: see the module comment. Throws on any failure; usage errors return 2. */
export async function stackUp(args: string[], deps: StackDeps = {}): Promise<number> {
  const opts = parseUp(args);
  if (opts === undefined) {
    console.error(UP_USAGE);
    return 2;
  }
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  const who = currentUserOverride(env, deps.user);
  if (!who.isHapi && !who.override) return reexec("up", args, run, env, who.user);
  if (who.override) {
    console.error(
      `hapi stack up: warning: HAPI_ALLOW_CURRENT_USER=1: running the stack as ${who.user}, not ${HAPI_USER}: a dev-only downgrade (no dedicated user, and your own Docker, not hapi's rootless one). The containers are labelled org.hapi.dev-override=1, and hapi audit reports it.`,
    );
  }

  const written = await (deps.build ?? ((roster) => buildAll(loadPolicy("policy"), "build", { roster })))(opts.roster);
  console.log(`policy build: wrote ${written.length} files under build/ (roster ${opts.roster})`);
  const resolved = await (deps.resolve ?? ((a) => secretsResolve(a)))(opts.config === undefined ? [] : ["--config", opts.config]);
  if (resolved !== 0) throw new Error(`hapi secrets resolve exited ${resolved}; nothing was started`);

  const composeEnv = { ...definedEnv(env), HAPI_STARTED_BY: who.user, HAPI_DEV_OVERRIDE: who.override ? "1" : "0", HAPI_BUILD_SHA256: buildDigest(written) };
  const compose = (rest: string[], inherit = true) => run(["docker", "compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...rest], { env: composeEnv, inherit });
  const created = await compose(["up", "--no-start", "--build"]);
  if (created.code !== 0) throw new Error(`docker compose up --no-start failed (exit ${created.code}); nothing was started`);

  const inspect = await run(["docker", "network", "inspect", ...ZONE_NETWORKS.map((n) => `${PROJECT}_${n}`)], { env: composeEnv, inherit: false });
  let networks: unknown[] = [];
  try {
    networks = JSON.parse(inspect.stdout || "[]") as unknown[];
  } catch {
    networks = [];
  }
  const problems = networkProblems(networks, PROJECT);
  if (problems.length > 0) {
    await run(["docker", "compose", "-p", PROJECT, "down"], { env: composeEnv, inherit: true });
    throw new Error(`${problems.join("; ")}. Nothing was started (docs/runbooks/stack.md#troubleshooting)`);
  }

  const up = await compose(["up", "-d", "--wait", "--wait-timeout", "300"]);
  if (up.code !== 0) {
    throw new Error(`the stack did not come up healthy (docker compose exit ${up.code}): see \`docker compose -p ${PROJECT} ps\` and \`docker compose -p ${PROJECT} logs <service>\` (docs/runbooks/stack.md#troubleshooting)`);
  }
  console.log(`the stack is up (Compose project ${PROJECT}): egress-hermes, egress-archon, egress-research, hermes, archon`);
  return 0;
}

/** `hapi stack down`: stop and remove the stack's containers and networks, keeping its volumes. */
export async function stackDown(args: string[], deps: StackDeps = {}): Promise<number> {
  if (args.length > 0) {
    console.error("usage: hapi stack down");
    return 2;
  }
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  const who = currentUserOverride(env, deps.user);
  if (!who.isHapi && !who.override) return reexec("down", args, run, env, who.user);
  const r = await run(["docker", "compose", "-p", PROJECT, "down"], { env: definedEnv(env), inherit: true });
  if (r.code !== 0) throw new Error(`docker compose -p ${PROJECT} down failed (exit ${r.code})`);
  return 0;
}
