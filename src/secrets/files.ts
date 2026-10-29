/**
 * Secrets on disk: where they go, how they are written, and where a key or a
 * plaintext store may sit (spec §11.5).
 *
 * - `runtimeDir`: `$XDG_RUNTIME_DIR/hapi`, the only place hapi writes a
 *   resolved secret. XDG_RUNTIME_DIR is the user's own tmpfs (systemd makes it
 *   at login, mode 0700), so the env files don't survive a reboot. There is
 *   no fallback: never /tmp, never the repo. Docker keeps a copy, though:
 *   each zone container's env sits in its container config on hapi's disk
 *   (under hapi's rootless data root) for as long as the container exists,
 *   reboots included, until `mise run down` removes it (H-189).
 * - `secureDir`: the directory is ours, a real directory (not a symlink) and
 *   mode 0700, under a runtime root (XDG_RUNTIME_DIR) that is itself ours and
 *   exactly 0700, as systemd makes it.
 * - `writeSecretFiles`: the whole set of zone env files at once. They are
 *   written into a fresh generation directory (`env.<random>`, 0700, each
 *   file 0600), and a symlink swap (`rename` over `env`) makes it current. A
 *   reader sees the old set or the new one, never a mix, and the old
 *   generation is deleted, so a zone file the manifest dropped goes with it.
 *   Task 4-era zone files, and generations a crash orphaned (once they are a
 *   minute old), are removed too.
 * - `writeSecretFile`: one file, 0600, written to a temp file and renamed over
 *   the target (a minted token; a store, its recipients file or recovery.age
 *   when a recipient changes).
 * - `writeNewSecretFile`: one new file, 0600, that never replaces anything:
 *   `link()` of a temp file, which fails with EEXIST if the path exists, even
 *   if it appeared after the caller checked (init, join).
 * - `envFileText` and `parseEnvFile`: the env-file format, `NAME='value'`.
 *   Docker Compose reads a single-quoted value literally: no `${...}`
 *   interpolation, no escapes, newlines kept. So a key with `$` or a
 *   multi-line PEM arrives intact. A value can't hold a single quote or NUL,
 *   or end in a backslash (Compose would take `\'` as an escaped quote);
 *   such a value is refused, by key.
 * - `privateFileProblem`, `ensurePrivateDir` and `defaultRepoRoot`: a key or a
 *   plaintext store must be ours, closed to group and other, and outside the
 *   hapi-factory checkout, private/ included. The checkout is the worktree
 *   hapi runs from and the repo's main worktree (`repoRoots`), as git says;
 *   if git can't say, that is an error, never a guess.
 *
 * Every error names a key or a path, never a value. A bad XDG_RUNTIME_DIR is a
 * plain Error; the callers turn a `privateFileProblem` into a SecretError.
 */
import { randomUUID } from "node:crypto";
import { chmod, link as hardLink, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** An env var name, as hapi writes one. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The name of the env-file symlink under `runtimeDir`: consumers read `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`. */
export const ENV_DIR = "env";

const octal = (mode: number) => `0${(mode & 0o777).toString(8)}`;
const currentUid = (uid?: number) => uid ?? process.getuid?.();

/**
 * `$XDG_RUNTIME_DIR/hapi`. Throws if XDG_RUNTIME_DIR is unset, empty or relative:
 * secrets go nowhere else.
 */
export function runtimeDir(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg === undefined || xdg === "") {
    throw new Error(
      "XDG_RUNTIME_DIR is not set. hapi writes secrets only under $XDG_RUNTIME_DIR/hapi/, the user's own tmpfs, " +
        "never /tmp or the repo. Run hapi in a login session of the user, or set XDG_RUNTIME_DIR=/run/user/$(id -u) " +
        "if that directory exists (loginctl enable-linger keeps it for the hapi user).",
    );
  }
  if (!isAbsolute(xdg)) throw new Error("XDG_RUNTIME_DIR must be an absolute path");
  return join(xdg, "hapi");
}

/**
 * Whether `path` is `dir` or under it (both absolute and normalized). Only a
 * relative path of `..` or one starting `../` leaves `dir`: a first segment
 * that merely starts with two dots (`..private`, `..agekey`) is still inside.
 */
export function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Check the runtime root `root` (XDG_RUNTIME_DIR): it must exist, be a real
 * directory owned by this user, and be mode 0700 exactly. It is never made or
 * tightened here: systemd makes it, and a root that isn't like that is not the
 * user's private tmpfs. Then make `dir` (and any missing levels between) under
 * it, and check `dir`: a real directory, not a symlink, ours, mode 0700. A
 * looser `dir` is tightened to 0700.
 */
export async function secureDir(dir: string, root: string, o: { uid?: number } = {}): Promise<void> {
  const uid = currentUid(o.uid);
  const what = `XDG_RUNTIME_DIR (${root})`;
  if (!isWithin(resolve(dir), resolve(root))) throw new Error(`${dir} is not under ${what}; refusing to write secrets there`);
  let rs;
  try {
    rs = await lstat(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${what} does not exist; systemd makes it at login (see docs/secrets.md)`);
    throw e;
  }
  if (!rs.isDirectory()) throw new Error(`${what} is not a directory (a symlink?); refusing to write secrets under it`);
  if (uid !== undefined && rs.uid !== uid) throw new Error(`${what} is owned by uid ${rs.uid}, not you (uid ${uid}); refusing to write secrets under it`);
  if ((rs.mode & 0o777) !== 0o700) {
    throw new Error(`${what} has mode ${octal(rs.mode)}, not 0700 as systemd makes it; refusing to write secrets under it`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a symlink?); refusing to write secrets there`);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by another user; refusing to write secrets there`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}

/** Write `content` to a new file `path`, mode exactly 0600 whatever the umask, and fsync it. Fails if `path` exists. */
async function writeNew(path: string, content: string | Uint8Array): Promise<void> {
  const fh = await open(path, "wx", 0o600);
  try {
    await fh.chmod(0o600);
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Write one file with mode 0600, atomically: to a temp file in the same
 * directory, then renamed over `path`. If the write fails, the temp file is
 * removed and `path` is untouched. The directory must exist.
 */
export async function writeSecretFile(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeNew(tmp, content);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Write one new file with mode 0600 that never replaces anything: the content
 * goes to a temp file in the same directory, which is then hard-linked to
 * `path` and unlinked. `link()` fails with EEXIST if `path` exists in any
 * form (a file, a directory, a dangling symlink), even one that appeared after
 * the caller checked, so a racing file is never clobbered. The directory must
 * exist. Rejects with the EEXIST error (code "EEXIST") in that case.
 */
export async function writeNewSecretFile(path: string, content: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeNew(tmp, content);
    await hardLink(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How old (by mtime) a generation the link doesn't point at must be before
 * `writeSecretFiles` removes it: a younger one may be a concurrent resolve's,
 * still being written, and removing it would leave that resolve's `env`
 * dangling. One a crash left behind is removed by the next resolve after this.
 */
export const ORPHAN_AGE_MS = 60_000;

/**
 * Write a whole set of files (`name -> content`) and make it current at `link`
 * in one step:
 * 1. write every file (0600) into a fresh `<link>.<random>/` (0700) beside `link`;
 * 2. make a temporary symlink to it, and `rename` that over `link`;
 * 3. delete the generation `link` pointed to before, if it is one of ours.
 *
 * A reader of `<link>/<name>` sees the old set or the new one, never a mix,
 * and a name not in the new set is gone. If anything fails before the swap,
 * the new generation is removed and the old set stays. `link` must be a
 * symlink or absent: a real directory or file there is refused. Its directory
 * must exist (see `secureDir`). Resolves to the paths, `<link>/<name>`.
 *
 * After the swap it also removes, beside `link`:
 * - the generation `link` pointed at before the swap;
 * - every other generation directory of ours that `link` doesn't point at
 *   and that is more than `ORPHAN_AGE_MS` old (one a crash orphaned). A
 *   younger one may be a concurrent resolve's, still being written, so it is
 *   left for a later run;
 * - each `legacy` name that is a regular file (the zone files Task 4 wrote
 *   directly in `$XDG_RUNTIME_DIR/hapi/`).
 * An entry that vanishes meanwhile (a concurrent resolve removed it) is
 * skipped. It never touches a symlink, or a directory or file of another name.
 */
export async function writeSecretFiles(link: string, files: Record<string, string>, o: { legacy?: readonly string[] } = {}): Promise<string[]> {
  const base = dirname(link);
  const linkName = basename(link);
  const names = Object.keys(files).sort();
  for (const name of names) {
    if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
      throw new Error("a secret file name must be a plain file name (not shown, in case it is a value)");
    }
  }
  const generation = `${linkName}.${randomUUID()}`;
  const genDir = join(base, generation);
  const tmpLink = join(base, `.${linkName}.${randomUUID()}.link`);
  let previous: string | undefined;
  try {
    try {
      const st = await lstat(link);
      if (!st.isSymbolicLink()) throw new Error(`${link} is not hapi's symlink (a real ${st.isDirectory() ? "directory" : "file"}); move it away and run again`);
      previous = await readlink(link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await mkdir(genDir, { mode: 0o700 });
    await chmod(genDir, 0o700);
    for (const name of names) await writeNew(join(genDir, name), files[name]!);
    await symlink(generation, tmpLink);
    await rename(tmpLink, link);
  } catch (e) {
    await rm(tmpLink, { force: true });
    await rm(genDir, { recursive: true, force: true });
    throw e;
  }
  // Only sibling generations of ours (real directories) are deleted, never whatever else the link pointed at,
  // and never the one it points at now (a concurrent resolve may have swapped in its own).
  const current = await readlink(link).catch(() => undefined);
  for (const entry of await readdir(base)) {
    if (entry === generation || entry === current || !entry.startsWith(`${linkName}.`) || !GENERATION.test(entry.slice(linkName.length + 1))) continue;
    let st;
    try {
      st = await lstat(join(base, entry));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // a concurrent resolve removed it
      throw e;
    }
    if (!st.isDirectory()) continue;
    if (entry !== previous && Date.now() - st.mtimeMs < ORPHAN_AGE_MS) continue; // maybe a concurrent resolve's, still being written
    await rm(join(base, entry), { recursive: true, force: true });
  }
  for (const name of o.legacy ?? []) {
    const path = join(base, name);
    try {
      if ((await lstat(path)).isFile()) await rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  return names.map((name) => join(link, name));
}

/** Why `value` can't be written in an env file, or undefined if it can. */
export function envValueProblem(value: string): string | undefined {
  if (value.includes("'")) return "the value holds a single quote ('), which an env file can't carry literally; rotate the secret to one without";
  if (value.includes("\0")) return "the value holds a NUL character, which no env var can carry";
  // Compose's dotenv parser takes \' as an escaped quote even inside single quotes; with ' refused, only a last \ can meet one.
  if (value.endsWith("\\")) return "the value ends in a backslash (\\), which Compose would take as escaping the closing quote; rotate the secret to one without";
  return undefined;
}

/**
 * The env file for one zone: a comment header, then `NAME='value'` per entry,
 * sorted by name. Throws, naming `zone/NAME`, for a name that isn't an env name
 * or a value that `envValueProblem` refuses.
 */
export function envFileText(zone: string, values: Record<string, string>): string {
  const lines = [
    `# hapi secrets for the ${zone} zone, written by \`hapi secrets resolve\` from the configured secret provider.`,
    "# Mode 0600 on the user's tmpfs. Never copy, commit or print this file.",
  ];
  for (const name of Object.keys(values).sort()) {
    if (!ENV_NAME.test(name)) throw new Error(`${zone}: an env name is not of the form ${ENV_NAME.source} (not shown, in case it is a value)`);
    const problem = envValueProblem(values[name]!);
    if (problem !== undefined) throw new Error(`${zone}/${name}: ${problem}`);
    lines.push(`${name}='${values[name]}'`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Read an env file that `envFileText` wrote: comment lines, blank lines and
 * `NAME='value'` entries, where a value may span lines. Anything else throws,
 * giving the line number but never the file's text.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  let line = 1;
  const fail = (why: string): never => {
    throw new Error(`malformed env file at line ${line}: ${why}`);
  };
  while (i < text.length) {
    const eol = text.indexOf("\n", i);
    const lineEnd = eol === -1 ? text.length : eol;
    if (text[i] === "#" || i === lineEnd) {
      i = lineEnd + 1;
      line++;
      continue;
    }
    const m = /^([A-Z_][A-Z0-9_]*)='/.exec(text.slice(i, lineEnd));
    if (!m) return fail("expected NAME='value'");
    const name = m[1]!;
    const start = i + m[0].length;
    const close = text.indexOf("'", start);
    if (close === -1) return fail("a value has no closing quote");
    if (close + 1 < text.length && text[close + 1] !== "\n") return fail("text after a closing quote");
    if (Object.hasOwn(out, name)) return fail(`${name} appears twice`);
    const value = text.slice(start, close);
    out[name] = value;
    line += value.split("\n").length;
    i = close + 2;
  }
  return out;
}

/** The checkout a key may not sit in: one root, or several (a linked worktree and its main worktree). */
export type CheckoutRoots = string | readonly string[];

/**
 * The absolute path git prints for `args` in `cwd`. Throws, naming the
 * command, its exit code and the first line of git's stderr, if git can't
 * run, fails, or prints anything but one absolute path.
 */
async function gitPath(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const what = `\`git ${args.join(" ")}\` in ${cwd}`;
  const why =
    "hapi needs it to find the hapi-factory checkout that age keys and plaintext must stay out of, and won't guess. " +
    "For \"dubious ownership\", run hapi as the user that owns the checkout (git's safe.directory explains the check)";
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`cannot run ${what}${code ? ` (${code})` : ""}: is git installed? ${why}`);
  }
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = out.trim();
  if (code === 0 && isAbsolute(line) && !line.includes("\n")) return line;
  const first = err
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  const said = first === undefined ? "" : `: ${first.length > 300 ? `${first.slice(0, 300)}...` : first}`;
  throw new Error(`${what} ${code === 0 ? "printed no absolute path" : `failed (exit ${code})`}${said}. ${why}`);
}

/**
 * The hapi-factory checkout that `cwd` (default: this module's directory) is
 * in, as every directory a key must stay out of:
 * 1. the worktree's top level, `git rev-parse --show-toplevel`;
 * 2. the repo's main worktree, the parent of
 *    `git rev-parse --path-format=absolute --git-common-dir`, if it is
 *    another directory. So when hapi runs from a linked worktree (under
 *    `.worktrees/`), the main worktree's private/ is still covered.
 * git runs with every GIT_* variable cleared, so a GIT_DIR or GIT_WORK_TREE in
 * the caller's shell can't point it at another repo. If git can't say (no git,
 * not a checkout, "dubious ownership" when one user runs hapi from another's
 * checkout), it throws, naming git's error: there is no fallback, because a
 * guessed boundary could leave the main worktree's private/ outside it.
 */
export async function repoRoots(o: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<string[]> {
  const cwd = o.cwd ?? import.meta.dir;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env ?? process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
  const top = await gitPath(["rev-parse", "--show-toplevel"], cwd, env);
  const main = dirname(await gitPath(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, env));
  return resolve(main) === resolve(top) ? [top] : [top, main];
}

let repoRootCache: Promise<string[]> | undefined;

/** `repoRoots()` for this module's own checkout, worked out once per process (a failure isn't kept: the next call tries again). */
export function defaultRepoRoot(): Promise<string[]> {
  repoRootCache ??= repoRoots();
  repoRootCache.catch(() => {
    repoRootCache = undefined;
  });
  return repoRootCache;
}

/** `path`'s real path, or, if it doesn't exist, its parent's real path joined with its name (so a missing file is still placed). */
export async function realish(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realish(parent), basename(path));
  }
}

/**
 * Why `path` may not hold a key or a plaintext store because of where it is,
 * or undefined: it is inside the checkout (any of `repoRoot`), private/
 * included, as given or as its real path, whether or not it exists yet. The
 * checkout can be committed, and private/ is pushed to the private remote.
 */
export async function checkoutProblem(path: string, repoRoot: CheckoutRoots): Promise<string | undefined> {
  const abs = resolve(path);
  for (const root of typeof repoRoot === "string" ? [repoRoot] : repoRoot) {
    if (isWithin(abs, resolve(root)) || isWithin(await realish(abs), await realish(resolve(root)))) {
      return `is inside the hapi-factory checkout (${root}), private/ included: the checkout can be committed, and private/ is pushed to the private remote. Move it outside the checkout`;
    }
  }
  return undefined;
}

/**
 * Why `path` may not hold a key or a plaintext store, or undefined if it may:
 * - `checkoutProblem` (checked first);
 * - it doesn't exist, isn't a regular file, or isn't owned by this user;
 * - mode `"private"`: it has any group or other permission bit;
 *   mode `"0600"`: its mode isn't exactly 0600.
 */
export async function privateFileProblem(path: string, o: { repoRoot: CheckoutRoots; mode: "private" | "0600"; uid?: number }): Promise<string | undefined> {
  const where = await checkoutProblem(path, o.repoRoot);
  if (where !== undefined) return where;
  const abs = resolve(path);
  let st;
  try {
    st = await stat(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? "does not exist" : `cannot be read (${code ?? "error"})`;
  }
  if (!st.isFile()) return "is not a regular file";
  const uid = currentUid(o.uid);
  if (uid !== undefined && st.uid !== uid) return `is owned by uid ${st.uid}, not you (uid ${uid})`;
  if (o.mode === "private" && (st.mode & 0o077) !== 0) return `has group or other permission bits (mode ${octal(st.mode)}): run chmod 600 ${abs}`;
  if (o.mode === "0600" && (st.mode & 0o777) !== 0o600) return `must be mode 0600 (it is ${octal(st.mode)}): run chmod 600 ${abs}`;
  return undefined;
}

/**
 * Make `dir` (and any missing parents, 0700) and leave it ours with mode 0700:
 * a looser mode is tightened. Throws if it isn't a directory or isn't ours.
 * For the directories that hold a config, an encrypted store or a key.
 * Resolves to the first directory it made, if it made any (as `mkdir -p`
 * reports it), so a caller that rolls back can remove what it made.
 */
export async function ensurePrivateDir(dir: string, o: { uid?: number } = {}): Promise<string | undefined> {
  const made = await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await stat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = currentUid(o.uid);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not you (uid ${uid})`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  return made;
}
