/**
 * TypeSafe System One API types — the exact wire contract for Jev.
 *
 * One endpoint: POST https://api.typesafe.ai/v1/systemone
 * You send a `state` and a map of typed `questions`; you get back one typed
 * `answer` per question, keyed by the IDs you chose.
 */

/** The content being evaluated. A plain string, or structured data. */
export type State = string | Record<string, unknown> | unknown[];

/**
 * What to ask about the state. Can be a plain string, or a structured object
 * that puts the question in one field and the data it refers to in others.
 */
export type Instructions = string | Record<string, unknown>;

/** Optional clarification of what yes and no mean. */
export interface NoulCriteria {
  true?: string;
  false?: string;
}

/** A map of option -> rubric description. Use null when an option needs no detail. Max 255 options. */
export type ChoiceCriteria = Record<string, string | null>;

/** An ordered array of level descriptions, low to high. 2-10 levels. */
export type ScoreCriteria = string[];

export interface NoulQuestion {
  type: "noul";
  instructions: Instructions;
  criteria?: NoulCriteria;
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: Instructions;
  criteria: ChoiceCriteria;
}

export interface ScoreQuestion {
  type: "score";
  instructions: Instructions;
  criteria: ScoreCriteria;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Question IDs are for your code. They are not sent to the model and are not used in inference. */
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** The probability the answer is yes. 0 = strong no, 1 = strong yes, 0.5 = uncertain. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  /** The highest-probability option. Always one you defined. */
  choice: string;
  /** Every option mapped to its probability. Floats that sum to 1. */
  probabilities: Record<string, number>;
  /** How certain the model is, derived from the shape of the distribution. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted position along the levels. Can land between levels. */
  score: number;
  /** Each level number mapped back to its description. */
  legend: Record<string, string>;
  /** Each level mapped to its probability. Floats that sum to 1. */
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SystemOneRequest {
  /** Defaults to "jev-latest". */
  model?: string;
  state: State;
  questions: Questions;
}

export interface SystemOneUsage {
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported USD cost. Only finite, nonnegative numbers are trusted. */
  cost?: unknown;
  [key: string]: unknown;
}

export interface SystemOneResponse {
  /** The versioned model that answered. Log it. */
  model: string;
  answers: Record<string, Answer>;
  usage: SystemOneUsage;
  /** Provider extensions are retained, not stripped during validation. */
  [key: string]: unknown;
}

/** Client-side validation limits, mirrored from the published API. */
export const LIMITS = {
  MAX_CHOICE_OPTIONS: 255,
  MIN_SCORE_LEVELS: 2,
  MAX_SCORE_LEVELS: 10,
  /** Approximate shared token budget for state + all questions. */
  TOTAL_TOKEN_BUDGET: 64_000,
} as const;

export class QuestionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Validate runtime input as well as TypeScript callers, before any transport. */
export function validateRequest(request: unknown): asserts request is SystemOneRequest {
  if (!isRecord(request)) throw new QuestionValidationError("Expected a request object.");
  if (typeof request.state !== "string" && !isRecord(request.state) && !Array.isArray(request.state)) {
    throw new QuestionValidationError("State must be a string, object, or array.");
  }
  if (request.model !== undefined && (typeof request.model !== "string" || !request.model.trim())) {
    throw new QuestionValidationError("Model must be a nonblank string.");
  }
  validateQuestions(request.questions);
}

/** Validate a request's question shapes before it is ever sent. */
export function validateQuestions(questions: unknown): asserts questions is Questions {
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new QuestionValidationError("Questions must be a nonempty object.");
  }
  for (const [id, q] of Object.entries(questions)) {
    if (!isRecord(q)) throw new QuestionValidationError(`Question "${id}" must be an object.`);
    if (q.type !== "noul" && q.type !== "choice" && q.type !== "score") {
      throw new QuestionValidationError(`Question "${id}" has a missing or unknown type.`);
    }
    if (typeof q.instructions === "string" ? !q.instructions.trim() : !isRecord(q.instructions)) {
      throw new QuestionValidationError(`Question "${id}" needs nonblank string or object instructions.`);
    }
    if (q.type === "noul" && q.criteria !== undefined) {
      if (!isRecord(q.criteria) || Object.entries(q.criteria).some(
        ([key, value]) => !["true", "false"].includes(key) || (value !== undefined && typeof value !== "string")
      )) {
        throw new QuestionValidationError(`Noul "${id}" criteria must map true/false to descriptions.`);
      }
    }
    if (q.type === "choice") {
      if (!isRecord(q.criteria)) {
        throw new QuestionValidationError(`Choice "${id}" criteria must be an object.`);
      }
      const options = Object.keys(q.criteria);
      if (options.length === 0) {
        throw new QuestionValidationError(`Choice "${id}" has no options.`);
      }
      if (options.length > LIMITS.MAX_CHOICE_OPTIONS) {
        throw new QuestionValidationError(
          `Choice "${id}" has ${options.length} options; the maximum is ${LIMITS.MAX_CHOICE_OPTIONS}.`
        );
      }
      if (Object.values(q.criteria).some((value) => value !== null && typeof value !== "string")) {
        throw new QuestionValidationError(`Choice "${id}" descriptions must be strings or null.`);
      }
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria)) {
        throw new QuestionValidationError(`Score "${id}" criteria must be an array.`);
      }
      if (q.criteria.length < LIMITS.MIN_SCORE_LEVELS || q.criteria.length > LIMITS.MAX_SCORE_LEVELS) {
        throw new QuestionValidationError(
          `Score "${id}" must have between ${LIMITS.MIN_SCORE_LEVELS} and ${LIMITS.MAX_SCORE_LEVELS} levels; got ${q.criteria.length}.`
        );
      }
      if (q.criteria.some((level) => typeof level !== "string" || !level.trim())) {
        throw new QuestionValidationError(`Score "${id}" levels must be nonblank strings.`);
      }
    }
  }
}
