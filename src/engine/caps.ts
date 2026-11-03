/**
 * The poller's caps (design §3.9; Plan 03 Task 13), checked before every automatic run, the operator's reworks and
 * a retry's runs included:
 *
 * - **The repo's month** (`budgets.repo_monthly_usd`, which an overlay may lower) and **the day** (`budgets.daily_usd`,
 *   central only), each a UTC calendar one, taken from each record's `startedAt`. The month is checked first.
 * - **What counts.** The repo's month sums every run its work orders' states list (every pass's, so a retried work
 *   order still counts its failed passes; the advancing work order's state as the caller holds it, `current`), its
 *   name compared in any case (GitHub's names aren't case-sensitive; only the matching dirs' files are read, so
 *   another repo's state file never stops this repo's check);
 *   the day sums every record in the launcher's state dir (hand runs too). Each run counts its known spend, or its
 *   whole budget when the spend isn't known (`runSpend`: a live run, or a ledger the run wrote that falls). The
 *   decision ledgers' spend is added to both (`decisionSpend`, an unanswered call at `unknown_call_usd`).
 * - **A run retention removed** (`readRecord` gives undefined) counts toward neither: retention keeps a run until
 *   the UTC month it started in has ended (src/run/lifecycle.ts `reapRuns`), so such a run is an earlier month's.
 * - **The verdict**: `spent + budget > cap` trips the cap (in whole micro-dollars, so a sum that equals the cap
 *   never trips it through float rounding), and `budgets.enforcement.poller` makes it a refusal (`hard`) or a
 *   warning (`soft`, the run starts and is flagged).
 *
 * `autoRoundsProblem` is the automatic-round cap (`runs.max_auto_rounds`): always hard, whatever
 * `budgets.enforcement.poller` says (ruling m38).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Policy } from "../policy/types";
import { listRecords, readRecord, type RunRecord } from "../run/records";
import { runSpend } from "../run/spend";
import { decisionSpend } from "./decisions";
import type { HarvestDeps } from "./harvest";
import { listStates, type WorkOrderState } from "./state";

const usd4 = (n: number) => `$${n.toFixed(4)}`;
const usd2 = (n: number) => `$${n.toFixed(2)}`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Whole micro-dollars. */
const micro = (n: number) => Math.round(n * 1e6);

/** A dir's entries, sorted; [] when it doesn't exist. */
async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * The states of `repo`, its name in any case: only the dirs whose `<owner>/<name>` matches are read, so another
 * repo's state file never stops this repo's check; one of its own that isn't a state throws (fail closed).
 */
async function repoStates(engineDir: string, repo: string): Promise<WorkOrderState[]> {
  const root = join(engineDir, "orders");
  const want = repo.toLowerCase();
  const out: WorkOrderState[] = [];
  for (const owner of await entries(root)) {
    for (const name of await entries(join(root, owner))) if (`${owner}/${name}`.toLowerCase() === want) out.push(...(await listStates(engineDir, `${owner}/${name}`)));
  }
  return out;
}

/** Whether a record started at or after `from`: a `startedAt` that doesn't parse counts (fail closed). */
const since = (r: RunRecord, from: number) => {
  const t = Date.parse(r.startedAt);
  return Number.isNaN(t) || t >= from;
};

/**
 * Whether a run of `budgetUsd` may start for `repo` now: undefined, `{ refuse }` (hard) or `{ warn }` (soft), with
 * the cap's text. See the module comment.
 */
export async function capProblem(
  d: Pick<HarvestDeps, "run" | "engineDir">,
  repo: string,
  policy: Policy,
  budgetUsd: number,
  current?: WorkOrderState,
): Promise<{ refuse: string } | { warn: string } | undefined> {
  const now = d.run.now();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const unknownUsd = policy.gates.classifiers.jev.unknown_call_usd;
  const runUsd = policy.budgets.run_usd;
  const spend = (r: RunRecord) => runSpend(d.run.stateDir, r, runUsd).usd;
  const verdict = (text: string) => (policy.budgets.enforcement.poller === "soft" ? { warn: text } : { refuse: text });

  // The month: the repo's states (its name in any case), every pass's runs, and their ledgers. The advancing work
  // order's own (`current`) replaces its file, which doesn't list yet what this advance adopted.
  const same = (s: Pick<WorkOrderState, "repo" | "id">, o: Pick<WorkOrderState, "repo" | "id">) => s.repo.toLowerCase() === o.repo.toLowerCase() && s.id === o.id;
  const states: WorkOrderState[] = (await repoStates(d.engineDir, repo)).filter((s) => current === undefined || !same(s, current));
  if (current !== undefined && current.repo.toLowerCase() === repo.toLowerCase()) states.push(current);
  let month = 0;
  for (const id of new Set(states.flatMap((s) => s.runs))) {
    const r = await readRecord(d.run.stateDir, id);
    if (r !== undefined && since(r, monthStart)) month += spend(r);
  }
  for (const spelling of new Set(states.map((s) => s.repo))) {
    const ids = states.filter((s) => s.repo === spelling).map((s) => s.id);
    month += await decisionSpend(d.engineDir, { repo: spelling, ids, from: new Date(monthStart), to: now, unknownUsd });
  }
  const cap = policy.budgets.repo_monthly_usd;
  if (micro(month + budgetUsd) > micro(cap)) {
    return verdict(`this month's spend on ${repo} (${usd4(month)}) plus the run's budget (${usd4(budgetUsd)}) would pass budgets.repo_monthly_usd (${usd2(cap)}): no new run for it until ${day(nextMonth)}`);
  }

  // The day: every record, and every ledger.
  let today = 0;
  for (const r of await listRecords(d.run.stateDir)) if (since(r, dayStart)) today += spend(r);
  today += await decisionSpend(d.engineDir, { from: new Date(dayStart), to: now, unknownUsd });
  const daily = policy.budgets.daily_usd;
  if (micro(today + budgetUsd) > micro(daily)) {
    return verdict(`today's spend (${usd4(today)}) plus the run's budget (${usd4(budgetUsd)}) would pass budgets.daily_usd (${usd2(daily)}): nothing new starts until ${day(dayStart + 86_400_000)} (UTC)`);
  }
  return undefined;
}

/** Why the automatic-round cap refuses another worker or automatic fix run of `s`, or undefined: `max` is `runs.max_auto_rounds`. */
export function autoRoundsProblem(s: Pick<WorkOrderState, "autoRounds">, max: number): string | undefined {
  return s.autoRounds >= max ? `${s.autoRounds} automatic runs since the last human action (runs.max_auto_rounds: ${max}): waiting for the operator` : undefined;
}
