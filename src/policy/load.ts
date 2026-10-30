/**
 * Load and validate policy/: the single source of truth (spec §8).
 *
 * `loadPolicy(dir)` reads every policy file, checks each against its JSON
 * Schema and returns one `Policy`. The first bad file throws a `PolicyError`
 * naming the file and the JSON Pointer of the problem.
 */
import { join } from "node:path";
import { commandRuleIssues } from "./commands";
import { mcpIssues } from "./mcp";
import { check, formatIssue, type Issue, readYaml, type SchemaName } from "./schema";
import type { Commands, Flags, Gates, McpCatalog, Policy, Roster, RosterName } from "./types";

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

/**
 * A gate that is on needs a classifier to run. Jev answers only for a public
 * repo (design §3.4), so Haiku, Jev's fallback (flags.yaml), is the only one a
 * run that isn't public has, whether or not Jev is enabled. With `fallback: none`
 * such a run would take the gate's fallback on every call, blocking every bash
 * command and wrapping every result while it spends its budget, so refuse it here
 * rather than at the first run (final review A-6).
 */
function gateIssues(flags: Flags, gates: Gates): Issue[] {
  if (flags.jev.fallback !== "none") return [];
  const issues: Issue[] = [];
  for (const gate of ["bash_gate", "result_screen"] as const) {
    if (!gates[gate].enabled) continue;
    issues.push({
      path: `/${gate}/enabled`,
      message:
        "on, but flags.jev.fallback is none, so a run that isn't public has no classifier whatever flags.jev.enabled says: set fallback to haiku, or turn the gate off here",
    });
  }
  return issues;
}

const ROSTERS: RosterName[] = ["budget", "anthropic", "portable"];

/**
 * Load the policy directory `dir` (normally `policy`). Throws PolicyError on the
 * first bad file. Beyond the schemas, it checks that every commands.yaml pattern
 * compiles, the MCP catalog's floors, blocklist, tool denylists and env
 * (`mcpIssues`, ./mcp.ts), and that no gate is on without a classifier (`gateIssues`).
 */
export function loadPolicy(dir: string): Policy {
  const load = <T>(file: string, schema: SchemaName) => loadChecked(join(dir, file), schema) as T;
  const protectedPaths = load<{ protected_paths: Policy["protectedPaths"] }>("protected_paths.yaml", "policy-protected-paths");
  const commands = load<Commands>("commands.yaml", "policy-commands");
  const patternIssues = commandRuleIssues(commands.hermes.allow).map((i) => ({ ...i, path: `/hermes/allow${i.path}` }));
  if (patternIssues.length > 0) throw new PolicyError(join(dir, "commands.yaml"), patternIssues);
  const mcp = load<McpCatalog>("mcp.yaml", "policy-mcp");
  const catalogIssues = mcpIssues(mcp);
  if (catalogIssues.length > 0) throw new PolicyError(join(dir, "mcp.yaml"), catalogIssues);
  const flags = load<Flags>("flags.yaml", "policy-flags");
  const gates = load<Gates>("gates.yaml", "policy-gates");
  const gate = gateIssues(flags, gates);
  if (gate.length > 0) throw new PolicyError(join(dir, "gates.yaml"), gate);
  return {
    protectedPaths: protectedPaths.protected_paths,
    commands,
    trustedSources: load("trusted_sources.yaml", "policy-trusted-sources"),
    budgets: load("budgets.yaml", "policy-budgets"),
    runs: load("runs.yaml", "policy-runs"),
    gates,
    approvals: load("approvals.yaml", "policy-approvals"),
    roles: load("roles.yaml", "policy-roles"),
    rosters: Object.fromEntries(
      ROSTERS.map((name) => [name, load<Roster>(join("rosters", `${name}.yaml`), "policy-roster")]),
    ) as Record<RosterName, Roster>,
    flags,
    mcp,
  };
}
