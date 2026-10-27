/**
 * Test helpers for tests/secrets: temp dirs, console capture, fakes for the
 * sops store and its runner, fake age tools and a fake terminal. Nothing here
 * reads the real HOME, the real ~/.config or a real key: every path is under
 * a fresh temp directory, and every value, key and word is an obviously fake
 * string.
 */
import { spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import type { Tty } from "../../src/secrets/recovery";
import type { SopsRunner } from "../../src/secrets/providers/sops";

const temps: string[] = [];
const restores: (() => void)[] = [];

/** Undo everything: call it from afterEach. */
export function cleanup(): void {
  for (const r of restores.splice(0)) r();
  for (const d of temps.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
}

/** A fresh directory, mode 0700 and ours, like $XDG_RUNTIME_DIR. Removed by `cleanup`. */
export function tempDir(prefix = "hapi-secrets-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Capture console.log and console.error until `cleanup`. */
export function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restores.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}

export const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

/** Every file under `dir`, relative, sorted. */
export function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** The text of every file under `dir`, joined: to check a word or a key never reached a file. */
export function allText(dir: string): string {
  return tree(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

export const mode = (path: string) => statSync(path).mode & 0o777;

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

/** A recipient-shaped string with no key behind it: post-quantum (age1pq1 + 1952 characters) or classic X25519 (age1 + 58). */
export function fakeRecipient(n: number, pq = true): string {
  let s = "";
  do {
    s = BECH32[n % 32] + s;
    n = Math.floor(n / 32);
  } while (n > 0);
  return pq ? `age1pq1${s.padStart(1952, "q")}` : `age1${s.padStart(58, "q")}`;
}

/** An age key file's text with the shape age-keygen writes (comments, one identity line) and no real key behind it. */
export const FAKE_KEY_FILE_TEXT = "# not a real age key (unit-test fixture)\nAGE-SECRET-KEY-PQ-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQFAKE\n";

/** A machine recipient and a recovery recipient for the static fake store below. */
export const FAKE_RECIPIENT = fakeRecipient(1);
export const FAKE_RECOVERY_RECIPIENT = fakeRecipient(2);
export const ENC = "ENC[AES256_GCM,data:ZmFrZQ==,iv:ZmFrZQ==,tag:ZmFrZQ==,type:str]";
const ENC_KEY = "-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n-----END AGE ENCRYPTED FILE-----\n";

/** The text of a sops-encrypted YAML file holding `names` (values look encrypted; "" stays "", as sops leaves it). */
export function sopsFileText(names: Record<string, "" | "enc">, metadata: Record<string, unknown> = {}, recipients = [FAKE_RECIPIENT, FAKE_RECOVERY_RECIPIENT]): string {
  const doc: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(names)) doc[name] = v === "" ? "" : ENC;
  doc.sops = { age: recipients.map((recipient) => ({ recipient, enc: ENC_KEY })), version: "3.13.3", ...metadata };
  return stringify(doc);
}

/** The text of a recipients file. */
export function recipientsFileText(recipients: { name: string; kind: "machine" | "recovery"; recipient: string }[], pq = true): string {
  return stringify({ pq, recipients: recipients.map((r) => ({ ...r, added: "2026-10-26" })) });
}

/**
 * A sops store in `dir`: `secrets.enc.yaml` shaped like sops's output for
 * `values`, encrypted to FAKE_RECIPIENT (machine `test-machine`) and
 * FAKE_RECOVERY_RECIPIENT (`recovery`), its recipients file and a fake
 * recovery.age beside it, and a 0600 age key file at `age/keys.txt` (fake
 * content). Returns the paths and a fake SopsRunner that "decrypts" to
 * `values` and records each call.
 */
export function sopsStore(dir: string, values: Record<string, string>) {
  const file = join(dir, "secrets.enc.yaml");
  writeFileSync(file, sopsFileText(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === "" ? "" : "enc"]))));
  const recipients = join(dir, "secrets.recipients.yaml");
  writeFileSync(recipients, recipientsFileText([
    { name: "test-machine", kind: "machine", recipient: FAKE_RECIPIENT },
    { name: "recovery", kind: "recovery", recipient: FAKE_RECOVERY_RECIPIENT },
  ]));
  const recovery = join(dir, "recovery.age");
  writeFileSync(recovery, ENC_KEY, { mode: 0o600 });
  const ageKeyFile = join(dir, "age", "keys.txt");
  mkdirSync(join(dir, "age"), { mode: 0o700, recursive: true });
  writeFileSync(ageKeyFile, FAKE_KEY_FILE_TEXT, { mode: 0o600 });
  const calls: { args: string[]; env: Record<string, string>; stdin?: string }[] = [];
  const run: SopsRunner = async (args, o) => {
    calls.push({ args, env: o.env, ...(o.stdin === undefined ? {} : { stdin: String(o.stdin) }) });
    return { code: 0, stdout: JSON.stringify(values), stderr: "" };
  };
  return { file, recipients, recovery, ageKeyFile, run, calls };
}

/** A secrets config file for the sops store in `dir`. */
export function sopsConfig(dir: string, store: { file: string; ageKeyFile: string }): string {
  const path = join(dir, "secrets.yaml");
  writeFileSync(path, stringify({ provider: "sops", sops: { file: store.file, age_key_file: store.ageKeyFile } }));
  return path;
}

/** Every logical name stack/secrets.yaml lists, with a fake value each. */
export function fullStore(): Record<string, string> {
  const names = [
    "hapi-hermes-anthropic-api-key", "hapi-hermes-slack-bot-token", "hapi-hermes-slack-app-token", "hapi-hermes-slack-allowed-users",
    "hapi-archon-anthropic-api-key", "hapi-archon-opencode-api-key", "hapi-archon-jev-openrouter-api-key",
    "hapi-research-brave-search-api-key", "hapi-research-exa-api-key", "hapi-mcp-context7-api-key",
    "hapi-host-planner-app-id", "hapi-host-planner-app-private-key", "hapi-host-factory-app-id", "hapi-host-factory-app-private-key",
  ];
  return Object.fromEntries(names.map((n) => [n, `fake-${n}-value`]));
}

/** Where the fake tools pretend the mise-pinned age lives. Never created: it only leads PATH. */
export const FAKE_AGE_DIR = "/nonexistent/mise/installs/age/1.3.2/age";

/** One recorded call of a fake tool. `fd3` is what the caller piped to file descriptor 3 (the passphrase). */
export interface ToolCall {
  tool: "age" | "age-keygen" | "sops";
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  fd3?: string;
}

const ARMOR = (body: string) => `-----BEGIN AGE ENCRYPTED FILE-----\n${body}\n-----END AGE ENCRYPTED FILE-----\n`;
const identityLines = (text: string) => text.split(/\s+/).filter((l) => l.startsWith("AGE-SECRET-KEY-"));

/**
 * Fake age, age-keygen and sops that share their keys, so the lifecycle
 * commands can be run end to end without the real tools:
 * - age-keygen [-pq] makes a fake identity (AGE-SECRET-KEY-PQ-1FAKEKEY<n>) and
 *   remembers its recipient; `-y <file>` and `-y` (stdin) look it up;
 * - age -e/-d -j batchpass "wraps" an identity under the passphrase on fd 3,
 *   as an armored token, and unwraps it only with the same passphrase;
 * - sops encrypt / decrypt / rotate -i edit a sops-shaped YAML file. A value
 *   is base64 inside ENC[...], and decrypt and rotate succeed only when the
 *   env holds (SOPS_AGE_KEY, SOPS_AGE_KEY_FILE or the default keys.txt) an
 *   identity whose recipient the file lists, as with real sops.
 * Every call is recorded in `calls`.
 */
export function fakeTools(o: { failRotate?: boolean } = {}) {
  const calls: ToolCall[] = [];
  const recipients = new Map<string, string>(); // identity -> recipient
  const wrapped = new Map<string, { identity: string; passphrase: string }>();
  let n = 100;
  const record = (tool: ToolCall["tool"], args: string[], opts: { env: Record<string, string>; stdin?: string | Uint8Array; fd3?: string }) => {
    const stdin = opts.stdin === undefined ? undefined : typeof opts.stdin === "string" ? opts.stdin : new TextDecoder().decode(opts.stdin);
    calls.push({ tool, args, env: opts.env, ...(stdin === undefined ? {} : { stdin }), ...(opts.fd3 === undefined ? {} : { fd3: opts.fd3 }) });
    return stdin;
  };
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const lookUp = (text: string) => identityLines(text).map((id) => recipients.get(id));

  const ageKeygen: SopsRunner = async (args, opts) => {
    const stdin = record("age-keygen", args, opts);
    if (args[0] === "-y") {
      const text = args[1] === undefined ? (stdin ?? "") : readFileSync(args[1], "utf8");
      const found = lookUp(text);
      if (found.length === 0 || found.some((r) => r === undefined)) return { code: 1, stdout: "", stderr: "age-keygen: error: failed to parse input: unknown identity type\n" };
      return ok(`${found.join("\n")}\n`);
    }
    const pq = args.includes("-pq");
    const id = `AGE-SECRET-KEY-${pq ? "PQ-" : ""}1FAKEKEY${n}`;
    const recipient = fakeRecipient(n++, pq);
    recipients.set(id, recipient);
    return { code: 0, stdout: `# created: 2026-10-26T12:00:00Z\n# public key: ${recipient}\n${id}\n`, stderr: `Public key: ${recipient}\n` };
  };

  const age: SopsRunner = async (args, opts) => {
    const stdin = record("age", args, opts) ?? "";
    if (opts.env.AGE_PASSPHRASE_FD !== "3" || opts.fd3 === undefined) return { code: 1, stdout: "", stderr: "age: error: batchpass plugin: either AGE_PASSPHRASE or AGE_PASSPHRASE_FD must be set\n" };
    if (args.includes("-e")) {
      const token = Buffer.from(`fake-wrapped-${n++}`).toString("base64");
      wrapped.set(token, { identity: stdin, passphrase: opts.fd3.replace(/\n+$/, "") });
      return ok(ARMOR(token));
    }
    const token = stdin.split("\n")[1] ?? "";
    const w = wrapped.get(token);
    if (w === undefined) return { code: 1, stdout: "", stderr: "age: error: failed to read header: parsing age header: unexpected intro\n" };
    if (w.passphrase !== opts.fd3.replace(/\n+$/, "")) return { code: 1, stdout: "", stderr: "age: error: batchpass plugin: incorrect passphrase\nage: report unexpected or unhelpful errors at https://filippo.io/age/report\n" };
    return ok(w.identity);
  };

  const canOpen = (env: Record<string, string>, listed: string[]) => {
    const ids = [...identityLines(env.SOPS_AGE_KEY ?? "")];
    const files = [env.SOPS_AGE_KEY_FILE, join(env.XDG_CONFIG_HOME || join(env.HOME ?? "/nonexistent", ".config"), "sops", "age", "keys.txt")];
    for (const f of files) if (f !== undefined && existsSync(f)) ids.push(...identityLines(readFileSync(f, "utf8")));
    return ids.some((id) => listed.includes(recipients.get(id) ?? ""));
  };
  const noKey = { code: 128, stdout: "", stderr: "Failed to get the data key required to decrypt the SOPS file.\n\nGroup 0: FAILED\n" };
  const encValue = (v: string) => (v === "" ? "" : `ENC[AES256_GCM,data:${Buffer.from(v).toString("base64")},iv:ZmFrZQ==,tag:ZmFrZQ==,type:str]`);
  const decValue = (v: string) => (v === "" ? "" : Buffer.from(/data:([^,]*)/.exec(v)![1]!, "base64").toString());
  const sopsDoc = (values: Record<string, string>, listed: string[]) =>
    stringify({
      ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, encValue(v)])),
      sops: { age: listed.map((recipient) => ({ recipient, enc: ENC_KEY })), lastmodified: "2026-10-26T12:00:00Z", mac: ENC, unencrypted_suffix: "_unencrypted", version: "3.13.3" },
    });
  const readStore = (file: string) => {
    const doc = parse(readFileSync(file, "utf8")) as Record<string, unknown> & { sops: { age: { recipient: string }[] } };
    const values = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== "sops").map(([k, v]) => [k, decValue(v as string)]));
    return { values, listed: doc.sops.age.map((a) => a.recipient) };
  };

  const sops: SopsRunner = async (args, opts) => {
    const stdin = record("sops", args, opts);
    const cmd = args[2];
    if (args[0] !== "--config" || args[1] !== "/dev/null") return { code: 1, stdout: "", stderr: "fake sops: --config /dev/null must come first\n" };
    if (cmd === "encrypt") {
      const listed = args[args.indexOf("--age") + 1]!.split(",");
      return ok(sopsDoc(parse(stdin ?? "") as Record<string, string>, listed));
    }
    const file = args.at(-1)!;
    const { values, listed } = readStore(file);
    if (!canOpen(opts.env, listed)) return noKey;
    if (cmd === "decrypt") return ok(JSON.stringify(values));
    if (cmd === "rotate") {
      if (o.failRotate) return { code: 1, stdout: "", stderr: "Could not generate data key: fake failure\n" };
      let next = [...listed];
      const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1]!.split(",") : []);
      next.push(...at("--add-age"));
      next = next.filter((r) => !at("--rm-age").includes(r));
      writeFileSync(file, sopsDoc(values, next));
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `fake sops: unexpected command ${cmd}\n` };
  };

  return { calls, ageKeygen, age, sops, ageDir: async () => FAKE_AGE_DIR, recipients, readStore };
}

/**
 * A fake terminal. It records everything written and every prompt. It reads
 * the words back from the "Your recovery words" block it was shown, and
 * answers the confirmation prompts ("Word 3: ") with `answer` (default: the
 * right word). A "recovery words" prompt gets the next of `typed`.
 */
export function fakeTty(o: { answer?: (position: number, words: string[]) => string; typed?: string[] } = {}) {
  const writes: string[] = [];
  const prompts: string[] = [];
  const shown: string[][] = [];
  const typed = [...(o.typed ?? [])];
  const tty: Tty = {
    write(text) {
      writes.push(text);
      if (text.includes("Your recovery words")) {
        const words: string[] = [];
        // The two rows of "<n> <word>" cells, not the prose after them.
        for (const line of text.split("\n").filter((l) => /^\s+\d+ [a-z]+/.test(l))) {
          for (const m of line.matchAll(/(\d+) ([a-z]+)/g)) words[Number(m[1]) - 1] = m[2]!;
        }
        shown.push(words);
      }
    },
    async read(prompt) {
      prompts.push(prompt);
      if (/Press Enter/.test(prompt)) return "";
      const m = /^Word (\d+): $/.exec(prompt);
      if (m) return (o.answer ?? ((p, w) => w[p - 1]!))(Number(m[1]), shown.at(-1)!);
      if (/recovery words/.test(prompt)) return typed.shift() ?? "";
      throw new Error(`fakeTty: unexpected prompt ${JSON.stringify(prompt)}`);
    },
  };
  return { tty, writes, prompts, shown, typed };
}
