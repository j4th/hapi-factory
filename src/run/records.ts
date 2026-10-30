/**
 * Run records (design §3.1, §3.2; H-090): one hapi-owned dir per run,
 * `<stateDir>/<run-id>/` (0700), holding:
 * - `record.json` (`RunRecord`, 0600): what the launcher started and how it
 *   ended;
 * - `run.json` (the `RunFile`, 0644): the run's input, bound read-only into
 *   the container, whose uid is another host uid under rootless Docker;
 * - `out/`: the outputs copy-out brought back (./copyout.ts), 0600 each.
 * Nothing a run writes lands here but through copy-out.
 *
 * Admission, under the launcher's lock (`withStartLock`), before anything is
 * created:
 * - the key: a run is keyed by its work-order id and source commit
 *   (`runKey`). A key with a live or succeeded run is refused, and one whose
 *   last run ended otherwise unless `--retry-of` names that run
 *   (`keyProblem`), so a re-fire is safe, as Archon's trigger receipts made
 *   it (design §3.1, H-183(c));
 * - one live run per repo (spec §4.4, H-090), and at most `runs.max_live` in
 *   all (`capacityProblem`).
 *
 * Liveness is Docker's, never a pid that could be reused: a run is live while
 * a container named `runName` with both its labels is running (`isLive`,
 * `liveRuns`). A helper container (the volume chown, copy-out) carries the
 * labels too, so `down` finds it, but not a run's name, so it never counts.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunFile } from "../generate/archon";
import { SecretError } from "../secrets/provider";
import { withStoreLock } from "../secrets/store-files";
import { definedEnv, listed, runFilters } from "../stack/up";
import { type RunDeps, runName } from "./spec";

export type RunStatus = "live" | "succeeded" | "failed" | "timed-out" | "stopped";

export interface RunRecord {
  runId: string;
  /** `runKey(workOrder, sha)`. */
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
  /** Set before the container is stopped, so whichever process finalizes the run records why it ended. */
  stopRequested?: "timed-out" | "stopped";
}

const STATUSES: readonly RunStatus[] = ["live", "succeeded", "failed", "timed-out", "stopped"];
const RECORD = "record.json";
export const RUN_FILE = "run.json";

/** A run id: twelve lower-case hex digits, in a container, network and volume name and a path. */
export const RUN_ID = /^[0-9a-f]{12}$/;

export function newRunId(): string {
  return randomBytes(6).toString("hex");
}

/** The SHA-256 hex of the work-order id and the commit: the same pair always has the same key. */
export function runKey(workOrderId: string, sha: string): string {
  return createHash("sha256").update(`${workOrderId}\0${sha}`).digest("hex");
}

export const recordDir = (stateDir: string, runId: string): string => join(stateDir, runId);

/** `x` as a record of run `runId`, or undefined if it isn't one. */
function asRecord(x: unknown, runId: string): RunRecord | undefined {
  const r = x as Partial<RunRecord> | null;
  if (r === null || typeof r !== "object" || r.runId !== runId || !STATUSES.includes(r.status as RunStatus)) return undefined;
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

/** Write `rec` whole (a temp file renamed into place), 0600. */
export async function writeRecord(stateDir: string, rec: RunRecord): Promise<void> {
  const dir = recordDir(stateDir, rec.runId);
  const tmp = join(dir, `.${RECORD}.${randomUUID()}`);
  await writeFile(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(tmp, join(dir, RECORD));
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

/** Make the run's dir (it must not exist), with its record and run file; a write that fails removes the dir again. */
export async function createRun(stateDir: string, rec: RunRecord, runFile: RunFile): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const dir = recordDir(stateDir, rec.runId);
  await mkdir(dir, { mode: 0o700 });
  try {
    await writeRecord(stateDir, rec);
    const file = join(dir, RUN_FILE);
    await writeFile(file, `${JSON.stringify(runFile, null, 2)}\n`, { flag: "wx" });
    // The container reads it as uid 1001, another host uid under rootless Docker: readable by all, whatever the umask.
    await chmod(file, 0o644);
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

/** Why the live runs leave no room for one more on `repo`, or undefined: one per repo (H-090), `maxLive` in all. */
export function capacityProblem(live: string[], records: RunRecord[], repo: string, d: Pick<RunDeps, "stateDir" | "project" | "runs">): string | undefined {
  const byId = new Map(records.map((r) => [r.runId, r]));
  for (const id of live) {
    const r = byId.get(id);
    if (r === undefined) {
      return `run ${id} is live but has no record in ${d.stateDir}, so its repo is unknown: remove it with \`docker rm -f ${runName(d.project, id)}\`, or \`mise run down\``;
    }
    if (r.repo === repo) return `run ${id} is live for ${repo}: one live run per repo (H-090); wait for it, or stop it with \`hapi run stop ${id}\``;
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
  return withStoreLock(d.stateDir, "run-start", fn, { env: definedEnv(d.env) });
}

/** Run `fn` holding run `runId`'s own lock, keyed by its dir: one finalize at a time, and a stop request between them. */
export function withRunLock<T>(d: Pick<RunDeps, "stateDir" | "env">, runId: string, fn: () => Promise<T>): Promise<T> {
  return withStoreLock(recordDir(d.stateDir, runId), "run-finalize", fn, { env: definedEnv(d.env) });
}

/** Whether `e` is `withStoreLock` refusing a lock another live process holds. */
export const lockHeld = (e: unknown): boolean => e instanceof SecretError && e.message.includes("hapi never takes the lock");
