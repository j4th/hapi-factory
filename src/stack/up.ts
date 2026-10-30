/**
 * `hapi stack up` and `hapi stack down` (`mise run up`, `mise run down`): start
 * and stop the stack in stack/compose.yaml (spec §4.3, §11.3-11.5, §11.8).
 * docs/runbooks/stack.md is the operator's procedure.
 *
 * A run (Plan 02, `hapi run`) is a container of its own, made from the `archon`
 * service of the compose file, on a network of its own that the launcher joins
 * `egress-archon` to; compose does not know it. Every such object carries
 * `RUN_LABEL` and `PROJECT_LABEL`, which is how `up` sees a live run and
 * `removeRuns` (and so `down`) finds what to remove.
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
 * 4. `docker compose build archon` (a profile-only service is built only when
 *    named, spike 07 finding 17), then `docker compose up --no-start --build`:
 *    build the images, create the networks and containers, start nothing.
 * 5. Check the zone networks Docker made (`networkProblems`): internal, and
 *    inside the proxies' zone_clients ranges. If any check fails, or can't
 *    be made (`docker network inspect` fails, prints something that isn't
 *    JSON, or a subnet doesn't parse), remove what step 4 made
 *    (`compose down`), and stop.
 * 6. `docker compose up -d --wait`: start, and wait until every service is
 *    healthy.
 * Nothing starts unless steps 1-5 pass.
 *
 * As the hapi user, and before step 2, `up` refuses if any run container is
 * running (`liveRuns`): recreating egress-archon would cut its egress, and
 * nothing has been built or written yet.
 *
 * `down` is `removeRuns` (the run containers, then egress-archon's hold on each
 * run network, then the run networks and volumes), then `docker compose -p hapi
 * down`, by project name, so it needs no compose file, build/ or
 * XDG_RUNTIME_DIR: it is kill switch 3 (spec §11.8).
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

/** On every run object (container, network, volumes) `hapi run` makes: found by `up`, `down` and the kill switches. */
export const RUN_LABEL = "org.hapi.run";
/** On every run object too: the Compose project it belongs to, so a test project's cleanup never touches hapi's. */
export const PROJECT_LABEL = "org.hapi.project";

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
 * What is wrong with one network as `docker network inspect` prints it, or
 * undefined: it isn't internal (it would have a route out around its proxy),
 * or a subnet is outside the proxies' `zone_clients` ranges (every request
 * from it would be refused; Docker's default pools are private, a host's
 * default-address-pools may not be). Anything that isn't a network is a
 * problem too, never a pass. `up` checks each zone network with it, and
 * `hapi run start` each run's own (src/run/lifecycle.ts).
 */
export function networkProblem(inspect: unknown): string | undefined {
  const n = inspect as Partial<NetworkInfo> | null | undefined;
  if (n === null || typeof n !== "object" || Array.isArray(n) || typeof n.Name !== "string") return "docker network inspect printed something that is not a network";
  const problems: string[] = [];
  if (n.Internal !== true) problems.push(`network ${n.Name} is not internal: it would have a route out around the proxy`);
  for (const { Subnet } of n.IPAM?.Config ?? []) {
    if (Subnet !== undefined && !CLIENT_RANGES.some((r) => cidrContains(r, Subnet))) {
      problems.push(
        `network ${n.Name} has subnet ${Subnet}, outside the proxies' zone_clients ranges, so its requests would all be refused: set Docker's default-address-pools to private ranges`,
      );
    }
  }
  return problems.length === 0 ? undefined : problems.join("; ");
}

/**
 * Problems with the zone networks Docker made for `project`: one that is
 * missing, or that `networkProblem` finds fault with. Empty when all is well.
 */
export function networkProblems(networks: unknown[], project: string): string[] {
  const byName = new Map((networks as NetworkInfo[]).map((n) => [n.Name, n]));
  const problems: string[] = [];
  for (const zone of ZONE_NETWORKS) {
    const name = `${project}_${zone}`;
    const n = byName.get(name);
    const problem = n === undefined ? `network ${name} does not exist` : networkProblem(n);
    if (problem !== undefined) problems.push(`zone ${problem}`);
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

/** The real `Runner`: `Bun.spawn`, stdin closed. `hapi run` uses it too (src/run/cli.ts). */
export const runCommand: Runner = async (cmd, o) => {
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

export const definedEnv = (env: Env): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

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
export function reexecScript(task: "up" | "down" | "hapi"): string {
  return `: "\${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; export PATH="$HOME/${HAPI_BIN}:$PATH"; cd "$HOME/${HAPI_CHECKOUT}" && exec "$HOME/${HAPI_MISE}" run ${task} -- "$@"`;
}

/**
 * Re-run `mise run <task> -- <args>` as hapi: `sudo -u hapi -H` (HOME is hapi's), never `sudo -i`, whose login
 * shell re-parses the command's words and leaves `$` unescaped (sudo(8)). `reexecScript` is the whole script,
 * and the arguments are its "$@". `name` is the command the message names: `hapi run` passes `run <sub>`, with
 * task `hapi` and args `run <sub> ...`.
 */
export async function reexec(task: "up" | "down" | "hapi", args: string[], run: Runner, env: Env, user: string, name = `stack ${task}`): Promise<number> {
  console.error(
    `hapi ${name}: running as ${HAPI_USER} (sudo -u ${HAPI_USER} -H), not ${user}. For development only, HAPI_ALLOW_CURRENT_USER=1 runs it as ${user} instead (docs/runbooks/stack.md).`,
  );
  const r = await run(["sudo", "-u", HAPI_USER, "-H", "--", "sh", "-c", reexecScript(task), "hapi-stack", ...args], { env: definedEnv(env), inherit: true });
  return r.code;
}

/** The `--filter` arguments that select the run objects of `project`, or of its one run `runId`. */
export const runFilters = (project: string, runId?: string): string[] => ["--filter", `label=${RUN_LABEL}${runId === undefined ? "" : `=${runId}`}`, "--filter", `label=${PROJECT_LABEL}=${project}`];

const lines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** The ids (or names) a listing printed, one per line. Throws, naming the command, when it fails. */
export async function listed(run: Runner, env: Env, cmd: string[]): Promise<string[]> {
  const r = await run(cmd, { env: definedEnv(env), inherit: false });
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${r.code}): ${r.stderr?.trim() || "(no error output)"}`);
  return lines(r.stdout);
}

/**
 * The ids of `project`'s live runs: a running container with both run labels and the run's own name,
 * `<project>-run-<id>`. A helper (the volume chown, a copy-out) carries the labels but no run's name, so a run that
 * is finalizing doesn't count (final review B-5). The same test as src/run/records.ts `liveRuns`, which can't be
 * imported here: records.ts imports this module. Throws when Docker can't say: `up` must not assume none.
 */
async function liveRuns(run: Runner, env: Env, project: string): Promise<string[]> {
  const r = await run(["docker", "ps", ...runFilters(project), "--format", '{{.Label "org.hapi.run"}}\t{{.Names}}'], { env: definedEnv(env), inherit: false });
  if (r.code !== 0) throw new Error(`hapi stack up: cannot tell whether runs are live (docker ps exited ${r.code}: ${r.stderr?.trim() || "(no error output)"}); nothing was started`);
  return lines(r.stdout)
    .map((row) => row.split("\t"))
    .filter(([id, name]) => id !== undefined && id !== "" && name === `${project}-run-${id}`)
    .map(([id]) => id!);
}

/**
 * Removes every run object of `project`: the labelled containers (`rm -f`), then `<project>-egress-archon-1`'s
 * attachment to each labelled network (Docker refuses to remove a network with an endpoint attached, spike 07
 * finding 13), then the networks, then the volumes. Only what the two labels select, never by name or prefix.
 * It tries every removal and throws at the end naming the ones that failed. A listing that fails (`docker ps`,
 * `network ls`, `volume ls`) throws at once and skips the steps after it: that almost always means the daemon is
 * down, when they would fail too. Either way `down`, kill switch 3, goes on to `compose down`. A disconnect that
 * fails is not an error by itself (the proxy may be gone, or not attached); the network removal after it says
 * whether anything is left. Nor is a removal that fails while nothing it named is still listed: a supervisor
 * finalizing its run removes the same objects, and may have got there first (`not found`).
 *
 * With `o.runId`, only that run's objects (`org.hapi.run=<id>`): `hapi run` finalizes one run, or rolls back a
 * start, this way, disconnecting `o.egress` (its `RunDeps.egress`) when given.
 */
export async function removeRuns(project: string, run: Runner, env: Env, o: { runId?: string; egress?: string } = {}): Promise<void> {
  const failures: string[] = [];
  /** Remove `names` with `cmd`; a failure counts while `list` (their listing) still shows one of them, or can't say. */
  const remove = async (cmd: string[], names: string[], list: string[]) => {
    const r = await run(cmd, { env: definedEnv(env), inherit: false });
    if (r.code === 0) return;
    let left = names;
    try {
      left = (await listed(run, env, list)).filter((n) => names.includes(n));
    } catch {}
    if (left.length > 0) failures.push(`${cmd.join(" ")} failed (exit ${r.code}): ${r.stderr?.trim() || "(no error output)"}`);
  };
  const filters = runFilters(project, o.runId);
  const egress = o.egress ?? `${project}-egress-archon-1`;
  const ps = ["docker", "ps", "-aq", ...filters];
  const containers = await listed(run, env, ps);
  if (containers.length > 0) await remove(["docker", "rm", "-f", ...containers], containers, ps);
  const nets = ["docker", "network", "ls", "--format", "{{.Name}}", ...filters];
  const networks = await listed(run, env, nets);
  for (const n of networks) await run(["docker", "network", "disconnect", "-f", n, egress], { env: definedEnv(env), inherit: false });
  if (networks.length > 0) await remove(["docker", "network", "rm", ...networks], networks, nets);
  const vols = ["docker", "volume", "ls", "-q", ...filters];
  const volumes = await listed(run, env, vols);
  if (volumes.length > 0) await remove(["docker", "volume", "rm", ...volumes], volumes, vols);
  if (failures.length > 0) throw new Error(`removing the runs of ${project} left something behind: ${failures.join("; ")}`);
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

  const live = await liveRuns(run, env, PROJECT);
  if (live.length > 0) {
    throw new Error(
      `hapi stack up: ${live.length} runs are live (docker ps --filter label=${RUN_LABEL}): stop them with \`hapi run stop <id>\` or wait; recreating egress-archon would cut their egress`,
    );
  }

  const written = await (deps.build ?? ((roster) => buildAll(loadPolicy("policy"), "build", { roster })))(opts.roster);
  console.log(`policy build: wrote ${written.length} files under build/ (roster ${opts.roster})`);
  const resolved = await (deps.resolve ?? ((a) => secretsResolve(a)))(opts.config === undefined ? [] : ["--config", opts.config]);
  if (resolved !== 0) throw new Error(`hapi secrets resolve exited ${resolved}; nothing was started`);

  const composeEnv = { ...definedEnv(env), HAPI_STARTED_BY: who.user, HAPI_DEV_OVERRIDE: who.override ? "1" : "0", HAPI_BUILD_SHA256: buildDigest(written) };
  const compose = (rest: string[], inherit = true) => run(["docker", "compose", "-f", COMPOSE_FILE, "-p", PROJECT, ...rest], { env: composeEnv, inherit });
  // A profile-only service is built only when named (spike 07, finding 17): `up --no-start --build` skips archon.
  const built = await compose(["build", "archon"]);
  if (built.code !== 0) throw new Error(`docker compose build archon failed (exit ${built.code}); nothing was started`);
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
  console.log(`the stack is up (Compose project ${PROJECT}): egress-hermes, egress-archon, egress-research, hermes (archon is built, and a container of it starts per run)`);
  return 0;
}

/** `hapi stack down`: remove the runs, then stop and remove the stack's containers and networks, keeping its volumes. */
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
  // The runs first: Docker won't remove a network with an endpoint attached. A failure here must not stop
  // `compose down` (this is kill switch 3), so it is reported after.
  let leftover: Error | undefined;
  try {
    await removeRuns(PROJECT, run, env);
  } catch (e) {
    leftover = e as Error;
  }
  const r = await run(["docker", "compose", "-p", PROJECT, "down"], { env: definedEnv(env), inherit: true });
  if (r.code !== 0) throw new Error(`docker compose -p ${PROJECT} down failed (exit ${r.code})${leftover === undefined ? "" : `; also ${leftover.message}`}`);
  if (leftover !== undefined) throw leftover;
  return 0;
}
