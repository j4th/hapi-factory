/**
 * Rules 6 and 8 (design §3.3, §6a item 10; spike 08 finding 7).
 *
 * Rule 6, secrets in writes (the write gate's local half, policy/decisions/
 * write-gate.ts): `write` content, `edit` new text and a `bash` command are
 * checked for the exact value of every secret the guard was started with and
 * for KEY_PATTERNS' key formats. A match blocks, and the decision log names the
 * secret or the pattern, never the value. Tool results are redacted to
 * `[hapi: <NAME> redacted]` (or `[hapi: <pattern name> redacted]` for a key
 * format) before the model sees them, and every log record, block reason and
 * classifier state is scrubbed the same way. Values shorter
 * than MIN_SECRET_CHARS aren't matched: no key is that short, and matching one
 * would block ordinary text. Encoded forms (base64, split strings) aren't seen.
 *
 * Rule 8, the shell's environment: the factory copies every `secret_env` value
 * (and the Anthropic and Jev keys its own classifiers use) and deletes the names
 * from `process.env`, and every allowed `bash` command is prefixed with
 * `unset <names>;`, because Archon's bash spawn hook merges its own copy of the
 * env back into the shell (options-translator.ts, buildBashSpawnHook), so the
 * delete alone doesn't reach it. Model auth survives both (Archon sets the
 * runtime key before extensions load, spike 08 finding 6). Neither is a
 * boundary: the shell can still read its parent's `/proc/<pid>/environ`, which
 * holds every key. They keep keys out of casual output (`env`, error dumps, the
 * transcript). GIT_CONFIG_* (the git hardening) and BUN_OPTIONS (--no-install)
 * are never unset; config.ts refuses a secret_env that names them.
 */
import { KEY_PATTERNS } from "../../policy/decisions/write-gate";
import { SHELL_KEEPS } from "./config";

/** The shortest value rule 6 matches exactly. */
export const MIN_SECRET_CHARS = 8;

/** The classifiers' own keys (design §3.4): decide() is handed them, never the environment. */
export const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";
export const JEV_KEY = "HAPI_JEV_OPENROUTER_API_KEY";

export interface Secrets {
  /** [name, value], longest value first, so a value inside another is redacted as the longer one. */
  values: [name: string, value: string][];
  anthropicKey: string | undefined;
  jevKey: string | undefined;
  /** The names `unset` in every bash command. */
  unset: string[];
}

/** Copy the secrets out of `env`, then delete every `secret_env` name from it (rule 8). */
export function takeSecrets(env: Record<string, string | undefined>, secretEnv: string[]): Secrets {
  const names = [...new Set([...secretEnv, ANTHROPIC_KEY, JEV_KEY])];
  const values: [string, string][] = [];
  for (const name of names) {
    const v = env[name];
    if (v !== undefined && v.length >= MIN_SECRET_CHARS) values.push([name, v]);
  }
  values.sort((a, b) => b[1].length - a[1].length);
  const secrets: Secrets = { values, anthropicKey: env[ANTHROPIC_KEY], jevKey: env[JEV_KEY], unset: secretEnv.filter((n) => !SHELL_KEEPS.test(n)) };
  for (const name of secrets.unset) delete env[name];
  return secrets;
}

/** The bash command with the secret names unset first. */
export function withUnset(command: string, s: Secrets): string {
  return s.unset.length === 0 ? command : `unset ${s.unset.join(" ")}; ${command}`;
}

/** The secret a text holds: an exact value's name first, then a key format's name. */
export function findSecret(text: string, s: Secrets): { name: string; exact: boolean } | undefined {
  for (const [name, value] of s.values) if (text.includes(value)) return { name, exact: true };
  for (const { name, re } of KEY_PATTERNS) if (re.test(text)) return { name, exact: false };
  return undefined;
}

/** KEY_PATTERNS' names, which never clash with an env name (those are upper case). */
export const PATTERN_NAMES: ReadonlySet<string> = new Set(KEY_PATTERNS.map((k) => k.name));

const PEM_BEGIN = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`;
const PEM_END = String.raw`-----END [A-Z ]*PRIVATE KEY-----`;
/**
 * A private key's block: its BEGIN line to its END line, or to the end of the text when it has none (lazy, no `m`
 * flag). It takes the whole block whatever its shape (`\n` escapes in a JSON string, an indented YAML block, CRLF,
 * trailing spaces), and fails closed: with no END line, everything after the BEGIN line goes. A worker that hides
 * its own text behind a BEGIN line hides it from the model too, so it gains nothing. A match with no END line runs
 * to the end of the text and stops there, so the scan is linear.
 */
const PRIVATE_KEY_BLOCK = new RegExp(`${PEM_BEGIN}[\\s\\S]*?(?:${PEM_END}|$)`, "g");
const ENDS_IN_END = new RegExp(`${PEM_END}$`);
/** What replaces a private key that had no END line, so a reader knows the rest of the text went with it. */
export const NO_END_MARKER = "[hapi: private-key redacted to the end of the text: no END line]";

/**
 * KEY_PATTERNS as redaction patterns, global, by the same names. `private-key` matches only a key's BEGIN line,
 * which is enough to find one (`findSecret`), but redacting that line alone would leave the key's body in the text,
 * so it is redacted as PRIVATE_KEY_BLOCK (ledger 168). That form lives here, not in policy/decisions/write-gate.ts,
 * which is under policy/**. Applied by `redactKeyFormats`, which `hapi run watch` shares (src/run/sanitize.ts), in
 * this order: `private-key` first, because another pattern's character class can swallow its BEGIN marker (slack's
 * `[A-Za-z0-9-]{10,}` takes the `-----BEGIN` of `xoxb------BEGIN ...`), and the key's body would then go unredacted.
 */
export const REDACT_PATTERNS: readonly { name: string; re: RegExp }[] = KEY_PATTERNS.map(({ name, re }) => ({
  name,
  re: name === "private-key" ? PRIVATE_KEY_BLOCK : new RegExp(re.source, `${re.flags.replace("g", "")}g`),
})).sort((a, b) => Number(b.name === "private-key") - Number(a.name === "private-key"));

/**
 * `text` with each REDACT_PATTERNS match replaced by `[hapi: <pattern name> redacted]`, or by NO_END_MARKER for a
 * private key that ran to the end of the text, and the names found: a truncating redaction is recorded like any.
 */
export function redactKeyFormats(text: string): { text: string; names: string[] } {
  const names: string[] = [];
  let out = text;
  for (const { name, re } of REDACT_PATTERNS) {
    const next = out.replace(re, (m) => (name === "private-key" && !ENDS_IN_END.test(m) ? NO_END_MARKER : `[hapi: ${name} redacted]`));
    if (next === out) continue;
    names.push(name);
    out = next;
  }
  return { text: out, names };
}

const BEGINS = new RegExp(PEM_BEGIN, "g");
const ENDS = new RegExp(PEM_END, "g");
const HAS_END = new RegExp(PEM_END);
/** Where the last match of `re` (global) starts in `text`, or -1: one pass, no lookahead. */
const lastAt = (re: RegExp, text: string): number => {
  let at = -1;
  for (const m of text.matchAll(re)) at = m.index;
  return at;
};
/** Whether `line` opens a private key: a BEGIN line after its last END line, so the key's body is still to come. */
export const opensPrivateKey = (line: string): boolean => lastAt(BEGINS, line) > lastAt(ENDS, line);
/** Whether `line` holds a private key's END line. */
export const closesPrivateKey = (line: string): boolean => HAS_END.test(line);

/**
 * The text with every exact value replaced by `[hapi: <NAME> redacted]`, then
 * every key format (`redactKeyFormats`: a private key's whole block), and the
 * names found: a key in a repo file the worker reads is not sent on to a
 * classifier.
 */
export function redact(text: string, s: Secrets): { text: string; names: string[] } {
  const names: string[] = [];
  let out = text;
  for (const [name, value] of s.values) {
    if (!out.includes(value)) continue;
    names.push(name);
    out = out.split(value).join(`[hapi: ${name} redacted]`);
  }
  const keys = redactKeyFormats(out);
  return { text: keys.text, names: [...names, ...keys.names] };
}

/** `redact` over every string inside a JSON value. */
export function redactDeep(value: unknown, s: Secrets, names: Set<string>): unknown {
  if (typeof value === "string") {
    const r = redact(value, s);
    for (const n of r.names) names.add(n);
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, s, names));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, s, names)]));
  }
  return value;
}
