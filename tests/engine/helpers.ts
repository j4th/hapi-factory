/**
 * Test helpers for tests/engine: a real git work repo in a temp dir, work orders added to it, planning merges in
 * GitHub's classic message, and a way to update a mirror from it. Git here runs with no system or global config
 * (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`) and HOME set to the work dir, so nothing reads the real
 * ~/.gitconfig or ~/.config, and nothing touches the network: a mirror fetches from the work dir's path.
 */
import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { Answers, DecideOptions, DecideResult, DecisionFile, State } from "../../src/decide/index";
import type { ask } from "../../src/decide/record";
import type { Discovered } from "../../src/engine/discover";
import type { ReviewFinding } from "../../src/engine/evidence";
import type { Evidence, PushOptions, PushResult } from "../../src/engine/harvest";
import { mirrorPath } from "../../src/engine/mirror";
import { githubForge } from "../../src/forge";
import { loadPolicy } from "../../src/policy/load";
import type { DecisionModels, EngineDecision, Policy } from "../../src/policy/types";
import type { RunDeps } from "../../src/run/spec";
import { runCommand } from "../../src/stack/up";
import { validateWorkOrder } from "../../src/workorder/validate";
import { fakeForge } from "../forge/helpers";
import { writeOrder } from "../run/helpers";
import { tempDir } from "../secrets/helpers";

/** git in one work dir, which returns stdout, trimmed; `dir` is that work dir. A non-zero exit fails the test, naming the command. */
export type Git = ((...args: string[]) => string) & { dir: string };

/** A fresh work repo at `dir` (which must exist), on `main`, with one empty commit. */
export function workRepo(dir: string): Git {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect([args.join(" "), r.exitCode, r.stderr.toString()]).toEqual([args.join(" "), 0, expect.any(String)]);
    return r.stdout.toString().trim();
  };
  const g = Object.assign(git, { dir });
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "base");
  return g;
}

/**
 * Write `.factory/work/<id>/order.yaml` (`writeOrder`'s YAML with `id`, then `over`, applied) and
 * `.factory/work/<id>/task.md` (`# <id>\n`), and stage both. Returns the order's path in the work dir.
 */
export function addOrder(git: Git, id: string, over: Record<string, unknown> = {}): string {
  const dir = join(git.dir, ".factory", "work", id);
  mkdirSync(dir, { recursive: true });
  const order = writeOrder(dir, { id, ...over }, "order.yaml");
  writeFileSync(join(dir, "task.md"), `# ${id}\n`);
  git("add", "--", join(".factory", "work", id, "order.yaml"), join(".factory", "work", id, "task.md"));
  return order;
}

/** Merge `branch` into main as GitHub's merge button does, with its classic message; returns the merge's sha. */
export function mergePlanning(git: Git, branch: string, pr: number): string {
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from example-owner/${branch}`, branch);
  return git("rev-parse", "HEAD");
}

/**
 * Update `mirror`'s main from the work dir's. A fetch into the mirror, not a push: `--shared` sets
 * `receive.denyNonFastforwards`, which refuses even a forced push. `force` lets main move other than forward,
 * as the poller's own fetch (`+refs/heads/main:refs/heads/main`) does.
 */
export function toMirror(git: Git, mirror: string, force = false): void {
  git("--git-dir", mirror, "fetch", "--quiet", git.dir, `${force ? "+" : ""}refs/heads/main:refs/heads/main`);
}

// ---------------------------------------------------------------------------------------------------------------
// Plan 03 Task 12: the harvester's and the engine decisions' helpers.
// ---------------------------------------------------------------------------------------------------------------

/** The sandbox's first work order, as discovery returns it; `mergeSha` is a placeholder until a test sets the real one (`orderAt`). */
export const ORDER: Discovered = (() => {
  const tmp = mkdtempSync(join(tmpdir(), "hapi-order-"));
  try {
    const file = writeOrder(tmp, {
      id: "0001-skeleton",
      lane: "factory",
      workflow: "factory-task",
      verify: { smoke: true },
      pieces: [
        { id: "server", files: ["src/**"], size: "small" },
        { id: "tests", files: ["tests/**"], size: "small" },
      ],
    });
    return {
      repo: "example-owner/sandbox",
      id: "0001-skeleton",
      mergeSha: "0".repeat(40),
      workOrder: validateWorkOrder(YAML.parse(readFileSync(file, "utf8"))),
      taskMd: "# Skeleton and crack_cookie\n\nA fortune-cookie MCP server with a health tool.\n",
      overlay: undefined,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
})();

/** ORDER keyed at `mergeSha`. */
export const orderAt = (mergeSha: string, over: Partial<Discovered> = {}): Discovered => ({ ...ORDER, mergeSha, ...over });

/** The trace id of ORDER's traceparent: what a run's commits carry as `Trace-Id`. */
export const TRACE_ID = ORDER.workOrder.trace.traceparent.split("-")[1]!;

/** The trailers factory-task's commit node writes, for run `runId`. */
export const trailersFor = (runId: string) => [`Work-Order: ${ORDER.id}`, `Hapi-Run: ${runId}`, "Hapi-Lane: factory", `Trace-Id: ${TRACE_ID}`, "Agent: pi@1.3.0", "Model: claude-sonnet-5-5"];

export interface GitWorld {
  tmp: string;
  engineDir: string;
  /** `mirrorPath(engineDir, ORDER.repo)`: a bare mirror whose `main` holds README.md. */
  mirror: string;
  /** main's commit (the merge a work order is keyed at). */
  base: string;
  /** A clone of the mirror on a detached HEAD at main; returns stdout, trimmed. */
  work: Git;
  /**
   * Write `files` in the work clone (a string or bytes; null deletes), stage them and commit, with `trailersFor(runId)`
   * unless `trailers` says otherwise; `empty` allows a commit that changes nothing. Returns the commit.
   */
  commit(files: Record<string, string | Uint8Array | null>, o?: { runId?: string; trailers?: string[]; message?: string; empty?: boolean; gitlink?: Record<string, string> }): string;
  /** `git bundle create <tmp>/<name> <base>..HEAD`, as run.sh makes run.bundle; returns its path. */
  bundle(o?: { from?: string; name?: string; extraRef?: string }): string;
  /** Commit `files` on main and move the mirror's main there (a merged change); returns the new main. The work clone follows it. */
  onMain(files: Record<string, string>): string;
  /** A bare scratch: the mirror cloned, plus the work clone's HEAD as refs/hapi/test; returns its path. */
  scratch(): string;
}

/** The work runner: real git, no system or global config, HOME the temp dir. */
function gitIn(dir: string, home: string): Git {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect([args.join(" "), r.exitCode, r.stderr.toString()]).toEqual([args.join(" "), 0, expect.any(String)]);
    return r.stdout.toString().trim();
  };
  return Object.assign(git, { dir });
}

/** A mirror at `mirrorPath(<tmp>/engine, ORDER.repo)` whose main holds README.md, and a work clone at main, detached. */
export function gitWorld(): GitWorld {
  const tmp = tempDir("hapi-harvest-");
  const engineDir = join(tmp, "engine");
  const origin = join(tmp, "origin");
  mkdirSync(origin);
  const o = gitIn(origin, tmp);
  o("init", "-q", "-b", "main");
  writeFileSync(join(origin, "README.md"), "# sandbox\n");
  o("add", "README.md");
  o("commit", "-q", "-m", "base");
  const mirror = mirrorPath(engineDir, ORDER.repo);
  mkdirSync(dirname(mirror), { recursive: true, mode: 0o700 });
  o("init", "-q", "--bare", "--shared=0644", "--initial-branch=main", mirror);
  o("--git-dir", mirror, "fetch", "-q", origin, "refs/heads/main:refs/heads/main");
  const workDir = join(tmp, "work");
  o("clone", "-q", mirror, workDir);
  const work = gitIn(workDir, tmp);
  work("checkout", "-q", "--detach", "main");
  const w: GitWorld = {
    tmp,
    engineDir,
    mirror,
    base: work("rev-parse", "HEAD"),
    work,
    commit(files, c = {}) {
      for (const [path, content] of Object.entries(files)) {
        const at = join(workDir, path);
        if (content === null) {
          work("rm", "-q", "--", path);
          continue;
        }
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, content);
        work("add", "--", path);
      }
      for (const [path, sha] of Object.entries(c.gitlink ?? {})) work("update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
      const trailers = (c.trailers ?? trailersFor(c.runId ?? "ab12cd34ef56")).flatMap((t) => ["--trailer", t]);
      work("commit", "-q", ...(c.empty ? ["--allow-empty"] : []), "-m", c.message ?? `${ORDER.id}: server`, ...trailers);
      return work("rev-parse", "HEAD");
    },
    bundle(b = {}) {
      const file = join(tmp, b.name ?? "run.bundle");
      if (b.extraRef !== undefined) work("branch", "-f", b.extraRef, "HEAD");
      work("bundle", "create", "-q", file, `${b.from ?? w.base}..HEAD`, ...(b.extraRef === undefined ? [] : [b.extraRef]));
      return file;
    },
    onMain(files) {
      const head = work("rev-parse", "HEAD");
      work("checkout", "-q", "--detach", w.base);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(workDir, path)), { recursive: true });
        writeFileSync(join(workDir, path), content);
        work("add", "--", path);
      }
      work("commit", "-q", "-m", "a merged change");
      const main = work("rev-parse", "HEAD");
      o("--git-dir", mirror, "fetch", "-q", workDir, `${main}:refs/heads/main`);
      w.base = main;
      if (head !== w.base) work("checkout", "-q", "--detach", main);
      return main;
    },
    scratch() {
      const scratch = join(tmp, `scratch-${Math.random().toString(16).slice(2)}.git`);
      o("clone", "-q", "--bare", "--no-hardlinks", mirror, scratch);
      o("--git-dir", scratch, "fetch", "-q", workDir, "HEAD:refs/hapi/test");
      return scratch;
    },
  };
  return w;
}

/** Real git for the code under test: hardened, as the harvester runs it. */
export const realGit = (): Pick<RunDeps, "run" | "env"> => ({ run: runCommand, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });

/** A noul answer per question id. */
export type FakeAnswers = Record<string, Partial<Record<string, number>> | "fail">;

/** diff-screen's answers that hold (reviewer_steer 0.81), and that note (stand_in 0.6). */
export const HOLD = { reviewer_steer: 0.81, loosened_check: 0.1, stand_in: 0.05, beyond_goal: 0.2 };
export const NOTE = { reviewer_steer: 0.1, loosened_check: 0.1, stand_in: 0.6, beyond_goal: 0.2 };

/**
 * The contract's mock of `decide()` (`HarvestDeps.decide`): for each subject's `path` (or `<path> (<part>)`) canned
 * noul answers, or "fail" (a default result with an error line); every other question, and every other subject, is
 * 0.05, which passes. It applies the file's own verdict(), so the thresholds are tested where they live, and records
 * each call's (name, state, options).
 */
export function fakeDecide(answers: FakeAnswers = {}, o: { via?: "jev" | "haiku"; costUsd?: number; error?: string } = {}) {
  const calls: { name: string; state: State; options: DecideOptions }[] = [];
  const decide = async <V extends string>(file: DecisionFile<V>, state: State, options: DecideOptions): Promise<DecideResult<V>> => {
    calls.push({ name: file.name, state, options });
    const s = state as { path?: string; part?: string };
    const a = answers[`${s.path} (${s.part})`] ?? answers[s.path ?? ""];
    if (a === "fail") return { verdict: file.fallback, via: "default", fallback: true, costUsd: 0, latencyMs: 0, error: o.error ?? "jev: openrouter HTTP 503.; haiku: HaikuError" };
    const typed: Answers = Object.fromEntries(Object.keys(file.questions).map((id) => [id, { type: "noul" as const, noul: a?.[id] ?? 0.05 }]));
    return { verdict: file.verdict(typed), via: o.via ?? "jev", fallback: false, costUsd: o.costUsd ?? 0.00002, latencyMs: 1, answers: typed };
  };
  return Object.assign(decide as typeof ask, { calls });
}

/** The shipped policy with `decisions` changed: `mode` and `max_calls_per_head` of the block, and `diff` over diff-screen's knobs. */
export function policyWith(o: { models?: DecisionModels; max?: number; diff?: Partial<EngineDecision> } = {}, base: Policy = SHIPPED): Policy {
  const p = structuredClone(base);
  p.decisions = {
    mode: o.models ?? p.decisions.mode,
    max_calls_per_head: o.max ?? p.decisions.max_calls_per_head,
    by_name: { ...p.decisions.by_name, "diff-screen": { ...p.decisions.by_name["diff-screen"]!, ...o.diff } },
  };
  return p;
}

/** `loadPolicy("policy")`, once. */
export const SHIPPED: Policy = loadPolicy("policy");

/** Write `text` to `<stateDir>/<runId>/out/<name>` (the outputs copy-out brought back); returns its path. */
export function writeOut(f: { deps: { stateDir: string } }, runId: string, name: string, text: string | Uint8Array): string {
  const dir = join(f.deps.stateDir, runId, "out");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

/** A review run's outputs as T19 recorded them: result.json with the review node completed, and the StructuredOutput row in the transcript. */
export function writeReview(f: { deps: { stateDir: string } }, runId: string, output: unknown, o: { nodeState?: string; coderabbit?: string } = {}): void {
  writeOut(f, runId, "result.json", JSON.stringify({ run: { status: "completed", nodes: [{ nodeId: "review", state: o.nodeState ?? "completed" }, { nodeId: "coderabbit", state: "completed" }] } }));
  const row = { type: "provider_event", step: "review", attemptId: "r1", seq: 3, event: { type: "tool_call", toolCallId: "toolu_so", name: "StructuredOutput", rawInput: output } };
  writeOut(f, runId, "transcript.jsonl", `${JSON.stringify({ type: "workflow_start" })}\n${JSON.stringify(row)}\n`);
  writeOut(f, runId, "coderabbit.ndjson", o.coderabbit ?? '{"type":"hapi","skipped":"runs.phases.coderabbit is off for this run"}\n');
}

/** bun's junit report for `files`, each with one passing test. */
export const junitFor = (files: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="${files.length}" assertions="${files.length}" failures="0" skipped="0" time="0.01">\n${files
    .map((f) => `  <testsuite name="${f}" file="${f}" tests="1" assertions="1" failures="0" skipped="0" time="0">\n    <testcase name="works" classname="" time="0" file="${f}" line="1" assertions="1" />\n  </testsuite>`)
    .join("\n")}\n</testsuites>\n`;

/** The planner's acceptance test the harvest tests merge on main. */
export const ACCEPTANCE = `.factory/work/${"0001-skeleton"}/acceptance/a.test.ts`;

/** A verify run's outputs: verify.json (`json`), result.json (`status`, completed by default) and, unless `junit` is null, the acceptance junit. */
export function writeVerify(f: { deps: { stateDir: string } }, runId: string, json: unknown, o: { status?: string; junit?: string | null } = {}): void {
  writeOut(f, runId, "verify.json", typeof json === "string" ? json : JSON.stringify(json));
  writeOut(f, runId, "result.json", JSON.stringify({ run: { status: o.status ?? "completed", nodes: [{ nodeId: "verify", state: "completed" }] } }));
  if (o.junit !== null) writeOut(f, runId, "acceptance.junit.xml", o.junit ?? junitFor([ACCEPTANCE]));
}

export const PASSING_VERIFY = { check: { exit: 0, tail: "ok" }, smoke: { exit: 0, tail: "" }, acceptance: { exit: 0, tail: "1 pass" } };
export const READY_REVIEW: { verdict: "ready"; findings: ReviewFinding[]; criteria: { criterion: string; mark: "met"; evidence: string }[] } = {
  verdict: "ready",
  findings: [],
  criteria: [{ criterion: "the health tool answers", mark: "met", evidence: "tests/health.test.ts" }],
};

/** A worker's transcript: provider_event rows of `step`, attempt a1, chunked as Pi streams them. */
export function transcriptOf(chunks: (string | { tool: string })[], step = "implement", attempt = "a1"): string {
  return (
    chunks
      .map((c, i) =>
        JSON.stringify({
          type: "provider_event",
          step,
          attemptId: attempt,
          seq: i,
          event: typeof c === "string" ? { type: "agent_message_chunk", text: c } : { type: "tool_call", toolCallId: `t${i}`, name: c.tool, rawInput: {} },
        }),
      )
      .join("\n") + "\n"
  );
}

/** A worker's decisions.jsonl: a spend record of `usd` and `turns`, then its result record. */
export const decisionsOf = (result: string, usd = 0.5, turns = 3) =>
  `${JSON.stringify({ event: "budget", decision: "allow", rule: "spend", cost_usd: usd, turns })}\n${JSON.stringify({ event: "result", decision: result, rule: "result", reason: "" })}\n`;

/** Task 3's fake forge for ORDER.repo, the real adapter over it, and a fake pushBranch that moves the fake's branch. */
export function forgeWorld() {
  const ff = fakeForge({ repo: ORDER.repo });
  const forge = githubForge({ repo: ff.repo, token: "fake-pr-token", fetch: ff.fetch });
  const pushes: PushOptions[] = [];
  const pushBranch = async (o: PushOptions): Promise<PushResult> => {
    pushes.push(o);
    ff.push(`factory/${o.id}`, o.head);
    return { pushed: true };
  };
  return { ff, forge, pushes, pushBranch };
}

/** Each of the fake forge's calls that isn't a GET, as `<METHOD> <path>`, the repo's API prefix cut off. */
export function writes(ff: ReturnType<typeof fakeForge>): string[] {
  return ff.calls
    .filter((c) => c.method !== "GET")
    .map((c) => {
      const path = new URL(c.url).pathname;
      const repo = `/repos/${ff.repo}`;
      return `${c.method} ${path.startsWith(repo) ? path.slice(repo.length) : path}`;
    });
}

/** design §3.6's clean evidence: gates clean, verify all passed, the review ready with one met criterion, CodeRabbit reviewed with no finding, the worker done. */
export const CLEAN: Evidence = {
  gates: { head: "c".repeat(40), files: ["src/a.ts"], problems: [], signals: [] },
  verify: { state: "ran", check: "passed", smoke: "passed", acceptance: "passed" },
  review: { state: "ran", verdict: "ready", findings: [], criteria: [{ criterion: "the health tool answers", mark: "met", evidence: "tests/health.test.ts" }] },
  cr: { state: "reviewed", findings: [] },
  worker: { result: "done", endsOnQuestion: false, account: "## Account\nChose X over Y.", hasFinal: true },
  screens: [],
};
