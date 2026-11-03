/**
 * The decision log (design §3.3 "Events"): every decision, rule or gate, allow
 * or block, appended to `<paths.out>/decisions.jsonl` as one JSON object per
 * line, synchronously, record by record. Nothing waits for `session_shutdown`,
 * which Archon never fires (the child just exits, brief §4).
 *
 * The first record of every node attempt is `event: "session_start"`, with `run`
 * (WORKFLOW_ID), `node` (ARCHON_NODE_EXECUTION.path) and `attempt`
 * (ARCHON_NODE_EXECUTION.attempt.id, a string). Task 7's guard-ran check joins
 * the transcript's per-attempt `node_start` rows on those three (spike 08,
 * finding 10), and fails a run in which a Pi attempt left no such record.
 *
 * Two records are read on the host: a `budget` record with rule `spend` at every
 * turn_end, holding the run's total (`cost_usd`) and its turns (`turns`), which
 * src/run/spend.ts reads (H-229), and a `result` record from the session's final
 * message (result.ts; H-228(b)), which the run's gates read. Like every record
 * here they are claims: the worker shares the guard's uid and can edit /out
 * (docs/security/threat-model.md, the Plan 02 residuals).
 *
 * A record names a secret, never its value: every string in it is scrubbed of
 * the exact values rule 6 knows, and of KEY_PATTERNS' key formats, before it is
 * written. A classifier record holds
 * its answers (probabilities and confidence), never the state it was shown.
 * OTel spans come later with the observability profile; the fields are theirs.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierRecord } from "../decide/record";
import type { RunFile } from "../generate/archon";
import type { Identity } from "./config";

export type GuardEvent = "session_start" | "agent_start" | "tool_call" | "tool_result" | "provider_request" | "budget" | "gate" | "result";
/** `done`, `blocked`, `no-change` and `missing` are a `result` record's alone (result.ts). */
export type GuardDecision = "allow" | "block" | "wrap" | "flag" | "fail" | "done" | "blocked" | "no-change" | "missing";

/** A classifier's answer as recorded (its type and numbers only): src/decide/record.ts's, shared with the run engine. */
export type { ClassifierRecord, RecordedAnswer } from "../decide/record";

export interface DecisionRecord {
  ts: string;
  run: string;
  node: string;
  attempt: string;
  event: GuardEvent;
  decision: GuardDecision;
  rule: string;
  reason: string;
  tool?: string;
  path?: string;
  /** A name, never a value. */
  secret?: string;
  cost_usd?: number;
  /** The run's turns so far, every attempt's (a `spend` record's, and a `run-turns` record's). */
  turns?: number;
  classifier?: ClassifierRecord;
  work_order: string;
  traceparent: string;
}

/** What a caller gives; the log adds the time, the identity and the run file's fields. */
export type Entry = Pick<DecisionRecord, "event" | "decision" | "rule" | "reason"> &
  Partial<Pick<DecisionRecord, "tool" | "path" | "secret" | "cost_usd" | "turns" | "classifier">>;

export const LOG_FILE = "decisions.jsonl";

export class DecisionLog {
  readonly file: string;

  constructor(
    out: string,
    private readonly id: Identity,
    private readonly run: Pick<RunFile, "work_order" | "traceparent">,
    private readonly scrub: (value: unknown) => unknown,
  ) {
    this.file = join(out, LOG_FILE);
  }

  /** Append one record. Throws if it can't be written: the caller fails closed. */
  write(e: Entry): void {
    const record: DecisionRecord = {
      ts: new Date().toISOString(),
      run: this.id.run,
      node: this.id.node,
      attempt: this.id.attempt,
      event: e.event,
      decision: e.decision,
      rule: e.rule,
      reason: e.reason,
      ...(e.tool === undefined ? {} : { tool: e.tool }),
      ...(e.path === undefined ? {} : { path: e.path }),
      ...(e.secret === undefined ? {} : { secret: e.secret }),
      ...(e.cost_usd === undefined ? {} : { cost_usd: e.cost_usd }),
      ...(e.turns === undefined ? {} : { turns: e.turns }),
      ...(e.classifier === undefined ? {} : { classifier: e.classifier }),
      work_order: this.run.work_order,
      traceparent: this.run.traceparent,
    };
    mkdirSync(join(this.file, ".."), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(this.scrub(record))}\n`);
  }

  /** This run's records already in the log, read before this process writes its own; a torn or foreign line is skipped. */
  private earlier(): Partial<DecisionRecord>[] {
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: Partial<DecisionRecord>[] = [];
    for (const line of text.split("\n")) {
      try {
        const r = JSON.parse(line) as Partial<DecisionRecord> | null;
        if (r !== null && typeof r === "object" && r.run === this.id.run) out.push(r);
      } catch {
        // a torn or foreign line
      }
    }
    return out;
  }

  /** The attempts of this run that already logged a good session_start, read before this one writes its own. */
  startedAttempts(): Set<string> {
    const started = new Set<string>();
    for (const r of this.earlier()) if (r.event === "session_start" && r.decision === "allow" && typeof r.attempt === "string") started.add(r.attempt);
    return started;
  }

  /**
   * The highest run total (`cost_usd` of a `spend` or `run-budget` budget record, as src/run/spend.ts reads them) and
   * the highest turn count (`turns` of a budget record) this run's log already holds: where a new process's totals
   * start, so the log's totals never fall when a ledger file it can't read counts as 0.
   */
  highest(): { usd: number; turns: number } {
    let usd = 0;
    let turns = 0;
    for (const r of this.earlier()) {
      if (r.event !== "budget") continue;
      const cost = r.cost_usd;
      if ((r.rule === "spend" || r.rule === "run-budget") && typeof cost === "number" && Number.isFinite(cost) && cost > usd) usd = cost;
      const t = r.turns;
      if (typeof t === "number" && Number.isInteger(t) && t > turns) turns = t;
    }
    return { usd, turns };
  }
}
