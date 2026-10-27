/**
 * Root never acts on a path inside hapi's home (docs/runbooks/stack.md#hardening).
 * hapi runs the agent stack, so it is less trusted than root, and may have
 * planted a symlink anywhere in its home; root writing, creating, chowning or
 * chmodding a path there would follow it (`~/.bashrc -> /etc/sudoers`). So
 * every change there is made by a process running as hapi, which root only
 * hands bytes to.
 *
 * Statically: the scripts' root-side code (everything but the snippets they
 * hand to hapi's sh) names no path in hapi's home and runs no command that
 * writes or changes one; and no doc tells the operator to run such a command
 * with sudo. Then the snippets hapi runs are run here, as this user, in a temp
 * HOME, to show they do what the scripts rely on: a fresh directory or nothing,
 * a binary renamed into place, one activate line. scripts/host-setup.sh itself
 * is never run (it needs root and creates a user).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const HOST_SETUP = join(REPO, "scripts", "host-setup.sh");
const COPY_SECRETS = join(REPO, "scripts", "copy-secrets-to-hapi.sh");
/** The docs that tell the operator what to run. */
const DOCS = ["README.md", "docs/secrets.md", ...readdirSync(join(REPO, "docs", "runbooks")).map((f) => `docs/runbooks/${f}`)];

let temps: string[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "hapi-home-test-"));
  temps.push(d);
  return d;
};

/** The single-quoted scripts a shell script hands to hapi's sh: as_hapi_sh's first argument, or `sudo -u "$HAPI_USER" -H -- sh -c '...'`. */
const SNIPPET = /(as_hapi_sh |sudo -u "\$HAPI_USER" -H -- sh -c )'([^']*)'/g;
const snippets = (file: string) => [...readFileSync(file, "utf8").matchAll(SNIPPET)].map((m) => m[2]!);

/**
 * A script's root-side code: comment lines dropped, every snippet hapi runs replaced by a placeholder, and any
 * other single-quoted word (an awk program, a format string) emptied, since the shell doesn't read it.
 */
function rootCode(file: string): string[] {
  return readFileSync(file, "utf8")
    .replace(SNIPPET, "$1RUN_AS_HAPI")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .map((l) => l.replace(/'[^'\n]*'/g, "''"));
}

/** A path inside hapi's home, written absolutely (relative paths only appear in what hapi runs). */
const HAPI_HOME = /\/home\/(hapi|\$HAPI_USER|\$\{HAPI_USER\})\b|~(hapi|\$HAPI_USER)\b/;
/** Commands that write, create or change a path, at command position, plus append and file redirections. */
const MUTATES = /(^|[;&|(]|&&|\|\||\bsudo\s+|\bthen\s+|\bdo\s+)\s*(install|chown|chgrp|chmod|mkdir|touch|tee|ln|cp|mv|rsync)\s/;
const REDIRECT_TO_FILE = /(?<![<>&0-9-])\d?>{1,2}\s*(?!&|\/dev\/null\b)[^\s;|&)]/;

describe("the scripts' root-side code never acts on hapi's home", () => {
  for (const file of [HOST_SETUP, COPY_SECRETS]) {
    const name = file.slice(REPO.length + 1);
    test(`${name}: no path in hapi's home, and no command that writes or changes one, outside what hapi runs`, () => {
      const code = rootCode(file);
      expect(code.filter((l) => HAPI_HOME.test(l))).toEqual([]);
      expect(code.filter((l) => MUTATES.test(l))).toEqual([]);
      expect(code.filter((l) => REDIRECT_TO_FILE.test(l))).toEqual([]);
      expect(code.filter((l) => /\bchown\b|install\s+(-d\s+)?-o\b/.test(l))).toEqual([]);
    });

    test(`${name}: what hapi runs uses paths relative to its home, never an absolute one into it`, () => {
      const s = snippets(file);
      expect(s.length).toBeGreaterThan(0);
      for (const snippet of s) expect([snippet, HAPI_HOME.test(snippet) || snippet.includes("..")]).toEqual([snippet, false]);
    });
  }

  test("the patterns catch the old forms (the control)", () => {
    for (const bad of [
      `install -d -o "$HAPI_USER" -g "$HAPI_USER" -m 0755 "/home/$HAPI_USER/.local"`,
      `install -o "$HAPI_USER" -g "$HAPI_USER" -m 0755 "$mise_tmp" "$bin"`,
      `grep -qxF "$line" "$profile" 2>/dev/null || printf '%s\\n' "$line" >>"$profile"`,
      `chown "$HAPI_USER:$HAPI_USER" "$profile"`,
      `  chown -R "$HAPI_USER:$HAPI_USER" "$dest"`,
    ]) {
      expect([bad, MUTATES.test(bad) || REDIRECT_TO_FILE.test(bad)]).toEqual([bad, true]);
    }
    expect(HAPI_HOME.test(`local bin="/home/$HAPI_USER/.local/bin/mise"`)).toBe(true);
    for (const ok of ['printf "%s" "$x" >&2', "id -u hapi >/dev/null 2>&1", "apt-get install -y uidmap", "as_hapi dockerd-rootless-setuptool.sh install"]) {
      expect([ok, MUTATES.test(ok) || REDIRECT_TO_FILE.test(ok)]).toEqual([ok, false]);
    }
  });

  test("host-setup.sh: every sudo runs as hapi, and nothing it gives sudo -i holds a `$` (sudo -i leaves `$` unescaped for hapi's login shell)", () => {
    // The commands, not the text: the next steps' here-document and the double-quoted messages dropped.
    const code = rootCode(HOST_SETUP)
      .join("\n")
      .replace(/<<EOF\n[\s\S]*?\nEOF\n/g, "<<EOF\n")
      .split("\n")
      .map((l) => l.replace(/"[^"\n]*"/g, '""'));
    const sudos = code.filter((l) => /\bsudo\b/.test(l));
    expect(sudos.length).toBe(2);
    for (const l of sudos) expect([l, /sudo -u "" -H -- sh -c "|sudo -iu "" -- env /.test(l)]).toEqual([l, true]);
    for (const l of code.filter((l) => /^\s*(if\s+)?(! )?as_hapi\s/.test(l))) expect([l, l.replace(/^\s*(if\s+)?(! )?as_hapi\s/, "").includes("$")]).toEqual([l, false]);
  });

  test("copy-secrets-to-hapi.sh refuses root, and both scripts hand the store over the same way: host-setup's next steps call the helper", () => {
    const helper = readFileSync(COPY_SECRETS, "utf8");
    expect(helper).toContain(`[[ "$(id -u)" -ne 0 ]] || die`);
    expect(helper).toContain(`tar -C "$checkout/private" -cf - -- "\${FILES[@]}" |\n  sudo -u "$HAPI_USER" -H -- sh -c 'umask 077`);
    const steps = readFileSync(HOST_SETUP, "utf8");
    expect(steps.match(/^ {7}scripts\/copy-secrets-to-hapi\.sh$/gm)?.length).toBe(2);
  });
});

describe("no doc tells the operator to act on hapi's home as root", () => {
  /** A sudo that doesn't switch to hapi: `sudo -u hapi` and `sudo -iu hapi` run as hapi, and are fine. */
  const ROOT_SUDO = /\bsudo\s+(?!-i?u\s+hapi\b|-u\s+hapi\s+-H\b)/;
  for (const doc of DOCS) {
    test(`${doc}: no sudo command on a path in hapi's home, and no install -o, install -d -o or chown to hapi`, () => {
      const lines = readFileSync(join(REPO, doc), "utf8").split("\n");
      expect(lines.filter((l) => ROOT_SUDO.test(l) && HAPI_HOME.test(l))).toEqual([]);
      expect(lines.filter((l) => /\binstall\s+(-d\s+)?-o\s+hapi\b|\bchown\s+(-R\s+)?hapi\b/.test(l))).toEqual([]);
    });
  }

  test("each doc that hands hapi its secrets uses the one helper, scripts/copy-secrets-to-hapi.sh", () => {
    for (const doc of ["README.md", "docs/secrets.md", "docs/runbooks/stack.md"]) {
      expect([doc, readFileSync(join(REPO, doc), "utf8").includes("scripts/copy-secrets-to-hapi.sh")]).toEqual([doc, true]);
    }
    // The control: the old line is caught.
    const old = "sudo install -o hapi -g hapi -m 0600 private/secrets.enc.yaml /home/hapi/.config/hapi/";
    expect(ROOT_SUDO.test(old) && HAPI_HOME.test(old)).toBe(true);
    expect(ROOT_SUDO.test("sudo -iu hapi docker info")).toBe(false);
  });
});

/** Run one of a script's hapi snippets as host-setup's as_hapi_sh would, but as this user, with HOME=`home`. */
function runSnippet(snippet: string, home: string, args: string[], stdin?: Uint8Array) {
  const r = Bun.spawnSync(["sh", "-c", `cd ~ || exit 1\n${snippet}`, "host-setup", ...args], {
    env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

/** The host-setup snippet that holds `marker`. */
const hostSnippet = (marker: string) => {
  const found = snippets(HOST_SETUP).filter((s) => s.includes(marker));
  expect(found.length).toBe(1);
  return found[0]!;
};

describe("what hapi runs, run as this user in a temp HOME", () => {
  test("the checkout: unpacks into a directory it makes; refuses any existing path, a dangling symlink included, and follows nothing", () => {
    const snippet = hostSnippet("--no-same-owner -xf -");
    const src = tempDir();
    writeFileSync(join(src, "README.md"), "hello\n");
    mkdirSync(join(src, ".git"));
    const tar = Bun.spawnSync(["tar", "-C", src, "-cf", "-", "."]).stdout;

    const home = tempDir();
    expect(runSnippet(snippet, home, ["hapi-factory"], tar).code).toBe(0);
    expect(readFileSync(join(home, "hapi-factory", "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(join(home, "hapi-factory", ".git"))).toBe(true);

    const planted = tempDir();
    const outside = join(planted, "outside");
    symlinkSync(outside, join(planted, "hapi-factory")); // dangling: [[ ! -e ]] would have passed
    expect(runSnippet(snippet, planted, ["hapi-factory"], tar).code).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(lstatSync(join(planted, "hapi-factory")).isSymbolicLink()).toBe(true);
  });

  test("the checkout from a URL: hapi clones into a directory it makes, and leaves nothing behind when the clone fails", () => {
    const snippet = hostSnippet('git clone -- "$2" "$1"');
    const origin = tempDir();
    const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd, stdout: "ignore", stderr: "ignore" }).exitCode;
    expect(git(origin, "init", "-q")).toBe(0);
    writeFileSync(join(origin, "a.txt"), "a\n");
    expect(git(origin, "add", "a.txt")).toBe(0);
    expect(git(origin, "commit", "-qm", "a")).toBe(0);

    const home = tempDir();
    expect(runSnippet(snippet, home, ["hapi-factory", origin]).code).toBe(0);
    expect(readFileSync(join(home, "hapi-factory", "a.txt"), "utf8")).toBe("a\n");

    const failing = tempDir();
    expect(runSnippet(snippet, failing, ["hapi-factory", join(failing, "no-such-repo")]).code).not.toBe(0);
    expect(existsSync(join(failing, "hapi-factory"))).toBe(false);
  });

  test("mise: the bytes on stdin become ~/.local/bin/mise, mode 0755, by rename; a failed write leaves no binary and no temp file", () => {
    const snippet = hostSnippet(".local/bin/.mise.XXXXXX");
    const bytes = new TextEncoder().encode("#!/bin/sh\necho '2026.10.3 linux-x64'\n");
    const home = tempDir();
    expect(runSnippet(snippet, home, [], bytes).code).toBe(0);
    const bin = join(home, ".local", "bin", "mise");
    expect(readFileSync(bin, "utf8")).toBe(new TextDecoder().decode(bytes));
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["mise"]);
    // Again over an existing one (a re-run with a new pin): replaced, still no temp file.
    expect(runSnippet(snippet, home, [], bytes).code).toBe(0);
    expect(readdirSync(join(home, ".local", "bin"))).toEqual(["mise"]);

    const broken = tempDir();
    mkdirSync(join(broken, ".local", "bin"), { recursive: true });
    mkdirSync(join(broken, ".local", "bin", "mise")); // a directory where the binary goes: mv -T refuses to move into it
    expect(runSnippet(snippet, broken, [], bytes).code).not.toBe(0);
    expect(readdirSync(join(broken, ".local", "bin"))).toEqual(["mise"]);
    expect(readdirSync(join(broken, ".local", "bin", "mise"))).toEqual([]);
  });

  test("the activate line: appended to ~/.bashrc once, however often it runs", () => {
    const snippet = hostSnippet(">>.bashrc");
    const line = 'eval "$(~/.local/bin/mise activate bash)"';
    const home = tempDir();
    writeFileSync(join(home, ".bashrc"), "# hapi's own\n");
    for (let i = 0; i < 2; i++) expect(runSnippet(snippet, home, [line]).code).toBe(0);
    expect(readFileSync(join(home, ".bashrc"), "utf8")).toBe(`# hapi's own\n${line}\n`);
    // host-setup passes exactly this line.
    expect(readFileSync(HOST_SETUP, "utf8")).toContain(`>>.bashrc' '${line}'`);
  });

  test("copy-secrets-to-hapi.sh end to end, with sudo -u hapi standing in as this user: the three files into ~/.config/hapi, 0700 and 0600", () => {
    // A checkout holding the helper and a fake private/; a sudo and an id that stand in for hapi.
    const checkout = tempDir();
    mkdirSync(join(checkout, "scripts"));
    copyFileSync(COPY_SECRETS, join(checkout, "scripts", "copy-secrets-to-hapi.sh"));
    chmodSync(join(checkout, "scripts", "copy-secrets-to-hapi.sh"), 0o755);
    mkdirSync(join(checkout, "private"));
    for (const f of ["secrets.enc.yaml", "secrets.recipients.yaml", "recovery.age"]) writeFileSync(join(checkout, "private", f), `fake ${f}\n`, { mode: 0o644 });
    const home = tempDir();
    const bin = tempDir();
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\n[ "$1 $2 $3 $4" = "-u hapi -H --" ] || { echo "unexpected sudo $*" >&2; exit 99; }\nshift 4\nexec env HOME='${home}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(bin, "id"), `#!/bin/sh\n[ "$*" = "-u hapi" ] && { echo 1999; exit 0; }\nexec /usr/bin/id "$@"\n`, { mode: 0o755 });
    const run = () =>
      Bun.spawnSync([join(checkout, "scripts", "copy-secrets-to-hapi.sh")], { cwd: tmpdir(), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: checkout }, stdout: "pipe", stderr: "pipe" });

    for (let i = 0; i < 2; i++) {
      const r = run();
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
    }
    const dir = join(home, ".config", "hapi");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dir).sort()).toEqual(["recovery.age", "secrets.enc.yaml", "secrets.recipients.yaml"]);
    for (const f of readdirSync(dir)) {
      expect([f, statSync(join(dir, f)).mode & 0o777]).toEqual([f, 0o600]);
      expect(readFileSync(join(dir, f), "utf8")).toBe(`fake ${f}\n`);
    }

    rmSync(join(checkout, "private", "recovery.age"));
    const missing = run();
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString()).toContain("private/recovery.age is missing");
  });
});
