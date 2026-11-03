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
import { type Discovered, type DiscoverDeps, type DiscoverProblem, discoverWorkOrders, overlapProblem, pinWorkOrder, planningPrOf, readWorkOrder, unpinWorkOrder } from "../../src/engine/discover";
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

  test("with real git: a work-order file over runs.work_order_kb is a problem, refused before it is read, never truncated (H-247)", async () => {
    const { git, d, mirror } = await world();
    const small = structuredClone(central);
    small.runs.work_order_kb = 1;
    const merge = plan(git, "plan/big", 8, () => {
      addOrder(git, "0007-big");
      writeFileSync(join(git.dir, ".factory", "work", "0007-big", "task.md"), `# 0007-big\n\n${"x".repeat(2048)}\n`);
      git("add", "--", ".factory/work/0007-big/task.md");
      addOrder(git, "0008-fine");
    });
    toMirror(git, mirror);
    const reads: string[][] = [];
    const counting: DiscoverDeps = { ...d, central: small, run: (cmd, o) => (reads.push(cmd), d.run(cmd, o)) };
    const problems: DiscoverProblem[] = [];
    const found = await discoverWorkOrders(counting, REPO, new Set(), problems);
    expect(found.map((o) => o.id)).toEqual(["0008-fine"]);
    expect(problems).toEqual([{ path: ".factory/work/0007-big/order.yaml", reason: `.factory/work/0007-big/task.md at ${merge.slice(0, 12)} is 2.0 KiB, over runs.work_order_kb (1 KiB): discovery reads no larger work-order file` }]);
    // Refused from ls-tree -l's size: no blob of 0007-big was read (its order.yaml is read only after every size is checked).
    const blobReads = reads.filter((c) => c.includes("cat-file") && c.includes("blob")).length;
    expect(blobReads).toBe(2);
    // At the shipped 1024 KiB it is read.
    expect((await discover(d)).found.map((o) => o.id)).toEqual(["0007-big", "0008-fine"]);
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

  test("with real git: a mirror with no main says so, and a merge sha or a work-order id that isn't one is refused before git", async () => {
    const { d } = await world();
    expect((await caught(discoverWorkOrders(d, REPO, new Set(), []))).message).toBe("example-owner/example-repo's mirror has no main: fetch it first");
    const seen: string[][] = [];
    const spy: DiscoverDeps = { ...d, run: async (cmd, o) => (seen.push(cmd), runCommand(cmd, o)) };
    const sha = "a".repeat(40);
    expect((await caught(readWorkOrder(spy, REPO, "0001-one", "--output=x"))).message).toBe("not a commit id: --output=x");
    expect((await caught(planningPrOf(spy, REPO, "HEAD"))).message).toBe("not a commit id: HEAD");
    expect((await caught(pinWorkOrder(spy, REPO, "0001-one", "main"))).message).toBe("not a commit id: main");
    for (const id of ["../x", "0001-one/../../x", "-d", `0001-${"a".repeat(80)}`, "0001-x\u001b[31m"]) {
      const want = `not a work-order id: ${id.replace(/[^\x21-\x7e]/g, "?").slice(0, 80)}${id.length > 80 ? "..." : ""}`;
      expect((await caught(readWorkOrder(spy, REPO, id, sha))).message).toBe(want);
      expect((await caught(pinWorkOrder(spy, REPO, id, sha))).message).toBe(want);
      expect((await caught(unpinWorkOrder(spy, REPO, id))).message).toBe(want);
    }
    expect(seen).toEqual([]);
  });

  test("with real git: a directory under .factory/work whose name isn't a work-order id is a problem, shown safe, and git never sees it", async () => {
    const { git, d, mirror } = await world();
    const names = ["Bad Name", "0001-x\u001b[31mred", `0001-${"a".repeat(90)}`];
    plan(git, "plan/names", 5, () => {
      addOrder(git, "0002-good");
      for (const name of names) {
        mkdirSync(join(git.dir, ".factory", "work", name), { recursive: true });
        writeFileSync(join(git.dir, ".factory", "work", name, "order.yaml"), "id: 0001-x\n");
        git("add", "--", `.factory/work/${name}/order.yaml`);
      }
    });
    toMirror(git, mirror);
    const seen: string[][] = [];
    const spy: DiscoverDeps = { ...d, run: async (cmd, o) => (seen.push(cmd), runCommand(cmd, o)) };
    const { found, problems } = await discover(spy);
    expect(found.map((o) => o.id)).toEqual(["0002-good"]);
    const reason = "its directory's name is not a work-order id (four or more digits, a hyphen and a lower-case slug, at most 80 characters)";
    expect(problems).toEqual([
      { path: `.factory/work/0001-${"a".repeat(75)}.../order.yaml`, reason },
      { path: ".factory/work/0001-x?[31mred/order.yaml", reason },
      { path: ".factory/work/Bad?Name/order.yaml", reason },
    ]);
    // Only ls-tree, which lists them, ever sees the names: no log or read is run for one.
    for (const name of names) expect(seen.filter((c) => c.some((a) => a.includes(name)))).toEqual([]);
  });

  test("with real git: a commit that isn't a merge has no planning PR, whatever its subject says", async () => {
    const { git, d, mirror } = await world();
    git("commit", "-q", "--allow-empty", "-m", "Merge pull request #5 from example-owner/plan/fake");
    const fake = git("rev-parse", "HEAD");
    const merge = plan(git, "plan/one", 7, () => void addOrder(git, "0001-one"));
    git("checkout", "-q", "-b", "side", `${merge}^1`);
    git("commit", "-q", "--allow-empty", "-m", "side");
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "Merge pull request #8 from example-owner/side", "side");
    toMirror(git, mirror);
    expect(await planningPrOf(d, REPO, fake)).toBeUndefined();
    expect(await planningPrOf(d, REPO, merge)).toBe(7);
    expect(await planningPrOf(d, REPO, git("rev-parse", "HEAD"))).toBe(8);
  });

  test("with real git: a pinned merge survives a rewrite of main and gc, an unpinned one doesn't, and readWorkOrder says so", async () => {
    const { git, d, mirror } = await world();
    let path = "";
    const merge = plan(git, "plan/one", 7, () => {
      path = addOrder(git, "0001-one");
    });
    toMirror(git, mirror);
    const want = discovered("0001-one", merge, loadWorkOrder(path));
    await pinWorkOrder(d, REPO, "0001-one", merge);
    git("commit", "-q", "--amend", "-m", "Merge pull request #7 from example-owner/plan/one (rewritten)");
    toMirror(git, mirror, true);
    const gc = () => Bun.spawnSync(["git", "--git-dir", mirror, "gc", "--quiet", "--prune=now"], { env: { PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).exitCode;
    expect(gc()).toBe(0);
    expect(await readWorkOrder(d, REPO, "0001-one", merge)).toEqual(want);

    await unpinWorkOrder(d, REPO, "0001-one");
    await unpinWorkOrder(d, REPO, "0001-one"); // a pin that isn't there is no error
    expect(gc()).toBe(0);
    const gone = `${merge.slice(0, 12)} is not in the mirror (main was rewritten and the work order wasn't pinned, or the mirror was deleted)`;
    expect((await caught(readWorkOrder(d, REPO, "0001-one", merge))).message).toBe(gone);
    expect((await caught(pinWorkOrder(d, REPO, "0001-one", merge))).message).toBe(gone);
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

  test("a `.` or empty segment, which the schema accepts, names the same path: ./a, a//b and a/./b", () => {
    for (const [mine, theirs] of [
      ["./src/x.ts", "src/x.ts"],
      ["src//x.ts", "src/x.ts"],
      ["src/./x.ts", "src/x.ts"],
      ["./src/./tools//**", "src/Tools/Crack.ts"],
    ]) {
      expect(overlapProblem([order("0001-a", [mine!]), order("0002-b", [theirs!])])).toEqual(
        new Map([
          ["0001-a", `overlaps work order 0002-b (${mine} and ${theirs}): ${how}`],
          ["0002-b", `overlaps work order 0001-a (${theirs} and ${mine}): ${how}`],
        ]),
      );
    }
    expect(overlapProblem([order("0001-a", ["./src/a/x.ts"]), order("0002-b", ["src//b.ts"])])).toEqual(new Map());
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
