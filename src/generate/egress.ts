/**
 * The egress proxies (spec §10, §11.4): one Squid config per zone, from
 * trusted_sources.yaml. The proxy is the real network boundary; the agents' own
 * settings are a second layer. Each zone's containers sit on an internal-only
 * network whose one way out is this proxy (Plan 01 Task 5).
 *
 * Every zone:
 * - serves only clients on the private container networks;
 * - refuses private, loopback, link-local and other special addresses, checked
 *   on what a name resolves to, so a public name pointing inside is refused too;
 * - tunnels (CONNECT) only to port 443;
 * - caches nothing and logs to stdout;
 * - ends with `http_access deny all`.
 *
 * An allowlisted zone (hermes, archon) allows only HTTPS tunnels to its
 * allowlist (`zoneHosts`, src/policy/zones.ts): each domain and its subdomains,
 * as a Squid dstdomain with a leading dot. The research zone (`openWeb`) allows
 * any public host: HTTPS tunnels to 443 and plain HTTP to 80.
 */
import { forgeDomain, forgeHostMessage } from "../policy/hosts";
import type { Policy, ZoneName } from "../policy/types";
import { zoneHosts } from "../policy/zones";
import { hashComment, notice, wrap } from "./header";

const ZONES: ZoneName[] = ["hermes", "archon", "research"];

/** The port each zone's proxy listens on, inside its own container. */
export const PROXY_PORT = 3128;

const ABOUT: Record<ZoneName, string> = {
  hermes: "the Hermes main session: model APIs, the forge, Slack, registries and curated docs",
  archon: "Archon and its Pi workers: model APIs and package registries. No forge route (spec §4.3)",
  research: "hapi-research, the only role that reaches the open web (spec §10)",
};

/** Clients allowed to use a proxy: the private container networks, and the proxy's own loopback. */
const CLIENT_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "fe80::/10", "127.0.0.0/8", "::1"];

/** Destinations no zone may reach, whatever a name resolves to. */
const PRIVATE_RANGES: [range: string, what: string][] = [
  ["0.0.0.0/8", "this network"],
  ["10.0.0.0/8", "private"],
  ["100.64.0.0/10", "carrier-grade NAT"],
  ["127.0.0.0/8", "loopback"],
  ["169.254.0.0/16", "link-local, including cloud metadata endpoints"],
  ["172.16.0.0/12", "private"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.168.0.0/16", "private"],
  ["198.18.0.0/15", "benchmarking"],
  ["224.0.0.0/4", "multicast"],
  ["240.0.0.0/4", "reserved, and broadcast"],
  ["::1", "loopback"],
  ["fc00::/7", "unique local"],
  ["fe80::/10", "link-local"],
  ["ff00::/8", "multicast"],
];

/**
 * The allowlist as Squid dstdomain values. ".example.com" matches the domain and
 * its subdomains, so a host under another listed host is folded into it
 * (api.github.com into .github.com): the set of allowed names is the same, and
 * Squid warns about a dstdomain list that holds both ("Ignoring .api.github.com
 * because it is already covered by .github.com"), so `squid -k parse` stays clean.
 */
function dstdomains(hosts: string[]): string[] {
  const covered = (h: string) => hosts.some((d) => d !== h && h.endsWith(`.${d}`));
  return hosts.filter((h) => !covered(h)).map((h) => `.${h}`);
}

/** Refuse a policy that breaks a zone rule the schema also enforces: a policy built in code skips the schema. */
function checkZone(p: Policy, zone: ZoneName, hosts: string[]): void {
  if (p.trustedSources.zones[zone].openWeb && zone !== "research") {
    throw new Error(`only the research zone may set openWeb, but the ${zone} zone does (spec §10)`);
  }
  if (zone !== "archon") return;
  for (const host of hosts) {
    const forge = forgeDomain(host);
    if (forge !== undefined) throw new Error(`archon zone: ${forgeHostMessage(host, forge)}`);
  }
}

function squidConf(p: Policy, zone: ZoneName): string {
  const z = p.trustedSources.zones[zone];
  const hosts = zoneHosts(p, zone);
  checkZone(p, zone, hosts);
  const open = z.openWeb === true;

  const head = hashComment([
    ...notice(`Squid egress proxy for the ${zone} zone`, ["policy/trusted_sources.yaml"]),
    "",
    ...wrap(`Zone ${zone} (tiers ${z.tiers.join(", ")}): ${ABOUT[zone]}.`),
    ...wrap(
      open
        ? "Open web: any public host, as HTTPS tunnels to port 443 or plain HTTP to port 80."
        : "Default-deny: only HTTPS tunnels (CONNECT to port 443) to the domains below and their subdomains.",
    ),
    "Private, loopback and link-local addresses are refused whatever a name resolves to.",
  ]);

  const lines = [
    head,
    "",
    `http_port ${PROXY_PORT}`,
    `visible_hostname hapi-egress-${zone}`,
    "# The container starts Squid as a non-root user and supervises it, so there is no pid",
    "# file. (Started as root, Squid drops privileges and then can't open /dev/stdout.)",
    "pid_filename none",
    "",
    "# This proxy only filters: no caching, and logs go to the container's stdout.",
    "cache deny all",
    "access_log stdio:/dev/stdout",
    "cache_log /dev/stdout",
    "",
    "# Don't reveal client addresses or the Squid version upstream.",
    "forwarded_for delete",
    "httpd_suppress_version_string on",
    "",
    "acl CONNECT method CONNECT",
    "acl https_port port 443",
    ...(open ? ["acl plain_http port 80"] : []),
    "# Clients: the zone's containers on the private container network.",
    `acl zone_clients src ${CLIENT_RANGES.join(" ")}`,
    "# Never reachable from any zone:",
    ...PRIVATE_RANGES.map(([range, what]) => `#   ${range.padEnd(16)}${what}`),
    `acl to_localnet dst ${PRIVATE_RANGES.map(([r]) => r).join(" ")}`,
  ];
  if (open) {
    lines.push(
      "",
      "http_access deny !zone_clients",
      "http_access deny to_localnet",
      "http_access deny CONNECT !https_port",
      "http_access allow CONNECT",
      "http_access allow plain_http",
      "http_access deny all",
    );
  } else {
    const domains = dstdomains(hosts);
    lines.push(
      "# A destination given as an IP address. Refused, so the dstdomain check below never",
      "# falls back to a reverse DNS lookup, whose answer the address's owner controls.",
      "acl ip_literal dstdom_regex ^[0-9.]+$ :",
      domains.length > 0
        ? "# The allowlist: the zone's hosts plus its tiers' hosts (zoneHosts in src/policy/zones.ts)."
        : "# The allowlist is empty, so everything is refused.",
      ...domains.map((d) => `acl allowed dstdomain ${d}`),
      "",
      "http_access deny !zone_clients",
      "http_access deny to_localnet",
      "http_access deny CONNECT !https_port",
      "http_access deny ip_literal",
      // Squid refuses a config that names an undefined ACL.
      ...(domains.length > 0 ? ["http_access allow CONNECT allowed"] : []),
      "http_access deny all",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The egress proxies' generated files: `<zone>.squid.conf` for each zone. Pure. */
export function emitEgress(p: Policy): Record<string, string> {
  return Object.fromEntries(ZONES.map((zone) => [`${zone}.squid.conf`, squidConf(p, zone)]));
}
