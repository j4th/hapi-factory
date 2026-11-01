/**
 * Pi's files for the factory's read-only agent directory (spec §9.3), mounted
 * at PI_CODING_AGENT_DIR in the Archon container (see ./archon.ts):
 *
 * - `models.json`: Pi 1.3.0's model registry file. Each Pi model the selected
 *   roster uses gets a `modelOverrides` entry that pins `maxTokens` at 64000
 *   (spec §9.3, §12) and the catalog's `cost` and whole `compat` object, and
 *   each provider's `baseUrl` is pinned too. An override changes fields of a
 *   built-in model and keeps the rest of its catalog entry; a `models` entry
 *   would replace it. The pins are computed only from the pinned catalog
 *   (./pi-catalog-1.3.0.json) and the roster, so a planted `models-store.json`
 *   can't zero the cost, drop `compat` or redirect the key (spike 08, finding 9).
 * - `models-store.json`: exactly `{}`, bound read-only over Pi's own store.
 * - `settings.json`: Pi's settings, with nothing set.
 * - `hapi-guard.json`: the settings Plan 02's hapi-guard extension enforces for
 *   workers: the protected-path table, the run budget, the max_tokens clamp, the
 *   pinned models it compares at `session_start`, the gates and the env names
 *   to keep out of the shell.
 */
import { join } from "node:path";
import { loadManifest, MANIFEST_FILE } from "../secrets/manifest";
import type { Effort, ModelSpec, Policy, RosterName } from "../policy/types";
import { RUN_PATHS } from "./archon";
import { notice, REPO_ROOT } from "./header";
import catalog from "./pi-catalog-1.3.0.json";

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

/** One model of Pi 1.3.0's built-in catalog, as ./pi-catalog-1.3.0.json records it (spike 08, finding 13). */
interface CatalogModel {
  baseUrl: string;
  cost: unknown;
  compat: Record<string, unknown>;
  /** Pi's thinking level -> the level it sends, or null when the model has no such level. */
  thinkingLevelMap: Partial<Record<Effort, string | null>>;
}
const CATALOG = catalog.models as unknown as Record<string, CatalogModel | undefined>;

/** The Pi models a roster runs, once each in tier order, each with the tiers' efforts. Claude-provider tiers run on Claude Code, not Pi. */
function rosterPiModels(p: Policy, roster: RosterName): Map<string, ModelSpec[]> {
  const byRef = new Map<string, ModelSpec[]>();
  for (const tier of ["small", "medium", "large"] as const) {
    const spec = p.rosters[roster][tier];
    if (spec.provider === "pi") byRef.set(spec.model, [...(byRef.get(spec.model) ?? []), spec]);
  }
  return byRef;
}

/**
 * The catalog entry for each Pi model a roster uses, or a refusal:
 * - a model the catalog lacks, since nothing could pin it (an unpinned model
 *   falls back to whatever a planted store says);
 * - for `anthropic/*`, one without `supportsMidConvoEffort` (H-184: Pi sends
 *   `drop_block` only then, and a 400 follows the first compaction), or a tier
 *   whose `effort` or `retry_effort` the catalog maps to null. Other vendors
 *   build anyway: Pi 1.3.0 sends `max` for some efforts there without a word,
 *   which the portable roster's H-120 note tracks.
 */
function pinnedModels(p: Policy, roster: RosterName): Map<string, CatalogModel> {
  const out = new Map<string, CatalogModel>();
  for (const [ref, specs] of rosterPiModels(p, roster)) {
    splitPiRef(ref);
    const where = `policy/rosters/${roster}.yaml: ${ref}`;
    const entry = CATALOG[ref];
    const anthropic = ref.startsWith("anthropic/");
    if (entry === undefined) throw new Error(`${where}: not in Pi 1.3.0's catalog${anthropic ? " with supportsMidConvoEffort (H-184)" : ""}`);
    if (anthropic) {
      if (entry.compat.supportsMidConvoEffort !== true) throw new Error(`${where}: not in Pi 1.3.0's catalog with supportsMidConvoEffort (H-184)`);
      for (const spec of specs) {
        for (const [field, effort] of [["effort", spec.effort], ["retry_effort", spec.retry_effort]] as const) {
          if (effort !== undefined && entry.thinkingLevelMap[effort] === null) {
            throw new Error(`${where}: ${field} '${effort}' maps to null in Pi 1.3.0's catalog`);
          }
        }
      }
    }
    out.set(ref, entry);
  }
  return out;
}

/** Pretty-printed JSON with a trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function modelsJson(p: Policy, roster: RosterName): string {
  const byVendor = new Map<string, Map<string, CatalogModel>>();
  for (const [ref, entry] of pinnedModels(p, roster)) {
    const { vendor, id } = splitPiRef(ref);
    byVendor.set(vendor, (byVendor.get(vendor) ?? new Map()).set(id, entry));
  }
  const providers = Object.fromEntries(
    [...byVendor.keys()].sort().map((vendor) => {
      const models = byVendor.get(vendor)!;
      const baseUrls = new Set([...models.values()].map((m) => m.baseUrl));
      if (baseUrls.size !== 1) throw new Error(`policy/rosters/${roster}.yaml: ${vendor}: the catalog gives more than one baseUrl`);
      return [
        vendor,
        {
          baseUrl: [...baseUrls][0],
          modelOverrides: Object.fromEntries(
            [...models.keys()].sort().map((id) => [id, { maxTokens: MAX_TOKENS, cost: models.get(id)!.cost, compat: models.get(id)!.compat }]),
          ),
        },
      ];
    }),
  );
  return json({
    // JSON has no comments, so the notice is a $comment, first. Pi 1.3.0 accepts it: its models.json
    // schema (ModelsConfigSchema, core/model-config.ts) doesn't forbid other keys, and Pi reads
    // only `providers`.
    $comment: notice("Pi models.json: the cost, output-token cap and compat pins for each Pi model, from Pi 1.3.0's catalog", [
      `policy/rosters/${roster}.yaml`,
    ]).join(" "),
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

/** What may sit in Pi's agent directory in a run (the guard fails the node on anything else). */
const AGENT_DIR_ALLOWED = [
  "auth.json",
  "auth.json.lock",
  "extensions",
  "hapi-guard.json",
  "models-store.json",
  "models-store.json.lock",
  "models.json",
  "sessions",
  "settings.json",
];

/** The env names of the Archon zone of stack/secrets.yaml, sorted: what the guard keeps out of a worker's shell. */
function archonSecretEnv(): string[] {
  return Object.keys(loadManifest(join(REPO_ROOT, MANIFEST_FILE)).archon ?? {}).sort();
}

function hapiGuardJson(p: Policy, roster: RosterName): string {
  const models = Object.fromEntries(
    [...pinnedModels(p, roster)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ref, m]) => [
        ref,
        { base_url: m.baseUrl, cost: m.cost, compat: m.compat, max_tokens: MAX_TOKENS, require_compat: ref.startsWith("anthropic/") },
      ]),
  );
  return json({
    $comment: [
      ...notice("hapi-guard settings for Pi workers", [
        "policy/protected_paths.yaml",
        "policy/budgets.yaml",
        "policy/gates.yaml",
        "policy/flags.yaml",
        `policy/rosters/${roster}.yaml`,
        "stack/secrets.yaml",
      ]),
      "protected_paths: repo-relative globs in the syntax of src/policy/paths.ts (docs/policy.md, Glob syntax).",
      "A file is blocked if ANY glob matches it (combine: strictest).",
      "models: the pinned catalog entry the guard compares with the resolved model at session_start.",
    ].join(" "),
    session: "workers",
    combine: "strictest",
    protected_paths: workerRules(p),
    budgets: { run_usd: p.budgets.run_usd, mode: p.budgets.enforcement.hapi_guard },
    max_tokens: MAX_TOKENS,
    models,
    secret_env: archonSecretEnv(),
    agent_dir_allowed: AGENT_DIR_ALLOWED,
    gates: p.gates,
    jev: { enabled: p.flags.jev.enabled, fallback: p.flags.jev.fallback },
    paths: { out: RUN_PATHS.out, runFile: RUN_PATHS.runFile, ledgerDir: RUN_PATHS.ledgerDir },
  });
}

/**
 * Pi's generated files. Pure, but for reading stack/secrets.yaml. A refusal throws
 * before any file is written.
 *
 * `models-store.json` is exactly `{}`, with no `$comment`: Pi reads the file as its
 * own model store, and a non-empty object might be taken as a catalog overlay.
 */
export function emitPi(p: Policy, roster: RosterName = "anthropic"): Record<string, string> {
  return {
    "models.json": modelsJson(p, roster),
    "models-store.json": "{}\n",
    "settings.json": json({ $comment: notice("Pi settings.json: nothing set", ["no policy file"]).join(" ") }),
    "hapi-guard.json": hapiGuardJson(p, roster),
  };
}
