/**
 * Secrets from Bitwarden Secrets Manager (spec §11.5), resolved fail-closed.
 *
 * `stack/secrets.map.yaml` (a `SecretMap`) says which bws secret fills which
 * env var in each zone. It holds bws secret ids, never values.
 * `resolveSecrets` reads every id with `bws secret get <id> --output json`,
 * all into memory first. Only when every key has a value does it write
 * `<outDir>/<zone>.env` (mode 0600, directory 0700, atomically; see
 * ./files.ts). Any miss throws a `SecretError` naming the zone and key, and
 * nothing is written, so the stack never starts with an empty variable.
 *
 * bws reads its access token from BWS_ACCESS_TOKEN in the caller's
 * environment. hapi never passes it on a command line and never writes it.
 *
 * The MCP catalog (policy/mcp.yaml) names a server's secret as
 * `bws:hapi-mcp-<slug>`, and the generated configs read it from the env var
 * `secretEnvName(key)` (HAPI_MCP_<SLUG>). `mcpSecretGaps` checks that the map
 * fills each of those vars in the server's zone, so the two never drift.
 *
 * Errors name the zone, the key and the file or JSON Pointer. Never a value:
 * not in a message, not on stdout or stderr. So nothing passes through text
 * that might hold one: bws's stdout, or JSON.parse's own message, which can
 * quote its input.
 */
import { join } from "node:path";
import { loadChecked, loadPolicy, PolicyError } from "../policy/load";
import { MCP_ZONES, type McpOptions, type McpZone, secretEnvName, secretKey, serversForZone } from "../policy/mcp";
import type { Policy } from "../policy/types";
import { ENV_NAME, envFileText, envValueProblem, runtimeDir, secureDir, writeSecretFiles } from "./files";

/** The env files hapi writes, one per zone. `host` is for host tools only, never a container. */
export const SECRET_ZONES = ["hermes", "archon", "research", "host"] as const;
export type SecretZone = (typeof SECRET_ZONES)[number];

/** Zone -> env var name -> bws secret id. A map built in code may leave zones out. */
export type SecretMap = Partial<Record<SecretZone, Record<string, string>>>;

/** Runs `bws` with these args and resolves to its stdout; rejects if it fails. */
export type BwsRunner = (args: string[]) => Promise<string>;

/** A secret could not be resolved. The message names `zone/key` and why, never the value. */
export class SecretError extends Error {
  override name = "SecretError";
  constructor(
    readonly zone: string,
    readonly key: string,
    readonly reason: string,
  ) {
    super(`${zone}/${key}: ${reason}`);
  }
}

/** The committed map's placeholder ids: 00000000-0000-0000-0000-xxxxxxxxxxxx. A real bws id is a random UUID. */
const PLACEHOLDER = /^00000000-0000-0000-0000-[0-9a-f]{12}$/i;
export const isPlaceholderId = (id: string): boolean => PLACEHOLDER.test(id);
const PLACEHOLDER_REASON = "still a placeholder bws id (docs/secrets.md: Filling in the map)";

/** What hapi passes to bws as an id: no leading "-" (it would read as a flag), no spaces. */
const BWS_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** One line of at most 300 characters, without ANSI colour codes or the bws access token. */
function oneLine(e: unknown): string {
  let s = (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const token = process.env.BWS_ACCESS_TOKEN;
  if (token) s = s.replaceAll(token, "[BWS_ACCESS_TOKEN]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

/**
 * The default `BwsRunner`: spawns the `bws` on PATH (mise installs the pinned
 * one) with the caller's environment, which carries BWS_ACCESS_TOKEN. stdout is
 * returned and never shown; a failure reports the exit status and bws's stderr.
 */
export const runBws: BwsRunner = async (args) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bws", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("cannot run bws: is it on PATH? (`mise install` provides it)");
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    // bws's errors end in a source location and backtrace hints; the message is what comes before.
    const why = oneLine(stderr).replace(/ Location: .*$/, "");
    throw new Error(`bws exited with status ${code}${why ? `: ${why}` : ""}`);
  }
  return stdout;
};

/** The map's entries as [zone, key, id], zones in `SECRET_ZONES` order. Throws on a bad zone, name or id. */
function entries(map: SecretMap): [SecretZone, string, string][] {
  for (const zone of Object.keys(map)) {
    if (!(SECRET_ZONES as readonly string[]).includes(zone)) {
      throw new Error(`unknown secrets zone '${zone}'; the zones are ${SECRET_ZONES.join(", ")}`);
    }
  }
  const out: [SecretZone, string, string][] = [];
  for (const zone of SECRET_ZONES) {
    for (const [key, id] of Object.entries(map[zone] ?? {})) {
      if (!ENV_NAME.test(key)) throw new Error(`${zone}: an env name is not of the form ${ENV_NAME.source} (not shown, in case it is a value)`);
      if (typeof id !== "string" || !BWS_ID.test(id)) throw new SecretError(zone, key, "not a bws secret id (not shown, in case it is a value)");
      out.push([zone, key, id]);
    }
  }
  return out;
}

/** Read one secret's value with `bws secret get`. Throws a SecretError for any miss. */
async function fetchValue(zone: string, key: string, id: string, bws: BwsRunner): Promise<string> {
  let stdout: string;
  try {
    stdout = await bws(["secret", "get", id, "--output", "json", "--color", "no"]);
  } catch (e) {
    throw new SecretError(zone, key, `bws secret get failed: ${oneLine(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON.parse's message: it can quote the text, which may hold the value.
    throw new SecretError(zone, key, "bws printed something that is not JSON (not shown)");
  }
  const value = typeof parsed === "object" && parsed !== null ? (parsed as { value?: unknown }).value : undefined;
  if (typeof value !== "string") throw new SecretError(zone, key, "bws returned no string value");
  if (value.trim() === "") throw new SecretError(zone, key, "the secret is empty");
  const problem = envValueProblem(value);
  if (problem !== undefined) throw new SecretError(zone, key, problem);
  return value;
}

/**
 * Resolve every secret in `map` and write `<outDir>/<zone>.env` (mode 0600) for
 * each zone in the map. Resolves to the paths written, by zone.
 *
 * Fail closed: a bad entry, a placeholder id, a bws failure, or an empty or
 * unwritable value throws a `SecretError` naming the key, before any file is
 * written. Each id is read once, even if several env vars share it.
 */
export async function resolveSecrets(
  map: SecretMap,
  opts: { bws?: BwsRunner; outDir: string },
): Promise<Partial<Record<SecretZone, string>>> {
  const bws = opts.bws ?? runBws;
  const list = entries(map);
  for (const [zone, key, id] of list) if (isPlaceholderId(id)) throw new SecretError(zone, key, PLACEHOLDER_REASON);

  const values: Partial<Record<SecretZone, Record<string, string>>> = {};
  const byId = new Map<string, string>();
  for (const [zone, key, id] of list) {
    let value = byId.get(id);
    if (value === undefined) {
      value = await fetchValue(zone, key, id, bws);
      byId.set(id, value);
    }
    (values[zone] ??= {})[key] = value;
  }

  await secureDir(opts.outDir);
  const files: Record<string, string> = {};
  const paths: Partial<Record<SecretZone, string>> = {};
  for (const zone of SECRET_ZONES) {
    if (map[zone] === undefined) continue;
    const path = join(opts.outDir, `${zone}.env`);
    files[path] = envFileText(zone, values[zone] ?? {});
    paths[zone] = path;
  }
  await writeSecretFiles(files);
  return paths;
}

/** One key's status in a dry run. `reason` says why it isn't found. */
export interface SecretCheck {
  zone: SecretZone;
  key: string;
  status: "found" | "missing" | "placeholder";
  reason?: string;
}

/**
 * The dry run: look up every key as `resolveSecrets` would, and report each as
 * found, missing or placeholder. Values are read and dropped; nothing is written.
 * A placeholder id is never looked up.
 */
export async function checkSecrets(map: SecretMap, opts: { bws?: BwsRunner } = {}): Promise<SecretCheck[]> {
  const bws = opts.bws ?? runBws;
  const byId = new Map<string, Omit<SecretCheck, "zone" | "key">>();
  const results: SecretCheck[] = [];
  for (const [zone, key, id] of entries(map)) {
    let r = byId.get(id);
    if (r === undefined) {
      if (isPlaceholderId(id)) r = { status: "placeholder", reason: PLACEHOLDER_REASON };
      else {
        try {
          await fetchValue(zone, key, id, bws);
          r = { status: "found" };
        } catch (e) {
          if (!(e instanceof SecretError)) throw e;
          r = { status: "missing", reason: e.reason };
        }
      }
      byId.set(id, r);
    }
    results.push({ zone, key, ...r });
  }
  return results;
}

/** An MCP server's secret that the map doesn't fill in the server's zone. */
export interface McpSecretGap {
  zone: McpZone;
  server: string;
  /** The env var the generated config reads: `secretEnvName(bwsKey)`. */
  env: string;
  bwsKey: string;
}

/**
 * Every `bws:` reference of the MCP servers each zone loads (`serversForZone`,
 * o11y as `opts` or the policy's flags say) whose env var is missing from
 * that zone of the map. [] when the map covers the catalog.
 */
export function mcpSecretGaps(p: Pick<Policy, "mcp" | "flags">, map: SecretMap, opts: McpOptions = {}): McpSecretGap[] {
  const gaps: McpSecretGap[] = [];
  for (const zone of MCP_ZONES) {
    const names = map[zone] ?? {};
    for (const [server, s] of serversForZone(p, zone, opts)) {
      for (const value of Object.values(s.env)) {
        const bwsKey = secretKey(value);
        if (bwsKey === undefined) continue;
        const env = secretEnvName(bwsKey);
        if (!Object.hasOwn(names, env)) gaps.push({ zone, server, env, bwsKey });
      }
    }
  }
  return gaps;
}

/** A JSON Pointer into the map, with any key that isn't a zone or env name hidden: it may be a pasted secret. */
function scrubPath(path: string): string {
  const segs = path.split("/");
  if (segs.length > 1 && !/^[a-z][a-z0-9_-]*$/.test(segs[1]!)) segs[1] = "(a key that is not a zone name, not shown)";
  if (segs.length > 2 && !ENV_NAME.test(segs[2]!)) segs[2] = "(a name that is not an env name, not shown)";
  return segs.join("/");
}

/**
 * Load and check a secrets map file (`secrets-map.schema.json`). Throws a
 * PolicyError naming the file and the JSON Pointer of each problem; a key
 * that isn't a zone or env name is not echoed.
 */
export function loadSecretMap(file: string): SecretMap {
  try {
    return loadChecked(file, "secrets-map") as SecretMap;
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    throw new PolicyError(
      file,
      e.issues.map((i) => ({ ...i, path: scrubPath(i.path) })),
    );
  }
}

const USAGE = "usage: hapi secrets resolve [--dry-run] [--map file] [--policy dir]";

const gapReason = (g: McpSecretGap, policyDir: string) =>
  `not in the secrets map, but ${policyDir}/mcp.yaml's ${g.server} server needs it (bws:${g.bwsKey}); add its bws id to the ${g.zone} zone`;

export interface SecretsDeps {
  bws?: BwsRunner;
  env?: Record<string, string | undefined>;
}

/**
 * `hapi secrets resolve [--dry-run] [--map file] [--policy dir]`.
 *
 * Loads the map (default `stack/secrets.map.yaml`) and checks it covers the MCP
 * catalog's references (`--policy`, default `policy`). Then:
 * - without `--dry-run`: resolves every secret into `$XDG_RUNTIME_DIR/hapi/<zone>.env`
 *   and prints each path. Any miss throws, naming the key; nothing is written.
 * - with `--dry-run`: prints `found`, `missing` or `placeholder` for every key,
 *   never a value, and exits 1 unless every key is found. It writes nothing,
 *   so it needs no XDG_RUNTIME_DIR.
 */
export async function secretsResolve(args: string[], deps: SecretsDeps = {}): Promise<number> {
  const bws = deps.bws ?? runBws;
  const env = deps.env ?? process.env;
  let dryRun = false;
  const opts: Record<"--map" | "--policy", string> = { "--map": "stack/secrets.map.yaml", "--policy": "policy" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = args[i + 1];
    if (arg === "--dry-run") dryRun = true;
    else if ((arg === "--map" || arg === "--policy") && value !== undefined && !value.startsWith("-")) {
      opts[arg] = value;
      i++;
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  const map = loadSecretMap(opts["--map"]);
  const gaps = mcpSecretGaps(loadPolicy(opts["--policy"]), map);

  if (dryRun) {
    const results = await checkSecrets(map, { bws });
    const line = (status: string, where: string, reason?: string) =>
      console.log(`${status.padEnd(12)} ${where}${reason === undefined ? "" : ` (${reason})`}`);
    for (const r of results) line(r.status, `${r.zone}/${r.key}`, r.reason);
    for (const g of gaps) line("missing", `${g.zone}/${g.env}`, gapReason(g, opts["--policy"]));
    const bad = [...results.filter((r) => r.status !== "found").map((r) => `${r.zone}/${r.key}`), ...gaps.map((g) => `${g.zone}/${g.env}`)];
    if (bad.length === 0) return 0;
    console.error(
      `hapi secrets resolve: ${bad.length} of ${results.length + gaps.length} secrets not found: ${bad.join(", ")}. ` +
        "Store each in Bitwarden and put its id in the secrets map (docs/secrets.md).",
    );
    return 1;
  }

  const gap = gaps[0];
  if (gap !== undefined) throw new SecretError(gap.zone, gap.env, gapReason(gap, opts["--policy"]));
  const outDir = runtimeDir(env);
  const paths = await resolveSecrets(map, { bws, outDir });
  for (const path of Object.values(paths).sort()) console.log(path);
  return 0;
}
