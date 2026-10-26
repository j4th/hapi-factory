import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import YAML from "yaml";
import { main } from "../../src/cli";
import { emitArchon } from "../../src/generate/archon";
import { emitEgress } from "../../src/generate/egress";
import { emitHermes } from "../../src/generate/hermes";
import { buildAll } from "../../src/generate/index";
import { emitPi } from "../../src/generate/pi";
import { loadPolicy } from "../../src/policy/load";
import type { RosterName } from "../../src/policy/types";

const p = loadPolicy("policy");
const FILES = [
  "archon/archon.env",
  "archon/config.yaml",
  "egress/archon.squid.conf",
  "egress/hermes.squid.conf",
  "egress/research.squid.conf",
  "hermes/config.yaml",
  "pi/hapi-guard.json",
  "pi/models.json",
];

let temps: string[] = [];
let restore: (() => void)[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  for (const r of restore) r();
  temps = [];
  restore = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-build-"));
  temps.push(dir);
  return dir;
}
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restore.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}

describe("buildAll", () => {
  // The plan's Step 5 says "the 9 files above", but its list names 8: 1 Hermes, 2 Archon, 2 Pi, 3 egress.
  test("writes the eight generated files and returns their paths", async () => {
    const out = tempDir();
    const paths = await buildAll(p, out);
    expect(paths.map((f) => relative(out, f)).sort()).toEqual(FILES);
  });

  test("each file is exactly its emitter's output", async () => {
    const out = tempDir();
    await buildAll(p, out);
    const expected: Record<string, string> = {};
    const add = (dir: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) expected[`${dir}/${name}`] = text;
    };
    add("hermes", emitHermes(p));
    add("archon", emitArchon(p, "anthropic"));
    add("pi", emitPi(p, "anthropic"));
    add("egress", emitEgress(p));
    expect(Object.keys(expected).sort()).toEqual(FILES);
    for (const [file, text] of Object.entries(expected)) expect(readFileSync(join(out, file), "utf8")).toBe(text);
  });

  test("the roster option selects Archon's tiers and Pi's models; Hermes stays on the anthropic roster", async () => {
    const out = tempDir();
    await buildAll(p, out, { roster: "budget" });
    expect(YAML.parse(readFileSync(join(out, "archon/config.yaml"), "utf8")).tiers.large.model).toBe("anthropic/claude-haiku-5-5");
    expect(readFileSync(join(out, "pi/models.json"), "utf8")).toBe(emitPi(p, "budget")["models.json"]!);
    expect(readFileSync(join(out, "hermes/config.yaml"), "utf8")).toBe(emitHermes(p)["config.yaml"]!);
  });

  test("an unknown roster or a policy an emitter refuses writes nothing", async () => {
    const out = tempDir();
    await expect(buildAll(p, out, { roster: "cheap" as RosterName })).rejects.toThrow("unknown roster 'cheap'");
    const forge = structuredClone(p);
    forge.trustedSources.zones.archon.hosts.push("github.com");
    await expect(buildAll(forge, out)).rejects.toThrow(/forge host/);
    expect(readdirSync(out)).toEqual([]);
  });

  test("two builds are byte-identical (no timestamps, stable order)", async () => {
    const a = tempDir();
    const b = tempDir();
    await buildAll(p, a, { roster: "portable" });
    await buildAll(loadPolicy("policy"), b, { roster: "portable" });
    for (const f of FILES) expect(readFileSync(join(a, f), "utf8")).toBe(readFileSync(join(b, f), "utf8"));
  });
});

describe("hapi policy build", () => {
  test("builds into --out with --roster and prints each path", async () => {
    const { out } = capture();
    const dir = tempDir();
    expect(await main(["policy", "build", "--policy", "policy", "--out", dir, "--roster", "budget"])).toBe(0);
    expect(out.map((f) => relative(dir, f)).sort()).toEqual(FILES);
    expect(readFileSync(join(dir, "pi/models.json"), "utf8")).toBe(emitPi(p, "budget")["models.json"]!);
  });

  test("an unknown roster, an unknown flag or a missing value is a usage error (exit 2)", async () => {
    const { err } = capture();
    const dir = tempDir();
    expect(await main(["policy", "build", "--out", dir, "--roster", "cheap"])).toBe(2);
    expect(await main(["policy", "build", "--out", dir, "--force"])).toBe(2);
    expect(await main(["policy", "build", "--out"])).toBe(2);
    expect(await main(["policy", "build", "extra"])).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi policy build");
    expect(err.join("\n")).toContain("unknown roster 'cheap'");
  });

  test("a bad policy directory fails with exit 1 and names the file", async () => {
    const { err } = capture();
    expect(await main(["policy", "build", "--policy", join(tempDir(), "missing"), "--out", tempDir()])).toBe(1);
    expect(err.join("\n")).toMatch(/hapi policy build: .*protected_paths\.yaml/);
  });
});
