/**
 * A run's spend and turns, from its copied-out files (src/run/spend.ts; H-229): the guard's ledger first, then
 * Archon's own total, and otherwise the run's whole budget, marked unknown, so a cap never counts a run as free.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spendOfRun, turnsOfRun } from "../../src/run/spend";
import { cleanup, tempDir } from "../secrets/helpers";

afterEach(cleanup);

/** An out dir holding `files`. */
function outDir(files: Record<string, string>): string {
  const dir = join(tempDir("hapi-spend-"), "out");
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const spend = (cost: unknown, rule = "spend", extra: Record<string, unknown> = {}) => JSON.stringify({ event: "budget", decision: "allow", rule, reason: "the run's spend so far", cost_usd: cost, ...extra });
const result = (total: unknown) => JSON.stringify({ run: { status: "completed", metadata: { total_cost_usd: total } } });

test("spendOfRun takes the guard's last spend record, then Archon's total_cost_usd, and otherwise counts the run at its full budget, unknown (H-229)", () => {
  // The guard's last spend record wins over Archon's total, and a line that isn't JSON is skipped.
  const both = outDir({ "decisions.jsonl": [spend(0.1), spend(0.25), "{not json", ""].join("\n"), "result.json": result(0.5) });
  expect(spendOfRun(both, 3)).toEqual({ usd: 0.25, known: true });
  // A hard stop's run-budget record carries the run's total too.
  const stopped = outDir({ "decisions.jsonl": [spend(0.9), JSON.stringify({ event: "budget", decision: "fail", rule: "run-budget", cost_usd: 1 })].join("\n") });
  expect(spendOfRun(stopped, 3)).toEqual({ usd: 1, known: true });
  // No decisions: Archon's.
  expect(spendOfRun(outDir({ "result.json": result(0.5) }), 3)).toEqual({ usd: 0.5, known: true });
  // Neither, or neither a spend that can be counted: the run's whole budget, unknown.
  expect(spendOfRun(outDir({}), 3)).toEqual({ usd: 3, known: false });
  expect(spendOfRun(join(tempDir("hapi-spend-"), "no-out"), 3)).toEqual({ usd: 3, known: false });
  expect(spendOfRun(outDir({ "decisions.jsonl": spend(-1), "result.json": result("x") }), 3)).toEqual({ usd: 3, known: false });
  // A record of another event or rule, or one whose cost isn't a finite number, is no spend record.
  const others = [
    JSON.stringify({ event: "tool_call", rule: "spend", cost_usd: 0.7 }),
    spend(0.7, "session"),
    spend("0.7"),
    spend(Number.POSITIVE_INFINITY),
    "[0.7]",
    "null",
  ].join("\n");
  expect(spendOfRun(outDir({ "decisions.jsonl": others, "result.json": result(-0.5) }), 0)).toEqual({ usd: 0, known: false });
  // A verify run's budget is 0 (Task 13), and its spend is unknown at 0.
  expect(spendOfRun(outDir({}), 0)).toEqual({ usd: 0, known: false });
});

test("turnsOfRun reads the last spend record's turns, never a count of records (m20)", async () => {
  const records = [
    spend(0.1, "spend", { turns: 1 }),
    spend(0.2, "spend", { turns: 2 }),
    // The pre-stop spend record a hard stop writes repeats the turns; the fail record after it has none.
    spend(0.2, "spend", { turns: 2 }),
    JSON.stringify({ event: "budget", decision: "fail", rule: "run-budget", cost_usd: 0.2 }),
  ];
  expect(await turnsOfRun(outDir({ "decisions.jsonl": records.join("\n") }))).toBe(2);
  expect(await turnsOfRun(outDir({ "decisions.jsonl": spend(0, "spend", { turns: 0 }) }))).toBe(0);
  // No spend record, no decisions, or a last spend record whose turns isn't a whole number of at least 0.
  expect(await turnsOfRun(outDir({ "decisions.jsonl": JSON.stringify({ event: "session_start" }) }))).toBeUndefined();
  expect(await turnsOfRun(outDir({}))).toBeUndefined();
  for (const turns of [-1, 1.5, "2", undefined]) {
    expect([turns, await turnsOfRun(outDir({ "decisions.jsonl": [spend(0.1, "spend", { turns: 1 }), spend(0.2, "spend", { turns })].join("\n") }))]).toEqual([turns, undefined]);
  }
});
