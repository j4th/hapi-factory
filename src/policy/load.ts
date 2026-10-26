/**
 * Load and validate policy/: the single source of truth (spec §8).
 *
 * `loadPolicy(dir)` reads every policy file, checks each against its JSON
 * Schema and returns one `Policy`. The first bad file throws a `PolicyError`
 * naming the file and the JSON Pointer of the problem.
 */
import { join } from "node:path";
import { commandRuleIssues } from "./commands";
import { check, formatIssue, type Issue, readYaml, type SchemaName } from "./schema";
import type { Commands, Policy, Roster, RosterName } from "./types";

/** A policy or overlay file failed to load. `path` is a JSON Pointer into the file ("" = the whole file). */
export class PolicyError extends Error {
  override name = "PolicyError";
  readonly path: string;
  /** Every problem found in the file; `path` is the first one's. */
  readonly issues: Issue[];

  constructor(
    readonly file: string,
    issues: Issue[],
  ) {
    super(`${file}: ${issues.map(formatIssue).join("; ")}`);
    this.issues = issues;
    this.path = issues[0]?.path ?? "";
  }
}

/** Read a YAML file and check it against a schema. Throws PolicyError. */
export function loadChecked(file: string, schema: SchemaName): unknown {
  let data: unknown;
  try {
    data = readYaml(file);
  } catch (e) {
    throw new PolicyError(file, [{ path: "", message: (e as Error).message }]);
  }
  const issues = check(schema, data);
  if (issues.length > 0) throw new PolicyError(file, issues);
  return data;
}

const ROSTERS: RosterName[] = ["budget", "anthropic", "portable"];

/**
 * Load the policy directory `dir` (normally `policy`). Throws PolicyError on the
 * first bad file. Beyond the schemas, it checks that every commands.yaml pattern
 * compiles.
 */
export function loadPolicy(dir: string): Policy {
  const load = <T>(file: string, schema: SchemaName) => loadChecked(join(dir, file), schema) as T;
  const protectedPaths = load<{ protected_paths: Policy["protectedPaths"] }>("protected_paths.yaml", "policy-protected-paths");
  const commands = load<Commands>("commands.yaml", "policy-commands");
  const patternIssues = commandRuleIssues(commands.hermes.allow).map((i) => ({ ...i, path: `/hermes/allow${i.path}` }));
  if (patternIssues.length > 0) throw new PolicyError(join(dir, "commands.yaml"), patternIssues);
  return {
    protectedPaths: protectedPaths.protected_paths,
    commands,
    trustedSources: load("trusted_sources.yaml", "policy-trusted-sources"),
    budgets: load("budgets.yaml", "policy-budgets"),
    approvals: load("approvals.yaml", "policy-approvals"),
    roles: load("roles.yaml", "policy-roles"),
    rosters: Object.fromEntries(
      ROSTERS.map((name) => [name, load<Roster>(join("rosters", `${name}.yaml`), "policy-roster")]),
    ) as Record<RosterName, Roster>,
    flags: load("flags.yaml", "policy-flags"),
  };
}
