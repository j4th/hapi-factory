/**
 * Hermes's `config.yaml` (spec §9.1): the day-one hardening defaults, the model
 * settings from roles.yaml and the anthropic roster, the turn cap from
 * budgets.yaml and the protected instruction files from protected_paths.yaml.
 *
 * Key names follow the pinned tag v0.22.5: `hermes_cli/config_defaults.py` and
 * `cli-config.yaml.example` there. Two differ from spec §9.1's shorthand:
 * - `cache_ttl` is `prompt_caching.cache_ttl` ("5m" | "1h" | "auto");
 * - `container_persistent` is `terminal.container_persistent`.
 * And `security.protected_instruction_files` is a boolean switch; the file
 * patterns go in `security.protected_instruction_extra_patterns`.
 *
 * No hooks in Plan 01: the hapi-cmd-allow hook script arrives in Plan 04, and a
 * fail_closed hook pointing at a missing script would block every tool call.
 */
import YAML, { isMap, isScalar } from "yaml";
import type { Effort, Policy, Role } from "../policy/types";
import { notice, wrap } from "./header";
import { splitPiRef } from "./pi";

/**
 * Hermes runs on the Anthropic provider with a Console API key (Global
 * Constraints: no subscription OAuth), so it always uses this roster. The
 * `--roster` choice applies to Archon and Pi only.
 */
export const HERMES_ROSTER = "anthropic";

/**
 * Every auxiliary model slot at v0.22.5 (DEFAULT_CONFIG["auxiliary"], less its
 * four scalar settings). A slot left unset runs on the main model (Opus), so
 * all of them are pinned (spec §9.1).
 */
const AUX_SLOTS = [
  "vision",
  "compression",
  "skills_hub",
  "approval",
  "review",
  "mcp",
  "title_generation",
  "memory_query_rewrite",
  "tts_audio_tags",
  "voice_chat",
  "triage_specifier",
  "kanban_decomposer",
  "profile_describer",
  "goal_judge",
  "curator",
  "monitor",
  "background_review",
  "moa_reference",
  "moa_aggregator",
] as const;

/** The Anthropic model id and effort for a Hermes role, from the anthropic roster. */
function anthropicModel(p: Policy, role: Role): { id: string; effort: Effort } {
  const spec = p.rosters[HERMES_ROSTER][p.roles[role]];
  // A claude-provider tier names an Anthropic id; a pi one names a Pi ref "anthropic/<id>".
  if (spec.provider === "claude") return { id: spec.model, effort: spec.effort };
  const { vendor, id } = splitPiRef(spec.model);
  if (vendor !== "anthropic") {
    throw new Error(`Hermes runs on the anthropic provider, but ${role} maps to ${JSON.stringify(spec.model)} in the ${HERMES_ROSTER} roster`);
  }
  return { id, effort: spec.effort };
}

/**
 * Patterns for Hermes's protected-instruction gate, which asks before an agent
 * writes a matching file, even under yolo, and refuses when nobody can answer.
 * Hermes matches each pattern with fnmatch against a file's basename, in every
 * directory.
 *
 * That gate can't express strictest-wins over our globs, so it gets a superset
 * (spec §8.2 binding rule): for every glob that adds a rule for a Hermes session
 * (interactive or unattended is not allow), its last segment, unless that is
 * "**". The last segment means the same in fnmatch (the glob syntax forbids
 * "[", "]" and "!"), and matching it in every directory covers at least every
 * file the anchored glob matches: "mise.toml" protects every mise.toml, and
 * "docs/*.md" becomes "*.md". Globs ending in "**" match whole directories,
 * which a basename can't say; they are returned separately for the comment.
 */
function instructionPatterns(p: Policy): { patterns: string[]; directories: string[] } {
  const patterns = new Set<string>();
  const directories = new Set<string>();
  for (const [glob, modes] of Object.entries(p.protectedPaths)) {
    if (modes.interactive === "allow" && modes.unattended === "allow") continue; // no rule for Hermes
    const last = glob.slice(glob.lastIndexOf("/") + 1);
    if (last === "**") directories.add(glob);
    else patterns.add(last);
  }
  return { patterns: [...patterns].sort(), directories: [...directories].sort() };
}

function configYaml(p: Policy): string {
  const main = anthropicModel(p, "hermes_main");
  const aux = anthropicModel(p, "hermes_auxiliary");
  const { patterns, directories } = instructionPatterns(p);
  const config = {
    model: { provider: "anthropic", default: main.id },
    agent: { max_turns: p.budgets.hermes_max_turns, reasoning_effort: main.effort },
    approvals: { mode: "manual", cron_mode: "deny", unattended_mode: "deny", single_query_mode: "deny" },
    skills: { write_approval: true, guard_agent_created: true },
    memory: { write_approval: true },
    security: {
      protected_instruction_files: true,
      protected_instruction_extra_patterns: patterns,
      allow_lazy_installs: false,
    },
    plugins: { isolation: "host" },
    auth: { adopt_external_logins: false },
    web: { keyless_fallback: false, keyless_rescue: false },
    prompt_caching: { cache_ttl: "auto" },
    terminal: { container_persistent: false },
    auxiliary: Object.fromEntries(AUX_SLOTS.map((slot) => [slot, { provider: "anthropic", model: aux.id }])),
    delegation: { provider: "anthropic", model: aux.id, subagent_auto_approve: false },
    cron: { model_provider: "anthropic", model: aux.id },
    hooks_auto_accept: false,
  };

  const doc = new YAML.Document(config);
  doc.commentBefore = notice("Hermes config.yaml (Hermes v0.22.5 keys)", [
    "policy/budgets.yaml",
    "policy/protected_paths.yaml",
    "policy/roles.yaml",
    `policy/rosters/${HERMES_ROSTER}.yaml`,
  ])
    .map((l) => ` ${l}`)
    .join("\n");
  const security = doc.get("security", true);
  const key = isMap(security)
    ? security.items.find((i) => isScalar(i.key) && i.key.value === "protected_instruction_extra_patterns")?.key
    : undefined;
  if (!isScalar(key)) throw new Error("unreachable: security.protected_instruction_extra_patterns is missing");
  // The comment sits two columns in, so it wraps a little narrower than the file header.
  const width = 84;
  key.commentBefore = [
    ...wrap(
      "From the protected-path globs that end in a file name. Hermes matches each as a basename in " +
        "every directory, which is stricter than the anchored glob. AGENTS.md is also built in.",
      width,
    ),
    ...(directories.length > 0 ? wrap(`Directory globs a basename can't express: ${directories.join(", ")}.`, width) : []),
    ...wrap(
      `Plan 04's hapi-path-guard plugin enforces ${directories.length > 0 ? "those, and " : ""}deny in ` +
        "interactive sessions, where this gate only asks.",
      width,
    ),
  ]
    .map((l) => ` ${l}`)
    .join("\n");
  return doc.toString({ lineWidth: 0 });
}

/** Hermes's generated files: `config.yaml`. Pure. */
export function emitHermes(p: Policy): Record<string, string> {
  return { "config.yaml": configYaml(p) };
}
