/**
 * .githooks/ (Task 7b Step 5, H-057): the pre-commit hook (gitleaks on the
 * staged changes, then the personal-strings check), the pre-merge-commit hook
 * (the same, for a merge commit) and the commit-msg hook (the personal-strings
 * check on the message). Each test commits in a
 * throwaway repo with the hooks installed (core.hooksPath), its own HOME and no
 * global or system git config. A stub `mise` on PATH runs the gitleaks that
 * mise.toml pins, so the hooks run exactly as they would in a checkout. The
 * personal strings are made up.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const HOOKS = join(REPO, ".githooks");
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

describe("the hook files", () => {
  test("bash parses each (bash -n), and the three hooks are executable", () => {
    for (const f of ["pre-commit", "pre-merge-commit", "commit-msg", "lib.sh"]) {
      const r = Bun.spawnSync(["bash", "-n", join(HOOKS, f)], { stderr: "pipe" });
      expect([f, r.exitCode, r.stderr.toString()]).toEqual([f, 0, ""]);
    }
    for (const f of ["pre-commit", "pre-merge-commit", "commit-msg"]) expect([f, statSync(join(HOOKS, f)).mode & 0o111]).toEqual([f, 0o111]);
  });

  /** A shellcheck that runs (a mise shim with no version set doesn't). */
  const shellcheck = Bun.which("shellcheck") !== null && Bun.spawnSync(["shellcheck", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.skipIf(!shellcheck)("shellcheck finds nothing (when shellcheck is on PATH)", () => {
    // From the repo root: the hooks' `# shellcheck source=.githooks/lib.sh` is relative to it, as scripts/ are.
    const r = Bun.spawnSync(["shellcheck", "-x", ".githooks/pre-commit", ".githooks/pre-merge-commit", ".githooks/commit-msg", ".githooks/lib.sh"], { cwd: REPO, stdout: "pipe" });
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, ""]);
  });
});

/** The gitleaks mise.toml pins, or undefined when mise can't say (the commit tests then skip). */
const gitleaks = (() => {
  const r = Bun.spawnSync(["mise", "which", "gitleaks"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  const path = r.stdout.toString().trim();
  return r.exitCode === 0 && path !== "" ? path : undefined;
})();

const NAME = "Rowan Quillfeather"; // made up
const LOGIN = "rquill-example"; // made up

interface Commit {
  code: number;
  out: string;
}

/** A throwaway repo with the hooks installed; `personal` is private/personal-strings.txt, or null for none. */
/** `mise` is the stub put on PATH: by default it runs the pinned gitleaks. */
function sandbox(personal: string | null = `# names\n${NAME}\n\n${LOGIN}\n`, mise = `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -- ] && [ "$3" = gitleaks ] || exit 127\nshift 3\nexec "${gitleaks}" "$@"\n`) {
  const root = temp("hapi-hooks-repo-");
  const home = temp("hapi-hooks-home-");
  const bin = temp("hapi-hooks-bin-");
  writeFileSync(join(bin, "mise"), mise);
  chmodSync(join(bin, "mise"), 0o755);
  const gitConfig = join(home, "gitconfig");
  writeFileSync(gitConfig, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const gitIn =
    (cwd: string) =>
    (...args: string[]): Commit => {
      const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
  const git = gitIn(root);
  expect(git("init", "-q").code).toBe(0);
  cpSync(HOOKS, join(root, ".githooks"), { recursive: true });
  expect(git("config", "core.hooksPath", ".githooks").code).toBe(0);
  if (personal !== null) {
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", "personal-strings.txt"), personal);
  }
  // The hooks run from the working tree (core.hooksPath); they are never staged here.
  // Linked worktrees go under .worktrees/, which git ignores, as in this repo.
  writeFileSync(join(root, ".gitignore"), `${personal === null ? "" : "private/\n"}.githooks/\n.worktrees/\n`);
  /** Stage these files in the checkout at `cwd` and commit with this message. */
  const commitIn =
    (cwd: string) =>
    (files: Record<string, string>, message = "add files"): Commit => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(cwd, path, ".."), { recursive: true });
        writeFileSync(join(cwd, path), text);
      }
      expect(gitIn(cwd)("add", "-A").code).toBe(0);
      return gitIn(cwd)("commit", "-q", "-m", message);
    };
  /**
   * A linked worktree on a new branch at .worktrees/<name>, with the hooks (git reads a relative core.hooksPath
   * from the worktree's root), or without them: then nothing checks its commits, as in a clone made elsewhere.
   */
  const worktree = (name: string, hooks = true) => {
    const dir = join(root, ".worktrees", name);
    expect(git("worktree", "add", "-q", "-b", name, dir).code).toBe(0);
    if (hooks) cpSync(HOOKS, join(dir, ".githooks"), { recursive: true });
    return { dir, git: gitIn(dir), commit: commitIn(dir) };
  };
  return { root, git, commit: commitIn(root), worktree };
}

describe.skipIf(gitleaks === undefined)("committing with the hooks", () => {
  test("a clean commit goes through", () => {
    const s = sandbox();
    const r = s.commit({ "README.md": "# A project\n\nNothing personal here.\n" });
    expect([r.code, r.out]).toEqual([0, ""]);
  });

  test("a personal string in a staged line stops the commit, in any case, naming the file and line but not the string", () => {
    const s = sandbox();
    const r = s.commit({ "docs/about.md": "# About\n\nWritten by\nrowan QUILLFEATHER, 2026.\n" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("pre-commit: the staged changes hold a personal string");
    expect(r.out).toContain("at docs/about.md:4");
    expect(r.out.toLowerCase()).not.toContain(NAME.toLowerCase());
    expect(s.git("log", "--oneline").out).not.toContain("add files"); // nothing was committed
  });

  test("a personal string in a staged path stops the commit", () => {
    const s = sandbox();
    const r = s.commit({ [`notes/${LOGIN}.md`]: "notes\n" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`in the path notes/${LOGIN}.md`);
  });

  test("a personal string in a binary file stops the commit (a PDF's or an image's metadata)", () => {
    const s = sandbox();
    const r = s.commit({ "scan.pdf": `%PDF-1.7\n\u0000\u0001\u0002\n/Author\u0000${NAME}\u0000\n` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("at scan.pdf:3");
    expect(r.out).not.toContain("null byte"); // bash's warning when it drops a NUL
    expect(r.out.toLowerCase()).not.toContain(NAME.toLowerCase());
  });

  test("a personal string in a file that replaces a symlink stops the commit (a type change)", () => {
    const s = sandbox();
    symlinkSync("README.md", join(s.root, "link.md"));
    expect(s.commit({ "README.md": "# A project\n" }).code).toBe(0);
    rmSync(join(s.root, "link.md"));
    const r = s.commit({ "link.md": `By ${LOGIN}.\n` }, "replace the link");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("at link.md:1");
  });

  test("a personal string in a path git has to quote (a tab or newline in the name) stops the commit", () => {
    for (const sep of ["\t", "\n"]) {
      const s = sandbox();
      const r = s.commit({ [`notes${sep}${LOGIN}.md`]: "notes\n" });
      expect([JSON.stringify(sep), r.code === 0]).toEqual([JSON.stringify(sep), false]);
      expect(r.out).toContain(`${LOGIN}.md`);
    }
  });

  test('an added line that starts with "++ " is still checked (it reads "+++ " in the diff)', () => {
    const s = sandbox();
    const r = s.commit({ "a.txt": `++ ${LOGIN}\n` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("at a.txt:1");
  });

  test("a later line of a changed file is found by its line number", () => {
    const s = sandbox();
    expect(s.commit({ "b.txt": "one\ntwo\nthree\n" }).code).toBe(0);
    const r = s.commit({ "b.txt": `one\ntwo\nthree\nfour ${LOGIN}\n` }, "change b");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("at b.txt:4");
  });

  test("a personal string matches whole words only, so \"Ash\" doesn't stop \"washing\"", () => {
    const s = sandbox("ash\n");
    expect(s.commit({ "j.md": "Washing the dishes; a cashier; an ashtray.\n" }).code).toBe(0);
    const r = s.commit({ "k.md": "Written by Ash.\n" }, "add k");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("at k.md:1");
  });

  test("blank lines and comments in personal-strings.txt match nothing", () => {
    const s = sandbox("# only a comment\n\n   \n");
    const r = s.commit({ "c.txt": "anything at all\n# names\n" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no personal strings to check");
  });

  test("a clone without private/ skips the personal-strings check with a notice", () => {
    const s = sandbox(null);
    const r = s.commit({ "d.txt": `${NAME}\n` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("pre-commit: no personal strings to check (private/personal-strings.txt is missing or empty, as in a fresh clone)");
  });

  test("in a linked worktree, which has no private/, the main checkout's personal strings still apply", () => {
    const s = sandbox();
    expect(s.commit({ "README.md": "# A project\n" }).code).toBe(0); // a worktree needs a commit to branch from
    const wt = s.worktree("plan-x");
    const inFile = wt.commit({ "notes.md": `Written by ${NAME}.\n` });
    expect(inFile.code).not.toBe(0);
    expect(inFile.out).toContain("pre-commit: the staged changes hold a personal string");
    expect(inFile.out).toContain("at notes.md:1");
    expect(inFile.out).not.toContain("no personal strings to check");
    const inMessage = wt.commit({ "notes.md": "Written by the operator.\n" }, `Add notes\n\nThanks to ${LOGIN}.`);
    expect(inMessage.code).not.toBe(0);
    expect(inMessage.out).toContain("commit-msg: the commit message holds a personal string");
    expect(wt.commit({}, "Add notes").code).toBe(0);
  });

  test("a merge commit gets pre-commit's checks on what it merges (pre-merge-commit)", () => {
    const s = sandbox();
    expect(s.commit({ "README.md": "# A project\n" }).code).toBe(0);
    const side = s.worktree("side", false); // a branch committed with no hooks
    expect(side.commit({ "side.md": `By ${NAME}.\n` }).code).toBe(0);
    expect(s.commit({ "main.md": "main\n" }, "Add main").code).toBe(0); // so the merge can't fast-forward
    const r = s.git("merge", "--no-ff", "-q", "-m", "Merge side", "side");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("pre-commit: the staged changes hold a personal string");
    expect(r.out).toContain("at side.md:1");
    expect(r.out.toLowerCase()).not.toContain(NAME.toLowerCase());
    expect(s.git("log", "--oneline").out).not.toContain("Merge side");
    // The control: a clean branch merges.
    const t = sandbox();
    expect(t.commit({ "README.md": "# A project\n" }).code).toBe(0);
    expect(t.worktree("side", false).commit({ "side.md": "By the operator.\n" }).code).toBe(0);
    expect(t.commit({ "main.md": "main\n" }, "Add main").code).toBe(0);
    expect(t.git("merge", "--no-ff", "-q", "-m", "Merge side", "side").code).toBe(0);
    expect(t.git("log", "--oneline").out).toContain("Merge side");
  });

  test("a personal string in the commit message stops the commit, naming the line but not the string", () => {
    const s = sandbox();
    const r = s.commit({ "e.txt": "e\n" }, `Add e\n\nThanks to ${NAME.toUpperCase()}.`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("commit-msg: the commit message holds a personal string from private/personal-strings.txt, on line 3.");
    expect(r.out.toLowerCase()).not.toContain(NAME.toLowerCase());
    expect(s.commit({ "f.txt": "f\n" }, "Add f").code).toBe(0);
  });

  test('a "#" line of a -m message counts, since git keeps it; the diff under the scissors line doesn\'t', () => {
    const s = sandbox();
    expect(s.commit({ "h.txt": "h\n" }, `Add h\n# ${LOGIN}`).code).not.toBe(0);
    const scissors = `Add i\n# ------------------------ >8 ------------------------\n+${LOGIN}\n`;
    expect(s.commit({ "i.txt": "i\n" }, scissors).code).toBe(0);
  });

  test("a secret in the staged changes stops the commit, and gitleaks's output is redacted", () => {
    const s = sandbox();
    // A GitHub token shape, built at run time so no scan of this repo flags this file.
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const token = `ghp_${[...randomBytes(36)].map((b) => alnum[b % alnum.length]).join("")}`;
    const r = s.commit({ "config.env": `GITHUB_TOKEN=${token}\n` });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("pre-commit: gitleaks found a possible secret in the staged changes");
    expect(r.out).not.toContain(token);
  });

  test("a gitleaks that can't run stops the commit", () => {
    const s = sandbox(null, "#!/bin/sh\necho 'mise: gitleaks is not installed' >&2\nexit 3\n");
    const r = s.commit({ "g.txt": "g\n" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("pre-commit: gitleaks could not run (exit 3), so the commit is stopped");
  });
});
