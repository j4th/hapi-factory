/**
 * The factory PR's description (design §3.7; Plan 03 Task 12): nine parts between `<!-- hapi:begin -->` and
 * `<!-- hapi:end -->`, so a re-render (`rerenderPr`) replaces only them and keeps what the operator wrote outside.
 *
 * - **Host text and the run's text never mix.** Every line outside a fence is built here from host values: fixed
 *   words, numbers, run ids, host-built paths (`shownPath`, code spans), the policy's names, and the reasons the
 *   harvester built. Whatever a run or a model wrote (the review's findings and criteria, CodeRabbit's findings,
 *   the task's goal, the worker's account) goes through `fence`: sanitized, comment markers broken, inside a fence
 *   one backtick longer than its longest run of backticks. So no model text, no `@` and no marker is ever outside a
 *   fence, and a host line is passed through `plain` (no `@`, `<` or `>`) as a last net.
 * - **No checkbox** in host text: the operator's tick would be overwritten by the next render.
 * - **`Ready to merge` only once `ci / gates` is green** on the head (the Task 8 → 13 ruling): `ci` pending shows
 *   "Waiting for ci / gates", and failed shows "Needs your decision"; Task 13 re-renders when it completes.
 */
import { sanitizeTerminal } from "../run/sanitize";
import type { RunKind } from "../run/kinds";
import { goalOf, type Screened } from "./decisions";
import type { Discovered } from "./discover";
import type { Evidence, Outcome, Round } from "./harvest";
import type { Phase } from "./state";

export interface PrInput {
  order: Discovered;
  outcome: Outcome;
  evidence: Evidence;
  /** The head the PR shows: the one pushed, or, when nothing was pushed, the PR's own (`s.prHead`); the unpushed head is named only in a reason. */
  head: string;
  /** The diff's size, `<merge>..<head>`; undefined when the host's scratch doesn't hold the head (a PR head the factory never pushed). */
  stat: { files: number; insertions: number; deletions: number } | undefined;
  planningPr: number | undefined;
  position: { k: number; n: number; siblings: number[] };
  runs: { id: string; kind: RunKind; round: number; retry?: number }[];
  rounds: Round[];
  roundCap: number;
  /** decisions: the work order's whole ledger. */
  cost: { usd: number; unknown: number; turns: number; decisions: { usd: number; calls: number } };
  phase: Phase;
  round: number;
  /** `ci / gates` on the head: undefined is pending. Ready to merge is shown only once it passed. */
  ci?: "pending" | "passed" | "failed";
  /** Design §3.5's unfixed major findings in a fix round's own change (./harvest.ts), at the top of Unresolved. */
  unfixed?: string[];
  /**
   * The run's head, when it was not pushed (a moved branch, GitHub's refusal, or a ready PR's new head a draft): every
   * head-specific Evidence row is scoped to it and says so, and no finding of it, nor an unfixed line, is shown.
   */
  unpushed?: string;
}

export const BEGIN = "<!-- hapi:begin -->";
export const END = "<!-- hapi:end -->";
/** The most of the worker's account a PR shows. */
const ACCOUNT_CHARS = 6000;

/** A host line, as a last net: one line, no terminal control, no `@`, `<` or `>`. */
const plain = (s: string) => sanitizeTerminal(s.replace(/[\r\n]+/g, " ")).replace(/[@<>]/g, "");

/** Text a run or a model wrote, in a fence it can't leave (see the module comment). */
export function fence(text: string, cap?: number): string {
  let t = sanitizeTerminal(text).replace(/<!--/g, "< !--").replace(/-->/g, "-- >");
  if (cap !== undefined) {
    const chars = Array.from(t);
    if (chars.length > cap) t = `${chars.slice(0, cap).join("")}\n… (truncated by the host)`;
  }
  const longest = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${t.replace(/\n+$/, "")}\n${f}`;
}

const VERDICT = {
  ready: ["Ready to merge", "green"],
  decision: ["Needs your decision", "yellow"],
  "do-not-merge": ["Do not merge", "red"],
} as const;

const h7 = (sha: string) => sha.slice(0, 7);
const cell = (s: string) => plain(s).replace(/\|/g, "\\|");

/** A capped list's full count: its lines, or 10 plus the `… and <n> more` line's n. */
function count(lines: string[]): number {
  const more = /^… and (\d+) more/.exec(lines.at(-1) ?? "");
  return more ? lines.length - 1 + Number(more[1]) : lines.length;
}

/** One decision's Evidence row: `| decide: <name> v<version> | <h7> | <screened> | <result> |`; `head` is the cell's text. */
function decisionRow(s: Screened, head: string): string {
  const via = (["jev", "haiku", "default"] as const).filter((k) => (s.via[k] ?? 0) > 0).map((k) => `${k} ${s.via[k]}`);
  const screened =
    s.models === "off" || !s.pushed || s.mode === "off" || s.subjects === 0
      ? "not asked"
      : `${s.subjects} ${s.subjects === 1 ? "file" : "files"} screened (${s.asked} asked, ${s.reused} reused${via.length > 0 ? `; ${via.join(", ")}` : ""})`;
  let result: string;
  if (s.models === "off") result = "off: decision models are off (gates.decisions.mode)";
  else if (!s.pushed) result = "not screened (this head was not pushed)";
  else if (s.mode === "off") result = `off (gates.decisions.by_name.${s.decision}.mode)`;
  else if (s.mode === "shadow") result = `shadow: would hold ${count(s.holds)}`;
  else if (s.models === "notes") result = `notes only (gates.decisions.mode): ${count(s.notes)} note`;
  else if (s.asked + s.reused === 0 && s.unscreened > 0) result = `${s.unscreened} not screened`;
  else if (s.holds.length + s.notes.length === 0) result = "pass";
  else result = `${count(s.holds)} hold, ${count(s.notes)} note`;
  return `| decide: ${cell(s.decision)} v${cell(s.version)} | ${head} | ${cell(screened)} | ${cell(result)} |`;
}

/** The verify rows' results. */
function verifyCells(e: Evidence): { check: string; smoke: string; acceptance: string } {
  const v = e.verify;
  if (v.state === "off") return { check: "off (runs.phases.verify)", smoke: "off (runs.phases.verify)", acceptance: "off (runs.phases.verify)" };
  if (v.state === "broken") return { check: `broken: ${v.why}`, smoke: "not read", acceptance: "not read" };
  if (v.state === "unconfirmed") return { check: `unconfirmed: ${v.why}`, smoke: "unconfirmed", acceptance: "unconfirmed" };
  const notRun = "not run (check failed first)";
  return {
    check: v.check,
    smoke: v.smoke === "off" ? "off (verify.smoke)" : v.smoke === "not-run" ? notRun : v.smoke,
    acceptance: v.acceptance === "none" ? "none" : v.acceptance === "not-run" ? notRun : v.acceptance,
  };
}

const STAGES = { "before-pr": "before the PR", "on-pr": "on the PR", rework: "rework" } as const;

/** The host's part of the PR body, markers included (see the module comment). */
export function renderPr(i: PrInput): string {
  const e = i.evidence;
  const id = i.order.id;
  const head = h7(i.head);
  /** The head the evidence is of: the PR's, or the run's head that was not pushed. */
  const evidenceHead = i.unpushed === undefined ? head : `${h7(i.unpushed)} (not pushed)`;
  const ci = i.ci ?? "pending";
  const out: string[] = [BEGIN, "## Verdict", ""];

  // 1. The verdict: Ready to merge only once ci / gates is green on the head.
  const ready = i.outcome.verdict === "ready";
  if (ready && ci === "pending") {
    out.push("**Waiting for `ci / gates`** · risk: green", "", `Nothing the host checked holds it back: it is Ready to merge once \`ci / gates\` passes on ${head}.`);
  } else if (ready && ci === "failed") out.push(`**${VERDICT.decision[0]}** · risk: ${VERDICT.decision[1]}`);
  else {
    const [word, risk] = VERDICT[i.outcome.verdict];
    out.push(`**${word}** · risk: ${risk}`);
  }

  // 2. Unresolved, then Check this yourself.
  const unresolved = [...(i.unpushed === undefined ? (i.unfixed ?? []) : []), ...i.outcome.reasons];
  if (ready && ci === "failed") unresolved.push(`\`ci / gates\` failed on ${head}`);
  if (e.cr.state === "not-reviewed") unresolved.push(`CodeRabbit's CLI did not review this head: ${e.cr.why}`);
  out.push("", "## Unresolved", "");
  if (unresolved.length === 0) out.push("Nothing unresolved.");
  else for (const r of unresolved) out.push(`- ${plain(r)}`);
  const check = [
    "The worker's account below is its own claim; the host did not check it.",
    "CI's `ci / gates` check on the head is GitHub's own run, on a fresh runner: read its result on this PR.",
    ...e.gates.signals,
    ...e.screens.filter((s) => s.mode === "enforce" && s.models !== "off").flatMap((s) => s.notes),
    ...(e.screens.some((s) => s.models === "off") ? ["Decision models are off (gates.decisions.mode: off): no decide() question screened this change."] : []),
  ];
  out.push("", "**Check this yourself**", "", ...check.map((c) => `- ${plain(c)}`));

  // 3. Links.
  out.push("", "## Links", "");
  out.push(`- Work order \`${plain(id)}\` (${i.position.k} of ${i.position.n}), merged at ${h7(i.order.mergeSha)}`);
  if (i.planningPr !== undefined) out.push(`- Part of #${i.planningPr}`);
  if (i.position.siblings.length > 0) out.push(`- Siblings: ${i.position.siblings.map((n) => `#${n}`).join(", ")} (independent; merge in any order)`);
  out.push(`- Trace: \`${plain(i.order.workOrder.trace.traceparent)}\``);
  for (const r of i.runs) out.push(`- Run \`${plain(r.id)}\`: ${r.kind}, round ${r.round}${r.retry !== undefined && r.retry >= 1 ? ` (retry ${r.retry})` : ""}`);

  // 4. Asked and built.
  out.push("", "## Asked and built", "", fence(goalOf(i.order.taskMd) || "(task.md has no paragraph)"), "");
  out.push(
    i.stat === undefined
      ? `The diff's size isn't known: the host's copy of the repo doesn't hold the PR's head ${head}. Rollback: revert this PR's merge commit.`
      : `${i.stat.files} files, +${i.stat.insertions} −${i.stat.deletions}. Rollback: revert this PR's merge commit.`,
  );

  // 5. Evidence, restated after every round.
  const v = verifyCells(e);
  const acceptanceCmd = e.verify.state === "ran" && e.verify.acceptance === "none" ? "no acceptance tests" : `bun test ./.factory/work/${plain(id)}/acceptance`;
  const r = e.review;
  const review = r.state === "off" ? "off (runs.phases.review)" : r.state === "none" ? `none: ${r.why}` : `${r.verdict}: ${r.findings.length} findings, ${r.criteria.filter((c) => c.mark === "met").length} of ${r.criteria.length} criteria met`;
  const cr =
    e.cr.state === "off"
      ? "off (runs.phases.coderabbit)"
      : e.cr.state === "not-reviewed"
        ? `not reviewed: ${e.cr.why}`
        : `reviewed: ${e.cr.findings.length} findings, ${e.cr.findings.filter((f) => f.severity === "critical" || f.severity === "major").length} major or critical`;
  const n = e.gates.files.length;
  const gates = e.gates.problems.length === 0 ? `passed (${n} ${n === 1 ? "file" : "files"})` : `refused (${e.gates.problems.length} problems)`;
  out.push("", "## Evidence", "", "| Gate | Head | Command | Result |", "|---|---|---|---|");
  out.push(`| host gates | ${evidenceHead} | the bundle, its trailers, protected paths, scope, the secret scan | ${cell(gates)} |`);
  out.push(`| check | ${evidenceHead} | \`mise run check\` | ${cell(v.check)} |`);
  out.push(`| smoke | ${evidenceHead} | \`mise run smoke\` | ${cell(v.smoke)} |`);
  out.push(`| acceptance | ${evidenceHead} | ${acceptanceCmd.startsWith("bun") ? `\`${acceptanceCmd}\`` : acceptanceCmd} | ${cell(v.acceptance)} |`);
  out.push(`| the independent review | ${evidenceHead} | factory-review, read-only | ${cell(review)} |`);
  out.push(`| CodeRabbit's CLI | ${evidenceHead} | \`cr review --agent --committed --gate major\` | ${cell(cr)} |`);
  for (const s of e.screens) out.push(decisionRow(s, evidenceHead));
  out.push(`| \`ci / gates\` | ${head} | GitHub Actions, on the pushed head | ${ci} |`);
  if (i.unpushed !== undefined) {
    out.push("", `The rows above but \`ci / gates\` are of round ${i.round}'s head ${h7(i.unpushed)}, which was not pushed (see Unresolved); the PR's head is still ${head}, and its findings aren't shown.`);
  } else if (r.state === "ran" && (r.findings.length > 0 || r.criteria.length > 0)) {
    const lines = [
      ...r.findings.map((f) => `[${f.severity}] ${f.path}: ${f.summary}`),
      ...r.criteria.map((c, n) => `criterion ${n + 1} (${c.mark}): ${c.criterion}\n  evidence: ${c.evidence}`),
    ];
    out.push("", "The independent review's findings and criteria, as it wrote them:", "", fence(lines.join("\n")));
  }
  if (i.unpushed === undefined && e.cr.state === "reviewed" && e.cr.findings.length > 0) {
    out.push("", "CodeRabbit's findings, as it wrote them:", "", fence(e.cr.findings.map((f) => `[${f.severity}] ${f.file}${f.line === undefined ? "" : `:${f.line}`}: ${f.title}\n${f.text}`).join("\n\n")));
  }

  // 6. Review rounds.
  out.push("", "## Review rounds", "", `Fix rounds: ${i.rounds.length} of ${i.roundCap}.`);
  if (i.rounds.length > 0) {
    out.push("");
    for (const rd of i.rounds) out.push(`- Round ${rd.round}, ${STAGES[rd.stage]}: run \`${plain(rd.run)}\``);
    out.push("", "Each finding's disposition (fixed, declined with why) is in that fix run's own account; the PR doesn't list them yet (H-274).");
  }

  // 7. Cost and turns, one line.
  const unknown = i.cost.unknown > 0 ? ` (${i.cost.unknown} with an unknown spend, counted at ${i.cost.unknown === 1 ? "its" : "their"} budget)` : "";
  out.push("", "## Cost and turns", "", `$${i.cost.usd.toFixed(2)} over ${i.runs.length} runs${unknown}, ${i.cost.turns} turns, decisions $${i.cost.decisions.usd.toFixed(4)} (${i.cost.decisions.calls} calls)`);

  // 8. The worker's account, fenced as its claim.
  out.push("", "## The worker's account", "");
  const account = e.worker.account;
  if (account === undefined) out.push("_The worker wrote no account._");
  else out.push("_The worker's own claim; the host did not check it._", "", fence(account, ACCOUNT_CHARS));

  // 9. The hidden state block.
  const state = { workOrder: id, status: i.phase, round: i.round, head: i.head, verdict: i.outcome.verdict };
  out.push("", `<!-- hapi:pr v1 ${JSON.stringify(state).replace(/-->/g, "")} -->`, END);
  return out.join("\n");
}

/** The body with its host part re-rendered: what is outside the markers is kept; a body without them gets the host part first. */
export function rerenderPr(oldBody: string, i: PrInput): string {
  const b = oldBody.indexOf(BEGIN);
  const e = b === -1 ? -1 : oldBody.indexOf(END, b);
  if (b === -1 || e === -1) return oldBody.trim() === "" ? renderPr(i) : `${renderPr(i)}\n\n${oldBody}`;
  return `${oldBody.slice(0, b)}${renderPr(i)}${oldBody.slice(e + END.length)}`;
}
