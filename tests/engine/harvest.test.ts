/**
 * The harvester (Plan 03 Task 12): the host gates with real git and the pinned gitleaks, the outcome row by row, the
 * never-forced push, and harvest() over Task 3's fake forge (the real githubForge adapter over `fakeForge().fetch`).
 * No model is called: fakeDecide, or the real ask() over a recording fetch with fake keys.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../src/decide/record";
import { diffSubjects, ledgerPath, readLedger, type Screened } from "../../src/engine/decisions";
import {
  diffStat,
  type Evidence,
  fixHunks,
  GITLEAKS_VERSION,
  type GateResult,
  type HarvestDeps,
  type HarvestInput,
  harvest,
  hostGates,
  outcome,
  push,
  pushOutcome,
  runGates,
  scratchPath,
} from "../../src/engine/harvest";
import type { WorkOrderState } from "../../src/engine/state";
import { applyOverlay } from "../../src/policy/overlay";
import type { Policy } from "../../src/policy/types";
import { readRecord, type RunRecord } from "../../src/run/records";
import { runCommand, type Runner } from "../../src/stack/up";
import { FAKE_ANTHROPIC_KEY, FAKE_JEV_KEY, recordingFetch } from "../decide/helpers";
import { fakeRun, fakeSecret, NOW, seedRun } from "../run/helpers";
import { cleanup } from "../secrets/helpers";
import {
  ACCEPTANCE,
  CLEAN,
  decisionsOf,
  fakeDecide,
  forgeWorld,
  gitWorld,
  HOLD,
  NOTE,
  ORDER,
  orderAt,
  PASSING_VERIFY,
  policyWith,
  READY_REVIEW,
  realGit,
  SHIPPED,
  transcriptOf,
  writeOut,
  writeReview,
  writes,
  writeVerify,
} from "./helpers";

afterEach(cleanup);

const W = "ab12cd34ef56";
const V = "cd34ef56ab12";
const R = "ef56ab12cd34";
const PHASES = SHIPPED.runs.phases;

/** The host gates on the world's bundle, as runGates calls them. */
function gatesOn(w: ReturnType<typeof gitWorld>, o: { bundle?: string; base?: string; policy?: Policy; secrets?: Record<string, string>; runId?: string } = {}) {
  return hostGates(realGit(), {
    mirror: w.mirror,
    scratch: scratchPath(w.engineDir, ORDER.repo, ORDER.id),
    bundle: o.bundle ?? w.bundle(),
    runId: o.runId ?? W,
    base: o.base ?? w.base,
    workOrder: ORDER.workOrder,
    policy: o.policy ?? SHIPPED,
    secrets: o.secrets ?? {},
  });
}

describe("with real git: the host gates", () => {
  test("the pinned gitleaks is mise.toml's", () => {
    expect(readFileSync("mise.toml", "utf8")).toContain(`gitleaks = "${GITLEAKS_VERSION}"`);
  });

  test("with real git: host gates pass a bundle inside its pieces' files", async () => {
    const w = gitWorld();
    const head = w.commit({ "src/a.ts": "export const a = 1;\n" });
    expect(await gatesOn(w)).toEqual({ head, files: ["src/a.ts"], problems: [], signals: [] });
    const scratch = scratchPath(w.engineDir, ORDER.repo, ORDER.id);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          expect([p, st.mode & 0o555]).toEqual([p, 0o555]);
          walk(p);
        } else expect([p, st.mode & 0o444]).toEqual([p, 0o444]);
      }
    };
    walk(scratch);
  });

  test("with real git: a protected path, a file outside every piece and an empty change are refused", async () => {
    const w = gitWorld();
    w.commit({ "src/a.ts": "a\n", ".github/workflows/x.yml": "on: push\n", "docs/x.md": "# x\n" });
    expect((await gatesOn(w)).problems).toEqual([
      { gate: "protected", detail: ".github/workflows/x.yml is a protected path (workers: deny)" },
      { gate: "scope", detail: ".github/workflows/x.yml is outside every piece's files" },
      { gate: "scope", detail: "docs/x.md is outside every piece's files" },
    ]);
    // A piece's scope matches case: SRC/ is not src/.
    const c = gitWorld();
    c.commit({ "SRC/a.ts": "a\n" });
    expect((await gatesOn(c)).problems).toEqual([{ gate: "scope", detail: "SRC/a.ts is outside every piece's files" }]);
    const overlaid = applyOverlay(SHIPPED, { protected_paths: { "src/a.ts": { workers: "deny" } } });
    expect((await gatesOn(w, { policy: overlaid })).problems).toContainEqual({ gate: "protected", detail: "src/a.ts is a protected path (workers: deny)" });

    const a = gitWorld();
    a.commit({ [ACCEPTANCE]: "test('x', () => {});\n" });
    expect((await gatesOn(a)).problems[0]).toEqual({ gate: "protected", detail: `${ACCEPTANCE} is a protected path (workers: deny)` });

    const e = gitWorld();
    const head = e.commit({}, { empty: true });
    expect((await gatesOn(e)).problems).toEqual([{ gate: "no-diff", detail: `the run changed no file (${e.base.slice(0, 7)}..${head.slice(0, 7)} is empty)` }]);
  });

  test("with real git: a bundle that doesn't apply, or names another ref, is a bundle problem", async () => {
    const w = gitWorld();
    w.commit({ "src/a.ts": "a\n" });
    // Another history: its base is a main this mirror never held.
    const other = gitWorld();
    other.onMain({ "README.md": "# another sandbox\n" });
    other.commit({ "src/b.ts": "b\n" });
    const foreign = other.bundle({ name: "foreign.bundle" });
    const p = (await gatesOn(w, { bundle: foreign })).problems;
    expect(p).toHaveLength(1);
    expect(p[0]!.gate).toBe("bundle");
    expect(p[0]!.detail).toMatch(/^run\.bundle does not apply to the mirror \(git bundle verify exited \d+\)$/);
    expect((await gatesOn(w, { bundle: w.bundle({ name: "extra.bundle", extraRef: "extra" }) })).problems).toEqual([{ gate: "bundle", detail: "run.bundle: unexpected refs in run.bundle: refs/heads/extra" }]);
  });

  test("with real git: a bundle over its size cap, a head that doesn't descend from the base, and a commit without the run's trailers are refused", async () => {
    const w = gitWorld();
    w.commit({ "src/a.ts": "a\n" });
    const tiny = structuredClone(SHIPPED);
    tiny.runs.output_limits_mb.bundle = 0;
    expect((await gatesOn(w, { policy: tiny })).problems).toEqual([{ gate: "size", detail: "run.bundle is 0.0 MiB, over runs.output_limits_mb.bundle (0 MiB)" }]);

    const bundle = w.bundle();
    const head = w.work("rev-parse", "HEAD");
    const old = w.base;
    const main = w.onMain({ "README.md": "# moved on\n" });
    w.work("checkout", "-q", "--detach", head);
    expect(old).not.toBe(main);
    expect((await gatesOn(w, { bundle, base: main })).problems).toEqual([{ gate: "bundle", detail: `the run's head ${head.slice(0, 7)} does not descend from ${main.slice(0, 7)}` }]);

    const t = gitWorld();
    const bare = t.commit({ "src/a.ts": "a\n" }, { trailers: ["Work-Order: 0001-skeleton"] });
    const problems = (await gatesOn(t)).problems;
    expect(problems.map((x) => x.gate)).toEqual(["bundle", "bundle", "bundle", "bundle", "bundle"]);
    expect(problems.map((x) => x.detail)).toContain(`commit ${bare.slice(0, 7)} lacks the trailer Hapi-Run: ${W}`);
    const wrong = gitWorld();
    wrong.commit({ "src/a.ts": "a\n" }, { runId: "000000000000" });
    expect((await gatesOn(wrong)).problems).toEqual([{ gate: "bundle", detail: `commit ${wrong.work("rev-parse", "HEAD").slice(0, 7)} lacks the trailer Hapi-Run: ${W}` }]);
  });

  test("with real git: the secret scan reads every new commit's contents, messages and path names, raw and base64, and gitleaks", async () => {
    const key = fakeSecret("ANTHROPIC_API_KEY");
    const secrets = { ANTHROPIC_API_KEY: key };
    const scan = async (files: Record<string, string>, message?: string) => {
      const w = gitWorld();
      w.commit({ "src/a.ts": "a\n" });
      w.commit(files, message === undefined ? {} : { message });
      return (await gatesOn(w, { secrets })).problems;
    };
    expect(await scan({ "src/b.ts": `export const k = "${key}";\n` })).toEqual([{ gate: "secret", detail: "src/b.ts holds ANTHROPIC_API_KEY's value" }]);
    expect(await scan({ "src/b.ts": `export const k = "zz${Buffer.from(`x${key}`).toString("base64")}";\n` })).toEqual([{ gate: "secret", detail: "src/b.ts holds ANTHROPIC_API_KEY's value, base64-encoded" }]);
    // A value removed again by a later commit is still in what would be pushed.
    const w = gitWorld();
    w.commit({ "src/b.ts": `${key}\n` });
    w.commit({ "src/b.ts": "clean\n" });
    expect((await gatesOn(w, { secrets })).problems).toEqual([{ gate: "secret", detail: "src/b.ts holds ANTHROPIC_API_KEY's value" }]);
    const named = await scan({ [`src/${key}.ts`]: "x\n" });
    expect(named).toContainEqual({ gate: "secret", detail: "a changed path's name holds ANTHROPIC_API_KEY's value: src/[hapi: ANTHROPIC_API_KEY redacted].ts" });
    for (const p of named) expect(p.detail).not.toContain(key);
    const ant = ["sk", "ant", "n".repeat(30)].join("-");
    expect(await scan({ [`src/${ant}.ts`]: "x\n" })).toContainEqual({ gate: "secret", detail: "a changed path's name holds a key's format (anthropic): src/[hapi: anthropic redacted].ts" });
    expect(await scan({ "src/b.ts": "b\n" }, `0001-skeleton: server\n\nthe key is ${key}`)).toContainEqual({ gate: "secret", detail: expect.stringMatching(/^the message of commit [0-9a-f]{7} holds ANTHROPIC_API_KEY's value$/) });
    // gitleaks: a token shaped like GitHub's, built at run time, random enough for its entropy check.
    const token = `ghp_${Array.from(crypto.getRandomValues(new Uint8Array(36)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[b % 62]).join("")}`;
    const leaks = await scan({ "src/c.ts": `const t = "${token}";\n` });
    expect(leaks.map((p) => p.gate)).toEqual(["secret"]);
    expect(leaks[0]!.detail).toMatch(/^gitleaks: github-pat in src\/c\.ts \(commit [0-9a-f]{7}\)$/);
    expect(leaks[0]!.detail).not.toContain(token);
    // Nothing a secret problem refuses is pushed.
    expect(outcome({ ...CLEAN, gates: { head: "c".repeat(40), files: ["src/c.ts"], problems: leaks, signals: [] } }, PHASES)).toMatchObject({ push: false, verdict: "do-not-merge" });
  });

  test("with real git: the added-line signals are check-this-yourself lines naming the file, never a problem", async () => {
    const w = gitWorld();
    w.commit({
      "tests/a.test.ts": 'test.skip("x", () => {});\nexpect(true).toBe(true);\n// TODO: real tests\n',
      "src/a.ts": 'if (process.env.NODE_ENV === "test") process.exit(0);\nwriteFileSync("/out/verify.json", "{}");\n',
      "bunfig.toml": '[test]\npreload = ["./x.ts"]\n',
    });
    const g = await gatesOn(w);
    expect(g.problems.filter((p) => p.gate !== "scope")).toEqual([]);
    expect(g.signals).toEqual([
      "`bunfig.toml`: it changes bunfig.toml, which can preload code into bun test",
      "`src/a.ts`: an added line branches on NODE_ENV being test",
      "`src/a.ts`: an added line calls process.exit",
      "`src/a.ts`: an added line names verify.json",
      "`src/a.ts`: an added line names /out or /.archon",
      "`tests/a.test.ts`: an added line skips a test (.skip, .todo or .only)",
      "`tests/a.test.ts`: an added line asserts nothing (expect(true))",
      "`tests/a.test.ts`: an added line leaves a TODO or FIXME",
    ]);
    expect(outcome({ ...CLEAN, gates: { ...CLEAN.gates, signals: g.signals } }, PHASES)).toEqual({ push: true, draft: false, verdict: "ready", reasons: [] });
  });
});

describe("outcome follows design §3.6, row by row", () => {
  const o = (e: Partial<Evidence>, phases = PHASES) => outcome({ ...CLEAN, ...e }, phases);
  const ran = CLEAN.review as Extract<Evidence["review"], { state: "ran" }>;

  test("clean evidence is Ready to merge", () => {
    expect(o({})).toEqual({ push: true, draft: false, verdict: "ready", reasons: [] });
  });

  test("a gate problem: no push", () => {
    expect(o({ gates: { head: undefined, files: [], problems: [{ gate: "scope", detail: "docs/x.md is outside every piece's files" }], signals: [] } })).toEqual({ push: false, draft: false, verdict: "do-not-merge", reasons: ["docs/x.md is outside every piece's files"] });
  });

  test("a failure in the verify container: a draft Do not merge", () => {
    const dnm = (v: Evidence["verify"], reason: string, phases = PHASES) => expect(o({ verify: v }, phases)).toEqual({ push: true, draft: true, verdict: "do-not-merge", reasons: [reason] });
    dnm({ state: "ran", check: "failed", smoke: "passed", acceptance: "passed" }, "check failed in the verify container");
    dnm({ state: "ran", check: "passed", smoke: "failed", acceptance: "passed" }, "smoke failed in the verify container");
    dnm({ state: "ran", check: "passed", smoke: "passed", acceptance: "failed" }, "the work order's acceptance tests failed in the verify container");
    dnm({ state: "ran", check: "passed", smoke: "passed", acceptance: "failed" }, "the work order's acceptance tests failed in the verify container", { ...PHASES, require_acceptance: false });
    dnm({ state: "broken", why: "the verify run left no verify.json" }, "verify: the verify run left no verify.json");
  });

  test("Needs your decision, a ready PR, with the reasons", () => {
    const dec = (e: Partial<Evidence>, reason: string, phases = PHASES) => expect(o(e, phases)).toEqual({ push: true, draft: false, verdict: "decision", reasons: [reason] });
    dec({ review: { ...ran, verdict: "needs-work" } }, "the independent review says needs-work");
    dec({ review: { ...ran, verdict: "blocked" } }, "the independent review says blocked");
    dec({ review: { ...ran, criteria: [{ criterion: "c", mark: "partly", evidence: "e" }] } }, "acceptance criterion 1 of 1 is partly met");
    dec({ review: { ...ran, criteria: [{ criterion: "c", mark: "unmet", evidence: "e" }] } }, "acceptance criterion 1 of 1 is unmet");
    dec({ review: { ...ran, criteria: [] } }, "the review marked no acceptance criterion");
    dec({ cr: { state: "reviewed", findings: [{ severity: "major", file: "src/a.ts", title: "t", text: "c" }] } }, "1 major or critical CodeRabbit finding is still open");
    dec({ review: { state: "none", why: "the review's output is malformed" } }, "no review: the review's output is malformed");
    dec({ review: { state: "off" } }, "the independent review is off (runs.phases.review)");
    dec({ verify: { state: "off" } }, "verify is off (runs.phases.verify): check, smoke and the acceptance tests were not run out of the worker's reach");
    dec({ verify: { state: "ran", check: "passed", smoke: "passed", acceptance: "none" } }, "the work order has no acceptance tests (runs.phases.require_acceptance)");
    dec({ worker: { ...CLEAN.worker, result: "blocked" } }, "the worker reported RESULT: blocked");
    dec({ worker: { ...CLEAN.worker, result: "no-change" } }, "the worker reported RESULT: no-change, yet changed files");
    dec({ worker: { ...CLEAN.worker, result: "missing" } }, "the worker's final message has no RESULT: line");
    dec({ worker: { ...CLEAN.worker, endsOnQuestion: true } }, "the worker's final message ends on a question");
    dec({ worker: { result: "done", endsOnQuestion: false, account: undefined, hasFinal: false } }, "the run's transcript holds no final message");
  });

  test("without require_acceptance, no acceptance tests alone stays ready; CodeRabbit not reviewed alone stays ready", () => {
    expect(o({ verify: { state: "ran", check: "passed", smoke: "passed", acceptance: "none" } }, { ...PHASES, require_acceptance: false }).verdict).toBe("ready");
    expect(o({ cr: { state: "not-reviewed", why: "the CodeRabbit CLI exited 1" } })).toEqual({ push: true, draft: false, verdict: "ready", reasons: [] });
  });

  test("outcome: an engine decision's hold turns Ready into Needs your decision; a note, notes mode, shadow or off never changes the verdict; none changes push or draft", () => {
    const hold = "`src/a.ts`: it holds text addressed to whoever reviews or checks the change (decide diff-screen: reviewer_steer 0.81, loosened_check 0.10, stand_in 0.05, beyond_goal 0.20, via jev)";
    const s: Screened = { decision: "diff-screen", version: "1a2b3c4d5e6f", models: "enforce", mode: "enforce", subjects: 1, asked: 1, reused: 0, unscreened: 0, via: { jev: 1 }, holds: [hold], notes: [], usd: 0, pushed: true };
    expect(o({ screens: [s] })).toEqual({ push: true, draft: false, verdict: "decision", reasons: [hold] });
    const failed = o({ screens: [s], verify: { state: "ran", check: "failed", smoke: "passed", acceptance: "passed" } });
    expect([failed.push, failed.draft, failed.verdict, failed.reasons.at(-1)]).toEqual([true, true, "do-not-merge", hold]);
    expect(o({ screens: [{ ...s, holds: [], notes: ["a note"] }] })).toEqual({ push: true, draft: false, verdict: "ready", reasons: [] });
    const quiets: Screened[] = [{ ...s, models: "notes", holds: [], notes: [hold] }, { ...s, mode: "shadow" }, { ...s, mode: "off", holds: [] }, { ...s, models: "off", holds: [] }];
    for (const quiet of quiets) {
      expect(o({ screens: [quiet] })).toEqual({ push: true, draft: false, verdict: "ready", reasons: [] });
    }
  });
});

describe("with real git: a push never uses +, and a moved branch is never forced", () => {
  test("a push never uses +, and a moved branch is never forced", async () => {
    const w = gitWorld();
    const head = w.commit({ "src/a.ts": "a\n" });
    await gatesOn(w);
    const scratch = scratchPath(w.engineDir, ORDER.repo, ORDER.id);
    const remote = join(w.tmp, "remote.git");
    w.work("init", "-q", "--bare", remote);
    const calls: { cmd: string[]; env: Record<string, string> }[] = [];
    // The push allows https alone (GIT_ALLOW_PROTOCOL); this test's remote is a local path, so the recording runner
    // checks that and lifts it for the real git underneath. A separate assertion shows git refuses the path with it.
    const run: Runner = async (cmd, o) => {
      calls.push({ cmd, env: o.env });
      const { GIT_ALLOW_PROTOCOL: _https, ...env } = o.env;
      return runCommand(cmd, { ...o, env });
    };
    const d = { run, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };
    expect(await push(d, { scratch, remote, id: ORDER.id, head, token: "fake-push-token" })).toEqual({ pushed: true });
    const argv = calls[0]!.cmd;
    expect(argv).toContain(`${head}:refs/heads/factory/0001-skeleton`);
    expect(argv.some((a) => a.startsWith("+") || a.startsWith("--force") || a === "-f")).toBe(false);
    expect(argv.join(" ")).not.toContain("fake-push-token");
    const { authedGit } = await import("../../src/forge/github/git");
    expect(calls[0]!.env).toMatchObject({ ...authedGit("fake-push-token"), GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https" });
    await expect(push(realGit(), { scratch, remote, id: ORDER.id, head, token: "fake-push-token" })).rejects.toThrow(/^git push to factory\/0001-skeleton failed \(exit \d+\)/);
    // Another commit lands on the remote branch; pushing a head that doesn't descend from it is refused, never forced.
    const later = w.commit({ "src/b.ts": "b\n" });
    w.work("push", "-q", remote, `${later}:refs/heads/factory/0001-skeleton`);
    w.work("--git-dir", scratch, "fetch", "-q", w.work.dir, `${later}:refs/hapi/later`);
    const lone = w.work("--git-dir", scratch, "commit-tree", "-p", w.base, "-m", "elsewhere", `${head}^{tree}`);
    expect(await push(d, { scratch, remote, id: ORDER.id, head: lone, token: "fake-push-token" })).toEqual({ moved: "factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten" });
    expect(w.work("--git-dir", remote, "rev-parse", "refs/heads/factory/0001-skeleton")).toBe(later);
  });
});

/** A harvest world: a real mirror and scratch, a worker, verify and review run seeded with passing outputs, the fake forge, and fakeDecide. */
async function world(o: { central?: Policy; decide?: HarvestDeps["decide"]; worker?: string; workerKind?: "worker" | "fix"; review?: unknown } = {}) {
  const w = gitWorld();
  w.onMain({ [ACCEPTANCE]: 'import { test } from "bun:test";\ntest("works", () => {});\n' });
  const base = w.base;
  const head = w.commit({ "src/a.ts": "export const a = 1;\n" });
  const f = fakeRun();
  const run = { ...f.deps, run: runCommand };
  const seed = (id: string, over: Partial<RunRecord>) => seedRun(f, { id, workOrder: ORDER.id, status: "succeeded", objects: false, retry: 0, round: 0, ...over });
  const recs = {
    worker: await seed(W, { sha: base, kind: o.workerKind ?? "worker", budgetUsd: 3, ...(o.workerKind === "fix" ? { round: 1 } : {}) }),
    verify: await seed(V, { sha: head, kind: "verify", budgetUsd: 0, exitCode: 0 }),
    review: await seed(R, { sha: head, kind: "review", budgetUsd: 1 }),
  };
  writeOut(f, W, "run.bundle", readFileSync(w.bundle()));
  writeOut(f, W, "transcript.jsonl", transcriptOf(["Working", { tool: "bash" }, "## Account\nChose X over Y.\n", "RESULT: done"]));
  writeOut(f, W, "decisions.jsonl", o.worker ?? decisionsOf("done"));
  writeVerify(f, V, PASSING_VERIFY);
  writeReview(f, R, o.review ?? READY_REVIEW);
  const fw = forgeWorld();
  const order = orderAt(base);
  const d: HarvestDeps = {
    run,
    engineDir: w.engineDir,
    repo: ORDER.repo,
    central: o.central ?? SHIPPED,
    forge: async () => fw.forge,
    token: async () => "fake-push-token",
    secrets: async () => ({}),
    gates: async () => {
      throw new Error("set below");
    },
    pushBranch: fw.pushBranch,
    public: true,
    subjects: (x) => diffSubjects(run, x),
    stat: (x) => diffStat(run, x),
    decide: o.decide ?? fakeDecide(),
    decideKeys: async () => ({ jev: FAKE_JEV_KEY, anthropic: FAKE_ANTHROPIC_KEY }),
  };
  const clean: GateResult = await runGates(d, order, recs.worker);
  expect(clean).toEqual({ head, files: ["src/a.ts"], problems: [], signals: [] });
  d.gates = async () => clean;
  const s: WorkOrderState = { repo: ORDER.repo, id: ORDER.id, mergeSha: base, planningPr: 7, phase: "harvest", runs: [W, V, R], autoRounds: 0, reworkRounds: 0, retry: 0, reasons: [], updatedAt: NOW.toISOString() };
  const h: HarvestInput = { order, run: recs.worker, verify: recs.verify, review: recs.review, runs: [recs.worker, recs.verify, recs.review], rounds: [], position: { k: 1, n: 1, siblings: [] } };
  return { w, f, d, fw, head, base, order, s, h, recs, clean };
}

const bodyOf = (ff: ReturnType<typeof forgeWorld>["ff"], i: number) => (ff.calls.filter((c) => c.method === "POST" || c.method === "PATCH").filter((c) => /\/pulls(\/\d+)?$/.test(new URL(c.url).pathname))[i]!.body as { body: string }).body;

describe("harvest", () => {
  test("opening a PR is idempotent: an existing PR for factory/<id> is found and updated, not duplicated", async () => {
    const { d, fw, s, h, head } = await world();
    const first = await harvest(d, s, h);
    expect(writes(fw.ff)).toEqual(["POST /pulls", "POST /issues/1/labels"]);
    const post = fw.ff.calls.find((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/pulls"))!.body as Record<string, unknown>;
    expect([post.head, post.base, post.draft, post.title]).toEqual(["factory/0001-skeleton", "main", false, "0001-skeleton: Skeleton and crack_cookie"]);
    expect([first.pr, first.prHead, first.verdict, first.reasons, first.phase]).toEqual([1, head, "ready", [], "harvest"]);
    const calls = (d.decide as ReturnType<typeof fakeDecide>).calls.length;
    expect(calls).toBe(1);
    // The crash before the state was saved: the same pre-harvest state again.
    const again = await harvest(d, s, h);
    expect(fw.ff.prs.size).toBe(1);
    expect(writes(fw.ff)).toEqual(["POST /pulls", "POST /issues/1/labels", "PATCH /pulls/1", "POST /issues/1/labels"]);
    expect([again.pr, again.prHead]).toEqual([1, head]);
    expect((d.decide as ReturnType<typeof fakeDecide>).calls.length).toBe(calls);
    expect(bodyOf(fw.ff, 1)).toBe(bodyOf(fw.ff, 0));
  });

  test("a ready PR's head is never replaced by one that fails check, and a moved branch is never overwritten", async () => {
    const { d, f, fw, s, h, base, head } = await world();
    fw.ff.addPr({ head: "factory/0001-skeleton" });
    fw.ff.push("factory/0001-skeleton", base);
    const verify = { ...h.verify!, round: 1 };
    writeVerify(f, V, { ...PASSING_VERIFY, check: { exit: 1, tail: "x" } }, { status: "failed" });
    const held = await harvest(d, { ...s, pr: 1, prHead: base }, { ...h, verify });
    expect(fw.pushes).toEqual([]);
    expect(held.verdict).toBe("decision");
    expect(held.reasons[0]).toBe(`round 1's head ${head.slice(0, 7)} failed check in the verify container, so it was not pushed over the ready PR (run ${V})`);
    expect(held.prHead).toBe(base);
    expect(bodyOf(fw.ff, 0)).toContain("not screened (this head was not pushed)");
    const h9 = "9".repeat(40);
    fw.ff.push("factory/0001-skeleton", h9);
    writeVerify(f, V, PASSING_VERIFY);
    const moved = await harvest(d, { ...s, pr: 1, prHead: base }, h);
    expect(fw.pushes).toEqual([]);
    expect(moved.verdict).toBe("decision");
    expect(moved.reasons[0]).toBe(`factory/0001-skeleton moved to 9999999 since the factory pushed ${base.slice(0, 7)}: not overwritten; the run's head ${h.verify!.sha.slice(0, 7)} was not pushed`);
    expect(moved.prHead).toBe(base);
  });

  test("a closed factory PR ends the harvest with its number, the reason, and no push", async () => {
    const f = fakeDecide();
    const { d, fw, s, h } = await world({ decide: f });
    fw.ff.addPr({ head: "factory/0001-skeleton", state: "closed" });
    const r = await harvest(d, s, h);
    expect([r.pr, r.reasons]).toEqual([1, ["the PR was closed"]]);
    expect(fw.pushes).toEqual([]);
    expect(writes(fw.ff)).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test("harvest sets harvestedAt on the runs it read, and flags spend over flags.thresholds.run_usd", async () => {
    const { d, f, fw, s, h } = await world({ worker: decisionsOf("done", 3.5) });
    const older = "2026-10-01T00:00:00.000Z";
    const r = await readRecord(f.deps.stateDir, R);
    const { writeRecord } = await import("../../src/run/records");
    await writeRecord(f.deps.stateDir, { ...r!, harvestedAt: older });
    await harvest(d, s, h);
    expect((await readRecord(f.deps.stateDir, W))!.harvestedAt).toBe(NOW.toISOString());
    expect((await readRecord(f.deps.stateDir, V))!.harvestedAt).toBe(NOW.toISOString());
    expect((await readRecord(f.deps.stateDir, R))!.harvestedAt).toBe(older);
    expect((await readRecord(f.deps.stateDir, W))!.decisions).toBeUndefined();
    const labels = fw.ff.calls.find((c) => new URL(c.url).pathname.endsWith("/issues/1/labels"))!.body;
    expect(labels).toEqual({ labels: ["lane:factory", "hapi:flagged"] });
  });

  test("the harvest screens only a head it will push, and saves every answer before the push", async () => {
    // A gate problem, the secret scan's included: nothing screened.
    for (const gate of ["scope", "secret"] as const) {
      const f = fakeDecide();
      const { d, fw, s, h, clean } = await world({ decide: f });
      d.gates = async () => ({ ...clean, problems: [{ gate, detail: "x" }] });
      const r = await harvest(d, s, h);
      expect([r.verdict, r.reasons, f.calls.length, writes(fw.ff)]).toEqual(["do-not-merge", ["x"], 0, []]);
    }
    // Clean gates: when the push comes, the ledger already holds one answer line per subject.
    const f = fakeDecide();
    const { d, fw, s, h } = await world({ decide: f });
    let seen: number | undefined;
    d.pushBranch = async (o) => {
      seen = (await readLedger(ledgerPath(d.engineDir, d.repo, ORDER.id))).filter((l) => l.kind === "answer").length;
      return fw.pushBranch(o);
    };
    await harvest(d, s, h);
    expect(seen).toBe(1);
    expect(f.calls.map((c) => (c.state as { path: string }).path)).toEqual(["src/a.ts"]);
  });

  test("decision models off: the harvest asks nothing, changes no verdict, and says so in the PR body and the run records", async () => {
    const f = fakeDecide({ "src/a.ts": HOLD });
    const { d, fw, s, h, f: run } = await world({ central: policyWith({ models: "off" }), decide: f });
    const r = await harvest(d, s, h);
    expect(f.calls).toHaveLength(0);
    expect(existsSync(ledgerPath(d.engineDir, d.repo, ORDER.id))).toBe(false);
    expect([r.verdict, r.reasons]).toEqual(["ready", []]);
    const body = bodyOf(fw.ff, 0);
    expect(body).toContain("| off: decision models are off (gates.decisions.mode) |");
    expect(body).toContain("- Decision models are off (gates.decisions.mode: off): no decide() question screened this change.");
    for (const id of [W, V, R]) {
      const rec = (await readRecord(run.deps.stateDir, id))!;
      expect([id, rec.harvestedAt, rec.decisions]).toEqual([id, NOW.toISOString(), "off"]);
    }
  });

  test("decision models are off only when the operator says: in enforce, no key holds the PR", async () => {
    const rf = recordingFetch(() => new Response("{}", { status: 500 }));
    const { d, fw, s, h } = await world({ decide: ((file, st, o) => ask(file, st, { ...o, fetch: rf.fetch, retryDelayMs: 0 })) as HarvestDeps["decide"] });
    d.decideKeys = async () => ({ jev: undefined, anthropic: undefined });
    const r = await harvest(d, s, h);
    expect(rf.seen).toHaveLength(0);
    expect(r.verdict).toBe("decision");
    expect(r.reasons).toContain("`src/a.ts`: not screened (no classifier answered: HAPI_JEV_OPENROUTER_API_KEY is not set; ANTHROPIC_API_KEY is not set) (gates.decisions.by_name.diff-screen.on_unscreened: hold)");
    const row = bodyOf(fw.ff, 0).split("\n").find((l) => l.startsWith("| decide: diff-screen"))!;
    expect(row).not.toContain("off");
    expect(row).toContain("| 1 not screened |");
  });

  test("a note under Check this yourself, a hold under Unresolved, and neither changes push or draft", async () => {
    const { d, fw, s, h } = await world({ decide: fakeDecide({ "src/a.ts": NOTE }) });
    const r = await harvest(d, s, h);
    expect([r.verdict, r.reasons, fw.pushes.length]).toEqual(["ready", [], 1]);
    expect(bodyOf(fw.ff, 0)).toContain("check it yourself");
    const held = await world({ decide: fakeDecide({ "src/a.ts": HOLD }) });
    const r2 = await harvest(held.d, held.s, held.h);
    expect([r2.verdict, held.fw.pushes.length]).toEqual(["decision", 1]);
    const post = held.fw.ff.calls.find((c) => c.method === "POST" && new URL(c.url).pathname.endsWith("/pulls"))!.body as { draft: boolean };
    expect(post.draft).toBe(false);
  });

  test("a major finding in a fix round's own change renders at the top of the PR, unfixed", async () => {
    const review = { verdict: "needs-work", findings: [{ severity: "major", path: "src/a.ts:1", summary: "still wrong" }], criteria: READY_REVIEW.criteria };
    const { d, fw, s, h } = await world({ workerKind: "fix", review });
    await harvest(d, s, h);
    const body = bodyOf(fw.ff, 0);
    const unresolved = body.slice(body.indexOf("## Unresolved"), body.indexOf("**Check this yourself**")).split("\n").filter((l) => l.startsWith("- "));
    expect(unresolved[0]).toBe("- a major finding (the independent review) is on line 1 of `src/a.ts`, in round 1's fix's own change: unfixed");
  });

  test("a live run is never harvested", async () => {
    const { d, s, h } = await world();
    await expect(harvest(d, s, { ...h, verify: { ...h.verify!, status: "live" } })).rejects.toThrow(`run ${V} is still live`);
  });

  test("a moved branch with no PR yet is never opened as the factory's PR", async () => {
    const { d, fw, s, h } = await world();
    d.pushBranch = async () => ({ moved: "factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten" });
    const r = await harvest(d, s, h);
    expect([r.pr, r.verdict, r.reasons[0]]).toEqual([undefined, "decision", `factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten; the run's head ${h.verify!.sha.slice(0, 7)} was not pushed`]);
    expect(writes(fw.ff)).toEqual([]);
    expect(existsSync(join(scratchPath(d.engineDir, ORDER.repo, ORDER.id), "HEAD"))).toBe(true);
  });
});

describe("fix round 1", () => {
  test("after a moved push, nothing marks the draft PR ready, and the body's evidence is the unpushed head's, said so", async () => {
    const { d, fw, s, h, base, head } = await world();
    fw.ff.addPr({ head: "factory/0001-skeleton", draft: true });
    fw.ff.push("factory/0001-skeleton", base);
    d.pushBranch = async () => ({ moved: "factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten" });
    const r = await harvest(d, { ...s, pr: 1, prHead: base }, h);
    expect(writes(fw.ff)).not.toContain("POST /graphql");
    expect(writes(fw.ff)).toEqual(["PATCH /pulls/1", "POST /issues/1/labels"]);
    expect(fw.ff.prs.get(1)!.draft).toBe(true);
    expect([r.prHead, r.verdict, r.reasons[0]]).toEqual([base, "decision", `factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten; the run's head ${head.slice(0, 7)} was not pushed`]);
    const body = bodyOf(fw.ff, 0);
    expect(body).toContain(`| host gates | ${head.slice(0, 7)} (not pushed) |`);
    expect(body).toContain(`| check | ${head.slice(0, 7)} (not pushed) |`);
    expect(body).toMatch(new RegExp(`\\| decide: diff-screen v[0-9a-f]{12} \\| ${head.slice(0, 7)} \\(not pushed\\) \\| not asked \\| not screened \\(this head was not pushed\\) \\|`));
    expect(body).toContain(`| \`ci / gates\` | ${base.slice(0, 7)} |`);
    expect(body).toContain(`"head":"${base}"`);
  });

  test("a PR head the scratch doesn't hold gives a body without a diff stat, never a throw", async () => {
    const { d, fw, s, h } = await world();
    fw.ff.addPr({ head: "factory/0001-skeleton", draft: true });
    fw.ff.push("factory/0001-skeleton", "8".repeat(40));
    d.pushBranch = async () => ({ moved: "factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten" });
    await harvest(d, { ...s, pr: 1 }, h);
    expect(bodyOf(fw.ff, 0)).toContain("The diff's size isn't known: the host's copy of the repo doesn't hold the PR's head 8888888.");
  });

  test("only git's own non-fast-forward is a move; GitHub's refusal carries its own reason; anything else throws", () => {
    const line = (summary: string) => `To https://github.com/x/y.git\n!\tabc:refs/heads/factory/0001-skeleton\t${summary}\nDone\n`;
    expect(pushOutcome(0, "", ORDER.id)).toEqual({ pushed: true });
    for (const why of ["[rejected] (non-fast-forward)", "[rejected] (fetch first)"]) expect(pushOutcome(1, line(why), ORDER.id)).toEqual({ moved: "factory/0001-skeleton moved on GitHub (not a fast-forward): not overwritten" });
    expect(pushOutcome(1, line("[remote rejected] (push declined due to repository rule violations @x)"), ORDER.id)).toEqual({
      refused: "GitHub refused the push to factory/0001-skeleton: `push declined due to repository rule violations x`",
    });
    expect(pushOutcome(1, line("[rejected] (stale info)"), ORDER.id)).toBeUndefined();
    expect(pushOutcome(128, "", ORDER.id)).toBeUndefined();
  });

  test("a refused push opens no PR and holds the work order, with GitHub's reason", async () => {
    const { d, fw, s, h, head } = await world();
    d.pushBranch = async () => ({ refused: "GitHub refused the push to factory/0001-skeleton: `push declined`" });
    const r = await harvest(d, s, h);
    expect([r.pr, r.verdict, r.reasons[0]]).toEqual([undefined, "decision", `GitHub refused the push to factory/0001-skeleton: \`push declined\`; the run's head ${head.slice(0, 7)} was not pushed`]);
    expect(writes(fw.ff)).toEqual([]);
  });

  test("the not-pushed reason gives the draft's real cause", async () => {
    const { d, f, fw, s, h, base, head } = await world();
    fw.ff.addPr({ head: "factory/0001-skeleton" });
    fw.ff.push("factory/0001-skeleton", base);
    writeOut(f, V, "verify.json", "not json");
    const r = await harvest(d, { ...s, pr: 1, prHead: base }, h);
    expect(r.reasons[0]).toBe(`round 0's head ${head.slice(0, 7)} has no readable verify result (verify: verify.json is malformed), so it was not pushed over the ready PR (run ${V})`);
  });

  test("m20: the review's verdict and marks go on the review run's record at harvest, never overwritten", async () => {
    const { d, f, s, h } = await world();
    await harvest(d, s, h);
    expect((await readRecord(f.deps.stateDir, R))!.review).toEqual({ verdict: "ready", marks: ["met"] });
    expect((await readRecord(f.deps.stateDir, W))!.review).toBeUndefined();
    writeReview(f, R, { verdict: "needs-work", findings: [], criteria: [{ criterion: "c", mark: "unmet", evidence: "e" }] });
    await harvest(d, s, h);
    expect((await readRecord(f.deps.stateDir, R))!.review).toEqual({ verdict: "ready", marks: ["met"] });
  });

  test("with real git: names git quotes, and an added line that looks like a header, are read per file, as content", async () => {
    const w = gitWorld();
    w.commit({ "src/tést.ts": 'test.skip("x", () => {});\n', 'src/a"b.ts': 'it.skip("y", () => {});\n', "src/c.ts": "++ b/src/zz.ts\nprocess.exit(0);\n" });
    const g = await gatesOn(w);
    expect(g.signals).toEqual([
      '`src/a"b.ts`: an added line skips a test (.skip, .todo or .only)',
      "`src/c.ts`: an added line calls process.exit",
      "`src/tést.ts`: an added line skips a test (.skip, .todo or .only)",
    ]);
    expect(g.signals.some((l) => l.includes("zz.ts"))).toBe(false);
  });

  test("with real git: a fix's own ranges are per file, for a quoted name and a deleted file too", async () => {
    const w = gitWorld();
    const first = w.commit({ "src/tést.ts": "a\nb\nc\n", "src/old.ts": "1\n2\n3\n", "src/x.ts": "x\n" });
    const fix = w.commit({ "src/tést.ts": "a\nB\nc\n", "src/old.ts": null, "src/x.ts": "x\n++ b/src/x.ts\n" });
    const hunks = await fixHunks(realGit(), w.scratch(), first, fix);
    expect(Object.fromEntries(hunks)).toEqual({ "src/old.ts": [], "src/tést.ts": [[2, 2]], "src/x.ts": [[2, 2]] });
  });

  test("with real git: a secret's commits leave the scratch, and only a clean scratch is made readable by all", async () => {
    const key = fakeSecret("ANTHROPIC_API_KEY");
    const w = gitWorld();
    w.commit({ "src/b.ts": `export const k = "${key}";\n` });
    const blob = w.work("rev-parse", "HEAD:src/b.ts");
    const g = await gatesOn(w, { secrets: { ANTHROPIC_API_KEY: key } });
    expect(g.problems.map((p) => p.gate)).toEqual(["secret"]);
    const scratch = scratchPath(w.engineDir, ORDER.repo, ORDER.id);
    const has = (args: string[]) => Bun.spawnSync(["git", "--git-dir", scratch, ...args], { env: { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode === 0;
    expect(has(["rev-parse", "--verify", "--quiet", `refs/hapi/runs/${W}`])).toBe(false);
    expect(has(["cat-file", "-e", blob])).toBe(false);
  });
});
