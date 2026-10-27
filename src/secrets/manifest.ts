/**
 * The secrets manifest, stack/secrets.yaml (spec §11.5): the committed,
 * public, provider-neutral list of every secret the stack needs. Per zone, it
 * maps each env var to a logical name (`hapi-<words>`). It holds no ids and no
 * values; the local config (./provider.ts) picks the provider, and the store
 * holds each value under its logical name. One logical name may fill several
 * env vars (archon's ANTHROPIC_API_KEY and CLAUDE_API_KEY).
 *
 * The manifest is the single list of what must exist: `hapi secrets resolve`
 * fails if the store lacks a name, and `hapi secrets check` names it.
 *
 * The MCP catalog (policy/mcp.yaml) names a server's secret as
 * `secret:hapi-mcp-<slug>`, and the generated configs read it from the env var
 * `secretEnvName(name)` (HAPI_MCP_<SLUG>). `mcpSecretGaps` checks that the
 * manifest maps that env var to that name in the server's zone, so the two
 * never drift.
 *
 * No env name may be one hapi sets in the containers itself
 * (`RESERVED_ENV_NAMES`, src/stack/env.ts: the proxy variables, HOST, PI_OFFLINE,
 * the telemetry switches and the rest), nor one that changes how a process
 * runs, loads code or trusts TLS (`CONTROL_ENV_NAMES` and `CONTROL_ENV_PREFIXES`:
 * PATH, LD_PRELOAD, NODE_OPTIONS, SSL_CERT_FILE, GIT_SSH_COMMAND, ...), in any
 * zone. `reservedEnvRule` decides, and such a secret is refused when the
 * manifest loads, by `loadManifest` and by `manifestEntries` for a manifest
 * built in code, before resolve writes anything.
 *
 * Errors never echo what might be a pasted secret: a JSON Pointer shows a zone
 * only if it is one of `SECRET_ZONES` (else `<zone>`), and an env name only if
 * it is one (else `<ENV>`).
 */
import { loadChecked, PolicyError } from "../policy/load";
import { MCP_ZONES, type McpOptions, type McpZone, secretEnvName, secretKey, serversForZone } from "../policy/mcp";
import type { Policy } from "../policy/types";
import { reservedEnvRule } from "../stack/env";
import { ENV_NAME } from "./files";

/** The env files hapi writes, one per zone. `host` is for host tools only, never a container. */
export const SECRET_ZONES = ["hermes", "archon", "research", "host"] as const;
export type SecretZone = (typeof SECRET_ZONES)[number];

/** A logical name: `hapi-` and lowercase words joined by `-`. */
export const LOGICAL_NAME = /^hapi-[a-z0-9]+(-[a-z0-9]+)*$/;

/** The committed manifest, relative to the repo root (where hapi runs). */
export const MANIFEST_FILE = "stack/secrets.yaml";

/** Zone -> env var name -> logical name. A manifest built in code may leave zones out. */
export type Manifest = Partial<Record<SecretZone, Record<string, string>>>;

/** One env var of the manifest. */
export interface ManifestEntry {
  zone: SecretZone;
  key: string;
  name: string;
}

/** A name as it may be shown: itself if it is a logical name, otherwise a placeholder, in case it is a pasted value. */
export function shownName(name: string): string {
  return LOGICAL_NAME.test(name) ? name : "(a name that is not a logical name, not shown)";
}

const isZone = (z: string): z is SecretZone => (SECRET_ZONES as readonly string[]).includes(z);

/** Why an env name is refused (`reservedEnvRule`), or undefined when it may be used. It names the rule, never a value. */
const reservedMessage = (key: string): string | undefined => {
  const rule = reservedEnvRule(key);
  return rule === undefined ? undefined : `${rule}. Give the secret another env name`;
};

/**
 * The manifest's entries, zones in `SECRET_ZONES` order and env vars in file
 * order. Throws for a zone, env name or logical name a manifest built in code
 * got wrong, without echoing it.
 */
export function manifestEntries(m: Manifest): ManifestEntry[] {
  for (const zone of Object.keys(m)) {
    if (!isZone(zone)) throw new Error(`the manifest has an unknown zone (<zone>, not shown); the zones are ${SECRET_ZONES.join(", ")}`);
  }
  const out: ManifestEntry[] = [];
  for (const zone of SECRET_ZONES) {
    for (const [key, name] of Object.entries(m[zone] ?? {})) {
      if (!ENV_NAME.test(key)) throw new Error(`${zone}/<ENV>: an env name is not of the form ${ENV_NAME.source} (not shown, in case it is a value)`);
      const reserved = reservedMessage(key);
      if (reserved !== undefined) throw new Error(`${zone}/${key}: ${reserved}`);
      if (typeof name !== "string" || !LOGICAL_NAME.test(name)) {
        throw new Error(`${zone}/${key}: not a logical name of the form ${LOGICAL_NAME.source} (not shown, in case it is a value)`);
      }
      out.push({ zone, key, name });
    }
  }
  return out;
}

/** Every logical name the manifest uses, once each, sorted. */
export function manifestNames(m: Manifest): string[] {
  return [...new Set(manifestEntries(m).map((e) => e.name))].sort();
}

/** An MCP server's secret that the manifest doesn't map to its env var in the server's zone. */
export interface McpSecretGap {
  zone: McpZone;
  server: string;
  /** The env var the generated config reads: `secretEnvName(name)`. */
  env: string;
  /** The logical name from the server's `secret:<name>` reference. */
  name: string;
}

/**
 * Every `secret:` reference of the MCP servers each zone loads (`serversForZone`,
 * o11y as `opts` or the policy's flags say) whose env var the manifest doesn't
 * map to that logical name in that zone. [] when the manifest covers the catalog.
 */
export function mcpSecretGaps(p: Pick<Policy, "mcp" | "flags">, m: Manifest, opts: McpOptions = {}): McpSecretGap[] {
  const gaps: McpSecretGap[] = [];
  for (const zone of MCP_ZONES) {
    const entries = m[zone] ?? {};
    for (const [server, s] of serversForZone(p, zone, opts)) {
      for (const value of Object.values(s.env)) {
        const name = secretKey(value);
        if (name === undefined) continue;
        const env = secretEnvName(name);
        if (!Object.hasOwn(entries, env) || entries[env] !== name) gaps.push({ zone, server, env, name });
      }
    }
  }
  return gaps;
}

/** A JSON Pointer into the manifest, with a zone or env name that isn't one hidden: it may be a pasted secret. */
function scrubPointer(path: string): string {
  const segs = path.split("/");
  if (segs.length > 1 && !isZone(segs[1]!)) segs[1] = "<zone>";
  if (segs.length > 2 && !ENV_NAME.test(segs[2]!)) segs[2] = "<ENV>";
  return segs.join("/");
}

/**
 * Load and check a manifest file (`secrets-manifest.schema.json`; default the
 * committed stack/secrets.yaml), then refuse any reserved env name
 * (`reservedEnvRule`). Throws a PolicyError naming the file and the JSON
 * Pointer of each problem, scrubbed as above.
 */
export function loadManifest(file: string = MANIFEST_FILE): Manifest {
  let m: Manifest;
  try {
    m = loadChecked(file, "secrets-manifest") as Manifest;
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    throw new PolicyError(
      file,
      e.issues.map((i) => ({ ...i, path: scrubPointer(i.path) })),
    );
  }
  const reserved = SECRET_ZONES.flatMap((zone) =>
    Object.keys(m[zone] ?? {}).flatMap((key) => {
      const message = reservedMessage(key);
      return message === undefined ? [] : [{ path: `/${zone}/${key}`, message }];
    }),
  );
  if (reserved.length > 0) throw new PolicyError(file, reserved);
  return m;
}
