/**
 * `decide()`: the one helper every typed decision goes through (spec §9.5).
 * A decision file (policy/decisions/*.ts) holds its questions, the careful
 * `fallback` verdict and the `verdict` function with its thresholds. `decide`
 * asks a classifier and applies the file's verdict to the answers:
 *
 *   1. Jev, via OpenRouter: only when the run is marked public (Jev is a
 *      third-party service, so a private repo's state never goes there);
 *   2. Haiku, via the Anthropic API;
 *   3. the file's `fallback` verdict, when no classifier answers.
 *
 * Keys are passed in by the caller from their own named variables
 * (HAPI_JEV_OPENROUTER_API_KEY, ANTHROPIC_API_KEY); nothing here reads the
 * environment. An unset key is an error in the result, never a lookup of
 * another name. The state is capped at `gates.max_state_chars` before it leaves,
 * and neither it nor any key is ever logged or put in `error`.
 *
 * It is bundled into hapi-guard (Task 5) and `hapi-decide.js` (Task 4), so
 * everything under src/decide/ must stay free of imports beyond `node:*` and
 * the two npm packages the bundle inlines.
 */
import type { Gates } from "../policy/types";
import { askHaiku } from "./haiku";
import { JevClient } from "./vendor/ten-levels/client";
import type { Answer, Questions, State } from "./vendor/ten-levels/types";

export type { Answer, Questions, State };
export type Answers = Record<string, Answer>;

export type Verdict = "allow" | "block" | "wrap" | "flag";

export interface DecisionFile<V extends string = Verdict> {
  /** A slug, equal to the file name. */
  readonly name: string;
  readonly questions: Questions;
  /** The careful verdict, used when no classifier answers. */
  readonly fallback: V;
  /** Thresholds live here, in code. */
  readonly verdict: (answers: Answers) => V;
}

export interface DecideOptions {
  gates: Gates;
  /** `enabled` is flags.jev.enabled; `public` is the run's public flag. */
  jev: { enabled: boolean; public: boolean; apiKey: string | undefined };
  /** `enabled` is flags.jev.fallback === "haiku". */
  haiku: { enabled: boolean; apiKey: string | undefined };
  /** Tests and `hapi decide --mock` only. */
  mock?: boolean;
  /** Tests inject; default globalThis.fetch. */
  fetch?: typeof fetch;
  /** Tests only: the Jev client's retry backoff base in ms (default 500). */
  retryDelayMs?: number;
}

export interface DecideResult<V extends string = Verdict> {
  verdict: V;
  via: "jev" | "haiku" | "default" | "mock";
  /** true when the answer did not come from the first-choice classifier. */
  fallback: boolean;
  costUsd: number;
  latencyMs: number;
  answers?: Answers;
  /** One line, no secret, no state text. */
  error?: string;
}

/** The state a classifier is shown: at most `max` characters (a structured state over the cap becomes capped text). */
function capState(state: State, max: number): State {
  if (typeof state === "string") return state.length > max ? state.slice(0, max) : state;
  const text = JSON.stringify(state);
  return text.length > max ? text.slice(0, max) : state;
}

/** One safe line from a classifier's error: the client's own messages name a status or a contract rule, never the state. */
function oneLine(e: unknown): string {
  const message = e instanceof Error ? e.message : "unknown error";
  return (message.split("\n")[0] ?? "").slice(0, 200);
}

export async function decide<V extends string>(
  file: DecisionFile<V>,
  state: State,
  o: DecideOptions,
): Promise<DecideResult<V>> {
  const started = performance.now();
  const latencyMs = () => Math.round(performance.now() - started);
  const shown = capState(state, o.gates.max_state_chars);

  if (o.mock) {
    const r = await new JevClient({ provider: "mock" }).systemOne(shown, file.questions);
    return { verdict: file.verdict(r.answers), via: "mock", fallback: false, costUsd: 0, latencyMs: latencyMs(), answers: r.answers };
  }
  if (!o.jev.enabled && !o.haiku.enabled) {
    throw new Error(`decision ${file.name} has no classifier: turn the gate off in policy/gates.yaml instead`);
  }

  const notes: string[] = [];
  const jevFirst = o.jev.enabled && o.jev.public;
  if (jevFirst) {
    if (!o.jev.apiKey) {
      notes.push("HAPI_JEV_OPENROUTER_API_KEY is not set");
    } else {
      try {
        const jev = new JevClient({
          provider: "openrouter",
          apiKey: o.jev.apiKey,
          model: o.gates.classifiers.jev.model,
          ...(o.retryDelayMs === undefined ? {} : { retryDelayMs: o.retryDelayMs }),
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        const r = await jev.systemOne(shown, file.questions);
        return {
          verdict: file.verdict(r.answers),
          via: "jev",
          fallback: false,
          costUsd: r.meta.cost.amount ?? o.gates.classifiers.jev.unknown_call_usd,
          latencyMs: latencyMs(),
          answers: r.answers,
        };
      } catch (e) {
        notes.push(`jev: ${oneLine(e)}`);
      }
    }
  } else if (o.jev.enabled && !o.haiku.enabled) {
    notes.push("jev answers public repos only and this run is not marked public");
  }

  if (o.haiku.enabled) {
    if (!o.haiku.apiKey) {
      notes.push("ANTHROPIC_API_KEY is not set");
    } else {
      try {
        const h = o.gates.classifiers.haiku;
        const r = await askHaiku(file.questions, shown, {
          apiKey: o.haiku.apiKey,
          model: h.model,
          ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        return {
          verdict: file.verdict(r.answers),
          via: "haiku",
          fallback: jevFirst,
          costUsd: (r.inputTokens / 1e6) * h.input_per_mtok + (r.outputTokens / 1e6) * h.output_per_mtok,
          latencyMs: latencyMs(),
          answers: r.answers,
          ...(notes.length ? { error: notes.join("; ") } : {}),
        };
      } catch (e) {
        notes.push(`haiku: ${oneLine(e)}`);
      }
    }
  }

  return { verdict: file.fallback, via: "default", fallback: true, costUsd: 0, latencyMs: latencyMs(), error: notes.join("; ") };
}
