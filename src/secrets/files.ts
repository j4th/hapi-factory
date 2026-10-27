/**
 * Secrets on disk: where they go, and how they are written (spec §11.5).
 *
 * - `runtimeDir`: `$XDG_RUNTIME_DIR/hapi`, the only place hapi writes a
 *   secret. XDG_RUNTIME_DIR is the user's own tmpfs (systemd makes it at
 *   login, mode 0700), so nothing survives a reboot. There is no fallback:
 *   never /tmp, never the repo.
 * - `secureDir`: the directory is ours, a real directory (not a symlink) and
 *   mode 0700.
 * - `writeSecretFiles`: each file is written mode 0600 to a temp file in the
 *   same directory, then renamed over the target, so a reader sees the old
 *   file or the new one, never half of one.
 * - `envFileText` and `parseEnvFile`: the env-file format, `NAME='value'`.
 *   Docker Compose reads a single-quoted value literally: no `${...}`
 *   interpolation, no escapes, newlines kept. So a key with `$` or a
 *   multi-line PEM arrives intact. A value can't hold a single quote or NUL;
 *   such a value is refused, by key.
 *
 * Every error names a key or a path, never a value.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

/** An env var name, as hapi writes one. */
export const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

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
 * Make `dir` (and any missing parents) and check it: a real directory, not a
 * symlink, owned by this user, mode 0700. A looser mode is tightened to 0700.
 */
export async function secureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a symlink?); refusing to write secrets there`);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} is owned by another user; refusing to write secrets there`);
  if ((st.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
}

/**
 * Write each `path -> content` with mode 0600, atomically: every file goes to a
 * temp file in its own directory first, and only when all are written are they
 * renamed into place. If any write fails, the temp files are removed and no
 * target is touched. The directories must exist (see `secureDir`).
 */
export async function writeSecretFiles(files: Record<string, string>): Promise<void> {
  const temps: [tmp: string, target: string][] = [];
  try {
    for (const [target, content] of Object.entries(files)) {
      const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
      const fh = await open(tmp, "wx", 0o600);
      temps.push([tmp, target]);
      try {
        await fh.chmod(0o600); // exactly 0600, whatever the umask
        await fh.writeFile(content);
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
    for (const [tmp, target] of temps) await rename(tmp, target);
  } catch (e) {
    await Promise.all(temps.map(([tmp]) => rm(tmp, { force: true })));
    throw e;
  }
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
    `# hapi secrets for the ${zone} zone, written by \`hapi secrets resolve\` from Bitwarden Secrets Manager.`,
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
