/**
 * repo.private-untracked (H-058): the checkout tracks nothing under private/,
 * and its root .gitignore ignores private/. git is a fake (helpers.ts), so each
 * test sets what it answers; one test runs the real git against throwaway repos.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultExec, runAudit } from "../../src/audit/index";
import { cleanup, cleanWorld, only, tempDir, type World } from "./helpers";

afterEach(cleanup);

async function check(edit?: (w: World) => void) {
  const w = await cleanWorld();
  edit?.(w);
  return { w, r: only(await runAudit(w.ctx), "repo.private-untracked") };
}

describe("repo.private-untracked", () => {
  test("passes when nothing under private/ is tracked and the root .gitignore ignores it", async () => {
    const { w, r } = await check();
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("tracks nothing under private/");
    // git runs on the audit's root, with the variables that could point it elsewhere unset, and fsmonitor off.
    const gits = w.calls.filter((c) => c[0] === "env" && c.includes("git"));
    expect(gits).toHaveLength(5);
    for (const c of gits) {
      for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) expect(c.join(" ")).toContain(`-u ${v}`);
      expect(c.slice(c.indexOf("git"), c.indexOf("git") + 5)).toEqual(["git", "-C", w.ctx.root, "-c", "core.fsmonitor=false"]);
    }
    for (const c of gits.filter((c) => c.includes("ls-files"))) expect(c).toContain(":(icase)private");
    expect(gits.find((c) => c.includes("--others"))).toContain("--exclude-per-directory=.gitignore");
  });

  test("fails on a tracked file under private/, naming it", async () => {
    const { r } = await check((w) => (w.git.tracked = ["private/secrets.enc.yaml"]));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('it tracks 1 path under private/ ("private/secrets.enc.yaml")');
    expect(r.detail).toContain("git rm -r --cached private");
  });

  test("names at most three tracked paths", async () => {
    const { r } = await check((w) => (w.git.tracked = ["private/a", "private/b", "Private/c", "private/d", "private/e"]));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('it tracks 5 paths under private/ ("private/a", "private/b", "Private/c" and 2 more)');
  });

  test("fails on a file under private/ that git add -A would stage (a partial ignore)", async () => {
    const { r } = await check((w) => (w.git.untracked = ["private/keep"]));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('`git add -A` would stage 1 path under private/ ("private/keep")');
  });

  test("fails when the root .gitignore doesn't ignore private/", async () => {
    const { r } = await check((w) => (w.git.ignoredBy = undefined));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("its root .gitignore doesn't ignore private/");
  });

  test("fails when only a local exclude file ignores private/, since a clone doesn't get it", async () => {
    const { r } = await check((w) => (w.git.ignoredBy = ".git/info/exclude:1:private/"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('private/ is ignored by ".git/info/exclude:1:private/", not a line of the root .gitignore');
  });

  test("fails when the line -v names is a negated pattern", async () => {
    const { r } = await check((w) => (w.git.ignoredBy = ".gitignore:2:!private/"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('".gitignore:2:!private/"');
  });

  test("reports a tracked path and the missing ignore together", async () => {
    const { r } = await check((w) => {
      w.git.tracked = ["private/notes.md"];
      w.git.ignoredBy = undefined;
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("private/notes.md");
    expect(r.detail).toContain("doesn't ignore private/");
  });

  test("fails when the root isn't the checkout's top level", async () => {
    const { r } = await check((w) => (w.git.prefix = "src/"));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain('is "src/" inside its checkout');
  });

  test("fails closed when git fails, naming git's error", async () => {
    const { r } = await check((w) => (w.git.fail = { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("failed (exit 128): fatal: not a git repository");
  });

  test("the real git: pass, a tracked file, and a missing ignore", async () => {
    const exec = defaultExec({ PATH: process.env.PATH, HOME: tempDir("hapi-audit-home-"), GIT_DIR: "/nonexistent" });
    const repo = async (gitignore: string, track?: string) => {
      const root = tempDir("hapi-audit-repo-");
      const git = (...a: string[]) => exec(["env", "-u", "GIT_DIR", "git", "-C", root, ...a]);
      expect((await git("init", "-q")).code).toBe(0);
      writeFileSync(join(root, ".gitignore"), gitignore);
      if (track !== undefined) {
        mkdirSync(join(root, track, ".."), { recursive: true });
        writeFileSync(join(root, track), "x\n");
        expect((await git("add", "-f", track)).code).toBe(0);
      }
      const w = await cleanWorld();
      w.ctx.root = root;
      w.ctx.exec = exec; // GIT_DIR in its env would point git elsewhere; the check unsets it
      return only(await runAudit(w.ctx), "repo.private-untracked");
    };
    expect((await repo("private/\n")).status).toBe("pass");
    const tracked = await repo("private/\n", "private/notes.md");
    expect([tracked.status, tracked.detail.includes('"private/notes.md"')]).toEqual(["fail", true]);
    const unignored = await repo("build/\n");
    expect([unignored.status, unignored.detail.includes("doesn't ignore private/")]).toEqual(["fail", true]);
    // Any case: PRIVATE/ is the same directory on macOS and Windows.
    const upper = await repo("private/\n", "PRIVATE/notes.md");
    expect([upper.status, upper.detail.includes('"PRIVATE/notes.md"')]).toEqual(["fail", true]);
  });

  test("the real git: a partial ignore, a negation, a local-only ignore and a nested repo", async () => {
    const exec = defaultExec({ PATH: process.env.PATH, HOME: tempDir("hapi-audit-home-") });
    const repo = async (setup: (root: string, git: (...a: string[]) => Promise<unknown>) => Promise<void>) => {
      const root = tempDir("hapi-audit-repo-");
      const git = (...a: string[]) => exec(["git", "-C", root, ...a]);
      await git("init", "-q");
      await setup(root, git);
      const w = await cleanWorld();
      w.ctx.root = root;
      w.ctx.exec = exec;
      return only(await runAudit(w.ctx), "repo.private-untracked");
    };
    const withFiles = (gitignore: string, ...files: string[]) => async (root: string) => {
      writeFileSync(join(root, ".gitignore"), gitignore);
      mkdirSync(join(root, "private"), { recursive: true });
      for (const f of files) writeFileSync(join(root, f), "x\n");
    };
    // private/* then !private/keep: check-ignore calls private/ ignored, but git add -A would stage keep.
    const partial = await repo(withFiles("private/*\n!private/keep\n", "private/keep", "private/other"));
    expect([partial.status, partial.detail.includes('"private/keep"'), partial.detail.includes("private/other")]).toEqual(["fail", true, false]);
    const negated = await repo(withFiles("private/\n!private/\n", "private/a"));
    expect(negated.status).toBe("fail");
    const localOnly = await repo(async (root) => {
      await withFiles("build/\n", "private/a")(root);
      writeFileSync(join(root, ".git", "info", "exclude"), "private/\n");
    });
    expect([localOnly.status, localOnly.detail.includes('"private/a"')]).toEqual(["fail", true]);
    // An embedded repo at private/ that isn't ignored would be added as a gitlink.
    const nested = await repo(async (root) => {
      writeFileSync(join(root, ".gitignore"), "build/\n");
      mkdirSync(join(root, "private"));
      await exec(["git", "-C", join(root, "private"), "init", "-q"]);
    });
    expect([nested.status, nested.detail.includes('"private/"')]).toEqual(["fail", true]);
  });
});
