/**
 * `hapi secrets init`: onboarding for the default sops + age provider (spec
 * §11.5). The flags are parsed in ./cli.ts.
 *
 * It never overwrites anything: if the config, the store, recovery.age or the
 * recipients file exists, it stops and points at `hapi secrets check`. It
 * refuses two of those paths (or the age key) being the same file. Then:
 * 1. **This machine's key** (`--age-key`, default sops's own
 *    `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`): an existing key
 *    is reused after `checkAgeKeyFile`, if its kind matches (post-quantum by
 *    default, classic with `--classic`); otherwise a new one is made in
 *    memory with `age-keygen -pq`, never inside the checkout. Its recipient is
 *    named `--name`, default `<hostname>-<user>`.
 * 2. **The recovery identity and its 10 words**, in memory (./recovery.ts).
 * 3. **The words are shown once** on the terminal, with what to do with them,
 *    and then **2 of them are asked for**, at random positions; a mismatch
 *    shows them again, up to 3 tries, then it aborts. (`--no-confirm` skips the
 *    check, for tests and CI fixtures only: it is refused when a person is at
 *    the terminal.)
 * 4. Only then: the recovery identity is wrapped with the words, and the
 *    template (every manifest name, each "") is encrypted to **both
 *    recipients** by piping it to `sops encrypt`. Plaintext never touches
 *    disk.
 * 5. **The writes**, each no-replace (`writeNewFiles`: a file that appears
 *    after the checks is never replaced), 0600 in a 0700 directory: this
 *    machine's key (if new), the store, recovery.age, the recipients file and
 *    the config. If one fails, the others are removed again.
 * An abort at any step writes nothing.
 */
import { join } from "node:path";
import { stringify } from "yaml";
import { defaultRepoRoot } from "./files";
import {
  configText,
  defaultMachineName,
  exists,
  machineKey,
  checkName,
  type LifecycleDeps,
  refuseCoinciding,
  refuseSharedDirs,
  terminalFor,
  today,
  toolsFor,
  uidOf,
  writeNewFiles,
} from "./lifecycle";
import { loadManifest, MANIFEST_FILE, manifestNames } from "./manifest";
import { configHome, configPath, defaultAgeKeyFile, expandPath, SecretError } from "./provider";
import { ageEnv, scrubToolError, sopsEnv, sopsFileProblem } from "./providers/sops";
import { recipientsPath, recipientsText, recoveryPath, storeRecipients } from "./recipients";
import { attendedTerminal, generateWords, newIdentity, showAndConfirmWords, wrapIdentity } from "./recovery";

export interface InitOptions {
  config?: string | undefined;
  file?: string | undefined;
  ageKey?: string | undefined;
  name?: string | undefined;
  /** All-classic (X25519) recipients instead of post-quantum: the trade-off for P-256 hardware plugins later. */
  classic: boolean;
  /** Skip the word check (tests and CI fixtures only). */
  noConfirm: boolean;
}

export async function initStore(o: InitOptions, deps: LifecycleDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const config = configPath({ config: o.config, env, cwd });
  const file = o.file === undefined ? join(configHome(env), "hapi", "secrets.enc.yaml") : expandPath(o.file, env, cwd);
  const ageKey = o.ageKey === undefined ? defaultAgeKeyFile(env) : expandPath(o.ageKey, env, cwd);
  const recovery = recoveryPath(file);
  const recipients = recipientsPath(file);
  await refuseCoinciding([["config", config], ["store", file], ["age key", ageKey], ["recovery.age", recovery], ["recipients file", recipients]]);
  for (const path of [config, file, recovery, recipients]) {
    if (await exists(path)) {
      throw new Error(`${path} already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`);
    }
  }
  if (o.noConfirm && (deps.attended ?? attendedTerminal())) {
    throw new SecretError("--no-confirm is for tests and CI fixtures only, and a person is at this terminal: run init without it, and confirm the words");
  }
  const reuseKey = await exists(ageKey);
  refuseSharedDirs(reuseKey ? [config, file] : [config, file, ageKey], env);
  const name = o.name ?? defaultMachineName(deps);
  checkName(name);
  const names = manifestNames(loadManifest(deps.manifestFile ?? MANIFEST_FILE));
  const tty = terminalFor(deps);
  if (tty === undefined && !o.noConfirm) {
    throw new SecretError("hapi secrets init needs a terminal to show the recovery words and check you kept them; run it in one (not in a pipe or CI)");
  }
  const pq = !o.classic;
  const kind = pq ? "post-quantum" : "classic";
  const tools = await toolsFor(deps);

  // 1. This machine's key; 2. the recovery identity and its words. In memory, so far.
  const key = await machineKey(ageKey, pq, tools, env, {
    repoRoot: await (deps.repoRoot ?? defaultRepoRoot)(),
    ...uidOf(deps),
    mismatch: (k) =>
      `the age key ${ageKey} is ${k}, and this store would be ${pq ? "post-quantum (the default)" : "classic (--classic)"}: hapi won't mix them. ` +
      `Give --age-key a new path for a new ${kind} key${pq ? ", or pass --classic for an all-classic store" : ""} (docs/secrets.md#post-quantum-by-default)`,
  });
  const rec = await newIdentity(tools.ageKeygen, ageEnv(env, tools.dir), pq);
  const words = generateWords();

  // 3. Shown once, then checked.
  if (tty !== undefined) await showAndConfirmWords(words, tty, { confirm: !o.noConfirm });
  else console.error("hapi secrets init: warning: no terminal, so the recovery words were not shown: this store's recovery.age can't be opened (fine for a test or CI fixture; run `hapi secrets new-recovery` on a terminal for real words)");

  // 4. Wrap the recovery key, and encrypt the template to both recipients.
  const wrapped = await wrapIdentity(tools.age, ageEnv(env, tools.dir), rec.text, words);
  const template = stringify(Object.fromEntries(names.map((n) => [n, ""])));
  const enc = await tools.sops(
    ["--config", "/dev/null", "encrypt", "--age", `${key.recipient},${rec.recipient}`, "--input-type", "yaml", "--output-type", "yaml", "--filename-override", file],
    { env: sopsEnv(env, tools.dir), stdin: template },
  );
  if (enc.code !== 0) {
    const why = scrubToolError(enc.stderr);
    throw new SecretError(`sops could not encrypt the template (exit ${enc.code})${why ? `: ${why}` : ""}`);
  }
  const problem = sopsFileProblem(enc.stdout);
  if (problem !== undefined) throw new SecretError(`sops's output ${problem}; nothing was written`);
  const got = storeRecipients(enc.stdout);
  if (got.length !== 2 || !got.includes(key.recipient) || !got.includes(rec.recipient)) throw new SecretError("sops's output is not encrypted to exactly the two recipients asked for; nothing was written");

  // 5. The writes, no-replace, all or nothing.
  const added = today(deps);
  const recipientsFile = {
    pq,
    recipients: [
      { name, kind: "machine" as const, recipient: key.recipient, added },
      { name: "recovery", kind: "recovery" as const, recipient: rec.recipient, added },
    ],
  };
  await writeNewFiles(
    [
      ...(key.text === undefined ? [] : [[ageKey, key.text] as [string, string]]),
      [file, enc.stdout],
      [recovery, wrapped],
      [recipients, recipientsText(recipientsFile, file)],
      [config, configText(file, ageKey, "init")],
    ],
    uidOf(deps),
  );

  console.log(`${key.text === undefined ? "using" : "created"} the age key ${ageKey} (this machine: ${name})`);
  console.log(`wrote ${file} (${names.length} names, all empty, encrypted to ${name} and the recovery recipient, both ${kind})`);
  console.log(`wrote ${recovery} (the recovery key, locked with your 10 words; it may be backed up with the store)`);
  console.log(`wrote ${recipients} (the store's recipients, public keys only)`);
  console.log(`wrote ${config} (provider: sops)`);
  console.log("next: mise run secrets:drill (proves your words open the store), then mise run secrets:edit to fill in each value (docs/secrets.md)");
  return 0;
}
