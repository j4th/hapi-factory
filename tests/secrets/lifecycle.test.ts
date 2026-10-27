import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { secretsAddMachine, secretsCheck, secretsDrill, secretsEdit, secretsInit, secretsJoin, secretsNewRecovery, secretsRecover, secretsResolve, secretsRevoke } from "../../src/secrets/cli";
import { DRIFT_FIX, loadStore, recipientReport } from "../../src/secrets/lifecycle";
import { lockPath } from "../../src/secrets/store-files";
import { loadManifest, manifestNames } from "../../src/secrets/manifest";
import { passphraseOf } from "../../src/secrets/recovery";
import { shortRecipient } from "../../src/secrets/recipients";
import {
  allText,
  capture,
  caught,
  cleanup,
  FAKE_AGE_DIR,
  FAKE_RECIPIENT,
  FAKE_RECOVERY_RECIPIENT,
  fakeRecipient,
  fakeTools,
  fakeTty,
  fullStore,
  mode,
  recipientsFileText,
  sopsConfig,
  sopsFileText,
  sopsStore,
  tempDir,
  tree,
} from "./helpers";

afterEach(cleanup);

const NAMES = manifestNames(loadManifest("stack/secrets.yaml"));
type Tools = ReturnType<typeof fakeTools>;

/**
 * One machine (or user): its own HOME, XDG_RUNTIME_DIR, config and age key at
 * the defaults under that HOME, a fake terminal, and the shared fake tools.
 */
function machine(root: string, name: string, tools: Tools, typed: string[] = []) {
  const home = join(root, name, "home");
  const xdg = join(root, name, "run");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(xdg, { recursive: true, mode: 0o700 });
  const t = fakeTty({ typed });
  const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: "/usr/bin:/bin" };
  const deps = {
    env,
    cwd: join(root, name),
    ageKeygen: tools.ageKeygen,
    age: tools.age,
    sops: tools.sops,
    ageDir: tools.ageDir,
    repoRoot: async () => join(root, "checkout"),
    tty: t.tty,
    attended: false,
    machineName: name,
    now: () => new Date("2026-10-27T09:00:00Z"),
  };
  return {
    name,
    home,
    xdg,
    env,
    deps,
    t,
    config: join(home, ".config", "hapi", "secrets.yaml"),
    key: join(home, ".config", "sops", "age", "keys.txt"),
    store: join(root, name, "private", "secrets.enc.yaml"),
  };
}

/** Machine `a` runs init with its store in its private/; returns the words and the recipients. */
async function initialised(o: { failRotate?: boolean; firstKey?: number } = {}) {
  const root = tempDir();
  mkdirSync(join(root, "checkout"));
  const tools = fakeTools(o);
  const a = machine(root, "machine-a", tools);
  expect(await secretsInit(["--file", a.store], a.deps)).toBe(0);
  const words = a.t.shown[0]!;
  const file = () => parse(readFileSync(join(dirname(a.store), "secrets.recipients.yaml"), "utf8")) as { pq: boolean; recipients: { name: string; kind: string; recipient: string; added: string }[] };
  const recipientOf = (name: string) => file().recipients.find((r) => r.name === name)!.recipient;
  return { root, tools, a, words, file, recipientOf };
}

/** Copy machine `from`'s private/ (store, recovery.age, recipients file) to machine `to`, as a git pull of private/ would. */
function copyPrivate(from: { store: string }, to: { store: string }) {
  rmSync(dirname(to.store), { recursive: true, force: true });
  cpSync(dirname(from.store), dirname(to.store), { recursive: true });
}

/** Fill the store with fake values, encrypted to the same recipients (as `secrets:edit` would). */
async function fill(tools: Tools, store: string, values = fullStore()) {
  const { listed } = tools.readStore(store);
  const r = await tools.sops(["--config", "/dev/null", "encrypt", "--age", listed.join(","), "--input-type", "yaml", "--output-type", "yaml", "--filename-override", store], {
    env: {},
    stdin: stringify(values),
  });
  writeFileSync(store, r.stdout);
}

/** The identity line of an age identity file's text. */
const idLine = (text: string) => text.split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-"))!;
const sopsCalls = (tools: Tools, cmd: string) => tools.calls.filter((c) => c.tool === "sops" && c.args[2] === cmd);
const ROTATE = ["--config", "/dev/null", "rotate", "-i", "--input-type", "yaml", "--output-type", "yaml"];
/** The words as they could leak: the passphrase age gets (joined by "-") and as typed (joined by spaces). Single words are ordinary English. */
const phrases = (words: string[]) => [passphraseOf(words), words.join(" ")];
/** Every file under `dir`, path -> bytes. */
const snapshot = (dir: string) => tree(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
/** An `edit` runner that records each run and changes nothing. */
function editor() {
  const runs: string[][] = [];
  return { runs, interactive: async (_cmd: string, args: string[]) => (runs.push(args), 0) };
}

describe("hapi secrets join and add-machine", () => {
  test("join creates a key and config without touching the store, and prints the add-machine command", async () => {
    const { out } = capture();
    const { root, tools, a } = await initialised();
    const b = machine(root, "machine-b", tools);
    copyPrivate(a, b);
    const before = tree(dirname(b.store)).map((f) => [f, readFileSync(join(dirname(b.store), f), "utf8")]);
    tools.calls.length = 0;
    out.length = 0;

    expect(await secretsJoin(["--store", b.store], b.deps)).toBe(0);
    // This machine's key: a new post-quantum one, 0600 in a 0700 directory. The config points at the copy of the store.
    expect(tools.calls.map((c) => [c.tool, ...c.args])).toEqual([["age-keygen", "-pq"], ["age-keygen", "-y"]]);
    const identity = readFileSync(b.key, "utf8").split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-PQ-1"))!;
    const recipient = tools.recipients.get(identity)!;
    expect([mode(b.key), mode(dirname(b.key))]).toEqual([0o600, 0o700]);
    expect(parse(readFileSync(b.config, "utf8"))).toEqual({ provider: "sops", sops: { file: b.store, age_key_file: b.key } });
    // The store, recovery.age and the recipients file are untouched; sops never ran.
    expect(tree(dirname(b.store)).map((f) => [f, readFileSync(join(dirname(b.store), f), "utf8")])).toEqual(before);
    expect(sopsCalls(tools, "rotate")).toEqual([]);
    const text = out.join("\n");
    expect(text).toContain(`this machine's public key (machine-b): ${recipient}`);
    expect(text).toContain(`mise run secrets:add-machine -- --name machine-b --recipient ${recipient}`);

    // Never overwritten: a second join stops at the config. A name already in the recipients file is refused before anything is written.
    await expect(secretsJoin(["--store", b.store], b.deps)).rejects.toThrow(/secrets\.yaml already exists, and hapi secrets join never overwrites anything/);
    const c = machine(root, "machine-c", tools);
    copyPrivate(a, c);
    await expect(secretsJoin(["--store", c.store, "--name", "machine-a"], c.deps)).rejects.toThrow(/machine-a is already a recipient of .*: pick another --name/);
    expect(existsSync(c.config) || existsSync(c.key)).toBe(false);
    // An existing classic key can't join a post-quantum store.
    const classic = await tools.ageKeygen([], { env: {} });
    mkdirSync(dirname(c.key), { recursive: true, mode: 0o700 });
    writeFileSync(c.key, classic.stdout, { mode: 0o600 });
    await expect(secretsJoin(["--store", c.store], c.deps)).rejects.toThrow(/is classic \(X25519\), and this store is post-quantum: hapi won't mix them/);
    expect(existsSync(c.config)).toBe(false);
  });

  test("add-machine and revoke go through rotate with --config /dev/null and keep the recipients file in step; revoke refuses the last machine or the only recovery", async () => {
    const { out, err } = capture();
    const { root, tools, a, file, recipientOf } = await initialised();
    const b = machine(root, "machine-b", tools);
    copyPrivate(a, b);
    await secretsJoin(["--store", b.store], b.deps);
    const rB = tools.recipients.get(idLine(readFileSync(b.key, "utf8")))!;
    const [rA, rR] = [recipientOf("machine-a"), recipientOf("recovery")];
    tools.calls.length = 0;

    expect(await secretsAddMachine(["--name", "machine-b", "--recipient", rB], a.deps)).toBe(0);
    const [rotate] = sopsCalls(tools, "rotate");
    expect(rotate!.args.slice(0, -1)).toEqual([...ROTATE, "--add-age", rB]);
    // sops works on a temp copy beside the store, which then replaces it in one rename: nothing is left behind.
    expect(dirname(rotate!.args.at(-1)!)).toBe(dirname(a.store));
    expect(rotate!.args.at(-1)).toMatch(/\/\.secrets\.enc\.yaml\.[0-9a-f-]{36}\.tmp$/);
    expect(rotate!.env.SOPS_AGE_KEY_FILE).toBe(a.key);
    expect(tree(dirname(a.store))).toEqual(["recovery.age", "secrets.enc.yaml", "secrets.recipients.yaml"]);
    expect(tools.readStore(a.store).listed).toEqual([rA, rR, rB]);
    expect(file().recipients.at(-1)).toEqual({ name: "machine-b", kind: "machine", recipient: rB, added: "2026-10-27" });
    expect(mode(a.store)).toBe(0o600);
    expect(out.join("\n")).toContain("added machine-b");

    // Refused before sops runs: a name or recipient already there, a malformed recipient, a classic one in a PQ store.
    tools.calls.length = 0;
    for (const [args, error] of [
      [["--name", "machine-b", "--recipient", fakeRecipient(999)], /machine-b is already a recipient/],
      [["--name", "other", "--recipient", rB], /that recipient is already in the store, as machine-b/],
      [["--name", "other", "--recipient", "age1notakey"], /--recipient is not an age public key/],
      [["--name", "other", "--recipient", fakeRecipient(999, false)], /--recipient is classic \(X25519\), and this store is post-quantum: hapi won't mix them/],
      [["--name", "Bad Name", "--recipient", fakeRecipient(999)], /--name must match/],
    ] as const) {
      await expect(secretsAddMachine([...args], a.deps)).rejects.toThrow(error);
    }
    expect(tools.calls.filter((c) => c.tool === "sops")).toEqual([]);

    // Machine b (now a recipient, with the updated store) revokes machine a.
    copyPrivate(a, b);
    out.length = 0;
    expect(await secretsRevoke(["--name", "machine-a"], b.deps)).toBe(0);
    expect(sopsCalls(tools, "rotate").at(-1)!.args.slice(0, -1)).toEqual([...ROTATE, "--rm-age", rA]);
    expect(tools.readStore(b.store).listed).toEqual([rR, rB]);
    expect(parse(readFileSync(join(dirname(b.store), "secrets.recipients.yaml"), "utf8")).recipients.map((r: { name: string }) => r.name)).toEqual(["recovery", "machine-b"]);
    expect(out.join("\n")).toContain(
      "if this key may be compromised, also reissue every credential in the store: copies of the store in git history stay readable by the removed key forever",
    );
    // Machine a's key no longer opens the new store.
    copyPrivate(b, a);
    await expect(secretsCheck([], a.deps)).rejects.toThrow(/sops could not decrypt .* \(exit 128\)/);

    // The last machine and the only recovery recipient can't be revoked.
    await expect(secretsRevoke(["--name", "machine-b"], b.deps)).rejects.toThrow(/machine-b is the last machine key: add another first \(join, then add-machine\)/);
    await expect(secretsRevoke(["--name", "recovery"], b.deps)).rejects.toThrow(/recovery is the only recovery recipient: use `hapi secrets new-recovery` to replace it/);
    await expect(secretsRevoke(["--name", "nobody"], b.deps)).rejects.toThrow(/no recipient named nobody/);
    expect(err).toEqual([]);
  });

  test("a failed rotate leaves the store and the recipients file untouched, and no temp file", async () => {
    capture();
    const { tools, a } = await initialised({ failRotate: true });
    const before = tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")]);
    await expect(secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).rejects.toThrow(
      /^sops could not change the recipients of .*secrets\.enc\.yaml \(exit 1\): Could not generate data key; nothing was changed$/,
    );
    expect(tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")])).toEqual(before);
    expect(sopsCalls(tools, "rotate").length).toBe(1);
  });
});

describe("hapi secrets recover, drill and new-recovery", () => {
  test("recover: words → SOPS_AGE_KEY only in the sops child env → rotate --add-age self", async () => {
    const { out, err } = capture();
    const { root, tools, a, words, file, recipientOf } = await initialised();
    // Machine c has only the store, recovery.age, the recipients file and the words.
    const c = machine(root, "machine-c", tools, [words.join(" ")]);
    copyPrivate(a, c);
    tools.calls.length = 0;

    expect(await secretsRecover(["--store", c.store], c.deps)).toBe(0);
    expect(tools.calls.map((x) => [x.tool, ...x.args.slice(0, 4)])).toEqual([
      ["age-keygen", "-pq"],
      ["age-keygen", "-y"],
      ["age", "-d", "-j", "batchpass"],
      ["age-keygen", "-y"],
      ["sops", ...ROTATE.slice(0, 4)],
    ]);
    const identity = idLine(tools.calls[3]!.stdin!);
    expect(tools.recipients.get(identity)).toBe(recipientOf("recovery"));
    const rC = tools.recipients.get(idLine(readFileSync(c.key, "utf8")))!;
    const rotate = tools.calls[4]!;
    expect(rotate.args.slice(0, -1)).toEqual([...ROTATE, "--add-age", rC]);
    // The recovery identity is in that one child's env, as SOPS_AGE_KEY, and nowhere else: not argv, not another env, not a file, not output.
    expect(rotate.env).toEqual({ PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`, HOME: c.home, SOPS_AGE_KEY: identity, SOPS_DISABLE_VERSION_CHECK: "1", GPG_AGENT_INFO: "" });
    for (const x of tools.calls.filter((call) => call !== rotate)) expect(JSON.stringify([x.args, x.env]).includes(identity)).toBe(false);
    expect(rotate.args.join(" ").includes(identity)).toBe(false);
    expect(allText(root).includes(identity)).toBe(false);
    expect([...out, ...err].join("\n").includes(identity)).toBe(false);
    // The words reach age on fd 3 only: never a tool's argv or env, a file under any machine's HOME or private/, or output.
    expect(tools.calls[2]!.fd3).toBe(passphraseOf(words));
    for (const phrase of phrases(words)) {
      for (const x of tools.calls) expect(JSON.stringify([x.args, x.env]).includes(phrase)).toBe(false);
      expect(allText(root).includes(phrase)).toBe(false);
      expect([...out, ...err].join("\n").includes(phrase)).toBe(false);
    }

    // Machine c is now a recipient, in the store and the recipients file, and has its config: it works without the words.
    expect(tools.readStore(c.store).listed).toContain(rC);
    expect(parse(readFileSync(join(dirname(c.store), "secrets.recipients.yaml"), "utf8")).recipients.at(-1)).toEqual({
      name: "machine-c",
      kind: "machine",
      recipient: rC,
      added: "2026-10-27",
    });
    expect(parse(readFileSync(c.config, "utf8"))).toEqual({ provider: "sops", sops: { file: c.store, age_key_file: c.key } });
    expect(await secretsCheck([], { ...c.deps, tty: null })).toBe(1); // every value is still empty, but it opens
    expect(out.join("\n")).toContain("recovered: machine-c can open the store now, without the words");
    expect(file().recipients.length).toBe(2); // a's copy is untouched

    // Wrong words: nothing changes in the store.
    const d = machine(root, "machine-d", tools, [[...words].reverse().join(" ")]);
    copyPrivate(a, d);
    const before = readFileSync(d.store, "utf8");
    await expect(secretsRecover(["--store", d.store], d.deps)).rejects.toThrow(/the words don't open .*recovery\.age: check each word and their order/);
    expect(readFileSync(d.store, "utf8")).toBe(before);
  });

  test("drill decrypts with an isolated HOME and only the recovery identity, and prints no value", async () => {
    const { out, err } = capture();
    const { root, tools, a, words } = await initialised();
    await fill(tools, a.store);
    a.t.typed.push(words.join(" "));
    const before = tree(dirname(dirname(a.store)));
    tools.calls.length = 0;

    expect(await secretsDrill([], a.deps)).toBe(0);
    expect(out).toContain(`recovery works: ${NAMES.length} names readable`);
    const [decrypt] = sopsCalls(tools, "decrypt");
    const tmp = decrypt!.env.HOME!;
    expect(tmp.startsWith(join(a.xdg, "hapi", "drill-"))).toBe(true);
    const identity = idLine(tools.calls.find((c) => c.tool === "age-keygen")!.stdin!);
    expect(decrypt!.env).toEqual({ PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`, HOME: tmp, XDG_CONFIG_HOME: tmp, SOPS_AGE_KEY: identity, SOPS_DISABLE_VERSION_CHECK: "1", GPG_AGENT_INFO: "" });
    expect(decrypt!.args).toEqual(["--config", "/dev/null", "decrypt", "--input-type", "yaml", "--output-type", "json", a.store]);
    // The temp dir is gone, nothing else was written, and no value was printed.
    expect(existsSync(tmp)).toBe(false);
    expect(readdirSync(join(a.xdg, "hapi"))).toEqual(["locks"]); // and the lock is released
    expect(readdirSync(join(a.xdg, "hapi", "locks"))).toEqual([]);
    expect(tree(dirname(dirname(a.store)))).toEqual(before);
    expect([...out, ...err].join("\n")).not.toContain("fake-hapi");
    // The recovery identity is in the decrypt child's env as SOPS_AGE_KEY and nowhere else; the words reach age on fd 3 only.
    for (const x of tools.calls.filter((c) => c !== decrypt)) expect(JSON.stringify([x.args, x.env]).includes(identity)).toBe(false);
    expect(decrypt!.args.join(" ").includes(identity)).toBe(false);
    expect(tools.calls.find((c) => c.tool === "age")!.fd3).toBe(passphraseOf(words));
    for (const secret of [identity, ...phrases(words)]) {
      expect(allText(root).includes(secret)).toBe(false);
      expect([...out, ...err].join("\n").includes(secret)).toBe(false);
    }
    for (const phrase of phrases(words)) for (const x of tools.calls) expect(JSON.stringify([x.args, x.env]).includes(phrase)).toBe(false);

    // Wrong words fail, and still leave nothing behind.
    a.t.typed.push([...words].reverse().join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(/the words don't open/);
    expect(readdirSync(join(a.xdg, "hapi"))).toEqual(["locks"]); // and the lock is released
    expect(readdirSync(join(a.xdg, "hapi", "locks"))).toEqual([]);
  });

  test("new-recovery adds a new recovery recipient, then removes the old, and replaces recovery.age; old words stop working", async () => {
    const { out } = capture();
    const { tools, a, words, recipientOf, file } = await initialised();
    const oldR = recipientOf("recovery");
    const oldFile = readFileSync(join(dirname(a.store), "recovery.age"), "utf8");
    tools.calls.length = 0;

    expect(await secretsNewRecovery([], a.deps)).toBe(0);
    const newWords = a.t.shown.at(-1)!;
    expect(newWords).not.toEqual(words);
    const newR = recipientOf("recovery");
    expect(newR).not.toBe(oldR);
    expect(sopsCalls(tools, "rotate").map((c) => c.args.slice(0, -1))).toEqual([
      [...ROTATE, "--add-age", newR],
      [...ROTATE, "--rm-age", oldR],
    ]);
    expect(tools.readStore(a.store).listed).toEqual([recipientOf("machine-a"), newR]);
    expect(file().recipients.map((r) => [r.name, r.kind])).toEqual([["machine-a", "machine"], ["recovery", "recovery"]]);
    expect(readFileSync(join(dirname(a.store), "recovery.age"), "utf8")).not.toBe(oldFile);
    expect(mode(join(dirname(a.store), "recovery.age"))).toBe(0o600);
    expect(out.join("\n")).toContain("old copies of the store and of recovery.age");

    a.t.typed.push(newWords.join(" "));
    expect(await secretsDrill([], a.deps)).toBe(0);
    a.t.typed.push(words.join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(/the words don't open/);
  });

  test("a new-recovery whose rotate fails leaves recovery.age, the store and the recipients file as they were", async () => {
    capture();
    const { a } = await initialised({ failRotate: true });
    const before = tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")]);
    await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(/sops could not change the recipients/);
    expect(tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")])).toEqual(before);
  });

  test("a new-recovery that fails after recovery.age and the store are replaced puts both back byte for byte", async () => {
    capture();
    const { tools, a, words } = await initialised();
    await fill(tools, a.store);
    const dir = dirname(a.store);
    const recipientsFile = join(dir, "secrets.recipients.yaml");
    const bytes = () => ({ store: readFileSync(a.store), recovery: readFileSync(join(dir, "recovery.age")), recipients: readFileSync(recipientsFile) });
    const before = bytes();
    // Once sops has rotated the copy, the recipients file becomes a directory, so its rewrite, commit's last step, fails:
    // by then the new recovery.age is written and the rotated store renamed over the old one.
    a.deps.sops = async (args, o) => {
      const r = await tools.sops(args, o);
      if (args.includes("--rm-age")) {
        rmSync(recipientsFile);
        mkdirSync(recipientsFile);
        writeFileSync(join(recipientsFile, "in-the-way"), "");
      }
      return r;
    };
    await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(/secrets\.recipients\.yaml/);
    expect(sopsCalls(tools, "rotate").length).toBe(2); // the add and the rm both ran: the failure came after them
    // recovery.age and the store are as they were, byte for byte, and no temp file or lock is left.
    expect(readFileSync(a.store).equals(before.store)).toBe(true);
    expect(readFileSync(join(dir, "recovery.age")).equals(before.recovery)).toBe(true);
    expect(tree(dir)).toEqual(["recovery.age", "secrets.enc.yaml", "secrets.recipients.yaml/in-the-way"]);
    // With the recipients file back, the store and it agree, and the old words still open the store.
    rmSync(recipientsFile, { recursive: true });
    writeFileSync(recipientsFile, before.recipients);
    await expect(loadStore(a.store)).resolves.toBeDefined();
    a.deps.sops = tools.sops;
    a.t.typed.push(words.join(" "));
    expect(await secretsDrill([], a.deps)).toBe(0);
  });
});

describe("an interrupted command leaves a state check reports", () => {
  const FILES = ["secrets.enc.yaml", "recovery.age", "secrets.recipients.yaml"];

  test("new-recovery renames the store, then recovery.age, then the recipients file: killed after any of them, check reports it", async () => {
    capture();
    const { tools, a, words } = await initialised();
    await fill(tools, a.store);
    const dir = dirname(a.store);
    const state = () => Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dir, f))]));
    // What a kill (SIGKILL, a power cut) right after each rename in the store's directory would leave on disk.
    const states = [state()];
    const order: string[] = [];
    const realRename = fsp.rename;
    const spy = spyOn(fsp, "rename").mockImplementation((async (from: string, to: string) => {
      await realRename(from, to);
      if (dirname(to) === dir) {
        order.push(basename(to));
        states.push(state());
      }
    }) as typeof fsp.rename);
    try {
      expect(await secretsNewRecovery([], a.deps)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(order).toEqual(FILES);
    // Each state, alone in a directory, as `check` sees it: the old state and the new are whole; the two between are reported.
    const reports = [];
    for (const st of states) {
      const d = tempDir();
      for (const f of FILES) writeFileSync(join(d, f), st[f]!);
      reports.push(await recipientReport(join(d, "secrets.enc.yaml")));
    }
    expect(reports.map((r) => r.errors.length > 0)).toEqual([false, true, true, false]);
    // Killed after the store's rename: drift, both ways (the new recovery recipient isn't listed, the old one isn't in the store).
    expect(reports[1]!.errors.join("\n")).toMatch(/the store is encrypted to age1pq1.*, which the recipients file doesn't list/);
    expect(reports[1]!.errors.join("\n")).toMatch(/the recipients file lists recovery \(age1pq1.*\), but the store isn't encrypted to it/);
    // Killed after recovery.age's rename: drift, and recovery.age isn't the one the recipients file records.
    expect(reports[2]!.errors.join("\n")).toMatch(/recovery\.age is not the recovery\.age the recipients file records for recovery \(age1pq1.*\): its SHA-256 differs/);
    // Every drift report ends with what to do, and how to tell an interrupted command from a planted recipient.
    for (const r of [reports[1]!, reports[2]!]) expect(r.errors.at(-1)).toBe(DRIFT_FIX);
    expect(reports[2]!.errors.slice(0, -1).at(-1)).toMatch(/recovery\.age is not the recovery\.age/);
    // The finished state is whole: the new words open it.
    a.t.typed.push(a.t.shown.at(-1)!.join(" "));
    expect(await secretsDrill([], a.deps)).toBe(0);
    expect(words).not.toEqual(a.t.shown.at(-1));
  });

  test("a recovery.age that isn't the one the recipients file records is an error for check, and drill and recover stop before the words", async () => {
    const { err } = capture();
    const { root, tools, a, words } = await initialised();
    await fill(tools, a.store);
    const dir = dirname(a.store);
    // Another store's recovery.age (or this one's from another commit): it opens with other words, to another recipient.
    const other = await initialised({ firstKey: 7000 });
    const recoveryAge = join(dir, "recovery.age");
    writeFileSync(recoveryAge, readFileSync(join(dirname(other.a.store), "recovery.age")));
    const problem = new RegExp(
      `^${recoveryAge.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not the recovery\\.age the recipients file records for recovery \\(age1pq1.*\\): its SHA-256 differs, so it comes from another commit or another store, or a command was interrupted\\. Restore recovery\\.age, the store and its recipients file from the same commit \\(docs/secrets\\.md#an-interrupted-command\\), or run \`mise run secrets:new-recovery\` for new words$`,
    );
    err.length = 0;
    expect(await secretsCheck([], { ...a.deps, tty: null })).toBe(1);
    expect(err.filter((l) => problem.test(l.replace(/^hapi secrets check: /, ""))).length).toBe(1);
    // drill and recover refuse before asking for the words, and recover writes no key or config.
    const prompts = a.t.prompts.length;
    a.t.typed.push(words.join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(problem);
    expect(a.t.prompts.length).toBe(prompts);
    const c = machine(root, "machine-c", tools, [words.join(" ")]);
    copyPrivate(a, c);
    await expect(secretsRecover(["--store", c.store], c.deps)).rejects.toThrow(/recovery\.age is not the recovery\.age the recipients file records/);
    expect([c.t.prompts, existsSync(c.key), existsSync(c.config)]).toEqual([[], false, false]);
    // new-recovery is the way out for lost words, so it still runs, and makes recovery.age whole again.
    expect(await secretsNewRecovery([], a.deps)).toBe(0);
    err.length = 0;
    expect(await secretsCheck([], { ...a.deps, tty: null })).toBe(0);
    expect(err).toEqual([]);
  });

  test("a drift error says to add a missing recipient back only if it is exactly the key being added, and otherwise to restore and treat it as a compromise", async () => {
    capture();
    const { tools, a } = await initialised();
    await fill(tools, a.store);
    const doc = parse(readFileSync(a.store, "utf8")) as { sops: { age: { recipient: string; enc: string }[] } };
    writeFileSync(a.store, stringify({ ...doc, sops: { ...doc.sops, age: [...doc.sops.age, { recipient: fakeRecipient(4243), enc: "x" }] } }));
    const e = await caught(secretsRevoke(["--name", "recovery"], a.deps));
    expect(e.message).toEndWith(`. ${DRIFT_FIX}`);
    expect(DRIFT_FIX).toContain("add a recipient the file is missing only if its whole public key is exactly the one that command was adding");
    expect(DRIFT_FIX).toContain("treat it as a possible compromise, since drift is also how a planted recipient shows up: revoke any recipient you didn't add, and reissue every credential in the store (docs/secrets.md#an-interrupted-command)");
  });
});

describe("a store with a master key that is not age", () => {
  /** The store's text with a PGP master key added, as `sops rotate -i --add-pgp` by someone holding a key would leave it. */
  const planted = (text: string) => {
    const doc = parse(text) as { sops: Record<string, unknown> };
    doc.sops.pgp = [{ created_at: "2026-10-27T09:00:00Z", enc: "-----BEGIN PGP MESSAGE-----\nfake\n-----END PGP MESSAGE-----\n", fp: "FAKEFINGERPRINT" }];
    return stringify(doc);
  };
  const REFUSED = /secrets\.enc\.yaml has a PGP key \(sops\.pgp\) in its sops metadata, besides its age recipients: hapi's store is encrypted to age recipients only/;

  test("check, resolve and every lifecycle command refuse a store also encrypted to a non-age key, before sops runs or anything is written", async () => {
    const { err } = capture();
    const { root, tools, a, words } = await initialised();
    await fill(tools, a.store);
    writeFileSync(a.store, planted(readFileSync(a.store, "utf8")));
    const before = snapshot(dirname(a.store));
    tools.calls.length = 0;

    await expect(secretsCheck([], a.deps)).rejects.toThrow(REFUSED);
    await expect(secretsResolve([], a.deps)).rejects.toThrow(REFUSED);
    // edit too: new values never go into a store a key outside the recipients file could open.
    const ed = editor();
    await expect(secretsEdit([], { ...a.deps, interactive: ed.interactive })).rejects.toThrow(REFUSED);
    expect(ed.runs).toEqual([]);
    await expect(secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).rejects.toThrow(REFUSED);
    await expect(secretsRevoke(["--name", "recovery"], a.deps)).rejects.toThrow(REFUSED);
    a.t.typed.push(words.join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(REFUSED);
    await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(REFUSED);
    // A new machine joining, or recovering with the words, is refused too, and gets no key or config.
    const b = machine(root, "machine-b", tools);
    copyPrivate(a, b);
    await expect(secretsJoin(["--store", b.store], b.deps)).rejects.toThrow(REFUSED);
    const c = machine(root, "machine-c", tools, [words.join(" ")]);
    copyPrivate(a, c);
    await expect(secretsRecover(["--store", c.store], c.deps)).rejects.toThrow(REFUSED);
    for (const m of [b, c]) expect([existsSync(m.key), existsSync(m.config)]).toEqual([false, false]);

    expect(tools.calls.filter((x) => x.tool === "sops")).toEqual([]);
    expect(snapshot(dirname(a.store))).toEqual(before);
    expect([...err].join("\n")).not.toContain("FAKEFINGERPRINT");
  });

  test("a rotate whose result carries a non-age key is not put in place", async () => {
    capture();
    const { tools, a } = await initialised();
    const before = snapshot(dirname(a.store));
    // A sops that adds a key of its own while rotating (say, from a .sops.yaml, were --config /dev/null ever lost).
    a.deps.sops = async (args, o) => {
      const r = await tools.sops(args, o);
      if (args[2] === "rotate") writeFileSync(args.at(-1)!, planted(readFileSync(args.at(-1)!, "utf8")));
      return r;
    };
    await expect(secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).rejects.toThrow(
      /^sops's result has a PGP key \(sops\.pgp\) in its sops metadata, besides its age recipients: .*; nothing was changed$/,
    );
    expect(snapshot(dirname(a.store))).toEqual(before);
  });
});

describe("hapi secrets edit runs the store checks first", () => {
  test("edit refuses recipient drift, a PQ/classic mix or a missing recipients file before sops runs", async () => {
    capture();
    const { tools, a } = await initialised();
    const dir = dirname(a.store);
    const recipientsFile = join(dir, "secrets.recipients.yaml");
    const original = readFileSync(recipientsFile, "utf8");
    const ed = editor();
    const deps = { ...a.deps, interactive: ed.interactive };
    expect(await secretsEdit([], deps)).toBe(0);
    expect(ed.runs.length).toBe(1);
    ed.runs.length = 0;

    // Drift: a recipient the store has that the file doesn't list (planted with raw sops, say), or the other way round.
    await fill(tools, a.store);
    const planted = fakeRecipient(4242);
    const doc = parse(readFileSync(a.store, "utf8")) as { sops: { age: { recipient: string; enc: string }[] } };
    writeFileSync(a.store, stringify({ ...doc, sops: { ...doc.sops, age: [...doc.sops.age, { recipient: planted, enc: "x" }] } }));
    await expect(secretsEdit([], deps)).rejects.toThrow(new RegExp(`secrets\\.enc\\.yaml and .*secrets\\.recipients\\.yaml disagree: the store is encrypted to ${shortRecipient(planted)}, which the recipients file doesn't list`));
    // Back to the store's own two recipients, then a recipients file that lists one more.
    const listed = (parse(original) as { recipients: { recipient: string }[] }).recipients.map((r) => r.recipient);
    const r = await tools.sops(["--config", "/dev/null", "encrypt", "--age", listed.join(","), "--input-type", "yaml", "--output-type", "yaml", "--filename-override", a.store], { env: {}, stdin: stringify(fullStore()) });
    writeFileSync(a.store, r.stdout);
    writeFileSync(recipientsFile, `${original.trimEnd()}\n  - { name: gone, kind: machine, recipient: ${fakeRecipient(77)}, added: 2026-10-26 }\n`);
    await expect(secretsEdit([], deps)).rejects.toThrow(/disagree: the recipients file lists gone \(.*\), but the store isn't encrypted to it/);
    // A classic recipient in a post-quantum store, or no recipients file at all.
    writeFileSync(recipientsFile, `${original.trimEnd()}\n  - { name: old-laptop, kind: machine, recipient: ${fakeRecipient(78, false)}, added: 2026-10-26 }\n`);
    await expect(secretsEdit([], deps)).rejects.toThrow(/pq: true, but old-laptop is a classic \(X25519\) recipient: hapi refuses to mix/);
    rmSync(recipientsFile);
    await expect(secretsEdit([], deps)).rejects.toThrow(/no recipients file at .*secrets\.recipients\.yaml/);
    expect(ed.runs).toEqual([]);
    expect(existsSync(join(dir, ".secrets.enc.yaml.lock"))).toBe(false);
  });

  test("a config whose age_key_file is the store's recovery.age is refused before sops ever sees it", async () => {
    capture();
    const { tools, a } = await initialised();
    await fill(tools, a.store);
    // A second machine first, so revoking it gets as far as the key check.
    expect(await secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).toBe(0);
    const recoveryAge = join(dirname(a.store), "recovery.age");
    for (const keyFile of [recoveryAge, join(a.home, "alias-of-recovery.age")]) {
      if (keyFile !== recoveryAge) symlinkSync(recoveryAge, keyFile);
      writeFileSync(a.config, stringify({ provider: "sops", sops: { file: a.store, age_key_file: keyFile } }));
      const before = snapshot(dirname(a.store));
      tools.calls.length = 0;
      const ed = editor();
      const refused = /age key file .* is the store's recovery\.age: that is the recovery key wrapped with the 10 words, never a machine key, and sops must never get it/;
      await expect(secretsCheck([], a.deps)).rejects.toThrow(refused);
      await expect(secretsResolve([], a.deps)).rejects.toThrow(refused);
      await expect(secretsEdit([], { ...a.deps, interactive: ed.interactive })).rejects.toThrow(refused);
      await expect(secretsAddMachine(["--name", "machine-x", "--recipient", fakeRecipient(998)], a.deps)).rejects.toThrow(refused);
      await expect(secretsRevoke(["--name", "machine-b"], a.deps)).rejects.toThrow(refused);
      await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(refused);
      expect(tools.calls.filter((x) => x.tool === "sops")).toEqual([]);
      expect(ed.runs).toEqual([]);
      expect(snapshot(dirname(a.store))).toEqual(before);
    }
  });
});

describe("the store lock", () => {
  /** The lock's path for machine `m`'s store, on its tmpfs. */
  const lockOf = (m: { store: string; env: Record<string, string> }) => lockPath(m.store, m.env);
  /** A lock line, as hapi writes it, for process `pid`. */
  const lockLine = (store: string, pid: number, extra = "") => `hapi secrets drill, pid ${pid}${extra}, started 2026-10-27T09:00:00.000Z, id 0123abcd, store ${store}\n`;
  /** Plant a lock for `m`'s store, as another hapi process would leave it: in a 0700 locks dir, the file 0600. */
  async function plant(m: { store: string; env: Record<string, string> }, text: string) {
    const lock = await lockOf(m);
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    writeFileSync(lock, text, { mode: 0o600 });
    return lock;
  }
  /** A pid that no process has: a child's, after it has exited. */
  const deadPid = () => {
    const pid = spawnSync("true").pid!;
    expect(() => process.kill(pid, 0)).toThrow();
    return pid;
  };
  const re = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  test("the lock is on the tmpfs, never in the store's directory: one 0600 file in a 0700 dir, named by the store's real path, holding the pid", async () => {
    capture();
    const { tools, a } = await initialised();
    const lock = await lockOf(a);
    expect(lock).toMatch(new RegExp(`^${re(join(a.xdg, "hapi", "locks"))}/[0-9a-f]{64}\\.lock$`));
    // The same store through a symlinked directory is the same lock.
    symlinkSync(dirname(a.store), join(a.home, "private-link"));
    expect(await lockPath(join(a.home, "private-link", "secrets.enc.yaml"), a.env)).toBe(lock);
    // While add-machine runs (seen from inside its sops call): the lock is held, by this process, and nothing is beside the store.
    const seen: { inStoreDir: string[]; lock: string; modes: number[] }[] = [];
    a.deps.sops = async (args, o) => {
      seen.push({ inStoreDir: readdirSync(dirname(a.store)).filter((f) => /lock/.test(f)), lock: readFileSync(lock, "utf8"), modes: [mode(lock), mode(dirname(lock))] });
      return tools.sops(args, o);
    };
    expect(await secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).toBe(0);
    expect(seen.length).toBe(1);
    expect(seen[0]!.inStoreDir).toEqual([]);
    expect(seen[0]!.lock).toMatch(new RegExp(`^hapi secrets add-machine, pid ${process.pid}( \\(start \\d+\\))?, started \\S+Z, id [0-9a-f]{8}, store ${re(a.store)}\\n$`));
    expect(seen[0]!.modes).toEqual([0o600, 0o700]);
    // Released when it ends; the store's directory never had one.
    expect(readdirSync(dirname(lock))).toEqual([]);
    expect(readdirSync(dirname(a.store)).filter((f) => /lock/.test(f))).toEqual([]);
  });

  test("a live lock refuses every lifecycle command and edit, naming its holder, and is left alone", async () => {
    capture();
    const { root, tools, a, words } = await initialised();
    const b = machine(root, "machine-b", tools);
    copyPrivate(a, b);
    const c = machine(root, "machine-c", tools, [words.join(" ")]);
    copyPrivate(a, c);
    // A lock held by a running process (this one, the test runner).
    const live = (m: { store: string }) => lockLine(m.store, process.pid);
    const locks = [await plant(a, live(a)), await plant(b, live(b)), await plant(c, live(c))];
    const before = [a, b, c].map((m) => snapshot(dirname(m.store)));
    tools.calls.length = 0;
    const held = (m: { store: string }, lock: string) =>
      new RegExp(
        `^another command, hapi secrets drill \\(pid ${process.pid}, started 2026-10-27T09:00:00\\.000Z\\), is using ${re(m.store)}: wait for it to end, or stop it, and run this again\\. hapi never takes the lock \\(${re(lock)}\\) while its process runs$`,
      );
    const ed = editor();
    await expect(secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).rejects.toThrow(held(a, locks[0]!));
    await expect(secretsRevoke(["--name", "recovery"], a.deps)).rejects.toThrow(held(a, locks[0]!));
    await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(held(a, locks[0]!));
    a.t.typed.push(words.join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(held(a, locks[0]!));
    await expect(secretsEdit([], { ...a.deps, interactive: ed.interactive })).rejects.toThrow(held(a, locks[0]!));
    await expect(secretsJoin(["--store", b.store], b.deps)).rejects.toThrow(held(b, locks[1]!));
    await expect(secretsRecover(["--store", c.store], c.deps)).rejects.toThrow(held(c, locks[2]!));
    // Nothing ran, nothing changed, each lock is as it was, and the joining and recovering machines got no key or config.
    expect(tools.calls).toEqual([]);
    expect(ed.runs).toEqual([]);
    expect([a, b, c].map((m) => snapshot(dirname(m.store)))).toEqual(before);
    expect([a, b, c].map((m, i) => readFileSync(locks[i]!, "utf8") === live(m))).toEqual([true, true, true]);
    for (const m of [b, c]) expect([existsSync(m.key), existsSync(m.config)]).toEqual([false, false]);
    // check and resolve only read: they don't take the lock.
    expect(await secretsCheck([], { ...a.deps, tty: null })).toBe(1); // every value is still empty
    // A lock that names no process isn't hapi's: refused, and left for the user to remove.
    writeFileSync(locks[0]!, "not a lock\n");
    await expect(secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(999)], a.deps)).rejects.toThrow(
      new RegExp(`^${re(locks[0]!)}, the lock on ${re(a.store)}, is not one hapi wrote \\(it names no process\\): if no hapi secrets command is running, remove it and run this again$`),
    );
    expect(readFileSync(locks[0]!, "utf8")).toBe("not a lock\n");
  });

  test("a stale lock (its process is gone, or its pid now belongs to a later process) is removed with a one-line message, and the command runs", async () => {
    const { err } = capture();
    const { a } = await initialised();
    const dead = deadPid();
    const lock = await plant(a, lockLine(a.store, dead));
    expect(await secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(901)], a.deps)).toBe(0);
    expect(err).toEqual([`hapi secrets add-machine: removed a stale lock on ${a.store}: hapi secrets drill (pid ${dead}, started 2026-10-27T09:00:00.000Z) is no longer running`]);
    expect(readdirSync(dirname(lock))).toEqual([]); // the new lock is released too, and the .clearing guard is gone
    // A live pid whose process started at another time than the lock records: the pid was reused, so the lock is stale too.
    err.length = 0;
    await plant(a, lockLine(a.store, process.pid, " (start 1)"));
    expect(await secretsAddMachine(["--name", "machine-c", "--recipient", fakeRecipient(902)], a.deps)).toBe(0);
    expect(err).toEqual([`hapi secrets add-machine: removed a stale lock on ${a.store}: hapi secrets drill (pid ${process.pid}, started 2026-10-27T09:00:00.000Z) is no longer running`]);
    expect((await loadStore(a.store)).recipients.recipients.map((r) => r.name)).toEqual(["machine-a", "recovery", "machine-b", "machine-c"]);
    // Another command clearing a stale lock at the same moment (its .clearing guard, live): refused, nothing removed.
    await plant(a, lockLine(a.store, dead));
    writeFileSync(`${lock}.clearing`, lockLine(a.store, process.pid), { mode: 0o600 });
    await expect(secretsRevoke(["--name", "machine-c"], a.deps)).rejects.toThrow(/^another hapi secrets command, hapi secrets drill \(pid \d+, started .*\), is clearing a stale lock on .*: run this again in a moment$/);
    expect(existsSync(lock)).toBe(true);
    // A guard whose process is gone was left by an interrupted command: the user removes it.
    writeFileSync(`${lock}.clearing`, lockLine(a.store, dead), { mode: 0o600 });
    await expect(secretsRevoke(["--name", "machine-c"], a.deps)).rejects.toThrow(new RegExp(`^${re(lock)}\\.clearing was left by an interrupted hapi secrets command while it cleared a stale lock on .*: if none is running, remove ${re(lock)}\\.clearing and run this again$`));
    rmSync(`${lock}.clearing`);
    expect(await secretsRevoke(["--name", "machine-c"], a.deps)).toBe(0);
    expect(readdirSync(dirname(lock))).toEqual([]);
  });

  test("two recipient changes at once: one runs, the other is refused, and the store and recipients file agree", async () => {
    capture();
    const { a, file } = await initialised();
    const results = await Promise.allSettled([
      secretsAddMachine(["--name", "machine-b", "--recipient", fakeRecipient(901)], a.deps),
      secretsAddMachine(["--name", "machine-c", "--recipient", fakeRecipient(902)], a.deps),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((refused.reason as Error).message).toMatch(new RegExp(`^another command, hapi secrets add-machine \\(pid ${process.pid}, started .*\\), is using ${re(a.store)}: wait for it to end`));
    // No lost update: exactly one was added, in both files.
    const state = await loadStore(a.store);
    expect(state.recipients.recipients.length).toBe(3);
    expect(file().recipients.map((r) => r.name).filter((n) => n !== "machine-a" && n !== "recovery").length).toBe(1);
    expect(readdirSync(dirname(await lockOf(a)))).toEqual([]);
  });

  /**
   * Signals delivered in-process (`process.emit`), with process.exit and the
   * message's writeSync recorded instead of run, so the test runner survives
   * a wrong answer.
   */
  function trapExit() {
    const exits: number[] = [];
    const lines: string[] = [];
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      exits.push(code ?? 0);
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
    const realWrite = fs.writeSync;
    const write = spyOn(fs, "writeSync").mockImplementation(((fd: number, text: string, ...rest: unknown[]) =>
      fd === 2 ? (lines.push(String(text)), String(text).length) : (realWrite as (...a: unknown[]) => number)(fd, text, ...rest)) as typeof fs.writeSync);
    return { exits, lines, restore: () => (exit.mockRestore(), write.mockRestore()) };
  }

  test("a Ctrl-C while sops edit runs is the editor's: hapi ignores it; a SIGTERM waits for sops to end, then releases the lock and exits 143", async () => {
    capture();
    const { a } = await initialised();
    const lock = await lockOf(a);
    const t = trapExit();
    try {
      // Ctrl-C reaches the editor and hapi alike (one foreground group): the edit goes on and ends normally.
      let held = "";
      expect(await secretsEdit([], { ...a.deps, interactive: async () => (process.emit("SIGINT"), await Bun.sleep(20), (held = readFileSync(lock, "utf8")), 0) })).toBe(0);
      expect(held).toContain("hapi secrets edit, pid");
      expect([t.exits, t.lines]).toEqual([[], []]);
      expect(readdirSync(dirname(lock))).toEqual([]);
      // SIGTERM: held back until sops ends, then the lock goes and hapi exits 128+15.
      let ran = false;
      await expect(secretsEdit([], { ...a.deps, interactive: async () => (process.emit("SIGTERM"), await Bun.sleep(20), (ran = existsSync(lock)), 0) })).rejects.toThrow("process.exit(143)");
      expect(ran).toBe(true);
      expect(t.exits).toEqual([143]);
      expect(t.lines).toEqual([`hapi secrets edit: stopped after sops edit ended (SIGTERM); released the lock on ${a.store}\n`]);
      expect(readdirSync(dirname(lock))).toEqual([]);
    } finally {
      t.restore();
    }
    // Afterwards hapi no longer handles the signals: nothing is left listening.
    expect(process.listenerCount("SIGINT") + process.listenerCount("SIGTERM") + process.listenerCount("SIGHUP")).toBe(0);
  });

  test("a Ctrl-C during the renames waits for them: new-recovery finishes its change, then releases the lock and exits 130", async () => {
    capture();
    const { tools, a } = await initialised();
    await fill(tools, a.store);
    const lock = await lockOf(a);
    const realRename = fsp.rename;
    let signalled = false;
    const rename = spyOn(fsp, "rename").mockImplementation((async (from: string, to: string) => {
      await realRename(from, to);
      // Ctrl-C right after the store's rename, before recovery.age and the recipients file are in place.
      if (to === a.store && !signalled) {
        signalled = true;
        process.emit("SIGINT");
      }
    }) as typeof fsp.rename);
    const t = trapExit();
    try {
      await expect(secretsNewRecovery([], a.deps)).rejects.toThrow("process.exit(130)");
    } finally {
      t.restore();
      rename.mockRestore();
    }
    expect(signalled).toBe(true);
    expect(t.lines).toEqual([`hapi secrets new-recovery: stopped after the change was written (SIGINT); released the lock on ${a.store}\n`]);
    // The change is whole (no drift, recovery.age the recorded one), and the lock is gone.
    const report = await recipientReport(a.store);
    expect(report.errors).toEqual([]);
    expect(readdirSync(dirname(lock))).toEqual([]);
    a.t.typed.push(a.t.shown.at(-1)!.join(" "));
    expect(await secretsDrill([], a.deps)).toBe(0);
  });

  /** Run the fixture (tests/secrets/fixtures/at-the-prompt.ts) as `hapi secrets <command>` for machine `m`, up to its first prompt. */
  async function atThePrompt(m: ReturnType<typeof machine>, root: string, command: "drill" | "recover" | "new-recovery", args: string[] = []) {
    const fixture = { command, args, env: m.env, cwd: m.deps.cwd, checkout: join(root, "checkout"), machineName: m.name, tty: "fake" };
    const child = spawn(process.execPath, [join(import.meta.dir, "fixtures", "at-the-prompt.ts")], { env: { ...m.env, HAPI_FIXTURE: JSON.stringify(fixture) }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => child.on("close", (code, signal) => done({ code, signal })));
    for (let i = 0; i < 400 && !out.includes("PROMPT ") && child.exitCode === null; i++) await Bun.sleep(25);
    if (!out.includes("PROMPT ")) throw new Error(`the fixture never reached a prompt: ${out} ${err}`);
    return { child, exited, out: () => out, err: () => err };
  }

  test("a signal releases the lock: SIGINT, SIGTERM or SIGHUP at the word prompt of drill, recover or new-recovery prints cancelled and exits 128+n", async () => {
    capture();
    const { root, tools, a, words } = await initialised();
    await fill(tools, a.store);
    const lock = await lockOf(a);
    const before = snapshot(dirname(a.store));
    const cases: ["drill" | "recover" | "new-recovery", NodeJS.Signals, number][] = [
      ["drill", "SIGINT", 130],
      ["drill", "SIGTERM", 143],
      ["drill", "SIGHUP", 129],
      ["new-recovery", "SIGINT", 130],
    ];
    for (const [command, signal, code] of cases) {
      const run = await atThePrompt(a, root, command);
      // At the prompt: the lock is held by the child.
      expect(readFileSync(lock, "utf8")).toContain(`hapi secrets ${command}, pid ${run.child.pid}`);
      run.child.kill(signal);
      expect(await run.exited).toEqual({ code, signal: null });
      expect(run.err()).toBe(`hapi secrets ${command}: cancelled (${signal}); released the lock on ${a.store}\n`);
      expect(readdirSync(dirname(lock))).toEqual([]);
      expect(snapshot(dirname(a.store))).toEqual(before);
    }
    // recover on a new box: Ctrl-C at the word prompt leaves its key and config (a retry reuses them) but no lock, and the store as it was.
    const c = machine(root, "machine-c", tools);
    copyPrivate(a, c);
    const run = await atThePrompt(c, root, "recover", ["--store", c.store]);
    expect(run.out()).toContain("PROMPT Type your 10 recovery words: ");
    run.child.kill("SIGINT");
    expect(await run.exited).toEqual({ code: 130, signal: null });
    expect(run.err()).toBe(`hapi secrets recover: cancelled (SIGINT); released the lock on ${c.store}\n`);
    expect(readdirSync(dirname(await lockOf(c)))).toEqual([]);
    expect(snapshot(dirname(c.store))).toEqual(before);
    expect([existsSync(c.key), existsSync(c.config)]).toEqual([true, true]);
    // And the next command runs: no stale lock to clear.
    a.t.typed.push(words.join(" "));
    const { err } = capture();
    expect(await secretsDrill([], a.deps)).toBe(0);
    expect(err).toEqual([]);
  }, 30_000);

  test.skipIf(!existsSync("/usr/bin/script") || !existsSync("/bin/bash"))("on a real terminal (script(1)), Ctrl-C at the word prompt turns echo back on, leaves no reader behind, releases the lock and exits 130", async () => {
    capture();
    const { root, tools, a } = await initialised();
    await fill(tools, a.store);
    const lock = await lockOf(a);
    /** The pids whose parent is `pid` (from /proc/<n>/stat: the fields after the command's closing parenthesis are state, then ppid). */
    const childrenOf = (pid: number) =>
      readdirSync("/proc")
        .filter((n) => /^\d+$/.test(n))
        .filter((n) => {
          try {
            const stat = readFileSync(`/proc/${n}/stat`, "utf8");
            return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid;
          } catch {
            return false;
          }
        })
        .map(Number);
    for (const how of ["ctrl-c", "sigint-to-hapi-only", "sigint-to-the-reader-only"] as const) {
      const fixture = { command: "drill", args: [], env: a.env, cwd: a.deps.cwd, checkout: join(root, "checkout"), machineName: a.name, tty: "real" };
      const shell = [
        `${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fixtures", "at-the-prompt.ts"))}`,
        'echo "rc=$?"',
        "stty -a | tr ' ;' '\\n\\n' | grep -x -- '-\\?echo'",
        'IFS= read -r x; echo "next=$x"',
      ].join("; ");
      // script(1) runs `$SHELL -c`. bash, after a Ctrl-C, goes on once its child exits normally (dash would stop too).
      const env = { ...a.env, HAPI_FIXTURE: JSON.stringify(fixture), TERM: "dumb", SHELL: "/bin/bash" };
      const child = spawn("/usr/bin/script", ["-qfec", shell, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString().replaceAll("\r", "")));
      const exited = new Promise<number | null>((done) => child.on("close", (code) => done(code)));
      const until = async (s: string) => {
        for (let i = 0; i < 400 && !out.includes(s); i++) await Bun.sleep(25);
        expect([s, out.includes(s)]).toEqual([s, true]);
      };
      await until("Type your 10 recovery words: ");
      await Bun.sleep(300); // the reading shell has turned echo off by now
      const pid = Number(/PID (\d+)/.exec(out)![1]);
      expect(readFileSync(lock, "utf8")).toContain(`hapi secrets drill, pid ${pid}`);
      if (how === "ctrl-c") child.stdin.write("\x03");
      else if (how === "sigint-to-hapi-only") process.kill(pid, "SIGINT");
      else {
        // Only the shell reading the line: its trap turns echo on and exits 130, and hapi cancels from that.
        const readers = childrenOf(pid);
        expect(readers.length).toBe(1);
        process.kill(readers[0]!, "SIGINT");
      }
      await until("rc=");
      child.stdin.write("typed after\n");
      await until("next=");
      child.stdin.end();
      expect(await exited).toBe(0);
      const cancelled = how === "sigint-to-the-reader-only" ? /hapi secrets drill: cancelled\n/ : /hapi secrets drill: cancelled \(SIGINT\); released the lock on .*secrets\.enc\.yaml\n/;
      expect([how, cancelled.test(out)]).toEqual([how, true]);
      expect([how, /rc=(\d+)/.exec(out)?.[1], /^-?echo$/m.exec(out)?.[0], /next=(.*)/.exec(out)?.[1]]).toEqual([how, "130", "echo", "typed after"]);
      expect(readdirSync(dirname(lock))).toEqual([]);
    }
  }, 30_000);
});

describe("hapi secrets check: the recipients", () => {
  /** A full static store (every name found), its recipients file and config, with the age dir injected. */
  function setup(values = fullStore()) {
    const root = tempDir();
    const home = join(root, "home");
    mkdirSync(home, { mode: 0o700 });
    const store = sopsStore(root, values);
    const config = sopsConfig(root, store);
    const checkout = tempDir();
    const deps = { env: { HOME: home, PATH: "/usr/bin:/bin" }, sops: store.run, ageDir: async () => FAKE_AGE_DIR, repoRoot: async () => checkout };
    return { root, store, config, deps };
  }

  test("check errors on recipient drift or a PQ/classic mix and warns without a recovery recipient", async () => {
    const { out, err } = capture();
    const s = setup();
    expect(await secretsCheck(["--config", s.config], s.deps)).toBe(0);
    expect(out).toContain("recipient machine  test-machine (post-quantum, added 2026-10-26)");
    expect(out).toContain("recipient recovery recovery (post-quantum, added 2026-10-26)");
    expect(err).toEqual([]);

    // Drift: the recipients file lists one the store isn't encrypted to, or the store has one the file doesn't list.
    writeFileSync(s.store.recipients, recipientsFileText([{ name: "test-machine", kind: "machine", recipient: FAKE_RECIPIENT }]));
    err.length = 0;
    expect(await secretsCheck(["--config", s.config], s.deps)).toBe(1);
    expect(err.join("\n")).toContain(`hapi secrets check: the store is encrypted to ${shortRecipient(FAKE_RECOVERY_RECIPIENT)}, which the recipients file doesn't list`);
    writeFileSync(s.store.recipients, recipientsFileText([
      { name: "test-machine", kind: "machine", recipient: FAKE_RECIPIENT },
      { name: "recovery", kind: "recovery", recipient: FAKE_RECOVERY_RECIPIENT },
      { name: "gone", kind: "machine", recipient: fakeRecipient(77) },
    ]));
    err.length = 0;
    expect(await secretsCheck(["--config", s.config], s.deps)).toBe(1);
    expect(err.join("\n")).toContain(`the recipients file lists gone (${shortRecipient(fakeRecipient(77))}), but the store isn't encrypted to it`);

    // A PQ/classic mix in the store, or in the recipients file, is an error.
    const classic = fakeRecipient(78, false);
    writeFileSync(s.store.file, sopsFileText(Object.fromEntries(Object.keys(fullStore()).map((k) => [k, "enc"])), {}, [FAKE_RECIPIENT, FAKE_RECOVERY_RECIPIENT, classic]));
    writeFileSync(s.store.recipients, recipientsFileText([
      { name: "test-machine", kind: "machine", recipient: FAKE_RECIPIENT },
      { name: "recovery", kind: "recovery", recipient: FAKE_RECOVERY_RECIPIENT },
      { name: "old-laptop", kind: "machine", recipient: classic },
    ]));
    err.length = 0;
    expect(await secretsCheck(["--config", s.config], s.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/pq: true, but old-laptop is a classic \(X25519\) recipient: hapi refuses to mix post-quantum and classic recipients/);

    // No recovery recipient, or no recovery.age: a warning, and still exit 0.
    const w = setup();
    writeFileSync(w.store.file, sopsFileText(Object.fromEntries(Object.keys(fullStore()).map((k) => [k, "enc"])), {}, [FAKE_RECIPIENT]));
    writeFileSync(w.store.recipients, recipientsFileText([{ name: "test-machine", kind: "machine", recipient: FAKE_RECIPIENT }]));
    err.length = 0;
    expect(await secretsCheck(["--config", w.config], w.deps)).toBe(0);
    expect(err.join("\n")).toMatch(/^hapi secrets check: warning: the store has no recovery recipient: if every machine key is lost, so is the store\. Run `mise run secrets:new-recovery`/m);
    const v = setup();
    rmSync(v.store.recovery);
    err.length = 0;
    expect(await secretsCheck(["--config", v.config], v.deps)).toBe(0);
    expect(err.join("\n")).toMatch(/^hapi secrets check: warning: there is no recovery\.age at .*recovery\.age: the 10 words can't open the store without it/m);

    // No recipients file at all: an error, naming it.
    const u = setup();
    rmSync(u.store.recipients);
    err.length = 0;
    expect(await secretsCheck(["--config", u.config], u.deps)).toBe(1);
    expect(err.join("\n")).toMatch(/no recipients file at .*secrets\.recipients\.yaml/);
  });
});

describe("the sops child environment", () => {
  test("every sops child env sets GPG_AGENT_INFO= and SOPS_DISABLE_VERSION_CHECK=1, and PATH starts with the mise age dir", async () => {
    capture();
    const { root, tools, a, words } = await initialised();
    const b = machine(root, "machine-b", tools);
    copyPrivate(a, b);
    await secretsJoin(["--store", b.store], b.deps);
    const rB = tools.recipients.get(idLine(readFileSync(b.key, "utf8")))!;
    await secretsAddMachine(["--name", "machine-b", "--recipient", rB], a.deps);
    await fill(tools, a.store);
    a.t.typed.push(words.join(" "));
    await secretsDrill([], a.deps);
    await secretsNewRecovery([], a.deps);
    copyPrivate(a, b);
    await secretsRevoke(["--name", "machine-a"], b.deps);
    expect(await secretsResolve([], b.deps)).toBe(0);
    expect(await secretsCheck([], b.deps)).toBe(0);
    const c = machine(root, "machine-c", tools, [a.t.shown.at(-1)!.join(" ")]);
    copyPrivate(b, c);
    await secretsRecover(["--store", c.store], c.deps);
    const edits: Record<string, string>[] = [];
    await secretsEdit([], { ...c.deps, interactive: async (_cmd, _args, o) => (edits.push(o.env), 0) });

    // Every call hapi made (the test's own `fill` passes an empty env).
    const ours = tools.calls.filter((x) => Object.keys(x.env).length > 0);
    const sops = [...ours.filter((x) => x.tool === "sops").map((x) => x.env), ...edits];
    expect(new Set(tools.calls.filter((x) => x.tool === "sops").map((x) => x.args[2]))).toEqual(new Set(["encrypt", "rotate", "decrypt"]));
    expect(sops.length).toBeGreaterThan(8);
    for (const env of sops) {
      expect([env.GPG_AGENT_INFO, env.SOPS_DISABLE_VERSION_CHECK, env.PATH!.split(":")[0]]).toEqual(["", "1", FAKE_AGE_DIR]);
    }
    for (const x of ours.filter((y) => y.tool !== "sops")) expect([x.tool, x.env.PATH!.split(":")[0]]).toEqual([x.tool, FAKE_AGE_DIR]);
    expect(edits.length).toBe(1);
  });
});
