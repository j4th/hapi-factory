import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutProblem, envFileText, isWithin, ORPHAN_AGE_MS, parseEnvFile, repoRoots, runtimeDir, secureDir, writeNewSecretFile, writeSecretFile, writeSecretFiles } from "../../src/secrets/files";

const FAKE = "fake-secret-value-7f3a";

let temps: string[] = [];
afterEach(() => {
  for (const d of temps) {
    chmodSync(d, 0o700);
    rmSync(d, { recursive: true, force: true });
  }
  temps = [];
});
/** A fresh directory like $XDG_RUNTIME_DIR: ours, mode 0700 (mkdtemp's mode). */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-files-"));
  temps.push(dir);
  return dir;
}
const mode = (path: string) => statSync(path).mode & 0o777;
const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

describe("env files", () => {
  test("envFileText writes NAME='value' lines under a comment header, sorted by name, and parseEnvFile reads them back", () => {
    const text = envFileText("hermes", { SLACK_BOT_TOKEN: "b", ANTHROPIC_API_KEY: "a\nb" });
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("ANTHROPIC_API_KEY='a\nb'\nSLACK_BOT_TOKEN='b'\n");
    expect(parseEnvFile(text)).toEqual({ ANTHROPIC_API_KEY: "a\nb", SLACK_BOT_TOKEN: "b" });
  });

  test("envFileText refuses a value with a single quote or NUL, or ending in a backslash, naming the key, never the value", () => {
    expect(() => envFileText("archon", { OPENCODE_API_KEY: `${FAKE}'x` })).toThrow(/archon\/OPENCODE_API_KEY: .*single quote/);
    expect(() => envFileText("archon", { OPENCODE_API_KEY: `${FAKE}\0` })).toThrow(/archon\/OPENCODE_API_KEY: .*NUL/);
    // Compose's dotenv parser takes \' as an escaped quote even inside single quotes, so NAME='abc\' would run on to the next line.
    expect(() => envFileText("archon", { OPENCODE_API_KEY: `${FAKE}\\` })).toThrow(/archon\/OPENCODE_API_KEY: the value ends in a backslash \(\\\), which Compose would take as escaping the closing quote/);
    for (const bad of [`${FAKE}'x`, `${FAKE}\0`, `${FAKE}\\`]) {
      try {
        envFileText("archon", { OPENCODE_API_KEY: bad });
      } catch (e) {
        expect((e as Error).message).not.toContain(FAKE);
      }
    }
    // A backslash anywhere else arrives as stored.
    const text = envFileText("archon", { OPENCODE_API_KEY: "a\\b\\\\c\\\nd" });
    expect(parseEnvFile(text)).toEqual({ OPENCODE_API_KEY: "a\\b\\\\c\\\nd" });
  });

  test("parseEnvFile refuses anything but comments, blank lines and NAME='value', and never echoes the file", () => {
    for (const bad of [`A=${FAKE}\n`, `A='${FAKE}`, `A='x' ${FAKE}\n`, `A='x'\nA='y'\n`, `a='${FAKE}'\n`]) {
      let message = "";
      try {
        parseEnvFile(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/env file/);
      expect(message).not.toContain(FAKE);
    }
  });
});

describe("writeSecretFile", () => {
  test("writes one file with mode 0600, replaces an existing one in one step, and leaves no temp file", async () => {
    const dir = tempDir();
    const file = join(dir, "a.token");
    await writeSecretFile(file, "old\n");
    await writeSecretFile(file, "new\n");
    expect(readFileSync(file, "utf8")).toBe("new\n");
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["a.token"]);
  });

  test("a failed write leaves no temp file", async () => {
    const dir = tempDir();
    await expect(writeSecretFile(join(dir, "missing", "a.token"), "x")).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("writeNewSecretFile: no-replace", () => {
  test("writes a new file 0600 through link(), and never replaces one that exists, even one that appears after a check", async () => {
    const dir = tempDir();
    const file = join(dir, "secrets.enc.yaml");
    await writeNewSecretFile(file, "first\n");
    expect([readFileSync(file, "utf8"), mode(file)]).toEqual(["first\n", 0o600]);
    const e = await caught(writeNewSecretFile(file, "second\n"));
    expect((e as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(readFileSync(file, "utf8")).toBe("first\n");
    // A symlink there counts as existing too: link() never follows or replaces it.
    symlinkSync(join(dir, "elsewhere"), join(dir, "link"));
    await expect(writeNewSecretFile(join(dir, "link"), "x")).rejects.toThrow();
    expect(existsSync(join(dir, "elsewhere"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["link", "secrets.enc.yaml"]);
  });
});

describe("writeSecretFiles: the whole set at once", () => {
  test("writes every file 0600 into a fresh 0700 generation directory and points the env symlink at it", async () => {
    const base = tempDir();
    const link = join(base, "env");
    const paths = await writeSecretFiles(link, { "a.env": "A='1'\n", "b.env": "B='2'\n" });
    expect(paths).toEqual([join(link, "a.env"), join(link, "b.env")]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    // A relative target: the generation directory beside the link.
    const target = readlinkSync(link);
    expect(target).toMatch(/^env\.[0-9a-f-]{36}$/);
    expect(mode(join(base, target))).toBe(0o700);
    expect(readdirSync(link).sort()).toEqual(["a.env", "b.env"]);
    for (const p of paths) expect(mode(p)).toBe(0o600);
    expect(readFileSync(join(link, "b.env"), "utf8")).toBe("B='2'\n");
    // Nothing else is left beside it: no temp link, no other generation.
    expect(readdirSync(base).sort()).toEqual(["env", target].sort());
  });

  test("writeSecretFiles swaps the whole set and drops stale zone files", async () => {
    const base = tempDir();
    const link = join(base, "env");
    await writeSecretFiles(link, { "hermes.env": "A='old'\n", "research.env": "B='old'\n" });
    const oldGeneration = realpathSync(link);
    await writeSecretFiles(link, { "hermes.env": "A='new'\n" });
    // The new set only: a zone file dropped from the manifest is gone with the old generation.
    expect(readdirSync(link)).toEqual(["hermes.env"]);
    expect(readFileSync(join(link, "hermes.env"), "utf8")).toBe("A='new'\n");
    expect(existsSync(oldGeneration)).toBe(false);
    expect(readdirSync(base).length).toBe(2); // the link and one generation
  });

  test("if any file can't be written, the old set stays in place and nothing new is left behind", async () => {
    const base = tempDir();
    const link = join(base, "env");
    await writeSecretFiles(link, { "hermes.env": "A='old'\n" });
    const before = readdirSync(base).sort();
    for (const bad of ["../escape.env", "sub/x.env", ".", ""]) {
      await expect(writeSecretFiles(link, { "hermes.env": "A='new'\n", [bad]: "x" })).rejects.toThrow();
    }
    expect(readdirSync(base).sort()).toEqual(before);
    expect(readFileSync(join(link, "hermes.env"), "utf8")).toBe("A='old'\n");
  });

  test("an env path that is a real directory or file, not hapi's symlink, is refused and left alone", async () => {
    const base = tempDir();
    const link = join(base, "env");
    mkdirSync(link);
    writeFileSync(join(link, "keep"), "x");
    const e = await caught(writeSecretFiles(link, { "hermes.env": "A='1'\n" }));
    expect(e.message).toMatch(/not hapi's symlink/);
    expect(readdirSync(link)).toEqual(["keep"]);
    expect(readdirSync(base)).toEqual(["env"]);
  });

  /** Make `dir` look `ms` old, as a generation a crash left behind a while ago. */
  const age = (dir: string, ms: number) => utimesSync(dir, new Date(Date.now() - ms), new Date(Date.now() - ms));
  const generations = (base: string) => readdirSync(base).filter((n) => /^env\.[0-9a-f-]{36}$/.test(n)).sort();

  test("writeSecretFiles removes Task 4-era zone files and orphaned generations", async () => {
    const base = tempDir();
    const link = join(base, "env");
    // Task 4 wrote $XDG_RUNTIME_DIR/hapi/<zone>.env directly; a crash can leave a generation the link doesn't point at.
    for (const z of ["hermes", "archon", "research", "host"]) writeFileSync(join(base, `${z}.env`), `A='${FAKE}'\n`, { mode: 0o600 });
    const orphan = join(base, "env.0b6c1c9e-5a8e-4a43-9d1e-2d6f8c2a1b3c");
    mkdirSync(orphan, { mode: 0o700 });
    writeFileSync(join(orphan, "hermes.env"), `A='${FAKE}'\n`);
    age(orphan, ORPHAN_AGE_MS + 60_000);
    // Not ours: a directory that isn't a generation, a symlink with a zone file's name, and a file of another name.
    mkdirSync(join(base, "env.not-a-generation"));
    symlinkSync(join(base, "keep-target"), join(base, "slack.env"));
    writeFileSync(join(base, "notes.txt"), "keep\n");
    await writeSecretFiles(link, { "hermes.env": "A='new'\n" }, { legacy: ["hermes.env", "archon.env", "research.env", "host.env", "slack.env"] });
    expect(readdirSync(base).sort()).toEqual(["env", readlinkSync(link), "env.not-a-generation", "notes.txt", "slack.env"].sort());
    expect(readFileSync(join(link, "hermes.env"), "utf8")).toBe("A='new'\n");
    // And it is idempotent: a second write leaves one generation (the one it replaced goes at once, however young).
    await writeSecretFiles(link, { "hermes.env": "A='newer'\n" }, { legacy: ["hermes.env"] });
    expect(generations(base)).toEqual([readlinkSync(link)]);
  });

  test("a generation the link doesn't point at is left alone until it is a minute old: a concurrent resolve may still be writing it", async () => {
    expect(ORPHAN_AGE_MS).toBe(60_000);
    const base = tempDir();
    const link = join(base, "env");
    await writeSecretFiles(link, { "hermes.env": "A='1'\n" });
    const replaced = readlinkSync(link);
    // Another resolve's generation, mid-write: not linked yet, and fresh.
    const inFlight = join(base, "env.1a2b3c4d-0000-4000-8000-000000000001");
    mkdirSync(inFlight, { mode: 0o700 });
    writeFileSync(join(inFlight, "hermes.env"), "A='other'\n", { mode: 0o600 });
    // One a crash left, 59 seconds ago: still possibly in flight, so kept too.
    const recent = join(base, "env.1a2b3c4d-0000-4000-8000-000000000002");
    mkdirSync(recent, { mode: 0o700 });
    age(recent, ORPHAN_AGE_MS - 1000);
    await writeSecretFiles(link, { "hermes.env": "A='2'\n" });
    // The generation it replaced is gone at once; the young ones stay, intact.
    expect(existsSync(join(base, replaced))).toBe(false);
    expect(generations(base)).toEqual([readlinkSync(link), "env.1a2b3c4d-0000-4000-8000-000000000001", "env.1a2b3c4d-0000-4000-8000-000000000002"].sort());
    expect(readFileSync(join(inFlight, "hermes.env"), "utf8")).toBe("A='other'\n");
    // Once they are more than a minute old, the next write removes them.
    age(inFlight, ORPHAN_AGE_MS + 1000);
    age(recent, ORPHAN_AGE_MS + 1000);
    await writeSecretFiles(link, { "hermes.env": "A='3'\n" });
    expect(generations(base)).toEqual([readlinkSync(link)]);
  });

  test("concurrent writes never delete each other's generation: every one resolves, and env points at a whole set", async () => {
    const base = tempDir();
    const link = join(base, "env");
    await writeSecretFiles(link, { "hermes.env": "A='0'\n", "host.env": "H='0'\n" });
    const runs = Array.from({ length: 8 }, (_, i) => writeSecretFiles(link, { "hermes.env": `A='${i + 1}'\n`, "host.env": `H='${i + 1}'\n` }));
    expect((await Promise.allSettled(runs)).map((r) => r.status)).toEqual(Array(8).fill("fulfilled"));
    // Whichever swapped last, its set is whole: no dangling link, no mix.
    const [a, h] = ["hermes.env", "host.env"].map((f) => readFileSync(join(link, f), "utf8"));
    expect(a!.slice(3, -2)).toBe(h!.slice(3, -2));
    expect(readdirSync(link).sort()).toEqual(["hermes.env", "host.env"]);
  });

  test("an entry that vanishes during the cleanup (a concurrent resolve removed it) doesn't fail a write that already swapped", async () => {
    const base = tempDir();
    const link = join(base, "env");
    const orphan = join(base, "env.1a2b3c4d-0000-4000-8000-000000000003");
    mkdirSync(orphan, { mode: 0o700 });
    age(orphan, ORPHAN_AGE_MS + 60_000);
    const realLstat = fsp.lstat;
    let vanished = false;
    // Between the cleanup's readdir and its lstat, another resolve removes the orphan.
    const spy = spyOn(fsp, "lstat").mockImplementation((async (path: string, ...rest: unknown[]) => {
      if (path === orphan) {
        rmSync(orphan, { recursive: true, force: true });
        vanished = true;
      }
      return (realLstat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof fsp.lstat);
    try {
      await writeSecretFiles(link, { "hermes.env": "A='1'\n" });
    } finally {
      spy.mockRestore();
    }
    expect(vanished).toBe(true);
    expect(readFileSync(join(link, "hermes.env"), "utf8")).toBe("A='1'\n");
    expect(existsSync(orphan)).toBe(false);
  });

  test("an old target that isn't one of hapi's generation directories is never deleted", async () => {
    const base = tempDir();
    const other = join(base, "someone-elses");
    mkdirSync(other);
    symlinkSync("someone-elses", join(base, "env"));
    await writeSecretFiles(join(base, "env"), { "hermes.env": "A='1'\n" });
    expect(existsSync(other)).toBe(true);
  });
});

describe("secureDir", () => {
  test("makes the directory 0700 under the runtime root; tightens a looser one; refuses a symlink", async () => {
    const xdg = tempDir();
    const dir = join(xdg, "hapi");
    await secureDir(dir, xdg);
    expect(mode(dir)).toBe(0o700);
    chmodSync(dir, 0o755);
    await secureDir(dir, xdg);
    expect(mode(dir)).toBe(0o700);
    const link = join(xdg, "link");
    symlinkSync(dir, link);
    await expect(secureDir(link, xdg)).rejects.toThrow(/not a directory/);
  });

  test("secureDir refuses an XDG_RUNTIME_DIR not owned by us or not 0700", async () => {
    const xdg = tempDir();
    chmodSync(xdg, 0o755);
    await expect(secureDir(join(xdg, "hapi"), xdg)).rejects.toThrow(/XDG_RUNTIME_DIR .* mode 0755, not 0700/);
    expect(existsSync(join(xdg, "hapi"))).toBe(false);
    chmodSync(xdg, 0o700);
    const uid = process.getuid!();
    await expect(secureDir(join(xdg, "hapi"), xdg, { uid: uid + 1 })).rejects.toThrow(/XDG_RUNTIME_DIR .* is owned by uid/);
    expect(existsSync(join(xdg, "hapi"))).toBe(false);
    // It must exist (systemd makes it), and be a real directory.
    await expect(secureDir(join(xdg, "nope", "hapi"), join(xdg, "nope"))).rejects.toThrow(/XDG_RUNTIME_DIR .* does not exist/);
    symlinkSync(xdg, join(xdg, "alias"));
    await expect(secureDir(join(xdg, "alias", "hapi"), join(xdg, "alias"))).rejects.toThrow(/XDG_RUNTIME_DIR .* not a directory/);
    // And the directory must be under it.
    await expect(secureDir(tempDir(), xdg)).rejects.toThrow(/not under/);
  });
});

describe("runtimeDir", () => {
  test("is $XDG_RUNTIME_DIR/hapi, and there is no fallback", () => {
    expect(runtimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/hapi");
    expect(() => runtimeDir({})).toThrow(/XDG_RUNTIME_DIR is not set/);
    expect(() => runtimeDir({ XDG_RUNTIME_DIR: "" })).toThrow(/XDG_RUNTIME_DIR is not set/);
    expect(() => runtimeDir({ XDG_RUNTIME_DIR: "run/user/1000" })).toThrow(/XDG_RUNTIME_DIR must be an absolute path/);
  });
});

describe("isWithin and checkoutProblem: the inside-the-checkout boundary", () => {
  test("a first segment that merely starts with \"..\" is inside; only \"..\" itself or \"../\" leaves", () => {
    const repo = "/srv/example-owner/hapi-factory";
    for (const p of [repo, `${repo}/keys.txt`, `${repo}/private/keys.txt`, `${repo}/..private/keys.txt`, `${repo}/..agekey`, `${repo}/..plain/secrets.env`, `${repo}/...`]) {
      expect([p, isWithin(p, repo)]).toEqual([p, true]);
    }
    for (const p of ["/srv/example-owner", "/srv/example-owner/hapi-factory-other/keys.txt", "/srv/example-owner/..hapi-factory/keys.txt", "/elsewhere/keys.txt", "/"]) {
      expect([p, isWithin(p, repo)]).toEqual([p, false]);
    }
  });

  test("checkoutProblem refuses \"..x\" names under the checkout, existing or not, and accepts a sibling", async () => {
    const repo = tempDir();
    mkdirSync(join(repo, "..keys"));
    writeFileSync(join(repo, "..keys", "age.txt"), "# not a real age key\n", { mode: 0o600 });
    for (const rel of [join("..keys", "age.txt"), join("..private", "keys.txt"), "..agekey", join("..plain", "secrets.env")]) {
      expect(await checkoutProblem(join(repo, rel), repo)).toMatch(/inside the hapi-factory checkout/);
    }
    const outside = tempDir();
    expect(await checkoutProblem(join(outside, "..agekey"), repo)).toBeUndefined();
    expect(await checkoutProblem(`${repo}-sibling/keys.txt`, repo)).toBeUndefined();
  });
});

describe("the checkout boundary", () => {
  /** Run git quietly, with no user config, in `cwd`. */
  function git(cwd: string, ...args: string[]) {
    const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "init.defaultBranch=main", ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }

  test("defaultRepoRoot covers the main worktree from a linked worktree and ignores GIT_DIR/GIT_WORK_TREE", async () => {
    const dir = realpathSync(tempDir());
    const main = join(dir, "main");
    mkdirSync(main);
    git(main, "init", "-q");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "worktree", "add", "-q", join(main, ".worktrees", "task"));
    const wt = join(main, ".worktrees", "task");
    mkdirSync(join(wt, "src"));
    const decoy = join(dir, "decoy");
    mkdirSync(decoy);
    git(decoy, "init", "-q");
    // GIT_DIR and GIT_WORK_TREE from the caller's shell would point git elsewhere: they are cleared.
    const env = { PATH: process.env.PATH, HOME: dir, GIT_DIR: join(decoy, ".git"), GIT_WORK_TREE: decoy, GIT_CONFIG_GLOBAL: "/dev/null" };
    expect(await repoRoots({ cwd: join(wt, "src"), env })).toEqual([wt, main]);
    expect(await repoRoots({ cwd: main, env })).toEqual([main]);
    // So private/ in the main worktree is inside the checkout, even when hapi runs from the linked one.
    expect(await checkoutProblem(join(main, "private", "keys.txt"), [wt, main])).toMatch(/inside the hapi-factory checkout/);
    expect(await checkoutProblem(join(dir, "elsewhere", "keys.txt"), [wt, main])).toBeUndefined();
  });

  test("repoRoots fails closed when git can't say: never a guessed boundary", async () => {
    const dir = realpathSync(tempDir());
    // Not a checkout at all.
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dir };
    // (GIT_* is cleared for git, so the ceiling can't help it; /tmp is no checkout either way.)
    await expect(repoRoots({ cwd: plain, env })).rejects.toThrow(/^`git rev-parse --show-toplevel` in .*plain failed \(exit 128\): fatal: not a git repository/);
    // The hapi user running from another user's checkout: git refuses with "dubious ownership" (a fake git here, which says so).
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const fakeGit = (script: string) => writeFileSync(join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    fakeGit(`echo "fatal: detected dubious ownership in repository at '/srv/other-user/hapi-factory'" >&2\nexit 128`);
    const e = await caught(repoRoots({ cwd: plain, env: { PATH: bin } }));
    expect(e.message).toBe(
      `\`git rev-parse --show-toplevel\` in ${plain} failed (exit 128): fatal: detected dubious ownership in repository at '/srv/other-user/hapi-factory'. ` +
        "hapi needs it to find the hapi-factory checkout that age keys and plaintext must stay out of, and won't guess. " +
        "For \"dubious ownership\", run hapi as the user that owns the checkout (git's safe.directory explains the check)",
    );
    // The worktree's top level, but not the main worktree (a broken linked worktree, say): still an error, not a one-root boundary.
    fakeGit(`case "$*" in *show-toplevel*) echo /srv/checkout/.worktrees/task;; *) echo "fatal: not a git repository: /srv/checkout/.git/worktrees/task" >&2; exit 128;; esac`);
    await expect(repoRoots({ cwd: plain, env: { PATH: bin } })).rejects.toThrow(/^`git rev-parse --path-format=absolute --git-common-dir` in .* failed \(exit 128\): fatal: not a git repository/);
    // git printing something that isn't one absolute path, or no git at all.
    fakeGit("echo relative/path");
    await expect(repoRoots({ cwd: plain, env: { PATH: bin } })).rejects.toThrow(/--show-toplevel` in .* printed no absolute path\. hapi needs it/);
    await expect(repoRoots({ cwd: plain, env: { PATH: join(dir, "no-bin") } })).rejects.toThrow(/^cannot run `git rev-parse --show-toplevel` in .*: is git installed\?/);
  });
});
