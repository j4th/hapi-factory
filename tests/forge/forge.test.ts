import { describe, expect, test } from "bun:test";
import { githubForge } from "../../src/forge/github/forge";
import { GITHUB_API as API } from "../../src/forge/github/rest";
import { CODERABBIT_BOT, fakeFetch, fakeForge, FACTORY_BOT, OPERATOR, STRANGER } from "./helpers";

const TOKEN = "fake-token-forge-31cd";
const SHA = "a".repeat(40);
const R = `${API}/repos/example-owner/hapi-sandbox`;
const setup = (o: Parameters<typeof fakeForge>[0] = {}) => {
  const ff = fakeForge(o);
  return { ff, forge: githubForge({ repo: ff.repo, token: TOKEN, fetch: ff.fetch }) };
};
const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};
const open = (forge: ReturnType<typeof setup>["forge"], head = "factory/0001-a") => forge.openPr({ head, base: "main", title: "t", body: "b", draft: true });

describe("githubForge over the fake forge", () => {
  test("findPr finds factory/<id>'s PR, an open one first, so a PR is never opened twice", async () => {
    const { ff, forge } = setup();
    expect(await forge.findPr("factory/0001-a")).toBeUndefined();
    ff.push("factory/0001-a", SHA);
    const pr = await open(forge);
    expect(pr).toEqual({ number: 1, state: "open", merged: false, draft: true, headSha: SHA, headRef: "factory/0001-a", baseRef: "main", body: "b", labels: [] });
    ff.calls.length = 0;
    expect(await forge.findPr("factory/0001-a")).toEqual(pr);
    expect(ff.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${R}/pulls?state=all&head=example-owner%3Afactory%2F0001-a&per_page=100`]);
    ff.prs.get(1)!.state = "closed";
    const second = ff.addPr({ head: "factory/0001-a" });
    expect((await forge.findPr("factory/0001-a"))!.number).toBe(second);
  });

  test("findPr with only a merged PR returns it with merged: true", async () => {
    const { ff, forge } = setup();
    ff.addPr({ head: "factory/0002-b", merged: true });
    const pr = await forge.findPr("factory/0002-b");
    expect(pr).toMatchObject({ number: 1, state: "closed", merged: true });
  });

  test("markReady posts the one GraphQL mutation, with the PR's node id, only for a draft", async () => {
    const { ff, forge } = setup();
    ff.push("factory/0001-a", SHA);
    await open(forge);
    ff.calls.length = 0;
    await forge.markReady(1);
    const post = ff.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${API}/graphql`);
    expect(post.body).toEqual({
      query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }",
      variables: { id: "PR_1" },
    });
    expect(ff.prs.get(1)!.draft).toBe(false);
    ff.calls.length = 0;
    await forge.markReady(1);
    expect(ff.calls.map((c) => c.method)).toEqual(["GET"]);
    const bad = githubForge({
      repo: ff.repo,
      token: TOKEN,
      fetch: fakeFetch({
        [`GET ${R}/pulls/1`]: { status: 200, body: { node_id: "PR_1", draft: true } },
        [`POST ${API}/graphql`]: { status: 200, body: { errors: [{ message: "x" }] } },
      }).fetch,
    });
    expect((await caught(bad.markReady(1))).message).toBe("GitHub: POST /graphql: x");
  });

  test("writes send exactly GitHub's bodies", async () => {
    const { ff, forge } = setup();
    ff.push("factory/0001-a", SHA);
    await open(forge);
    ff.calls.length = 0;
    await forge.editPrBody(1, "new");
    await forge.addLabels(1, ["lane:factory", "hapi:flagged"]);
    expect(await forge.createComment(1, "s")).toBe(1000);
    await forge.editComment(1000, "s2");
    const sent = ff.calls.map((c) => [c.method, c.url, c.body]);
    expect(sent).toEqual([
      ["PATCH", `${R}/pulls/1`, { body: "new" }],
      ["POST", `${R}/issues/1/labels`, { labels: ["lane:factory", "hapi:flagged"] }],
      ["POST", `${R}/issues/1/comments`, { body: "s" }],
      ["PATCH", `${R}/issues/comments/1000`, { body: "s2" }],
    ]);
    expect(ff.prs.get(1)!.labels).toEqual(["lane:factory", "hapi:flagged"]);
    expect((await forge.pr(1)).body).toBe("new");
  });

  test("comments and label events carry the actor's id, login and type, and whether an App acted", async () => {
    const { ff, forge } = setup();
    ff.addPr({ head: "factory/0001-a" });
    ff.comment(1, STRANGER, "hi");
    ff.label(1, "hapi:rework", OPERATOR);
    await forge.addLabels(1, ["hapi:flagged"]);
    expect(await forge.issueComments(1)).toEqual([
      { id: 1000, userId: 2, userLogin: "example-stranger", userType: "User", viaApp: false, body: "hi", createdAt: "2026-11-01T00:00:01.000Z" },
    ]);
    expect(await forge.labelEvents(1)).toEqual([
      { action: "labeled", label: "hapi:rework", actor: { id: 1, login: "example-owner", type: "User" }, viaApp: false, at: "2026-11-01T00:00:02.000Z" },
      { action: "labeled", label: "hapi:flagged", actor: { id: 3, login: "hapi-factory[bot]", type: "Bot" }, viaApp: true, at: "2026-11-01T00:00:03.000Z" },
    ]);
    expect(FACTORY_BOT.id).toBe(3);
  });

  test("reviews and review comments keep their review, reply-to and commit; check runs come out of check_runs", async () => {
    const { ff, forge } = setup();
    ff.addPr({ head: "factory/0001-a" });
    const rv = ff.review(1, CODERABBIT_BOT, SHA);
    const root = ff.reviewComment(1, { reviewId: rv, user: CODERABBIT_BOT, commitId: SHA, body: "root" });
    const reply = ff.reviewComment(1, { reviewId: rv, inReplyTo: root, user: STRANGER, commitId: SHA, body: "reply" });
    const reviews = await forge.reviews(1);
    expect(reviews).toEqual([{ id: rv, userId: CODERABBIT_BOT.id, commitId: SHA, state: "COMMENTED", submittedAt: "2026-11-01T00:00:01.000Z" }]);
    const rcs = await forge.reviewComments(1);
    expect(rcs.map((c) => [c.id, c.reviewId, c.inReplyTo])).toEqual([
      [root, rv, null],
      [reply, rv, root],
    ]);
    ff.checkRun(SHA, { name: "CodeRabbit", appId: 347564, status: "completed", conclusion: "success", title: "Review completed", summary: "s" });
    ff.calls.length = 0;
    expect(await forge.checkRuns(SHA)).toEqual([
      { name: "CodeRabbit", appId: 347564, headSha: SHA, status: "completed", conclusion: "success", title: "Review completed", summary: "s" },
    ]);
    expect(ff.calls[0]!.url).toBe(`${R}/commits/${SHA}/check-runs?per_page=100`);
  });

  test("permission reads role_name, so triage and maintain are seen, and anyone GitHub doesn't know is none", async () => {
    const { ff, forge } = setup();
    ff.collaborators.set("t", "triage");
    ff.collaborators.set("m", "maintain");
    ff.collaborators.set("w", "write");
    expect(await forge.permission("t")).toBe("triage");
    expect(await forge.permission("m")).toBe("maintain");
    expect(await forge.permission("w")).toBe("write");
    expect(await forge.permission("nobody")).toBe("none");
  });

  test("repoInfo reads private and default_branch", async () => {
    const { forge } = setup({ private: true });
    expect(await forge.repoInfo()).toEqual({ private: true, defaultBranch: "main" });
  });

  test("a list longer than a page is read whole", async () => {
    const { ff, forge } = setup({ pageSize: 2 });
    ff.addPr({ head: "factory/0001-a" });
    for (let i = 0; i < 5; i++) ff.comment(1, STRANGER, `c${i}`);
    ff.calls.length = 0;
    expect(await forge.issueComments(1)).toHaveLength(5);
    expect(ff.calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  test("failNext fails the next matching call once", async () => {
    const { ff, forge } = setup();
    ff.failNext("GET", "/repos/example-owner/hapi-sandbox/pulls", 500);
    expect((await caught(forge.findPr("factory/x"))).message).toContain("HTTP 500");
    expect(await forge.findPr("factory/x")).toBeUndefined();
  });

  test("an item missing a field fails the read rather than passing a partial record", async () => {
    const forge = githubForge({
      repo: "example-owner/hapi-sandbox",
      token: TOKEN,
      fetch: fakeFetch({
        [`GET ${R}/issues/1/comments?per_page=100`]: { status: 200, body: [{ id: 5, body: "x", created_at: "2026-11-01T00:00:01Z" }] },
      }).fetch,
    });
    expect((await caught(forge.issueComments(1))).message).toBe("GitHub: GET /repos/example-owner/hapi-sandbox/issues/1/comments: an item has no user.id");
  });
});
