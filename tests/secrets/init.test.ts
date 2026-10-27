import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { secretsInit } from "../../src/secrets/init";
import { manifestNames, loadManifest } from "../../src/secrets/manifest";
import type { SopsRunner } from "../../src/secrets/providers/sops";
import { capture, caught, cleanup, FAKE_RECIPIENT, sopsFileText, tempDir } from "./helpers";

afterEach(cleanup);

const NAMES = manifestNames(loadManifest("stack/secrets.yaml"));
const mode = (path: string) => statSync(path).mode & 0o777;

/** Every file under `dir`, relative, sorted. */
function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** A temp HOME, a stand-in checkout, and fake age-keygen and sops runners that record every call. */
function setup() {
  const root = tempDir();
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const checkout = tempDir();
  const env = { HOME: home, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: join(root, "run"), SOPS_AGE_RECIPIENTS: "age1other" };
  const keygen: { args: string[]; env: Record<string, string> }[] = [];
  const sops: { args: string[]; env: Record<string, string>; stdin?: string }[] = [];
  const ageKeygen: SopsRunner = async (args, o) => {
    keygen.push({ args, env: o.env });
    if (args[0] === "-o") {
      // age-keygen writes the new key 0600; its content is a stand-in here.
      writeFileSync(args[1]!, "# not a real age key (unit-test fixture)\n", { mode: 0o600, flag: "wx" });
      return { code: 0, stdout: "", stderr: `Public key: ${FAKE_RECIPIENT}\n` };
    }
    return { code: 0, stdout: `${FAKE_RECIPIENT}\n`, stderr: "" };
  };
  const encrypted = sopsFileText(Object.fromEntries(NAMES.map((n) => [n, ""] as const)));
  const sopsRun: SopsRunner = async (args, o) => {
    sops.push({ args, env: o.env, ...(o.stdin === undefined ? {} : { stdin: o.stdin }) });
    return { code: 0, stdout: encrypted, stderr: "" };
  };
  const deps = { env, cwd: root, ageKeygen, sops: sopsRun, repoRoot: async () => checkout };
  return { root, home, checkout, env, keygen, sops, encrypted, deps };
}

describe("hapi secrets init", () => {
  test("init builds the template in memory and pipes it to sops (no plaintext file written)", async () => {
    const { out } = capture();
    const s = setup();
    expect(await secretsInit([], s.deps)).toBe(0);
    const cfgDir = join(s.home, ".config");
    const ageKey = join(cfgDir, "sops", "age", "keys.txt");
    const file = join(cfgDir, "hapi", "secrets.enc.yaml");
    const config = join(cfgDir, "hapi", "secrets.yaml");

    // A new age key, made by age-keygen, in sops's default place, with its directory 0700.
    expect(s.keygen.map((k) => k.args)).toEqual([["-o", ageKey], ["-y", ageKey]]);
    expect(s.keygen[0]!.env).toEqual({ PATH: "/usr/bin:/bin", HOME: s.home });
    expect(mode(join(cfgDir, "sops", "age"))).toBe(0o700);
    expect(mode(ageKey)).toBe(0o600);

    // The template goes to sops on stdin: every manifest name, each "". sops sees no other SOPS_* setting.
    expect(s.sops.length).toBe(1);
    const call = s.sops[0]!;
    expect(call.args).toEqual(["--config", "/dev/null", "encrypt", "--age", FAKE_RECIPIENT, "--input-type", "yaml", "--output-type", "yaml", "--filename-override", file]);
    expect(call.env).toEqual({ PATH: "/usr/bin:/bin", HOME: s.home, SOPS_AGE_KEY_FILE: ageKey, SOPS_DISABLE_VERSION_CHECK: "1" });
    expect(parse(call.stdin!)).toEqual(Object.fromEntries(NAMES.map((n) => [n, ""])));

    // Only sops's encrypted output reaches disk, then the config: both 0600, in 0700 directories.
    expect(readFileSync(file, "utf8")).toBe(s.encrypted);
    expect(parse(readFileSync(config, "utf8"))).toEqual({ provider: "sops", sops: { file, age_key_file: ageKey } });
    for (const f of [file, config]) expect(mode(f)).toBe(0o600);
    expect(mode(join(cfgDir, "hapi"))).toBe(0o700);
    expect(tree(s.root)).toEqual([".config/hapi/secrets.enc.yaml", ".config/hapi/secrets.yaml", ".config/sops/age/keys.txt"].map((p) => join("home", p)));

    // Then it prints the public key, the backup reminder and the next step.
    const text = out.join("\n");
    expect(text).toContain(`age public key: ${FAKE_RECIPIENT}`);
    expect(text).toContain(`back up ${ageKey} offline (e.g. in your password manager): without it the encrypted file can't be opened`);
    expect(text).toContain("next: mise run secrets:edit");
  });

  test("init never overwrites an existing config or sops file", async () => {
    capture();
    for (const which of ["config", "sops"] as const) {
      const s = setup();
      const dir = join(s.home, ".config", "hapi");
      mkdirSync(dir, { recursive: true });
      const existing = join(dir, which === "config" ? "secrets.yaml" : "secrets.enc.yaml");
      writeFileSync(existing, "keep me\n");
      const e = await caught(secretsInit([], s.deps));
      expect(e.message).toBe(`${existing} already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`);
      expect(readFileSync(existing, "utf8")).toBe("keep me\n");
      expect(s.keygen).toEqual([]);
      expect(s.sops).toEqual([]);
      expect(tree(s.home)).toEqual([relative(s.home, existing)]);
    }
  });

  test("--config, --file and --age-key choose the paths; relative ones resolve against the working directory, and the config records them absolute", async () => {
    capture();
    const s = setup();
    expect(await secretsInit(["--config", "cfg/secrets.yaml", "--file", "private/secrets.enc.yaml", "--age-key", "~/keys/age.txt"], s.deps)).toBe(0);
    const config = join(s.root, "cfg", "secrets.yaml");
    expect(parse(readFileSync(config, "utf8"))).toEqual({
      provider: "sops",
      sops: { file: join(s.root, "private", "secrets.enc.yaml"), age_key_file: join(s.home, "keys", "age.txt") },
    });
    expect(mode(join(s.root, "private"))).toBe(0o700);
  });

  test("an existing age key is reused after its checks, with its public key from age-keygen -y", async () => {
    capture();
    const s = setup();
    const key = join(s.root, "my.agekey");
    writeFileSync(key, "# not a real age key\n", { mode: 0o600 });
    expect(await secretsInit(["--age-key", key], s.deps)).toBe(0);
    expect(s.keygen.map((k) => k.args)).toEqual([["-y", key]]);

    const loose = setup();
    const looseKey = join(loose.root, "loose.agekey");
    writeFileSync(looseKey, "# not a real age key\n", { mode: 0o644 });
    await expect(secretsInit(["--age-key", looseKey], loose.deps)).rejects.toThrow(/group or other permission bits/);
    expect(loose.keygen).toEqual([]);
    expect(loose.sops).toEqual([]);
  });

  test("a file directly in $HOME or the config home is refused: init won't chmod a shared directory", async () => {
    const s = setup();
    for (const args of [["--age-key", "~/keys.txt"], ["--file", join(s.home, ".config", "secrets.enc.yaml")], ["--config", "~/secrets.yaml"]]) {
      await expect(secretsInit(args, s.deps)).rejects.toThrow(/would sit directly in .*put it in a directory of its own/);
    }
    expect(s.keygen).toEqual([]);
    expect(mode(s.home)).toBe(0o700);
    expect(existsSync(join(s.home, ".config"))).toBe(false);
  });

  test("an age key path inside the checkout (private/ included) is refused before age-keygen runs", async () => {
    const s = setup();
    const e = await caught(secretsInit(["--age-key", join(s.checkout, "private", "keys.txt")], s.deps));
    expect(e.message).toMatch(/inside the hapi-factory checkout/);
    expect(s.keygen).toEqual([]);
    expect(existsSync(join(s.checkout, "private"))).toBe(false);
  });

  test("the sops file may live in the checkout's private/ (the encrypted file is backed up there)", async () => {
    capture();
    const s = setup();
    expect(await secretsInit(["--file", join(s.checkout, "private", "secrets.enc.yaml")], s.deps)).toBe(0);
    expect(existsSync(join(s.checkout, "private", "secrets.enc.yaml"))).toBe(true);
  });

  test("if sops's output isn't encrypted, or a tool fails, nothing is written", async () => {
    const s = setup();
    const plaintext: SopsRunner = async (_args, o) => ({ code: 0, stdout: o.stdin ?? "", stderr: "" });
    await expect(secretsInit([], { ...s.deps, sops: plaintext })).rejects.toThrow(/^sops's output has no sops metadata.*; nothing was written$/);
    expect(existsSync(join(s.home, ".config", "hapi", "secrets.enc.yaml"))).toBe(false);
    expect(existsSync(join(s.home, ".config", "hapi", "secrets.yaml"))).toBe(false);

    const t = setup();
    const failing: SopsRunner = async () => ({ code: 1, stdout: "", stderr: "Could not generate data key: x: y\n" });
    await expect(secretsInit([], { ...t.deps, sops: failing })).rejects.toThrow(/^sops could not encrypt the template \(exit 1\): Could not generate data key$/);
    expect(existsSync(join(t.home, ".config", "hapi"))).toBe(false);

    const u = setup();
    const keygenFails: SopsRunner = async () => ({ code: 1, stdout: "", stderr: "age-keygen: error: failed to open output file\n" });
    await expect(secretsInit([], { ...u.deps, ageKeygen: keygenFails })).rejects.toThrow(/^age-keygen could not write .*keys\.txt \(exit 1\): age-keygen/);
    expect(u.sops).toEqual([]);
  });

  test("a new key that age-keygen leaves looser than 0600 is tightened", async () => {
    capture();
    const s = setup();
    const loose: SopsRunner = async (args, o) => {
      if (args[0] === "-o") {
        writeFileSync(args[1]!, "# not a real age key\n", { mode: 0o644 });
        chmodSync(args[1]!, 0o644);
        return { code: 0, stdout: "", stderr: "" };
      }
      return s.deps.ageKeygen(args, o);
    };
    expect(await secretsInit([], { ...s.deps, ageKeygen: loose })).toBe(0);
    expect(mode(join(s.home, ".config", "sops", "age", "keys.txt"))).toBe(0o600);
  });

  test("usage errors exit 2", async () => {
    const { err } = capture();
    const s = setup();
    expect(await secretsInit(["--nope"], s.deps)).toBe(2);
    expect(await secretsInit(["--file"], s.deps)).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi secrets init [--config file] [--file file] [--age-key file]");
    expect(s.keygen).toEqual([]);
  });
});
