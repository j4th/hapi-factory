import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRuleIssues, matchCommand, REASON_CODES } from "../../src/policy/commands";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { check } from "../../src/policy/schema";
import type { CommandRule } from "../../src/policy/types";

const rules = loadPolicy("policy").commands.hermes.allow;
/** The stable code a reason starts with: "bad-arg: ..." -> "bad-arg". */
const code = (reason: string): string => reason.slice(0, reason.indexOf(":"));
const rule = (r: Partial<CommandRule> & Pick<CommandRule, "command">): CommandRule => ({ args: [], flags: {}, ...r });

describe("matchCommand on policy/commands.yaml: the security review's cases", () => {
  test("allows pushing a plan branch to origin", () => {
    expect(matchCommand(rules, ["git", "push", "origin", "plan/odoo-mcp"])).toEqual({
      allowed: true,
      rule: "git-push-plan",
      reason: "match: rule git-push-plan",
    });
  });

  const denied: [string[], string][] = [
    [["git", "push", "origin", "plan/x:main"], "bad-arg"], // a refspec that updates main
    [["git", "push", "origin", "+plan/x"], "bad-arg"], // a forced refspec
    [["git", "push", "--force", "origin", "plan/x"], "no-rule"], // a flag before the exact leading tokens
    [["git", "push", "origin", "plan/x", "--delete"], "unknown-flag"],
    [["git", "push", "--mirror"], "no-rule"],
    [["git", "push", "origin", "main"], "bad-arg"],
  ];
  for (const [argv, want] of denied) {
    test(`denies ${argv.join(" ")} (${want})`, () => {
      const r = matchCommand(rules, argv);
      expect(r.allowed).toBe(false);
      expect(code(r.reason)).toBe(want);
    });
  }

  test("the reason names the token and the rule", () => {
    expect(matchCommand(rules, ["git", "push", "origin", "plan/x", "--delete"])).toEqual({
      allowed: false,
      rule: "git-push-plan",
      reason: 'unknown-flag: "--delete" is not an allowed flag of rule git-push-plan',
    });
    const bad = matchCommand(rules, ["git", "push", "origin", "plan/x:main"]);
    expect(bad.reason).toContain('"plan/x:main"');
    expect(bad.reason).toContain("^plan/[a-z0-9][a-z0-9-]*$");
  });

  test("git global options never match: the leading tokens are exact", () => {
    for (const argv of [
      ["git", "-c", "core.sshCommand=sh", "push", "origin", "plan/x"],
      ["git", "-c", "core.hooksPath=/tmp/h", "commit", "-m", "x"],
      ["git", "--git-dir=/tmp/x/.git", "status"],
      ["git", "-C", "/tmp", "diff"],
    ]) {
      expect(matchCommand(rules, argv)).toEqual({ allowed: false, reason: expect.stringMatching(/^no-rule: /) });
    }
  });
});

describe("git diff, log and commit take only their listed flags", () => {
  const cases: [string[], boolean][] = [
    // diff: --stat, --name-only, --name-status, --cached, --no-color, plus safe revisions and paths
    [["git", "diff", "--stat", "--name-only", "--name-status", "--cached", "--no-color"], true],
    [["git", "diff", "main...plan/x", "src/cli.ts"], true],
    [["git", "diff", "--output=/tmp/x"], false],
    [["git", "diff", "--ext-diff"], false],
    [["git", "diff", "--textconv"], false],
    [["git", "diff", "/etc/passwd", "/dev/null"], false], // would act as --no-index outside the repo
    // log: --oneline, -n with a number, --stat, --no-color
    [["git", "log", "--oneline", "-n", "20", "--stat", "--no-color"], true],
    [["git", "log", "-n", "lots"], false],
    [["git", "log", "--output=/tmp/x"], false],
    [["git", "log", "--ext-diff"], false],
    [["git", "log", "--textconv"], false],
    [["git", "log", "-c"], false],
    // commit: -m with a message, --trailer with a value
    [["git", "commit", "-m", "fix: x", "--trailer", "Claude-Session: https://claude.ai/code/session_x"], true],
    [["git", "commit", "--no-verify", "-m", "x"], false],
    [["git", "commit", "-n", "-m", "x"], false], // -n is --no-verify for commit
    [["git", "commit", "-c", "HEAD"], false],
    [["git", "commit", "--amend", "-m", "x"], false],
  ];
  for (const [argv, allowed] of cases) {
    test(`${allowed ? "allows" : "denies"} ${argv.join(" ")}`, () => {
      expect(matchCommand(rules, argv).allowed).toBe(allowed);
    });
  }
});

interface Vector {
  argv: string[];
  allowed: boolean;
  reason?: string;
}
const vectors = JSON.parse(readFileSync("tests/fixtures/command-vectors.json", "utf8")) as Vector[];

describe("shared command vectors (tests/fixtures/command-vectors.json, also run by Plan 04's Python hook)", () => {
  test("the fixture is well formed", () => {
    expect(vectors.length).toBeGreaterThan(50);
    for (const v of vectors) {
      expect(Object.keys(v).every((k) => ["argv", "allowed", "reason"].includes(k))).toBe(true);
      expect(Array.isArray(v.argv) && v.argv.every((t) => typeof t === "string")).toBe(true);
      expect(typeof v.allowed).toBe("boolean");
      if (v.reason !== undefined) expect(REASON_CODES as readonly string[]).toContain(v.reason);
    }
  });

  test("every rule in policy/commands.yaml is exercised by an allowed vector", () => {
    const used = new Set(vectors.filter((v) => v.allowed).map((v) => matchCommand(rules, v.argv).rule));
    expect([...used].sort()).toEqual(Object.keys(rules).sort());
  });

  for (const v of vectors) {
    test(`${JSON.stringify(v.argv)} is ${v.allowed ? "allowed" : `denied (${v.reason})`}`, () => {
      const r = matchCommand(rules, v.argv);
      expect(r.allowed).toBe(v.allowed);
      if (v.reason !== undefined) expect(code(r.reason)).toBe(v.reason);
    });
  }
});

describe("matchCommand semantics", () => {
  test("an empty argv is denied", () => {
    expect(matchCommand(rules, [])).toEqual({ allowed: false, reason: "empty-argv: no command" });
  });

  test("patterns are full matches, even with a top-level alternation", () => {
    const r = { x: rule({ command: ["x"], args: ["^a|b$"] }) };
    expect(matchCommand(r, ["x", "a"]).allowed).toBe(true);
    expect(matchCommand(r, ["x", "b"]).allowed).toBe(true);
    expect(code(matchCommand(r, ["x", "axyz"]).reason)).toBe("bad-arg");
    expect(code(matchCommand(r, ["x", "zzb"]).reason)).toBe("bad-arg");
    // "$" never matches before a trailing newline (Python's re.match pitfall).
    expect(code(matchCommand({ x: rule({ command: ["x"], args: ["^a$"] }) }, ["x", "a\n"]).reason)).toBe("bad-arg");
  });

  test("a flag's value is the next token, even when it starts with '-'", () => {
    const r = { x: rule({ command: ["x"], flags: { "-m": { value: "^[^\\x00]+$" }, "-q": {} } }) };
    expect(matchCommand(r, ["x", "-m", "-q"]).allowed).toBe(true);
    expect(matchCommand(r, ["x", "-q", "-m", "a", "-m", "b", "-q"]).allowed).toBe(true); // flags may repeat
    expect(code(matchCommand(r, ["x", "-q", "-m"]).reason)).toBe("missing-value");
    expect(code(matchCommand(r, ["x", "-q", "a"]).reason)).toBe("extra-arg");
  });

  test("positionals fill args in order, then up to rest.max more", () => {
    const r = { x: rule({ command: ["x"], args: ["^a$", "^b$"], rest: { pattern: "^c$", max: 2 } }) };
    expect(matchCommand(r, ["x", "a", "b"]).allowed).toBe(true);
    expect(matchCommand(r, ["x", "a", "b", "c", "c"]).allowed).toBe(true);
    expect(code(matchCommand(r, ["x", "a", "b", "c", "c", "c"]).reason)).toBe("extra-arg");
    expect(code(matchCommand(r, ["x", "b", "a"]).reason)).toBe("bad-arg");
    expect(code(matchCommand(r, ["x", "a"]).reason)).toBe("missing-arg");
  });

  test("allowed when any rule matches, whatever the order", () => {
    const one = rule({ command: ["x"], args: ["^1$"] });
    const two = rule({ command: ["x"], args: ["^2$"] });
    expect(matchCommand({ one, two }, ["x", "2"])).toEqual({ allowed: true, rule: "two", reason: "match: rule two" });
    expect(matchCommand({ two, one }, ["x", "2"])).toEqual({ allowed: true, rule: "two", reason: "match: rule two" });
  });

  test("a denial reports the candidate with the longest command, then the first in order", () => {
    const short = rule({ command: ["x"] });
    const long = rule({ command: ["x", "y"] });
    for (const rs of [{ short, long }, { long, short }]) {
      const r = matchCommand(rs, ["x", "y", "--bad"]);
      expect(r).toEqual({ allowed: false, rule: "long", reason: expect.stringMatching(/^unknown-flag: /) });
    }
    const a = rule({ command: ["x"], args: ["^a$"] });
    const b = rule({ command: ["x"], args: ["^b$"] });
    expect(matchCommand({ a, b }, ["x", "c"]).rule).toBe("a");
    expect(matchCommand({ b, a }, ["x", "c"]).rule).toBe("b");
    // No candidate: no rule is named.
    expect(matchCommand({ a, b }, ["y"])).toEqual({ allowed: false, reason: expect.stringMatching(/^no-rule: /) });
  });

  test("only own flag names count", () => {
    const r = { x: rule({ command: ["x"] }) };
    expect(code(matchCommand(r, ["x", "--constructor"]).reason)).toBe("unknown-flag");
    expect(code(matchCommand(r, ["x", "-__proto__"]).reason)).toBe("unknown-flag");
  });
});

describe("commandRuleIssues", () => {
  test("the policy's rules all compile", () => {
    expect(commandRuleIssues(rules)).toEqual([]);
  });

  test("a pattern that doesn't compile is reported at its path", () => {
    const issues = commandRuleIssues({
      bad: rule({ command: ["x"], args: ["^ok$", "^[a-$"], rest: { pattern: "^(a$", max: 1 }, flags: { "-n": { value: "^a{2,1}$" } } }),
    });
    expect(issues.map((i) => i.path)).toEqual(["/bad/args/1", "/bad/rest/pattern", "/bad/flags/-n/value"]);
    expect(issues.every((i) => i.message.startsWith("invalid regular expression"))).toBe(true);
  });
});

describe("policy-commands schema", () => {
  const base = () => ({
    hermes: { allow: { r: { command: ["git", "status"], args: [] as string[], flags: {} as Record<string, unknown> } } },
    workers: { tools: ["read"] },
  });
  const issuesFor = (mutate: (c: ReturnType<typeof base>) => void) => {
    const c = base();
    mutate(c);
    return check("policy-commands", c);
  };

  test("a minimal rule is valid", () => {
    expect(issuesFor(() => {})).toEqual([]);
  });

  test("the old glob-string list is rejected", () => {
    expect(check("policy-commands", { hermes: { allow: ["git push origin plan/*"] }, workers: { tools: ["read"] } })).toEqual([
      { path: "/hermes/allow", message: "must be object" },
    ]);
  });

  test("args, flags and command are required; unknown rule keys are rejected", () => {
    const c = { hermes: { allow: { r: { command: ["git"], anything: true } } }, workers: { tools: ["read"] } };
    expect(check("policy-commands", c).map((i) => `${i.path}: ${i.message}`)).toEqual([
      "/hermes/allow/r/anything: unknown key",
      "/hermes/allow/r/args: missing required key",
      "/hermes/allow/r/flags: missing required key",
    ]);
  });

  test("portable, anchored patterns are accepted", () => {
    for (const p of [
      "^plan/[a-z0-9][a-z0-9-]*$",
      "^(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$",
      "^[^\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f$`]{1,5000}$",
      "^a\\\\$", // a literal backslash, then the end anchor
      "^(?:a|b)(?=c)c\\u00e9$",
    ]) {
      expect(issuesFor((c) => (c.hermes.allow.r.args = [p]))).toEqual([]);
    }
  });

  test("unanchored or non-portable patterns are rejected", () => {
    for (const p of [
      "plan/.*", // not anchored at the start
      "^plan/x", // not anchored at the end
      "^plan/x\\$", // ends in a literal "$", not the end anchor
      "^\\d+$", // shorthand classes differ between JS and Python
      "^\\w+$",
      "^a\\sb$",
      "^\\bword$",
      "^(?<=a)b$", // lookbehind
      "^(?<name>a)$", // named group (JS)
      "^(?P<name>a)$", // named group (Python)
      "^(a)\\1$", // backreference
      "^(?i)a$", // inline flags
      "^\\Aa$",
      "^\\p{L}$",
      "^\\cA$",
      "^a\u0000$",
    ]) {
      expect(issuesFor((c) => (c.hermes.allow.r.args = [p]))).toEqual([
        { path: "/hermes/allow/r/args/0", message: expect.stringMatching(/^must match pattern/) },
      ]);
    }
  });

  test("flag names are exact single-dash letters or double-dash words", () => {
    for (const f of ["-n", "-C", "--stat", "--name-only"]) expect(issuesFor((c) => (c.hermes.allow.r.flags = { [f]: {} }))).toEqual([]);
    for (const f of ["--output=x", "--", "-", "-ab", "--Stat", "stat", "--a b"]) {
      expect(issuesFor((c) => (c.hermes.allow.r.flags = { [f]: {} })).map((i) => i.message)).toEqual(["invalid key"]);
    }
  });

  test("rule ids start with a letter, so every implementation keeps them in file order", () => {
    for (const id of ["123", "Git-push", "git_push", "-x"]) {
      const c = { hermes: { allow: { [id]: base().hermes.allow.r } }, workers: { tools: ["read"] } };
      expect(check("policy-commands", c).map((i) => i.message)).toEqual(["invalid key"]);
    }
  });
});

describe("loadPolicy checks that command patterns compile", () => {
  let temps: string[] = [];
  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps = [];
  });

  test("an invalid regular expression is a PolicyError naming commands.yaml and the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "hapi-policy-"));
    temps.push(dir);
    cpSync("policy", dir, { recursive: true });
    const yaml = readFileSync("policy/commands.yaml", "utf8");
    // A replacer function, because "$'" in a replacement string means "the text after the match".
    const broken = yaml.replace("'^plan/[a-z0-9][a-z0-9-]*$'", () => "'^plan/[a-z0-9$'");
    expect(broken).not.toBe(yaml);
    writeFileSync(join(dir, "commands.yaml"), broken);
    let err: unknown;
    try {
      loadPolicy(dir);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyError);
    const e = err as PolicyError;
    expect(e.file).toEndWith("commands.yaml");
    expect(e.path).toMatch(/^\/hermes\/allow\/git-[a-z-]+-plan\/args\/0$/);
    expect(e.message).toContain("invalid regular expression");
  });
});
