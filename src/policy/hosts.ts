/**
 * Forge hosts (spec §4.3): the archon zone must never reach a forge, because
 * Archon holds no forge credentials and has no route to the forge, and nor may
 * the review zone (design §3.5). The stack is forge-agnostic, so GitLab and
 * Bitbucket count as well as GitHub.
 *
 * The one list of forge domains is the `forgeHost` definition in
 * policy/schemas/policy-defs.schema.json. The schemas use it (as `nonForgeHost`)
 * for a work order's `egress_extra`, the archon zone's hosts and tiers, and the
 * review zone's hosts, so any JSON Schema validator enforces it, Python ones
 * included. This module
 * reads the same pattern, for `applyOverlay`, the egress generator and error
 * messages, and the schema's `hostname` pattern for `isHostname`.
 */
import defs from "../../policy/schemas/policy-defs.schema.json";

const FORGE_HOST = new RegExp(defs.$defs.forgeHost.pattern, "u");
const HOSTNAME = new RegExp(defs.$defs.hostname.pattern, "u");

/**
 * The forge domains, read from the pattern's final group "(a\.com|b\.org)$". A host
 * is a forge host if it is one of them or a subdomain of one.
 */
export const FORGE_DOMAINS: readonly string[] = Object.freeze(
  (/\(([^()]*)\)\$$/.exec(defs.$defs.forgeHost.pattern)?.[1] ?? "").split("|").map((d) => d.replaceAll("\\.", ".")),
);

/**
 * The forge domain a host belongs to, or undefined if it isn't a forge host,
 * e.g. forgeDomain("raw.githubusercontent.com") === "githubusercontent.com".
 * Case is ignored, as Squid ignores it when it matches a domain, so
 * "GitHub.com" is a forge host too; the result is lowercase.
 */
export function forgeDomain(host: string): string | undefined {
  return FORGE_HOST.exec(host.toLowerCase())?.[1];
}

/**
 * Whether `host` is a plain, lowercase domain name with at least two labels:
 * the schema's `hostname`, read from the same pattern. No scheme, port, path,
 * wildcard, leading or trailing dot, whitespace or IP address.
 */
export function isHostname(host: string): boolean {
  return HOSTNAME.test(host);
}

/**
 * The message for a forge host where a zone with no forge route could reach it: the archon zone (spec §4.3), or the
 * review zone, whose findings the harvester posts, never the review container (design §3.5).
 */
export function forgeHostMessage(host: string, forge: string, zone: "archon" | "review" = "archon"): string {
  return `${JSON.stringify(host)} is a forge host (${forge}); the ${zone} zone has no forge route (${zone === "archon" ? "spec §4.3" : "design §3.5"})`;
}
