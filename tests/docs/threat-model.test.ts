/**
 * docs/security/threat-model.md is where spec §11.9's six residual risks, and
 * every accepted residual the handoffs register sends to Plan 01 Task 7, are
 * recorded. docs/runbooks/kill-switches.md is spec §11.8's four kill switches.
 * These tests keep both honest, with no network:
 * - each §11.9 residual has its section at a stable anchor, `<a id="residual-N"></a>`
 *   (N = 1..6, the spec's numbering), naming its owner control and its next level;
 * - every register item Task 7 closed (H-038–H-052 and H-137) has its entry at
 *   `<a id="h-NNN"></a>` (an owner control and a next level, except H-052, which is
 *   about the review), and its row in the register's Closed table points there;
 * - every repo path the two docs write in backticks exists. A path is a backticked
 *   word that starts `src/`, `stack/`, `policy/`, `scripts/`, `docs/` or `tests/`, or
 *   holds a `/` and ends in an extension; `build/` (generated) and `private/` (the
 *   operator's) are left out, and so is anything with a placeholder or a variable
 *   in it (`<zone>`, `$XDG_RUNTIME_DIR`, `~`, `*`). Write anything else as a link.
 * - the runbook gives each switch what it stops, what it doesn't, how to confirm it,
 *   how to undo it and when it takes effect, fastest first.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const MODEL = "docs/security/threat-model.md";
const KILL = "docs/runbooks/kill-switches.md";
const read = (file: string) => readFileSync(join(REPO, file), "utf8");

/** The register items Task 7 closes into the threat model (handoffs.md, "Plan 01 Task 7"). */
const TASK7_ITEMS = [...Array.from({ length: 15 }, (_, i) => 38 + i), 137].map((n) => `H-${String(n).padStart(3, "0")}`);

const REPO_PREFIXES = ["src/", "stack/", "policy/", "scripts/", "docs/", "tests/"];

/** The repo paths a doc writes in backticks (see the header for what counts). */
function repoPathsIn(text: string): string[] {
  const paths = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const word = m[1]!;
    if (/\s/.test(word)) continue; // a command or a phrase, not a path
    const path = word.replace(/#.*$/, ""); // a link fragment
    if (/^[/~$<@]/.test(path) || /[<>*{}$:@=?|"'\\]/.test(path)) continue; // absolute, home, variable, placeholder, image ref
    if (path.startsWith("build/") || path.startsWith("private/")) continue;
    const last = path.split("/").pop() ?? "";
    if (REPO_PREFIXES.some((p) => path.startsWith(p)) || (path.includes("/") && /\.[A-Za-z0-9]+$/.test(last))) paths.add(path);
  }
  return [...paths].sort();
}

/** The text of the section that starts at `<a id="id"></a>`, up to the next anchor or `##` heading. */
function section(text: string, id: string): string | undefined {
  const start = text.indexOf(`<a id="${id}"></a>`);
  if (start < 0) return undefined;
  const rest = text.slice(start + id.length + 13);
  const end = rest.search(/<a id="|\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the threat model", () => {
  const model = existsSync(join(REPO, MODEL)) ? read(MODEL) : "";

  test("exists", () => {
    expect(existsSync(join(REPO, MODEL))).toBe(true);
  });

  // Spec §11.9, in order, each with words its section must use.
  const RESIDUALS: [number, string[]][] = [
    [1, ["in-process", "Archon"]],
    [2, ["allowed hosts"]],
    [3, ["keys", "containers"]],
    [4, ["protected-file gate"]],
    [5, ["repo content"]],
    [6, ["review"]],
  ];
  for (const [n, words] of RESIDUALS) {
    test(`spec §11.9 residual ${n} has its entry, with an owner control and a next level`, () => {
      const s = section(model, `residual-${n}`);
      expect([n, s !== undefined]).toEqual([n, true]);
      for (const w of ["**Owner control", "**Next level", ...words]) expect([n, w, s!.includes(w)]).toEqual([n, w, true]);
    });
  }

  for (const id of TASK7_ITEMS) {
    test(`${id} has its entry${id === "H-052" ? "" : ", with an owner control and a next level"}`, () => {
      expect(model).toContain(id);
      const s = section(model, id.toLowerCase());
      expect([id, s !== undefined]).toEqual([id, true]);
      if (id !== "H-052") for (const w of ["**Owner control", "**Next level"]) expect([id, w, s!.includes(w)]).toEqual([id, w, true]);
    });
  }
});

describe("the handoffs register", () => {
  const register = read("docs/superpowers/plans/handoffs.md");
  const closed = register.slice(register.indexOf("\n## Closed"));
  const open = register.slice(0, register.indexOf("\n## Closed"));

  for (const id of TASK7_ITEMS) {
    test(`${id} is closed, its Closed row pointing at its threat-model entry`, () => {
      expect([id, open.includes(`- **${id}**`)]).toEqual([id, false]);
      const row = closed.split("\n").find((l) => l.startsWith(`| **${id}**`));
      expect([id, row?.includes(`${MODEL}#${id.toLowerCase()}`)]).toEqual([id, true]);
    });
  }
});

describe("repo paths in backticks exist", () => {
  test("the extractor (the control): repo paths in, everything else out", () => {
    const sample =
      "`src/nope.ts` `docs/runbooks/stack.md#5-the-audit` `.github/workflows/ci.yml` `stack/` `~/.config/hapi/secrets.yaml` " +
      "`$XDG_RUNTIME_DIR/hapi/env/<zone>.env` `build/pi/models.json` `private/secrets.enc.yaml` `ghcr.io/coleam00/archon:0.12.1` " +
      "`mise run down` `plan/**` `AGENTS.md` `@upstash/context7-mcp` `.github/CODEOWNERS`";
    expect(repoPathsIn(sample)).toEqual([".github/workflows/ci.yml", "docs/runbooks/stack.md", "src/nope.ts", "stack/"]);
  });

  for (const doc of [MODEL, KILL]) {
    test(`${doc}: every repo path it names exists`, () => {
      expect(existsSync(join(REPO, doc))).toBe(true);
      const paths = repoPathsIn(read(doc));
      expect(paths.length).toBeGreaterThan(doc === MODEL ? 30 : 2);
      expect(paths.filter((p) => !existsSync(join(REPO, p)))).toEqual([]);
    });
  }
});

describe("the kill-switch runbook", () => {
  const runbook = existsSync(join(REPO, KILL)) ? read(KILL) : "";

  test("has spec §11.8's four switches, fastest first, each saying what it stops and doesn't, how to confirm and undo it, and when it takes effect", () => {
    const starts = [1, 2, 3, 4].map((n) => runbook.indexOf(`\n## ${n}. `));
    expect(starts.every((s) => s >= 0)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    const bodies = starts.map((s, i) => runbook.slice(s, starts[i + 1] ?? runbook.indexOf("\n## ", s + 5)));
    for (const [i, body] of bodies.entries()) {
      for (const label of ["**Stops:**", "**Doesn't stop:**", "**Confirm:**", "**Undo:**", "**Takes effect:**"]) {
        expect([i + 1, label, body.includes(label)]).toEqual([i + 1, label, true]);
      }
    }
  });

  test("switch 4 drops hapi's traffic in a dedicated nft table, so the undo is one `nft delete table`", () => {
    expect(runbook).toContain("meta skuid hapi");
    expect(runbook).toContain("sudo nft delete table inet hapi_kill");
    expect(runbook).toContain("-m owner --uid-owner hapi");
  });
});
