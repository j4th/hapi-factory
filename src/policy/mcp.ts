/**
 * The MCP catalog, policy/mcp.yaml (spec §10.1): which MCP servers each zone
 * may load, each pinned exactly, with a read-only tool allowlist, its env by
 * bws key name and its egress hosts.
 *
 * The schema (policy-mcp.schema.json) checks the shapes, including that no
 * server lists the archon zone. `mcpIssues` adds what a schema can't say:
 * - the advisory floors: a pinned version below a server's floor names the
 *   advisory, because some advisories (Context7's CVE-2026-75130) have no OSV
 *   record, so the scanners stay silent;
 * - the blocklist of package names;
 * - `tools.include` never lists a `tools.deny` tool (write and third-party tools);
 * - each transport's fields: `url` is for http only, and its host is an egress host;
 * - env names a server may not set (proxies and URL overrides), and one server per bws key.
 * `loadPolicy` runs both; the emitters run them again for a policy built in code.
 */
import { type Issue, pointerSegment } from "./schema";
import type { McpCatalog, McpServer, Policy, ZoneName } from "./types";

/** The zones that may load MCP servers. The archon zone never does (spec §10.1). */
export const MCP_ZONES = ["hermes", "research"] as const satisfies readonly ZoneName[];
export type McpZone = (typeof MCP_ZONES)[number];

export interface McpOptions {
  /** Whether the observability profile runs. Default: the policy's flags.otel.enabled. */
  o11y?: boolean;
}

/** Whether o11y-gated servers are on: the explicit option, else flags.otel.enabled. */
export function o11yEnabled(p: Pick<Policy, "flags">, opts: McpOptions = {}): boolean {
  return opts.o11y ?? p.flags.otel.enabled;
}

/**
 * The servers a zone loads, as [name, server] sorted by name: those that list
 * the zone and are enabled. An `enabled_when: o11y` server is enabled only
 * while o11y is on (see `o11yEnabled`).
 */
export function serversForZone(p: Pick<Policy, "mcp" | "flags">, zone: ZoneName, opts: McpOptions = {}): [string, McpServer][] {
  const o11y = o11yEnabled(p, opts);
  return Object.entries(p.mcp.servers)
    .filter(([, s]) => s.zones.includes(zone) && (s.enabled_when !== "o11y" || o11y))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const BWS = "bws:";

/** The bws key name an env value refers to (`bws:<key>`), or undefined for a literal. */
export function secretKey(value: string): string | undefined {
  return value.startsWith(BWS) ? value.slice(BWS.length) : undefined;
}

/**
 * The env var a bws key's secret is resolved into, which the generated configs
 * reference as `${NAME}`: the key upper-cased with "-" as "_", so
 * hapi-mcp-context7-api-key is HAPI_MCP_CONTEXT7_API_KEY. Key names are
 * `hapi-mcp-` and a lowercase slug, so two keys never share a name, and none
 * clashes with a variable Hermes itself reads.
 */
export function secretEnvName(bwsKey: string): string {
  return bwsKey.toUpperCase().replaceAll("-", "_");
}

/** Compare two exact versions (MAJOR.MINOR.PATCH) numerically: <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The first blocked pattern that matches the whole name, or undefined. `*` matches any run of characters. */
export function blockedBy(name: string, blocked: readonly string[]): string | undefined {
  const matches = (pattern: string) =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "su").test(name);
  return blocked.find(matches);
}

/**
 * Env names no server may set. The zone's proxy settings belong to the stack,
 * and URL overrides would send a server's traffic (and its key) elsewhere
 * (spec §10.1: "no proxy or URL overrides beyond the zone's own").
 */
const FORBIDDEN_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: "the zone's proxy settings come from the stack, never from a server entry",
  HTTPS_PROXY: "the zone's proxy settings come from the stack, never from a server entry",
  ALL_PROXY: "the zone's proxy settings come from the stack, never from a server entry",
  NO_PROXY: "the zone's proxy settings come from the stack, never from a server entry",
  CONTEXT7_API_URL: "it redirects Context7's traffic and its API key",
  DANGEROUSLY_READ_README_FILES: "it makes the Phoenix MCP server read files from disk and serve them as tools and resources",
};

/** Whether `host` is `domain` or a subdomain of it, as the egress proxy matches. */
const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** A URL's lowercase host name, or undefined if it doesn't parse. */
function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The catalog's problems beyond the schema, with JSON Pointers into mcp.yaml.
 * Assumes the catalog passed the schema. Returns [] when there are none.
 */
export function mcpIssues(m: McpCatalog): Issue[] {
  const issues: Issue[] = [];
  const keyOwner = new Map<string, string>();
  for (const [name, s] of Object.entries(m.servers)) {
    const at = (...path: (string | number)[]) => `/servers/${[name, ...path].map(pointerSegment).join("/")}`;
    const add = (path: string, message: string) => issues.push({ path, message });

    // The transport's own fields.
    if (s.transport === "stdio" && s.url !== undefined) add(at("url"), "url is for http servers; a stdio server runs from its package");
    if (s.transport === "http") {
      if (s.package !== undefined) add(at("package"), "an http server runs remotely; package is for stdio servers");
      if (s.image !== undefined) add(at("image"), "an http server runs remotely; image is for stdio servers");
      if (s.url !== undefined) {
        const host = urlHost(s.url);
        if (host === undefined) add(at("url"), "not a valid URL");
        else if (!s.egress.some((d) => underDomain(host, d))) {
          add(at("url"), `the url's host ${JSON.stringify(host)} is not one of this server's egress hosts, or under one`);
        }
      }
    }

    // Our own advisory floor (OSV and the scanners don't know every advisory).
    if (s.floor !== undefined) {
      if (s.package === undefined) {
        add(at("floor"), `a floor needs a package version to check (${s.floor.advisory})`);
      } else if (compareVersions(s.package.version, s.floor.min) < 0) {
        add(
          at("package", "version"),
          `${s.package.version} is below this server's advisory floor ${s.floor.min} (${s.floor.advisory}); pin ${s.floor.min} or later`,
        );
      }
    }

    if (s.package !== undefined) {
      const pattern = blockedBy(s.package.name, m.blocked);
      if (pattern !== undefined) add(at("package", "name"), `${JSON.stringify(s.package.name)} is blocked (matches ${JSON.stringify(pattern)} in blocked)`);
    }

    s.tools.include.forEach((tool, i) => {
      if (s.tools.deny.includes(tool)) {
        add(at("tools", "include", i), `${JSON.stringify(tool)} is on ${name}'s tools.deny list (a write or third-party tool); include read-only tools only`);
      }
    });

    if (s.transport === "http" && Object.keys(s.env).length > 0) add(at("env"), "env is for stdio servers; an http server gets none");
    for (const [env, value] of Object.entries(s.env)) {
      const reason = Object.hasOwn(FORBIDDEN_ENV, env) ? FORBIDDEN_ENV[env] : undefined;
      if (reason !== undefined) add(at("env", env), `a server may not set ${env}: ${reason} (spec §10.1)`);
      const key = secretKey(value);
      if (key === undefined) continue;
      const owner = keyOwner.get(key);
      if (owner !== undefined && owner !== name) {
        add(at("env", env), `bws key ${JSON.stringify(key)} is already ${owner}'s; each server gets only its own key (spec §10.1)`);
      } else {
        keyOwner.set(key, name);
      }
    }
  }
  return issues;
}
