/**
 * Egress zones (spec §10): one per container network, each behind its own
 * default-deny proxy. trusted_sources.yaml defines them; this module is the one
 * definition of what a zone's allowlist is, so every generator and check reads
 * it the same way.
 */
import type { Policy, ZoneName } from "./types";

/**
 * A zone's allowlist: its own `hosts` plus the hosts of every tier it lists,
 * sorted and de-duplicated. Hosts are plain domains; the egress generator also
 * allows their subdomains.
 *
 * A zone with `openWeb` (only `research`) reaches any public host on top of
 * this list. Read `zone.openWeb` for that; this function never says "any".
 */
export function zoneHosts(p: Pick<Policy, "trustedSources">, zone: ZoneName): string[] {
  const { tiers, zones } = p.trustedSources;
  const z = zones[zone];
  return [...new Set([...z.hosts, ...z.tiers.flatMap((t) => tiers[t].hosts)])].sort();
}
