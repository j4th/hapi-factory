/**
 * The runtime.* checks: what the running stack actually has, read with
 * `docker inspect` (spec §9.1, §9.2, §9.3, §11.3).
 *
 * - runtime.run-container: there is no long-lived archon container (a run is a
 *   fresh container the launcher makes, src/run/spec.ts), so the check's subject
 *   is the run definition, one per run kind (src/run/kinds.ts; design §3.5):
 *   `runArgs` for a sample run of each kind must give Pi's agent dir a tmpfs,
 *   bind every host file (build/'s generated ones and the run's own guard
 *   settings and run config, /.archon/.env, empty, the workflow pack, the kind's
 *   prelude, the run file, the work order and its task text, the source repo,
 *   a review's or fix's inputs dir, and the kind's extra binds) read-only,
 *   carry every value of `serviceEnvironment("archon")` with the kind's proxy
 *   (egress-review's for a review), label its container with its kind, run its
 *   kind's prelude and workflow, publish no port (H-197), and carry every
 *   hardening flag and the stop timeout. Each live run container, found by its
 *   `org.hapi.run` and `org.hapi.project` labels (never by Compose's), is held
 *   through `docker inspect` to the argv of its own `org.hapi.kind` (a worker's
 *   when it has none; any other value fails), `liveProblems`, and to its kind's
 *   command and keys, `kindProblems`: it holds only its kind's zone's keys, and
 *   a verify none, named, never shown.
 * - runtime.hermes-no-yolo: Hermes's effective approval settings: no `--yolo`
 *   in its argv, no HERMES_YOLO_MODE or HERMES_YOLO in its env, HERMES_HOME
 *   where hapi puts it, and in the config mounted read-only at
 *   $HERMES_HOME/config.yaml, approvals.mode not off and no unattended mode
 *   that approves. The config is read as YAML 1.1, as Hermes reads it, where a
 *   bare `off` or `no` is false.
 * - runtime.run-disk: the run disk (`RUN_DISK`, src/run/disk.ts; H-217) as
 *   `hapi run start` checks it against `runs.disk` (`diskProblem`, the same
 *   reason): there, its own filesystem, apart from Docker's data root (from
 *   `docker info`), writable, and at most `runs.disk.gb`. It fails under either
 *   enforcement: under `hard` every start refuses, under `soft` runs start
 *   without the cap.
 * - runtime.dev-override: the labels `hapi stack up` (and the launcher, for a
 *   run) puts on every container (H-147). `1` is the dev bypass (HAPI_ALLOW_CURRENT_USER=1); `unknown` or
 *   empty means a stack not started through `hapi stack up`, never "no
 *   bypass". Both fail, and so does this shell's own bypass
 *   (`currentUserOverride`), unless `--dev` makes them a skip.
 *
 * With no Docker, each but runtime.run-container (whose definition needs
 * none) is a skip. With Docker but no container of the Compose project,
 * runtime.hermes-no-yolo and runtime.dev-override skip; runtime.run-disk reads
 * `docker info` and the filesystem, not the containers, so it doesn't.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { RUN_PATHS } from "../../generate/archon";
import { loadPolicy } from "../../policy/load";
import { dataRootOf, diskProblem, GIB, probeFs } from "../../run/disk";
import { egressOf, KIND_LABEL, type KindProfile, kindProfile, proxyZoneOf, RUN_KINDS, type RunKind } from "../../run/kinds";
import { RUN_DISK } from "../../run/locks";
import { APP_HOME, APP_USER, NO_NEW_PRIVILEGES, runArgs, type RunInputs, runName, STOP_GRACE_S } from "../../run/spec";
import { loadManifest, MANIFEST_FILE, manifestEntries } from "../../secrets/manifest";
import { composeServices } from "../../stack/compose";
import { HERMES_HOME, proxyEnv, serviceEnvironment } from "../../stack/env";
import { currentUserOverride, HAPI_USER, networkProblem, PROJECT, runFilters } from "../../stack/up";
import type { WorkOrder } from "../../workorder/validate";
import { type AuditContext, type AuditRun, type CheckResult, result } from "../types";
import { freshBuilds } from "./generated";

/** A container as `docker inspect` prints it (the fields the audit reads). */
export interface Container {
  /** The container's id: its key in `docker network inspect`'s Containers. */
  Id?: string;
  Name: string;
  State?: { Running?: boolean };
  Path?: string;
  Args?: string[];
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null; Cmd?: string[] | null; Entrypoint?: string[] | null; User?: string | null; StopTimeout?: number | null };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[] | null;
  /** The networks the container is on, by name. */
  NetworkSettings?: { Networks?: Record<string, unknown> | null } | null;
  HostConfig?: {
    /** `--network`: a run container's is its own network's name. */
    NetworkMode?: string;
    /** `--init`: true puts docker-init at PID 1, before the prelude. */
    Init?: boolean | null;
    PortBindings?: Record<string, unknown> | null;
    Tmpfs?: Record<string, string> | null;
    CapDrop?: string[] | null;
    ReadonlyRootfs?: boolean;
    SecurityOpt?: string[] | null;
    PidsLimit?: number | null;
    Memory?: number | null;
  };
}

export type Stack = { containers: Container[] } | { unavailable: string };

const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, 200);

/** The containers `docker ps -a` finds with these filters, inspected (the listing of a run is the argv after `docker ps -a -q --no-trunc`). */
async function inspected(run: AuditRun, filters: string[]): Promise<Stack> {
  let ps;
  try {
    ps = await run.ctx.exec(["docker", "ps", "-a", "-q", "--no-trunc", ...filters]);
  } catch (e) {
    return { unavailable: `docker is not available (${(e as Error).message})` };
  }
  if (ps.code !== 0) return { unavailable: `docker ps failed (exit ${ps.code}): ${firstLine(ps.stderr) || "no error output"}` };
  const ids = ps.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (ids.length === 0) return { containers: [] };
  const inspect = await run.ctx.exec(["docker", "inspect", ...ids]);
  if (inspect.code !== 0) throw new Error(`docker inspect exited ${inspect.code}: ${firstLine(inspect.stderr) || "no error output"}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) throw new Error("docker inspect printed something that is not a JSON array of containers");
  return { containers: parsed as Container[] };
}

/** Every container of the Compose project `hapi`, running or not (memoized per audit). Run containers are not among them: their Compose labels are blank. */
export function stackContainers(run: AuditRun): Promise<Stack> {
  return run.once("stack", () => inspected(run, ["--filter", `label=com.docker.compose.project=${PROJECT}`]));
}

/** Every run container of hapi (`org.hapi.run` and `org.hapi.project=hapi`), running or not (memoized per audit). */
export function runContainers(run: AuditRun): Promise<Stack> {
  return run.once("runs", () => inspected(run, runFilters(PROJECT)));
}

/** The stack's containers and the run containers together, or why Docker can't say (memoized per audit). */
export function liveContainers(run: AuditRun): Promise<Stack> {
  return run.once("live", async (): Promise<Stack> => {
    const [stack, runs] = await Promise.all([stackContainers(run), runContainers(run)]);
    if ("unavailable" in stack) return stack;
    if ("unavailable" in runs) return runs;
    return { containers: [...stack.containers, ...runs.containers] };
  });
}

export const containerName = (c: Container) => c.Name.replace(/^\//, "");
export const serviceOf = (c: Container) => c.Config?.Labels?.["com.docker.compose.service"];
export const isRunning = (c: Container) => c.State?.Running === true;
const label = (c: Container, name: string) => c.Config?.Labels?.[name];

/** A container's env as a map (the first `=` splits name and value). */
function envOf(c: Container): Map<string, string> {
  return new Map((c.Config?.Env ?? []).map((e) => [e.slice(0, Math.max(0, e.indexOf("="))), e.slice(e.indexOf("=") + 1)] as [string, string]).filter(([k]) => k !== ""));
}

const NOT_RUNNING = `the stack is not running (no container of the Compose project ${PROJECT}): \`mise run up\` starts it`;

/** The running container of `service`, or a skip saying why there is none. */
async function running(run: AuditRun, id: string, service: string): Promise<Container | CheckResult> {
  const stack = await stackContainers(run);
  if ("unavailable" in stack) return result(id, "skip", stack.unavailable);
  if (stack.containers.length === 0) return result(id, "skip", NOT_RUNNING);
  const c = stack.containers.find((x) => serviceOf(x) === service && isRunning(x));
  return c ?? result(id, "skip", `${service} is not running: \`docker compose -p ${PROJECT} ps\` shows why`);
}

/** The tmpfs options Pi's agent dir gets (design §6a item 3): small, the appuser's, nobody else's. */
const PI_TMPFS = "size=64m,uid=1001,gid=1001,mode=0700";

/** The prelude a run container of `profile`'s kind runs, as its entrypoint's first argument. */
const preludeOf = (profile: KindProfile) => `/opt/hapi/${profile.prelude}`;

/**
 * What a run container of `profile`'s kind must have bound read-only, by destination: every host file runArgs binds
 * (build/'s generated files and the run's own `hapi-guard.json` and run config, /.archon/.env (empty, so Archon loads
 * nothing over the environment), the pack, the kind's prelude, the run file, the host's copies of the work order and
 * its task text, the source repo, a review's or fix's inputs dir, and each of the kind's extra binds). The live check
 * holds a container to runArgs' own output, so only this list catches a bind runArgs drops (CodeRabbit, on PR #13 and
 * locally).
 */
function readOnlyDestinations(profile: KindProfile, buildDir: string): string[] {
  return [
    `${RUN_PATHS.piDir}/models.json`,
    `${RUN_PATHS.piDir}/models-store.json`,
    `${RUN_PATHS.piDir}/hapi-guard.json`,
    `${RUN_PATHS.piDir}/settings.json`,
    `${RUN_PATHS.piDir}/extensions`,
    "/.archon/config.yaml",
    "/.archon/.env",
    RUN_PATHS.pack,
    "/opt/hapi/run-config.yaml",
    `${APP_HOME}/.gitconfig`,
    preludeOf(profile),
    RUN_PATHS.runFile,
    RUN_PATHS.order,
    RUN_PATHS.task,
    RUN_PATHS.source,
    ...(profile.inputs ? [RUN_PATHS.inputs] : []),
    ...profile.extraBinds({ buildDir }).map(([, dst]) => dst),
  ];
}

/**
 * The environment a run container of `profile`'s kind carries: `serviceEnvironment("archon")` (src/stack/env.ts, the
 * code's own list, not the compose file's), with its kind's zone's proxy variables: the review zone's for a review.
 */
function kindEnvironment(profile: KindProfile): Map<string, string> {
  return new Map(Object.entries({ ...serviceEnvironment("archon"), ...proxyEnv(proxyZoneOf(profile)) }));
}

/** What `env` says, as problems against `want`: each of its values, none missing. */
function envProblems(env: Map<string, string>, want: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, value] of want) {
    if (!env.has(name)) problems.push(`${name} is not set`);
    else if (env.get(name) !== value) problems.push(`${name} is not ${value}`);
  }
  return problems;
}

/** A word a container's labels or command hold, shown only if it is plain enough. */
const shown = (s: string) => (/^[A-Za-z0-9._/:@=+-]{1,200}$/.test(s) ? s : "(a value that is not shown)");

/** Each zone's env names: the context's, or each zone of stack/secrets.yaml. */
function zoneKeysOf(ctx: AuditContext): Record<string, string[]> {
  if (ctx.zoneKeys !== undefined) return ctx.zoneKeys;
  const out: Record<string, string[]> = {};
  for (const e of manifestEntries(loadManifest(join(ctx.root, MANIFEST_FILE)))) (out[e.zone] ??= []).push(e.key);
  return out;
}

/**
 * The keys in `env` that a run container of `profile`'s kind may not hold, by name only, never a value: any env name
 * some zone of `zoneKeys` holds is a key, and a container holds only its own zone's (design §3.5), a verify none.
 * Names no zone holds aren't keys: the service's own environment, git's `GIT_CONFIG_KEY_<n>` pairs among them
 * (spike 09, T19), and PATH.
 */
export function keyProblems(env: Iterable<string>, profile: KindProfile, zoneKeys: Record<string, string[]>): string[] {
  const any = new Set(Object.values(zoneKeys).flat());
  const own = new Set(profile.zone === undefined ? [] : (zoneKeys[profile.zone] ?? []));
  const why = profile.zone === undefined ? `a ${profile.kind} container holds no key` : `a ${profile.kind} container holds only its zone's keys`;
  return [...env].filter((name) => any.has(name) && !own.has(name)).sort().map((name) => `${name} is set: ${why}`);
}

/**
 * How a live run container falls short of its kind beyond its mounts and environment: it must run its kind's prelude
 * (`sh /opt/hapi/<prelude>`) and, for a verify or a review, its kind's workflow, and hold no key its kind's zone
 * doesn't (`keyProblems`).
 */
export function kindProblems(c: Container, profile: KindProfile, zoneKeys: Record<string, string[]>): string[] {
  const problems: string[] = [];
  const want = ["sh", preludeOf(profile), ...(profile.workflow === undefined ? [] : [profile.workflow])];
  const have = [c.Path ?? "", ...(c.Args ?? [])].slice(0, want.length);
  if (want.some((w, i) => have[i] !== w)) problems.push(`it runs ${have.map(shown).join(" ")}, not ${want.join(" ")}`);
  problems.push(...keyProblems(envOf(c).keys(), profile, zoneKeys));
  return problems;
}

/**
 * How a live run container's network falls short of its kind's: it must be on exactly one network, its own (named as
 * the container is: src/run/spec.ts `runName`, which `createRunObjects` makes), and that network, read with
 * `docker network inspect`, must be internal with a private subnet (src/stack/up.ts `networkProblem`, start's own
 * check) and hold exactly two endpoints: the container (by its id and its name) and its kind's proxy (`egressOf`:
 * egress-archon, or egress-review for a review). Another network, Docker's default bridge, an extra endpoint, or the other zone's
 * proxy each fail.
 */
export async function runNetworkProblems(run: AuditRun, c: Container, profile: KindProfile): Promise<string[]> {
  const name = containerName(c);
  const problems: string[] = [];
  const mode = c.HostConfig?.NetworkMode;
  if (mode !== name) problems.push(`its network is ${shown(mode ?? "(none)")}, not its own network ${name}`);
  const on = Object.keys(c.NetworkSettings?.Networks ?? {}).sort();
  if (on.length !== 1 || on[0] !== name) problems.push(`it is on ${on.length === 0 ? "no network" : on.map(shown).join(", ")}, not on its own network ${name} alone`);
  if (!on.includes(name)) return problems;
  const r = await run.ctx.exec(["docker", "network", "inspect", name]);
  if (r.code !== 0) return [...problems, `its network ${name} could not be inspected (docker network inspect exited ${r.code}): ${firstLine(r.stderr) || "no error output"}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  const net = (Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined) as { Containers?: Record<string, { Name?: unknown }> | null } | undefined;
  const problem = networkProblem(net);
  if (problem !== undefined) problems.push(problem);
  if (net === undefined || net === null || typeof net !== "object") return problems;
  const want = [name, ...egressOf({ project: PROJECT, egress: `${PROJECT}-egress-archon-1` }, profile)].sort();
  const have = Object.values(net.Containers ?? {}).map((e) => (typeof e?.Name === "string" ? e.Name : "")).sort();
  if (have.length !== want.length || have.some((n, i) => n !== want[i])) {
    problems.push(`its network ${name} holds ${have.length === 0 ? "no endpoint" : have.map(shown).join(", ")}, not exactly ${want.join(" and ")}`);
  }
  // The endpoint named for the container is the container itself: the network's Containers are keyed by id.
  if (c.Id !== undefined && net.Containers?.[c.Id]?.Name !== name) problems.push(`its network ${name} has no endpoint of this container's id under its name`);
  return problems;
}

/** The sample run of `kind` that `runArgs` is asked about: none of it reaches Docker. */
function sampleInputs(packDir: string, kind: RunKind): RunInputs {
  const traceparent = "00-00000000000000000000000000000001-0000000000000001-01";
  return {
    runId: "000000000000",
    repo: "/audit/sample/repo.git",
    sha: "0".repeat(40),
    workOrder: { id: `audit-sample-${kind}`, workflow: "hapi-check-run", trace: { traceparent }, budget: { usd: 1, turns: 1, minutes: 1 } } as WorkOrder,
    public: false,
    budgetUsd: 1,
    packDir,
  };
}

/** What the run definition's argv says a run container is (the one source the live check compares against). */
export interface RunShape {
  tmpfs: Map<string, string>;
  binds: Map<string, { src: string; ro: boolean }>;
  volumes: Set<string>;
  env: Map<string, string>;
  /** The `-e NAME` entries: the secrets passed by name, their values left to the docker CLI. */
  secretNames: string[];
  labels: Map<string, string>;
  /** `--entrypoint`, then what follows the image: the prelude and its arguments. */
  entrypoint: string | undefined;
  args: string[];
  capDrop: string[];
  readOnly: boolean;
  securityOpt: string[];
  user: string | undefined;
  pids: number | undefined;
  memory: number | undefined;
  /** `--stop-timeout`, in seconds; Docker keeps it in `Config.StopTimeout`. */
  stopTimeout: number | undefined;
  /** `--init`: false (`--init=false`), true, or undefined when the argv says neither, which leaves it to the daemon. */
  init: boolean | undefined;
  ports: boolean;
}

const BYTES: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export function shapeOf(argv: string[]): RunShape {
  const after = (flag: string) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
  const mem = /^(\d+)([bkmg]?)$/i.exec(after("--memory")[0] ?? "");
  const pids = after("--pids-limit")[0];
  const stop = after("--stop-timeout")[0];
  const shape: RunShape = {
    tmpfs: new Map(after("--tmpfs").map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] as [string, string])),
    binds: new Map(),
    volumes: new Set(),
    env: new Map(after("-e").filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as [string, string])),
    secretNames: after("-e").filter((e) => !e.includes("=")),
    labels: new Map(after("--label").map((l) => (l.includes("=") ? [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] : [l, ""]) as [string, string])),
    entrypoint: after("--entrypoint")[0],
    args: argv.includes("--entrypoint") ? argv.slice(argv.indexOf("--entrypoint") + 3) : [],
    capDrop: after("--cap-drop"),
    readOnly: argv.includes("--read-only"),
    securityOpt: after("--security-opt"),
    user: after("--user")[0],
    pids: pids === undefined ? undefined : Number(pids),
    memory: mem === null ? undefined : Number(mem[1]) * BYTES[mem[2]!.toLowerCase()]!,
    stopTimeout: stop === undefined ? undefined : Number(stop),
    init: argv.includes("--init=false") ? false : argv.includes("--init") || argv.includes("--init=true") ? true : undefined,
    ports: argv.some((a) => ["-p", "--publish", "-P", "--publish-all"].includes(a) || a.startsWith("--publish=")),
  };
  for (const v of after("-v")) {
    const [src, dst, mode] = v.split(":") as [string, string, string?];
    // A source that is a path is a bind of a host file; a name is a per-run volume (/work and /out), which is meant to be written.
    if (src.startsWith("/")) shape.binds.set(dst, { src, ro: mode === "ro" });
    else shape.volumes.add(dst);
  }
  return shape;
}

/**
 * How the run definition of `profile`'s kind falls short of what its run container must be; empty if it doesn't:
 * Pi's tmpfs, every bind read-only and none of its kind's missing, the default pack dir, its kind's environment and
 * label, its prelude and workflow, no key for a kind that holds none, no published port, every hardening flag
 * (`--cap-drop ALL`, `--read-only`, no-new-privileges, user 1001:1001, a pids and a memory limit) and the stop timeout.
 */
function definitionProblems(want: RunShape, packDir: string, profile: KindProfile, buildDir: string): string[] {
  const problems: string[] = [];
  const tmpfs = want.tmpfs.get(RUN_PATHS.piDir);
  if (tmpfs === undefined) problems.push(`no tmpfs at ${RUN_PATHS.piDir}`);
  else if (tmpfs !== PI_TMPFS) problems.push(`the tmpfs at ${RUN_PATHS.piDir} has options ${tmpfs}, not ${PI_TMPFS}`);
  for (const [dst, b] of want.binds) if (!b.ro) problems.push(`${dst} is not bound read-only`);
  for (const dest of readOnlyDestinations(profile, buildDir)) if (!want.binds.has(dest)) problems.push(`nothing is bound at ${dest}`);
  const pack = want.binds.get(RUN_PATHS.pack);
  if (pack !== undefined && pack.src !== packDir) problems.push(`${RUN_PATHS.pack} is bound from ${pack.src}, not the default pack dir ${packDir}`);
  problems.push(...envProblems(want.env, kindEnvironment(profile)));
  if (want.labels.get(KIND_LABEL) !== profile.kind) problems.push(`it does not label its container ${KIND_LABEL}=${profile.kind}`);
  const command = ["sh", preludeOf(profile), ...(profile.workflow === undefined ? [] : [profile.workflow])];
  const has = [want.entrypoint ?? "", ...want.args].slice(0, command.length);
  if (command.some((w, i) => has[i] !== w)) problems.push(`it runs ${has.join(" ") || "(no entrypoint)"}, not ${command.join(" ")}`);
  if (profile.zone === undefined) for (const name of want.secretNames) problems.push(`it passes ${name}, a key, to a container that holds none`);
  if (want.ports) problems.push("it publishes a port (a run listens nowhere)");
  if (!want.capDrop.includes("ALL")) problems.push("it does not drop ALL capabilities");
  if (!want.readOnly) problems.push("its root filesystem is not read-only");
  if (!want.securityOpt.includes(NO_NEW_PRIVILEGES)) problems.push(`it does not set ${NO_NEW_PRIVILEGES}`);
  if (want.user !== APP_USER) problems.push(`it runs as ${want.user ?? "(the image's user)"}, not ${APP_USER}`);
  if (want.pids === undefined) problems.push("it has no pids limit");
  if (want.memory === undefined) problems.push("it has no memory limit");
  if (want.stopTimeout !== STOP_GRACE_S) problems.push(`its stop timeout is ${want.stopTimeout ?? "Docker's default"}, not ${STOP_GRACE_S}`);
  if (want.init !== false) problems.push("it doesn't set --init=false: its prelude must be PID 1 whatever the daemon's default");
  return problems;
}

/**
 * How a live run container falls short of the definition `want`: every tmpfs (Docker lists a `--tmpfs` only in
 * `HostConfig.Tmpfs`), every bind and volume (none missing, none unexpected, each bind read-only), the default pack
 * dir, the environment, no published port, the hardening flags (capabilities dropped, a read-only root,
 * no-new-privileges, the user, the pids and memory limits), the stop timeout (in `Config.StopTimeout`) and no init
 * process at PID 1 (`HostConfig.Init`).
 */
export function liveProblems(c: Container, want: RunShape, packDir: string): string[] {
  const problems: string[] = [];
  const have = c.HostConfig?.Tmpfs ?? {};
  for (const [path, options] of want.tmpfs) {
    if (!Object.hasOwn(have, path)) problems.push(`no tmpfs at ${path}`);
    else if (have[path] !== options) problems.push(`the tmpfs at ${path} has options ${have[path]}, not ${options}`);
  }
  for (const path of Object.keys(have)) if (!want.tmpfs.has(path)) problems.push(`${path} is a tmpfs but the run definition has no such mount`);
  const mounts = c.Mounts ?? [];
  for (const dest of [...want.binds.keys(), ...want.volumes]) {
    const m = mounts.find((x) => x.Destination === dest);
    if (m === undefined) problems.push(`nothing is mounted at ${dest}`);
    else if (want.binds.has(dest) && m.RW !== false) problems.push(`${dest} is not mounted read-only`);
    else if (dest === RUN_PATHS.pack && m.Source !== packDir) problems.push(`${dest} is mounted from ${m.Source}, not the default pack dir ${packDir}`);
  }
  for (const m of mounts) if (m.Destination !== undefined && !want.binds.has(m.Destination) && !want.volumes.has(m.Destination)) problems.push(`${m.Destination} is mounted but the run definition has no such mount`);
  problems.push(...envProblems(envOf(c), want.env));
  if (Object.keys(c.HostConfig?.PortBindings ?? {}).length > 0) problems.push("it publishes a port (a run listens nowhere)");
  const h = c.HostConfig ?? {};
  for (const cap of want.capDrop) if (!(h.CapDrop ?? []).includes(cap)) problems.push(`it does not drop ${cap} capabilities`);
  if (want.readOnly && h.ReadonlyRootfs !== true) problems.push("its root filesystem is not read-only");
  for (const opt of want.securityOpt) if (!(h.SecurityOpt ?? []).includes(opt)) problems.push(`${opt} is not set`);
  if (want.user !== undefined && c.Config?.User !== want.user) problems.push(`it runs as ${c.Config?.User || "(the image's user)"}, not ${want.user}`);
  if (want.pids !== undefined && h.PidsLimit !== want.pids) problems.push(`its pids limit is ${h.PidsLimit ?? 0}, not ${want.pids}`);
  if (want.memory !== undefined && h.Memory !== want.memory) problems.push(`its memory limit is ${h.Memory ?? 0}, not ${want.memory}`);
  const stop = c.Config?.StopTimeout ?? undefined;
  if (want.stopTimeout !== undefined && stop !== want.stopTimeout) problems.push(`its stop timeout is ${stop ?? "Docker's default"}, not ${want.stopTimeout}`);
  // docker-init at PID 1 would make a verify's or review's guarded kill of what its workflow left a silent no-op.
  if (h.Init === true) problems.push("it runs an init process at PID 1 (HostConfig.Init), so its prelude isn't PID 1");
  return problems;
}

/** runtime.run-container */
export async function runContainer(run: AuditRun): Promise<CheckResult[]> {
  const id = "runtime.run-container";
  const { ctx } = run;
  const service = (await composeServices(ctx.root)).archon;
  if (service?.image === undefined) throw new Error("stack/compose.yaml has no archon service with an image: it is the run container's definition");
  const fresh = (await freshBuilds(run))[0]!;
  const packDir = join(ctx.root, "archon", "workflows", "hapi");
  const buildDir = join(fresh.root, "build");
  const fix = "the run container's definition is stack/compose.yaml's archon service, translated by src/run/spec.ts for each kind's profile (src/run/kinds.ts): restore them";
  const zoneKeys = zoneKeysOf(ctx);
  const deps = { project: PROJECT, image: service.image, root: ctx.root, buildDir, stateDir: "/audit/sample/state", user: ctx.user, env: ctx.env };
  // One definition per kind, each checked on its own.
  const wants = new Map<RunKind, RunShape>();
  const static_: string[] = [];
  for (const kind of RUN_KINDS) {
    const profile = kindProfile(kind);
    const argv = runArgs(service, sampleInputs(packDir, kind), deps, [], profile);
    const want = shapeOf(argv);
    const p = definitionProblems(want, packDir, profile, buildDir);
    // A kind that holds no key (verify): runArgs, given the archon zone's names for it, must refuse them, never bind one.
    const archonKeys = zoneKeys.archon ?? [];
    if (profile.zone === undefined && archonKeys.length > 0) {
      let bound = true;
      try {
        runArgs(service, sampleInputs(packDir, kind), deps, archonKeys, profile);
      } catch (e) {
        if (!/holds no key/.test((e as Error).message)) throw e;
        bound = false;
      }
      if (bound) p.push("runArgs binds the archon zone's keys into it when given them, where it must refuse them: it holds no key");
    }
    if (p.length > 0) static_.push(`${kind}: ${p.join("; ")}`);
    wants.set(kind, want);
  }
  if (static_.length > 0) return [result(id, "fail", `the run definition (runArgs, src/run/spec.ts): ${static_.join("; ")}. ${fix}`)];

  const runs = await runContainers(run);
  // A run container is named for its run (`<project>-run-<org.hapi.run>`), as src/stack/up.ts's liveRuns tells one: a
  // copy-out or chown helper caught mid-flight carries the run labels (a bare org.hapi.run) but no run's name, runs
  // with --network none and is gone in seconds, so it is no run container to hold to a kind's definition.
  const isRun = (c: Container) => {
    const runId = c.Config?.Labels?.["org.hapi.run"];
    return runId !== undefined && runId !== "" && containerName(c) === runName(PROJECT, runId);
  };
  const live = "containers" in runs ? runs.containers.filter((c) => isRunning(c) && isRun(c)) : [];
  const checkedLive: (readonly [Container, string[]])[] = [];
  for (const c of live) {
    // A container's kind is its label; a Plan 02 run container has none, and is a worker's.
    const label = c.Config?.Labels?.[KIND_LABEL];
    if (label !== undefined && !(RUN_KINDS as readonly string[]).includes(label)) {
      checkedLive.push([c, [`carries ${KIND_LABEL}=${shown(label)}, which is no run kind`]]);
      continue;
    }
    const kind = (label ?? "worker") as RunKind;
    const profile = kindProfile(kind);
    checkedLive.push([c, [...liveProblems(c, wants.get(kind)!, packDir), ...kindProblems(c, profile, zoneKeys), ...(await runNetworkProblems(run, c, profile))]]);
  }
  const bad = checkedLive.filter(([, p]) => p.length > 0);
  if (bad.length > 0) {
    return [
      result(
        id,
        "fail",
        `${bad.map(([c, p]) => `${containerName(c)}: ${p.join("; ")}`).join("; ")}. A live run container must be as its kind's run definition says, and hold only its kind's zone's keys: stop it with \`hapi run stop <id>\`, then ${fix}`,
      ),
    ];
  }
  const checked =
    "unavailable" in runs
      ? `no live run container was checked (${runs.unavailable})`
      : live.length === 0
        ? "no live run container was checked (none is running)"
        : `${live.length} live run containers are as their kind's definition says, each holding only its kind's zone's keys, on its own internal network with only its kind's proxy`;
  const nonProxy = Object.entries(serviceEnvironment("archon")).filter(([k]) => !/proxy/i.test(k)).length;
  const binds = RUN_KINDS.map((k) => `${k} ${readOnlyDestinations(kindProfile(k), buildDir).length}`).join(", ");
  return [
    result(
      id,
      "pass",
      `the run definition (runArgs, src/run/spec.ts), for each of the ${RUN_KINDS.length} run kinds (${RUN_KINDS.join(", ").replace(/, ([^,]+)$/, " and $1")}), gives ${RUN_PATHS.piDir} a tmpfs (${PI_TMPFS}), binds every host file its kind has (${binds}: build/'s generated ones and the run's own guard settings and run config, /.archon/.env, the pack ${packDir}, its prelude, the run file, the work order and its task text, the source repo, and a review's or fix's inputs dir) read-only, sets all ${Object.keys(serviceEnvironment("archon")).length} values of serviceEnvironment("archon") (${nonProxy} besides the proxy's, which are egress-review's for a review), labels its container with its kind and runs its kind's prelude, passes no key to a verify (and refuses the archon zone's names for one), publishes no port, and has every hardening flag and a ${STOP_GRACE_S} s stop timeout; ${checked}`,
    ),
  ];
}

/** runtime.run-disk */
export async function runDisk(run: AuditRun): Promise<CheckResult[]> {
  const id = "runtime.run-disk";
  const { ctx } = run;
  let info;
  try {
    info = await ctx.exec(["docker", "info", "--format", "{{.DockerRootDir}}"]);
  } catch (e) {
    return [result(id, "skip", `docker info failed: ${(e as Error).message}`)];
  }
  if (info.code !== 0) return [result(id, "skip", `docker info failed (exit ${info.code}): ${firstLine(info.stderr) || "no error output"}`)];
  const root = dataRootOf(info.code, info.stdout, info.stderr);
  const limits = loadPolicy(ctx.policyDir).runs.disk;
  const probe = ctx.probeFs ?? probeFs;
  // The run disk is probed once: the check and its detail read the same facts.
  const disk = probe(RUN_DISK);
  const problem = diskProblem(RUN_DISK, limits, root, (p) => (p === RUN_DISK ? disk : probe(p)));
  if (problem !== undefined) {
    const then = limits.enforcement === "hard" ? "refuses every run" : "warns and starts every run anyway";
    return [result(id, "fail", `${problem}; runs.disk.enforcement is ${limits.enforcement}, so \`hapi run start\` ${then}`)];
  }
  const size = ((disk?.bytes ?? 0) / GIB).toFixed(1);
  return [result(id, "pass", `${RUN_DISK}: its own filesystem, ${size} GB of runs.disk.gb's ${limits.gb}, apart from Docker's data root (${root}), writable`)];
}

/** A yolo variable's value that turns yolo on: anything but empty, 0, false, no or off. */
const truthy = (v: string) => !["", "0", "false", "no", "off"].includes(v.trim().toLowerCase());
/** What an unattended approval mode may be (Hermes treats approve, off, allow and yes as approve). */
const approves = (v: unknown) => typeof v === "boolean" || (typeof v === "string" && ["approve", "off", "allow", "yes"].includes(v.trim().toLowerCase()));

/** runtime.hermes-no-yolo */
export async function hermesNoYolo(run: AuditRun): Promise<CheckResult[]> {
  const id = "runtime.hermes-no-yolo";
  const c = await running(run, id, "hermes");
  if ("status" in c) return [c];
  const name = containerName(c);
  const problems: string[] = [];
  const argv = [c.Path ?? "", ...(c.Args ?? []), ...(c.Config?.Entrypoint ?? []), ...(c.Config?.Cmd ?? [])];
  if (argv.some((a) => a === "--yolo" || a.startsWith("--yolo="))) problems.push("--yolo is in its command line (every approval skipped)");
  const env = envOf(c);
  for (const v of ["HERMES_YOLO_MODE", "HERMES_YOLO"]) {
    if (env.has(v) && truthy(env.get(v)!)) problems.push(`${v} is set in its env (every approval skipped)`);
  }
  const dispatchVar = "HERMES_KANBAN_DISPATCH_IN_GATEWAY";
  if (env.has(dispatchVar) && truthy(env.get(dispatchVar)!)) problems.push(`${dispatchVar} is set in its env (the Kanban dispatcher runs over the config)`);
  const home = env.get("HERMES_HOME") ?? HERMES_HOME;
  if (home !== HERMES_HOME) problems.push(`HERMES_HOME is not ${HERMES_HOME}, so Hermes doesn't read the generated config`);
  const dest = `${home}/config.yaml`;
  const mount = (c.Mounts ?? []).find((m) => m.Destination === dest && m.RW === false);
  let summary = "";
  if (mount?.Source === undefined) problems.push(`no read-only config mounted at ${dest}`);
  else {
    let text: string;
    try {
      text = await readFile(mount.Source, "utf8");
    } catch (e) {
      return [result(id, "skip", `cannot read ${name}'s mounted config ${mount.Source} (${(e as NodeJS.ErrnoException).code ?? "error"}): run the audit as ${HAPI_USER}`)];
    }
    let cfg: unknown;
    try {
      cfg = YAML.parse(text, { version: "1.1" });
    } catch {
      return [result(id, "fail", `${name}'s mounted config ${mount.Source} does not parse as YAML`)];
    }
    const approvals = ((cfg as Record<string, unknown> | null)?.approvals ?? {}) as Record<string, unknown>;
    const mode = approvals.mode;
    if (mode === false || (typeof mode === "string" && mode.trim().toLowerCase() === "off")) problems.push("approvals.mode is off (spec §9.1 forbids it)");
    for (const k of ["cron_mode", "unattended_mode", "single_query_mode"]) {
      if (approvals[k] !== undefined && approves(approvals[k])) problems.push(`approvals.${k} approves, where policy says deny`);
    }
    // The dispatcher spawns a worker per ready card with full terminal access and no approval step (kanban.md).
    const kanban = ((cfg as Record<string, unknown> | null)?.kanban ?? {}) as Record<string, unknown>;
    if (kanban.dispatch_in_gateway !== false) problems.push("kanban.dispatch_in_gateway is not false (Hermes's default runs the dispatcher)");
    if (!Array.isArray(kanban.dispatch_profiles) || kanban.dispatch_profiles.length > 0) problems.push("kanban.dispatch_profiles is not an empty list (an omitted key lets this home claim cards for any profile)");
    if (kanban.auto_decompose !== false) problems.push("kanban.auto_decompose is not false");
    if (kanban.review_dispatch !== false) problems.push("kanban.review_dispatch is not false");
    summary = `approvals.mode ${mode === undefined ? "(Hermes's default, manual)" : String(mode)}, no unattended mode that approves, and the Kanban dispatcher off`;
  }
  if (problems.length > 0) {
    return [result(id, "fail", `${name}: ${problems.join("; ")}. Yolo, approvals.mode: off and the Kanban dispatcher are forbidden (spec §9.1): restore build/ with \`mise run up\` and remove the flag or variable`)];
  }
  return [result(id, "pass", `${name}: no --yolo, no HERMES_YOLO_MODE, HERMES_YOLO or HERMES_KANBAN_DISPATCH_IN_GATEWAY, HERMES_HOME ${home}, and its read-only ${dest} (${mount!.Source}) has ${summary}`)];
}

/** runtime.dev-override */
export async function devOverride(run: AuditRun): Promise<CheckResult[]> {
  const id = "runtime.dev-override";
  const { ctx } = run;
  const problems: string[] = [];
  const shell = currentUserOverride(ctx.env, ctx.user);
  if (shell.override) {
    problems.push(`this shell sets HAPI_ALLOW_CURRENT_USER=1 as ${shell.user}, not ${HAPI_USER}, so \`mise run up\` from it runs the stack as ${shell.user}`);
  }
  const stack = await liveContainers(run);
  const containers = "containers" in stack ? stack.containers.filter(isRunning) : [];
  for (const c of containers) {
    const v = label(c, "org.hapi.dev-override") ?? "";
    const by = label(c, "org.hapi.started-by") ?? "";
    if (v === "1") problems.push(`${containerName(c)} was started with HAPI_ALLOW_CURRENT_USER=1 by ${by || "(no org.hapi.started-by)"}`);
    else if (v !== "0") problems.push(`${containerName(c)} was not started through \`hapi stack up\` (org.hapi.dev-override=${v === "" ? "(empty)" : v})`);
    else if (by !== HAPI_USER) problems.push(`${containerName(c)} says it was started by ${by || "(nobody)"} with no bypass, which \`hapi stack up\` never labels`);
  }
  if (problems.length > 0) {
    if (ctx.dev) return [result(id, "skip", `--dev: the dev bypass is reported, not failed: ${problems.join("; ")}`)];
    return [
      result(
        id,
        "fail",
        `${problems.join("; ")}. The dev bypass is a dev-only downgrade (no dedicated user, no rootless Docker): run the stack with \`mise run up\` as ${HAPI_USER}, without HAPI_ALLOW_CURRENT_USER (docs/runbooks/stack.md#the-dev-bypass-hapi_allow_current_user1)`,
      ),
    ];
  }
  if ("unavailable" in stack) return [result(id, "skip", stack.unavailable)];
  if (containers.length === 0) return [result(id, "skip", NOT_RUNNING)];
  return [result(id, "pass", `all ${containers.length} containers were started by \`hapi stack up\` as ${HAPI_USER}, with no dev bypass (org.hapi.dev-override=0)`)];
}
