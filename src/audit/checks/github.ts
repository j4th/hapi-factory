/**
 * The GitHub checks, once per `--repo` (spec §5.1, §7, §11.5, §11.7; handoffs
 * H-023, H-036). Every read is a GET. The credential:
 *
 * - `--github-token-file <path>`: the operator's own token (a file only its
 *   owner can read; never printed, logged or put in argv), for every read.
 *   GitHub returns a ruleset's `bypass_actors` only to a token with write
 *   access to that ruleset (repository Administration), and the Apps never
 *   get Administration, so this is the only way the bypass checks run.
 * - else an installation token of one of the Apps (hapi-planner, else
 *   hapi-factory), from the App keys in host.env as `hapi token mint` reads
 *   them, minted for this one repo with `contents: read` and `metadata: read`
 *   only (the one POST), and revoked when the audit ends (the one DELETE).
 *   Metadata read covers the rules and rulesets endpoints; Contents read the
 *   workflow files.
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
 *   (selected repositories only), and neither is a bypass actor anywhere.
 * - repo.ai-workflows: no workflow runs an AI agent (a known AI action, or an
 *   AI CLI in a `run:`) on a comment, issue or review trigger, or
 *   `pull_request_target`, in a job that holds a credential (a `secrets.*` or
 *   `github.token` reference anywhere in the job, in any step's inputs, env or
 *   script, or the workflow's env; or `id-token: write`): the "Comment and
 *   Control" class (spec §7). The steps of a job share one runner, so a
 *   secret an earlier step exports reaches the agent, and the agent can
 *   rewrite what a later step runs with its secret.
 */
import { lstat, readFile } from "node:fs/promises";
import YAML from "yaml";
import { APPS, type AppName, appCredentials, appJwt, findInstallationId, GITHUB_API, GITHUB_API_VERSION, mintInstallationToken } from "../../forge/github/app-token";
import { HAPI_VERSION } from "../../version";
import { type AuditRun, type CheckResult, type RepoRef, result } from "../types";

const repoName = (r: RepoRef) => `${r.owner}/${r.name}`;
const repoPath = (r: RepoRef) => `/repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.name)}`;
const asRecord = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** One GET. Redirects are refused, so a credential never follows one. */
async function get(run: AuditRun, path: string, bearer: string): Promise<{ status: number; json: unknown }> {
  const res = await run.ctx.fetch(`${GITHUB_API}${path}`, {
    method: "GET",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${bearer}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": `hapi-factory/${HAPI_VERSION}` },
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

/** The credential for a repo's reads (memoized per repo). */
function credential(run: AuditRun, repo: RepoRef): Promise<Credential> {
  return run.once(`gh-cred:${repoName(repo)}`, async (): Promise<Credential> => {
    const { ctx } = run;
    if (ctx.githubTokenFile !== undefined) return { token: await tokenFromFile(ctx.githubTokenFile), via: "the operator's token (--github-token-file)" };
    const missing: string[] = [];
    for (const app of ["planner", "factory"] as const) {
      let creds;
      try {
        creds = await appCredentials(app, ctx.env);
      } catch (e) {
        missing.push((e as Error).message);
        continue;
      }
      const common = { ...creds, fetch: ctx.fetch, now: ctx.now };
      const installationId = await findInstallationId({ ...common, owner: repo.owner, repo: repo.name });
      const { token } = await mintInstallationToken({ ...common, installationId, repositories: [repo.name], permissions: { contents: "read", metadata: "read" } });
      run.cleanups.push(async () => {
        await ctx.fetch(`${GITHUB_API}/installation/token`, {
          method: "DELETE",
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": GITHUB_API_VERSION, "User-Agent": `hapi-factory/${HAPI_VERSION}` },
          redirect: "error",
        });
      });
      return { token, via: `a read-only ${APPS[app].name} installation token (contents and metadata read, revoked when the audit ends)` };
    }
    return { none: `no GitHub credentials: pass --github-token-file, or let the audit mint a read-only App token from the App keys (${missing[0] ?? "host.env"})` };
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
          `${name}: main requires the ci check from GitHub Actions with no bypass, blocks force-pushes and deletion, and main-review requires 1 code-owner approval with Restrict updates and only the Admin PR-only bypass; no ruleset without bypass actors restricts updates, and no App is a bypass actor (read with ${data.via})`,
        ),
      );
    }
  }
  return out;
}

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** What in `granted` goes beyond `app`'s runbook permissions (administration and workflows always do). */
function beyond(app: AppName, granted: unknown): string[] {
  const allowed: Record<string, string> = APPS[app].permissions;
  const out: string[] = [];
  for (const [k, v] of Object.entries(asRecord(granted) ?? {})) {
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
        for (const p of beyond(app, self?.permissions)) problems.push(`${appName} has ${p}, beyond docs/runbooks/github-apps.md's table`);
        for (const p of beyond(app, inst?.permissions)) problems.push(`${appName}'s installation on ${name} has ${p}`);
        if (inst?.repository_selection !== "selected") problems.push(`${appName}'s installation covers all repositories, not selected ones`);
        if (typeof self?.id === "number") checked.push({ app, id: self.id });
      } catch (e) {
        problems.push(`${appName}: ${(e as Error).message}`);
      }
    }
    if (checked.length === 0 && problems.length === 0) {
      out.push(result(id, "skip", `${name}: no GitHub credentials for either App: ${gaps.join("; ")}`));
      continue;
    }
    const data = await repoData(run, repo).catch((e: Error) => ({ none: e.message }));
    if ("none" in data || !data.bypassVisible) gaps.push(`no ruleset's bypass_actors could be read (${"none" in data ? data.none : "GitHub shows them only to a token with Administration write: pass --github-token-file"})`);
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

/** The triggers that run a workflow on input from anyone who can comment, open an issue or review, or with a fork's PR and the base's secrets. */
const FORBIDDEN_TRIGGER = /^(issue_comment|issues|pull_request_review.*|pull_request_target)$/;
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
const CREDENTIAL = /\$\{\{\s*(?:secrets\.[A-Za-z0-9_]+|github\.token)\s*\}\}/g;

/** A workflow's triggers, in any spelling of `on`. */
function triggers(doc: Record<string, unknown>): string[] {
  // YAML 1.1 readers turn a bare `on` key into true; this parser (YAML 1.2) keeps it a string, but take either.
  const on = doc.on ?? doc["true"];
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(asRecord(on) ?? {});
}

/** The credentials the given parts of a workflow reference, in any field at any depth (secret names, github.token), or grant (`id-token: write` in a permissions block). */
function credentials(...parts: unknown[]): string[] {
  const found = new Set<string>();
  for (const p of parts) {
    for (const m of JSON.stringify(p ?? null).matchAll(CREDENTIAL)) found.add(m[0].replace(/\$\{\{\s*|\s*\}\}/g, ""));
    if (asRecord(p)?.["id-token"] === "write") found.add("id-token: write");
  }
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
    // or exported to $GITHUB_ENV for the steps after it), the job's own env, permissions and other fields, and the
    // workflow's env and permissions.
    const creds = credentials(j, j.permissions, doc.env, doc.permissions);
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
