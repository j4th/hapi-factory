/**
 * Rule 3, the run budget (design §3.3, §3.5, §6a items 6 and 8).
 *
 * The limit is `min(run.json budget_usd, hapi-guard.json budgets.run_usd)`; the
 * launcher has already folded the work order's `budget.usd` into `budget_usd`,
 * so an override can only lower it. The run's spend is:
 *
 * - this session's, summed as Pi's own `getUsageCostBreakdown` groups it
 *   (core/usage-totals.js:41-78): assistant messages, `usage` entries (cache
 *   warms), toolResult messages with usage, and `compaction` and
 *   `branch_summary` entries. The cost is Pi's, from the resolved model's prices,
 *   which session_start has checked against the pins;
 * - plus this process's classifier calls (decide()'s `costUsd`). A few billed
 *   classifier failures report 0 (decide() returns the fallback with no cost);
 *   that undercount is decide()'s, not fixed here;
 * - plus every other attempt's spend from the ledger.
 *
 * The ledger: each Pi node attempt runs in a fresh process (§6a item 6), so the
 * run's total can't live in memory. Each process keeps one file,
 * `<ledgerDir>/<WORKFLOW_ID>/<attempt id>.<session id>.json`, written whole
 * (temp file, then rename) at session_start and after each spend. A later
 * process of the same attempt and session (a reask that resumes it) replaces the
 * file, carrying its classifier cost forward; its session entries already hold
 * the earlier spend. A session resumed by another attempt is counted twice:
 * the safe direction.
 *
 * The residual: the ledger is in the worker's own tmpfs, so its shell can edit or
 * delete it (the write tool can't: rule 1). An unreadable file counts as 0, and
 * so does a started attempt that left no file (known from its session_start in
 * the decision log); each is logged as rule `ledger-reset` and flags the run.
 * Archon's `max_spend_usd` and the provider caps stay as the second and third
 * lines (spike T10).
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Identity } from "./config";
import type { SessionEntry } from "./pi-api";

/** One usage's cost in USD; anything but a positive finite number counts as 0. */
export const usageUsd = (u: { cost?: { total?: unknown } } | undefined): number => {
  const t = u?.cost?.total;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0;
};

/** The session's spend in USD, by getUsageCostBreakdown's grouping. */
export function sessionSpendUsd(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const e of entries) {
    if (e.type === "message" && e.message?.role === "assistant") total += usageUsd(e.message.usage);
    else if (e.type === "usage") total += usageUsd(e.usage);
    else if (e.type === "message" && e.message?.role === "toolResult") total += usageUsd(e.message.usage);
    else if (e.type === "compaction" || e.type === "branch_summary") total += usageUsd(e.usage);
  }
  return total;
}

/** A file name segment: anything but letters, digits, "_" and "-" is %-encoded, so "." can separate. */
const segment = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** One process's ledger file. */
export interface LedgerRecord {
  run: string;
  node: string;
  attempt: string;
  session: string;
  session_usd: number;
  classifier_usd: number;
  /** Requests started (before_provider_headers), retries included. */
  sends: number;
  updated: string;
}

const isUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** A ledger file's record, or undefined when it isn't one. */
function parseRecord(text: string, run: string): LedgerRecord | undefined {
  try {
    const r = JSON.parse(text) as Partial<LedgerRecord>;
    if (r && r.run === run && typeof r.attempt === "string" && isUsd(r.session_usd) && isUsd(r.classifier_usd)) return r as LedgerRecord;
  } catch {
    // not JSON
  }
  return undefined;
}

export class Ledger {
  readonly dir: string;
  readonly file: string;
  private classifierUsd = 0;
  private sends = 0;

  constructor(
    ledgerDir: string,
    private readonly id: Identity,
    private readonly session: string,
  ) {
    this.dir = join(ledgerDir, segment(id.run));
    this.file = `${segment(id.attempt)}.${segment(session)}.json`;
  }

  /**
   * At session_start: carry this attempt and session's classifier cost forward,
   * write the file, and say which ledgers counted as 0. `started` are the
   * attempts of this run the decision log saw start.
   */
  open(started: Set<string>): string[] {
    mkdirSync(this.dir, { recursive: true });
    const { records, bad } = this.read(true);
    const mine = records.find(([name]) => name === this.file)?.[1];
    if (mine) {
      this.classifierUsd = mine.classifier_usd;
      this.sends = typeof mine.sends === "number" ? mine.sends : 0;
    }
    const covered = new Set(records.map(([, r]) => r.attempt));
    const resets = bad.map((name) => `the ledger file ${name} can't be read, so its spend counts as 0`);
    for (const attempt of started) {
      if (!covered.has(attempt)) resets.push(`attempt ${attempt} of this run started but left no ledger, so its spend counts as 0`);
    }
    return resets;
  }

  /** Every parsable record in the run's dir (with this process's own file only if `withMine`), and the unreadable names. */
  private read(withMine: boolean): { records: [string, LedgerRecord][]; bad: string[] } {
    const records: [string, LedgerRecord][] = [];
    const bad: string[] = [];
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return { records, bad };
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || (!withMine && name === this.file)) continue;
      let r: LedgerRecord | undefined;
      try {
        r = parseRecord(readFileSync(join(this.dir, name), "utf8"), this.id.run);
      } catch {
        // unreadable
      }
      if (r) records.push([name, r]);
      else bad.push(name);
    }
    return { records, bad };
  }

  /** The other processes' spend, and the names of files that count as 0 (re-read each time: parallel nodes spend too). */
  others(): { usd: number; bad: string[] } {
    const { records, bad } = this.read(false);
    return { usd: records.reduce((sum, [, r]) => sum + r.session_usd + r.classifier_usd, 0), bad };
  }

  addClassifier(usd: number): void {
    if (isUsd(usd)) this.classifierUsd += usd;
  }

  countSend(): void {
    this.sends++;
  }

  /** This process's own spend: the session's plus its classifier calls. */
  mine(sessionUsd: number): number {
    return sessionUsd + this.classifierUsd;
  }

  /** Write this process's record whole: a temp file, then rename. */
  save(sessionUsd: number): void {
    const record: LedgerRecord = {
      run: this.id.run,
      node: this.id.node,
      attempt: this.id.attempt,
      session: this.session,
      session_usd: sessionUsd,
      classifier_usd: this.classifierUsd,
      sends: this.sends,
      updated: new Date().toISOString(),
    };
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${this.file}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameSync(tmp, join(this.dir, this.file));
  }
}

/** A USD amount for a message: up to four decimals, no trailing zeros. */
export const usd = (n: number): string => `$${Number(n.toFixed(4))}`;
