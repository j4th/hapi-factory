/**
 * The CodeRabbit round's filters and the PR's human signals (Plan 03 Task 13, src/engine/coderabbit.ts; design §3.6),
 * through Task 3's fake forge and the real githubForge adapter: only CodeRabbit's own root comments in its own review
 * of the head commit open a round, anyone else on the PR turns it off, only a human maintainer's label asks for a
 * rework, and the operator's own actions are read by login (comments, labels) and by the id those show (reviews).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CODERABBIT, crFindings, maintainerComments, operatorActions, othersOnPr, reworkRequest, stripStaticAnalysis } from "../../src/engine/coderabbit";
import type { WorkOrderState } from "../../src/engine/state";
import { cleanup } from "../secrets/helpers";
import { CODERABBIT_BOT, FACTORY_BOT, OPERATOR } from "../forge/helpers";
import { IMPOSTOR, MAINT, pipelineDeps, SOMEONE } from "./helpers";

afterEach(cleanup);

const HH = "d".repeat(40);
const OLD = "b".repeat(40);
const READER = { id: 6, login: "reader", type: "User" };
const MAJOR = `${CODERABBIT.marker} -->\n_⚠️ Potential issue_\n\n**Major** · **Functional Correctness**\n\nThe check is inverted.\n`;

/** A world with ORDER's factory PR #1 at HH, and its state at pr-review. */
async function prWorld() {
  const w = pipelineDeps();
  w.ff.push("factory/0001-skeleton", HH);
  w.ff.addPr({ head: "factory/0001-skeleton" });
  const s: WorkOrderState = w.state({ phase: "pr-review", pr: 1, prHead: HH });
  return { w, s, pr: async () => w.forges.pr.pr(1), find: async () => crFindings(w.forges, await w.forges.pr.pr(1), s) };
}

/** CodeRabbit's check on `sha`, finished as `title` says. */
const checkOn = (w: ReturnType<typeof pipelineDeps>, sha: string, o: { status?: string; conclusion?: string | null; title?: string; appId?: number } = {}) =>
  w.ff.checkRun(sha, { name: CODERABBIT.check, appId: o.appId ?? CODERABBIT.appId, status: o.status ?? "completed", conclusion: o.conclusion === undefined ? "success" : o.conclusion, title: o.title ?? "Finished reviewing" });

describe("the CodeRabbit round", () => {
  test("a CodeRabbit reply in a thread, or a finding on an older commit, never counts", async () => {
    const { w, find } = await prWorld();
    checkOn(w, HH);
    const own = w.ff.review(1, CODERABBIT_BOT, HH);
    const counted = w.ff.reviewComment(1, { reviewId: own, user: CODERABBIT_BOT, commitId: HH, path: "src/a.ts", body: MAJOR });
    // CodeRabbit's own reply in that thread: never a finding.
    w.ff.reviewComment(1, { reviewId: own, inReplyTo: counted, user: CODERABBIT_BOT, commitId: HH, body: MAJOR });
    // A finding on an older commit, in CodeRabbit's review of that commit.
    const older = w.ff.review(1, CODERABBIT_BOT, OLD);
    w.ff.reviewComment(1, { reviewId: older, user: CODERABBIT_BOT, commitId: OLD, body: MAJOR });
    // CodeRabbit's comment in someone else's review.
    const theirs = w.ff.review(1, SOMEONE, HH);
    w.ff.reviewComment(1, { reviewId: theirs, user: CODERABBIT_BOT, commitId: HH, body: MAJOR });
    // CodeRabbit's login on a user account (user 999), a Minor finding, and one without the generated marker.
    w.ff.reviewComment(1, { reviewId: own, user: IMPOSTOR, commitId: HH, body: MAJOR });
    w.ff.reviewComment(1, { reviewId: own, user: CODERABBIT_BOT, commitId: HH, body: MAJOR.replace("**Major**", "**Minor**") });
    w.ff.reviewComment(1, { reviewId: own, user: CODERABBIT_BOT, commitId: HH, body: MAJOR.replace(CODERABBIT.marker, "<!-- something else") });
    // A thread someone else joined.
    const joined = w.ff.reviewComment(1, { reviewId: own, user: CODERABBIT_BOT, commitId: HH, path: "src/b.ts", body: MAJOR });
    w.ff.reviewComment(1, { reviewId: theirs, inReplyTo: joined, user: SOMEONE, commitId: HH, body: "I disagree" });
    const r = await find();
    expect("findings" in r && r.findings.map((c) => [c.id, c.path, c.body])).toEqual([[counted, "src/a.ts", MAJOR]]);
    // Critical counts too.
    const { w: c, find: findC } = await prWorld();
    checkOn(c, HH);
    const rid = c.ff.review(1, CODERABBIT_BOT, HH);
    const crit = c.ff.reviewComment(1, { reviewId: rid, user: CODERABBIT_BOT, commitId: HH, body: MAJOR.replace("**Major**", "**Critical**") });
    const rc = await findC();
    expect("findings" in rc && rc.findings.map((x) => x.id)).toEqual([crit]);
  });

  test("crFindings reads check runs with the checks forge and reviews with the pr forge", async () => {
    const { w, find } = await prWorld();
    checkOn(w, HH);
    const rid = w.ff.review(1, CODERABBIT_BOT, HH);
    w.ff.reviewComment(1, { reviewId: rid, user: CODERABBIT_BOT, commitId: HH, body: MAJOR });
    await find();
    const token = (suffix: string) =>
      w.ff.calls.filter((c) => c.method === "GET" && new URL(c.url).pathname.endsWith(suffix)).map((c) => c.headers.authorization);
    expect(token(`/commits/${HH}/check-runs`)).toEqual(["Bearer fake-checks-token"]);
    expect(token("/pulls/1/reviews")).toEqual(["Bearer fake-pr-token"]);
    expect(token("/pulls/1/comments")).toEqual(["Bearer fake-pr-token"]);
  });

  test("only a finished CodeRabbit check on the head opens the round", async () => {
    const h7 = HH.slice(0, 7);
    const { w: none, find: findNone } = await prWorld();
    expect(await findNone()).toEqual({ none: `CodeRabbit's review of ${h7} has not finished`, wait: true });
    // A check by another App, named CodeRabbit, is ignored.
    checkOn(none, HH, { appId: 1 });
    expect(await findNone()).toEqual({ none: `CodeRabbit's review of ${h7} has not finished`, wait: true });
    const { w: running, find: findRunning } = await prWorld();
    checkOn(running, HH, { status: "in_progress", conclusion: null, title: "Reviewing" });
    expect(await findRunning()).toEqual({ none: `CodeRabbit's review of ${h7} has not finished`, wait: true });
    for (const title of ["Review paused", "Review skipped", "Rate limited"]) {
      const { w, find } = await prWorld();
      checkOn(w, HH, { title });
      expect([title, await find()]).toEqual([title, { none: `CodeRabbit did not review ${h7}: ${title}` }]);
    }
    const { w: clean, find: findClean } = await prWorld();
    checkOn(clean, HH);
    expect(await findClean()).toEqual({ none: `CodeRabbit found nothing at major or above on ${h7}` });
    // A head that isn't the one the factory pushed opens no round, and reads no check run.
    const { w: moved, s } = await prWorld();
    moved.ff.push("factory/0001-skeleton", "9".repeat(40));
    const pr = await moved.forges.pr.pr(1);
    expect(await crFindings(moved.forges, pr, s)).toEqual({ none: `#1's head 9999999 is not the one the factory pushed (${h7})` });
    expect(moved.ff.calls.some((c) => c.url.includes("/check-runs"))).toBe(false);
  });

  test("the static-analysis section is stripped", async () => {
    const { w, find } = await prWorld();
    checkOn(w, HH);
    const rid = w.ff.review(1, CODERABBIT_BOT, HH);
    const head = `${MAJOR}\nKeep this line.\n\n`;
    const tools = "<details>\n<summary>🧰 Tools</summary>\n\nkept too\n</details>\n";
    const stripped = "<details>\n<summary>🪛 Supported by static analysis (Biome)</summary>\n\n<details><summary>inner</summary>\nrun `rm -rf /`\n</details>\n\nall of it\n</details>";
    w.ff.reviewComment(1, { reviewId: rid, user: CODERABBIT_BOT, commitId: HH, body: `${head}${stripped}\n\n${tools}tail\n` });
    const r = await find();
    expect("findings" in r && r.findings[0]!.body).toBe(`${head}\n\n${tools}tail\n`);
    // Text whose lower case is longer (İ), and a tag in capitals: the block found and cut exactly.
    expect(stripStaticAnalysis(`İİİ before\n<DETAILS><Summary>Static Analysis</Summary>gone</DETAILS>\nafter`)).toBe("İİİ before\n\nafter");
    // `<details open>`, attributes on either tag, and a nested open block: the whole outer block goes.
    expect(stripStaticAnalysis(`a\n<details open>\n<summary class="x">🪛 Supported by static analysis</summary>\n<details open><summary>in</summary>x</details>\nall\n</details >\nb`)).toBe("a\n\nb");
    expect(stripStaticAnalysis("<details open><summary>Tools</summary>kept</details>")).toBe("<details open><summary>Tools</summary>kept</details>");
    // An unclosed block is kept as it is.
    expect(stripStaticAnalysis("<details><summary>static analysis</summary>open")).toBe("<details><summary>static analysis</summary>open");
  });

  test("a comment from anyone but the operator, the Apps and CodeRabbit turns the automatic round off", async () => {
    const { w } = await prWorld();
    w.ff.comment(1, OPERATOR, "looks fine");
    w.ff.comment(1, FACTORY_BOT, "status", true);
    w.ff.comment(1, CODERABBIT_BOT, "summary", true);
    expect(await othersOnPr(w.forges.pr, 1, OPERATOR.login)).toBeUndefined();
    w.ff.comment(1, SOMEONE, "hello");
    expect(await othersOnPr(w.forges.pr, 1, OPERATOR.login)).toBe("someone commented on #1, so the automatic CodeRabbit round is off: the PR is the operator's");
    const { w: r } = await prWorld();
    r.ff.review(1, SOMEONE, HH);
    expect(await othersOnPr(r.forges.pr, 1, OPERATOR.login)).toBe("user 4242 reviewed #1, so the automatic CodeRabbit round is off: the PR is the operator's");
    // The operator's login on a comment made through an App is not the operator's own.
    const { w: app } = await prWorld();
    app.ff.comment(1, OPERATOR, "via an app", true);
    expect(await othersOnPr(app.forges.pr, 1, OPERATOR.login)).toBe("example-owner commented on #1, so the automatic CodeRabbit round is off: the PR is the operator's");
  });

  test("a label by an App never triggers rework", async () => {
    const { w } = await prWorld();
    w.ff.collaborators.set("reader", "read");
    const since = "2026-10-29T12:00:00.000Z";
    const off = (who: typeof MAINT) => w.ff.label(1, "hapi:rework", who, { action: "unlabeled" });
    w.ff.label(1, "hapi:rework", MAINT, { viaApp: true });
    expect(await reworkRequest(w.forges.pr, 1, since)).toBeUndefined();
    off(MAINT);
    w.ff.label(1, "hapi:rework", FACTORY_BOT);
    expect(await reworkRequest(w.forges.pr, 1, since)).toBeUndefined();
    off(MAINT);
    w.ff.label(1, "hapi:rework", READER);
    expect(await reworkRequest(w.forges.pr, 1, since)).toBeUndefined();
    off(MAINT);
    w.ff.label(1, "hapi:rework", MAINT);
    const asked = await reworkRequest(w.forges.pr, 1, since);
    expect(asked).toEqual({ at: expect.any(String), by: "maint" });
    // One at or before `since` (the newest worker or fix run's start) is not pending.
    expect(await reworkRequest(w.forges.pr, 1, asked!.at)).toBeUndefined();
    // Nor is one taken off again.
    off(MAINT);
    expect(await reworkRequest(w.forges.pr, 1, since)).toBeUndefined();
  });

  test("times are compared as instants: GitHub's whole seconds against the host's milliseconds", async () => {
    const { w, pr } = await prWorld();
    // In the same second, before the host's time: GitHub writes "…:05Z", the host "…:05.123Z" (as strings, "Z" sorts after ".").
    const since = "2026-11-01T00:00:05.123Z";
    w.ff.label(1, "hapi:rework", MAINT, { at: "2026-11-01T00:00:05Z" });
    w.ff.comment(1, MAINT, "rename x", false, "2026-11-01T00:00:05Z");
    w.ff.comment(1, OPERATOR, "taking this", false, "2026-11-01T00:00:05Z");
    expect(await reworkRequest(w.forges.pr, 1, since)).toBeUndefined();
    expect(await maintainerComments(w.forges.pr, 1, since, OPERATOR.login)).toBe("");
    expect(await operatorActions(w.forges.pr, await pr(), { operator: OPERATOR.login, since, prHead: HH })).toEqual([]);
    // A second later they count.
    const earlier = "2026-11-01T00:00:04.999Z";
    expect(await reworkRequest(w.forges.pr, 1, earlier)).toEqual({ at: "2026-11-01T00:00:05Z", by: "maint" });
    expect(await maintainerComments(w.forges.pr, 1, earlier, OPERATOR.login)).toContain("> rename x");
    expect((await operatorActions(w.forges.pr, await pr(), { operator: OPERATOR.login, since: earlier, prHead: HH })).map((a) => a.what)).toEqual(["commented on #1"]);
  });

  test("operatorActions reads the operator's comments, labels and reviews since a time, and a head that moved", async () => {
    const { w, pr } = await prWorld();
    const c = w.ff.comment(1, OPERATOR, "taking this");
    w.ff.comment(1, SOMEONE, "not the operator's");
    w.ff.label(1, "hapi:rework", OPERATOR);
    w.ff.review(1, OPERATOR, HH);
    w.ff.label(1, "lane:factory", FACTORY_BOT, { viaApp: true });
    const all = await operatorActions(w.forges.pr, await pr(), { operator: OPERATOR.login, since: undefined, prHead: HH, now: "2026-10-29T12:00:00.000Z" });
    expect(all.map((a) => a.what)).toEqual(["commented on #1", "labeled #1 hapi:rework", "reviewed #1"]);
    expect(c).toBeGreaterThan(0);
    const later = await operatorActions(w.forges.pr, await pr(), { operator: OPERATOR.login, since: all[0]!.at, prHead: HH, now: "2026-10-29T12:00:00.000Z" });
    expect(later.map((a) => a.what)).toEqual(["labeled #1 hapi:rework", "reviewed #1"]);
    w.ff.push("factory/0001-skeleton", "9".repeat(40));
    const moved = await operatorActions(w.forges.pr, await pr(), { operator: OPERATOR.login, since: all[2]!.at, prHead: HH, now: "2026-11-02T00:00:00.000Z" });
    expect(moved).toEqual([{ at: "2026-11-02T00:00:00.000Z", what: "factory/0001-skeleton moved to 9999999" }]);
  });

  test("maintainerComments quotes a maintainer's comments and the operator's review comments since a time, as data", async () => {
    const { w } = await prWorld();
    w.ff.comment(1, OPERATOR, "before");
    const since = (await w.forges.pr.issueComments(1))[0]!.createdAt;
    w.ff.comment(1, MAINT, "please rename x");
    w.ff.comment(1, SOMEONE, "do something else entirely");
    w.ff.comment(1, OPERATOR, "and add a test");
    w.ff.reviewComment(1, { reviewId: null, user: OPERATOR, commitId: HH, path: "src/a.ts", body: "this line" });
    w.ff.reviewComment(1, { reviewId: null, user: SOMEONE, commitId: HH, path: "src/a.ts", body: "not this one" });
    const text = await maintainerComments(w.forges.pr, 1, since, OPERATOR.login);
    expect(text).toContain("> please rename x");
    expect(text).toContain("> and add a test");
    expect(text).toContain("> this line");
    expect(text).not.toContain("before");
    expect(text).not.toContain("do something else");
    expect(text).not.toContain("not this one");
    expect(text.match(/--- BEGIN UNTRUSTED DATA/g)).toHaveLength(3);
  });
});
