/**
 * Rule 1 (design §3.3; H-087, H-089): where a worker's `write` or `edit` may go.
 *
 * A tool path is resolved exactly as Pi 1.3.0's file tools resolve it
 * (`resolveToCwd`, core/tools/path-utils.js:42-44 → utils/paths.js:59-87), then
 * its symlinks are followed the way `fs.writeFile` would follow them, a dangling
 * link included (write.js:44-47 creates the target). The real path is then:
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
import { isAbsolute, join, resolve, sep } from "node:path";
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

/**
 * The path a write to `abs` (absolute, normalized) would land on: the real
 * path of its longest existing prefix, then each next component that is a
 * symlink followed, dangling or not, until the rest doesn't exist.
 */
export function realPath(abs: string): string {
  let path = abs;
  for (let hops = 0; hops <= MAX_LINKS; hops++) {
    const parts = path.split("/").filter(Boolean);
    let i = parts.length;
    let real = "/";
    for (; i >= 0; i--) {
      try {
        real = realpathSync(`/${parts.slice(0, i).join("/")}`);
        break;
      } catch {
        // a shorter prefix, then
      }
    }
    if (i === parts.length) return real;
    const next = join(real, parts[i]!);
    let link: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // doesn't exist: the rest is literal
    }
    if (link === undefined) return join(real, ...parts.slice(i));
    path = resolve(real, link, ...parts.slice(i + 1));
  }
  throw new Error(`${abs}: too many levels of symbolic links`);
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
  const real = realPath(abs);
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

/** The real path of an existing dir, or the path itself when it doesn't exist (so nothing can be inside it). */
export function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

