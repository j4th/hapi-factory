/**
 * A work order's state in the run engine (design §3.4, §3.6): the types the harvester (./harvest.ts), the state
 * machine (./pipeline.ts) and the poller share, and the functions that read, write and move them (Plan 03 Task 13).
 *
 * - **One file per work order**, `<engineDir>/orders/<owner>/<name>/<id>.json` (0600, its dirs 0700), written whole
 *   by temp and rename (`writeState`), and read strictly (`readState`): a field of the wrong type, an unknown key,
 *   or a file that isn't JSON throws, naming the file and the field. The poller writes it under the work order's
 *   own lock (`withOrderLock`), only once `advance` has resolved, so a crash leaves the last good state.
 * - **A transition** changes the phase and `updatedAt` alone, and gives one `StatusEvent` for `events.jsonl`;
 *   everything else a step changes (runs, rounds, the PR, the verdict, the reasons) is the caller's.
 * - **`hapi retry`** (the operator's call of 2026-11-01, m19): `retryProblem` says why a state can't be retried,
 *   reading nothing but its arguments, and `retryState` is the next pass, queued at the back of its repo's queue.
 *   Only the operator's `hapi retry` calls them (Task 14): nothing retries on its own.
 */
import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseOwnerRepo } from "../forge/github/app-token";
import { RUN_ID, writeWhole } from "../run/records";
import { withStoreLock } from "../secrets/store-files";
import { definedEnv, type Env } from "../stack/up";
import { isWorkOrderId, WORK_ORDER_ID } from "../workorder/validate";
import type { Discovered } from "./discover";

/** The work-order schema's id pattern: Task 6's one definition, re-exported for the engine's callers. */
export { WORK_ORDER_ID };

/** Where a work order is. SETTLED: failed, merged, closed, cap-stopped; the rest are queued, active or on a PR. */
export type Phase =
  | "held"
  | "queued"
  | "worker"
  | "verify"
  | "review"
  | "fix"
  | "harvest"
  | "pr"
  | "pr-review"
  | "pr-fix"
  | "waiting"
  | "failed"
  | "merged"
  | "closed"
  | "cap-stopped";

/** Every phase, in the pipeline's order. */
export const PHASES: readonly Phase[] = ["held", "queued", "worker", "verify", "review", "fix", "harvest", "pr", "pr-review", "pr-fix", "waiting", "failed", "merged", "closed", "cap-stopped"];

/** A factory PR's verdict (design §3.7 row 1): Ready to merge, Needs your decision, Do not merge. */
export type Verdict = "ready" | "decision" | "do-not-merge";

export interface WorkOrderState {
  repo: string;
  id: string;
  mergeSha: string;
  planningPr: number | undefined;
  phase: Phase;
  runs: string[];
  autoRounds: number;
  reworkRounds: number;
  /** 0 until the operator's first `hapi retry` (Task 14). */
  retry: number;
  pr?: number;
  prHead?: string;
  verdict?: Verdict;
  reasons: string[];
  lastHumanAt?: string;
  updatedAt: string;
}

export interface StatusEvent {
  at: string;
  repo: string;
  workOrder: string;
  phase: Phase;
  run?: string;
  pr?: number;
  verdict?: Verdict;
  reason?: string;
  usd?: number;
  /** Only when the work order's is at least 1. */
  retry?: number;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const VERDICTS: readonly Verdict[] = ["ready", "decision", "do-not-merge"];
const KEYS = new Set(["repo", "id", "mergeSha", "planningPr", "phase", "runs", "autoRounds", "reworkRounds", "retry", "pr", "prHead", "verdict", "reasons", "lastHumanAt", "updatedAt"]);

/** `<engineDir>/orders/<owner>/<name>/<id>.json`. Throws for a repo that isn't an owner/name, or an id that isn't a work-order id. */
export const statePath = (engineDir: string, repo: string, id: string): string => {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${JSON.stringify(repo.slice(0, 120))}`);
  if (!isWorkOrderId(id)) throw new Error(`not a work-order id: ${JSON.stringify(id.slice(0, 120))}`);
  return join(engineDir, "orders", r.owner, r.name, `${id}.json`);
};

/** The first state a discovered work order gets: `held` (verdict `decision`, the reason first) when `held` names why, else `queued`. */
export function newState(o: Discovered, planningPr: number | undefined, at: string, held?: string): WorkOrderState {
  return {
    repo: o.repo,
    id: o.id,
    mergeSha: o.mergeSha,
    planningPr,
    phase: held === undefined ? "queued" : "held",
    runs: [],
    autoRounds: 0,
    reworkRounds: 0,
    retry: 0,
    ...(held === undefined ? {} : { verdict: "decision" as const }),
    reasons: held === undefined ? [] : [held],
    updatedAt: at,
  };
}

const whole = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const prNumber = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const time = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The first field of `x` that isn't what a state holds, or undefined: see the module comment. */
function badField(x: unknown, want: { repo: string; id: string } | undefined): string | undefined {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return "the file's content";
  const s = x as Record<string, unknown>;
  const extra = Object.keys(s).find((k) => !KEYS.has(k));
  if (extra !== undefined) return extra.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 40);
  const checks: [string, boolean][] = [
    ["repo", typeof s.repo === "string" && parseOwnerRepo(s.repo) !== undefined && (want === undefined || s.repo === want.repo)],
    ["id", typeof s.id === "string" && isWorkOrderId(s.id) && (want === undefined || s.id === want.id)],
    ["mergeSha", typeof s.mergeSha === "string" && COMMIT.test(s.mergeSha)],
    ["planningPr", s.planningPr === undefined || prNumber(s.planningPr)],
    ["phase", PHASES.includes(s.phase as Phase)],
    ["runs", Array.isArray(s.runs) && s.runs.every((r) => typeof r === "string" && RUN_ID.test(r))],
    ["autoRounds", whole(s.autoRounds)],
    ["reworkRounds", whole(s.reworkRounds)],
    ["retry", whole(s.retry)],
    ["pr", s.pr === undefined || prNumber(s.pr)],
    ["prHead", s.prHead === undefined || (typeof s.prHead === "string" && COMMIT.test(s.prHead))],
    ["verdict", s.verdict === undefined || VERDICTS.includes(s.verdict as Verdict)],
    ["reasons", Array.isArray(s.reasons) && s.reasons.every((r) => typeof r === "string")],
    ["lastHumanAt", s.lastHumanAt === undefined || time(s.lastHumanAt)],
    ["updatedAt", time(s.updatedAt)],
  ];
  return checks.find(([, ok]) => !ok)?.[0];
}

/** Work order `id`'s state, or undefined when it has none. A file that isn't a state throws, naming it and the field. */
export async function readState(engineDir: string, repo: string, id: string): Promise<WorkOrderState | undefined> {
  const file = statePath(engineDir, repo, id);
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
    throw new Error(`${file} is not a work order's state: JSON`);
  }
  const bad = badField(parsed, { repo, id });
  if (bad !== undefined) throw new Error(`${file} is not a work order's state: ${bad}`);
  return parsed as WorkOrderState;
}

/** Write `s` whole (a temp file renamed into place), 0600, its dirs 0700. A state that isn't one throws, writing nothing. */
export async function writeState(engineDir: string, s: WorkOrderState): Promise<void> {
  const file = statePath(engineDir, s.repo, s.id);
  const bad = badField(JSON.parse(JSON.stringify(s)), undefined);
  if (bad !== undefined) throw new Error(`not a work order's state, so ${file} is not written: ${bad}`);
  const made = await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // The dirs this call made are 0700 whatever the umask.
  if (made !== undefined) for (let d = dirname(file); d.length >= made.length; d = dirname(d)) await chmod(d, 0o700);
  await writeWhole(file, `${JSON.stringify(s, null, 2)}\n`);
}

/** A dir's entries, sorted; [] when it doesn't exist. */
async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** The directories in `dir`, sorted: a stray file where an owner or a repo dir would be is skipped (D79); any error but ENOENT throws. */
async function dirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Every state of `repo`, by id; with no repo, every repo's, by repo then id. A file that isn't a state throws. */
export async function listStates(engineDir: string, repo?: string): Promise<WorkOrderState[]> {
  const root = join(engineDir, "orders");
  const repos: { owner: string; name: string }[] = [];
  if (repo !== undefined) {
    const r = parseOwnerRepo(repo);
    if (r === undefined) throw new Error(`not an owner/name: ${JSON.stringify(repo.slice(0, 120))}`);
    repos.push(r);
  } else {
    for (const owner of await dirs(root)) for (const name of await dirs(join(root, owner))) repos.push({ owner, name });
  }
  const out: WorkOrderState[] = [];
  for (const { owner, name } of repos) {
    const r = `${owner}/${name}`;
    for (const f of await entries(join(root, owner, name))) {
      if (!f.endsWith(".json") || !isWorkOrderId(f.slice(0, -".json".length))) continue;
      const s = await readState(engineDir, r, f.slice(0, -".json".length));
      if (s !== undefined) out.push(s);
    }
  }
  return out;
}

/** Run `fn` holding work order `s`'s own lock (the secrets commands' lock, keyed by its state file): one writer at a time. */
export function withOrderLock<T>(engineDir: string, s: Pick<WorkOrderState, "repo" | "id">, env: Env, fn: () => Promise<T>): Promise<T> {
  return withStoreLock(statePath(engineDir, s.repo, s.id), "engine-order", fn, { env: definedEnv(env), label: "hapi poll" });
}

/** Move `s` to `to`: only its phase and `updatedAt` change. The event carries the state's PR, verdict and pass (from retry 1). */
export function transition(s: WorkOrderState, to: Phase, o: { at: string; reason?: string; run?: string; usd?: number }): { state: WorkOrderState; event: StatusEvent } {
  const state: WorkOrderState = { ...s, phase: to, updatedAt: o.at };
  const event: StatusEvent = {
    at: o.at,
    repo: s.repo,
    workOrder: s.id,
    phase: to,
    ...(o.run === undefined ? {} : { run: o.run }),
    ...(s.pr === undefined ? {} : { pr: s.pr }),
    ...(s.verdict === undefined ? {} : { verdict: s.verdict }),
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.usd === undefined ? {} : { usd: o.usd }),
    ...(s.retry >= 1 ? { retry: s.retry } : {}),
  };
  return { state, event };
}

/**
 * Why `hapi retry` refuses `s`, or undefined; `maxRetries` is the central policy's `runs.max_retries`. In order: a
 * phase but `failed`; a PR (a retry never pushes to a PR's branch); the retries used up (always hard: no enforcement
 * setting softens it).
 */
export function retryProblem(s: WorkOrderState, maxRetries: number): string | undefined {
  if (s.phase !== "failed") return `work order ${s.id} is ${s.phase}, not failed: only a failed work order is retried (docs/runbooks/engine.md, Troubleshooting)`;
  if (s.pr !== undefined) return `work order ${s.id} has PR #${s.pr}: a PR is reworked with the hapi:rework label, not retried`;
  if (s.retry >= maxRetries) return `work order ${s.id} has been retried ${s.retry} ${s.retry === 1 ? "time" : "times"}, and runs.max_retries is ${maxRetries}: plan the work again under a new work order id`;
  return undefined;
}

/**
 * The next pass of a failed work order, queued (`updatedAt`: the back of its repo's queue), and its event. The
 * automatic-round count restarts (a retry is a human action); `runs` keeps every pass's runs, so their spend still
 * counts; `reworkRounds` and `lastHumanAt` are kept, and the verdict and PR head go.
 */
export function retryState(s: WorkOrderState, at: string): { state: WorkOrderState; event: StatusEvent } {
  const { verdict: _verdict, prHead: _prHead, ...rest } = s;
  const next: WorkOrderState = { ...rest, retry: s.retry + 1, autoRounds: 0, reasons: [] };
  return transition(next, "queued", { at, reason: `the operator retried it (retry ${next.retry}) after: ${s.reasons[0] ?? "no reason recorded"}` });
}
