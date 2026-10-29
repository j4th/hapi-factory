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
 * - `run-config.yaml`: the per-run `--config` layer (spike 07): the same tiers and
 *   aliases, with `assistants.pi.enableExtensions` pinned on and
 *   `workflows.autoResumeOnQuotaReset` off. It beats a repo's own
 *   `.archon/config.yaml`, which Archon reads from the clone.
 * - `gitconfig`: the run container's `~/.gitconfig`, read-only. It trusts the
 *   source clone and Archon's workspace dirs, and names the worker.
 * - `empty.env`: bound over `/.archon/.env`, so no env file of a repo or an earlier
 *   run reaches Archon's workflows.
 * - `archon.env`: the Archon container's environment: loopback bind, telemetry
 *   off, and the Pi worker settings (spec §9.2, §9.3). The record of what
 *   stack/compose.yaml's archon `environment:` sets (`ARCHON_ENV`), and what
 *   Task 6's audit compares the running container with.
 */
import YAML from "yaml";
import { type ModelSpec, type Policy, ROLES, type RosterName, type Tier } from "../policy/types";
import { hashComment, notice, wrap } from "./header";

/**
 * The fixed paths inside the run container (spike 07, spike 08). Every consumer
 * (the launcher, hapi-guard, the audit) imports them from here.
 */
export const RUN_PATHS = {
  /** Pi's agent dir: a tmpfs with build/pi's files bound read-only into it (Plan 02 Task 7). */
  piDir: "/opt/hapi/pi-agent",
  /** Where a run writes its output files. */
  out: "/out",
  /** The clone a worker edits. */
  work: "/work/repo",
  /** The bare source repo the clone comes from, read-only. */
  source: "/src/repo.git",
  /** The per-run input (a `RunFile`), bound read-only. */
  runFile: "/run/hapi/run.json",
  /** Where hapi-guard keeps its per-attempt ledger. */
  ledgerDir: "/tmp/hapi-guard",
  /** The home-scoped workflow pack, bound read-only. */
  pack: "/.archon/workflows/hapi",
} as const;

/**
 * The per-run input the launcher writes and binds read-only at
 * `RUN_PATHS.runFile`. No work-order file enters the container.
 */
export interface RunFile {
  run_id: string;
  /** The work order's id. */
  work_order: string;
  traceparent: string;
  /** Already `min(work order budget.usd, --budget-usd)`. */
  budget_usd: number;
  public: boolean;
  workflow: string;
  started_at: string;
}

/**
 * Where the Archon container mounts Pi's agent dir (Plan 01 Task 5). Pi reads
 * models.json from here and hapi-guard its settings; the files bound into it
 * are read-only.
 */
export const PI_AGENT_DIR = RUN_PATHS.piDir;

const TIERS: Tier[] = ["small", "medium", "large"];

/** The roles that run inside Archon: every role but hermes_*, which run in Hermes (./hermes.ts). */
const ARCHON_ROLES = ROLES.filter((role) => !role.startsWith("hermes_"));

/** An Archon tier or alias preset: the roster entry without `retry_effort`. */
function preset(spec: ModelSpec, effort = spec.effort): { provider: string; model: string; effort: string } {
  return { provider: spec.provider, model: spec.model, effort };
}

/** Archon's `config.yaml` or the run's `run-config.yaml`: the same tiers and aliases, and the settings the worker needs. */
function configYaml(p: Policy, roster: RosterName, run: boolean): string {
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
  // hapi-guard is a Pi extension, and Archon 0.12.1 only defaults enableExtensions on (H-181(b)).
  const doc = new YAML.Document({
    assistants: { pi: { enableExtensions: true } },
    ...(run ? { workflows: { autoResumeOnQuotaReset: false } } : {}),
    tiers,
    aliases: sorted,
  });
  doc.commentBefore = [
    ...notice(
      run
        ? "Archon run config (--config /opt/hapi/run-config.yaml, Archon v0.12.1)"
        : "Archon global config (~/.archon/config.yaml, Archon v0.12.1)",
      ["policy/roles.yaml", `policy/rosters/${roster}.yaml`],
    ),
    "",
    `assistants: hapi-guard needs Pi's extensions on. tiers: the ${roster} roster. aliases: one per Archon role,`,
    `at its tier in roles.yaml; "-retry" is the same model at the tier's retry_effort.`,
    ...(run ? ["workflows: a run never resumes itself after a quota reset; the launcher decides."] : []),
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

/** The directories Git is told to trust: the source clone, and Archon's workspaces and worktrees. */
const SAFE_DIRECTORIES = [RUN_PATHS.source, "/.archon/workspaces", "/.archon/workspaces/*", "/.archon/worktrees", "/.archon/worktrees/*"];

/**
 * The run container's `~/.gitconfig` (spike 07, finding 3). The clone is owned by
 * the worker, but its source (`/src/repo.git`) is bind-mounted from another uid,
 * so Git's ownership check needs a `[safe]` entry. The `/.archon` entries are
 * for worktrees, which `--no-worktree` doesn't use but which do no harm.
 */
function gitconfig(): string {
  const head = hashComment(notice("Git config for the run container (~/.gitconfig)", ["the run container's paths (RUN_PATHS), no policy file"]));
  const safe = SAFE_DIRECTORIES.map((d) => `\tdirectory = ${d}`).join("\n");
  return `${head}\n[safe]\n${safe}\n[user]\n\tname = hapi-factory worker\n\temail = worker@hapi.invalid\n`;
}

/** Bound over `/.archon/.env`: only comments, so Archon loads no env file. */
function emptyEnv(): string {
  return `${hashComment(notice("An empty env file, bound over /.archon/.env so Archon's workflows get no env from a file", ["no policy file"]))}\n`;
}

/** Archon's generated files: the config, the run config, the env files and the gitconfig. Pure. */
export function emitArchon(p: Policy, roster: RosterName = "anthropic"): Record<string, string> {
  return {
    "config.yaml": configYaml(p, roster, false),
    "run-config.yaml": configYaml(p, roster, true),
    "archon.env": archonEnv(),
    "empty.env": emptyEnv(),
    gitconfig: gitconfig(),
  };
}
