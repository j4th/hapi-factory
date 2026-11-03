/**
 * Run records (design §3.1, §3.2; H-090): one hapi-owned dir per run,
 * `<stateDir>/<run-id>/` (0700), holding:
 * - `record.json` (`RunRecord`, 0600): what the launcher started and how it
 *   ended;
 * - `run.json` (the `RunFile`) and the `PER_RUN_FILES` (each 0644): the run's
 *   input, its own guard settings and run config (generated from the policy
 *   with the repo's overlay applied, H-172), and the host's copies of its work
 *   order and task text, each bound read-only into the container, whose uid is
 *   another host uid under rootless Docker;
 * - `inputs/` (0755, its files 0644), for a review or a fix: the host's copy of
 *   the inputs dir the caller named (its kind's `RUN_INPUTS` files alone,
 *   ./kinds.ts `inputFiles`), bound read-only at `RUN_PATHS.inputs`;
 * - `sidecar/` (0755, its files 0644), for a run with a smoke sidecar: its
 *   data, exported from the run's commit (./sidecar.ts `exportSidecarData`)
 *   and bound read-only into the sidecar at /data;
 * - `out/`: the outputs copy-out brought back (./copyout.ts), 0600 each.
 * Nothing a run writes lands here but through copy-out.
 *
 * Admission, under the launcher's lock (`withStartLock`), before anything is
 * created:
 * - the key: a run is keyed by its work-order id and source commit, and, for
 *   the engine's runs, by its kind, round and pass (`runKey`, `keyPart`). A
 *   key with a live or succeeded run is refused, and one whose last run ended
 *   otherwise unless `--retry-of` names that run (`keyProblem`), so a re-fire
 *   is safe, as Archon's trigger receipts made it (design §3.1, H-183(c)). A
 *   hand run (`hapi run start`) keeps Plan 02's two-part key; every engine
 *   key has a part, so the two never meet;
 * - one live run per repo (spec §4.4, H-090), and at most `runs.max_live` in
 *   all (`capacityProblem`). A repo is its source's git dir, and its GitHub
 *   `owner/name` when the start names one (`forgeRepo`, m23): a verify or a
 *   review starts from a scratch copy of the mirror, another git dir, and still
 *   counts against its repo.
 *
 * Liveness is Docker's, never a pid that could be reused: a run is live while
 * a container named `runName` with both its labels is running (`isLive`,
 * `liveRuns`). A helper container (the volume chown, copy-out, the run disk's
 * cleanup) and a run's smoke sidecar carry the labels too, so `down` finds
 * them, but not a run's name, so they never count.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseOwnerRepo } from "../forge/github/app-token";
import type { RunFile } from "../generate/archon";
import { withStoreLock } from "../secrets/store-files";
import { definedEnv, listed, runFilters } from "../stack/up";
import { INPUTS_DIR, type KindProfile, kindProfile, RUN_KINDS, type RunKind } from "./kinds";
import { type RunDeps, runName } from "./spec";

/** Whether an error is a held lock: defined in ./locks.ts, which src/stack/up.ts can import too, and re-exported here for the launcher's locks. */
export { lockHeld } from "./locks";

export type RunStatus = "live" | "succeeded" | "failed" | "timed-out" | "stopped";

export interface RunRecord {
  runId: string;
  /** `runKey(workOrder, sha, keyPart(kind, round, retry))`: Plan 02's two-part key for a hand run. */
  key: string;
  project: string;
  /** The source's git dir, as the run bound it: the per-repo lock's identity. */
  repo: string;
  sha: string;
  workOrder: string;
  workflow: string;
  container: string;
  network: string;
  volumes: { work: string; out: string };
  startedAt: string;
  /** startedAt plus the work order's budget.minutes: the supervisor (or the reaper) stops the run then. */
  deadline: string;
  status: RunStatus;
  /** Why a run did not succeed (or what its cleanup left), from hapi's own checks: never text a run wrote. */
  reason?: string;
  retryOf?: string;
  harvestedAt?: string;
  /** Set before the container is stopped, so whichever process finalizes the run records why it ended. A stop outranks the deadline: "stopped" may replace "timed-out" while the run is live, never the reverse. */
  stopRequested?: "timed-out" | "stopped";
  // What an eval compares (design §3.8). A Plan 02 record has none of these: its kind is a worker's.
  kind?: RunKind;
  /** The work order's worker run, for every kind but `worker`: its sha is this run's base commit. */
  parent?: string;
  round?: number;
  /** The run's budget: the work order's budget.usd for a worker, at most `runs.phases.round_usd` for any other kind, or lower as the caller asked. */
  budgetUsd?: number;
  /** What the run spent, when it is known (./spend.ts `spendOfRun`), written at finalize. */
  spendUsd?: number;
  /** The roster `build/roster` named when the run started. */
  roster?: string;
  /** The SHA-256 hex of the effective policy (the central policy with the repo's overlay applied) as JSON. */
  policyHash?: string;
  /** The engine's pass of the work order: 0 on the first, n after the n-th `hapi retry`. A hand run has none (its `--retry-of` is `retryOf`). */
  retry?: number;
  /** The turns the run took (its guard's count, ./spend.ts `turnsOfRun`), written at finalize when known. Not run.json's `turns`, which is the run's turn budget. */
  turns?: number;
  /** The model the run's alias names in its roster: `@implement`'s for a worker or fix, `@review`'s for a review; none for a verify, which runs no model. */
  model?: string;
  /** The GitHub repository the run is of, `owner/name` (the poller's `Discovered.repo`, Task 13), lower-cased: one live run per repo counts by it too (m23). A hand run has none. */
  forgeRepo?: string;
  /**
   * The run container's exit code as Docker recorded it, read at finalize (`docker inspect`), when it could be. Never
   * the run's status (a paused run exits 0): one more source Task 12 cross-checks a verify run's results against.
   */
  exitCode?: number;
  /**
   * `"off"` when decision models were off (policy/gates.yaml's `decisions.mode`) for the harvest that first read the
   * run: written with `harvestedAt`, in the same write (Plan 03 Task 12), so it is never silent. No other value.
   */
  decisions?: "off";
  /**
   * A review run's verdict and its acceptance criteria's marks, in order, as the harvester read them (m20; Plan 03
   * Task 12): written with or after `harvestedAt`, never overwritten. What an eval compares (design §3.8).
   */
  review?: { verdict: "ready" | "needs-work" | "blocked"; marks: ("met" | "partly" | "unmet")[] };
}

/** The files a run's dir holds beside record.json and run.json, each bound read-only into the container: see the module comment. */
export const PER_RUN_FILES = ["hapi-guard.json", "run-config.yaml", "order.json", "task.md"] as const;

const STATUSES: readonly RunStatus[] = ["live", "succeeded", "failed", "timed-out", "stopped"];
const RECORD = "record.json";
export const RUN_FILE = "run.json";

/** A run id: twelve lower-case hex digits, in a container, network and volume name and a path. */
export const RUN_ID = /^[0-9a-f]{12}$/;

export function newRunId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * The SHA-256 hex of the work-order id, the commit and, when given, the key's part (`keyPart`): the same triple
 * always has the same key. With no part it is Plan 02's two-part key, unchanged, so Plan 02's records stay valid.
 */
export function runKey(workOrderId: string, sha: string, part?: string): string {
  return createHash("sha256").update(part === undefined ? `${workOrderId}\0${sha}` : `${workOrderId}\0${sha}\0${part}`).digest("hex");
}

/**
 * The key's part for a run of `kind` at `round`, in the engine's pass `retry` (the one formula startRun and the
 * engine share): undefined for a worker with no retry, which is a hand run (Plan 02's two-part key);
 * `<kind>:<round>` for any other kind with no retry, and for every kind at retry 0, the engine's first pass; and
 * `<kind>:<round>:retry<n>` from the first retry on, so a new pass never meets an earlier pass's records.
 */
export function keyPart(kind: RunKind, round: number, retry?: number): string | undefined {
  if (retry === undefined) return kind === "worker" ? undefined : `${kind}:${round}`;
  return retry === 0 ? `${kind}:${round}` : `${kind}:${round}:retry${retry}`;
}

export const recordDir = (stateDir: string, runId: string): string => join(stateDir, runId);

/** An optional amount: absent, or a finite number of at least 0. */
const amount = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
/** An optional count: absent, or a whole number of at least 0. */
const count = (v: unknown) => v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);

/** A record's `review`: exactly `{ verdict, marks }`, a verdict of the review's three and marks of its three. */
function reviewOk(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "marks,verdict") return false;
  return ["ready", "needs-work", "blocked"].includes(r.verdict as string) && Array.isArray(r.marks) && r.marks.every((m) => m === "met" || m === "partly" || m === "unmet");
}

/**
 * `x` as a record of run `runId`, or undefined if it isn't one: a kind that is no run kind, a budget or spend that
 * isn't a finite number of at least 0, a round, turns or retry that isn't a whole number of at least 0, a
 * forgeRepo that isn't a GitHub repository's owner/name, an exit code that isn't an integer, a `decisions` that
 * isn't "off", or a `review` that isn't a verdict and marks, isn't.
 */
function asRecord(x: unknown, runId: string): RunRecord | undefined {
  const r = x as Partial<RunRecord> | null;
  if (r === null || typeof r !== "object" || r.runId !== runId || !STATUSES.includes(r.status as RunStatus)) return undefined;
  if (r.kind !== undefined && !RUN_KINDS.includes(r.kind)) return undefined;
  if (![r.budgetUsd, r.spendUsd].every(amount) || ![r.round, r.turns, r.retry].every(count)) return undefined;
  if (r.forgeRepo !== undefined && (typeof r.forgeRepo !== "string" || parseOwnerRepo(r.forgeRepo) === undefined)) return undefined;
  if (r.exitCode !== undefined && !Number.isInteger(r.exitCode)) return undefined;
  if (r.decisions !== undefined && r.decisions !== "off") return undefined;
  if (r.review !== undefined && !reviewOk(r.review)) return undefined;
  const text = [r.key, r.project, r.repo, r.sha, r.workOrder, r.workflow, r.container, r.network, r.startedAt, r.deadline, r.volumes?.work, r.volumes?.out];
  return text.every((t) => typeof t === "string") ? (r as RunRecord) : undefined;
}

/** The record of `runId`, or undefined if its dir or record.json doesn't exist. Throws on one hapi didn't write. */
export async function readRecord(stateDir: string, runId: string): Promise<RunRecord | undefined> {
  const file = join(recordDir(stateDir, runId), RECORD);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const rec = asRecord(parsed, runId);
  if (rec === undefined) throw new Error(`${file} is not a run record hapi wrote: fix or remove ${recordDir(stateDir, runId)}`);
  return rec;
}

/** Write `text` to `file` whole: a new temp file beside it (`mode`, never an existing one), renamed into place. */
export async function writeWhole(file: string, text: string, mode = 0o600): Promise<void> {
  const tmp = join(dirname(file), `.${basename(file)}.${randomUUID()}`);
  await writeFile(tmp, text, { mode, flag: "wx" });
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Write `rec` whole (a temp file renamed into place), 0600. */
export async function writeRecord(stateDir: string, rec: RunRecord): Promise<void> {
  await writeWhole(join(recordDir(stateDir, rec.runId), RECORD), `${JSON.stringify(rec, null, 2)}\n`);
}

/** Every run's record, oldest id first. A dir without record.json (a start that died before writing it) is skipped. */
export async function listRecords(stateDir: string): Promise<RunRecord[]> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: RunRecord[] = [];
  for (const name of names.filter((n) => RUN_ID.test(n)).sort()) {
    const rec = await readRecord(stateDir, name);
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

/** A name in an inputs dir that may be shown: plain, and short. */
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,64}$/;

const MIB = 1024 * 1024;
/** The refusal of an inputs copy over `runs.inputs_mb`: refused, never truncated. */
const inputsOver = (dir: string, bytes: number, capMb: number) => `the inputs dir ${dir} holds ${(bytes / MIB).toFixed(1)} MiB, over runs.inputs_mb (${capMb} MiB): an inputs copy is refused, never truncated`;

/**
 * Why `dir` can't be the inputs dir of a run of `profile`'s kind, or undefined: it must be a directory (not a
 * symlink to one) holding only regular files, each one of its kind's inputs (`inputFiles.allowed`, ./kinds.ts), and
 * each it requires (`inputFiles.required`): a fix's findings.md, a review's diff.patch; together at most `capMb` MiB
 * (`runs.inputs_mb`), when given. A name that isn't plain is never shown.
 */
export async function inputsProblem(dir: string, profile: Pick<KindProfile, "kind" | "inputFiles">, capMb?: number): Promise<string | undefined> {
  const { allowed, required } = profile.inputFiles;
  const at = await lstat(dir).catch(() => undefined);
  if (at === undefined || !at.isDirectory()) return `the inputs dir ${dir} is not a directory`;
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (e) {
    return `the inputs dir ${dir} can't be read (${(e as NodeJS.ErrnoException).code ?? "error"})`;
  }
  let bytes = 0;
  for (const name of names) {
    if (!PLAIN_NAME.test(name)) return "the inputs dir holds a name that isn't plain ([A-Za-z0-9._-], at most 64 characters): not shown";
    const entry = await lstat(join(dir, name)).catch(() => undefined);
    if (entry === undefined || !entry.isFile()) return `${dir}/${name}: the inputs dir holds only regular files, not a symlink or a directory`;
    if (!allowed.includes(name)) {
      const bundle = /\.bundle$/.test(name) ? ": an inputs dir never holds a bundle" : "";
      return `${dir}/${name} is not one of a ${profile.kind} run's inputs (${allowed.join(", ") || "none"})${bundle}`;
    }
    bytes += entry.size;
  }
  for (const name of required) if (!names.includes(name)) return `${dir} has no ${name}: a ${profile.kind} run's inputs dir must hold it`;
  if (capMb !== undefined && bytes > capMb * MIB) return inputsOver(dir, bytes, capMb);
  return undefined;
}

/**
 * Copy the inputs dir `from` into `<dir>/inputs` (0755, each file 0644: the container reads them as another host
 * uid). Each file is opened without following a link and must be a regular file named for one of `allowed`, its
 * kind's inputs, as `inputsProblem` checked before the launcher's lock, and all of them together at most `capMb`
 * MiB, counted as they are read (a file that grew since the check is refused, never truncated); anything else now
 * throws.
 */
async function copyInputs(from: string, dir: string, allowed: readonly string[], capMb: number | undefined): Promise<void> {
  const to = join(dir, INPUTS_DIR);
  await mkdir(to, { mode: 0o755 });
  await chmod(to, 0o755);
  let total = 0;
  for (const name of (await readdir(from)).sort()) {
    if (!allowed.includes(name)) throw new Error(`the inputs dir ${from} changed after it was checked: it holds a name that is not one of its kind's inputs`);
    const fh = await open(join(from, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      if (!(await fh.stat()).isFile()) throw new Error(`${from}/${name} changed after it was checked: it is not a regular file`);
      bytes = await fh.readFile();
    } finally {
      await fh.close();
    }
    total += bytes.length;
    if (capMb !== undefined && total > capMb * MIB) throw new Error(inputsOver(from, total, capMb));
    const file = join(to, name);
    await writeFile(file, bytes, { flag: "wx" });
    await chmod(file, 0o644);
  }
}

/**
 * Make the run's dir (it must not exist), with its record, its run file and each of `PER_RUN_FILES`, and, for a
 * review or a fix, its copy of the inputs dir `inputsFrom` (`copyInputs`, at most `inputsCapMb` MiB); a write that
 * fails removes the dir again.
 */
export async function createRun(
  stateDir: string,
  rec: RunRecord,
  runFile: RunFile,
  files: Record<(typeof PER_RUN_FILES)[number], string>,
  inputsFrom?: string,
  inputsCapMb?: number,
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const dir = recordDir(stateDir, rec.runId);
  await mkdir(dir, { mode: 0o700 });
  try {
    await writeRecord(stateDir, rec);
    const bound: [name: string, text: string][] = [[RUN_FILE, `${JSON.stringify(runFile, null, 2)}\n`], ...PER_RUN_FILES.map((name) => [name, files[name]] as [string, string])];
    for (const [name, text] of bound) {
      const file = join(dir, name);
      await writeFile(file, text, { flag: "wx" });
      // The container reads it as uid 1001, another host uid under rootless Docker: readable by all, whatever the umask.
      await chmod(file, 0o644);
    }
    if (inputsFrom !== undefined) await copyInputs(inputsFrom, dir, kindProfile(rec.kind ?? "worker").inputFiles.allowed, inputsCapMb);
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Remove a run's dir: a start that failed leaves no record behind. */
export async function removeRunDir(stateDir: string, runId: string): Promise<void> {
  await rm(recordDir(stateDir, runId), { recursive: true, force: true });
}

/** The ids of the project's live runs. Throws when Docker can't say: admission must not assume none. */
export async function liveRuns(d: Pick<RunDeps, "run" | "env" | "project">): Promise<string[]> {
  const rows = await listed(d.run, d.env, ["docker", "ps", ...runFilters(d.project), "--format", '{{.Label "org.hapi.run"}}\t{{.Names}}']);
  return rows.map((row) => row.split("\t")).filter(([id, name]) => id !== undefined && RUN_ID.test(id) && name === runName(d.project, id)).map(([id]) => id!);
}

/** Whether run `runId`'s container is running. Throws when Docker can't say. */
export async function isLive(d: Pick<RunDeps, "run" | "env" | "project">, runId: string): Promise<boolean> {
  const names = await listed(d.run, d.env, ["docker", "ps", ...runFilters(d.project, runId), "--format", "{{.Names}}"]);
  return names.includes(runName(d.project, runId));
}

/** Whether run `runId`'s container exists, running or not. Throws when Docker can't say. */
export async function containerExists(d: Pick<RunDeps, "run" | "env" | "project">, runId: string): Promise<boolean> {
  const names = await listed(d.run, d.env, ["docker", "ps", "-a", ...runFilters(d.project, runId), "--format", "{{.Names}}"]);
  return names.includes(runName(d.project, runId));
}

const at = (workOrder: string, sha: string) => `work order ${workOrder} at ${sha.slice(0, 12)}`;

/** Why the key refuses this run, or undefined: see the module comment. */
export function keyProblem(records: RunRecord[], want: { key: string; workOrder: string; sha: string; retryOf?: string }): string | undefined {
  const same = records.filter((r) => r.key === want.key).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
  const what = at(want.workOrder, want.sha);
  const live = same.find((r) => r.status === "live");
  if (live !== undefined) return `run ${live.runId} of ${what} is live: a work order runs once per commit; wait for it, or stop it with \`hapi run stop ${live.runId}\``;
  const won = same.find((r) => r.status === "succeeded");
  if (won !== undefined) return `run ${won.runId} of ${what} already succeeded: a work order runs once per commit`;
  const last = same.at(-1);
  if (want.retryOf === undefined) return last === undefined ? undefined : `run ${last.runId} of ${what} ended ${last.status}: pass --retry-of ${last.runId} to run it again`;
  if (last === undefined) return `--retry-of ${want.retryOf}: ${what} has no run to retry`;
  if (last.runId !== want.retryOf) return `--retry-of ${want.retryOf} is not the last run of ${what}: that is ${last.runId}`;
  return undefined;
}

/**
 * Why the live runs leave no room for one more on `want`'s repo, or undefined: one per repo (H-090), `maxLive` in all.
 * A live run is of the same repo when its source is the same git dir, or when the start names a GitHub repo
 * (`forgeRepo`, m23) and the live run's record names the same one: a verify on a scratch copy of the mirror counts
 * against a worker live on the mirror.
 */
export function capacityProblem(live: string[], records: RunRecord[], want: { repo: string; forgeRepo?: string }, d: Pick<RunDeps, "stateDir" | "project" | "runs">): string | undefined {
  const byId = new Map(records.map((r) => [r.runId, r]));
  for (const id of live) {
    const r = byId.get(id);
    if (r === undefined) {
      return `run ${id} is live but has no record in ${d.stateDir}, so its repo is unknown: remove it with \`docker rm -f ${runName(d.project, id)}\`, or \`mise run down\``;
    }
    // GitHub's names aren't case-sensitive: startRun lower-cases a forgeRepo, and this compares them so too.
    const forge = want.forgeRepo !== undefined && r.forgeRepo?.toLowerCase() === want.forgeRepo.toLowerCase();
    if (forge || r.repo === want.repo) {
      return `run ${id} is live for ${forge ? want.forgeRepo : want.repo}: one live run per repo (H-090); wait for it, or stop it with \`hapi run stop ${id}\``;
    }
  }
  if (live.length >= d.runs.max_live) {
    return `${live.length} runs are live and runs.max_live is ${d.runs.max_live} (policy/runs.yaml): wait for one to end, or stop one with \`hapi run stop <id>\``;
  }
  return undefined;
}

/**
 * Run `fn` holding the launcher's lock: the secrets commands' lock
 * (`withStoreLock`, on the user's tmpfs), keyed by the state dir. Start's
 * admission and creation, and every reap, hold it, so two of them never
 * interleave. A held lock fails at once, naming its holder.
 */
export function withStartLock<T>(d: Pick<RunDeps, "stateDir" | "env">, fn: () => Promise<T>): Promise<T> {
  return withStoreLock(d.stateDir, "run-start", fn, { env: definedEnv(d.env), label: "hapi run" });
}

/** Run `fn` holding run `runId`'s own lock, keyed by its dir: one finalize at a time, and a stop request between them. */
export function withRunLock<T>(d: Pick<RunDeps, "stateDir" | "env">, runId: string, fn: () => Promise<T>): Promise<T> {
  return withStoreLock(recordDir(d.stateDir, runId), "run-finalize", fn, { env: definedEnv(d.env), label: "hapi run" });
}
