/**
 * The tool-description lock, policy/mcp.lock.json (spec §10.1): the rug-pull
 * defense. An MCP server's tool descriptions, instructions, prompts and
 * resources are text the model reads, and a new release (or a remote server)
 * can change them without a version bump anyone notices. So `hapi mcp pin`
 * records each server's raw surface and its hash, and `hapi mcp verify` fails
 * closed when a live surface no longer matches. Re-pinning is a reviewed change:
 * `new_skill_or_mcp` is on the approvals list, so it goes through a planning PR.
 *
 * `fetchSurface(name)` gets a server's live surface. Plan 04 wires the real one,
 * which launches the pinned server's own image (built from a committed
 * lockfile) in a throwaway container on its zone's network: npx can't fetch
 * on the internal zone networks. Until then the registered commands fail
 * closed, and the tests inject fakes.
 *
 * An entry counts only for the pin it was recorded for: after a version bump
 * the server is unpinned until someone pins it again.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../policy/load";
import { check, type Issue, pointerSegment } from "../policy/schema";
import type { McpPackage, McpServer, Policy } from "../policy/types";

/** One tool from tools/list, kept raw: a name plus whatever the server sends (description, inputSchema, annotations...). */
export interface Tool {
  name: string;
  [key: string]: unknown;
}

/** What a server serves: its tools, its `instructions` from initialize, and its prompts and resources. */
export interface Surface {
  tools: Tool[];
  instructions?: string;
  prompts?: unknown[];
  resources?: unknown[];
}

/** The catalog's pin fields for a server, as recorded in its lock entry. */
export interface McpPin {
  package?: McpPackage;
  image?: string;
  url?: string;
}

export interface LockEntry {
  /** The pin this surface was recorded for. */
  pin: McpPin;
  /** `hashToolSurface(surface)`. */
  hash: string;
  /** The raw surface, as the server served it. */
  surface: Surface;
}

/** policy/mcp.lock.json: server name -> entry. It starts as {}. */
export type McpLock = Record<string, LockEntry>;

/** Gets a server's live surface. */
export type FetchSurface = (name: string) => Promise<Surface>;

export interface LockStatus {
  name: string;
  /**
   * ok: the live surface matches. changed: it doesn't. unpinned: no entry for
   * the server's current pin. orphaned: an entry for a server the catalog no
   * longer has.
   */
  status: "ok" | "changed" | "unpinned" | "orphaned";
  /** The locked hash (absent when unpinned). */
  expected?: string;
  /** The live surface's hash (absent when orphaned: a server outside the catalog is never launched). */
  actual?: string;
}

/**
 * JSON with every object's keys sorted (by UTF-16 code unit, JavaScript's
 * default sort) at every depth, and no whitespace. Arrays keep their order;
 * undefined object values are left out, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const isTool = (t: unknown): t is Tool =>
  t !== null && typeof t === "object" && !Array.isArray(t) && typeof (t as { name?: unknown }).name === "string";

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A list's items as canonical JSON, sorted, so the list's order doesn't count. */
function sortedCanonical(list: unknown, what: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new TypeError(`a surface's ${what} must be a list`);
  return list.map(canonicalJson).sort(byString);
}

/**
 * The surface's hash: `sha256:` and the hex sha256 of its canonical JSON,
 * {instructions, prompts, resources, tools}. Tools are sorted by name, and
 * prompts and resources by their canonical JSON, so order never counts; every
 * other change does, down to one character of a description or schema. A
 * missing `instructions` is null; missing prompts or resources are []. Throws
 * if `tools` isn't a list of objects with a string `name`, `instructions`
 * isn't a string, or prompts or resources aren't lists.
 */
export function hashToolSurface(s: Surface): string {
  if (!Array.isArray(s.tools)) throw new TypeError("a surface's tools must be a list");
  s.tools.forEach((t, i) => {
    if (!isTool(t)) throw new TypeError(`tool ${i} is not an object with a string name`);
  });
  if (s.instructions !== undefined && typeof s.instructions !== "string") throw new TypeError("a surface's instructions must be a string");
  const tools = s.tools
    .map((t) => ({ name: t.name, json: canonicalJson(t) }))
    .sort((a, b) => byString(a.name, b.name) || byString(a.json, b.json))
    .map((t) => t.json);
  const instructions = s.instructions === undefined ? "null" : JSON.stringify(s.instructions);
  const list = (items: string[]) => `[${items.join(",")}]`;
  const canonical =
    `{"instructions":${instructions},"prompts":${list(sortedCanonical(s.prompts, "prompts"))},` +
    `"resources":${list(sortedCanonical(s.resources, "resources"))},"tools":${list(tools)}}`;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

/** A server's pin fields (package, image, url), as a lock entry records them. */
export function pinOf(s: McpServer): McpPin {
  return {
    ...(s.package !== undefined ? { package: { name: s.package.name, version: s.package.version, integrity: s.package.integrity } } : {}),
    ...(s.image !== undefined ? { image: s.image } : {}),
    ...(s.url !== undefined ? { url: s.url } : {}),
  };
}

/**
 * Compare every catalog server's live surface with the lock, o11y-gated
 * servers included. A missing entry, or one recorded for another pin, is
 * `unpinned`. A lock entry for a server the catalog doesn't have is
 * `orphaned`, and that server is never fetched. Results are in name order. A
 * failed fetch rejects the whole check (fail closed).
 */
export async function verifyLock(p: Pick<Policy, "mcp">, lock: McpLock, fetchSurface: FetchSurface): Promise<LockStatus[]> {
  const results: LockStatus[] = [];
  const names = [...new Set([...Object.keys(p.mcp.servers), ...Object.keys(lock)])].sort(byString);
  for (const name of names) {
    const entry = Object.hasOwn(lock, name) ? lock[name] : undefined;
    if (!Object.hasOwn(p.mcp.servers, name)) {
      results.push({ name, status: "orphaned", expected: entry!.hash });
      continue;
    }
    const actual = hashToolSurface(await fetchSurface(name));
    if (entry === undefined || canonicalJson(entry.pin) !== canonicalJson(pinOf(p.mcp.servers[name]!))) {
      results.push({ name, status: "unpinned", actual });
    } else {
      results.push({ name, status: entry.hash === actual ? "ok" : "changed", expected: entry.hash, actual });
    }
  }
  return results;
}

/**
 * Read and check a lock file: its schema, that every tool is an object with a
 * string name, and that every hash matches its stored surface (so a hand edit
 * shows). Throws PolicyError naming the file and the JSON Pointer.
 */
export function loadLock(file: string): McpLock {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const message = e instanceof SyntaxError ? `invalid JSON: ${e.message}` : `cannot read file${code ? ` (${code})` : ""}`;
    throw new PolicyError(file, [{ path: "", message }]);
  }
  const schemaIssues = check("mcp-lock", data);
  if (schemaIssues.length > 0) throw new PolicyError(file, schemaIssues);
  const lock = data as McpLock;
  const issues: Issue[] = [];
  for (const [name, entry] of Object.entries(lock)) {
    const at = `/${pointerSegment(name)}`;
    const bad = entry.surface.tools.findIndex((t) => !isTool(t));
    if (bad !== -1) issues.push({ path: `${at}/surface/tools/${bad}`, message: "a tool must be an object with a string name" });
    else if (hashToolSurface(entry.surface) !== entry.hash) {
      issues.push({ path: `${at}/hash`, message: "does not match the stored surface; re-pin the server with `hapi mcp pin`" });
    }
  }
  if (issues.length > 0) throw new PolicyError(file, issues);
  return lock;
}

/** The lock as written to disk: server names sorted, two-space indent, a trailing newline. */
export function lockJson(lock: McpLock): string {
  const sorted = Object.fromEntries(
    Object.keys(lock)
      .sort(byString)
      .map((name) => {
        const { pin, hash, surface } = lock[name]!;
        return [name, { pin, hash, surface }];
      }),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// `hapi mcp verify` and `hapi mcp pin`
// ---------------------------------------------------------------------------

export interface McpDeps {
  fetchSurface: FetchSurface;
}

/** Until Plan 04 wires the live fetch, the commands fail closed: a stub can never pass as a check. */
const NOT_WIRED: McpDeps = {
  fetchSurface: async () => {
    throw new Error(
      "fetching a live MCP surface arrives in Plan 04, which runs the pinned server's own image in a throwaway container on its zone's network",
    );
  },
};

const VERIFY_USAGE = "usage: hapi mcp verify [--policy dir] [--lock file]";
const PIN_USAGE = "usage: hapi mcp pin --server name [--policy dir] [--lock file]";

/** Parse `--flag value` pairs. Returns undefined on an unknown flag or a missing value. */
function parseFlags(args: string[], flags: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!flags.includes(flag) || value === undefined || value.startsWith("-")) return undefined;
    out[flag] = value;
  }
  return out;
}

/**
 * `hapi mcp verify [--policy dir] [--lock file]`: check every catalog server's
 * live surface against the lock (default `<policy>/mcp.lock.json`). Prints one
 * line per server or lock entry, `ok|changed|unpinned|orphaned <name> ...`.
 * Exits 0 only if every server is ok and no entry is orphaned; otherwise 1,
 * with the re-pin commands, or the entries to remove, on stderr. A usage error
 * exits 2.
 */
export async function mcpVerify(args: string[], deps: McpDeps = NOT_WIRED): Promise<number> {
  const flags = parseFlags(args, ["--policy", "--lock"]);
  if (flags === undefined) {
    console.error(VERIFY_USAGE);
    return 2;
  }
  const dir = flags["--policy"] ?? "policy";
  const p = loadPolicy(dir);
  const file = flags["--lock"] ?? join(dir, "mcp.lock.json");
  const lock = loadLock(file);
  const results = await verifyLock(p, lock, deps.fetchSurface);
  for (const r of results) {
    if (r.status === "ok") console.log(`ok ${r.name} ${r.actual}`);
    else if (r.status === "changed") console.log(`changed ${r.name} expected ${r.expected} actual ${r.actual}`);
    else if (r.status === "unpinned") console.log(`unpinned ${r.name} actual ${r.actual}`);
    else console.log(`orphaned ${r.name} expected ${r.expected}`);
  }
  const servers = results.filter((r) => r.status !== "orphaned");
  const bad = servers.filter((r) => r.status !== "ok");
  const orphaned = results.filter((r) => r.status === "orphaned");
  if (bad.length > 0) {
    console.error(
      `hapi mcp verify: ${bad.length} of ${servers.length} servers changed or were never pinned. Review the new surface ` +
        `(new_skill_or_mcp: a planning PR), then re-pin: ${bad.map((r) => `hapi mcp pin --server ${r.name}`).join("; ")}`,
    );
  }
  if (orphaned.length > 0) {
    const [entries, it] = orphaned.length === 1 ? ["lock entry has", "it"] : ["lock entries have", "them"];
    console.error(
      `hapi mcp verify: ${orphaned.length} ${entries} no server in the catalog: ${orphaned.map((r) => r.name).join(", ")}. ` +
        `Remove ${it} from ${file} in the PR that removes the server.`,
    );
  }
  return bad.length === 0 && orphaned.length === 0 ? 0 : 1;
}

/**
 * `hapi mcp pin --server name [--policy dir] [--lock file]`: record one
 * server's live surface and hash in the lock, for its current pin, keeping the
 * other entries. Prints `pinned <name> <hash>`, with the hash it replaced.
 * An unknown server or a usage error exits 2.
 */
export async function mcpPin(args: string[], deps: McpDeps = NOT_WIRED): Promise<number> {
  const flags = parseFlags(args, ["--server", "--policy", "--lock"]);
  const name = flags?.["--server"];
  if (flags === undefined || name === undefined) {
    console.error(PIN_USAGE);
    return 2;
  }
  const dir = flags["--policy"] ?? "policy";
  const p = loadPolicy(dir);
  if (!Object.hasOwn(p.mcp.servers, name)) {
    console.error(`hapi mcp pin: unknown server '${name}'; the catalog (${join(dir, "mcp.yaml")}) has: ${Object.keys(p.mcp.servers).sort(byString).join(", ")}`);
    console.error(PIN_USAGE);
    return 2;
  }
  const file = flags["--lock"] ?? join(dir, "mcp.lock.json");
  const lock = loadLock(file);
  const surface = await deps.fetchSurface(name);
  const entry: LockEntry = { pin: pinOf(p.mcp.servers[name]!), hash: hashToolSurface(surface), surface };
  // Never write an entry that loadLock would refuse (an extra surface key from the fetcher, say).
  const entryIssues = check("mcp-lock", { [name]: entry });
  if (entryIssues.length > 0) throw new PolicyError(`${file} (the new ${name} entry)`, entryIssues);
  const previous = Object.hasOwn(lock, name) ? lock[name]!.hash : undefined;
  // Write a sibling file and rename it over the lock, so a crash never leaves half a file.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, lockJson({ ...lock, [name]: entry }));
  renameSync(tmp, file);
  const was = previous === undefined ? "" : previous === entry.hash ? " (unchanged)" : ` (was ${previous})`;
  console.log(`pinned ${name} ${entry.hash}${was}`);
  return 0;
}
