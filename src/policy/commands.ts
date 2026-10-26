/**
 * Hermes's command allowlist (commands.yaml, spec §8.1): argv-exact rules, and
 * `matchCommand`, the one definition of how a rule matches. Plan 04's Python
 * hapi-cmd-allow hook must implement exactly these semantics, and both run the
 * shared vectors in tests/fixtures/command-vectors.json.
 *
 * `matchCommand(rules, argv)` allows argv only if some rule matches all of it.
 * A rule matches when:
 * 1. argv starts with exactly `rule.command`, token for token. So anything before
 *    or between those tokens (git's `-c`, `-C`, `--git-dir`, an env assignment,
 *    a path to the binary) means no match.
 * 2. Every later token is read left to right:
 *    - A token that starts with "-" is a flag. It must be a key of `rule.flags`,
 *      spelled exactly: `--flag=value`, `-n5` and bundled `-abc` are unknown
 *      flags. A flag with a `value` pattern takes the next token as its value,
 *      whatever it looks like (as git does), and that token must match. Flags
 *      may repeat and may come before, between or after positionals.
 *    - Any other token is a positional. The i-th must match `rule.args[i]`;
 *      after those, up to `rule.rest.max` more must match `rule.rest.pattern`.
 * 3. Every pattern in `rule.args` got a token.
 * A pattern must match the whole token: JS `new RegExp("^(?:" + p + ")$", "su")`,
 * Python `re.fullmatch(p, token, re.DOTALL)`. The schema keeps patterns to the
 * subset where the two agree.
 *
 * The result's `reason` starts with a stable code, then ": " and details:
 * `match`, `empty-argv`, `no-rule`, `unknown-flag`, `missing-value`, `bad-value`,
 * `bad-arg`, `extra-arg` or `missing-arg`. The first failing token decides it.
 * When no rule matches, the reason (and `rule`) come from the candidate rule
 * whose `command` matched with the most tokens, the first in file order on a
 * tie; with no candidate, the reason is `no-rule` and `rule` is absent. That
 * choice only affects the message: argv is allowed if ANY rule matches.
 *
 * This checks argv only. The hook runs first and must tokenize the command line
 * shell-aware and refuse shell operators and expansions (docs/policy.md).
 */
import { type Issue, pointerSegment } from "./schema";
import type { CommandRule } from "./types";

/** The result of matching one argv. `rule` is the matching rule, or for a denial the closest candidate. */
export interface CommandMatch {
  allowed: boolean;
  rule?: string;
  /** "<code>: <details>", where code is one of REASON_CODES. */
  reason: string;
}

/** The stable reason codes, the part of `reason` before the first ":". */
export const REASON_CODES = [
  "match",
  "empty-argv",
  "no-rule",
  "unknown-flag",
  "missing-value",
  "bad-value",
  "bad-arg",
  "extra-arg",
  "missing-arg",
] as const;

const compiled = new Map<string, RegExp>();

/** A pattern as a full-match RegExp. Throws SyntaxError if it doesn't compile. */
function fullMatch(pattern: string): RegExp {
  let re = compiled.get(pattern);
  if (!re) {
    re = new RegExp(`^(?:${pattern})$`, "su");
    compiled.set(pattern, re);
  }
  return re;
}

/** A token for a message: JSON-quoted, so control characters print escaped. */
const q = (token: string): string => JSON.stringify(token);

/** Why `tokens` (argv after the rule's command) don't fit the rule, or undefined if they do. */
function mismatch(id: string, rule: CommandRule, tokens: readonly string[]): string | undefined {
  let positional = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      const flag = Object.hasOwn(rule.flags, token) ? rule.flags[token] : undefined;
      if (!flag) return `unknown-flag: ${q(token)} is not an allowed flag of rule ${id}`;
      if (flag.value === undefined) continue;
      i++;
      const value = tokens[i];
      if (value === undefined) return `missing-value: ${q(token)} needs a value (rule ${id})`;
      if (!fullMatch(flag.value).test(value)) {
        return `bad-value: the value ${q(value)} of ${q(token)} does not match ${flag.value} (rule ${id})`;
      }
      continue;
    }
    const n = positional + 1;
    const pattern =
      positional < rule.args.length
        ? rule.args[positional]
        : rule.rest && positional - rule.args.length < rule.rest.max
          ? rule.rest.pattern
          : undefined;
    if (pattern === undefined) return `extra-arg: argument ${n}, ${q(token)}, is more than rule ${id} takes`;
    if (!fullMatch(pattern).test(token)) return `bad-arg: argument ${n}, ${q(token)}, does not match ${pattern} (rule ${id})`;
    positional++;
  }
  if (positional < rule.args.length) {
    return `missing-arg: rule ${id} needs argument ${positional + 1}, matching ${rule.args[positional]}`;
  }
  return undefined;
}

/**
 * Whether argv is allowed by `rules` (commands.yaml's `hermes.allow`). See the
 * module comment for the exact semantics.
 */
export function matchCommand(rules: Readonly<Record<string, CommandRule>>, argv: readonly string[]): CommandMatch {
  if (argv.length === 0) return { allowed: false, reason: "empty-argv: no command" };
  let closest: { id: string; length: number; reason: string } | undefined;
  for (const [id, rule] of Object.entries(rules)) {
    if (argv.length < rule.command.length || rule.command.some((t, i) => argv[i] !== t)) continue;
    const reason = mismatch(id, rule, argv.slice(rule.command.length));
    if (reason === undefined) return { allowed: true, rule: id, reason: `match: rule ${id}` };
    if (!closest || rule.command.length > closest.length) closest = { id, length: rule.command.length, reason };
  }
  if (closest) return { allowed: false, rule: closest.id, reason: closest.reason };
  return { allowed: false, reason: `no-rule: no rule's command is a prefix of the argv, which starts ${JSON.stringify(argv.slice(0, 4))}` };
}

/**
 * Patterns that don't compile, as issues with JSON Pointers relative to the rules
 * map ("/git-log/flags/-n/value"). `loadPolicy` runs this after the schema check.
 */
export function commandRuleIssues(rules: Readonly<Record<string, CommandRule>>): Issue[] {
  const issues: Issue[] = [];
  const at = (path: string, pattern: string) => {
    try {
      fullMatch(pattern);
    } catch (e) {
      issues.push({ path, message: `invalid regular expression: ${(e as Error).message}` });
    }
  };
  for (const [id, rule] of Object.entries(rules)) {
    rule.args.forEach((p, i) => at(`/${pointerSegment(id)}/args/${i}`, p));
    if (rule.rest) at(`/${pointerSegment(id)}/rest/pattern`, rule.rest.pattern);
    for (const [flag, spec] of Object.entries(rule.flags)) {
      if (spec.value !== undefined) at(`/${pointerSegment(id)}/flags/${pointerSegment(flag)}/value`, spec.value);
    }
  }
  return issues;
}
