/**
 * Untrusted text a run wrote, made safe to show or keep on the host: `sanitizeTerminal` (no escape sequence, control
 * character or bidi control reaches a terminal), then `redactSecrets` with its zones' values (keys off the screen; no
 * boundary). `hapi run watch` prints every line through both, and finalize keeps a run container's log through both
 * (./lifecycle.ts). Its own module so lifecycle.ts can use it: view.ts imports lifecycle.ts.
 *
 * The run engine also finds and redacts a value's base64 forms (`base64Forms`, `secretHits`, `redactSecretForms`):
 * the harvester's secret scan of a bundle, and what it shows of a run (the worker's account) or sends to a
 * classifier (a decision's state), cover each zone value raw and base64, and every key format.
 */
import { MIN_SECRET_CHARS, redactKeyFormats } from "../guard/secrets";

// String sequences (OSC, DCS, SOS, PM, APC; 7- and 8-bit) up to their terminator (BEL or ST), or to the end of
// the text when there is none; then CSI (7- and 8-bit), any other ESC sequence, and every C0 and C1 control but
// tab and newline, and the bidi controls: the embedding, override and isolate ones (U+202A–202E, U+2066–2069) and
// the marks LRM, RLM and ALM (U+200E, U+200F, U+061C), which can reorder what a terminal shows (Trojan Source; H-220).
const STRING_SEQUENCE = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const CSI = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?/g;
const ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `text` with every terminal escape sequence, every C0/C1 control character but `\n` and `\t`, and every bidi control removed. */
export function sanitizeTerminal(text: string): string {
  return text.replace(STRING_SEQUENCE, "").replace(CSI, "").replace(ESCAPE, "").replace(CONTROL, "");
}

/**
 * `text` with each exact value in `values` of MIN_SECRET_CHARS or more (longest first, so a value inside
 * another is redacted as the longer one), then each key format, replaced by `[hapi: <NAME> redacted]`. The key
 * formats are the guard's (`redactKeyFormats`): KEY_PATTERNS, with a private key redacted whole, body and all, to
 * the end of the text when it has no END line.
 */
export function redactSecrets(text: string, values: Record<string, string>): string {
  let out = text;
  const exact = Object.entries(values).filter(([, v]) => v.length >= MIN_SECRET_CHARS).sort((a, b) => b[1].length - a[1].length);
  for (const [name, value] of exact) out = out.split(value).join(`[hapi: ${name} redacted]`);
  return redactKeyFormats(out).text;
}

/**
 * The base64 forms of `value` that any base64 text holding it must contain, one per alignment of its first byte in
 * the encoded stream: the characters fixed by the value's bytes alone, padding and the partial characters at either
 * end dropped. So a value encoded on its own or inside a longer string is found either way. Forms under
 * MIN_SECRET_CHARS characters are dropped (too short to tell from ordinary text).
 */
export function base64Forms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const forms = new Set<string>();
  for (const k of [0, 1, 2]) {
    const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64").replace(/=+$/, "");
    const end = (k + bytes.length) % 3 === 0 ? enc.length : enc.length - 1;
    const core = enc.slice([0, 2, 3][k], end);
    if (core.length >= MIN_SECRET_CHARS) forms.add(core);
  }
  return [...forms];
}

/**
 * Where `text` holds one of `values` (each of MIN_SECRET_CHARS or more), raw or in a base64 form (`base64Forms`):
 * the value's name and how, never the value. The host's secret scan of a run's bundle reads the bundle with it.
 */
export function secretHits(text: string, values: Record<string, string>): { name: string; form: "raw" | "base64" }[] {
  const hits: { name: string; form: "raw" | "base64" }[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (value.length < MIN_SECRET_CHARS) continue;
    if (text.includes(value)) hits.push({ name, form: "raw" });
    else if (base64Forms(value).some((f) => text.includes(f))) hits.push({ name, form: "base64" });
  }
  return hits;
}

/**
 * `redactSecrets` (each exact value, then each key format), then each value's base64 forms, as `[hapi: <NAME>
 * redacted (base64)]`: what the harvester does to every string of a run's it shows (a worker's account) or sends to
 * a classifier (a decision's state). The same coverage as the host's secret scan of the bundle (`secretHits`), plus
 * the key formats.
 */
export function redactSecretForms(text: string, values: Record<string, string>): string {
  let out = redactSecrets(text, values);
  const encoded = Object.entries(values)
    .filter(([, v]) => v.length >= MIN_SECRET_CHARS)
    .flatMap(([name, v]) => base64Forms(v).map((form) => [name, form] as const))
    .sort((a, b) => b[1].length - a[1].length);
  for (const [name, form] of encoded) out = out.split(form).join(`[hapi: ${name} redacted (base64)]`);
  return out;
}

/**
 * An error's message and its causes', for a reason or a report: each cause once, unless its text is already in the
 * message above it, joined by `; caused by: `. With `firstLines`, each part is its first line only (the tick report's
 * one line per repo). The run engine's reasons (src/engine/pipeline.ts) and the CLI's last line (src/cli.ts, `asHapi`)
 * both use it, so a cleanup failure's original error always reaches the operator.
 */
export function errorText(e: unknown, o: { firstLines?: boolean } = {}): string {
  const parts: string[] = [];
  let x: unknown = e;
  for (let i = 0; i < 5 && x !== undefined && x !== null; i++) {
    const text = x instanceof Error ? x.message : String(x);
    const m = o.firstLines ? (text.trim().split("\n")[0] ?? "").trim() : text;
    if (!parts.some((p) => p.includes(m))) parts.push(m);
    x = x instanceof Error ? x.cause : undefined;
  }
  return parts.join("; caused by: ");
}
