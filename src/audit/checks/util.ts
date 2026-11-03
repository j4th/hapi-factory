/** Helpers the audit's checks share (D95: one copy of each). */

/** The first non-empty line of `s` (a command's stderr, a tool's output), trimmed, at most `max` characters. */
export function firstLine(s: string, max = 300): string {
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return (line ?? "").slice(0, max);
}
