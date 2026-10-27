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
import { aiWorkflowProblems } from "../../src/audit/checks/github";
import { auditCommand, runAudit } from "../../src/audit/index";
import { API, APP_IDS, APP_KEY, appOf, capture, cleanup, cleanWorld, FIXTURES, githubRoutes, goodRulesets, hostEnv, MINTED_TOKEN, NAME, only, OWNER } from "./helpers";
import { envFileText } from "../../src/secrets/files";

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

/** A world read with the audit's own App token: the App keys in host.env, no --github-token-file. */
async function withAppToken(o: Parameters<typeof githubRoutes>[0] = {}): Promise<World> {
  const w = await withToken(o);
  delete w.ctx.githubTokenFile;
  return w;
}
const posts = (w: World) => w.requests.filter((c) => c.method === "POST").map((c) => c.url);
const deletes = (w: World) => w.requests.filter((c) => c.method === "DELETE");
const INSTALLATION = `GET ${API}/repos/${OWNER}/${NAME}/installation`;
const MINT = (id: number) => `${API}/app/installations/${id}/access_tokens`;
type Route = World["routes"][string];
const call = (route: Route, c: Parameters<Extract<Route, Function>>[0]) => (typeof route === "function" ? route(c) : route);

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

describe("the audit's own App token", () => {
  test("hapi-planner first, then hapi-factory: an App not installed on the repo is passed over, not fatal", async () => {
    const w = await withAppToken();
    const real = w.routes[INSTALLATION]!;
    w.routes[INSTALLATION] = (c) => (appOf(c) === "planner" ? { status: 404, body: { message: "Not Found" } } : call(real, c));
    const r = await run(w);
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("a read-only hapi-factory installation token");
    expect(r.rulesets.status).toBe("pass");
    expect(r.rulesets.detail).toContain("hapi-factory installation token");
    expect(posts(w)).toEqual([MINT(12)]);
    expect(deletes(w).length).toBe(1);
  });

  test("an App whose token request GitHub refuses is passed over too", async () => {
    const w = await withAppToken();
    w.routes[`POST ${MINT(11)}`] = { status: 403, body: { message: "Resource not accessible by integration" } };
    const r = await run(w);
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("hapi-factory installation token");
    expect(posts(w)).toEqual([MINT(11), MINT(12)]);
  });

  test("an App whose keys aren't in host.env is passed over, as before", async () => {
    const w = await withAppToken();
    const file = join(w.ctx.env.XDG_RUNTIME_DIR!, "hapi", "env", "host.env");
    writeFileSync(file, envFileText("host", { HAPI_FACTORY_APP_ID: String(APP_IDS.factory), HAPI_FACTORY_APP_PRIVATE_KEY: APP_KEY }), { mode: 0o600 });
    const r = await run(w);
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("hapi-factory installation token");
    expect(posts(w)).toEqual([MINT(12)]);
  });

  test("when neither App can mint, the checks fail naming each App's reason, and never a token", async () => {
    const w = await withAppToken();
    w.routes[INSTALLATION] = () => ({ status: 404, body: { message: "Not Found" } });
    const r = await run(w);
    for (const x of [r.rulesets, r.workflows]) {
      expect([x.id, x.status]).toEqual([x.id, "fail"]);
      expect(x.detail).toContain(`hapi-planner: the App is not installed on ${OWNER}/${NAME}`);
      expect(x.detail).toContain(`hapi-factory: the App is not installed on ${OWNER}/${NAME}`);
    }
    expect(posts(w)).toEqual([]);
  });

  test("a token broader than requested stops the search: a fail naming the App, and the next App is never tried", async () => {
    const w = await withAppToken();
    w.routes[`POST ${MINT(11)}`] = {
      status: 201,
      body: { token: MINTED_TOKEN, expires_at: "2030-01-01T00:00:00Z", permissions: { contents: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ name: NAME }] },
    };
    const r = await run(w);
    for (const x of [r.rulesets, r.workflows]) {
      expect([x.id, x.status]).toEqual([x.id, "fail"]);
      expect(x.detail).toContain("hapi-planner");
      expect(x.detail).toContain("broader than requested");
    }
    expect(posts(w)).toEqual([MINT(11)]);
    for (const x of r.all) expect(x.detail).not.toContain(MINTED_TOKEN);
  });

  test("it is revoked when the audit ends; a revoke GitHub confirms (204) prints nothing", async () => {
    const w = await withAppToken();
    const { err } = capture();
    expect(await auditCommand([], w.ctx)).toBe(0);
    expect(deletes(w).map((c) => [c.url, c.headers.authorization])).toEqual([[`${API}/installation/token`, `Bearer ${MINTED_TOKEN}`]]);
    expect(err).toEqual([]);
  });

  test("a revoke GitHub doesn't confirm prints one warning naming the App and the HTTP status, never the token; the exit code is unchanged", async () => {
    const { err, out } = capture();
    for (const status of [500, 404, 200]) {
      err.length = 0;
      out.length = 0;
      const w = await withAppToken();
      w.routes[`DELETE ${API}/installation/token`] = { status, body: { message: `revoke said ${MINTED_TOKEN}` } };
      expect([status, await auditCommand([], w.ctx)]).toEqual([status, 0]);
      expect([status, err.length]).toEqual([status, 1]);
      expect(err[0]).toContain("hapi-planner");
      expect(err[0]).toContain(`HTTP ${status}`);
      expect(err[0]).toContain(`${OWNER}/${NAME}`);
      expect([...err, ...out].join("\n")).not.toContain(MINTED_TOKEN);
    }
  });

  test("a revoke request that fails outright prints the same one warning, and the exit code is unchanged", async () => {
    const w = await withAppToken();
    const real = w.ctx.fetch;
    w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      init?.method === "DELETE" ? Promise.reject(new Error(`socket hang up (${MINTED_TOKEN})`)) : real(input, init)) as unknown as typeof fetch;
    const { err, out } = capture();
    expect(await auditCommand([], w.ctx)).toBe(0);
    expect(err.length).toBe(1);
    expect(err[0]).toContain("hapi-planner");
    expect(err[0]).toContain("socket hang up");
    expect([...err, ...out].join("\n")).not.toContain(MINTED_TOKEN);
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

  test("a response with no permissions object, or no App id, fails closed: there is nothing to clear", async () => {
    const cases: [string, (body: Record<string, unknown>) => void, string][] = [
      [`GET ${API}/app`, (b) => delete b.permissions, "GET /app returned no permissions object"],
      [`GET ${API}/app`, (b) => (b.permissions = ["contents"]), "GET /app returned no permissions object"],
      [`GET ${API}/app`, (b) => (b.permissions = null), "GET /app returned no permissions object"],
      [INSTALLATION, (b) => delete b.permissions, `/installation returned no permissions object`],
      [INSTALLATION, (b) => (b.permissions = "all"), `/installation returned no permissions object`],
      [`GET ${API}/app`, (b) => delete b.id, "GET /app returned no App id"],
    ];
    for (const [key, edit, says] of cases) {
      const w = await withToken();
      const real = w.routes[key]!;
      w.routes[key] = (c) => {
        const reply = call(real, c);
        const body = { ...(reply.body as Record<string, unknown>) };
        edit(body);
        return { ...reply, body };
      };
      const r = await run(w);
      expect([key, says, r.perms.status]).toEqual([key, says, "fail"]);
      expect([key, r.perms.detail]).toEqual([key, expect.stringContaining(says)]);
    }
  });

  test("a failed read of the rulesets fails, never a skip: the bypass check could not run for a reason that isn't a missing credential", async () => {
    const w = await withToken();
    w.routes[`GET ${API}/repos/${OWNER}/${NAME}/rules/branches/main?per_page=100&page=1`] = { status: 500, body: { message: "Server Error" } };
    const r = await run(w);
    expect(r.perms.status).toBe("fail");
    expect(r.perms.detail).toContain("reading the rulesets failed");
  });

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
  test("AI on pull_request, comment triggers with no AI, and an AI agent on a comment that holds nothing, pass", async () => {
    const r = await run(
      await withToken({ workflows: { "claude-code-review.yml": workflow("claude-code-review.yml"), "ci.yml": workflow("ci.yml"), "agent-safe.yml": workflow("agent-safe.yml") } }),
    );
    expect(r.workflows.status).toBe("pass");
    expect(r.workflows.detail).toContain("3 workflows");
    expect(aiWorkflowProblems(".github/workflows/agent-safe.yml", workflow("agent-safe.yml"))).toEqual([]);
  });

  test("the mtg-shaped claude.yml names every credential its agent's job holds", () => {
    const [problem, ...more] = aiWorkflowProblems(".github/workflows/claude.yml", workflow("claude.yml"));
    expect(more).toEqual([]);
    for (const c of ["secrets.CLAUDE_CODE_OAUTH_TOKEN", "id-token: write", "actions/checkout's persisted GITHUB_TOKEN"]) expect([c, problem]).toEqual([c, expect.stringContaining(c)]);
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

  test("a secret written inline in the agent's own `run:` line counts", async () => {
    const text = 'on: issue_comment\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} claude -p "$BODY"\n';
    expect(aiWorkflowProblems(".github/workflows/inline.yml", text)).toEqual([expect.stringContaining("secrets.ANTHROPIC_API_KEY")]);
    const r = await run(await withToken({ workflows: { "inline.yml": text } }));
    expect(r.workflows.status).toBe("fail");
    expect(r.workflows.detail).toContain(".github/workflows/inline.yml (job a) runs claude in a run: step on issue_comment");
    expect(r.workflows.detail).toContain("secrets.ANTHROPIC_API_KEY");
    // The run line itself is never echoed: it could hold a literal secret.
    expect(r.workflows.detail).not.toContain("$BODY");
  });

  test("a credential anywhere in the agent's job counts: an earlier step's $GITHUB_ENV, a later step's input, a step field", async () => {
    // The steps of one job share a runner: an exported secret reaches the agent, and an agent can rewrite what a later step runs.
    const job = (steps: string) => `on: {issues: {types: [opened]}}\njobs:\n  triage:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
    const cases: Record<string, string> = {
      "GITHUB_ENV": '      - run: echo "OPENAI_API_KEY=${{ secrets.OPENAI_API_KEY }}" >> "$GITHUB_ENV"\n      - run: codex exec "$TITLE"\n',
      "later step": '      - run: codex exec "$TITLE"\n      - uses: actions/github-script@v8\n        with:\n          github-token: ${{ secrets.LABEL_TOKEN }}\n',
      "step field": "      - name: agent ${{ github.token }}\n        run: gemini -p hi\n",
    };
    for (const [what, steps] of Object.entries(cases)) {
      expect([what, aiWorkflowProblems(".github/workflows/t.yml", job(steps)).length]).toEqual([what, 1]);
    }
    // The control: the same job with no credential anywhere passes.
    expect(aiWorkflowProblems(".github/workflows/t.yml", job('      - run: codex exec "$TITLE"\n'))).toEqual([]);
  });

  /** A one-job workflow: `top` goes before `jobs:`, `perms` into the job, then its steps. */
  const wf = (o: { on?: string; top?: string; perms?: string; steps: string }) => `on: ${o.on ?? "issue_comment"}\n${o.top ?? ""}jobs:\n  a:\n    runs-on: ubuntu-latest\n${o.perms ?? ""}    steps:\n${o.steps}`;
  const P = ".github/workflows/x.yml";
  const CLI_WITH = (expr: string) => `      - run: claude -p "$BODY"\n        env:\n          KEY: "${expr}"\n`;
  const ACTION = "      - uses: anthropics/claude-code-action@v1\n        with:\n          prompt: hi\n";

  test("any expression that reads a secret or the job's token counts, not only one that is exactly `${{ secrets.NAME }}`", async () => {
    const cases: [string, string][] = [
      ["${{ secrets.ANTHROPIC_API_KEY || '' }}", "secrets.ANTHROPIC_API_KEY"],
      ["${{ secrets['ANTHROPIC_API_KEY'] }}", "secrets.ANTHROPIC_API_KEY"],
      ["${{ secrets [ 'ANTHROPIC_API_KEY' ] }}", "secrets.ANTHROPIC_API_KEY"],
      ["${{ toJSON(secrets) }}", "every secret (secrets as a whole)"],
      ["${{ fromJSON(toJSON(secrets)).ANTHROPIC_API_KEY }}", "every secret (secrets as a whole)"],
      ["${{ secrets[format('{0}_KEY', 'ANTHROPIC')] }}", "a secret by a computed name"],
      ["${{ SECRETS.anthropic_api_key }}", "secrets.anthropic_api_key"],
      ["${{ format('{0}}}', secrets.ANTHROPIC_API_KEY) }}", "secrets.ANTHROPIC_API_KEY"],
      ["prefix-${{ github.event.issue.number }}-${{ secrets.ANTHROPIC_API_KEY }}", "secrets.ANTHROPIC_API_KEY"],
      ["${{ github.token }}", "github.token"],
      ["${{ github['token'] }}", "github.token"],
      ["${{ GitHub.Token }}", "github.token"],
      ["${{ toJSON(github) }}", "github.token (the whole github context)"],
    ];
    for (const [expr, label] of cases) {
      const problems = aiWorkflowProblems(P, wf({ steps: CLI_WITH(expr) }));
      expect([expr, problems.length]).toEqual([expr, 1]);
      expect([expr, problems[0]]).toEqual([expr, expect.stringContaining(`the job holds ${label}`)]);
    }
    // The reviewer's case, end to end.
    const r = await run(await withToken({ workflows: { "x.yml": wf({ steps: CLI_WITH("${{ secrets.ANTHROPIC_API_KEY || '' }}") }) } }));
    expect(r.workflows.status).toBe("fail");
    expect(r.workflows.detail).toContain("secrets.ANTHROPIC_API_KEY");
  });

  test("an expression that only mentions the words does not: a string literal, another context's field, a step named secrets, text outside an expression", () => {
    for (const expr of [
      "${{ contains(github.event.comment.body, 'secrets.ANTHROPIC_API_KEY') }}",
      "${{ contains(github.event.comment.body, 'it''s github.token') }}",
      "${{ steps.secrets.outputs.value }}",
      "${{ inputs.secrets_dir }}",
      "${{ github.event.comment.body }}",
      "${{ github.token_name }}",
      "secrets.ANTHROPIC_API_KEY and github.token, outside an expression",
    ]) {
      expect([expr, aiWorkflowProblems(P, wf({ steps: CLI_WITH(expr) }))]).toEqual([expr, []]);
    }
  });

  test("permissions: write-all, at the workflow or the job, counts: it holds id-token: write and a write GITHUB_TOKEN; so does any write scope", () => {
    for (const [top, perms, label] of [
      ["permissions: write-all\n", "", "permissions: write-all"],
      ["", "    permissions: write-all\n", "permissions: write-all"],
      ["permissions: {}\n", "    permissions: write-all\n", "permissions: write-all"],
      ["", "    permissions:\n      contents: write\n", "contents: write"],
      ["permissions:\n  pull-requests: write\n", "", "pull-requests: write"],
      ["", "    permissions:\n      id-token: write\n", "id-token: write"],
    ] as const) {
      const problems = aiWorkflowProblems(P, wf({ top, perms, steps: ACTION }));
      expect([top, perms, problems.length]).toEqual([top, perms, 1]);
      expect([top, perms, problems[0]]).toEqual([top, perms, expect.stringContaining(label)]);
    }
  });

  test("read-all, {} and read scopes grant nothing, and a job's permissions replace the workflow's", () => {
    for (const [top, perms] of [
      ["permissions: read-all\n", ""],
      ["permissions: {}\n", ""],
      ["", "    permissions: read-all\n"],
      ["", "    permissions: {}\n"],
      ["", "    permissions:\n      contents: read\n      issues: read\n      id-token: none\n"],
      ["permissions: write-all\n", "    permissions: {}\n"],
      ["permissions: write-all\n", "    permissions: read-all\n"],
      ["permissions:\n  id-token: write\n", "    permissions:\n      contents: read\n"],
    ] as const) {
      expect([top, perms, aiWorkflowProblems(P, wf({ top, perms, steps: ACTION }))]).toEqual([top, perms, []]);
    }
  });

  test("actions/checkout in the agent's job counts unless persist-credentials is false: by default it writes the GITHUB_TOKEN into .git/config", () => {
    const checkout = (uses: string, withBlock = "") => `      - uses: ${uses}\n${withBlock}${ACTION}`;
    for (const step of [
      checkout("actions/checkout@v6"),
      checkout("actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955"),
      checkout("Actions/Checkout@v4"),
      checkout("actions/checkout@v6", "        with:\n          fetch-depth: 1\n"),
      checkout("actions/checkout@v6", "        with:\n          persist-credentials: true\n"),
      checkout("actions/checkout@v6", "        with:\n          persist-credentials: ${{ inputs.keep }}\n"),
    ]) {
      const problems = aiWorkflowProblems(P, wf({ steps: step }));
      expect([step, problems.length]).toEqual([step, 1]);
      expect([step, problems[0]]).toEqual([step, expect.stringContaining("actions/checkout's persisted GITHUB_TOKEN (no persist-credentials: false)")]);
    }
    for (const step of [
      checkout("actions/checkout@v6", "        with:\n          persist-credentials: false\n"),
      checkout("actions/checkout@v6", "        with:\n          persist-credentials: 'false'\n"),
      checkout("actions/checkout-extra@v1"),
    ]) {
      expect([step, aiWorkflowProblems(P, wf({ steps: step }))]).toEqual([step, []]);
    }
    // A checkout in another job doesn't reach this job's runner.
    const twoJobs = `on: issue_comment\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${ACTION}`;
    expect(aiWorkflowProblems(P, twoJobs)).toEqual([]);
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
