/**
 * Every `hapi secrets ...` command handler (registered in ../cli.ts), and
 * `providerFor`, which builds the configured provider.
 *
 * The handlers parse their flags and call into ./init.ts, ./lifecycle.ts and
 * ./provider.ts. They live here, not in provider.ts, so that provider.ts
 * imports no provider and the providers import only it: no import cycle.
 *
 * A usage error prints the usage line and returns 2. Anything else that goes
 * wrong throws, and `hapi` prints it and exits 1.
 */
import { dirname } from "node:path";
import { loadPolicy } from "../policy/load";
import { defaultRepoRoot, runtimeDir, secureDir } from "./files";
import { initStore } from "./init";
import { shielded } from "./interrupt";
import { addMachine, drill, joinMachine, type LifecycleDeps, loadStore, newRecovery, recipientReport, recover, revoke, toolsFor } from "./lifecycle";
import { loadManifest, MANIFEST_FILE, mcpSecretGaps, type McpSecretGap } from "./manifest";
import { checkSecrets, configPath, describeSecretsConfig, entryLabel, loadSecretsConfig, resolveSecrets, SecretError, type SecretProvider, type SecretsConfig } from "./provider";
import { type BwsRunner, bwsProvider } from "./providers/bws";
import { envFileProvider } from "./providers/env-file";
import { checkSopsKeys, sopsEditInvocation, sopsProvider } from "./providers/sops";
import { withStoreLock } from "./store-files";

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
export interface SecretsDeps extends LifecycleDeps {
  bws?: BwsRunner;
  interactive?: InteractiveRunner;
  policyDir?: string;
}

/** Exactly the configured provider. Nothing else is built, so nothing else can be fallen back on. */
export function providerFor(cfg: SecretsConfig, deps: SecretsDeps = {}): SecretProvider {
  const common = { ...(deps.repoRoot ? { repoRoot: deps.repoRoot } : {}), ...(deps.uid === undefined ? {} : { uid: deps.uid }) };
  switch (cfg.provider) {
    case "sops":
      return sopsProvider({
        file: cfg.sops.file,
        ageKeyFile: cfg.sops.age_key_file,
        env: deps.env ?? process.env,
        ...(deps.sops ? { run: deps.sops } : {}),
        ...(deps.ageDir ? { ageDir: deps.ageDir } : {}),
        ...common,
      });
    case "bws":
      return bwsProvider({ ids: cfg.bws.ids, ...(deps.bws ? { run: deps.bws } : {}) });
    case "env-file":
      return envFileProvider({ file: cfg.env_file.file, ...common });
  }
}

/**
 * Parse `args` against `values` (flags that take a value) and `booleans`
 * (flags that don't). Undefined on a usage error: an unknown flag, a flag
 * given twice, a value missing or starting with "-", or a stray argument.
 */
function parseFlags(args: string[], values: string[], booleans: string[] = []): Record<string, string | true> | undefined {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (Object.hasOwn(out, flag)) return undefined;
    if (booleans.includes(flag)) out[flag] = true;
    else if (values.includes(flag)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      out[flag] = value;
      i++;
    } else return undefined;
  }
  return out;
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

/** Parse, or print `usage` and return undefined. */
function flagsOr(usage: string, args: string[], values: string[], booleans: string[] = []) {
  const f = parseFlags(args, values, booleans);
  if (f === undefined) console.error(usage);
  return f;
}

const USAGE = {
  init: "usage: hapi secrets init [--config file] [--file file] [--age-key file] [--name name] [--classic] [--no-confirm]",
  join: "usage: hapi secrets join --store file [--name name] [--config file] [--age-key file]",
  addMachine: "usage: hapi secrets add-machine --name name --recipient age1... [--config file]",
  recover: "usage: hapi secrets recover [--store file] [--name name] [--config file] [--age-key file]",
  drill: "usage: hapi secrets drill [--config file]",
  revoke: "usage: hapi secrets revoke --name name [--config file]",
  newRecovery: "usage: hapi secrets new-recovery [--config file] [--no-confirm]",
  resolve: "usage: hapi secrets resolve [--config file] [--dry-run]",
  check: "usage: hapi secrets check [--config file]",
  edit: "usage: hapi secrets edit [--config file]",
};

/** `hapi secrets init`: see ./init.ts. */
export async function secretsInit(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.init, args, ["--config", "--file", "--age-key", "--name"], ["--classic", "--no-confirm"]);
  if (f === undefined) return 2;
  return initStore(
    { config: str(f["--config"]), file: str(f["--file"]), ageKey: str(f["--age-key"]), name: str(f["--name"]), classic: f["--classic"] === true, noConfirm: f["--no-confirm"] === true },
    deps,
  );
}

/** `hapi secrets join --store <file>`: see `joinMachine`. */
export async function secretsJoin(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.join, args, ["--store", "--name", "--config", "--age-key"]);
  if (f === undefined || f["--store"] === undefined) {
    if (f !== undefined) console.error(USAGE.join);
    return 2;
  }
  return joinMachine({ store: str(f["--store"])!, config: str(f["--config"]), ageKey: str(f["--age-key"]), name: str(f["--name"]) }, deps);
}

/** `hapi secrets add-machine --name <n> --recipient <age1...>`: see `addMachine`. */
export async function secretsAddMachine(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.addMachine, args, ["--name", "--recipient", "--config"]);
  if (f === undefined || f["--name"] === undefined || f["--recipient"] === undefined) {
    if (f !== undefined) console.error(USAGE.addMachine);
    return 2;
  }
  return addMachine({ name: str(f["--name"])!, recipient: str(f["--recipient"])!, config: str(f["--config"]) }, deps);
}

/** `hapi secrets recover`: see `recover`. */
export async function secretsRecover(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.recover, args, ["--store", "--name", "--config", "--age-key"]);
  if (f === undefined) return 2;
  return recover({ store: str(f["--store"]), name: str(f["--name"]), config: str(f["--config"]), ageKey: str(f["--age-key"]) }, deps);
}

/** `hapi secrets drill`: see `drill`. */
export async function secretsDrill(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.drill, args, ["--config"]);
  if (f === undefined) return 2;
  return drill({ config: str(f["--config"]) }, deps);
}

/** `hapi secrets revoke --name <n>`: see `revoke`. */
export async function secretsRevoke(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.revoke, args, ["--name", "--config"]);
  if (f === undefined || f["--name"] === undefined) {
    if (f !== undefined) console.error(USAGE.revoke);
    return 2;
  }
  return revoke({ name: str(f["--name"])!, config: str(f["--config"]) }, deps);
}

/** `hapi secrets new-recovery`: see `newRecovery`. */
export async function secretsNewRecovery(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.newRecovery, args, ["--config"], ["--no-confirm"]);
  if (f === undefined) return 2;
  return newRecovery({ config: str(f["--config"]), noConfirm: f["--no-confirm"] === true }, deps);
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

async function runCheck(config: string | undefined, deps: SecretsDeps): Promise<number> {
  const { manifest, gaps, provider, policyDir, cfg } = prepare(config, deps);
  const { entries, unknown } = await checkSecrets(manifest, provider);
  const line = (status: string, what: string, note = "") => console.log(`${status.padEnd(8)} ${what}${note}`);
  for (const e of entries) line(e.status, entryLabel(e), e.reason === undefined ? "" : `: ${e.reason}`);
  for (const g of gaps) line("missing", `${g.zone}/${g.env}`, ` (${gapReason(g, policyDir)})`);
  for (const n of unknown) line("unknown", n, ` (in the store, not in ${MANIFEST_FILE})`);
  let code = 0;
  if (cfg.provider === "sops") {
    const report = await recipientReport(cfg.sops.file);
    for (const l of report.lines) console.log(l);
    for (const w of report.warnings) console.error(`hapi secrets check: warning: ${w}`);
    for (const e of report.errors) console.error(`hapi secrets check: ${e}`);
    if (report.errors.length > 0) code = 1;
  }
  const bad = [...entries.filter((e) => e.status !== "found").map((e) => `${e.zone}/${e.key}`), ...gaps.map((g) => `${g.zone}/${g.env}`)];
  if (bad.length === 0) return code;
  const fix = { sops: "Fill them in with `mise run secrets:edit`", bws: "Add or fill them in Bitwarden, with each id under bws.ids in your secrets config", "env-file": "Add or fill them in your env file" }[provider.name];
  console.error(`hapi secrets check: ${bad.length} of ${entries.length + gaps.length} secrets are missing or empty: ${bad.join(", ")}. ${fix} (docs/secrets.md).`);
  return 1;
}

/**
 * `hapi secrets check [--config file]`: print `found`, `missing`, `empty` or
 * `invalid` for every env var of the manifest, `missing` for an MCP reference
 * the manifest doesn't map, and `unknown` for each store name the manifest
 * doesn't list. Never a value. For sops, also the store's recipients (names,
 * kinds, PQ): drift or a PQ/classic mix is an error, and no recovery
 * recipient or no recovery.age a warning. Exits 1 if anything is missing,
 * empty or invalid, or on a recipient error. It writes nothing, so it needs
 * no XDG_RUNTIME_DIR.
 */
export async function secretsCheck(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.check, args, ["--config"]);
  if (f === undefined) return 2;
  return runCheck(str(f["--config"]), deps);
}

/**
 * `hapi secrets resolve [--config file] [--dry-run]`: resolve the manifest
 * from the configured provider into `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`
 * and print each path. Any failure throws, naming the secret; nothing is
 * written. `--dry-run` is `hapi secrets check`.
 */
export async function secretsResolve(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.resolve, args, ["--config"], ["--dry-run"]);
  if (f === undefined) return 2;
  if (f["--dry-run"] === true) return runCheck(str(f["--config"]), deps);
  const env = deps.env ?? process.env;
  const outDir = runtimeDir(env);
  const { manifest, gaps, provider, policyDir } = prepare(str(f["--config"]), deps);
  const gap = gaps[0];
  if (gap !== undefined) throw new SecretError(`${gap.zone}/${gap.env}: ${gapReason(gap, policyDir)}`);
  const paths = await resolveSecrets(manifest, provider, { outDir });
  for (const path of Object.values(paths).sort()) console.log(path);
  return 0;
}

/**
 * `hapi secrets edit [--config file]`: sops only. Under the store's lock
 * (`withStoreLock`, as the lifecycle commands; Ctrl-C while sops runs is the
 * editor's, so hapi ignores it until sops ends), it first runs the store
 * checks every lifecycle command runs (`loadStore`: the file's shape, age
 * recipients and nothing else, and the recipients file in step with it), so
 * new values are never written into a store that a key outside the
 * recipients file could open. Then it checks the age key, and runs `sops
 * edit` on the configured file with stdio inherited. sops decrypts into a
 * temp file for the editor, so TMPDIR is `$XDG_RUNTIME_DIR/hapi` (the user's
 * tmpfs): the plaintext never lands on a disk. The editor gets the caller's
 * env minus every SOPS_* variable, plus SOPS_AGE_KEY_FILE,
 * SOPS_DISABLE_VERSION_CHECK=1, GPG_AGENT_INFO= and the pinned age first on
 * PATH. sops's exit 200 (file unchanged) counts as success.
 */
export async function secretsEdit(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const f = flagsOr(USAGE.edit, args, ["--config"]);
  if (f === undefined) return 2;
  const env = deps.env ?? process.env;
  const cfg = loadSecretsConfig(configPath({ config: str(f["--config"]), env, ...(deps.cwd ? { cwd: deps.cwd } : {}) }), env);
  if (cfg.provider !== "sops") {
    throw new SecretError(`hapi secrets edit works with the sops provider only; ${cfg.path} selects ${cfg.provider}. Edit that store with its own tools (docs/secrets.md)`);
  }
  const tmp = runtimeDir(env);
  const file = cfg.sops.file;
  const uid = deps.uid === undefined ? {} : { uid: deps.uid };
  return withStoreLock(
    file,
    "edit",
    async () => {
      await loadStore(file);
      await secureDir(tmp, dirname(tmp), uid);
      const { dir } = await toolsFor(deps);
      const inv = sopsEditInvocation({ file, ageKeyFile: cfg.sops.age_key_file, env, tmpDir: tmp, ageDir: dir });
      await checkSopsKeys(cfg.sops.age_key_file, inv.env, { repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(), store: file, ...uid });
      // Ctrl-C in the editor is the editor's (it reaches hapi too, in the same foreground group), so hapi ignores it
      // until sops ends, as system(3) does; a SIGTERM or SIGHUP waits until then, so the lock outlives no edit.
      const code = await shielded(() => (deps.interactive ?? runInteractive)("sops", inv.args, { env: inv.env }), { ignoreInterrupt: true, done: "stopped after sops edit ended" });
      if (code === 0 || code === 200) return 0;
      console.error(`hapi secrets edit: sops exited with status ${code}; the file is unchanged unless sops said otherwise`);
      return 1;
    },
    { env, ...uid },
  );
}
