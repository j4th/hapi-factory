/**
 * Pluggable secret providers (spec §11.5), resolved fail-closed.
 *
 * Secrets come in three parts:
 * - the manifest (./manifest.ts, stack/secrets.yaml): committed, public,
 *   provider-neutral, logical names only;
 * - the local config (`loadSecretsConfig`): outside the repo, by default
 *   `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`. It picks one
 *   provider and binds it;
 * - the store: the provider's own data. sops + age is the default
 *   (./providers/sops.ts); bws is optional (./providers/bws.ts); env-file is an
 *   explicit, audited downgrade (./providers/env-file.ts).
 *
 * This module holds the provider contract, the config, and the resolver; it
 * imports no provider. `providerFor` (./cli.ts) builds exactly the configured
 * one: there is no automatic fallback. If it fails, or any name is missing or
 * empty, `resolveSecrets` writes nothing, so nothing starts.
 *
 * Errors name zones, env vars, logical names, files and exit codes, never a
 * value. The kinds: a PolicyError when the manifest or config doesn't match
 * its schema; a plain Error for XDG_RUNTIME_DIR; a SecretError for the config
 * file being absent, the provider and the store.
 */
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PolicyError } from "../policy/load";
import { check, readYaml } from "../policy/schema";
import { ENV_DIR, envFileText, envValueProblem, secureDir, writeSecretFiles } from "./files";
import { LOGICAL_NAME, type Manifest, type ManifestEntry, manifestEntries, SECRET_ZONES, type SecretZone, shownName } from "./manifest";

export type Env = Record<string, string | undefined>;
export type ProviderName = "sops" | "bws" | "env-file";

/**
 * A secret could not be resolved. The message names logical names, zones, env
 * vars, files or exit codes, never a value. `missing` lists the logical names
 * the store lacks, when that is the problem.
 */
export class SecretError extends Error {
  override name = "SecretError";
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
  ) {
    super(message);
  }
}

/**
 * A secret store. `fetch` returns every name asked for, or throws a
 * SecretError (with `missing` set when names are absent). It ignores store
 * entries it wasn't asked for. `list` gives every name the store holds (for
 * bws, every name the config binds), without values, so `checkSecrets` can
 * tell missing from present and report unknown names.
 */
export interface SecretProvider {
  readonly name: ProviderName;
  /** True for env-file: plaintext on disk. `hapi audit` fails on it (secrets.provider; --dev: a skip). */
  readonly downgrade: boolean;
  fetch(names: string[]): Promise<Map<string, string>>;
  list(): Promise<string[]>;
}

/** The local config, loaded: `path` is where it was read, and every path in it is absolute. */
export type SecretsConfig =
  | { path: string; provider: "sops"; sops: { file: string; age_key_file: string } }
  | { path: string; provider: "bws"; bws: { ids: Record<string, string> } }
  | { path: string; provider: "env-file"; env_file: { file: string } };

/** The block each provider reads in the config. */
const BLOCK: Record<ProviderName, "sops" | "bws" | "env_file"> = { sops: "sops", bws: "bws", "env-file": "env_file" };

/** $HOME, which must be an absolute path. */
function home(env: Env): string {
  const h = env.HOME;
  if (h === undefined || h === "" || !isAbsolute(h)) throw new Error("HOME is not set to an absolute path; set it, or pass --config");
  return h;
}

/** `${XDG_CONFIG_HOME:-$HOME/.config}`. A relative XDG_CONFIG_HOME is invalid by the XDG spec, so it is ignored. */
export function configHome(env: Env): string {
  const x = env.XDG_CONFIG_HOME;
  return x !== undefined && x !== "" && isAbsolute(x) ? x : join(home(env), ".config");
}

/** sops's own default age key file: `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`. */
export function defaultAgeKeyFile(env: Env): string {
  return join(configHome(env), "sops", "age", "keys.txt");
}

/** A path from a flag or a config: a leading `~` is $HOME, a relative path is relative to `base`. */
export function expandPath(p: string, env: Env, base: string): string {
  if (p === "~") return home(env);
  if (p.startsWith("~/")) return join(home(env), p.slice(2));
  return resolve(base, p);
}

/** The config's path: `--config`, else $HAPI_SECRETS_CONFIG, else `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`. */
export function configPath(o: { config?: string | undefined; env: Env; cwd?: string }): string {
  const given = o.config ?? (o.env.HAPI_SECRETS_CONFIG || undefined);
  if (given !== undefined) return expandPath(given, o.env, o.cwd ?? process.cwd());
  return join(configHome(o.env), "hapi", "secrets.yaml");
}

const CONFIG_KEYS = new Set(["provider", "sops", "bws", "env_file", "file", "age_key_file", "ids"]);

/** A JSON Pointer into the config, with any segment that isn't a config key or a logical name hidden: it may be a pasted secret. */
function scrubConfigPointer(path: string): string {
  return path
    .split("/")
    .map((seg, i, all) => {
      if (i === 0 || CONFIG_KEYS.has(seg)) return seg;
      if (i === 3 && all[1] === "bws" && all[2] === "ids") return LOGICAL_NAME.test(seg) ? seg : "<name>";
      return "<key>";
    })
    .join("/");
}

/**
 * Load the local config at `path` (see `configPath`) and check it against
 * secrets-config.schema.json. Exactly the selected provider's block must be
 * set: any other block is refused, so a config never names two stores.
 * A leading `~` expands to $HOME, and a relative path resolves against the
 * config's directory. The sops age key defaults to sops's own path.
 *
 * Throws a SecretError if there is no file at `path`, and a PolicyError (JSON
 * Pointers scrubbed) if it doesn't check.
 */
export function loadSecretsConfig(path: string, env: Env): SecretsConfig {
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SecretError(`no secrets config at ${path}: run \`mise run secrets:init\``);
    throw e;
  }
  let raw: unknown;
  try {
    raw = readYaml(path);
  } catch (e) {
    throw new PolicyError(path, [{ path: "", message: (e as Error).message }]);
  }
  const issues = check("secrets-config", raw);
  const data = (raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const provider = data.provider;
  if (typeof provider === "string" && Object.hasOwn(BLOCK, provider)) {
    for (const block of Object.values(BLOCK)) {
      if (block !== BLOCK[provider as ProviderName] && Object.hasOwn(data, block)) {
        issues.push({ path: `/${block}`, message: `the provider is ${provider}, so only its ${BLOCK[provider as ProviderName]} block may be set; remove ${block}` });
      }
    }
  }
  if (issues.length > 0) throw new PolicyError(path, issues.map((i) => ({ ...i, path: scrubConfigPointer(i.path) })));

  const base = dirname(path);
  const at = (p: string) => expandPath(p, env, base);
  switch (provider as ProviderName) {
    case "sops": {
      const s = data.sops as { file: string; age_key_file?: string };
      return { path, provider: "sops", sops: { file: at(s.file), age_key_file: s.age_key_file === undefined ? defaultAgeKeyFile(env) : at(s.age_key_file) } };
    }
    case "bws":
      return { path, provider: "bws", bws: { ids: { ...(data.bws as { ids: Record<string, string> }).ids } } };
    case "env-file":
      return { path, provider: "env-file", env_file: { file: at((data.env_file as { file: string }).file) } };
  }
}

/**
 * What `hapi audit` needs to know about a config: the provider, whether it is a downgrade, and every file it
 * uses (the config first). The sops store's recipients file and recovery.age, beside the store, aren't listed
 * here (./recipients.ts imports this module); `hapi audit` (secrets.provider) checks them with `recipientReport`.
 */
export function describeSecretsConfig(cfg: SecretsConfig): { provider: ProviderName; downgrade: boolean; files: string[] } {
  switch (cfg.provider) {
    case "sops":
      return { provider: "sops", downgrade: false, files: [cfg.path, cfg.sops.file, cfg.sops.age_key_file] };
    case "bws":
      return { provider: "bws", downgrade: false, files: [cfg.path] };
    case "env-file":
      return { provider: "env-file", downgrade: true, files: [cfg.path, cfg.env_file.file] };
  }
}

/** How to fix `n` missing or empty secrets in each provider's store. */
function storeHint(provider: ProviderName, problem: "missing" | "empty", n: number): string {
  const it = n === 1 ? "it" : "them";
  const its = n === 1 ? "its" : "their";
  switch (provider) {
    case "sops":
      return problem === "missing" ? `add ${it} with \`mise run secrets:edit\`` : `fill ${it} in with \`mise run secrets:edit\``;
    case "bws":
      return problem === "missing" ? `add ${it} in Bitwarden, and ${its} id under bws.ids in your secrets config` : `set ${its} value in Bitwarden`;
    case "env-file":
      return problem === "missing"
        ? `add ${it} to your env file as NAME='value', NAME being the logical name upper-cased with "-" as "_"`
        : `set ${its} value in your env file`;
  }
}

/** An env var of the manifest as errors and `check` show it: `zone/ENV (logical-name)`. */
export const entryLabel = (e: ManifestEntry) => `${e.zone}/${e.key} (${e.name})`;
const where = entryLabel;
const isAre = (n: number) => (n === 1 ? "is" : "are");

/**
 * Resolve every secret in `manifest` from `provider` and write the zone env
 * files under `<outDir>/env/` (`outDir` is `$XDG_RUNTIME_DIR/hapi`, whose
 * parent is the runtime root `secureDir` checks). Resolves to the paths
 * written, by zone.
 *
 * In order: check the runtime directory; fetch the de-duplicated logical names
 * once; check every value (an empty one counts as missing; `envValueProblem`);
 * only then write the whole set with `writeSecretFiles`. Any failure throws,
 * naming `zone/ENV (name)`, and writes nothing.
 */
export async function resolveSecrets(manifest: Manifest, provider: SecretProvider, opts: { outDir: string }): Promise<Partial<Record<SecretZone, string>>> {
  const entries = manifestEntries(manifest);
  await secureDir(opts.outDir, dirname(opts.outDir));
  const names = [...new Set(entries.map((e) => e.name))].sort();

  const missingError = (absent: readonly string[], why?: string) => {
    const list = entries.filter((e) => absent.includes(e.name)).map(where);
    return new SecretError(
      `${list.join(", ")} ${isAre(list.length)} not in the ${provider.name} store${why ? ` (${why})` : ""}: ${storeHint(provider.name, "missing", list.length)}`,
      absent,
    );
  };
  let values: Map<string, string>;
  try {
    values = await provider.fetch(names);
  } catch (e) {
    if (e instanceof SecretError && e.missing.length > 0) throw missingError(e.missing, e.message);
    throw e;
  }
  const absent = names.filter((n) => !values.has(n));
  if (absent.length > 0) throw missingError(absent);

  const empty = entries.filter((e) => values.get(e.name)!.trim() === "");
  if (empty.length > 0) {
    throw new SecretError(`${empty.map(where).join(", ")} ${isAre(empty.length)} empty: ${storeHint(provider.name, "empty", empty.length)}`, [
      ...new Set(empty.map((e) => e.name)),
    ]);
  }
  for (const e of entries) {
    const problem = envValueProblem(values.get(e.name)!);
    if (problem !== undefined) throw new SecretError(`${where(e)}: ${problem}`);
  }

  const files: Record<string, string> = {};
  const paths: Partial<Record<SecretZone, string>> = {};
  const envDir = join(opts.outDir, ENV_DIR);
  for (const zone of SECRET_ZONES) {
    if (manifest[zone] === undefined) continue;
    const vals: Record<string, string> = {};
    for (const e of entries) if (e.zone === zone) vals[e.key] = values.get(e.name)!;
    files[`${zone}.env`] = envFileText(zone, vals);
    paths[zone] = join(envDir, `${zone}.env`);
  }
  // Also drops the zone files Task 4 wrote directly in outDir, before env/ existed.
  await writeSecretFiles(envDir, files, { legacy: SECRET_ZONES.map((z) => `${z}.env`) });
  return paths;
}

/** One env var's status in a check. `invalid`: present, but a value `resolveSecrets` would refuse (`reason` says why). */
export interface SecretCheck extends ManifestEntry {
  status: "found" | "missing" | "empty" | "invalid";
  reason?: string;
}

/**
 * The dry run: what `resolveSecrets` would find, per env var, plus `unknown`,
 * the store's names that the manifest doesn't list, each as `shownName` shows
 * it (a name that isn't a logical name may be a pasted value, so it is masked
 * here, not only when printed). Values are read only to classify them, and
 * dropped; nothing is written. A provider failure throws.
 */
export async function checkSecrets(manifest: Manifest, provider: SecretProvider): Promise<{ entries: SecretCheck[]; unknown: string[] }> {
  const entries = manifestEntries(manifest);
  const names = [...new Set(entries.map((e) => e.name))].sort();
  const stored = new Set(await provider.list());
  const present = names.filter((n) => stored.has(n));
  const values = present.length > 0 ? await provider.fetch(present) : new Map<string, string>();
  const checks = entries.map((e): SecretCheck => {
    const value = values.get(e.name);
    if (value === undefined) return { ...e, status: "missing" };
    if (value.trim() === "") return { ...e, status: "empty" };
    const problem = envValueProblem(value);
    return problem === undefined ? { ...e, status: "found" } : { ...e, status: "invalid", reason: problem };
  });
  return { entries: checks, unknown: [...stored].filter((n) => !names.includes(n)).sort().map(shownName) };
}
