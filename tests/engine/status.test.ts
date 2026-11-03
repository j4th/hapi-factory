/**
 * The status view (Plan 03 Task 14, src/engine/status.ts; design §3.8): the planning PR's status comment, its rows and
 * their spend, the "Can't run" table, the decision-models line, the comment's one-time create, its edits in place,
 * the final comment once the plan settles, and `hapi status`, which reads local state only. Over Task 3's fake forge
 * through the real adapter. No Docker, no model, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { statusCommand } from "../../src/engine/cli";
import { appendLedger, ledgerPath } from "../../src/engine/decisions";
import { markPath, renderFinal, renderStatus, rowsOf, type StatusRow, statusTable, upsertStatusComment, VERDICT_TEXT } from "../../src/engine/status";
import { type WorkOrderState, writeState } from "../../src/engine/state";
import { githubForge } from "../../src/forge";
import { FACTORY_BOT, STRANGER } from "../forge/helpers";
import { fakeRun, NOW, seedRun } from "../run/helpers";
import { capture, cleanup } from "../secrets/helpers";
import YAML from "yaml";
import { readWorkOrder } from "../../src/engine/discover";
import { budgetsOf } from "../../src/engine/poll";
import { loadPolicy } from "../../src/policy/load";
import { runCommand } from "../../src/stack/up";
import { decisionsOf, gitWorld, MERGE, ORDER, planningWorld, policyRoot, SANDBOX, writeOut, writes } from "./helpers";

afterEach(cleanup);

const CAPS = { monthlyUsd: 15, dailyUsd: 10 };
const AT = NOW.toISOString();
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const stateOf = (over: Partial<WorkOrderState>): WorkOrderState => ({
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
  updatedAt: AT,
  ...over,
});

/** The three rows of the brief's status comment. */
const ROWS: StatusRow[] = [
  { state: stateOf({ id: "0001-skeleton-and-crack-cookie", phase: "waiting", verdict: "ready", runs: ["ab12cd34ef56", "cd34ef56ab12"], autoRounds: 2, pr: 12 }), usd: 1.234, known: true },
  { state: stateOf({ id: "0002-search-fortunes", phase: "held", verdict: "decision", reasons: ["pieces overlap 0003-fortune-of-the-day: src/tools/index.ts"] }), usd: 0, known: true },
  { state: stateOf({ id: "0003-fortune-of-the-day", phase: "queued", retry: 1, runs: ["ef56ab12cd34"] }), usd: 0.4, known: true },
];

const HEAD = ["<!-- hapi:status v1 -->", "**hapi-factory: this plan's work orders**", ""];
const TABLE = [
  "| Work order | State | Run | PR | Rounds | Cost |",
  "|---|---|---|---|---|---|",
  "| `0001-skeleton-and-crack-cookie` | waiting: Ready to merge | `cd34ef56ab12` | #12 | 2 automatic, 0 rework | $1.23 |",
  "| `0002-search-fortunes` | held: Needs your decision (`pieces overlap 0003-fortune-of-the-day: src/tools/index.ts`) | — | — | 0 automatic, 0 rework | $0.00 |",
  "| `0003-fortune-of-the-day` | queued | `ef56ab12cd34` | — | 0 automatic, 0 rework, retry 1 | $0.40 |",
];
const TOTAL = (usd: string) => `Total: $${usd}, against this repo's cap of $15.00 a month and $10.00 a day for all repos. The poller edits this comment in place; \`hapi status\` shows the same.`;
const BODY = [...HEAD, ...TABLE, "", TOTAL("1.63")].join("\n");
const OFF = "Decision models are off (gates.decisions.mode: off): the harvester asks no decide() question, so none holds or notes a PR here.";
const NOTES = "Decision models give notes only (gates.decisions.mode: notes): none holds a PR here.";

describe("the status comment", () => {
  test("the status comment is one row per work order, the plan's total against the caps, a hidden marker, and no checkbox", () => {
    const body = renderStatus(ROWS, CAPS, [], "enforce");
    expect(body).toBe(BODY);
    expect(body).not.toContain("[ ]");
    expect(body).not.toContain("[x]");
    expect(VERDICT_TEXT).toEqual({ ready: "Ready to merge", decision: "Needs your decision", "do-not-merge": "Do not merge" });
    // statusTable is the table alone, for `hapi status`.
    expect(statusTable(ROWS)).toBe(TABLE.join("\n"));
  });

  test("a reason can't break the table", () => {
    const row: StatusRow = { state: stateOf({ phase: "failed", reasons: ["a|b\nc"] }), usd: 0, known: true };
    expect(statusTable([row]).split("\n")[2]).toBe("| `0001-skeleton-and-crack-cookie` | failed (`a\\|b c`) | — | — | 0 automatic, 0 rework | $0.00 |");
    // Untrusted text in a code span: no mention, link, HTML or backtick gets out of it; a second reason is counted.
    const loud: StatusRow = { state: stateOf({ phase: "failed", reasons: ["@someone [x](https://e.invalid) <b>`", "two"] }), usd: 0, known: true };
    expect(statusTable([loud]).split("\n")[2]).toBe("| `0001-skeleton-and-crack-cookie` | failed (`someone [x](https://e.invalid) b`, and 1 more) | — | — | 0 automatic, 0 rework | $0.00 |");
  });

  test("the status comment says when decision models are off or give notes only", () => {
    expect(renderStatus(ROWS, CAPS, [], "enforce")).toBe(BODY);
    expect(renderStatus(ROWS, CAPS, [], "off")).toBe(`${BODY}\n\n${OFF}`);
    expect(renderStatus(ROWS, CAPS, [], "notes")).toBe(`${BODY}\n\n${NOTES}`);
  });

  test("a work order that can't run gets a row in a second table", () => {
    const problem = { path: ".factory/work/0004-bad/order.yaml", reason: "invalid YAML: bad | indentation" };
    const cant = ["**Can't run** (fix each in a new planning PR)", "| Work order file | Why |", "|---|---|", "| `.factory/work/0004-bad/order.yaml` | `invalid YAML: bad \\| indentation` |"];
    expect(renderStatus(ROWS, CAPS, [problem], "enforce")).toBe([...HEAD, ...TABLE, "", ...cant, "", TOTAL("1.63")].join("\n"));
    // With no rows, the first table is left out.
    expect(renderStatus([], CAPS, [problem], "enforce")).toBe([...HEAD, ...cant, "", TOTAL("0.00")].join("\n"));
  });

  test("renderFinal counts the settled work orders and the plan's total", () => {
    const rows: StatusRow[] = [
      { state: stateOf({ id: "0001-a", phase: "merged" }), usd: 1.2, known: true },
      { state: stateOf({ id: "0002-b", phase: "closed" }), usd: 0.3, known: true },
      { state: stateOf({ id: "0003-c", phase: "failed" }), usd: 0.034, known: true },
    ];
    expect(renderFinal(rows)).toBe("<!-- hapi:status-final v1 -->\nThis plan has settled: 1 merged, 1 closed, 1 failed. Total: $1.53.");
  });
});

describe("rowsOf", () => {
  /** Run `id` of 0003 with a known spend of `usd`, or none (its outputs missing) at `budgetUsd`. */
  async function run(f: ReturnType<typeof fakeRun>, id: string, o: { usd?: number; budgetUsd?: number }) {
    await seedRun(f, { id, workOrder: "0003-fortune-of-the-day", status: "succeeded", objects: false, kind: "worker", budgetUsd: o.budgetUsd ?? 3, retry: 0 });
    if (o.usd !== undefined) writeOut(f, id, "decisions.jsonl", decisionsOf("done", o.usd));
  }

  test("a work order's decision spend is in its row's cost", async () => {
    const f = fakeRun();
    const engineDir = join(f.tmp, "engine");
    await run(f, "ef56ab12cd34", { usd: 0.4 });
    const s = stateOf({ id: "0003-fortune-of-the-day", runs: ["ef56ab12cd34"], retry: 1 });
    const base = { at: "2026-10-29T10:00:00.000Z", repo: SANDBOX, workOrder: s.id, retry: 1, run: "ef56ab12cd34", head: "c".repeat(40), decision: "diff-screen", version: "v1", subject: "src/a.ts", part: "whole", key: "k1", public: true };
    await appendLedger(ledgerPath(engineDir, SANDBOX, s.id), [
      { ...base, kind: "asking", call: "c1" },
      { ...base, kind: "answer", call: "c1", state_chars: 10, models: "enforce", mode: "enforce", via: "jev", fallback: false, latency_ms: 1, cost_usd: 0.02, verdict: "pass", effect: "pass" },
    ]);
    const [row] = await rowsOf(f.deps.stateDir, [s], 3, engineDir, 0.001, NOW);
    expect([row!.usd.toFixed(4), row!.known]).toEqual(["0.4200", true]);
    const body = renderStatus([ROWS[0]!, ROWS[1]!, row!], CAPS, [], "enforce");
    expect(body).toContain("| `0003-fortune-of-the-day` | queued | `ef56ab12cd34` | — | 0 automatic, 0 rework, retry 1 | $0.42 |");
    expect(body).toContain(TOTAL("1.65"));
  });

  test("an unknown spend shows the budget it counts at", async () => {
    const f = fakeRun();
    await run(f, "ef56ab12cd34", { budgetUsd: 2 });
    const rows = await rowsOf(f.deps.stateDir, [stateOf({ id: "0003-fortune-of-the-day", runs: ["ef56ab12cd34"] })], 3, join(f.tmp, "engine"), 0.001, NOW);
    expect([rows[0]!.usd, rows[0]!.known]).toEqual([2, false]);
    expect(statusTable(rows).split("\n")[2]).toEndWith("| $2.00 (budget: spend unknown) |");
    // A run retention removed counts at runs' run_usd, unknown.
    const gone = await rowsOf(f.deps.stateDir, [stateOf({ runs: ["0a0a0a0a0a0a"] })], 3, join(f.tmp, "engine"), 0.001, NOW);
    expect([gone[0]!.usd, gone[0]!.known]).toEqual([3, false]);
  });
});

describe("upsertStatusComment", () => {
  function world() {
    const ff = planningWorld(SANDBOX);
    const forge = githubForge({ repo: SANDBOX, token: "fake-pr-token", fetch: ff.fetch });
    const f = fakeRun();
    const file = markPath(join(f.tmp, "engine"), SANDBOX, 3);
    let asked = 0;
    const lazy = async () => (asked++, forge);
    return { ff, file, lazy, asked: () => asked };
  }
  const mark = (file: string) => JSON.parse(readFileSync(file, "utf8"));

  test("the status comment is created once, then edited only when its body changes", async () => {
    const w = world();
    expect(await upsertStatusComment(w.lazy, 3, "one", undefined, w.file, false)).toEqual(["created"]);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments"]);
    expect(mark(w.file)).toEqual({ commentId: 1000, sha256: sha256("one"), final: false });
    expect(statSync(w.file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(w.file)).mode & 0o777).toBe(0o700);
    // The same body: no request, and the forge isn't even asked for.
    const calls = w.ff.calls.length;
    const asked = w.asked();
    expect(await upsertStatusComment(w.lazy, 3, "one", undefined, w.file, false)).toEqual([]);
    expect([w.ff.calls.length, w.asked()]).toEqual([calls, asked]);
    // A new body: one PATCH of the same comment.
    expect(await upsertStatusComment(w.lazy, 3, "two", undefined, w.file, false)).toEqual(["edited"]);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments", "PATCH /issues/comments/1000"]);
    expect(mark(w.file)).toEqual({ commentId: 1000, sha256: sha256("two"), final: false });
  });

  test("once every work order has settled, and no problem is open, one final comment is posted, and none again until a work order leaves the settled phases", async () => {
    const w = world();
    await upsertStatusComment(w.lazy, 3, "running", undefined, w.file, false);
    // Every row settled: the status edited, then one final comment.
    expect(await upsertStatusComment(w.lazy, 3, "settled", "FINAL", w.file, true)).toEqual(["edited", "final"]);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments", "PATCH /issues/comments/1000", "POST /issues/3/comments"]);
    expect(w.ff.calls.at(-1)!.body).toEqual({ body: "FINAL" });
    expect(mark(w.file).final).toBe(true);
    // The row back in queued, as hapi retry leaves it: the status edited, no POST, final false, reopened.
    expect(await upsertStatusComment(w.lazy, 3, "queued again", undefined, w.file, false)).toEqual(["edited", "reopened"]);
    expect(writes(w.ff).slice(3)).toEqual(["PATCH /issues/comments/1000"]);
    expect(mark(w.file)).toEqual({ commentId: 1000, sha256: sha256("queued again"), final: false });
    // Settled again: exactly one more final POST.
    expect(await upsertStatusComment(w.lazy, 3, "settled again", "FINAL 2", w.file, true)).toEqual(["edited", "final"]);
    expect(writes(w.ff).slice(4)).toEqual(["PATCH /issues/comments/1000", "POST /issues/3/comments"]);
    // Another tick: none.
    const calls = w.ff.calls.length;
    expect(await upsertStatusComment(w.lazy, 3, "settled again", "FINAL 2", w.file, true)).toEqual([]);
    expect(w.ff.calls.length).toBe(calls);
  });

  test("a problem after the final comment reopens nothing", async () => {
    const w = world();
    await upsertStatusComment(w.lazy, 3, "settled", "FINAL", w.file, true);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments", "POST /issues/3/comments"]);
    // A problem appears (settled, no final body): the status edited, the mark still final, nothing reopened.
    expect(await upsertStatusComment(w.lazy, 3, "settled, a problem", undefined, w.file, true)).toEqual(["edited"]);
    expect(mark(w.file).final).toBe(true);
    // The problem clears: no second final comment.
    expect(await upsertStatusComment(w.lazy, 3, "settled", "FINAL", w.file, true)).toEqual(["edited"]);
    expect(writes(w.ff).filter((x) => x.startsWith("POST"))).toHaveLength(2);
  });

  /** A status body: the hidden marker first, as renderStatus writes it. */
  const B = (t: string) => `<!-- hapi:status v1 -->\n${t}`;

  test("a mark lost after the POST (its write failed) is found again on the PR: the next tick makes no second POST", async () => {
    const w = world();
    // The mark's dir can't be written: the comment is posted, then writing its mark fails.
    mkdirSync(dirname(w.file), { recursive: true, mode: 0o700 });
    chmodSync(dirname(w.file), 0o500);
    await expect(upsertStatusComment(w.lazy, 3, B("one"), undefined, w.file, false)).rejects.toThrow();
    chmodSync(dirname(w.file), 0o700);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments"]);
    // Someone else's comment holding the marker, newer, is never adopted: only the factory App's.
    w.ff.comment(3, STRANGER, B("not ours"));
    w.ff.comment(3, { ...FACTORY_BOT }, B("posted by a user's own hand"), false);
    expect(await upsertStatusComment(w.lazy, 3, B("one"), undefined, w.file, false)).toEqual(["adopted"]);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments"]);
    expect(mark(w.file)).toEqual({ commentId: 1000, sha256: sha256(B("one")), final: false });
    // Found again with a new body: adopted, then edited in place.
    const v = world();
    await upsertStatusComment(v.lazy, 3, B("one"), undefined, v.file, false);
    rmSync(v.file);
    expect(await upsertStatusComment(v.lazy, 3, B("two"), undefined, v.file, false)).toEqual(["adopted", "edited"]);
    expect(writes(v.ff)).toEqual(["POST /issues/3/comments", "PATCH /issues/comments/1000"]);
  });

  test("a lost mark on a plan whose final comment is posted is found again as final: no second final comment", async () => {
    const w = world();
    await upsertStatusComment(w.lazy, 3, B("settled"), "<!-- hapi:status-final v1 -->\nFINAL", w.file, true);
    rmSync(w.file);
    expect(await upsertStatusComment(w.lazy, 3, B("settled"), "<!-- hapi:status-final v1 -->\nFINAL", w.file, true)).toEqual(["adopted"]);
    expect(mark(w.file)).toEqual({ commentId: 1000, sha256: sha256(B("settled")), final: true });
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments", "POST /issues/3/comments"]);
  });

  test("a status comment someone deleted is posted again, not edited forever", async () => {
    const w = world();
    await upsertStatusComment(w.lazy, 3, B("one"), undefined, w.file, false);
    w.ff.removeComment(1000);
    expect(await upsertStatusComment(w.lazy, 3, B("two"), undefined, w.file, false)).toEqual(["created"]);
    expect(writes(w.ff)).toEqual(["POST /issues/3/comments", "PATCH /issues/comments/1000", "POST /issues/3/comments"]);
    expect(mark(w.file)).toEqual({ commentId: 1001, sha256: sha256(B("two")), final: false });
    // And the next edit goes to the new one.
    expect(await upsertStatusComment(w.lazy, 3, B("three"), undefined, w.file, false)).toEqual(["edited"]);
    expect(writes(w.ff).at(-1)).toBe("PATCH /issues/comments/1001");
    // Any other forge error still fails closed, mark kept.
    w.ff.failNext("PATCH", `/repos/${SANDBOX}/issues/comments/1001`, 502);
    await expect(upsertStatusComment(w.lazy, 3, B("four"), undefined, w.file, false)).rejects.toThrow("HTTP 502");
    expect(mark(w.file).commentId).toBe(1001);
  });

  test("a mark that isn't one fails closed, naming the file, and posts nothing", async () => {
    const w = world();
    await upsertStatusComment(w.lazy, 3, "one", undefined, w.file, false);
    writeFileSync(w.file, '{"commentId":"1000"}\n');
    const calls = w.ff.calls.length;
    await expect(upsertStatusComment(w.lazy, 3, "two", undefined, w.file, false)).rejects.toThrow(`${w.file} is not a status mark`);
    expect(w.ff.calls.length).toBe(calls);
  });
});

describe("hapi status", () => {
  /** fakeRun's deps over a policy root registering SANDBOX, and its states written into a temp engineDir. */
  async function seeded(o: { models?: "off" | "notes" } = {}) {
    const f = fakeRun();
    const engineDir = join(f.tmp, "engine");
    await writeState(engineDir, stateOf({ id: "0001-skeleton-and-crack-cookie", phase: "failed", reasons: ["worker run 0a0b0c0d0e0f ended failed: \x1b[2Jpreflight exited 1"] }));
    await writeState(engineDir, stateOf({ id: "0002-search-fortunes", planningPr: 4, phase: "queued" }));
    return { f, engineDir, root: policyRoot(o) };
  }

  test("hapi status prints the rows from local state only, sanitized", async () => {
    const { out } = capture();
    const w = await seeded();
    expect(await statusCommand([SANDBOX], { run: { ...w.f.deps, root: w.root }, engineDir: w.engineDir })).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("\x1b");
    expect(out).toEqual([
      [
        `${SANDBOX} planning PR #3`,
        "| Work order | State | Run | PR | Rounds | Cost |",
        "|---|---|---|---|---|---|",
        "| `0001-skeleton-and-crack-cookie` | failed (`worker run 0a0b0c0d0e0f ended failed: preflight exited 1`) | — | — | 0 automatic, 0 rework | $0.00 |",
        "Total: $0.00",
      ].join("\n"),
      [
        `${SANDBOX} planning PR #4`,
        "| Work order | State | Run | PR | Rounds | Cost |",
        "|---|---|---|---|---|---|",
        "| `0002-search-fortunes` | queued | — | — | 0 automatic, 0 rework | $0.00 |",
        "Total: $0.00",
      ].join("\n"),
    ]);
    // Local state only: no docker, git or sudo, and no forge.
    expect(w.f.calls).toEqual([]);
    // With no repo, every registered repo's; an unregistered one exits 1.
    out.length = 0;
    expect(await statusCommand([], { run: { ...w.f.deps, root: w.root }, engineDir: w.engineDir })).toBe(0);
    expect(out).toHaveLength(2);
    const { err } = capture();
    expect(await statusCommand(["example-owner/nope"], { run: { ...w.f.deps, root: w.root }, engineDir: w.engineDir })).toBe(1);
    expect(err.at(-1)).toBe("hapi status: example-owner/nope isn't registered in policy/repos.yaml");
  });

  test("hapi status ends with the decision-models line when decisions.mode isn't enforce", async () => {
    const { out } = capture();
    const shipped = await seeded();
    expect(await statusCommand([SANDBOX], { run: { ...shipped.f.deps, root: shipped.root }, engineDir: shipped.engineDir })).toBe(0);
    expect(out.join("\n").split("\n").some((l) => l.startsWith("Decision models"))).toBe(false);
    for (const [models, line] of [["off", OFF], ["notes", NOTES]] as const) {
      out.length = 0;
      const w = await seeded({ models });
      expect(await statusCommand([SANDBOX], { run: { ...w.f.deps, root: w.root }, engineDir: w.engineDir })).toBe(0);
      expect(out).toHaveLength(2);
      for (const block of out) expect(block.split("\n").at(-1)).toBe(line);
    }
  });

  test("hapi status counts an unknown spend at the plan's overlay's run_usd, as the comment does", async () => {
    const { out } = capture();
    // A real mirror whose main holds the work order and an overlay lowering run_usd, read with hardened host git.
    const gw = gitWorld();
    const merge = gw.onMain({
      [`.factory/work/${ORDER.id}/order.yaml`]: YAML.stringify(ORDER.workOrder),
      [`.factory/work/${ORDER.id}/task.md`]: ORDER.taskMd,
      ".factory/config.yaml": "budgets:\n  run_usd: 1\n",
    });
    const f = fakeRun();
    // A run retention removed: no record, so it counts at run_usd, unknown.
    const s = stateOf({ repo: ORDER.repo, id: ORDER.id, mergeSha: merge, runs: ["0a0a0a0a0a0a"] });
    await writeState(gw.engineDir, s);
    const run = { ...f.deps, run: runCommand, root: policyRoot({ repos: [ORDER.repo] }) };
    expect(await statusCommand([ORDER.repo], { run, engineDir: gw.engineDir })).toBe(0);
    expect(out[0]).toContain(`| \`${ORDER.id}\` | queued | \`0a0a0a0a0a0a\` | — | 0 automatic, 0 rework | $1.00 (budget: spend unknown) |`);
    // The comment's basis is the same: budgetsOf over the work order's overlay.
    const central = loadPolicy(join(run.root, "policy"));
    const budgets = await budgetsOf(central, s, (id, sha) => readWorkOrder({ run: runCommand, env: f.deps.env, engineDir: gw.engineDir, central }, ORDER.repo, id, sha));
    expect(budgets.run_usd).toBe(1);
    // With no mirror, the central policy's: $3.00.
    out.length = 0;
    const bare = fakeRun();
    const engineDir = join(bare.tmp, "engine");
    await writeState(engineDir, s);
    expect(await statusCommand([ORDER.repo], { run: { ...bare.deps, root: run.root }, engineDir })).toBe(0);
    expect(out[0]).toContain("| $3.00 (budget: spend unknown) |");
    expect(bare.calls).toEqual([]);
  });

  test("with no state, it says so", async () => {
    const { out } = capture();
    const f = fakeRun();
    expect(await statusCommand([], { run: { ...f.deps, root: policyRoot() }, engineDir: join(f.tmp, "engine") })).toBe(0);
    expect(out).toEqual(["hapi status: no work order has a state yet"]);
  });
});
