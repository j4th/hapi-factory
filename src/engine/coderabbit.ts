/**
 * The CodeRabbit round on a factory PR and the PR's human signals (design §3.4, §3.6; Plan 03 Task 13), read through
 * the forge as data:
 *
 * - **`crFindings`**: only CodeRabbit's own review of the head commit the factory pushed opens the one automatic
 *   round. The head counts as reviewed only when CodeRabbit's check run (`CODERABBIT.check`, app
 *   `CODERABBIT.appId`) on it is completed, `success` and titled `Finished…`; any other title (paused, skipped,
 *   rate-limited) is named and fails closed. A finding is a root review comment (`inReplyTo` null) by CodeRabbit's
 *   bot user (`CODERABBIT.userId`, never matched by login) on the head, in a review CodeRabbit submitted on that
 *   commit, carrying its generated-comment marker and a first bold span whose word is Critical or Major
 *   (`severityOf`), in a thread no one else replied in. With no such finding, a comment whose severity can't be
 *   read is named, never taken for a clean review. Its "Supported by static analysis" sections are stripped. Check runs are read with the
 *   `checks` token, reviews with the `pr` token (Task 3's tokens split them).
 * - **`othersOnPr`**: a comment or review from anyone but the operator, hapi's Apps and CodeRabbit turns the
 *   automatic round off: the PR is the operator's.
 * - **`operatorActions`**: the operator's comments and labels (by login, `type: "User"`, not through an App), their
 *   reviews (by the user id those show: a review carries no login), and a head the factory didn't push.
 * - **`reworkRequest`**: a `hapi:rework` label added by a human (`type: "User"`, not through an App, no `[bot]`
 *   login) with at least triage permission, after `since`, and not taken off again.
 * - **`maintainerComments`**: what a rework is given: maintainers' issue comments and the operator's review
 *   comments, each in IS-7's wrapper (`quoteUntrusted`).
 *
 * The factory never @-mentions CodeRabbit, ticks its boxes, replies to or resolves its threads: nothing here writes.
 */
import type { Forge, IssueComment, LabelEvent, PrInfo, ReviewComment } from "../forge";
import { APPS } from "../forge/github/app-token";
import { CODERABBIT as CODERABBIT_IDS } from "../forge/github/forge";
import { sanitizeTerminal } from "../run/sanitize";
import { quoteUntrusted } from "./evidence";
import type { WorkOrderState } from "./state";

/** CodeRabbit's ids (Task 3's), its check run's name, and the marker its generated comments start with. */
export const CODERABBIT = { ...CODERABBIT_IDS, check: "CodeRabbit", marker: "<!-- coderabbit-ai-generated" } as const;

/** crFindings' `none` when CodeRabbit reviewed the head and found nothing at major or above: the round has nothing to fix. */
export const CR_CLEAN = "CodeRabbit found nothing at major or above on";

/** hapi's two Apps' bot logins: no user can hold a `[bot]` login. */
const APP_LOGINS: readonly string[] = [`${APPS.factory.name}[bot]`, `${APPS.planner.name}[bot]`];
/** The permissions that may ask for a rework. */
const MAINTAINERS = new Set(["admin", "maintain", "write", "triage"]);
const REWORK = "hapi:rework";

const h7 = (sha: string) => sha.slice(0, 7);
/**
 * Whether time `a` is after `b`, as instants: GitHub gives whole seconds (`…:05Z`) and the host milliseconds
 * (`…:05.123Z`), and as strings `"…05Z" > "…05.123Z"`. A time that doesn't parse is never after anything.
 */
export const later = (a: string, b: string): boolean => {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x > y;
};
/** Oldest first, as instants. */
const byTime = (a: string, b: string) => (Date.parse(a) || 0) - (Date.parse(b) || 0);
/** A login or title for one line of host text: printable, no `@ < > \``, at most 80 characters. */
const shown = (s: string) => {
  const t = sanitizeTerminal(s.replace(/[\r\n\t]/g, " ")).replace(/[@<>`]/g, "").trim();
  return t.length > 80 ? `${t.slice(0, 79)}…` : t || "(none)";
};

/** The operator's own: their login, as a User, not through an App. */
const byOperator = (u: { login: string; type: string; viaApp: boolean }, operator: string) => u.type === "User" && !u.viaApp && u.login === operator;
const commenter = (c: IssueComment) => ({ login: c.userLogin, type: c.userType, viaApp: c.viaApp });
const actor = (e: LabelEvent) => ({ login: e.actor.login, type: e.actor.type, viaApp: e.viaApp });

/** The user ids the operator's own comments and label events on PR `n` show: a review carries only an id. */
async function operatorIds(forge: Forge, n: number, operator: string, comments?: IssueComment[], events?: LabelEvent[]): Promise<Set<number>> {
  const ids = new Set<number>();
  for (const c of comments ?? (await forge.issueComments(n))) if (byOperator(commenter(c), operator)) ids.add(c.userId);
  for (const e of events ?? (await forge.labelEvents(n))) if (byOperator(actor(e), operator)) ids.add(e.actor.id);
  return ids;
}

/** The severities CodeRabbit gives a finding. Only the first two open the automatic round. */
const SEVERITIES: readonly string[] = ["Critical", "Major", "Minor", "Trivial", "Info"];

/**
 * A comment's severity: the word of its first bold span, with any HTML in the span left out, if it is one of
 * CodeRabbit's. It writes `**Major** · **<category>**`, and since 2026-11 an icon before the word:
 * `**<picture>…</picture> Major** · **<category>** · **<effort>**` (H-309). Bold text further down, such as the
 * `**IMPORTANT**` of a note, is never the severity; a first span that names none reads as undefined, which
 * `crFindings` reports and never takes for a finding below major.
 */
function severityOf(body: string): string | undefined {
  const span = /\*\*((?:(?!\*\*)[^\n])+)\*\*/.exec(body)?.[1];
  const word = span?.replace(/<[^>]*>/g, "").trim();
  return word !== undefined && SEVERITIES.includes(word) ? word : undefined;
}

/**
 * `body` with every `<details>` block (`<details open>` and any attributes too) whose own `<summary>` holds "static
 * analysis" removed, nested blocks and all; the rest kept byte for byte. An unclosed block is kept as it is.
 */
export function stripStaticAnalysis(body: string): string {
  let out = body;
  // Case-insensitive patterns on the body itself: a lower-cased copy can differ in length, and its indexes with it.
  for (let from = 0; ; ) {
    const open = /<details(?:\s[^>]*)?>/gi;
    open.lastIndex = from;
    const first = open.exec(out);
    if (first === null) return out;
    const start = first.index;
    // The block's end: its matching </details>, counting the blocks nested in it.
    let depth = 0;
    let end = -1;
    const tag = /<details(?:\s[^>]*)?>|<\/details\s*>/gi;
    tag.lastIndex = start;
    for (let m = tag.exec(out); m !== null; m = tag.exec(out)) {
      depth += m[0][1] === "/" ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    if (end === -1) return out;
    const summary = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i.exec(out.slice(start + first[0].length, end));
    if (summary !== null && /static analysis/i.test(summary[1]!)) out = out.slice(0, start) + out.slice(end);
    else from = start + first[0].length;
  }
}

/**
 * CodeRabbit's findings on PR `pr`'s head, or why there are none (`wait`: its review of the head hasn't finished).
 * See the module comment. `forges.checks` reads the check runs, `forges.pr` the reviews and review comments.
 */
export async function crFindings(forges: { pr: Forge; checks: Forge }, pr: PrInfo, s: Pick<WorkOrderState, "prHead">): Promise<{ findings: ReviewComment[] } | { none: string; wait?: true }> {
  const head = pr.headSha;
  if (s.prHead === undefined || head !== s.prHead) return { none: `#${pr.number}'s head ${h7(head)} is not the one the factory pushed (${h7(s.prHead ?? "(none)")})` };
  const checks = (await forges.checks.checkRuns(head)).filter((c) => c.name === CODERABBIT.check && c.appId === CODERABBIT.appId && c.headSha === head);
  if (checks.length === 0 || checks.some((c) => c.status !== "completed")) return { none: `CodeRabbit's review of ${h7(head)} has not finished`, wait: true };
  const unreviewed = checks.find((c) => !(c.conclusion === "success" && /^Finished/.test(c.title ?? "")));
  if (unreviewed !== undefined) return { none: `CodeRabbit did not review ${h7(head)}: ${shown(unreviewed.title ?? `its check concluded ${unreviewed.conclusion ?? "nothing"}`)}` };
  const own = new Set((await forges.pr.reviews(pr.number)).filter((r) => r.userId === CODERABBIT.userId && r.commitId === head).map((r) => r.id));
  const comments = await forges.pr.reviewComments(pr.number);
  const joined = new Set(comments.filter((c) => c.inReplyTo !== null && c.userId !== CODERABBIT.userId).map((c) => c.inReplyTo));
  const roots = comments.filter(
    (c) => c.inReplyTo === null && c.userId === CODERABBIT.userId && c.commitId === head && c.reviewId !== null && own.has(c.reviewId) && c.body.startsWith(CODERABBIT.marker) && !joined.has(c.id),
  );
  const findings = roots.filter((c) => ["Critical", "Major"].includes(severityOf(c.body) ?? "")).map((c) => ({ ...c, body: stripStaticAnalysis(c.body) }));
  if (findings.length > 0) return { findings };
  // A comment whose severity can't be read may be a major one in a form CodeRabbit changed: the round says so, and
  // the work order waits for the operator, where a clean review would wait with nothing to say.
  const unread = roots.filter((c) => severityOf(c.body) === undefined).length;
  if (unread > 0) return { none: `CodeRabbit left ${unread} comment${unread === 1 ? "" : "s"} on ${h7(head)} whose severity hapi could not read: read ${unread === 1 ? "it" : "them"} on the PR` };
  return { none: `${CR_CLEAN} ${h7(head)}` };
}

/** Why anyone else on PR `n` turns the automatic round off, or undefined: see the module comment. */
export async function othersOnPr(forge: Forge, n: number, operator: string): Promise<string | undefined> {
  const comments = await forge.issueComments(n);
  const off = "so the automatic CodeRabbit round is off: the PR is the operator's";
  for (const c of comments) {
    if (byOperator(commenter(c), operator) || c.userId === CODERABBIT.userId || (c.userType === "Bot" && APP_LOGINS.includes(c.userLogin))) continue;
    return `${shown(c.userLogin)} commented on #${n}, ${off}`;
  }
  const mine = await operatorIds(forge, n, operator, comments);
  for (const r of await forge.reviews(n)) {
    if (r.userId === CODERABBIT.userId || mine.has(r.userId)) continue;
    return `user ${r.userId} reviewed #${n}, ${off}`;
  }
  for (const c of await forge.reviewComments(n)) {
    if (c.userId === CODERABBIT.userId || mine.has(c.userId)) continue;
    return `user ${c.userId} reviewed #${n}, ${off}`;
  }
  return undefined;
}

/**
 * The operator's actions on PR `pr` after `since` (all, when undefined), oldest first: comments, labels, reviews,
 * and the PR's head when it isn't `prHead` (timed `now`, the caller's clock: a push has no time on the PR).
 */
export async function operatorActions(forge: Forge, pr: PrInfo, o: { operator: string; since: string | undefined; prHead: string | undefined; now?: string }): Promise<{ at: string; what: string }[]> {
  const n = pr.number;
  const now = o.now ?? new Date().toISOString();
  // An action whose time doesn't parse still counts, timed now (D78): the operator wins, never a lost action.
  const add = (at: string, what: string) => {
    if (!Number.isFinite(Date.parse(at))) acts.push({ at: now, what });
    else if (o.since === undefined || later(at, o.since)) acts.push({ at, what });
  };
  const comments = await forge.issueComments(n);
  const events = await forge.labelEvents(n);
  const acts: { at: string; what: string }[] = [];
  for (const c of comments) if (byOperator(commenter(c), o.operator)) add(c.createdAt, `commented on #${n}`);
  for (const e of events) if (byOperator(actor(e), o.operator)) add(e.at, `${e.action} #${n} ${shown(e.label)}`);
  const mine = await operatorIds(forge, n, o.operator, comments, events);
  if (mine.size > 0) for (const r of await forge.reviews(n)) if (mine.has(r.userId) && r.submittedAt !== "") add(r.submittedAt, `reviewed #${n}`);
  acts.sort((a, b) => byTime(a.at, b.at));
  if (o.prHead !== undefined && pr.headSha !== o.prHead) acts.push({ at: now, what: `${shown(pr.headRef)} moved to ${h7(pr.headSha)}` });
  return acts;
}

/** A pending rework request on PR `n`: the latest `hapi:rework` label a human maintainer added after `since` and didn't take off. */
export async function reworkRequest(forge: Forge, n: number, since: string): Promise<{ at: string; by: string } | undefined> {
  const events = (await forge.labelEvents(n)).filter((e) => e.label === REWORK);
  const human = (e: LabelEvent) => e.actor.type === "User" && !e.viaApp && !e.actor.login.endsWith("[bot]");
  const permissions = new Map<string, boolean>();
  events.sort((a, b) => byTime(a.at, b.at));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (!later(e.at, since)) continue;
    if (e.action !== "labeled" || !human(e)) continue;
    // Taken off again since: withdrawn.
    if (events.slice(i + 1).some((x) => x.action === "unlabeled")) continue;
    if (!permissions.has(e.actor.login)) permissions.set(e.actor.login, MAINTAINERS.has(await forge.permission(e.actor.login)));
    if (permissions.get(e.actor.login)) return { at: e.at, by: shown(e.actor.login) };
  }
  return undefined;
}

/**
 * What a rework is given (spec §5.2): each issue comment on PR `n` after `since` by a human with at least triage
 * permission, and each review comment after it by the operator's user id, quoted as data. "" when there is none.
 */
export async function maintainerComments(forge: Forge, n: number, since: string, operator: string): Promise<string> {
  const comments = await forge.issueComments(n);
  const blocks: string[] = [];
  const permissions = new Map<string, boolean>();
  for (const c of comments) {
    if (!later(c.createdAt, since) || c.userType !== "User" || c.viaApp) continue;
    if (!permissions.has(c.userLogin)) permissions.set(c.userLogin, MAINTAINERS.has(await forge.permission(c.userLogin)));
    if (permissions.get(c.userLogin)) blocks.push(quoteUntrusted(`a maintainer's comment ${c.id} on #${n} by ${shown(c.userLogin)}`, c.body));
  }
  const mine = await operatorIds(forge, n, operator, comments);
  for (const c of await forge.reviewComments(n)) {
    if (!later(c.createdAt, since) || !mine.has(c.userId)) continue;
    blocks.push(quoteUntrusted(`the operator's review comment ${c.id} on ${shown(c.path)}`, c.body));
  }
  return blocks.join("\n\n");
}
