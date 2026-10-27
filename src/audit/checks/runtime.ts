/**
 * The runtime.* checks: what the running stack actually has, read with
 * `docker inspect` (spec §9.1, §9.2, §9.3, §11.3).
 *
 * - runtime.archon-env: the archon container's environment holds every value
 *   of `serviceEnvironment("archon")` (the Global Constraints' Archon and Pi
 *   settings, and its proxy), and its Pi agent dir and config are mounted
 *   read-only.
 * - runtime.hermes-no-yolo: Hermes's effective approval settings: no `--yolo`
 *   in its argv, no HERMES_YOLO_MODE or HERMES_YOLO in its env, HERMES_HOME
 *   where hapi puts it, and in the config mounted read-only at
 *   $HERMES_HOME/config.yaml, approvals.mode not off and no unattended mode
 *   that approves. The config is read as YAML 1.1, as Hermes reads it, where a
 *   bare `off` or `no` is false.
 * - runtime.dev-override: the labels `hapi stack up` puts on every container
 *   (H-147). `1` is the dev bypass (HAPI_ALLOW_CURRENT_USER=1); `unknown` or
 *   empty means a stack not started through `hapi stack up`, never "no
 *   bypass". Both fail, and so does this shell's own bypass
 *   (`currentUserOverride`), unless `--dev` makes them a skip.
 *
 * With no container of the Compose project, or no Docker, each is a skip.
 */
import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { PI_AGENT_DIR } from "../../generate/archon";
import { HERMES_HOME, serviceEnvironment } from "../../stack/env";
import { currentUserOverride, HAPI_USER, PROJECT } from "../../stack/up";
import { type AuditRun, type CheckResult, result } from "../types";

/** A container as `docker inspect` prints it (the fields the audit reads). */
export interface Container {
  Name: string;
  State?: { Running?: boolean };
  Path?: string;
  Args?: string[];
  Config?: { Labels?: Record<string, string> | null; Env?: string[] | null; Cmd?: string[] | null; Entrypoint?: string[] | null };
  Mounts?: { Source?: string; Destination?: string; RW?: boolean }[] | null;
}

export type Stack = { containers: Container[] } | { unavailable: string };

const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, 200);

/** Every container of the Compose project `hapi`, running or not (memoized per audit). */
export function stackContainers(run: AuditRun): Promise<Stack> {
  return run.once("stack", async (): Promise<Stack> => {
    let ps;
    try {
      ps = await run.ctx.exec(["docker", "ps", "-a", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${PROJECT}`]);
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

/** runtime.archon-env */
export async function archonEnv(run: AuditRun): Promise<CheckResult[]> {
  const id = "runtime.archon-env";
  const c = await running(run, id, "archon");
  if ("status" in c) return [c];
  const env = envOf(c);
  const want = serviceEnvironment("archon");
  const problems: string[] = [];
  for (const [name, value] of Object.entries(want)) {
    if (!env.has(name)) problems.push(`${name} is not set`);
    else if (env.get(name) !== value) problems.push(`${name} is not ${value}`);
  }
  for (const dest of [PI_AGENT_DIR, "/.archon/config.yaml"]) {
    const m = (c.Mounts ?? []).find((x) => x.Destination === dest);
    if (m === undefined) problems.push(`nothing is mounted at ${dest}`);
    else if (m.RW !== false) problems.push(`${dest} is not mounted read-only`);
  }
  const name = containerName(c);
  if (problems.length > 0) {
    return [
      result(
        id,
        "fail",
        `${name}: ${problems.join("; ")}. Its environment: is serviceEnvironment("archon") in src/stack/env.ts, set in stack/compose.yaml; restore the file and run \`mise run up\``,
      ),
    ];
  }
  return [result(id, "pass", `${name} has all ${Object.keys(want).length} values of serviceEnvironment("archon") (${Object.entries(want).filter(([k]) => !/proxy/i.test(k)).map(([k, v]) => `${k}=${v}`).join(", ")}, and its proxy), and ${PI_AGENT_DIR} and /.archon/config.yaml mounted read-only`)];
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
  const stack = await stackContainers(run);
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
