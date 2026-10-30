import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NON_ASCII_FOLDS } from "../../src/generate/hermes";
import { loadPolicy } from "../../src/policy/load";
import { effectiveModes, globMatches } from "../../src/policy/paths";
import { check } from "../../src/policy/schema";
import type { PathModes } from "../../src/policy/types";

const p = loadPolicy("policy");
const ALLOW: PathModes = { interactive: "allow", unattended: "allow", workers: "allow" };
const ASK: PathModes = { interactive: "ask", unattended: "deny", workers: "deny" };
const DENY: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };

/**
 * The shared vectors, tests/fixtures/path-vectors.json, in the shape of
 * command-vectors.json: hapi-guard runs the same file (tests/guard/paths.test.ts
 * and bundle.test.ts), and Plan 04's hapi-path-guard must too (H-087, H-093).
 */
interface GlobVector {
  glob: string;
  path: string;
  matches: boolean;
}
interface PathVector extends PathModes {
  path: string;
  /** effectiveModes throws an error containing this, and every enforcer denies the path. */
  reason?: string;
}
const vectors = JSON.parse(readFileSync("tests/fixtures/path-vectors.json", "utf8")) as { globs: GlobVector[]; paths: PathVector[] };

describe("globMatches (shared vectors)", () => {
  for (const { glob, path, matches } of vectors.globs) {
    test(`${JSON.stringify(glob)} ${matches ? "matches" : "does not match"} ${JSON.stringify(path)}`, () => {
      expect(globMatches(glob, path)).toBe(matches);
    });
  }
});

describe("effectiveModes", () => {
  test("every shared path vector: the base policy's modes, or an error naming the problem (and deny)", () => {
    for (const { path, reason, ...modes } of vectors.paths) {
      if (reason === undefined) expect([path, effectiveModes(p, path)]).toEqual([path, modes]);
      else {
        expect(() => effectiveModes(p, path)).toThrow(reason);
        expect([path, modes]).toEqual([path, DENY]);
      }
    }
  });

  test("the vectors keep every kind of case: case folding, git's files, mise, aliases and each error", () => {
    const paths = new Set(vectors.paths.map((v) => v.path));
    for (const path of ["AGENTS.MD", "README.md", ".git/config", "sub/.git", ".GIT/Config", ".config/mise/mise.lock", "pkg/.GitleaksIgnore"]) {
      expect([path, paths.has(path)]).toEqual([path, true]);
    }
    for (const path of ["docs/../AGENTS.md", ".github/", "src/../.pi/x", "", "../AGENTS.md", "AGENTS.md\u0000.txt", "a\u0085b", "AGENTS.md\\", "docs/café.md"]) {
      expect([path, paths.has(path)]).toEqual([path, true]);
    }
    expect(new Set(vectors.paths.filter((v) => v.reason !== undefined).map((v) => v.reason)).size).toBe(7);
  });

  test("the strictest mode across every matching glob wins, per session, whatever the order", () => {
    const broad: PathModes = { interactive: "allow", unattended: "deny", workers: "ask" };
    const narrow: PathModes = { interactive: "ask", unattended: "allow", workers: "allow" };
    const want: PathModes = { interactive: "ask", unattended: "deny", workers: "ask" };
    // Neither first, last nor most-specific match: each order gives the same result.
    expect(effectiveModes({ protectedPaths: { "a/**": broad, "a/b/**": narrow } }, "a/b/c")).toEqual(want);
    expect(effectiveModes({ protectedPaths: { "a/b/**": narrow, "a/**": broad } }, "a/b/c")).toEqual(want);
    // A path only the broad glob matches gets the broad glob's modes.
    expect(effectiveModes({ protectedPaths: { "a/b/**": narrow, "a/**": broad } }, "a/x")).toEqual(broad);
  });

  test("a narrower glob that names allow can't loosen a broader one", () => {
    const policy = { protectedPaths: { ...p.protectedPaths, ".github/workflows/**": ALLOW } };
    expect(effectiveModes(policy, ".github/workflows/ci.yml")).toEqual(ASK);
  });

  test("no matching glob means allow in every session", () => {
    expect(effectiveModes({ protectedPaths: {} }, "AGENTS.md")).toEqual(ALLOW);
  });

  test("an error shows the path JSON-escaped, so it prints safely", () => {
    expect(() => effectiveModes(p, "a\u001bb")).toThrow('"a\\u001bb"');
  });

  test("the result is a fresh object", () => {
    const m = effectiveModes(p, "src/cli.ts");
    m.workers = "deny";
    expect(effectiveModes(p, "src/cli.ts")).toEqual(ALLOW);
  });
});

test("only the long s and the Kelvin sign fold to an ASCII letter (src/generate/hermes.ts's NON_ASCII_FOLDS)", () => {
  const letter = /^[a-z]$/iu;
  const found: Record<string, string> = {};
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates aren't code points of a string
    const ch = String.fromCodePoint(cp);
    if (letter.test(ch)) for (const a of "abcdefghijklmnopqrstuvwxyz") if (new RegExp(`^${a}$`, "iu").test(ch)) found[a] = ch;
  }
  expect(found).toEqual({ ...NON_ASCII_FOLDS });
});

describe("protected-path glob syntax (schema)", () => {
  const modes = { interactive: "ask", unattended: "deny", workers: "deny" };
  const keyIssue = (glob: string) =>
    check("policy-protected-paths", { protected_paths: { [glob]: modes } }).map((i) => i.message);

  test("canonical globs are accepted", () => {
    for (const glob of ["AGENTS.md", ".github/**", "**/AGENTS.md", "a/**/b", "*.md", "docs/?.md", "src/odoo_mcp/x-y.py"]) {
      expect(keyIssue(glob)).toEqual([]);
    }
  });

  test("a glob with another spelling of a path, or another glob dialect, is rejected", () => {
    for (const glob of [
      "./AGENTS.md", // a "." segment
      "a/./b",
      "a/../AGENTS.md", // a ".." segment
      "/AGENTS.md", // absolute
      ".github/", // a trailing slash
      ".github//workflows", // an empty segment
      "a\\b", // a backslash
      "[ab].md", // character classes
      "{a,b}.md", // brace expansion
      "!AGENTS.md", // negation
      "a**", // "**" not a whole segment
      "**a/b",
      "a/***",
      "**/\u00C4GENTS.md", // non-ASCII: its case folding could differ between guards
      "\u017FOUL.md", // the long s, which folds to "s"
      "a\u00A0b", // a no-break space
      "",
    ]) {
      expect(keyIssue(glob)).toEqual(["invalid key"]);
    }
  });

  test("the overlay schema uses the same glob syntax", () => {
    const issues = check("repo-overlay", { protected_paths: { "./AGENTS.md": { workers: "deny" } } });
    expect(issues).toEqual([{ path: "/protected_paths/.~1AGENTS.md", message: "invalid key" }]);
  });
});
