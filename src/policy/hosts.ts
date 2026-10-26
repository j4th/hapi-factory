/**
 * Forge hosts (spec §4.3): the archon zone must never reach a forge, because
 * Archon holds no forge credentials and has no route to the forge. The stack is
 * forge-agnostic, so GitLab and Bitbucket count as well as GitHub.
 *
 * The one list of forge domains is the `forgeHost` definition in
 * policy/schemas/policy-defs.schema.json. The schemas use it (as `nonForgeHost`)
 * for a work order's `egress_extra` and for the archon zone's hosts and tiers,
 * so any JSON Schema validator enforces it, Python ones included. This module
 * reads the same pattern, for `applyOverlay` and for error messages.
 */
import defs from "../../policy/schemas/policy-defs.schema.json";

const FORGE_HOST = new RegExp(defs.$defs.forgeHost.pattern, "u");

/**
 * The forge domains, read from the pattern's final group "(a\.com|b\.org)$". A host
 * is a forge host if it is one of them or a subdomain of one.
 */
export const FORGE_DOMAINS: readonly string[] = Object.freeze(
  (/\(([^()]*)\)\$$/.exec(defs.$defs.forgeHost.pattern)?.[1] ?? "").split("|").map((d) => d.replaceAll("\\.", ".")),
);

/**
 * The forge domain a host belongs to, or undefined if it isn't a forge host.
 * `host` is a plain lowercase domain (the schema's `hostname`), e.g.
 * forgeDomain("raw.githubusercontent.com") === "githubusercontent.com".
 */
export function forgeDomain(host: string): string | undefined {
  return FORGE_HOST.exec(host)?.[1];
}

/** The message for a forge host where the archon zone could reach it. */
export function forgeHostMessage(host: string, forge: string): string {
  return `${JSON.stringify(host)} is a forge host (${forge}); the archon zone has no forge route (spec §4.3)`;
}
