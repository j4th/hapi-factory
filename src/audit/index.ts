/**
 * `hapi audit` (`mise run audit`, spec §11.8): the deployed config, the pins,
 * the running stack's settings, the secrets setup and each `--repo`'s GitHub
 * settings, checked against policy. docs/audit.md describes every check: what
 * it verifies, why, the credential it uses, how to fix a failure and what its
 * skip means.
 *
 * `runAudit(ctx)` runs every check in a fixed order and returns one result per
 * check (per repo for the github.* and repo.* checks). A check that throws is
 * a fail with the error (an audit fails closed). Every command goes through
 * `ctx.exec` and every request through `ctx.fetch`. Temp dirs are removed and
 * the audit's own GitHub token revoked when it ends; a revoke GitHub doesn't
 * confirm prints one warning line on stderr (the App and the HTTP status,
 * never the token) and doesn't change the exit code.
 *
 * `hapi audit [--repo owner/name ...] [--strict] [--dev] [--github-token-file
 * path] [--build-dir dir] [--policy dir]` prints one line per check and a
 * summary, and exits 1 if any check fails, 2 on a usage error, else 0.
 * `--strict` makes every skip a fail (stage b, and any scheduled audit).
 */
import { rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { parseOwnerRepo } from "../forge/github/app-token";
import { generatedDrift } from "./checks/generated";
import { githubAppPerms, githubRulesets, repoAiWorkflows } from "./checks/github";
import { mcpToolHashes } from "./checks/mcp";
import { pinsVersions } from "./checks/pins";
import { repoPrivateUntracked } from "./checks/repo";
import { archonEnv, devOverride, hermesNoYolo } from "./checks/runtime";
import { secretsCheck, secretsProvider } from "./checks/secrets";
import { archonValidate, hermesValidate } from "./checks/tools";
import { type AuditContext, type Check, type CheckResult, type Exec, newRun, type RepoRef, result } from "./types";

/** Every check, in the order it runs and prints. */
const CHECKS: readonly (readonly [id: string, check: Check])[] = [
  ["generated.drift", generatedDrift],
  ["runtime.archon-env", archonEnv],
  ["runtime.hermes-no-yolo", hermesNoYolo],
  ["runtime.dev-override", devOverride],
  ["pins.versions", pinsVersions],
  ["tools.archon-validate", archonValidate],
  ["tools.hermes-validate", hermesValidate],
  ["mcp.tool-hashes", mcpToolHashes],
  ["secrets.provider", secretsProvider],
  ["secrets.check", secretsCheck],
  ["github.rulesets", githubRulesets],
  ["github.app-perms", githubAppPerms],
  ["repo.ai-workflows", repoAiWorkflows],
  ["repo.private-untracked", repoPrivateUntracked],
];

export const CHECK_IDS: readonly string[] = CHECKS.map(([id]) => id);

/** An error as one line, never more than 500 characters. */
const oneLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 500);

/** Run every check. With ctx.strict, every skip comes back a fail. */
export async function runAudit(ctx: AuditContext): Promise<CheckResult[]> {
  const run = newRun(ctx);
  const out: CheckResult[] = [];
  try {
    for (const [id, check] of CHECKS) {
      try {
        out.push(...(await check(run)));
      } catch (e) {
        out.push(result(id, "fail", `the check could not run: ${oneLine(e)}`));
      }
    }
  } finally {
    // Each cleanup reports its own trouble (the App-token revoke prints one warning line naming the App and the HTTP
    // status, never the token). One that throws anyway gets a warning line too, and never changes the results.
    for (const undo of run.cleanups.splice(0)) await undo().catch((e: unknown) => console.error(`hapi audit: warning: a cleanup step failed: ${oneLine(e)}`));
    for (const dir of run.temps.splice(0)) await rm(dir, { recursive: true, force: true });
  }
  return ctx.strict ? out.map((r) => (r.status === "skip" ? result(r.id, "fail", `--strict: skipped: ${r.detail}`) : r)) : out;
}

/** The real `exec`: argv, no shell, output captured, killed at the timeout (default 2 minutes). */
export function defaultExec(env: Record<string, string | undefined>): Exec {
  return async (cmd, o = {}) => {
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn(cmd, { env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined)), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      throw new Error(`cannot run ${cmd[0]}: is it installed and on PATH?`);
    }
    const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 120_000);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
}

const USAGE = "usage: hapi audit [--repo owner/name ...] [--strict] [--dev] [--github-token-file path] [--build-dir dir] [--policy dir]";

interface Flags {
  repos: RepoRef[];
  strict: boolean;
  dev: boolean;
  tokenFile?: string;
  buildDir?: string;
  policy?: string;
}

/** Parse the flags, or undefined on a usage error (an unknown flag, a missing value, a bad repo, a flag given twice). */
function parse(args: string[]): Flags | undefined {
  const f: Flags = { repos: [], strict: false, dev: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag !== "--repo" && seen.has(flag)) return undefined;
    seen.add(flag);
    if (flag === "--strict") f.strict = true;
    else if (flag === "--dev") f.dev = true;
    else if (["--repo", "--github-token-file", "--build-dir", "--policy"].includes(flag)) {
      const value = args[++i];
      if (value === undefined || value.startsWith("-")) return undefined;
      if (flag === "--repo") {
        const repo = parseOwnerRepo(value);
        if (repo === undefined) return undefined;
        f.repos.push(repo);
      } else if (flag === "--github-token-file") f.tokenFile = value;
      else if (flag === "--build-dir") f.buildDir = value;
      else f.policy = value;
    } else return undefined;
  }
  return f;
}

/**
 * `hapi audit`: see the module comment. `deps` replaces parts of the context (tests pass fakes); the flags
 * decide `repos`, `strict`, `dev`, the token file, the build dir and the policy dir.
 */
export async function auditCommand(args: string[], deps: Partial<AuditContext> = {}): Promise<number> {
  const f = parse(args);
  if (f === undefined) {
    console.error(USAGE);
    return 2;
  }
  const root = deps.root ?? process.cwd();
  const env = deps.env ?? process.env;
  const ctx: AuditContext = {
    root,
    policyDir: f.policy !== undefined ? resolve(root, f.policy) : (deps.policyDir ?? join(root, "policy")),
    ...(f.buildDir !== undefined ? { buildDir: resolve(root, f.buildDir) } : deps.buildDir !== undefined ? { buildDir: deps.buildDir } : {}),
    repos: f.repos.length > 0 ? f.repos : (deps.repos ?? []),
    strict: f.strict,
    dev: f.dev,
    ...(f.tokenFile !== undefined ? { githubTokenFile: resolve(root, f.tokenFile) } : deps.githubTokenFile !== undefined ? { githubTokenFile: deps.githubTokenFile } : {}),
    env,
    user: deps.user ?? userInfo().username,
    exec: deps.exec ?? defaultExec(env),
    fetch: deps.fetch ?? fetch,
    now: deps.now ?? Date.now,
    ...(deps.secrets !== undefined ? { secrets: deps.secrets } : {}),
  };
  const results = await runAudit(ctx);
  const width = Math.max(...CHECK_IDS.map((id) => id.length));
  for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.id.padEnd(width)}  ${r.detail}`);
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(`hapi audit: ${count("pass")} pass, ${count("fail")} fail, ${count("skip")} skip`);
  return count("fail") > 0 ? 1 : 0;
}
