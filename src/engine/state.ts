/**
 * A work order's state in the run engine (design §3.4, §3.6): the types the harvester (./harvest.ts), the state
 * machine and the poller share. Types only here; Plan 03 Task 13 adds the functions that read, write and move them.
 */

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
