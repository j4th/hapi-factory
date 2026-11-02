/**
 * The result record (H-228(b)): the session's final message's `RESULT:` line, which Task 11's gates and Task 12's
 * harvester read. It is a claim: the worker can edit /out (the threat model's Plan 02 residuals).
 */
import { afterEach, expect, test } from "bun:test";
import { sessionResult } from "../../src/guard/result";
import { cleanupAll, FAKE_ENV, gatesOff, setup } from "./harness";

afterEach(cleanupAll);

const final = (content: unknown) => ({ role: "assistant", stopReason: "stop", content }) as any;
const text = (t: string) => final([{ type: "text", text: t }]);
const DONE = { decision: "done", reason: "the session ended on RESULT: done" };
const MISSING = { decision: "missing", reason: "the final message has no RESULT: line" };

test("sessionResult reads the last non-empty line of the final message's text", () => {
  const long = "y".repeat(301);
  const table: [unknown, { decision: string; reason: string }][] = [
    [text("…\n## Account\n…\nRESULT: done"), DONE],
    [text("RESULT: blocked: the sidecar is down"), { decision: "blocked", reason: "the session ended blocked: the sidecar is down" }],
    [text("RESULT: no-change: already on main"), { decision: "no-change", reason: "the session ended with no change: already on main" }],
    [text("Should I go ahead?"), { decision: "missing", reason: "the final message has no RESULT: line, and it ends on a question" }],
    [text("done.\nRESULT: done\nThanks!"), MISSING],
    [text("RESULT: blocked"), MISSING],
    [text("RESULT: no-change"), MISSING],
    [text("RESULT: blocked: "), MISSING],
    [text("RESULT: finished"), MISSING],
    [text(`RESULT: blocked: ${long}`), { decision: "blocked", reason: `the session ended blocked: ${"y".repeat(300)}…` }],
    [text(`RESULT: no-change: ${"y".repeat(300)}`), { decision: "no-change", reason: `the session ended with no change: ${"y".repeat(300)}` }],
    // Trailing blank lines and a CR are not the last line.
    [text("RESULT: done\r\n\n  \n"), DONE],
    // Only text parts count: thinking and tool calls are ignored, and text parts are joined with "\n".
    [final([{ type: "thinking", thinking: "RESULT: done" }, { type: "text", text: "RESULT: done" }]), DONE],
    [final([{ type: "text", text: "RESULT: done" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]), DONE],
    [final([{ type: "thinking", thinking: "RESULT: done" }]), MISSING],
    [final([{ type: "text", text: "the work" }, { type: "text", text: "RESULT: done" }]), DONE],
    [final([{ type: "text", text: "RESULT: done" }, { type: "text", text: "Is that all?" }]), { decision: "missing", reason: "the final message has no RESULT: line, and it ends on a question" }],
    [final([]), MISSING],
    [final("RESULT: done"), MISSING],
    [final(undefined), MISSING],
  ];
  expect(table.map(([m]) => sessionResult(m as any))).toEqual(table.map(([, want]) => want as any));
});

test("the result record is written at the turn_end that ends the session, and readers take the last", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const results = () => h.log().filter((r) => r.event === "result").map((r) => [r.event, r.decision, r.rule]);
  const turn = (i: number, message: Record<string, unknown>) => h.fire("turn_end", { turnIndex: i, message });

  await turn(0, { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] });
  expect(results()).toEqual([]);
  await turn(1, { role: "assistant", content: [{ type: "text", text: "RESULT: done" }] });
  expect(results()).toEqual([]);
  await turn(2, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "x\nRESULT: done" }] });
  expect(results()).toEqual([["result", "done", "result"]]);

  // A later final turn (a reask) writes another; readers take the last.
  await turn(3, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `RESULT: blocked: the key ${FAKE_ENV.ANTHROPIC_API_KEY} is refused` }] });
  const last = h.log().filter((r) => r.event === "result").at(-1);
  expect([last.decision, last.reason]).toEqual(["blocked", "the session ended blocked: the key [hapi: ANTHROPIC_API_KEY redacted] is refused"]);
  expect(JSON.stringify(h.log())).not.toContain(FAKE_ENV.ANTHROPIC_API_KEY);
});

test("which stop reasons end the session: stop, length, error and aborted; never toolUse, pending, deferred or an unknown one", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const stops = ["toolUse", "pending", "deferred", "something-new", "stop", "length", "error", "aborted"];
  for (const [i, stopReason] of stops.entries()) {
    await h.fire("turn_end", { turnIndex: i, message: { role: "assistant", stopReason, content: [{ type: "text", text: `RESULT: no-change: ${stopReason}` }] } });
  }
  // A user message is never the session's final message, whatever it carries.
  await h.fire("turn_end", { turnIndex: 9, message: { role: "user", stopReason: "stop", content: [{ type: "text", text: "RESULT: done" }] } });
  expect(h.log().filter((r) => r.event === "result").map((r) => r.reason)).toEqual(
    ["stop", "length", "error", "aborted"].map((s) => `the session ended with no change: ${s}`),
  );
});
