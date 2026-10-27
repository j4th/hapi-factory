/**
 * The MCP catalog, policy/mcp.yaml (spec §10.1): which MCP servers each zone
 * may load, each pinned exactly, with a read-only tool allowlist, its env by
 * bws key name and its egress hosts.
 *
 * The schema (policy-mcp.schema.json) checks the shapes, including that no
 * server lists the archon zone and that no `url` or env literal holds `$`
 * (Hermes expands `${...}` in both). `mcpIssues` adds what a schema can't say:
 * - the advisory floors: a pinned version below a server's floor names the
 *   advisory, because some advisories (Context7's CVE-2026-75130) have no OSV
 *   record, so the scanners stay silent;
 * - the blocklist of package names;
 * - `tools.include` never lists a `tools.deny` tool (write and third-party tools);
 * - each transport's fields: `url` is for http only, and its host is an egress host;
 * - env: a stdio server gets only the names its package's allowlist
 *   (`PACKAGE_ENV`) lists, each in the form its rule says (a secret as a bws
 *   reference, a flag as one of its values, an endpoint as a URL whose host is
 *   an egress host), and any secret-looking name (`SECRET_ENV_NAME`) only as a
 *   bws reference; no server sets a name on the hard denylist (`forbiddenEnv`:
 *   launch hijacks, proxies and URL overrides); and one server per bws key.
 * `loadPolicy` runs both; the emitters run them again for a policy built in code.
 */
import { type Issue, pointerSegment } from "./schema";
import type { McpCatalog, McpServer, Policy, ZoneName } from "./types";

/** The zones that may load MCP servers. The archon zone never does (spec §10.1). */
export const MCP_ZONES = ["hermes", "research"] as const satisfies readonly ZoneName[];
export type McpZone = (typeof MCP_ZONES)[number];

/** Whether a zone may load MCP servers: hermes and research, never archon. */
export function isMcpZone(zone: string): zone is McpZone {
  return (MCP_ZONES as readonly string[]).includes(zone);
}

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
 *
 * It fails closed even for a policy built in code, which skips the loader: a
 * zone outside `MCP_ZONES` (archon) gets [], and a server that lists such a
 * zone is never returned, for any zone.
 */
export function serversForZone(p: Pick<Policy, "mcp" | "flags">, zone: ZoneName, opts: McpOptions = {}): [string, McpServer][] {
  if (!isMcpZone(zone)) return [];
  const o11y = o11yEnabled(p, opts);
  return Object.entries(p.mcp.servers)
    .filter(([, s]) => s.zones.every(isMcpZone) && s.zones.includes(zone) && (s.enabled_when !== "o11y" || o11y))
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

/** A whole-string pattern: `*` matches any run of characters, everything else is literal. */
function globRegExp(pattern: string, flags = ""): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, `su${flags}`);
}

/** The first blocked pattern that matches the whole name, or undefined. `*` matches any run of characters. */
export function blockedBy(name: string, blocked: readonly string[]): string | undefined {
  return blocked.find((pattern) => globRegExp(pattern).test(name));
}

/**
 * How a server may receive one env name:
 * - `secret`: only as a bws reference (`bws:hapi-mcp-<name>`), never a literal;
 * - `flag`: only as a literal, one of `values`, so it can't carry a secret;
 * - `endpoint`: only as a literal http(s) URL with no user info, query or
 *   fragment, whose host is one of the server's egress hosts or under one.
 */
export type EnvRule = { kind: "secret" } | { kind: "flag"; values: readonly string[] } | { kind: "endpoint" };

/**
 * The env allowlist (spec §10.1: "env, by bws key name"), by npm package: every
 * env name the package may receive, and how (`EnvRule`). A stdio server gets
 * only its package's names, and a package not listed here gets no env. So a
 * name the package would also read, such as NODE_OPTIONS or
 * NPM_CONFIG_REGISTRY, can never be declared, and a literal can only be a flag
 * value or an endpoint, never a secret.
 *
 * It lives in code, not in mcp.yaml, so a catalog entry can't widen its own
 * allowlist. The names come from reading the package's source when it is added
 * or upgraded (docs/mcp.md, "Adding or upgrading a server").
 */
export const PACKAGE_ENV: Readonly<Record<string, Readonly<Record<string, EnvRule>>>> = {
  "@upstash/context7-mcp": {
    CONTEXT7_API_KEY: { kind: "secret" },
    OTEL_SDK_DISABLED: { kind: "flag", values: ["true"] }, // spec §10.1: telemetry off
  },
  "@arizeai/phoenix-mcp": {
    PHOENIX_API_KEY: { kind: "secret" }, // minted by a VIEWER-role user
    PHOENIX_DISCOVER_CONFIG: { kind: "flag", values: ["false"] }, // no .env.phoenix discovery up the directory tree
    PHOENIX_ENDPOINT: { kind: "endpoint" }, // explicit, so a planted .env.phoenix can't redirect it
  },
};

/** An env name that holds a secret, which only a bws reference may fill, whatever `PACKAGE_ENV` says. */
export const SECRET_ENV_NAME = /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/i;

const PROXY = "the zone's proxy settings come from the stack, never from a server entry";

/**
 * The hard denylist, defense in depth behind `PACKAGE_ENV`: env names no server
 * may set, as a literal or a bws reference, for any package. Each one hijacks
 * the launched process (npx, node, the dynamic linker, a shell) or redirects
 * its traffic (spec §10.1: "no proxy or URL overrides beyond the zone's own").
 * `*` matches any run of characters; case doesn't count.
 */
const FORBIDDEN_ENV: readonly (readonly [pattern: string, reason: string])[] = [
  ["*_PROXY", PROXY],
  ["GLOBAL_AGENT_*", PROXY],
  [
    "NPM_*",
    "npm and npx read npm_config_* in any case: NPM_CONFIG_REGISTRY makes npx fetch the package from another registry, and nothing checks its integrity at launch",
  ],
  ["NODE_*", "Node reads it at start-up: NODE_OPTIONS can --require or --import any code, and NODE_EXTRA_CA_CERTS or NODE_TLS_REJECT_UNAUTHORIZED weaken TLS"],
  ["LD_*", "the dynamic linker reads it: LD_PRELOAD and LD_LIBRARY_PATH load other code into the process"],
  ["GCONV_PATH", "glibc loads iconv modules from the directory it names"],
  ["PATH", "it chooses which npx and node binaries run"],
  ["HOME", "npm reads ~/.npmrc from it, which can set the registry"],
  ["BASH_ENV", "bash sources the file it names before it runs a script"],
  ["ENV", "sh sources the file it names"],
  ["BASH_FUNC_*", "bash imports shell functions from it"],
  ["UV_*", "uv and uvx read it: UV_INDEX_URL and UV_DEFAULT_INDEX fetch packages from another index"],
  ["PIP_*", "pip reads it: PIP_INDEX_URL fetches packages from another index"],
  ["PYTHON*", "Python reads it at start-up: PYTHONPATH and PYTHONSTARTUP load other code"],
  ["SSL_CERT_*", "OpenSSL trusts the CA certificates it names"],
  ["OTEL_EXPORTER_*", "it sends the server's telemetry to another endpoint"],
  ["CONTEXT7_API_URL", "it redirects Context7's traffic and its API key"],
  ["PHOENIX_CLIENT_HEADERS", "it adds headers to every request the Phoenix MCP server sends, such as another credential"],
  ["DANGEROUSLY_READ_README_FILES", "it makes the Phoenix MCP server read files from disk and serve them as tools and resources"],
];

/** Why no server may set this env name (the hard denylist, any case), or undefined if it isn't on it. */
export function forbiddenEnv(name: string): string | undefined {
  return FORBIDDEN_ENV.find(([pattern]) => globRegExp(pattern, "i").test(name))?.[1];
}

/** Whether `host` is `domain` or a subdomain of it, as the egress proxy matches. */
const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** Why an endpoint literal is refused, or undefined: it must be an http(s) URL with no user info, query or fragment, under one of `egress`. */
function endpointProblem(value: string, egress: readonly string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "it must be an http or https URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "it must be an http or https URL";
  if (url.username !== "" || url.password !== "") return "it may not hold user info, which could carry a secret";
  if (/[?#]/.test(value)) return "it may not hold a query or fragment, which could carry a secret";
  const host = url.hostname.toLowerCase();
  if (!egress.some((d) => underDomain(host, d))) return `its host ${JSON.stringify(host)} is not one of this server's egress hosts, or under one`;
  return undefined;
}

const MUST_BE_BWS = (env: string) =>
  `${env} names a secret, so its value must be a bws reference (bws:hapi-mcp-<name>), never a literal: a literal is written in plaintext into every generated config (spec §10.1)`;

/** Why a stdio server may not receive `env` with this value, or undefined if it may. */
function envProblem(env: string, value: string, s: McpServer): string | undefined {
  const isRef = secretKey(value) !== undefined;
  if (SECRET_ENV_NAME.test(env) && !isRef) return MUST_BE_BWS(env);
  const pkg = s.package?.name ?? "(no package)";
  const names = Object.hasOwn(PACKAGE_ENV, pkg) ? PACKAGE_ENV[pkg]! : undefined;
  if (names === undefined) {
    return `${pkg} has no env allowlist (PACKAGE_ENV in src/policy/mcp.ts), so it may not receive ${env}; list the env names it reads there, in the planning PR that adds it`;
  }
  const rule = Object.hasOwn(names, env) ? names[env]! : undefined;
  if (rule === undefined) return `${pkg} may not receive ${env}: its env allowlist (PACKAGE_ENV in src/policy/mcp.ts) is ${Object.keys(names).join(", ")}`;
  if (rule.kind === "secret") return isRef ? undefined : MUST_BE_BWS(env);
  if (isRef) return `${env} is a ${rule.kind}, not a secret: write its literal value, not a bws reference`;
  if (rule.kind === "flag") {
    return rule.values.includes(value) ? undefined : `${env} is a flag: its value must be ${rule.values.map((v) => JSON.stringify(v)).join(" or ")}`;
  }
  const problem = endpointProblem(value, s.egress);
  return problem === undefined ? undefined : `${env} is an endpoint: ${problem}`;
}

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
      const reason = forbiddenEnv(env);
      if (reason !== undefined) add(at("env", env), `a server may not set ${env}: ${reason} (spec §10.1)`);
      else if (s.transport === "stdio") {
        // An http server's env is refused as a whole, above.
        const problem = envProblem(env, value, s);
        if (problem !== undefined) add(at("env", env), problem);
      }
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
