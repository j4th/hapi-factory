import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { LOGICAL_NAME, loadManifest, MANIFEST_FILE, manifestEntries, manifestNames, mcpSecretGaps, SECRET_ZONES } from "../../src/secrets/manifest";
import { resolveSecrets, type SecretProvider } from "../../src/secrets/provider";
import { RESERVED_ENV_NAMES, serviceEnvironment, ZONE_SERVICES } from "../../src/stack/env";

// Obviously fake: not, and not like, a real credential.
const FAKE = "fake-secret-value-7f3a";

let temps: string[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
function manifestFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-manifest-"));
  temps.push(dir);
  const file = join(dir, "secrets.yaml");
  writeFileSync(file, text);
  return file;
}
function policyError(f: () => unknown): PolicyError {
  try {
    f();
  } catch (e) {
    if (e instanceof PolicyError) return e;
    throw e;
  }
  throw new Error("expected a PolicyError");
}
const full = (extra = "") =>
  `hermes:\n  A: hapi-a\narchon:\n  B: hapi-b\nresearch:\n  C: hapi-c\nhost:\n  D: hapi-a\n${extra}`;

describe("stack/secrets.yaml, the manifest", () => {
  const m = loadManifest(MANIFEST_FILE);

  test("the manifest holds logical names only, and covers every MCP secret: reference", () => {
    expect(MANIFEST_FILE).toBe("stack/secrets.yaml");
    expect(Object.keys(m).sort()).toEqual([...SECRET_ZONES].sort());
    for (const zone of SECRET_ZONES) for (const name of Object.values(m[zone]!)) expect(name).toMatch(LOGICAL_NAME);
    // The file text assigns nothing but logical names (comments aside): no id, no value.
    const assignments = readFileSync(MANIFEST_FILE, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l !== "" && !/^[a-z]+:$/.test(l));
    for (const line of assignments) expect(line).toMatch(/^[A-Z][A-Z0-9_]*: hapi-[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(mcpSecretGaps(loadPolicy("policy"), m)).toEqual([]);
  });

  test("names exactly the env vars each zone needs, each under the Task 4 key name", () => {
    expect(m).toEqual({
      hermes: {
        ANTHROPIC_API_KEY: "hapi-hermes-anthropic-api-key",
        SLACK_BOT_TOKEN: "hapi-hermes-slack-bot-token",
        SLACK_APP_TOKEN: "hapi-hermes-slack-app-token",
        SLACK_ALLOWED_USERS: "hapi-hermes-slack-allowed-users",
      },
      archon: {
        ANTHROPIC_API_KEY: "hapi-archon-anthropic-api-key",
        CLAUDE_API_KEY: "hapi-archon-anthropic-api-key",
        OPENCODE_API_KEY: "hapi-archon-opencode-api-key",
        HAPI_JEV_OPENROUTER_API_KEY: "hapi-archon-jev-openrouter-api-key",
      },
      research: {
        BRAVE_SEARCH_API_KEY: "hapi-research-brave-search-api-key",
        EXA_API_KEY: "hapi-research-exa-api-key",
        HAPI_MCP_CONTEXT7_API_KEY: "hapi-mcp-context7-api-key",
      },
      host: {
        HAPI_PLANNER_APP_ID: "hapi-host-planner-app-id",
        HAPI_PLANNER_APP_PRIVATE_KEY: "hapi-host-planner-app-private-key",
        HAPI_FACTORY_APP_ID: "hapi-host-factory-app-id",
        HAPI_FACTORY_APP_PRIVATE_KEY: "hapi-host-factory-app-private-key",
      },
    });
    // One logical name fills two env vars; every other name is used once.
    expect(manifestNames(m).length).toBe(14);
  });

  test("GitHub App private keys stay in the host zone, never in a container's env file (spec §4.3)", () => {
    for (const zone of SECRET_ZONES.filter((z) => z !== "host")) {
      const entries = Object.entries(m[zone]!).filter(([k, n]) => /APP_PRIVATE_KEY|GITHUB/.test(k) || /-host-/.test(n));
      expect({ zone, entries }).toEqual({ zone, entries: [] });
    }
  });

  test("Pi and Archon's Claude nodes share the hapi-factory workspace key; Hermes has its own", () => {
    expect(m.archon!.CLAUDE_API_KEY).toBe(m.archon!.ANTHROPIC_API_KEY!);
    expect(m.hermes!.ANTHROPIC_API_KEY).not.toBe(m.archon!.ANTHROPIC_API_KEY!);
  });

  test("turning on o11y needs the Phoenix key in the hermes zone", () => {
    expect(mcpSecretGaps(loadPolicy("policy"), m, { o11y: true })).toEqual([
      { zone: "hermes", server: "phoenix", env: "HAPI_MCP_PHOENIX_VIEWER_KEY", name: "hapi-mcp-phoenix-viewer-key" },
    ]);
  });

  test("an MCP env var mapped to another logical name is a gap too", () => {
    const wrong = structuredClone(m);
    wrong.research!.HAPI_MCP_CONTEXT7_API_KEY = "hapi-research-exa-api-key";
    expect(mcpSecretGaps(loadPolicy("policy"), wrong)).toEqual([
      { zone: "research", server: "context7", env: "HAPI_MCP_CONTEXT7_API_KEY", name: "hapi-mcp-context7-api-key" },
    ]);
  });
});

describe("loadManifest", () => {
  test("loads a valid manifest; manifestNames de-duplicates and sorts", () => {
    const m = loadManifest(manifestFile(full()));
    expect(m).toEqual({ hermes: { A: "hapi-a" }, archon: { B: "hapi-b" }, research: { C: "hapi-c" }, host: { D: "hapi-a" } });
    expect(manifestNames(m)).toEqual(["hapi-a", "hapi-b", "hapi-c"]);
  });

  test("a secret pasted in place of a logical name is refused without echoing it", () => {
    const e = policyError(() => loadManifest(manifestFile(full().replace("A: hapi-a", `A: ${FAKE}`))));
    expect(e.message).toContain("/hermes/A");
    expect(e.message).not.toContain(FAKE);
  });

  test("a secret pasted as an env name or a zone is refused without echoing it: only real zones and env names are shown", () => {
    const asKey = policyError(() => loadManifest(manifestFile(full().replace("  A:", `  ${FAKE}:`))));
    expect(asKey.message).toContain("/hermes/<ENV>");
    expect(asKey.message).not.toContain(FAKE);
    const asZone = policyError(() => loadManifest(manifestFile(full(`${FAKE}:\n  E: hapi-e\n`))));
    expect(asZone.issues.map((i) => i.path)).toEqual(["/<zone>"]);
    expect(asZone.message).not.toContain(FAKE);
    // Even a zone-shaped key that isn't one of the four is not shown.
    expect(policyError(() => loadManifest(manifestFile(full("extra:\n  E: hapi-e\n")))).message).toMatch(/\/<zone>: unknown key/);
  });

  test("a missing zone is refused", () => {
    expect(() => loadManifest(manifestFile("hermes:\n  A: hapi-a\n"))).toThrow(/\/archon: missing required key/);
  });

  test("an env name hapi sets in the containers itself is refused, in any zone, naming each one (R4)", () => {
    // HOST would rebind Archon off loopback, HTTPS_PROXY route around the proxy, PI_OFFLINE let Pi fetch packages.
    const e = policyError(() =>
      loadManifest(manifestFile(full().replace("  A: hapi-a", "  A: hapi-a\n  HTTPS_PROXY: hapi-a").replace("  B: hapi-b", "  HOST: hapi-b\n  PI_OFFLINE: hapi-b").replace("  D: hapi-a", "  ALL_PROXY: hapi-a"))),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["/hermes/HTTPS_PROXY", "/archon/HOST", "/archon/PI_OFFLINE", "/host/ALL_PROXY"]);
    expect(e.message).toContain("/archon/HOST: HOST is reserved: hapi sets it in the containers itself (src/stack/env.ts, stack/compose.yaml's environment:)");
  });

  test("every reserved name is refused, and the committed manifest uses none", () => {
    for (const name of RESERVED_ENV_NAMES) {
      const e = policyError(() => loadManifest(manifestFile(full(`  ${name}: hapi-x\n`))));
      // The lower-case proxy names never get that far: an env name is upper case (the schema's pattern).
      expect([name, e.issues.map((i) => i.path)]).toEqual([name, [name === name.toUpperCase() ? `/host/${name}` : "/host/<ENV>"]]);
    }
    const committed = loadManifest(MANIFEST_FILE);
    for (const zone of SECRET_ZONES) expect(Object.keys(committed[zone]!).filter((k) => RESERVED_ENV_NAMES.includes(k))).toEqual([]);
  });

  test("a manifest built in code with a reserved name is refused too, before resolve fetches or writes anything", async () => {
    const m = { archon: { ANTHROPIC_API_KEY: "hapi-a", HOST: "hapi-b" } };
    expect(() => manifestEntries(m)).toThrow("archon/HOST: HOST is reserved");
    let fetched = false;
    const provider: SecretProvider = { name: "sops", downgrade: false, list: async () => [], fetch: async () => ((fetched = true), new Map()) };
    const dir = mkdtempSync(join(tmpdir(), "hapi-manifest-"));
    temps.push(dir);
    await expect(resolveSecrets(m, provider, { outDir: join(dir, "hapi") })).rejects.toThrow("archon/HOST: HOST is reserved");
    expect(fetched).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the reserved set: every name the zone services' environment: sets, the research proxy's, and ALL_PROXY", () => {
    for (const s of ZONE_SERVICES) for (const name of Object.keys(serviceEnvironment(s))) expect(RESERVED_ENV_NAMES).toContain(name);
    expect(RESERVED_ENV_NAMES).toEqual([
      "ALL_PROXY",
      "ARCHON_DOCKER",
      "ARCHON_TELEMETRY_DISABLED",
      "DO_NOT_TRACK",
      "HERMES_HOME",
      "HOST",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "NO_PROXY",
      "PI_CODING_AGENT_DIR",
      "PI_OFFLINE",
      "PI_TELEMETRY",
      "all_proxy",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]);
  });

  test("the logical-name pattern", () => {
    for (const ok of ["hapi-a", "hapi-mcp-context7-api-key", "hapi-host-planner-app-id"]) expect(ok).toMatch(LOGICAL_NAME);
    for (const bad of ["hapi", "hapi-", "hapi--a", "hapi-A", "other-a", "hapi-a-", "hapi_a"]) expect(bad).not.toMatch(LOGICAL_NAME);
  });
});
