/**
 * mcp.tool-hashes (spec §10.1, handoffs H-026, H-035): the lock as a whole
 * (its hashes, no orphaned entry), each pinned server's allowlisted tools
 * annotated read-only in the locked surface, and the live surfaces of the
 * servers the stack runs. Until Plan 04 wires the live fetch (H-101), a
 * server that runs can only be a skip; today none runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { hashToolSurface, type LockEntry, lockJson, pinOf } from "../../src/mcp/lock";
import { loadPolicy } from "../../src/policy/load";
import { cleanup, cleanWorld, only, REPO, tempDir } from "./helpers";

afterEach(cleanup);

/** A copy of policy/ to change. */
function policyCopy(): string {
  const dir = join(tempDir("hapi-audit-policy-"), "policy");
  cpSync(join(REPO, "policy"), dir, { recursive: true });
  return dir;
}
async function tool(policyDir: string) {
  const w = await cleanWorld();
  w.ctx.policyDir = policyDir;
  return only(await runAudit(w.ctx), "mcp.tool-hashes");
}
function lockEntry(policyDir: string, server: string, tools: { name: string; annotations?: Record<string, unknown> }[]): LockEntry {
  const surface = { tools };
  return { pin: pinOf(loadPolicy(policyDir).mcp.servers[server]!), hash: hashToolSurface(surface), surface };
}

describe("mcp.tool-hashes", () => {
  test("no MCP server runs in this stack today (no o11y, no research container), so there is nothing live to verify: pass, saying so", async () => {
    const r = await tool(join(REPO, "policy"));
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("no MCP server runs");
  });

  test("a server that runs (Phoenix, with o11y on) fails with no lock entry, and is a skip with one until Plan 04 wires the live fetch (H-101)", async () => {
    const dir = policyCopy();
    writeFileSync(join(dir, "flags.yaml"), readFileSync(join(dir, "flags.yaml"), "utf8").replace("otel:         { enabled: false", "otel:         { enabled: true"));
    expect(loadPolicy(dir).flags.otel.enabled).toBe(true);
    let r = await tool(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("phoenix runs in this stack but has no lock entry");
    expect(r.detail).toContain("hapi mcp pin --server phoenix");

    const tools = loadPolicy(dir).mcp.servers.phoenix!.tools.include.map((name) => ({ name, annotations: { readOnlyHint: true } }));
    writeFileSync(join(dir, "mcp.lock.json"), lockJson({ phoenix: lockEntry(dir, "phoenix", tools) }));
    r = await tool(dir);
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("phoenix runs in this stack");
    expect(r.detail).toContain("Plan 04");
  });

  test("an orphaned lock entry fails", async () => {
    const dir = policyCopy();
    const entry = lockEntry(dir, "context7", [{ name: "query-docs", annotations: { readOnlyHint: true } }]);
    writeFileSync(join(dir, "mcp.lock.json"), lockJson({ gone: entry }));
    const r = await tool(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("gone");
    expect(r.detail).toContain("orphaned");
  });

  test("a hand-edited lock (a hash that doesn't match its surface) fails", async () => {
    const dir = policyCopy();
    const entry = lockEntry(dir, "context7", [{ name: "query-docs", annotations: { readOnlyHint: true } }]);
    writeFileSync(join(dir, "mcp.lock.json"), lockJson({ context7: { ...entry, hash: `sha256:${"0".repeat(64)}` } }));
    const r = await tool(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("does not match the stored surface");
  });

  test("an allowlisted tool the locked surface doesn't annotate read-only, or doesn't have, fails (H-035)", async () => {
    const dir = policyCopy();
    const entry = lockEntry(dir, "context7", [{ name: "resolve-library-id", annotations: { readOnlyHint: true } }, { name: "query-docs", annotations: { readOnlyHint: false } }]);
    writeFileSync(join(dir, "mcp.lock.json"), lockJson({ context7: entry }));
    let r = await tool(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("context7's allowlisted tool query-docs is not annotated readOnlyHint: true");

    writeFileSync(join(dir, "mcp.lock.json"), lockJson({ context7: lockEntry(dir, "context7", [{ name: "resolve-library-id", annotations: { readOnlyHint: true } }]) }));
    r = await tool(dir);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("context7's allowlisted tool query-docs is not in its locked surface");

    writeFileSync(
      join(dir, "mcp.lock.json"),
      lockJson({ context7: lockEntry(dir, "context7", [{ name: "resolve-library-id", annotations: { readOnlyHint: true } }, { name: "query-docs", annotations: { readOnlyHint: true } }]) }),
    );
    expect((await tool(dir)).status).toBe("pass");
  });
});
