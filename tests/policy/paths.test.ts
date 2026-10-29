import { NON_ASCII_FOLDS } from "../../src/generate/hermes";
import { describe, expect, test } from "bun:test";
import { loadPolicy } from "../../src/policy/load";
import { effectiveModes, globMatches } from "../../src/policy/paths";
import { check } from "../../src/policy/schema";
import type { PathModes } from "../../src/policy/types";

const p = loadPolicy("policy");
const ALLOW: PathModes = { interactive: "allow", unattended: "allow", workers: "allow" };
const ASK: PathModes = { interactive: "ask", unattended: "deny", workers: "deny" };
const DENY: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };

describe("globMatches", () => {
  // [glob, path, matches]
  const cases: [string, string, boolean][] = [
    // A glob is anchored at the repo root and matched against the whole path.
    ["AGENTS.md", "AGENTS.md", true],
    ["AGENTS.md", "src/AGENTS.md", false],
    ["AGENTS.md", "AGENTS.md.bak", false],
    ["AGENTS.md", "xAGENTS.md", false],
    // Matching ignores case: Pi loads AGENTS.MD, and on macOS or Windows Agents.md is AGENTS.md.
    ["AGENTS.md", "agents.md", true],
    ["**/AGENTS.md", "pkg/Agents.MD", true],
    [".github/**", ".GitHub/workflows/ci.yml", true],
    // Case folding is Unicode's: the long s (U+017F) folds to "s", so it matches too.
    ["**/SOUL.md", "\u017FOUL.md", true],
    ["keys/**", "\u212Aeys/a.pem", true], // the Kelvin sign folds to "k"
    // Every other character is literal: "." is not a regex wildcard.
    ["mise.toml", "misextoml", false],
    // "dir/**" covers the directory itself and everything under it, dotfiles included.
    [".github/**", ".github", true],
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", ".github/.hidden", true],
    [".github/**", ".githubx/ci.yml", false],
    [".github/**", "src/.github/ci.yml", false],
    // "**" as a leading or middle segment matches zero or more segments.
    ["**/AGENTS.md", "AGENTS.md", true],
    ["**/AGENTS.md", "a/b/AGENTS.md", true],
    ["**/AGENTS.md", "a/b/AGENTS.mdx", false],
    ["a/**/b", "a/b", true],
    ["a/**/b", "a/x/y/b", true],
    ["a/**/b", "a/xb", false],
    ["**", "anything/at/all", true],
    ["**/**", "a", true],
    // "*" and "?" never cross a "/".
    ["*.md", "README.md", true],
    ["*.md", ".md", true],
    ["*.md", "docs/README.md", false],
    ["docs/*", "docs/a", true],
    ["docs/*", "docs/a/b", false],
    ["docs/?.md", "docs/a.md", true],
    ["docs/?.md", "docs/ab.md", false],
    ["docs/?.md", "docs//.md", false],
  ];
  for (const [glob, path, want] of cases) {
    test(`${JSON.stringify(glob)} ${want ? "matches" : "does not match"} ${JSON.stringify(path)}`, () => {
      expect(globMatches(glob, path)).toBe(want);
    });
  }
});

describe("effectiveModes", () => {
  test("the base policy, per file", () => {
    expect(effectiveModes(p, "AGENTS.md")).toEqual(ASK);
    expect(effectiveModes(p, ".github/workflows/ci.yml")).toEqual(ASK);
    expect(effectiveModes(p, ".pi/settings.json")).toEqual(DENY);
    expect(effectiveModes(p, "mise.toml")).toEqual(ASK);
    // Agent instruction files are protected at any depth ("**/AGENTS.md" matches the root too).
    expect(effectiveModes(p, "src/AGENTS.md")).toEqual(ASK);
    expect(effectiveModes(p, "pkg/web/CLAUDE.md")).toEqual(ASK);
    expect(effectiveModes(p, "pkg/web/.claude/settings.json")).toEqual(ASK);
    // Other globs are anchored at the root: only the root .coderabbit.yaml is CodeRabbit's config.
    expect(effectiveModes(p, "src/.coderabbit.yaml")).toEqual(ALLOW);
    expect(effectiveModes(p, "src/cli.ts")).toEqual(ALLOW);
  });

  test("git's own files are deny in every session: a .git dir at any depth, all of it, and a worktree's .git file", () => {
    // git runs commands that .git/config names (core.fsmonitor, diff.external) from argv commands.yaml allows.
    for (const path of [".git", ".git/config", ".git/hooks/pre-commit", "sub/.git/config", "sub/.git", ".GIT/Config", "a/b/.git/worktrees/x/gitdir"]) {
      expect([path, effectiveModes(p, path)]).toEqual([path, DENY]);
    }
    // Names that only start with ".git" are not git's own.
    for (const path of [".gitignore", ".gitattributes", "docs/.gitkeep", "src/.github/x.yml"]) expect([path, effectiveModes(p, path)]).toEqual([path, ALLOW]);
    expect(effectiveModes(p, ".github/workflows/ci.yml")).toEqual(ASK);
  });

  test("every other file mise reads config, tasks or locked tools from is protected like mise.toml, at any depth", () => {
    // From the pinned mise's `mise config ls` and task dirs; a later file overrides mise.toml's tasks. A lockfile
    // (mise.lock, mise.<env>.lock, mise.local.lock) names the URL and checksum mise installs each tool from.
    for (const path of [
      ".mise.toml",
      "mise.local.toml",
      ".mise.local.toml",
      "mise.ci.toml",
      ".mise.ci.toml",
      "mise/config.toml",
      "mise/conf.d/a.toml",
      "mise/tasks/test",
      ".mise/config.toml",
      ".mise/tasks/test",
      ".config/mise.toml",
      ".config/mise.local.toml",
      ".config/mise.ci.toml",
      ".config/mise/config.toml",
      ".config/mise/conf.d/a.toml",
      ".config/mise/tasks/test",
      "mise-tasks/test",
      ".mise-tasks/test",
      ".tool-versions",
      "pkg/.mise.toml",
      "pkg/.tool-versions",
      "pkg/mise.toml",
      "a/b/MISE.toml",
      "mise.lock",
      "mise.ci.lock",
      "mise.local.lock",
      "mise.ci.local.lock",
      "pkg/mise.lock",
      ".config/mise/mise.lock",
    ]) {
      expect([path, effectiveModes(p, path)]).toEqual([path, ASK]);
    }
    for (const path of ["src/mise.ts", "docs/mise.md", "misery.toml", ".config/other.toml", "mise-notes/a.md", "docs/mise.lockfile.md"]) expect([path, effectiveModes(p, path)]).toEqual([path, ALLOW]);
  });

  test("gitleaks's config and ignore file are protected at any depth: one could turn the secret scans off", () => {
    for (const path of [".gitleaks.toml", ".gitleaksignore", "pkg/.gitleaks.toml", "pkg/.GitleaksIgnore"]) expect([path, effectiveModes(p, path)]).toEqual([path, ASK]);
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

  test("the path is normalized first, so an alias can't dodge a glob", () => {
    for (const alias of ["./AGENTS.md", "docs/../AGENTS.md", "././AGENTS.md"]) {
      expect(effectiveModes(p, alias)).toEqual(ASK);
    }
    expect(effectiveModes(p, ".github//workflows/ci.yml")).toEqual(ASK);
    expect(effectiveModes(p, ".github/")).toEqual(ASK);
    expect(effectiveModes(p, "src/../.pi/x")).toEqual(DENY);
  });

  test("a path that isn't inside the repo is an error, not allow", () => {
    for (const bad of ["", ".", "./", "/etc/passwd", "/AGENTS.md", "..", "../AGENTS.md", "a/../../AGENTS.md"]) {
      expect(() => effectiveModes(p, bad)).toThrow(/repo-relative/);
    }
  });

  test("a path with NUL, a control character or a backslash is an error that names the problem", () => {
    expect(() => effectiveModes(p, "AGENTS.md\u0000.txt")).toThrow(/contains NUL \(U\+0000\)/);
    expect(() => effectiveModes(p, "AGENTS.md\n")).toThrow(/contains a control character \(U\+000A\)/);
    expect(() => effectiveModes(p, "a\u001b[31m")).toThrow(/control character \(U\+001B\)/);
    expect(() => effectiveModes(p, "a\u007fb")).toThrow(/control character \(U\+007F\)/);
    expect(() => effectiveModes(p, "a\u0085b")).toThrow(/control character \(U\+0085\)/); // C1 controls too
    expect(() => effectiveModes(p, ".github\\workflows\\ci.yml")).toThrow(/contains a backslash/);
    expect(() => effectiveModes(p, "AGENTS.md\\")).toThrow(/contains a backslash/);
    // The message shows the path escaped, so it prints safely.
    expect(() => effectiveModes(p, "a\u001bb")).toThrow('"a\\u001bb"');
    // Other non-ASCII characters are ordinary.
    expect(effectiveModes(p, "docs/café.md")).toEqual(ALLOW);
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
