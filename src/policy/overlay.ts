/**
 * Repo overlays: a target repo's `.factory/config.yaml` on top of the central
 * policy (spec §7, §8.1).
 *
 * An overlay may only tighten policy. It may:
 * - add protected paths, or raise an existing path's modes (allow < ask < deny);
 * - add `egress_extra` hosts to the archon zone (the one exception to tighten-only),
 *   but never a forge host, since the archon zone has no forge route (spec §4.3);
 * - lower budgets.
 * Anything else is rejected: unknown keys by the schema (in `loadOverlay`, and
 * again in `applyOverlay`), and loosening by `applyOverlay`, with a
 * `PolicyLoosenError` naming the path. Nothing is ever merged silently.
 */
import { loadChecked, PolicyError } from "./load";
import { check, pointerSegment } from "./schema";
import type { Budgets, Mode, PathModes, Policy, RepoOverlay } from "./types";

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

const RANK: Record<Mode, number> = { allow: 0, ask: 1, deny: 2 };
const SESSIONS = ["interactive", "unattended", "workers"] as const;
/** The modes of a path the base policy doesn't protect. */
const UNPROTECTED: PathModes = { interactive: "allow", unattended: "allow", workers: "allow" };

/**
 * Forge domains (with their subdomains). The archon zone must never reach them:
 * Archon holds no forge credentials and has no route to the forge (spec §4.3).
 */
const FORGE_DOMAINS = ["github.com", "githubusercontent.com", "githubassets.com", "ghcr.io"];

/**
 * Apply an overlay to a policy, returning a new policy. The inputs are not changed.
 * Throws PolicyLoosenError on the first change that would loosen policy. The overlay
 * is schema-checked again here, so an overlay built in code gets the same checks as
 * one from `loadOverlay`; problems throw a PolicyError for the file "(overlay)".
 */
export function applyOverlay(p: Policy, o: RepoOverlay): Policy {
  const issues = check("repo-overlay", o);
  if (issues.length > 0) throw new PolicyError("(overlay)", issues);
  const result = structuredClone(p);
  if (o.protected_paths) result.protectedPaths = tightenPaths(p.protectedPaths, o.protected_paths);
  if (o.egress_extra) {
    o.egress_extra.forEach((host, i) => {
      const forge = FORGE_DOMAINS.find((d) => host === d || host.endsWith(`.${d}`));
      if (forge) {
        throw new PolicyLoosenError(
          `/egress_extra/${i}`,
          `"${host}" is a forge host (${forge}); the archon zone has no forge route (spec §4.3)`,
        );
      }
    });
    const archon = result.trustedSources.zones.archon;
    archon.hosts = [...new Set([...archon.hosts, ...o.egress_extra])];
  }
  if (o.budgets) result.budgets = lowerBudgets(p.budgets, o.budgets);
  return result;
}

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
    const from = current ?? UNPROTECTED;
    const next = { ...from };
    for (const session of SESSIONS) {
      const mode = entry[session];
      if (mode === undefined) continue;
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

function lowerBudgets(base: Budgets, overlay: NonNullable<RepoOverlay["budgets"]>): Budgets {
  const result = structuredClone(base);
  const lower = (path: string, name: string, from: number, to: number | undefined): number => {
    if (to === undefined) return from;
    if (to > from) throw new PolicyLoosenError(path, `raises ${name} from ${from} to ${to}`);
    return to;
  };
  const { workspaces, ...scalars } = overlay;
  for (const [key, value] of Object.entries(scalars) as [Exclude<keyof Budgets, "workspaces">, number][]) {
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
  return result;
}
