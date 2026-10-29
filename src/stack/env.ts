/**
 * The environment hapi sets in each zone container itself: stack/compose.yaml's
 * `environment:` for each zone service (tests/stack/compose.test.ts checks the
 * file against `serviceEnvironment`). These are hardening settings, not
 * secrets: each zone's proxy, loopback going direct, Archon's telemetry
 * switches, Pi's offline mode and read-only agent dir, Bun's no-install, the git
 * hardening, and where each tool reads its generated config.
 *
 * Compose gives `environment:` precedence over `env_file`, so a zone's secrets
 * file (`$XDG_RUNTIME_DIR/hapi/env/<zone>.env`, the service's only env_file)
 * can't override any of them. And the secrets manifest may not name one at
 * all (`RESERVED_ENV_NAMES`, enforced by src/secrets/manifest.ts), so a secret
 * called PI_OFFLINE or HTTPS_PROXY is refused when the manifest loads, before it can
 * mean anything.
 *
 * Nor may it name an env var that changes how a process in the container runs,
 * loads code or trusts TLS (`CONTROL_ENV_NAMES`, `CONTROL_ENV_PREFIXES`:
 * LD_PRELOAD, NODE_OPTIONS, SSL_CERT_FILE, GIT_SSH_COMMAND and the like), which
 * hapi doesn't set and so `environment:` can't shadow. `reservedEnvRule` is the
 * one check, for both lists.
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

/**
 * Exact env names that change how a process runs, which code it loads, or
 * which TLS certificates it trusts, that no prefix in `CONTROL_ENV_PREFIXES`
 * covers. hapi sets none of them, so a secret of that name would reach the
 * container's processes as is. Sorted.
 */
export const CONTROL_ENV_NAMES: readonly string[] = [
  // The shell and the process: where programs are found, what a shell runs first, scratch space, programs run for you.
  "BASHOPTS",
  "BASH_ENV",
  "CDPATH",
  "EDITOR",
  "ENV",
  "HOME",
  "IFS",
  "PAGER",
  "PATH",
  "PS4",
  "SHELL",
  "SHELLOPTS",
  "TMPDIR",
  "VISUAL",
  // glibc: loadable charset converters and locales, and allocator tunables.
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "LOCPATH",
  // TLS trust and key logging.
  "CURL_CA_BUNDLE",
  "CURL_HOME",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "REQUESTS_CA_BUNDLE",
  "SSLKEYLOGFILE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  // Git: programs it runs, where it looks, and TLS (GIT_CONFIG_* is a prefix).
  "GIT_ASKPASS",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_NO_VERIFY",
  "GIT_TEMPLATE_DIR",
  "GIT_WORK_TREE",
  "SSH_ASKPASS",
  // Other runtimes' code-loading switches (Python's are the PYTHON prefix, Node's NODE_).
  "CLASSPATH",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "PERL5LIB",
  "PERL5OPT",
  "PERLLIB",
  "RUBYLIB",
  "RUBYOPT",
  "VIRTUAL_ENV",
  "_JAVA_OPTIONS",
  // Where tools read their config and data. Claude Code (Archon's claude nodes) loads settings.json hooks and env, and credentials, from CLAUDE_CONFIG_DIR.
  "CLAUDE_CONFIG_DIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
].sort();

/**
 * Env name prefixes no secret may start with: the dynamic loader (LD_, and
 * macOS's DYLD_), git's config injection (GIT_CONFIG_COUNT/KEY_n/VALUE_n,
 * GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM), and the runtimes, package managers
 * and tools in the containers, each of which reads its own settings from its
 * prefix (NODE_OPTIONS, NODE_EXTRA_CA_CERTS, PYTHONPATH, BUN_OPTIONS,
 * UV_INDEX_URL, PIP_INDEX_URL, NPM_CONFIG_REGISTRY, HERMES_HOME, ARCHON_*,
 * PI_*, CLAUDE_CODE_*, and s6-overlay's S6_*, the Hermes image's init:
 * S6_CMD_ARG0 runs a program in front of its command). No entry of the
 * committed stack/secrets.yaml starts with one (a unit test checks). `PYTHON`
 * has no underscore: Python's own variables are PYTHONPATH, PYTHONHOME,
 * PYTHONSTARTUP and the rest.
 * CLAUDE_CODE_ also keeps CLAUDE_CODE_OAUTH_TOKEN out: the factory bills by
 * API key and never runs on subscription OAuth (spec §11.5).
 */
export const CONTROL_ENV_PREFIXES: readonly string[] = [
  "ARCHON_",
  "BUN_",
  "CLAUDE_CODE_",
  "DYLD_",
  "GIT_CONFIG_",
  "HERMES_",
  "LD_",
  "MISE_",
  "NODE_",
  "NPM_CONFIG_",
  "PIP_",
  "PI_",
  "PYTHON",
  "S6_",
  "UV_",
];

/**
 * Env name suffixes no secret may end with: a client's endpoint override
 * (ANTHROPIC_BASE_URL, OPENAI_API_BASE, GITHUB_API_URL,
 * OTEL_EXPORTER_OTLP_ENDPOINT). One would send a client's requests, and the
 * key that goes with them, somewhere else. An endpoint is policy, committed
 * and reviewed, not a secret; the egress allowlists are the second check. A
 * credential that is itself a URL (a webhook) ends in plain _URL, which stays
 * allowed.
 */
export const CONTROL_ENV_SUFFIXES: readonly string[] = ["_API_BASE", "_API_URL", "_BASE_URL", "_ENDPOINT"];

/**
 * Why no secret may have the env name `name`, or undefined when one may: a
 * name hapi sets itself (`RESERVED_ENV_NAMES`), an exact process-control or
 * trust-store name (`CONTROL_ENV_NAMES`), one that starts with a prefix of
 * `CONTROL_ENV_PREFIXES`, or an endpoint override (`CONTROL_ENV_SUFFIXES`). The reason names the rule and the env name (which
 * the manifest's errors already show for any key of env-name form), never a
 * value. src/secrets/manifest.ts calls it for every env name of the manifest,
 * in every zone.
 */
export function reservedEnvRule(name: string): string | undefined {
  if (RESERVED_ENV_NAMES.includes(name)) {
    return `${name} is reserved: hapi sets it in the containers itself (src/stack/env.ts, stack/compose.yaml's environment:), and a secret must never override it`;
  }
  if (CONTROL_ENV_NAMES.includes(name)) {
    return `${name} is reserved: it can change how a process runs, which code it loads or which TLS certificates it trusts (CONTROL_ENV_NAMES, src/stack/env.ts), so a secret may not set it`;
  }
  const prefix = CONTROL_ENV_PREFIXES.find((p) => name.startsWith(p));
  if (prefix !== undefined) {
    return `${name} is reserved: env names starting ${prefix} configure a runtime, the loader or a tool in the containers (CONTROL_ENV_PREFIXES, src/stack/env.ts), so a secret may not use one`;
  }
  const suffix = CONTROL_ENV_SUFFIXES.find((s) => name.endsWith(s));
  if (suffix !== undefined) {
    return `${name} is reserved: env names ending ${suffix} set where a client sends its requests and its key (CONTROL_ENV_SUFFIXES, src/stack/env.ts); an endpoint belongs in policy/, not in a secret`;
  }
  return undefined;
}
