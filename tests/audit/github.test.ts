/**
 * github.rulesets, github.app-perms and repo.ai-workflows, per --repo,
 * against a fake GitHub (./helpers.ts, `githubRoutes`): GET requests only,
 * plus minting the audit's own read-only App token and revoking it. No
 * token is ever printed. The rulesets are docs/runbooks/github-apps.md's,
 * the same ones tests/docs/rulesets.test.ts holds the README's JSON to.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { API, APP_IDS, cleanup, cleanWorld, FIXTURES, githubRoutes, goodRulesets, hostEnv, NAME, only, OWNER } from "./helpers";

afterEach(cleanup);

type World = Awaited<ReturnType<typeof cleanWorld>>;
const TOKEN = "fake-operator-token-1f2e";
const workflow = (name: string) => readFileSync(join(FIXTURES, "workflows", name), "utf8");

/** A world with --repo, an operator token file, and these rulesets and workflows. */
async function withToken(o: Parameters<typeof githubRoutes>[0] = {}): Promise<World> {
  const w = await cleanWorld({ repos: true });
  w.routes = githubRoutes(o);
  const file = join(w.ctx.env.HOME!, "gh.token");
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  w.ctx.githubTokenFile = file;
  hostEnv(w.ctx.env as Record<string, string>);
  return w;
}
const run = async (w: World) => {
  const all = await runAudit(w.ctx);
  return { rulesets: only(all, "github.rulesets"), perms: only(all, "github.app-perms"), workflows: only(all, "repo.ai-workflows"), all };
};
const mutate = (f: (r: Record<string, any>[]) => void) => {
  const r = goodRulesets() as Record<string, any>[];
  f(r);
  return r;
};
const named = (r: Record<string, any>[], name: string) => r.find((x) => x.name === name)!;

describe("github.rulesets", () => {
  test("the runbook's rulesets pass, read with the operator's token, GET only", async () => {
    const w = await withToken();
    const r = await run(w);
    expect(r.rulesets.status).toBe("pass");
    expect(r.rulesets.detail).toStartWith(`${OWNER}/${NAME}: `);
    const github = w.requests.filter((c) => c.url.startsWith(`${API}/repos/`) && !c.url.endsWith("/installation"));
    expect(github.length).toBeGreaterThan(0);
    for (const c of github) expect([c.url, c.method, c.headers.authorization]).toEqual([c.url, "GET", `Bearer ${TOKEN}`]);
  });

  for (const [what, rulesets, says] of [
    ["no approval required", mutate((r) => (named(r, "main-review").rules[0].parameters.required_approving_review_count = 0)), "required_approving_review_count"],
    ["no ci check", mutate((r) => (named(r, "main-protect").rules = named(r, "main-protect").rules.filter((x: any) => x.type !== "required_status_checks"))), "ci"],
    ["ci from any integration", mutate((r) => (named(r, "main-protect").rules[2].parameters.required_status_checks = [{ context: "ci" }])), "15368"],
    ["a bypass on the ci ruleset", mutate((r) => named(r, "main-protect").bypass_actors.push({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" })), "main-protect holds required_status_checks and has bypass actors"],
    ["no Restrict updates on main-review", mutate((r) => (named(r, "main-review").rules = named(r, "main-review").rules.filter((x: any) => x.type !== "update"))), "main-review has no update"],
    ["code owners off", mutate((r) => (named(r, "main-review").rules[0].parameters.require_code_owner_review = false)), "require_code_owner_review"],
    ["main-review bypass always, not PR-only", mutate((r) => (named(r, "main-review").bypass_actors[0].bypass_mode = "always")), "main-review's bypass actors"],
    ["Restrict updates where nobody may bypass", mutate((r) => named(r, "main-protect").rules.push({ type: "update" })), "main-protect has update and no bypass actors"],
    ["an App as a bypass actor", mutate((r) => named(r, "agent-branch-scope").bypass_actors.push({ actor_id: APP_IDS.planner, actor_type: "Integration", bypass_mode: "always" })), "Integration"],
    ["no main-review", mutate((r) => r.splice(1, 1)), "main-review"],
    ["no force-push block", mutate((r) => (named(r, "main-protect").rules = named(r, "main-protect").rules.filter((x: any) => x.type !== "non_fast_forward"))), "non_fast_forward"],
  ] as const) {
    test(`fails on ${what}`, async () => {
      const r = await run(await withToken({ rulesets: rulesets as Record<string, any>[] }));
      expect(r.rulesets.status).toBe("fail");
      expect(r.rulesets.detail).toContain(says);
    });
  }

  test("a ruleset in evaluate mode doesn't count: GitHub doesn't apply it to main", async () => {
    const r = await run(await withToken({ rulesets: mutate((x) => (named(x, "main-protect").enforcement = "evaluate")) }));
    expect(r.rulesets.status).toBe("fail");
    expect(r.rulesets.detail).toContain("ci");
  });

  test("with only an App token, GitHub hides bypass_actors: rules that pass are a skip naming what is missing; rules that fail still fail", async () => {
    const strip = (rs: Record<string, any>[]) => rs.map(({ bypass_actors, ...r }) => r);
    let w = await withToken({ rulesets: strip(goodRulesets()) });
    delete w.ctx.githubTokenFile;
    let r = await run(w);
    expect(r.rulesets.status).toBe("skip");
    expect(r.rulesets.detail).toContain("bypass_actors");
    expect(r.rulesets.detail).toContain("--github-token-file");
    // The App token: minted for contents and metadata read only, used for GETs, then revoked.
    const mint = w.requests.find((c) => c.method === "POST")!;
    expect(mint.url).toBe(`${API}/app/installations/11/access_tokens`);
    expect(w.requests.filter((c) => !["GET", "POST", "DELETE"].includes(c.method))).toEqual([]);
    expect(w.requests.at(-1)!.method).toBe("DELETE");
    expect(w.requests.filter((c) => c.method === "DELETE").length).toBe(1);

    w = await withToken({ rulesets: strip(mutate((x) => (named(x, "main-review").rules[0].parameters.required_approving_review_count = 0))) });
    delete w.ctx.githubTokenFile;
    r = await run(w);
    expect(r.rulesets.status).toBe("fail");
  });

  test("no credentials at all is a skip, saying what is missing", async () => {
    const w = await cleanWorld({ repos: true });
    const r = await run(w);
    for (const x of [r.rulesets, r.perms, r.workflows]) {
      expect(x.status).toBe("skip");
      expect(x.detail).toContain("no GitHub credentials");
    }
  });

  test("a token file others can read is refused, and the token is never printed", async () => {
    const w = await withToken();
    chmodSync(w.ctx.githubTokenFile!, 0o644);
    const r = await run(w);
    expect(r.rulesets.status).toBe("fail");
    expect(r.rulesets.detail).toContain("chmod 600");
    for (const x of r.all) expect(x.detail).not.toContain(TOKEN);
  });
});

describe("github.app-perms", () => {
  test("both Apps with exactly the runbook's permissions, selected repos, and no ruleset bypass: pass", async () => {
    const w = await withToken();
    const r = await run(w);
    expect(r.perms.status).toBe("pass");
    expect(r.perms.detail).toContain("hapi-planner");
    expect(r.perms.detail).toContain("hapi-factory");
    // The App calls use each App's own JWT, GET only.
    for (const c of w.requests.filter((x) => x.url === `${API}/app` || x.url.endsWith("/installation"))) expect(c.method).toBe("GET");
  });

  for (const [what, perms, says] of [
    ["administration", { planner: { contents: "write", pull_requests: "write", issues: "read", metadata: "read", administration: "read" } }, "administration"],
    ["workflows", { factory: { contents: "write", pull_requests: "write", metadata: "read", workflows: "write" } }, "workflows"],
    ["a permission beyond the runbook's", { factory: { contents: "write", pull_requests: "write", metadata: "read", issues: "write" } }, "issues: write"],
  ] as const) {
    test(`fails on ${what}`, async () => {
      const base = { planner: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" }, factory: { contents: "write", pull_requests: "write", metadata: "read" } };
      const r = await run(await withToken({ appPermissions: { ...base, ...perms } as Record<string, Record<string, string>> }));
      expect(r.perms.status).toBe("fail");
      expect(r.perms.detail).toContain(says);
    });
  }

  test("an App as a bypass actor fails, naming it", async () => {
    const r = await run(await withToken({ rulesets: mutate((x) => named(x, "tags-admin-only").bypass_actors.push({ actor_id: APP_IDS.factory, actor_type: "Integration", bypass_mode: "always" })) }));
    expect(r.perms.status).toBe("fail");
    expect(r.perms.detail).toContain("hapi-factory is a bypass actor on tags-admin-only");
  });

  test("without a token that sees bypass_actors, good permissions are a skip, naming the gap", async () => {
    const w = await withToken({ rulesets: goodRulesets().map(({ bypass_actors, ...r }) => r) });
    delete w.ctx.githubTokenFile;
    const r = await run(w);
    expect(r.perms.status).toBe("skip");
    expect(r.perms.detail).toContain("bypass_actors");
  });
});

describe("repo.ai-workflows", () => {
  test("AI on pull_request, and comment triggers with no AI, pass", async () => {
    const r = await run(await withToken({ workflows: { "claude-code-review.yml": workflow("claude-code-review.yml"), "ci.yml": workflow("ci.yml") } }));
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("2 workflows");
  });

  test("an AI action with a secret on each forbidden trigger fails, in every spelling of `on`", async () => {
    const body = (on: string) =>
      `on: ${on}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: openai/codex-action@v1\n        with:\n          openai-api-key: \${{ secrets.OPENAI_API_KEY }}\n`;
    for (const on of ["issue_comment", "[push, issues]", "{pull_request_target: {types: [opened]}}", "pull_request_review", "{pull_request_review_comment: null}"]) {
      const r = await run(await withToken({ workflows: { "x.yml": body(on) } }));
      expect([on, r.workflows.status]).toEqual([on, "fail"]);
      expect(r.workflows.detail).toContain("openai/codex-action");
    }
  });

  test("an AI CLI run with a secret in the job's env counts too", async () => {
    const text = "on: issue_comment\njobs:\n  a:\n    runs-on: ubuntu-latest\n    env:\n      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n    steps:\n      - run: npx @anthropic-ai/claude-code -p \"$BODY\"\n";
    const r = await run(await withToken({ workflows: { "agent.yaml": text } }));
    expect(r.workflows.status).toBe("fail");
    expect(r.workflows.detail).toContain("agent.yaml");
  });

  test("no .github/workflows at all passes", async () => {
    const w = await withToken();
    delete w.routes[`GET ${API}/repos/${OWNER}/${NAME}/contents/.github/workflows`];
    const r = await run(w);
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("no .github/workflows");
  });

  test("a workflow that doesn't parse fails: it can't be cleared", async () => {
    const r = await run(await withToken({ workflows: { "bad.yml": "on: [unclosed\n" } }));
    expect(r.workflows.status).toBe("fail");
    expect(r.workflows.detail).toContain("bad.yml");
  });
});
