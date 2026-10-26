/**
 * The shape of policy/ once loaded: the single source of truth (spec §8) that
 * `loadPolicy` returns and every generator consumes. The JSON Schemas in
 * policy/schemas/ check the same shapes at load time; keep the two in step.
 */

/** What an agent may do with a protected path. Tightening order: allow < ask < deny. */
export type Mode = "allow" | "ask" | "deny";

/**
 * The mode per session kind (spec §8.2).
 * - `interactive`: the operator is in the session.
 * - `unattended`: Hermes cron, webhook and API surfaces.
 * - `workers`: Pi or Claude Code inside Archon.
 */
export interface PathModes {
  interactive: Mode;
  unattended: Mode;
  workers: Mode;
}

/** An abstract model tier. Rosters map tiers to models; roles and work orders name tiers only. */
export type Tier = "small" | "medium" | "large";

/** A trusted-source tier (spec §10). */
export type SourceTier = "T0" | "T1" | "T2" | "T3";

/** An egress zone: one per container network with its own proxy. */
export type ZoneName = "hermes" | "archon" | "research";

export interface Zone {
  /** The source tiers this zone may reach. Their hosts join the zone's allowlist. */
  tiers: SourceTier[];
  /** Plain domains (no leading dot). The egress generator also allows their subdomains. */
  hosts: string[];
  /** true: any public host (private ranges stay blocked). Only the research zone may set it. */
  openWeb?: boolean;
}

export interface TrustedSources {
  tiers: Record<SourceTier, { hosts: string[] }>;
  zones: Record<ZoneName, Zone>;
}

/** Pi's built-in tools. */
export type WorkerTool = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export interface Commands {
  /** Shell command patterns Hermes may run; everything else is denied. */
  hermes: { allow: string[] };
  /** Pi built-ins that factory worker nodes get. */
  workers: { tools: WorkerTool[] };
}

export type Workspace = "hapi-hermes" | "hapi-factory" | "hapi-evals";

/** All amounts in USD. */
export interface Budgets {
  /** Monthly spend limit per Anthropic Console workspace. */
  workspaces: Record<Workspace, number>;
  openrouter_monthly_usd: number;
  jev_monthly_usd: number;
  run_usd: number;
  hermes_max_turns: number;
}

/** The fixed short list of actions that always need the operator (spec §8.1). */
export type Approval =
  | "merge"
  | "new_dependency"
  | "new_skill_or_mcp"
  | "ci_workflow_change"
  | "outbound_message"
  | "spend_above_threshold";

export type Role =
  | "hermes_main"
  | "hermes_auxiliary"
  | "planner"
  | "implement"
  | "review"
  | "scout"
  | "router"
  | "eval_judge";

/** The default tier per role. */
export type Roles = Record<Role, Tier>;

/** Archon's effort ladder. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The Archon provider that runs a tier: the embedded Pi SDK, or Claude Code via the Agent SDK. */
export type Provider = "pi" | "claude";

export interface ModelSpec {
  provider: Provider;
  /** For `pi`, a Pi model ref `<vendor>/<model-id>`; for `claude`, an Anthropic model id. */
  model: string;
  effort: Effort;
  /** The effort a retry escalates to, before any change of model. */
  retry_effort?: Effort;
}

/** Tier -> model (spec §12). */
export type Roster = Record<Tier, ModelSpec>;

export type RosterName = "budget" | "anthropic" | "portable";

/** Exactly spec §13.3. */
export interface Flags {
  metrics: { enabled: boolean; merge_outcomes: boolean };
  otel: { enabled: boolean; content_capture: "off" | "preview" };
  jev: { enabled: boolean; fallback: "haiku" | "none"; via: "openrouter" };
  coderabbit: { enabled: boolean; include_in_rework: boolean };
  /** Crossing any one flags the run. */
  thresholds: { run_usd: number; interventions: number; review_rounds: number };
  on_flag: ("label_pr" | "chat_alert")[];
}

export interface Policy {
  /**
   * Repo-relative glob -> modes. From protected_paths.yaml's `protected_paths` map.
   *
   * Binding rule: a file's effective mode, per session kind, is the STRICTEST mode
   * across EVERY glob that matches it, never the first, last or most specific
   * match; a file no glob matches is allow. `allow` in an entry means "this glob
   * adds no rule for that session". Read it with `effectiveModes` (./paths.ts),
   * which also defines the glob syntax; never look a file up by key.
   */
  protectedPaths: Record<string, PathModes>;
  commands: Commands;
  trustedSources: TrustedSources;
  budgets: Budgets;
  approvals: Approval[];
  roles: Roles;
  rosters: Record<RosterName, Roster>;
  flags: Flags;
}

/**
 * A target repo's `.factory/config.yaml` (spec §7). It may only tighten policy,
 * except that it may add `egress_extra` hosts. `null` for a protected path is a
 * removal attempt, which `applyOverlay` rejects.
 */
export interface RepoOverlay {
  protected_paths?: Record<string, Partial<PathModes> | null>;
  /** Hosts added to the archon zone. */
  egress_extra?: string[];
  /** Budgets to lower; each must be at most the base value. */
  budgets?: Partial<Omit<Budgets, "workspaces">> & { workspaces?: Partial<Record<Workspace, number>> };
}
