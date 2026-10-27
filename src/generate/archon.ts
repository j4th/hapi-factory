/**
 * Archon's files (spec §9.2, Archon v0.12.1):
 *
 * - `config.yaml`: Archon's global config (`~/.archon/config.yaml`). Its `tiers`
 *   map small/medium/large to the selected roster, and its `aliases` name each
 *   Archon role's tier (roles.yaml), so workflows say `@implement` or `medium`
 *   and never a model id (spec §8.1, §12). The syntax is Archon's
 *   docs/reference/configuration.md: `{provider, model, effort}`, aliases start
 *   with "@". A pi-provider model is a Pi ref `<vendor>/<id>`; a claude one is
 *   an Anthropic model id. Both pass through unchanged.
 * - `archon.env`: the Archon container's environment: loopback bind, telemetry
 *   off, and the Pi worker settings (spec §9.2, §9.3). The record of what
 *   stack/compose.yaml's archon `environment:` sets (`ARCHON_ENV`), and what
 *   Task 6's audit compares the running container with.
 */
import YAML from "yaml";
import { type ModelSpec, type Policy, ROLES, type RosterName, type Tier } from "../policy/types";
import { hashComment, notice, wrap } from "./header";

/**
 * Where the Archon container mounts build/pi, read-only (Plan 01 Task 5). Pi
 * reads models.json from here and hapi-guard its settings; nothing in the
 * container can write it.
 */
export const PI_AGENT_DIR = "/opt/hapi/pi-agent";

const TIERS: Tier[] = ["small", "medium", "large"];

/** The roles that run inside Archon: every role but hermes_*, which run in Hermes (./hermes.ts). */
const ARCHON_ROLES = ROLES.filter((role) => !role.startsWith("hermes_"));

/** An Archon tier or alias preset: the roster entry without `retry_effort`. */
function preset(spec: ModelSpec, effort = spec.effort): { provider: string; model: string; effort: string } {
  return { provider: spec.provider, model: spec.model, effort };
}

function configYaml(p: Policy, roster: RosterName): string {
  const r = p.rosters[roster];
  const tiers = Object.fromEntries(TIERS.map((t) => [t, preset(r[t])]));
  const aliases: Record<string, ReturnType<typeof preset>> = {};
  for (const role of ARCHON_ROLES) {
    const spec = r[p.roles[role]];
    const name = `@${role.replaceAll("_", "-")}`;
    aliases[name] = preset(spec);
    // A failed step retries once at higher effort before any change of model (spec §9.2, §12).
    if (spec.retry_effort !== undefined) aliases[`${name}-retry`] = preset(spec, spec.retry_effort);
  }
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const doc = new YAML.Document({ tiers, aliases: sorted });
  doc.commentBefore = [
    ...notice("Archon global config (~/.archon/config.yaml, Archon v0.12.1)", [
      "policy/roles.yaml",
      `policy/rosters/${roster}.yaml`,
    ]),
    "",
    `tiers: the ${roster} roster. aliases: one per Archon role, at its tier in roles.yaml; "-retry"`,
    "is the same model at the tier's retry_effort.",
  ]
    .map((l) => (l === "" ? "" : ` ${l}`))
    .join("\n");
  return doc.toString({ lineWidth: 0 });
}

/**
 * The container environment, in this order: name, value, why. Values never
 * need quoting. stack/compose.yaml sets every one in the archon service's
 * `environment:` (src/stack/env.ts), which beats any env_file, so no secret
 * can override them; tests/stack/compose.test.ts keeps the two equal.
 */
export const ARCHON_ENV: readonly (readonly [name: string, value: string, why: string])[] = [
  ["HOST", "127.0.0.1", "Archon's server listens on loopback only; it has no auth in SQLite mode (spec §9.2)"],
  ["ARCHON_TELEMETRY_DISABLED", "1", "no Archon telemetry"],
  ["DO_NOT_TRACK", "1", "the cross-tool telemetry opt-out, which Archon also honours"],
  ["PI_OFFLINE", "1", "Pi makes no network calls of its own: no installing the packages a repo's .pi/settings.json lists, no catalog refresh, no update check (spec §9.3: critical)"],
  ["PI_TELEMETRY", "0", "no Pi install telemetry"],
  ["PI_CODING_AGENT_DIR", PI_AGENT_DIR, "Pi's agent dir: build/pi, mounted read-only (models.json, hapi-guard.json)"],
];

function archonEnv(): string {
  const head = hashComment([
    ...notice("Archon container environment", ["the hardening settings of spec §9.2 and §9.3 (no policy file)"]),
  ]);
  const body = ARCHON_ENV.map(([key, value, why]) => `${hashComment(wrap(why))}\n${key}=${value}`).join("\n");
  return `${head}\n\n${body}\n`;
}

/** Archon's generated files: `config.yaml` and `archon.env`. Pure. */
export function emitArchon(p: Policy, roster: RosterName = "anthropic"): Record<string, string> {
  return { "config.yaml": configYaml(p, roster), "archon.env": archonEnv() };
}
