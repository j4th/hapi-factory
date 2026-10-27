import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { secretsInit } from "../../src/secrets/cli";
import { loadManifest, manifestNames } from "../../src/secrets/manifest";
import { passphraseOf } from "../../src/secrets/recovery";
import { recipientType, recoveryDigest } from "../../src/secrets/recipients";
import type { SopsRunner } from "../../src/secrets/providers/sops";
import { allText, capture, caught, cleanup, FAKE_AGE_DIR, fakeTools, fakeTty, mode, tempDir, tree } from "./helpers";

afterEach(cleanup);

const NAMES = manifestNames(loadManifest("stack/secrets.yaml"));

/** A temp HOME, a stand-in checkout, fake age tools and sops that record every call, and a fake terminal. */
function setup(o: { answer?: (p: number, w: string[]) => string; failRotate?: boolean } = {}) {
  const root = tempDir();
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const checkout = tempDir();
  // Shell SOPS_* settings that must not reach sops.
  const env = { HOME: home, PATH: "/usr/bin:/bin", XDG_RUNTIME_DIR: join(root, "run"), SOPS_AGE_RECIPIENTS: "age1other", SOPS_AGE_KEY: "AGE-NOT-A-KEY" };
  const tools = fakeTools();
  const t = fakeTty(o.answer ? { answer: o.answer } : {});
  const deps = {
    env,
    cwd: root,
    ageKeygen: tools.ageKeygen,
    age: tools.age,
    sops: tools.sops,
    ageDir: tools.ageDir,
    repoRoot: async () => checkout,
    tty: t.tty,
    attended: false,
    machineName: "test-box-user",
    now: () => new Date("2026-10-26T12:00:00Z"),
  };
  const cfg = join(home, ".config");
  const paths = {
    ageKey: join(cfg, "sops", "age", "keys.txt"),
    file: join(cfg, "hapi", "secrets.enc.yaml"),
    config: join(cfg, "hapi", "secrets.yaml"),
    recovery: join(cfg, "hapi", "recovery.age"),
    recipients: join(cfg, "hapi", "secrets.recipients.yaml"),
  };
  return { root, home, checkout, env, tools, t, deps, paths };
}

/** Unwrap a recovery.age with the fake age, and say whose identity it holds. */
async function recoveryIdentity(s: ReturnType<typeof setup>, file: string, words: string[]) {
  const r = await s.tools.age(["-d", "-j", "batchpass"], { env: { AGE_PASSPHRASE_FD: "3" }, stdin: readFileSync(file, "utf8"), fd3: passphraseOf(words) });
  expect(r.code).toBe(0);
  const identity = r.stdout.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"))!;
  return { identity, recipient: s.tools.recipients.get(identity) };
}

describe("hapi secrets init", () => {
  test("init encrypts to a machine key and a recovery recipient, both PQ, and writes the recipients file", async () => {
    const { out } = capture();
    const s = setup();
    expect(await secretsInit([], s.deps)).toBe(0);
    const p = s.paths;

    // In order: this machine's key and the recovery key, both in memory (age-keygen -pq, recipient via -y on stdin),
    // the words shown and confirmed, the recovery key wrapped with them, then one sops encrypt to both recipients.
    expect(s.tools.calls.map((c) => [c.tool, ...c.args])).toEqual([
      ["age-keygen", "-pq"],
      ["age-keygen", "-y"],
      ["age-keygen", "-pq"],
      ["age-keygen", "-y"],
      ["age", "-e", "-a", "-j", "batchpass"],
      ["sops", "--config", "/dev/null", "encrypt", "--age", expect.any(String), "--input-type", "yaml", "--output-type", "yaml", "--filename-override", p.file],
    ]);
    expect(s.t.shown.length).toBe(1);
    expect(s.t.prompts.filter((q) => q.startsWith("Word ")).length).toBe(2);

    const recipients = parse(readFileSync(p.recipients, "utf8"));
    expect(recipients).toEqual({
      pq: true,
      recipients: [
        { name: "test-box-user", kind: "machine", recipient: expect.any(String), added: "2026-10-26" },
        { name: "recovery", kind: "recovery", recipient: expect.any(String), added: "2026-10-26", recovery_age_sha256: recoveryDigest(readFileSync(p.recovery)) },
      ],
    });
    const [machine, recovery] = recipients.recipients.map((r: { recipient: string }) => r.recipient);
    expect([recipientType(machine), recipientType(recovery)]).toEqual(["pq", "pq"]);

    // The store is encrypted to exactly those two; the template went in on stdin: every manifest name, each "".
    const enc = s.tools.calls.at(-1)!;
    expect(enc.args[4]).toBe(`${machine},${recovery}`);
    expect(enc.env).toEqual({ PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`, HOME: s.home, SOPS_DISABLE_VERSION_CHECK: "1", GPG_AGENT_INFO: "" });
    expect(parse(enc.stdin!)).toEqual(Object.fromEntries(NAMES.map((n) => [n, ""])));
    expect(s.tools.readStore(p.file)).toEqual({ values: Object.fromEntries(NAMES.map((n) => [n, ""])), listed: [machine, recovery] });

    // The machine key file opens as the machine recipient; recovery.age opens with the shown words as the recovery recipient.
    const key = readFileSync(p.ageKey, "utf8");
    expect(s.tools.recipients.get(key.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-PQ-1"))!)).toBe(machine);
    expect((await recoveryIdentity(s, p.recovery, s.t.shown[0]!)).recipient).toBe(recovery);
    expect(readFileSync(p.recovery, "utf8")).toStartWith("-----BEGIN AGE ENCRYPTED FILE-----\n");

    expect(parse(readFileSync(p.config, "utf8"))).toEqual({ provider: "sops", sops: { file: p.file, age_key_file: p.ageKey } });
    for (const f of Object.values(p)) expect([relative(s.root, f), mode(f)]).toEqual([relative(s.root, f), 0o600]);
    for (const d of [join(s.home, ".config", "hapi"), join(s.home, ".config", "sops", "age")]) expect(mode(d)).toBe(0o700);
    expect(tree(s.root)).toEqual(Object.values(p).map((f) => relative(s.root, f)).sort());

    const text = out.join("\n");
    expect(text).toContain(`created the age key ${p.ageKey} (this machine: test-box-user)`);
    expect(text).toContain(`wrote ${p.recovery}`);
    expect(text).toContain("next: mise run secrets:drill");
    expect(text).not.toContain("back up");
  });

  test("init writes nothing if the word confirmation fails or any step aborts", async () => {
    capture();
    const wrong = setup({ answer: () => "zoo" });
    await expect(secretsInit([], wrong.deps)).rejects.toThrow(/^the recovery words weren't confirmed after 3 tries; nothing was written/);
    expect(wrong.t.shown.length).toBe(3);
    expect(tree(wrong.root)).toEqual([]);
    expect(existsSync(join(wrong.home, ".config"))).toBe(false);
    expect(wrong.tools.calls.filter((c) => c.tool !== "age-keygen")).toEqual([]);

    const fail = (r: { code: number; stdout?: string; stderr: string }): SopsRunner => async () => ({ stdout: "", ...r });
    const cases: [string, (s: ReturnType<typeof setup>) => Record<string, unknown>, RegExp][] = [
      ["sops fails", () => ({ sops: fail({ code: 1, stderr: "Could not generate data key: x: y\n" }) }), /^sops could not encrypt the template \(exit 1\): Could not generate data key$/],
      ["sops's output isn't encrypted", () => ({ sops: (async (_a, o) => ({ code: 0, stdout: String(o.stdin), stderr: "" })) as SopsRunner }), /^sops's output has no sops metadata.*; nothing was written$/],
      ["wrapping fails", () => ({ age: fail({ code: 1, stderr: "age: error: batchpass plugin: x\n" }) }), /^age could not wrap the recovery key \(exit 1\)/],
      ["age-keygen fails", () => ({ ageKeygen: fail({ code: 1, stderr: "age-keygen: error: x\n" }) }), /^age-keygen could not make a key \(exit 1\)/],
      ["no terminal for the words", () => ({ tty: null }), /needs a terminal to show the recovery words/],
    ];
    for (const [what, override, error] of cases) {
      const s = setup();
      const e = await caught(secretsInit([], { ...s.deps, ...override(s) }));
      expect([what, e.message]).toEqual([what, expect.stringMatching(error)]);
      expect([what, tree(s.root)]).toEqual([what, []]);
    }
  });

  test("init refuses coinciding paths and never replaces a file created after its checks (no-replace write)", async () => {
    capture();
    const s = setup();
    for (const args of [
      ["--file", "x/same.yaml", "--config", "x/same.yaml"],
      ["--file", "x/keys.txt", "--age-key", "x/keys.txt"],
      ["--file", "x/recovery.age"],
      ["--file", "x/secrets.enc.yaml", "--config", "x/secrets.recipients.yaml"],
      ["--config", "x/recovery.age", "--file", "x/secrets.enc.yaml"],
      ["--age-key", "x/../x/secrets.recipients.yaml", "--file", "x/secrets.enc.yaml"],
    ]) {
      const e = await caught(secretsInit(args, s.deps));
      expect([args, e.message]).toEqual([args, expect.stringMatching(/^the (config|store|age key|recovery\.age|recipients file) and the (config|store|age key|recovery\.age|recipients file) are the same file \(.*\): give each its own path$/)]);
    }
    expect(s.tools.calls).toEqual([]);
    expect(tree(s.root)).toEqual([]);

    // A config that appears after the checks (here: while sops runs) is never replaced, and what init wrote is rolled back.
    const r = setup();
    const racing: SopsRunner = async (args, o) => {
      mkdirSync(join(r.home, ".config", "hapi"), { recursive: true, mode: 0o700 });
      writeFileSync(r.paths.config, "keep me\n");
      return r.tools.sops(args, o);
    };
    const e = await caught(secretsInit([], { ...r.deps, sops: racing }));
    expect(e.message).toBe(`${r.paths.config} already exists (it appeared after hapi checked), and hapi never replaces it; nothing was written`);
    expect(readFileSync(r.paths.config, "utf8")).toBe("keep me\n");
    expect(tree(r.root)).toEqual([relative(r.root, r.paths.config)]);
  });

  test("the words and the plaintext recovery identity never reach argv, env, a file or an error", async () => {
    const { out, err } = capture();
    const s = setup();
    expect(await secretsInit([], s.deps)).toBe(0);
    const calls = [...s.tools.calls];
    const words = s.t.shown[0]!;
    const { identity } = await recoveryIdentity(s, s.paths.recovery, words);
    expect(identity).toStartWith("AGE-SECRET-KEY-PQ-1");
    const secrets = [passphraseOf(words), words.join(" "), words.join(""), identity];

    // Every tool call: the identity only ever goes on stdin, the words only on fd 3.
    for (const c of calls) {
      const argvEnv = JSON.stringify([c.args, c.env]);
      for (const x of secrets) expect([c.tool, c.args[0], argvEnv.includes(x)]).toEqual([c.tool, c.args[0], false]);
    }
    expect(calls.filter((c) => c.fd3 !== undefined).map((c) => [c.tool, c.fd3])).toEqual([["age", passphraseOf(words)]]);
    // Every file written (the machine key holds only the machine identity), stdout and stderr.
    for (const x of secrets) {
      expect(allText(s.root).includes(x)).toBe(false);
      expect(allText(s.checkout).includes(x)).toBe(false);
      expect([...out, ...err].join("\n").includes(x)).toBe(false);
    }

    // And an error after the words exist doesn't carry them either.
    const f = setup();
    const e = await caught(secretsInit([], { ...f.deps, sops: async () => ({ code: 1, stdout: identity, stderr: `Error: ${identity}: ${passphraseOf(words)}\n` }) }));
    for (const x of secrets) expect(e.message.includes(x)).toBe(false);
  });

  test("init never overwrites an existing config, store, recovery.age or recipients file", async () => {
    capture();
    for (const which of ["config", "file", "recovery", "recipients"] as const) {
      const s = setup();
      const existing = s.paths[which];
      mkdirSync(join(existing, ".."), { recursive: true });
      writeFileSync(existing, "keep me\n");
      const e = await caught(secretsInit([], s.deps));
      expect(e.message).toBe(`${existing} already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`);
      expect(readFileSync(existing, "utf8")).toBe("keep me\n");
      expect(s.tools.calls).toEqual([]);
      expect(tree(s.home)).toEqual([relative(s.home, existing)]);
    }
  });

  test("--config, --file, --age-key and --name choose the paths and name; recovery.age and the recipients file go beside the store", async () => {
    capture();
    const s = setup();
    expect(await secretsInit(["--config", "cfg/secrets.yaml", "--file", "private/secrets.enc.yaml", "--age-key", "~/keys/age.txt", "--name", "lab-vm"], s.deps)).toBe(0);
    const config = join(s.root, "cfg", "secrets.yaml");
    expect(parse(readFileSync(config, "utf8"))).toEqual({
      provider: "sops",
      sops: { file: join(s.root, "private", "secrets.enc.yaml"), age_key_file: join(s.home, "keys", "age.txt") },
    });
    expect(mode(join(s.root, "private"))).toBe(0o700);
    expect(existsSync(join(s.root, "private", "recovery.age"))).toBe(true);
    expect(parse(readFileSync(join(s.root, "private", "secrets.recipients.yaml"), "utf8")).recipients[0].name).toBe("lab-vm");
    await expect(secretsInit(["--name", "Not A Name", "--file", "other/s.enc.yaml", "--config", "other/c.yaml"], s.deps)).rejects.toThrow(/--name must match \^\[a-z0-9\]\[a-z0-9-\]\{0,62\}\$/);
  });

  test("an existing age key is reused after its checks, only if its kind matches (post-quantum by default, --classic otherwise)", async () => {
    capture();
    const s = setup();
    const made = await s.tools.ageKeygen(["-pq"], { env: {} });
    const key = join(s.root, "my.agekey");
    writeFileSync(key, made.stdout, { mode: 0o600 });
    s.tools.calls.length = 0;
    expect(await secretsInit(["--age-key", key], s.deps)).toBe(0);
    expect(s.tools.calls.filter((c) => c.tool === "age-keygen").map((c) => c.args)).toEqual([["-y", key], ["-pq"], ["-y"]]);

    // A classic key and a post-quantum store would be a mix: refused, with the way out.
    const c = setup();
    const classic = await c.tools.ageKeygen([], { env: {} });
    const classicKey = join(c.root, "classic.agekey");
    writeFileSync(classicKey, classic.stdout, { mode: 0o600 });
    const e = await caught(secretsInit(["--age-key", classicKey], c.deps));
    expect(e.message).toMatch(/^the age key .*classic\.agekey is classic \(X25519\), and this store would be post-quantum \(the default\): hapi won't mix them\. Give --age-key a new path for a new post-quantum key, or pass --classic/);
    expect(tree(c.root)).toEqual(["classic.agekey"]);
    // With --classic, every recipient is classic and the recipients file says pq: false.
    expect(await secretsInit(["--age-key", classicKey, "--classic"], c.deps)).toBe(0);
    const file = parse(readFileSync(join(c.home, ".config", "hapi", "secrets.recipients.yaml"), "utf8"));
    expect(file.pq).toBe(false);
    expect(file.recipients.map((r: { recipient: string }) => recipientType(r.recipient))).toEqual(["classic", "classic"]);

    const loose = setup();
    const looseKey = join(loose.root, "loose.agekey");
    writeFileSync(looseKey, made.stdout, { mode: 0o644 });
    await expect(secretsInit(["--age-key", looseKey], loose.deps)).rejects.toThrow(/group or other permission bits/);
    expect(loose.tools.calls).toEqual([]);
  });

  test("a file directly in $HOME or the config home is refused: init won't chmod a shared directory", async () => {
    const s = setup();
    for (const args of [["--age-key", "~/keys.txt"], ["--file", join(s.home, ".config", "secrets.enc.yaml")], ["--config", "~/secrets.yaml"]]) {
      await expect(secretsInit(args, s.deps)).rejects.toThrow(/would sit directly in .*put it in a directory of its own/);
    }
    expect(s.tools.calls).toEqual([]);
    expect(mode(s.home)).toBe(0o700);
    expect(existsSync(join(s.home, ".config"))).toBe(false);
  });

  test("an age key path inside the checkout (private/ included) is refused before anything runs", async () => {
    const s = setup();
    const e = await caught(secretsInit(["--age-key", join(s.checkout, "private", "keys.txt")], s.deps));
    expect(e.message).toMatch(/inside the hapi-factory checkout/);
    expect(s.tools.calls).toEqual([]);
    expect(existsSync(join(s.checkout, "private"))).toBe(false);
  });

  test("the store, recovery.age and the recipients file may live in the checkout's private/ (backed up there)", async () => {
    capture();
    const s = setup();
    expect(await secretsInit(["--file", join(s.checkout, "private", "secrets.enc.yaml")], s.deps)).toBe(0);
    expect(tree(join(s.checkout, "private"))).toEqual(["recovery.age", "secrets.enc.yaml", "secrets.recipients.yaml"]);
  });

  test("--no-confirm (tests and CI fixtures only) is refused when a person is at the terminal", async () => {
    const { err } = capture();
    const s = setup();
    await expect(secretsInit(["--no-confirm"], { ...s.deps, attended: true })).rejects.toThrow(/--no-confirm is for tests and CI fixtures only/);
    expect(s.tools.calls).toEqual([]);
    // Unattended, the words are shown without the check.
    expect(await secretsInit(["--no-confirm"], s.deps)).toBe(0);
    expect([s.t.shown.length, s.t.prompts]).toEqual([1, []]);
    // With no terminal at all, the words go nowhere, and it says so.
    const n = setup();
    expect(await secretsInit(["--no-confirm"], { ...n.deps, tty: null })).toBe(0);
    expect(err.join("\n")).toMatch(/warning: no terminal, so the recovery words were not shown: this store's recovery\.age can't be opened/);
  });

  test("usage errors exit 2", async () => {
    const { err } = capture();
    const s = setup();
    expect(await secretsInit(["--nope"], s.deps)).toBe(2);
    expect(await secretsInit(["--file"], s.deps)).toBe(2);
    expect(await secretsInit(["--classic", "x"], s.deps)).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi secrets init [--config file] [--file file] [--age-key file] [--name name] [--classic] [--no-confirm]");
    expect(s.tools.calls).toEqual([]);
  });
});
