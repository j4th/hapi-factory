/**
 * The files beside a sops store, and the helpers `hapi secrets init` and the
 * lifecycle commands (./init.ts, ./lifecycle.ts) share to write them
 * (spec §11.5):
 * - `exists`, `refuseCoinciding` and `refuseSharedDirs`: checks before any
 *   file is made;
 * - `configText`: the local config for a store and this machine's key;
 * - `writeNewFiles`: several new files as one step, each no-replace;
 * - `withStoreLock`: the lock beside the store, held by every lifecycle
 *   command and by `edit` while they read and change the store and its
 *   recipients file, so two of them can't interleave and lose an update.
 *
 * It imports ./files and ./provider only, so init, lifecycle and cli can all
 * import it without a cycle.
 */
import { lstat, open, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { ensurePrivateDir, isWithin, realish, writeNewSecretFile } from "./files";
import { configHome, defaultAgeKeyFile, type Env, SecretError } from "./provider";

/** Whether anything (a file, a directory, a dangling symlink) is at `path`. */
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Throw if any two of `paths` (label -> path) are the same file, as given or through a symlink. */
export async function refuseCoinciding(paths: [string, string][]): Promise<void> {
  const real = await Promise.all(paths.map(async ([, p]) => [resolve(p), await realish(resolve(p))] as const));
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (real[i]![0] === real[j]![0] || real[i]![1] === real[j]![1]) {
        throw new SecretError(`the ${paths[i]![0]} and the ${paths[j]![0]} are the same file (${real[i]![0]}): give each its own path`);
      }
    }
  }
}

/** Refuse a new file directly in $HOME or the config home (or above): its directory would be made 0700. */
export function refuseSharedDirs(paths: string[], env: Env): void {
  const shared = [env.HOME, configHome(env)].filter((d): d is string => d !== undefined && d !== "").map((d) => resolve(d));
  for (const path of paths) {
    const dir = resolve(dirname(path));
    if (shared.some((d) => isWithin(d, dir))) {
      throw new Error(
        `${path} would sit directly in ${dir}, which hapi would have to make 0700; put it in a directory of its own (the defaults are under ${join(configHome(env), "hapi")} and ${dirname(defaultAgeKeyFile(env))})`,
      );
    }
  }
}

/** The local config text for a sops store and this machine's key. */
export function configText(file: string, ageKey: string, by: string): string {
  return (
    `# hapi's local secrets config, written by \`hapi secrets ${by}\` (docs/secrets.md).\n` +
    "# It picks the secret provider and binds it; it holds no secret.\n" +
    stringify({ provider: "sops", sops: { file, age_key_file: ageKey } })
  );
}

/**
 * New files, written as one step: each with `writeNewSecretFile` (0600, never
 * replacing anything) in a directory made or tightened to 0700. If one fails,
 * the ones already written, and the directories made for them, are removed,
 * and the error ends "; nothing was written".
 */
export async function writeNewFiles(files: [string, string | Uint8Array][], o: { uid?: number } = {}): Promise<void> {
  const written: string[] = [];
  const made: [string, string][] = [];
  try {
    for (const [path, content] of files) {
      const top = await ensurePrivateDir(dirname(path), o);
      if (top !== undefined) made.push([dirname(path), top]);
      try {
        await writeNewSecretFile(path, content);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SecretError(`${path} already exists (it appeared after hapi checked), and hapi never replaces it`);
        throw e;
      }
      written.push(path);
    }
  } catch (e) {
    for (const path of written.reverse()) await rm(path, { force: true });
    for (const [dir, top] of made.reverse()) {
      // Each level hapi made, deepest first, while it is empty.
      for (let d = resolve(dir); isWithin(d, resolve(top)); d = dirname(d)) {
        try {
          await rmdir(d);
        } catch {
          break;
        }
        if (d === resolve(top)) break;
      }
    }
    if (e instanceof Error) e.message = `${e.message}; nothing was written`;
    throw e;
  }
}

/** The lock file beside `store`: `.<basename>.lock` (`private/.secrets.enc.yaml.lock`). */
export function lockPath(store: string): string {
  return join(dirname(store), `.${basename(store)}.lock`);
}

/**
 * Run `fn` holding the lock on `store`: a file beside it, made with
 * O_CREAT|O_EXCL (`open(..., "wx")`), so only one `hapi secrets` command at a
 * time reads and changes a store and its recipients file. `what` names the
 * command in the lock's text. The lock is removed when `fn` settles, however
 * it ends. It guards this copy of the store on this machine; other machines
 * have their own copies, and `check` reports copies that disagree.
 *
 * If the lock already exists, another command holds it, or one was
 * interrupted (killed, a crash, a power cut) and left it: the SecretError
 * names the file, says how to tell, and never removes a lock hapi didn't make.
 */
export async function withStoreLock<T>(store: string, what: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(store);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(lock, "wx", 0o600);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const made = await lstat(lock).then(
        (s) => ` (made ${s.mtime.toISOString()})`,
        () => "",
      );
      throw new SecretError(
        `${lock} exists${made}: another hapi secrets command is using ${store}, or one was interrupted and left it. ` +
          `If none is running, run \`hapi secrets check\`, repair the store and its recipients file if it reports drift (docs/secrets.md#an-interrupted-command), then remove ${lock} and run this again`,
      );
    }
    if (code === "ENOENT") throw new SecretError(`no sops file at ${store}: ${dirname(store)} does not exist. Run \`mise run secrets:init\`, or give the path of your copy of the store`);
    throw new SecretError(`cannot make the lock file ${lock} beside the store${code ? ` (${code})` : ""}: hapi secrets ${what} needs to write in ${dirname(store)}`);
  }
  try {
    try {
      await fh.writeFile(`hapi secrets ${what}, pid ${process.pid}, started ${new Date().toISOString()}\n`);
    } finally {
      await fh.close();
    }
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}
