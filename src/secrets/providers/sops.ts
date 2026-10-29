/**
 * The sops + age provider (spec §11.5): the default for everyone.
 *
 * The store is one sops-encrypted YAML file (`secrets.enc.yaml`): a flat map of
 * logical name -> value, every value encrypted to the store's age recipients
 * (one key per machine or user, plus a recovery recipient: ../recipients.ts,
 * ../lifecycle.ts). This machine's key is an age key file, by default sops's
 * own `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`. The encrypted
 * file may live anywhere (private/ included: it is backed up to the private
 * remote there). The key may not: it must be ours, closed to group and other,
 * and outside the hapi-factory checkout, private/ included, because the key
 * and the encrypted file together are the plaintext.
 *
 * The age tools are the mise-pinned age (`resolveAgeDir`), never the age on
 * PATH: the distro age 1.1.1 has no post-quantum keys and no batchpass. Its
 * install dir leads the PATH of every age and sops child (sops runs age
 * plugins from PATH).
 *
 * `fetch`:
 * 1. checks the age key file (`checkAgeKeyFile`: where it is, its mode, that
 *    it isn't the store's recovery.age, and that it holds plain age identities
 *    only), and sops's own default key file under the HOME it gets, if that
 *    exists too: sops 3.13 reads every key source it finds, not only
 *    SOPS_AGE_KEY_FILE (`checkSopsKeys`);
 * 2. parses the raw file and checks its shape before decrypting
 *    (`sopsFileProblem`): a sops block with an age recipient and nothing else
 *    but sops's bookkeeping (any other master key, or a field hapi doesn't
 *    know, could open the store unseen by the recipients file), no setting
 *    that picks which values stay in plaintext but sops's default suffix (one
 *    would let `sops edit` write a new value in plaintext), and every
 *    top-level value encrypted;
 * 3. runs `sops decrypt --output-type json <file>` through a `SopsRunner`,
 *    with the minimal env of `sopsEnv`. `--config /dev/null` keeps any
 *    .sops.yaml out of it. No value goes through argv; stderr is never echoed
 *    raw (`scrubToolError`);
 * 4. checks the JSON is a flat map of name -> string.
 *
 * `list` reads the names from the encrypted file (sops leaves keys in the
 * clear) without decrypting.
 */
import { spawn } from "node:child_process";
import { access, constants, lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { type CheckoutRoots, defaultRepoRoot, privateFileProblem, realish } from "../files";
import { shownName } from "../manifest";
import { type Env, SecretError, type SecretProvider } from "../provider";
import { recoveryPath } from "../recipients";

/**
 * Runs a tool with these args and this whole env (nothing inherited). `stdin`
 * is piped in if given (else stdin is closed), and `fd3`, if given, is piped
 * in on file descriptor 3 and closed: that is how a passphrase reaches
 * age-plugin-batchpass (AGE_PASSPHRASE_FD=3), never through argv or env.
 */
export type SopsRunner = (
  args: string[],
  o: { env: Record<string, string>; stdin?: string | Uint8Array; fd3?: string; cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A `SopsRunner` for the binary `cmd` (a path, or a name looked up on the env's PATH). Rejects with a SecretError if it can't start. */
export function commandRunner(cmd: string): SopsRunner {
  return (args, o) =>
    new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, {
        env: o.env,
        ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
        stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(o.fd3 === undefined ? [] : ["pipe" as const])],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      child.stdout!.on("data", (d: Buffer) => out.push(d));
      child.stderr!.on("data", (d: Buffer) => err.push(d));
      child.on("error", () => {
        if (settled) return;
        settled = true;
        reject(new SecretError(`cannot run ${cmd}: is it on PATH? (\`mise install\` provides it)`));
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        resolvePromise({ code: code ?? 128, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
      });
      // A child that exits without reading its input gets EPIPE here: its exit code tells the story.
      if (o.stdin !== undefined) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(o.stdin);
      }
      if (o.fd3 !== undefined) {
        const fd3 = child.stdio[3] as NodeJS.WritableStream & { on(e: "error", f: () => void): void };
        fd3.on("error", () => {});
        fd3.end(o.fd3);
      }
    });
}

/** The pinned `sops` on PATH. */
export const runSops: SopsRunner = commandRunner("sops");

/**
 * The first non-blank line of a tool's stderr, safe to show: ANSI codes
 * stripped, and after each `:` only a segment that is a path is kept (a parse
 * error can quote the file's text). At most 300 characters.
 */
export function scrubToolError(stderr: string): string {
  const first = stderr
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (first === undefined) return "";
  const [head, ...rest] = first.split(":");
  const kept = [head!.trim(), ...rest.map((s) => s.trim()).filter((s) => /^\/\S*$/.test(s))];
  const line = kept.join(": ").replace(/\s+/g, " ");
  return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

/** The age version mise.toml pins. The age tools must be at least this (a test keeps the two in step). */
export const AGE_MIN_VERSION = "1.3.2";

const versionParts = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())?.slice(1).map(Number);

/** Whether `version` (as `age --version` prints it, `v1.3.2`) is at least `min`. */
function atLeast(version: string, min: string): boolean {
  const have = versionParts(version);
  const need = versionParts(min)!;
  if (have === undefined) return false;
  for (let i = 0; i < 3; i++) if (have[i]! !== need[i]!) return have[i]! > need[i]!;
  return true;
}

const AGE_BINARIES = ["age", "age-keygen", "age-plugin-batchpass"];

/** `mise where age`, run from the checkout with the caller's environment (mise needs its own config and data dirs). */
async function miseWhereAge(): Promise<string> {
  const cwd = (await defaultRepoRoot())[0]!;
  let r: { code: number; stdout: string; stderr: string };
  try {
    r = await commandRunner("mise")(["where", "age"], { cwd, env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)) });
  } catch {
    throw new SecretError("cannot run mise, which pins the age hapi uses: install mise, then `mise install` (README.md)");
  }
  if (r.code !== 0) {
    const why = scrubToolError(r.stderr);
    throw new SecretError(`\`mise where age\` failed (exit ${r.code})${why ? `: ${why}` : ""}: run \`mise install\` in the hapi-factory checkout`);
  }
  return r.stdout;
}

async function ageVersion(ageBin: string): Promise<string> {
  const r = await commandRunner(ageBin)(["--version"], { env: {} });
  return r.code === 0 ? r.stdout : "";
}

/**
 * The directory holding the mise-pinned age, age-keygen and
 * age-plugin-batchpass: `mise where age` (an install dir, with the binaries in
 * it or in its `age/` or `bin/`), checked with `age --version` against
 * `AGE_MIN_VERSION`. The age on PATH is never used: the distro age 1.1.1 has
 * no post-quantum keys and no batchpass. Throws a SecretError naming the fix.
 */
export async function resolveAgeDir(o: { where?: () => Promise<string>; version?: (ageBin: string) => Promise<string> } = {}): Promise<string> {
  const where = (await (o.where ?? miseWhereAge)()).trim();
  if (!isAbsolute(where)) throw new SecretError(`\`mise where age\` gave no install directory: run \`mise install\` in the hapi-factory checkout`);
  let dir: string | undefined;
  for (const candidate of [where, join(where, "age"), join(where, "bin")]) {
    const found = await Promise.all(AGE_BINARIES.map((b) => access(join(candidate, b), constants.X_OK).then(() => true, () => false)));
    if (found.every(Boolean)) {
      dir = candidate;
      break;
    }
  }
  if (dir === undefined) throw new SecretError(`no age, age-keygen and age-plugin-batchpass under ${where} (mise's age install): run \`mise install\``);
  const version = (await (o.version ?? ageVersion)(join(dir, "age"))).trim();
  if (!atLeast(version, AGE_MIN_VERSION)) {
    throw new SecretError(`the age in ${dir} (${version || "no version"}) is not age ${AGE_MIN_VERSION} or later, which hapi needs for post-quantum keys and batchpass: run \`mise install\``);
  }
  return dir;
}

let ageDirCache: Promise<string> | undefined;

/** `resolveAgeDir()`, worked out once per process. */
export function pinnedAgeDir(): Promise<string> {
  ageDirCache ??= resolveAgeDir();
  ageDirCache.catch(() => {
    ageDirCache = undefined;
  });
  return ageDirCache;
}

/** PATH with the pinned age's directory first. */
function agePath(env: Env, ageDir: string): string {
  return env.PATH ? `${ageDir}:${env.PATH}` : ageDir;
}

/** An age or age-keygen child's environment: PATH (the pinned age first) and HOME from `env`. Nothing else. */
export function ageEnv(env: Env, ageDir: string): Record<string, string> {
  const out: Record<string, string> = { PATH: agePath(env, ageDir) };
  if (env.HOME) out.HOME = env.HOME;
  return out;
}

/**
 * sops's environment: PATH (the pinned age first) and HOME from `env`, the
 * identity sops may use, the version check off (sops phones home otherwise)
 * and `GPG_AGENT_INFO=` (empty), so sops never dials a gpg-agent: its client
 * ignores GNUPGHOME and HOME. Nothing else of `env` reaches sops.
 * - `{ file }`: this machine's age key file, as SOPS_AGE_KEY_FILE;
 * - `{ identity }`: an identity held in memory (the unwrapped recovery key),
 *   as SOPS_AGE_KEY, for that one child only;
 * - `{}`: no identity (encrypting needs none).
 */
export function sopsEnv(env: Env, ageDir: string, key: { file: string } | { identity: string } | Record<string, never> = {}): Record<string, string> {
  const out: Record<string, string> = { PATH: agePath(env, ageDir) };
  if (env.HOME) out.HOME = env.HOME;
  if ("file" in key) out.SOPS_AGE_KEY_FILE = key.file;
  if ("identity" in key) out.SOPS_AGE_KEY = key.identity;
  out.SOPS_DISABLE_VERSION_CHECK = "1";
  out.GPG_AGENT_INFO = "";
  return out;
}

const ENCRYPTED = /^ENC\[AES256_GCM,/;
const AGE_RECIPIENT = /^age1[0-9a-z]+$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * The sops whose metadata fields hapi knows: the version mise.toml pins (a
 * test keeps the two in step). A new sops may add a field, so bumping it
 * means checking `OTHER_MASTER_KEYS`, `SOPS_BOOKKEEPING` and
 * `ENCRYPTION_SETTINGS` against its metadata struct again.
 */
export const SOPS_METADATA_VERSION = "3.13.3";

/**
 * The master-key lists sops 3.13.3's metadata can hold besides `age` (its
 * `mapstructure` tags), each as a message names it. A key in any of them opens
 * the store as well as an age recipient does, and `sops rotate --add-age` /
 * `--rm-age` keep it, so hapi's store has none: its decryptors are its age
 * recipients, each named in the recipients file (../recipients.ts). A Map, so
 * a field named `constructor` or `__proto__` is just an unknown field.
 */
const OTHER_MASTER_KEYS = new Map<string, string>([
  ["pgp", "a PGP key"],
  ["kms", "an AWS KMS key"],
  ["gcp_kms", "a GCP KMS key"],
  ["azure_kv", "an Azure Key Vault key"],
  ["hc_vault", "a HashiCorp Vault transit key"],
  ["hckms", "a HuaweiCloud KMS key"],
  ["key_groups", "sops key groups"],
]);
/**
 * sops 3.13.3's bookkeeping, scalars that hold no key: the last-modified
 * time, the MAC, the version and the Shamir threshold.
 */
const SOPS_BOOKKEEPING = new Set(["lastmodified", "mac", "version", "shamir_threshold"]);
const unset = (v: unknown) => v === null || v === undefined || v === "";
/**
 * The rest of sops 3.13.3's metadata struct: the settings that pick which
 * values sops leaves in plaintext, and what its MAC covers, each with the
 * values hapi's store may have. That is none of them set but sops's default
 * `unencrypted_suffix: _unencrypted`, which `sops encrypt` writes. Any other
 * lets `sops edit` write a value still "", or a name not added yet, in
 * plaintext, and the MAC still verifies ("" is the same either way).
 */
const ENCRYPTION_SETTINGS = new Map<string, (v: unknown) => boolean>([
  ["unencrypted_suffix", (v) => unset(v) || v === "_unencrypted"],
  ["encrypted_suffix", unset],
  ["unencrypted_regex", unset],
  ["encrypted_regex", unset],
  ["unencrypted_comment_regex", unset],
  ["encrypted_comment_regex", unset],
  ["mac_only_encrypted", (v) => v === null || v === undefined || v === false],
]);
const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0);
/** A metadata field's name as a message shows it: `sops.<field>` if it is a plain identifier, else masked. */
const shownField = (field: string) => (/^[a-z][a-z0-9_]{0,39}$/.test(field) ? `sops.${field}` : "name not shown");

/**
 * Everything in a sops block besides its age recipients and sops's
 * bookkeeping, as a message names it: each non-empty list `OTHER_MASTER_KEYS`
 * names, and every field sops 3.13.3 doesn't write, whatever its value (a
 * newer sops's key type would be one), so this fails closed. Never quotes a
 * key's identifier or a value.
 */
function otherMasterKeys(meta: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [field, value] of Object.entries(meta)) {
    if (field === "age" || SOPS_BOOKKEEPING.has(field) || ENCRYPTION_SETTINGS.has(field)) continue;
    const kind = OTHER_MASTER_KEYS.get(field);
    if (kind === undefined) found.push(`a field hapi doesn't know (${shownField(field)}: it may hold a key)`);
    else if (!isEmpty(value)) found.push(`${kind} (sops.${field})`);
  }
  return found;
}

/** Each of `ENCRYPTION_SETTINGS` the sops block sets to a value hapi's store may not have, as `sops.<field>`. Never its value. */
function encryptionSettings(meta: Record<string, unknown>): string[] {
  return [...ENCRYPTION_SETTINGS].filter(([field, allowed]) => Object.hasOwn(meta, field) && !allowed(meta[field])).map(([field]) => `sops.${field}`);
}

/**
 * Why the raw text of a sops file is not a usable encrypted store, or
 * undefined: it must be a YAML mapping with a `sops` block that lists at least
 * one age recipient and nothing else but sops's bookkeeping (`otherMasterKeys`:
 * a PGP, cloud KMS or Vault key, or key groups, would open the store without
 * being in its recipients file, and so might a field hapi doesn't know), with
 * no encryption setting but sops's default suffix (`encryptionSettings`), and
 * every other top-level value must be a string sops
 * encrypted (`ENC[AES256_GCM,...`). The one exception is "": sops leaves an
 * empty string as it is (there is nothing to encrypt), and it holds nothing.
 * Never quotes the file.
 */
export function sopsFileProblem(text: string): string | undefined {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return "is not valid YAML (not shown)";
  }
  if (!isRecord(doc)) return "is not a sops-encrypted YAML mapping";
  const meta = doc.sops;
  if (!isRecord(meta)) return "has no sops metadata: it is not encrypted. Encrypt it with sops (docs/secrets.md)";
  const age = meta.age;
  if (!Array.isArray(age) || !age.some((r) => isRecord(r) && typeof r.recipient === "string" && AGE_RECIPIENT.test(r.recipient))) {
    return "has no age recipient in its sops metadata; hapi's sops store is encrypted to an age key (docs/secrets.md)";
  }
  const others = otherMasterKeys(meta);
  if (others.length > 0) {
    return (
      `has ${others.join(" and ")} in its sops metadata, besides its age recipients: hapi's store is encrypted to age recipients only, ` +
      `each named in its recipients file, so any other key could open it unseen (and hapi knows only the metadata fields of sops ${SOPS_METADATA_VERSION}, the pinned sops). ` +
      "Remove it with sops rotate -i (--rm-pgp, --rm-kms and so on) " +
      "or restore the store from a commit without it; then, unless you added it yourself, reissue every credential in the store: whoever holds it may have read them " +
      "(docs/secrets.md#threat-notes)"
    );
  }
  const settings = encryptionSettings(meta);
  if (settings.length > 0) {
    return (
      `has ${settings.join(" and ")} in its sops metadata: ${settings.length === 1 ? "a setting that picks" : "settings that pick"} which values sops leaves in plaintext, or what its MAC covers, ` +
      `so sops edit could write a value you enter in plaintext, with the MAC still verifying. hapi's store has none of them but sops's default unencrypted_suffix (_unencrypted), as sops encrypt writes it. ` +
      "Restore the store from a commit without it; unless you set it yourself, someone who can write the store did (docs/secrets.md#threat-notes)"
    );
  }
  const plain = Object.entries(doc)
    .filter(([k, v]) => k !== "sops" && v !== "" && !(typeof v === "string" && ENCRYPTED.test(v)))
    .map(([k]) => shownName(k));
  if (plain.length > 0) {
    return (
      `${plain.join(", ")} ${plain.length === 1 ? "is" : "are"} not encrypted (a name ending in _unencrypted, a nested value, or a hand edit?); ` +
      "every value must be a top-level string that sops encrypted. Re-encrypt the file with sops"
    );
  }
  return undefined;
}

/** An age identity line, as `age-keygen` writes one: X25519 (`AGE-SECRET-KEY-1...`) or post-quantum (`AGE-SECRET-KEY-PQ-1...`). */
const AGE_IDENTITY = /^AGE-SECRET-KEY-(?:PQ-)?1[0-9A-Z]+$/;

/**
 * Why an age key file's text isn't a plain age identity file, or undefined:
 * every line that isn't blank or a `#` comment must be an `AGE_IDENTITY`, and
 * there must be at least one. A passphrase-wrapped identity (recovery.age, or
 * any age-encrypted file) would make sops prompt through gpg-agent or the
 * terminal; a plugin identity would run a plugin. Never quotes the file.
 */
export function ageKeyTextProblem(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim());
  const bad = lines.findIndex((l) => l !== "" && !l.startsWith("#") && !AGE_IDENTITY.test(l));
  if (bad !== -1) {
    return (
      `is not a plain age identity file: line ${bad + 1} is not an AGE-SECRET-KEY-1... or AGE-SECRET-KEY-PQ-1... identity (not shown). ` +
      "sops gets this file as it is, so it must hold unwrapped identities only, as age-keygen writes them: never recovery.age or another passphrase-protected or plugin key"
    );
  }
  if (!lines.some((l) => AGE_IDENTITY.test(l))) return "holds no age identity (an AGE-SECRET-KEY-1... or AGE-SECRET-KEY-PQ-1... line), so it can't open anything";
  return undefined;
}

/**
 * Throw a SecretError unless the age key file is ours, closed to group and
 * other, outside the checkout, not the store's recovery.age (when `store` is
 * given), and a plain age identity file (`ageKeyTextProblem`). So sops is
 * never handed a wrapped identity.
 */
export async function checkAgeKeyFile(path: string, o: { repoRoot?: CheckoutRoots; uid?: number; store?: string } = {}): Promise<void> {
  const problem = await privateFileProblem(path, { repoRoot: o.repoRoot ?? (await defaultRepoRoot()), mode: "private", ...(o.uid === undefined ? {} : { uid: o.uid }) });
  if (problem !== undefined) throw new SecretError(`age key file ${path} ${problem}`);
  if (o.store !== undefined) {
    const rec = recoveryPath(o.store);
    if (resolve(path) === resolve(rec) || (await realish(resolve(path))) === (await realish(resolve(rec)))) {
      throw new SecretError(
        `age key file ${path} is the store's recovery.age: that is the recovery key wrapped with the 10 words, never a machine key, and sops must never get it. Point sops.age_key_file in your secrets config at this machine's own key (docs/secrets.md#keys-and-recovery)`,
      );
    }
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new SecretError(`age key file ${path} cannot be read${code ? ` (${code})` : ""}`);
  }
  const content = ageKeyTextProblem(text);
  if (content !== undefined) throw new SecretError(`age key file ${path} ${content}`);
}

/**
 * Check every age key file sops will read with `env` for `o.store`:
 * `ageKeyFile` (it must pass `checkAgeKeyFile`), and sops's own default,
 * `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt` as sops computes it
 * from `env`, if that is another file and exists. sops 3.13 loads identities
 * from every source it finds, so an unchecked default would be used too.
 * (It also tries ~/.ssh/id_ed25519 and id_rsa, but only for an SSH
 * recipient; hapi's store is encrypted to age recipients.)
 */
export async function checkSopsKeys(ageKeyFile: string, env: Env, o: { repoRoot: CheckoutRoots; uid?: number; store?: string }): Promise<void> {
  await checkAgeKeyFile(ageKeyFile, o);
  // As Go's os.UserConfigDir, which sops uses: $XDG_CONFIG_HOME if set (a relative one is an error, so no default), else $HOME/.config.
  const xdg = env.XDG_CONFIG_HOME;
  const configDir = xdg ? (isAbsolute(xdg) ? xdg : undefined) : env.HOME ? join(env.HOME, ".config") : undefined;
  if (configDir === undefined) return;
  const implicit = join(configDir, "sops", "age", "keys.txt");
  if (resolve(implicit) === resolve(ageKeyFile)) return;
  try {
    await lstat(implicit);
  } catch {
    return;
  }
  try {
    await checkAgeKeyFile(implicit, o);
  } catch (e) {
    throw new SecretError(`${(e as Error).message} (sops reads its default key file as well as ${ageKeyFile}, so it must be safe too, or gone)`);
  }
}

export interface SopsOptions {
  /** The encrypted file. */
  file: string;
  /** The age key file (the config's `age_key_file`, or sops's default). */
  ageKeyFile: string;
  /** Where PATH and HOME come from. Nothing else of it reaches sops. */
  env: Env;
  run?: SopsRunner;
  repoRoot?: () => Promise<CheckoutRoots>;
  /** The pinned age's directory (default `pinnedAgeDir`). */
  ageDir?: () => Promise<string>;
  uid?: number;
}

/** The sops + age provider over one encrypted file. */
export function sopsProvider(o: SopsOptions): SecretProvider {
  const run = o.run ?? runSops;
  const raw = async (): Promise<string> => {
    let text: string;
    try {
      text = await readFile(o.file, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new SecretError(`no sops file at ${o.file}: run \`mise run secrets:init\``);
      throw new SecretError(`cannot read ${o.file}${code ? ` (${code})` : ""}`);
    }
    const problem = sopsFileProblem(text);
    if (problem !== undefined) throw new SecretError(`${o.file} ${problem}`);
    return text;
  };
  return {
    name: "sops",
    downgrade: false,
    async list() {
      const doc = parse(await raw()) as Record<string, unknown>;
      return Object.keys(doc).filter((k) => k !== "sops");
    },
    async fetch(names) {
      const env = sopsEnv(o.env, await (o.ageDir ?? pinnedAgeDir)(), { file: o.ageKeyFile });
      await checkSopsKeys(o.ageKeyFile, env, { repoRoot: await (o.repoRoot ?? defaultRepoRoot)(), store: o.file, ...(o.uid === undefined ? {} : { uid: o.uid }) });
      await raw();
      const r = await run(["--config", "/dev/null", "decrypt", "--input-type", "yaml", "--output-type", "json", o.file], { env });
      if (r.code !== 0) {
        const why = scrubToolError(r.stderr);
        throw new SecretError(`sops could not decrypt ${o.file} (exit ${r.code})${why ? `: ${why}` : ""}`);
      }
      const values = decryptedMap(r.stdout, o.file);
      const missing = names.filter((n) => !values.has(n));
      if (missing.length > 0) throw new SecretError(`${o.file} has no ${missing.join(", ")}`, missing);
      return new Map(names.map((n) => [n, values.get(n)!]));
    },
  };
}

/** sops's decrypted JSON as a map of name -> value, or a SecretError that quotes none of it. */
export function decryptedMap(stdout: string, file: string): Map<string, string> {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    // Not JSON.parse's message: it can quote the text, which holds the values.
    throw new SecretError(`sops printed something for ${file} that is not JSON (not shown)`);
  }
  if (!isRecord(doc)) throw new SecretError(`${file} does not decrypt to a map of name: value`);
  const values = new Map<string, string>();
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v !== "string") throw new SecretError(`${file}: ${shownName(k)} is not a string (a hapi sops store is a flat map of name: value)`);
    values.set(k, v);
  }
  return values;
}

/**
 * The `sops edit` invocation for `hapi secrets edit`: the args, and the env:
 * the caller's minus every SOPS_* variable (so the shell can't add a recipient
 * or a key), plus the age key file, the version check off, `GPG_AGENT_INFO=`,
 * the pinned age first on PATH, and TMPDIR on the user's tmpfs, where sops
 * writes the plaintext temp file for the editor.
 */
export function sopsEditInvocation(o: { file: string; ageKeyFile: string; env: Env; tmpDir: string; ageDir: string }): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined && !k.startsWith("SOPS_")) env[k] = v;
  env.PATH = agePath(o.env, o.ageDir);
  env.GPG_AGENT_INFO = "";
  env.SOPS_AGE_KEY_FILE = o.ageKeyFile;
  env.SOPS_DISABLE_VERSION_CHECK = "1";
  env.TMPDIR = o.tmpDir;
  return { args: ["--config", "/dev/null", "edit", "--input-type", "yaml", "--output-type", "yaml", o.file], env };
}
