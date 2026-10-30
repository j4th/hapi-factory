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
const GLOBAL_PATTERNS = KEY_PATTERNS.map(({ name, re }) => ({ name, re: new RegExp(re.source, `${re.flags.replace("g", "")}g`) }));

/**
 * The text with every exact value replaced by `[hapi: <NAME> redacted]`, then
 * every KEY_PATTERNS match by `[hapi: <pattern name> redacted]`, and the names
 * found: a key in a repo file the worker reads is not sent on to a classifier.
 */
export function redact(text: string, s: Secrets): { text: string; names: string[] } {
  const names: string[] = [];
  let out = text;
  for (const [name, value] of s.values) {
    if (!out.includes(value)) continue;
    names.push(name);
    out = out.split(value).join(`[hapi: ${name} redacted]`);
  }
  for (const { name, re } of GLOBAL_PATTERNS) {
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
