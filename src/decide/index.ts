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
 * another name; a key that isn't printable ASCII is "malformed", never echoed.
 * A state over `gates.max_state_chars` is not classified (the unseen tail could
 * hold the danger): the file's fallback comes back, marked `truncated`. Neither it nor any key is ever logged or put in `error`.
 *
 * It is bundled into hapi-guard (Task 5) and `hapi-decide.js` (Task 4), so
 * everything under src/decide/ must stay free of imports beyond `node:*` and
 * the two npm packages the bundle inlines.
 */
import type { Gates } from "../policy/types";
import { askHaiku, HaikuError } from "./haiku";
import { ContractError, JevClient } from "./vendor/ten-levels/client";
import { QuestionValidationError, type Answer, type Questions, type State } from "./vendor/ten-levels/types";

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
  /** true when the state was over `gates.max_state_chars`: nothing was sent and the file's fallback was returned. */
  truncated?: true;
  /** One line, no secret, no state text. */
  error?: string;
}

/** How many characters of state a classifier would be shown. */
function stateLength(state: State): number {
  return (typeof state === "string" ? state : JSON.stringify(state)).length;
}

/** A key must be printable ASCII with no whitespace: anything else can't be a header value and must never be echoed. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;

/** Why a key can't be used, naming its variable and never its value; undefined when it is usable. */
function keyProblem(name: string, key: string | undefined): string | undefined {
  if (!key) return `${name} is not set`;
  return KEY_SHAPE.test(key) ? undefined : `${name} is malformed`;
}

/** The Jev client's own failure for an HTTP status, e.g. "openrouter HTTP 503.". */
const JEV_HTTP = /^openrouter HTTP \d{3}\./;

/**
 * One safe line from a classifier's error. Only messages of the errors this code
 * knows are passed on; anything else (a fetch or header error may quote its
 * input) is reported by its name alone.
 */
function oneLine(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error";
  const first = (e.message.split("\n")[0] ?? "").slice(0, 200);
  if (e instanceof HaikuError || e instanceof ContractError || e instanceof QuestionValidationError) return first;
  return JEV_HTTP.exec(first)?.[0] ?? e.name;
}

export async function decide<V extends string>(
  file: DecisionFile<V>,
  state: State,
  o: DecideOptions,
): Promise<DecideResult<V>> {
  const started = performance.now();
  const latencyMs = () => Math.round(performance.now() - started);

  if (!o.mock && !o.jev.enabled && !o.haiku.enabled) {
    throw new Error(`decision ${file.name} has no classifier: turn the gate off in policy/gates.yaml instead`);
  }
  // Text past the cap would go unassessed yet could still get "allow", so an over-cap state is never classified.
  if (stateLength(state) > o.gates.max_state_chars) {
    return {
      verdict: file.fallback,
      via: "default",
      fallback: true,
      costUsd: 0,
      latencyMs: latencyMs(),
      truncated: true,
      error: `state is over max_state_chars (${o.gates.max_state_chars}) and was not classified`,
    };
  }
  const shown = state;

  if (o.mock) {
    const r = await new JevClient({ provider: "mock" }).systemOne(shown, file.questions);
    return { verdict: file.verdict(r.answers), via: "mock", fallback: false, costUsd: 0, latencyMs: latencyMs(), answers: r.answers };
  }

  const notes: string[] = [];
  const jevFirst = o.jev.enabled && o.jev.public;
  if (jevFirst) {
    const problem = keyProblem("HAPI_JEV_OPENROUTER_API_KEY", o.jev.apiKey);
    if (problem || !o.jev.apiKey) {
      notes.push(problem ?? "HAPI_JEV_OPENROUTER_API_KEY is not set");
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
    const problem = keyProblem("ANTHROPIC_API_KEY", o.haiku.apiKey);
    if (problem || !o.haiku.apiKey) {
      notes.push(problem ?? "ANTHROPIC_API_KEY is not set");
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
