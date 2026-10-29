/**
 * `hapi stack up` and `hapi stack down` (`mise run up`, `mise run down`): start
 * and stop the stack in stack/compose.yaml (spec §4.3, §11.3-11.5, §11.8).
 * docs/runbooks/stack.md is the operator's procedure.
 *
 * `up`, in order, aborting at the first failure:
 * 1. Run as the `hapi` user. Anyone else re-execs `mise run up` as hapi with
 *    `sudo -u hapi -H -- sh -c '<fixed script>' hapi-stack <args>`, in hapi's
 *    own checkout (~hapi/hapi-factory), with hapi's XDG_RUNTIME_DIR and mise
 *    (`reexecScript`). There is no login shell, so each forwarded argument
 *    stays an argv entry of its own through the re-exec; mise then quotes them
 *    into its task's command line, so they reach hapi's `up` as typed.
 *    HAPI_ALLOW_CURRENT_USER=1 skips the re-exec, for development and the
 *    stage-a tests only: a downgrade (no dedicated user, no rootless Docker)
 *    that it warns about, labels on every container (org.hapi.dev-override),
 *    and Task 6's audit reports (currentUserOverride).
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
 *    inside the proxies' zone_clients ranges. If any check fails, or can't
 *    be made (`docker network inspect` fails, prints something that isn't
 *    JSON, or a subnet doesn't parse), remove what step 4 made
 *    (`compose down`), and stop.
 * 6. `docker compose up -d --wait`: start, and wait until every service is
 *    healthy.
 * Nothing starts unless steps 1-5 pass.
 *
 * `down` is `docker compose -p hapi down`, by project name, so it needs no
 * compose file, build/ or XDG_RUNTIME_DIR: it is kill switch 3 (spec §11.8).
 * It does load the whole CLI (`bun run src/cli.ts`), so it needs a checkout
 * that loads (src/ parses, node_modules installed) and a working mise;
 * without them, use kill switch 3b (docs/runbooks/kill-switches.md). Volumes
 * are kept. With HAPI_ALLOW_CURRENT_USER=1 it stops the dev-bypass stack on
 * the Docker the caller's CLI reaches instead (normally the caller's own), and
 * warns how to stop hapi's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
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
/** hapi's own bin directory, relative to its home; scripts/host-setup.sh installs the pinned mise there. */
export const HAPI_BIN = ".local/bin";
/** hapi's mise, relative to its home (scripts/host-setup.sh's install target; tests/scripts/host-setup.test.ts checks it). */
export const HAPI_MISE = `${HAPI_BIN}/mise`;

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

/**
 * The zone networks of the project as `docker network inspect` prints them.
 * Throws, with inspect's exit code and stderr, when it fails (a daemon error,
 * or a network Compose didn't make), and when its output isn't a JSON array.
 */
async function zoneNetworks(run: Runner, env: Record<string, string>): Promise<unknown[]> {
  const names = ZONE_NETWORKS.map((n) => `${PROJECT}_${n}`);
  const r = await run(["docker", "network", "inspect", ...names], { env, inherit: false });
  if (r.code !== 0) {
    throw new Error(`docker network inspect ${names.join(" ")} exited ${r.code}: ${r.stderr?.trim() || "(no error output)"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) throw new Error(`docker network inspect ${names.join(" ")} printed something that is not a JSON array of networks`);
  return parsed;
}

/**
 * A SHA-256 over the generated files, each path (as given) and its contents, in path order. `up` passes the
 * paths `buildAll` wrote (`build/...`, relative to the checkout). With `root`, each path is read under it but
 * hashed as given, so the audit can compute the same digest for a build it made in a temp dir.
 */
export function buildDigest(paths: string[], root?: string): string {
  const h = createHash("sha256");
  for (const p of [...paths].sort()) h.update(`${p}\0`).update(readFileSync(root === undefined ? p : join(root, p))).update("\0");
  return h.digest("hex");
}

/** Runs a command: with `inherit`, its output goes to the terminal; otherwise stdout and stderr are captured. */
export type Runner = (cmd: string[], o: { env: Record<string, string>; inherit: boolean }) => Promise<{ code: number; stdout: string; stderr?: string }>;

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
  let proc: Bun.Subprocess<"ignore", "pipe" | "inherit", "pipe" | "inherit">;
  const out = o.inherit ? "inherit" : "pipe";
  try {
    proc = Bun.spawn(cmd, { env: o.env, stdin: "ignore", stdout: out, stderr: out });
  } catch {
    throw new Error(`cannot run ${cmd[0]}: is it installed and on PATH?`);
  }
  if (o.inherit) return { code: await proc.exited, stdout: "" };
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  return { code: await proc.exited, stdout, stderr };
};

const definedEnv = (env: Env): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/**
 * The script `sh -c` runs as hapi to re-exec `mise run <task>`. It is fixed text: nothing the caller passes is
 * ever in it. The forwarded arguments follow it on sudo's command line as argv entries of their own, and reach
 * mise as "$@", so no shell parses them on the way to mise: a `$`, a `$(...)`, a backtick, a quote or a space in
 * one arrives as it was typed. mise then quotes them into its task's `run` line for its own `sh -c`; that quoting
 * is mise's, checked by hand once and live in stage b (H-146(e), 2026-10-28), not by a unit test.
 *
 * It sets up what hapi's login shell used to give `sudo -iu` (H-148), and nothing else:
 * - XDG_RUNTIME_DIR, defaulting to hapi's /run/user/<uid> when sudo has cleared it (lingering keeps that, H-004);
 * - hapi's ~/.local/bin first on PATH, as /etc/skel's ~/.profile put it: up's secrets step runs `mise where age`
 *   by name (src/secrets/providers/sops.ts), so hapi's mise must be on PATH, whatever `mise run` adds itself;
 * - the working directory, hapi's checkout;
 * - mise by its absolute path, where scripts/host-setup.sh installs it.
 * `mise run` puts the pinned tools (bun) on the task's PATH itself, from the checkout's mise.toml.
 */
export function reexecScript(task: "up" | "down"): string {
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; export PATH="$HOME/${HAPI_BIN}:$PATH"; cd "$HOME/${HAPI_CHECKOUT}" && exec "$HOME/${HAPI_MISE}" run ${task} -- "$@"`;
}

/**
 * Re-run `mise run <task> -- <args>` as hapi: `sudo -u hapi -H` (HOME is hapi's), never `sudo -i`, whose login
 * shell re-parses the command's words and leaves `$` unescaped (sudo(8)). `reexecScript` is the whole script,
 * and the arguments are its "$@".
 */
async function reexec(task: "up" | "down", args: string[], run: Runner, env: Env, user: string): Promise<number> {
  console.error(
    `hapi stack ${task}: running as ${HAPI_USER} (sudo -u ${HAPI_USER} -H), not ${user}. For development only, HAPI_ALLOW_CURRENT_USER=1 runs it as ${user} instead (docs/runbooks/stack.md).`,
  );
  const r = await run(["sudo", "-u", HAPI_USER, "-H", "--", "sh", "-c", reexecScript(task), "hapi-stack", ...args], { env: definedEnv(env), inherit: true });
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

  // Step 5. Anything that goes wrong here, a check that fails or one that can't be made, removes what step 4
  // created, so nothing is left started or created.
  try {
    const problems = networkProblems(await zoneNetworks(run, composeEnv), PROJECT);
    if (problems.length > 0) throw new Error(problems.join("; "));
  } catch (e) {
    const down = await run(["docker", "compose", "-p", PROJECT, "down"], { env: composeEnv, inherit: true });
    const cleanup =
      down.code === 0
        ? "and what `compose up --no-start` created was removed"
        : `but removing what \`compose up --no-start\` created failed (docker compose -p ${PROJECT} down exited ${down.code}): run \`mise run down\``;
    throw new Error(`${(e as Error).message}. Nothing was started, ${cleanup} (docs/runbooks/stack.md#troubleshooting)`);
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
  if (who.override) {
    // A shell that exported the dev bypass would otherwise stop nothing of hapi's and exit 0, in silence, on the kill-switch path.
    // Compose gets this shell's env, so DOCKER_HOST, DOCKER_CONTEXT or the CLI's current context picks the daemon: say so, not which.
    console.error(
      `hapi stack down: warning: HAPI_ALLOW_CURRENT_USER=1: stopping the dev-bypass stack (Compose project ${PROJECT}) on the Docker daemon this shell's docker CLI reaches, ` +
        `through its DOCKER_HOST, DOCKER_CONTEXT or current context: normally ${who.user}'s own, not ${HAPI_USER}'s. ` +
        `To stop ${HAPI_USER}'s stack, run \`mise run down\` in a shell without HAPI_ALLOW_CURRENT_USER, or use kill switch 3b (docs/runbooks/kill-switches.md#3b-without-a-checkout-or-mise).`,
    );
  }
  const r = await run(["docker", "compose", "-p", PROJECT, "down"], { env: definedEnv(env), inherit: true });
  if (r.code !== 0) throw new Error(`docker compose -p ${PROJECT} down failed (exit ${r.code})`);
  return 0;
}
