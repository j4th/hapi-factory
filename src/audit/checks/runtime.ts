/**
 * The runtime.* checks: what the running stack actually has, read with
 * `docker inspect` (spec §9.1, §9.2, §9.3, §11.3).
 *
 * - runtime.run-container: there is no long-lived archon container (a run is a
 *   fresh container the launcher makes, src/run/spec.ts), so the check's subject
 *   is the run definition: `runArgs` for a sample run must give Pi's agent dir
 *   a tmpfs, bind every generated file (and /.archon/.env, empty, and the
 *   workflow pack) read-only, carry every value of `serviceEnvironment("archon")`
 *   and publish no port (H-197). Each live run container, found by its
 *   `org.hapi.run` and `org.hapi.project` labels (never by Compose's), is held to
 *   the same through `docker inspect`.
 * - runtime.hermes-no-yolo: Hermes's effective approval settings: no `--yolo`
 *   in its argv, no HERMES_YOLO_MODE or HERMES_YOLO in its env, HERMES_HOME
 *   where hapi puts it, and in the config mounted read-only at
 *   $HERMES_HOME/config.yaml, approvals.mode not off and no unattended mode
 *   that approves. The config is read as YAML 1.1, as Hermes reads it, where a
 *   bare `off` or `no` is false.
 * - runtime.dev-override: the labels `hapi stack up` (and the launcher, for a
 *   run) puts on every container (H-147). `1` is the dev bypass (HAPI_ALLOW_CURRENT_USER=1); `unknown` or
 *   empty means a stack not started through `hapi stack up`, never "no
 *   bypass". Both fail, and so does this shell's own bypass
 *   (`currentUserOverride`), unless `--dev` makes them a skip.
 *
 * With no container of the Compose project, or no Docker, each but
 * runtime.run-container (whose definition needs none) is a skip.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { RUN_PATHS } from "../../generate/archon";
import { runArgs, type RunInputs } from "../../run/spec";
import { composeServices } from "../../stack/compose";
import { HERMES_HOME, serviceEnvironment } from "../../stack/env";
import { currentUserOverride, HAPI_USER, PROJECT, runFilters } from "../../stack/up";
import type { WorkOrder } from "../../workorder/validate";
import { type AuditRun, type CheckResult, result } from "../types";
import { freshBuilds } from "./generated";

/** A container as `docker inspect` prints it (the fields the audit reads). */
export interface Container {
  Name: string;
  State?: { Running?: boolean };
  Path?: string;
  Args?: string[];
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null; Cmd?: string[] | null; Entrypoint?: string[] | null; User?: string | null };
  Mounts?: { Type?: string; Source?: string; Destination?: string; RW?: boolean }[] | null;
  HostConfig?: {
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

/** What the run container must have, by destination: the generated files, /.archon/.env (empty, so Archon loads nothing over the environment) and the pack. */
const READ_ONLY_DESTINATIONS = [
  `${RUN_PATHS.piDir}/models.json`,
  `${RUN_PATHS.piDir}/models-store.json`,
  `${RUN_PATHS.piDir}/hapi-guard.json`,
  "/.archon/config.yaml",
  "/.archon/.env",
  RUN_PATHS.pack,
];

/** What a live container's `Config.Env` says, as problems against `serviceEnvironment("archon")`. */
function envProblems(env: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(serviceEnvironment("archon"))) {
    if (!env.has(name)) problems.push(`${name} is not set`);
    else if (env.get(name) !== value) problems.push(`${name} is not ${value}`);
  }
  return problems;
}

/** The sample run `runArgs` is asked about: none of it reaches Docker. */
function sampleInputs(packDir: string): RunInputs {
  const traceparent = "00-00000000000000000000000000000001-0000000000000001-01";
  return {
    runId: "000000000000",
    repo: "/audit/sample/repo.git",
    sha: "0".repeat(40),
    workOrder: { id: "audit-sample", workflow: "hapi-check-run", trace: { traceparent }, budget: { usd: 1, turns: 1, minutes: 1 } } as WorkOrder,
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
  capDrop: string[];
  readOnly: boolean;
  securityOpt: string[];
  user: string | undefined;
  pids: number | undefined;
  memory: number | undefined;
  ports: boolean;
}

const BYTES: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

export function shapeOf(argv: string[]): RunShape {
  const after = (flag: string) => argv.flatMap((a, i) => (argv[i - 1] === flag ? [a] : []));
  const mem = /^(\d+)([bkmg]?)$/i.exec(after("--memory")[0] ?? "");
  const pids = after("--pids-limit")[0];
  const shape: RunShape = {
    tmpfs: new Map(after("--tmpfs").map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)] as [string, string])),
    binds: new Map(),
    volumes: new Set(),
    env: new Map(after("-e").filter((e) => e.includes("=")).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)] as [string, string])),
    capDrop: after("--cap-drop"),
    readOnly: argv.includes("--read-only"),
    securityOpt: after("--security-opt"),
    user: after("--user")[0],
    pids: pids === undefined ? undefined : Number(pids),
    memory: mem === null ? undefined : Number(mem[1]) * BYTES[mem[2]!.toLowerCase()]!,
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

/** How the run definition's `docker run` argv falls short of what a run container must be; empty if it doesn't. */
function definitionProblems(want: RunShape, packDir: string): string[] {
  const problems: string[] = [];
  const tmpfs = want.tmpfs.get(RUN_PATHS.piDir);
  if (tmpfs === undefined) problems.push(`no tmpfs at ${RUN_PATHS.piDir}`);
  else if (tmpfs !== PI_TMPFS) problems.push(`the tmpfs at ${RUN_PATHS.piDir} has options ${tmpfs}, not ${PI_TMPFS}`);
  for (const [dst, b] of want.binds) if (!b.ro) problems.push(`${dst} is not bound read-only`);
  for (const dest of READ_ONLY_DESTINATIONS) if (!want.binds.has(dest)) problems.push(`nothing is bound at ${dest}`);
  const pack = want.binds.get(RUN_PATHS.pack);
  if (pack !== undefined && pack.src !== packDir) problems.push(`${RUN_PATHS.pack} is bound from ${pack.src}, not the default pack dir ${packDir}`);
  problems.push(...envProblems(want.env));
  if (want.ports) problems.push("it publishes a port (a run listens nowhere)");
  return problems;
}

/**
 * How a live run container falls short of the definition `want`: every tmpfs (Docker lists a `--tmpfs` only in
 * `HostConfig.Tmpfs`), every bind and volume (none missing, none unexpected, each bind read-only), the default pack
 * dir, the environment, no published port, and the hardening flags.
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
  problems.push(...envProblems(envOf(c)));
  if (Object.keys(c.HostConfig?.PortBindings ?? {}).length > 0) problems.push("it publishes a port (a run listens nowhere)");
  const h = c.HostConfig ?? {};
  for (const cap of want.capDrop) if (!(h.CapDrop ?? []).includes(cap)) problems.push(`it does not drop ${cap} capabilities`);
  if (want.readOnly && h.ReadonlyRootfs !== true) problems.push("its root filesystem is not read-only");
  for (const opt of want.securityOpt) if (!(h.SecurityOpt ?? []).includes(opt)) problems.push(`${opt} is not set`);
  if (want.user !== undefined && c.Config?.User !== want.user) problems.push(`it runs as ${c.Config?.User || "(the image's user)"}, not ${want.user}`);
  if (want.pids !== undefined && h.PidsLimit !== want.pids) problems.push(`its pids limit is ${h.PidsLimit ?? 0}, not ${want.pids}`);
  if (want.memory !== undefined && h.Memory !== want.memory) problems.push(`its memory limit is ${h.Memory ?? 0}, not ${want.memory}`);
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
  const argv = runArgs(service, sampleInputs(packDir), { project: PROJECT, image: service.image, root: ctx.root, buildDir: join(fresh.root, "build"), stateDir: "/audit/sample/state", user: ctx.user, env: ctx.env }, []);
  const fix = "the run container's definition is stack/compose.yaml's archon service, translated by src/run/spec.ts: restore them";
  const want = shapeOf(argv);
  const static_ = definitionProblems(want, packDir);
  if (static_.length > 0) return [result(id, "fail", `the run definition (runArgs, src/run/spec.ts): ${static_.join("; ")}. ${fix}`)];

  const runs = await runContainers(run);
  const live = "containers" in runs ? runs.containers.filter(isRunning) : [];
  const bad = live.map((c) => [c, liveProblems(c, want, packDir)] as const).filter(([, p]) => p.length > 0);
  if (bad.length > 0) {
    return [result(id, "fail", `${bad.map(([c, p]) => `${containerName(c)}: ${p.join("; ")}`).join("; ")}. A live run container must be as the run definition says: stop it with \`hapi run stop <id>\`, then ${fix}`)];
  }
  const checked = "unavailable" in runs ? `no live run container was checked (${runs.unavailable})` : live.length === 0 ? "no live run container was checked (none is running)" : `${live.length} live run containers are as it says`;
  const nonProxy = Object.entries(serviceEnvironment("archon")).filter(([k]) => !/proxy/i.test(k)).length;
  return [
    result(
      id,
      "pass",
      `the run definition (runArgs, src/run/spec.ts) gives ${RUN_PATHS.piDir} a tmpfs (${PI_TMPFS}), binds ${READ_ONLY_DESTINATIONS.length} files (the generated ones, /.archon/.env and the pack ${packDir}) read-only, sets all ${Object.keys(serviceEnvironment("archon")).length} values of serviceEnvironment("archon") (${nonProxy} besides the proxy's) and publishes no port; ${checked}`,
    ),
  ];
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
    summary = `approvals.mode ${mode === undefined ? "(Hermes's default, manual)" : String(mode)}, no unattended mode that approves`;
  }
  if (problems.length > 0) {
    return [result(id, "fail", `${name}: ${problems.join("; ")}. Yolo and approvals.mode: off are forbidden (spec §9.1): restore build/ with \`mise run up\` and remove the flag or variable`)];
  }
  return [result(id, "pass", `${name}: no --yolo, no HERMES_YOLO_MODE or HERMES_YOLO, HERMES_HOME ${home}, and its read-only ${dest} (${mount!.Source}) has ${summary}`)];
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
