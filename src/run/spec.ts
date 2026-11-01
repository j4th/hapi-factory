/**
 * The run container's `docker run` arguments (design §3.1, §3.5; §6a items
 * 2-4, 12 and 16; spike 07, spike 08 finding 9). A run is a fresh container of
 * the profile-only `archon` service of stack/compose.yaml, the reviewed source
 * of its image, user, limits, hardening and environment, whatever its kind:
 * the kind's profile (./kinds.ts `kindProfile`) says what differs. Compose
 * can't give a run its own network or tmpfs mounts, and `compose down` never
 * stops a `docker run` container (design §6a item 12), so the launcher
 * translates the service into `docker run` arguments itself, and refuses a key
 * it doesn't translate (`TRANSLATED_KEYS`): a hardening setting added there
 * can't be dropped on the way.
 *
 * What the service can't say, `runArgs` adds:
 * - the run's name (`runName`) and labels: `org.hapi.run` and
 *   `org.hapi.project` on every object of the run, so `down`, the kill
 *   switches and the reaper find it, plus `org.hapi.int` for a test project;
 *   on the container alone, `org.hapi.kind`, the kind the audit holds it to;
 *   the stack's labels are computed as `up` computes them (who started it, the
 *   dev bypass, the build's digest), since the service's are Compose
 *   interpolations; and the image's `com.docker.compose.*` labels, blanked;
 * - its own internal network, which the launcher makes and joins its kind's
 *   proxy to (`egress-archon`, or `egress-review` for a review) under the
 *   alias the proxy variables name. A review's proxy variables are the review
 *   zone's (`proxyEnv("review")`), each in place of the archon zone's;
 * - tmpfs mounts for `$HOME`, `/.archon` and Pi's agent dir, so nothing a run
 *   writes there outlives it, with the generated files bound read-only into
 *   them: Pi's `models.json`, `models-store.json` (`{}`, so a planted store
 *   can't reprice or reroute a model), `hapi-guard.json`, `settings.json` and
 *   `extensions/` (H-181(a)); Archon's `config.yaml`, an empty `/.archon/.env`
 *   (Archon loads it over the process env at every start, design §6a item 2)
 *   and the workflow pack; the run config, the gitconfig, the kind's prelude
 *   (stack/archon/run.sh, verify.sh or review.sh), the run's `run.json`, its
 *   work order and task text (`order.json`, `task.md`), the source repo's git
 *   dir, a review's or fix's inputs dir, and the kind's extra binds.
 *   `hapi-guard.json` and the run config are the run's own, in its record
 *   dir: generated per run from the policy with the repo's overlay applied,
 *   for `build/roster`'s roster (H-172; ./lifecycle.ts `startRun`). The rest
 *   of build/ is shared;
 * - two per-run volumes, `/work` (the clone) and `/out` (what may leave),
 *   which the launcher makes and chowns first (design §6a item 16): each is
 *   bind-backed, on a dir of its own on the run disk, a filesystem capped at
 *   `runs.disk.gb` (./disk.ts; design §3.1, H-217);
 * - each secret of the kind's zone as `-e NAME`, never its value: the docker
 *   CLI takes the value from its own environment (spike 07 finding 16). A
 *   verify run's kind has no zone, so it is given none;
 * - `--stop-timeout STOP_GRACE_S`, so a daemon stop gives the prelude the same
 *   grace `hapi run stop` does, and `--init=false`, so the prelude is the
 *   container's PID 1 whatever the daemon's default;
 * - the kind's prelude as the entrypoint, from `/app`, never the clone (design
 *   §6a items 2 and 4), with the kind's workflow, or the work order's own.
 *
 * `--pull never` translates `pull_policy: build`: the image is the one `hapi
 * stack up` built, and a registry image of that name is never fetched.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { mountable } from "../audit/checks/tools";
import { RUN_PATHS } from "../generate/archon";
import { ROSTERS } from "../generate/index";
import type { RosterName, Runs } from "../policy/types";
import { ENV_NAME } from "../secrets/files";
import type { FsProbe } from "./disk";
import { INPUTS_DIR, KIND_LABEL, type KindProfile, proxyZoneOf } from "./kinds";
import { proxyEnv, reservedEnvRule } from "../stack/env";
import { buildDigest, currentUserOverride, type Env, PROJECT, PROJECT_LABEL, RUN_LABEL, type Runner } from "../stack/up";
import type { WorkOrder } from "../workorder/validate";

/** What the launcher runs with; every field has a default (src/run/cli.ts `runDeps`), and tests give their own. */
export interface RunDeps {
  /** src/stack/up.ts's Runner (text output). */
  run: Runner;
  /** A runner whose stdout is bytes, never decoded: copy-out reads `run.bundle` through it. */
  runBytes: (cmd: string[], env: Record<string, string>) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
  /** A runner that hands each line of stdout and stderr to `line` as it comes, without its newline, and resolves to the exit code: `hapi run watch`'s `docker logs --follow`. */
  stream: (cmd: string[], env: Record<string, string>, line: (text: string) => void) => Promise<number>;
  env: Env;
  user: string;
  now: () => Date;
  /** "hapi", or a test project. */
  project: string;
  /** The archon image tag: the service's `image`. */
  image: string;
  /** The project's egress-archon container, e.g. "hapi-egress-archon-1". */
  egress: string;
  /** ${XDG_STATE_HOME:-~/.local/state}/hapi/runs, or a temp dir in tests. */
  stateDir: string;
  /** The run disk, where each run's volumes have their dirs (./disk.ts): RUN_DISK (./locks.ts), or a temp dir in tests. */
  diskDir: string;
  /** What the run disk's filesystem is (./disk.ts `probeFs`); tests give a fake. */
  probeFs: FsProbe;
  /** The checkout. */
  root: string;
  buildDir: string;
  /** The workflow pack bound at /.archon/workflows/hapi: <root>/archon/workflows/hapi, or a test's fixture pack. */
  packDir: string;
  /** policy/runs.yaml: the caps on live runs, on each output file and on the run disk. */
  runs: Runs;
  /** Starts `hapi run supervise <id>`, detached: settles once it has started, and rejects if it couldn't. */
  spawnDetached: (argv: string[]) => Promise<void>;
}

export interface RunInputs {
  runId: string;
  /** The source repository's git dir, absolute: `<checkout>/.git`, a bare repo itself, or the repo's mirror. */
  repo: string;
  /** The commit the run starts from: a hand run's source's HEAD, or the commit the poller names. */
  sha: string;
  workOrder: WorkOrder;
  public: boolean;
  /** The run's budget (`RunFile.budget_usd`). */
  budgetUsd: number;
  packDir: string;
}

/** The roster the deployed build was made for: `<buildDir>/roster`, one bare word that `buildAll` writes. Throws when it is missing or names no roster. */
export function readRoster(buildDir: string): RosterName {
  const file = join(buildDir, "roster");
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    text = undefined;
  }
  const name = text?.trim();
  if (name === undefined || !(ROSTERS as readonly string[]).includes(name)) {
    throw new Error(`${file} is missing or names no roster (${ROSTERS.join(", ").replace(/, ([^,]+)$/, " or $1")}): \`mise run up\` writes it`);
  }
  return name as RosterName;
}

/**
 * Every key of the archon service `runArgs` translates; any other key on the
 * service is refused. How each is translated:
 * - `build`, `pull_policy`, `profiles`: how `hapi stack up` builds the image
 *   (`compose build archon`); the launcher runs that image with `--pull never`;
 * - `image`: `RunDeps.image`'s default;
 * - `restart`: must be "no", `docker run`'s own default: a run is one-shot;
 * - `user`, `read_only`, `cap_drop`, `security_opt`, `pids_limit`,
 *   `mem_limit`, `logging`, `tmpfs`: their `docker run` flags;
 * - `labels`: as given, but the three the stack's anchor interpolates
 *   (`LABEL_VALUES`), which are computed as `up` computes them;
 * - `env_file`: the launcher reads the run's kind's zone's file itself
 *   (./lifecycle.ts `zoneSecrets`: the archon zone's archon.env, or a review's
 *   review.env; a verify run reads none) and passes each name as `-e NAME`;
 * - `environment`: `-e K=V`, each value as written.
 */
export const TRANSLATED_KEYS: readonly string[] = [
  "build", "pull_policy", "profiles", "image", "restart",
  "user", "read_only", "cap_drop", "security_opt", "pids_limit", "mem_limit", "logging", "labels", "tmpfs",
  "env_file", "environment",
];

/** The image's appuser (stack/archon/Dockerfile): the tmpfs mounts, the volume chown and the copy-out helper assume it. */
export const APP_USER = "1001:1001";
/**
 * Seconds between TERM and KILL, for `hapi run stop` (`docker stop -t`) and for any other stop (`--stop-timeout`:
 * a daemon restart or a host reboot). Not Docker's 10: after the workflow ends, run.sh starts the Archon CLI (bun)
 * up to three more times for its read-back (result.json, the transcript), and a KILL inside that leaves a stopped
 * run without its outputs. Spike 07 saw a bash-only run's post-run steps take under a second.
 */
export const STOP_GRACE_S = 30;
/** The appuser's home in the image: a tmpfs per run, with the generated gitconfig bound into it. */
export const APP_HOME = "/home/appuser";
/** "hapi-run-<id>", or "<project>-run-<id>" for a test project: the container, its network, and the stem of its volumes. */
export function runName(project: string, runId: string): string {
  return `${project}-run-${runId}`;
}

/** The labels on every object of a run: its id and project, and `org.hapi.int` for a test project (tests/stack/helpers.ts cleans those up). */
export function runLabels(project: string, runId: string): string[] {
  return ["--label", `${RUN_LABEL}=${runId}`, "--label", `${PROJECT_LABEL}=${project}`, ...(project === PROJECT ? [] : ["--label", `org.hapi.int=${project}`])];
}

/**
 * The build's digest, as `up` labels its containers (H-147): every file under `buildDir`, each named
 * `<its last segment>/<path>`, so `build/<path>` for the deployed build, as `up` names what it wrote.
 */
export function buildInUse(buildDir: string): string {
  const dir = resolve(buildDir);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) files.push(join(basename(dir), relative(dir, join(d, e.name))));
    }
  };
  try {
    walk(dir);
  } catch (e) {
    throw new Error(`cannot read the build at ${dir} (${(e as NodeJS.ErrnoException).code ?? "error"}): \`mise run up\` writes it`);
  }
  return buildDigest(files, dirname(dir));
}

const SERVICE = "stack/compose.yaml: archon:";
const untranslated = (what: string) => new Error(`${SERVICE} ${what} isn't translated into the run container; add it to src/run/spec.ts or remove it`);

/** What the stack's interpolated labels are computed from: who started the run, the dev bypass, the build's digest. */
type Started = { user: string; override: boolean; digest: string };

/** The labels the stack's anchor interpolates, and how the launcher computes each. */
const LABEL_VALUES: Record<string, (d: Started) => string> = {
  "org.hapi.started-by": (d) => d.user,
  "org.hapi.dev-override": (d) => (d.override ? "1" : "0"),
  "org.hapi.build-sha256": (d) => d.digest,
};

/**
 * The Compose labels the archon image carries (`docker image inspect hapi-factory/archon:0.12.1`: the build leaves
 * them on it), which a container inherits. Blank, so a live run is never the archon service of the Compose project
 * `hapi` to `docker ps --filter label=com.docker.compose.project=hapi`, `compose ps` or the audit's stack
 * checks; the audit finds runs by `org.hapi.run` and `org.hapi.project`.
 */
const COMPOSE_LABELS = ["com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.version"];

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, key: string): string[] => {
  const list = typeof v === "string" ? [v] : v;
  if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) throw new Error(`${SERVICE} ${key} must be a list of strings`);
  return list;
};
const scalar = (v: unknown, what: string): string => {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v !== "string") throw new Error(`${SERVICE} ${what} has no value: a name without one would pass the launcher's own value through`);
  if (v.includes("${")) throw new Error(`${SERVICE} ${what} holds a Compose interpolation, which the launcher doesn't do`);
  return v;
};

/** The no-new-privileges setting every service has (the stack's hardening anchor). */
export const NO_NEW_PRIVILEGES = "no-new-privileges:true";

/**
 * The service's hardening and limits, as `docker run` flags, in a fixed order. Each hardening key is required: a
 * service that lost one (a drifted compose.yaml on the host) is refused, never run without it (final review B-2).
 */
function hardening(s: Record<string, unknown>): string[] {
  if (s.restart !== undefined && s.restart !== "no") throw new Error(`${SERVICE} restart is ${JSON.stringify(s.restart)}: a run container is one-shot, so it must be "no"`);
  if (s.user !== APP_USER) throw new Error(`${SERVICE} user is ${JSON.stringify(s.user)}: the run container runs as ${APP_USER}, the image's appuser, which its tmpfs mounts, volumes and copy-out assume`);
  if (s.read_only !== true) throw new Error(`${SERVICE} read_only is ${JSON.stringify(s.read_only) ?? "undefined"}: the run container's root filesystem must be read-only (read_only: true)`);
  const caps = strings(s.cap_drop ?? [], "cap_drop");
  if (!caps.includes("ALL")) throw new Error(`${SERVICE} cap_drop does not include ALL: the run container drops every capability`);
  const opts = strings(s.security_opt ?? [], "security_opt");
  if (!opts.includes(NO_NEW_PRIVILEGES)) throw new Error(`${SERVICE} security_opt does not include ${NO_NEW_PRIVILEGES}: the run container gains no privileges`);
  if (s.pids_limit === undefined) throw new Error(`${SERVICE} pids_limit is not set: the run container has a pid limit`);
  if (s.mem_limit === undefined) throw new Error(`${SERVICE} mem_limit is not set: the run container has a memory limit`);
  const out = ["--user", APP_USER, "--read-only"];
  for (const cap of caps) out.push("--cap-drop", cap);
  for (const opt of opts) out.push("--security-opt", opt);
  out.push("--pids-limit", scalar(s.pids_limit, "pids_limit"), "--memory", scalar(s.mem_limit, "mem_limit"));
  if (s.logging !== undefined) {
    if (!isMap(s.logging)) throw new Error(`${SERVICE} logging must be a mapping`);
    for (const k of Object.keys(s.logging)) if (k !== "driver" && k !== "options") throw untranslated(`logging key "${k}"`);
    if (s.logging.driver !== undefined) out.push("--log-driver", scalar(s.logging.driver, "logging driver"));
    const options = s.logging.options ?? {};
    if (!isMap(options)) throw new Error(`${SERVICE} logging options must be a mapping`);
    for (const [k, v] of Object.entries(options)) out.push("--log-opt", `${k}=${scalar(v, `logging option ${k}`)}`);
  }
  return out;
}

/** The service's labels, the anchor's interpolated ones computed. */
function labels(s: Record<string, unknown>, computed: Started): string[] {
  if (s.labels === undefined) return [];
  if (!isMap(s.labels)) throw new Error(`${SERVICE} labels must be a mapping`);
  return Object.entries(s.labels).flatMap(([k, v]) => {
    const value = LABEL_VALUES[k];
    if (value !== undefined) return ["--label", `${k}=${value(computed)}`];
    if (typeof v === "string" && v.includes("${")) throw new Error(`${SERVICE} label "${k}" holds a Compose interpolation, which the launcher doesn't do; compute it in src/run/spec.ts or remove it`);
    return ["--label", `${k}=${scalar(v, `label "${k}"`)}`];
  });
}

/**
 * `-e K=V` for the service's environment, then `-e NAME` for each secret of the kind's zone: a secret never shadows
 * the environment. A container behind egress-review (a review's) has each proxy variable of the archon zone set to
 * the review zone's value, in place; every other kind keeps the service's. A kind with no zone (verify) is given no
 * secret: a name passed for it is refused, never bound.
 */
function environment(s: Record<string, unknown>, secretNames: string[], profile: KindProfile): string[] {
  const env = s.environment ?? {};
  if (!isMap(env)) throw new Error(`${SERVICE} environment must be a mapping`);
  const proxy = proxyZoneOf(profile) === "archon" ? {} : proxyEnv(proxyZoneOf(profile));
  const proxied = new Set(Object.keys(proxyEnv("archon")));
  const out = Object.entries(env).flatMap(([k, v]) => {
    const value = scalar(v, `environment ${k}`);
    return ["-e", `${k}=${proxied.has(k) && Object.hasOwn(proxy, k) ? proxy[k] : value}`];
  });
  if (profile.zone === undefined) {
    if (secretNames.length > 0) throw new Error(`a ${profile.kind} run holds no key: it is given no zone's secrets`);
    return out;
  }
  const file = `the ${profile.zone} zone's env file`;
  for (const name of [...secretNames].sort()) {
    if (!ENV_NAME.test(name)) throw new Error(`${file} holds a name that is not an env name (not shown, in case it is a value)`);
    const rule = reservedEnvRule(name) ?? (Object.hasOwn(env, name) ? `${name} is reserved: the archon service's environment sets it` : undefined);
    if (rule !== undefined) throw new Error(`${file}: ${rule}`);
    out.push("-e", name);
  }
  return out;
}

/**
 * The whole `docker run` argv for one run of `profile`'s kind, in a fixed
 * order (see the module comment). Pure but for reading the build's files for
 * its digest label. Throws on a service key or value it can't translate, a
 * secret name that would shadow the environment (or any, for a kind with no
 * zone), or a path a `-v` can't hold.
 */
export function runArgs(
  service: Record<string, unknown>,
  r: RunInputs,
  d: Pick<RunDeps, "project" | "image" | "root" | "buildDir" | "stateDir" | "user" | "env">,
  secretNames: string[],
  profile: KindProfile,
): string[] {
  for (const key of Object.keys(service)) if (!TRANSLATED_KEYS.includes(key)) throw untranslated(`key "${key}"`);
  const name = runName(d.project, r.runId);
  const who = currentUserOverride(d.env, d.user);
  const [uid, gid] = APP_USER.split(":");
  const tmpfs = (path: string, size: string) => `${path}:size=${size},uid=${uid},gid=${gid},mode=0700`;
  const pi = join(resolve(d.buildDir), "pi");
  const archon = join(resolve(d.buildDir), "archon");
  // The run's own files, in its record dir (./records.ts `createRun`).
  const own = join(resolve(d.stateDir), r.runId);
  const prelude = `/opt/hapi/${profile.prelude}`;
  const binds: [string, string][] = [
    [join(pi, "models.json"), `${RUN_PATHS.piDir}/models.json`],
    [join(pi, "models-store.json"), `${RUN_PATHS.piDir}/models-store.json`],
    [join(own, "hapi-guard.json"), `${RUN_PATHS.piDir}/hapi-guard.json`],
    [join(pi, "settings.json"), `${RUN_PATHS.piDir}/settings.json`],
    [join(pi, "extensions"), `${RUN_PATHS.piDir}/extensions`],
    [join(archon, "config.yaml"), "/.archon/config.yaml"],
    [join(archon, "empty.env"), "/.archon/.env"],
    [resolve(r.packDir), RUN_PATHS.pack],
    [join(own, "run-config.yaml"), "/opt/hapi/run-config.yaml"],
    [join(archon, "gitconfig"), `${APP_HOME}/.gitconfig`],
    [join(resolve(d.root), "stack", "archon", profile.prelude), prelude],
    [join(own, "run.json"), RUN_PATHS.runFile],
    [join(own, "order.json"), RUN_PATHS.order],
    [join(own, "task.md"), RUN_PATHS.task],
    [resolve(r.repo), RUN_PATHS.source],
    // A review's or fix's inputs: the host's copy in the run's dir, never the dir it came from.
    ...(profile.inputs ? [[join(own, INPUTS_DIR), RUN_PATHS.inputs] as [string, string]] : []),
    ...profile.extraBinds(d),
  ];
  return [
    "docker", "run", "-d", "--pull", "never", "--name", name,
    ...runLabels(d.project, r.runId),
    "--label", `${KIND_LABEL}=${profile.kind}`,
    ...labels(service, { user: who.user, override: who.override, digest: buildInUse(d.buildDir) }),
    ...COMPOSE_LABELS.flatMap((k) => ["--label", `${k}=`]),
    ...hardening(service),
    "--stop-timeout", String(STOP_GRACE_S),
    // The prelude is PID 1, whatever the daemon's default ("init": true would put docker-init there): a verify's and a
    // review's kill of what the workflow left runs only as PID 1.
    "--init=false",
    "--network", name,
    ...strings(service.tmpfs ?? [], "tmpfs").flatMap((t) => ["--tmpfs", t]),
    ...[tmpfs(APP_HOME, "256m"), tmpfs("/.archon", "512m"), tmpfs(RUN_PATHS.piDir, "64m")].flatMap((t) => ["--tmpfs", t]),
    ...binds.flatMap(([src, dst]) => ["-v", `${mountable(src, "the run container")}:${dst}:ro`]),
    "-v", `${name}-work:/work`, "-v", `${name}-out:${RUN_PATHS.out}`,
    ...environment(service, secretNames, profile),
    "-w", "/app", "--entrypoint", "sh", d.image, prelude, profile.workflow ?? r.workOrder.workflow, r.sha, r.workOrder.id, r.workOrder.trace.traceparent,
  ];
}
