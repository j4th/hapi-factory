/**
 * The GitHub checks, once per `--repo` (spec §5.1, §7, §11.5, §11.7; handoffs
 * H-023, H-036). Every read of repo state is a GET. The credential:
 *
 * - `--github-token-file <path>`: the operator's own token (a file only its
 *   owner can read; never printed, logged or put in argv), for every read.
 *   GitHub returns a ruleset's `bypass_actors` only to a token with write
 *   access to that ruleset (repository Administration), and the Apps never
 *   get Administration, so this is the only way the bypass checks run.
 * - else an installation token of one of the Apps, from the App keys in
 *   host.env as `hapi token mint` reads them, minted for this one repo with
 *   `contents: read` and `metadata: read` only (the one POST), and revoked
 *   when the audit ends (the one DELETE). The controller's ruling R2 (Task 6
 *   security fix pass) accepts that POST and DELETE under amendment set 2's
 *   ruling 5; the reads stay GET-only. hapi-planner is tried first, then
 *   hapi-factory: an App whose keys aren't in host.env, or whose keys load
 *   but which can't mint for this repo (not installed there, suspended,
 *   refused), is passed over with its reason kept. A token GitHub returns
 *   broader than requested is never passed over: it is a fail. Metadata read
 *   covers the rules and rulesets endpoints; Contents read the workflow files.
 *   If GitHub doesn't confirm the revoke (204), one warning line on stderr
 *   names the App and the HTTP status, never the token.
 * - github.app-perms always uses each App's own JWT (GET /app, GET
 *   /repos/{owner}/{repo}/installation), which needs no permission.
 * With neither, each check is a skip saying what is missing.
 *
 * - github.rulesets: the effective rules on main (GET .../rules/branches/main)
 *   and every ruleset (GET .../rulesets, then each by id), held to
 *   docs/runbooks/github-apps.md as tests/docs/rulesets.test.ts holds the
 *   README's JSON: main-protect and main-review, never one ruleset.
 * - github.app-perms: neither App has administration or workflows, or any
 *   permission beyond the runbook's table, on the App or on its installation
 *   (selected repositories only), and neither is a bypass actor anywhere. A
 *   response with no permissions object or no App id fails: it can't be
 *   cleared.
 * - repo.ai-workflows: no workflow runs an AI agent (a known AI action, or an
 *   AI CLI in a `run:`) on a comment, issue or review trigger, or
 *   `pull_request_target`, in a job that holds a credential: the "Comment and
 *   Control" class (spec §7). A credential is any `${{ }}` expression in the
 *   job (any field at any depth) or the workflow's env that reads a secret
 *   (`secrets.NAME`, `secrets['NAME']`, or `secrets` whole, as in
 *   `toJSON(secrets)`) or the job's token (`github.token`, or the `github`
 *   context whole); a write grant in the job's effective permissions
 *   (`write-all`, or any scope at `write`, `id-token: write` included; the
 *   job's own block replaces the workflow's, and `read-all`, `{}` and read
 *   scopes grant none); or an `actions/checkout` step without
 *   `persist-credentials: false`, which writes the GITHUB_TOKEN into
 *   .git/config. The steps of a job share one runner, so a secret an earlier
 *   step exports reaches the agent, and the agent can rewrite what a later
 *   step runs with its secret. It stays a heuristic: what it doesn't follow
 *   is docs/audit.md's "Not covered yet" and handoffs H-155.
 */
import { lstat, readFile } from "node:fs/promises";
import YAML from "yaml";
import { APPS, type AppName, appCredentials, appJwt, findInstallationId, GITHUB_API, GITHUB_API_VERSION, mintInstallationToken, TokenScopeError } from "../../forge/github/app-token";
import { HAPI_VERSION } from "../../version";
import { type AuditRun, type CheckResult, type RepoRef, result } from "../types";

const repoName = (r: RepoRef) => `${r.owner}/${r.name}`;
const repoPath = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
const asRecord = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const headers = (bearer: string) => ({ Accept: "application/vnd.github+json", Authorization: `Bearer ${bearer}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": `hapi-factory/${HAPI_VERSION}` });

/** An error as one short line, with `secret` (when given) blanked out. */
function oneLine(e: unknown, secret?: string): string {
  let s = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  if (secret !== undefined && secret !== "") s = s.split(secret).join("[redacted]");
  return s.slice(0, 300);
}

/** One GET. Redirects are refused, so a credential never follows one. */
async function get(run: AuditRun, path: string, bearer: string): Promise<{ status: number; json: unknown }> {
  const res = await run.ctx.fetch(`${GITHUB_API}${path}`, {
    method: "GET",
    headers: headers(bearer),
    redirect: "error",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/** GitHub's error message, short and on one line, or "". */
function ghMessage(json: unknown): string {
  const m = asRecord(json)?.message;
  return typeof m === "string" ? `: ${m.replace(/\s+/g, " ").trim().slice(0, 200)}` : "";
}

async function getOk(run: AuditRun, path: string, bearer: string): Promise<unknown> {
  const r = await get(run, path, bearer);
  if (r.status !== 200) throw new Error(`GitHub: GET ${path.replace(/\?.*$/, "")}: HTTP ${r.status}${ghMessage(r.json)}`);
  return r.json;
}

/** Every page of a list endpoint (100 a page, at most 10 pages). */
async function getAll(run: AuditRun, path: string, bearer: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const items = await getOk(run, `${path}?per_page=100&page=${page}`, bearer);
    if (!Array.isArray(items)) throw new Error(`GitHub: GET ${path}: not a list`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

type Credential = { token: string; via: string } | { none: string };

/** The operator's token from --github-token-file: a regular file only its owner can read. Errors name the file, never its contents. */
async function tokenFromFile(file: string): Promise<string> {
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    throw new Error(`cannot read --github-token-file ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!st.isFile()) throw new Error(`--github-token-file ${file} is not a regular file`);
  if ((st.mode & 0o077) !== 0) throw new Error(`--github-token-file ${file} can be read by others (mode ${(st.mode & 0o777).toString(8)}): chmod 600 it`);
  const token = (await readFile(file, "utf8")).trim();
  if (token === "" || /\s/.test(token)) throw new Error(`--github-token-file ${file} must hold one token and nothing else`);
  return token;
}

/**
 * Revoke the audit's own token when the audit ends. GitHub answers 204 when it revoked it; anything else (another
 * status, or a request that fails) prints one warning line on stderr naming the App, the repo and the status, never
 * the token. It never changes the audit's results or exit code: the token expires within the hour regardless.
 */
async function revokeAuditToken(run: AuditRun, appName: string, repo: RepoRef, token: string, expiresAt: string): Promise<void> {
  let why: string;
  try {
    const res = await run.ctx.fetch(`${GITHUB_API}/installation/token`, { method: "DELETE", headers: headers(token), redirect: "error" });
    if (res.status === 204) return;
    why = `HTTP ${res.status}`;
  } catch (e) {
    why = `the request failed: ${oneLine(e, token)}`;
  }
  console.error(
    `hapi audit: warning: GitHub didn't confirm revoking the read-only ${appName} installation token the audit minted for ${repoName(repo)} (DELETE /installation/token: ${why}); ` +
      `it stays valid until ${expiresAt}, at most an hour; suspend the App's installation to end it sooner (docs/runbooks/github-apps.md)`,
  );
}

/**
 * The credential for a repo's reads (memoized per repo). The operator's token file, else a read-only App token:
 * hapi-planner first, then hapi-factory. An App whose keys aren't in host.env is passed over (a skip if neither has
 * them), and so is one whose keys load but which can't mint for this repo (not installed there, suspended, refused),
 * with its reason kept: if neither App mints, the reasons are a fail. A token broader than requested is a fail at
 * once (mintInstallationToken has revoked it), never a reason to try the other App. No reason holds a token.
 */
function credential(run: AuditRun, repo: RepoRef): Promise<Credential> {
  return run.once(`gh-cred:${repoName(repo)}`, async (): Promise<Credential> => {
    const { ctx } = run;
    if (ctx.githubTokenFile !== undefined) return { token: await tokenFromFile(ctx.githubTokenFile), via: "the operator's token (--github-token-file)" };
    const noKeys: string[] = [];
    const cannotMint: string[] = [];
    for (const app of ["planner", "factory"] as const) {
      const appName = APPS[app].name;
      let creds;
      try {
        creds = await appCredentials(app, ctx.env);
      } catch (e) {
        noKeys.push(`${appName}: ${oneLine(e)}`);
        continue;
      }
      const common = { ...creds, fetch: ctx.fetch, now: ctx.now };
      let minted: { token: string; expiresAt: string };
      try {
        const installationId = await findInstallationId({ ...common, owner: repo.owner, repo: repo.name });
        minted = await mintInstallationToken({ ...common, installationId, repositories: [repo.name], permissions: { contents: "read", metadata: "read" } });
      } catch (e) {
        if (e instanceof TokenScopeError) throw new Error(`${appName}: ${oneLine(e)} The audit tries no other App after a token broader than requested`);
        cannotMint.push(`${appName}: ${oneLine(e)}`);
        continue;
      }
      const { token, expiresAt } = minted;
      run.cleanups.push(() => revokeAuditToken(run, appName, repo, token, expiresAt));
      return { token, via: `a read-only ${appName} installation token (contents and metadata read, revoked when the audit ends)` };
    }
    if (cannotMint.length > 0) {
      throw new Error(`neither App could mint a read-only token for ${repoName(repo)} (pass --github-token-file, or fix the App): ${[...cannotMint, ...noKeys].join("; ")}`);
    }
    return { none: `no GitHub credentials: pass --github-token-file, or let the audit mint a read-only App token from the App keys (${noKeys.join("; ") || "host.env"})` };
  });
}

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
  ruleset_id?: number;
}
interface Ruleset {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode?: string }[];
  rules?: Rule[];
}
interface RepoData {
  via: string;
  /** The effective rules on main. */
  rules: Rule[];
  rulesets: Ruleset[];
  /** Whether GitHub returned bypass_actors for every ruleset (only to a token with write access to them). */
  bypassVisible: boolean;
}

/** A repo's rules on main and every ruleset (memoized per repo), or the reason there are none to read. */
function repoData(run: AuditRun, repo: RepoRef): Promise<RepoData | { none: string }> {
  return run.once(`gh-data:${repoName(repo)}`, async () => {
    const cred = await credential(run, repo);
    if ("none" in cred) return cred;
    const rules = (await getAll(run, `${repoPath(repo)}/rules/branches/main`, cred.token)) as Rule[];
    const list = (await getAll(run, `${repoPath(repo)}/rulesets`, cred.token)) as Ruleset[];
    const rulesets: Ruleset[] = [];
    for (const r of list) rulesets.push((await getOk(run, `${repoPath(repo)}/rulesets/${Number(r.id)}`, cred.token)) as Ruleset);
    return { via: cred.via, rules, rulesets, bypassVisible: rulesets.every((r) => Array.isArray(r.bypass_actors)) };
  });
}

const NO_REPO = "no --repo given";
const ADMIN_PR_ONLY = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }];
/** GitHub Actions' integration id: only Actions can satisfy the ci check. */
const ACTIONS = 15368;

/** github.rulesets */
export async function githubRulesets(run: AuditRun): Promise<CheckResult[]> {
  const id = "github.rulesets";
  if (run.ctx.repos.length === 0) return [result(id, "skip", NO_REPO)];
  const out: CheckResult[] = [];
  for (const repo of run.ctx.repos) {
    const name = repoName(repo);
    const data = await repoData(run, repo).catch((e: Error) => ({ error: e.message }));
    if ("error" in data) {
      out.push(result(id, "fail", `${name}: ${data.error}`));
      continue;
    }
    if ("none" in data) {
      out.push(result(id, "skip", `${name}: ${data.none}`));
      continue;
    }
    const problems: string[] = [];
    const rules = data.rules;
    const of = (type: string) => rules.filter((r) => r.type === type);
    if (!of("pull_request").some((r) => Number(r.parameters?.required_approving_review_count) >= 1)) {
      problems.push("main has no pull_request rule with required_approving_review_count ≥ 1");
    }
    const checks = of("required_status_checks").flatMap((r) => (Array.isArray(r.parameters?.required_status_checks) ? (r.parameters!.required_status_checks as Record<string, unknown>[]) : []));
    const ci = checks.filter((c) => c.context === "ci");
    if (ci.length === 0) problems.push("main has no required_status_checks rule with the ci check");
    else if (!ci.some((c) => c.integration_id === ACTIONS)) problems.push(`main's ci check isn't tied to GitHub Actions (integration_id ${ACTIONS}), so another integration could satisfy it`);
    // Only ci gates a merge. A third-party App's check (CodeRabbit's, spec §9.6) is never a required one: an advisory
    // reviewer that could block or, once green, stand in for a gate.
    const others = [...new Set(checks.filter((c) => c.context !== "ci").map((c) => String(c.context)))];
    if (others.length > 0) problems.push(`main requires status checks other than ci (${others.join(", ")}): only GitHub Actions' ci gates a merge, and no third-party reviewer's check, such as CodeRabbit's, is ever a required one`);
    for (const t of ["deletion", "non_fast_forward"]) if (of(t).length === 0) problems.push(`main has no ${t} rule`);

    const onMain = new Set(rules.map((r) => r.ruleset_id));
    const review = data.rulesets.find((r) => r.name === "main-review" && onMain.has(r.id));
    if (review === undefined) problems.push("no ruleset named main-review applies to main");
    else {
      const rr = review.rules ?? [];
      if (!rr.some((r) => r.type === "update")) problems.push("main-review has no update (Restrict updates) rule, so an App could merge");
      const pr = rr.find((r) => r.type === "pull_request")?.parameters;
      if (pr?.require_code_owner_review !== true) problems.push("main-review's pull_request rule doesn't set require_code_owner_review");
      if (Number(pr?.required_approving_review_count) < 1) problems.push("main-review's required_approving_review_count is below 1");
      if (data.bypassVisible && JSON.stringify((review.bypass_actors ?? []).map(({ actor_id, actor_type, bypass_mode }) => ({ actor_id, actor_type, bypass_mode }))) !== JSON.stringify(ADMIN_PR_ONLY)) {
        problems.push("main-review's bypass actors are not exactly the Admin role (actor_id 5), PR-only");
      }
    }
    if (data.bypassVisible) {
      for (const r of data.rulesets) {
        const bypass = r.bypass_actors ?? [];
        const rr = r.rules ?? [];
        if (rr.some((x) => x.type === "required_status_checks") && bypass.length > 0) problems.push(`${r.name} holds required_status_checks and has bypass actors, so its bypass would also bypass ci`);
        if (rr.some((x) => x.type === "update") && bypass.length === 0) problems.push(`${r.name} has update and no bypass actors, so it stops every merge`);
        if (bypass.some((a) => a.actor_type === "Integration")) problems.push(`${r.name} has an Integration (GitHub App) bypass actor`);
      }
    }
    if (problems.length > 0) {
      out.push(result(id, "fail", `${name}: ${problems.join("; ")}. Fix the rulesets as docs/runbooks/github-apps.md and the README set them (read with ${data.via})`));
    } else if (!data.bypassVisible) {
      out.push(
        result(
          id,
          "skip",
          `${name}: the rules on main pass, but GitHub returned no bypass_actors (it shows them only to a token with write access to the ruleset, i.e. repository Administration, which the Apps never get), so no bypass check was made: pass --github-token-file with the operator's token`,
        ),
      );
    } else {
      out.push(
        result(
          id,
          "pass",
          `${name}: main requires only the ci check, from GitHub Actions, with no bypass, blocks force-pushes and deletion, and main-review requires 1 code-owner approval with Restrict updates and only the Admin PR-only bypass; no ruleset without bypass actors restricts updates, and no App is a bypass actor (read with ${data.via})`,
        ),
      );
    }
  }
  return out;
}

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** What in `granted` goes beyond `app`'s runbook permissions (administration and workflows always do). */
function beyond(app: AppName, granted: Record<string, unknown>): string[] {
  const allowed: Record<string, string> = APPS[app].permissions;
  const out: string[] = [];
  for (const [k, v] of Object.entries(granted)) {
    if (k === "administration" || k === "workflows") out.push(`${k}: ${String(v)}`);
    else if (!Object.hasOwn(allowed, k) || (LEVELS[String(v)] ?? Infinity) > LEVELS[allowed[k]!]!) out.push(`${k}: ${String(v)}`);
  }
  return out;
}

/** github.app-perms */
export async function githubAppPerms(run: AuditRun): Promise<CheckResult[]> {
  const id = "github.app-perms";
  if (run.ctx.repos.length === 0) return [result(id, "skip", NO_REPO)];
  const out: CheckResult[] = [];
  for (const repo of run.ctx.repos) {
    const name = repoName(repo);
    const problems: string[] = [];
    const gaps: string[] = [];
    const checked: { app: AppName; id: number }[] = [];
    for (const app of ["planner", "factory"] as const) {
      const appName = APPS[app].name;
      let creds;
      try {
        creds = await appCredentials(app, run.ctx.env);
      } catch (e) {
        gaps.push(`${appName}: ${(e as Error).message}`);
        continue;
      }
      const jwt = await appJwt(creds.appId, creds.privateKeyPem, run.ctx.now());
      try {
        const self = asRecord(await getOk(run, "/app", jwt));
        const inst = asRecord(await getOk(run, `${repoPath(repo)}/installation`, jwt));
        // A response with nothing to check fails: an App is never cleared on what GitHub didn't say.
        const selfPerms = asRecord(self?.permissions);
        const instPerms = asRecord(inst?.permissions);
        if (selfPerms === undefined) problems.push(`${appName}: GET /app returned no permissions object, so the App's permissions can't be checked`);
        else for (const p of beyond(app, selfPerms)) problems.push(`${appName} has ${p}, beyond docs/runbooks/github-apps.md's table`);
        if (instPerms === undefined) problems.push(`${appName}: GET ${repoPath(repo)}/installation returned no permissions object, so its installation's permissions can't be checked`);
        else for (const p of beyond(app, instPerms)) problems.push(`${appName}'s installation on ${name} has ${p}`);
        if (inst?.repository_selection !== "selected") problems.push(`${appName}'s installation covers all repositories, not selected ones`);
        if (typeof self?.id === "number") checked.push({ app, id: self.id });
        else problems.push(`${appName}: GET /app returned no App id, so whether the App is a ruleset bypass actor can't be checked`);
      } catch (e) {
        problems.push(`${appName}: ${(e as Error).message}`);
      }
    }
    if (checked.length === 0 && problems.length === 0) {
      out.push(result(id, "skip", `${name}: no GitHub credentials for either App: ${gaps.join("; ")}`));
      continue;
    }
    // No credential to read the rulesets is a gap (a skip); a read that fails is a fail, as in github.rulesets.
    const data = await repoData(run, repo).catch((e: Error) => ({ error: e.message }));
    if ("error" in data) problems.push(`reading the rulesets failed, so whether an App is a bypass actor can't be checked: ${data.error}`);
    else if ("none" in data || !data.bypassVisible) gaps.push(`no ruleset's bypass_actors could be read (${"none" in data ? data.none : "GitHub shows them only to a token with Administration write: pass --github-token-file"})`);
    else {
      for (const r of data.rulesets) {
        for (const a of r.bypass_actors ?? []) {
          const hit = checked.find((c) => a.actor_type === "Integration" && a.actor_id === c.id);
          if (hit !== undefined) problems.push(`${APPS[hit.app].name} is a bypass actor on ${r.name}`);
        }
      }
    }
    const apps = checked.map((c) => APPS[c.app].name).join(" and ");
    if (problems.length > 0) out.push(result(id, "fail", `${name}: ${problems.join("; ")}. Set each App's permissions exactly as docs/runbooks/github-apps.md, and never make an App a bypass actor`));
    else if (gaps.length > 0) out.push(result(id, "skip", `${name}: ${apps} have only the runbook's permissions, but ${gaps.join("; ")}`));
    else out.push(result(id, "pass", `${name}: ${apps} have only the runbook's permissions (no administration, no workflows), are installed on selected repositories, and neither is a ruleset bypass actor`));
  }
  return out;
}

/** The triggers that run a workflow on input from anyone who can comment, open an issue or a discussion, or review, or with a fork's PR and the base's secrets. */
const FORBIDDEN_TRIGGER = /^(issue_comment|issues|discussion|discussion_comment|pull_request_review.*|pull_request_target)$/;
/** AI agent actions. */
const AI_ACTIONS = [
  /^anthropics\/claude-code(?:-base)?-action(?:@|$)/i,
  /^openai\/codex-action(?:@|$)/i,
  /^google-github-actions\/run-gemini-cli(?:@|$)/i,
  /^google-gemini\/gemini-cli-action(?:@|$)/i,
  /^actions\/ai-inference(?:@|$)/i,
];
/** An AI agent CLI started in a `run:` step. */
const AI_CLI = /(?:^|[\s;&|(])(?:npx\s+(?:-y\s+)?)?(?:@anthropic-ai\/claude-code|@openai\/codex|@google\/gemini-cli|claude|codex|gemini|aider|opencode)(?:@\S*)?(?=\s|$)/m;
/** actions/checkout, at any ref: by default it writes the job's GITHUB_TOKEN into .git/config (`persist-credentials: true`). */
const CHECKOUT = /^actions\/checkout(?:@|$)/i;
const CHECKOUT_TOKEN = "actions/checkout's persisted GITHUB_TOKEN (no persist-credentials: false)";

/** A workflow's triggers, in any spelling of `on`. */
function triggers(doc: Record<string, unknown>): string[] {
  // YAML 1.1 readers turn a bare `on` key into true; this parser (YAML 1.2) keeps it a string, but take either.
  const on = doc.on ?? doc["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(asRecord(on) ?? {});
}

/** Every string in a workflow value, mapping keys included, at any depth. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
}

/** The bodies of a string's `${{ … }}` expressions. A `}}` inside a quoted string doesn't end one; an unclosed one runs to the end. */
function expressions(s: string): string[] {
  const out: string[] = [];
  for (let i = s.indexOf("${{"); i !== -1; i = s.indexOf("${{", i)) {
    let j = i + 3;
    let quoted = false;
    for (; j < s.length; j++) {
      // An escaped quote ('') toggles twice, so it stays inside the string.
      if (s[j] === "'") quoted = !quoted;
      else if (!quoted && s.startsWith("}}", j)) break;
    }
    out.push(s.slice(i + 3, j));
    i = j + 2;
  }
  return out;
}

/** An expression's tokens: a quoted string, a name (contexts and properties may hold `-`), or one other character. */
const EXPRESSION_TOKEN = /'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_-]*|\S/g;

/**
 * The credentials one expression reads. Context and property names are matched without regard to case, as GitHub
 * reads them, and a name inside a quoted string is only text.
 * - `secrets.NAME` or `secrets['NAME']`: that secret; `secrets[<an expression>]`: a secret by a computed name;
 *   `secrets` as a whole (as in `toJSON(secrets)`): every secret.
 * - `github.token` or `github['token']`: the job's token; `github` as a whole (as in `toJSON(github)`), or by a
 *   computed property: the token too, which the github context holds.
 */
function expressionCredentials(body: string): string[] {
  const t = [...body.matchAll(EXPRESSION_TOKEN)].map((m) => m[0]);
  const literal = (x: string | undefined) => (x?.startsWith("'") ? x.slice(1, -1).replace(/''/g, "'") : undefined);
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const context = t[i]!.toLowerCase();
    // A property (steps.secrets, event.github) isn't the context.
    if ((context !== "secrets" && context !== "github") || t[i - 1] === ".") continue;
    let property: string | undefined;
    let computed = false;
    if (t[i + 1] === "." && /^[A-Za-z_]/.test(t[i + 2] ?? "")) property = t[i + 2];
    else if (t[i + 1] === "[") {
      property = t[i + 3] === "]" ? literal(t[i + 2]) : undefined;
      computed = property === undefined;
    }
    if (context === "secrets") out.push(property !== undefined ? `secrets.${property}` : computed ? "a secret by a computed name (secrets[…])" : "every secret (secrets as a whole)");
    else if (property === undefined) out.push(computed ? "github.token" : "github.token (the whole github context)");
    else if (property.toLowerCase() === "token") out.push("github.token");
  }
  return out;
}

/**
 * What a job's GITHUB_TOKEN permissions grant that counts as a credential: `write-all`, or any scope at `write`
 * (`id-token: write` lets every step of the job mint an OIDC token). `read-all`, `{}` and read scopes grant none.
 * A form GitHub doesn't read counts, since it can't be cleared.
 */
function permissionGrants(p: unknown): string[] {
  if (p === undefined || p === null) return [];
  if (typeof p === "string") return p.trim().toLowerCase() === "read-all" ? [] : p.trim().toLowerCase() === "write-all" ? ["permissions: write-all"] : [`permissions: ${p.trim()} (a form the audit can't read)`];
  const scopes = asRecord(p);
  if (scopes === undefined) return [`permissions: ${JSON.stringify(p)} (a form the audit can't read)`];
  return Object.entries(scopes)
    .filter(([, level]) => String(level).trim().toLowerCase() === "write")
    .map(([scope]) => `${scope}: write`);
}

/** Whether a step is actions/checkout keeping the job's token in .git/config: anything but `persist-credentials: false` does. */
function persistsToken(step: Record<string, unknown> | undefined): boolean {
  if (typeof step?.uses !== "string" || !CHECKOUT.test(step.uses.trim())) return false;
  const persist = asRecord(step.with)?.["persist-credentials"];
  return !(persist === false || (typeof persist === "string" && persist.trim().toLowerCase() === "false"));
}

/**
 * The credentials a job holds: what its expressions read (any field at any depth, and the workflow's env); what its
 * effective GITHUB_TOKEN permissions grant (the job's own block replaces the workflow's); and an actions/checkout step
 * that leaves the token in .git/config.
 */
function jobCredentials(doc: Record<string, unknown>, job: Record<string, unknown>): string[] {
  const found = new Set<string>();
  for (const s of strings([job, doc.env])) for (const body of expressions(s)) for (const c of expressionCredentials(body)) found.add(c);
  for (const g of permissionGrants(job.permissions ?? doc.permissions)) found.add(g);
  for (const step of Array.isArray(job.steps) ? job.steps.map(asRecord) : []) if (persistsToken(step)) found.add(CHECKOUT_TOKEN);
  return [...found].sort();
}

/** Why a workflow runs an AI agent with a credential on a forbidden trigger, or [] when it doesn't. */
export function aiWorkflowProblems(path: string, text: string): string[] {
  let doc: Record<string, unknown> | undefined;
  try {
    doc = asRecord(YAML.parse(text));
  } catch {
    return [`${path} does not parse as YAML, so it can't be cleared`];
  }
  if (doc === undefined) return [`${path} is not a workflow (not a YAML mapping), so it can't be cleared`];
  const bad = triggers(doc).filter((t) => FORBIDDEN_TRIGGER.test(t));
  if (bad.length === 0) return [];
  const problems: string[] = [];
  for (const [jobName, job] of Object.entries(asRecord(doc.jobs) ?? {})) {
    const j = asRecord(job) ?? {};
    // Everything the job holds: every field of every step (`run:` included, where a secret can be written inline,
    // or exported to $GITHUB_ENV for the steps after it), the job's own env and other fields, the workflow's env,
    // the job's effective permissions, and a checkout that keeps its token.
    const creds = jobCredentials(doc, j);
    if (creds.length === 0) continue;
    for (const step of Array.isArray(j.steps) ? j.steps.map(asRecord) : []) {
      const uses = typeof step?.uses === "string" ? step.uses : undefined;
      const runLine = typeof step?.run === "string" ? step.run : undefined;
      const action = uses !== undefined && AI_ACTIONS.some((re) => re.test(uses)) ? uses : undefined;
      // Only the CLI's name: the rest of a run line is never echoed, since it could hold a literal secret.
      const cli = runLine === undefined ? undefined : AI_CLI.exec(runLine)?.[0].replace(/^[\s;&|(]+/, "");
      if (action === undefined && cli === undefined) continue;
      problems.push(`${path} (job ${jobName}) runs ${action ?? `${cli} in a run: step`} on ${bad.join(", ")}, and the job holds ${creds.join(", ")}`);
    }
  }
  return problems;
}

/** repo.ai-workflows */
export async function repoAiWorkflows(run: AuditRun): Promise<CheckResult[]> {
  const id = "repo.ai-workflows";
  if (run.ctx.repos.length === 0) return [result(id, "skip", NO_REPO)];
  const out: CheckResult[] = [];
  for (const repo of run.ctx.repos) {
    const name = repoName(repo);
    try {
      const cred = await credential(run, repo);
      if ("none" in cred) {
        out.push(result(id, "skip", `${name}: ${cred.none}`));
        continue;
      }
      const dir = await get(run, `${repoPath(repo)}/contents/.github/workflows`, cred.token);
      if (dir.status === 404) {
        out.push(result(id, "pass", `${name}: no .github/workflows`));
        continue;
      }
      if (dir.status !== 200 || !Array.isArray(dir.json)) throw new Error(`GitHub: GET ${repoPath(repo)}/contents/.github/workflows: HTTP ${dir.status}${ghMessage(dir.json)}`);
      const files = dir.json.map(asRecord).filter((f) => f?.type === "file" && typeof f.name === "string" && /\.ya?ml$/.test(f.name as string)).map((f) => f!.name as string).sort();
      const problems: string[] = [];
      for (const file of files) {
        const body = asRecord(await getOk(run, `${repoPath(repo)}/contents/.github/workflows/${encodeURIComponent(file)}`, cred.token));
        if (body?.encoding !== "base64" || typeof body.content !== "string") throw new Error(`GitHub: .github/workflows/${file}: no base64 content`);
        problems.push(...aiWorkflowProblems(`.github/workflows/${file}`, Buffer.from(body.content, "base64").toString("utf8")));
      }
      if (problems.length > 0) {
        out.push(
          result(
            id,
            "fail",
            `${name}: ${problems.join("; ")}. Anyone who can comment, open an issue or review can steer an agent that holds those credentials (spec §7, §11.7): remove the workflow, or move it to a trigger that gets no secrets`,
          ),
        );
      } else out.push(result(id, "pass", `${name}: ${files.length} workflows, none runs an AI agent with credentials on issue_comment, issues, pull_request_review* or pull_request_target (read with ${cred.via})`));
    } catch (e) {
      out.push(result(id, "fail", `${name}: ${(e as Error).message}`));
    }
  }
  return out;
}
