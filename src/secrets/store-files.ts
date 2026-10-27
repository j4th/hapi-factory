/**
 * The files beside a sops store, and the helpers `hapi secrets init` and the
 * lifecycle commands (./init.ts, ./lifecycle.ts) share to write them
 * (spec §11.5):
 * - `exists`, `refuseCoinciding` and `refuseSharedDirs`: checks before any
 *   file is made;
 * - `configText`: the local config for a store and this machine's key;
 * - `writeNewFiles`: several new files as one step, each no-replace;
 * - `withStoreLock`: the store's lock, on the user's tmpfs, held by every
 *   lifecycle command and by `edit` while they read and change the store and
 *   its recipients file, so two of them can't interleave and lose an update.
 *
 * It imports ./files, ./interrupt and ./provider only, so init, lifecycle and
 * cli can all import it without a cycle.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { lstat, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { ensurePrivateDir, isWithin, realish, runtimeDir, secureDir, writeNewSecretFile } from "./files";
import { onInterrupt } from "./interrupt";
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

/**
 * The lock on `store`: `$XDG_RUNTIME_DIR/hapi/locks/<sha256 of the store's
 * real path>.lock`. It lives on the user's tmpfs, never beside the store: a
 * file in private/ (a git repo) could be committed, and a committed lock
 * would stop every other machine. A reboot clears it.
 */
export async function lockPath(store: string, env: Env): Promise<string> {
  const real = await realish(resolve(store));
  return join(runtimeDir(env), "locks", `${createHash("sha256").update(real).digest("hex")}.lock`);
}

/** Who holds a lock, as its one line records it. */
interface Holder {
  what: string;
  pid: number;
  /** The process's start time (`/proc/<pid>/stat`, clock ticks since boot), so a reused pid isn't taken for the holder. */
  start?: string;
  started: string;
}

/** Linux's largest pid (`/proc/sys/kernel/pid_max` can't exceed it). */
const PID_MAX = 4_194_304;

const HOLDER = /^hapi secrets ([a-z][a-z-]{0,30}), pid (\d{1,7})(?: \(start (\d{1,20})\))?, started (\d{4}-\d\d-\d\dT[0-9:.]+Z), id [0-9a-f]{8}, store /;

/** A process's start time in clock ticks since boot (field 22 of `/proc/<pid>/stat`), or undefined if it can't be read. */
function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The fields after the command name, which is in parentheses and may hold spaces: field 3 (state) is first.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** The lock's one line: the command, this process (pid and start time), when, a random id (so each holder's line is its own) and the store. */
function holderLine(what: string, store: string): string {
  const start = processStart(process.pid);
  return `hapi secrets ${what}, pid ${process.pid}${start === undefined ? "" : ` (start ${start})`}, started ${new Date().toISOString()}, id ${randomUUID().slice(0, 8)}, store ${store}\n`;
}

function parseHolder(text: string): Holder | undefined {
  const m = HOLDER.exec(text);
  if (m === null) return undefined;
  const pid = Number(m[2]);
  if (pid < 2 || pid > PID_MAX) return undefined;
  return { what: m[1]!, pid, ...(m[3] === undefined ? {} : { start: m[3] }), started: m[4]! };
}

const describeHolder = (h: Holder) => `hapi secrets ${h.what} (pid ${h.pid}, started ${h.started})`;

/** Whether the lock's process still runs: its pid exists, and (when both are known) started when the lock says. */
function running(h: Holder): boolean {
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: the pid exists (another user's process).
  }
  if (h.start !== undefined) {
    const now = processStart(h.pid);
    if (now !== undefined && now !== h.start) return false;
  }
  return true;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Remove `path` if it still holds exactly `text` (so only the lock this command made). Synchronous, for a signal handler. */
function removeIfOursSync(path: string, text: string): boolean {
  try {
    if (readFileSync(path, "utf8") !== text) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

async function removeIfOurs(path: string, text: string): Promise<void> {
  if ((await readText(path)) === text) await rm(path, { force: true });
}

/**
 * Clear a lock whose process is gone, under a second lock (`<lock>.clearing`)
 * so two commands that find the same stale lock can't both clear it and then
 * both take a new one: only the command holding `.clearing` removes a lock it
 * didn't make, and only if the lock still holds the stale line it read.
 */
async function clearStale(lock: string, seen: string, holder: Holder, o: { store: string; what: string }): Promise<void> {
  const guard = `${lock}.clearing`;
  const mine = holderLine(o.what, o.store);
  try {
    await writeNewSecretFile(guard, mine);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const other = parseHolder((await readText(guard)) ?? "");
    if (other !== undefined && running(other)) throw new SecretError(`another hapi secrets command, ${describeHolder(other)}, is clearing a stale lock on ${o.store}: run this again in a moment`);
    throw new SecretError(`${guard} was left by an interrupted hapi secrets command while it cleared a stale lock on ${o.store}: if none is running, remove ${guard} and run this again`);
  }
  const release = onInterrupt(() => void removeIfOursSync(guard, mine));
  try {
    if ((await readText(lock)) === seen) {
      await rm(lock, { force: true });
      console.error(`hapi secrets ${o.what}: removed a stale lock on ${o.store}: ${describeHolder(holder)} is no longer running`);
    }
  } finally {
    await removeIfOurs(guard, mine);
    release();
  }
}

/**
 * Run `fn` holding the lock on `store` (`lockPath`), so only one `hapi
 * secrets` command at a time reads and changes a store and its recipients
 * file. `what` names the command in the lock's line. The lock is made whole
 * and at once (a temp file hard-linked into place, which fails if the lock
 * exists), and holds this process's pid. It guards this copy of the store on
 * this machine, for this user; other machines have their own copies, and
 * `check` reports copies that disagree.
 *
 * The lock is removed when `fn` settles, however it ends, and also on SIGINT,
 * SIGTERM or SIGHUP (./interrupt.ts): Ctrl-C at the word prompt leaves no
 * lock. If a lock exists:
 * - its process still runs: a SecretError names it; hapi never takes a live
 *   lock;
 * - its process is gone (killed with SIGKILL, a crash): the lock is stale, so
 *   hapi removes it, says so in one line, and takes the lock;
 * - it names no process: a SecretError says to remove it by hand.
 */
export async function withStoreLock<T>(store: string, what: string, fn: () => Promise<T>, o: { env: Env; uid?: number }): Promise<T> {
  const rt = runtimeDir(o.env);
  const uid = o.uid === undefined ? {} : { uid: o.uid };
  await secureDir(rt, dirname(rt), uid);
  await secureDir(join(rt, "locks"), dirname(rt), uid);
  const lock = await lockPath(store, o.env);
  const mine = holderLine(what, resolve(store));
  // Registered first, so a signal from here on never leaves this command's lock behind.
  const release = onInterrupt(() => (removeIfOursSync(lock, mine) ? `released the lock on ${store}` : undefined), `hapi secrets ${what}`);
  try {
    for (let attempt = 1; ; attempt++) {
      if (attempt > 4) throw new SecretError(`the lock on ${store} (${lock}) keeps changing hands: run this again`);
      try {
        await writeNewSecretFile(lock, mine);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new SecretError(`cannot make the lock on ${store} (${lock})${(e as NodeJS.ErrnoException).code ? ` (${(e as NodeJS.ErrnoException).code})` : ""}`);
      }
      const seen = await readText(lock);
      if (seen === undefined) continue; // released meanwhile
      const holder = parseHolder(seen);
      if (holder === undefined) {
        throw new SecretError(`${lock}, the lock on ${store}, is not one hapi wrote (it names no process): if no hapi secrets command is running, remove it and run this again`);
      }
      if (running(holder)) {
        throw new SecretError(`another command, ${describeHolder(holder)}, is using ${store}: wait for it to end, or stop it, and run this again. hapi never takes the lock (${lock}) while its process runs`);
      }
      await clearStale(lock, seen, holder, { store, what });
    }
    return await fn();
  } finally {
    await removeIfOurs(lock, mine);
    release();
  }
}
