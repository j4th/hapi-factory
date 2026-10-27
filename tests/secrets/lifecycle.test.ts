import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { secretsAddMachine, secretsCheck, secretsDrill, secretsEdit, secretsInit, secretsJoin, secretsNewRecovery, secretsRecover, secretsResolve, secretsRevoke } from "../../src/secrets/cli";
import { loadManifest, manifestNames } from "../../src/secrets/manifest";
import { passphraseOf } from "../../src/secrets/recovery";
import { shortRecipient } from "../../src/secrets/recipients";
import {
  allText,
  capture,
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
async function initialised(o: { failRotate?: boolean } = {}) {
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
    expect(tools.calls[2]!.fd3).toBe(passphraseOf(words));

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
    const { tools, a, words } = await initialised();
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
    expect(readdirSync(join(a.xdg, "hapi"))).toEqual([]);
    expect(tree(dirname(dirname(a.store)))).toEqual(before);
    expect([...out, ...err].join("\n")).not.toContain("fake-hapi");

    // Wrong words fail, and still leave nothing behind.
    a.t.typed.push([...words].reverse().join(" "));
    await expect(secretsDrill([], a.deps)).rejects.toThrow(/the words don't open/);
    expect(readdirSync(join(a.xdg, "hapi"))).toEqual([]);
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

  test("a failed new-recovery restores recovery.age and leaves the store and recipients file as they were", async () => {
    capture();
    const { a } = await initialised({ failRotate: true });
    const before = tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")]);
    await expect(secretsNewRecovery([], a.deps)).rejects.toThrow(/sops could not change the recipients/);
    expect(tree(dirname(a.store)).map((f) => [f, readFileSync(join(dirname(a.store), f), "utf8")])).toEqual(before);
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
  const snapshot = (dir: string) => tree(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);

  test("check, resolve and every lifecycle command refuse a store also encrypted to a non-age key, before sops runs or anything is written", async () => {
    const { err } = capture();
    const { root, tools, a, words } = await initialised();
    await fill(tools, a.store);
    writeFileSync(a.store, planted(readFileSync(a.store, "utf8")));
    const before = snapshot(dirname(a.store));
    tools.calls.length = 0;

    await expect(secretsCheck([], a.deps)).rejects.toThrow(REFUSED);
    await expect(secretsResolve([], a.deps)).rejects.toThrow(REFUSED);
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
