/**
 * MCP servers in generated configs (spec §10.1), from policy/mcp.yaml.
 *
 * - `hermesMcpServers(p, zone, opts)`: Hermes's `mcp_servers` for one zone's
 *   profile: the zone's enabled servers (`serversForZone`). `emitHermes` uses
 *   it for the hermes zone; Plan 04's hapi-research profile uses it for the
 *   research zone.
 * - `emitMcpJson(p, zone)`: a standard `mcp.json` (`{"mcpServers": {...}}`) for
 *   the zone, written to build/mcp/<zone>.mcp.json for the CI scanners (Plan 05).
 *   It lists the zone's whole catalog, o11y-gated servers included, because
 *   the scanners vet what may run, not what runs today. The archon zone has no
 *   MCP servers and no file.
 *
 * No secret is ever in either. A `bws:<key>` env value becomes `${NAME}`, with
 * NAME from `secretEnvName` (HAPI_MCP_...): Hermes resolves it from its env,
 * which the stack fills from bws, and the scanners see only the reference.
 *
 * A stdio server's command is `npx --yes <name>@<version>`. That pins the
 * package but not its dependency tree; the per-server image built from a
 * committed lockfile (the catalog's `image`, Task 5 and Plan 04) replaces it.
 *
 * Every function here re-checks the catalog first (schema and `mcpIssues`), so
 * a policy built in code, which skips the loader, can't emit a server the
 * loader would refuse.
 */
import { check, formatIssue } from "../policy/schema";
import { MCP_ZONES, type McpOptions, type McpZone, mcpIssues, secretEnvName, secretKey, serversForZone } from "../policy/mcp";
import type { McpServer, Policy } from "../policy/types";
import { notice } from "./header";

/** Throw if the catalog fails the schema or `mcpIssues`, naming each problem's path in mcp.yaml. */
function checkCatalog(p: Policy): void {
  const schemaIssues = check("policy-mcp", p.mcp);
  const issues = schemaIssues.length > 0 ? schemaIssues : mcpIssues(p.mcp);
  if (issues.length > 0) throw new Error(`policy/mcp.yaml: ${issues.map(formatIssue).join("; ")}`);
}

function checkZone(zone: string): asserts zone is McpZone {
  if (!(MCP_ZONES as readonly string[]).includes(zone)) {
    throw new Error(`the ${zone} zone gets no MCP servers (spec §10.1); MCP zones: ${MCP_ZONES.join(", ")}`);
  }
}

/** A stdio server's launch command, from its exact package pin. */
function launch(name: string, s: McpServer): { command: string; args: string[] } {
  if (s.package === undefined) throw new Error(`unreachable: stdio server ${name} has no package`);
  return { command: "npx", args: ["--yes", `${s.package.name}@${s.package.version}`] };
}

/** The server's env with every bws reference as `${HAPI_MCP_...}`, keys sorted. */
function envRefs(s: McpServer): Record<string, string> {
  return Object.fromEntries(
    Object.keys(s.env)
      .sort()
      .map((env) => {
        const value = s.env[env]!;
        const key = secretKey(value);
        return [env, key === undefined ? value : `\${${secretEnvName(key)}}`];
      }),
  );
}

/**
 * Hermes's `mcp_servers` for a zone (Hermes v0.22.5 keys): `command`, `args`
 * and `env` (Hermes passes a stdio server only these, plus a safe baseline),
 * or `url`; `tools.include` with prompts and resources off; `trust: untrusted`;
 * elicitation and sampling off. Pure.
 */
export function hermesMcpServers(p: Policy, zone: McpZone, opts: McpOptions = {}): Record<string, unknown> {
  checkCatalog(p);
  checkZone(zone);
  return Object.fromEntries(
    serversForZone(p, zone, opts).map(([name, s]) => [
      name,
      {
        ...(s.transport === "http" ? { url: s.url } : { ...launch(name, s), env: envRefs(s) }),
        tools: { include: [...s.tools.include], prompts: false, resources: false },
        trust: s.trust,
        elicitation: { enabled: false },
        // A server may not run completions on our model key (sampling); none in the catalog needs it.
        sampling: { enabled: false },
      },
    ]),
  );
}

/** A standard mcp.json for the zone's whole catalog, for the CI scanners. Pure. */
export function emitMcpJson(p: Policy, zone: McpZone): string {
  checkCatalog(p);
  checkZone(zone);
  const mcpServers = Object.fromEntries(
    serversForZone(p, zone, { o11y: true }).map(([name, s]) => [
      name,
      s.transport === "http" ? { type: "http", url: s.url } : { type: "stdio", ...launch(name, s), env: envRefs(s) },
    ]),
  );
  const comment = notice(`mcp.json for the ${zone} zone's MCP servers, for the CI scanners`, ["policy/mcp.yaml"]);
  return `${JSON.stringify({ $comment: comment.join(" "), mcpServers }, null, 2)}\n`;
}

/** The scanner files: `<zone>.mcp.json` for each MCP zone. Pure. */
export function emitMcp(p: Policy): Record<string, string> {
  return Object.fromEntries(MCP_ZONES.map((zone) => [`${zone}.mcp.json`, emitMcpJson(p, zone)]));
}
