/**
 * The poller's tick (Plan 03 Task 14, src/engine/poll.ts; design §3.4): new work orders get a state, one pipeline
 * per repo, every work order on a PR advanced each tick, a state written only under its lock and only once
 * `advance` resolves, problems in "Can't run", the planning PR's status comment, a forge error that fails one repo
 * closed and touches nothing (Review Focus 4), and the poll lock `hapi retry` shares. Over `tickWorld`: fake forges
 * through the real adapter, a fake mirror, a recording `advance` (or the real one). No Docker, no model, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { engineAdvance } from "../../src/engine/cli";
import { overlapProblem } from "../../src/engine/discover";
import { headsFile } from "../../src/engine/pipeline";
import { ACTIVE, formatTick, ON_PR, pollTick, QUEUE, SETTLED, withPollLock } from "../../src/engine/poll";
import { markPath, renderStatus, rowsOf } from "../../src/engine/status";
import { type Phase, readState, retryState, statePath, withOrderLock, writeState, type WorkOrderState } from "../../src/engine/state";
import { lockHeld } from "../../src/run/records";
import { SHA } from "../run/helpers";
import { cleanup } from "../secrets/helpers";
import { MERGE, ORDER, SANDBOX, SECOND, tickWorld } from "./helpers";

afterEach(cleanup);

const W1 = "0001-skeleton-and-crack-cookie";
const W2 = "0002-search-fortunes";
const W3 = "0003-fortune-of-the-day";
const T0 = "2026-10-29T10:00:00.000Z";
const T1 = "2026-10-29T11:00:00.000Z";
const T2 = "2026-10-29T11:30:00.000Z";
const bytes = (file: string) => readFileSync(file);
/** A state of SANDBOX's work order, as tickWorld's `state` builds it. */
const stateOf = (over: Partial<WorkOrderState>): WorkOrderState => ({
  repo: SANDBOX,
  id: W1,
  mergeSha: MERGE,
  planningPr: 3,
  phase: "queued",
  runs: [],
  autoRounds: 0,
  reworkRounds: 0,
  retry: 0,
  reasons: [],
  updatedAt: T0,
  ...over,
});
const seen = (w: ReturnType<typeof tickWorld>) => w.advanced.map((a) => a.id);

describe("the phase groups", () => {
  test("every phase but held is in exactly one group, and held is in none", () => {
    const all: Phase[] = [...SETTLED, ...ACTIVE, ...ON_PR, ...QUEUE];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(["cap-stopped", "closed", "failed", "fix", "harvest", "merged", "pr", "pr-fix", "pr-review", "queued", "review", "verify", "waiting", "worker"]);
  });
});

describe("pollTick", () => {
  test("a forge error mid-tick leaves the work order's state unchanged and revokes the tick's tokens", async () => {
    const w = tickWorld();
    w.d.advance = engineAdvance(w.d.run, w.d.policy, w.engineDir);
    await writeState(w.engineDir, w.state({ phase: "pr-review", pr: 7, prHead: SHA, runs: [] }));
    const file = statePath(w.engineDir, SANDBOX, W1);
    const before = bytes(file);
    w.worlds[SANDBOX]!.failNext("GET", `/repos/${SANDBOX}/pulls/7`, 502);
    const r = await pollTick(w.d);
    const sandbox = r.repos.find((x) => x.repo === SANDBOX)!;
    expect(bytes(file)).toEqual(before);
    expect(sandbox.error).toContain("HTTP 502");
    expect(sandbox.error).not.toContain("fake-");
    expect(w.mints.length).toBeGreaterThan(0);
    expect(w.mints.every((m) => m.revoked)).toBe(true);
    expect(w.events()).toEqual([]);
    expect(r.repos.find((x) => x.repo === SECOND)!.error).toBeUndefined();
    expect(formatTick(r)).toContain(`${SANDBOX}: failed closed: ${sandbox.error}; the next tick retries`);
    // The next tick tries again, and still changes nothing.
    const calls = w.worlds[SANDBOX]!.calls.length;
    w.worlds[SANDBOX]!.failNext("GET", `/repos/${SANDBOX}/pulls/7`, 502);
    expect((await pollTick(w.d)).repos.find((x) => x.repo === SANDBOX)!.error).toContain("HTTP 502");
    expect(w.worlds[SANDBOX]!.calls.length).toBeGreaterThan(calls);
    expect(bytes(file)).toEqual(before);
    expect(w.events()).toEqual([]);
  });

  test("GitHub's secondary rate limit (a 403 with retry-after) is a transient tick failure: that repo waits for the next tick", async () => {
    const w = tickWorld();
    w.d.advance = engineAdvance(w.d.run, w.d.policy, w.engineDir);
    await writeState(w.engineDir, w.state({ phase: "pr-review", pr: 7, prHead: SHA }));
    const before = bytes(statePath(w.engineDir, SANDBOX, W1));
    w.worlds[SANDBOX]!.failNext("GET", `/repos/${SANDBOX}/pulls/7`, 403, { "retry-after": "60", "x-ratelimit-remaining": "4000" });
    const r = await pollTick(w.d);
    expect(r.repos.find((x) => x.repo === SANDBOX)!.error).toContain("HTTP 403");
    expect(r.repos.find((x) => x.repo === SECOND)!.error).toBeUndefined();
    expect(bytes(statePath(w.engineDir, SANDBOX, W1))).toEqual(before);
    expect(w.mints.every((m) => m.revoked)).toBe(true);
  });

  test("a tick with nothing to do makes no forge write", async () => {
    const w = tickWorld();
    const s = w.state({ phase: "merged", pr: 12, runs: [] });
    await writeState(w.engineDir, s);
    // Its status mark is current: final, with the sha256 of the body the tick renders.
    const rows = await rowsOf(w.f.deps.stateDir, [s], w.policy.budgets.run_usd, w.engineDir, w.policy.gates.classifiers.jev.unknown_call_usd, w.f.deps.now());
    const body = renderStatus(rows, { monthlyUsd: w.policy.budgets.repo_monthly_usd, dailyUsd: w.policy.budgets.daily_usd }, [], w.policy.decisions.mode);
    const file = markPath(w.engineDir, SANDBOX, 3);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ commentId: 1000, sha256: createHash("sha256").update(body).digest("hex"), final: true }));
    const mark = bytes(file);
    const r = await pollTick(w.d);
    expect(Object.values(w.worlds).map((x) => x.calls)).toEqual([[], []]);
    expect(w.mints).toEqual([
      { repo: SANDBOX, purpose: "mirror", revoked: true },
      { repo: SECOND, purpose: "mirror", revoked: true },
    ]);
    expect(bytes(file)).toEqual(mark);
    expect(w.events()).toEqual([]);
    expect(formatTick(r)).toEqual([`${SANDBOX}: nothing to do`, `${SECOND}: nothing to do`]);
    // The mirror token went to the fetch, and discovery was given the merged id too: known holds every id taken up.
    expect(w.fetched).toEqual([
      { repo: SANDBOX, token: "fake-mirror-token" },
      { repo: SECOND, token: "fake-mirror-token" },
    ]);
    expect(w.known[SANDBOX]).toEqual([[W1]]);
  });

  test("a newly merged work order gets a queued state with its planning PR, and one event", async () => {
    const order = { ...ORDER, repo: SANDBOX, id: W1, mergeSha: MERGE };
    const w = tickWorld({ discovered: { [SANDBOX]: [order] } });
    const r = await pollTick(w.d);
    const s = await readState(w.engineDir, SANDBOX, W1);
    expect(s).toEqual({ repo: SANDBOX, id: W1, mergeSha: MERGE, planningPr: 3, phase: "queued", runs: [], autoRounds: 0, reworkRounds: 0, retry: 0, reasons: [], updatedAt: w.f.deps.now().toISOString() });
    expect(w.events()).toEqual([{ at: w.f.deps.now().toISOString(), repo: SANDBOX, workOrder: W1, phase: "queued" }]);
    expect(r.repos.find((x) => x.repo === SANDBOX)!.created).toEqual([`${W1} queued`]);
    // Pinned at its merge as its state is written.
    expect(w.pins).toEqual([[SANDBOX, W1, MERGE]]);
    // Planning PR #3's status comment is created.
    expect(r.repos.find((x) => x.repo === SANDBOX)!.comments).toEqual(["#3 created"]);
    // A second tick creates nothing, and discovery is given the new id.
    const again = await pollTick(w.d);
    expect(again.repos.find((x) => x.repo === SANDBOX)!.created).toEqual([]);
    expect(w.known[SANDBOX]!.at(-1)).toEqual([W1]);
    expect(w.events()).toHaveLength(1);
  });

  test("two work orders of one merge whose pieces overlap are both held, each with the overlap reason", async () => {
    const a = { ...ORDER, repo: SANDBOX, id: W1, mergeSha: MERGE };
    const b = { ...ORDER, repo: SANDBOX, id: W2, mergeSha: MERGE };
    const w = tickWorld({ discovered: { [SANDBOX]: [a, b] } });
    await pollTick(w.d);
    const reasons = overlapProblem([a, b]);
    for (const id of [W1, W2]) {
      const s = (await readState(w.engineDir, SANDBOX, id))!;
      expect([s.phase, s.verdict, s.reasons[0]]).toEqual(["held", "decision", reasons.get(id)]);
    }
    expect(w.events().map((e) => [e.workOrder, e.phase, e.verdict, e.reason])).toEqual([
      [W1, "held", "decision", reasons.get(W1)],
      [W2, "held", "decision", reasons.get(W2)],
    ]);
    expect(seen(w)).toEqual([]);
  });

  test("work orders of different merges never hold each other", async () => {
    const a = { ...ORDER, repo: SANDBOX, id: W1, mergeSha: MERGE };
    const b = { ...ORDER, repo: SANDBOX, id: W2, mergeSha: "e".repeat(40) };
    const w = tickWorld({ discovered: { [SANDBOX]: [a, b] } });
    await pollTick(w.d);
    expect((await readState(w.engineDir, SANDBOX, W1))!.phase).toBe("queued");
    expect((await readState(w.engineDir, SANDBOX, W2))!.phase).toBe("queued");
  });

  test("one pipeline per repo: a queued work order waits while another is in verify, a cap-stopped one heads the queue, and the oldest queued one starts when none is active", async () => {
    const cases: [WorkOrderState[], string[]][] = [
      [[{ id: W1, phase: "verify" }, { id: W2, phase: "queued" }].map((x) => stateOf(x as Partial<WorkOrderState>)), [W1]],
      [[{ id: W1, phase: "verify" }, { id: W2, phase: "cap-stopped" }].map((x) => stateOf(x as Partial<WorkOrderState>)), [W1]],
      [[{ id: W1, phase: "merged" }, { id: W2, phase: "cap-stopped", updatedAt: T1 }, { id: W3, phase: "queued", updatedAt: T0 }].map((x) => stateOf(x as Partial<WorkOrderState>)), [W2]],
      [[{ id: W1, phase: "merged" }, { id: W3, phase: "queued", updatedAt: T0 }, { id: W2, phase: "queued", updatedAt: T0 }].map((x) => stateOf(x as Partial<WorkOrderState>)), [W2]],
    ];
    for (const [states, want] of cases) {
      const w = tickWorld();
      for (const s of states) await writeState(w.engineDir, s);
      await pollTick(w.d);
      expect([states.map((s) => `${s.id} ${s.phase}`), seen(w)]).toEqual([states.map((s) => `${s.id} ${s.phase}`), want]);
    }
  });

  test("a reworked order back in fix advances beside another order's worker", async () => {
    const w = tickWorld();
    await writeState(w.engineDir, w.state({ id: W1, phase: "fix", pr: 12 }));
    await writeState(w.engineDir, w.state({ id: W2, phase: "worker" }));
    await writeState(w.engineDir, w.state({ id: W3, phase: "queued" }));
    await pollTick(w.d);
    expect(seen(w).sort()).toEqual([W1, W2]);
    expect((await readState(w.engineDir, SANDBOX, W3))!.phase).toBe("queued");
  });

  test("every work order on a PR is advanced each tick", async () => {
    const w = tickWorld();
    const onPr = ON_PR.map((phase, i) => w.state({ id: `000${i + 1}-on-${phase}`, phase, pr: 10 + i, mergeSha: `${String(i).repeat(40)}` }));
    const never = (["held", ...SETTLED] as Phase[]).map((phase, i) => w.state({ id: `001${i}-off-${phase}`, phase, pr: 20 + i }));
    for (const s of [...onPr, ...never]) await writeState(w.engineDir, s);
    await pollTick(w.d);
    expect(seen(w).sort()).toEqual(onPr.map((s) => s.id).sort());
    for (const s of onPr) expect(w.advanced.find((a) => a.id === s.id)!.order).toEqual({ ...ORDER, repo: SANDBOX, id: s.id, mergeSha: s.mergeSha });
    // Each tick, again.
    w.advanced.length = 0;
    await pollTick(w.d);
    expect(seen(w).sort()).toEqual(onPr.map((s) => s.id).sort());
  });

  test("an advanced state is written under the work order's lock, then its events are appended, and nothing else is", async () => {
    const w = tickWorld();
    await writeState(w.engineDir, w.state({ id: W1, phase: "worker", runs: ["ab12cd34ef56"] }));
    let inner: unknown;
    const event = { at: T2, repo: SANDBOX, workOrder: W1, phase: "verify" as const, run: "cd34ef56ab12" };
    w.d.advance = async (s) => {
      inner = await withOrderLock(w.engineDir, s, w.d.run.env, async () => {}).catch((e: unknown) => e);
      // Nothing is written while advance runs.
      expect((await readState(w.engineDir, SANDBOX, W1))!.phase).toBe("worker");
      expect(w.events()).toEqual([]);
      return { state: { ...s, phase: "verify", runs: [...s.runs, "cd34ef56ab12"], updatedAt: T2 }, events: [event] };
    };
    const r = await pollTick(w.d);
    expect(lockHeld(inner)).toBe(true);
    expect((await readState(w.engineDir, SANDBOX, W1))!.phase).toBe("verify");
    expect(w.events()).toEqual([event]);
    expect(r.repos.find((x) => x.repo === SANDBOX)!.moved).toEqual([`${W1} worker -> verify`]);
  });

  test("an advance that throws writes nothing; one whose order lock is held waits for the next tick; a policy that loosens is a problem", async () => {
    const w = tickWorld();
    await writeState(w.engineDir, w.state({ id: W1, phase: "worker" }));
    const before = bytes(statePath(w.engineDir, SANDBOX, W1));
    // The order lock held by another process: left for the next tick, and the repo goes on.
    const held = await (async () => {
      let r: Awaited<ReturnType<typeof pollTick>> | undefined;
      await withOrderLock(w.engineDir, w.state({ id: W1 }), w.d.run.env, async () => {
        r = await pollTick(w.d);
      });
      return r!;
    })();
    expect(held.repos.find((x) => x.repo === SANDBOX)!.error).toBeUndefined();
    expect(seen(w)).toEqual([]);
    expect(bytes(statePath(w.engineDir, SANDBOX, W1))).toEqual(before);
    // A PolicyLoosenError (a tightened central policy, m15): that work order can't run; the repo's tick goes on.
    const { PolicyLoosenError } = await import("../../src/policy/overlay");
    w.d.advance = async () => {
      throw new PolicyLoosenError("budgets.repo_monthly_usd", "the overlay's 40 is above the central 25");
    };
    const r = await pollTick(w.d);
    const sandbox = r.repos.find((x) => x.repo === SANDBOX)!;
    expect(sandbox.error).toBeUndefined();
    expect(sandbox.problems).toEqual([`.factory/work/${W1}/order.yaml: budgets.repo_monthly_usd: the overlay's 40 is above the central 25; overlays may only tighten policy`]);
    expect(bytes(statePath(w.engineDir, SANDBOX, W1))).toEqual(before);
  });

  test("a work order that can't be read is a problem in the tick report and its planning PR's status comment, and is never advanced", async () => {
    const problem = { path: ".factory/work/0004-bad/order.yaml", reason: "invalid YAML: bad indentation" };
    const w = tickWorld({ problems: { [SANDBOX]: [problem] }, unreadable: { [W1]: new Error(`no order.yaml at ${MERGE.slice(0, 12)}`) } });
    await writeState(w.engineDir, w.state({ id: W1, phase: "pr", pr: 12 }));
    const r = await pollTick(w.d);
    const sandbox = r.repos.find((x) => x.repo === SANDBOX)!;
    expect(existsSync(statePath(w.engineDir, SANDBOX, "0004-bad"))).toBe(false);
    // Discovery's problems first, then each a stated work order's rebuild gave.
    expect(sandbox.problems).toEqual([".factory/work/0004-bad/order.yaml: invalid YAML: bad indentation", `.factory/work/${W1}/order.yaml: no order.yaml at ${MERGE.slice(0, 12)}`]);
    expect(seen(w)).toEqual([]);
    expect(sandbox.error).toBeUndefined();
    const comment = w.worlds[SANDBOX]!.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/3/comments"))!;
    const body = (comment.body as { body: string }).body;
    expect(body).toContain("| `.factory/work/0004-bad/order.yaml` | `invalid YAML: bad indentation` |");
    expect(body).toContain(`| \`.factory/work/${W1}/order.yaml\` | \`no order.yaml at ${MERGE.slice(0, 12)}\` |`);
    expect(formatTick(r)).toContain(`${SANDBOX}: can't run .factory/work/0004-bad/order.yaml: invalid YAML: bad indentation`);
  });

  test("a problem's path and reason are sanitized for the report, and in code spans in the comment", async () => {
    const problem = { path: ".factory/work/0004-\x1b[31mbad/order.yaml", reason: "@someone see <https://e.invalid>\n`x`" };
    const w = tickWorld({ problems: { [SANDBOX]: [problem] } });
    const r = await pollTick(w.d);
    expect(r.repos.find((x) => x.repo === SANDBOX)!.problems).toEqual([".factory/work/0004-bad/order.yaml: @someone see <https://e.invalid> `x`"]);
    const body = (w.worlds[SANDBOX]!.calls.find((c) => c.method === "POST")!.body as { body: string }).body;
    expect(body).toContain("| `.factory/work/0004-bad/order.yaml` | `someone see https://e.invalid x` |");
    expect(body).not.toContain("@");
  });

  test("a tick while another holds the poll lock skips and touches nothing", async () => {
    const w = tickWorld({ discovered: { [SANDBOX]: [{ ...ORDER, repo: SANDBOX, id: W1, mergeSha: MERGE }] } });
    mkdirSync(w.engineDir, { recursive: true });
    const r = await withPollLock(w.engineDir, w.d.run.env, () => pollTick(w.d));
    expect(r).toEqual({ skipped: "another tick holds the poll lock", repos: [] });
    expect(w.mints).toEqual([]);
    expect(existsSync(statePath(w.engineDir, SANDBOX, W1))).toBe(false);
    expect(formatTick(r)).toEqual(["poll: another tick holds the poll lock"]);
  });

  test("a retried work order waits its turn in the queue", async () => {
    const w = tickWorld();
    const failed = w.state({ id: W1, phase: "failed", reasons: ["worker run 0a0b0c0d0e0f ended failed: preflight exited 1"], updatedAt: T0 });
    await writeState(w.engineDir, retryState(failed, T2).state);
    await writeState(w.engineDir, w.state({ id: W2, phase: "queued", updatedAt: T1 }));
    await pollTick(w.d);
    expect(seen(w)).toEqual([W2]);
    await writeState(w.engineDir, w.state({ id: W2, phase: "merged", updatedAt: T1 }));
    w.advanced.length = 0;
    await pollTick(w.d);
    expect(seen(w)).toEqual([W1]);
  });

  test("a state that retires (merged or closed) loses its heads cache", async () => {
    const w = tickWorld();
    await writeState(w.engineDir, w.state({ id: W1, phase: "waiting", pr: 12 }));
    const heads = headsFile(w.engineDir, SANDBOX, W1);
    mkdirSync(dirname(heads), { recursive: true });
    writeFileSync(heads, "{}\n");
    w.d.advance = async (s) => ({ state: { ...s, phase: "merged", updatedAt: T2 }, events: [{ at: T2, repo: SANDBOX, workOrder: W1, phase: "merged", pr: 12 }] });
    const r = await pollTick(w.d);
    expect(r.repos.find((x) => x.repo === SANDBOX)!.moved).toEqual([`${W1} waiting -> merged`]);
    expect(existsSync(heads)).toBe(false);
  });

  test("startRun's warnings reach the tick report", async () => {
    const w = tickWorld();
    await writeState(w.engineDir, w.state({ id: W1, phase: "queued" }));
    w.d.advance = async (s) => ({ state: { ...s, phase: "worker", updatedAt: T2 }, events: [], warnings: ["the run disk has 3.1 GiB free, under runs.disk.gb (20 GiB)"] });
    const r = await pollTick(w.d);
    expect(formatTick(r)).toContain(`${SANDBOX}: warning: the run disk has 3.1 GiB free, under runs.disk.gb (20 GiB)`);
  });

  test("a repo whose mirror fetch fails fails closed alone, and every repo is ticked in sorted order", async () => {
    const w = tickWorld({ fetchFails: { [SECOND]: new Error("cannot fetch example-owner/second into its mirror (git fetch exited 128): fatal: fake-mirror-token rejected", { cause: new Error("the network is down") }) } });
    const r = await pollTick(w.d);
    expect(r.repos.map((x) => x.repo)).toEqual([SANDBOX, SECOND]);
    const second = r.repos.find((x) => x.repo === SECOND)!;
    // The token is redacted, and the cause chain kept.
    expect(second.error).toBe("cannot fetch example-owner/second into its mirror (git fetch exited 128): fatal: [hapi: mirror token redacted] rejected; caused by: the network is down");
    expect(r.repos.find((x) => x.repo === SANDBOX)!.error).toBeUndefined();
    expect(w.mints.every((m) => m.revoked)).toBe(true);
  });

  test("a revoke that throws is reported, and the rest are still revoked", async () => {
    const { capture } = await import("../secrets/helpers");
    const { err } = capture();
    const w = tickWorld();
    const mint = w.d.mint;
    w.d.mint = async (repo, p) => {
      const m = await mint(repo, p);
      return repo === SANDBOX ? { token: m.token, revoke: async () => Promise.reject(new Error("DELETE /installation/token: HTTP 500")) } : m;
    };
    await pollTick(w.d);
    expect(err).toContain(`hapi poll: ${SANDBOX}: revoking the mirror token failed: DELETE /installation/token: HTTP 500`);
    expect(w.mints.find((m) => m.repo === SECOND)!.revoked).toBe(true);
  });
});
