/**
 * The status view (design §3.8; Plan 03 Task 14): what the poller tells the operator about a plan's work orders.
 *
 * - **`events.jsonl`** (`<engineDir>/events.jsonl`, 0600): one JSON line per transition (`StatusEvent`, ./state.ts),
 *   appended by the holder of the poll lock only (a tick, after it writes the state; or `hapi retry`), so a reader
 *   sees an event only once the state it names is on disk. A retry is `failed` then `queued`, with `retry` on it.
 * - **The status comment** on each planning PR: one row per work order of the plan, a "Can't run" table for the work
 *   orders that can't run, the plan's spend against the caps, and the decision-models line when `gates.decisions.mode`
 *   isn't `enforce` (so decision models off is never silent). The poller creates it once and edits it in place, only
 *   when its body changes (`upsertStatusComment`, its mark `<engineDir>/status/<owner>/<name>/<planning-pr>.json`).
 *   Once every work order has settled and no problem is open, it posts one final comment, and the poller then leaves
 *   the plan's comments as they are (./poll.ts); a work order that leaves the settled phases (`hapi retry`) reopens the
 *   plan, and the next settling posts another.
 * - **Recoverable.** A mark that is missing (a crash, or a write that failed, after the comment was posted) is found
 *   again on the PR: the newest comment of the factory's App that starts with the hidden marker is adopted, never a
 *   second one posted; a comment someone deleted (its edit a 404) is found again the same way, or posted anew.
 * - **Markdown-safe.** Every cell is one line, its `|` escaped. Text a run, a worker, a planner or GitHub controls
 *   (reasons, problems' paths and reasons) is in a code span (`codeSpan`: no `@ < > \``, no control character), so no
 *   mention, link, image, HTML or emphasis renders; the rest is host-built (ids the schema checked, run ids, numbers).
 * - **`hapi status`** prints the same table from local state only (./cli.ts `statusCommand`).
 */
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Forge, IssueComment } from "../forge";
import { APPS, parseOwnerRepo } from "../forge/github/app-token";
import { ForgeError } from "../forge/github/rest";
import type { DecisionModels } from "../policy/types";
import { readRecord, writeWhole } from "../run/records";
import { runSpend } from "../run/spend";
import { codeSpan, decisionSpend } from "./decisions";
import type { DiscoverProblem } from "./discover";
import type { Phase, StatusEvent, Verdict, WorkOrderState } from "./state";

/** A factory PR's verdict as the operator reads it (design §3.7 row 1). */
export const VERDICT_TEXT: Record<Verdict, string> = { ready: "Ready to merge", decision: "Needs your decision", "do-not-merge": "Do not merge" };

/** One work order's row: its state, its spend (every pass's runs and its decision ledger), and whether all of it is known. */
export interface StatusRow {
  state: WorkOrderState;
  usd: number;
  known: boolean;
}

/** What the poller remembers of a planning PR's status comment: its id, its body's SHA-256, and whether the final comment is posted. */
export interface StatusMark {
  commentId: number;
  sha256: string;
  final: boolean;
}

const MARKER = "<!-- hapi:status v1 -->";
const FINAL_MARKER = "<!-- hapi:status-final v1 -->";
/** The factory App's bot: the only author whose status comment is adopted. */
const FACTORY_BOT = `${APPS.factory.name}[bot]`;
const SETTLED: readonly Phase[] = ["merged", "closed", "failed"];
const usd2 = (n: number) => `$${n.toFixed(2)}`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** A table cell: one line, its `|` escaped. */
const cell = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

/** `<engineDir>/status/<owner>/<name>/<planningPr>.json`. Throws for a repo that isn't an owner/name, or a PR number that isn't one. */
export function markPath(engineDir: string, repo: string, planningPr: number): string {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${JSON.stringify(repo.slice(0, 120))}`);
  if (!Number.isSafeInteger(planningPr) || planningPr < 1) throw new Error(`not a PR number: ${planningPr}`);
  return join(engineDir, "status", r.owner, r.name, `${planningPr}.json`);
}

/**
 * Each state's row: each run's spend as the caps count it (`runSpend`: its known spend, or its budget, `runUsd` for a
 * record with none or a run retention removed), and its decision ledger's (`decisionSpend`, an unanswered call at
 * `unknownUsd`) up to `now` (the tick's, or `hapi status`'s, `d.run.now()`). A row is known only if every run's is; an
 * unknown call already counts high, so the ledger never makes it unknown.
 */
export async function rowsOf(stateDir: string, states: WorkOrderState[], runUsd: number, engineDir: string, unknownUsd: number, now: Date): Promise<StatusRow[]> {
  const rows: StatusRow[] = [];
  for (const s of states) {
    let usd = 0;
    let known = true;
    for (const id of s.runs) {
      const rec = await readRecord(stateDir, id);
      const spend = runSpend(stateDir, rec ?? { runId: id }, runUsd);
      usd += spend.usd;
      known &&= spend.known;
    }
    usd += await decisionSpend(engineDir, { repo: s.repo, ids: [s.id], from: new Date(0), to: now, unknownUsd });
    rows.push({ state: s, usd, known });
  }
  return rows;
}

/** Append `e` to `<engineDir>/events.jsonl` (0600, the dir 0700), one JSON line. */
export async function appendEvent(engineDir: string, e: StatusEvent): Promise<void> {
  await mkdir(engineDir, { recursive: true, mode: 0o700 });
  const file = join(engineDir, "events.jsonl");
  await appendFile(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** The state cell: the phase, the verdict, and the first reason (a code span), with how many more. */
function stateCell(s: WorkOrderState): string {
  let text = s.phase;
  if (s.verdict !== undefined) text += `: ${VERDICT_TEXT[s.verdict]}`;
  if (s.reasons.length > 0) text += ` (${codeSpan(s.reasons[0]!, 300)}${s.reasons.length > 1 ? `, and ${s.reasons.length - 1} more` : ""})`;
  return cell(text);
}

/** The rows as a Markdown table: the work order, its state, its last run, its PR, its rounds and its cost. */
export function statusTable(rows: StatusRow[]): string {
  const lines = ["| Work order | State | Run | PR | Rounds | Cost |", "|---|---|---|---|---|---|"];
  for (const { state: s, usd, known } of rows) {
    const run = s.runs.at(-1);
    const rounds = `${s.autoRounds} automatic, ${s.reworkRounds} rework${s.retry >= 1 ? `, retry ${s.retry}` : ""}`;
    const cost = known ? usd2(usd) : `${usd2(usd)} (budget: spend unknown)`;
    lines.push(`| ${codeSpan(s.id, 100)} | ${stateCell(s)} | ${run === undefined ? "—" : codeSpan(run, 20)} | ${s.pr === undefined ? "—" : `#${s.pr}`} | ${rounds} | ${cost} |`);
  }
  return lines.join("\n");
}

/** The rows' total. */
export const totalOf = (rows: StatusRow[]): number => rows.reduce((n, r) => n + r.usd, 0);

/** The line under the table when decision models aren't `enforce`: off and notes are never silent. */
export function modelsLine(models: DecisionModels): string | undefined {
  if (models === "off") return "Decision models are off (gates.decisions.mode: off): the harvester asks no decide() question, so none holds or notes a PR here.";
  if (models === "notes") return "Decision models give notes only (gates.decisions.mode: notes): none holds a PR here.";
  return undefined;
}

/**
 * The status comment's body: the hidden marker, the rows' table (left out when there is none), the "Can't run" table
 * for `problems`, the plan's total against `caps` (the repo's month, with its overlay; the day, for all repos), and the
 * decision-models line (`models`: the central `gates.decisions.mode`).
 */
export function renderStatus(rows: StatusRow[], caps: { monthlyUsd: number; dailyUsd: number }, problems: DiscoverProblem[], models: DecisionModels): string {
  const lines = [MARKER, "**hapi-factory: this plan's work orders**", ""];
  if (rows.length > 0) lines.push(statusTable(rows), "");
  if (problems.length > 0) {
    lines.push("**Can't run** (fix each in a new planning PR)", "| Work order file | Why |", "|---|---|");
    for (const p of problems) lines.push(`| ${cell(codeSpan(p.path, 120))} | ${cell(codeSpan(p.reason, 300))} |`);
    lines.push("");
  }
  lines.push(
    `Total: ${usd2(totalOf(rows))}, against this repo's cap of ${usd2(caps.monthlyUsd)} a month and ${usd2(caps.dailyUsd)} a day for all repos. The poller edits this comment in place; \`hapi status\` shows the same.`,
  );
  const m = modelsLine(models);
  if (m !== undefined) lines.push("", m);
  return lines.join("\n");
}

/**
 * The final comment, once every work order of the plan has settled and no problem is open. It carries no
 * decision-models line: the status comment, which every tick still renders and edits after the plan settles, does,
 * and so does each factory PR's body.
 */
export function renderFinal(rows: StatusRow[]): string {
  const n = (p: Phase) => rows.filter((r) => r.state.phase === p).length;
  return `${FINAL_MARKER}\nThis plan has settled: ${n("merged")} merged, ${n("closed")} closed, ${n("failed")} failed. Total: ${usd2(totalOf(rows))}.`;
}

/** Whether `rows` is a plan that has settled: at least one row, and every one in a settled phase. */
export const settledRows = (rows: StatusRow[]): boolean => rows.length > 0 && rows.every((r) => SETTLED.includes(r.state.phase));

/** The mark at `file`, or undefined when there is none. Anything else there throws: a lost id would post a second comment. */
export async function readMark(file: string): Promise<StatusMark | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    m = undefined;
  }
  const r = m as Partial<StatusMark> | null | undefined;
  const ok =
    r !== null &&
    typeof r === "object" &&
    !Array.isArray(r) &&
    Object.keys(r).every((k) => k === "commentId" || k === "sha256" || k === "final") &&
    Number.isSafeInteger(r.commentId) &&
    (r.commentId as number) >= 1 &&
    typeof r.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    typeof r.final === "boolean";
  if (!ok) throw new Error(`${file} is not a status mark: remove it, and the next tick posts a new status comment on the planning PR`);
  return r as StatusMark;
}

/** Write `m` whole to `file` (a temp file renamed into place), 0600, the dirs this call makes 0700. */
async function writeMark(file: string, m: StatusMark): Promise<void> {
  const made = await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (made !== undefined) for (let d = dirname(file); d.length >= made.length; d = dirname(d)) await chmod(d, 0o700);
  await writeWhole(file, `${JSON.stringify(m)}\n`);
}

/** A comment the factory's App posted. */
const ours = (c: IssueComment) => c.viaApp && c.userType === "Bot" && c.userLogin === FACTORY_BOT;

/**
 * The PR's status comment found again, or posted (`created`): the newest the factory's App posted that starts with the
 * marker is adopted (`adopted`), and edited to `body` when it differs (`edited`); `final` is whether the App has posted
 * a final comment there. The mark is written at once.
 */
async function adoptOrCreate(f: Forge, planningPr: number, body: string, file: string, actions: string[]): Promise<StatusMark> {
  const mine = (await f.issueComments(planningPr)).filter(ours);
  const found = mine.filter((c) => c.body.startsWith(MARKER)).sort((a, b) => b.id - a.id)[0];
  const final = mine.some((c) => c.body.startsWith(FINAL_MARKER));
  if (found === undefined) {
    const mark = { commentId: await f.createComment(planningPr, body), sha256: sha256(body), final };
    await writeMark(file, mark);
    actions.push("created");
    return mark;
  }
  let mark: StatusMark = { commentId: found.id, sha256: sha256(found.body), final };
  await writeMark(file, mark);
  actions.push("adopted");
  if (mark.sha256 !== sha256(body)) {
    await f.editComment(found.id, body);
    mark = { ...mark, sha256: sha256(body) };
    await writeMark(file, mark);
    actions.push("edited");
  }
  return mark;
}

/**
 * The planning PR's status comment: created once (`created`), or found again when the mark is missing (`adopted`),
 * then edited in place only when `body` changes (`edited`); a comment someone deleted (its edit a 404) is found again
 * or posted anew. `settled` is "there is a row, and every row is settled"; `finalBody` is the final comment, undefined
 * while a problem is open. Settled with a final body and no final comment yet posts it (`final`); not settled with one
 * posted marks the plan open again (`reopened`, no forge call), so the next settling posts another. Settled with a
 * problem open leaves the mark as it is. `forge` is called only when it must read or write, so a tick with nothing to
 * change mints no token. Returns the actions taken, in order. The mark is written after each write.
 */
export async function upsertStatusComment(forge: () => Promise<Forge>, planningPr: number, body: string, finalBody: string | undefined, file: string, settled: boolean): Promise<string[]> {
  const actions: string[] = [];
  let mark = await readMark(file);
  const sha = sha256(body);
  if (mark === undefined) {
    mark = await adoptOrCreate(await forge(), planningPr, body, file, actions);
  } else if (mark.sha256 !== sha) {
    const f = await forge();
    try {
      await f.editComment(mark.commentId, body);
      mark = { ...mark, sha256: sha };
      await writeMark(file, mark);
      actions.push("edited");
    } catch (e) {
      if (!(e instanceof ForgeError && e.status === 404)) throw e;
      // Deleted on GitHub: the mark names nothing. Find the comment again, or post it anew.
      await rm(file, { force: true });
      mark = await adoptOrCreate(f, planningPr, body, file, actions);
    }
  }
  if (settled && finalBody !== undefined && !mark.final) {
    await (await forge()).createComment(planningPr, finalBody);
    mark = { ...mark, final: true };
    await writeMark(file, mark);
    actions.push("final");
  } else if (!settled && mark.final) {
    mark = { ...mark, final: false };
    await writeMark(file, mark);
    actions.push("reopened");
  }
  return actions;
}
