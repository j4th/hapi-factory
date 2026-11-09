/** Rule 3: the run budget, summed across the run's Pi node attempts through a ledger in the tmpfs (design §6a item 6). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sessionSpendUsd } from "../../src/guard/budget";
import type { SessionEntry } from "../../src/guard/pi-api";
import { spendOfRun } from "../../src/run/spend";
import { assistant, cleanupAll, gatesOff, RUN_ID, setup } from "./harness";

afterEach(cleanupAll);

const usage = (usd: number) => ({ cost: { total: usd } });
const HARD = (limit: string, spent: string) =>
  `hapi-guard: the run's budget of ${limit} is spent (${spent}); the node fails (budgets.enforcement.hapi_guard: hard)`;
/** A budget record as Task 7's readers see it. */
const spendOf = (r: any) => [r.event, r.decision, r.rule, r.cost_usd, r.turns];
/** A turn that isn't the session's last. */
const turnEnd = (h: ReturnType<typeof setup>, i: number) => h.fire("turn_end", { turnIndex: i, message: { role: "assistant", stopReason: "toolUse" } });

describe("the spend record (H-229, S14)", () => {
  test("a spend record with the run's total and the ledger's turns is written at every turn_end", async () => {
    const a = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1), attempt: "attempt-A" });
    await a.start();
    a.entries.push(assistant(0.25));
    await turnEnd(a, 0);
    expect(spendOf(a.log().at(-1))).toEqual(["budget", "allow", "spend", 0.25, 1]);
    expect(a.log().at(-1).reason).toBe("the run's spend so far");
    const b = setup({ share: a, settings: gatesOff, run: (r) => (r.budget_usd = 1), attempt: "attempt-B" });
    await b.start();
    b.entries.push(assistant(0.25));
    await turnEnd(b, 0);
    expect(spendOf(b.log().at(-1))).toEqual(["budget", "allow", "spend", 0.5, 2]);
    expect(a.log().filter((r) => r.rule === "spend").map(spendOf)).toEqual([
      ["budget", "allow", "spend", 0.25, 1],
      ["budget", "allow", "spend", 0.5, 2],
    ]);
  });

  test("the spend record comes right before a hard stop's fail record, and its turns never counts it", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1) });
    await h.start();
    h.entries.push(assistant(0.75));
    await turnEnd(h, 0);
    h.entries.push(assistant(0.25));
    await expect(turnEnd(h, 1)).rejects.toThrow(HARD("$1", "$1"));
    expect(h.log().slice(-2).map(spendOf)).toEqual([
      ["budget", "allow", "spend", 1, 2],
      ["budget", "fail", "run-budget", 1, undefined],
    ]);
    // One spend record per turn_end, the stopping one included.
    expect(h.log().filter((r) => r.rule === "spend").length).toBe(2);

    // At the limit on a message_end, before any turn_end: one spend record, and 0 turns.
    const m = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1) });
    await m.start();
    await expect(m.fire("message_end", { message: { role: "assistant", usage: usage(1.5) } })).rejects.toThrow(HARD("$1", "$1.5"));
    expect(m.log().slice(-2).map(spendOf)).toEqual([
      ["budget", "allow", "spend", 1.5, 0],
      ["budget", "fail", "run-budget", 1.5, undefined],
    ]);
    expect(m.log().filter((r) => r.rule === "spend").length).toBe(1);
  });

  test("the guard's totals never fall: a sequence of turns, ledger resets and a soft flag, across attempts (Task 7's spendOfRun)", async () => {
    const soft = (s: any) => (gatesOff(s), (s.budgets.mode = "soft"));
    const a = setup({ settings: soft, run: (r) => (r.budget_usd = 1), attempt: "attempt-A" });
    await a.start();
    a.entries.push(assistant(0.25));
    await turnEnd(a, 0);
    // A soft flag that counts a message's usage before Pi persists it; the message is then never persisted.
    expect(await a.fire("message_end", { message: { role: "assistant", usage: usage(1) } })).toBeUndefined();
    await turnEnd(a, 1);
    a.entries.push(assistant(0.125));
    await turnEnd(a, 2);

    // A ledger reset between attempts: attempt A's file can't be read, so its spend counts as 0.
    const dir = join(a.ledgerDir, RUN_ID);
    writeFileSync(join(dir, "attempt-A.session-attempt-A.json"), "{ not json");
    const b = setup({ share: a, settings: soft, run: (r) => (r.budget_usd = 1), attempt: "attempt-B" });
    await b.start();
    b.entries.push(assistant(0.5));
    await turnEnd(b, 0);

    // A ledger reset mid-attempt: attempt B's file goes while C runs.
    const c = setup({ share: a, settings: soft, run: (r) => (r.budget_usd = 1), attempt: "attempt-C" });
    await c.start();
    rmSync(join(dir, "attempt-B.session-attempt-B.json"));
    c.entries.push(assistant(0.125));
    await turnEnd(c, 0);
    c.entries.push(assistant(0.25));
    await turnEnd(c, 1);

    const totals = a.log().filter((r) => r.event === "budget" && (r.rule === "spend" || r.rule === "run-budget")).map((r) => r.cost_usd);
    // A: 0.25, the flag with the unpersisted 1, which stays counted, then 0.125 more. B starts from the log's highest
    // total, since A's ledger can't be read. C keeps B's spend after B's file goes. B and C each flag once.
    expect(totals).toEqual([0.25, 1.25, 1.25, 1.375, 1.875, 1.875, 2, 2, 2.25]);
    expect(totals.every((t, i) => i === 0 || t >= totals[i - 1])).toBe(true);
    // A's reset is logged at B's session_start and at C's (the file, and the attempt it leaves without a ledger); B's
    // file going under C is logged when C next reads the ledger.
    const lost = "attempt attempt-A of this run started but left no ledger, so its spend counts as 0";
    const unreadable = "the ledger file attempt-A.session-attempt-A.json can't be read, so its spend counts as 0";
    expect(a.log().filter((r) => r.rule === "ledger-reset").map((r) => [r.attempt, r.reason])).toEqual([
      ["attempt-B", unreadable],
      ["attempt-B", lost],
      ["attempt-C", unreadable],
      ["attempt-C", lost],
      ["attempt-C", "the ledger file attempt-B.session-attempt-B.json can't be read, so its spend counts at the $0.5 last read from it"],
    ]);
    expect(spendOfRun(a.out, 1)).toEqual({ usd: 2.25, known: true });
    // The turns never fall either: A took three, B one, C two.
    expect(a.log().filter((r) => r.rule === "spend").map((r) => r.turns)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("H-230: a hard stop is final", () => {
  test("after a hard stop, a tool call is blocked as run-budget without touching the stale ctx", async () => {
    const h = setup({ settings: gatesOff, run: (r) => (r.budget_usd = 1) });
    await h.start();
    await expect(h.fire("message_end", { message: { role: "assistant", usage: usage(1.5) } })).rejects.toThrow(HARD("$1", "$1.5"));
    const stale = () => {
      throw new Error("This extension ctx is stale after session replacement or reload");
    };
    h.ctx.sessionManager.getEntries = stale;
    Object.defineProperty(h.ctx, "cwd", { get: stale });
    expect(await h.tool("bash", { command: "ls" })).toEqual({
      block: true,
      reason: "hapi-guard: the run's budget of $1 is spent ($1.5); no more tool calls (rule run-budget)",
    });
    expect(h.log().filter((r) => r.rule === "error")).toEqual([]);
    expect(h.log().at(-1)).toMatchObject({ event: "tool_call", decision: "block", rule: "run-budget", tool: "bash" });
  });
});

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
  const flags = h.log().filter((r) => r.rule === "run-budget");
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
