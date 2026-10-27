/**
 * mcp.tool-hashes (spec §10.1, the rug-pull defense; handoffs H-026, H-035).
 *
 * What it can check today, offline, from policy/ (loaded with `loadPolicy`,
 * so a server listing the archon zone is refused before anything else, H-031):
 * - the lock (`loadLock`): its schema, and every hash matches its stored
 *   surface, so a hand edit shows;
 * - no lock entry is orphaned (its server left the catalog);
 * - for each server pinned at its current pin, every allowlisted tool
 *   (`tools.include`) is in the locked surface with `readOnlyHint: true`
 *   (H-035): `tools.deny` sits in the same file, so this is the check that a
 *   write tool didn't slip into the allowlist;
 * - every server the stack runs (the zone services' enabled servers) has a
 *   lock entry for its pin.
 * What it can't yet: compare a running server's live surface with the lock.
 * That needs the live fetch Plan 04 wires (H-101), so a server that runs
 * makes this a skip. Today none runs (the hermes zone enables Phoenix only
 * with o11y; the research container arrives in Plan 04), so there is nothing
 * live to compare, and that is a pass that says so.
 */
import { join } from "node:path";
import { canonicalJson, loadLock, pinOf } from "../../mcp/lock";
import { loadPolicy } from "../../policy/load";
import { isMcpZone, o11yEnabled, serversForZone } from "../../policy/mcp";
import { ZONE_SERVICES } from "../../stack/env";
import { type AuditRun, type CheckResult, result } from "../types";

/** mcp.tool-hashes */
export async function mcpToolHashes(run: AuditRun): Promise<CheckResult[]> {
  const id = "mcp.tool-hashes";
  const p = loadPolicy(run.ctx.policyDir);
  const lockFile = join(run.ctx.policyDir, "mcp.lock.json");
  const lock = loadLock(lockFile);
  const problems: string[] = [];
  for (const name of Object.keys(lock).sort()) {
    if (!Object.hasOwn(p.mcp.servers, name)) problems.push(`lock entry ${name} is orphaned: no server of that name is in mcp.yaml; remove it in the PR that removed the server`);
  }
  const pinned = new Set<string>();
  for (const [name, s] of Object.entries(p.mcp.servers).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = Object.hasOwn(lock, name) ? lock[name]! : undefined;
    if (entry === undefined || canonicalJson(entry.pin) !== canonicalJson(pinOf(s))) continue;
    pinned.add(name);
    for (const tool of s.tools.include) {
      const t = entry.surface.tools.find((x) => x.name === tool);
      if (t === undefined) problems.push(`${name}'s allowlisted tool ${tool} is not in its locked surface`);
      else if ((t.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint !== true) {
        problems.push(`${name}'s allowlisted tool ${tool} is not annotated readOnlyHint: true in its locked surface: allowlist read-only tools only (spec §10.1)`);
      }
    }
  }
  const runs = [...new Set(ZONE_SERVICES.filter(isMcpZone).flatMap((zone) => serversForZone(p, zone).map(([name]) => name)))].sort();
  for (const name of runs) if (!pinned.has(name)) problems.push(`${name} runs in this stack but has no lock entry for its pin: review its surface and pin it (\`hapi mcp pin --server ${name}\`)`);

  const catalog = Object.keys(p.mcp.servers).length;
  const counts = `the lock (${lockFile}) holds ${Object.keys(lock).length} entries for ${catalog} catalog servers, ${pinned.size} pinned at their current pin`;
  if (problems.length > 0) return [result(id, "fail", `${problems.join("; ")}; ${counts}`)];
  if (runs.length > 0) {
    return [
      result(
        id,
        "skip",
        `${runs.join(", ")} run${runs.length === 1 ? "s" : ""} in this stack, but a live tool surface can't be fetched until Plan 04 wires \`hapi mcp verify\` (H-101), so it wasn't compared with the lock; ${counts}`,
      ),
    ];
  }
  return [
    result(
      id,
      "pass",
      `no MCP server runs in this stack (the hermes zone enables none with o11y ${o11yEnabled(p) ? "on" : "off"}, archon never loads one, and the research container arrives in Plan 04), so there is no live surface to compare; ${counts}`,
    ),
  ];
}
