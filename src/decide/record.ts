/**
 * The one wrapper every caller of `decide()` asks through, and the record of an answer: moved here from hapi-guard
 * (src/guard/gates.ts and src/guard/log.ts) unchanged but for being generic over a file's verdict, so the guard's
 * gates and the run engine's decisions (src/engine/decisions.ts) share one. The guard imports and re-exports them.
 *
 * - `ask` is `decide()` with a throw (a broken mock answer, a decision with no classifier) taken as the file's
 *   fallback, with `error: "decide failed"`, like any classifier failure.
 * - `classifierRecord` and `recordedAnswers` keep the answers as type and numbers only: never the state the
 *   classifier was shown, never a key.
 *
 * Like the rest of src/decide/, it imports only `node:*` and the packages the bundles inline.
 */
import { type DecideOptions, type DecideResult, type DecisionFile, decide, type State } from "./index";

/** One answer as recorded: its type and numbers only. */
export type RecordedAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };

export interface ClassifierRecord {
  /** The decision file's name. */
  decision: string;
  via: "jev" | "haiku" | "default" | "mock";
  fallback: boolean;
  latency_ms: number;
  cost_usd: number;
  answers?: Record<string, RecordedAnswer>;
  error?: string;
}

/** decide(), with a throw (a broken mock answer, say) taken as the file's fallback like any classifier failure. */
export async function ask<V extends string>(file: DecisionFile<V>, state: State, o: DecideOptions): Promise<DecideResult<V>> {
  const started = performance.now();
  try {
    return await decide(file, state, o);
  } catch {
    return { verdict: file.fallback, via: "default", fallback: true, costUsd: 0, latencyMs: Math.round(performance.now() - started), error: "decide failed" };
  }
}

/** The answers as recorded: type and numbers, nothing else. */
export function recordedAnswers(answers: DecideResult<string>["answers"]): Record<string, RecordedAnswer> | undefined {
  if (!answers) return undefined;
  return Object.fromEntries(
    Object.entries(answers).map(([id, a]): [string, RecordedAnswer] => [
      id,
      a.type === "noul"
        ? { type: "noul", noul: a.noul }
        : a.type === "choice"
          ? { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
          : { type: "score", score: a.score, probabilities: a.probabilities, confidence: a.confidence },
    ]),
  );
}

export function classifierRecord<V extends string>(file: DecisionFile<V>, r: DecideResult<V>): ClassifierRecord {
  const answers = recordedAnswers(r.answers);
  return {
    decision: file.name,
    via: r.via,
    fallback: r.fallback,
    latency_ms: r.latencyMs,
    cost_usd: r.costUsd,
    ...(answers ? { answers } : {}),
    ...(r.error === undefined ? {} : { error: r.error }),
  };
}
