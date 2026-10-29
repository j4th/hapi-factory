/** Rule 3: the run budget, summed across the run's Pi node attempts through a ledger in the tmpfs (design §6a item 6). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sessionSpendUsd } from "../../src/guard/budget";
import type { SessionEntry } from "../../src/guard/pi-api";
import { assistant, cleanupAll, gatesOff, RUN_ID, setup } from "./harness";

afterEach(cleanupAll);

const usage = (usd: number) => ({ cost: { total: usd } });
const HARD = (limit: string, spent: string) =>
  `hapi-guard: the run's budget of ${limit} is spent (${spent}); the node fails (budgets.enforcement.hapi_guard: hard)`;

test("the session's spend is Pi's getUsageCostBreakdown grouping, summed (core/usage-totals.js:41-78)", () => {
  const entries: SessionEntry[] = [
    assistant(0.5),
    { type: "message", message: { role: "user" } },
    { type: "usage", usage: usage(0.25) }, // a cache warm
    { type: "message", message: { role: "toolResult", usage: usage(0.125) } }, // a tool's own model call
    { type: "message", message: { role: "toolResult" } },
    { type: "compaction", usage: usage(0.0625) },
    { type: "branch_summary", usage: usage(0.03125) },
    { type: "compaction" },
    { type: "model_change" },
  ];
  expect(sessionSpendUsd(entries)).toBe(0.96875);
  expect(sessionSpendUsd([])).toBe(0);
});

describe("the limit is min(run.json budget_usd, hapi-guard.json budgets.run_usd)", () => {
  test("run.json lower", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 0.5) });
    await h.start();
    h.entries.push(assistant(0.625));
    await expect(h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).rejects.toThrow(HARD("$0.5", "$0.625"));
  });

  test("the policy lower", async () => {
    const h = setup({ settings: (s) => (gatesOff(s), (s.budgets.run_usd = 1)), run: (r) => (r.budget_usd = 5) });
    await h.start();
    h.entries.push(assistant(0.75));
    await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } });
    h.entries.push(assistant(0.25));
    await expect(h.fire("turn_end", { turnIndex: 1, message: { role: "assistant" } })).rejects.toThrow(HARD("$1", "$1"));
  });
});

describe("hard mode", () => {
  test("turn_end at or over the limit throws", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1) });
    await h.start();
    h.entries.push(assistant(0.75));
    expect(await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).toBeUndefined();
    h.entries.push(assistant(0.25));
    await expect(h.fire("turn_end", { turnIndex: 1, message: { role: "assistant" } })).rejects.toThrow(HARD("$1", "$1"));
    const r = h.log().at(-1);
    expect([r.event, r.decision, r.rule, r.cost_usd]).toEqual(["budget", "fail", "run-budget", 1]);
  });

  test("message_end counts the message before Pi persists it (agent-session.js:752-768)", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1) });
    await h.start();
    await expect(h.fire("message_end", { message: { role: "assistant", usage: usage(1.5) } })).rejects.toThrow(HARD("$1", "$1.5"));
  });

  test("before_provider_headers when already over throws before the request is sent, on every send", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 0.01) });
    await h.start();
    expect(await h.fire("before_provider_headers", { headers: {} })).toBeUndefined();
    h.entries.push(assistant(0.02));
    for (let retry = 0; retry < 3; retry++) {
      await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow(HARD("$0.01", "$0.02"));
    }
    expect(h.ledger().sends).toBe(4);
  });

  test("a zero budget refuses the first send", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 0) });
    await h.start();
    await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow(HARD("$0", "$0"));
  });
});

test("soft mode logs decision flag, once, and never throws", async () => {
  const h = setup({ settings: (s) => (gatesOff(s), (s.budgets.mode = "soft")), run: (r) => (r.budget_usd = 0.1) });
  await h.start();
  h.entries.push(assistant(0.2));
  expect(await h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).toBeUndefined();
  expect(await h.fire("before_provider_headers", { headers: {} })).toBeUndefined();
  expect(await h.fire("message_end", { message: { role: "assistant", usage: usage(1) } })).toBeUndefined();
  const flags = h.log().filter((r) => r.event === "budget");
  expect(flags.map((r) => [r.decision, r.rule, r.cost_usd])).toEqual([["flag", "run-budget", 0.2]]);
  expect(flags[0].reason).toBe("the run's budget of $0.1 is spent ($0.2); the run goes on and is flagged (budgets.enforcement.hapi_guard: soft)");
});

describe("the ledger", () => {
  test("the ledger is keyed by WORKFLOW_ID and node attempt, and a later attempt counts the earlier ones", async () => {
    const a = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1), attempt: "attempt-A" });
    await a.start();
    a.entries.push(assistant(0.5));
    await a.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } });
    expect(a.ledger()).toMatchObject({ run: RUN_ID, node: "work", attempt: "attempt-A", session: "session-attempt-A", session_usd: 0.5, classifier_usd: 0 });
    expect(existsSync(join(a.ledgerDir, RUN_ID, "attempt-A.session-attempt-A.json"))).toBe(true);

    const b = setup({ share: a, settings: gatesOff, run: (r) => (r.budget_usd = 1), attempt: "attempt-B" });
    await b.start();
    b.entries.push(assistant(0.25));
    expect(await b.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).toBeUndefined();
    b.entries.push(assistant(0.25));
    await expect(b.fire("turn_end", { turnIndex: 1, message: { role: "assistant" } })).rejects.toThrow(HARD("$1", "$1"));
    // Another run's ledger is not counted.
    const c = setup({ share: a, settings: gatesOff, run: (r) => (r.budget_usd = 1), attempt: "attempt-C", env: { WORKFLOW_ID: "wf-other" } });
    await c.start();
    c.entries.push(assistant(0.875));
    expect(await c.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).toBeUndefined();
  });

  test("an unparsable ledger counts as 0 and logs rule ledger-reset (the documented residual)", async () => {
    const a = setup({ settings: gatesOff });
    mkdirSync(join(a.ledgerDir, RUN_ID), { recursive: true });
    writeFileSync(join(a.ledgerDir, RUN_ID, "attempt-0.session-0.json"), "{ not json");
    await a.start();
    const log = a.log();
    expect(log[0].event).toBe("session_start");
    expect(log.slice(1).map((r) => [r.event, r.decision, r.rule, r.reason])).toEqual([
      ["budget", "flag", "ledger-reset", "the ledger file attempt-0.session-0.json can't be read, so its spend counts as 0"],
    ]);
  });

  test("a missing ledger of an attempt that started counts as 0 and logs rule ledger-reset", async () => {
    const a = setup({ settings: gatesOff, attempt: "attempt-A" });
    await a.start();
    rmSync(a.ledgerDir, { recursive: true });
    const b = setup({ share: a, settings: gatesOff, attempt: "attempt-B" });
    await b.start();
    const mine = b.log().filter((r) => r.attempt === "attempt-B");
    expect(mine.map((r) => [r.event, r.rule])).toEqual([["session_start", "session-start"], ["budget", "ledger-reset"]]);
    expect(mine[1].reason).toBe("attempt attempt-A of this run started but left no ledger, so its spend counts as 0");
    // The run's first attempt has nothing to miss.
    expect(a.log().filter((r) => r.attempt === "attempt-A").map((r) => r.rule)).toEqual(["session-start"]);
  });

  test("a later process of the same attempt and session carries its classifier cost forward", async () => {
    const a = setup({ settings: gatesOff, attempt: "attempt-A" });
    await a.start();
    const file = join(a.ledgerDir, RUN_ID, "attempt-A.session-attempt-A.json");
    writeFileSync(file, JSON.stringify({ ...a.ledger(), classifier_usd: 0.25 }));
    const again = setup({ share: a, settings: gatesOff, attempt: "attempt-A", run: (r) => (r.budget_usd = 0.375) });
    await again.start();
    again.entries.push(assistant(0.125));
    await expect(again.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).rejects.toThrow(HARD("$0.375", "$0.375"));
  });
});
