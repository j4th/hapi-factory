/**
 * What a run spent and how many turns it took, read from its copied-out files (`<record dir>/out`; H-229, design
 * §3.8, §3.9). The files are the run's own, so untrusted: each is read whole as text, a line or a file that doesn't
 * parse counts as none, and only a finite number of at least 0 counts as a spend.
 *
 * Two sources each say the run's total, and each misses costs the other sees:
 * - **the guard's ledger**: hapi-guard writes a spend record (`event` "budget", `rule` "spend") with the run's
 *   total so far at every `turn_end`, and a hard stop's `run-budget` record carries the total too. Archon reports no
 *   cost for an attempt the guard failed (the paid check's Run B, 2026-10-31);
 * - **Archon's**, `result.json`'s `run.metadata.total_cost_usd`.
 * The spend is the higher of the ledger's last total and Archon's. Both are in places the worker can write (`/out`,
 * and Archon's database), so a forged low line must not lower it: an honest ledger is cumulative and never falls, so
 * a ledger whose totals fall from one line to a later one makes the spend unknown, and so does no total at all. An
 * unknown spend counts at the run's whole budget, so a cap never counts a run it can't read as cheaper than it may
 * have been. A worker that rewrites both sources consistently can still under-report (H-250).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `file`'s text, or undefined when it is missing or can't be read. */
function text(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Each line of decisions.jsonl that parses to a JSON object, in order. */
function records(outDir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of (text(join(outDir, "decisions.jsonl")) ?? "").split("\n")) {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec !== null && typeof rec === "object" && !Array.isArray(rec)) out.push(rec as Record<string, unknown>);
  }
  return out;
}

const spendOk = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The run's spend from its out dir (see the module comment): the higher of the guard's last total (each record with
 * `event` "budget", `rule` "spend" or "run-budget" and a `cost_usd` that is finite and at least 0) and Archon's
 * `total_cost_usd`; `{ usd: budgetUsd, known: false }` when the guard's totals ever fall, or there is neither.
 */
export function spendOfRun(outDir: string, budgetUsd: number): { usd: number; known: boolean } {
  const totals = records(outDir)
    .filter((r) => r.event === "budget" && (r.rule === "spend" || r.rule === "run-budget") && spendOk(r.cost_usd))
    .map((r) => r.cost_usd as number);
  // An honest ledger is cumulative: a total below an earlier one is a line the run wrote.
  if (totals.some((t, i) => i > 0 && t < totals[i - 1]!)) return { usd: budgetUsd, known: false };
  let doc: { run?: { metadata?: { total_cost_usd?: unknown } } } | null = null;
  try {
    doc = JSON.parse(text(join(outDir, "result.json")) ?? "null");
  } catch {
    doc = null;
  }
  const archon = doc?.run?.metadata?.total_cost_usd;
  const seen = [...totals.slice(-1), ...(spendOk(archon) ? [archon] : [])];
  return seen.length === 0 ? { usd: budgetUsd, known: false } : { usd: Math.max(...seen), known: true };
}

/**
 * The turns the run took: the last spend record's `turns` (the guard's count over every attempt, so the spend record
 * a hard stop writes again adds none), never a count of records; undefined when there is no spend record, or the
 * last one's `turns` isn't a whole number of at least 0.
 */
export async function turnsOfRun(outDir: string): Promise<number | undefined> {
  const last = records(outDir).filter((r) => r.event === "budget" && r.rule === "spend").at(-1);
  const turns = last?.turns;
  return typeof turns === "number" && Number.isInteger(turns) && turns >= 0 ? turns : undefined;
}
