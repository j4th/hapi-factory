/**
 * `hapi run start`, `stop` and `supervise` (design §3.1; §6a items 11, 12, 14
 * and 16), and `startRun`, the launcher's API (design §3.4, §6a item 1), on
 * the host, as the hapi user: as anyone else each command re-execs
 * `mise run hapi -- run <sub> ...` as hapi (`reexecScript("hapi")`, as `up`
 * does), and HAPI_ALLOW_CURRENT_USER=1 is the same dev-only downgrade. The
 * re-exec runs in hapi's checkout, so `start` first makes `--repo` and
 * `--work-order` absolute from the caller's working dir (a path that isn't
 * there is a usage error).
 *
 * `startRun(d, o)` is what the poller calls: a parsed work order, a source (the
 * repo's mirror, or the harvester's checked copy of it, neither of which holds a
 * credential) and an explicit commit in, the run's record out, or the refusal
 * as a thrown error, so nothing scrapes stdout. Each phase of a work order is a
 * run of its own kind (`o.kind`), whose profile (./kinds.ts `kindProfile`;
 * design §3.5) decides its container. It prints nothing. It refuses, before
 * anything is made, at the first of these that fails:
 * 1. reap (`reapRuns`);
 * 2. `egress_extra`, in the work order or the repo's overlay: refused until a
 *    per-run proxy exists (H-088, H-207);
 * 3. the run's kind, and the workflow it runs, which must be one of hapi's pack
 *    (`packNodes`): its kind's (`factory-verify`, `factory-review`) for a verify
 *    or a review, the work order's own for a worker or a fix. The pack must
 *    parse, name each workflow by its file's stem and keep
 *    `pi.enableExtensions` on;
 * 4. the run's round, budget (it may only lower the work order's budget.usd),
 *    retry and GitHub repo (`forgeRepo`, an owner/name), each in range;
 * 5. the run disk against `runs.disk` (`diskProblem`, ./disk.ts: refused under
 *    `hard`; under `soft` a warning, which startRun returns on its result for
 *    the caller to show; H-217);
 * 6. its kind's zone's env file: the archon zone's for a worker or a fix, the
 *    review zone's for a review (missing: run `mise run up`). A verify run holds
 *    no key of any kind, so it reads none. A review run whose overlaid
 *    `runs.phases.coderabbit` is on needs CODERABBIT_API_KEY in it (step 10):
 *    the key is optional in the manifest, but no automatic fallback runs a
 *    review without the CodeRabbit step it was asked for. With it off, the
 *    review container isn't given CODERABBIT_API_KEY even when the file has it;
 * 7. the source (`sourceGitDir`);
 * 8. the commit: a commit id, which the source holds (host git with no config);
 * 9. the roster `build/roster` names (`readRoster`, ./spec.ts);
 * 10. the policy, with the repo's overlay applied (H-172): the work order's roles
 *     against the roster, for the run's kind (`rolesProblem`, ruling m16: a
 *     worker's implement on a pi tier; a review's on a claude tier, with
 *     another model than implement's), the budget against its kind's cap
 *     (`runs.phases.round_usd` for every kind but `worker`), and a review's
 *     CodeRabbit key when `phases.coderabbit` is on (step 6). The sidecar
 *     the run starts comes from it too: the overlay's `sidecar`, for a kind
 *     that may have one (./kinds.ts `sidecar`) whose work order smokes;
 * 11. the parent, for every kind but `worker`: the work order's worker run, whose
 *     sha is the run's base commit (`RunFile.base`);
 * 12. the inputs dir (`StartOptions.inputsDir`): a review and a fix need one, a
 *     worker and a verify take none, and it holds only regular files, its kind's
 *     inputs (./kinds.ts `inputFiles`; ./records.ts `inputsProblem`): a fix's
 *     findings.md, a review's diff.patch and verify.json; never a bundle;
 * 13. the run's own files (./records.ts `PER_RUN_FILES`): its `hapi-guard.json`
 *     and run config, generated from that policy for that roster, and the host's
 *     copies of its work order and task text; and the container's argv
 *     (`runArgs`, for its kind's profile).
 * The run's key names its kind, round and pass (./records.ts `keyPart`), so the
 * engine's runs never meet a hand run's key, nor an earlier pass's. Then it makes
 * the run:
 * 1. under the launcher's lock: admission (the key; one live run per repo, by
 *    its git dir and its `forgeRepo`, m23; `runs.max_live`; ./records.ts), then
 *    the run's dir with record.json, run.json, its own files and, for a review
 *    or a fix, its copy of the inputs dir; then, for a run with a sidecar, its
 *    data, exported from the run's commit into the run's dir (./sidecar.ts
 *    `exportSidecarData`: a data dir it refuses fails the start here);
 * 2. the run's own network, `--internal`, checked with `networkProblem`;
 * 3. its kind's proxy joined to it (`egressOf`: egress-archon, or egress-review
 *    for a review) under the alias the proxy variables name (spike 07 finding
 *    13);
 * 4. the two volumes, each bind-backed on a dir of its own on the run disk
 *    (`volumeDir`, made 0700 and checked before the volume: Docker would make a
 *    volume on a missing dir and fail only at `docker run`, spike 09 finding
 *    17), chowned to 1001 by a one-shot helper with CAP_CHOWN alone: a fresh
 *    volume's root is root's (spike 07 finding 12). Like every helper, it runs
 *    under the host's `timeout` (./copyout.ts `bounded`);
 * 5. the run's smoke sidecar, when it has one (./sidecar.ts `startSidecar`): on
 *    the run's network as `hapi-sidecar`, its data read-only, no secret;
 * 6. the run container, its kind's secrets passed by name, their values in the
 *    docker CLI's env only (a verify run's has none);
 * 7. a detached `hapi run supervise <id>`, awaited until its process has
 *    started: one that can't start is a failed step.
 * A failure after the run's dir is made removes what start made (its kind's
 * egress disconnected before its network goes, and the sidecar with the run's
 * other containers, by its labels) and the run's dir, then releases the lock.
 * A supervisor that starts and then dies is left to the reap (below): nothing
 * in start can see it.
 *
 * `hapi run start`, by hand, is a thin wrapper: it reads the work order file,
 * the source's HEAD, the task.md beside the work order and the repo's overlay
 * at that commit (`.factory/config.yaml`, design §3.5), then calls `startRun`
 * as a worker with no retry, a hand run: Plan 02's two-part key, which the
 * poller never takes as its own. It prints startRun's warnings, then the run
 * id, and returns at once.
 *
 * `supervise` waits for the container (`docker wait` under a host `timeout` to
 * the run's deadline, the work order's budget.minutes from its start, for
 * every kind), stops it at the deadline, then finalizes. `stop` stops one run,
 * but not one that has no container yet (H-218: its start may still be making
 * it). Either records why it is stopping before it stops the container
 * (`stopRequested`), so whichever process finalizes records it. The operator's
 * stop outranks the deadline: "stopped" replaces an earlier "timed-out" while
 * the run is live, never the reverse. The stop grace is `STOP_GRACE_S`.
 *
 * `finalizeRun`, under the run's own lock and once only: stop the container if
 * it still runs (no volume a live worker can write is ever read), then, under
 * the run disk's lock (./locks.ts; H-210), which `down` holds while it removes
 * runs, copy its kind's outputs out (./copyout.ts), check the bundle (exactly
 * one head, `HEAD`, read by host git with hardened flags in an empty dir: spike
 * 07 finding 19),
 * read Archon's status from result.json (a paused run exits 0, so the exit code
 * is never the status: spike 07 finding 5), check that the guard ran in every
 * Pi attempt (design §6a item 7; spike 08 finding 10), keep the tail of the
 * container's log when no result.json came out (`keepContainerLog`); then
 * write the record, with the run's spend and turns when they are known
 * (./spend.ts) and the container's exit code (`docker inspect`; never the
 * status), before anything is removed, so a finalizer that dies next
 * leaves the outcome (H-219); then remove every object of the run, disconnecting
 * only its kind's egress, empty and remove its volumes' dirs on the run disk
 * (`removeVolumeDirs`), and, only if that cleanup fails, add its reason to the
 * record as it then is. A run whose
 * container is gone was removed around hapi (`mise run down`, a cleanup, a
 * prune), so nothing is copied and it fails: a copy-out helper would race a
 * removal of its volumes (`volume is in use`). The finalize leaves its volumes,
 * and their dirs on the run disk, in place, since nothing was copied out of
 * them (H-209): a `mise run down` that takes the run disk's lock removes the
 * volumes, and the next reap their dirs. A held run disk lock (`down` is
 * removing runs) makes the finalize wait (`finalizeRun`), or a reap leave the
 * run for the next one.
 *
 * `reapRuns` runs first in `start` and `stop` (`supervise` is spawned by a
 * start that has just reaped): it finalizes a live record whose container has
 * exited, and stops and finalizes one past its deadline, but never the run
 * `stop` is about to stop (`o.stopping`): the operator's stop outranks the
 * deadline, so `stop`'s own reap never times that run out. So a supervisor that
 * died leaves nothing behind for long. Then the run disk's sweep: a run's dir
 * there whose run isn't live and whose volume is gone (a start rolled back, a
 * `down` that left the volumes, a cleanup that failed) is emptied and removed;
 * one it can't clean fails the reap, and so every start, until it is cleaned.
 * Then retention, fail-closed: it deletes
 * a finished run's dir only once record.json's `harvestedAt` (Plan 03's
 * harvester sets it) is more than `runs.retention_days` ago, so an output no
 * harvester has read is never lost.
 *
 * Everything that comes out of a run is untrusted data: stored and checked,
 * never executed, never read by git with its own config, never printed raw.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { packNodes } from "../audit/checks/tools";
import { parseOwnerRepo } from "../forge/github/app-token";
import { emitArchon, type RunFile } from "../generate/archon";
import { emitPi } from "../generate/pi";
import { loadPolicy, PolicyError } from "../policy/load";
import { applyOverlay, overlayFromText, PolicyLoosenError } from "../policy/overlay";
import type { Policy, RepoOverlay, Roster, RosterName, Sidecar } from "../policy/types";
import { ENV_DIR, parseEnvFile, runtimeDir } from "../secrets/files";
import { composeServices } from "../stack/compose";
import { currentUserOverride, definedEnv, HAPI_USER, listed, networkProblem, reexec, removeRuns, runCommand, runFilters } from "../stack/up";
import { loadWorkOrder, type WorkOrder } from "../workorder/validate";
import { parseRunId, parseStart, runDeps, START_USAGE, STOP_USAGE, SUPERVISE_USAGE } from "./cli";
import { bounded, copyOut, HELPER_HOST_TIMEOUT_S, HELPER_KILL_AFTER_S, timedOut } from "./copyout";
import { diskProblem, dockerDataRoot, removeVolumeDirs, volumeDir } from "./disk";
import { hardenedGit } from "./git";
import { egressOf, type KindProfile, kindProfile, MAX_OUTPUTS, RUN_KINDS, type RunKind } from "./kinds";
import { withStackLock } from "./locks";
import {
  capacityProblem,
  containerExists,
  createRun,
  inputsProblem,
  isLive,
  keyPart,
  keyProblem,
  listRecords,
  liveRuns,
  lockHeld,
  newRunId,
  type PER_RUN_FILES,
  readRecord,
  RUN_ID,
  recordDir,
  removeRunDir,
  runKey,
  type RunRecord,
  type RunStatus,
  withRunLock,
  withStartLock,
  writeRecord,
} from "./records";
import { redactSecrets, sanitizeTerminal } from "./sanitize";
import { exportSidecarData, SIDECAR_DATA, startSidecar } from "./sidecar";
import { APP_USER, helperLabels, readRoster, runArgs, type RunDeps, type RunInputs, runLabels, runName, STOP_GRACE_S } from "./spec";
import { spendOfRun, turnsOfRun } from "./spend";

/**
 * How long `finalizeRun` waits for another process finalizing the same run: its stop's grace (STOP_GRACE_S, 30 s),
 * then its bounded helper calls, each at its host bound and KILL: four fixed ones (the container's exit code, the
 * listing, the container's log and the run disk's cleanup helper) and a read per output of the kind with the most
 * (MAX_OUTPUTS, four: a worker's, a fix's and a review's): 8 × (150 + 10) = 1280 s, and 100 s for the rest: 1410 s in
 * all. The same loop waits on the run disk's lock (./locks.ts), which is one lock for every run: `down` holds it for
 * seconds, while it removes the runs, but another run's copy-out, or a reap's finalize, holds it for up to about six
 * bounded calls (6 × 160 s). With `runs.max_live` at 1 only one run is ever finalizing, so those holds can't stack;
 * raising `max_live` needs this wait revisited.
 */
export const FINALIZE_WAIT_S = STOP_GRACE_S + (4 + MAX_OUTPUTS) * (HELPER_HOST_TIMEOUT_S + HELPER_KILL_AFTER_S) + 100;

const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.slice(0, 300) || "(no error output)";
/** Printable ASCII only, and short: for a name a run made (a node path, an attempt id, a ref). */
const safe = (s: string) => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 100);

/**
 * Run `body` with the whole `RunDeps`, as hapi: anyone else re-execs `hapi run <sub> <args>` as hapi first.
 * A failure prints `hapi run <sub>: <message>` and returns 1.
 */
export async function asHapi(sub: string, args: string[], partial: Partial<RunDeps>, body: (d: RunDeps) => Promise<number>): Promise<number> {
  const env = partial.env ?? process.env;
  const run = partial.run ?? runCommand;
  const who = currentUserOverride(env, partial.user);
  if (!who.isHapi && !who.override) return reexec("hapi", ["run", sub, ...args], run, env, who.user, `run ${sub}`);
  try {
    if (who.override) {
      console.error(
        `hapi run ${sub}: warning: HAPI_ALLOW_CURRENT_USER=1: running as ${who.user}, not ${HAPI_USER}: a dev-only downgrade (your own Docker, not hapi's rootless one); the run container is labelled org.hapi.dev-override=1`,
      );
    }
    return await body(await runDeps({ ...partial, env, run, user: who.user }));
  } catch (e) {
    console.error(`hapi run ${sub}: ${(e as Error).message}`);
    return 1;
  }
}

/**
 * A zone's secrets, from `$XDG_RUNTIME_DIR/hapi/env/<zone>.env` (`hapi secrets resolve` writes it): the archon zone's
 * for a worker or a fix, the review zone's for a review. Fails closed when it is missing.
 */
export async function zoneSecrets(zone: "archon" | "review", env: RunDeps["env"]): Promise<Record<string, string>> {
  const file = join(runtimeDir(env), ENV_DIR, `${zone}.env`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${file} is missing: run \`mise run up\` first`);
    throw new Error(`cannot read ${file} (${code ?? "error"}): run hapi run as the user that ran \`mise run up\``);
  }
  try {
    return parseEnvFile(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/**
 * The values text a run of `kind` wrote is redacted with, by name: the archon zone's, and for a review the review
 * zone's too. Both zones map ANTHROPIC_API_KEY and CLAUDE_API_KEY to the one hapi-factory key (stack/secrets.yaml),
 * so those values match and are named once; a name the two zones hold with different values (should the review's
 * key ever be its own) has the review's named `<NAME> (review zone)`, so neither value is lost. Fails closed: a zone file it can't read throws.
 * `hapi run watch` and a kept container log (`keepContainerLog`) both use it.
 */
export async function redactionValues(env: RunDeps["env"], kind: RunKind): Promise<Record<string, string>> {
  const values = { ...(await zoneSecrets("archon", env)) };
  if (kind !== "review") return values;
  for (const [name, value] of Object.entries(await zoneSecrets("review", env))) {
    if (!Object.hasOwn(values, name)) values[name] = value;
    else if (values[name] !== value) values[`${name} (review zone)`] = value;
  }
  return values;
}

/** The git dir to bind as the source, its real path: `<repo>/.git`, or `repo` itself when it is bare. */
async function sourceGitDir(repo: string): Promise<string> {
  const abs = resolve(repo);
  const kind = async (p: string) => {
    try {
      const s = await stat(p);
      return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
    } catch {
      return "none";
    }
  };
  let dir: string | undefined;
  if ((await kind(join(abs, ".git"))) === "dir") dir = join(abs, ".git");
  else if ((await kind(join(abs, "HEAD"))) === "file" && (await kind(join(abs, "objects"))) === "dir" && (await kind(join(abs, "refs"))) === "dir") dir = abs;
  if (dir === undefined) throw new Error(`${abs} is not a git repository with a .git dir, nor a bare one: name a checkout (not a linked worktree) or a bare repo`);
  return realpath(dir);
}

/**
 * The commit the source's HEAD names: a hand run's (`hapi run start`; the poller names its commit). The repo is the
 * operator's, read with no system or global config, hooks or fsmonitor; the source's own .git/config is read, which
 * is why the runbook asks for a bare clone.
 */
async function headOf(gitDir: string, d: RunDeps): Promise<string> {
  const git = hardenedGit(d);
  const r = await d.run([...git.cmd, "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, "rev-parse", "--verify", "HEAD^{commit}"], { env: git.env, inherit: false });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`cannot read the commit HEAD names in ${gitDir} (git rev-parse exited ${r.code}): the source must have a commit checked out`);
  }
  return sha;
}

/**
 * Steps 2-7 of making a run (see the module comment), each of which throws on failure. Only the run container's
 * docker CLI gets the secrets, in its env; an error from it is scrubbed of their values. Its kind's proxy joins the
 * run's network under the alias its proxy variables name (`profile.egress`). With `sidecar`, the policy sidecar
 * `spec` starts after the volume chown and before the run container, its data the dir `dir` holds.
 */
export async function createRunObjects(
  d: RunDeps,
  rec: RunRecord,
  argv: string[],
  secrets: Record<string, string>,
  profile: KindProfile,
  sidecar?: { spec: Sidecar; dir: string },
): Promise<void> {
  const labels = runLabels(d.project, rec.runId);
  const must = async (what: string, cmd: string[], env = definedEnv(d.env)) => {
    const r = await d.run(cmd, { env, inherit: false });
    if (r.code !== 0) {
      let why = firstLine(r.stderr);
      for (const v of Object.values(secrets)) if (v.length >= 4) why = why.replaceAll(v, "[a secret value]");
      // `cmd` starts with `timeout` only when it is a helper `bounded` put under the host's bound.
      const how = cmd[0] === "timeout" && timedOut(r.code) ? `timed out after ${HELPER_HOST_TIMEOUT_S} s` : "failed";
      throw new Error(`${what} ${how} (exit ${r.code}): ${why}`);
    }
    return r;
  };
  await must(`docker network create ${rec.network}`, ["docker", "network", "create", "--internal", ...labels, rec.network]);
  const inspect = await must(`docker network inspect ${rec.network}`, ["docker", "network", "inspect", rec.network]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    parsed = undefined;
  }
  const problem = networkProblem(Array.isArray(parsed) ? parsed[0] : undefined);
  if (problem !== undefined) throw new Error(problem);
  for (const egress of egressOf(d, profile)) await must(`docker network connect ${rec.network} ${egress}`, ["docker", "network", "connect", "--alias", profile.egress, rec.network, egress]);
  for (const v of [rec.volumes.work, rec.volumes.out]) {
    const dir = volumeDir(d.diskDir, v);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Docker makes a bind-backed volume on a dir that isn't there without a word, and only `docker run` fails, with
    // an exit code that says nothing of why (spike 09 finding 17): so the dir is checked here, before the volume.
    const made = await lstat(dir).catch(() => undefined);
    if (made === undefined || !made.isDirectory()) throw new Error(`${dir}, the dir of volume ${v} on the run disk, is not a directory hapi made (a symlink?): no volume was made on it`);
    await must(`docker volume create ${v}`, ["docker", "volume", "create", "--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${dir}`, ...labels, v]);
  }
  await must("the volume chown helper", bounded([
    "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true",
    ...labels, ...helperLabels("chown"), "-v", `${rec.volumes.work}:/w`, "-v", `${rec.volumes.out}:/o`, "--entrypoint", "chown", d.image, APP_USER, "/w", "/o",
  ]));
  // Before the run, so it is there when the run's smoke test looks for it; it holds no secret.
  if (sidecar !== undefined) await startSidecar(d, rec, sidecar.spec, sidecar.dir);
  await must(`docker run ${rec.container}`, argv, { ...definedEnv(d.env), ...secrets });
  await d.spawnDetached(["hapi", "run", "supervise", rec.runId]);
}

/** Whether nothing is at `p` (ENOENT, or a file where a dir was named). A path that can't be looked at for another reason is left to the step that reads it. */
async function absent(p: string): Promise<boolean> {
  try {
    await stat(p);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** The run disk against `runs.disk` (H-217): under `hard` a problem refuses the run; under `soft` it is the warning returned, and the run starts. */
async function checkRunDisk(d: RunDeps): Promise<string | undefined> {
  const problem = diskProblem(d.diskDir, d.runs.disk, await dockerDataRoot(d), d.probeFs);
  if (problem === undefined) return undefined;
  if (d.runs.disk.enforcement === "hard") throw new Error(problem);
  return `${problem}; runs.disk.enforcement is soft, so the run starts anyway`;
}

/** The launcher API's options (`startRun`). */
export interface StartOptions {
  /** The source: a git dir (the repo's mirror, or a bare clone) or a checkout, whose .git dir is bound. */
  repoGitDir: string;
  /** The work order, validated on the host (`loadWorkOrder`, or the poller's `readWorkOrder`). */
  workOrder: WorkOrder;
  /** The work order's task.md, bound at `RUN_PATHS.task`; an empty file when it is absent. */
  taskMd?: string;
  /** The commit the run starts from (40 or 64 lower-case hex digits), which the source must hold. */
  sha: string;
  /** Whether the repo is public: hapi-guard asks Jev only about a public one. */
  public: boolean;
  kind: RunKind;
  /** The work order's worker run, for every kind but `worker`, which takes none: its sha is the run's base commit. */
  parent?: string;
  /** 0 by default: the worker's and the first verify's and review's; n for the n-th fix round and what follows it. */
  round?: number;
  /** The engine's pass of the work order: the engine always passes it (0 on the first pass); `hapi run start` never does. */
  retry?: number;
  /** Lowers the kind's budget (`RunRecord.budgetUsd`); 0 is a budget (a verify run's). */
  budgetUsd?: number;
  /** A hand run's `--retry-of`, handed to `keyProblem` as given. The engine never passes it. */
  retryOf?: string;
  /** The repo's `.factory/config.yaml` at the run's commit, applied over the central policy for this run (H-172). */
  overlay?: RepoOverlay;
  /**
   * What a review or a fix reads, which Task 13 writes: a dir holding only `RUN_INPUTS`' files (./kinds.ts), copied
   * into the run's dir and bound read-only at `RUN_PATHS.inputs`. Required for a review and a fix, refused for a
   * worker and a verify.
   */
  inputsDir?: string;
  /** The GitHub repository the run is of, `owner/name` (Task 13: `Discovered.repo`), lower-cased here: one live run per repo counts by it (m23). */
  forgeRepo?: string;
}

/** Why a kind that takes an inputs dir needs one. */
const INPUTS_FOR: Partial<Record<RunKind, string>> = { fix: "its findings go in it", review: "the diff and verify's results go in it" };
/** Why a kind that takes none refuses one. */
const NO_INPUTS: Partial<Record<RunKind, string>> = { verify: ": its source already holds the bundle's commits" };

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const OVERLAY_FILE = ".factory/config.yaml";
const OVERLAY_LABEL = `the repo's ${OVERLAY_FILE}`;
const wholeFrom0 = (n: number) => Number.isInteger(n) && n >= 0;

/** A model id without its vendor: a Pi ref's part after its last "/" (`anthropic/claude-haiku-5-5`), or a claude-provider id as it is. */
const modelName = (model: string) => model.slice(model.lastIndexOf("/") + 1);

/**
 * Why a run of `kind` can't run the work order's roles on `roster` (`name`), or undefined (ruling m16):
 * - a worker runs implement in the workflows' Pi nodes, so `roles.implement` must name a pi tier;
 * - a review runs in Claude Code, so `roles.review` must name a claude tier, and one whose model isn't
 *   implement's (compared without the vendor): a model reviewing its own work is no second opinion;
 * - a verify runs no model, and a fix runs implement's, which its worker was checked for.
 * So no review runs on the portable roster (every tier is Pi) or the budget one (every tier is Haiku): H-249.
 */
export function rolesProblem(kind: RunKind, roles: WorkOrder["roles"], roster: Roster, name: RosterName): string | undefined {
  if (kind === "worker") {
    const has = roster[roles.implement].provider;
    return has === "pi" ? undefined : `the work order's roles.implement is ${roles.implement}, a ${has} tier in the ${name} roster: implement runs on Pi, so it must name a pi tier`;
  }
  if (kind !== "review") return undefined;
  const review = roster[roles.review];
  if (review.provider !== "claude") {
    return `the work order's roles.review is ${roles.review}, a ${review.provider} tier in the ${name} roster: the review runs in Claude Code, so it must name a claude tier`;
  }
  const model = modelName(review.model);
  if (model === modelName(roster[roles.implement].model)) {
    return `the work order's roles.review is ${roles.review}, whose model in the ${name} roster, ${model}, is roles.implement's (${roles.implement}) too: a review must run on another model than the work it reviews`;
  }
  return undefined;
}

/** Throws unless `sha` is a commit id that `gitDir` holds, read by host git with no config of its own. */
async function commitIn(d: RunDeps, gitDir: string, sha: string): Promise<void> {
  if (!COMMIT.test(sha)) throw new Error(`${JSON.stringify(sha.slice(0, 80))} is not a commit id: 40 or 64 lower-case hex digits`);
  const git = hardenedGit(d);
  const r = await d.run([...git.cmd, "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, "rev-parse", "--verify", `${sha}^{commit}`], { env: git.env, inherit: false });
  // The answer must be the commit asked for: an abbreviation or another name could resolve to another one.
  if (r.code !== 0 || r.stdout.trim() !== sha) throw new Error(`${sha} is not a commit in ${gitDir} (git rev-parse exited ${r.code}): fetch it into the source first`);
}

/** `central` with the repo's overlay applied, its errors naming the overlay. */
function overlaid(central: Policy, overlay: RepoOverlay): Policy {
  try {
    return applyOverlay(central, overlay);
  } catch (e) {
    if (e instanceof PolicyError) throw new PolicyError(OVERLAY_LABEL, e.issues);
    if (e instanceof PolicyLoosenError) throw new Error(`${OVERLAY_LABEL}: ${e.message}`);
    throw e;
  }
}

/** The work order's worker run that a run of another kind names as its parent: see `StartOptions.parent`. */
async function parentOf(d: RunDeps, o: StartOptions): Promise<RunRecord> {
  if (o.parent === undefined) throw new Error(`a ${o.kind} run needs its parent (StartOptions.parent), the work order's worker run: its base commit is that run's sha`);
  if (!RUN_ID.test(o.parent)) throw new Error(`the parent run ${JSON.stringify(o.parent.slice(0, 80))} is not a run id: twelve lower-case hex digits`);
  const rec = await readRecord(d.stateDir, o.parent);
  if (rec === undefined) throw new Error(`the parent run ${o.parent} has no record in ${d.stateDir}`);
  // A Plan 02 record has no kind: it is a worker's.
  const kind = rec.kind ?? "worker";
  if (kind !== "worker") throw new Error(`the parent run ${o.parent} is a ${kind} run, not the work order's worker run: a ${o.kind} run's base commit is its worker run's sha`);
  if (rec.workOrder !== o.workOrder.id) throw new Error(`the parent run ${o.parent} is a run of work order ${rec.workOrder}, not of ${o.workOrder.id}`);
  return rec;
}

/** What startRun returns: the record it wrote, with `warnings` (never written to the record) when the start warned. */
export type StartedRun = RunRecord & { warnings?: string[] };

/**
 * Start a run: see the module comment for its steps. Returns the record it wrote, with the start's warnings (a soft
 * run disk's) when there are any; throws the refusal's text, or a held lock's error unwrapped (`lockHeld` recognizes
 * it: the poller tries again next tick). Prints nothing of its own; its reap says what it reaped, on stderr.
 */
export async function startRun(d: RunDeps, o: StartOptions): Promise<StartedRun> {
  await reapRuns(d);
  const order = o.workOrder;
  if (order.egress_extra.length > 0) throw new Error("egress_extra isn't supported yet (design §3.1, H-088); remove it or wait for the per-run proxy");
  if ((o.overlay?.egress_extra ?? []).length > 0) throw new Error(`${OVERLAY_LABEL} adds egress_extra hosts, which aren't supported yet (H-207): remove them`);
  if (!RUN_KINDS.includes(o.kind)) throw new Error(`${JSON.stringify(o.kind)} is not a run kind (${RUN_KINDS.join(", ").replace(/, ([^,]+)$/, " or $1")})`);
  const profile = kindProfile(o.kind);
  // A verify or review runs its kind's workflow; a worker or a fix runs the work order's own.
  const workflow = profile.workflow ?? order.workflow;
  // Archon also resolves its bundled workflows by name, and hapi reviews only its own pack's (paid check, 2026-10-31).
  const pack = await packNodes(d.packDir);
  if ("missing" in pack) throw new Error(pack.missing);
  if (pack.problems.length > 0) throw new Error(`hapi's pack has a problem: ${pack.problems.join("; ")}`);
  if (!pack.workflows.some((w) => w.name === workflow)) {
    const whose = profile.workflow === undefined ? "the work order's workflow" : `a ${o.kind} run's workflow`;
    throw new Error(`${whose} ${JSON.stringify(workflow)} is not in hapi's pack (${d.packDir}): a run may use only the pack's workflows, never one of Archon's bundled ones, which hapi doesn't review`);
  }
  const round = o.round ?? 0;
  if (!wholeFrom0(round)) throw new Error(`the run's round ${round} is not a whole number of at least 0`);
  if (o.budgetUsd !== undefined && !(Number.isFinite(o.budgetUsd) && o.budgetUsd >= 0)) throw new Error(`the run's budget ${o.budgetUsd} is not a number of at least 0`);
  if (o.budgetUsd !== undefined && o.budgetUsd > order.budget.usd) throw new Error(`the run's budget ${o.budgetUsd} is above the work order's budget.usd (${order.budget.usd}): it may only lower it`);
  if (o.retry !== undefined && !wholeFrom0(o.retry)) throw new Error(`the run's retry ${o.retry} is not a whole number of at least 0`);
  if (o.forgeRepo !== undefined && parseOwnerRepo(o.forgeRepo) === undefined) throw new Error(`the run's forgeRepo ${JSON.stringify(o.forgeRepo.slice(0, 120))} is not a GitHub repository's owner/name`);
  // GitHub's owner and repository names aren't case-sensitive, so one repo has one forgeRepo, the lower-cased one.
  const forgeRepo = o.forgeRepo?.toLowerCase();
  if (o.kind === "worker" && o.parent !== undefined) throw new Error("a worker run takes no parent: it is the work order's first run, and its own base");
  const disk = await checkRunDisk(d);
  // A verify run holds no key of any kind (design §3.5): no zone's env file is read for it.
  const zone = profile.zone === undefined ? {} : await zoneSecrets(profile.zone, d.env);
  const repo = await sourceGitDir(o.repoGitDir);
  await commitIn(d, repo, o.sha);
  const roster = readRoster(d.buildDir);
  const central = loadPolicy(join(d.root, "policy"));
  const applied = o.overlay === undefined ? central : overlaid(central, o.overlay);
  const roles = rolesProblem(o.kind, order.roles, applied.rosters[roster], roster);
  if (roles !== undefined) throw new Error(roles);
  const phases = applied.runs.phases;
  // CodeRabbit's key is optional in the manifest (until an unattended one exists, H-167), so a review asked to run
  // CodeRabbit's step without it is refused here: no automatic fallback, and an unset key is an error.
  if (o.kind === "review" && phases.coderabbit && (zone.CODERABBIT_API_KEY ?? "").trim() === "") {
    throw new Error(
      "runs.phases.coderabbit is on for this run, but the review zone's env file has no CODERABBIT_API_KEY: store hapi-review-coderabbit-api-key (`mise run secrets:edit`, docs/runbooks/provider-keys.md) and run `mise run up`, or leave phases.coderabbit off",
    );
  }
  // And it reaches the review container only when that step runs: with it off, the container never holds the key.
  const secrets = o.kind === "review" && !phases.coderabbit ? Object.fromEntries(Object.entries(zone).filter(([k]) => k !== "CODERABBIT_API_KEY")) : zone;
  // The smoke sidecar: the overlay's, for a kind that may have one, when the work order smokes (design §3.3).
  const sc = profile.sidecar && order.verify.smoke ? applied.repo?.sidecar : undefined;
  const sidecarSpec = sc === undefined ? undefined : applied.sidecars[sc.name];
  if (sc !== undefined && sidecarSpec === undefined) throw new Error(`${OVERLAY_LABEL} names the sidecar ${JSON.stringify(sc.name)}, which policy/sidecars.yaml doesn't list`);
  // A worker may spend the work order's budget; every later kind one round's, at most (design §3.9).
  const cap = o.kind === "worker" ? order.budget.usd : Math.min(order.budget.usd, phases.round_usd);
  if (o.budgetUsd !== undefined && o.budgetUsd > cap) {
    throw new Error(`the run's budget ${o.budgetUsd} is above a ${o.kind} run's cap, the smaller of the work order's budget.usd (${order.budget.usd}) and runs.phases.round_usd (${phases.round_usd}): it may only lower it`);
  }
  const base = o.kind === "worker" ? o.sha : (await parentOf(d, o)).sha;
  if (profile.inputs && o.inputsDir === undefined) throw new Error(`a ${o.kind} run needs an inputs dir (StartOptions.inputsDir): ${INPUTS_FOR[o.kind]}`);
  if (!profile.inputs && o.inputsDir !== undefined) throw new Error(`a ${o.kind} run takes no inputs dir${NO_INPUTS[o.kind] ?? ""}`);
  const inputs = o.inputsDir === undefined ? undefined : await inputsProblem(o.inputsDir, profile);
  if (inputs !== undefined) throw new Error(inputs);

  // The run's own files: the guard's settings and Archon's run layer, from the overlaid policy for build/roster's
  // roster, with the work order's tiers for implement and review; and the host's copies of the order and its task.
  const tiers = { ...applied, roles: { ...applied.roles, implement: order.roles.implement, review: order.roles.review } };
  const files: Record<(typeof PER_RUN_FILES)[number], string> = {
    "hapi-guard.json": emitPi(applied, roster)["hapi-guard.json"]!,
    "run-config.yaml": emitArchon(tiers, roster)["run-config.yaml"]!,
    "order.json": `${JSON.stringify(order, null, 2)}\n`,
    "task.md": o.taskMd ?? "",
  };
  const service = (await composeServices(d.root)).archon;
  if (service === undefined) throw new Error("stack/compose.yaml has no archon service: the run container is made from it");

  const runId = newRunId();
  const budgetUsd = o.budgetUsd ?? cap;
  const runInputs: RunInputs = { runId, repo, sha: o.sha, workOrder: order, public: o.public, budgetUsd, packDir: d.packDir, ...(sc === undefined ? {} : { sidecar: sc.name }) };
  const argv = runArgs(service, runInputs, d, Object.keys(secrets), profile);
  const started = d.now();
  const name = runName(d.project, runId);
  const alias = o.kind === "verify" ? undefined : o.kind === "review" ? order.roles.review : order.roles.implement;
  const rec: RunRecord = {
    runId, key: runKey(order.id, o.sha, keyPart(o.kind, round, o.retry)), project: d.project, repo, sha: o.sha, workOrder: order.id, workflow,
    container: name, network: name, volumes: { work: `${name}-work`, out: `${name}-out` },
    startedAt: started.toISOString(), deadline: new Date(started.getTime() + order.budget.minutes * 60_000).toISOString(), status: "live",
    ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }),
    kind: o.kind,
    ...(o.parent === undefined ? {} : { parent: o.parent }),
    round, budgetUsd, roster,
    policyHash: createHash("sha256").update(JSON.stringify(applied)).digest("hex"),
    ...(o.retry === undefined ? {} : { retry: o.retry }),
    ...(alias === undefined ? {} : { model: applied.rosters[roster][alias].model }),
    ...(forgeRepo === undefined ? {} : { forgeRepo }),
  };
  const runFile: RunFile = {
    run_id: runId, work_order: order.id, traceparent: order.trace.traceparent, budget_usd: budgetUsd, public: o.public, workflow, started_at: rec.startedAt,
    kind: o.kind, round, turns: o.kind === "fix" ? Math.min(order.budget.turns, phases.round_turns) : order.budget.turns, base,
    // A review's CodeRabbit node runs only when the overlaid policy says so (Task 11 reads it).
    ...(o.kind === "review" ? { coderabbit: phases.coderabbit } : {}),
  };

  await withStartLock(d, async () => {
    const records = await listRecords(d.stateDir);
    const refused =
      keyProblem(records, { key: rec.key, workOrder: order.id, sha: o.sha, ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }) }) ??
      capacityProblem(await liveRuns(d), records, { repo, ...(forgeRepo === undefined ? {} : { forgeRepo }) }, d);
    if (refused !== undefined) throw new Error(refused);
    await createRun(d.stateDir, rec, runFile, files, o.inputsDir);
    try {
      let sidecar: { spec: Sidecar; dir: string } | undefined;
      if (sc !== undefined && sidecarSpec !== undefined) {
        sidecar = { spec: sidecarSpec, dir: join(recordDir(d.stateDir, runId), SIDECAR_DATA) };
        await exportSidecarData(d, repo, o.sha, sc.data_dir, sidecar.dir, sidecarSpec.limits);
      }
      await createRunObjects(d, rec, argv, secrets, profile, sidecar);
    } catch (e) {
      let cleanup = "What start had created was removed.";
      try {
        // The volumes go here, and their dirs on the run disk go with them at the next reap: its sweep removes a
        // run's dir whose volume is gone and whose run has no live record, as this run has none after removeRunDir.
        await removeRuns(d.project, d.run, d.env, { runId, egress: egressOf(d, profile) });
      } catch (x) {
        cleanup = `Removing what start had created failed too (${(x as Error).message}): \`mise run down\` removes it.`;
      }
      await removeRunDir(d.stateDir, runId);
      throw new Error(`${(e as Error).message}. ${cleanup}`);
    }
  });
  return disk === undefined ? rec : { ...rec, warnings: [disk] };
}

/** The task.md beside the work-order file `orderFile`, or undefined when there is none. */
async function taskBeside(orderFile: string): Promise<string | undefined> {
  try {
    return await readFile(join(dirname(orderFile), "task.md"), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * The repo's overlay at commit `sha` of `gitDir`, `<sha>:.factory/config.yaml` (design §3.5), or undefined when the
 * commit has none. Read as a blob by host git with no config (`hardenedGit`), as discovery reads it, so no textconv
 * or attribute applies; a symlink, a directory or a submodule there is refused, and so is text that fails the
 * overlay's schema (`overlayFromText`).
 */
async function overlayAt(d: RunDeps, gitDir: string, sha: string): Promise<RepoOverlay | undefined> {
  const at = sha.slice(0, 12);
  const git = hardenedGit(d);
  const run = (args: string[]) => d.run([...git.cmd, "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, ...args], { env: git.env, inherit: false });
  const tree = await run(["ls-tree", "-z", sha, "--", OVERLAY_FILE]);
  if (tree.code !== 0) throw new Error(`cannot list ${OVERLAY_FILE} at ${at} in ${gitDir} (git ls-tree exited ${tree.code}): ${firstLine(tree.stderr)}`);
  const entry = tree.stdout.split("\0").find((e) => e.endsWith(`\t${OVERLAY_FILE}`));
  if (entry === undefined) return undefined;
  const [mode, type, oid] = entry.slice(0, entry.indexOf("\t")).split(" ");
  if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(oid ?? "")) throw new Error(`${OVERLAY_FILE} at ${at} is not a regular file`);
  const blob = await run(["cat-file", "blob", oid!]);
  if (blob.code !== 0) throw new Error(`cannot read ${OVERLAY_FILE} at ${at} in ${gitDir} (git cat-file exited ${blob.code}): ${firstLine(blob.stderr)}`);
  return overlayFromText(blob.stdout, `${at}:${OVERLAY_FILE}`);
}

/**
 * `hapi run start --repo <path> --work-order <file> [--public] [--budget-usd <n>] [--retry-of <run-id>]`: a hand
 * run, through `startRun` (see the module comment).
 */
export async function runStart(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const parsed = parseStart(args);
  if (parsed === undefined) {
    console.error(START_USAGE);
    return 2;
  }
  // The re-exec runs in hapi's checkout (`reexecScript`), so both paths are made absolute here, from the caller's
  // working dir, and one that isn't there is a usage error before anything runs.
  const opts = { ...parsed, repo: resolve(parsed.repo), workOrder: resolve(parsed.workOrder) };
  for (const [flag, p] of [["--repo", opts.repo], ["--work-order", opts.workOrder]] as const) {
    if (await absent(p)) {
      console.error(`hapi run start: ${flag} ${p} does not exist: name a path relative to where you run hapi, or an absolute one`);
      console.error(START_USAGE);
      return 2;
    }
  }
  // parseStart has checked that each value follows its flag and that none starts with "-", so only the two values match.
  const absolute = args.map((a, i) => (args[i - 1] === "--repo" ? opts.repo : args[i - 1] === "--work-order" ? opts.workOrder : a));
  return asHapi("start", absolute, deps, async (d) => {
    const workOrder = loadWorkOrder(opts.workOrder);
    if (opts.budgetUsd !== undefined && opts.budgetUsd > workOrder.budget.usd) {
      console.error(`hapi run start: --budget-usd ${opts.budgetUsd} is above the work order's budget.usd (${workOrder.budget.usd}): it may only lower it`);
      console.error(START_USAGE);
      return 2;
    }
    const repoGitDir = await sourceGitDir(opts.repo);
    const sha = await headOf(repoGitDir, d);
    const taskMd = await taskBeside(opts.workOrder);
    // The repo's own overlay at the run's commit, as the poller reads it (design §3.5), so a hand run (a retry, say)
    // keeps the repo's protected paths and sidecar.
    const overlay = await overlayAt(d, repoGitDir, sha);
    const rec = await startRun(d, {
      repoGitDir, workOrder, sha, public: opts.public, kind: "worker",
      ...(taskMd === undefined ? {} : { taskMd }),
      ...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
      ...(opts.retryOf === undefined ? {} : { retryOf: opts.retryOf }),
      ...(overlay === undefined ? {} : { overlay }),
    });
    for (const w of rec.warnings ?? []) console.error(`hapi run start: warning: ${w}`);
    console.log(rec.runId);
    return 0;
  });
}

/**
 * Record why run `rec` is being stopped, then stop its container with `STOP_GRACE_S`. The first reason stays, but
 * the operator's stop outranks the deadline: "stopped" replaces "timed-out" while the run is live, and "timed-out"
 * never replaces "stopped". A stop that fails is an error only if the container still runs.
 */
async function requestStop(d: RunDeps, rec: RunRecord, why: NonNullable<RunRecord["stopRequested"]>): Promise<void> {
  await withRunLock(d, rec.runId, async () => {
    const disk = await readRecord(d.stateDir, rec.runId);
    if (disk?.status === "live" && (disk.stopRequested === undefined || (why === "stopped" && disk.stopRequested === "timed-out"))) {
      await writeRecord(d.stateDir, { ...disk, stopRequested: why });
    }
  });
  await stopContainer(d, rec);
}

async function stopContainer(d: RunDeps, rec: RunRecord): Promise<void> {
  const r = await d.run(["docker", "stop", "-t", String(STOP_GRACE_S), rec.container], { env: definedEnv(d.env), inherit: false });
  if (r.code !== 0 && (await isLive(d, rec.runId))) throw new Error(`docker stop ${rec.container} failed (exit ${r.code}): ${firstLine(r.stderr)}`);
}

/**
 * What is wrong with `file`, a run's bundle, or undefined: it must list exactly one head, `HEAD` (spike 07
 * finding 19). Read by host git with no system or global config, hooks or fsmonitor, from an empty temp dir
 * that repo discovery can't leave (GIT_CEILING_DIRECTORIES), so nothing the run wrote configures it. The
 * bundle is only listed, never verified or fetched here: that needs the base commit (Plan 03's harvester).
 */
export async function bundleProblem(file: string, d: Pick<RunDeps, "run" | "env">): Promise<string | undefined> {
  const empty = await mkdtemp(join(tmpdir(), "hapi-bundle-"));
  try {
    const git = hardenedGit(d, { env: [`GIT_CEILING_DIRECTORIES=${dirname(empty)}`], git: ["-C", empty] });
    const r = await d.run([...git.cmd, "bundle", "list-heads", file], { env: git.env, inherit: false });
    if (r.code !== 0) return `run.bundle is not a bundle git can read (git bundle list-heads exited ${r.code}): kept, never fetched`;
    const refs = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));
    const head = refs.indexOf("HEAD");
    const extra = head === -1 ? refs : refs.filter((_, i) => i !== head);
    if (head !== -1 && extra.length === 0) return undefined;
    return `unexpected refs in run.bundle: ${extra.length === 0 ? "(none)" : extra.slice(0, 10).map(safe).join(", ")}`;
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

/**
 * The guard-ran check (design §6a item 7; spike 08 finding 10). A guard that fails to load fails open, so
 * every Pi attempt the transcript shows (a `node_start` row with `execution.binding.provider` "pi") must have
 * a `session_start` record in the decision log with the same run, node and attempt
 * (`execution.runId`, `.path`, `.attempt.id`). Returns a problem per attempt without one; a missing
 * transcript, or a line of it that isn't JSON, fails the check rather than passing it.
 */
export function guardProblems(transcript: string | undefined, decisions: string | undefined): string[] {
  if (transcript === undefined) return ["no transcript.jsonl was copied out, so the guard-ran check could not be made"];
  const started = new Set<string>();
  for (const line of (decisions ?? "").split("\n")) {
    let rec: { event?: unknown; run?: unknown; node?: unknown; attempt?: unknown } | null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a line the guard didn't write can only take a record away, never add one
    }
    if (rec?.event === "session_start" && typeof rec.run === "string" && typeof rec.node === "string" && typeof rec.attempt === "string") {
      started.add(JSON.stringify([rec.run, rec.node, rec.attempt]));
    }
  }
  const problems: string[] = [];
  for (const [i, line] of transcript.split("\n").entries()) {
    if (line.trim() === "") continue;
    let row: { type?: unknown; execution?: { runId?: unknown; path?: unknown; attempt?: { id?: unknown }; binding?: { provider?: unknown } } } | null;
    try {
      row = JSON.parse(line);
    } catch {
      return [`transcript.jsonl line ${i + 1} is not JSON, so the guard-ran check can't be made`];
    }
    if (row?.type !== "node_start" || row.execution?.binding?.provider !== "pi") continue;
    const { runId, path } = row.execution;
    const attempt = row.execution.attempt?.id;
    if (typeof runId !== "string" || typeof path !== "string" || typeof attempt !== "string") {
      problems.push(`a Pi node_start row in transcript.jsonl (line ${i + 1}) has no run, node or attempt id`);
    } else if (!started.has(JSON.stringify([runId, path, attempt]))) problems.push(`guard did not run in node ${safe(path)} attempt ${safe(attempt)}`);
  }
  return problems.length <= 5 ? problems : [...problems.slice(0, 5), `and ${problems.length - 5} more Pi attempts without a guard record`];
}

/** How many lines of a run container's log finalize keeps, for a run that left no result.json. */
const LOG_TAIL = 200;
/** The most of the log's last line a run's reason quotes. */
const LOG_LINE_CHARS = 200;
/** `sh -c LOGS_SCRIPT hapi-logs <container>`: the log's last LOG_TAIL lines, stdout and stderr in the order they were written. Fixed text. */
export const LOGS_SCRIPT = `exec docker logs --tail ${LOG_TAIL} "$1" 2>&1`;

/**
 * Keep the tail of a run container's log in `<out>/container.log` (mode 0600), for a run that left no result.json.
 * A run that died in the prelude (the clone, the sparse checkout, the Archon CLI failing to start) leaves nothing
 * else, and removeRuns takes the log with the container (final review C-1). The log is untrusted text: it is
 * sanitized, then redacted with the archon zone's values, and a review's with the review zone's too
 * (`redactionValues`), in `watch`'s order, and it is not kept if they can't be read. The file is the host's own,
 * never one of a kind's outputs. Returns what the run's reason says of it, if anything: the log's last line, or why
 * it wasn't kept. Never throws: nothing here may stop finalize.
 */
async function keepContainerLog(d: RunDeps, rec: RunRecord, out: string): Promise<string | undefined> {
  let values: Record<string, string>;
  try {
    values = await redactionValues(d.env, rec.kind ?? "worker");
  } catch (e) {
    return `the container's log was not kept, since nothing could redact it: ${(e as Error).message}`;
  }
  let r: Awaited<ReturnType<RunDeps["run"]>>;
  try {
    r = await d.run(bounded(["sh", "-c", LOGS_SCRIPT, "hapi-logs", rec.container]), { env: definedEnv(d.env), inherit: false });
  } catch (e) {
    return `the container's log could not be read: ${(e as Error).message}`;
  }
  if (timedOut(r.code)) return `reading the container's log timed out after ${HELPER_HOST_TIMEOUT_S} s`;
  if (r.code !== 0) return `the container's log could not be read (docker logs exited ${r.code})`;
  const text = redactSecrets(sanitizeTerminal(r.stdout), values);
  const file = join(out, "container.log");
  const tmp = join(out, `.container.log.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    return `the container's log could not be written to ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`;
  }
  const last = text.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1);
  if (last === undefined) return undefined;
  return `the container's last log line: ${last.length > LOG_LINE_CHARS ? `${last.slice(0, LOG_LINE_CHARS)}…` : last}`;
}

/** What finalize asks `docker inspect` for: the container's state, then its exit code. */
export const EXIT_FORMAT = "{{.State.Status}} {{.State.ExitCode}}";

/**
 * The run container's exit code as Docker recorded it (`docker inspect`, under the helpers' host bound), or undefined
 * when it can't be read, or the container didn't exit: Docker reports 0 for one that was made and never started
 * (`created`), so only an `exited` container's code is kept. It is never the run's status (a paused run exits 0); the
 * record keeps it for Task 12's cross-check of a verify run, whose results the code it ran could have forged.
 */
async function containerExitCode(d: RunDeps, container: string): Promise<number | undefined> {
  let r: Awaited<ReturnType<RunDeps["run"]>>;
  try {
    r = await d.run(bounded(["docker", "inspect", "--format", EXIT_FORMAT, container]), { env: definedEnv(d.env), inherit: false });
  } catch {
    return undefined;
  }
  const m = /^(\S+) (-?\d{1,10})$/.exec(r.stdout.trim());
  return r.code === 0 && m !== null && m[1] === "exited" ? Number(m[2]) : undefined;
}

/** Archon's status of the run, from out/result.json's `run.status` (`workflow get`), or why it can't be read. */
async function archonStatus(out: string, copied: string[]): Promise<{ status: string } | { problem: string }> {
  if (!copied.includes("result.json")) return { problem: "no result.json was copied out" };
  let doc: { run?: { status?: unknown } } | null = null;
  try {
    doc = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
  } catch {
    doc = null;
  }
  const status = doc?.run?.status;
  return typeof status === "string" ? { status } : { problem: "out/result.json does not hold a run's status" };
}

/** Why a run Archon didn't complete failed. A paused run fails: v1 has no approval nodes, and nothing can answer one (design §3.1). */
function statusReason(status: string): string {
  if (status === "paused") return "the run paused (Archon status paused): v1 answers no approval, so a paused run fails (design §3.1)";
  if (status === "failed") return "the workflow failed (Archon status failed)";
  return /^[a-z_]{1,32}$/.test(status) ? `Archon reports the run ${status}, not completed` : "Archon reports a status that is none of its own";
}

/** finalizeRun's work, holding the run's lock. */
async function finalizeLocked(rec: RunRecord, d: RunDeps): Promise<RunRecord> {
  const disk = (await readRecord(d.stateDir, rec.runId)) ?? rec;
  if (disk.status !== "live") return disk;
  // A Plan 02 record has no kind: it is a worker's.
  const profile = kindProfile(disk.kind ?? "worker");
  // No volume a live worker can still write is ever read.
  if (await isLive(d, disk.runId)) await stopContainer(d, disk);
  const out = join(recordDir(d.stateDir, disk.runId), "out");
  const reasons: string[] = [];
  if (disk.stopRequested === "timed-out") reasons.push(`the run passed its deadline (${disk.deadline}, from the work order's budget.minutes) and was stopped`);
  if (disk.stopRequested === "stopped") reasons.push("stopped by `hapi run stop`");

  const problems: string[] = [];
  let gone = false;
  let exitCode: number | undefined;
  // Under the run disk's lock, which `down` holds while it removes runs (H-210): held, it throws `lockHeld`, so
  // finalizeRun waits and a reap leaves the run for the next one, and no copy-out reads a volume `down` is removing.
  const archon = await withStackLock(d, "run-copyout", async (): Promise<Awaited<ReturnType<typeof archonStatus>>> => {
    if (!(await containerExists(d, disk.runId))) {
      // Removed around hapi (`mise run down`, a cleanup: `docker wait` returns as `rm -f` kills it), and its volumes
      // may be going too: a helper would race that removal for them, and its `-v` of one just removed would make an
      // unlabelled volume that nothing removes.
      gone = true;
      problems.push("the run's container was removed before the run was finalized (`mise run down`, or a cleanup): nothing was copied out");
      return { problem: "nothing was copied out" };
    }
    exitCode = await containerExitCode(d, disk.container);
    const copy = await copyOut(disk.volumes.out, out, profile.outputs, d.runs.output_limits_mb, d);
    problems.push(...copy.problems);
    if (copy.copied.includes("run.bundle")) {
      const p = await bundleProblem(join(out, "run.bundle"), d);
      if (p !== undefined) problems.push(p);
    }
    const status = await archonStatus(out, copy.copied);
    if ("problem" in status) problems.push(status.problem);
    const read = async (name: string) => (copy.copied.includes(name) ? readFile(join(out, name), "utf8") : undefined);
    problems.push(...guardProblems(await read("transcript.jsonl"), await read("decisions.jsonl")));
    if (!copy.copied.includes("result.json")) {
      const log = await keepContainerLog(d, disk, out);
      if (log !== undefined) problems.push(log);
    }
    return status;
  });

  let status: RunStatus;
  if (disk.stopRequested !== undefined) status = disk.stopRequested;
  else if (problems.length > 0) status = "failed";
  else if ("status" in archon && archon.status === "completed") status = "succeeded";
  else {
    status = "failed";
    if ("status" in archon) problems.push(statusReason(archon.status));
  }
  reasons.push(...problems);
  // Nothing was copied out of a run whose container was gone, and an exited run's outputs may still be in its volumes,
  // so the finalize leaves them, with their dirs on the run disk (H-209): a `mise run down` that takes the run disk's
  // lock removes the volumes, and the next reap their dirs.
  if (gone) reasons.push(`the finalize left the run's volumes ${disk.volumes.work} and ${disk.volumes.out} in place, since nothing was copied out (H-209)`);
  const spend = spendOfRun(out, disk.budgetUsd ?? 0);
  const turns = await turnsOfRun(out);
  const done: RunRecord = {
    ...disk,
    status,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
    ...(spend.known ? { spendUsd: spend.usd } : {}),
    ...(turns === undefined ? {} : { turns }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
  // The outcome first (H-219): a finalizer that dies during the removal leaves it recorded, never a live record
  // whose container is gone, which the next finalize would record failed.
  await writeRecord(d.stateDir, done);

  const cleanup: string[] = [];
  try {
    await removeRuns(d.project, d.run, d.env, { runId: disk.runId, egress: egressOf(d, profile), volumes: !gone });
    // A kept volume keeps its dirs on the run disk: the cleanup helper runs only for volumes removeRuns removed.
    if (!gone) {
      try {
        await removeVolumeDirs(d, disk.runId);
      } catch (e) {
        cleanup.push(`cleanup left the run's dirs on the run disk: ${(e as Error).message}; the next reap tries again`);
      }
    }
  } catch (e) {
    cleanup.push(`cleanup left run objects behind: ${(e as Error).message}; \`mise run down\` removes them`);
  }
  if (cleanup.length === 0) return done;
  // The record as it is now, which another writer may have changed since the outcome was written, with the cleanup's reason added.
  const now = (await readRecord(d.stateDir, disk.runId)) ?? done;
  const left: RunRecord = { ...now, reason: [...(now.reason === undefined ? [] : [now.reason]), ...cleanup].join("; ") };
  await writeRecord(d.stateDir, left);
  return left;
}

/**
 * Finish run `rec`: see the module comment. Idempotent: a run that has ended is returned as recorded. If
 * another process is finalizing it, waits for that one (up to FINALIZE_WAIT_S) and returns what it recorded.
 */
export async function finalizeRun(rec: RunRecord, deps: RunDeps): Promise<RunRecord> {
  for (let waited = 0; ; waited++) {
    try {
      return await withRunLock(deps, rec.runId, () => finalizeLocked(rec, deps));
    } catch (e) {
      if (!lockHeld(e) || waited >= FINALIZE_WAIT_S) throw e;
      await Bun.sleep(1000);
    }
  }
}

/**
 * The run disk's sweep, part of a reap (under the launcher's lock, so no start is making dirs meanwhile): each dir
 * named for a run of `d.project` (`<project>-run-<id>-work` or `-out`; nothing else, `lost+found` included, is
 * touched) whose run has no live record, and none of whose run's volumes is still listed, is emptied and removed
 * (`removeVolumeDirs`), holding the run's own lock. A live run's dirs are its finalize's to remove, and so are a
 * run's whose finalize still holds that lock: it writes the outcome before it removes the run's objects (H-219), so
 * an ended record alone doesn't say its dirs are done with. Returns what it couldn't do; a missing run disk is
 * nothing to sweep.
 */
async function sweepRunDisk(d: RunDeps, live: Set<string>): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(d.diskDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    return [`the run disk ${d.diskDir} can't be listed (${code ?? (e as Error).message})`];
  }
  const stem = `${d.project}-run-`;
  const ids = new Set<string>();
  for (const n of names) {
    const m = n.startsWith(stem) ? /^([0-9a-f]{12})-(work|out)$/.exec(n.slice(stem.length)) : null;
    if (m !== null && !live.has(m[1]!)) ids.add(m[1]!);
  }
  if (ids.size === 0) return [];
  let volumes: string[];
  try {
    volumes = await listed(d.run, d.env, ["docker", "volume", "ls", "-q", ...runFilters(d.project)]);
  } catch (e) {
    return [`the run disk's sweep: ${(e as Error).message}`];
  }
  const failures: string[] = [];
  for (const id of [...ids].sort()) {
    if (["work", "out"].some((v) => volumes.includes(`${runName(d.project, id)}-${v}`))) continue;
    try {
      await withRunLock(d, id, () => removeVolumeDirs(d, id));
      console.error(`hapi run: removed run ${id}'s dirs on the run disk: their volumes were gone`);
    } catch (e) {
      if (!lockHeld(e)) failures.push(`run ${id}: ${(e as Error).message}`);
    }
  }
  return failures;
}

/**
 * Repair what a dead supervisor left, under the launcher's lock: every live record whose container has
 * exited is finalized, and every one past its deadline is stopped (timed-out) and finalized, but `o.stopping`: the
 * run `hapi run stop` is about to stop is never stopped at its deadline here, since the operator's stop outranks
 * the deadline (it is still finalized once its container has exited). A run another process is finalizing, or one
 * `down` holds the run disk's lock over, is left to it. Then the run disk's sweep (`sweepRunDisk`) and retention
 * (see the module comment): a finished run harvested more than `runs.retention_days` ago loses its dir. Throws
 * after trying every run, naming those it couldn't finish.
 */
export async function reapRuns(deps: RunDeps, o: { stopping?: string } = {}): Promise<void> {
  await withStartLock(deps, async () => {
    const failures: string[] = [];
    for (const rec of (await listRecords(deps.stateDir)).filter((r) => r.status === "live")) {
      try {
        if (await isLive(deps, rec.runId)) {
          if (rec.runId === o.stopping || deps.now().getTime() < Date.parse(rec.deadline)) continue;
          await requestStop(deps, rec, "timed-out");
        }
        const done = await withRunLock(deps, rec.runId, () => finalizeLocked(rec, deps));
        console.error(`hapi run: reaped run ${rec.runId}: ${done.status}`);
      } catch (e) {
        if (!lockHeld(e)) failures.push(`run ${rec.runId}: ${(e as Error).message}`);
      }
    }
    const records = await listRecords(deps.stateDir);
    failures.push(...(await sweepRunDisk(deps, new Set(records.filter((r) => r.status === "live").map((r) => r.runId)))));
    const keep = deps.runs.retention_days * 86_400_000;
    for (const rec of records) {
      // Only a time hapi's harvester wrote: anything else, or none, keeps the run.
      const harvested = typeof rec.harvestedAt === "string" ? Date.parse(rec.harvestedAt) : Number.NaN;
      if (rec.status === "live" || !Number.isFinite(harvested) || deps.now().getTime() - harvested <= keep) continue;
      try {
        await removeRunDir(deps.stateDir, rec.runId);
        console.error(`hapi run: removed run ${rec.runId}: harvested ${rec.harvestedAt}, more than runs.retention_days (${deps.runs.retention_days}) ago`);
      } catch (e) {
        failures.push(`run ${rec.runId}: removing its dir failed: ${(e as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(`reaping left runs unfinished: ${failures.join("; ")}`);
  });
}

/** How a run ended, as `supervise`, `stop` and `watch` print it. */
export const ended = (rec: RunRecord) => `run ${rec.runId}: ${rec.status}${rec.reason === undefined ? "" : `: ${rec.reason}`}`;

/** `hapi run supervise <run-id>` (internal; start spawns it): wait, stop at the deadline, finalize. */
export async function runSupervise(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const id = parseRunId(args);
  if (id === undefined) {
    console.error(SUPERVISE_USAGE);
    return 2;
  }
  return asHapi("supervise", args, deps, async (d) => {
    // No reap: the start that spawns this has just reaped, and still holds the launcher's lock.
    const rec = await readRecord(d.stateDir, id);
    if (rec === undefined) throw new Error(`there is no run ${id} in ${d.stateDir}`);
    if (rec.status !== "live") return 0;
    const left = Math.ceil((Date.parse(rec.deadline) - d.now().getTime()) / 1000);
    let overdue = left <= 0;
    if (!overdue) {
      // The host's timeout ends `docker wait` (exit 124) at the deadline; the container's own exit code is never the status.
      const w = await d.run(["timeout", String(left), "docker", "wait", rec.container], { env: definedEnv(d.env), inherit: false });
      overdue = w.code === 124;
      if (!overdue && w.code !== 0 && (await isLive(d, id))) {
        throw new Error(`cannot wait for ${rec.container} (docker wait exited ${w.code}): the next \`hapi run\` command reaps it at its deadline`);
      }
    }
    if (overdue) await requestStop(d, rec, "timed-out");
    console.log(ended(await finalizeRun(rec, d)));
    return 0;
  });
}

/** `hapi run stop <run-id>`: stop one run, and finalize it as stopped. */
export async function runStop(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const id = parseRunId(args);
  if (id === undefined) {
    console.error(STOP_USAGE);
    return 2;
  }
  return asHapi("stop", args, deps, async (d) => {
    try {
      // Its own reap never times out the run it is about to stop: the operator's stop outranks the deadline.
      await reapRuns(d, { stopping: id });
    } catch (e) {
      console.error(`hapi run stop: warning: ${(e as Error).message}`);
    }
    const rec = await readRecord(d.stateDir, id);
    if (rec === undefined) throw new Error(`there is no run ${id} in ${d.stateDir}`);
    if (rec.status !== "live") {
      console.log(`run ${id} has already ended: ${rec.status}`);
      return 0;
    }
    // A live record with no container is a start between its record and its `docker run` (H-218): the reap above
    // couldn't take start's lock, and a stop recorded now would leave start's container running. The deadline's
    // stops (the supervisor's, the reap's) don't come here: theirs is a container that exists, or one that was removed.
    if (!(await containerExists(d, id))) {
      throw new Error(`run ${id} has no container yet: its start may still be making it, so wait and stop it again; a container removed around hapi is reaped by the next \`hapi run\` command`);
    }
    await requestStop(d, rec, "stopped");
    console.log(ended(await finalizeRun(rec, d)));
    return 0;
  });
}
