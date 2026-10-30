/**
 * HAPI_INT=1 only: `mise run policy:build -- --roster ... --out ...` passes its
 * flags through mise to `hapi policy build` (H-020). It needs mise and this
 * checkout trusted (`mise trust`), not Docker or the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

describe.skipIf(!process.env.HAPI_INT)("mise run policy:build", () => {
  let out = "";
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "hapi-policy-build-int-"));
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  test("-- --roster budget --out <dir>: writes the seventeen generated files there, with the budget roster", () => {
    const r = Bun.spawnSync(["mise", "run", "policy:build", "--", "--roster", "budget", "--out", out], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stderr.toString().includes("ERROR")]).toEqual([0, false]);
    const written = r.stdout.toString().trim().split("\n");
    expect(written.map((p) => p.slice(out.length + 1)).sort()).toEqual([
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
    ]);
    // The budget roster: Haiku 5.5 on every Archon tier.
    const archon = readFileSync(join(out, "archon", "config.yaml"), "utf8");
    expect(archon).toContain("the budget roster");
    expect(archon).not.toMatch(/claude-(opus|sonnet)-5-5/);
  });

  test("an unknown roster is a usage error (exit 2), and writes nothing", () => {
    const empty = mkdtempSync(join(out, "empty-"));
    const r = Bun.spawnSync(["mise", "run", "policy:build", "--", "--roster", "nope", "--out", empty], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("unknown roster 'nope'");
    expect(Bun.spawnSync(["ls", "-A", empty]).stdout.toString()).toBe("");
  });
});
