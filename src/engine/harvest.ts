/**
 * The harvester (design §3.6; Plan 03 Task 12): deterministic host code that turns a finished pipeline into a verdict
 * and one factory PR. It reads every phase's outputs as data (./evidence.ts) and never executes, sources or follows
 * them; it runs no generative model, and its only model calls are `decide()`'s advisory screens (./decisions.ts).
 *
 * - **The host gates** (`hostGates`, H-203, H-182's host half): the run's bundle, read with the host's own hardened
 *   git into a host-owned scratch copy of the mirror (`<engineDir>/scratch/<owner>/<name>/<id>.git`): its one head,
 *   its size, that it applies and descends from the run's base, each new commit's trailers (the commit node's
 *   TOCTOU and a worker-writable git config are re-checked here, on what was committed), the changed files against
 *   the overlaid protected paths and the pieces' scopes, no-op, and the secret scan of the new commits (the pinned
 *   gitleaks; both zones' exact values, raw and base64, in contents, each commit's raw header and message, and every
 *   changed path's name; and KEY_PATTERNS in headers, messages and names). Each commit's header and message are read
 *   from its object (`readCommits`), never parsed out of `git log`'s text. Any problem means nothing is pushed. The
 *   added-line signals (harness tampering, placeholders, loosened tests) are "check this yourself" lines only, never
 *   a verdict.
 * - **The outcome** (`outcome`, pure): design §3.6's rows, the operator's acceptance-test rules, then the screens'
 *   holds last. Screens never change `push` or `draft`.
 * - **The push** (`push`): `git push` without `+` or `--force`, over https alone, the token in the process's
 *   environment only; a non-fast-forward is a moved branch, never overwritten, and GitHub's refusal carries its reason.
 * - **`harvest`**: the gates, the evidence, the PR lookup (a closed PR ends it; a moved branch or a ready PR whose
 *   new head failed check means no push), the screens of a head it will push (each answer saved before the push),
 *   the push, the PR body (./pr.ts) and its labels, then `harvestedAt` on each record it read (H-206). It mints no
 *   token: it uses the tick's (`HarvestDeps.forge`, `token`), which Task 14 revokes. It moves no phase (Task 13 does).
 */
import { lstat, mkdir, mkdtemp, readdir, rm, stat, chmod, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { KEY_PATTERNS } from "../../policy/decisions/write-gate";
import type { ask } from "../decide/record";
import type { Forge, PrInfo } from "../forge";
import { authedGit } from "../forge/github/git";
import { parseOwnerRepo } from "../forge/github/app-token";
import { WORKER_IDENTITY } from "../generate/archon";
import { applyOverlay } from "../policy/overlay";
import { effectiveModes, globMatches } from "../policy/paths";
import type { Phases, Policy } from "../policy/types";
import { hardenedGit } from "../run/git";
import { bundleProblem } from "../run/lifecycle";
import { lockHeld, readRecord, recordDir, type RunRecord, withRunLock, writeRecord } from "../run/records";
import { redactSecretForms, redactSecrets, sanitizeTerminal, secretHits } from "../run/sanitize";
import { runSpend } from "../run/spend";
import type { RunDeps } from "../run/spec";
import { isWorkOrderId, type WorkOrder } from "../workorder/validate";
import {
  callsOf,
  codeSpan,
  type DiffInput,
  decisionSpend,
  emptyScreens,
  ENGINE_DECISIONS,
  goalOf,
  ledgerPath,
  readLedger,
  scratchGit,
  type Screened,
  screenHarvest,
  shownPath,
  type Subject,
} from "./decisions";
import type { Discovered } from "./discover";
import { type CodeRabbitResult, codeRabbitResult, type PlannerTest, type ReviewResult, reviewResult, turnsOfRun, type VerifyResult, verifyResult, type WorkerResult, workerResult } from "./evidence";
import { mirrorPath } from "./mirror";
import { isNoRoom, type PrInput, renderPr, rerenderPr } from "./pr";
import type { Phase, Verdict, WorkOrderState } from "./state";

/** The gitleaks the host's secret scan runs: mise.toml's pin (a test holds them equal). */
export const GITLEAKS_VERSION = "8.30.1";
/** git's empty tree: GIT_ATTR_SOURCE, so no in-tree .gitattributes changes what the secret scan reads. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** secret: the Task 8 → 12 ruling's scan of the bundle's new commits. */
export interface GateProblem {
  gate: "bundle" | "size" | "protected" | "scope" | "no-diff" | "secret";
  detail: string;
}
/** signals: the added-line signal's "check this yourself" lines, each naming the file. */
export interface GateResult {
  head: string | undefined;
  files: string[];
  problems: GateProblem[];
  signals: string[];
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const short = (sha: string) => sha.slice(0, 7);
const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.trim().slice(0, 300) || "(no error output)";
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** A path (or other text) a worker chose, for a gate's detail: redacted, then a code span (`codeSpan`: no terminal control, no `@ < > \``), at most 120 characters. */
function shown(path: string, secrets: Record<string, string>): string {
  return codeSpan(redactSecretForms(path, secrets), 120);
}

/** At most 20 problems of one gate, then `… and <n> more`. */
function capGate(gate: GateProblem["gate"], details: string[]): GateProblem[] {
  const out = details.slice(0, 20).map((detail) => ({ gate, detail }));
  if (details.length > 20) out.push({ gate, detail: `… and ${details.length - 20} more` });
  return out;
}

/** Every entry under `dir` readable by all (dirs a+rx, files a+r), as Task 6's mirror is: a run container's uid reads the scratch. */
async function readableByAll(dir: string): Promise<void> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await chmod(dir, st.mode | 0o555);
    for (const name of await readdir(dir)) await readableByAll(join(dir, name));
  } else if (st.isFile()) await chmod(dir, st.mode | 0o444);
}

/** The trailers factory-task's commit node writes on every commit (spec §13.2), each once, and no other. */
const TRAILER_KEYS = ["Work-Order", "Hapi-Run", "Hapi-Lane", "Trace-Id", "Agent", "Model"] as const;
/** The headers a commit the commit node made carries, each once: no `encoding`, `gpgsig` or any other. */
const HEADER_KEYS = ["tree", "parent", "author", "committer"] as const;
/** The `--format` of the commits' log `trailerProblems` reads: sha, parents, author and committer, the trailers. */
export const COMMIT_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%(trailers:only,unfold)%x1e";

/** One commit object, as git stored it: its raw header (up to the first empty line), the header's keys in order, and its message. */
export interface CommitObject {
  sha: string;
  /** Each header line's first word, but a continuation line's (it starts with a space). */
  keys: string[];
  header: string;
  message: string;
}

/**
 * The commits `shas` named, from one `git cat-file --batch` over them, read by its byte lengths alone (final re-review
 * N1): each entry is `<sha> commit <size>\n`, then exactly `<size>` bytes of the object, then `\n`. Nothing in an
 * object is searched for a marker, so no header line or message (`commit <sha>`, `diff --git`) can move where one
 * commit ends or another begins. In each object, the header is everything before the first empty line, and the
 * message everything after it. An entry for another object than asked, `missing`, a type but `commit`, a size that
 * doesn't match, a NUL byte in the object, or output beyond the last entry is a problem, and nothing after it is read.
 */
export function commitObjects(out: Uint8Array, shas: readonly string[]): { commits: CommitObject[]; problems: string[] } {
  const text = new TextDecoder();
  const trust = (what: string) => ({ commits, problems: [`the secret scan can't be trusted: ${what}`] });
  const commits: CommitObject[] = [];
  let at = 0;
  for (const sha of shas) {
    const lf = out.indexOf(0x0a, at);
    const line = lf === -1 ? "" : text.decode(out.subarray(at, lf));
    if (line === `${sha} missing`) return trust(`commit ${short(sha)} is missing from the scratch (git cat-file --batch)`);
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) ([a-z]+) (\d+)$/.exec(line);
    if (!m || m[1] !== sha) return trust(`git cat-file --batch's output can't be read at commit ${short(sha)}`);
    if (m[2] !== "commit") return trust(`${short(sha)} is a ${m[2]}, not a commit (git cat-file --batch)`);
    const start = lf + 1;
    const end = start + Number(m[3]);
    if (!Number.isSafeInteger(end) || end >= out.length || out[end] !== 0x0a) return trust(`git cat-file --batch's entry for ${short(sha)} doesn't match its size`);
    const body = out.subarray(start, end);
    if (body.includes(0)) return trust(`commit ${short(sha)} holds a NUL byte, where git's own parse of its headers and trailers stops (git fsck: nulInHeader, nulInCommit)`);
    let blank = -1;
    for (let i = 0; i + 1 < body.length; i++) {
      if (body[i] === 0x0a && body[i + 1] === 0x0a) {
        blank = i;
        break;
      }
    }
    const header = text.decode(blank === -1 ? body : body.subarray(0, blank));
    const message = blank === -1 ? "" : text.decode(body.subarray(blank + 2));
    const keys = header.split("\n").filter((l) => l !== "" && !l.startsWith(" ")).map((l) => l.split(" ")[0]!);
    commits.push({ sha, keys, header, message });
    at = end + 1;
  }
  if (at !== out.length) return trust("git cat-file --batch wrote more than the commits asked for");
  return { commits, problems: [] };
}

/** The scan's git environment, after `env -i`: no system or global config, no replace objects, no in-tree attributes, no hooks or fsmonitor; `attributes`, the diff's attributes file. */
function scanEnv(PATH: string, scratch: string, o: { home?: string; attributes?: string } = {}): string[] {
  const config: [string, string][] = [
    ...(o.attributes === undefined ? [] : [["core.attributesFile", o.attributes] as [string, string]]),
    ["safe.directory", scratch],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
  ];
  return [
    `PATH=${PATH}`, ...(o.home === undefined ? [] : [`HOME=${o.home}`]), "GIT_NO_REPLACE_OBJECTS=1", `GIT_ATTR_SOURCE=${EMPTY_TREE}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
    `GIT_CONFIG_COUNT=${config.length}`, ...config.flatMap(([k, v], i) => [`GIT_CONFIG_KEY_${i}=${k}`, `GIT_CONFIG_VALUE_${i}=${v}`]),
  ];
}

/**
 * The new commits of `range`, each read whole from its object (final re-review N1): `git rev-list` over the range, then
 * ONE `git cat-file --batch` over its shas (`commitObjects`), both as the secret scan runs git (`scanEnv`). A git that
 * fails or writes to stderr, or an entry `commitObjects` can't read, is a problem: the scan fails closed.
 */
export async function readCommits(d: Pick<RunDeps, "run" | "runBytes" | "env">, scratch: string, range: string): Promise<{ commits: CommitObject[]; problems: string[] }> {
  const PATH = d.env.PATH ?? "/usr/bin:/bin";
  const env = ["env", "-i", ...scanEnv(PATH, scratch), "git", "-C", scratch];
  const list = await d.run([...env, "rev-list", "--full-history", range], { env: { PATH }, inherit: false });
  if (list.code !== 0 || (list.stderr ?? "") !== "") return { commits: [], problems: [`the secret scan can't be trusted: git rev-list exited ${list.code}${(list.stderr ?? "") === "" ? "" : " and wrote to stderr"}`] };
  const shas = list.stdout.split("\n").filter((l) => l !== "");
  if (shas.some((s) => !COMMIT.test(s))) return { commits: [], problems: ["the secret scan can't be trusted: git rev-list gave a line that isn't a commit id"] };
  if (shas.length === 0) return { commits: [], problems: [] };
  const batch = await d.runBytes([...env, "cat-file", "--batch"], { PATH }, `${shas.join("\n")}\n`);
  if (batch.code !== 0 || batch.stderr !== "") return { commits: [], problems: [`the secret scan can't be trusted: git cat-file --batch exited ${batch.code}${batch.stderr === "" ? "" : " and wrote to stderr"}`] };
  return commitObjects(batch.stdout, shas);
}

/**
 * Each new commit's header problems (final review I1): a merge; an author or committer other than the run container's
 * generated identity (`WORKER_IDENTITY`); a raw header beyond tree, parent, author and committer, or one of them
 * twice; and the commit node's six trailers (spec §13.2) with the values the host knows, each exactly once, and no
 * other trailer (a `Co-authored-by` credits someone else). `log` is `COMMIT_FORMAT`'s; `headers`, each commit's
 * header keys from its object (`readCommits`), and a commit in only one of them can't be read.
 */
function trailerProblems(log: string, headers: Map<string, string[]>, o: { runId: string; workOrder: WorkOrder; secrets: Record<string, string> }): string[] {
  const trace = o.workOrder.trace.traceparent.split("-")[1] ?? "";
  const problems: string[] = [];
  const logged = new Set<string>();
  for (const rec of log.split("\x1e")) {
    const body = rec.replace(/^\n/, "");
    if (body === "") continue;
    const [sha, parents, an, ae, cn, ce, trailers, ...rest] = body.split("\x1f");
    if (sha === undefined || !COMMIT.test(sha) || trailers === undefined || rest.length > 0) {
      problems.push("a run commit's identity or trailers can't be read field by field (one holds a separator)");
      continue;
    }
    const at = `commit ${short(sha)}`;
    logged.add(sha);
    if ((parents ?? "").trim().split(" ").filter(Boolean).length !== 1) {
      problems.push(`${at} is a merge: a run commits one piece at a time, in a line`);
      continue;
    }
    for (const [role, name, email] of [["author", an, ae], ["committer", cn, ce]] as const) {
      if (name !== WORKER_IDENTITY.name || email !== WORKER_IDENTITY.email) problems.push(`${at}'s ${role} is ${shown(`${name} <${email}>`, o.secrets)}, not the generated worker identity (src/generate/archon.ts)`);
    }
    const keys = headers.get(sha);
    if (keys === undefined) problems.push(`${at}'s raw headers can't be read`);
    else {
      for (const k of new Set(keys)) {
        const n = keys.filter((x) => x === k).length;
        if (!(HEADER_KEYS as readonly string[]).includes(k)) problems.push(`${at} has a header beyond tree, parent, author and committer: ${shown(k, o.secrets)}`);
        else if (n > 1) problems.push(`${at} has ${n} ${k} headers`);
      }
    }
    const lines = trailers.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const keyOf = (l: string) => (l.includes(":") ? l.slice(0, l.indexOf(":")).trim() : l);
    const count = new Map<string, number>();
    for (const l of lines) count.set(keyOf(l), (count.get(keyOf(l)) ?? 0) + 1);
    for (const [k, n] of count) {
      if (!(TRAILER_KEYS as readonly string[]).includes(k)) problems.push(`${at} has a trailer beyond the commit node's six: ${shown(k, o.secrets)}`);
      else if (n > 1) problems.push(`${at} has the trailer ${k} ${n} times: the commit node writes each once`);
    }
    const value = (key: string) => lines.filter((l) => keyOf(l) === key).map((l) => l.slice(l.indexOf(":") + 1).trim());
    const want: [string, string | undefined][] = [
      ["Work-Order", o.workOrder.id],
      ["Hapi-Run", o.runId],
      ["Hapi-Lane", "factory"],
      ["Trace-Id", trace],
      ["Agent", undefined],
      ["Model", undefined],
    ];
    for (const [key, v] of want) {
      const got = value(key);
      if (got.length > 1) continue; // said above
      if (v === undefined ? (got[0] ?? "") === "" : got[0] !== v) problems.push(`${at} lacks the trailer ${key}: ${v ?? "<a value>"}`);
    }
  }
  for (const sha of headers.keys()) if (!logged.has(sha)) problems.push(`commit ${short(sha)}'s identity and trailers can't be read`);
  return problems;
}

/** The added-line signals (the Task 8 → 12 ruling, and the decisions amendment's ruling 6): what a string match finds. */
const SIGNALS: readonly { what: string; re: RegExp }[] = [
  { what: "an added line skips a test (.skip, .todo or .only)", re: /\.(skip|todo|only)\s*\(/ },
  { what: "an added line asserts nothing (expect(true))", re: /expect\(\s*(true|!0|1)\s*\)/ },
  { what: "an added line branches on NODE_ENV being test", re: /NODE_ENV[^\n]{0,24}['"]test['"]|['"]test['"][^\n]{0,24}NODE_ENV/ },
  { what: "an added line calls process.exit", re: /process\.exit\b/ },
  { what: "an added line kills a process (process.kill)", re: /process\.kill\b/ },
  { what: "an added line leaves a TODO or FIXME", re: /\b(TODO|FIXME)\b/ },
  { what: "an added line names verify.json", re: /verify\.json/ },
  { what: "an added line names /out or /.archon", re: /(^|[^\w.-])\/(out|\.archon)(\/|['"\s]|$)/ },
  { what: "an added line reads /proc", re: /\/proc\// },
  { what: "an added line patches a module at load (mock.module, Bun.plugin)", re: /mock\.module\s*\(|Bun\.plugin\s*\(/ },
];
const BUNFIG = "it changes bunfig.toml, which can preload code into bun test";

/** One file's change, from its own `diff -U0`: its added lines (every `+` line after the first `@@`) and its new-side line ranges. */
export interface FileChange {
  added: string[];
  ranges: [number, number][];
}

/**
 * Each of `files`' changes, `base..head`, from one `--literal-pathspecs diff -U0 --text` per file of a `-z` list, so a
 * file is never named by parsing a header (a quoted or escaped name, or an added line that looks like `+++ b/…`, can't
 * misattribute a line), and `--text` sees through a `-diff` attribute. Only `@@` lines give ranges; every `+` line
 * after the first is content. undefined when git fails.
 */
export async function fileChanges(d: Pick<RunDeps, "run" | "env">, scratch: string, base: string, head: string, files: readonly string[]): Promise<Map<string, FileChange> | undefined> {
  const out = new Map<string, FileChange>();
  for (const f of files) {
    const r = await scratchGit(d, scratch, ["diff", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, head, "--", f], ["--literal-pathspecs"]);
    if (r.code !== 0) return undefined;
    const change: FileChange = { added: [], ranges: [] };
    let body = false;
    let sections = 0;
    for (const line of r.stdout.split("\n")) {
      // A pathspec that names a file also names a directory of that name (a deleted `src/f` and a new `src/f/x.ts`):
      // the file's own section is the first; a second `diff --git` is another file's (a content line never starts so).
      if (line.startsWith("diff --git ") && ++sections > 1) break;
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h) {
        body = true;
        const start = Number(h[1]);
        const n = h[2] === undefined ? 1 : Number(h[2]);
        if (n > 0) change.ranges.push([start, start + n - 1]);
        continue;
      }
      if (body && line.startsWith("+")) change.added.push(line.slice(1));
    }
    out.set(f, change);
  }
  return out;
}

/** "Check this yourself" lines from each changed file's added lines, one per file and signal, in path order; at most 50. */
function signalsOf(changes: Map<string, FileChange>, secrets: Record<string, string>): string[] {
  const order = [BUNFIG, ...SIGNALS.map((x) => x.what)];
  const lines = [...changes]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .flatMap(([path, c]) => {
      const whats = new Set<string>();
      if (basename(path) === "bunfig.toml") whats.add(BUNFIG);
      for (const line of c.added) for (const sig of SIGNALS) if (sig.re.test(line)) whats.add(sig.what);
      return order.filter((w) => whats.has(w)).map((w) => `${shownPath(redactSecretForms(path, secrets))}: ${w}`);
    });
  return lines.length <= 50 ? lines : [...lines.slice(0, 50), `… and ${lines.length - 50} more`];
}

/**
 * The secret scan of the bundle's new commits (`base..head`): gitleaks (`GITLEAKS_VERSION`, its default rules, every
 * path read as text, and its own failure modes failing closed, as the gates workflow runs it), then `secrets`' exact
 * values, raw and base64, in every patch, in each commit's raw header and message (`commits`, read from the objects
 * by `readCommits`, whose problems fail the scan too) and in every changed path's name, and KEY_PATTERNS in each
 * commit's header and message and in every name.
 */
async function secretScan(
  d: Pick<RunDeps, "run" | "env">,
  o: { scratch: string; base: string; head: string; secrets: Record<string, string>; commits: { commits: CommitObject[]; problems: string[] } },
): Promise<string[]> {
  const problems: string[] = [...o.commits.problems];
  const range = `${o.base}..${o.head}`;
  const tmp = await mkdtemp(join(tmpdir(), "hapi-secret-scan-"));
  try {
    const attributes = join(tmp, "attributes");
    const config = join(tmp, "gitleaks.toml");
    const report = join(tmp, "report.json");
    await writeFile(attributes, "* diff\n", { mode: 0o600 });
    await writeFile(config, "[extend]\nuseDefault = true\n", { mode: 0o600 });
    const PATH = d.env.PATH ?? "/usr/bin:/bin";
    // git as gitleaks runs it: no in-tree attributes, every path as text, no system or global config, hooks or fsmonitor.
    const env = scanEnv(PATH, o.scratch, { home: tmp, attributes });
    const logOpts = ["--full-history", "-m", "--no-mailmap", "--no-renames", "--ignore-submodules=none", "--no-ext-diff", "--no-textconv"];
    const run = (cmd: string[]) => d.run(["env", "-i", ...env, ...cmd], { env: { PATH }, inherit: false });

    // 1. Each commit's raw header (every header: the committer and any extra one included) and its message, apart, so
    // a hit names which (never the value).
    for (const c of o.commits.commits) {
      for (const [part, text] of [["header", c.header], ["message", c.message]] as const) {
        for (const h of secretHits(text, o.secrets)) problems.push(`the ${part} of commit ${short(c.sha)} holds ${h.name}'s value${h.form === "base64" ? ", base64-encoded" : ""}`);
        for (const k of KEY_PATTERNS) if (k.re.test(text)) problems.push(`the ${part} of commit ${short(c.sha)} holds a key's format (${k.name})`);
      }
    }
    // 1b. The patches alone, as gitleaks will read them (`--format=`: no header or message in the output, so every
    // `diff --git` at a line's start is a file's own); a git that fails or warns fails the scan closed.
    const log = await run(["git", "-C", o.scratch, "log", "-p", "-U0", "--no-color", "--format=", ...logOpts, range]);
    if (log.code !== 0 || (log.stderr ?? "") !== "") problems.push(`the secret scan can't be trusted: git log, run as gitleaks runs it, exited ${log.code}${(log.stderr ?? "") === "" ? "" : " and wrote to stderr"}`);
    else {
      // Each file's patch, so a hit names its file.
      for (const seg of log.stdout.split(/\n(?=diff --git )/)) {
        const file = /^diff --git a\/.* b\/(.*)$/m.exec(seg)?.[1];
        const where = file !== undefined ? shown(file, o.secrets) : "the new commits";
        for (const h of secretHits(seg, o.secrets)) problems.push(`${where} holds ${h.name}'s value${h.form === "base64" ? ", base64-encoded" : ""}`);
      }
    }
    // 2. Every path any new commit touches, by name, trees included (`-t`: an empty subtree has no file to name it).
    const names = await run(["git", "-C", o.scratch, "log", "--format=", "--name-only", "-t", "-z", ...logOpts, range]);
    if (names.code !== 0) problems.push(`the secret scan can't be trusted: git log --name-only exited ${names.code}`);
    for (const name of new Set(names.stdout.split("\0").map((n) => n.replace(/^\n+/, "")).filter((n) => n !== ""))) {
      for (const h of secretHits(name, o.secrets)) problems.push(`a changed path's name holds ${h.name}'s value${h.form === "base64" ? ", base64-encoded" : ""}: ${shown(name, o.secrets)}`);
      for (const k of KEY_PATTERNS) if (k.re.test(name)) problems.push(`a changed path's name holds a key's format (${k.name}): ${shown(name, o.secrets)}`);
    }
    // 3. gitleaks, the pinned one.
    const version = await run(["gitleaks", "version"]);
    if (version.code !== 0 || version.stdout.trim() !== GITLEAKS_VERSION) {
      problems.push(`the secret scan needs gitleaks ${GITLEAKS_VERSION} (mise.toml's pin) on PATH, and ${version.code === 0 ? `PATH has ${JSON.stringify(sanitizeTerminal(version.stdout.trim()).replace(/[@<>`]/g, "").slice(0, 40))}` : `gitleaks version exited ${version.code}`}`);
      return [...new Set(problems)];
    }
    const g = await run([
      "gitleaks", "git", "--config", config, `--log-opts=${[...logOpts, range].join(" ")}`, "--ignore-gitleaks-allow", "--redact", "--no-banner", "--no-color",
      "--gitleaks-ignore-path", tmp, "--report-format", "json", "--report-path", report, o.scratch,
    ]);
    const out = `${g.stdout}\n${g.stderr ?? ""}`;
    if (/(^|\s)ERR(\s|$)/.test(out)) problems.push("the secret scan can't be trusted: gitleaks logged an error");
    if (out.split("\n").some((l) => /(^|\s)WRN(\s|$)/.test(l) && !/^\S+ WRN leaks found: \d+$/.test(l.trim()))) problems.push("the secret scan can't be trusted: gitleaks logged a warning other than its findings count");
    if (/(^|\s)0 commits scanned/.test(out)) problems.push("the secret scan can't be trusted: gitleaks scanned 0 commits");
    if (g.code === 1) {
      let findings: unknown;
      try {
        findings = JSON.parse(readFileSync(report, "utf8"));
      } catch {
        findings = undefined;
      }
      if (!Array.isArray(findings) || findings.length === 0) problems.push("gitleaks found a leak, and its report can't be read");
      else {
        for (const f of findings as Record<string, unknown>[]) {
          const rule = sanitizeTerminal(String(f.RuleID ?? "a rule")).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
          const commit = typeof f.Commit === "string" && COMMIT.test(f.Commit) ? ` (commit ${short(f.Commit)})` : "";
          problems.push(`gitleaks: ${rule} in ${shown(String(f.File ?? "a file"), o.secrets)}${commit}`);
        }
      }
    } else if (g.code !== 0) problems.push(`the secret scan can't be trusted: gitleaks exited ${g.code}`);
    return [...new Set(problems)];
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * The host gates on a run's bundle (see the module comment), in order; a bundle or size problem ends them. Each git
 * call is hardened (`hardenedGit`) on the scratch, `-c safe.directory=<scratch> --git-dir <scratch>`. Throws only
 * when the host itself can't do its part (no mirror, a git failure that is no run's doing).
 */
export async function hostGates(
  d: Pick<RunDeps, "run" | "runBytes" | "env">,
  o: { mirror: string; scratch: string; bundle: string; runId: string; base: string; workOrder: WorkOrder; policy: Policy; secrets: Record<string, string> },
): Promise<GateResult> {
  const end = (gate: GateProblem["gate"], detail: string, head?: string): GateResult => ({ head, files: [], problems: [{ gate, detail }], signals: [] });
  if (!COMMIT.test(o.base)) throw new Error(`not a commit id: ${o.base.slice(0, 80)}`);
  // 1. The bundle: one head, within its size.
  const bp = await bundleProblem(o.bundle, d);
  if (bp !== undefined) return end("bundle", `run.bundle: ${bp}`);
  const size = (await stat(o.bundle)).size;
  const cap = o.policy.runs.output_limits_mb.bundle;
  if (size > cap * 1024 * 1024) return end("size", `run.bundle is ${(size / 1024 / 1024).toFixed(1)} MiB, over runs.output_limits_mb.bundle (${cap} MiB)`);
  // 2. The scratch: a host-owned local copy of the mirror (only the push is held to no `+`).
  const git = (args: string[], pre: string[] = []) => scratchGit(d, o.scratch, args, pre);
  const must = async (args: string[], what: string) => {
    const r = await git(args);
    if (r.code !== 0) throw new Error(`cannot ${what} in the scratch ${o.scratch} (git ${args[0]} exited ${r.code}): ${firstLine(r.stderr)}`);
    return r.stdout;
  };
  if (!(await exists(join(o.scratch, "HEAD")))) {
    await mkdir(dirname(o.scratch), { recursive: true, mode: 0o700 });
    const g = hardenedGit(d);
    const r = await d.run([...g.cmd, "clone", "--bare", "--no-hardlinks", "--quiet", "--", o.mirror, o.scratch], { env: g.env, inherit: false });
    if (r.code !== 0) throw new Error(`cannot make the scratch ${o.scratch} from the mirror (git clone exited ${r.code}): ${firstLine(r.stderr)}`);
  }
  // The scratch is private while it holds commits nobody has scanned: a run container's uid reads it only once a
  // scan was clean, or the unscanned commits are gone (step 7). No run of this work order is live during its harvest
  // (one pipeline per repo, Task 13), so locking the scratch out meanwhile stops nothing.
  await chmod(o.scratch, 0o700);
  await must(["fetch", "--quiet", "--no-tags", o.mirror, "+refs/heads/main:refs/heads/main", "+refs/heads/factory/*:refs/heads/factory/*", "+refs/hapi/orders/*:refs/hapi/orders/*"], "fetch the mirror");
  // 3. The bundle applies (nothing of it is in the scratch before this).
  const verify = await git(["bundle", "verify", "--quiet", o.bundle]);
  if (verify.code !== 0) {
    await readableByAll(o.scratch);
    return end("bundle", `run.bundle does not apply to the mirror (git bundle verify exited ${verify.code})`);
  }
  const ref = `refs/hapi/runs/${o.runId}`;
  // From the bundle's fetch on, every exit but a clean scan drops the run's commits from the scratch (`purgeRun`):
  // a run refused before its scan (no descent, no diff, a throw) may still hold a secret nobody looked for.
  let clean = false;
  let failure: unknown;
  try {
    return await scanned();
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    // 7. Unscanned commits dropped, or (after a clean scan) every object no ref reaches (a bundle's pack can carry
    // one HEAD doesn't reach, never scanned); then readable by all, as the mirror is.
    await settleScratch({
      clean,
      failure,
      purge: () => purgeRun(d, o.scratch, o.runId),
      compact: () => compactScratch(d, o.scratch),
      open: () => readableByAll(o.scratch),
      what: `run ${o.runId}'s scratch ${o.scratch}`,
    });
  }

  async function scanned(): Promise<GateResult> {
    const fetched = await git(["fetch", "--quiet", "--no-tags", o.bundle, `HEAD:${ref}`]);
    if (fetched.code !== 0) return end("bundle", `run.bundle could not be fetched into the scratch (git fetch exited ${fetched.code})`);
    const head = (await must(["rev-parse", "--verify", `${ref}^{commit}`], "read the run's head")).trim();
    if (!COMMIT.test(head)) throw new Error(`the run's head in the scratch is not a commit id: ${head.slice(0, 80)}`);
    const anc = await git(["merge-base", "--is-ancestor", o.base, head]);
    if (anc.code === 1) return end("bundle", `the run's head ${short(head)} does not descend from ${short(o.base)}`, head);
    if (anc.code !== 0) throw new Error(`cannot check the run's head descends from its base (git merge-base exited ${anc.code}): ${firstLine(anc.stderr)}`);
    // 3b. Each new commit is one piece's, as the commit node makes it: the generated identity, the four headers and
    // the six trailers (re-checked on what was committed, since a worker-writable git config reaches the commit node).
    // The headers are read from each commit's object (`readCommits`), which the secret scan reads too.
    const log = await must(["log", "--no-mailmap", `--format=${COMMIT_FORMAT}`, `${o.base}..${head}`], "read the run's commits");
    const commits = await readCommits(d, o.scratch, `${o.base}..${head}`);
    const headerProblems = trailerProblems(log, new Map(commits.commits.map((c) => [c.sha, c.keys])), o);
    const problems: GateProblem[] = capGate("bundle", headerProblems);
    // 4. The changed files.
    const files = (await must(["diff", "--name-only", "-z", "--no-renames", o.base, head], "list the run's changed files")).split("\0").filter((f) => f !== "");
    if (files.length === 0) return { head, files: [], problems: [...problems, { gate: "no-diff", detail: `the run changed no file (${short(o.base)}..${short(head)} is empty)` }], signals: [] };
    // 5. Protected paths (the overlaid policy), then the pieces' scopes.
    const prot: string[] = [];
    const scope: string[] = [];
    const globs = o.workOrder.pieces.flatMap((p) => p.files.map((g) => g.split("/").filter((x) => x !== "" && x !== ".").join("/")));
    for (const f of files) {
      try {
        if (effectiveModes(o.policy, f).workers !== "allow") prot.push(`${shown(f, o.secrets)} is a protected path (workers: ${effectiveModes(o.policy, f).workers})`);
      } catch (e) {
        prot.push(`${shown(f, o.secrets)} can't be checked against protected paths: ${shown(e instanceof Error ? e.message : String(e), o.secrets)}`);
      }
      // A piece's scope grants, so it matches case as the run's own git pathspecs do (protection ignores case).
      if (!globs.some((g) => globMatches(g, f, { caseSensitive: true }))) scope.push(`${shown(f, o.secrets)} is outside every piece's files`);
    }
    problems.push(...capGate("protected", prot), ...capGate("scope", scope));
    // 6. The secret scan, and the added-line signals. Only a scan with no leak, of commits whose headers pass, keeps
    // the run's commits: a forged identity or an extra header is as untrusted as an unscanned commit.
    const leaks = await secretScan(d, { scratch: o.scratch, base: o.base, head, secrets: o.secrets, commits });
    problems.push(...capGate("secret", leaks));
    const changes = await fileChanges(d, o.scratch, o.base, head, files);
    const signals = changes !== undefined ? signalsOf(changes, o.secrets) : ["the added-line signals could not be read: check the diff yourself"];
    clean = leaks.length === 0 && headerProblems.length === 0;
    return { head, files, problems, signals };
  }
}

/** Every object no ref reaches leaves the scratch: the reflogs expired, `repack -a -d`, `prune --expire=now`. Throws when git fails. */
export async function compactScratch(d: Pick<RunDeps, "run" | "env">, scratch: string): Promise<void> {
  for (const args of [["reflog", "expire", "--expire=now", "--all"], ["repack", "-a", "-d", "-q"], ["prune", "--expire=now"]]) {
    const r = await scratchGit(d, scratch, args);
    if (r.code !== 0) throw new Error(`git ${args[0]} exited ${r.code}: ${firstLine(r.stderr)}`);
  }
}

/**
 * Drop run `runId`'s commits from the scratch: its ref, then every object no ref reaches (`compactScratch`). After a
 * secret, an exit before the scan, or GitHub's refusal of the push (its push protection may have found what the
 * host's scan didn't). A missing ref is no error. Throws when git fails.
 */
export async function purgeRun(d: Pick<RunDeps, "run" | "env">, scratch: string, runId: string): Promise<void> {
  const r = await scratchGit(d, scratch, ["update-ref", "-d", `refs/hapi/runs/${runId}`]);
  if (r.code !== 0) throw new Error(`git update-ref exited ${r.code}: ${firstLine(r.stderr)}`);
  await compactScratch(d, scratch);
}

/**
 * How the host gates leave the scratch, on every exit from the bundle's fetch on: purged unless the scan was clean,
 * else compacted; then opened (readable by all). A step that fails throws its own error carrying the original one
 * (the gates' own throw, if any) as its cause, so neither is lost, and the scratch stays private: nothing after a
 * failed step runs.
 */
export async function settleScratch(o: { clean: boolean; failure: unknown; purge: () => Promise<void>; compact: () => Promise<void>; open: () => Promise<void>; what: string }): Promise<void> {
  const step = async (run: () => Promise<void>, doing: string) => {
    try {
      await run();
    } catch (e) {
      throw new Error(`cannot ${doing} ${o.what}: ${e instanceof Error ? e.message : String(e)}`, { cause: o.failure ?? e });
    }
  };
  if (o.clean) await step(o.compact, "compact");
  else await step(o.purge, "drop the unscanned commits from");
  await step(o.open, "make readable by all");
}

export interface Evidence {
  gates: GateResult;
  verify: VerifyResult;
  review: ReviewResult;
  cr: CodeRabbitResult;
  worker: WorkerResult;
  /** ./decisions.ts's, one per registry decision. */
  screens: Screened[];
}
export interface Outcome {
  push: boolean;
  draft: boolean;
  verdict: Verdict;
  reasons: string[];
}

/** Design §3.6's rows, the acceptance rules, then the screens' holds (see the module comment). Pure. */
export function outcome(e: Evidence, phases: Phases): Outcome {
  if (e.gates.problems.length > 0) return { push: false, draft: false, verdict: "do-not-merge", reasons: e.gates.problems.map((p) => p.detail) };
  const reasons: string[] = [];
  let verdict: Verdict = "ready";
  let draft = false;
  const dnm = (r: string) => {
    reasons.push(r);
    draft = true;
    verdict = "do-not-merge";
  };
  const decide = (r: string) => {
    reasons.push(r);
    if (verdict === "ready") verdict = "decision";
  };
  const v = e.verify;
  if (v.state === "off") decide("verify is off (runs.phases.verify): check, smoke and the acceptance tests were not run out of the worker's reach");
  else if (v.state === "broken") dnm(`verify: ${v.why}`);
  else if (v.state === "unconfirmed") decide(`verify: ${v.why}`);
  else {
    if (v.check === "failed") dnm("check failed in the verify container");
    if (v.smoke === "failed") dnm("smoke failed in the verify container");
    if (v.acceptance === "failed") dnm("the work order's acceptance tests failed in the verify container");
    if (v.acceptance === "none" && phases.require_acceptance) decide("the work order has no acceptance tests (runs.phases.require_acceptance)");
  }
  const r = e.review;
  if (r.state === "off") decide("the independent review is off (runs.phases.review)");
  else if (r.state === "none") decide(`no review: ${r.why}`);
  else {
    if (r.verdict !== "ready") decide(`the independent review says ${r.verdict}`);
    if (r.criteria.length === 0) decide("the review marked no acceptance criterion");
    r.criteria.forEach((c, i) => {
      if (c.mark !== "met") decide(`acceptance criterion ${i + 1} of ${r.criteria.length} is ${c.mark === "partly" ? "partly met" : "unmet"}`);
    });
  }
  if (e.cr.state === "reviewed") {
    const open = e.cr.findings.filter((f) => f.severity === "critical" || f.severity === "major").length;
    if (open > 0) decide(`${open} major or critical CodeRabbit ${open === 1 ? "finding is" : "findings are"} still open`);
    // Final review M1: the CLI's own gate failed, yet the host read no finding at major or above.
    else if (e.cr.gateFailed) decide("CodeRabbit's CLI failed its gate (exit 2: a finding at major or above), yet no major or critical finding was read from its output: check its findings yourself");
  }
  const w = e.worker;
  if (w.result === "blocked") decide("the worker reported RESULT: blocked");
  else if (w.result === "no-change") decide("the worker reported RESULT: no-change, yet changed files");
  else if (w.result === "missing") decide("the worker's final message has no RESULT: line");
  if (w.endsOnQuestion) decide("the worker's final message ends on a question");
  if (w.result === "done" && !w.hasFinal) decide("the run's transcript holds no final message");
  // Last, and replacing none of the above: the engine decisions' holds (in enforce, of an enforced decision).
  for (const s of e.screens) {
    if (s.models !== "enforce" || s.mode !== "enforce" || s.holds.length === 0) continue;
    reasons.push(...s.holds);
    if (verdict === "ready") verdict = "decision";
  }
  return { push: true, draft, verdict, reasons };
}

export interface PushOptions {
  scratch: string;
  remote: string;
  id: string;
  head: string;
  token: string;
}
/** moved: git's non-fast-forward; refused: GitHub's own refusal (push protection, a ruleset). Neither is ever forced. */
export type PushResult = { pushed: true } | { moved: string } | { refused: string };

/**
 * Push `head` to `factory/<id>`, never forced (no `+`, no `--force`): git itself, not `hardenedGit` (whose `env -i`
 * would need the token on its argv), with the token in the environment only (`authedGit`), no prompt and https alone
 * (`GIT_ALLOW_PROTOCOL`). git's non-fast-forward is `moved`, GitHub's own refusal `refused` (`pushOutcome`); any other
 * failure throws, the token and its header redacted.
 */
export async function push(d: Pick<RunDeps, "run" | "env">, o: PushOptions): Promise<PushResult> {
  if (!isWorkOrderId(o.id)) throw new Error(`not a work-order id: ${JSON.stringify(o.id)}`);
  if (!COMMIT.test(o.head)) throw new Error("not a commit id to push");
  const env = { PATH: d.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", ...authedGit(o.token) };
  const r = await d.run(
    ["git", "--git-dir", o.scratch, "-c", `safe.directory=${o.scratch}`, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "push", "--porcelain", o.remote, `${o.head}:refs/heads/factory/${o.id}`],
    { env, inherit: false },
  );
  const header = authedGit(o.token).GIT_CONFIG_VALUE_0!;
  const clean = (t: string) => redactSecrets(redactSecretForms(t, { TOKEN: o.token }), { HEADER: header });
  const outcome = pushOutcome(r.code, clean(r.stdout), o.id);
  if (outcome !== undefined) return outcome;
  throw new Error(`git push to factory/${o.id} failed (exit ${r.code}): ${firstLine(clean(r.stderr ?? ""))}`);
}

/**
 * What a `git push --porcelain` said: pushed (exit 0); `moved` only for a rejection that is git's own non-fast-forward
 * (`[rejected]` with `(non-fast-forward)` or `(fetch first)`); `refused` for GitHub's own refusal (`[remote rejected]`:
 * push protection, a ruleset), with its reason in a code span; undefined for any other failure (the caller throws).
 */
export function pushOutcome(code: number, porcelain: string, id: string): PushResult | undefined {
  if (code === 0) return { pushed: true };
  for (const line of porcelain.split("\n")) {
    if (!line.startsWith("!")) continue;
    const summary = line.split("\t")[2] ?? "";
    if (/^\[rejected\] \((non-fast-forward|fetch first)\)/.test(summary)) return { moved: `factory/${id} moved on GitHub (not a fast-forward): not overwritten` };
    const remote = /^\[remote rejected\] \((.*)\)\s*$/.exec(summary);
    if (remote) return { refused: `GitHub refused the push to factory/${id}: ${codeSpan(remote[1]!, 120)}` };
  }
  return undefined;
}

/** The PR's diff stat: `diff --numstat -z --no-renames <base> <head>` in the scratch, hardened as the gates' calls are; a binary file counts no line. */
export async function diffStat(d: Pick<RunDeps, "run" | "env">, o: { scratch: string; base: string; head: string }): Promise<PrInput["stat"]> {
  const r = await scratchGit(d, o.scratch, ["diff", "--numstat", "-z", "--no-renames", o.base, o.head]);
  if (r.code !== 0) throw new Error(`cannot read the PR's diff stat in the scratch (git diff exited ${r.code}): ${firstLine(r.stderr)}`);
  const stat = { files: 0, insertions: 0, deletions: 0 };
  for (const t of r.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(t);
    if (!m) continue;
    stat.files++;
    stat.insertions += m[1] === "-" ? 0 : Number(m[1]);
    stat.deletions += m[2] === "-" ? 0 : Number(m[2]);
  }
  return stat;
}

export interface HarvestDeps {
  run: RunDeps;
  engineDir: string;
  /** `<owner>/<name>`; per work order the policy is `policyOf(central, order)`. */
  repo: string;
  central: Policy;
  /** The tick's: githubForge over forgeToken tokens Task 14 revokes. */
  forge(purpose: "pr" | "checks"): Promise<Forge>;
  token(purpose: "push"): Promise<string>;
  /** The archon and review zones' values, for redaction only. */
  secrets(): Promise<Record<string, string>>;
  /** Production: `(o, r) => runGates(d, o, r)`. */
  gates(order: Discovered, rec: RunRecord): Promise<GateResult>;
  /** Production: `(o) => push(d.run, o)`. */
  pushBranch(o: PushOptions): Promise<PushResult>;
  /** The forge's visibility: Jev is asked only when true. */
  public: boolean;
  /** Production: `(o) => diffSubjects(d.run, o)`. */
  subjects(o: DiffInput): Promise<Subject[]>;
  /** Production: `(o) => diffStat(d.run, o)`. */
  stat(o: { scratch: string; base: string; head: string }): Promise<PrInput["stat"]>;
  /** Production: `ask` (src/decide/record.ts); tests: fakeDecide. */
  decide: typeof ask;
  /** The archon zone's two classifier keys, read in-process, never in an env. */
  decideKeys(): Promise<{ jev: string | undefined; anthropic: string | undefined }>;
}

/** Each diff-based registry decision's subjects for `head` (`<mergeSha>..<head>` in the scratch); none with decision models off. */
async function subjectsFor(d: Pick<HarvestDeps, "subjects">, policy: Policy, order: Discovered, scratch: string, head: string, secrets: Record<string, string>): Promise<Subject[]> {
  const subjects: Subject[] = [];
  if (policy.decisions.mode === "off") return subjects;
  for (const [name, entry] of Object.entries(ENGINE_DECISIONS)) {
    const knob = policy.decisions.by_name[name];
    if (entry.subjects !== "diff" || knob === undefined || knob.mode === "off") continue;
    subjects.push(...(await d.subjects({ decision: name, scratch, base: order.mergeSha, head, goal: goalOf(order.taskMd), skip: knob.skip_paths ?? [], maxChars: policy.gates.max_state_chars, secrets })));
  }
  return subjects;
}

/** The work order's policy: the central one, with its overlay applied when it has one. */
export const policyOf = (central: Policy, order: Discovered): Policy => (order.overlay === undefined ? central : applyOverlay(central, order.overlay));

/** `<engineDir>/scratch/<owner>/<name>/<id>.git`. */
export const scratchPath = (engineDir: string, repo: string, id: string): string => {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${repo}`);
  if (!isWorkOrderId(id)) throw new Error(`not a work-order id: ${JSON.stringify(id)}`);
  return join(engineDir, "scratch", r.owner, r.name, `${id}.git`);
};

/** The host gates on `rec`'s bundle, its base the run's own `sha` (a fix run's gates see only the fix). */
export async function runGates(d: Pick<HarvestDeps, "run" | "engineDir" | "repo" | "central" | "secrets">, order: Discovered, rec: RunRecord): Promise<GateResult> {
  return hostGates(d.run, {
    mirror: mirrorPath(d.engineDir, d.repo),
    scratch: scratchPath(d.engineDir, d.repo, order.id),
    bundle: join(recordDir(d.run.stateDir, rec.runId), "out", "run.bundle"),
    runId: rec.runId,
    base: rec.sha,
    workOrder: order.workOrder,
    policy: policyOf(d.central, order),
    secrets: await d.secrets(),
  });
}

export interface Round {
  round: number;
  stage: "before-pr" | "on-pr" | "rework";
  run: string;
}
/** run: the latest worker or fix run whose gates pass; verify and review: of its head. */
export interface HarvestInput {
  order: Discovered;
  run: RunRecord;
  verify?: RunRecord;
  review?: RunRecord;
  runs: RunRecord[];
  rounds: Round[];
  position: { k: number; n: number; siblings: number[] };
  /**
   * Reasons the state machine carries to this harvest (Task 13: a fix before the PR that failed or was refused, a
   * soft cap's start): added to the outcome's, so the PR and the state say so, the verdict at best Needs your decision.
   */
  carried?: string[];
}

/** A test call at a line's start: `test(`, `it(`, and their modifiers but `.each` (which adds tests a static count can't see). */
const TEST_CALL = /^\s*(?:test|it)(?:\.(?:only|skip|todo|failing|serial|concurrent|if\([^)\n]*\)))?\s*\(/gm;

/**
 * The planner's acceptance test files at the merge (`.factory/work/<id>/acceptance/`), each with its static test
 * count (at least 1), read as blobs; undefined when they can't be listed or read.
 */
async function acceptanceFiles(d: Pick<RunDeps, "run" | "env">, scratch: string, mergeSha: string, id: string): Promise<PlannerTest[] | undefined> {
  if (!(await exists(join(scratch, "HEAD")))) return undefined;
  const r = await scratchGit(d, scratch, ["ls-tree", "-r", "-z", mergeSha, "--", `.factory/work/${id}/acceptance`], ["--literal-pathspecs"]);
  if (r.code !== 0) return undefined;
  const out: PlannerTest[] = [];
  for (const entry of r.stdout.split("\0").filter((e) => e !== "")) {
    const tab = entry.indexOf("\t");
    const [, type, oid] = entry.slice(0, tab).split(" ");
    const file = entry.slice(tab + 1);
    if (type !== "blob" || !/(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const blob = await scratchGit(d, scratch, ["cat-file", "blob", oid!]);
    if (blob.code !== 0) return undefined;
    out.push({ file, tests: Math.max(1, blob.stdout.match(TEST_CALL)?.length ?? 0) });
  }
  return out;
}

/** The new-side line ranges of each file a fix run changed (`<fix sha>..<head>`), per file of a `-z` list (`fileChanges`); a deleted file has none. */
export async function fixHunks(d: Pick<RunDeps, "run" | "env">, scratch: string, base: string, head: string): Promise<Map<string, [number, number][]>> {
  const names = await scratchGit(d, scratch, ["diff", "--name-only", "-z", "--no-renames", base, head]);
  if (names.code !== 0) return new Map();
  const changes = await fileChanges(d, scratch, base, head, names.stdout.split("\0").filter((f) => f !== ""));
  return new Map([...(changes ?? new Map<string, FileChange>())].map(([f, c]) => [f, c.ranges]));
}

/**
 * Design §3.5's rule, without a model: a major or critical finding on the head (the review's or CodeRabbit's) whose
 * file, and line when it has one, falls in the fix run's own hunks, is unresolved at the top of the PR.
 */
function unfixedFindings(e: Evidence, hunks: Map<string, [number, number][]>, round: number): string[] {
  const lines: string[] = [];
  const check = (path: string, line: number | undefined, source: string) => {
    const ranges = hunks.get(path);
    if (ranges === undefined) return;
    if (line === undefined) lines.push(`a major finding (${source}) is in ${shownPath(path)}, a file round ${round}'s fix changed: unfixed`);
    else if (ranges.some(([a, b]) => line >= a && line <= b)) lines.push(`a major finding (${source}) is on line ${line} of ${shownPath(path)}, in round ${round}'s fix's own change: unfixed`);
  };
  if (e.review.state === "ran") {
    for (const f of e.review.findings) {
      if (f.severity !== "major" && f.severity !== "critical") continue;
      const m = /^(.*?):(\d+)(?:[-:]\d+)?$/.exec(f.path);
      check(m ? m[1]! : f.path, m ? Number(m[2]) : undefined, "the independent review");
    }
  }
  if (e.cr.state === "reviewed") for (const f of e.cr.findings) if (f.severity === "major" || f.severity === "critical") check(f.file, f.line, "CodeRabbit");
  return [...new Set(lines)];
}

/** The round a PR body's hidden block (`<!-- hapi:pr v1 {...} -->`) names, when its head is `head`. */
function roundOfBody(body: string, head: string): number | undefined {
  const m = /<!-- hapi:pr v1 (\{[^\n]*?\}) -->/.exec(body);
  if (!m) return undefined;
  try {
    const b = JSON.parse(m[1]!) as { head?: unknown; round?: unknown };
    return b.head === head && typeof b.round === "number" && Number.isInteger(b.round) && b.round >= 0 ? b.round : undefined;
  } catch {
    return undefined;
  }
}

/** Why the outcome is a draft, as the not-pushed reason says it: what failed in the verify container, or why it can't be read. */
function draftCause(e: Evidence): string {
  const v = e.verify;
  if (v.state === "broken") return `has no readable verify result (verify: ${v.why})`;
  if (v.state === "ran") {
    const failed = [v.check === "failed" ? "check" : undefined, v.smoke === "failed" ? "smoke" : undefined, v.acceptance === "failed" ? "the acceptance tests" : undefined].filter((x): x is string => x !== undefined);
    if (failed.length > 0) return `failed ${failed.length === 1 ? failed[0] : `${failed.slice(0, -1).join(", ")} and ${failed.at(-1)}`} in the verify container`;
  }
  return "is a draft's (the verify container's results)";
}

/** The PR's title: `<id>: <task.md's first "# " heading>`, sanitized, no `@ < >`, at most 72 characters. */
function titleOf(order: Discovered): string {
  const heading = /^# (.+)$/m.exec(order.taskMd)?.[1]?.trim() ?? "";
  const t = sanitizeTerminal(`${order.id}: ${heading}`.replace(/[\n\t]/g, " ")).replace(/[@<>]/g, "").trim();
  const chars = Array.from(t);
  return chars.length > 72 ? `${chars.slice(0, 71).join("")}…` : t;
}

/**
 * Set `harvestedAt` (and, with decision models off, `decisions: "off"` in the same write) on a record, and on the
 * review run's its `review` (m20), never overwriting either, under its run lock.
 */
async function markHarvested(d: HarvestDeps, runId: string, at: string, off: boolean, review?: RunRecord["review"]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await withRunLock(d.run, runId, async () => {
        const r = await readRecord(d.run.stateDir, runId);
        if (r === undefined) return;
        const first = r.harvestedAt === undefined;
        const addReview = review !== undefined && r.review === undefined;
        if (!first && !addReview) return;
        await writeRecord(d.run.stateDir, {
          ...r,
          ...(first ? { harvestedAt: at, ...(off ? { decisions: "off" as const } : {}) } : {}),
          ...(addReview ? { review } : {}),
        });
      });
      return;
    } catch (e) {
      // A finalize or a reap holds the run's lock for a moment: wait for it, a few times, then fail the tick closed.
      if (!lockHeld(e) || attempt >= 10) throw e;
      await Bun.sleep(500);
    }
  }
}

/**
 * Harvest a work order's pipeline (see the module comment). Returns the state with `pr`, `prHead`, `verdict`,
 * `reasons` and `updatedAt`; the phase unchanged. A PR body with no room for the host's part beside the operator's
 * own text isn't written: its reason (`noRoomReason`) comes first, and the tick goes on. Throws (the tick fails closed
 * for the repo, nothing pushed after the throw) on a host failure: a forge error, a failed append to the decision
 * ledger, a push that fails.
 */
export async function harvest(d: HarvestDeps, s: WorkOrderState, h: HarvestInput): Promise<WorkOrderState> {
  for (const r of [h.run, h.verify, h.review]) {
    if (r?.status === "live") throw new Error(`run ${r.runId} is still live: the harvester reads only finished runs`);
  }
  const policy = policyOf(d.central, h.order);
  const phases = policy.runs.phases;
  const id = h.order.id;
  const now = d.run.now().toISOString();
  const off = policy.decisions.mode === "off";
  const scratch = scratchPath(d.engineDir, d.repo, id);
  const gates = await d.gates(h.order, h.run);
  const secrets = await d.secrets();
  const outOf = (r: RunRecord | undefined) => (r === undefined ? undefined : join(recordDir(d.run.stateDir, r.runId), "out"));
  const ofHead = (r: RunRecord | undefined) => (r !== undefined && gates.head !== undefined && r.sha === gates.head ? r : undefined);
  const verifyRec = ofHead(h.verify);
  const reviewRec = ofHead(h.review);
  const read = [...new Map([h.run, h.verify, h.review, ...h.runs].filter((r): r is RunRecord => r !== undefined).map((r) => [r.runId, r])).values()];
  const done = async (state: WorkOrderState): Promise<WorkOrderState> => {
    // m20: the review's verdict and the criteria's marks go on the review run's record, with harvestedAt.
    const review = e.review.state === "ran" && reviewRec !== undefined ? { runId: reviewRec.runId, review: { verdict: e.review.verdict, marks: e.review.criteria.map((c) => c.mark) } } : undefined;
    for (const r of read) await markHarvested(d, r.runId, now, off, review?.runId === r.runId ? review.review : undefined);
    return state;
  };
  const e: Evidence = {
    gates,
    verify: verifyResult(outOf(verifyRec), h.order.workOrder, phases, {
      exitCode: verifyRec?.exitCode,
      acceptanceFiles: gates.problems.length === 0 ? await acceptanceFiles(d.run, scratch, h.order.mergeSha, id) : undefined,
    }),
    review: reviewResult(outOf(reviewRec), phases),
    cr: codeRabbitResult(outOf(reviewRec), phases),
    worker: await workerResult(outOf(h.run)!, secrets),
    screens: [],
  };
  // A no-room reason (final re-review N3) is the PR body's state, never the change's: it isn't carried to the PR.
  const carried = (h.carried ?? []).filter((r) => !isNoRoom(r));
  const carry = (o: Outcome): Outcome => (carried.length === 0 ? o : { ...o, verdict: worse(o.verdict, "decision"), reasons: [...new Set([...o.reasons, ...carried])] });
  // The gates and evidence settle push and draft; the screens can't change either.
  const first = outcome(e, phases);
  if (!first.push) return done({ ...s, verdict: first.verdict, reasons: carry(first).reasons, updatedAt: now });
  const head = gates.head!;

  const forge = await d.forge("pr");
  const ref = `factory/${id}`;
  const pr: PrInfo | undefined = s.pr !== undefined ? await forge.pr(s.pr) : await forge.findPr(ref);
  // A closed factory PR is this work order's own: it leaves with its PR set, and Task 13 settles it closed.
  if (pr?.state === "closed") return done({ ...s, pr: pr.number, reasons: ["the PR was closed"], updatedAt: now });

  // The branch already at this head: the factory's own push, before a write that failed or a crash lost the state
  // (Task 13's replay). Nothing moved it, and it isn't pushed again.
  const already = pr !== undefined && pr.headSha === head;
  // Not pushed: a branch moved since the factory's push, or a ready PR whose new head is a draft's (m49(5): the PR
  // keeps its head, and the unpushed head is named only in the reason and its Evidence rows).
  let notPushed: string | undefined;
  if (!already && pr !== undefined && s.prHead !== undefined && pr.headSha !== s.prHead) {
    notPushed = `${ref} moved to ${short(pr.headSha)} since the factory pushed ${short(s.prHead)}: not overwritten; the run's head ${short(head)} was not pushed`;
  } else if (!already && pr !== undefined && !pr.draft && first.draft) {
    const failed = h.verify ?? h.run;
    notPushed = `round ${failed.round ?? h.run.round ?? 0}'s head ${short(head)} ${draftCause(e)}, so it was not pushed over the ready PR (run ${failed.runId})`;
  }

  let result: Outcome = first;
  let prHead = s.prHead;
  if (notPushed === undefined) {
    // Only a head it will push is screened; every answer is saved before the push.
    const subjects = await subjectsFor(d, policy, h.order, scratch, head, secrets);
    e.screens = await screenHarvest(d, { s, run: h.run, head, subjects, policy, ask: true });
    result = outcome(e, phases);
    const pushed: PushResult = already ? { pushed: true } : await d.pushBranch({ scratch, remote: `https://github.com/${d.repo}.git`, id, head, token: await d.token("push") });
    if ("pushed" in pushed) prHead = head;
    else {
      notPushed = `${"moved" in pushed ? pushed.moved : pushed.refused}; the run's head ${short(head)} was not pushed`;
      // Asked and paid for, but of a head that wasn't pushed: the Evidence row says so, and nothing of them is used.
      e.screens = e.screens.map((x) => ({ ...x, pushed: false, holds: [], notes: [], coverage: [], held: [] }));
      // GitHub's refusal may be its push protection finding what the host's scan didn't: the commits leave the scratch.
      if ("refused" in pushed) {
        await purgeRun(d.run, scratch, h.run.runId);
        // Then readable by all again, as after every gates run: a later run container's uid reads the scratch (D71).
        await readableByAll(scratch);
      }
    }
  }
  if (notPushed !== undefined) {
    if (e.screens.length === 0 || e.screens.every((x) => x.pushed)) e.screens = emptyScreens(policy, false);
    // The other reasons are of the head that wasn't pushed: each says so, since the PR shows another.
    result = { ...first, verdict: "decision", reasons: [notPushed, ...first.reasons.map((r) => `${short(head)} (not pushed): ${r}`)] };
    // A branch the factory didn't push is never shown as its head, nor opened as its PR.
    if (pr === undefined) return done({ ...s, verdict: carry(result).verdict, reasons: carry(result).reasons, updatedAt: now });
  }
  result = carry(result);
  const shownHead = notPushed === undefined ? head : (s.prHead ?? pr!.headSha);

  // The body, its labels, then harvestedAt.
  const ledger = await readLedger(ledgerPath(d.engineDir, d.repo, id));
  const spends = h.runs.map((r) => runSpend(d.run.stateDir, r, h.order.workOrder.budget.usd));
  const turns = (await Promise.all(h.runs.map((r) => turnsOfRun(outOf(r)!)))).reduce<number>((n, t) => n + (t ?? 0), 0);
  const fix = notPushed === undefined && h.run.kind === "fix" ? unfixedFindings(e, await fixHunks(d.run, scratch, h.run.sha, head), h.run.round ?? 1) : [];
  // The stat only of a head the scratch holds: the one pushed, or the factory's last (else the body has none).
  const known = (await scratchGit(d.run, scratch, ["cat-file", "-e", `${shownHead}^{commit}`])).code === 0;
  const input: PrInput = {
    order: h.order,
    outcome: result,
    evidence: e,
    head: shownHead,
    stat: known ? await d.stat({ scratch, base: h.order.mergeSha, head: shownHead }) : undefined,
    planningPr: s.planningPr,
    position: h.position,
    runs: h.runs.map((r) => ({ id: r.runId, kind: r.kind ?? "worker", round: r.round ?? 0, ...(r.retry === undefined ? {} : { retry: r.retry }) })),
    rounds: h.rounds,
    roundCap: phases.fix_rounds_before_pr + phases.fix_rounds_on_pr,
    cost: {
      usd: spends.reduce((n, x) => n + x.usd, 0),
      unknown: spends.filter((x) => !x.known).length,
      turns,
      decisions: { usd: await decisionSpend(d.engineDir, { repo: d.repo, ids: [id], from: new Date(0), to: d.run.now(), unknownUsd: policy.gates.classifiers.jev.unknown_call_usd }), calls: callsOf(ledger) },
    },
    phase: "pr",
    // The hidden block's round is its head's: the pushed run's, or, when nothing was pushed, the round the PR's own
    // block names for that head; with no such block the round isn't known, and the block carries none.
    round: notPushed === undefined ? (h.run.round ?? 0) : pr === undefined ? undefined : roundOfBody(pr.body, shownHead),
    ci: "pending",
    ...(notPushed === undefined ? {} : { unpushed: head }),
    ...(fix.length > 0 ? { unfixed: fix } : {}),
  };
  let number: number;
  let noRoom: string | undefined;
  if (pr !== undefined) {
    number = pr.number;
    // The body read again just before it is written (final review M4): an edit outside the markers made while the
    // screens and the push ran is kept, not lost. With no room beside it even for the fallback (final re-review N3),
    // nothing is written, and the state says why, first, so the status row shows it.
    const fresh = await forge.pr(number);
    const body = rerenderPr(fresh.body, input);
    if ("noRoom" in body) noRoom = body.noRoom;
    else await forge.editPrBody(number, body.body);
    // In a not-pushed case the body is the one state-changing write: nothing marks a head nobody vetted ready.
    if (notPushed === undefined && pr.draft && !result.draft) await forge.markReady(number);
  } else {
    number = (await forge.openPr({ head: ref, base: "main", title: titleOf(h.order), body: renderPr(input), draft: result.draft })).number;
  }
  // Labels only with a push: nothing flags a PR for a head it doesn't show.
  if (notPushed === undefined) {
    const flagged =
      policy.flags.on_flag.includes("label_pr") &&
      (spends.reduce((n, x) => n + x.usd, 0) > policy.flags.thresholds.run_usd || s.reworkRounds > policy.flags.thresholds.review_rounds);
    await forge.addLabels(number, flagged ? ["lane:factory", "hapi:flagged"] : ["lane:factory"]);
  }
  return done({ ...s, pr: number, ...(prHead === undefined ? {} : { prHead }), verdict: result.verdict, reasons: noRoom === undefined ? result.reasons : [noRoom, ...result.reasons], updatedAt: now });
}

const RANK: Record<Verdict, number> = { ready: 0, decision: 1, "do-not-merge": 2 };
/** The worse of two verdicts. */
export const worse = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

/**
 * Re-render a factory PR's body for the head it shows, `s.prHead` (Plan 03 Task 13): when `ci / gates` completes on
 * it (Ready to merge shows only once it is green, the Task 8 → 13 ruling), or when the state machine moves the PR to
 * `waiting` with a reason (rulings m31, m50). `h.run` is the run whose head that is. The body is built as the
 * harvest builds it, from the scratch and the ledger: that run's gates and evidence, the screens re-read from the
 * ledger (`ask: false`, so it asks and spends nothing; with decision models off it builds no subjects), the whole
 * ledger's cost, and the state's reasons beyond the outcome's under Unresolved (but a no-room reason, the body's own
 * state), with a verdict no better than the state's. It pushes nothing, marks nothing ready and adds no label.
 * Returns what it did: `written`; `unchanged` when the body is already that; `not-the-head` when the run's gates
 * don't give the PR's head; or `noRoom` with why, writing nothing, when the operator's own text leaves no room even
 * for the fallback (final re-review N3).
 */
export async function rerender(
  d: HarvestDeps,
  s: WorkOrderState,
  h: HarvestInput,
  o: { forge: Forge; pr: PrInfo; ci: "pending" | "passed" | "failed"; phase: Phase },
): Promise<"written" | "unchanged" | "not-the-head" | { noRoom: string }> {
  const policy = policyOf(d.central, h.order);
  const phases = policy.runs.phases;
  const id = h.order.id;
  const scratch = scratchPath(d.engineDir, d.repo, id);
  const gates = await d.gates(h.order, h.run);
  if (gates.head === undefined || gates.head !== s.prHead || gates.problems.length > 0) return "not-the-head";
  const head = gates.head;
  const secrets = await d.secrets();
  const outOf = (r: RunRecord | undefined) => (r === undefined ? undefined : join(recordDir(d.run.stateDir, r.runId), "out"));
  const ofHead = (r: RunRecord | undefined) => (r !== undefined && r.sha === head ? r : undefined);
  const verifyRec = ofHead(h.verify);
  const reviewRec = ofHead(h.review);
  const e: Evidence = {
    gates,
    verify: verifyResult(outOf(verifyRec), h.order.workOrder, phases, { exitCode: verifyRec?.exitCode, acceptanceFiles: await acceptanceFiles(d.run, scratch, h.order.mergeSha, id) }),
    review: reviewResult(outOf(reviewRec), phases),
    cr: codeRabbitResult(outOf(reviewRec), phases),
    worker: await workerResult(outOf(h.run)!, secrets),
    screens: [],
  };
  e.screens = await screenHarvest(d, { s, run: h.run, head, subjects: await subjectsFor(d, policy, h.order, scratch, head, secrets), policy, ask: false });
  const result = outcome(e, phases);
  const extra = s.reasons.filter((r) => !result.reasons.includes(r) && !isNoRoom(r));
  const verdict = worse(worse(result.verdict, s.verdict ?? "ready"), extra.length > 0 ? "decision" : "ready");
  const ledger = await readLedger(ledgerPath(d.engineDir, d.repo, id));
  const spends = h.runs.map((r) => runSpend(d.run.stateDir, r, h.order.workOrder.budget.usd));
  const turns = (await Promise.all(h.runs.map((r) => turnsOfRun(outOf(r)!)))).reduce<number>((n, t) => n + (t ?? 0), 0);
  const fix = h.run.kind === "fix" ? unfixedFindings(e, await fixHunks(d.run, scratch, h.run.sha, head), h.run.round ?? 1) : [];
  const input: PrInput = {
    order: h.order,
    outcome: { ...result, verdict, reasons: [...result.reasons, ...extra] },
    evidence: e,
    head,
    stat: await d.stat({ scratch, base: h.order.mergeSha, head }),
    planningPr: s.planningPr,
    position: h.position,
    runs: h.runs.map((r) => ({ id: r.runId, kind: r.kind ?? "worker", round: r.round ?? 0, ...(r.retry === undefined ? {} : { retry: r.retry }) })),
    rounds: h.rounds,
    roundCap: phases.fix_rounds_before_pr + phases.fix_rounds_on_pr,
    cost: {
      usd: spends.reduce((n, x) => n + x.usd, 0),
      unknown: spends.filter((x) => !x.known).length,
      turns,
      decisions: { usd: await decisionSpend(d.engineDir, { repo: d.repo, ids: [id], from: new Date(0), to: d.run.now(), unknownUsd: policy.gates.classifiers.jev.unknown_call_usd }), calls: callsOf(ledger) },
    },
    phase: o.phase,
    round: roundOfBody(o.pr.body, head) ?? h.run.round ?? 0,
    ci: o.ci,
    ...(fix.length > 0 ? { unfixed: fix } : {}),
  };
  // The body read again just before it is written (final review M4), so an edit outside the markers made while
  // the gates and the screens ran is kept.
  const fresh = await o.forge.pr(o.pr.number);
  const body = rerenderPr(fresh.body, input);
  if ("noRoom" in body) return { noRoom: body.noRoom };
  if (body.body === fresh.body) return "unchanged";
  await o.forge.editPrBody(o.pr.number, body.body);
  return "written";
}
