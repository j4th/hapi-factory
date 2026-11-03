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
import type { Budgets, Commands, EngineDecisions, Flags, Gates, McpCatalog, Policy, Roster, RosterName, Runs } from "./types";

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
 *
 * The run engine's decisions (gates.yaml's `decisions` block) are held the same way: one whose `mode` isn't `off`
 * would give every subject its file's fallback (a hold), so it is refused at `/decisions/by_name/<name>/mode`, unless
 * `decisions.mode` is `off`, which asks nothing. `notes` still asks, so it is refused too.
 */
function gateIssues(flags: Flags, gates: Gates, decisions: EngineDecisions): Issue[] {
  if (flags.jev.fallback !== "none") return [];
  const issues: Issue[] = [];
  const message =
    "on, but flags.jev.fallback is none, so a run that isn't public has no classifier whatever flags.jev.enabled says: set fallback to haiku, or turn the gate off here";
  for (const gate of ["bash_gate", "result_screen"] as const) {
    if (!gates[gate].enabled) continue;
    issues.push({ path: `/${gate}/enabled`, message });
  }
  if (decisions.mode !== "off") {
    for (const [name, d] of Object.entries(decisions.by_name)) if (d.mode !== "off") issues.push({ path: `/decisions/by_name/${name}/mode`, message });
  }
  return issues;
}

/**
 * A fix round must fit in one run's budget: `phases.round_usd` is at most
 * `budgets.run_usd`. Paths are relative to runs.yaml's root, so `/phases/round_usd`.
 */
export function phaseIssues(budgets: Budgets, runs: Runs): Issue[] {
  if (runs.phases.round_usd <= budgets.run_usd) return [];
  return [
    {
      path: "/phases/round_usd",
      message: `phases.round_usd ${runs.phases.round_usd} is more than budgets.run_usd ${budgets.run_usd}: a fix round must fit in one run's budget; lower round_usd`,
    },
  ];
}

const ROSTERS: RosterName[] = ["budget", "anthropic", "portable"];

/**
 * Load the policy directory `dir` (normally `policy`). Throws PolicyError on the
 * first bad file. Beyond the schemas, it checks that every commands.yaml pattern
 * compiles, the MCP catalog's floors, blocklist, tool denylists and env
 * (`mcpIssues`, ./mcp.ts), and that no gate or engine decision is on without a classifier (`gateIssues`).
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
  // gates.yaml holds the guard's gates and the run engine's decisions; Policy.gates keeps Plan 02's shape.
  const { decisions, ...gates } = load<Gates & { decisions: EngineDecisions }>("gates.yaml", "policy-gates");
  const gate = gateIssues(flags, gates, decisions);
  if (gate.length > 0) throw new PolicyError(join(dir, "gates.yaml"), gate);
  const budgets = load<Budgets>("budgets.yaml", "policy-budgets");
  const runs = load<Runs>("runs.yaml", "policy-runs");
  const phase = phaseIssues(budgets, runs);
  if (phase.length > 0) throw new PolicyError(join(dir, "runs.yaml"), phase);
  return {
    protectedPaths: protectedPaths.protected_paths,
    commands,
    trustedSources: load("trusted_sources.yaml", "policy-trusted-sources"),
    budgets,
    runs,
    gates,
    decisions,
    approvals: load("approvals.yaml", "policy-approvals"),
    roles: load("roles.yaml", "policy-roles"),
    rosters: Object.fromEntries(
      ROSTERS.map((name) => [name, load<Roster>(join("rosters", `${name}.yaml`), "policy-roster")]),
    ) as Record<RosterName, Roster>,
    flags,
    mcp,
    repos: load("repos.yaml", "policy-repos"),
    sidecars: load<{ sidecars: Policy["sidecars"] }>("sidecars.yaml", "policy-sidecars").sidecars,
  };
}
