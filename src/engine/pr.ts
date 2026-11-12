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
import { ENGINE_DECISIONS, goalOf, type Screened } from "./decisions";
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
  /**
   * The round of `head`: the pushed run's, or, when nothing was pushed, the PR's own head's as its hidden block named
   * it; undefined when that isn't known, and the hidden block then carries no round.
   */
  round: number | undefined;
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
/** The most characters each quoted block (the review's findings and criteria; CodeRabbit's findings) shows (final review I2). */
const QUOTE_CHARS = 20_000;
/** The most characters the host's part of a PR body may hold: GitHub refuses a body over 65,536 (final review I2). */
export const BODY_CHARS = 60_000;
/** GitHub's limit on a whole PR body, the operator's own text outside the markers included. */
export const GITHUB_BODY_CHARS = 65_536;
/** What a re-render leaves free under GitHub's limit beside the operator's own text (final re-review N3). */
export const ROOM_MARGIN = 512;
/** The fallback body's `held:` lines: at most this many, each at most FALLBACK_LINE_CHARS characters, so its size is bounded whatever the screens hold. */
const FALLBACK_HELD = 5;
const FALLBACK_LINE_CHARS = 300;
/** How a reason that the PR body had no room for the host's part starts (`noRoomReason`). */
export const NO_ROOM = "the PR body has no room for the host's part";
/** The reason a work order's state carries when its PR body has no room for the host's part (final re-review N3). */
export const noRoomReason = (outside: number) => `${NO_ROOM}: ${outside} characters of it are outside the hapi markers`;
/** Whether `reason` is `noRoomReason`'s: a state of the body, never a reason of the change, so no render shows it. */
export const isNoRoom = (reason: string) => reason.startsWith(`${NO_ROOM}:`);

/** How much of the run's quoted text one render shows: each quoted block's characters, the account's, and (last resort) the host lists' lines. */
interface Caps {
  quote: number;
  account: number;
  lists?: number;
}
/**
 * The last guard's steps, tried in order until the body fits in BODY_CHARS (final review I2): the quoted sections
 * first, then the account, then (when even that isn't enough) the Unresolved and Check-this-yourself lists. Fixed
 * steps, so the same input always renders the same body.
 */
const STEPS: readonly Caps[] = [
  { quote: QUOTE_CHARS, account: ACCOUNT_CHARS },
  { quote: 10_000, account: ACCOUNT_CHARS },
  { quote: 4_000, account: ACCOUNT_CHARS },
  { quote: 0, account: ACCOUNT_CHARS },
  { quote: 0, account: 2_000 },
  { quote: 0, account: 0 },
  { quote: 0, account: 0, lists: 40 },
  { quote: 0, account: 0, lists: 10 },
];

/** A host line, as a last net: one line, no terminal control, no `@`, `<` or `>`. The state machine reads a reason's Unresolved line by it. */
export const plain = (s: string) => sanitizeTerminal(s.replace(/[\r\n]+/g, " ")).replace(/[@<>]/g, "");

/** Text a run or a model wrote, in a fence it can't leave (see the module comment); `where`, when it is cut, says where the whole text is. */
export function fence(text: string, cap?: number, where?: string): string {
  let t = sanitizeTerminal(text).replace(/<!--/g, "< !--").replace(/-->/g, "-- >");
  if (cap !== undefined) {
    const chars = Array.from(t);
    if (chars.length > cap) t = `${chars.slice(0, cap).join("")}\n… (truncated by the host${where === undefined ? "" : `: ${where}`})`;
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

/**
 * The quoted items that fit in `max` characters, joined by `sep`: whole items, in order (an item over `max` is cut to
 * `max - 1` characters and `…`, so a first item over it still shows, cut: final re-review N2), and how many were left
 * out. With `max` at least 1 the first item is always kept.
 */
function quoted(items: string[], sep: string, max: number): { text: string; more: number } {
  const kept: string[] = [];
  let n = 0;
  for (const item of items) {
    const it = item.length > max ? `${item.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, "")}…` : item;
    const add = (kept.length === 0 ? 0 : sep.length) + it.length;
    if (n + add > max) break;
    kept.push(it);
    n += add;
  }
  return { text: kept.join(sep), more: items.length - kept.length };
}

/** `n` and `word`, or its plural. */
const counted = (n: number, word: string, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;

/** At most `max` lines of a host list, then a line saying how many more and where they all are. */
function capList(lines: string[], max: number | undefined, where: string): string[] {
  if (max === undefined || lines.length <= max) return lines;
  return [...lines.slice(0, max), `… and ${lines.length - max} more (cut to keep the PR body under GitHub's size limit): ${where}`];
}

/** A capped list's full count: its lines, or 10 plus the `… and <n> more` line's n. */
function count(lines: string[]): number {
  const more = /^… and (\d+) more/.exec(lines.at(-1) ?? "");
  return more ? lines.length - 1 + Number(more[1]) : lines.length;
}

/** One decision's Evidence row: `| decide: <name> v<version> | <h7> | <screened> | <result> |`; `head` is the cell's text. */
function decisionRow(s: Screened, head: string): string {
  const via = (["jev", "haiku", "default"] as const).filter((k) => (s.via[k] ?? 0) > 0).map((k) => `${k} ${s.via[k]}`);
  const asked = s.asked + s.reused + s.unscreened > 0;
  const screened =
    s.models === "off" || (!s.pushed && !asked) || s.mode === "off" || s.subjects === 0
      ? "not asked"
      : `${s.subjects} ${s.subjects === 1 ? "file" : "files"} screened (${s.asked} asked, ${s.reused} reused${via.length > 0 ? `; ${via.join(", ")}` : ""})`;
  let result: string;
  if (s.models === "off") result = "off: decision models are off (gates.decisions.mode)";
  else if (!s.pushed) result = s.asked + s.reused > 0 ? "asked; this head was not pushed" : s.unscreened > 0 ? "unscreened; this head was not pushed" : "not screened (this head was not pushed)";
  else if (s.mode === "off") result = `off (gates.decisions.by_name.${s.decision}.mode)`;
  else if (s.mode === "shadow") result = `shadow: would hold ${count(s.holds)}`;
  else if (s.models === "notes") result = `notes only (gates.decisions.mode): ${count(s.notes)} note`;
  else if (s.asked + s.reused === 0 && s.unscreened > 0) result = `${s.unscreened} not screened`;
  else if (s.holds.length + s.notes.length === 0) result = "pass";
  else result = `${count(s.holds)} hold, ${count(s.notes)} note`;
  return `| decide: ${cell(s.decision)} v${cell(s.version)} | ${head} | ${cell(screened)} | ${cell(result)} |`;
}

/** One enforced screen's verdict-line holds (D73): `held: <n> files not screened (<cause>)` per cause, then `held: <what it found> in <paths>`. */
function heldText(s: Screened): string[] {
  const lines = (s.coverage ?? []).map((c) => `held: ${c.files} ${c.files === 1 ? "file" : "files"} not screened (${c.cause})`);
  const paths = s.held ?? [];
  if (paths.length > 0) {
    const what = ENGINE_DECISIONS[s.decision]?.heldFor ?? `decide ${s.decision}'s hold`;
    lines.push(`held: ${what} in ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` and ${paths.length - 5} more` : ""}`);
  }
  return lines;
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

/**
 * The host's part of the PR body, markers included (see the module comment). Its last step is the size guard (final
 * review I2): it renders with each STEPS entry in turn and returns the first body within `budget` (BODY_CHARS unless
 * a re-render beside the operator's own text gives less, `rerenderPr`). When even the last step is over it, the
 * fallback (final re-review N3): the markers, the verdict, the `held:` lines (at most FALLBACK_HELD, each at most
 * FALLBACK_LINE_CHARS), one line saying where the full report is, and the hidden block. Its size doesn't grow with
 * the evidence, so only a budget smaller than that fixed size can't hold it, and the caller checks for that.
 */
export function renderPr(i: PrInput, budget = BODY_CHARS): string {
  for (const caps of STEPS) {
    const body = renderWith(i, caps);
    if (body.length <= budget) return body;
  }
  return fallback(i);
}

/** The verdict line (Ready to merge only once ci / gates is green on the head), and its explanation when ci / gates is pending. */
function verdictLines(i: PrInput): string[] {
  const ci = i.ci ?? "pending";
  const ready = i.outcome.verdict === "ready";
  if (ready && ci === "pending") return ["**Waiting for `ci / gates`** · risk: green", "", `Nothing the host checked holds it back: it is Ready to merge once \`ci / gates\` passes on ${h7(i.head)}.`];
  if (ready && ci === "failed") return [`**${VERDICT.decision[0]}** · risk: ${VERDICT.decision[1]}`];
  const [word, risk] = VERDICT[i.outcome.verdict];
  return [`**${word}** · risk: ${risk}`];
}

/** D73 (the hold-fatigue ruling): an enforced screen's holds, coverage apart from findings, for under the verdict line; none for a head that wasn't pushed. */
function heldLinesOf(i: PrInput): string[] {
  return i.unpushed === undefined ? i.evidence.screens.filter((s) => s.models === "enforce" && s.mode === "enforce").flatMap(heldText) : [];
}

/** The hidden state block, the last line before the end marker. */
function hiddenBlock(i: PrInput): string {
  const state = { workOrder: i.order.id, status: i.phase, ...(i.round === undefined ? {} : { round: i.round }), head: i.head, verdict: i.outcome.verdict };
  return `<!-- hapi:pr v1 ${JSON.stringify(state).replace(/-->/g, "")} -->`;
}

/** The fallback body (see `renderPr`): bounded by its own caps, whatever the evidence holds. */
function fallback(i: PrInput): string {
  const cut = (l: string) => {
    const chars = Array.from(plain(l));
    return chars.length > FALLBACK_LINE_CHARS ? `${chars.slice(0, FALLBACK_LINE_CHARS - 1).join("")}…` : chars.join("");
  };
  const held = heldLinesOf(i);
  const out = [BEGIN, "## Verdict", "", ...verdictLines(i)];
  if (held.length > 0) {
    out.push("", ...held.slice(0, FALLBACK_HELD).map((l) => `- ${cut(l)}`));
    if (held.length > FALLBACK_HELD) out.push(`- … and ${held.length - FALLBACK_HELD} more held lines (cut to keep the PR body under GitHub's size limit)`);
  }
  out.push(
    "",
    "_The full report is too long for this PR's body (GitHub's size limit): `hapi status` lists every reason, and the runs' outputs on the host hold the rest (the evidence, the findings and the worker's account)._",
    "",
    hiddenBlock(i),
    END,
  );
  return out.join("\n");
}

/** The body with `caps` (see `renderPr`). */
function renderWith(i: PrInput, caps: Caps): string {
  const e = i.evidence;
  const id = i.order.id;
  const head = h7(i.head);
  /** The head the evidence is of: the PR's, or the run's head that was not pushed. */
  const evidenceHead = i.unpushed === undefined ? head : `${h7(i.unpushed)} (not pushed)`;
  const ci = i.ci ?? "pending";
  const out: string[] = [BEGIN, "## Verdict", ""];

  // 1. The verdict: Ready to merge only once ci / gates is green on the head; then the enforced screens' holds.
  const ready = i.outcome.verdict === "ready";
  out.push(...verdictLines(i));
  const heldLines = heldLinesOf(i);
  if (heldLines.length > 0) out.push("", ...heldLines.map((l) => `- ${plain(l)}`));

  // 2. Unresolved, then Check this yourself.
  const unresolved = [...(i.unpushed === undefined ? (i.unfixed ?? []) : []), ...i.outcome.reasons];
  if (ready && ci === "failed") unresolved.push(`\`ci / gates\` failed on ${head}`);
  // What describes the unpushed head stays in its Evidence rows (and its reason): the PR shows another head.
  if (e.cr.state === "not-reviewed" && i.unpushed === undefined) unresolved.push(`CodeRabbit's CLI did not review this head: ${e.cr.why}`);
  out.push("", "## Unresolved", "");
  if (unresolved.length === 0) out.push("Nothing unresolved.");
  else for (const r of capList(unresolved, caps.lists, "`hapi status` lists every reason")) out.push(`- ${plain(r)}`);
  const check = [
    ...(i.unpushed === undefined ? ["The worker's account below is its own claim; the host did not check it."] : []),
    "CI's `ci / gates` check on the head is GitHub's own run, on a fresh runner: read its result on this PR.",
    ...(i.unpushed === undefined ? e.gates.signals : []),
    ...(i.unpushed === undefined ? e.screens.filter((s) => s.mode === "enforce" && s.models !== "off").flatMap((s) => s.notes) : []),
    ...(e.screens.some((s) => s.models === "off") ? ["Decision models are off (gates.decisions.mode: off): no decide() question screened this change."] : []),
  ];
  out.push("", "**Check this yourself**", "", ...capList(check, caps.lists, "the run's outputs on the host hold the rest").map((c) => `- ${plain(c)}`));

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
  out.push(`| CodeRabbit's CLI | ${evidenceHead} | \`cr review --deep --agent --committed --gate major\` | ${cell(cr)} |`);
  for (const s of e.screens) out.push(decisionRow(s, evidenceHead));
  out.push(`| \`ci / gates\` | ${head} | GitHub Actions, on the pushed head | ${ci} |`);
  if (i.unpushed !== undefined) {
    out.push("", `The rows above but \`ci / gates\` are of the run's head ${h7(i.unpushed)}, which was not pushed (see Unresolved); the PR's head is still ${head}, and its findings aren't shown.`);
  } else if (r.state === "ran" && (r.findings.length > 0 || r.criteria.length > 0)) {
    const lines = [
      ...r.findings.map((f) => `[${f.severity}] ${f.path}: ${f.summary}`),
      ...r.criteria.map((c, n) => `criterion ${n + 1} (${c.mark}): ${c.criterion}\n  evidence: ${c.evidence}`),
    ];
    // Nothing kept (the quoted blocks gone at this step) is this one line, never an empty fence.
    const q = caps.quote === 0 ? { text: "", more: lines.length } : quoted(lines, "\n", caps.quote);
    if (q.more === lines.length) out.push("", `_The independent review's ${counted(r.findings.length, "finding")} and ${counted(r.criteria.length, "criterion", "criteria")} aren't shown here, to keep the PR body under GitHub's size limit: they are in the review run's outputs._`);
    else {
      out.push("", "The independent review's findings and criteria, as it wrote them:", "", fence(q.text));
      if (q.more > 0) out.push("", `… (truncated by the host: ${q.more} more in the review run's outputs)`);
    }
  }
  if (i.unpushed === undefined && e.cr.state === "reviewed" && e.cr.findings.length > 0) {
    const items = e.cr.findings.map((f) => `[${f.severity}] ${f.file}${f.line === undefined ? "" : `:${f.line}`}: ${f.title}\n${f.text}`);
    const q = caps.quote === 0 ? { text: "", more: items.length } : quoted(items, "\n\n", caps.quote);
    if (q.more === items.length) out.push("", `_CodeRabbit's ${counted(items.length, "finding")} ${items.length === 1 ? "isn't" : "aren't"} shown here, to keep the PR body under GitHub's size limit: they are in the review run's outputs._`);
    else {
      out.push("", "CodeRabbit's findings, as it wrote them:", "", fence(q.text));
      if (q.more > 0) out.push("", `… (truncated by the host: ${q.more} more CodeRabbit findings in the review run's outputs)`);
    }
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
  if (i.unpushed !== undefined) out.push(`_The run whose head ${h7(i.unpushed)} was not pushed isn't this PR's: its account isn't shown._`);
  else if (account === undefined) out.push("_The worker wrote no account._");
  else if (caps.account === 0) out.push("_The worker's account isn't shown here, to keep the PR body under GitHub's size limit: it is in the worker run's transcript on the host._");
  else out.push("_The worker's own claim; the host did not check it._", "", fence(account, caps.account, caps.account < ACCOUNT_CHARS ? "the whole account is in the worker run's transcript on the host" : undefined));

  // 9. The hidden state block.
  out.push("", hiddenBlock(i), END);
  return out.join("\n");
}

/**
 * The body with its host part re-rendered: what is outside the markers is kept; a body without them gets the host
 * part first. The host part's budget is what GitHub's limit leaves beside that text, less ROOM_MARGIN, and never over
 * BODY_CHARS (final re-review N3). `noRoom` when even the fallback doesn't fit: the operator's own text nearly fills
 * the body, so nothing is written, and the caller records why (`noRoomReason`) instead.
 */
export function rerenderPr(oldBody: string, i: PrInput): { body: string } | { noRoom: string } {
  const b = oldBody.indexOf(BEGIN);
  const e = b === -1 ? -1 : oldBody.indexOf(END, b);
  const marked = b !== -1 && e !== -1;
  const before = marked ? oldBody.slice(0, b) : "";
  const after = marked ? oldBody.slice(e + END.length) : oldBody.trim() === "" ? "" : `\n\n${oldBody}`;
  const budget = Math.min(BODY_CHARS, GITHUB_BODY_CHARS - before.length - after.length - ROOM_MARGIN);
  const host = renderPr(i, budget);
  if (host.length > budget) return { noRoom: noRoomReason(marked ? before.length + after.length : oldBody.length) };
  return { body: `${before}${host}${after}` };
}
