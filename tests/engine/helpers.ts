/**
 * Test helpers for tests/engine: a real git work repo in a temp dir, work orders added to it, planning merges in
 * GitHub's classic message, and a way to update a mirror from it. Git here runs with no system or global config
 * (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`) and HOME set to the work dir, so nothing reads the real
 * ~/.gitconfig or ~/.config, and nothing touches the network: a mirror fetches from the work dir's path.
 */
import { expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import type { Answers, DecideOptions, DecideResult, DecisionFile, State } from "../../src/decide/index";
import type { ask } from "../../src/decide/record";
import type { DiscoverProblem, Discovered } from "../../src/engine/discover";
import type { ReviewFinding } from "../../src/engine/evidence";
import type { Evidence, GateProblem, HarvestDeps, PushOptions, PushResult } from "../../src/engine/harvest";
import { mirrorPath } from "../../src/engine/mirror";
import type { PipelineDeps } from "../../src/engine/pipeline";
import type { PollDeps } from "../../src/engine/poll";
import type { StatusEvent, WorkOrderState } from "../../src/engine/state";
import { githubForge } from "../../src/forge";
import { WORKER_IDENTITY } from "../../src/generate/archon";
import type { TokenPurpose } from "../../src/forge/github/token";
import { loadPolicy } from "../../src/policy/load";
import type { DecisionModels, EngineDecision, Policy } from "../../src/policy/types";
import type { StartOptions } from "../../src/run/lifecycle";
import { runBytes } from "../../src/run/cli";
import { keyPart, readRecord, runKey, type RunRecord, writeRecord } from "../../src/run/records";
import type { RunDeps } from "../../src/run/spec";
import { runCommand } from "../../src/stack/up";
import { validateWorkOrder } from "../../src/workorder/validate";
import { fakeForge, OPERATOR } from "../forge/helpers";
import { emptyRegistry } from "../policy/helpers";
import { fakeRun, NOW, seedRun, writeOrder } from "../run/helpers";
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
  commit(files: Record<string, string | Uint8Array | null>, o?: { runId?: string; trailers?: string[]; message?: string; empty?: boolean; gitlink?: Record<string, string>; config?: string[]; author?: string }): string;
  /** `git bundle create <tmp>/<name> <base>..HEAD`, as run.sh makes run.bundle; returns its path. */
  bundle(o?: { from?: string; name?: string; extraRef?: string }): string;
  /** Commit `files` on main and move the mirror's main there (a merged change); returns the new main. The work clone follows it. */
  onMain(files: Record<string, string>): string;
  /** A bare scratch: the mirror cloned, plus the work clone's HEAD as refs/hapi/test; returns its path. */
  scratch(): string;
}

/** The work runner: real git, no system or global config, HOME the temp dir, committing as the run container's generated identity. */
function gitIn(dir: string, home: string): Git {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const who = ["-c", `user.name=${WORKER_IDENTITY.name}`, "-c", `user.email=${WORKER_IDENTITY.email}`];
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, ...who, "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });
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
      const config = (c.config ?? []).flatMap((x) => ["-c", x]);
      work(...config, "commit", "-q", ...(c.empty ? ["--allow-empty"] : []), ...(c.author === undefined ? [] : ["--author", c.author]), "-m", c.message ?? `${ORDER.id}: server`, ...trailers);
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
export const realGit = (): Pick<RunDeps, "run" | "runBytes" | "env"> => ({ run: runCommand, runBytes, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });

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

// ---------------------------------------------------------------------------------------------------------------
// Plan 03 Task 13: the state machine's helpers.
// ---------------------------------------------------------------------------------------------------------------

/** The users beyond Task 3's: a stranger (the round's off switch), CodeRabbit's login on a user account, and a triage maintainer. */
export const SOMEONE = { id: 4242, login: "someone", type: "User" };
export const IMPOSTOR = { id: 999, login: "coderabbitai", type: "User" };
export const MAINT = { id: 5, login: "maint", type: "User" };

/** The merge the pipeline tests key ORDER at. */
export const MERGE = "f".repeat(40);

/** The fake gates' head of a run of `round` in pass `retry`: 40 hex digits (the fake heads are no commits). */
export const headAt = (round: number, retry = 0): string => `${"e".repeat(36)}${String(retry).padStart(2, "0")}${String(round).padStart(2, "0")}`;

/** What the fake engine git prints for a review's diff. */
export const FAKE_PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+export const a = 1;\n";

/** One `start` call: its options, and the inputs dir's files as they were when it was called. */
export interface Started {
  o: StartOptions;
  inputs: Record<string, string> | undefined;
  rec: RunRecord;
}

/**
 * The state machine's world (Task 13): `fakeRun()`'s deps with a clock the test moves (`clock.now`) and the engine's
 * own git calls answered (a review's diff, `cat-file -e`, `update-ref`), a temp engineDir, the shipped policy, Task 12's
 * forge world with a `pr` and a `checks` client of one fake GitHub, fake gates (clean unless `refuse` names the run;
 * the head `headAt(round, retry)`), a fake `start` that writes a live record as startRun would and records each call,
 * `finish` to end one, and `emit` collecting events. Every run starts at `clock.now`, and the clock moves a minute on.
 */
export function pipelineDeps(o: { central?: Policy; decide?: HarvestDeps["decide"]; subjects?: HarvestDeps["subjects"]; decision?: string } = {}) {
  const f = fakeRun();
  const engineDir = join(f.tmp, "engine");
  const clock = { now: new Date(NOW) };
  /** The engine's git calls the fake answered, each as its argv after `git`'s own options. */
  const gitCalls: string[][] = [];
  /** Commits the fake scratch doesn't hold: `cat-file -e <sha>^{commit}` answers 1 for them. */
  const missing = new Set<string>();
  const answer = (code: number, stdout = "") => ({ code, stdout, stderr: "" });
  const runner: RunDeps["run"] = async (cmd, opts) => {
    const g = cmd.indexOf("git");
    if (cmd[0] === "env" && cmd[1] === "-i" && g > 0) {
      const rest = cmd.slice(g + 1);
      let i = 0;
      while (rest[i] === "-c" || rest[i] === "--git-dir" || rest[i] === "--literal-pathspecs") i += rest[i] === "--literal-pathspecs" ? 1 : 2;
      const args = rest.slice(i);
      if (args[0] === "diff" || args[0] === "update-ref" || (args[0] === "cat-file" && args[1] === "-e")) {
        gitCalls.push(args);
        if (args[0] === "cat-file" && missing.has((args[2] ?? "").replace(/\^\{commit\}$/, ""))) return answer(1);
        if (args[0] !== "diff") return answer(0);
        if (args.includes("--name-only")) return answer(0, "src/a.ts\0");
        return answer(0, FAKE_PATCH);
      }
    }
    return f.deps.run(cmd, opts);
  };
  const run: RunDeps = { ...f.deps, run: runner, now: () => clock.now };
  const fw = forgeWorld();
  const ff = fw.ff;
  ff.collaborators.set("maint", "triage");
  ff.collaborators.set("example-owner", "admin");
  const forges = {
    pr: githubForge({ repo: ff.repo, token: "fake-pr-token", fetch: ff.fetch }),
    checks: githubForge({ repo: ff.repo, token: "fake-checks-token", fetch: ff.fetch }),
  };
  const starts: Started[] = [];
  const events: StatusEvent[] = [];
  /** Run ids whose fake gates refuse, with the problem each gives. */
  const refuse = new Map<string, GateProblem[]>();
  let next = 0;
  const order = orderAt(MERGE);
  const tick = () => {
    clock.now = new Date(clock.now.getTime() + 60_000);
  };
  const decide = o.decide ?? fakeDecide();
  const d: PipelineDeps = {
    run,
    engineDir,
    repo: ORDER.repo,
    central: o.central ?? SHIPPED,
    forge: async (p) => forges[p],
    token: async () => "fake-push-token",
    secrets: async () => ({}),
    gates: async (_order, rec) => ({ head: headAt(rec.round ?? 0, rec.retry ?? 0), files: ["src/a.ts"], problems: refuse.get(rec.runId) ?? [], signals: [] }),
    pushBranch: fw.pushBranch,
    public: true,
    subjects:
      o.subjects ??
      (async (x) => [{ decision: o.decision ?? x.decision, subject: "src/a.ts", part: "whole", state: { goal: x.goal, path: "src/a.ts", part: "whole", diff: "diff --git a/src/a.ts b/src/a.ts" } }]),
    stat: async () => ({ files: 1, insertions: 1, deletions: 0 }),
    decide,
    decideKeys: async () => ({ jev: "fake-jev-key", anthropic: "fake-anthropic-key" }),
    start: async (so) => {
      const id = (++next).toString(16).padStart(12, "0");
      const inputs = so.inputsDir === undefined ? undefined : Object.fromEntries(readdirSync(so.inputsDir).sort().map((n) => [n, readFileSync(join(so.inputsDir!, n), "utf8")]));
      const rec = await seedRun(f, {
        id,
        workOrder: so.workOrder.id,
        sha: so.sha,
        repo: so.repoGitDir,
        key: runKey(so.workOrder.id, so.sha, keyPart(so.kind, so.round ?? 0, so.retry)),
        status: "live",
        objects: false,
        startedAt: clock.now.toISOString(),
        kind: so.kind,
        round: so.round ?? 0,
        ...(so.retry === undefined ? {} : { retry: so.retry }),
        ...(so.parent === undefined ? {} : { parent: so.parent }),
        ...(so.budgetUsd === undefined ? {} : { budgetUsd: so.budgetUsd }),
        ...(so.forgeRepo === undefined ? {} : { forgeRepo: so.forgeRepo.toLowerCase() }),
      });
      starts.push({ o: so, inputs, rec });
      tick();
      return rec;
    },
    emit: async (e) => void events.push(e),
    operator: OPERATOR.login,
  };

  /** End run `id` with `status`, writing its kind's outputs: a done worker or fix spending `usd`, a passing verify, a ready review, unless told. */
  const finish = async (id: string, status: RunRecord["status"], x: { reason?: string; usd?: number; verify?: unknown; review?: unknown; exitCode?: number } = {}) => {
    const rec = await readRecord(f.deps.stateDir, id);
    if (rec === undefined) throw new Error(`no run ${id}`);
    const kind = rec.kind ?? "worker";
    if (kind === "worker" || kind === "fix") {
      writeOut(f, id, "decisions.jsonl", decisionsOf("done", x.usd ?? 0.5));
      writeOut(f, id, "transcript.jsonl", transcriptOf(["## Account\nDid it.\n", "RESULT: done"], kind === "fix" ? "fix" : "implement"));
    }
    if (kind === "verify") writeVerify(f, id, x.verify ?? PASSING_VERIFY, { status: status === "succeeded" ? "completed" : "failed" });
    if (kind === "review") writeReview(f, id, x.review ?? READY_REVIEW);
    await writeRecord(f.deps.stateDir, { ...rec, status, ...(x.reason === undefined ? {} : { reason: x.reason }), ...(kind === "verify" ? { exitCode: x.exitCode ?? 0 } : {}) });
  };

  /** A run of ORDER seeded as the engine's fake start would make it (the key from its kind, round, retry and sha), finished unless `status` is live. */
  const seed = async (kind: RunRecord["kind"] & string, x: { id: string; sha?: string; round?: number; retry?: number; parent?: string; status?: RunRecord["status"]; startedAt?: string; budgetUsd?: number; usd?: number; reason?: string; review?: unknown; verify?: unknown; harvestedAt?: string; forgeRepo?: string | null }) => {
    const round = x.round ?? 0;
    const retry = x.retry ?? 0;
    // A fix starts on the head before it (the review's); a verify or review on its round's head.
    const sha = x.sha ?? (kind === "worker" ? MERGE : kind === "fix" ? headAt(Math.max(0, round - 1), retry) : headAt(round, retry));
    const budgetUsd = x.budgetUsd ?? (kind === "worker" ? 3 : kind === "verify" ? 0 : 1);
    const rec = await seedRun(f, {
      id: x.id,
      workOrder: ORDER.id,
      sha,
      key: runKey(ORDER.id, sha, keyPart(kind, round, retry)),
      status: "live",
      objects: false,
      startedAt: x.startedAt ?? clock.now.toISOString(),
      kind,
      round,
      retry,
      budgetUsd,
      ...(x.forgeRepo === null ? {} : { forgeRepo: x.forgeRepo ?? ORDER.repo }),
      ...(x.parent === undefined ? {} : { parent: x.parent }),
      ...(x.harvestedAt === undefined ? {} : { harvestedAt: x.harvestedAt }),
    });
    if (x.startedAt === undefined) tick();
    if ((x.status ?? "succeeded") !== "live") await finish(x.id, x.status ?? "succeeded", x);
    return rec;
  };

  /** ORDER's state at `phase`, keyed at MERGE, planning PR 7, retry 0, unless `over` says otherwise. */
  const state = (over: Partial<WorkOrderState> = {}): WorkOrderState => ({
    repo: ORDER.repo,
    id: ORDER.id,
    mergeSha: MERGE,
    planningPr: 7,
    phase: "queued",
    runs: [],
    autoRounds: 0,
    reworkRounds: 0,
    retry: 0,
    reasons: [],
    updatedAt: clock.now.toISOString(),
    ...over,
  });

  return { f, d, ff, fw, forges, order, clock, starts, events, refuse, finish, seed, state, gitCalls, missing, decide, engineDir };
}

// ---------------------------------------------------------------------------------------------------------------
// Plan 03 Task 14: the poller's helpers.
// ---------------------------------------------------------------------------------------------------------------

/** The two repos the poller's tests register. */
export const SANDBOX = "example-owner/hapi-sandbox-fortune";
export const SECOND = "example-owner/second";

/** The shipped policy with `repos` registering `repos` (default: SANDBOX and SECOND). */
export function registered(base: Policy = SHIPPED, repos: string[] = [SANDBOX, SECOND]): Policy {
  const p = structuredClone(base);
  p.repos = { ...p.repos, repos: Object.fromEntries(repos.map((r) => [r, { registered: "2026-11-01" }])) };
  return p;
}

/**
 * A checkout root for the CLI's tests (`RunDeps.root`): a temp dir holding a copy of policy/ whose repos.yaml
 * registers `repos` (SANDBOX and SECOND by default), and whose gates.yaml sets `decisions.mode` to `models` when given.
 */
export function policyRoot(o: { models?: DecisionModels; repos?: string[] } = {}): string {
  const root = tempDir("hapi-engine-root-");
  const dir = join(root, "policy");
  Bun.spawnSync(["cp", "-R", join(import.meta.dir, "..", "..", "policy"), dir]);
  const listed = (o.repos ?? [SANDBOX, SECOND]).map((r) => `  ${r}: { registered: "2026-11-01" }`).join("\n");
  const repos = emptyRegistry(readFileSync(join(dir, "repos.yaml"), "utf8")).replace(/^repos: \{\}.*$/m, `repos:\n${listed}`);
  writeFileSync(join(dir, "repos.yaml"), repos);
  if (o.models !== undefined) {
    const gates = readFileSync(join(dir, "gates.yaml"), "utf8").replace(/^(  mode: )enforce(\s)/m, `$1${o.models}$2`);
    writeFileSync(join(dir, "gates.yaml"), gates);
  }
  return root;
}

/** A fake forge world with three merged planning PRs (#1-#3), each closed too, as GitHub reports a merged PR. */
export function planningWorld(repo: string, o: { private?: boolean } = {}) {
  const w = fakeForge({ repo, ...(o.private === undefined ? {} : { private: o.private }) });
  for (let i = 1; i <= 3; i++) w.addPr({ head: `plan/p${i}`, merged: true, state: "closed" });
  return w;
}

export interface TickOptions {
  worlds?: Record<string, ReturnType<typeof fakeForge>>;
  /** Discovery's problems, by repo. */
  problems?: Record<string, DiscoverProblem[]>;
  /** What discovery returns, by repo. */
  discovered?: Record<string, Discovered[]>;
  /** `readOrder` throws this for the work order id. */
  unreadable?: Record<string, Error>;
  advance?: PollDeps["advance"];
  /** `fetchMirror` throws this for the repo. */
  fetchFails?: Record<string, Error>;
  policy?: Policy;
}

/**
 * The poller's world (Task 14): `fakeRun()`'s deps, a temp engineDir, the shipped policy registering SANDBOX and
 * SECOND, a `planningWorld` per repo (`o.worlds` seeds one) reached through the real adapter, a `mint` that records
 * each token and its revoke, a fake mirror fetch and pin, a `discover` that records the `known` set it is given, a
 * `readOrder` of ORDER keyed as asked, planning PR 3 for everything, and a recording `advance` unless `o.advance`.
 */
export function tickWorld(o: TickOptions = {}) {
  const f = fakeRun();
  const engineDir = join(f.tmp, "engine");
  const policy = registered(o.policy ?? SHIPPED);
  const worlds: Record<string, ReturnType<typeof fakeForge>> = {};
  for (const repo of [SANDBOX, SECOND]) worlds[repo] = o.worlds?.[repo] ?? planningWorld(repo);
  const mints: { repo: string; purpose: TokenPurpose; revoked: boolean }[] = [];
  const known: Record<string, string[][]> = {};
  const advanced: { id: string; order: Discovered }[] = [];
  const fetched: { repo: string; token: string }[] = [];
  const pins: [string, string, string][] = [];
  const d: PollDeps = {
    run: f.deps,
    policy,
    engineDir,
    mint: async (repo, purpose) => {
      const m = { repo, purpose, revoked: false };
      mints.push(m);
      return { token: `fake-${purpose}-token`, revoke: async () => void (m.revoked = true) };
    },
    forge: (repo, token) => githubForge({ repo, token, fetch: worlds[repo]!.fetch }),
    fetchMirror: async (repo, token) => {
      fetched.push({ repo, token });
      const e = o.fetchFails?.[repo];
      if (e !== undefined) throw e;
    },
    discover: async (repo, k, problems) => {
      (known[repo] ??= []).push([...k].sort());
      problems.push(...(o.problems?.[repo] ?? []));
      return o.discovered?.[repo] ?? [];
    },
    readOrder: async (repo, id, mergeSha) => {
      const e = o.unreadable?.[id];
      if (e !== undefined) throw e;
      return { ...ORDER, repo, id, mergeSha };
    },
    planningPr: async () => 3,
    problemPr: async () => 3,
    pin: async (repo, id, sha) => void pins.push([repo, id, sha]),
    advance:
      o.advance ??
      (async (s, order) => {
        advanced.push({ id: s.id, order });
        return { state: s, events: [] };
      }),
  };
  /** A state of SANDBOX's `id` (default 0001-skeleton-and-crack-cookie), keyed at MERGE, planning PR 3, queued. */
  const state = (over: Partial<WorkOrderState> = {}): WorkOrderState => ({
    repo: SANDBOX,
    id: "0001-skeleton-and-crack-cookie",
    mergeSha: MERGE,
    planningPr: 3,
    phase: "queued",
    runs: [],
    autoRounds: 0,
    reworkRounds: 0,
    retry: 0,
    reasons: [],
    updatedAt: NOW.toISOString(),
    ...over,
  });
  /** The events appended so far, parsed. */
  const events = (): StatusEvent[] => {
    const file = join(engineDir, "events.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as StatusEvent) : [];
  };
  return { f, d, engineDir, policy, worlds, mints, known, advanced, fetched, pins, state, events };
}
