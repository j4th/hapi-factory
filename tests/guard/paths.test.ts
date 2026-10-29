/** Rule 1, H-087 and H-089: hapi-guard's protected paths for write and edit, with Pi's own path resolution. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piResolve, realPath } from "../../src/guard/paths";
import { loadPolicy } from "../../src/policy/load";
import { effectiveModes } from "../../src/policy/paths";
import { cleanupAll, gatesOff, setup } from "./harness";

afterEach(cleanupAll);

const p = loadPolicy("policy");
const vectors = JSON.parse(readFileSync("tests/fixtures/path-vectors.json", "utf8")) as { paths: { path: string; workers: string }[] };

/** effectiveModes' verdict for a worker: blocked unless allow, and blocked when it throws. */
function policyBlocks(path: string): boolean {
  try {
    return effectiveModes(p, path).workers !== "allow";
  } catch {
    return true;
  }
}

async function started() {
  const h = setup({ settings: gatesOff });
  await h.start();
  return h;
}

test("every path vector gives the same verdict as effectiveModes, through write and edit", async () => {
  const h = await started();
  for (const { path, workers } of vectors.paths) {
    expect([path, policyBlocks(path)]).toEqual([path, workers !== "allow"]);
    const w = await h.tool("write", { path, content: "x" });
    const e = await h.tool("edit", { path, edits: [{ oldText: "a", newText: "b" }] });
    expect([path, w?.block === true, e?.block === true]).toEqual([path, policyBlocks(path), policyBlocks(path)]);
  }
});

describe("Pi's own path resolution, mirrored exactly (core/tools/path-utils.js:42-44, utils/paths.js:59-87)", () => {
  test("Unicode spaces become ' ', a leading @ is stripped, ~ and ~/ expand to $HOME, file:// becomes a path, then path.resolve", () => {
    const cwd = "/work/repo";
    expect(piResolve("a b c　.md", cwd, "/home/w")).toBe("/work/repo/a b c .md");
    expect(piResolve("@AGENTS.md", cwd, "/home/w")).toBe("/work/repo/AGENTS.md");
    expect(piResolve("@@x", cwd, "/home/w")).toBe("/work/repo/@x");
    expect(piResolve("~", cwd, "/home/w")).toBe("/home/w");
    expect(piResolve("~/notes", cwd, "/home/w")).toBe("/home/w/notes");
    expect(piResolve("~x/notes", cwd, "/home/w")).toBe("/work/repo/~x/notes");
    expect(piResolve("file:///work/repo/AGENTS.md", cwd, "/home/w")).toBe("/work/repo/AGENTS.md");
    expect(piResolve("docs/../AGENTS.md", cwd, "/home/w")).toBe("/work/repo/AGENTS.md");
    expect(piResolve("/abs/x", cwd, "/home/w")).toBe("/abs/x");
  });

  test("so @AGENTS.md, file:// and a no-break space can't dodge a protected path", async () => {
    const h = await started();
    for (const path of ["@AGENTS.md", `file://${h.work}/AGENTS.md`, "@.github/workflows/ci.yml", ".github/workflows /../ci.yml"]) {
      const r = await h.tool("write", { path, content: "x" });
      expect([path, r?.block]).toEqual([path, true]);
    }
    expect((await h.tool("write", { path: "@README.md", content: "x" }))?.block).toBeUndefined();
  });
});

describe("writes outside the worktree", () => {
  test("write, edit to a protected path block with rule protected-path", async () => {
    const h = await started();
    expect(await h.tool("write", { path: "AGENTS.md", content: "x" })).toEqual({
      block: true,
      reason: "hapi-guard: AGENTS.md is a protected path; workers may not change it (rule protected-path)",
    });
    expect((await h.tool("edit", { path: ".github/workflows/ci.yml", edits: [{ oldText: "a", newText: "b" }] }))?.block).toBe(true);
    const blocks = h.log().filter((r) => r.decision === "block");
    expect(blocks.map((r) => [r.event, r.tool, r.rule, r.path])).toEqual([
      ["tool_call", "write", "protected-path", "AGENTS.md"],
      ["tool_call", "edit", "protected-path", ".github/workflows/ci.yml"],
    ]);
  });

  test("a write outside the worktree blocks unless under /tmp", async () => {
    const h = await started();
    expect(await h.tool("write", { path: "/etc/x", content: "x" })).toEqual({
      block: true,
      reason: "hapi-guard: /etc/x is outside the worktree; workers write only there and under /tmp (rule outside-worktree)",
    });
    expect((await h.tool("write", { path: join(h.home, "x"), content: "x" }))?.block).toBe(true);
    expect((await h.tool("write", { path: "../x", content: "x" }))?.block).toBe(true);
    expect(await h.tool("write", { path: join(h.tmp, "scratch", "x.txt"), content: "x" })).toBeUndefined();
    expect(await h.tool("write", { path: "src/new.ts", content: "x" })).toBeUndefined();
  });

  test("the guard's own ledger under /tmp is not writable by a tool", async () => {
    const h = await started();
    const r = await h.tool("write", { path: join(h.ledgerDir, "x.json"), content: "{}" });
    expect(r).toEqual({ block: true, reason: `hapi-guard: ${join(h.ledgerDir, "x.json")} is hapi-guard's own budget ledger (rule guard-ledger)` });
  });

  test("a symlink inside the worktree pointing at AGENTS.md blocks, dangling or not", async () => {
    const h = await started();
    symlinkSync("AGENTS.md", join(h.work, "link.md")); // dangling: AGENTS.md doesn't exist yet, and write would create it
    expect((await h.tool("write", { path: "link.md", content: "x" }))?.block).toBe(true);
    writeFileSync(join(h.work, "AGENTS.md"), "# agents\n");
    mkdirSync(join(h.work, "docs"));
    symlinkSync("..", join(h.work, "docs", "up"));
    expect((await h.tool("write", { path: "docs/up/AGENTS.md", content: "x" }))?.block).toBe(true);
    symlinkSync(join(h.work, ".github"), join(h.work, "gh"));
    expect((await h.tool("edit", { path: "gh/workflows/ci.yml", edits: [{ oldText: "a", newText: "b" }] }))?.block).toBe(true);
    // A link out of the worktree is outside it.
    symlinkSync("/etc", join(h.work, "etc"));
    expect((await h.tool("write", { path: "etc/passwd", content: "x" }))?.block).toBe(true);
  });

  test("a link target's .. applies after the link is followed, as the kernel does, never lexically (.git/hooks, .github/workflows)", async () => {
    const h = await started();
    mkdirSync(join(h.work, ".git", "objects"), { recursive: true });
    mkdirSync(join(h.work, ".git", "hooks"));
    mkdirSync(join(h.work, ".github", "workflows"), { recursive: true });
    symlinkSync(".git/objects", join(h.work, "a")); // a/.. is .git, not the worktree root
    symlinkSync("a/../hooks/pre-commit", join(h.work, "l")); // dangling: write would create .git/hooks/pre-commit
    symlinkSync(".github/workflows", join(h.work, "b"));
    symlinkSync("b/../workflows/evil.yml", join(h.work, "m"));
    symlinkSync(`${h.work}/a/../hooks/post-commit`, join(h.work, "q")); // an absolute target, unnormalized
    expect(realPath(join(h.work, "l"))).toBe(join(h.work, ".git", "hooks", "pre-commit"));
    expect(realPath(join(h.work, "m"))).toBe(join(h.work, ".github", "workflows", "evil.yml"));
    for (const path of ["l", "m", "q"]) expect([path, (await h.tool("write", { path, content: "x" }))?.block]).toEqual([path, true]);
    expect((await h.tool("edit", { path: "l", edits: [{ oldText: "a", newText: "b" }] }))?.block).toBe(true);
    // The kernel agrees: a write through l lands where realPath said.
    writeFileSync(join(h.work, "l"), "#!/bin/sh\n");
    expect(existsSync(join(h.work, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(existsSync(join(h.work, "hooks"))).toBe(false);
  });

  test("a .. after a component that doesn't exist is blocked: the kernel can't resolve it either", async () => {
    const h = await started();
    symlinkSync("missing/../AGENTS.md", join(h.work, "n"));
    expect(await h.tool("write", { path: "n", content: "x" })).toEqual({
      block: true,
      reason: `hapi-guard: n resolves through ${join(h.work, "missing")}, which doesn't exist, and then "..", so where it lands can't be known (rule invalid-path)`,
    });
  });

  test("a hard link to another file is refused: it may be a protected file under another name", async () => {
    const h = await started();
    writeFileSync(join(h.work, "AGENTS.md"), "# agents\n");
    linkSync(join(h.work, "AGENTS.md"), join(h.work, "notes.md"));
    expect(await h.tool("write", { path: "notes.md", content: "x" })).toEqual({
      block: true,
      reason: "hapi-guard: notes.md has 2 hard links, so it may be a protected file under another name (rule protected-path)",
    });
  });
});

test("**/.git/** blocks, at any depth and in any case (H-182, H-191)", async () => {
  const h = await started();
  for (const path of [".git/config", ".git/hooks/pre-commit", "sub/.git/config", ".GIT/Config", "a/b/.git/worktrees/x/gitdir"]) {
    expect([path, (await h.tool("write", { path, content: "x" }))?.block]).toEqual([path, true]);
  }
  expect((await h.tool("write", { path: ".gitignore", content: "x" }))?.block).toBeUndefined();
});

test("no false positives on case: case-folded AGENTS.MD blocks; README.md allows", async () => {
  const h = await started();
  expect((await h.tool("write", { path: "AGENTS.MD", content: "x" }))?.block).toBe(true);
  expect((await h.tool("write", { path: "pkg/Agents.Md", content: "x" }))?.block).toBe(true);
  expect(await h.tool("write", { path: "README.md", content: "x" })).toBeUndefined();
  expect(await h.tool("write", { path: "docs/agents-guide.md", content: "x" })).toBeUndefined();
});

test("read-only tools are not path-checked: reading AGENTS.md is fine", async () => {
  const h = await started();
  for (const [tool, input] of [["read", { path: "AGENTS.md" }], ["grep", { pattern: "x", path: ".github" }], ["ls", { path: ".git" }], ["find", { pattern: "*.md" }]] as const) {
    expect([tool, await h.tool(tool, input)]).toEqual([tool, undefined]);
  }
});
