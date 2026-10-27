/**
 * Secrets on disk: where they go, how they are written, and where a key or a
 * plaintext store may sit (spec §11.5).
 *
 * - `runtimeDir`: `$XDG_RUNTIME_DIR/hapi`, the only place hapi writes a
 *   resolved secret. XDG_RUNTIME_DIR is the user's own tmpfs (systemd makes it
 *   at login, mode 0700), so nothing survives a reboot. There is no fallback:
 *   never /tmp, never the repo.
 * - `secureDir`: the directory is ours, a real directory (not a symlink) and
 *   mode 0700, under a runtime root (XDG_RUNTIME_DIR) that is itself ours and
 *   exactly 0700, as systemd makes it.
 * - `writeSecretFiles`: the whole set of zone env files at once. They are
 *   written into a fresh generation directory (`env.<random>`, 0700, each
 *   file 0600), and a symlink swap (`rename` over `env`) makes it current. A
 *   reader sees the old set or the new one, never a mix, and the old
 *   generation is deleted, so a zone file the manifest dropped goes with it.
 * - `writeSecretFile`: one file, 0600, written to a temp file and renamed over
 *   the target (a minted token, a config, an encrypted store).
 * - `envFileText` and `parseEnvFile`: the env-file format, `NAME='value'`.
 *   Docker Compose reads a single-quoted value literally: no `${...}`
 *   interpolation, no escapes, newlines kept. So a key with `$` or a
 *   multi-line PEM arrives intact. A value can't hold a single quote or NUL;
 *   such a value is refused, by key.
 * - `privateFileProblem`, `ensurePrivateDir` and `defaultRepoRoot`: a key or a
 *   plaintext store must be ours, closed to group and other, and outside the
 *   hapi-factory checkout, private/ included.
 *
 * Every error names a key or a path, never a value. A bad XDG_RUNTIME_DIR is a
 * plain Error; the callers turn a `privateFileProblem` into a SecretError.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readlink, realpath, rename, rm, stat, symlink } from "node:fs/promises";
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
async function writeNew(path: string, content: string): Promise<void> {
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
export async function writeSecretFile(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeNew(tmp, content);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
 */
export async function writeSecretFiles(link: string, files: Record<string, string>): Promise<string[]> {
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
  let old: string | undefined;
  try {
    try {
      const st = await lstat(link);
      if (!st.isSymbolicLink()) throw new Error(`${link} is not hapi's symlink (a real ${st.isDirectory() ? "directory" : "file"}); move it away and run again`);
      old = await readlink(link);
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
  // Only a sibling generation of ours is deleted, never whatever else the link pointed at.
  if (old !== undefined && old !== generation && old.startsWith(`${linkName}.`) && GENERATION.test(old.slice(linkName.length + 1))) {
    await rm(join(base, old), { recursive: true, force: true });
  }
  return names.map((name) => join(link, name));
}

/** Why `value` can't be written in an env file, or undefined if it can. */
export function envValueProblem(value: string): string | undefined {
  if (value.includes("'")) return "the value holds a single quote ('), which an env file can't carry literally; rotate the secret to one without";
  if (value.includes("\0")) return "the value holds a NUL character, which no env var can carry";
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

let repoRootCache: Promise<string> | undefined;

/**
 * The hapi-factory checkout this code runs from: `git rev-parse --show-toplevel`
 * in this module's directory, or, if git can't say (no git, not a checkout),
 * the directory two levels up, which holds src/ in a normal layout.
 */
export function defaultRepoRoot(): Promise<string> {
  repoRootCache ??= (async () => {
    const fallback = resolve(import.meta.dir, "..", "..");
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const top = out.trim();
      return code === 0 && isAbsolute(top) ? top : fallback;
    } catch {
      return fallback;
    }
  })();
  return repoRootCache;
}

/** `path`'s real path, or, if it doesn't exist, its parent's real path joined with its name (so a missing file is still placed). */
async function realish(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realish(parent), basename(path));
  }
}

/**
 * Why `path` may not hold a key or a plaintext store because of where it is,
 * or undefined: it is inside the checkout `repoRoot`, private/ included, as
 * given or as its real path, whether or not it exists yet. The checkout can be
 * committed, and private/ is pushed to the private remote.
 */
export async function checkoutProblem(path: string, repoRoot: string): Promise<string | undefined> {
  const abs = resolve(path);
  if (isWithin(abs, resolve(repoRoot)) || isWithin(await realish(abs), await realish(resolve(repoRoot)))) {
    return `is inside the hapi-factory checkout (${repoRoot}), private/ included: the checkout can be committed, and private/ is pushed to the private remote. Move it outside the checkout`;
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
export async function privateFileProblem(path: string, o: { repoRoot: string; mode: "private" | "0600"; uid?: number }): Promise<string | undefined> {
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
 */
export async function ensurePrivateDir(dir: string, o: { uid?: number } = {}): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await stat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  const uid = currentUid(o.uid);
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by uid ${st.uid}, not you (uid ${uid})`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}
