/**
 * The turn budget (design §3.5 "Every phase and round is a knob", §3.9): run.json's `turns`, enforced as `run_usd`
 * is (`budgets.enforcement.hapi_guard`), counted across the run's attempts through the ledger. A missing or bad
 * `turns` fails the node closed (the Global Constraints' Limits rule; ruling m48(2)).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAll, gatesOff, RUN_ID, setup } from "./harness";

afterEach(cleanupAll);

type H = ReturnType<typeof setup>;
const turn = (h: H, i: number, stopReason = "toolUse") =>
  h.fire("turn_end", { turnIndex: i, message: { role: "assistant", stopReason, content: stopReason === "toolUse" ? [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: {} }] : [{ type: "text", text: "RESULT: done" }] } });
const HARD = (n: number, used: string) => `hapi-guard: the run's turn budget of ${n} is spent (${used}); the node fails (budgets.enforcement.hapi_guard: hard)`;
const rec = (r: any) => [r.event, r.decision, r.rule];

test("the turn budget is run.json's turns, counted across the run's attempts in the ledger", async () => {
  const a = setup({ settings: gatesOff, run: (r) => (r.turns = 2), attempt: "attempt-A" });
  await a.start();
  expect(await turn(a, 0)).toBeUndefined();
  await expect(turn(a, 1)).rejects.toThrow(HARD(2, "2 turns"));
  const log = a.log();
  expect(rec(log.at(-1))).toEqual(["budget", "fail", "run-turns"]);
  expect([log.at(-1).reason, log.at(-1).turns]).toEqual(["the run's turn budget of 2 is spent (2 turns); the node fails", 2]);
  // The spend record of that turn comes first, and counts it.
  expect([log.at(-2).rule, log.at(-2).turns]).toEqual(["spend", 2]);

  // A later attempt of the run counts the earlier one's turns: it is stopped at its first turn that isn't the last.
  const b = setup({ share: a, settings: gatesOff, run: (r) => (r.turns = 2), attempt: "attempt-B" });
  await b.start();
  await expect(turn(b, 0)).rejects.toThrow(HARD(2, "3 turns"));
});

test("the turn that ends the session never fails on turns", async () => {
  const h = setup({ settings: gatesOff, run: (r) => (r.turns = 1) });
  await h.start();
  expect(await turn(h, 0, "stop")).toBeUndefined();
  expect(h.log().filter((r) => r.event === "result").map(rec)).toEqual([["result", "done", "result"]]);
  // One turn that isn't the last is the budget of 1 spent: "1 turn", singular.
  const one = setup({ settings: gatesOff, run: (r) => (r.turns = 1) });
  await one.start();
  await expect(turn(one, 0)).rejects.toThrow(HARD(1, "1 turn"));
});

test("soft mode flags turns once and goes on", async () => {
  const h = setup({ settings: (s) => (gatesOff(s), (s.budgets.mode = "soft")), run: (r) => (r.turns = 2) });
  await h.start();
  for (let i = 0; i < 4; i++) expect(await turn(h, i)).toBeUndefined();
  const flags = h.log().filter((r) => r.rule === "run-turns");
  expect(flags.map((r) => [r.event, r.decision, r.rule, r.turns])).toEqual([["budget", "flag", "run-turns", 2]]);
  expect(flags[0].reason).toBe("the run's turn budget of 2 is spent (2 turns); the run goes on and is flagged (budgets.enforcement.hapi_guard: soft)");
  expect(await h.tool("ls", { path: "." })).toBeUndefined();
});

test("after a turn stop, a tool call is blocked as run-turns, without touching the stale ctx", async () => {
  const h = setup({ settings: gatesOff, run: (r) => (r.turns = 2) });
  await h.start();
  await turn(h, 0);
  await expect(turn(h, 1)).rejects.toThrow(HARD(2, "2 turns"));
  const stale = () => {
    throw new Error("This extension ctx is stale after session replacement or reload");
  };
  h.ctx.sessionManager.getEntries = stale;
  Object.defineProperty(h.ctx, "cwd", { get: stale });
  expect(await h.tool("bash", { command: "ls" })).toEqual({
    block: true,
    reason: "hapi-guard: the run's turn budget of 2 is spent (2 turns); no more tool calls (rule run-turns)",
  });
  // Every hook after the stop throws the stop again, before it reads the ctx.
  await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow(HARD(2, "2 turns"));
  await expect(h.fire("message_end", { message: { role: "assistant" } })).rejects.toThrow(HARD(2, "2 turns"));
  await expect(turn(h, 2)).rejects.toThrow(HARD(2, "2 turns"));
  expect(h.log().filter((r) => r.rule === "error")).toEqual([]);
});

describe("run.json's turns", () => {
  test("a run.json without turns fails closed (a limit has no fail-open default)", async () => {
    const h = setup({ run: (r) => delete r.turns });
    expect([...h.pi.handlers.keys()]).toEqual(["session_start"]);
    await expect(h.start()).rejects.toThrow(`hapi-guard: ${h.runFile}: turns must be a whole number of at least 1; the node fails closed`);
  });

  test("a turns that isn't a whole number of at least 1 fails closed", async () => {
    for (const turns of [0, -1, 1.5, "3", null, Number.POSITIVE_INFINITY]) {
      const h = setup({ run: (r) => (r.turns = turns) });
      await expect(h.start()).rejects.toThrow(`hapi-guard: ${h.runFile}: turns must be a whole number of at least 1; the node fails closed`);
    }
  });
});

test("the ledger carries turns", async () => {
  const a = setup({ settings: gatesOff, attempt: "attempt-A" });
  await a.start();
  expect(a.ledger().turns).toBe(0);
  await turn(a, 0);
  expect(a.ledger().turns).toBe(1);

  // An older file without turns counts as 0.
  const dir = join(a.ledgerDir, RUN_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "attempt-0.session-0.json"), JSON.stringify({ run: RUN_ID, node: "work", attempt: "attempt-0", session: "session-0", session_usd: 0, classifier_usd: 0, sends: 1, updated: "x" }));
  const b = setup({ share: a, settings: gatesOff, attempt: "attempt-B" });
  await b.start();
  await turn(b, 0);
  expect(b.log().filter((r) => r.rule === "spend").at(-1).turns).toBe(2);

  // A later process of the same attempt and session carries its turns forward.
  const again = setup({ share: a, settings: gatesOff, attempt: "attempt-A" });
  await again.start();
  expect(again.ledger().turns).toBe(1);
  await turn(again, 1);
  expect(again.ledger().turns).toBe(2);
});
