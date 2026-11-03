/**
 * Repo overlays: a target repo's `.factory/config.yaml` on top of the central
 * policy (spec §7, §8.1).
 *
 * An overlay may only tighten policy. It may:
 * - add protected-path globs that name only ask or deny, or raise an existing
 *   glob's modes (allow < ask < deny);
 * - add `egress_extra` hosts to the archon zone (the one exception to tighten-only),
 *   but never a forge host, since the archon zone has no forge route (spec §4.3);
 * - lower budgets and run limits, and harden budget enforcement modes (soft < hard);
 * - switch a run phase on (never off), lower the fix-round counts, turns and
 *   cap, `max_auto_rounds` and the disk cap, and harden `runs.disk.enforcement`;
 * - set the repo's `default_risk`, `workflow` and `sidecar` (spec §7). These are
 *   repo settings, not policy, so tighten-only doesn't apply: they appear on the
 *   result as `repo`, for Plan 03 to read. A sidecar must be one
 *   policy/sidecars.yaml lists, and its data dir is denied to workers.
 * Anything else is rejected: unknown keys and non-canonical globs by the schema
 * (in `loadOverlay`, and again in `applyOverlay`), and loosening by
 * `applyOverlay`, with a `PolicyLoosenError` naming the path. Nothing is ever
 * merged silently.
 *
 * A new glob that overlaps a protected one can't loosen it, because a file's
 * mode is the strictest across every glob that matches it (see ./paths.ts).
 */
import { forgeDomain, forgeHostMessage } from "./hosts";
import { loadChecked, PolicyError, phaseIssues } from "./load";
import { RANK, SESSIONS, UNPROTECTED } from "./paths";
import { check, parseYaml, pointerSegment } from "./schema";
import type { Budgets, Enforcement, Phases, Policy, RepoOverlay, RepoSettings, Runs } from "./types";

/** Tightening order of enforcement modes: soft < hard. */
const ENFORCEMENT_RANK: Record<Enforcement, number> = { soft: 0, hard: 1 };

/** An overlay tried to loosen policy. `path` is a JSON Pointer into the overlay, e.g. "/protected_paths/AGENTS.md/interactive". */
export class PolicyLoosenError extends Error {
  override name = "PolicyLoosenError";

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}; overlays may only tighten policy`);
  }
}

/** Load and schema-check an overlay file. Throws PolicyError naming the file and path. */
export function loadOverlay(file: string): RepoOverlay {
  return loadChecked(file, "repo-overlay") as RepoOverlay;
}

/**
 * Check overlay text read as a git blob (H-172) as `loadOverlay` checks a file.
 * `label` names it in errors, e.g. `abc1234:.factory/config.yaml`. Throws PolicyError.
 */
export function overlayFromText(text: string, label: string): RepoOverlay {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (e) {
    throw new PolicyError(label, [{ path: "", message: e instanceof Error ? e.message : String(e) }]);
  }
  const issues = check("repo-overlay", data);
  if (issues.length > 0) throw new PolicyError(label, issues);
  return data as RepoOverlay;
}

/**
 * Apply an overlay to a policy, returning a new policy that shares no objects
 * with either input; neither input is changed. Throws PolicyLoosenError on the
 * first change that would loosen policy. The overlay is schema-checked again
 * here, so an overlay built in code gets the same checks as one from
 * `loadOverlay`; problems throw a PolicyError for the file "(overlay)".
 */
export function applyOverlay(p: Policy, o: RepoOverlay): Policy {
  const issues = check("repo-overlay", o);
  if (issues.length > 0) throw new PolicyError("(overlay)", issues);
  const result = structuredClone(p);
  if (o.protected_paths) result.protectedPaths = tightenPaths(result.protectedPaths, o.protected_paths);
  if (o.sidecar) {
    const { name, data_dir } = o.sidecar;
    if (!Object.hasOwn(p.sidecars, name)) {
      throw new PolicyError("(overlay)", [
        {
          path: "/sidecar/name",
          message: `"${name}" is not a sidecar in policy/sidecars.yaml (it lists: ${Object.keys(p.sidecars).join(", ")})`,
        },
      ]);
    }
    // The sidecar's data is the sidecar's code (`bun /data/server.ts`), so a worker may not write it.
    result.protectedPaths = tightenPaths(result.protectedPaths, { [`${data_dir}/**`]: { workers: "deny" } });
  }
  if (o.egress_extra) {
    o.egress_extra.forEach((host, i) => {
      // The same forge list as the work-order schema's egress_extra (./hosts.ts).
      const forge = forgeDomain(host);
      if (forge !== undefined) throw new PolicyLoosenError(`/egress_extra/${i}`, forgeHostMessage(host, forge));
    });
    const archon = result.trustedSources.zones.archon;
    archon.hosts = [...new Set([...archon.hosts, ...o.egress_extra])];
  }
  if (o.budgets) result.budgets = lowerBudgets(result.budgets, o.budgets);
  if (o.runs) result.runs = lowerRuns(result.runs, o.runs);
  const phase = phaseIssues(result.budgets, result.runs).map((i) => ({ ...i, path: `/runs${i.path}` }));
  if (phase.length > 0) throw new PolicyError("(overlay)", phase);
  // Repo settings, not policy: no tighten-only check applies.
  const repo: RepoSettings = {};
  if (o.default_risk !== undefined) repo.default_risk = o.default_risk;
  if (o.workflow !== undefined) repo.workflow = o.workflow;
  if (o.sidecar !== undefined) repo.sidecar = { ...o.sidecar };
  if (Object.keys(repo).length > 0) result.repo = { ...result.repo, ...repo };
  return result;
}

/** `base` must be the caller's own copy: untouched entries are reused, not copied. */
function tightenPaths(
  base: Policy["protectedPaths"],
  overlay: NonNullable<RepoOverlay["protected_paths"]>,
): Policy["protectedPaths"] {
  const merged = new Map(Object.entries(base));
  for (const [glob, entry] of Object.entries(overlay)) {
    const at = `/protected_paths/${pointerSegment(glob)}`;
    const current = Object.hasOwn(base, glob) ? base[glob] : undefined;
    if (entry === null) {
      throw new PolicyLoosenError(
        at,
        current
          ? `removes protected path "${glob}"`
          : `null for "${glob}" asks to remove a protected path, which is never allowed`,
      );
    }
    // A new glob's unnamed modes are allow: the glob adds no rule for that session.
    const from = current ?? UNPROTECTED;
    const next = { ...from };
    for (const session of SESSIONS) {
      const mode = entry[session];
      if (mode === undefined) continue;
      if (!current && mode === "allow") {
        // Under strictest-wins, allow on a new glob can't change any file's mode. An
        // overlay that names it is trying to loosen what another glob protects.
        throw new PolicyLoosenError(
          `${at}/${session}`,
          `"${glob}" is a new glob, where allow can't loosen anything (a file's mode is the strictest across every glob that matches it); name only ask or deny`,
        );
      }
      if (RANK[mode] < RANK[from[session]]) {
        throw new PolicyLoosenError(
          `${at}/${session}`,
          `loosens "${glob}" ${session} from ${from[session]} to ${mode}`,
        );
      }
      next[session] = mode;
    }
    merged.set(glob, next);
  }
  // fromEntries defines own properties, so a glob such as "__proto__" stays a plain key.
  return Object.fromEntries(merged);
}

/** `to` must be at most `from`; the error names the raised key. */
function lower(path: string, name: string, from: number, to: number | undefined): number {
  if (to === undefined) return from;
  if (to > from) throw new PolicyLoosenError(path, `raises ${name} from ${from} to ${to}`);
  return to;
}

function lowerBudgets(base: Budgets, overlay: NonNullable<RepoOverlay["budgets"]>): Budgets {
  const result = { ...base, workspaces: { ...base.workspaces }, enforcement: { ...base.enforcement } };
  const { workspaces, enforcement, ...scalars } = overlay;
  for (const [key, value] of Object.entries(scalars) as [Exclude<keyof Budgets, "workspaces" | "enforcement">, number][]) {
    result[key] = lower(`/budgets/${pointerSegment(key)}`, `budgets.${key}`, base[key], value);
  }
  for (const [key, value] of Object.entries(workspaces ?? {}) as [keyof Budgets["workspaces"], number][]) {
    result.workspaces[key] = lower(
      `/budgets/workspaces/${pointerSegment(key)}`,
      `the ${key} workspace budget`,
      base.workspaces[key],
      value,
    );
  }
  for (const [key, value] of Object.entries(enforcement ?? {}) as [keyof Budgets["enforcement"], Enforcement][]) {
    const from = base.enforcement[key];
    if (ENFORCEMENT_RANK[value] < ENFORCEMENT_RANK[from]) {
      throw new PolicyLoosenError(
        `/budgets/enforcement/${pointerSegment(key)}`,
        `softens budgets.enforcement.${key} from ${from} to ${value}`,
      );
    }
    result.enforcement[key] = value;
  }
  return result;
}

const PHASE_SWITCHES = ["verify", "review", "coderabbit", "require_acceptance"] as const;
const PHASE_NUMBERS = ["fix_rounds_before_pr", "fix_rounds_on_pr", "round_turns", "round_usd"] as const;

function lowerRuns(base: Runs, overlay: NonNullable<RepoOverlay["runs"]>): Runs {
  const { output_limits_mb, disk, phases, ...scalars } = overlay;
  const result = {
    ...base,
    output_limits_mb: { ...base.output_limits_mb },
    disk: { ...base.disk },
    phases: { ...base.phases },
  };
  for (const [key, value] of Object.entries(scalars) as [Exclude<keyof Runs, "output_limits_mb" | "disk" | "phases" | "poll_interval_s" | "max_retries" | "max_rework_rounds" | "inputs_mb" | "work_order_kb">, number][]) {
    result[key] = lower(`/runs/${pointerSegment(key)}`, `runs.${key}`, base[key], value);
  }
  for (const [key, value] of Object.entries(output_limits_mb ?? {}) as [keyof Runs["output_limits_mb"], number][]) {
    result.output_limits_mb[key] = lower(
      `/runs/output_limits_mb/${pointerSegment(key)}`,
      `runs.output_limits_mb.${key}`,
      base.output_limits_mb[key],
      value,
    );
  }
  if (disk?.gb !== undefined) result.disk.gb = lower("/runs/disk/gb", "runs.disk.gb", base.disk.gb, disk.gb);
  if (disk?.enforcement !== undefined) {
    const from = base.disk.enforcement;
    if (ENFORCEMENT_RANK[disk.enforcement] < ENFORCEMENT_RANK[from]) {
      throw new PolicyLoosenError("/runs/disk/enforcement", `softens runs.disk.enforcement from ${from} to ${disk.enforcement}`);
    }
    result.disk.enforcement = disk.enforcement;
  }
  for (const key of PHASE_NUMBERS) {
    result.phases[key] = lower(`/runs/phases/${key}`, `runs.phases.${key}`, base.phases[key], phases?.[key]);
  }
  for (const key of PHASE_SWITCHES) {
    const value: Phases[typeof key] | undefined = phases?.[key];
    if (value === undefined) continue;
    if (base.phases[key] && !value) throw new PolicyLoosenError(`/runs/phases/${key}`, `switches runs.phases.${key} off`);
    result.phases[key] = value;
  }
  return result;
}
