/**
 * `hapi secrets init [--config file] [--file file] [--age-key file]`:
 * onboarding for the default sops + age provider (spec §11.5).
 *
 * It never overwrites anything: if the config or the sops file exists, it
 * stops and points at `hapi secrets check`. Then:
 * 1. The age key (`--age-key`, default sops's own
 *    `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`): an existing key is
 *    reused after `checkAgeKeyFile` (ours, closed to group and other, outside
 *    the checkout, private/ included); otherwise `age-keygen -o` makes one, in
 *    a 0700 directory, and it ends up 0600. Its public key comes from
 *    `age-keygen -y`.
 * 2. The sops file (`--file`, default
 *    `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.enc.yaml`; private/ in
 *    the checkout is fine): every manifest name with the value "", built in
 *    memory and piped on stdin to `sops encrypt --age <recipient>`. Plaintext
 *    never touches disk; only sops's output is written, once it checks as
 *    encrypted (`sopsFileProblem`).
 * 3. The config (`--config`, as `configPath` says): `provider: sops` with both
 *    paths, absolute.
 * Each file is written atomically, mode 0600, in a directory made or tightened
 * to 0700 (so never directly in $HOME or the config home, which it refuses).
 * Then it prints the public key, the backup reminder and the next step.
 */
import { chmod, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import { checkoutProblem, defaultRepoRoot, ensurePrivateDir, isWithin, writeSecretFile } from "./files";
import { loadManifest, MANIFEST_FILE, manifestNames } from "./manifest";
import { configHome, configPath, defaultAgeKeyFile, type Env, expandPath, SecretError, type SecretsDeps } from "./provider";
import { checkAgeKeyFile, runAgeKeygen, runSops, scrubToolError, sopsEnv, sopsFileProblem } from "./providers/sops";

const USAGE = "usage: hapi secrets init [--config file] [--file file] [--age-key file]";
const AGE_RECIPIENT = /^age1[0-9a-z]+$/;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** PATH and HOME only: what age-keygen needs. */
function keygenEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.PATH) out.PATH = env.PATH;
  if (env.HOME) out.HOME = env.HOME;
  return out;
}

export async function secretsInit(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!["--config", "--file", "--age-key"].includes(flag) || value === undefined || value.startsWith("-")) {
      console.error(USAGE);
      return 2;
    }
    flags[flag] = value;
  }
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const uid = deps.uid === undefined ? {} : { uid: deps.uid };
  const config = configPath({ config: flags["--config"], env, cwd });
  const file = flags["--file"] === undefined ? join(configHome(env), "hapi", "secrets.enc.yaml") : expandPath(flags["--file"], env, cwd);
  const ageKey = flags["--age-key"] === undefined ? defaultAgeKeyFile(env) : expandPath(flags["--age-key"], env, cwd);

  for (const path of [config, file]) {
    if (await exists(path)) {
      throw new Error(`${path} already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`);
    }
  }
  // Each new file's directory is made or tightened to 0700. Never a shared one: $HOME, the config home, or above them.
  const reuseKey = await exists(ageKey);
  const shared = [env.HOME, configHome(env)].filter((d): d is string => d !== undefined && d !== "").map((d) => resolve(d));
  for (const path of reuseKey ? [config, file] : [config, file, ageKey]) {
    const dir = resolve(dirname(path));
    if (shared.some((d) => isWithin(d, dir))) {
      throw new Error(`${path} would sit directly in ${dir}, which init would have to make 0700; put it in a directory of its own (the defaults are under ${join(configHome(env), "hapi")} and ${dirname(defaultAgeKeyFile(env))})`);
    }
  }
  const names = manifestNames(loadManifest(deps.manifestFile ?? MANIFEST_FILE));
  const repoRoot = await (deps.repoRoot ?? defaultRepoRoot)();
  const ageKeygen = deps.ageKeygen ?? runAgeKeygen;
  const sops = deps.sops ?? runSops;

  // 1. The age key: reused if it is there and safe; otherwise made, never inside the checkout.
  let created = false;
  if (reuseKey) {
    await checkAgeKeyFile(ageKey, { repoRoot, ...uid });
  } else {
    const where = await checkoutProblem(ageKey, repoRoot);
    if (where !== undefined) throw new SecretError(`age key file ${ageKey} ${where}`);
    await ensurePrivateDir(dirname(ageKey), uid);
    const r = await ageKeygen(["-o", ageKey], { env: keygenEnv(env) });
    if (r.code !== 0) {
      const why = scrubToolError(r.stderr);
      throw new SecretError(`age-keygen could not write ${ageKey} (exit ${r.code})${why ? `: ${why}` : ""}`);
    }
    await chmod(ageKey, 0o600);
    await checkAgeKeyFile(ageKey, { repoRoot, ...uid });
    created = true;
  }
  const pub = await ageKeygen(["-y", ageKey], { env: keygenEnv(env) });
  const recipients = pub.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (pub.code !== 0 || recipients.length === 0 || !recipients.every((r) => AGE_RECIPIENT.test(r))) {
    const why = scrubToolError(pub.stderr);
    throw new SecretError(`age-keygen -y could not read a public key from ${ageKey} (exit ${pub.code})${why ? `: ${why}` : ""}`);
  }

  // 2. The template, in memory only, encrypted through stdin.
  const template = stringify(Object.fromEntries(names.map((n) => [n, ""])));
  const enc = await sops(
    ["--config", "/dev/null", "encrypt", "--age", recipients.join(","), "--input-type", "yaml", "--output-type", "yaml", "--filename-override", file],
    { env: sopsEnv(env, ageKey), stdin: template },
  );
  if (enc.code !== 0) {
    const why = scrubToolError(enc.stderr);
    throw new SecretError(`sops could not encrypt the template (exit ${enc.code})${why ? `: ${why}` : ""}`);
  }
  const problem = sopsFileProblem(enc.stdout);
  if (problem !== undefined) throw new SecretError(`sops's output ${problem}; nothing was written`);
  await ensurePrivateDir(dirname(file), uid);
  await writeSecretFile(file, enc.stdout);

  // 3. The config.
  await ensurePrivateDir(dirname(config), uid);
  await writeSecretFile(
    config,
    "# hapi's local secrets config, written by `hapi secrets init` (docs/secrets.md).\n" +
      "# It picks the secret provider and binds it; it holds no secret.\n" +
      stringify({ provider: "sops", sops: { file, age_key_file: ageKey } }),
  );

  console.log(`${created ? "created" : "using"} the age key ${ageKey}`);
  for (const r of recipients) console.log(`age public key: ${r}`);
  console.log(`wrote ${file} (${names.length} names, all empty, encrypted to that key)`);
  console.log(`wrote ${config} (provider: sops)`);
  console.log(`back up ${ageKey} offline (e.g. in your password manager): without it the encrypted file can't be opened`);
  console.log("next: mise run secrets:edit, and fill in each value (docs/secrets.md)");
  return 0;
}
