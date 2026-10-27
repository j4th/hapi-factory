/**
 * The secret-store lifecycle (spec §11.5): per-machine keys and the recovery
 * recipient, for the sops + age provider.
 *
 * The pattern (sops's "multiple master keys", age's author, Flux) never backs
 * a key up by copying it. Every store is encrypted to one age key per machine
 * or user, generated where it lives, and one recovery recipient whose identity
 * is wrapped with 10 words in recovery.age (./recovery.ts). The recipients
 * file beside the store names each one (./recipients.ts).
 *
 * - `join`: a new machine or user makes its own key and config, and prints
 *   the `add-machine` command to run where the store already opens.
 * - `add-machine` / `revoke`: add or remove a recipient.
 * - `recover`: a box with the store, recovery.age, the recipients file and
 *   the words, but no key that opens them, adds a key of its own.
 * - `drill`: proves the words and recovery.age open the store.
 * - `new-recovery`: new words, for lost or exposed ones.
 *
 * Every recipient change is `sops --config /dev/null rotate -i --add-age /
 * --rm-age`, which makes a new data key (`updatekeys` doesn't), on a temp copy
 * beside the store. The copy is checked (encrypted, and to exactly the
 * recipients asked for), renamed over the store in one step, and only then is
 * the recipients file rewritten; if that fails, the old store is put back. So
 * a failure leaves both as they were. Before any change, the store and its
 * recipients file must agree (`loadStore`).
 *
 * sops is never given a wrapped identity: it would prompt through gpg-agent
 * or the terminal, and its gpg-agent client ignores GNUPGHOME. hapi unwraps
 * the recovery identity itself and hands it to the one sops child that needs
 * it as SOPS_AGE_KEY. Every sops child gets `GPG_AGENT_INFO=` (`sopsEnv`).
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { PolicyError } from "../policy/load";
import { type CheckoutRoots, checkoutProblem, defaultRepoRoot, ensurePrivateDir, isWithin, realish, runtimeDir, secureDir, writeNewSecretFile, writeSecretFile } from "./files";
import { configHome, configPath, defaultAgeKeyFile, type Env, expandPath, loadSecretsConfig, SecretError } from "./provider";
import {
  ageEnv,
  checkAgeKeyFile,
  checkSopsKeys,
  commandRunner,
  decryptedMap,
  pinnedAgeDir,
  runSops,
  type SopsRunner,
  scrubToolError,
  sopsEnv,
  sopsFileProblem,
} from "./providers/sops";
import {
  loadRecipients,
  machineName,
  RECIPIENT_NAME,
  type RecipientEntry,
  type RecipientsFile,
  recipientProblems,
  recipientsPath,
  recipientsText,
  recipientType,
  recoveryPath,
  shortRecipient,
  storeRecipients,
} from "./recipients";
import { attendedTerminal, generateWords, newIdentity, openTerminal, readRecoveryWords, showAndConfirmWords, type Tty, unwrapIdentity, wrapIdentity } from "./recovery";

/** What the lifecycle commands (and init) can be given instead of the real thing, for tests. */
export interface LifecycleDeps {
  env?: Env;
  cwd?: string;
  uid?: number;
  /** The hapi-factory checkout that keys must stay out of. Default: `defaultRepoRoot`. */
  repoRoot?: () => Promise<CheckoutRoots>;
  sops?: SopsRunner;
  ageKeygen?: SopsRunner;
  age?: SopsRunner;
  /** The pinned age's directory. Default: `pinnedAgeDir`. */
  ageDir?: () => Promise<string>;
  /** The terminal for the recovery words; null when there is none. Default: `openTerminal()`. */
  tty?: Tty | null;
  /** Whether a person may be at the terminal (then --no-confirm is refused). Default: `attendedTerminal()`. */
  attended?: boolean;
  /** This machine's default recipient name. Default: `<hostname>-<user>`, normalised. */
  machineName?: string;
  now?: () => Date;
  manifestFile?: string;
}

/** The age tools, from the pinned age's directory, and sops. */
export interface Tools {
  dir: string;
  age: SopsRunner;
  ageKeygen: SopsRunner;
  sops: SopsRunner;
}

export async function toolsFor(deps: LifecycleDeps): Promise<Tools> {
  const dir = await (deps.ageDir ?? pinnedAgeDir)();
  return { dir, age: deps.age ?? commandRunner(join(dir, "age")), ageKeygen: deps.ageKeygen ?? commandRunner(join(dir, "age-keygen")), sops: deps.sops ?? runSops };
}

export const terminalFor = (deps: LifecycleDeps): Tty | undefined => (deps.tty === undefined ? openTerminal() : (deps.tty ?? undefined));
export const uidOf = (deps: LifecycleDeps) => (deps.uid === undefined ? {} : { uid: deps.uid });
export const today = (deps: LifecycleDeps) => (deps.now?.() ?? new Date()).toISOString().slice(0, 10);

export function defaultMachineName(deps: LifecycleDeps): string {
  if (deps.machineName !== undefined) return deps.machineName;
  let user = (deps.env ?? process.env).USER ?? "";
  if (user === "") {
    try {
      user = userInfo().username;
    } catch {
      user = "user";
    }
  }
  return machineName(hostname(), user);
}

/** Throw unless `name` is a recipient name (and, for a machine, not the reserved `recovery`). */
export function checkName(name: string, flag = "--name", kind: "machine" | "recovery" = "machine"): void {
  if (!RECIPIENT_NAME.test(name)) throw new SecretError(`${flag} must match ${RECIPIENT_NAME.source} (lower-case letters, digits and "-"; not shown, in case it is something else)`);
  if (kind === "machine" && name === "recovery") throw new SecretError(`${flag}: "recovery" is the recovery recipient's name; pick another for a machine`);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Throw if any two of `paths` (label -> path) are the same file, as given or through a symlink. */
export async function refuseCoinciding(paths: [string, string][]): Promise<void> {
  const real = await Promise.all(paths.map(async ([, p]) => [resolve(p), await realish(resolve(p))] as const));
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (real[i]![0] === real[j]![0] || real[i]![1] === real[j]![1]) {
        throw new SecretError(`the ${paths[i]![0]} and the ${paths[j]![0]} are the same file (${real[i]![0]}): give each its own path`);
      }
    }
  }
}

/** Refuse a new file directly in $HOME or the config home (or above): its directory would be made 0700. */
export function refuseSharedDirs(paths: string[], env: Env): void {
  const shared = [env.HOME, configHome(env)].filter((d): d is string => d !== undefined && d !== "").map((d) => resolve(d));
  for (const path of paths) {
    const dir = resolve(dirname(path));
    if (shared.some((d) => isWithin(d, dir))) {
      throw new Error(
        `${path} would sit directly in ${dir}, which hapi would have to make 0700; put it in a directory of its own (the defaults are under ${join(configHome(env), "hapi")} and ${dirname(defaultAgeKeyFile(env))})`,
      );
    }
  }
}

/** The local config text for a sops store and this machine's key. */
export function configText(file: string, ageKey: string, by: string): string {
  return (
    `# hapi's local secrets config, written by \`hapi secrets ${by}\` (docs/secrets.md).\n` +
    "# It picks the secret provider and binds it; it holds no secret.\n" +
    stringify({ provider: "sops", sops: { file, age_key_file: ageKey } })
  );
}

/**
 * New files, written as one step: each with `writeNewSecretFile` (0600, never
 * replacing anything) in a directory made or tightened to 0700. If one fails,
 * the ones already written, and the directories made for them, are removed,
 * and the error ends "; nothing was written".
 */
export async function writeNewFiles(files: [string, string | Uint8Array][], o: { uid?: number } = {}): Promise<void> {
  const written: string[] = [];
  const made: [string, string][] = [];
  try {
    for (const [path, content] of files) {
      const top = await ensurePrivateDir(dirname(path), o);
      if (top !== undefined) made.push([dirname(path), top]);
      try {
        await writeNewSecretFile(path, content);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SecretError(`${path} already exists (it appeared after hapi checked), and hapi never replaces it`);
        throw e;
      }
      written.push(path);
    }
  } catch (e) {
    for (const path of written.reverse()) await rm(path, { force: true });
    for (const [dir, top] of made.reverse()) {
      // Each level hapi made, deepest first, while it is empty.
      for (let d = resolve(dir); isWithin(d, resolve(top)); d = dirname(d)) {
        try {
          await rmdir(d);
        } catch {
          break;
        }
        if (d === resolve(top)) break;
      }
    }
    if (e instanceof Error) e.message = `${e.message}; nothing was written`;
    throw e;
  }
}

/** This machine's age key: an existing file (checked), or a new identity in memory (`text`), to be written with `writeNewFiles`. */
export interface MachineKey {
  path: string;
  recipient: string;
  text?: string;
}

/**
 * This machine's age key at `path`. If the file exists it is reused, once it
 * passes `checkAgeKeyFile` and `age-keygen -y` gives one public key of the
 * store's kind (`mismatch` explains otherwise). If not, a new key is made in
 * memory (`age-keygen -pq`, or classic), never inside the checkout.
 */
export async function machineKey(
  path: string,
  pq: boolean,
  tools: Tools,
  env: Env,
  o: { repoRoot: CheckoutRoots; uid?: number; mismatch: (kind: string) => string },
): Promise<MachineKey> {
  if (await exists(path)) {
    await checkAgeKeyFile(path, o);
    const y = await tools.ageKeygen(["-y", path], { env: ageEnv(env, tools.dir) });
    const lines = y.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    if (y.code !== 0 || lines.length === 0) {
      const why = scrubToolError(y.stderr);
      throw new SecretError(`age-keygen -y could not read a public key from ${path} (exit ${y.code})${why ? `: ${why}` : ""}`);
    }
    if (lines.length !== 1) throw new SecretError(`${path} holds ${lines.length} age keys; hapi expects one, this machine's, per key file`);
    const type = recipientType(lines[0]!);
    if (type !== (pq ? "pq" : "classic")) throw new SecretError(o.mismatch(type === "pq" ? "post-quantum" : type === "classic" ? "classic (X25519)" : "not an X25519 or post-quantum age key"));
    return { path, recipient: lines[0]! };
  }
  const where = await checkoutProblem(path, o.repoRoot);
  if (where !== undefined) throw new SecretError(`age key file ${path} ${where}`);
  const id = await newIdentity(tools.ageKeygen, ageEnv(env, tools.dir), pq);
  return { path, recipient: id.recipient, text: id.text };
}

/** A store and its recipients file, read and checked to agree. */
export interface StoreState {
  file: string;
  text: string;
  recipientsFile: string;
  recipients: RecipientsFile;
  recovery: string;
}

/** Read the store and its recipients file, and throw unless the store is encrypted and the two agree (no drift, no PQ/classic mix). */
export async function loadStore(file: string): Promise<StoreState> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SecretError(`no sops file at ${file}: run \`mise run secrets:init\`, or give the path of your copy of the store`);
    throw new SecretError(`cannot read ${file}${code ? ` (${code})` : ""}`);
  }
  const problem = sopsFileProblem(text);
  if (problem !== undefined) throw new SecretError(`${file} ${problem}`);
  const recipientsFile = recipientsPath(file);
  const recipients = await loadRecipients(recipientsFile);
  const problems = recipientProblems(recipients, storeRecipients(text));
  if (problems.length > 0) {
    throw new SecretError(`${file} and ${recipientsFile} disagree: ${problems.join("; ")}. Restore both from the same commit (private/'s history, say) and run it again (docs/secrets.md#keys-and-recovery)`);
  }
  return { file, text, recipientsFile, recipients, recovery: recoveryPath(file) };
}

/** The local config, which must select sops. */
export function sopsConfigFor(config: string | undefined, deps: LifecycleDeps, what: string) {
  const env = deps.env ?? process.env;
  const cfg = loadSecretsConfig(configPath({ config, env, ...(deps.cwd ? { cwd: deps.cwd } : {}) }), env);
  if (cfg.provider !== "sops") throw new SecretError(`hapi secrets ${what} works with the sops provider only; ${cfg.path} selects ${cfg.provider} (docs/secrets.md)`);
  return cfg;
}

const ROTATE = ["--config", "/dev/null", "rotate", "-i", "--input-type", "yaml", "--output-type", "yaml"];

/**
 * Change the store's recipients on a temp copy beside it, one `sops rotate -i`
 * per step (each makes a new data key), with `key` to decrypt. Then check the
 * copy: encrypted, and to exactly the recipients asked for. Resolves to the
 * copy's path and text; on any failure the copy is removed and nothing has
 * changed.
 */
async function rotate(state: StoreState, steps: ({ add: string } | { rm: string })[], key: { file: string } | { identity: string }, tools: Tools, env: Env) {
  const tmp = join(dirname(state.file), `.${basename(state.file)}.${randomUUID()}.tmp`);
  await writeNewSecretFile(tmp, state.text);
  try {
    const childEnv = sopsEnv(env, tools.dir, key);
    let expected = storeRecipients(state.text);
    for (const step of steps) {
      const flag = "add" in step ? ["--add-age", step.add] : ["--rm-age", step.rm];
      const r = await tools.sops([...ROTATE, ...flag, tmp], { env: childEnv });
      if (r.code !== 0) {
        const why = scrubToolError(r.stderr);
        throw new SecretError(`sops could not change the recipients of ${state.file} (exit ${r.code})${why ? `: ${why}` : ""}; nothing was changed`);
      }
      expected = "add" in step ? [...expected, step.add] : expected.filter((x) => x !== step.rm);
    }
    const text = await readFile(tmp, "utf8");
    const problem = sopsFileProblem(text);
    if (problem !== undefined) throw new SecretError(`sops's result ${problem}; nothing was changed`);
    const got = storeRecipients(text);
    if (got.length !== expected.length || !expected.every((r) => got.includes(r))) {
      throw new SecretError(`sops's result for ${state.file} is not encrypted to exactly the recipients asked for; nothing was changed`);
    }
    return { tmp, text };
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/**
 * Put a rotated store in place and the recipients file in step with it: the
 * new recovery.age first, if there is one (backing up the old in memory), then
 * the store (one rename), then the recipients file. If a step fails, the
 * earlier ones are undone.
 */
async function commit(state: StoreState, rotated: { tmp: string }, next: RecipientsFile, recovery?: string): Promise<void> {
  let oldRecovery: Buffer | undefined;
  let recoveryWritten = false;
  let storeReplaced = false;
  try {
    if (recovery !== undefined) {
      oldRecovery = (await exists(state.recovery)) ? await readFile(state.recovery) : undefined;
      await writeSecretFile(state.recovery, recovery);
      recoveryWritten = true;
    }
    await rename(rotated.tmp, state.file);
    storeReplaced = true;
    await writeSecretFile(state.recipientsFile, recipientsText(next, state.file));
  } catch (e) {
    if (storeReplaced) await writeSecretFile(state.file, state.text);
    else await rm(rotated.tmp, { force: true });
    if (recoveryWritten) {
      if (oldRecovery === undefined) await rm(state.recovery, { force: true });
      else await writeSecretFile(state.recovery, oldRecovery);
    }
    throw e;
  }
}

const entry = (name: string, kind: RecipientEntry["kind"], recipient: string, deps: LifecycleDeps): RecipientEntry => ({ name, kind, recipient, added: today(deps) });
const storeKind = (pq: boolean) => (pq ? "post-quantum" : "classic");
const recipientCount = (n: number) => `${n} recipient${n === 1 ? "" : "s"}`;

/** recovery.age's bytes, or a SecretError saying where it should be. */
async function readRecovery(state: StoreState): Promise<Buffer> {
  try {
    return await readFile(state.recovery);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SecretError(`there is no recovery.age at ${state.recovery}: the words can't open the store without it. Restore it from a backup of ${dirname(state.recovery)} (private/'s history, say)`);
    }
    throw e;
  }
}

/** The store's one recovery recipient. */
function recoveryEntry(state: StoreState): RecipientEntry {
  const all = state.recipients.recipients.filter((r) => r.kind === "recovery");
  if (all.length === 0) throw new SecretError(`${state.file} has no recovery recipient (${state.recipientsFile}), so no words can open it: run \`hapi secrets new-recovery\` on a machine whose key does`);
  if (all.length > 1) throw new SecretError(`${state.recipientsFile} lists ${all.length} recovery recipients; hapi expects one: revoke the extra ones by name`);
  return all[0]!;
}

/**
 * `hapi secrets join --store <file>`: for a new machine or user, with a copy
 * of the store (and its recipients file and recovery.age beside it). Makes
 * this machine's key (or reuses one) and its config, never overwriting
 * either, and prints the `add-machine` command to run where the store already
 * opens. It doesn't touch the store.
 */
export async function joinMachine(o: { store: string; config?: string | undefined; ageKey?: string | undefined; name?: string | undefined }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const config = configPath({ config: o.config, env, cwd });
  const store = expandPath(o.store, env, cwd);
  const ageKey = o.ageKey === undefined ? defaultAgeKeyFile(env) : expandPath(o.ageKey, env, cwd);
  await refuseCoinciding([["config", config], ["store", store], ["age key", ageKey], ["recovery.age", recoveryPath(store)], ["recipients file", recipientsPath(store)]]);
  if (await exists(config)) throw new SecretError(`${config} already exists, and hapi secrets join never overwrites anything: this machine is set up (run \`hapi secrets check\`)`);
  const name = o.name ?? defaultMachineName(deps);
  checkName(name);
  const state = await loadStore(store);
  const newKey = !(await exists(ageKey));
  refuseSharedDirs(newKey ? [config, ageKey] : [config], env);
  const tools = await toolsFor(deps);
  const pq = state.recipients.pq;
  const key = await machineKey(ageKey, pq, tools, env, {
    repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(),
    ...uidOf(deps),
    mismatch: (kind) => `the age key ${ageKey} is ${kind}, and this store is ${storeKind(pq)}: hapi won't mix them. Give --age-key a new path for a new ${storeKind(pq)} key (docs/secrets.md#post-quantum-by-default)`,
  });
  const listed = state.recipients.recipients.find((r) => r.recipient === key.recipient);
  if (listed === undefined && state.recipients.recipients.some((r) => r.name === name)) throw new SecretError(`${name} is already a recipient of ${store}: pick another --name`);
  await writeNewFiles([...(key.text === undefined ? [] : [[ageKey, key.text] as [string, string]]), [config, configText(store, ageKey, "join")]], uidOf(deps));
  console.log(`${key.text === undefined ? "using" : "created"} the age key ${ageKey}`);
  console.log(`wrote ${config} (provider: sops, store ${store})`);
  if (listed !== undefined) {
    console.log(`this key is already a recipient of the store, as ${listed.name}: nothing to add. Next: mise run secrets:check`);
    return 0;
  }
  console.log(`this machine's public key (${name}): ${key.recipient}`);
  console.log("next, on a machine whose key already opens the store, run:");
  console.log(`  mise run secrets:add-machine -- --name ${name} --recipient ${key.recipient}`);
  console.log(`then bring the updated ${basename(store)} and ${basename(recipientsPath(store))} here (commit and pull private/, or copy both), and run mise run secrets:check`);
  return 0;
}

/** `hapi secrets add-machine --name <n> --recipient <age1...>`: add a machine's public key to the store, with a new data key. */
export async function addMachine(o: { config?: string | undefined; name: string; recipient: string }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  checkName(o.name);
  const type = recipientType(o.recipient);
  if (type === undefined) throw new SecretError("--recipient is not an age public key (age1pq1... or age1..., as `hapi secrets join` prints it)");
  const cfg = sopsConfigFor(o.config, deps, "add-machine");
  const state = await loadStore(cfg.sops.file);
  const pq = state.recipients.pq;
  if (type !== (pq ? "pq" : "classic")) {
    throw new SecretError(`--recipient is ${type === "pq" ? "post-quantum" : "classic (X25519)"}, and this store is ${storeKind(pq)}: hapi won't mix them (docs/secrets.md#post-quantum-by-default)`);
  }
  if (state.recipients.recipients.some((r) => r.name === o.name)) throw new SecretError(`${o.name} is already a recipient of ${state.file}: pick another --name`);
  const same = state.recipients.recipients.find((r) => r.recipient === o.recipient);
  if (same !== undefined) throw new SecretError(`that recipient is already in the store, as ${same.name}`);
  const tools = await toolsFor(deps);
  const key = cfg.sops.age_key_file;
  await checkSopsKeys(key, sopsEnv(env, tools.dir, { file: key }), { repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(), ...uidOf(deps) });
  const rotated = await rotate(state, [{ add: o.recipient }], { file: key }, tools, env);
  const next = { ...state.recipients, recipients: [...state.recipients.recipients, entry(o.name, "machine", o.recipient, deps)] };
  await commit(state, rotated, next);
  console.log(`added ${o.name} (${shortRecipient(o.recipient)}): ${state.file} has a new data key and is encrypted to ${recipientCount(next.recipients.length)}`);
  console.log(`next: bring ${basename(state.file)} and ${basename(state.recipientsFile)} to ${o.name} (commit and push private/, then pull it there), and run mise run secrets:check on it`);
  return 0;
}

/**
 * `hapi secrets recover [--store <file>]`: for a box that has the store,
 * recovery.age and the recipients file, but no key that opens them. It joins
 * (this machine's key and config), reads the words, unwraps the recovery
 * identity in memory, and adds this machine's key with that identity as
 * SOPS_AGE_KEY in the one sops child. Then the machine works without the words.
 */
export async function recover(o: { store?: string | undefined; config?: string | undefined; ageKey?: string | undefined; name?: string | undefined }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const configFile = configPath({ config: o.config, env, cwd });
  const haveConfig = await exists(configFile);
  let store: string;
  let ageKey: string;
  if (haveConfig) {
    const cfg = sopsConfigFor(o.config, deps, "recover");
    store = cfg.sops.file;
    ageKey = cfg.sops.age_key_file;
    if (o.store !== undefined && resolve(expandPath(o.store, env, cwd)) !== resolve(store)) throw new SecretError(`--store isn't the store ${configFile} names (${store}); drop --store, or use another --config`);
    if (o.ageKey !== undefined && resolve(expandPath(o.ageKey, env, cwd)) !== resolve(ageKey)) throw new SecretError(`--age-key isn't the key ${configFile} names (${ageKey}); drop --age-key, or use another --config`);
  } else {
    if (o.store === undefined) throw new SecretError(`no secrets config at ${configFile}: pass --store <your copy of the store>`);
    store = expandPath(o.store, env, cwd);
    ageKey = o.ageKey === undefined ? defaultAgeKeyFile(env) : expandPath(o.ageKey, env, cwd);
  }
  await refuseCoinciding([["config", configFile], ["store", store], ["age key", ageKey], ["recovery.age", recoveryPath(store)], ["recipients file", recipientsPath(store)]]);
  const name = o.name ?? defaultMachineName(deps);
  checkName(name);
  const state = await loadStore(store);
  const rec = recoveryEntry(state);
  const tty = terminalFor(deps);
  if (tty === undefined) throw new SecretError("hapi secrets recover needs a terminal to read the recovery words");
  const newKey = !(await exists(ageKey));
  refuseSharedDirs([...(haveConfig ? [] : [configFile]), ...(newKey ? [ageKey] : [])], env);
  const tools = await toolsFor(deps);
  const repoRoot = await (deps.repoRoot ?? defaultRepoRoot)();
  const pq = state.recipients.pq;
  const key = await machineKey(ageKey, pq, tools, env, {
    repoRoot,
    ...uidOf(deps),
    mismatch: (kind) => `the age key ${ageKey} is ${kind}, and this store is ${storeKind(pq)}: hapi won't mix them. Give --age-key a new path`,
  });
  const listed = state.recipients.recipients.find((r) => r.recipient === key.recipient);
  if (listed !== undefined) throw new SecretError(`this machine's key (${ageKey}) already opens ${store}, as ${listed.name}: nothing to recover (run \`hapi secrets check\`)`);
  if (state.recipients.recipients.some((r) => r.name === name)) {
    throw new SecretError(`${name} is already a recipient of ${store} (is its key the lost one?): run recover with another --name, then \`hapi secrets revoke --name ${name}\``);
  }
  // 1. Join: this machine's key and config, before the words, so a retry reuses them.
  await writeNewFiles(
    [...(key.text === undefined ? [] : [[ageKey, key.text] as [string, string]]), ...(haveConfig ? [] : [[configFile, configText(store, ageKey, "recover")] as [string, string]])],
    uidOf(deps),
  );
  // 2. The words, and the recovery identity, in memory.
  const wrapped = await readRecovery(state);
  const words = await readRecoveryWords(tty);
  const identity = await unwrapIdentity(tools, ageEnv(env, tools.dir), wrapped, words, { file: state.recovery, recipient: rec.recipient });
  // 3. Add this machine, with the recovery identity in that one sops child's env.
  await checkSopsKeys(ageKey, sopsEnv(env, tools.dir, { file: ageKey }), { repoRoot, ...uidOf(deps) });
  const rotated = await rotate(state, [{ add: key.recipient }], { identity }, tools, env);
  await commit(state, rotated, { ...state.recipients, recipients: [...state.recipients.recipients, entry(name, "machine", key.recipient, deps)] });
  console.log(`recovered: ${name} can open the store now, without the words (${state.file} has a new data key)`);
  console.log("next: mise run secrets:check; then `mise run secrets:revoke -- --name <machine>` for any machine whose key is lost or may be compromised");
  return 0;
}

/**
 * `hapi secrets drill`: proves the backup works. It unwraps the recovery
 * identity with the words, then decrypts the store in a sops child whose HOME
 * and XDG_CONFIG_HOME are a fresh temp dir under $XDG_RUNTIME_DIR/hapi/ (so
 * no machine key can load) and whose only identity is SOPS_AGE_KEY. It prints
 * how many names it read, never a value, deletes the temp dir, and writes
 * nothing else.
 */
export async function drill(o: { config?: string | undefined }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cfg = sopsConfigFor(o.config, deps, "drill");
  const state = await loadStore(cfg.sops.file);
  const rec = recoveryEntry(state);
  const tty = terminalFor(deps);
  if (tty === undefined) throw new SecretError("hapi secrets drill needs a terminal to read the recovery words");
  const rt = runtimeDir(env);
  await secureDir(rt, dirname(rt), uidOf(deps));
  const tools = await toolsFor(deps);
  const wrapped = await readRecovery(state);
  const words = await readRecoveryWords(tty);
  const identity = await unwrapIdentity(tools, ageEnv(env, tools.dir), wrapped, words, { file: state.recovery, recipient: rec.recipient });
  const tmp = await mkdtemp(join(rt, "drill-"));
  try {
    const childEnv = { ...sopsEnv({ PATH: env.PATH, HOME: tmp }, tools.dir, { identity }), XDG_CONFIG_HOME: tmp };
    const r = await tools.sops(["--config", "/dev/null", "decrypt", "--input-type", "yaml", "--output-type", "json", state.file], { env: childEnv });
    if (r.code !== 0) {
      const why = scrubToolError(r.stderr);
      throw new SecretError(`the recovery key could not decrypt ${state.file} (exit ${r.code})${why ? `: ${why}` : ""}`);
    }
    console.log(`recovery works: ${decryptedMap(r.stdout, state.file).size} names readable`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return 0;
}

const COMPROMISED =
  "if this key may be compromised, also reissue every credential in the store: copies of the store in git history stay readable by the removed key forever";

/** `hapi secrets revoke --name <n>`: remove a recipient, with a new data key. Refuses the last machine key and the only recovery recipient. */
export async function revoke(o: { config?: string | undefined; name: string }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  checkName(o.name, "--name", "recovery");
  const cfg = sopsConfigFor(o.config, deps, "revoke");
  const state = await loadStore(cfg.sops.file);
  const all = state.recipients.recipients;
  const target = all.find((r) => r.name === o.name);
  if (target === undefined) throw new SecretError(`no recipient named ${o.name} in ${state.recipientsFile} (the names: ${all.map((r) => r.name).join(", ")})`);
  if (all.filter((r) => r.kind === target.kind).length === 1) {
    throw new SecretError(
      target.kind === "machine"
        ? `${o.name} is the last machine key: add another first (join, then add-machine), or no machine could open the store`
        : `${o.name} is the only recovery recipient: use \`hapi secrets new-recovery\` to replace it`,
    );
  }
  const tools = await toolsFor(deps);
  const key = cfg.sops.age_key_file;
  await checkSopsKeys(key, sopsEnv(env, tools.dir, { file: key }), { repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(), ...uidOf(deps) });
  const own = await tools.ageKeygen(["-y", key], { env: ageEnv(env, tools.dir) });
  const rotated = await rotate(state, [{ rm: target.recipient }], { file: key }, tools, env);
  const next = { ...state.recipients, recipients: all.filter((r) => r !== target) };
  await commit(state, rotated, next);
  console.log(`removed ${o.name} (${shortRecipient(target.recipient)}): ${state.file} has a new data key and is encrypted to ${recipientCount(next.recipients.length)}`);
  if (own.code === 0 && own.stdout.split("\n").map((l) => l.trim()).includes(target.recipient)) {
    console.log("that was this machine's own key: this machine can no longer open the store");
  }
  console.log(COMPROMISED);
  return 0;
}

/**
 * `hapi secrets new-recovery`: new words, for lost or exposed ones. It needs
 * a working machine key. A new recovery identity and words, shown and
 * confirmed as in init; then the new recipient is added and the old removed
 * (`rotate`), and recovery.age replaced: the one deliberate replace, with the
 * old file kept in memory and put back if a step fails.
 */
export async function newRecovery(o: { config?: string | undefined; noConfirm: boolean }, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cfg = sopsConfigFor(o.config, deps, "new-recovery");
  if (o.noConfirm && (deps.attended ?? attendedTerminal())) throw new SecretError("--no-confirm is for tests and CI fixtures only, and a person is at this terminal: run it without, and confirm the words");
  const state = await loadStore(cfg.sops.file);
  const tty = terminalFor(deps);
  if (tty === undefined && !o.noConfirm) throw new SecretError("hapi secrets new-recovery needs a terminal to show the new recovery words and check you kept them");
  const tools = await toolsFor(deps);
  const key = cfg.sops.age_key_file;
  await checkSopsKeys(key, sopsEnv(env, tools.dir, { file: key }), { repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(), ...uidOf(deps) });
  const pq = state.recipients.pq;
  const id = await newIdentity(tools.ageKeygen, ageEnv(env, tools.dir), pq);
  const words = generateWords();
  if (tty !== undefined) await showAndConfirmWords(words, tty, { confirm: !o.noConfirm });
  else console.error("hapi secrets new-recovery: warning: no terminal, so the new recovery words were not shown: this store's recovery.age can't be opened");
  const wrapped = await wrapIdentity(tools.age, ageEnv(env, tools.dir), id.text, words);
  const old = state.recipients.recipients.filter((r) => r.kind === "recovery");
  const rotated = await rotate(state, [{ add: id.recipient }, ...old.map((r) => ({ rm: r.recipient }))], { file: key }, tools, env);
  const next = { ...state.recipients, recipients: [...state.recipients.recipients.filter((r) => r.kind !== "recovery"), entry("recovery", "recovery", id.recipient, deps)] };
  await commit(state, rotated, next, wrapped);
  console.log(`new recovery words are in place: ${state.recovery} and the recovery recipient are replaced, and ${state.file} has a new data key`);
  if (old.length > 0) {
    console.log(
      "the old words no longer open this store, but old copies of the store and of recovery.age (in private/'s git history, say) still open with them: if the old words may be exposed, also reissue every credential in the store",
    );
  }
  console.log("next: mise run secrets:drill, with the new words");
  return 0;
}

/**
 * For `hapi secrets check`: the recipients (names, kinds, PQ) as lines, the
 * errors (no or a bad recipients file, drift, a PQ/classic mix) and the
 * warnings (no recovery recipient, no recovery.age).
 */
export async function recipientReport(file: string): Promise<{ lines: string[]; errors: string[]; warnings: string[] }> {
  const out = { lines: [] as string[], errors: [] as string[], warnings: [] as string[] };
  let recipients: RecipientsFile;
  try {
    recipients = await loadRecipients(recipientsPath(file));
  } catch (e) {
    if (e instanceof SecretError || e instanceof PolicyError) {
      out.errors.push(e.message);
      return out;
    }
    throw e;
  }
  const kind = recipients.pq ? "post-quantum" : "classic";
  out.lines = recipients.recipients.map((r) => `recipient ${r.kind.padEnd(8)} ${r.name} (${kind}, added ${r.added})`);
  out.errors = recipientProblems(recipients, storeRecipients(await readFile(file, "utf8")));
  if (!recipients.recipients.some((r) => r.kind === "recovery")) {
    out.warnings.push("the store has no recovery recipient: if every machine key is lost, so is the store. Run `mise run secrets:new-recovery` (docs/secrets.md#keys-and-recovery)");
  } else if (!(await exists(recoveryPath(file)))) {
    out.warnings.push(
      `there is no recovery.age at ${recoveryPath(file)}: the 10 words can't open the store without it. Restore it from a backup of ${dirname(file)} (private/'s history, say), or run \`mise run secrets:new-recovery\` for new words`,
    );
  }
  return out;
}
