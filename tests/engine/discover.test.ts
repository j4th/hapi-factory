/**
 * Discovery (src/engine/discover.ts; design §3.4, §6a item 1; H-183(c)), with real git over a mirror that fetches
 * from a local work repo: each work order on the mirror's main is keyed by the merge commit that first added it, and
 * read at that commit (its order, task.md and the repo's overlay), never at main's head. A bad one is a problem,
 * never a work order, and an id the poller already has state for is never re-keyed. Then the overlap check, which
 * holds two work orders whose pieces' files overlap.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Discovered, type DiscoverDeps, type DiscoverProblem, discoverWorkOrders, overlapProblem, planningPrOf, readWorkOrder } from "../../src/engine/discover";
import { ensureMirror } from "../../src/engine/mirror";
import { loadPolicy } from "../../src/policy/load";
import { overlayFromText } from "../../src/policy/overlay";
import type { Policy } from "../../src/policy/types";
import { runCommand } from "../../src/stack/up";
import { loadWorkOrder, type WorkOrder } from "../../src/workorder/validate";
import { caught, cleanup, tempDir } from "../secrets/helpers";
import { REPO as ROOT } from "../stack/helpers";
import { addOrder, type Git, mergePlanning, toMirror, workRepo } from "./helpers";

afterEach(cleanup);

const REPO = "example-owner/example-repo";
const PATH = process.env.PATH ?? "/usr/bin:/bin";
let central: Policy;
beforeAll(() => {
  central = loadPolicy(join(ROOT, "policy"));
});

/** A work repo, the engine's deps over real git, and the repo's mirror (made, not yet fetched). */
async function world(): Promise<{ git: Git; d: DiscoverDeps; mirror: string }> {
  const tmp = tempDir("hapi-discover-");
  mkdirSync(join(tmp, "work"));
  const git = workRepo(join(tmp, "work"));
  const d: DiscoverDeps = { run: runCommand, env: { PATH }, engineDir: join(tmp, "engine"), central };
  return { git, d, mirror: await ensureMirror(d, REPO) };
}

/** Commit what is staged on a new planning branch, and merge it as PR `pr`; returns the merge's sha. */
function plan(git: Git, branch: string, pr: number, stage: () => void): string {
  git("checkout", "-q", "-b", branch);
  stage();
  git("commit", "-q", "-m", `plan ${branch}`);
  return mergePlanning(git, branch, pr);
}

const discover = async (d: DiscoverDeps, known: ReadonlySet<string> = new Set()) => {
  const problems: DiscoverProblem[] = [];
  const found = await discoverWorkOrders(d, REPO, known, problems);
  return { found, problems };
};

const discovered = (id: string, mergeSha: string, workOrder: WorkOrder): Discovered => ({ repo: REPO, id, mergeSha, workOrder, taskMd: `# ${id}\n`, overlay: undefined });

describe("discovery", () => {
  test("with real git: a work order merged by a planning PR is discovered, keyed by the merge commit", async () => {
    const { git, d, mirror } = await world();
    let path = "";
    const merge = plan(git, "plan/one", 7, () => {
      path = addOrder(git, "0001-one");
    });
    toMirror(git, mirror);
    const { found, problems } = await discover(d);
    expect(found).toEqual([discovered("0001-one", merge, loadWorkOrder(path))]);
    expect(problems).toEqual([]);
    expect(await planningPrOf(d, REPO, merge)).toBe(7);
    expect(await planningPrOf(d, REPO, git("rev-parse", `${merge}^1`))).toBeUndefined();
  });

  test("with real git: one merge carrying two work orders gives two, both keyed by that merge", async () => {
    const { git, d, mirror } = await world();
    const paths: string[] = [];
    const merge = plan(git, "plan/two", 8, () => {
      paths.push(addOrder(git, "0002-b", { pieces: [{ id: "b", files: ["b.md"], size: "small" }] }));
      paths.push(addOrder(git, "0001-a", { pieces: [{ id: "a", files: ["a.md"], size: "small" }] }));
    });
    toMirror(git, mirror);
    const { found, problems } = await discover(d);
    expect(found).toEqual([discovered("0001-a", merge, loadWorkOrder(paths[1]!)), discovered("0002-b", merge, loadWorkOrder(paths[0]!))]);
    expect(problems).toEqual([]);
  });

  test("with real git: a later edit keeps the first-adding merge as the key, and the work order is read at that merge", async () => {
    const { git, d, mirror } = await world();
    let path = "";
    const merge = plan(git, "plan/one", 7, () => {
      path = addOrder(git, "0001-one");
    });
    const original = loadWorkOrder(path);
    addOrder(git, "0001-one", { budget: { usd: 1, turns: 10, minutes: 30 } });
    git("commit", "-q", "-m", "edit 0001-one on main");
    toMirror(git, mirror);
    const { found } = await discover(d);
    expect(found.map((o) => [o.id, o.mergeSha, o.workOrder.budget.usd])).toEqual([["0001-one", merge, 3]]);
    expect(found[0]!.workOrder).toEqual(original);
  });

  test("with real git: a work order deleted from main later is not discovered, but readWorkOrder still rebuilds it at its merge", async () => {
    const { git, d, mirror } = await world();
    let path = "";
    const merge = plan(git, "plan/one", 7, () => {
      path = addOrder(git, "0001-one");
    });
    const want = discovered("0001-one", merge, loadWorkOrder(path));
    git("rm", "-r", "-q", "--", ".factory/work/0001-one");
    git("commit", "-q", "-m", "drop 0001-one");
    toMirror(git, mirror);
    expect(await discover(d)).toEqual({ found: [], problems: [] });
    expect(await readWorkOrder(d, REPO, "0001-one", merge)).toEqual(want);
  });

  test("with real git: a work order deleted and added again keeps the merge that first added it", async () => {
    const { git, d, mirror } = await world();
    let path = "";
    const merge = plan(git, "plan/one", 7, () => {
      path = addOrder(git, "0001-one");
    });
    const want = discovered("0001-one", merge, loadWorkOrder(path));
    git("rm", "-r", "-q", "--", ".factory/work/0001-one");
    git("commit", "-q", "-m", "drop 0001-one");
    const again = plan(git, "plan/again", 9, () => void addOrder(git, "0001-one", { budget: { usd: 1, turns: 10, minutes: 30 } }));
    toMirror(git, mirror);
    const { found } = await discover(d);
    expect(found).toEqual([want]);
    expect(found[0]!.mergeSha).not.toBe(again);
  });

  test("with real git: a force-pushed main doesn't re-key an already-run work order", async () => {
    const { git, d, mirror } = await world();
    const merge = plan(git, "plan/one", 7, () => void addOrder(git, "0001-one"));
    toMirror(git, mirror);
    expect((await discover(d)).found.map((o) => o.mergeSha)).toEqual([merge]);
    git("commit", "-q", "--amend", "-m", "Merge pull request #7 from example-owner/plan/one (rewritten)");
    const rewritten = git("rev-parse", "HEAD");
    expect(rewritten).not.toBe(merge);
    toMirror(git, mirror, true);
    expect(await discover(d, new Set(["0001-one"]))).toEqual({ found: [], problems: [] });
    expect((await discover(d)).found.map((o) => o.mergeSha)).toEqual([rewritten]);
  });

  test("with real git: a malformed order, an id unlike its directory, a missing task.md and a bad overlay are problems, never work orders", async () => {
    const { git, d, mirror } = await world();
    let good = "";
    const first = plan(git, "plan/good", 1, () => {
      good = addOrder(git, "0001-good");
    });
    const bad = plan(git, "plan/bad", 2, () => {
      mkdirSync(join(git.dir, ".factory", "work", "0002-bad"), { recursive: true });
      writeFileSync(join(git.dir, ".factory", "work", "0002-bad", "order.yaml"), "id: [unclosed\n");
      writeFileSync(join(git.dir, ".factory", "work", "0002-bad", "task.md"), "# 0002-bad\n");
      git("add", "--", ".factory/work/0002-bad");
      addOrder(git, "0003-mismatch", { id: "0009-other" });
      addOrder(git, "0004-notask");
      git("rm", "-q", "-f", "--", ".factory/work/0004-notask/task.md");
    });
    const config = "budgets:\n  not_a_budget: 1\n";
    const overlaid = plan(git, "plan/overlay", 3, () => {
      addOrder(git, "0005-overlay");
      writeFileSync(join(git.dir, ".factory", "config.yaml"), config);
      git("add", "--", ".factory/config.yaml");
    });
    toMirror(git, mirror);
    const label = `.factory/config.yaml at ${overlaid.slice(0, 12)}`;
    let overlayReason = "";
    try {
      overlayFromText(config, label);
    } catch (e) {
      overlayReason = (e as Error).message;
    }
    expect(overlayReason.startsWith(`${label}: `)).toBe(true);

    const { found, problems } = await discover(d);
    expect(found).toEqual([discovered("0001-good", first, loadWorkOrder(good))]);
    expect(problems).toEqual([
      { path: ".factory/work/0002-bad/order.yaml", reason: expect.stringMatching(/^invalid YAML: /) },
      { path: ".factory/work/0003-mismatch/order.yaml", reason: "its id is 0009-other, not its directory's name 0003-mismatch" },
      { path: ".factory/work/0004-notask/order.yaml", reason: `no task.md beside it at ${bad.slice(0, 12)}` },
      { path: ".factory/work/0005-overlay/order.yaml", reason: overlayReason },
    ]);
  });

  test("with real git: a symlink where a file must be is not a regular file", async () => {
    const { git, d, mirror } = await world();
    const merge = plan(git, "plan/link", 4, () => {
      addOrder(git, "0006-link");
      git("rm", "-q", "-f", "--", ".factory/work/0006-link/task.md");
      symlinkSync("../../../README.md", join(git.dir, ".factory", "work", "0006-link", "task.md"));
      git("add", "--", ".factory/work/0006-link/task.md");
    });
    toMirror(git, mirror);
    expect(await discover(d)).toEqual({ found: [], problems: [{ path: ".factory/work/0006-link/order.yaml", reason: `.factory/work/0006-link/task.md at ${merge.slice(0, 12)} is not a regular file` }] });
  });

  test("with real git: the overlay comes from the merge commit, not main's head", async () => {
    const { git, d, mirror } = await world();
    plan(git, "plan/one", 7, () => {
      addOrder(git, "0001-one");
      writeFileSync(join(git.dir, ".factory", "config.yaml"), "budgets:\n  run_usd: 2\n");
      git("add", "--", ".factory/config.yaml");
    });
    writeFileSync(join(git.dir, ".factory", "config.yaml"), "budgets:\n  run_usd: 1\n");
    git("commit", "-q", "-am", "lower run_usd on main");
    toMirror(git, mirror);
    const { found, problems } = await discover(d);
    expect(problems).toEqual([]);
    expect(found.map((o) => o.overlay)).toEqual([{ budgets: { run_usd: 2 } }]);
  });

  test("with real git: an overlay that loosens the central policy is a problem, never a work order", async () => {
    const { git, d, mirror } = await world();
    const cap = central.budgets.repo_monthly_usd;
    const merge = plan(git, "plan/one", 7, () => {
      addOrder(git, "0001-one");
      writeFileSync(join(git.dir, ".factory", "config.yaml"), `budgets:\n  repo_monthly_usd: ${cap + 1}\n`);
      git("add", "--", ".factory/config.yaml");
    });
    toMirror(git, mirror);
    const reason = `.factory/config.yaml at ${merge.slice(0, 12)}: /budgets/repo_monthly_usd: raises budgets.repo_monthly_usd from ${cap} to ${cap + 1}; overlays may only tighten policy`;
    expect(await discover(d)).toEqual({ found: [], problems: [{ path: ".factory/work/0001-one/order.yaml", reason }] });
    expect((await caught(readWorkOrder(d, REPO, "0001-one", merge))).message).toBe(reason);
  });

  test("with real git: a mirror with no main says so, and a merge sha that isn't a commit id is refused before git", async () => {
    const { d } = await world();
    expect((await caught(discoverWorkOrders(d, REPO, new Set(), []))).message).toBe("example-owner/example-repo's mirror has no main: fetch it first");
    const seen: string[][] = [];
    const spy: DiscoverDeps = { ...d, run: async (cmd, o) => (seen.push(cmd), runCommand(cmd, o)) };
    expect((await caught(readWorkOrder(spy, REPO, "0001-one", "--output=x"))).message).toBe("not a commit id: --output=x");
    expect((await caught(planningPrOf(spy, REPO, "HEAD"))).message).toBe("not a commit id: HEAD");
    expect(seen).toEqual([]);
  });
});

describe("the overlap check", () => {
  const order = (id: string, ...pieces: string[][]): Discovered => ({
    repo: REPO,
    id,
    mergeSha: "0".repeat(40),
    workOrder: {
      id,
      lane: "direct",
      workflow: "hapi-check-run",
      risk: "low",
      roles: { implement: "small", review: "small" },
      budget: { usd: 3, turns: 10, minutes: 30 },
      pieces: pieces.map((files, i) => ({ id: `piece-${i}`, files, size: "small" })),
      verify: { smoke: false },
      egress_extra: [],
      trace: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      sources: [],
    },
    taskMd: `# ${id}\n`,
    overlay: undefined,
  });
  const how = "merge them into one work order, or plan one after the other merges";

  test("overlapProblem holds both work orders when a piece's files match or nest, in any case", () => {
    expect(overlapProblem([order("0002-b", ["src/tools/**"]), order("0001-a", ["docs/a.md"], ["src/Tools/Crack.ts"])])).toEqual(
      new Map([
        ["0001-a", `overlaps work order 0002-b (src/Tools/Crack.ts and src/tools/**): ${how}`],
        ["0002-b", `overlaps work order 0001-a (src/tools/** and src/Tools/Crack.ts): ${how}`],
      ]),
    );
  });

  test("globs whose literal prefixes don't nest never overlap, a leading wildcard overlaps everything, and pieces of one work order never count", () => {
    expect(overlapProblem([order("0001-a", ["src/a/*.ts"]), order("0002-b", ["src/b.ts"])])).toEqual(new Map());
    expect(overlapProblem([order("0001-a", ["**/*.md"]), order("0002-b", ["docs/x.md"])])).toEqual(
      new Map([
        ["0001-a", `overlaps work order 0002-b (**/*.md and docs/x.md): ${how}`],
        ["0002-b", `overlaps work order 0001-a (docs/x.md and **/*.md): ${how}`],
      ]),
    );
    expect(overlapProblem([order("0001-a", ["README.md"], ["README.md", "src/x.ts"])])).toEqual(new Map());
  });

  test("an order that already has a reason keeps it: the first overlap, in id order, names it", () => {
    const m = overlapProblem([order("0003-c", ["src/x.ts"]), order("0002-b", ["src/**"]), order("0001-a", ["src/x.ts"])]);
    expect(m).toEqual(
      new Map([
        ["0001-a", `overlaps work order 0002-b (src/x.ts and src/**): ${how}`],
        ["0002-b", `overlaps work order 0001-a (src/** and src/x.ts): ${how}`],
        ["0003-c", `overlaps work order 0001-a (src/x.ts and src/x.ts): ${how}`],
      ]),
    );
  });
});
