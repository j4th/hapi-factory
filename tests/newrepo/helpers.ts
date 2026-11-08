/**
 * A world for `newRepo` (src/newrepo/steps.ts): a fake GitHub (tests/forge/helpers.ts `fakeFetch`, over a route
 * table that holds the new repo's state), a fake `Runner` that answers the checkout's `git rev-parse HEAD` and
 * `git status` and records the push and the clone, but runs every other git call for real, and recording fakes for
 * `confirm` and `audit`. The checkout is a temp dir with a copy of policy/ (its repos.yaml naming the fake
 * installations 11, 12 and 13) and templates/ linked. GitHub's two installation reads answer 403, as they answer
 * an OAuth login (Task 16): new-repo never makes them. No network, no real token.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AuditContext, CheckResult } from "../../src/audit/types";
import { runCommand, type Runner } from "../../src/stack/up";
import type { NewRepoDeps } from "../../src/newrepo/steps";
import { type Call, fakeFetch, type Reply } from "../forge/helpers";

export const REPO = resolve(import.meta.dir, "../..");
export const API = "https://api.github.com";
export const OWNER = "example-owner";
export const NAME = "example-repo";
export const FULL = `${OWNER}/${NAME}`;
export const USER_ID = 4100;
export const REPO_ID = 4242;
export const TOKEN = "fake-gh-token";
/** What the fake checkout's `git rev-parse HEAD` says. */
export const GATES = "c0ffee".padEnd(40, "0");
export const R = `${API}/repos/${OWNER}/${NAME}`;
export const NOW = new Date("2026-10-31T12:00:00Z");

const temps: string[] = [];
export function cleanup(): void {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
}

type Route = Reply | ((c: Call) => Reply);
/** GitHub's answers to an OAuth login's GET /user/installations and GET /user/installations/{id}/repositories (live, 2026-11-06). */
const OAUTH_403 = "You must authenticate with an access token authorized to a GitHub App in order to list installations";
const OAUTH_403_REPOS = "You must authenticate with an access token authorized to a GitHub App, a personal access token, or basic auth in order to list repositories for an installation.";
export interface Installation {
  id: number;
  app_slug: string;
}
export interface WorldOptions {
  scopes?: string;
  type?: string;
  repoExists?: boolean;
  installations?: readonly Installation[];
  /** policy/repos.yaml's installations; default { planner: 11, factory: 12, coderabbit: 13 }. */
  policyInstallations?: { planner: number; factory: number; coderabbit?: number };
  gatesOnGitHub?: boolean;
  dirtyTemplates?: boolean;
  /** Routes that replace the world's own, by "METHOD url". */
  routes?: Record<string, Route>;
}

/** The rules a ruleset adds to a branch, as GitHub's GET /rules/branches/{branch} lists them. */
function refMatches(pattern: string, branch: string): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return branch === "main";
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  return re.test(`refs/heads/${branch}`);
}

/** GitHub's own defaults, which a ruleset read back holds beside what was posted. */
function withDefaults(id: number, body: Record<string, any>): Record<string, any> {
  const rules = (body.rules as Record<string, any>[]).map((r) => {
    if (r.type === "pull_request") return { ...r, parameters: { ...r.parameters, required_reviewers: [], allowed_merge_methods: ["merge", "squash", "rebase"], require_extra_approval_for_unattributed_changes: true } };
    if (r.type === "required_status_checks") return { ...r, parameters: { do_not_enforce_on_create: false, ...r.parameters } };
    return r;
  });
  return { id, ...body, rules, source_type: "Repository", source: FULL, node_id: `RRS_${id}`, current_user_can_bypass: "always", created_at: "2026-10-31T12:00:00Z", updated_at: "2026-10-31T12:00:00Z", _links: { self: { href: `${R}/rulesets/${id}` } } };
}

export function newRepoWorld(o: WorldOptions = {}) {
  const base = mkdtempSync(join(tmpdir(), "hapi-newrepo-"));
  temps.push(base);
  const root = join(base, "hapi-factory");
  mkdirSync(root);
  cpSync(join(REPO, "policy"), join(root, "policy"), { recursive: true });
  symlinkSync(join(REPO, "templates"), join(root, "templates"));
  const ids = o.policyInstallations ?? { planner: 11, factory: 12, coderabbit: 13 };
  const reposYaml = readFileSync(join(REPO, "policy", "repos.yaml"), "utf8")
    .replace(/^ {2}planner: \d+/m, `  planner: ${ids.planner}`)
    .replace(/^ {2}factory: \d+/m, `  factory: ${ids.factory}`)
    .replace(/^ {2}# coderabbit: <id>/m, ids.coderabbit === undefined ? "  # coderabbit: <id>" : `  coderabbit: ${ids.coderabbit}`);
  writeFileSync(join(root, "policy", "repos.yaml"), reposYaml);

  const installations = o.installations ?? [
    { id: 11, app_slug: "hapi-planner" },
    { id: 12, app_slug: "hapi-factory" },
    { id: 13, app_slug: "coderabbitai" },
  ];
  const rulesets = new Map<number, Record<string, any>>();
  const labels: Record<string, unknown>[] = [];
  let created = o.repoExists ?? false;
  let nextRuleset = 101;
  /** Every request and the push and the clone, in order: "METHOD /path" or "git push" / "git clone". */
  const events: string[] = [];

  const repoJson = () => ({ id: REPO_ID, name: NAME, full_name: FULL, private: false, default_branch: "main", owner: { login: OWNER, id: USER_ID, type: "User" } });
  const effective = (branch: string) =>
    [...rulesets.entries()]
      .filter(([, r]) => r.target === "branch" && r.enforcement === "active")
      .filter(([, r]) => (r.conditions.ref_name.include as string[]).some((p) => refMatches(p, branch)) && !(r.conditions.ref_name.exclude as string[]).some((p) => refMatches(p, branch)))
      .flatMap(([id, r]) => (r.rules as Record<string, unknown>[]).map((rule) => ({ ...rule, ruleset_source_type: "Repository", ruleset_source: FULL, ruleset_id: id })));

  const routes: Record<string, Route> = {
    [`GET ${API}/user`]: { status: 200, body: { login: OWNER, id: USER_ID, type: o.type ?? "User" }, headers: { "x-oauth-scopes": o.scopes ?? "repo, workflow, read:org" } },
    [`GET ${R}`]: () => (created ? { status: 200, body: repoJson() } : { status: 404, body: { message: "Not Found" } }),
    [`GET ${API}/user/installations?per_page=100`]: { status: 403, body: { message: OAUTH_403 } },
    [`GET ${API}/repos/${OWNER}/hapi-factory/contents/.github/workflows/gates.yml?ref=${GATES}`]:
      o.gatesOnGitHub === false ? { status: 404, body: { message: "No commit found for the ref" } } : { status: 200, body: { type: "file", name: "gates.yml", path: ".github/workflows/gates.yml" } },
    [`POST ${API}/user/repos`]: () => {
      created = true;
      return { status: 201, body: repoJson() };
    },
    [`PATCH ${R}`]: { status: 200, body: repoJson() },
    [`PUT ${R}/actions/permissions/workflow`]: { status: 204 },
    [`PUT ${R}/actions/permissions`]: { status: 204 },
    [`PUT ${R}/actions/permissions/selected-actions`]: { status: 204 },
    [`PUT ${R}/actions/permissions/fork-pr-contributor-approval`]: { status: 204 },
    [`PUT ${R}/private-vulnerability-reporting`]: { status: 204 },
    [`PATCH ${R}/code-scanning/default-setup`]: { status: 202, body: { run_id: 1, run_url: `${R}/actions/runs/1` } },
    [`PUT ${R}/interaction-limits`]: (c) => ({ status: 200, body: { ...(c.body as object), origin: "repository", expires_at: "2027-04-30T12:00:00Z" } }),
    [`POST ${R}/rulesets`]: (c) => {
      const id = nextRuleset++;
      rulesets.set(id, c.body as Record<string, any>);
      return { status: 201, body: withDefaults(id, c.body as Record<string, any>) };
    },
    [`POST ${R}/labels`]: (c) => {
      labels.push(c.body as Record<string, unknown>);
      return { status: 201, body: { id: labels.length, ...(c.body as object) } };
    },
  };
  for (const id of [101, 102, 103, 104]) {
    routes[`GET ${R}/rulesets/${id}`] = () => (rulesets.has(id) ? { status: 200, body: withDefaults(id, rulesets.get(id)!) } : { status: 404, body: { message: "Not Found" } });
  }
  for (const [branch, path] of [["main", "main"], ["some-feature", "some-feature"], ["plan/example", "plan%2Fexample"], ["factory/example", "factory%2Fexample"]] as const) {
    routes[`GET ${R}/rules/branches/${path}?per_page=100`] = () => ({ status: 200, body: effective(branch) });
  }
  for (const i of installations) {
    routes[`PUT ${API}/user/installations/${i.id}/repositories/${REPO_ID}`] = { status: 204 };
    routes[`GET ${API}/user/installations/${i.id}/repositories?per_page=100`] = { status: 403, body: { message: OAUTH_403_REPOS } };
  }
  Object.assign(routes, o.routes ?? {});
  const gh = fakeFetch(routes);
  const fetchAndLog = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    events.push(`${init.method ?? "GET"} ${url.pathname}`);
    return gh.fetch(input, init);
  }) as unknown as typeof fetch;

  /** Every runner call; and, at the push, what the first commit holds and who wrote it (read with real git before the dir goes). */
  const runs: { cmd: string[]; env: Record<string, string> }[] = [];
  const pushed: { files: string[]; author: string; dir: string }[] = [];
  /** Called at the push, after the world records it: lets a test change the world mid-run. */
  let onPush: () => void = () => {};
  const run: Runner = async (cmd, opts) => {
    runs.push({ cmd, env: opts.env });
    if (cmd[0] === "git" && cmd.includes("rev-parse") && cmd.includes("HEAD")) return { code: 0, stdout: `${GATES}\n`, stderr: "" };
    if (cmd[0] === "git" && cmd.includes("status") && cmd.includes("--porcelain")) return { code: 0, stdout: o.dirtyTemplates ? " M templates/repo-contract/AGENTS.md.tmpl\n" : "", stderr: "" };
    if (cmd[0] === "git" && cmd.includes("push")) {
      events.push("git push");
      const dir = cmd[cmd.indexOf("-C") + 1]!;
      const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { env: opts.env, stdout: "pipe", stderr: "pipe" }).stdout.toString();
      pushed.push({ dir, files: git("ls-tree", "-r", "--name-only", "HEAD").trim().split("\n"), author: git("log", "-1", "--format=%an <%ae>").trim() });
      onPush();
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd[0] === "git" && cmd.includes("clone")) {
      events.push("git clone");
      return { code: 0, stdout: "", stderr: "" };
    }
    return runCommand(cmd, opts);
  };

  const out: string[] = [];
  const prompts: string[] = [];
  const audits: AuditContext[] = [];
  let auditResults: CheckResult[] = ["github.rulesets", "github.repo-settings", "github.labels", "repo.ai-workflows"].map((id) => ({ id, status: "pass" as const, detail: `${FULL}: ok` }));
  let onConfirm: (prompt: string) => void = () => {};
  const deps: NewRepoDeps = {
    fetch: fetchAndLog,
    run,
    env: { PATH: process.env.PATH, HOME: base },
    root,
    now: () => NOW,
    out: (line) => void out.push(line),
    confirm: async (prompt) => {
      prompts.push(prompt);
      onConfirm(prompt);
      // Resolve on a later tick, as the operator's Enter does: a step that didn't wait would act before "confirmed".
      await new Promise((r) => setTimeout(r, 1));
      events.push("confirmed");
    },
    audit: async (ctx) => {
      audits.push(ctx);
      return auditResults;
    },
  };
  return {
    deps,
    base,
    root,
    calls: gh.calls,
    events,
    runs,
    pushed,
    out,
    prompts,
    audits,
    rulesets,
    labels,
    /** The non-GET requests and the git push/clone, in order. */
    writes: () => events.filter((e) => !e.startsWith("GET ")),
    setAuditResults: (r: CheckResult[]) => void (auditResults = r),
    setOnConfirm: (f: (prompt: string) => void) => void (onConfirm = f),
    setOnPush: (f: () => void) => void (onPush = f),
    cloneTarget: join(dirname(root), NAME),
  };
}
export type World = ReturnType<typeof newRepoWorld>;
