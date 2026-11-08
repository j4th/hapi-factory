/**
 * `newRepo`, the eleven steps of `hapi new-repo` (design §3.2), against the fake world of ./helpers.ts: the order of
 * the writes, the push's credential, the first commit, the rulesets, the refusals before any write, --dry-run, a
 * failed step's report, the App web step, the registration, --clone and the verify step. No network, no real token.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRACT_CHECK, LABELS } from "../../src/forge/index";
import { STEPS, newRepo, type NewRepoOptions, registerText } from "../../src/newrepo/steps";
import { loadPolicy } from "../../src/policy/load";
import { API, cleanup, FULL, GATES, NAME, newRepoWorld, OWNER, R, REPO, REPO_ID, TOKEN, USER_ID, type World } from "./helpers";

afterEach(cleanup);

const OPTS: NewRepoOptions = { name: NAME, clone: false, collaboratorsOnly: false, dryRun: false };
const go = (w: World, o: Partial<NewRepoOptions> = {}) => newRepo(w.deps, TOKEN, { ...OPTS, ...o });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const failLine = (w: World) => w.out.find((l) => l.startsWith("step "));

test("STEPS are the eleven of design §3.2, in order", () => {
  expect(STEPS).toEqual(["preflight", "render", "create", "push", "settings", "rulesets", "labels", "apps", "register", "clone", "verify"]);
});

test("new-repo runs the eleven steps in order against the fake forge", async () => {
  const w = newRepoWorld();
  expect(await go(w)).toBe(0);
  expect(w.writes()).toEqual([
    "POST /user/repos",
    "git push",
    `PATCH /repos/${FULL}`,
    `PUT /repos/${FULL}/actions/permissions/workflow`,
    `PUT /repos/${FULL}/actions/permissions`,
    `PUT /repos/${FULL}/actions/permissions/selected-actions`,
    `PUT /repos/${FULL}/actions/permissions/fork-pr-contributor-approval`,
    `PUT /repos/${FULL}/private-vulnerability-reporting`,
    `PATCH /repos/${FULL}/code-scanning/default-setup`,
    ...Array(4).fill(`POST /repos/${FULL}/rulesets`),
    ...Array(5).fill(`POST /repos/${FULL}/labels`),
    `PUT /user/installations/11/repositories/${REPO_ID}`,
    `PUT /user/installations/12/repositories/${REPO_ID}`,
    `PUT /user/installations/13/repositories/${REPO_ID}`,
  ]);
  // One line per step, in order, and the token on every request and in no line.
  expect(w.out.filter((l) => /^\[\d+\/11\] /.test(l)).map((l) => l.replace(/:.*$/, ""))).toEqual(STEPS.map((s, i) => `[${i + 1}/11] ${s}`));
  for (const c of w.calls) expect([c.url, c.headers.authorization]).toEqual([c.url, `Bearer ${TOKEN}`]);
  for (const l of w.out) expect(l).not.toContain(TOKEN);
});

test("the create and settings bodies are the design's: public, merge commits only with the classic message, a read-only token, selected SHA-pinned actions", async () => {
  const w = newRepoWorld();
  expect(await go(w, { collaboratorsOnly: true })).toBe(0);
  const body = (method: string, url: string) => w.calls.find((c) => c.method === method && c.url === url)?.body;
  expect(body("POST", `${API}/user/repos`)).toEqual({ name: NAME, private: false, has_issues: true, has_projects: false, has_wiki: false, auto_init: false });
  expect(body("PATCH", R)).toEqual({
    default_branch: "main",
    allow_merge_commit: true,
    allow_squash_merge: false,
    allow_rebase_merge: false,
    allow_auto_merge: false,
    delete_branch_on_merge: true,
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
    security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } },
  });
  expect(body("PUT", `${R}/actions/permissions/workflow`)).toEqual({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false });
  expect(body("PUT", `${R}/actions/permissions`)).toEqual({ enabled: true, allowed_actions: "selected", sha_pinning_required: true });
  expect(body("PUT", `${R}/actions/permissions/selected-actions`)).toEqual({
    github_owned_allowed: true,
    verified_allowed: false,
    patterns_allowed: ["jdx/mise-action@*", `${OWNER}/hapi-factory/.github/workflows/gates.yml@*`],
  });
  expect(body("PUT", `${R}/actions/permissions/fork-pr-contributor-approval`)).toEqual({ approval_policy: "all_external_contributors" });
  expect(body("PATCH", `${R}/code-scanning/default-setup`)).toEqual({ state: "configured" });
  // --collaborators-only adds the interaction limit, last of the settings.
  expect(body("PUT", `${R}/interaction-limits`)).toEqual({ limit: "collaborators_only", expiry: "six_months" });
  expect(w.writes().indexOf(`PUT /repos/${FULL}/interaction-limits`)).toBe(w.writes().indexOf(`PATCH /repos/${FULL}/code-scanning/default-setup`) + 1);
  expect(w.labels).toEqual(LABELS.map((l) => ({ ...l })));
});

test("no ruleset is posted before the first push, and no App is installed before every ruleset is read back", async () => {
  const w = newRepoWorld();
  expect(await go(w)).toBe(0);
  const e = w.events;
  const firstRuleset = e.indexOf(`POST /repos/${FULL}/rulesets`);
  expect(e.indexOf("git push")).toBeGreaterThan(-1);
  expect(firstRuleset).toBeGreaterThan(e.indexOf("git push"));
  const firstApp = e.findIndex((x) => x.startsWith("PUT /user/installations/"));
  for (const id of [101, 102, 103, 104]) {
    const read = e.indexOf(`GET /repos/${FULL}/rulesets/${id}`);
    expect([id, read > firstRuleset && read < firstApp]).toEqual([id, true]);
  }
  for (const b of ["main", "some-feature", "plan%2Fexample", "factory%2Fexample"]) {
    const read = e.indexOf(`GET /repos/${FULL}/rules/branches/${b}`);
    expect([b, read > -1 && read < firstApp]).toEqual([b, true]);
  }
});

test("the first push carries the token in its environment only", async () => {
  const w = newRepoWorld();
  expect(await go(w)).toBe(0);
  const push = w.runs.find((r) => r.cmd.includes("push"))!;
  expect(push.cmd.slice(-4)).toEqual(["push", "--quiet", `https://github.com/${FULL}.git`, "HEAD:refs/heads/main"]);
  expect(push.cmd.slice(0, 7)).toEqual(["git", "-C", w.pushed[0]!.dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
  const argv = push.cmd.join(" ");
  for (const secret of [TOKEN, b64(TOKEN), b64(`x-access-token:${TOKEN}`)]) expect(argv).not.toContain(secret);
  expect(push.env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${btoa(`x-access-token:${TOKEN}`)}`);
  expect(push.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", GIT_CONFIG_COUNT: "1" });
  // Only the push holds the token; every other git call has the hardened env and nothing else.
  for (const r of w.runs.filter((x) => x.cmd[0] === "git" && x !== push && !x.cmd.includes("clone"))) {
    expect(Object.keys(r.env).sort()).toEqual(["GIT_ALLOW_PROTOCOL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "PATH"]);
  }
  // The work dir is gone afterwards.
  expect(existsSync(w.pushed[0]!.dir)).toBe(false);
});

test("with real git: the first commit holds exactly the rendered files, by the operator's noreply identity", async () => {
  const w = newRepoWorld();
  expect(await go(w)).toBe(0);
  const { files, author } = w.pushed[0]!;
  expect(files.length).toBe(30);
  expect(files).toContain(".factory/template.lock");
  expect(files).toContain(".github/workflows/hapi-gates.yml");
  expect(files.filter((f) => f.endsWith(".tmpl"))).toEqual([]);
  expect(author).toBe(`${OWNER} <${USER_ID}+${OWNER}@users.noreply.github.com>`);
});

test("the rulesets are posted from policy/github/rulesets, main-protect requiring ci / gates and agent-branch-scope letting Dependabot push", async () => {
  const w = newRepoWorld();
  expect(await go(w)).toBe(0);
  const dir = join(REPO, "policy", "github", "rulesets");
  const want = Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(dir, f), "utf8"))]));
  want["main-protect"].rules.find((r: any) => r.type === "required_status_checks").parameters.required_status_checks = [{ context: CONTRACT_CHECK, integration_id: 15368 }];
  want["agent-branch-scope"].conditions.ref_name.exclude.push("refs/heads/dependabot/**/*");
  const posted = w.calls.filter((c) => c.method === "POST" && c.url === `${R}/rulesets`).map((c) => c.body as Record<string, any>);
  expect(Object.fromEntries(posted.map((p) => [p.name, p]))).toEqual(want);
  expect(CONTRACT_CHECK).toBe("ci / gates");
});

describe("a ruleset that doesn't read back as posted stops the step before any App is added", () => {
  for (const [what, routes, says] of [
    [
      "a posted rule missing",
      { [`GET ${R}/rulesets/101`]: { status: 200, body: { id: 101, name: "main-protect", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [], rules: [{ type: "deletion" }, { type: "non_fast_forward" }] } } },
      "main-protect (101) read back differs from what was posted: /rules",
    ],
    [
      "an extra bypass actor",
      {
        [`GET ${R}/rulesets/101`]: {
          status: 200,
          body: { id: 101, name: "main-protect", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }], rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CONTRACT_CHECK, integration_id: 15368 }] } }] },
        },
      },
      "main-protect (101) read back differs from what was posted: /bypass_actors",
    ],
    ["plan/example under a restriction", { [`GET ${R}/rules/branches/plan%2Fexample?per_page=100`]: { status: 200, body: [{ type: "update", ruleset_id: 103 }] } }, "plan/example has update"],
    ["main without Restrict updates", { [`GET ${R}/rules/branches/main?per_page=100`]: { status: 200, body: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }, { type: "required_status_checks" }] } }, "main lacks update"],
  ] as const) {
    test(what, async () => {
      const w = newRepoWorld({ routes });
      expect(await go(w)).toBe(1);
      expect(failLine(w)).toStartWith("step 6 (rulesets) failed: ");
      expect(failLine(w)).toContain(says);
      expect(w.writes().some((e) => e.startsWith("PUT /user/installations/"))).toBe(false);
    });
  }
});

describe("new-repo refuses before any write", () => {
  for (const [what, opts, says] of [
    ["scopes without workflow", { scopes: "repo, read:org" }, "missing scope workflow: run gh auth refresh -s workflow"],
    ["an organization account", { type: "Organization" }, `${OWNER} is an Organization account: new-repo makes repos for a personal account only`],
    ["a repo that already exists", { repoExists: true }, `${FULL} already exists`],
    ["a dirty templates/", { dirtyTemplates: true }, "templates/repo-contract, .github/workflows/gates.yml or policy/github/rulesets has changes git hasn't committed"],
    ["gates.yml not on GitHub at HEAD", { gatesOnGitHub: false }, `GitHub has no .github/workflows/gates.yml in ${OWNER}/hapi-factory at ${GATES.slice(0, 7)}`],
  ] as const) {
    test(what, async () => {
      const w = newRepoWorld(opts);
      expect(await go(w)).toBe(1);
      expect(failLine(w)).toStartWith("step 1 (preflight) failed: ");
      expect(failLine(w)).toContain(says);
      expect(w.calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(w.runs.filter((r) => r.cmd.includes("push") || r.cmd.includes("clone"))).toEqual([]);
      expect(w.out).toContain("Done so far: nothing");
    });
  }

  test("the uncommitted-change check covers the template, gates.yml and the rulesets new-repo posts", async () => {
    const w = newRepoWorld({ dirtyTemplates: true });
    expect(await go(w)).toBe(1);
    const status = w.runs.find((r) => r.cmd.includes("status"))!.cmd;
    expect(status.slice(status.indexOf("status"))).toEqual(["status", "--porcelain", "--ignored", "--", "templates/repo-contract", ".github/workflows/gates.yml", "policy/github/rulesets"]);
  });

  test("a repo policy/repos.yaml already registers is refused before any write", async () => {
    const w = newRepoWorld();
    const file = join(w.root, "policy", "repos.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^repos: \{\}/m, `repos:\n  "${OWNER}/Example-Repo": { registered: "2026-01-01" }\n#`));
    expect(await go(w)).toBe(1);
    expect(failLine(w)).toBe(`step 1 (preflight) failed: policy/repos.yaml already registers ${FULL}: drop the stale entry by PR first`);
    expect(w.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("a missing repo scope is named too, and so is a login with no scopes header", async () => {
    let w = newRepoWorld({ scopes: "workflow" });
    expect(await go(w)).toBe(1);
    expect(failLine(w)).toContain("missing scope repo: run gh auth refresh -s repo");
    w = newRepoWorld({ routes: { [`GET ${API}/user`]: { status: 200, body: { login: OWNER, id: USER_ID, type: "User" } } } });
    expect(await go(w)).toBe(1);
    expect(failLine(w)).toContain("GET /user returned no x-oauth-scopes header");
  });

  test("new-repo reads no installation, which GitHub answers an OAuth login 403: the ids are policy/repos.yaml's, said to be (Task 16)", async () => {
    const w = newRepoWorld();
    expect(await go(w)).toBe(0);
    expect(w.events.filter((e) => e.startsWith("GET /user/installations"))).toEqual([]);
    expect(w.out.find((l) => l.startsWith("[1/11] preflight"))).toContain("installations hapi-planner 11, hapi-factory 12, coderabbitai 13, as policy/repos.yaml records them;");
    expect(w.out.find((l) => l.startsWith("[8/11] apps"))).toContain(
      `${FULL} added to hapi-planner (11), hapi-factory (12), coderabbitai (13); the strict audit as hapi proves hapi-planner and hapi-factory cover it (github.app-perms; docs/runbooks/new-repo.md#verify); nothing checks coderabbitai's: see its Repository access on github.com`,
    );
  });

  test("with no coderabbit id in policy/repos.yaml, CodeRabbit isn't added, and the lines say so", async () => {
    const w = newRepoWorld({ policyInstallations: { planner: 11, factory: 12 } });
    expect(await go(w)).toBe(0);
    expect(w.writes().filter((e) => e.startsWith("PUT /user/installations/"))).toEqual([`PUT /user/installations/11/repositories/${REPO_ID}`, `PUT /user/installations/12/repositories/${REPO_ID}`]);
    expect(w.out.find((l) => l.startsWith("[1/11] preflight"))).toContain("installations hapi-planner 11, hapi-factory 12, as policy/repos.yaml records them; the gates at c0ffee0; policy/repos.yaml names no coderabbit installation, so CodeRabbit isn't added");
    expect(w.out.find((l) => l.startsWith("[8/11] apps"))).toEndWith(`${FULL} added to hapi-planner (11), hapi-factory (12); the strict audit as hapi proves hapi-planner and hapi-factory cover it (github.app-perms; docs/runbooks/new-repo.md#verify)`);
  });

  test("--clone onto a path that exists is refused here, before the repo is made", async () => {
    const w = newRepoWorld();
    mkdirSync(w.cloneTarget);
    expect(await go(w, { clone: true })).toBe(1);
    expect(failLine(w)).toBe(`step 1 (preflight) failed: ${w.cloneTarget} already exists: --clone clones into ../${NAME}, beside the checkout, so move it away or leave out --clone`);
    expect(w.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});

test("--dry-run makes no write", async () => {
  const w = newRepoWorld();
  const before = readFileSync(join(w.root, "policy", "repos.yaml"));
  expect(await go(w, { dryRun: true, clone: true, collaboratorsOnly: true })).toBe(0);
  expect(w.calls.filter((c) => c.method !== "GET")).toEqual([]);
  const git = w.runs.filter((r) => r.cmd[0] === "git");
  expect(git.map((r) => (r.cmd.includes("rev-parse") ? "rev-parse" : r.cmd.includes("status") ? "status" : r.cmd.join(" ")))).toEqual(["rev-parse", "status"]);
  expect(readFileSync(join(w.root, "policy", "repos.yaml")).equals(before)).toBe(true);
  for (const [k, step] of STEPS.entries()) {
    const lines = w.out.filter((l) => l.startsWith(`[${k + 1}/11] ${step}: `));
    expect([step, lines.length]).toEqual([step, 1]);
    expect([step, lines[0]!.includes("would:")]).toEqual([step, k >= 2]);
  }
  expect(w.out.filter((l) => l.includes("would:")).length).toBe(9);
  expect(existsSync(w.cloneTarget)).toBe(false);
  expect(w.audits).toEqual([]);
});

test("a failed step stops, says what was done and what to undo, and never prints the token", async () => {
  let n = 0;
  const w = newRepoWorld({
    routes: {
      [`POST ${R}/labels`]: () => (++n === 3 ? { status: 422, body: { message: "Validation Failed" } } : { status: 201, body: { id: n } }),
    },
  });
  expect(await go(w)).toBe(1);
  expect(failLine(w)).toBe(`step 7 (labels) failed: POST /repos/${FULL}/labels: HTTP 422: Validation Failed`);
  const done = w.out.indexOf("Done so far:");
  const undo = w.out.indexOf("To undo:");
  expect(done).toBeGreaterThan(w.out.indexOf(failLine(w)!));
  expect(w.out.slice(done + 1, undo).map((l) => l.replace(/^ {2}(\d+\. \w+): .*$/, "$1"))).toEqual(["3. create", "4. push", "5. settings", "6. rulesets"]);
  expect(w.out.slice(undo + 1)).toContain(`  gh repo delete ${FULL} --yes (first: gh auth refresh -s delete_repo)`);
  expect(w.writes().some((e) => e.startsWith("PUT /user/installations/"))).toBe(false);
  for (const l of w.out) expect(l).not.toContain(TOKEN);
});

test("an error that holds the token is printed with it redacted", async () => {
  const w = newRepoWorld({ routes: { [`PATCH ${R}`]: { status: 500, body: { message: `boom ${TOKEN} and ${b64(`x-access-token:${TOKEN}`)}` } } } });
  expect(await go(w)).toBe(1);
  expect(failLine(w)).toBe(`step 5 (settings) failed: PATCH /repos/${FULL}: HTTP 500: boom [redacted] and [redacted]`);
});

test("M16: GitHub's text is printed with no terminal control in it", async () => {
  const w = newRepoWorld({ routes: { [`PATCH ${R}`]: { status: 500, body: { message: "boom\u001b]0;owned\u0007 \u001b[2Jthere" } } } });
  expect(await go(w)).toBe(1);
  expect(failLine(w)).toBe(`step 5 (settings) failed: PATCH /repos/${FULL}: HTTP 500: boom there`);
  for (const l of w.out) expect(l).not.toContain("\u001b");
});

test("an App install GitHub refuses becomes a web step the command waits on, then the other Apps' PUTs go on (design §3.2)", async () => {
  const puts = [11, 12, 13].map((id) => `PUT /user/installations/${id}/repositories/${REPO_ID}`);
  let w = newRepoWorld({ routes: { [`PUT ${API}/user/installations/12/repositories/${REPO_ID}`]: { status: 403, body: { message: "Resource not accessible by integration" } } } });
  expect(await go(w)).toBe(0);
  expect(w.prompts).toEqual([`Add ${FULL} to hapi-factory: github.com → Settings → Applications → hapi-factory → Configure → Repository access (selected repositories only), then press Enter`]);
  expect(w.events.filter((e) => e.startsWith("PUT /user/installations/"))).toEqual(puts);
  expect(w.events.indexOf("confirmed")).toBeGreaterThan(w.events.indexOf(puts[1]!));
  expect(w.events.indexOf("confirmed")).toBeLessThan(w.events.indexOf(puts[2]!));
  expect(w.out.find((l) => l.startsWith("[8/11] apps"))).toContain("coderabbitai (13) (hapi-factory by the web step); the strict audit as hapi proves");
  expect(w.events.filter((e) => e.startsWith("GET /user/installations"))).toEqual([]);
  // A web step on the first App doesn't end the step either.
  w = newRepoWorld({ routes: { [`PUT ${API}/user/installations/11/repositories/${REPO_ID}`]: { status: 403, body: { message: "Resource not accessible by integration" } } } });
  expect(await go(w)).toBe(0);
  expect(w.events.filter((e) => e.startsWith("PUT /user/installations/"))).toEqual(puts);
  expect(w.events.indexOf("confirmed")).toBeLessThan(w.events.indexOf(puts[1]!));
});

test("a 404 (an id GitHub doesn't know) and a 422 become the web step too; a 304 is done; any other answer fails the step", async () => {
  let w = newRepoWorld({ policyInstallations: { planner: 11, factory: 99, coderabbit: 13 } });
  expect(await go(w)).toBe(0);
  expect(w.prompts.map((l) => l.slice(0, l.indexOf(": ")))).toEqual([`Add ${FULL} to hapi-factory`]);
  w = newRepoWorld({ routes: { [`PUT ${API}/user/installations/13/repositories/${REPO_ID}`]: { status: 422, body: { message: "Validation Failed" } } } });
  expect(await go(w)).toBe(0);
  expect(w.prompts).toEqual([`Add ${FULL} to coderabbitai: github.com → Settings → Applications → coderabbitai → Configure → Repository access (an App on all repositories has it already), then press Enter`]);
  w = newRepoWorld({ routes: { [`PUT ${API}/user/installations/11/repositories/${REPO_ID}`]: { status: 304 } } });
  expect(await go(w)).toBe(0);
  expect(w.prompts).toEqual([]);
  w = newRepoWorld({ routes: { [`PUT ${API}/user/installations/12/repositories/${REPO_ID}`]: { status: 500, body: { message: "boom" } } } });
  expect(await go(w)).toBe(1);
  expect(w.prompts).toEqual([]);
  expect(failLine(w)).toBe(`step 8 (apps) failed: PUT /user/installations/12/repositories/${REPO_ID}: HTTP 500: boom`);
});

test("register adds the repo to policy/repos.yaml and keeps its comments", async () => {
  const w = newRepoWorld();
  const file = join(w.root, "policy", "repos.yaml");
  const comments = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("#"));
  const before = readFileSync(file, "utf8");
  expect(await go(w)).toBe(0);
  const after = readFileSync(file, "utf8");
  expect(comments(after)).toEqual(comments(before));
  expect(loadPolicy(join(w.root, "policy")).repos.repos[FULL]).toEqual({ registered: "2026-10-31" });
  expect(w.out.find((l) => l.startsWith("[9/11] register: "))).toBe(`[9/11] register: added ${FULL} to policy/repos.yaml (registered 2026-10-31), uncommitted: review it and commit it by PR`);
});

test("registerText adds one line and leaves every other line byte-identical, on a first registration and on a later one", () => {
  const text = readFileSync(join(REPO, "policy", "repos.yaml"), "utf8");
  const one = registerText(text, "example-owner/a", "2026-10-31");
  const two = registerText(one, "example-owner/b", "2026-11-01");
  const old = text.split("\n");
  const at = old.findIndex((l) => l.startsWith("repos:"));
  // The first: `repos: {}` loses its braces (two spaces, so the note keeps its column), and the entry follows it.
  expect(one.split("\n")).toEqual([...old.slice(0, at), old[at]!.replace("{}", "  "), '  "example-owner/a": { registered: "2026-10-31" }', ...old.slice(at + 1)]);
  // A later one: exactly one line added, after the last entry.
  const first = one.split("\n");
  expect(two.split("\n")).toEqual([...first.slice(0, at + 2), '  "example-owner/b": { registered: "2026-11-01" }', ...first.slice(at + 2)]);
  // The note on the repos: line, and every comment line, as they were; the data is the old plus the entries.
  expect(first[at]).toMatch(/^repos: {3,}# "owner\/name": \{ registered: "YYYY-MM-DD" \}$/);
  const policy = (t: string) => {
    const dir = join(newRepoWorld().root, "policy");
    writeFileSync(join(dir, "repos.yaml"), t);
    return loadPolicy(dir).repos;
  };
  expect(policy(two)).toEqual({ ...policy(text), repos: { "example-owner/a": { registered: "2026-10-31" }, "example-owner/b": { registered: "2026-11-01" } } });
  expect(() => registerText(one, "Example-Owner/A", "2026-11-02")).toThrow("policy/repos.yaml already registers Example-Owner/A");
  expect(() => registerText("installations: { planner: 1, factory: 2 }\nrepos: { a/b: { registered: \"2026-01-01\" } }\n", "x/y", "2026-11-02")).toThrow("add the entry by hand");
});

test("register restores the old text when the new one doesn't load", async () => {
  const w = newRepoWorld();
  const file = join(w.root, "policy", "repos.yaml");
  const before = readFileSync(file, "utf8");
  // Another policy file breaks after preflight read it, so the policy with the new entry doesn't load: the entry is undone.
  w.setOnPush(() => appendFileSync(join(w.root, "policy", "runs.yaml"), "\nnot_a_key: 1\n"));
  expect(await go(w)).toBe(1);
  expect(failLine(w)).toStartWith("step 9 (register) failed: policy/ doesn't load with the new entry, so policy/repos.yaml is back as it was: ");
  expect(readFileSync(file, "utf8")).toBe(before);
});

describe("--clone clones into ../<name> beside the checkout and refuses a path that exists (H-178)", () => {
  test("the clone, with the operator's own env", async () => {
    const w = newRepoWorld();
    expect(await go(w, { clone: true })).toBe(0);
    const clone = w.runs.find((r) => r.cmd.includes("clone"))!;
    expect(clone.cmd).toEqual(["git", "clone", "--quiet", `https://github.com/${FULL}.git`, w.cloneTarget]);
    expect(clone.env).toEqual({ PATH: process.env.PATH!, HOME: w.base });
    expect(w.writes().at(-1)).toBe("git clone");
  });

  test("a path that appears after preflight fails step 10 before cloning", async () => {
    const w = newRepoWorld();
    w.setOnPush(() => mkdirSync(w.cloneTarget));
    expect(await go(w, { clone: true })).toBe(1);
    expect(failLine(w)).toBe(`step 10 (clone) failed: ${w.cloneTarget} already exists: --clone clones into ../${NAME}, beside the checkout, so move it away or leave out --clone`);
    expect(w.runs.some((r) => r.cmd.includes("clone"))).toBe(false);
    expect(w.audits).toEqual([]);
  });
});

describe("verify runs the GitHub checks for the new repo, strict, on the in-memory token", () => {
  test("the audit's context", async () => {
    const w = newRepoWorld();
    expect(await go(w)).toBe(0);
    expect(w.audits.length).toBe(1);
    const ctx = w.audits[0]!;
    expect(ctx).toMatchObject({ root: w.root, policyDir: join(w.root, "policy"), repos: [{ owner: OWNER, name: NAME }], strict: true, githubToken: TOKEN });
    expect(ctx.only).toEqual(["github.rulesets", "github.repo-settings", "github.labels", "repo.ai-workflows"]);
    expect(ctx.githubTokenFile).toBeUndefined();
    expect(w.out.filter((l) => /^ {2}pass {2}/.test(l)).length).toBe(4);
  });

  test("a single fail result fails step 11", async () => {
    const w = newRepoWorld();
    w.setAuditResults([
      { id: "github.rulesets", status: "pass", detail: "ok" },
      { id: "github.repo-settings", status: "fail", detail: `${FULL}: allow_squash_merge is true, not false` },
      { id: "github.labels", status: "pass", detail: "ok" },
      { id: "repo.ai-workflows", status: "pass", detail: "ok" },
    ]);
    expect(await go(w)).toBe(1);
    expect(failLine(w)).toBe("step 11 (verify) failed: the strict audit failed github.repo-settings: fix it, then run it again (docs/runbooks/new-repo.md#verify)");
    expect(w.out).toContain(`  fail  github.repo-settings  ${FULL}: allow_squash_merge is true, not false`);
  });
});
