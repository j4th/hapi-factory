/**
 * How protected-path globs apply to a file (spec §8.2). This is the one binding
 * rule; every guard and generator must use `effectiveModes` or implement exactly
 * the same rule (Task 3's generators, Plan 04's hapi-path-guard and hapi-guard,
 * CI path checks):
 *
 *   A file's effective mode, for each session kind, is the STRICTEST mode
 *   (allow < ask < deny) across EVERY glob that matches it. Never the first,
 *   last or most specific match. A file no glob matches is allow everywhere.
 *
 * So adding a glob can only tighten: a narrower or later glob never loosens a
 * broader one, and `allow` in an entry means "this glob adds no rule for that
 * session", not "permit".
 *
 * Glob syntax (the schema's `pathGlob` enforces it): segments split on "/",
 * anchored at the repo root and matched against the whole path, case-sensitively.
 * - `**` as a whole segment matches zero or more segments, so ".github/**" also
 *   matches ".github" itself;
 * - `*` matches any run of characters within one segment, `?` exactly one;
 * - every other character is literal, and dotfiles are not special.
 * No ".", ".." or empty segment, and no `[`, `]`, `{`, `}`, `!` or backslash, so
 * no other glob dialect can read a different meaning into a key.
 */
import { posix } from "node:path";
import type { Mode, PathModes, Policy } from "./types";

/** The session kinds, in the order of PathModes. */
export const SESSIONS = ["interactive", "unattended", "workers"] as const;

/** Tightening order: allow < ask < deny. */
export const RANK: Record<Mode, number> = { allow: 0, ask: 1, deny: 2 };

/** The modes of a file no glob matches. */
export const UNPROTECTED: Readonly<PathModes> = Object.freeze({ interactive: "allow", unattended: "allow", workers: "allow" });

const compiled = new Map<string, RegExp>();

function globRegExp(glob: string): RegExp {
  const cached = compiled.get(glob);
  if (cached) return cached;
  // Consecutive "**" segments mean the same as one.
  const segs = glob.split("/").filter((s, i, all) => !(s === "**" && all[i - 1] === "**"));
  let src = "";
  segs.forEach((seg, i) => {
    const first = i === 0;
    const last = i === segs.length - 1;
    if (seg === "**") {
      if (first && last) src += "[^/]+(?:/[^/]+)*"; // any path
      else if (first) src += "(?:[^/]+/)*"; // zero or more leading segments
      else src += "(?:/[^/]+)*"; // zero or more segments after the previous one
      return;
    }
    // After a leading "**" (which ends in "/"), the next segment needs no separator.
    const sep = first || (i === 1 && segs[0] === "**") ? "" : "/";
    const body = seg.replace(/[.+^${}()|[\]\\*?]/g, (c) => (c === "*" ? "[^/]*" : c === "?" ? "[^/]" : `\\${c}`));
    src += sep + body;
  });
  const re = new RegExp(`^${src}$`);
  compiled.set(glob, re);
  return re;
}

/**
 * Whether a protected-path glob matches a path. The path must already be
 * normalized and repo-relative ("a/b", no "./", "//" or trailing "/");
 * `effectiveModes` normalizes it for you.
 */
export function globMatches(glob: string, path: string): boolean {
  return globRegExp(glob).test(path);
}

/**
 * Normalize a repo-relative path: resolve "." and ".." segments and drop
 * repeated and trailing slashes. Throws if the path is empty, absolute, the repo
 * root itself, or outside the repo, so a guard never treats it as unprotected.
 */
function normalize(path: string): string {
  const fail = () => new Error(`not a repo-relative file path: ${JSON.stringify(path)}`);
  if (path === "" || path.startsWith("/")) throw fail();
  const n = posix.normalize(path).replace(/\/+$/, "");
  if (n === "" || n === "." || n === ".." || n.startsWith("../")) throw fail();
  return n;
}

/**
 * The effective modes of one file: for each session kind, the strictest mode
 * across every glob in `p.protectedPaths` that matches it, or allow when none
 * does. The path is normalized first, so "./AGENTS.md" and "docs/../AGENTS.md"
 * are AGENTS.md. Throws on a path that isn't a repo-relative file path.
 *
 * A guard resolves symlinks and makes the path relative to the repo root before
 * calling this. An action on a directory (a rename or a recursive delete) must
 * check the files under it too.
 */
export function effectiveModes(p: Pick<Policy, "protectedPaths">, path: string): PathModes {
  const file = normalize(path);
  const modes: PathModes = { ...UNPROTECTED };
  for (const [glob, entry] of Object.entries(p.protectedPaths)) {
    if (!globMatches(glob, file)) continue;
    for (const s of SESSIONS) if (RANK[entry[s]] > RANK[modes[s]]) modes[s] = entry[s];
  }
  return modes;
}
