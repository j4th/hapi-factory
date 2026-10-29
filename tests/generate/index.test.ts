import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import YAML from "yaml";
import { main } from "../../src/cli";
import { emitArchon } from "../../src/generate/archon";
import { emitEgress } from "../../src/generate/egress";
import { emitHermes } from "../../src/generate/hermes";
import { buildAll, bundleEntry, DECIDE_ENTRY, GUARD_ENTRY, REPO_ROOT } from "../../src/generate/index";
import { emitMcp } from "../../src/generate/mcp";
import { emitPi } from "../../src/generate/pi";
import { loadPolicy } from "../../src/policy/load";
import type { RosterName } from "../../src/policy/types";

const p = loadPolicy("policy");
const FILES = [
  "archon/archon.env",
  "archon/config.yaml",
  "archon/empty.env",
  "archon/gitconfig",
  "archon/run-config.yaml",
  "decide/hapi-decide.js",
  "egress/archon.squid.conf",
  "egress/hermes.squid.conf",
  "egress/research.squid.conf",
  "hermes/config.yaml",
  "mcp/hermes.mcp.json",
  "mcp/research.mcp.json",
  "pi/extensions/hapi-guard.js",
  "pi/hapi-guard.json",
  "pi/models-store.json",
  "pi/models.json",
  "pi/settings.json",
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
  // Task 3 wrote 8 files (1 Hermes, 2 Archon, 2 Pi, 3 egress); Task 3b adds the 2 per-zone mcp.json files;
  // Plan 02 Task 4 adds 3 Archon run files, 2 Pi files, and the guard and hapi-decide bundles.
  test("writes the seventeen generated files and returns their paths", async () => {
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
    add("mcp", emitMcp(p));
    expected["pi/extensions/hapi-guard.js"] = await bundleEntry(GUARD_ENTRY, REPO_ROOT);
    expected["decide/hapi-decide.js"] = await bundleEntry(DECIDE_ENTRY, REPO_ROOT);
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

  test("the o11y option defaults to flags.otel.enabled and gates Hermes's MCP servers only", async () => {
    const off = tempDir();
    await buildAll(p, off);
    expect(YAML.parse(readFileSync(join(off, "hermes/config.yaml"), "utf8")).mcp_servers).toBeUndefined();
    const on = tempDir();
    await buildAll(p, on, { o11y: true });
    expect(readFileSync(join(on, "hermes/config.yaml"), "utf8")).toBe(emitHermes(p, { o11y: true })["config.yaml"]!);
    expect(Object.keys(YAML.parse(readFileSync(join(on, "hermes/config.yaml"), "utf8")).mcp_servers)).toEqual(["phoenix"]);
    // The scanner files cover the whole catalog either way.
    expect(readFileSync(join(on, "mcp/hermes.mcp.json"), "utf8")).toBe(readFileSync(join(off, "mcp/hermes.mcp.json"), "utf8"));
    const flagged = structuredClone(p);
    flagged.flags.otel.enabled = true;
    const byFlag = tempDir();
    await buildAll(flagged, byFlag);
    expect(readFileSync(join(byFlag, "hermes/config.yaml"), "utf8")).toBe(readFileSync(join(on, "hermes/config.yaml"), "utf8"));
  });

  test("an unknown roster or a policy an emitter refuses writes nothing", async () => {
    const out = tempDir();
    await expect(buildAll(p, out, { roster: "cheap" as RosterName })).rejects.toThrow("unknown roster 'cheap'");
    const forge = structuredClone(p);
    forge.trustedSources.zones.archon.hosts.push("github.com");
    await expect(buildAll(forge, out)).rejects.toThrow(/forge host/);
    const archonMcp = structuredClone(p);
    archonMcp.mcp.servers.context7!.zones = ["archon"];
    await expect(buildAll(archonMcp, out)).rejects.toThrow(/\/servers\/context7\/zones\/0/);
    expect(readdirSync(out)).toEqual([]);
  });

  test("every file starts with the generated-file notice: # comments, or a JSON file's first key, $comment", async () => {
    const out = tempDir();
    for (const roster of ["anthropic", "budget", "portable"] as const) {
      await buildAll(p, out, { roster });
      for (const f of FILES) {
        const text = readFileSync(join(out, f), "utf8");
        let head: string;
        if (f.endsWith(".js")) {
          const lines = text.split("\n");
          head = lines.slice(0, lines.findIndex((l) => !l.startsWith("//"))).join("\n");
        } else if (f.endsWith(".json") && f !== "pi/models-store.json") {
          const parsed = JSON.parse(text);
          expect({ f, first: Object.keys(parsed)[0] }).toEqual({ f, first: "$comment" });
          head = parsed.$comment;
        } else if (f === "pi/models-store.json") {
          // Exempt: Pi reads this file as its model store, so it is bound read-only as exactly {}, with no $comment
          // that Pi might treat as a catalog overlay (spike 08, finding 9; docs/generated-configs.md).
          expect(text).toBe("{}\n");
          continue;
        } else {
          const lines = text.split("\n");
          head = lines.slice(0, lines.findIndex((l) => !l.startsWith("#"))).join("\n");
        }
        expect({ f, notice: head.includes("Do not edit it by hand: change policy/ and run `mise run policy:build`.") }).toEqual({ f, notice: true });
        expect({ f, notice: head.includes("docs/generated-configs.md") }).toEqual({ f, notice: true });
      }
    }
  });

  test("nested output paths are created", async () => {
    const out = tempDir();
    await buildAll(p, out);
    expect(existsSync(join(out, "pi/extensions/hapi-guard.js"))).toBe(true);
    expect(readdirSync(join(out, "pi/extensions"))).toEqual(["hapi-guard.js"]);
  });

  test("the bundles are deterministic: two builds give identical bytes", async () => {
    expect(await bundleEntry(GUARD_ENTRY, REPO_ROOT)).toBe(await bundleEntry(GUARD_ENTRY, REPO_ROOT));
    expect(await bundleEntry(DECIDE_ENTRY, REPO_ROOT)).toBe(await bundleEntry(DECIDE_ENTRY, REPO_ROOT));
  });

  test("a bundle imports nothing but node:*", async () => {
    for (const entry of [GUARD_ENTRY, DECIDE_ENTRY]) {
      const text = await bundleEntry(entry, REPO_ROOT);
      const specs = [...text.matchAll(/^(?:import|export)\b[^;\n]*?["']([^"']+)["']/gm)].map((m) => m[1]!);
      expect(specs.every((s) => s.startsWith("node:"))).toBe(true);
    }
    await expect(bundleEntry("tests/generate/fixtures/external-import.ts", REPO_ROOT)).rejects.toThrow(/bun:sqlite/);
  });

  test("the guard bundle is the placeholder until Task 5: its factory registers session_start, which throws", async () => {
    const dir = tempDir();
    await buildAll(p, dir);
    const mod = await import(join(dir, "pi/extensions/hapi-guard.js"));
    const handlers: Record<string, () => unknown> = {};
    mod.default({ on: (event: string, fn: () => unknown) => void (handlers[event] = fn) });
    expect(Object.keys(handlers)).toEqual(["session_start"]);
    expect(handlers.session_start).toThrow("hapi-guard: placeholder (Plan 02 Task 5)");
  });

  test("the hapi-decide bundle, run with bun from a temp dir under BUN_OPTIONS=--no-install, answers bash-gate --mock from stdin", async () => {
    const dir = tempDir();
    await buildAll(p, dir);
    const run = Bun.spawnSync(["bun", "--no-env-file", join(dir, "decide/hapi-decide.js"), "bash-gate", "--mock"], {
      cwd: dir,
      stdin: new TextEncoder().encode("git status"),
      env: { PATH: process.env.PATH ?? "", HOME: dir, BUN_OPTIONS: "--no-install" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
    const result = JSON.parse(run.stdout.toString().trim().split("\n").pop()!);
    expect(result.via).toBe("mock");
    expect(["allow", "block", "wrap", "flag"]).toContain(result.verdict);
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
