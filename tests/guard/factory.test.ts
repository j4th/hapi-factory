/** The factory and the decision log (design §6a items 6-8; Review Focus 6). */
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import hapiGuard from "../../src/guard/index";
import { cleanupAll, FakePi, gatesOff, RUN_ID, setup } from "./harness";

afterEach(cleanupAll);

test("bad settings fail the node at session_start, before any request (Review Focus 6)", async () => {
  const h = setup({ settingsText: "[]" });
  expect([...h.pi.handlers.keys()]).toEqual(["session_start"]);
  await expect(h.start()).rejects.toThrow(/^hapi-guard: .*hapi-guard\.json: must be an object; the node fails closed$/);
});

test("the factory never throws: a Pi whose on() throws, or a broken env, still returns (a throw would leave the node unguarded)", () => {
  const throwing = { on: () => { throw new Error("boom"); }, registerTool() {}, registerFlag() {} };
  expect(() => hapiGuard(throwing as any)).not.toThrow();
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/nonexistent/hapi-guard-test";
    const pi = new FakePi();
    expect(() => hapiGuard(pi as any)).not.toThrow();
    expect([...pi.handlers.keys()]).toEqual(["session_start"]);
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
});

test("good settings register exactly the guard's hooks; no tool or flag is registered", () => {
  const h = setup({ settings: gatesOff });
  expect([...h.pi.handlers.keys()].sort()).toEqual(
    ["before_provider_headers", "before_provider_request", "message_end", "session_start", "tool_call", "tool_result", "turn_end"],
  );
  expect(h.pi.registered).toEqual([]);
});

test("the first record of each attempt is session_start, carrying the join keys Task 7 checks", async () => {
  const a = setup({ settings: gatesOff, attempt: "attempt-A" });
  await a.start();
  await a.tool("write", { path: "AGENTS.md", content: "x" });
  const b = setup({ share: a, settings: gatesOff, attempt: "attempt-B" });
  await b.tool("bash", { command: "ls" }); // even a call before session_start can't come first: it is refused
  await b.start();
  await b.tool("read", { path: "README.md" });
  const log = a.log();
  for (const attempt of ["attempt-A", "attempt-B"]) {
    const mine = log.filter((r) => r.attempt === attempt);
    expect([attempt, mine[0].event]).toEqual([attempt, "session_start"]);
  }
  expect(log[0]).toEqual({
    ts: log[0].ts,
    run: RUN_ID,
    node: "work",
    attempt: "attempt-A",
    event: "session_start",
    decision: "allow",
    rule: "session-start",
    reason: "the model, Pi's agent dir and the worktree match hapi's settings",
    work_order: "WO-0001",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  });
  expect(new Date(log[0].ts).toISOString()).toBe(log[0].ts);
});

test("a tool call before session_start is blocked, and logs nothing", async () => {
  const h = setup({ settings: gatesOff });
  expect(await h.tool("bash", { command: "ls" })).toEqual({ block: true, reason: "hapi-guard: session_start has not run, so no tool call is allowed (rule session-start)" });
  expect(h.log()).toEqual([]);
});

test("the log is written synchronously, record by record: nothing waits for session_shutdown", async () => {
  const h = setup({ settings: gatesOff });
  expect(h.pi.handlers.has("session_shutdown")).toBe(false);
  await h.start();
  const lines = () => readFileSync(join(h.out, "decisions.jsonl"), "utf8").trimEnd().split("\n").length;
  expect(lines()).toBe(1);
  await h.tool("write", { path: "AGENTS.md", content: "x" });
  expect(lines()).toBe(2);
  await h.tool("ls", { path: "." });
  expect(lines()).toBe(3);
});

test("an unknown tool is blocked: Pi's __pi_deferred_placeholder__ is never a real capability", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  expect(await h.tool("__pi_deferred_placeholder__", {})).toEqual({
    block: true,
    reason: "hapi-guard: __pi_deferred_placeholder__ is not a tool hapi-guard knows (rule unknown-tool)",
  });
});

test("an error inside the tool_call handler blocks the call instead of failing open", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const r = await h.tool("write", { path: 42, content: "x" });
  expect(r).toEqual({ block: true, reason: "hapi-guard: write's path is not a string (rule bad-input)" });
});
