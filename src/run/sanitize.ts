/**
 * Untrusted text a run wrote, made safe to show or keep on the host: `sanitizeTerminal` (no escape sequence or
 * control character reaches a terminal), then `redactSecrets` with the archon zone's values (keys off the screen;
 * no boundary). `hapi run watch` prints every line through both, and finalize keeps a run container's log through
 * both (./lifecycle.ts). Its own module so lifecycle.ts can use it: view.ts imports lifecycle.ts.
 */
import { MIN_SECRET_CHARS, redactKeyFormats } from "../guard/secrets";

// String sequences (OSC, DCS, SOS, PM, APC; 7- and 8-bit) up to their terminator (BEL or ST), or to the end of
// the text when there is none; then CSI (7- and 8-bit), any other ESC sequence, and every C0 and C1 control but
// tab and newline.
const STRING_SEQUENCE = /(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g;
const CSI = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?/g;
const ESCAPE = /\x1b[\x20-\x2f]*[\x30-\x7e]?/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/** `text` with every terminal escape sequence and every C0/C1 control character removed, but `\n` and `\t`. */
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
