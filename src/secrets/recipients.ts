/**
 * A sops store's recipients (spec §11.5): who the store is encrypted to.
 *
 * Every store is encrypted to one age key per machine or user (generated where
 * it lives, never copied) and one recovery recipient (its identity wrapped
 * with the 10 words, in recovery.age: ./recovery.ts). The recipients file,
 * `<stem>.recipients.yaml` beside the store, names each public key:
 *
 *   pq: true
 *   recipients:
 *     - { name: laptop-user, kind: machine, recipient: age1pq1..., added: 2026-10-26 }
 *     - { name: recovery, kind: recovery, recipient: age1pq1..., added: 2026-10-26 }
 *
 * It holds public keys only (schema: secrets-recipients.schema.json), so it
 * may sit in private/ with the store. hapi compares it with the store's own
 * `sops.age[].recipient` metadata, read without decrypting
 * (`recipientProblems`): drift in either direction is an error naming the
 * recipient. Any other kind of master key in the store (PGP, a cloud KMS,
 * Vault, key groups) is refused before that, by `sopsFileProblem`
 * (./providers/sops.ts), so the age recipients are all the store's
 * decryptors.
 *
 * Post-quantum by default. sops accepts a mix of post-quantum and classic
 * recipients without a word, and the file is then only as strong as its
 * classic recipient (age itself refuses a mix). So hapi refuses one: with
 * `pq: true` every recipient is `age1pq1...`, with `pq: false` (the trade-off
 * for P-256 hardware plugins later) every one is classic X25519.
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { PolicyError } from "../policy/load";
import { check } from "../policy/schema";
import { SecretError } from "./provider";

export type RecipientKind = "machine" | "recovery";

export interface RecipientEntry {
  name: string;
  kind: RecipientKind;
  /** The age public key. */
  recipient: string;
  /** YYYY-MM-DD (UTC). */
  added: string;
}

export interface RecipientsFile {
  pq: boolean;
  recipients: RecipientEntry[];
}

/** A recipient's name: a machine or user, or `recovery`. */
export const RECIPIENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const BECH32 = "[qpzry9x8gf2tvdw0s3jn54khce6mua7l]";
/** ML-KEM-768 + X25519 (age-keygen -pq): 1216 bytes of key, so 1952 bech32 characters after `age1pq1`. */
const PQ_RECIPIENT = new RegExp(`^age1pq1${BECH32}{1952}$`);
/** X25519 (age-keygen): 32 bytes of key, so 58 bech32 characters after `age1`. */
const CLASSIC_RECIPIENT = new RegExp(`^age1${BECH32}{58}$`);

/** "pq" for a post-quantum age recipient, "classic" for an X25519 one, undefined for anything else (a plugin's, an SSH key, a typo). */
export function recipientType(r: string): "pq" | "classic" | undefined {
  if (PQ_RECIPIENT.test(r)) return "pq";
  if (CLASSIC_RECIPIENT.test(r)) return "classic";
  return undefined;
}

/** A store's or a key's kind, as every message names it: "post-quantum" or "classic (X25519)". */
export function kindName(pq: boolean): string {
  return pq ? "post-quantum" : "classic (X25519)";
}

/** A public key short enough for a message (a post-quantum one is 1959 characters). */
export function shortRecipient(r: string): string {
  return r.length > 28 ? `${r.slice(0, 16)}…${r.slice(-8)}` : r;
}

/** The recipients file beside `store`: the same directory and basename stem, `secrets.enc.yaml` -> `secrets.recipients.yaml`. */
export function recipientsPath(store: string): string {
  const base = basename(store);
  const stem = base.replace(/(\.enc)?\.ya?ml$/, "") || base;
  return join(dirname(store), `${stem}.recipients.yaml`);
}

/** The wrapped recovery identity beside `store`. */
export function recoveryPath(store: string): string {
  return join(dirname(store), "recovery.age");
}

/**
 * Parse and check a recipients file's text: the schema, then unique names and
 * recipients, then every recipient of the file's kind (`pq`). Throws a
 * PolicyError for the schema (naming `path` and the JSON Pointer), a
 * SecretError for the rest.
 */
export function parseRecipients(text: string, path: string): RecipientsFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new PolicyError(path, [{ path: "", message: `invalid YAML: ${(e as Error).message.split("\n")[0]}` }]);
  }
  const issues = check("secrets-recipients", raw);
  if (issues.length > 0) throw new PolicyError(path, issues);
  const file = raw as RecipientsFile;
  const names = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const r of file.recipients) {
    if (names.has(r.name)) throw new SecretError(`${path}: the name ${r.name} appears twice; each recipient has its own name`);
    const same = keys.get(r.recipient);
    if (same !== undefined) throw new SecretError(`${path}: ${r.name} has the same recipient as ${same}`);
    names.set(r.name, r.recipient);
    keys.set(r.recipient, r.name);
    if (recipientType(r.recipient) !== (file.pq ? "pq" : "classic")) {
      throw new SecretError(
        `${path}: pq: ${file.pq}, but ${r.name} is a ${kindName(!file.pq)} recipient: hapi refuses to mix post-quantum and classic recipients, ` +
          "since sops would quietly drop the post-quantum protection (docs/secrets.md#post-quantum-by-default)",
      );
    }
  }
  return file;
}

/** Read and check the recipients file at `path` (`parseRecipients`). A missing file is a SecretError. */
export async function loadRecipients(path: string): Promise<RecipientsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SecretError(
        `no recipients file at ${path}: it sits beside the store and names every key the store is encrypted to. Restore it with the store from the same commit; a store made before hapi had recovery keys has none, so make a new one with \`mise run secrets:init\` and copy the values across (docs/secrets.md#keys-and-recovery)`,
      );
    }
    throw new SecretError(`cannot read ${path}${code ? ` (${code})` : ""}`);
  }
  return parseRecipients(text, path);
}

/** The recipients file's text: a header, then the file as YAML. */
export function recipientsText(file: RecipientsFile, store: string): string {
  return (
    `# The age recipients ${basename(store)} is encrypted to, written by hapi secrets (docs/secrets.md#keys-and-recovery).\n` +
    "# Public keys only. hapi checks it against the store; change it only with hapi secrets join, add-machine, recover, revoke and new-recovery.\n" +
    stringify(file, { lineWidth: 0 })
  );
}

/** The recipients in a store's sops metadata (`sops.age[].recipient`), read without decrypting. [] if there are none. */
export function storeRecipients(storeText: string): string[] {
  let doc: unknown;
  try {
    doc = parse(storeText);
  } catch {
    return [];
  }
  const age = (doc as { sops?: { age?: unknown } } | null)?.sops?.age;
  if (!Array.isArray(age)) return [];
  return age.map((a) => (a as { recipient?: unknown }).recipient).filter((r): r is string => typeof r === "string");
}

/**
 * Everything wrong between a (checked) recipients file and the store's
 * recipients: a post-quantum/classic mix in the store, a recipient listed
 * twice, one the store has that the file doesn't list (named by public key),
 * and one the file lists that the store isn't encrypted to (named by name).
 * [] when they agree.
 */
export function recipientProblems(file: RecipientsFile, store: readonly string[]): string[] {
  const problems: string[] = [];
  const types = new Set(store.map(recipientType));
  if (types.has("pq") && types.size > 1) {
    const odd = store.find((r) => recipientType(r) !== "pq")!;
    problems.push(
      `the store mixes post-quantum and classic recipients (${shortRecipient(odd)} is ${recipientType(odd) ?? "not an age X25519 or post-quantum recipient"}), which drops post-quantum protection: hapi refuses a mix`,
    );
  }
  const seen = new Set<string>();
  for (const r of store) {
    if (seen.has(r)) problems.push(`the store lists ${shortRecipient(r)} twice`);
    seen.add(r);
  }
  const listed = new Set(file.recipients.map((r) => r.recipient));
  for (const r of seen) if (!listed.has(r)) problems.push(`the store is encrypted to ${shortRecipient(r)}, which the recipients file doesn't list`);
  for (const r of file.recipients) if (!seen.has(r.recipient)) problems.push(`the recipients file lists ${r.name} (${shortRecipient(r.recipient)}), but the store isn't encrypted to it`);
  return problems;
}

/** The default machine name, `<hostname>-<user>`, normalised to `RECIPIENT_NAME`: lower-case, other characters as "-", at most 63. */
export function machineName(hostname: string, user: string): string {
  const name = `${hostname}-${user}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return name === "" ? "machine" : name;
}
