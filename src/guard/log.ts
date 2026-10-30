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
 * A record names a secret, never its value: every string in it is scrubbed of
 * the exact values rule 6 knows, and of KEY_PATTERNS' key formats, before it is
 * written. A classifier record holds
 * its answers (probabilities and confidence), never the state it was shown.
 * OTel spans come later with the observability profile; the fields are theirs.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFile } from "../generate/archon";
import type { Identity } from "./config";

export type GuardEvent = "session_start" | "tool_call" | "tool_result" | "provider_request" | "budget" | "gate";
export type GuardDecision = "allow" | "block" | "wrap" | "flag" | "fail";

/** One answer as recorded: its type and numbers only. */
export type RecordedAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface ClassifierRecord {
  /** The decision file's name. */
  decision: string;
  via: string;
  fallback: boolean;
  latency_ms: number;
  cost_usd: number;
  answers?: Record<string, RecordedAnswer>;
  error?: string;
}

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
  classifier?: ClassifierRecord;
  work_order: string;
  traceparent: string;
}

/** What a caller gives; the log adds the time, the identity and the run file's fields. */
export type Entry = Pick<DecisionRecord, "event" | "decision" | "rule" | "reason"> &
  Partial<Pick<DecisionRecord, "tool" | "path" | "secret" | "cost_usd" | "classifier">>;

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
      ...(e.classifier === undefined ? {} : { classifier: e.classifier }),
      work_order: this.run.work_order,
      traceparent: this.run.traceparent,
    };
    mkdirSync(join(this.file, ".."), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(this.scrub(record))}\n`);
  }

  /** The attempts of this run that already logged a good session_start, read before this one writes its own. */
  startedAttempts(): Set<string> {
    const started = new Set<string>();
    let text = "";
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return started;
    }
    for (const line of text.split("\n")) {
      try {
        const r = JSON.parse(line) as Partial<DecisionRecord>;
        if (r.event === "session_start" && r.decision === "allow" && r.run === this.id.run && typeof r.attempt === "string") started.add(r.attempt);
      } catch {
        // a torn or foreign line
      }
    }
    return started;
  }
}
