/**
 * `hapi new-repo` (design §3.2; spec §7): make a new public GitHub repo ready for the factory, with the operator's
 * own `gh` login. It is the only part of Plan 03 that acts with the operator's rights, and only the operator runs it,
 * from their own terminal: agents never create repos.
 *
 * The eleven steps, in this order (the order matters):
 *  1. preflight: reads only. The login has the `repo` and `workflow` scopes and is a personal account; the name is
 *     valid and free; hapi-planner and hapi-factory are installed on selected repositories only, with the ids
 *     policy/repos.yaml records (and CodeRabbit's, if it records one), which doesn't register the repo yet; the
 *     checkout's HEAD is the gates commit, its template, gates.yml and rulesets are committed, and GitHub has gates.yml
 *     at that commit; a --clone target is free.
 *  2. render: templates/repo-contract, then the checks of `contractProblems` (H-194, exact versions, mise.lock,
 *     repo.ai-workflows, the overlay only tightening).
 *  3. create: the repo, public and empty, issues on.
 *  4. push: the first commit, by the operator's noreply identity, to main, before any ruleset exists (afterwards
 *     main-review's Restrict updates and main-protect's required check refuse even the operator's direct push). The
 *     token reaches git only in the push's environment (`authedHostGit`, src/run/git.ts), never argv.
 *  5. settings: `contractSettings`, private vulnerability reporting, CodeQL's default setup, and with
 *     --collaborators-only an interaction limit.
 *  6. rulesets: the four in policy/github/rulesets, main-protect requiring CONTRACT_CHECK and agent-branch-scope
 *     excluding Dependabot's branches; each read back by id, then the rules GitHub applies on main, a feature
 *     branch, plan/** and factory/**.
 *  7. labels: LABELS.
 *  8. apps: only now, the repo added to each App's installation; a 403 or 404 becomes a web step the command waits on
 *     (`confirm`); then each installation must list the repo.
 *  9. register: the repo in policy/repos.yaml, an uncommitted change the operator reviews and commits by PR.
 * 10. clone: with --clone only, into ../<name> beside the checkout, never inside it (H-178).
 * 11. verify: the strict audit's GitHub checks for the new repo, on the same in-memory token.
 *
 * A failed step stops the command: it prints the failure (the token redacted), what was done and what to undo,
 * newest first, and returns 1. It never retries. With --dry-run, steps 3-11 print what they would do and do nothing.
 */
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { defaultExec, type runAudit } from "../audit/index";
import { parseOwnerRepo } from "../forge/github/app-token";
import { asRecord, ghMessage, oneLine, paginate, rest } from "../forge/github/rest";
import { CONTRACT_CHECK, contractSettings, LABELS } from "../forge/index";
import { loadPolicy } from "../policy/load";
import { authedHostGit } from "../run/git";
import { definedEnv, type Env, type Runner } from "../stack/up";
import { contractProblems, renderTemplate, TEMPLATE_DIR } from "./render";

export interface NewRepoOptions {
  name: string;
  clone: boolean;
  collaboratorsOnly: boolean;
  dryRun: boolean;
}

export interface NewRepoDeps {
  fetch: typeof fetch;
  run: Runner;
  env: Env;
  /** hapi-factory's checkout: its policy/, templates/ and HEAD. */
  root: string;
  now: () => Date;
  out: (line: string) => void;
  /** Show a web step's prompt and wait for the operator (Enter). */
  confirm: (prompt: string) => Promise<void>;
  audit: typeof runAudit;
}

export const STEPS = ["preflight", "render", "create", "push", "settings", "rulesets", "labels", "apps", "register", "clone", "verify"] as const;
type StepName = (typeof STEPS)[number];

/** The checks step 11 runs: the GitHub side of the contract. github.app-perms, which needs the App keys, is the operator's audit as hapi (docs/runbooks/new-repo.md#verify). */
export const VERIFY_CHECKS = ["github.rulesets", "github.repo-settings", "github.labels", "repo.ai-workflows"] as const;
/** GitHub Actions' integration id: only Actions can satisfy the required check. */
const ACTIONS = 15368;
/** The rulesets, in the order they are posted (policy/github/rulesets/<name>.json). */
const RULESETS = ["main-protect", "main-review", "agent-branch-scope", "tags-admin-only"] as const;
/** Dependabot's branches, dependabot/<ecosystem>/<name>: the template turns Dependabot on (the audit's `mayExclude`). */
const DEPENDABOT = "refs/heads/dependabot/**/*";
/** The Apps, by the slug GitHub lists their installations under. */
const APP_SLUGS = { planner: "hapi-planner", factory: "hapi-factory", coderabbit: "coderabbitai" } as const;

interface App {
  slug: string;
  id: number;
  /** Why its PUT is skipped (CodeRabbit installed on all repositories), if it is. */
  skip?: string;
}

/** What every step works on. */
interface Ctx {
  d: NewRepoDeps;
  token: string;
  o: NewRepoOptions;
  owner: string;
  userId: number;
  /** owner/name. */
  full: string;
  gatesSha: string;
  files: Map<string, string>;
  repoId: number;
  apps: App[];
  /** What to undo, oldest first, pushed the moment something is created. */
  undo: string[];
}

/** A step's line, and whether it changed anything (only those are listed under "Done so far"). */
interface StepResult {
  line: string;
  acted: boolean;
}

const would = (what: string): StepResult => ({ line: `would: ${what}`, acted: false });
const done = (line: string): StepResult => ({ line, acted: true });
const short = (sha: string) => sha.slice(0, 7);

/** One GitHub call whose status must be one of `want`; the error names the method, the path (no query) and GitHub's message. */
async function gh(c: Ctx, method: string, path: string, want: readonly number[], body?: unknown): Promise<unknown> {
  const r = await rest(c.d.fetch, method, path, c.token, body);
  if (!want.includes(r.status)) throw new Error(`${method} ${path.replace(/\?.*$/, "")}: HTTP ${r.status}${ghMessage(r.json)}`);
  return r.json;
}

/**
 * git with no system or global config, no hooks, no fsmonitor, no prompt and https only: every git call but the
 * clone. The push alone adds the token, through `authedHostGit` (src/run/git.ts), which has the same flags.
 */
function gitEnv(d: NewRepoDeps): Record<string, string> {
  return { PATH: d.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" };
}
async function git(c: Ctx, dir: string, args: string[]): Promise<string> {
  return gitIn(c, { cmd: ["git", "-C", dir, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"], env: gitEnv(c.d) }, args);
}
/** `args` after `base.cmd`, with exactly `base.env`. */
async function gitIn(c: Ctx, base: { cmd: string[]; env: Record<string, string> }, args: string[]): Promise<string> {
  const r = await c.d.run([...base.cmd, ...args], { env: base.env, inherit: false });
  if (r.code !== 0) throw new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? args[0]} exited ${r.code}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`);
  return r.stdout;
}

const exists = async (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );
const cloneTarget = (c: Ctx) => join(dirname(c.d.root), c.o.name);
const cloneTaken = (path: string, name: string) => `${path} already exists: --clone clones into ../${name}, beside the checkout, so move it away or leave out --clone`;

// ---------------------------------------------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------------------------------------------

async function preflight(c: Ctx): Promise<StepResult> {
  const { d } = c;
  const me = await rest(d.fetch, "GET", "/user", c.token);
  if (me.status !== 200) throw new Error(`GET /user: HTTP ${me.status}${ghMessage(me.json)}`);
  const header = me.headers.get("x-oauth-scopes");
  if (header === null) throw new Error("GET /user returned no x-oauth-scopes header: new-repo needs gh's OAuth login (gh auth login), not a fine-grained or App token");
  const scopes = header.split(",").map((s) => s.trim());
  for (const need of ["repo", "workflow"]) if (!scopes.includes(need)) throw new Error(`missing scope ${need}: run gh auth refresh -s ${need}`);
  const user = asRecord(me.json);
  if (typeof user?.login !== "string" || typeof user.id !== "number") throw new Error("GET /user returned no login and id");
  const type = String(user.type);
  if (type !== "User") throw new Error(`${user.login} is ${/^[aeiou]/i.test(type) ? "an" : "a"} ${type} account: new-repo makes repos for a personal account only`);
  c.owner = user.login;
  c.userId = user.id;
  if (parseOwnerRepo(`${c.owner}/${c.o.name}`) === undefined) throw new Error(`${c.owner}/${c.o.name} is not a valid owner/name: a repository name is letters, digits, ".", "-" and "_", and not "." or ".."`);
  c.full = `${c.owner}/${c.o.name}`;
  const taken = await rest(d.fetch, "GET", `/repos/${c.full}`, c.token);
  if (taken.status === 200) throw new Error(`${c.full} already exists`);
  if (taken.status !== 404) throw new Error(`GET /repos/${c.full}: HTTP ${taken.status}${ghMessage(taken.json)}`);

  const registry = loadPolicy(join(d.root, "policy")).repos;
  const ids = registry.installations;
  if (Object.keys(registry.repos).some((k) => k.toLowerCase() === c.full.toLowerCase())) throw new Error(`policy/repos.yaml already registers ${c.full}: drop the stale entry by PR first`);
  const listed = (await paginate(d.fetch, "/user/installations", c.token, (j) => asRecord(j)?.installations as unknown[] | undefined)).map(asRecord);
  const notes: string[] = [];
  const find = (slug: string, want: number) => {
    const inst = listed.find((i) => i?.app_slug === slug);
    if (inst === undefined) throw new Error(`${slug} isn't installed on ${c.owner}'s account, but policy/repos.yaml names installation ${want}: install it on selected repositories (docs/runbooks/github-apps.md), then run new-repo again`);
    if (inst.id !== want) throw new Error(`${slug}'s installation is ${String(inst.id)}, but policy/repos.yaml says ${want}`);
    return inst;
  };
  c.apps = [];
  for (const app of ["planner", "factory"] as const) {
    const inst = find(APP_SLUGS[app], ids[app]);
    if (inst.repository_selection !== "selected") throw new Error(`${APP_SLUGS[app]} is installed on all repositories: make it selected first`);
    c.apps.push({ slug: APP_SLUGS[app], id: ids[app] });
  }
  if (ids.coderabbit === undefined) notes.push("policy/repos.yaml names no coderabbit installation, so CodeRabbit isn't added");
  else {
    const inst = find(APP_SLUGS.coderabbit, ids.coderabbit);
    const skip = inst.repository_selection === "selected" ? undefined : "coderabbitai is installed on all repositories, so it covers the new repo already: its PUT is skipped";
    if (skip !== undefined) notes.push(skip);
    c.apps.push({ slug: APP_SLUGS.coderabbit, id: ids.coderabbit, ...(skip === undefined ? {} : { skip }) });
  }

  const head = (await git(c, d.root, ["rev-parse", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git rev-parse HEAD in ${d.root} printed no commit`);
  c.gatesSha = head;
  const dirty = (await git(c, d.root, ["status", "--porcelain", "--ignored", "--", TEMPLATE_DIR, ".github/workflows/gates.yml", "policy/github/rulesets"])).trim();
  if (dirty !== "") throw new Error(`templates/repo-contract, .github/workflows/gates.yml or policy/github/rulesets has changes git hasn't committed (${dirty.split("\n")[0]!.trim()}): new-repo uses what HEAD holds, so commit or remove them first`);
  const gates = await rest(d.fetch, "GET", `/repos/${c.owner}/hapi-factory/contents/.github/workflows/gates.yml?ref=${head}`, c.token);
  if (gates.status === 404) throw new Error(`GitHub has no .github/workflows/gates.yml in ${c.owner}/hapi-factory at ${short(head)}: push this checkout's HEAD first, since the new repo's hapi-gates.yml calls the gates at that commit`);
  if (gates.status !== 200) throw new Error(`GET /repos/${c.owner}/hapi-factory/contents/.github/workflows/gates.yml: HTTP ${gates.status}${ghMessage(gates.json)}`);
  if (c.o.clone && (await exists(cloneTarget(c)))) throw new Error(cloneTaken(cloneTarget(c), c.o.name));

  const apps = c.apps.map((a) => `${a.slug} ${a.id}`).join(", ");
  return { line: `${c.owner} (user ${c.userId}) with the repo and workflow scopes; ${c.full} is free; installations ${apps}; the gates at ${short(head)}${notes.length > 0 ? `; ${notes.join("; ")}` : ""}`, acted: false };
}

async function render(c: Ctx): Promise<StepResult> {
  const year = String(c.d.now().getUTCFullYear());
  c.files = renderTemplate(join(c.d.root, TEMPLATE_DIR), { name: c.o.name, owner: c.owner, gates_sha: c.gatesSha, year });
  const problems = contractProblems(c.files, loadPolicy(join(c.d.root, "policy")));
  if (problems.length > 0) throw new Error(`the render fails new-repo's checks: ${problems.join("; ")}`);
  return { line: `${c.files.size} files from ${TEMPLATE_DIR} at ${short(c.gatesSha)}; the mise files, versions, mise.lock, workflows and overlay pass`, acted: false };
}

async function create(c: Ctx): Promise<StepResult> {
  if (c.o.dryRun) return would(`POST /user/repos: ${c.full}, public and empty, issues on, no projects or wiki`);
  const body = { name: c.o.name, private: false, has_issues: true, has_projects: false, has_wiki: false, auto_init: false };
  const repo = asRecord(await gh(c, "POST", "/user/repos", [201], body));
  c.undo.push(`gh repo delete ${c.full} --yes (first: gh auth refresh -s delete_repo)`);
  if (typeof repo?.id !== "number") throw new Error("POST /user/repos returned no repository id");
  if (String(repo.full_name).toLowerCase() !== c.full.toLowerCase()) throw new Error(`POST /user/repos made ${String(repo.full_name)}, not ${c.full}`);
  c.repoId = repo.id;
  return done(`${c.full} (id ${c.repoId}), public and empty`);
}

async function push(c: Ctx): Promise<StepResult> {
  const email = `${c.userId}+${c.owner}@users.noreply.github.com`;
  if (c.o.dryRun) return would(`push one commit of ${c.files.size} files to ${c.full}'s main, by ${c.owner} <${email}>`);
  const dir = await mkdtemp(join(tmpdir(), "hapi-new-repo-"));
  try {
    for (const [path, text] of c.files) {
      await mkdir(dirname(join(dir, path)), { recursive: true, mode: 0o755 });
      await writeFile(join(dir, path), text, { mode: 0o644 });
    }
    await git(c, dir, ["init", "-q", "-b", "main"]);
    await git(c, dir, ["add", "-A"]);
    await git(c, dir, ["-c", `user.name=${c.owner}`, "-c", `user.email=${email}`, "-c", "commit.gpgSign=false", "commit", "-q", "-m", `chore: the factory repo contract (hapi-factory ${c.gatesSha})`]);
    const tree = (await git(c, dir, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])).split("\0").filter((p) => p !== "");
    const want = [...c.files.keys()].sort();
    if (JSON.stringify(tree.sort()) !== JSON.stringify(want)) throw new Error(`the first commit holds ${tree.length} files, not exactly the ${want.length} rendered: nothing was pushed`);
    // Only the push gets the token, in its environment: init, add and commit above stay token-free.
    await gitIn(c, authedHostGit(c.d, c.token, { git: ["-C", dir] }), ["push", "--quiet", `https://github.com/${c.full}.git`, "HEAD:refs/heads/main"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return done(`one commit of ${c.files.size} files on main, by ${c.owner} <${email}>`);
}

async function settings(c: Ctx): Promise<StepResult> {
  const s = contractSettings(c.owner);
  const what = `merge commits only, with GitHub's classic merge message; head branches deleted on merge; secret scanning and push protection; a read-only Actions token that can't approve PRs; selected, SHA-pinned actions; fork runs approved first; private vulnerability reporting; CodeQL's default setup${c.o.collaboratorsOnly ? "; interactions limited to collaborators for six months" : ""}`;
  if (c.o.dryRun) return would(what);
  const r = `/repos/${c.full}`;
  await gh(c, "PATCH", r, [200], s.repo);
  await gh(c, "PUT", `${r}/actions/permissions/workflow`, [204], s.workflow);
  await gh(c, "PUT", `${r}/actions/permissions`, [204], s.actions);
  await gh(c, "PUT", `${r}/actions/permissions/selected-actions`, [204], s.selectedActions);
  await gh(c, "PUT", `${r}/actions/permissions/fork-pr-contributor-approval`, [204], s.forkApproval);
  await gh(c, "PUT", `${r}/private-vulnerability-reporting`, [204]);
  await gh(c, "PATCH", `${r}/code-scanning/default-setup`, [200, 202], { state: "configured" });
  if (c.o.collaboratorsOnly) await gh(c, "PUT", `${r}/interaction-limits`, [200], { limit: "collaborators_only", expiry: "six_months" });
  return done(what);
}

/** The JSON Pointers where `got` doesn't hold what was posted: every posted key with its value (GitHub may add keys), and lists of the same length matched item by item, in any order. */
function postedDiffs(want: unknown, got: unknown, at = ""): string[] {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return [at || "/"];
    const left = [...got];
    for (const w of want) {
      const i = left.findIndex((g) => postedDiffs(w, g).length === 0);
      if (i < 0) return [at || "/"];
      left.splice(i, 1);
    }
    return [];
  }
  if (want !== null && typeof want === "object") {
    const g = asRecord(got);
    if (g === undefined) return [at || "/"];
    return Object.entries(want).flatMap(([k, v]) => postedDiffs(v, g[k], `${at}/${k}`));
  }
  return got === want ? [] : [at || "/"];
}

async function rulesets(c: Ctx): Promise<StepResult> {
  if (c.o.dryRun) return would(`post ${RULESETS.join(", ")} (main-protect requiring ${CONTRACT_CHECK}, agent-branch-scope excluding Dependabot's branches), read each back, then the rules on main, a feature branch, plan/** and factory/**`);
  const dir = join(c.d.root, "policy", "github", "rulesets");
  const bodies: Record<string, any>[] = [];
  for (const name of RULESETS) {
    const body = JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as Record<string, any>;
    if (name === "main-protect") {
      const rule = (body.rules as Record<string, any>[]).find((r) => r.type === "required_status_checks");
      if (rule === undefined) throw new Error("policy/github/rulesets/main-protect.json has no required_status_checks rule");
      rule.parameters.required_status_checks = [{ context: CONTRACT_CHECK, integration_id: ACTIONS }];
    }
    if (name === "agent-branch-scope" && !body.conditions.ref_name.exclude.includes(DEPENDABOT)) body.conditions.ref_name.exclude.push(DEPENDABOT);
    bodies.push(body);
  }
  const ids: number[] = [];
  for (const body of bodies) {
    const made = asRecord(await gh(c, "POST", `/repos/${c.full}/rulesets`, [201], body));
    if (typeof made?.id !== "number") throw new Error(`POST /repos/${c.full}/rulesets returned no id for ${String(body.name)}`);
    ids.push(made.id);
  }
  for (const [i, body] of bodies.entries()) {
    const got = await gh(c, "GET", `/repos/${c.full}/rulesets/${ids[i]}`, [200]);
    const diffs = postedDiffs(body, got);
    if (diffs.length > 0) throw new Error(`${String(body.name)} (${ids[i]}) read back differs from what was posted: ${diffs.join(", ")}`);
  }
  const want: [branch: string, has: string[], hasNot: string[]][] = [
    ["main", ["pull_request", "required_status_checks", "deletion", "non_fast_forward", "update"], []],
    ["some-feature", ["creation", "update", "deletion"], []],
    ["plan/example", [], ["creation", "update", "deletion"]],
    ["factory/example", [], ["creation", "update", "deletion"]],
  ];
  const problems: string[] = [];
  for (const [branch, has, hasNot] of want) {
    const rules = await paginate(c.d.fetch, `/repos/${c.full}/rules/branches/${encodeURIComponent(branch)}`, c.token, (j) => (Array.isArray(j) ? j : undefined));
    const types = new Set(rules.map((r) => String(asRecord(r)?.type)));
    for (const t of has) if (!types.has(t)) problems.push(`${branch} lacks ${t}`);
    for (const t of hasNot) if (types.has(t)) problems.push(`${branch} has ${t}`);
  }
  if (problems.length > 0) throw new Error(`the rules GitHub applies aren't the contract's: ${problems.join("; ")}`);
  return done(`${RULESETS.map((n, i) => `${n} ${ids[i]}`).join(", ")}, each read back as posted; main requires ${CONTRACT_CHECK}, a feature branch is the Admin's only, plan/** and factory/** are open to the Apps`);
}

async function labels(c: Ctx): Promise<StepResult> {
  const names = LABELS.map((l) => l.name).join(", ");
  if (c.o.dryRun) return would(`make the labels ${names}`);
  for (const l of LABELS) await gh(c, "POST", `/repos/${c.full}/labels`, [201], { name: l.name, color: l.color, description: l.description });
  return done(names);
}

async function apps(c: Ctx): Promise<StepResult> {
  const adding = c.apps.filter((a) => a.skip === undefined);
  const skipped = c.apps.filter((a) => a.skip !== undefined).map((a) => `; ${a.skip}`).join("");
  if (c.o.dryRun) return would(`add ${c.full} to ${adding.map((a) => `${a.slug} (${a.id})`).join(", ")}, then check each installation lists it${skipped}`);
  for (const a of adding) {
    const r = await rest(c.d.fetch, "PUT", `/user/installations/${a.id}/repositories/${c.repoId}`, c.token);
    if (r.status === 403 || r.status === 404) {
      // GitHub's docs don't say an OAuth login may add a repo to an installation (design §7.2): the web UI can.
      await c.d.confirm(`Add ${c.full} to ${a.slug}: github.com → Settings → Applications → ${a.slug} → Configure → Repository access, then press Enter`);
    } else if (r.status !== 204) throw new Error(`PUT /user/installations/${a.id}/repositories/${c.repoId}: HTTP ${r.status}${ghMessage(r.json)}`);
  }
  for (const a of adding) {
    const repos = await paginate(c.d.fetch, `/user/installations/${a.id}/repositories`, c.token, (j) => asRecord(j)?.repositories as unknown[] | undefined);
    if (!repos.some((r) => asRecord(r)?.id === c.repoId)) throw new Error(`${a.slug}'s installation (${a.id}) doesn't list ${c.full} (repo id ${c.repoId}): add it on github.com, then run the audit (docs/runbooks/new-repo.md)`);
  }
  return done(`${c.full} added to ${adding.map((a) => `${a.slug} (${a.id})`).join(", ")}, and each installation lists it${skipped}`);
}

/** The repos map of policy/repos.yaml's text, as plain data, or undefined if the text has none. */
function reposOf(text: string): Record<string, unknown> | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`policy/repos.yaml doesn't parse: ${doc.errors[0]!.message}`);
  return asRecord(asRecord(doc.toJS())?.repos);
}

/**
 * policy/repos.yaml with `"<full>": { registered: "<date>" }` added as one new line, so every other line stays
 * byte-identical: it goes after the last line of a block `repos:` map, or, for the empty `repos: {}`, right after
 * that line, whose `{}` becomes two spaces (its note keeps its column). Any other layout of `repos` is refused (add
 * the entry by hand), as is a repo already registered. The result is parsed back: it must hold exactly the old
 * data plus the new entry.
 */
export function registerText(text: string, full: string, date: string): string {
  const before = reposOf(text);
  if (before === undefined) throw new Error("policy/repos.yaml has no repos map");
  if (Object.keys(before).some((k) => k.toLowerCase() === full.toLowerCase())) throw new Error(`policy/repos.yaml already registers ${full}`);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^repos:/.test(l));
  const entry = `${JSON.stringify(full)}: { registered: ${JSON.stringify(date)} }`;
  const empty = at < 0 ? null : /^repos:([ \t]*)\{\}(.*)$/.exec(lines[at]!);
  if (at >= 0 && empty !== null) {
    lines[at] = `repos:${empty[1]}  ${empty[2]}`.replace(/[ \t]+$/, "");
    lines.splice(at + 1, 0, `  ${entry}`);
  } else if (at >= 0 && /^repos:[ \t]*(#.*)?$/.test(lines[at]!)) {
    let last = at;
    for (let i = at + 1; i < lines.length && (lines[i] === "" || /^[ \t]/.test(lines[i]!)); i++) if (lines[i]!.trim() !== "") last = i;
    const indent = lines.slice(at + 1, last + 1).find((l) => l.trim() !== "" && !l.trim().startsWith("#"))?.match(/^[ \t]+/)?.[0] ?? "  ";
    lines.splice(last + 1, 0, `${indent}${entry}`);
  } else throw new Error("policy/repos.yaml's repos isn't `repos: {}` or a block map at the top level: add the entry by hand");
  const out = lines.join("\n");
  const after = reposOf(out);
  const want = { ...before, [full]: { registered: date } };
  if (JSON.stringify(after) !== JSON.stringify(want) || JSON.stringify({ ...(parseDocument(out).toJS() as object), repos: null }) !== JSON.stringify({ ...(parseDocument(text).toJS() as object), repos: null })) {
    throw new Error("policy/repos.yaml didn't read back as the old registry plus the new entry: add the entry by hand");
  }
  return out;
}

async function register(c: Ctx): Promise<StepResult> {
  const date = c.d.now().toISOString().slice(0, 10);
  const what = `${c.full} to policy/repos.yaml (registered ${date}), uncommitted: review it and commit it by PR`;
  if (c.o.dryRun) return would(`add ${what}`);
  const file = join(c.d.root, "policy", "repos.yaml");
  const old = await readFile(file, "utf8");
  const replace = async (text: string) => {
    const tmp = `${file}.new-repo.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, file);
  };
  await replace(registerText(old, c.full, date));
  try {
    loadPolicy(join(c.d.root, "policy"));
  } catch (e) {
    await replace(old);
    throw new Error(`policy/ doesn't load with the new entry, so policy/repos.yaml is back as it was: ${e instanceof Error ? e.message : String(e)}`);
  }
  c.undo.push("git checkout -- policy/repos.yaml (it drops every uncommitted change there: to keep others, delete the new entry by hand)");
  return done(`added ${what}`);
}

async function clone(c: Ctx): Promise<StepResult> {
  if (!c.o.clone) return c.o.dryRun ? would("skip the clone (no --clone)") : { line: "skipped (no --clone)", acted: false };
  const path = cloneTarget(c);
  const url = `https://github.com/${c.full}.git`;
  if (await exists(path)) throw new Error(cloneTaken(path, c.o.name));
  if (c.o.dryRun) return would(`git clone ${url} ${path}`);
  c.undo.push(`rm -rf ${path}`);
  const r = await c.d.run(["git", "clone", "--quiet", url, path], { env: definedEnv(c.d.env), inherit: false });
  if (r.code !== 0) throw new Error(`git clone exited ${r.code}${r.stderr?.trim() ? `: ${r.stderr.trim()}` : ""}`);
  return done(`cloned into ${path}`);
}

async function verify(c: Ctx): Promise<StepResult> {
  const checks = VERIFY_CHECKS.join(", ");
  if (c.o.dryRun) return would(`run the strict audit's ${checks} for ${c.full}`);
  const [owner, name] = [c.owner, c.o.name];
  const results = await c.d.audit({
    root: c.d.root,
    policyDir: join(c.d.root, "policy"),
    repos: [{ owner, name }],
    strict: true,
    dev: false,
    githubToken: c.token,
    only: VERIFY_CHECKS,
    env: c.d.env,
    user: userInfo().username,
    exec: defaultExec(c.d.env),
    fetch: c.d.fetch,
    now: () => c.d.now().getTime(),
  });
  for (const r of results) c.d.out(redact(`  ${r.status.padEnd(4)}  ${r.id}  ${r.detail}`, c.token));
  const failed = [...new Set([...results.filter((r) => r.status !== "pass").map((r) => r.id), ...VERIFY_CHECKS.filter((id) => !results.some((r) => r.id === id))])];
  if (failed.length > 0) throw new Error(`the strict audit failed ${failed.join(", ")}: fix it, then run it again (docs/runbooks/new-repo.md#verify)`);
  return done(`the strict audit passes ${checks} for ${c.full}`);
}

const IMPL: Record<StepName, (c: Ctx) => Promise<StepResult>> = { preflight, render, create, push, settings, rulesets, labels, apps, register, clone, verify };

/** `text` with the token, and the basic-auth header value made from it, replaced by [redacted]. */
function redact(text: string, token: string): string {
  let s = text;
  for (const secret of [Buffer.from(`x-access-token:${token}`).toString("base64"), Buffer.from(token).toString("base64"), token]) if (secret !== "") s = s.split(secret).join("[redacted]");
  return s;
}

/**
 * Run the eleven steps (see the module comment) with the operator's token, held in memory only. Prints
 * `[k/11] <step>: <what>` for each; on a failure, the step and why, what was done and what to undo (newest
 * first). Resolves to 0 when every step passed, 1 when one failed.
 */
export async function newRepo(d: NewRepoDeps, token: string, o: NewRepoOptions): Promise<number> {
  const c: Ctx = { d, token, o, owner: "", userId: 0, full: "", gatesSha: "", files: new Map(), repoId: 0, apps: [], undo: [] };
  const acted: string[] = [];
  for (const [k, step] of STEPS.entries()) {
    try {
      const r = await IMPL[step](c);
      d.out(redact(`[${k + 1}/${STEPS.length}] ${step}: ${r.line}`, token));
      if (r.acted) acted.push(redact(`  ${k + 1}. ${step}: ${r.line}`, token));
    } catch (e) {
      d.out(`step ${k + 1} (${step}) failed: ${redact(oneLine(e, token), token)}`);
      if (acted.length === 0) d.out("Done so far: nothing");
      else {
        d.out("Done so far:");
        for (const l of acted) d.out(l);
      }
      if (c.undo.length === 0) d.out("To undo: nothing");
      else {
        d.out("To undo:");
        for (const u of [...c.undo].reverse()) d.out(redact(`  ${u}`, token));
      }
      return 1;
    }
  }
  return 0;
}
