/**
 * The built bundle, as Pi loads it: build/pi/extensions/hapi-guard.js imported
 * natively by a bare bun from a temp dir with BUN_OPTIONS=--no-install and no
 * node_modules (spike 08, findings 1 and 2). It must run the shared path
 * vectors exactly as src/policy/paths.ts does (H-087, H-089).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleEntry, GUARD_ENTRY, REPO_ROOT } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { effectiveModes } from "../../src/policy/paths";
import { cleanupAll, gatesOff, pinnedModel, setup } from "./harness";

afterEach(cleanupAll);

const p = loadPolicy("policy");
const vectors = JSON.parse(readFileSync("tests/fixtures/path-vectors.json", "utf8")) as { paths: { path: string }[] };

/** The script the bare bun runs: it imports the bundle and drives it with a fake Pi, printing one JSON line. */
const RUNNER = `
const [bundle, fixture] = process.argv.slice(2);
const f = JSON.parse(await Bun.file(fixture).text());
const mod = await import(bundle);
const fake = () => {
  const handlers = new Map(), registered = [];
  return { handlers, registered, on: (e, h) => void handlers.set(e, [...(handlers.get(e) ?? []), h]), registerTool: () => registered.push("tool"), registerFlag: () => registered.push("flag") };
};
const fire = async (pi, event, payload, ctx) => { let r; for (const h of pi.handlers.get(event) ?? []) { const x = await h({ type: event, ...payload }, ctx); if (x !== undefined) r = x; } return r; };
const out = { defaultType: typeof mod.default };
// The default export with no settings: only a failing session_start.
const bad = fake();
mod.default(bad);
out.badEvents = [...bad.handlers.keys()];
try { await fire(bad, "session_start", {}, {}); } catch (e) { out.badMessage = e.message; }
// The guard with good settings: every vector through write.
const pi = fake();
mod.createGuard(pi, { env: f.env, tmpRoot: f.tmp, home: f.home, decide: { mock: true } });
const ctx = { cwd: f.work, model: f.model, sessionManager: { getEntries: () => [], getSessionId: () => "s" } };
await fire(pi, "session_start", { reason: "startup" }, ctx);
out.registered = pi.registered;
out.blocks = [];
for (const path of f.paths) out.blocks.push((await fire(pi, "tool_call", { toolCallId: "c", toolName: "write", input: { path, content: "x" } }, ctx))?.block === true);
console.log(JSON.stringify(out));
`;

test("the built bundle, imported from a temp dir with BUN_OPTIONS=--no-install, exports a default function and runs every path vector the same as src/policy/paths.ts", async () => {
  const h = setup({ settings: gatesOff });
  const ext = join(h.base, "bundle");
  const runner = join(h.base, "runner");
  mkdirSync(ext);
  mkdirSync(runner);
  const text = await bundleEntry(GUARD_ENTRY, REPO_ROOT);
  writeFileSync(join(ext, "hapi-guard.js"), text);
  writeFileSync(join(runner, "run.mjs"), RUNNER);
  const paths = vectors.paths.map((v) => v.path);
  // h.env has already lost its secret names to the harness's own guard; the bundle needs none of them (decide is mocked).
  writeFileSync(join(runner, "fixture.json"), JSON.stringify({ env: h.env, tmp: h.tmp, home: h.home, work: h.work, model: pinnedModel(), paths }));

  const run = Bun.spawnSync(["bun", "--no-env-file", join(runner, "run.mjs"), join(ext, "hapi-guard.js"), join(runner, "fixture.json")], {
    cwd: runner,
    env: { PATH: process.env.PATH ?? "", HOME: h.home, BUN_OPTIONS: "--no-install" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect([run.exitCode, run.stderr.toString()]).toEqual([0, ""]);
  const out = JSON.parse(run.stdout.toString().trim().split("\n").pop()!);
  expect(out.defaultType).toBe("function");
  expect(out.badEvents).toEqual(["session_start"]);
  expect(out.badMessage).toBe("hapi-guard: PI_CODING_AGENT_DIR is not set; the node fails closed");
  expect(out.registered).toEqual([]);
  const want = paths.map((path) => {
    try {
      return effectiveModes(p, path).workers !== "allow";
    } catch {
      return true;
    }
  });
  expect(paths.map((path, i) => [path, out.blocks[i]])).toEqual(paths.map((path, i) => [path, want[i]]));
});

test("the bundle imports nothing but node:*", async () => {
  const text = await bundleEntry(GUARD_ENTRY, REPO_ROOT);
  const specs = [...text.matchAll(/^(?:import|export)\b[^;\n]*?["']([^"']+)["']/gm)].map((m) => m[1]!);
  expect(specs.length).toBeGreaterThan(0);
  expect(specs.filter((s) => !s.startsWith("node:"))).toEqual([]);
});
