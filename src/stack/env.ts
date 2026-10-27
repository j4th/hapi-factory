/**
 * The environment hapi sets in each zone container itself: stack/compose.yaml's
 * `environment:` for each zone service (tests/stack/compose.test.ts checks the
 * file against `serviceEnvironment`). These are hardening settings, not
 * secrets: each zone's proxy, loopback going direct, Archon's loopback bind and
 * telemetry switches, Pi's offline mode and read-only agent dir, and where each
 * tool reads its generated config.
 *
 * Compose gives `environment:` precedence over `env_file`, so a zone's secrets
 * file (`$XDG_RUNTIME_DIR/hapi/env/<zone>.env`, the service's only env_file)
 * can't override any of them. And the secrets manifest may not name one at
 * all (`RESERVED_ENV_NAMES`, enforced by src/secrets/manifest.ts), so a secret
 * called HOST or HTTPS_PROXY is refused when the manifest loads, before it can
 * mean anything.
 */
import { ARCHON_ENV } from "../generate/archon";
import { PROXY_PORT } from "../generate/egress";

/** The zone services stack/compose.yaml runs today (research's own arrives in Plan 04). */
export const ZONE_SERVICES = ["hermes", "archon"] as const;
export type ZoneService = (typeof ZONE_SERVICES)[number];

/** Where the hermes service's generated config is mounted (`$HERMES_HOME/config.yaml`), as the image itself sets it. */
export const HERMES_HOME = "/opt/data";

/**
 * A zone's proxy variables: HTTP(S)_PROXY, in both cases, at the zone's own
 * egress proxy, and loopback direct. Every zone container gets exactly these.
 */
export function proxyEnv(zone: "hermes" | "archon" | "research"): Record<string, string> {
  const proxy = `http://egress-${zone}:${PROXY_PORT}`;
  const direct = "localhost,127.0.0.1,::1";
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: direct, no_proxy: direct };
}

/** The whole `environment:` of a zone service in stack/compose.yaml. */
export function serviceEnvironment(service: ZoneService): Record<string, string> {
  if (service === "hermes") {
    // The image sets HERMES_HOME too; set here, no env_file can move Hermes off its read-only generated config.
    return { HERMES_HOME, ...proxyEnv("hermes") };
  }
  return {
    // Archon's home is /.archon (the run DB, workspaces, worktrees), as in its own compose file.
    ARCHON_DOCKER: "true",
    ...Object.fromEntries(ARCHON_ENV.map(([name, value]) => [name, value])),
    ...proxyEnv("archon"),
  };
}

/**
 * Env names no secret may have, in any zone of stack/secrets.yaml: every name
 * hapi sets in a zone container (`serviceEnvironment`, and the research
 * zone's proxy variables), plus ALL_PROXY in both cases, the proxy variable
 * no zone sets, which some tools would use for what HTTP(S)_PROXY doesn't
 * cover. Sorted.
 */
export const RESERVED_ENV_NAMES: readonly string[] = [
  ...new Set([...ZONE_SERVICES.flatMap((s) => Object.keys(serviceEnvironment(s))), ...Object.keys(proxyEnv("research")), "ALL_PROXY", "all_proxy"]),
].sort();
