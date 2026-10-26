/**
 * Pi's files for the factory's read-only agent directory (spec §9.3), mounted
 * at PI_CODING_AGENT_DIR in the Archon container (see ./archon.ts):
 *
 * - `models.json`: Pi 1.3.0's model registry file. Each Pi model the selected
 *   roster uses gets a `modelOverrides` entry capping `maxTokens` at 64000
 *   (spec §9.3, §12). An override changes one field of a built-in model and
 *   keeps the rest of its catalog entry; a `models` entry would replace it.
 * - `hapi-guard.json`: the settings Plan 02's hapi-guard extension enforces for
 *   workers: the protected-path table, the run budget and the max_tokens clamp.
 */
import type { ModelSpec, Policy, RosterName } from "../policy/types";
import { notice } from "./header";

/** Pi's output-token cap for every worker model (spec §9.3: "maxTokens around 64K"; §12). */
export const MAX_TOKENS = 64000;

/** The JSON Schema Pi publishes for models.json (docs/models.md at Pi v1.3.0). */
const MODELS_SCHEMA = "https://pi.dev/schemas/models.schema.json";

/**
 * Split a Pi model ref `<vendor>/<model-id>` at its first "/". The id may hold
 * more slashes: "openrouter/qwen/qwen3-coder" is vendor "openrouter", id
 * "qwen/qwen3-coder" (Archon's Pi docs). The roster schema already requires the
 * form; this throws if it's missing anyway, rather than emit a broken ref.
 */
export function splitPiRef(ref: string): { vendor: string; id: string } {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`not a Pi model ref <vendor>/<model-id>: ${JSON.stringify(ref)}`);
  return { vendor: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** Pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function modelsJson(p: Policy, roster: RosterName): string {
  const byVendor = new Map<string, Set<string>>();
  for (const spec of Object.values(p.rosters[roster]) as ModelSpec[]) {
    // Claude-provider tiers run on Claude Code through the Agent SDK, not on Pi.
    if (spec.provider !== "pi") continue;
    const { vendor, id } = splitPiRef(spec.model);
    byVendor.set(vendor, (byVendor.get(vendor) ?? new Set()).add(id));
  }
  const providers = Object.fromEntries(
    [...byVendor.keys()].sort().map((vendor) => [
      vendor,
      { modelOverrides: Object.fromEntries([...byVendor.get(vendor)!].sort().map((id) => [id, { maxTokens: MAX_TOKENS }])) },
    ]),
  );
  return json({
    // JSON has no comments, so the notice is a $comment, first. Pi 1.3.0 accepts it: its models.json
    // schema (ModelsConfigSchema, core/model-config.ts) doesn't forbid other keys, and Pi reads
    // only `providers`.
    $comment: notice("Pi models.json: the output-token cap for each Pi model", [`policy/rosters/${roster}.yaml`]).join(" "),
    $schema: MODELS_SCHEMA,
    providers,
  });
}

/**
 * The workers' protected-path table: glob -> "deny".
 *
 * Strictest-wins (src/policy/paths.ts) is kept by construction:
 * - `allow` means "this glob adds no rule", so an allow entry is left out, and
 *   no glob in the table can loosen a file another glob protects;
 * - `ask` becomes `deny`: nobody answers a worker, and nothing inside the Archon
 *   container is a human-approval boundary (spec §4.3). That is stricter, never
 *   looser.
 * So every rule is deny, and the enforcer's combining rule can't change a
 * file's result. The file still says `combine: "strictest"` for Plan 02.
 */
function workerRules(p: Policy): Record<string, "deny"> {
  const globs = Object.entries(p.protectedPaths)
    .filter(([, modes]) => modes.workers !== "allow")
    .map(([glob]) => glob)
    .sort();
  // fromEntries defines own properties, so a glob such as "__proto__" stays a plain key.
  return Object.fromEntries(globs.map((glob) => [glob, "deny" as const]));
}

function hapiGuardJson(p: Policy): string {
  return json({
    $comment: [
      ...notice("hapi-guard settings for Pi workers", ["policy/protected_paths.yaml", "policy/budgets.yaml"]),
      "protected_paths: repo-relative globs in the syntax of src/policy/paths.ts (docs/policy.md, Glob syntax).",
      "A file is blocked if ANY glob matches it (combine: strictest).",
    ].join(" "),
    session: "workers",
    combine: "strictest",
    protected_paths: workerRules(p),
    budgets: { run_usd: p.budgets.run_usd },
    max_tokens: MAX_TOKENS,
  });
}

/** Pi's generated files: `models.json` and `hapi-guard.json`. Pure. */
export function emitPi(p: Policy, roster: RosterName = "anthropic"): Record<string, string> {
  return { "models.json": modelsJson(p, roster), "hapi-guard.json": hapiGuardJson(p) };
}
