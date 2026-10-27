/**
 * The sops + age provider (spec §11.5): the default for everyone.
 *
 * The store is one sops-encrypted YAML file (`secrets.enc.yaml`): a flat map of
 * logical name -> value, every value encrypted to an age recipient. Its key is
 * an age key file, by default sops's own `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`.
 * The encrypted file may live anywhere (private/ included: it is backed up to
 * the private remote there). The key may not: it must be ours, closed to group
 * and other, and outside the hapi-factory checkout, private/ included, because
 * the key and the encrypted file together are the plaintext.
 *
 * `fetch`:
 * 1. checks the age key file (`checkAgeKeyFile`), and sops's own default key
 *    file under the HOME it gets, if that exists too: sops 3.13 reads every
 *    key source it finds, not only SOPS_AGE_KEY_FILE (`checkSopsKeys`);
 * 2. parses the raw file and checks its shape before decrypting
 *    (`sopsFileProblem`): a sops block with an age recipient, and every
 *    top-level value encrypted, so a value `unencrypted_suffix` or
 *    `unencrypted_regex` left in plaintext is refused;
 * 3. runs `sops decrypt --output-type json <file>` through a `SopsRunner`.
 *    The child gets a minimal env: PATH, HOME, SOPS_AGE_KEY_FILE (always the
 *    file just checked, the configured one or the default) and
 *    SOPS_DISABLE_VERSION_CHECK=1 (sops otherwise phones home). `--config
 *    /dev/null` keeps any .sops.yaml out of it. No value goes through argv;
 *    stderr is never echoed raw (`scrubToolError`);
 * 4. checks the JSON is a flat map of name -> string.
 *
 * `list` reads the names from the encrypted file (sops leaves keys in the
 * clear) without decrypting.
 */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { defaultRepoRoot, privateFileProblem } from "../files";
import { shownName } from "../manifest";
import { type Env, SecretError, type SecretProvider } from "../provider";

/** Runs a tool with these args and this whole env (nothing inherited), with `stdin` piped in if given. */
export type SopsRunner = (args: string[], o: { env: Record<string, string>; stdin?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A `SopsRunner` for the binary `cmd` on the env's PATH (mise installs the pinned one). Throws a SecretError if it can't start. */
export function commandRunner(cmd: string): SopsRunner {
  return async (args, o) => {
    let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn([cmd, ...args], {
        env: o.env,
        stdin: o.stdin === undefined ? "ignore" : new Response(o.stdin),
        stdout: "pipe",
        stderr: "pipe",
      }) as Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    } catch {
      throw new SecretError(`cannot run ${cmd}: is it on PATH? (\`mise install\` provides it)`);
    }
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
}

/** The pinned `sops` on PATH. */
export const runSops: SopsRunner = commandRunner("sops");
/** The pinned `age-keygen` on PATH. */
export const runAgeKeygen: SopsRunner = commandRunner("age-keygen");

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

/** sops's environment: PATH and HOME from `env`, the age key file, and the version check off. Nothing else. */
export function sopsEnv(env: Env, ageKeyFile: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.PATH) out.PATH = env.PATH;
  if (env.HOME) out.HOME = env.HOME;
  out.SOPS_AGE_KEY_FILE = ageKeyFile;
  out.SOPS_DISABLE_VERSION_CHECK = "1";
  return out;
}

const ENCRYPTED = /^ENC\[AES256_GCM,/;
const AGE_RECIPIENT = /^age1[0-9a-z]+$/;
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Why the raw text of a sops file is not a usable encrypted store, or
 * undefined: it must be a YAML mapping with a `sops` block that lists at least
 * one age recipient, and every other top-level value must be a string sops
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
  const plain = Object.entries(doc)
    .filter(([k, v]) => k !== "sops" && v !== "" && !(typeof v === "string" && ENCRYPTED.test(v)))
    .map(([k]) => shownName(k));
  if (plain.length > 0) {
    return (
      `${plain.join(", ")} ${plain.length === 1 ? "is" : "are"} not encrypted (an unencrypted_suffix or unencrypted_regex, a nested value, or a hand edit?); ` +
      "every value must be a top-level string that sops encrypted. Re-encrypt the file with sops"
    );
  }
  return undefined;
}

/** Throw a SecretError unless the age key file is ours, closed to group and other, and outside the checkout. */
export async function checkAgeKeyFile(path: string, o: { repoRoot?: string; uid?: number } = {}): Promise<void> {
  const problem = await privateFileProblem(path, { repoRoot: o.repoRoot ?? (await defaultRepoRoot()), mode: "private", ...(o.uid === undefined ? {} : { uid: o.uid }) });
  if (problem !== undefined) throw new SecretError(`age key file ${path} ${problem}`);
}

/**
 * Check every age key file sops will read with `env`: `ageKeyFile` (it must
 * pass `checkAgeKeyFile`), and sops's own default,
 * `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt` as sops computes it
 * from `env`, if that is another file and exists. sops 3.13 loads identities
 * from every source it finds, so an unchecked default would be used too.
 * (It also tries ~/.ssh/id_ed25519 and id_rsa, but only for an SSH
 * recipient; hapi's store is encrypted to an age recipient.)
 */
export async function checkSopsKeys(ageKeyFile: string, env: Env, o: { repoRoot: string; uid?: number }): Promise<void> {
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
  repoRoot?: () => Promise<string>;
  uid?: number;
}

/** The sops + age provider over one encrypted file. */
export function sopsProvider(o: SopsOptions): SecretProvider {
  const run = o.run ?? commandRunner("sops");
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
      const env = sopsEnv(o.env, o.ageKeyFile);
      await checkSopsKeys(o.ageKeyFile, env, { repoRoot: await (o.repoRoot ?? defaultRepoRoot)(), ...(o.uid === undefined ? {} : { uid: o.uid }) });
      await raw();
      const r = await run(["--config", "/dev/null", "decrypt", "--input-type", "yaml", "--output-type", "json", o.file], { env });
      if (r.code !== 0) {
        const why = scrubToolError(r.stderr);
        throw new SecretError(`sops could not decrypt ${o.file} (exit ${r.code})${why ? `: ${why}` : ""}`);
      }
      let doc: unknown;
      try {
        doc = JSON.parse(r.stdout);
      } catch {
        // Not JSON.parse's message: it can quote the text, which holds the values.
        throw new SecretError(`sops printed something for ${o.file} that is not JSON (not shown)`);
      }
      if (!isRecord(doc)) throw new SecretError(`${o.file} does not decrypt to a map of name: value`);
      const values = new Map<string, string>();
      for (const [k, v] of Object.entries(doc)) {
        if (typeof v !== "string") throw new SecretError(`${o.file}: ${shownName(k)} is not a string (a hapi sops store is a flat map of name: value)`);
        values.set(k, v);
      }
      const missing = names.filter((n) => !values.has(n));
      if (missing.length > 0) throw new SecretError(`${o.file} has no ${missing.join(", ")}`, missing);
      return new Map(names.map((n) => [n, values.get(n)!]));
    },
  };
}

/**
 * The `sops edit` invocation for `hapi secrets edit`: the args, and the env:
 * the caller's minus every SOPS_* variable (so the shell can't add a recipient
 * or a key), plus the age key file, the version check off, and TMPDIR on the
 * user's tmpfs, where sops writes the plaintext temp file for the editor.
 */
export function sopsEditInvocation(o: { file: string; ageKeyFile: string; env: Env; tmpDir: string }): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(o.env)) if (v !== undefined && !k.startsWith("SOPS_")) env[k] = v;
  env.SOPS_AGE_KEY_FILE = o.ageKeyFile;
  env.SOPS_DISABLE_VERSION_CHECK = "1";
  env.TMPDIR = o.tmpDir;
  return { args: ["--config", "/dev/null", "edit", "--input-type", "yaml", "--output-type", "yaml", o.file], env };
}
