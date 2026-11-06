/**
 * The handoffs register (docs/superpowers/plans/handoffs.md) is the one committed record of deferred work. These
 * tests hold two of its rules, with no network:
 * - an id names one item: it is listed once, open (`- **H-NNN**` before `## Closed`) or closed (`| **H-NNN**` after
 *   it), never both. An id may have more than one entry only when it was split in halves, each entry naming its half
 *   right after the id (`**H-182** (Plan 02's half)`), and no two naming the same half; once both halves close, they
 *   merge into one Closed row (Plan 03's ruling b4);
 * - every id the Plan 03 design's `**Register:**` line pulls into Plan 03 (each `H-a to H-b` range expanded) is
 *   closed (a Closed row, and no open entry left), or still open with a `**Plan 03 (…):**` update saying what landed
 *   and where the rest goes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const REGISTER = readFileSync(join(REPO, "docs/superpowers/plans/handoffs.md"), "utf8");
const DESIGN = readFileSync(join(REPO, "docs/superpowers/specs/2026-10-31-hapi-factory-03-run-engine-design.md"), "utf8");

const cut = REGISTER.indexOf("\n## Closed");
const OPEN = REGISTER.slice(0, cut).split("\n");
const CLOSED = REGISTER.slice(cut).split("\n");

/** Every entry: its id, whether it is open, the half it names (if any) and its line. */
function entries(): { id: string; open: boolean; half: string | undefined; line: string }[] {
  const out: { id: string; open: boolean; half: string | undefined; line: string }[] = [];
  for (const [lines, open, re] of [
    [OPEN, true, /^- \*\*(H-\d{3})\*\*/],
    [CLOSED, false, /^\| \*\*(H-\d{3})\*\*/],
  ] as const) {
    for (const line of lines) {
      const m = re.exec(line);
      if (m === null) continue;
      const half = /^ \(([^()]*?'s half)\b/.exec(line.slice(m[0].length))?.[1];
      out.push({ id: m[1]!, open, half, line: line.slice(0, 80) });
    }
  }
  return out;
}

/** The ids the design's Register line names, ranges expanded. */
function designIds(): string[] {
  const line = DESIGN.split("\n").find((l) => l.startsWith("- **Register:**"));
  if (line === undefined) throw new Error("the Plan 03 design has no **Register:** line");
  const ids: string[] = [];
  for (const m of line.matchAll(/H-(\d{3})(?: to H-(\d{3}))?/g)) {
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let n = from; n <= to; n++) ids.push(`H-${String(n).padStart(3, "0")}`);
  }
  return ids;
}

describe("the handoffs register", () => {
  test("the parsers see the register (the control): open items, closed rows and the design's ids", () => {
    const all = entries();
    expect(all.filter((e) => e.open).length).toBeGreaterThan(50);
    expect(all.filter((e) => !e.open).length).toBeGreaterThan(50);
    const ids = designIds();
    expect(ids).toContain("H-090");
    expect(ids).toContain("H-205"); // inside "H-203 to H-211"
    expect(ids).toContain("H-230");
    expect(ids.length).toBeGreaterThan(25);
  });

  test("no register id is listed twice, or both open and closed, but a split item", () => {
    const byId = new Map<string, ReturnType<typeof entries>>();
    for (const e of entries()) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
    const problems: string[] = [];
    for (const [id, list] of byId) {
      if (list.length === 1) continue;
      const halves = list.map((e) => e.half);
      if (halves.some((h) => h === undefined)) problems.push(`${id} has ${list.length} entries, not each naming its half: ${list.map((e) => `${e.open ? "open" : "closed"} "${e.line}"`).join(", ")}`);
      else if (new Set(halves).size !== halves.length) problems.push(`${id}'s entries name the same half twice: ${halves.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  test("every id the Plan 03 design names in its Register line is closed, or open with a Plan 03 update", () => {
    const all = entries();
    const missing: string[] = [];
    for (const id of designIds()) {
      const mine = all.filter((e) => e.id === id);
      // Closed means no open entry is left: a split item with one half closed still needs its open half's update.
      const open = OPEN.filter((l) => l.startsWith(`- **${id}**`));
      const closed = open.length === 0 && mine.some((e) => !e.open);
      const updated = open.length > 0 && open.every((l) => l.includes("**Plan 03 ("));
      if (!closed && !updated) missing.push(`${id}: ${mine.length === 0 ? "not in the register" : "open with no **Plan 03 (…):** update"}`);
    }
    expect(missing).toEqual([]);
  });
});
