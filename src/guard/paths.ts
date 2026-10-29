/**
 * Rule 1 (design §3.3; H-087, H-089): where a worker's `write` or `edit` may go.
 *
 * A tool path is resolved exactly as Pi 1.3.0's file tools resolve it
 * (`resolveToCwd`, core/tools/path-utils.js:42-44 → utils/paths.js:59-87),
 * which is lexical, as Pi's is. Then its symlinks are followed component by
 * component, as the kernel follows them for `fs.writeFile`, a dangling link
 * included (write.js:44-47 creates the target). A link's target is spliced in
 * unnormalized, so a `..` in it applies to the directory the link before it
 * points at, never lexically: with `a -> .git/objects`, `a/../hooks` is
 * `.git/hooks`. (`realpathSync`, Bun's as well as Node's, collapses `x/..`
 * before following `x`, so it isn't used for this.) A `..` after a component
 * that doesn't exist can't be resolved by the kernel either, and is blocked.
 * The real path is then:
 *
 * - inside the worktree (`ctx.cwd`, itself resolved): relativized and checked
 *   with `effectiveModes` from src/policy/paths.ts, bundled in, so the guard and
 *   the policy share one matcher and one glob dialect. hapi-guard.json's table
 *   is glob → deny for every glob that isn't `allow` for workers, so a file is
 *   blocked when its workers mode isn't allow. A path effectiveModes rejects
 *   (the worktree root, NUL, a control character, a backslash) is blocked;
 * - under the guard's own ledger dir: blocked (rule 3's residual is the shell,
 *   not the write tool);
 * - under /tmp: allowed;
 * - anywhere else: blocked.
 *
 * An existing file with more than one hard link is blocked too: it may be a
 * protected file under another name. Reads are not checked.
 */
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveModes } from "../policy/paths";
import type { PathModes } from "../policy/types";

/** Pi's UNICODE_SPACES (utils/paths.js:6). */
const UNICODE_SPACES = /[  -   　]/g;

/**
 * A tool path as Pi resolves it: Unicode spaces become " ", one leading "@" is
 * stripped, "~" and "~/" expand to `home`, a file:// URL becomes a path, then
 * `path.resolve(cwd, p)`.
 */
export function piResolve(input: string, cwd: string, home: string): string {
  let p = input.replace(UNICODE_SPACES, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  else if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Linux's SYMLOOP_MAX. */
const MAX_LINKS = 40;

/** A path the kernel can't resolve: a ".." after `missing`, a component that doesn't exist. */
export class Unresolvable extends Error {
  override name = "Unresolvable";
  constructor(readonly missing: string) {
    super(`${missing} doesn't exist, and a ".." follows it`);
  }
}

/**
 * The path a write to `abs` (absolute; "." and ".." allowed) would land on, by
 * the kernel's rules: each component in turn, a symlink's target spliced in
 * unnormalized (from "/" when absolute) and walked the same way, ".." the
 * parent of the real path so far. From the first component that doesn't
 * exist, the rest is literal: the write, or `mkdir -p`, creates it. Throws
 * Unresolvable for a ".." after that point, and an Error after MAX_LINKS links.
 */
export function realPath(abs: string): string {
  const todo = abs.split("/");
  let cur = "/";
  let missing: string | undefined;
  let links = 0;
  while (todo.length > 0) {
    const c = todo.shift()!;
    if (c === "" || c === ".") continue;
    if (c === "..") {
      if (missing !== undefined) throw new Unresolvable(missing);
      cur = dirname(cur);
      continue;
    }
    const next = cur === "/" ? `/${c}` : `${cur}/${c}`;
    if (missing === undefined) {
      let link: string | undefined;
      try {
        if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
      } catch {
        missing = next;
      }
      if (link !== undefined) {
        if (++links > MAX_LINKS) throw new Error(`${abs}: too many levels of symbolic links`);
        if (link.startsWith("/")) cur = "/";
        todo.unshift(...link.split("/"));
        continue;
      }
    }
    cur = next;
  }
  return cur;
}

/** Whether `p` is `root` or under it. Both are real, absolute paths. */
export const within = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

const DENY: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };

/** hapi-guard.json's glob → deny table, in effectiveModes' shape. */
export function protectedTable(globs: Record<string, "deny">): { protectedPaths: Record<string, PathModes> } {
  return { protectedPaths: Object.fromEntries(Object.keys(globs).map((g) => [g, DENY])) };
}

export interface Roots {
  /** The worktree, real. */
  work: string;
  /** /tmp, real. */
  tmp: string;
  /** The guard's ledger dir (under /tmp). */
  ledger: string;
  table: { protectedPaths: Record<string, PathModes> };
}

/** A blocked write names its rule and the path it judged: repo-relative inside the worktree, real outside it. */
export type Verdict = { block: false } | { block: true; rule: string; reason: string; path: string };

/** Whether a repo-relative path is protected for workers; a path effectiveModes rejects counts as protected. */
export function isProtected(table: Roots["table"], rel: string): boolean {
  try {
    return effectiveModes(table, rel).workers !== "allow";
  } catch {
    return true;
  }
}

/** The repo-relative form of a real path inside the worktree. */
export const relTo = (work: string, real: string): string => (real === work ? "" : real.slice(work.length + 1));

/** Rule 1 for one write or edit path, as given to the tool. */
export function checkWrite(r: Roots, input: string, cwd: string, home: string): Verdict {
  const abs = piResolve(input, cwd, home);
  let real: string;
  try {
    real = realPath(abs);
  } catch (e) {
    const why =
      e instanceof Unresolvable
        ? `resolves through ${e.missing}, which doesn't exist, and then "..", so where it lands can't be known`
        : "goes through too many levels of symbolic links";
    return { block: true, rule: "invalid-path", reason: `${input} ${why}`, path: abs };
  }
  if (within(real, r.work)) {
    const rel = relTo(r.work, real);
    if (isProtected(r.table, rel)) {
      return { block: true, rule: "protected-path", reason: `${rel || "."} is a protected path; workers may not change it`, path: rel || "." };
    }
    let links = 1;
    try {
      const st = statSync(real);
      if (st.isFile()) links = st.nlink;
    } catch {
      // a new file
    }
    if (links > 1) return { block: true, rule: "protected-path", reason: `${rel} has ${links} hard links, so it may be a protected file under another name`, path: rel };
    return { block: false };
  }
  if (within(real, r.ledger)) return { block: true, rule: "guard-ledger", reason: `${real} is hapi-guard's own budget ledger`, path: real };
  if (within(real, r.tmp)) return { block: false };
  return { block: true, rule: "outside-worktree", reason: `${real} is outside the worktree; workers write only there and under /tmp`, path: real };
}

/**
 * The real path of an existing dir, or the path itself when it doesn't exist (so nothing can be inside it).
 * Only for the guard's roots (the worktree, /tmp, Pi's dir, the ledger, /out), which hold no "..", so
 * realpathSync's lexical first step can't misplace them.
 */
export function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

