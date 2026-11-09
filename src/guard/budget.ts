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
 * Each file also counts its process's turns (`turns`, at every turn_end), which
 * the run's turn budget is held to (index.ts).
 *
 * The totals never fall (Task 7's `spendOfRun` reads a falling ledger as an
 * unknown spend, counted at the run's whole budget):
 *
 * - this process's session spend is counted, not re-read: a reading below the
 *   last (a message counted at message_end, before Pi persisted it, that never
 *   landed) keeps what was counted;
 * - another process's file counts at the highest this process has read from it,
 *   so a file that goes, or turns unreadable, mid-attempt still counts;
 * - a file that was already unreadable when this process started is covered by
 *   the decision log's highest total so far (log.ts `highest`, index.ts).
 *
 * Each process's totals never fall, but two Pi nodes running at once would each
 * write their own into the one log, interleaved, and a lower one after a higher
 * one makes spendOfRun read the run's spend as unknown: a false unknown, which
 * fails closed (the run counts at its whole budget). Today's workflows run their
 * Pi nodes one after another.
 *
 * The residual: the ledger is in the worker's own tmpfs, so its shell can edit or
 * delete it (the write tool can't: rule 1). An unreadable file counts as 0, and
 * so does a started attempt that left no file (known from its session_start in
 * the decision log), unless this process read it before; each, and a file that
 * goes, is logged as rule `ledger-reset` and flags the run,
 * and the run's total still starts from the log's highest. A worker that rewrites
 * both its ledger and the log can still lower it (H-250). Archon's
 * `max_spend_usd` and the provider caps stay as the second and third lines
 * (spike T10).
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
  /** Turns ended (turn_end); absent in an older file, which counts as 0. */
  turns?: number;
  updated: string;
}

const isUsd = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** A record's turns: a whole number of at least 0, else 0. */
const turnsOf = (r: Partial<LedgerRecord>): number => (typeof r.turns === "number" && Number.isInteger(r.turns) && r.turns >= 0 ? r.turns : 0);

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
  private turns = 0;
  /** This process's session spend as counted: the last reading, plus every fall since (see the module comment). */
  private lastSession: number | undefined;
  private sessionKept = 0;
  /** The session spend the file held when this process started, for a later process of the same attempt and session. */
  private resumedUsd = 0;
  /** The highest spend and turns read from each other process's file. */
  private readonly seen = new Map<string, { usd: number; turns: number }>();

  constructor(
    ledgerDir: string,
    private readonly id: Identity,
    private readonly session: string,
  ) {
    this.dir = join(ledgerDir, segment(id.run));
    this.file = `${segment(id.attempt)}.${segment(session)}.json`;
  }

  /**
   * At session_start: carry this attempt and session's classifier cost, sends,
   * turns and session spend forward, and say which ledgers counted as 0.
   * `started` are the attempts of this run the decision log saw start.
   */
  open(started: Set<string>): string[] {
    mkdirSync(this.dir, { recursive: true });
    const { records, bad } = this.read(true);
    const mine = records.find(([name]) => name === this.file)?.[1];
    if (mine) {
      this.classifierUsd = mine.classifier_usd;
      this.sends = typeof mine.sends === "number" ? mine.sends : 0;
      this.turns = turnsOf(mine);
      this.resumedUsd = mine.session_usd;
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

  /**
   * The other processes' spend and turns, each file at the highest this process has read from it, and the names of
   * files that can't be read now, or that went since this process read them (re-read each time: parallel nodes spend
   * too).
   */
  others(): { usd: number; turns: number; bad: string[] } {
    const { records, bad } = this.read(false);
    for (const [name, r] of records) {
      const was = this.seen.get(name) ?? { usd: 0, turns: 0 };
      this.seen.set(name, { usd: Math.max(was.usd, r.session_usd + r.classifier_usd), turns: Math.max(was.turns, turnsOf(r)) });
    }
    const read = new Set([...records.map(([name]) => name), ...bad]);
    const gone = [...this.seen.keys()].filter((name) => !read.has(name));
    let usd = 0;
    let turns = 0;
    for (const v of this.seen.values()) {
      usd += v.usd;
      turns += v.turns;
    }
    return { usd, turns, bad: [...bad, ...gone] };
  }

  /** The spend this process last counted for another process's file, if it has read it. */
  held(name: string): number | undefined {
    return this.seen.get(name)?.usd;
  }

  addClassifier(usd: number): void {
    if (isUsd(usd)) this.classifierUsd += usd;
  }

  countSend(): void {
    this.sends++;
  }

  /** One more turn ended in this process. */
  countTurn(): void {
    this.turns++;
  }

  /** This process's turns, a resumed session's earlier ones included. */
  mineTurns(): number {
    return this.turns;
  }

  /**
   * Count a reading of this session's spend (`sessionUsd`: its entries, plus a message not yet persisted), and return
   * this process's own spend: the session's as counted, plus its classifier calls. A reading below the last keeps what
   * was counted, and the first starts no lower than the file this attempt and session left.
   */
  mine(sessionUsd: number): number {
    if (this.lastSession === undefined) this.sessionKept = Math.max(0, this.resumedUsd - sessionUsd);
    else if (sessionUsd < this.lastSession) this.sessionKept += this.lastSession - sessionUsd;
    this.lastSession = sessionUsd;
    return this.counted() + this.classifierUsd;
  }

  /** The session's spend as counted (see mine). */
  private counted(): number {
    return (this.lastSession ?? this.resumedUsd) + this.sessionKept;
  }

  /** Write this process's record whole: a temp file, then rename. */
  save(): void {
    const record: LedgerRecord = {
      run: this.id.run,
      node: this.id.node,
      attempt: this.id.attempt,
      session: this.session,
      session_usd: this.counted(),
      classifier_usd: this.classifierUsd,
      sends: this.sends,
      turns: this.turns,
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
