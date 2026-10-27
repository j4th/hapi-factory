import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretError } from "../../src/secrets/provider";
import { AGE_MIN_VERSION, checkAgeKeyFile, resolveAgeDir, type SopsRunner, sopsFileProblem, sopsProvider } from "../../src/secrets/providers/sops";
import { caught, cleanup, ENC, FAKE_AGE_DIR, FAKE_RECIPIENT, sopsFileText, sopsStore, tempDir } from "./helpers";

const FAKE = "sk-SECRET-123";

afterEach(cleanup);

/** A sops store in a temp dir and a provider over it, with a temp dir standing in for the hapi-factory checkout. */
function setup(values: Record<string, string> = { "hapi-a": FAKE, "hapi-b": "" }, run?: SopsRunner) {
  const dir = tempDir();
  const store = sopsStore(dir, values);
  const checkout = tempDir();
  const env = { PATH: "/usr/bin:/bin", HOME: join(dir, "home"), SOPS_AGE_KEY: "AGE-NOT-A-KEY", BWS_ACCESS_TOKEN: "not-a-token", OTHER: FAKE };
  const provider = sopsProvider({ file: store.file, ageKeyFile: store.ageKeyFile, run: run ?? store.run, env, repoRoot: async () => checkout, ageDir: async () => FAKE_AGE_DIR });
  return { dir, store, checkout, env, provider };
}

describe("the sops provider", () => {
  test("sops provider: minimal env with SOPS_DISABLE_VERSION_CHECK=1, no value in argv", async () => {
    const s = setup();
    expect([s.provider.name, s.provider.downgrade]).toEqual(["sops", false]);
    const values = await s.provider.fetch(["hapi-a", "hapi-b"]);
    expect([...values]).toEqual([
      ["hapi-a", FAKE],
      ["hapi-b", ""],
    ]);
    expect(s.store.calls).toEqual([
      {
        args: ["--config", "/dev/null", "decrypt", "--input-type", "yaml", "--output-type", "json", s.store.file],
        // Nothing else is inherited: not the shell's SOPS_* settings, not BWS_ACCESS_TOKEN, nothing.
        // The pinned age leads PATH (sops runs age plugins from it), and GPG_AGENT_INFO= keeps sops away from any gpg-agent.
        env: { PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`, HOME: s.env.HOME, SOPS_AGE_KEY_FILE: s.store.ageKeyFile, SOPS_DISABLE_VERSION_CHECK: "1", GPG_AGENT_INFO: "" },
      },
    ]);
    expect(JSON.stringify(s.store.calls)).not.toContain(FAKE);
  });

  test("every name asked for is returned, or a SecretError names the missing ones and the file; unknown entries are ignored", async () => {
    const s = setup({ "hapi-a": "x", "hapi-old": "y" });
    expect([...(await s.provider.fetch(["hapi-a"]))]).toEqual([["hapi-a", "x"]]);
    const e = await caught(s.provider.fetch(["hapi-a", "hapi-b", "hapi-c"]));
    expect(e).toBeInstanceOf(SecretError);
    expect((e as SecretError).missing).toEqual(["hapi-b", "hapi-c"]);
    expect(e.message).toBe(`${s.store.file} has no hapi-b, hapi-c`);
  });

  test("list reads the names from the encrypted file without decrypting it", async () => {
    const s = setup({ "hapi-a": "x", "hapi-b": "" });
    expect((await s.provider.list()).sort()).toEqual(["hapi-a", "hapi-b"]);
    expect(s.store.calls).toEqual([]);
  });

  test("sops provider refuses a file with a plaintext value or no age recipient", async () => {
    const s = setup();
    const refuse = async (text: string, why: RegExp) => {
      writeFileSync(s.store.file, text);
      const e = await caught(s.provider.fetch(["hapi-a"]));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(why);
      expect(e.message).not.toContain(FAKE);
    };
    // unencrypted_suffix (or _regex) leaves a value in plaintext: refused, by name, without the value.
    const plain = sopsFileText({ "hapi-a": "enc" }, { unencrypted_suffix: "_unencrypted" }).replace(/^hapi-a: .*$/m, `hapi-a: ${FAKE}`);
    await refuse(plain, /hapi-a is not encrypted/);
    await refuse(sopsFileText({ "hapi-a": "enc" }).replace(/^hapi-a: .*$/m, "hapi-a: 12345"), /hapi-a is not encrypted/);
    await refuse(`hapi-a:\n  nested: ${ENC}\n${sopsFileText({}).trimEnd()}\n`, /hapi-a is not encrypted/);
    // A pasted secret as a key name is not shown.
    await refuse(sopsFileText({ "hapi-a": "enc" }).replace("hapi-a:", `${FAKE}: plain\nhapi-a:`), /\(a name that is not a logical name, not shown\) is not encrypted/);
    // No sops block at all: a plaintext file.
    await refuse(`hapi-a: ${FAKE}\n`, /no sops metadata/);
    // A sops block with no age recipient (another key type only).
    await refuse(sopsFileText({ "hapi-a": "enc" }).replace(/ {2}age:\n(?: {4}.*\n)+/, "  pgp:\n    - fp: FAKEFINGERPRINT\n"), /no age recipient/);
    await refuse(sopsFileText({ "hapi-a": "enc" }, {}, ["not-a-recipient"]), /no age recipient/);
    await refuse(`- ${FAKE}\n`, /not a sops-encrypted YAML mapping/);
    await refuse(`hapi-a: [${FAKE}\n`, /not valid YAML \(not shown\)/);
    expect(s.store.calls).toEqual([]); // sops never ran
  });

  test("sops provider refuses a store also encrypted to a master key that is not age, naming its type, before sops runs", async () => {
    // sops 3.13.3's master-key lists besides age (its metadata's mapstructure tags), each with its type as named.
    const others: [string, unknown, RegExp][] = [
      ["pgp", [{ fp: "FAKEFINGERPRINT", enc: ENC }], /a PGP key \(sops\.pgp\)/],
      ["kms", [{ arn: "arn:aws:kms:us-east-1:000000000000:key/fake", enc: ENC }], /an AWS KMS key \(sops\.kms\)/],
      ["gcp_kms", [{ resource_id: "projects/fake/keyRings/fake/cryptoKeys/fake", enc: ENC }], /a GCP KMS key \(sops\.gcp_kms\)/],
      ["azure_kv", [{ vault_url: "https://fake.vault.azure.net", name: "fake", enc: ENC }], /an Azure Key Vault key \(sops\.azure_kv\)/],
      ["hc_vault", [{ vault_address: "https://vault.example.org:8200", engine_path: "transit", key_name: "fake", enc: ENC }], /a HashiCorp Vault transit key \(sops\.hc_vault\)/],
      ["hckms", [{ key_id: "region:fake", enc: ENC }], /a HuaweiCloud KMS key \(sops\.hckms\)/],
      ["key_groups", [{ age: [{ recipient: FAKE_RECIPIENT, enc: ENC }] }], /sops key groups \(sops\.key_groups\)/],
      // A list sops 3.13 doesn't write is refused too: a newer sops's key type is a list like the rest.
      ["future_kms", [{ id: "fake", enc: ENC }], /keys of a type hapi doesn't know \(sops\.future_kms\)/],
    ];
    const s = setup();
    for (const [field, value, why] of others) {
      const text = sopsFileText({ "hapi-a": "enc" }, { [field]: value });
      const problem = sopsFileProblem(text);
      expect(problem).toMatch(why);
      expect(problem).toMatch(/in its sops metadata, besides its age recipients: hapi's store is encrypted to age recipients only, each named in its recipients file, so any other key could open it unseen/);
      expect(problem).toMatch(/reissue every credential in the store/);
      // The key's identifier is metadata, not a secret, but sopsFileProblem never quotes the file.
      expect(problem).not.toMatch(/FAKEFINGERPRINT|arn:aws|projects\/fake|vault\.azure|vault\.example|region:fake/);
      writeFileSync(s.store.file, text);
      await expect(s.provider.fetch(["hapi-a"])).rejects.toThrow(why);
      await expect(s.provider.list()).rejects.toThrow(why);
    }
    // Several at once are all named.
    expect(sopsFileProblem(sopsFileText({ "hapi-a": "enc" }, { pgp: [{ fp: "F" }], kms: [{ arn: "a" }] }))).toMatch(/^has a PGP key \(sops\.pgp\) and an AWS KMS key \(sops\.kms\) in its sops metadata/);
    // An empty list (older sops wrote `pgp: []` and the like) and sops's scalar metadata are fine.
    expect(sopsFileProblem(sopsFileText({ "hapi-a": "enc" }, { pgp: [], kms: [], gcp_kms: null, azure_kv: [], hc_vault: [], hckms: [], key_groups: [] }))).toBeUndefined();
    expect(
      sopsFileProblem(sopsFileText({ "hapi-a": "enc" }, { lastmodified: "2026-10-26T12:00:00Z", mac: ENC, unencrypted_suffix: "_unencrypted", shamir_threshold: 1, mac_only_encrypted: false })),
    ).toBeUndefined();
    // A metadata field name that isn't a plain identifier isn't shown either.
    expect(sopsFileProblem(sopsFileText({ "hapi-a": "enc" }, { [FAKE]: [{ x: 1 }] }))).toMatch(/keys of a type hapi doesn't know \(a sops metadata field, not shown\)/);
    expect(sopsFileProblem(sopsFileText({ "hapi-a": "enc" }, { [FAKE]: [{ x: 1 }] }))).not.toContain(FAKE);
    expect(s.store.calls).toEqual([]); // sops never ran
  });

  test("an empty value is allowed in the encrypted file: sops leaves \"\" as it is, and it holds nothing", () => {
    expect(sopsFileProblem(sopsFileText({ "hapi-a": "", "hapi-b": "enc" }))).toBeUndefined();
  });

  test("a decrypt failure reports the file and exit code and only the first stderr line, scrubbed", async () => {
    const fail = (stderr: string): SopsRunner => async () => ({ code: 1, stdout: `{"hapi-a":"${FAKE}"}`, stderr });
    const message = async (stderr: string) => (await caught(setup(undefined, fail(stderr)).provider.fetch(["hapi-a"]))).message.replace(/^.*\(exit 1\)/, "");
    expect(await message("Failed to get the data key required to decrypt the SOPS file.\n\nGroup 0: FAILED\n  age1x: FAILED")).toBe(
      ": Failed to get the data key required to decrypt the SOPS file.",
    );
    // After a ':' only a path survives: a parse error can quote the file's text.
    expect(await message(`Error unmarshalling input yaml: yaml: line 3: could not find expected ':' near "${FAKE}"`)).toBe(": Error unmarshalling input yaml");
    expect(await message("Error: /home/example/.config/sops/age/keys.txt: permission denied")).toBe(": Error: /home/example/.config/sops/age/keys.txt");
    expect(await message("\u001b[31mcolour\u001b[0m")).toBe(": colour");
    expect(await message("")).toBe("");
    const e = await caught(setup(undefined, fail(`Error: ${FAKE}: x`)).provider.fetch(["hapi-a"]));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toMatch(/^sops could not decrypt .*secrets\.enc\.yaml \(exit 1\)/);
    expect(e.message).not.toContain(FAKE);
  });

  test("the decrypted JSON must be a flat map of name to string; nothing of it is echoed", async () => {
    for (const stdout of [`value: ${FAKE}`, `["${FAKE}"]`, `{"hapi-a":{"v":"${FAKE}"}}`, `{"hapi-a":12345}`]) {
      const e = await caught(setup(undefined, async () => ({ code: 0, stdout, stderr: "" })).provider.fetch(["hapi-a"]));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).not.toContain(FAKE);
      expect(e.message).not.toContain("12345");
    }
  });

  test("no sops file, or no sops binary, fails clearly", async () => {
    const s = setup();
    const missing = sopsProvider({ file: join(s.dir, "nope.enc.yaml"), ageKeyFile: s.store.ageKeyFile, run: s.store.run, env: s.env, repoRoot: async () => s.checkout, ageDir: async () => FAKE_AGE_DIR });
    await expect(missing.fetch(["hapi-a"])).rejects.toThrow(/no sops file at .*nope\.enc\.yaml: run `mise run secrets:init`/);
    // The default runner, with a PATH that has no sops: nothing runs.
    const noBinary = sopsProvider({ file: s.store.file, ageKeyFile: s.store.ageKeyFile, env: { PATH: join(s.dir, "empty-bin") }, repoRoot: async () => s.checkout, ageDir: async () => join(s.dir, "no-age") });
    await expect(noBinary.fetch(["hapi-a"])).rejects.toThrow(/cannot run sops: is it on PATH\? \(`mise install` provides it\)/);
  });
});

describe("the age key file", () => {
  test("age key file: refuses group/other bits, wrong owner, or a path inside the checkout (private/ included)", async () => {
    const s = setup();
    const opts = { repoRoot: s.checkout };
    await expect(checkAgeKeyFile(s.store.ageKeyFile, opts)).resolves.toBeUndefined();
    for (const m of [0o640, 0o604, 0o644, 0o601]) {
      chmodSync(s.store.ageKeyFile, m);
      await expect(checkAgeKeyFile(s.store.ageKeyFile, opts)).rejects.toThrow(/group or other permission bits/);
    }
    chmodSync(s.store.ageKeyFile, 0o400); // read-only for the owner is fine
    await expect(checkAgeKeyFile(s.store.ageKeyFile, opts)).resolves.toBeUndefined();
    chmodSync(s.store.ageKeyFile, 0o600);
    await expect(checkAgeKeyFile(s.store.ageKeyFile, { ...opts, uid: process.getuid!() + 1 })).rejects.toThrow(/owned by uid \d+, not you/);
    await expect(checkAgeKeyFile(join(s.dir, "absent.txt"), opts)).rejects.toThrow(/does not exist/);

    // Inside the checkout, private/ included: private/ is pushed beside the encrypted file.
    // A first segment that merely starts with ".." ("..private", "..agekey") is still inside.
    for (const rel of ["keys.txt", join("private", "keys.txt"), join("private", "deep", "age.agekey"), join("..private", "keys.txt"), "..agekey", join("..keys", "age.txt")]) {
      const inside = join(s.checkout, rel);
      mkdirSync(join(inside, ".."), { recursive: true });
      writeFileSync(inside, "# not a real age key\n", { mode: 0o600 });
      const e = await caught(checkAgeKeyFile(inside, opts));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/inside the hapi-factory checkout/);
    }
    // A symlink from outside that resolves into the checkout counts as inside.
    const link = join(s.dir, "link.txt");
    symlinkSync(join(s.checkout, "keys.txt"), link);
    await expect(checkAgeKeyFile(link, opts)).rejects.toThrow(/inside the hapi-factory checkout/);
  });

  test("sops's own default key file under HOME is checked too when it exists, since sops reads it as well", async () => {
    const s = setup();
    const implicit = join(s.env.HOME, ".config", "sops", "age", "keys.txt");
    mkdirSync(join(implicit, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(implicit, "# not a real age key\n", { mode: 0o644 });
    chmodSync(implicit, 0o644);
    await expect(s.provider.fetch(["hapi-a"])).rejects.toThrow(/age key file .*\.config\/sops\/age\/keys\.txt has group or other permission bits.*sops reads its default key file as well/);
    expect(s.store.calls).toEqual([]);
    chmodSync(implicit, 0o600);
    await expect(s.provider.fetch(["hapi-a"])).resolves.toBeDefined();
  });

  test("the provider checks the age key before it decrypts", async () => {
    const s = setup();
    chmodSync(s.store.ageKeyFile, 0o644);
    await expect(s.provider.fetch(["hapi-a"])).rejects.toThrow(/age key file .*keys\.txt has group or other permission bits/);
    expect(s.store.calls).toEqual([]);
  });

  test("the default checkout is this repo's git top-level, and a path in it is refused before the file is even looked at", async () => {
    // Nothing is created or read: the location check comes first.
    await expect(checkAgeKeyFile(join(process.cwd(), "private", "no-such-dir", "keys.txt"))).rejects.toThrow(/inside the hapi-factory checkout/);
  });
});

describe("the pinned age", () => {
  /** A fake `mise where age` install dir with the three binaries (never run: the version is injected). */
  function install(layout: "flat" | "nested") {
    const where = tempDir();
    const bin = layout === "flat" ? where : join(where, "age");
    mkdirSync(bin, { recursive: true });
    for (const b of ["age", "age-keygen", "age-plugin-batchpass"]) writeFileSync(join(bin, b), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    return { where, bin };
  }

  test("the minimum is mise.toml's pin", async () => {
    const pin = /^age = "([0-9.]+)"/m.exec(await Bun.file("mise.toml").text())![1];
    expect(AGE_MIN_VERSION).toBe(pin!);
  });

  test("resolves the install dir once with `mise where age`, finds the binaries, and refuses an age below the pin", async () => {
    for (const layout of ["flat", "nested"] as const) {
      const { where, bin } = install(layout);
      const seen: string[] = [];
      const version = async (age: string) => (seen.push(age), "v1.3.2\n");
      expect(await resolveAgeDir({ where: async () => `${where}\n`, version })).toBe(bin);
      expect(seen).toEqual([join(bin, "age")]);
    }
    const { where } = install("nested");
    for (const v of ["v1.10.0", "1.3.2", "v2.0.0-rc.1"]) await expect(resolveAgeDir({ where: async () => where, version: async () => v })).resolves.toBeDefined();
    for (const v of ["v1.3.1", "v1.1.1", "(devel)", ""]) {
      const e = await caught(resolveAgeDir({ where: async () => where, version: async () => v }));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/is not age 1\.3\.2 or later.*run `mise install`/);
    }
    // No binaries there (the distro age is never a fallback), or mise can't say.
    const empty = tempDir();
    await expect(resolveAgeDir({ where: async () => empty, version: async () => "v1.3.2" })).rejects.toThrow(/no age, age-keygen and age-plugin-batchpass under .*: run `mise install`/);
    await expect(resolveAgeDir({ where: async () => { throw new SecretError("`mise where age` failed (exit 1)"); }, version: async () => "v1.3.2" })).rejects.toThrow(/mise where age/);
  });
});
