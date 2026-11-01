import { expect, test } from "bun:test";
import bashGate from "../../policy/decisions/bash-gate";
import resultScreen from "../../policy/decisions/result-screen";
import { KEY_PATTERNS } from "../../policy/decisions/write-gate";
import type { Answers } from "../../src/decide/index";

const bash = (irreversible: number, destructive: number): Answers => ({
  effect: { type: "choice", choice: "irreversible", probabilities: { read_only: 1 - irreversible, reversible: 0, irreversible }, confidence: 1 },
  destructive_intent: { type: "noul", noul: destructive },
});

test("the files' names are their slugs and their fallbacks are the careful verdicts", () => {
  expect(bashGate.name).toBe("bash-gate");
  expect(bashGate.fallback).toBe("block");
  expect(resultScreen.name).toBe("result-screen");
  expect(resultScreen.fallback).toBe("wrap");
});

test("bash-gate: block at the bars, flag at the floors, else allow", () => {
  const v = bashGate.verdict;
  expect(v(bash(0.6, 0))).toBe("block");
  expect(v(bash(0, 0.7))).toBe("block");
  expect(v(bash(0.59, 0.69))).toBe("flag");
  expect(v(bash(0.4, 0))).toBe("flag");
  expect(v(bash(0, 0.5))).toBe("flag");
  expect(v(bash(0.39, 0.49))).toBe("allow");
});

test("result-screen: wrap at 0.7, flag at 0.5, else allow", () => {
  const a = (n: number): Answers => ({ injection: { type: "noul", noul: n } });
  expect(resultScreen.verdict(a(0.7))).toBe("wrap");
  expect(resultScreen.verdict(a(0.69))).toBe("flag");
  expect(resultScreen.verdict(a(0.5))).toBe("flag");
  expect(resultScreen.verdict(a(0.49))).toBe("allow");
});

test("a decision whose answer is missing is an error, not a quiet allow", () => {
  expect(() => resultScreen.verdict({})).toThrow();
  expect(() => bashGate.verdict({ destructive_intent: { type: "noul", noul: 0 } })).toThrow();
});

/** Samples are built at run time so no key-shaped literal sits in the source. */
const hex = (n: number) => "0123456789abcdef".repeat(8).slice(0, n);
const samples: Record<string, string> = {
  anthropic: ["sk", "ant", "x".repeat(24)].join("-"),
  openrouter: ["sk", "or", "v1", hex(64)].join("-"),
  "github-token": "ghp_" + "a".repeat(36),
  "github-pat": "github" + "_pat_" + "A".repeat(60),
  slack: ["xoxb", "1234567890", "abcdef"].join("-"),
  "aws-key-id": "AKIA" + "ABCDEFGHIJKLMNOP",
  "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "age-key": "AGE-SECRET-KEY-1" + "Q".repeat(58),
};

test("KEY_PATTERNS: each pattern, by name, matches its sample and none of the others' misses", () => {
  expect(KEY_PATTERNS.map((p) => p.name)).toEqual(Object.keys(samples));
  for (const { name, re } of KEY_PATTERNS) {
    expect(re.test(samples[name]!), name).toBe(true);
    expect(re.test("an ordinary line of source code, sk-learn and a ghost_story"), name).toBe(false);
  }
});

test("KEY_PATTERNS are not global (no lastIndex state between calls)", () => {
  for (const { re } of KEY_PATTERNS) expect(re.global || re.sticky).toBe(false);
});
