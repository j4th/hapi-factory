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
/** What a line of a private key's body holds: base64, a `Name: value` header (an encrypted key's `Proc-Type:`), or nothing. */
const PEM_BODY = String.raw`(?:[A-Za-z0-9+/=]+|[A-Za-z-]+: [^\r\n]*|)`;
/** One whole line of a private key's body, without its newline (as `hapi run watch` gets a line). */
export const PEM_BODY_LINE = new RegExp(`^${PEM_BODY}\\r?$`);
/** One whole line that is a private key's END line. */
export const PEM_END_LINE = new RegExp(`^${PEM_END}\\r?$`);
/** A BEGIN line with no END line after it in the same text: the key's body is still to come. */
export const PEM_OPEN = new RegExp(`${PEM_BEGIN}(?![\\s\\S]*${PEM_END})`);
/**
 * A private key's block: its BEGIN line, then each following line while it is a body line (PEM_BODY), then its END
 * line if that comes next. It stops at the first line that is neither, so a BEGIN line alone hides no text after it,
 * and a truncated key never runs on into the next. Each body line is matched up to a line end it looks ahead for, so
 * a long line that isn't one costs one linear scan, never a backtracking blow-up.
 */
const PRIVATE_KEY_BLOCK = new RegExp(`${PEM_BEGIN}(?:\\r?\\n${PEM_BODY}(?=\\r?\\n|$))*(?:\\r?\\n${PEM_END})?`, "g");

/**
 * KEY_PATTERNS as redaction patterns, global, by the same names. `private-key` matches only a key's BEGIN line,
 * which is enough to find one (`findSecret`), but redacting that line alone would leave the key's body in the text,
 * so it is redacted as PRIVATE_KEY_BLOCK (ledger 168). That form lives here, not in policy/decisions/write-gate.ts,
 * which is under policy/**. Shared with `hapi run watch` (src/run/sanitize.ts), whose live printer uses the same
 * line rule (PEM_BODY_LINE) across the lines it is handed one at a time.
 */
export const REDACT_PATTERNS: readonly { name: string; re: RegExp }[] = KEY_PATTERNS.map(({ name, re }) => ({
  name,
  re: name === "private-key" ? PRIVATE_KEY_BLOCK : new RegExp(re.source, `${re.flags.replace("g", "")}g`),
}));

/**
 * The text with every exact value replaced by `[hapi: <NAME> redacted]`, then
 * every REDACT_PATTERNS match by `[hapi: <pattern name> redacted]` (a private
 * key's whole block), and the names found: a key in a repo file the worker
 * reads is not sent on to a classifier.
 */
export function redact(text: string, s: Secrets): { text: string; names: string[] } {
  const names: string[] = [];
  let out = text;
  for (const [name, value] of s.values) {
    if (!out.includes(value)) continue;
    names.push(name);
    out = out.split(value).join(`[hapi: ${name} redacted]`);
  }
  for (const { name, re } of REDACT_PATTERNS) {
    const next = out.replace(re, `[hapi: ${name} redacted]`);
    if (next === out) continue;
    names.push(name);
    out = next;
  }
  return { text: out, names };
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
