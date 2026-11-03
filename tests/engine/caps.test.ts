/**
 * The poller's caps (Plan 03 Task 13, src/engine/caps.ts; design §3.9): the repo's UTC month and the UTC day against
 * `budgets.repo_monthly_usd` and `budgets.daily_usd`, every run counted at its known spend or its whole budget, the
 * decision ledger's spend with them, and the automatic-round cap. Retention keeps a run until its month has ended,
 * so the month's sum never loses one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { autoRoundsProblem, capProblem } from "../../src/engine/caps";
import { appendLedger, ledgerPath, type LedgerLine } from "../../src/engine/decisions";
import { writeState } from "../../src/engine/state";
import type { Policy } from "../../src/policy/types";
import { reapRuns } from "../../src/run/lifecycle";
import { readRecord } from "../../src/run/records";
import { capture, cleanup } from "../secrets/helpers";
import { seedRun } from "../run/helpers";
import { decisionsOf, ORDER, pipelineDeps, SHIPPED, writeOut } from "./helpers";

afterEach(cleanup);

/** The shipped policy with `budgets` changed. */
function withBudgets(b: Partial<Policy["budgets"]>, poller: "hard" | "soft" = "hard"): Policy {
  const p = structuredClone(SHIPPED);
  p.budgets = { ...p.budgets, ...b, enforcement: { ...p.budgets.enforcement, poller } };
  return p;
}

type World = ReturnType<typeof pipelineDeps>;

/** A finished (or live) run of `workOrder` started at `startedAt`; it spent `usd` when given, else its spend is unknown. */
async function spent(w: World, id: string, o: { workOrder?: string; startedAt: string; usd?: number; budgetUsd?: number; status?: "live" | "succeeded"; harvestedAt?: string }) {
  await seedRun(w.f, {
    id,
    workOrder: o.workOrder ?? ORDER.id,
    status: o.status ?? "succeeded",
    objects: false,
    startedAt: o.startedAt,
    kind: "worker",
    budgetUsd: o.budgetUsd ?? 3,
    retry: 0,
    ...(o.harvestedAt === undefined ? {} : { harvestedAt: o.harvestedAt }),
  });
  if (o.usd !== undefined) writeOut(w.f, id, "decisions.jsonl", decisionsOf("done", o.usd));
}

/** A state of `id` in ORDER's repo (or `repo`) listing `runs`. */
const listing = (w: World, id: string, runs: string[], repo = ORDER.repo) => writeState(w.engineDir, w.state({ repo, id, runs }));

/** A ledger call at `at` that a classifier answered at `cost`. */
function call(repo: string, workOrder: string, at: string, cost: number, n: number): LedgerLine[] {
  const base = { at, repo, workOrder, retry: 0, run: "a0a0a0a0a0a0", head: "c".repeat(40), decision: "diff-screen", version: "v1", subject: "src/a.ts", part: "whole", key: `k${n}`, public: true };
  return [
    { ...base, kind: "asking", call: `c${n}` },
    { ...base, kind: "answer", call: `c${n}`, state_chars: 10, models: "enforce", mode: "enforce", via: "jev", fallback: false, latency_ms: 1, cost_usd: cost, verdict: "pass", effect: "pass" },
  ];
}

const MONTH_TEXT = (spend: string, budget: string, cap: string) =>
  `this month's spend on example-owner/sandbox ($${spend}) plus the run's budget ($${budget}) would pass budgets.repo_monthly_usd ($${cap}): no new run for it until 2026-11-01`;
const DAY_TEXT = (spend: string, budget: string, cap: string) => `today's spend ($${spend}) plus the run's budget ($${budget}) would pass budgets.daily_usd ($${cap}): nothing new starts until 2026-10-30 (UTC)`;

describe("the caps", () => {
  test("caps at the boundary", async () => {
    // The month: records of the repo's work orders, on 2026-10-01, so the day's cap doesn't see them (m50(3)).
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 5.5 });
    await spent(w, "b0000000000b", { workOrder: "0002-other", startedAt: "2026-10-01T06:00:00.000Z", usd: 5.5 });
    await listing(w, ORDER.id, ["a0000000000a"]);
    await listing(w, "0002-other", ["b0000000000b"]);
    const p15 = withBudgets({ repo_monthly_usd: 15 });
    expect(await capProblem(w.d, ORDER.repo, p15, 4)).toBeUndefined();
    await spent(w, "c0000000000c", { startedAt: "2026-10-01T07:00:00.000Z", usd: 0.01 });
    await listing(w, ORDER.id, ["a0000000000a", "c0000000000c"]);
    expect(await capProblem(w.d, ORDER.repo, p15, 4)).toEqual({ refuse: MONTH_TEXT("11.0100", "4.0000", "15.00") });

    // The day: every record, the repo's or not (a hand run with no state counts too), against daily_usd 10.
    const day = pipelineDeps();
    await spent(day, "d0000000000d", { workOrder: "0009-hand", startedAt: "2026-10-29T01:00:00.000Z", usd: 6 });
    await spent(day, "e0000000000e", { startedAt: "2026-10-29T02:00:00.000Z", usd: 0.01 });
    expect(await capProblem(day.d, ORDER.repo, SHIPPED, 3.99)).toBeUndefined();
    expect(await capProblem(day.d, ORDER.repo, SHIPPED, 4)).toEqual({ refuse: DAY_TEXT("6.0100", "4.0000", "10.00") });
    // budgets.enforcement.poller: soft gives the same text as a warning.
    expect(await capProblem(day.d, ORDER.repo, withBudgets({}, "soft"), 4)).toEqual({ warn: DAY_TEXT("6.0100", "4.0000", "10.00") });
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 15 }, "soft"), 4)).toEqual({ warn: MONTH_TEXT("11.0100", "4.0000", "15.00") });
  });

  test("the month is checked before the day", async () => {
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-29T01:00:00.000Z", usd: 9 });
    await listing(w, ORDER.id, ["a0000000000a"]);
    // Both caps trip: the month's text.
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 10 }), 2)).toEqual({ refuse: MONTH_TEXT("9.0000", "2.0000", "10.00") });
  });

  test("an unknown spend counts at the run's full budget, and only this month's and today's runs count", async () => {
    const w = pipelineDeps();
    // A live run with no spend record yet, today; and a record from the last minute of September.
    await spent(w, "a0000000000a", { status: "live", startedAt: "2026-10-29T08:00:00.000Z", budgetUsd: 3 });
    await spent(w, "b0000000000b", { startedAt: "2026-09-30T23:59:00.000Z", usd: 100 });
    await listing(w, ORDER.id, ["a0000000000a", "b0000000000b"]);
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 5, daily_usd: 100 }), 2)).toBeUndefined();
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 5, daily_usd: 100 }), 2.5)).toEqual({ refuse: MONTH_TEXT("3.0000", "2.5000", "5.00") });
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 100, daily_usd: 4 }), 1.5)).toEqual({ refuse: DAY_TEXT("3.0000", "1.5000", "4.00") });
    // A listed run whose record retention removed counts toward neither (it is from an earlier month).
    await listing(w, ORDER.id, ["a0000000000a", "b0000000000b", "f0000000000f"]);
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 5, daily_usd: 100 }), 2)).toBeUndefined();
  });

  test("a repo's spend counts its name in any case, as one GitHub repo", async () => {
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 12 });
    await listing(w, ORDER.id, ["a0000000000a"], "Example-Owner/Sandbox");
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 15 }), 4)).toEqual({ refuse: MONTH_TEXT("12.0000", "4.0000", "15.00") });
  });

  test("the advancing work order's own state counts as the caller holds it, in place of its file", async () => {
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 5 });
    await spent(w, "b0000000000b", { startedAt: "2026-10-01T01:00:00.000Z", usd: 6.5 });
    // Its file lists one run; the advance has adopted a second that a lost state never listed.
    await listing(w, ORDER.id, ["a0000000000a"]);
    const p15 = withBudgets({ repo_monthly_usd: 15 });
    expect(await capProblem(w.d, ORDER.repo, p15, 4)).toBeUndefined();
    expect(await capProblem(w.d, ORDER.repo, p15, 4, w.state({ runs: ["a0000000000a", "b0000000000b"] }))).toEqual({ refuse: MONTH_TEXT("11.5000", "4.0000", "15.00") });
    // With no file at all.
    const n = pipelineDeps();
    await spent(n, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 12 });
    expect(await capProblem(n.d, ORDER.repo, p15, 4, n.state({ runs: ["a0000000000a"] }))).toEqual({ refuse: MONTH_TEXT("12.0000", "4.0000", "15.00") });
  });

  test("another repo's state file never stops this repo's check; one of its own that isn't a state fails it closed", async () => {
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 12 });
    await listing(w, ORDER.id, ["a0000000000a"]);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(join(w.engineDir, "orders", "another-owner", "repo"), { recursive: true });
    writeFileSync(join(w.engineDir, "orders", "another-owner", "repo", "0001-x.json"), "{ not a state");
    const p15 = withBudgets({ repo_monthly_usd: 15 });
    expect(await capProblem(w.d, ORDER.repo, p15, 4)).toEqual({ refuse: MONTH_TEXT("12.0000", "4.0000", "15.00") });
    // D79: a stray file where an owner or a repo dir would be is skipped, never a throw.
    writeFileSync(join(w.engineDir, "orders", "README"), "x");
    writeFileSync(join(w.engineDir, "orders", "another-owner", "notes.txt"), "x");
    expect(await capProblem(w.d, ORDER.repo, p15, 4)).toEqual({ refuse: MONTH_TEXT("12.0000", "4.0000", "15.00") });
    writeFileSync(join(w.engineDir, "orders", "example-owner", "sandbox", "0009-bad.json"), "{ not a state");
    await expect(capProblem(w.d, ORDER.repo, p15, 4)).rejects.toThrow("0009-bad.json is not a work order's state: JSON");
  });

  test("autoRoundsProblem", () => {
    const w = pipelineDeps();
    expect(autoRoundsProblem(w.state({ autoRounds: 3 }), 3)).toBe("3 automatic runs since the last human action (runs.max_auto_rounds: 3): waiting for the operator");
    expect(autoRoundsProblem(w.state({ autoRounds: 2 }), 3)).toBeUndefined();
  });

  test("a run harvested more than retention_days ago still counts toward this month", async () => {
    capture();
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-02T00:00:00.000Z", harvestedAt: "2026-10-02T01:00:00.000Z", usd: 11.01 });
    await listing(w, ORDER.id, ["a0000000000a"]);
    await reapRuns(w.d.run);
    expect(await readRecord(w.d.run.stateDir, "a0000000000a")).toBeDefined();
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 15 }), 4)).toEqual({ refuse: MONTH_TEXT("11.0100", "4.0000", "15.00") });
  });

  test("decision spend counts toward the repo's month and the day", async () => {
    const w = pipelineDeps();
    await spent(w, "a0000000000a", { startedAt: "2026-10-01T00:00:00.000Z", usd: 11 });
    await listing(w, ORDER.id, ["a0000000000a"]);
    await appendLedger(ledgerPath(w.engineDir, ORDER.repo, ORDER.id), [
      ...call(ORDER.repo, ORDER.id, "2026-10-15T00:00:00.000Z", 0.01, 1),
      // Last month's: counts toward neither.
      ...call(ORDER.repo, ORDER.id, "2026-09-15T00:00:00.000Z", 5, 2),
    ]);
    // Another repo's call today: the day's only.
    await appendLedger(ledgerPath(w.engineDir, "another-owner/repo", "0009-x"), call("another-owner/repo", "0009-x", "2026-10-29T10:00:00.000Z", 0.02, 3));
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 15 }), 4)).toEqual({ refuse: MONTH_TEXT("11.0100", "4.0000", "15.00") });
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 15.01 }), 4)).toBeUndefined();
    expect(await capProblem(w.d, ORDER.repo, withBudgets({ repo_monthly_usd: 100, daily_usd: 4.01 }), 4)).toEqual({ refuse: DAY_TEXT("0.0200", "4.0000", "4.01") });
  });
});
