/** Readers for the typed answers a decision file's verdict looks at. A missing or mistyped answer throws. */
import type { Answers } from "./index";

/** The yes-probability of a noul question. */
export function noulOf(answers: Answers, id: string): number {
  const a = answers[id];
  if (a?.type !== "noul") throw new Error(`no noul answer for '${id}'`);
  return a.noul;
}

/** The probability of one option of a choice or score question. */
export function probOf(answers: Answers, id: string, option: string): number {
  const a = answers[id];
  if (a === undefined || a.type === "noul") throw new Error(`no distribution for '${id}'`);
  const p = a.probabilities[option];
  if (p === undefined) throw new Error(`'${id}' has no option '${option}'`);
  return p;
}
