/**
 * A work order's state (Plan 03 Task 13, src/engine/state.ts): its file (0600, by temp and rename), the strict
 * reader, the first state discovery gives, the transition and its one event, and `hapi retry`'s two halves: what it
 * refuses (`retryProblem`) and the next pass it queues (`retryState`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listStates, newState, readState, retryProblem, retryState, statePath, transition, WORK_ORDER_ID, writeState, type WorkOrderState } from "../../src/engine/state";
import { cleanup, tempDir } from "../secrets/helpers";
import { ORDER } from "./helpers";

afterEach(cleanup);

const AT = "2026-10-29T12:00:00.000Z";
const T0 = "2026-10-29T10:00:00.000Z";
const W0 = "a0a0a0a0a0a0";
const V0 = "b0b0b0b0b0b0";

/** A state of ORDER at `phase`, retry 0 unless `over` names another. */
const stateOf = (over: Partial<WorkOrderState> = {}): WorkOrderState => ({
  repo: ORDER.repo,
  id: ORDER.id,
  mergeSha: "1".repeat(40),
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

describe("state files", () => {
  test("writeState writes 0600 by temp and rename, and readState reads it back", async () => {
    const dir = tempDir("hapi-state-");
    const s = stateOf({ phase: "verify", runs: [W0, V0], autoRounds: 1, pr: 4, prHead: "2".repeat(40), verdict: "ready", reasons: ["x"], lastHumanAt: AT });
    await writeState(dir, s);
    const file = statePath(dir, ORDER.repo, ORDER.id);
    expect(file).toBe(join(dir, "orders", "example-owner", "sandbox", "0001-skeleton.json"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    for (let d = dirname(file); d !== dir; d = dirname(d)) expect([d, statSync(d).mode & 0o777]).toEqual([d, 0o700]);
    // No temp file is left beside it.
    expect(readdirSync(dirname(file))).toEqual(["0001-skeleton.json"]);
    expect(await readState(dir, ORDER.repo, ORDER.id)).toEqual(s);
    // A second write replaces it whole.
    await writeState(dir, { ...s, phase: "review" });
    expect((await readState(dir, ORDER.repo, ORDER.id))!.phase).toBe("review");
    expect(readdirSync(dirname(file))).toEqual(["0001-skeleton.json"]);
    // None: undefined.
    expect(await readState(dir, ORDER.repo, "0002-none")).toBeUndefined();
  });

  test("a malformed state file throws, naming it", async () => {
    const dir = tempDir("hapi-state-");
    const file = statePath(dir, ORDER.repo, ORDER.id);
    mkdirSync(dirname(file), { recursive: true });
    const put = (x: unknown) => writeFileSync(file, typeof x === "string" ? x : JSON.stringify(x));
    const good = stateOf();
    const rows: [what: string, x: unknown, field: string][] = [
      ["an unknown phase", { ...good, phase: "dancing" }, "phase"],
      ["a missing runs", (({ runs: _, ...rest }) => rest)(good), "runs"],
      ["a retry of -1", { ...good, retry: -1 }, "retry"],
      ["a retry of 1.5", { ...good, retry: 1.5 }, "retry"],
      ["no retry", (({ retry: _, ...rest }) => rest)(good), "retry"],
      ["a run id that isn't one", { ...good, runs: ["../x"] }, "runs"],
      ["another work order's", { ...good, id: "0002-other" }, "id"],
      ["an unknown key", { ...good, extra: 1 }, "extra"],
      ["not JSON", "{", "JSON"],
    ];
    for (const [what, x, field] of rows) {
      put(x);
      const message = await readState(dir, ORDER.repo, ORDER.id).then(
        () => "(read)",
        (e: Error) => e.message,
      );
      expect([what, message]).toEqual([what, `${file} is not a work order's state: ${field}`]);
    }
  });

  test("newState holds with verdict decision, or queues", () => {
    expect(newState(ORDER, 3, AT, "overlaps 0002-x")).toEqual({
      repo: ORDER.repo,
      id: ORDER.id,
      mergeSha: ORDER.mergeSha,
      phase: "held",
      verdict: "decision",
      reasons: ["overlaps 0002-x"],
      planningPr: 3,
      runs: [],
      autoRounds: 0,
      reworkRounds: 0,
      retry: 0,
      updatedAt: AT,
    });
    const q = newState(ORDER, undefined, AT);
    expect(q).toEqual({ repo: ORDER.repo, id: ORDER.id, mergeSha: ORDER.mergeSha, phase: "queued", reasons: [], planningPr: undefined, runs: [], autoRounds: 0, reworkRounds: 0, retry: 0, updatedAt: AT });
    expect("verdict" in q).toBe(false);
  });

  test("listStates lists one repo's states, or every repo's", async () => {
    const dir = tempDir("hapi-state-");
    expect(await listStates(dir)).toEqual([]);
    expect(await listStates(dir, ORDER.repo)).toEqual([]);
    const a = stateOf({ id: "0002-b" });
    const b = stateOf({ id: "0001-a" });
    const c = stateOf({ repo: "another-owner/repo", id: "0001-a" });
    for (const s of [a, b, c]) await writeState(dir, s);
    // A stray file beside them is not a state.
    writeFileSync(join(dirname(statePath(dir, ORDER.repo, "0001-a")), ".0001-a.json.tmp"), "{");
    expect(await listStates(dir, ORDER.repo)).toEqual([b, a]);
    expect(await listStates(dir)).toEqual([c, b, a]);
    // D79: a stray file where an owner or a repo dir would be is skipped, never a throw.
    writeFileSync(join(dir, "orders", "README"), "x");
    writeFileSync(join(dir, "orders", "another-owner", "notes.txt"), "x");
    expect(await listStates(dir)).toEqual([c, b, a]);
  });

  test("transition appends one StatusEvent with the phase, run, PR, verdict and reason", () => {
    const s = stateOf({ phase: "worker", runs: [W0], pr: 4, verdict: "decision" });
    const { state, event } = transition(s, "verify", { at: AT, reason: "why", run: V0, usd: 0.5 });
    expect(event).toEqual({ at: AT, repo: "example-owner/sandbox", workOrder: "0001-skeleton", phase: "verify", run: V0, pr: 4, verdict: "decision", reason: "why", usd: 0.5 });
    // Only the phase and updatedAt change.
    expect(state).toEqual({ ...s, phase: "verify", updatedAt: AT });
    // retry only from the first retry on.
    expect(transition(stateOf({ retry: 2 }), "worker", { at: AT }).event).toEqual({ at: AT, repo: ORDER.repo, workOrder: ORDER.id, phase: "worker", retry: 2 });
    expect("retry" in transition(stateOf({ retry: 0 }), "worker", { at: AT }).event).toBe(false);
  });

  test("WORK_ORDER_ID is the work-order schema's id pattern", () => {
    const schema = JSON.parse(readFileSync("policy/schemas/work-order.schema.json", "utf8")) as { properties: { id: { pattern: string } } };
    expect(WORK_ORDER_ID.source).toBe(schema.properties.id.pattern);
  });
});

describe("hapi retry's state change", () => {
  test("retryProblem refuses all but a failed work order with no PR and retries left", () => {
    for (const phase of ["waiting", "queued", "held", "cap-stopped", "merged", "closed"] as const) {
      expect([phase, retryProblem(stateOf({ phase }), 2)]).toEqual([
        phase,
        `work order 0001-skeleton is ${phase}, not failed: only a failed work order is retried (docs/runbooks/engine.md, Troubleshooting)`,
      ]);
    }
    expect(retryProblem(stateOf({ phase: "failed", pr: 4 }), 2)).toBe("work order 0001-skeleton has PR #4: a PR is reworked with the hapi:rework label, not retried");
    expect(retryProblem(stateOf({ phase: "failed", retry: 2 }), 2)).toBe("work order 0001-skeleton has been retried 2 times, and runs.max_retries is 2: plan the work again under a new work order id");
    expect(retryProblem(stateOf({ phase: "failed", retry: 0 }), 0)).toBe("work order 0001-skeleton has been retried 0 times, and runs.max_retries is 0: plan the work again under a new work order id");
    expect(retryProblem(stateOf({ phase: "failed", retry: 1, reasons: ["worker run 0a0b0c0d0e0f ended failed: preflight exited 1"] }), 2)).toBeUndefined();
  });

  test("retryState queues the next pass and records the operator's action", () => {
    const failed = stateOf({
      phase: "failed",
      retry: 0,
      autoRounds: 2,
      reworkRounds: 0,
      runs: [W0, V0],
      verdict: "do-not-merge",
      prHead: "3".repeat(40),
      lastHumanAt: T0,
      reasons: [`worker run ${W0} ended timed-out: the run passed its deadline`],
      updatedAt: T0,
    });
    const { state, event } = retryState(failed, AT);
    const { verdict: _v, prHead: _p, ...rest } = failed;
    expect(state).toEqual({ ...rest, phase: "queued", retry: 1, autoRounds: 0, reasons: [], updatedAt: AT });
    expect("verdict" in state || "prHead" in state).toBe(false);
    expect([state.runs, state.reworkRounds, state.mergeSha, state.planningPr, state.lastHumanAt]).toEqual([failed.runs, 0, failed.mergeSha, 3, T0]);
    expect(event).toEqual({
      at: AT,
      repo: "example-owner/sandbox",
      workOrder: "0001-skeleton",
      phase: "queued",
      retry: 1,
      reason: `the operator retried it (retry 1) after: worker run ${W0} ended timed-out: the run passed its deadline`,
    });
    expect(retryState({ ...failed, reasons: [] }, AT).event.reason).toBe("the operator retried it (retry 1) after: no reason recorded");
  });
});
