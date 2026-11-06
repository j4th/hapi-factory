/**
 * The result record (H-228(b); design §3.5): how the session says it ended. The factory's prompt, and a repo's
 * AGENTS.md from the template, tell the worker to end on one line, `RESULT: done`, `RESULT: blocked: <reason>` or
 * `RESULT: no-change: <reason>`. At each `turn_end` that ends the session, the guard writes `{ event: "result",
 * decision, rule: "result", reason }` from that message; a session that ends twice (a reask) writes two, and readers
 * take the last. The run's gates (the no-op check) and the harvester read it, beside the diff.
 *
 * A turn ends the session when its message is the assistant's and its `stopReason` is `stop`, `length`, `error` or
 * `aborted` (FINAL_STOPS). `toolUse` goes on to the tools; `pending` and `deferred` (pi-ai's other two values, a:301;
 * spike 09, finding 4) are a message not yet complete and a turn that waits, so neither is final, and neither is a
 * value this guard doesn't know: a stop reason it can't place writes no record (the readers then see none, which is
 * `missing`) and counts as a turn for the turn budget. Both are the fail-closed way.
 *
 * The record is a claim, like every record in /out: the worker can edit the decision log (the threat model's Plan 02
 * residuals), and it writes the line itself.
 */
import type { AgentMessage } from "./pi-api";

/** The stop reasons that end the session (see the module comment). */
export const FINAL_STOPS: ReadonlySet<string> = new Set(["stop", "length", "error", "aborted"]);

/** Whether a turn_end's message ends the session. */
export const endsSession = (m: AgentMessage | undefined): boolean =>
  m?.role === "assistant" && typeof m.stopReason === "string" && FINAL_STOPS.has(m.stopReason);

export type SessionDecision = "done" | "blocked" | "no-change" | "missing";

/** The most characters of a reason a record keeps. */
const REASON_CHARS = 300;
const RESULT_LINE = /^RESULT: (done|blocked: (\S.*)|no-change: (\S.*))$/;

const capped = (reason: string): string => {
  const chars = Array.from(reason);
  return chars.length > REASON_CHARS ? `${chars.slice(0, REASON_CHARS).join("")}…` : reason;
};

/**
 * How the session's final message says it ended: its text parts (thinking and tool calls are no text), joined with
 * "\n", and their last non-empty line, trimmed, which must be a whole `RESULT:` line. Anything else is `missing`,
 * and says when the message ends on a question: a worker that asks for a go-ahead no one can give.
 */
export function sessionResult(m: AgentMessage): { decision: SessionDecision; reason: string } {
  const parts = Array.isArray(m.content) ? m.content : [];
  const text = parts.flatMap((p) => (p?.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n");
  const last = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .at(-1);
  const match = last === undefined ? null : RESULT_LINE.exec(last);
  if (match?.[1] === "done") return { decision: "done", reason: "the session ended on RESULT: done" };
  if (match?.[2] !== undefined) return { decision: "blocked", reason: `the session ended blocked: ${capped(match[2])}` };
  if (match?.[3] !== undefined) return { decision: "no-change", reason: `the session ended with no change: ${capped(match[3])}` };
  const question = last?.endsWith("?") === true;
  return { decision: "missing", reason: `the final message has no RESULT: line${question ? ", and it ends on a question" : ""}` };
}
