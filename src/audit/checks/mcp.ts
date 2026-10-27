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
 * Any of these failing is a fail.
 * What it can't yet: compare the live surfaces of the servers that run with
 * the lock, which is what the check verifies. That needs the live fetch Plan
 * 04 wires (H-101), so until then the check can only skip once the offline
 * checks pass, saying why (H-026), whether or not a server runs: the audit
 * reads which servers run from policy, not from the running stack (today
 * none: the hermes zone enables Phoenix only with o11y, archon never loads
 * one, and the research container arrives in Plan 04). With `--strict` that
 * skip is a fail, which stage b expects until H-101 closes
 * (docs/runbooks/stack.md#5-the-audit).
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
  const running =
    runs.length > 0
      ? `${runs.join(", ")} run${runs.length === 1 ? "s" : ""} in this stack`
      : `no MCP server runs in this stack by policy (the hermes zone enables none with o11y ${o11yEnabled(p) ? "on" : "off"}, archon never loads one, and the research container arrives in Plan 04)`;
  return [
    result(
      id,
      "skip",
      `the live tool surfaces can't be compared with the lock until Plan 04 wires the live fetch (\`hapi mcp verify\`, H-101); ${running}; the offline lock checks pass: ${counts}`,
    ),
  ];
}
