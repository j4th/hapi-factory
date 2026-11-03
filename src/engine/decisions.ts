/**
 * The run engine's decisions (design §3.6, "Decisions"; Plan 03 Task 12): `decide()`'s typed, advisory questions
 * about a head the harvester will push, as data. An answer can only hold back `Ready to merge` or add a note under
 * "Check this yourself": nothing here pushes, opens, closes or drafts a PR, moves a phase or starts a run.
 *
 * - **The registry**, `ENGINE_DECISIONS`: each decision file (policy/decisions/<name>.ts, an `EngineDecisionFile`)
 *   and the source of its subjects. gates.yaml's `decisions.by_name` has one entry per name (the schema and a test
 *   hold them equal). Adding a decision is a file, a line here and a knob; a new kind of subject also needs a
 *   builder here and its call site.
 * - **Subjects** (`diffSubjects`, the source `"diff"`): each changed file of `<mergeSha>..<head>`, its diff in the
 *   scratch, read with hardened git. A `skip_paths` entry is an exact repo path, matched case-sensitively, never a
 *   glob, and the file it names is skipped only when its content at the head is, structurally, the lockfile its name
 *   says (`LOCKFILES`: for bun.lock, no comment, only Bun's keys and shapes, and every string a name, spec,
 *   resolution, integrity or path); one that isn't is unscreened, so a worker can't hide text from the screen behind
 *   a lockfile's name. Every string is redacted first (`redactSecretForms`), then a
 *   long diff is cut into windows of whole lines, each with the file's header lines, covering every line once.
 *   Content the diff doesn't show (a binary, a `-diff` attribute, a gitlink) is a subject with no state: unscreened.
 * - **The ledger**, `<engineDir>/decisions/<owner>/<name>/<id>.jsonl` (0600, dirs 0700, append-only): an `asking`
 *   line before each call, an `answer` line after it (or for a subject not asked). It is the cache (an answered
 *   state is never asked again: its key is a digest of the host's own state), the spend (`decisionSpend`: an
 *   unanswered call counts at `unknown_call_usd`, never 0) and the evals' record (Plan 06, H-262). It never holds a
 *   state's text or a key. The caller holds the work order's lock (Task 13's tick) while it appends.
 * - **`screenHarvest`** asks every registry decision whose mode isn't `off`: it reuses what the ledger answered,
 *   asks the rest within `max_calls_per_head` (all at once), writes each call before it is made and each answer
 *   before it returns, and works each effect out again under the current modes. `ask: false` (a re-render) asks
 *   and appends nothing, and holds what it has no answer for. `decisions.mode: off` reads, asks and appends nothing.
 *
 * The only words of a decision that reach a PR, a status comment or a reason are the file's `says`, numbers and
 * host-built paths (`shownPath`): never a model's text.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, truncate } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import diffScreen from "../../policy/decisions/diff-screen";
import type { DecideOptions, DecideResult, EngineDecisionFile, EngineVerdict, State } from "../decide/index";
import { stateLength } from "../decide/index";
import { type ask, type RecordedAnswer, recordedAnswers } from "../decide/record";
import { parseOwnerRepo } from "../forge/github/app-token";
import type { DecisionMode, DecisionModels, EngineDecision, Policy } from "../policy/types";
import { hardenedGit } from "../run/git";
import type { RunRecord } from "../run/records";
import { redactSecretForms, sanitizeTerminal } from "../run/sanitize";
import type { RunDeps } from "../run/spec";
import { isWorkOrderId } from "../workorder/validate";
import type { WorkOrderState } from "./state";

/** Where a decision's subjects come from: `"diff"`, each changed file's diff, in windows. */
export type SubjectSource = "diff";

/** The engine's decisions, by name: each file and its subjects' source. gates.yaml's `decisions.by_name` matches it. */
/** heldFor: what a finding hold found, for the PR's verdict line (D73: `held: <heldFor> in <paths>`). */
export const ENGINE_DECISIONS: Readonly<Record<string, { file: EngineDecisionFile; subjects: SubjectSource; heldFor: string }>> = Object.freeze({
  "diff-screen": { file: diffScreen, subjects: "diff", heldFor: "text aimed at the reviewer" },
});

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const versions = new Map<string, string>();

/** The first 12 hex of the sha256 of policy/decisions/<name>.ts's bytes: it pins the questions, glosses, thresholds, `says` and fallback. */
export function decisionVersion(name: string): string {
  if (!NAME.test(name)) throw new Error(`not a decision name: ${JSON.stringify(name)}`);
  const known = versions.get(name);
  if (known !== undefined) return known;
  const v = createHash("sha256").update(readFileSync(join(import.meta.dir, "..", "..", "policy", "decisions", `${name}.ts`))).digest("hex").slice(0, 12);
  versions.set(name, v);
  return v;
}

/** decide()'s options for the engine, as the guard's `decideOptions` builds them: keys in the options only, Jev only for a public repo. */
export function engineDecideOptions(p: Policy, isPublic: boolean, keys: { jev: string | undefined; anthropic: string | undefined }): DecideOptions {
  return {
    gates: p.gates,
    jev: { enabled: p.flags.jev.enabled, public: isPublic, apiKey: keys.jev },
    haiku: { enabled: p.flags.jev.fallback === "haiku", apiKey: keys.anthropic },
  };
}

/** `<engineDir>/decisions/<owner>/<name>`: a repo's ledgers. Throws for a repo that isn't an owner/name. */
function ledgerDir(engineDir: string, repo: string): string {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${repo}`);
  return join(engineDir, "decisions", r.owner, r.name);
}

/** `<engineDir>/decisions/<owner>/<name>/<id>.jsonl`. Throws for a repo that isn't an owner/name, or an id that isn't a work-order id. */
export function ledgerPath(engineDir: string, repo: string, id: string): string {
  if (!isWorkOrderId(id)) throw new Error(`not a work-order id: ${JSON.stringify(id)}`);
  return join(ledgerDir(engineDir, repo), `${id}.jsonl`);
}

/** What every ledger line carries. `call` joins an `asking` line to its `answer`. */
export interface LineBase {
  call?: string;
  at: string;
  repo: string;
  workOrder: string;
  retry: number;
  run: string;
  head: string;
  decision: string;
  version: string;
  subject: string;
  part: string;
  key: string;
  public: boolean;
}
/** Appended before each call. */
export interface AskingLine extends LineBase {
  kind: "asking";
  call: string;
}
/** A call's answer, or a subject that wasn't asked (no `call`, `via: "default"`, `cost_usd: 0`). `models` is enforce or notes: off writes no line. */
export interface DecisionEntry extends LineBase {
  kind: "answer";
  state_chars: number;
  models: DecisionModels;
  mode: DecisionMode;
  via: "jev" | "haiku" | "default";
  fallback: boolean;
  model?: string;
  latency_ms: number;
  cost_usd: number;
  answers?: Record<string, RecordedAnswer>;
  verdict: EngineVerdict;
  effect: EngineVerdict | "none";
  truncated?: true;
  error?: string;
}
export type LedgerLine = AskingLine | DecisionEntry;

const BASE_KEYS = ["call", "at", "repo", "workOrder", "retry", "run", "head", "decision", "version", "subject", "part", "key", "public"];
const ANSWER_KEYS = new Set([...BASE_KEYS, "kind", "state_chars", "models", "mode", "via", "fallback", "model", "latency_ms", "cost_usd", "answers", "verdict", "effect", "truncated", "error"]);
const ASKING_KEYS = new Set([...BASE_KEYS, "kind"]);
const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isAmount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** `x` as a ledger line, or undefined when it isn't one this module writes. */
function asLine(x: unknown): LedgerLine | undefined {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return undefined;
  const r = x as Record<string, unknown>;
  const base = ["at", "repo", "workOrder", "run", "head", "decision", "version", "subject", "part", "key"].every((k) => isString(r[k]));
  if (!base || !isCount(r.retry) || typeof r.public !== "boolean" || Number.isNaN(Date.parse(r.at as string))) return undefined;
  if (r.kind === "asking") {
    if (!isString(r.call) || Object.keys(r).some((k) => !ASKING_KEYS.has(k))) return undefined;
    return r as unknown as AskingLine;
  }
  if (r.kind !== "answer" || Object.keys(r).some((k) => !ANSWER_KEYS.has(k))) return undefined;
  const ok =
    (r.call === undefined || isString(r.call)) &&
    isCount(r.state_chars) &&
    (r.models === "enforce" || r.models === "notes") &&
    (r.mode === "shadow" || r.mode === "enforce") &&
    (r.via === "jev" || r.via === "haiku" || r.via === "default") &&
    typeof r.fallback === "boolean" &&
    (r.model === undefined || isString(r.model)) &&
    isAmount(r.latency_ms) &&
    isAmount(r.cost_usd) &&
    (r.answers === undefined || (r.answers !== null && typeof r.answers === "object" && !Array.isArray(r.answers))) &&
    (r.verdict === "pass" || r.verdict === "note" || r.verdict === "hold") &&
    (r.effect === "pass" || r.effect === "note" || r.effect === "hold" || r.effect === "none") &&
    (r.truncated === undefined || r.truncated === true) &&
    (r.error === undefined || isString(r.error));
  return ok ? (r as unknown as DecisionEntry) : undefined;
}

/** The ledger's lines: [] when it is missing; a torn last line (no newline after it: a crash during an append) is ignored; any other bad line throws. */
export async function readLedger(file: string): Promise<LedgerLine[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const end = bytes.lastIndexOf(0x0a);
  if (end === -1) return [];
  const text = bytes.subarray(0, end).toString("utf8");
  return text.split("\n").map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const l = asLine(parsed);
    if (l === undefined) throw new Error(`${file} line ${i + 1} is not a decision entry`);
    return l;
  });
}

/**
 * Append whole lines to the ledger (0600, its directories 0700), after cutting a torn tail (the bytes after the last
 * newline, left by a crash during an append). The caller holds the work order's lock. A failure throws.
 */
export async function appendLedger(file: string, lines: LedgerLine[]): Promise<void> {
  if (lines.length === 0) return;
  const dir = dirname(file);
  // The dirs this call makes are 0700 whatever the umask; one that exists is left as it is.
  const made = await mkdir(dir, { recursive: true, mode: 0o700 });
  if (made !== undefined) for (let d = dir; d.length >= made.length; d = dirname(d)) await chmod(d, 0o700);
  let bytes: Buffer | undefined;
  try {
    bytes = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (bytes !== undefined && bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) await truncate(file, bytes.lastIndexOf(0x0a) + 1);
  await appendFile(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Every ledger file under `<engineDir>/decisions`, or `repo`'s alone; with `ids`, those work orders' alone. */
async function ledgerFiles(engineDir: string, repo: string | undefined, ids: readonly string[] | undefined): Promise<string[]> {
  const list = async (dir: string) => {
    try {
      return (await readdir(dir)).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  };
  const root = join(engineDir, "decisions");
  const dirs: string[] = [];
  if (repo !== undefined) dirs.push(ledgerDir(engineDir, repo));
  else for (const owner of await list(root)) for (const name of await list(join(root, owner))) dirs.push(join(root, owner, name));
  const files: string[] = [];
  for (const dir of dirs) {
    for (const f of await list(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      if (ids !== undefined && !ids.includes(f.slice(0, -".jsonl".length))) continue;
      files.push(join(dir, f));
    }
  }
  return files;
}

/**
 * What the ledgers' calls cost in `[from, to)`: each `asking` line in the window counts at its answer's `cost_usd`
 * when a classifier answered (`via` jev or haiku), else at `unknownUsd` (no answer: a crash, a failed append, a
 * failure that may still have been billed). All repos' ledgers, or `repo`'s, or its work orders `ids`.
 */
export async function decisionSpend(engineDir: string, o: { repo?: string; ids?: readonly string[]; from: Date; to: Date; unknownUsd: number }): Promise<number> {
  let usd = 0;
  for (const file of await ledgerFiles(engineDir, o.repo, o.ids)) {
    const lines = await readLedger(file);
    const answers = new Map<string, DecisionEntry>();
    for (const l of lines) if (l.kind === "answer" && l.call !== undefined) answers.set(l.call, l);
    for (const l of lines) {
      if (l.kind !== "asking") continue;
      const at = Date.parse(l.at);
      if (at < o.from.getTime() || at >= o.to.getTime()) continue;
      const a = answers.get(l.call);
      usd += a !== undefined && (a.via === "jev" || a.via === "haiku") ? a.cost_usd : o.unknownUsd;
    }
  }
  return usd;
}

/** The number of `asking` lines in a ledger: the calls made, answered or not. */
export const callsOf = (lines: readonly LedgerLine[]): number => lines.filter((l) => l.kind === "asking").length;

/**
 * Text a run or a worker controls, for one line of host Markdown: `\n` and `\t` to a space, no terminal control, no
 * `@ < > \``, at most `max` characters, in a code span, so no link, image, autolink, mention or issue reference renders.
 */
export function codeSpan(text: string, max = 200): string {
  const safe = sanitizeTerminal(text.replace(/[\r\n\t]/g, " ")).replace(/[@<>`]/g, "");
  const chars = Array.from(safe);
  const t = chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : safe;
  return `\`${t.trim() === "" ? "(empty)" : t}\``;
}

/** A path for display, built on the host: `codeSpan`, at most 120 characters. */
export const shownPath = (path: string): string => codeSpan(path, 120);

/** One subject a decision is asked about. `state` undefined: `unscreened` says why, and it is never asked. */
export interface Subject {
  decision: string;
  subject: string;
  part: string;
  state: State | undefined;
  unscreened?: string;
}

export interface DiffInput {
  /** The registry name each Subject carries. */
  decision: string;
  scratch: string;
  /** The merge commit: the same base as the PR's diff stat, so a fix round's harvest screens the whole change. */
  base: string;
  head: string;
  goal: string;
  /** Exact repo paths (case-sensitive, no globs) of lockfiles never screened, each only while it parses as one (`LOCKFILES`). */
  skip: readonly string[];
  maxChars: number;
  secrets: Record<string, string>;
}

/** The work order's goal: task.md's first paragraph that isn't a heading, at most 600 characters. */
export function goalOf(taskMd: string): string {
  const blocks = taskMd.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l) => l.trim() !== "" && !/^\s{0,3}#/.test(l));
    if (lines.length === 0) continue;
    const text = lines.map((l) => l.trim()).join("\n");
    const chars = Array.from(text);
    return chars.length > 600 ? `${chars.slice(0, 599).join("")}…` : text;
  }
  return "";
}

const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.trim().slice(0, 300) || "(no error output)";

/** Hardened git on the scratch, as the host gates run it. */
export function scratchGit(d: Pick<RunDeps, "run" | "env">, scratch: string, args: string[], pre: string[] = []) {
  const g = hardenedGit(d);
  return d.run([...g.cmd, "-c", `safe.directory=${scratch}`, "--git-dir", scratch, ...pre, ...args], { env: g.env, inherit: false });
}

async function mustGit(d: Pick<RunDeps, "run" | "env">, scratch: string, args: string[], pre: string[] = []): Promise<string> {
  const r = await scratchGit(d, scratch, args, pre);
  if (r.code !== 0) throw new Error(`cannot read the scratch's diff (git ${args[0]} exited ${r.code}): ${firstLine(r.stderr)}`);
  return r.stdout;
}

/** `diff --raw --numstat -z` parsed: each path's modes and status, and its added and deleted counts ("-" for content the diff doesn't show). */
function parseRawNumstat(out: string): Map<string, { oldMode?: string; newMode?: string; status?: string; added?: string; deleted?: string }> {
  const m = new Map<string, { oldMode?: string; newMode?: string; status?: string; added?: string; deleted?: string }>();
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "") continue;
    if (t.startsWith(":")) {
      const [oldMode = "", newMode = "", , , status = ""] = t.slice(1).split(" ");
      const path = tokens[++i] ?? "";
      m.set(path, { ...m.get(path), oldMode, newMode, status: status.slice(0, 1) });
      continue;
    }
    const a = t.indexOf("\t");
    const b = t.indexOf("\t", a + 1);
    if (a === -1 || b === -1) continue;
    const path = t.slice(b + 1);
    m.set(path, { ...m.get(path), added: t.slice(0, a), deleted: t.slice(a + 1, b) });
  }
  return m;
}

/** How many characters `text` adds to a JSON string (its escaped length). */
const escaped = (text: string): number => JSON.stringify(text).length - 2;

/**
 * Cut `diff` (its lines, each with its newline) into windows of whole lines, each prefixed by `header`, that keep the
 * state's length at or under `maxChars`: a hunk start (`@@`) begins a new window when the hunk fits there; a hunk too
 * long for one window is split by lines; a single line too long for any window is a window of its own.
 */
function windows(state: (part: string, diff: string) => State, header: string[], body: string[], maxChars: number): string[][] {
  const label = `part ${body.length} of ${body.length}`;
  const budget = maxChars - stateLength(state(label, "")) - escaped(header.map((l) => `${l}\n`).join(""));
  const cost = (l: string) => escaped(`${l}\n`);
  const hunks: string[][] = [];
  for (const l of body) {
    if (l.startsWith("@@") || hunks.length === 0) hunks.push([l]);
    else hunks.at(-1)!.push(l);
  }
  const out: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const hunk of hunks) {
    const hc = hunk.reduce((n, l) => n + cost(l), 0);
    if (used + hc <= budget) {
      cur.push(...hunk);
      used += hc;
      continue;
    }
    if (cur.length > 0 && hc <= budget) {
      out.push(cur);
      cur = [...hunk];
      used = hc;
      continue;
    }
    for (const l of hunk) {
      const lc = cost(l);
      if (cur.length > 0 && used + lc > budget) {
        out.push(cur);
        cur = [];
        used = 0;
      }
      cur.push(l);
      used += lc;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

const NOT_SHOWN = "content not shown in the diff";

/** The strings and keys a JSON value holds, counted with a stack (no recursion): what a lockfile's string tokens must equal. */
function stringsIn(root: unknown): number {
  let n = 0;
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") n++;
    else if (Array.isArray(v)) for (const x of v) stack.push(x);
    else if (v !== null && typeof v === "object") {
      for (const [, x] of Object.entries(v)) {
        n++;
        stack.push(x);
      }
    }
  }
  return n;
}

/** The deepest a Bun lockfile nests (it writes about 5 levels): anything deeper isn't one, and is never parsed. */
const MAX_LOCK_DEPTH = 16;

/**
 * Bun's text lockfile as JSON: trailing commas are dropped, and any comment (`//` or `/*` outside a string) makes it
 * not a lockfile at all, since text in a comment is text the screen would never see. Every character must be printable
 * ASCII or JSON's whitespace. A duplicate key (`JSON.parse` keeps the last, so the first could hold anything, escaped
 * or not) is caught by counting: the string tokens the scanner met must equal the keys and strings the parsed value
 * holds. Nesting deeper than MAX_LOCK_DEPTH is refused while scanning, before anything recurses. undefined when it
 * isn't such a JSON value, and on any error.
 */
function lockJson(text: string): unknown {
  try {
    return lockJsonUnsafe(text);
  } catch {
    return undefined;
  }
}

function lockJsonUnsafe(text: string): unknown {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) return undefined;
  let out = "";
  let tokens = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{" || c === "[") {
      if (++depth > MAX_LOCK_DEPTH) return undefined;
      out += c;
    } else if (c === "}" || c === "]") {
      depth--;
      out += c;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      tokens++;
      i = j;
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) return undefined;
    else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  let v: unknown;
  try {
    v = JSON.parse(out);
  } catch {
    return undefined;
  }
  return stringsIn(v) === tokens ? v : undefined;
}

// The grammar every string of a skipped bun.lock must fit (the controller's rulings, Task 12 fix rounds 1 and 2):
// names, resolutions, specs, registries, integrities, paths and platforms, each printable ASCII and at most 256
// characters, with at most 16 dist-tag specs in all. Free text with spaces fits none of them; what still fits is
// H-275's residual: hyphenated words as package names, up to 16 dist-tag specs of lower-case words joined by hyphens
// (each up to 32 characters), and words joined without spaces in a workspace, file, link or github path, a catalog
// name, an https or git+https URL, a registry URL, a prerelease tag or a bin path.
const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const NESTED_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*)*$/;
const PART = "(?:0|[1-9][0-9]*|x|X|\\*)";
const PRE = "(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const COMPARATOR = new RegExp(`^(?:\\^|~>?|>=|<=|>|<|=)?v?${PART}(?:\\.${PART}){0,2}${PRE}$`);
const VERSION = new RegExp(`^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)${PRE}$`);
const DIST_TAG = /^[a-z][a-z0-9-]{0,31}$/;
const WORKSPACE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const BIN_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const PLATFORM = /^!?[a-z0-9_]+$/;
const INTEGRITY = /^sha(512|384|256|1)-[A-Za-z0-9+/]+={0,2}$/;
const GIT_REF = /^[A-Za-z0-9._-]+-[0-9a-f]{7,64}$/;

const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 256 && /^[\x20-\x7e]*$/.test(v);
/** The most dist-tag specs (`latest`, `next`, a word) one lockfile may hold: each is a word the screen won't see. */
const MAX_DIST_TAGS = 16;
/** The dist-tag specs of the lockfile `isBunLock` is checking (reset at each call; the check is synchronous). */
let distTags = 0;
const isName = (v: unknown): v is string => isStr(v) && v.length <= 214 && NPM_NAME.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));

/** A semver range: comparators separated by spaces, `||` and ` - ` (hyphen ranges). */
function isRange(s: string): boolean {
  return s.split("||").every((part) => {
    const t = part.trim();
    if (t === "") return false;
    const hyphen = t.split(" - ");
    if (hyphen.length === 2) return hyphen.every((v) => COMPARATOR.test(v.trim()));
    return t.split(/\s+/).every((c) => COMPARATOR.test(c));
  });
}

/** A dependency spec: a range, a protocol with no whitespace, or a dist-tag. */
function isSpec(v: unknown): boolean {
  if (!isStr(v)) return false;
  if (isRange(v)) return true;
  if (DIST_TAG.test(v)) return ++distTags <= MAX_DIST_TAGS;
  if (v.startsWith("npm:")) {
    const rest = v.slice(4);
    const at = rest.lastIndexOf("@");
    return at > 0 ? isName(rest.slice(0, at)) && isSpec(rest.slice(at + 1)) : isName(rest);
  }
  if (/^catalog:[a-z0-9._-]*$/.test(v)) return true;
  if (/^workspace:/.test(v)) return /^workspace:(?:[*^~]|[A-Za-z0-9._/-]+)$/.test(v) || isRange(v.slice("workspace:".length));
  if (/^(file|link):[A-Za-z0-9._~/@+-]+$/.test(v)) return true;
  if (/^github:[A-Za-z0-9._/#-]+$/.test(v)) return true;
  return /^(git\+https|https):\/\/[\x21-\x7e]+$/.test(v);
}

/** `<name>@<spec>`, the name possibly scoped. */
function isResolution(v: unknown): boolean {
  if (!isStr(v)) return false;
  const at = v.lastIndexOf("@");
  return at > 0 && isName(v.slice(0, at)) && isSpec(v.slice(at + 1));
}

const isDeps = (v: unknown) => isObj(v) && Object.entries(v).every(([k, x]) => isName(k) && isSpec(x));
const isNames = (v: unknown) => Array.isArray(v) && v.every(isName);
const isBin = (v: unknown) => (isStr(v) && BIN_PATH.test(v)) || (isObj(v) && Object.entries(v).every(([k, x]) => isStr(k) && /^[A-Za-z0-9._-]{1,214}$/.test(k) && isStr(x) && BIN_PATH.test(x)));
const isPlatform = (v: unknown) => (isStr(v) && PLATFORM.test(v)) || (Array.isArray(v) && v.every((x) => isStr(x) && PLATFORM.test(x)));
const DEP_KEYS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

function isWorkspace(v: unknown): boolean {
  if (!isObj(v) || !onlyKeys(v, ["name", "version", ...DEP_KEYS, "optionalPeers", "bin"])) return false;
  if (v.name !== undefined && !isName(v.name)) return false;
  if (v.version !== undefined && !(isStr(v.version) && VERSION.test(v.version))) return false;
  if (DEP_KEYS.some((k) => v[k] !== undefined && !isDeps(v[k]))) return false;
  if (v.optionalPeers !== undefined && !isNames(v.optionalPeers)) return false;
  return v.bin === undefined || isBin(v.bin);
}

function isMeta(v: unknown): boolean {
  if (!isObj(v) || !onlyKeys(v, [...DEP_KEYS, "optionalPeers", "bin", "binDir", "os", "cpu", "libc"])) return false;
  if (DEP_KEYS.some((k) => v[k] !== undefined && !isDeps(v[k]))) return false;
  if (v.optionalPeers !== undefined && !isNames(v.optionalPeers)) return false;
  if (v.bin !== undefined && !isBin(v.bin)) return false;
  if (v.binDir !== undefined && !(isStr(v.binDir) && BIN_PATH.test(v.binDir))) return false;
  return ["os", "cpu", "libc"].every((k) => v[k] === undefined || isPlatform(v[k]));
}

/** One `packages` entry: npm `[resolution, registry, meta, integrity]`, workspace `[resolution]`, git `[resolution, meta, "<owner>-<repo>-<sha>"]`, file, link or tarball `[resolution, meta]`. */
function isPackage(v: unknown): boolean {
  if (!Array.isArray(v) || !isResolution(v[0])) return false;
  if (v.length === 1) return true;
  if (v.length === 2) return isMeta(v[1]);
  if (v.length === 3) return isMeta(v[1]) && isStr(v[2]) && GIT_REF.test(v[2]);
  if (v.length === 4) return isStr(v[1]) && (v[1] === "" || /^https:\/\/[\x21-\x7e]+$/.test(v[1])) && isMeta(v[2]) && isStr(v[3]) && INTEGRITY.test(v[3]);
  return false;
}

/**
 * Whether `text` is Bun's text lockfile, checked structurally: JSON with trailing commas but no comment; the top-level
 * keys `lockfileVersion` (0 to 2), `workspaces` and `packages`, and optionally `configVersion` (0 or 1),
 * `trustedDependencies`, `patchedDependencies`, `overrides`, `catalog` and `catalogs`; each value in the shape Bun
 * writes; every string a name, resolution, spec, registry, integrity, path or platform, printable ASCII, of at most
 * 256 characters; no duplicate key; no nesting deeper than 16; and at most 16 dist-tag specs. Anything else, and any
 * error while checking, is not a lockfile, so the file is unscreened and holds.
 */
export function isBunLock(text: string): boolean {
  try {
    return isBunLockUnsafe(text);
  } catch {
    return false;
  }
}

function isBunLockUnsafe(text: string): boolean {
  distTags = 0;
  const v = lockJson(text);
  if (!isObj(v) || !onlyKeys(v, ["lockfileVersion", "configVersion", "workspaces", "packages", "trustedDependencies", "patchedDependencies", "overrides", "catalog", "catalogs"])) return false;
  if (!Number.isInteger(v.lockfileVersion) || (v.lockfileVersion as number) < 0 || (v.lockfileVersion as number) > 2) return false;
  if (v.configVersion !== undefined && v.configVersion !== 0 && v.configVersion !== 1) return false;
  if (!isObj(v.workspaces) || !Object.entries(v.workspaces).every(([k, w]) => (k === "" || (isStr(k) && WORKSPACE_PATH.test(k))) && isWorkspace(w))) return false;
  if (!isObj(v.packages) || !Object.entries(v.packages).every(([k, p]) => isStr(k) && NESTED_NAME.test(k) && isPackage(p))) return false;
  if (v.trustedDependencies !== undefined && !isNames(v.trustedDependencies)) return false;
  if (v.patchedDependencies !== undefined && !(isObj(v.patchedDependencies) && Object.entries(v.patchedDependencies).every(([k, x]) => (isName(k) || isResolution(k)) && isStr(x) && BIN_PATH.test(x)))) return false;
  if (v.overrides !== undefined && !isDeps(v.overrides)) return false;
  if (v.catalog !== undefined && !isDeps(v.catalog)) return false;
  return v.catalogs === undefined || (isObj(v.catalogs) && Object.entries(v.catalogs).every(([k, c]) => /^[a-z0-9._-]{1,64}$/.test(k) && isDeps(c)));
}

/** The lockfiles a `skip_paths` entry may name, by file name, and the check its content at the head must pass to be skipped. */
export const LOCKFILES: Readonly<Record<string, (text: string) => boolean>> = Object.freeze({ "bun.lock": isBunLock });

/**
 * The `"diff"` subjects of `o.decision`: each file of `diff --name-only -z --no-renames <base> <head>` that matches
 * no `o.skip` glob, ordered by path, then part. The state is `{ goal, path, part, diff }`, every string redacted
 * (`redactSecretForms`, with `o.secrets`) before the diff is cut into windows; content the diff doesn't show (a
 * binary, a `-diff` attribute from the scratch's HEAD tree, a gitlink) is a subject with no state.
 */
export async function diffSubjects(d: Pick<RunDeps, "run" | "env">, o: DiffInput): Promise<Subject[]> {
  const names = (await mustGit(d, o.scratch, ["diff", "--name-only", "-z", "--no-renames", o.base, o.head])).split("\0").filter((p) => p !== "");
  const stat = parseRawNumstat(await mustGit(d, o.scratch, ["diff", "--raw", "--numstat", "-z", "--no-renames", o.base, o.head]));
  const redact = (t: string) => redactSecretForms(t, o.secrets);
  const goal = redact(o.goal);
  const out: Subject[] = [];
  for (const path of [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const shown = redact(path);
    const s = stat.get(path);
    const subject = (part: string, state: State | undefined, unscreened?: string): Subject => ({ decision: o.decision, subject: shown, part, state, ...(unscreened === undefined ? {} : { unscreened }) });
    if (o.skip.includes(path)) {
      // A deletion adds nothing to read; otherwise the file must be the lockfile its name says, or it is unscreened.
      if (s?.status === "D") continue;
      const check = LOCKFILES[basename(path)];
      if (check === undefined) {
        out.push(subject("whole", undefined, "skip_paths names it, but the engine has no check that it is a lockfile"));
        continue;
      }
      const blob = await scratchGit(d, o.scratch, ["cat-file", "blob", `${o.head}:${path}`]);
      if (blob.code === 0 && check(blob.stdout)) continue;
      out.push(subject("whole", undefined, `skip_paths names it as a lockfile, but it doesn't parse as ${basename(path)}`));
      continue;
    }
    if (s?.oldMode === "160000" || s?.newMode === "160000" || s?.added === "-" || s?.deleted === "-") {
      out.push(subject("whole", undefined, NOT_SHOWN));
      continue;
    }
    const text = redact(await mustGit(d, o.scratch, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", o.base, o.head, "--", path], ["--literal-pathspecs"]));
    const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    const at = lines.findIndex((l) => l.startsWith("@@"));
    const header = at === -1 ? lines : lines.slice(0, at);
    const body = at === -1 ? [] : lines.slice(at);
    const state = (part: string, diff: string): State => ({ goal, path: shown, part, diff });
    if (s?.status === "D") {
      out.push(subject("deleted", state("deleted", `${header.join("\n")}\n(this change deletes the file: ${s.deleted ?? "?"} lines)\n`)));
      continue;
    }
    if (stateLength(state("whole", text)) <= o.maxChars) {
      out.push(subject("whole", state("whole", text)));
      continue;
    }
    const parts = windows(state, header, body, o.maxChars);
    parts.forEach((w, i) => {
      const part = `part ${i + 1} of ${parts.length}`;
      out.push(subject(part, state(part, `${[...header, ...w].join("\n")}\n`)));
    });
  }
  return out;
}

/** One decision's result for a head, for the PR's Evidence row and its reasons. See the module comment. */
export interface Screened {
  decision: string;
  version: string;
  /** gates.decisions.mode. off: nothing asked, subjects 0; notes: an enforce decision's holds are listed under notes, and its holds is []. */
  models: DecisionModels;
  mode: DecisionMode;
  /** The changed files it had subjects for. */
  subjects: number;
  /** Subjects answered by a call for this head (in this harvest or an earlier one of the same head). */
  asked: number;
  /** Subjects answered by a call recorded for an earlier head, reused by content. */
  reused: number;
  /** Subjects no classifier answered. */
  unscreened: number;
  via: Partial<Record<"jev" | "haiku" | "default", number>>;
  /** Lines for Unresolved (enforce), or for the Evidence row's count (shadow: what it would hold). */
  holds: string[];
  /** Lines for Check this yourself. */
  notes: string[];
  /**
   * D73 (the hold-fatigue ruling): the files `holds` holds for want of an answer, by cause (`call cap 24`, `no
   * classifier answered`, …), and the files it holds for what an answer found (`shownPath`s); in enforce only, as
   * `holds` holds only then. The PR's verdict line names both apart (./pr.ts).
   */
  coverage?: { cause: string; files: number }[];
  held?: string[];
  /** What the calls for this head cost. */
  usd: number;
  /** false: the head was not pushed, so nothing was screened. */
  pushed: boolean;
}

const knobOf = (p: Policy, name: string): EngineDecision => {
  const k = p.decisions.by_name[name];
  if (k === undefined) throw new Error(`policy/gates.yaml has no decisions.by_name.${name}: the schema requires one per engine decision`);
  return k;
};

/** Each registry decision's Screened when nothing was screened: `pushed` false for a head the harvest didn't push, or decision models off. */
export function emptyScreens(p: Policy, pushed: boolean): Screened[] {
  return Object.keys(ENGINE_DECISIONS).map((name) => ({
    decision: name,
    version: decisionVersion(name),
    models: p.decisions.mode,
    mode: knobOf(p, name).mode,
    subjects: 0,
    asked: 0,
    reused: 0,
    unscreened: 0,
    via: {},
    holds: [],
    notes: [],
    usd: 0,
    pushed,
  }));
}

/** The answers, in the file's question order, to two decimals. */
function answersText(file: EngineDecisionFile, answers: Record<string, RecordedAnswer> | undefined): string {
  return Object.keys(file.questions)
    .map((id) => {
      const a = answers?.[id];
      if (a === undefined) return `${id} ?`;
      if (a.type === "noul") return `${id} ${a.noul.toFixed(2)}`;
      if (a.type === "choice") return `${id} ${sanitizeTerminal(a.choice).replace(/[^A-Za-z0-9_-]/g, "")} ${(a.probabilities[a.choice] ?? 0).toFixed(2)}`;
      return `${id} ${a.score.toFixed(2)}`;
    })
    .join(", ");
}

const partText = (part: string) => (part === "whole" ? "" : ` (${part})`);
const clip = (t: string, n: number) => {
  const safe = sanitizeTerminal(t.replace(/[\n\t]/g, " ")).replace(/[@<>`]/g, "");
  const chars = Array.from(safe);
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : safe;
};

const keyOf = (name: string, version: string, state: unknown) => createHash("sha256").update(`${name}\0${version}\0${JSON.stringify(state)}`).digest("hex");

/** One subject as screenHarvest settled it. */
interface Settled {
  subject: Subject;
  key: string;
  chars: number;
  /** The classifier's answer: reused from the ledger, or from this harvest's call. */
  answer?: { via: "jev" | "haiku"; verdict: EngineVerdict; answers?: Record<string, RecordedAnswer>; head: string; cost: number };
  /** Why no classifier answered. */
  why?: string;
  truncated?: true;
  call?: string;
  result?: DecideResult<EngineVerdict>;
}

/**
 * Screen a head (see the module comment) and return every registry decision's `Screened`. `ask: false` reuses only,
 * asking and appending nothing; `decisions.mode: off` reads, asks and appends nothing. Every line is appended before
 * it returns: the `asking` lines before any call (a failed append throws, and nothing is asked).
 */
export async function screenHarvest(
  d: ScreenDeps,
  o: { s: WorkOrderState; run: RunRecord; head: string; subjects: Subject[]; policy: Policy; ask: boolean },
): Promise<Screened[]> {
  const p = o.policy;
  const models = p.decisions.mode;
  if (models === "off") return emptyScreens(p, true);
  const file = ledgerPath(d.engineDir, d.repo, o.s.id);
  const ledger = await readLedger(file);
  const max = p.gates.max_state_chars;
  const cap = p.decisions.max_calls_per_head;
  const answered = new Map<string, DecisionEntry>();
  for (const l of ledger) if (l.kind === "answer" && (l.via === "jev" || l.via === "haiku")) answered.set(l.key, l);
  // Final review M3: a re-render (ask: false) gives a subject no classifier answered the why its newest via-default
  // line recorded, as the harvest worded it, so one file never shows two contradictory coverage holds.
  const unanswered = new Map<string, string>();
  for (const l of ledger) {
    if (l.kind !== "answer" || l.via !== "default") continue;
    unanswered.set(l.key, l.call !== undefined ? `no classifier answered: ${clip(l.error ?? "no classifier gave a reason", 200)}` : (l.error ?? NOT_SHOWN));
  }
  let left = cap - ledger.filter((l) => l.kind === "asking" && l.head === o.head).length;
  const at = () => d.run.now().toISOString();
  const base = (name: string, version: string, x: Settled) => ({
    at: at(),
    repo: d.repo,
    workOrder: o.s.id,
    retry: o.s.retry,
    run: o.run.runId,
    head: o.head,
    decision: name,
    version,
    subject: x.subject.subject,
    part: x.subject.part,
    key: x.key,
    public: d.public,
  });

  const byName = new Map<string, Settled[]>();
  for (const name of Object.keys(ENGINE_DECISIONS)) {
    if (knobOf(p, name).mode === "off") continue;
    const version = decisionVersion(name);
    const mine = o.subjects
      .filter((x) => x.decision === name)
      .sort((a, b) => (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
    const settled: Settled[] = mine.map((subject) => {
      const state = subject.state;
      const key = keyOf(name, version, state ?? { subject: subject.subject, part: subject.part, unscreened: subject.unscreened ?? NOT_SHOWN });
      if (state === undefined) return { subject, key, chars: 0, why: subject.unscreened ?? NOT_SHOWN };
      const chars = stateLength(state);
      const reuse = answered.get(key);
      if (reuse !== undefined && (reuse.via === "jev" || reuse.via === "haiku")) {
        return { subject, key, chars, answer: { via: reuse.via, verdict: reuse.verdict, ...(reuse.answers ? { answers: reuse.answers } : {}), head: reuse.head, cost: reuse.cost_usd } };
      }
      if (chars > max) return { subject, key, chars, why: `over gates.max_state_chars (${max})`, truncated: true };
      if (!o.ask) return { subject, key, chars, why: unanswered.get(key) ?? "not asked: a re-render asks nothing" };
      if (left <= 0) return { subject, key, chars, why: `not asked: over gates.decisions.max_calls_per_head (${cap})` };
      left--;
      return { subject, key, chars, call: randomBytes(6).toString("hex") };
    });
    byName.set(name, settled);
  }

  // Each call is written before it is made; an append that fails throws before any call.
  const toAsk = [...byName].flatMap(([name, xs]) => xs.filter((x) => x.call !== undefined).map((x) => ({ name, x })));
  if (toAsk.length > 0) {
    await appendLedger(
      file,
      toAsk.map(({ name, x }): AskingLine => ({ kind: "asking", ...base(name, decisionVersion(name), x), call: x.call! })),
    );
    const opts = engineDecideOptions(p, d.public, await d.decideKeys());
    await Promise.all(
      toAsk.map(async ({ name, x }) => {
        const f = ENGINE_DECISIONS[name]!.file;
        try {
          x.result = await d.decide(f, x.subject.state!, opts);
        } catch {
          x.result = { verdict: f.fallback, via: "default", fallback: true, costUsd: 0, latencyMs: 0, error: "decide failed" };
        }
        const r = x.result;
        if (r.via === "jev" || r.via === "haiku") {
          const answers = recordedAnswers(r.answers);
          x.answer = { via: r.via, verdict: r.verdict, ...(answers ? { answers } : {}), head: o.head, cost: r.costUsd };
        } else x.why = `no classifier answered: ${clip(r.error ?? "no classifier gave a reason", 200)}`;
      }),
    );
  }

  // Every answer is saved before it is used; a re-render (ask: false) appends nothing.
  if (o.ask) {
    const lines: DecisionEntry[] = [];
    for (const [name, xs] of byName) {
      const knob = knobOf(p, name);
      const f = ENGINE_DECISIONS[name]!.file;
      const version = decisionVersion(name);
      for (const x of xs) {
        if (x.call === undefined && x.answer !== undefined) continue; // reused: no new line
        const r = x.result;
        const via = x.answer?.via ?? "default";
        const verdict = x.answer?.verdict ?? f.fallback;
        const answers = x.answer?.answers;
        const model = via === "jev" ? p.gates.classifiers.jev.model : via === "haiku" ? p.gates.classifiers.haiku.model : undefined;
        lines.push({
          kind: "answer",
          ...base(name, version, x),
          ...(x.call === undefined ? {} : { call: x.call }),
          state_chars: x.chars,
          models,
          mode: knob.mode as "shadow" | "enforce",
          via,
          fallback: r?.fallback ?? true,
          ...(model === undefined ? {} : { model }),
          latency_ms: r?.latencyMs ?? 0,
          cost_usd: r?.costUsd ?? 0,
          ...(answers === undefined ? {} : { answers }),
          verdict,
          effect: effectOf(models, knob, via, verdict),
          ...(x.truncated ? { truncated: true as const } : {}),
          ...(x.call === undefined ? { error: x.why ?? NOT_SHOWN } : r?.error === undefined ? {} : { error: r.error }),
        });
      }
    }
    if (lines.length > 0) await appendLedger(file, lines);
  }

  return Object.keys(ENGINE_DECISIONS).map((name) => {
    const knob = knobOf(p, name);
    const xs = byName.get(name);
    if (xs === undefined) return emptyScreens(p, true).find((s) => s.decision === name)!;
    return screened(name, knob, models, o.head, xs);
  });
}

/** What the engine does with a verdict: none in shadow; on_unscreened for a subject no classifier answered; then, in notes mode, a hold is a note. */
function effectOf(models: DecisionModels, knob: EngineDecision, via: "jev" | "haiku" | "default", verdict: EngineVerdict): EngineVerdict | "none" {
  if (knob.mode === "shadow") return "none";
  const v = via === "default" ? knob.on_unscreened : verdict;
  return models === "notes" && v === "hold" ? "note" : v;
}

/** At most 10 lines, then `… and <n> more (decide <name>)`. */
const capped = (lines: string[], name: string) => (lines.length <= 10 ? lines : [...lines.slice(0, 10), `… and ${lines.length - 10} more (decide ${name})`]);

function screened(name: string, knob: EngineDecision, models: DecisionModels, head: string, xs: Settled[]): Screened {
  const f = ENGINE_DECISIONS[name]!.file;
  const via: Screened["via"] = {};
  let asked = 0;
  let reused = 0;
  let unscreened = 0;
  let usd = 0;
  // One line per file: its first hold (or would-be hold), else its first note; a hold is for want of an answer
  // (coverage, with its cause) or for what an answer found (finding).
  type Line = { rank: number; text: string; notesText: string; path: string; cause?: string };
  const best = new Map<string, Line>();
  for (const x of xs) {
    const v = x.answer?.via ?? "default";
    via[v] = (via[v] ?? 0) + 1;
    if (x.answer === undefined) unscreened++;
    else if (x.answer.head === head) {
      asked++;
      usd += x.answer.cost;
    } else reused++;
    const path = shownPath(x.subject.subject);
    const p = `${path}${partText(x.subject.part)}`;
    let line: Line | undefined;
    if (x.answer === undefined) {
      const why = x.why ?? NOT_SHOWN;
      line = {
        rank: knob.on_unscreened === "hold" ? 2 : 1,
        text: `${p}: not screened (${why}) (gates.decisions.by_name.${name}.on_unscreened: ${knob.on_unscreened})`,
        notesText: `${p}: not screened (${why}) (gates.decisions.mode: notes)`,
        path,
        cause: causeOf(why),
      };
    } else {
      const nums = `(decide ${name}: ${answersText(f, x.answer.answers)}, via ${x.answer.via})`;
      if (x.answer.verdict === "hold") {
        line = { rank: 2, text: `${p}: ${f.says.hold} ${nums}`, notesText: `${p}: ${f.says.hold} ${nums}: check it yourself (gates.decisions.mode: notes)`, path };
      } else if (x.answer.verdict === "note") {
        const text = `${p}: ${f.says.note} ${nums}: check it yourself`;
        line = { rank: 1, text, notesText: text, path };
      }
    }
    if (line === undefined) continue;
    const prev = best.get(x.subject.subject);
    if (prev === undefined || line.rank > prev.rank) best.set(x.subject.subject, line);
  }
  const lines = [...best.values()];
  let holds: string[] = [];
  let notes: string[] = [];
  const coverage: { cause: string; files: number }[] = [];
  let held: string[] = [];
  if (knob.mode === "shadow") holds = lines.filter((l) => l.rank === 2).map((l) => l.text);
  else if (models === "notes") notes = lines.map((l) => l.notesText);
  else {
    holds = lines.filter((l) => l.rank === 2).map((l) => l.text);
    notes = lines.filter((l) => l.rank === 1).map((l) => l.text);
    for (const l of lines.filter((x) => x.rank === 2)) {
      if (l.cause === undefined) continue;
      const c = coverage.find((x) => x.cause === l.cause);
      if (c === undefined) coverage.push({ cause: l.cause, files: 1 });
      else c.files++;
    }
    held = lines.filter((l) => l.rank === 2 && l.cause === undefined).map((l) => l.path);
  }
  return {
    decision: name,
    version: decisionVersion(name),
    models,
    mode: knob.mode,
    subjects: new Set(xs.map((x) => x.subject.subject)).size,
    asked,
    reused,
    unscreened,
    via,
    holds: capped(holds, name),
    notes: capped(notes, name),
    coverage,
    held,
    usd,
    pushed: true,
  };
}

/** A coverage hold's cause, short, for the verdict line: `call cap <n>`, `no classifier answered`, or the why itself. */
function causeOf(why: string): string {
  if (why.startsWith("no classifier answered")) return "no classifier answered";
  const cap = /^not asked: over gates\.decisions\.max_calls_per_head \((\d+)\)$/.exec(why);
  return cap ? `call cap ${cap[1]}` : why;
}

/** What screenHarvest needs: the harvester's deps (./harvest.ts `HarvestDeps`) narrowed. */
export interface ScreenDeps {
  run: Pick<RunDeps, "now">;
  engineDir: string;
  /** `<owner>/<name>`. */
  repo: string;
  /** The forge's visibility: Jev is asked only when true. */
  public: boolean;
  /** Production: `ask` (src/decide/record.ts); tests: `fakeDecide`. */
  decide: typeof ask;
  /** The archon zone's two classifier keys, read in-process, never in an env; called once, and only when a call is needed. */
  decideKeys(): Promise<{ jev: string | undefined; anthropic: string | undefined }>;
}
