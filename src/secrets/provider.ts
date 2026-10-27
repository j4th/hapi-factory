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
 * There is no automatic fallback. `providerFor` builds exactly the configured
 * provider, and if it fails, or any name is missing or empty, `resolveSecrets`
 * writes nothing, so nothing starts.
 *
 * Errors name zones, env vars, logical names, files and exit codes, never a
 * value. The kinds: a PolicyError when the manifest or config doesn't match
 * its schema; a plain Error for XDG_RUNTIME_DIR; a SecretError for the config
 * file being absent, the provider and the store.
 *
 * (The providers import `SecretError` from here and this module imports them
 * for `providerFor`: an import cycle that is safe because neither side uses
 * the other's exports until a function runs.)
 */
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadPolicy, PolicyError } from "../policy/load";
import { check, readYaml } from "../policy/schema";
import { defaultRepoRoot, ENV_DIR, envFileText, envValueProblem, runtimeDir, secureDir, writeSecretFiles } from "./files";
import {
  LOGICAL_NAME,
  loadManifest,
  type Manifest,
  MANIFEST_FILE,
  type ManifestEntry,
  manifestEntries,
  mcpSecretGaps,
  type McpSecretGap,
  SECRET_ZONES,
  type SecretZone,
  shownName,
} from "./manifest";
import { type BwsRunner, bwsProvider } from "./providers/bws";
import { envFileProvider } from "./providers/env-file";
import { checkSopsKeys, type SopsRunner, sopsEditInvocation, sopsProvider } from "./providers/sops";

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
  /** True for env-file: plaintext on disk. `hapi audit` (Plan 01 Task 6) reports it. */
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

/** What `hapi audit` needs to know about a config: the provider, whether it is a downgrade, and every file it uses (the config first). */
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

/** Runs a command with stdio inherited (for `sops edit`); resolves to its exit code. */
export type InteractiveRunner = (cmd: string, args: string[], o: { env: Record<string, string> }) => Promise<number>;

const runInteractive: InteractiveRunner = async (cmd, args, o) => {
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn([cmd, ...args], { env: o.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch {
    throw new SecretError(`cannot run ${cmd}: is it on PATH? (\`mise install\` provides it)`);
  }
  return await proc.exited;
};

/** What the secrets commands can be given instead of the real thing, for tests. */
export interface SecretsDeps {
  env?: Env;
  cwd?: string;
  uid?: number;
  /** The hapi-factory checkout that keys and plaintext stores must stay out of. Default: `defaultRepoRoot`. */
  repoRoot?: () => Promise<string>;
  sops?: SopsRunner;
  ageKeygen?: SopsRunner;
  bws?: BwsRunner;
  interactive?: InteractiveRunner;
  manifestFile?: string;
  policyDir?: string;
}

/** Exactly the configured provider. Nothing else is built, so nothing else can be fallen back on. */
export function providerFor(cfg: SecretsConfig, deps: SecretsDeps = {}): SecretProvider {
  const common = { ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}), ...(deps.uid === undefined ? {} : { uid: deps.uid }) };
  switch (cfg.provider) {
    case "sops":
      return sopsProvider({ file: cfg.sops.file, ageKeyFile: cfg.sops.age_key_file, env: deps.env ?? process.env, ...(deps.sops ? { run: deps.sops } : {}), ...common });
    case "bws":
      return bwsProvider({ ids: cfg.bws.ids, ...(deps.bws ? { run: deps.bws } : {}) });
    case "env-file":
      return envFileProvider({ file: cfg.env_file.file, ...common });
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

const where = (e: ManifestEntry) => `${e.zone}/${e.key} (${e.name})`;
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
  await writeSecretFiles(envDir, files);
  return paths;
}

/** One env var's status in a check. `invalid`: present, but a value `resolveSecrets` would refuse (`reason` says why). */
export interface SecretCheck extends ManifestEntry {
  status: "found" | "missing" | "empty" | "invalid";
  reason?: string;
}

/**
 * The dry run: what `resolveSecrets` would find, per env var, plus `unknown`,
 * the store's names that the manifest doesn't list. Values are read only to
 * classify them, and dropped; nothing is written. A provider failure throws.
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
  return { entries: checks, unknown: [...stored].filter((n) => !names.includes(n)).sort() };
}

/** Parse `--config <file>` and, if allowed, `--dry-run`. Undefined on a usage error. */
function parseArgs(args: string[], allowDryRun: boolean): { config?: string; dryRun: boolean } | undefined {
  let config: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--dry-run" && allowDryRun) dryRun = true;
    else if (arg === "--config" && value !== undefined && !value.startsWith("-")) {
      config = value;
      i++;
    } else return undefined;
  }
  return { ...(config === undefined ? {} : { config }), dryRun };
}

const gapReason = (g: McpSecretGap, policyDir: string) =>
  `${policyDir}/mcp.yaml's ${g.server} server needs secret:${g.name}; map ${g.env} to ${g.name} in the ${g.zone} zone of ${MANIFEST_FILE}`;

/** Load the manifest and check it covers the MCP catalog; load the config and build its provider. */
function prepare(config: string | undefined, deps: SecretsDeps) {
  const env = deps.env ?? process.env;
  const policyDir = deps.policyDir ?? "policy";
  const manifest = loadManifest(deps.manifestFile ?? MANIFEST_FILE);
  const gaps = mcpSecretGaps(loadPolicy(policyDir), manifest);
  const cfg = loadSecretsConfig(configPath({ config, env, ...(deps.cwd ? { cwd: deps.cwd } : {}) }), env);
  const provider = providerFor(cfg, { ...deps, env });
  if (provider.downgrade) {
    console.error(
      `hapi secrets: warning: the env-file provider is a downgrade (plaintext on disk, in ${describeSecretsConfig(cfg).files[1]}); hapi audit reports it. sops + age is the default (docs/secrets.md).`,
    );
  }
  return { env, policyDir, manifest, gaps, cfg, provider };
}

const RESOLVE_USAGE = "usage: hapi secrets resolve [--config file] [--dry-run]";
const CHECK_USAGE = "usage: hapi secrets check [--config file]";
const EDIT_USAGE = "usage: hapi secrets edit [--config file]";

async function runCheck(config: string | undefined, deps: SecretsDeps): Promise<number> {
  const { manifest, gaps, provider, policyDir } = prepare(config, deps);
  const { entries, unknown } = await checkSecrets(manifest, provider);
  const line = (status: string, what: string, note = "") => console.log(`${status.padEnd(8)} ${what}${note}`);
  for (const e of entries) line(e.status, where(e), e.reason === undefined ? "" : `: ${e.reason}`);
  for (const g of gaps) line("missing", `${g.zone}/${g.env}`, ` (${gapReason(g, policyDir)})`);
  for (const n of unknown) line("unknown", shownName(n), ` (in the store, not in ${MANIFEST_FILE})`);
  const bad = [...entries.filter((e) => e.status !== "found").map((e) => `${e.zone}/${e.key}`), ...gaps.map((g) => `${g.zone}/${g.env}`)];
  if (bad.length === 0) return 0;
  const fix = { sops: "Fill them in with `mise run secrets:edit`", bws: "Add or fill them in Bitwarden, with each id under bws.ids in your secrets config", "env-file": "Add or fill them in your env file" }[provider.name];
  console.error(`hapi secrets check: ${bad.length} of ${entries.length + gaps.length} secrets are missing or empty: ${bad.join(", ")}. ${fix} (docs/secrets.md).`);
  return 1;
}

/**
 * `hapi secrets check [--config file]`: print `found`, `missing`, `empty` or
 * `invalid` for every env var of the manifest, `missing` for an MCP reference
 * the manifest doesn't map, and `unknown` for each store name the manifest
 * doesn't list. Never a value. Exits 1 if anything is missing, empty or
 * invalid. It writes nothing, so it needs no XDG_RUNTIME_DIR.
 */
export async function secretsCheck(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const parsed = parseArgs(args, false);
  if (parsed === undefined) {
    console.error(CHECK_USAGE);
    return 2;
  }
  return runCheck(parsed.config, deps);
}

/**
 * `hapi secrets resolve [--config file] [--dry-run]`: resolve the manifest
 * from the configured provider into `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`
 * and print each path. Any failure throws, naming the secret; nothing is
 * written. `--dry-run` is `hapi secrets check`.
 */
export async function secretsResolve(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const parsed = parseArgs(args, true);
  if (parsed === undefined) {
    console.error(RESOLVE_USAGE);
    return 2;
  }
  if (parsed.dryRun) return runCheck(parsed.config, deps);
  const env = deps.env ?? process.env;
  const outDir = runtimeDir(env);
  const { manifest, gaps, provider, policyDir } = prepare(parsed.config, deps);
  const gap = gaps[0];
  if (gap !== undefined) throw new SecretError(`${gap.zone}/${gap.env}: ${gapReason(gap, policyDir)}`);
  const paths = await resolveSecrets(manifest, provider, { outDir });
  for (const path of Object.values(paths).sort()) console.log(path);
  return 0;
}

/**
 * `hapi secrets edit [--config file]`: sops only. Checks the age key, then
 * runs `sops edit` on the configured file with stdio inherited. sops decrypts
 * into a temp file for the editor, so TMPDIR is `$XDG_RUNTIME_DIR/hapi` (the
 * user's tmpfs): the plaintext never lands on a disk. The editor gets the
 * caller's env minus every SOPS_* variable, plus SOPS_AGE_KEY_FILE and
 * SOPS_DISABLE_VERSION_CHECK=1. sops's exit 200 (file unchanged) counts as success.
 */
export async function secretsEdit(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const parsed = parseArgs(args, false);
  if (parsed === undefined) {
    console.error(EDIT_USAGE);
    return 2;
  }
  const env = deps.env ?? process.env;
  const cfg = loadSecretsConfig(configPath({ config: parsed.config, env, ...(deps.cwd ? { cwd: deps.cwd } : {}) }), env);
  if (cfg.provider !== "sops") {
    throw new SecretError(`hapi secrets edit works with the sops provider only; ${cfg.path} selects ${cfg.provider}. Edit that store with its own tools (docs/secrets.md)`);
  }
  const tmp = runtimeDir(env);
  await secureDir(tmp, dirname(tmp), deps.uid === undefined ? {} : { uid: deps.uid });
  const inv = sopsEditInvocation({ file: cfg.sops.file, ageKeyFile: cfg.sops.age_key_file, env, tmpDir: tmp });
  await checkSopsKeys(cfg.sops.age_key_file, inv.env, { repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(), ...(deps.uid === undefined ? {} : { uid: deps.uid }) });
  const code = await (deps.interactive ?? runInteractive)("sops", inv.args, { env: inv.env });
  if (code === 0 || code === 200) return 0;
  console.error(`hapi secrets edit: sops exited with status ${code}; the file is unchanged unless sops said otherwise`);
  return 1;
}
