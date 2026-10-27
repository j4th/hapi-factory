import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { LOGICAL_NAME, loadManifest, MANIFEST_FILE, manifestEntries, manifestNames, mcpSecretGaps, SECRET_ZONES } from "../../src/secrets/manifest";
import { resolveSecrets, type SecretProvider } from "../../src/secrets/provider";
import { CONTROL_ENV_NAMES, CONTROL_ENV_PREFIXES, CONTROL_ENV_SUFFIXES, RESERVED_ENV_NAMES, reservedEnvRule, serviceEnvironment, ZONE_SERVICES } from "../../src/stack/env";

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

  test("a process-control or trust-store env name is refused in any zone, by exact name or by prefix, naming the rule", () => {
    // LD_PRELOAD would load a library into every process, NODE_OPTIONS add --require, SSL_CERT_FILE swap the CA bundle.
    const e = policyError(() =>
      loadManifest(
        manifestFile(
          full()
            .replace("  A: hapi-a", "  A: hapi-a\n  LD_PRELOAD: hapi-a")
            .replace("  B: hapi-b", "  B: hapi-b\n  NODE_OPTIONS: hapi-b\n  SSL_CERT_FILE: hapi-b")
            .replace("  C: hapi-c", "  C: hapi-c\n  GIT_SSH_COMMAND: hapi-c")
            .replace("  D: hapi-a", "  D: hapi-a\n  PATH: hapi-a"),
        ),
      ),
    );
    expect(e.issues.map((i) => i.path)).toEqual(["/hermes/LD_PRELOAD", "/archon/NODE_OPTIONS", "/archon/SSL_CERT_FILE", "/research/GIT_SSH_COMMAND", "/host/PATH"]);
    expect(e.message).toContain(
      "/hermes/LD_PRELOAD: LD_PRELOAD is reserved: env names starting LD_ configure a runtime, the loader or a tool in the containers (CONTROL_ENV_PREFIXES, src/stack/env.ts), so a secret may not use one. Give the secret another env name",
    );
    expect(e.message).toContain(
      "/archon/SSL_CERT_FILE: SSL_CERT_FILE is reserved: it can change how a process runs, which code it loads or which TLS certificates it trusts (CONTROL_ENV_NAMES, src/stack/env.ts), so a secret may not set it. Give the secret another env name",
    );
  });

  test("every name the ruling lists is refused, each exact name and each prefix too, and a name hapi sets keeps its own reason", () => {
    const ruling = [
      ...["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "IFS", "PS4", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"],
      ...["SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL"],
      ...["GIT_CONFIG_SYSTEM", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS"],
      ...["OPENSSL_CONF", "SSLKEYLOGFILE", "XDG_CONFIG_HOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BUN_OPTIONS", "MISE_DATA_DIR", "UV_INDEX_URL"],
      ...["NPM_CONFIG_REGISTRY", "HERMES_CONFIG", "ARCHON_HOME"],
    ];
    for (const name of [...ruling, ...CONTROL_ENV_NAMES, ...CONTROL_ENV_PREFIXES.map((p) => `${p}X`), ...CONTROL_ENV_SUFFIXES.map((s) => `X${s}`)]) {
      expect([name, reservedEnvRule(name)?.startsWith(`${name} is reserved: `)]).toEqual([name, true]);
      const e = policyError(() => loadManifest(manifestFile(full(`  ${name}: hapi-x\n`))));
      expect([name, e.issues.map((i) => i.path)]).toEqual([name, [`/host/${name}`]]);
    }
    for (const name of ["HERMES_HOME", "ARCHON_DOCKER", "PI_OFFLINE"]) expect(reservedEnvRule(name)).toContain("hapi sets it in the containers itself");
    for (const name of ["ANTHROPIC_BASE_URL", "OPENAI_API_BASE", "GITHUB_API_URL", "OTEL_EXPORTER_OTLP_ENDPOINT", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect([name, reservedEnvRule(name)?.startsWith(`${name} is reserved: `)]).toEqual([name, true]);
    }
    expect(reservedEnvRule("ANTHROPIC_BASE_URL")).toContain("env names ending _BASE_URL set where a client sends its requests and its key");
  });

  test("a lookalike that is neither an exact name nor under a prefix is allowed, as is every name the committed manifest uses", () => {
    for (const name of ["LDAP_PASSWORD", "NODEPING_API_KEY", "BUNNY_API_KEY", "MISER_TOKEN", "UVX_TOKEN", "PIPELINE_KEY", "PINECONE_API_KEY", "GIT_TOKEN", "GITHUB_TOKEN"]) {
      expect([name, reservedEnvRule(name)]).toEqual([name, undefined]);
    }
    for (const name of ["PATH_TOKEN", "MY_PATH", "SSL_CERT_FILE_ID", "HERMESAPI_KEY", "ARCHONS_KEY", "HOMEPAGE_KEY", "XDG_TOKEN", "SLACK_WEBHOOK_URL", "BASE_URL_TOKEN", "ENDPOINT_KEY"]) {
      expect([name, reservedEnvRule(name)]).toEqual([name, undefined]);
    }
    expect(Object.keys(loadManifest(manifestFile(full("  LDAP_PASSWORD: hapi-x\n  NODEPING_API_KEY: hapi-y\n"))).host!)).toEqual(["D", "LDAP_PASSWORD", "NODEPING_API_KEY"]);
    const committed = loadManifest(MANIFEST_FILE);
    for (const zone of SECRET_ZONES) for (const key of Object.keys(committed[zone]!)) expect([zone, key, reservedEnvRule(key)]).toEqual([zone, key, undefined]);
  });

  test("a manifest built in code with a process-control name is refused before resolve fetches or writes anything", async () => {
    const m = { archon: { ANTHROPIC_API_KEY: "hapi-a", NODE_OPTIONS: "hapi-b" } };
    expect(() => manifestEntries(m)).toThrow("archon/NODE_OPTIONS: NODE_OPTIONS is reserved: env names starting NODE_");
    let fetched = false;
    const provider: SecretProvider = { name: "sops", downgrade: false, list: async () => [], fetch: async () => ((fetched = true), new Map()) };
    const dir = mkdtempSync(join(tmpdir(), "hapi-manifest-"));
    temps.push(dir);
    await expect(resolveSecrets(m, provider, { outDir: join(dir, "hapi") })).rejects.toThrow("archon/NODE_OPTIONS: NODE_OPTIONS is reserved");
    expect(fetched).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the control lists: sorted, env-name shaped, and no exact name is already under a prefix", () => {
    expect(CONTROL_ENV_NAMES).toEqual([...CONTROL_ENV_NAMES].sort());
    expect(CONTROL_ENV_PREFIXES).toEqual([...CONTROL_ENV_PREFIXES].sort());
    expect(CONTROL_ENV_SUFFIXES).toEqual([...CONTROL_ENV_SUFFIXES].sort());
    for (const name of [...CONTROL_ENV_NAMES, ...CONTROL_ENV_PREFIXES, ...CONTROL_ENV_SUFFIXES]) expect(name).toMatch(/^[A-Z_][A-Z0-9_]*$/);
    for (const name of CONTROL_ENV_NAMES) expect([name, CONTROL_ENV_SUFFIXES.filter((s) => name.endsWith(s))]).toEqual([name, []]);
    for (const name of CONTROL_ENV_NAMES) expect([name, CONTROL_ENV_PREFIXES.filter((p) => name.startsWith(p))]).toEqual([name, []]);
    expect(CONTROL_ENV_PREFIXES).toEqual(["ARCHON_", "BUN_", "CLAUDE_CODE_", "DYLD_", "GIT_CONFIG_", "HERMES_", "LD_", "MISE_", "NODE_", "NPM_CONFIG_", "PIP_", "PI_", "PYTHON", "UV_"]);
  });

  test("the logical-name pattern", () => {
    for (const ok of ["hapi-a", "hapi-mcp-context7-api-key", "hapi-host-planner-app-id"]) expect(ok).toMatch(LOGICAL_NAME);
    for (const bad of ["hapi", "hapi-", "hapi--a", "hapi-A", "other-a", "hapi-a-", "hapi_a"]) expect(bad).not.toMatch(LOGICAL_NAME);
  });
});
