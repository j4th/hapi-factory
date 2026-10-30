/**
 * Question builders, matching the @typesafe-ai/sdk helper style.
 * Answer types are inferred from the question you build.
 */
import type {
  ChoiceAnswer,
  ChoiceCriteria,
  ChoiceQuestion,
  Instructions,
  NoulAnswer,
  NoulCriteria,
  NoulQuestion,
  Question,
  ScoreAnswer,
  ScoreCriteria,
  ScoreQuestion,
} from "./types.ts";

export function noul(instructions: Instructions, criteria?: NoulCriteria): NoulQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

export function choice(instructions: Instructions, criteria: ChoiceCriteria): ChoiceQuestion {
  return { type: "choice", instructions, criteria };
}

export function score(instructions: Instructions, criteria: ScoreCriteria): ScoreQuestion {
  return { type: "score", instructions, criteria };
}

/** Infer the answer type a question returns. */
export type AnswerOf<Q> =
  Q extends NoulQuestion ? NoulAnswer :
  Q extends ChoiceQuestion ? ChoiceAnswer :
  Q extends ScoreQuestion ? ScoreAnswer :
  never;

/** Typed question map -> typed answer map. */
export type AnswersOf<Q extends Record<string, Question>> = {
  [K in keyof Q]: AnswerOf<Q[K]>;
};
