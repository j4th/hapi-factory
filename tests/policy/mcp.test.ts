import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { blockedBy, compareVersions, forbiddenEnv, PACKAGE_ENV, SECRET_ENV_NAME, secretEnvName, serversForZone } from "../../src/policy/mcp";
import { zoneHosts } from "../../src/policy/zones";

const p = loadPolicy("policy");
const MCP_YAML = readFileSync("policy/mcp.yaml", "utf8");

/** Phoenix MCP's 23 read-only tools (spec §10.1; mcp_baseline.md §2.1, checked against 4.3.16's build/). */
const PHOENIX_READ_ONLY = [
  "list-projects", "get-project", "list-traces", "get-trace", "get-spans", "get-span-annotations", "list-sessions",
  "get-session", "list-annotation-configs", "list-datasets", "get-dataset", "get-dataset-examples",
  "get-dataset-experiments", "list-experiments-for-dataset", "get-experiment-by-id", "list-prompts", "get-prompt",
  "get-latest-prompt", "get-prompt-by-identifier", "get-prompt-version", "list-prompt-versions",
  "get-prompt-version-by-tag", "list-prompt-version-tags",
];

// Copies of policy/ with mcp.yaml changed, for the negative tests. Removed after each test.
let temps: string[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
function withMcp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-mcp-"));
  temps.push(dir);
  cpSync("policy", dir, { recursive: true });
  writeFileSync(join(dir, "mcp.yaml"), content);
  return dir;
}
/** mcp.yaml with one exact substring replaced; fails if the substring isn't there exactly once. */
function edited(from: string, to: string): string {
  expect(MCP_YAML.split(from).length - 1).toBe(1);
  return MCP_YAML.replace(from, to);
}
function policyError(content: string): PolicyError {
  try {
    loadPolicy(withMcp(content));
  } catch (e) {
    if (e instanceof PolicyError) return e;
    throw e;
  }
  throw new Error("expected loadPolicy to throw a PolicyError");
}

test("context7 is research-only and hermes has no MCP outside o11y", () => {
  expect(serversForZone(p, "research").map(([n]) => n)).toEqual(["context7"]);
  expect(serversForZone(p, "hermes")).toEqual([]);
  expect(serversForZone(p, "hermes", { o11y: true }).map(([n]) => n)).toEqual(["phoenix"]);
  expect(serversForZone(p, "archon")).toEqual([]);
});

test("serversForZone never returns a server that lists archon, even from a policy built in code", () => {
  // A policy built in code skips the loader, which would refuse these zones.
  const q = structuredClone(p);
  q.mcp.servers.context7!.zones = ["research", "archon"];
  expect(serversForZone(q, "research")).toEqual([]);
  expect(serversForZone(q, "archon")).toEqual([]);
  q.mcp.servers.context7!.zones = ["archon"];
  expect(serversForZone(q, "archon")).toEqual([]);
  // A zone outside the MCP zones gets nothing, whatever the catalog says.
  expect(serversForZone(q, "nope" as never)).toEqual([]);
  // The other servers are untouched.
  expect(serversForZone(q, "hermes", { o11y: true }).map(([n]) => n)).toEqual(["phoenix"]);
});

test("serversForZone defaults o11y to flags.otel.enabled, and an explicit option wins", () => {
  const on = structuredClone(p);
  on.flags.otel.enabled = true;
  expect(serversForZone(on, "hermes").map(([n]) => n)).toEqual(["phoenix"]);
  expect(serversForZone(on, "hermes", { o11y: false })).toEqual([]);
  // o11y never adds a server to another zone.
  expect(serversForZone(on, "research").map(([n]) => n)).toEqual(["context7"]);
});

describe("the v1 catalog (spec §10.1)", () => {
  test("context7: research zone, the cooldown-eligible 4.3.0 pin, its floor, two read-only tools", () => {
    expect(p.mcp.servers.context7).toEqual({
      zones: ["research"],
      transport: "stdio",
      package: {
        name: "@upstash/context7-mcp",
        version: "4.3.0",
        // Checked against registry.npmjs.org and the tarball's sha512 on 2026-10-26.
        integrity: "sha512-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo/rVV0RFA8TOwODGdDVdt/nPxNslkxeDIDp/rPA==",
      },
      floor: { min: "2.1.3", advisory: "CVE-2026-75130" },
      tools: { include: ["resolve-library-id", "query-docs"], deny: [] },
      env: { CONTEXT7_API_KEY: "secret:hapi-mcp-context7-api-key", OTEL_SDK_DISABLED: "true" },
      egress: ["context7.com"],
      trust: "untrusted",
      elicitation: "deny",
      enabled_when: "always",
    });
  });

  test("phoenix: hermes zone with o11y only, 23 read-only tools, write and third-party tools denied", () => {
    const phoenix = p.mcp.servers.phoenix!;
    expect(phoenix.zones).toEqual(["hermes"]);
    expect(phoenix.transport).toBe("stdio");
    expect(phoenix.enabled_when).toBe("o11y");
    // 4.3.16 (2026-10-09) is the newest release past the 14-day cooldown on 2026-10-26; 4.3.17 is 2026-10-21.
    expect(phoenix.package).toEqual({
      name: "@arizeai/phoenix-mcp",
      version: "4.3.16",
      integrity: "sha512-S0k63JMke9hj7A7xehr3Ut7QmrHd9nI4hS2lQSe9zIuREyFvXctckhg1pred6Fmo4FRCgV6h1TK/vLFO5zeNcQ==",
    });
    expect(phoenix.tools.include).toEqual(PHOENIX_READ_ONLY);
    expect(phoenix.tools.deny).toEqual([
      "upsert-prompt", "add-prompt-version-tag", "add-dataset-examples", "phoenix-support", "list-readmes", "get-readme",
    ]);
    expect(phoenix.env).toEqual({
      PHOENIX_API_KEY: "secret:hapi-mcp-phoenix-viewer-key",
      PHOENIX_DISCOVER_CONFIG: "false",
      PHOENIX_ENDPOINT: "http://phoenix.hapi.internal:6006",
    });
    expect(phoenix.egress).toEqual(["phoenix.hapi.internal"]);
    expect([phoenix.trust, phoenix.elicitation]).toEqual(["untrusted", "deny"]);
  });

  test("the blocklist names the lookalike and unwanted packages", () => {
    expect(p.mcp.blocked).toEqual([
      "@modelcontextprotocol/server-brave-search",
      "crawl4ai",
      "ai.smithery/*",
      "@upstash/context7-pi",
      "@upstash/context7-admin-mcp",
    ]);
  });
});

describe("loadPolicy rejects a bad catalog with the file and path", () => {
  test("rejects an inexact pin or a missing integrity", () => {
    for (const version of ["^4.3.0", "latest", "4.3", "4.3.0-canary.1"]) {
      const e = policyError(edited('version: "4.3.0"', `version: "${version}"`));
      expect(e.file).toEndWith("mcp.yaml");
      expect(e.path).toBe("/servers/context7/package/version");
    }
    const noIntegrity = edited(
      '      integrity: "sha512-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo/rVV0RFA8TOwODGdDVdt/nPxNslkxeDIDp/rPA=="\n',
      "",
    );
    const e = policyError(noIntegrity);
    expect(e.path).toBe("/servers/context7/package/integrity");
    expect(e.message).toContain("missing required key");
    // A sha256 or truncated value is not an npm sha512 integrity.
    expect(policyError(edited("sha512-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo", "sha256-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo")).path).toBe(
      "/servers/context7/package/integrity",
    );
  });

  test("enforces the advisory floor", () => {
    const e = policyError(edited('version: "4.3.0"', 'version: "2.1.2"'));
    expect(e.path).toBe("/servers/context7/package/version");
    expect(e.message).toContain("CVE-2026-75130");
    expect(e.message).toContain("2.1.3");
    // At the floor is fine.
    expect(() => loadPolicy(withMcp(edited('version: "4.3.0"', 'version: "2.1.3"')))).not.toThrow();
  });

  test("an image is pinned by digest", () => {
    const at = "    transport: stdio\n    package:\n      name: \"@upstash/context7-mcp\"";
    const withImage = (image: string) =>
      edited(at, `    transport: stdio\n    image: ${image}\n    package:\n      name: "@upstash/context7-mcp"`);
    // An image beside the package (built from it) is fine; the floor still checks the package.
    expect(() => loadPolicy(withMcp(withImage(`ghcr.io/example/context7@sha256:${"a".repeat(64)}`)))).not.toThrow();
    expect(policyError(withImage("ghcr.io/example/context7:4.3.0")).path).toBe("/servers/context7/image");
    expect(policyError(withImage("ghcr.io/example/context7:latest")).path).toBe("/servers/context7/image");
  });

  test("rejects any server enabled for the archon zone", () => {
    const e = policyError(edited("zones: [research]", "zones: [research, archon]"));
    expect(e.path).toBe("/servers/context7/zones/1");
    expect(e.message).toContain("must be one of: hermes, research");
  });

  test("rejects blocked packages", () => {
    const e = policyError(edited('name: "@upstash/context7-mcp"', 'name: "@modelcontextprotocol/server-brave-search"'));
    expect(e.path).toBe("/servers/context7/package/name");
    expect(e.message).toContain("@modelcontextprotocol/server-brave-search");
    expect(e.message).toContain("blocked");
    const admin = policyError(edited('name: "@upstash/context7-mcp"', 'name: "@upstash/context7-admin-mcp"'));
    expect(admin.path).toBe("/servers/context7/package/name");
  });

  test("rejects write tools for phoenix", () => {
    const e = policyError(edited("        - list-prompt-version-tags\n", "        - list-prompt-version-tags\n        - upsert-prompt\n"));
    expect(e.path).toBe("/servers/phoenix/tools/include/23");
    expect(e.message).toContain('"upsert-prompt"');
    expect(e.message).toContain("tools.deny");
  });

  test("a tool name is never an fnmatch pattern, which Hermes would expand", () => {
    const e = policyError(edited("include: [resolve-library-id, query-docs]", 'include: [resolve-library-id, "query-*"]'));
    expect(e.path).toBe("/servers/context7/tools/include/1");
  });

  test("env values are secret:hapi-mcp-<name> references or literals with no $ interpolation", () => {
    const interp = policyError(edited('OTEL_SDK_DISABLED: "true"', 'OTEL_SDK_DISABLED: "${ANTHROPIC_API_KEY}"'));
    expect(interp.path).toBe("/servers/context7/env/OTEL_SDK_DISABLED");
    const badRef = policyError(edited("secret:hapi-mcp-context7-api-key", "secret:context7"));
    expect(badRef.path).toBe("/servers/context7/env/CONTEXT7_API_KEY");
    const lower = policyError(edited('OTEL_SDK_DISABLED: "true"', 'otel_sdk_disabled: "true"'));
    expect(lower.path).toBe("/servers/context7/env/otel_sdk_disabled");
  });

  test("a server may not set the proxy or redirect its traffic", () => {
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "CONTEXT7_API_URL"]) {
      const e = policyError(edited('OTEL_SDK_DISABLED: "true"', `OTEL_SDK_DISABLED: "true"\n      ${name}: http://proxy.example.com:3128`));
      expect(e.path).toBe(`/servers/context7/env/${name}`);
    }
  });

  test("a literal secret-looking value is rejected: a secret's name must hold a secret reference", () => {
    // The reviewer's probe: a real-looking Context7 key as a literal would be emitted in plaintext.
    const e = policyError(edited("CONTEXT7_API_KEY: secret:hapi-mcp-context7-api-key", "CONTEXT7_API_KEY: ctx7sk-FAKE-NOT-A-REAL-KEY"));
    expect(e.file).toEndWith("mcp.yaml");
    expect(e.issues).toEqual([
      {
        path: "/servers/context7/env/CONTEXT7_API_KEY",
        message:
          "CONTEXT7_API_KEY names a secret, so its value must be a secret reference (secret:hapi-mcp-<name>), never a literal: a literal is written in plaintext into every generated config (spec §10.1)",
      },
    ]);
    const phoenix = policyError(edited("PHOENIX_API_KEY: secret:hapi-mcp-phoenix-viewer-key", "PHOENIX_API_KEY: phx-FAKE-NOT-A-REAL-KEY"));
    expect(phoenix.path).toBe("/servers/phoenix/env/PHOENIX_API_KEY");
    expect(phoenix.message).toContain("must be a secret reference");
  });

  test("any name ending in _KEY, _TOKEN, _SECRET, _PASSWORD or _CREDENTIAL(S) must be a secret reference", () => {
    for (const name of ["CONTEXT7_TOKEN", "SERVICE_SECRET", "DB_PASSWORD", "GCP_CREDENTIALS", "GCP_CREDENTIAL", "X_API_KEY"]) {
      const e = policyError(edited('OTEL_SDK_DISABLED: "true"', `OTEL_SDK_DISABLED: "true"\n      ${name}: s3cr3t-value`));
      expect({ name, path: e.path }).toEqual({ name, path: `/servers/context7/env/${name}` });
      expect(e.message).toContain("must be a secret reference");
    }
    expect(SECRET_ENV_NAME.test("api_key")).toBe(true);
    expect(SECRET_ENV_NAME.test("OTEL_SDK_DISABLED")).toBe(false);
  });

  test("a server receives only the env names its package's allowlist lists", () => {
    const extra = (line: string) => edited('OTEL_SDK_DISABLED: "true"', `OTEL_SDK_DISABLED: "true"\n      ${line}`);
    // Not secret-looking, so only the allowlist stops it.
    const e = policyError(extra("CONTEXT7_AUTH: ctx7sk-FAKE-NOT-A-REAL-KEY"));
    expect(e.issues).toEqual([
      {
        path: "/servers/context7/env/CONTEXT7_AUTH",
        message:
          "@upstash/context7-mcp may not receive CONTEXT7_AUTH: its env allowlist (PACKAGE_ENV in src/policy/mcp.ts) is CONTEXT7_API_KEY, OTEL_SDK_DISABLED",
      },
    ]);
    // A secret reference doesn't widen it, and another package's names aren't context7's.
    expect(policyError(extra("CONTEXT7_AUTH: secret:hapi-mcp-context7-auth")).path).toBe("/servers/context7/env/CONTEXT7_AUTH");
    expect(policyError(extra('PHOENIX_DISCOVER_CONFIG: "false"')).path).toBe("/servers/context7/env/PHOENIX_DISCOVER_CONFIG");
    // A package with no allowlist gets no env at all.
    const fork = policyError(edited('name: "@upstash/context7-mcp"', 'name: "@example/context7-fork"'));
    expect(fork.issues.map((i) => i.path)).toEqual(["/servers/context7/env/CONTEXT7_API_KEY", "/servers/context7/env/OTEL_SDK_DISABLED"]);
    expect(fork.message).toContain("@example/context7-fork has no env allowlist");
  });

  test("a flag is a literal from its allowed values, so it can't carry a secret", () => {
    for (const value of ["ctx7sk-FAKE-NOT-A-REAL-KEY", "false", "1"]) {
      const e = policyError(edited('OTEL_SDK_DISABLED: "true"', `OTEL_SDK_DISABLED: "${value}"`));
      expect(e.issues).toEqual([{ path: "/servers/context7/env/OTEL_SDK_DISABLED", message: 'OTEL_SDK_DISABLED is a flag: its value must be "true"' }]);
    }
    expect(policyError(edited('PHOENIX_DISCOVER_CONFIG: "false"', 'PHOENIX_DISCOVER_CONFIG: "true"')).path).toBe("/servers/phoenix/env/PHOENIX_DISCOVER_CONFIG");
    // A flag or an endpoint is a literal, never a secret reference.
    const ref = policyError(edited('OTEL_SDK_DISABLED: "true"', "OTEL_SDK_DISABLED: secret:hapi-mcp-context7-otel"));
    expect(ref.issues).toEqual([{ path: "/servers/context7/env/OTEL_SDK_DISABLED", message: "OTEL_SDK_DISABLED is a flag, not a secret: write its literal value, not a secret reference" }]);
  });

  test("an endpoint literal is an http(s) URL whose host is one of the server's own egress hosts", () => {
    const at = "PHOENIX_ENDPOINT: http://phoenix.hapi.internal:6006";
    const e = policyError(edited(at, "PHOENIX_ENDPOINT: http://evil.example.com:6006"));
    expect(e.issues).toEqual([
      {
        path: "/servers/phoenix/env/PHOENIX_ENDPOINT",
        message: 'PHOENIX_ENDPOINT is an endpoint: its host "evil.example.com" is not one of this server\'s egress hosts, or under one',
      },
    ]);
    for (const url of [
      "https://phoenix.hapi.internal.evil.com", // a lookalike suffix is not a subdomain
      "http://user:pw@phoenix.hapi.internal:6006", // user info could carry a secret
      "http://phoenix.hapi.internal:6006/?api_key=abc", // so could a query
      "http://phoenix.hapi.internal:6006/#x",
      "ftp://phoenix.hapi.internal",
      "phoenix.hapi.internal:6006", // no scheme: parses as the scheme "phoenix.hapi.internal:"
      "not a url",
    ]) {
      expect({ url, path: policyError(edited(at, `PHOENIX_ENDPOINT: "${url}"`)).path }).toEqual({ url, path: "/servers/phoenix/env/PHOENIX_ENDPOINT" });
    }
    // An egress host, or a subdomain of one, over http or https, is fine.
    expect(() => loadPolicy(withMcp(edited(at, "PHOENIX_ENDPOINT: https://ui.phoenix.hapi.internal/base")))).not.toThrow();
  });

  test("an endpoint literal's path is plain segments: no percent-encoding, dot segments or other punctuation (H-034)", () => {
    const at = "PHOENIX_ENDPOINT: http://phoenix.hapi.internal:6006";
    for (const path of ["/a%2Fb", "/a/../b", "/./a", "/a;b=c", "/a,b", "/a@b", "/a b", "/~user/../.."]) {
      const e = policyError(edited(at, `PHOENIX_ENDPOINT: "http://phoenix.hapi.internal:6006${path}"`));
      expect({ path, issues: e.issues }).toEqual({
        path,
        issues: [{ path: "/servers/phoenix/env/PHOENIX_ENDPOINT", message: expect.stringContaining("its path may hold only plain segments") }],
      });
    }
    for (const path of ["", "/", "/base", "/v1/", "/a.b/c-d_e~f"]) {
      expect(() => loadPolicy(withMcp(edited(at, `PHOENIX_ENDPOINT: "http://phoenix.hapi.internal:6006${path}"`)))).not.toThrow();
    }
  });

  test("the names a package must be given are required, not merely allowed (H-032)", () => {
    // spec §10.1: Context7 always keyed with telemetry off; Phoenix with a VIEWER key, no config discovery and an explicit endpoint.
    for (const [line, server, name] of [
      ["      OTEL_SDK_DISABLED: \"true\"\n", "context7", "OTEL_SDK_DISABLED"],
      ["      CONTEXT7_API_KEY: secret:hapi-mcp-context7-api-key   # always keyed: anonymous callers can get a setup elicitation\n", "context7", "CONTEXT7_API_KEY"],
      ["      PHOENIX_DISCOVER_CONFIG: \"false\"                   # no .env.phoenix discovery up the directory tree\n", "phoenix", "PHOENIX_DISCOVER_CONFIG"],
      ["      PHOENIX_API_KEY: secret:hapi-mcp-phoenix-viewer-key   # minted by a VIEWER-role user\n", "phoenix", "PHOENIX_API_KEY"],
      ["      PHOENIX_ENDPOINT: http://phoenix.hapi.internal:6006\n", "phoenix", "PHOENIX_ENDPOINT"],
    ] as const) {
      const e = policyError(edited(line, ""));
      expect({ name, issues: e.issues }).toEqual({ name, issues: [{ path: `/servers/${server}/env`, message: expect.stringContaining(`must set ${name}`) }] });
    }
  });

  test("a hard denylist of launch-hijack, proxy and redirect variables, as literals or secret references (defense in depth)", () => {
    const names = [
      "NPM_CONFIG_REGISTRY", // npx fetches the package from another registry; nothing checks its integrity at launch
      "NPM_CONFIG_USERCONFIG",
      "NPM_TOKEN",
      "NODE_OPTIONS", // --require or --import of any code
      "NODE_PATH",
      "NODE_EXTRA_CA_CERTS",
      "NODE_TLS_REJECT_UNAUTHORIZED",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "LD_AUDIT",
      "GCONV_PATH",
      "PATH",
      "HOME", // npm reads ~/.npmrc
      "BASH_ENV",
      "ENV",
      "BASH_FUNC_X",
      "UV_INDEX_URL",
      "UV_DEFAULT_INDEX",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "FTP_PROXY",
      "GLOBAL_AGENT_HTTP_PROXY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "CONTEXT7_API_URL",
      "PHOENIX_CLIENT_HEADERS",
      "DANGEROUSLY_READ_README_FILES",
    ];
    for (const name of names) {
      expect({ name, denied: forbiddenEnv(name) !== undefined }).toEqual({ name, denied: true });
      for (const value of ["http://proxy.example.com:3128", "secret:hapi-mcp-context7-extra"]) {
        const e = policyError(edited('OTEL_SDK_DISABLED: "true"', `OTEL_SDK_DISABLED: "true"\n      ${name}: ${value}`));
        expect({ name, value, issues: e.issues.map((i) => i.path) }).toEqual({ name, value, issues: [`/servers/context7/env/${name}`] });
        expect(e.message).toContain(`a server may not set ${name}: ${forbiddenEnv(name)} (spec §10.1)`);
      }
    }
    // Case doesn't matter: npm reads npm_config_* in any case.
    expect(forbiddenEnv("npm_config_registry")).toBe(forbiddenEnv("NPM_CONFIG_REGISTRY"));
    expect(forbiddenEnv("node_options")).toBeDefined();
    // The catalog's own names are not on it.
    for (const name of ["CONTEXT7_API_KEY", "OTEL_SDK_DISABLED", "PHOENIX_API_KEY", "PHOENIX_DISCOVER_CONFIG", "PHOENIX_ENDPOINT", "PATHS"]) {
      expect({ name, denied: forbiddenEnv(name) }).toEqual({ name, denied: undefined });
    }
  });

  test("the allowlist itself: a secret-looking name is always a secret, no name is on the denylist, and it covers the catalog", () => {
    for (const [pkg, names] of Object.entries(PACKAGE_ENV)) {
      for (const [name, rule] of Object.entries(names)) {
        if (SECRET_ENV_NAME.test(name)) expect({ pkg, name, kind: rule.kind }).toEqual({ pkg, name, kind: "secret" });
        expect({ pkg, name, denied: forbiddenEnv(name) }).toEqual({ pkg, name, denied: undefined });
        if (rule.kind === "flag") expect(rule.values.length).toBeGreaterThan(0);
      }
    }
    // Every name spec §10.1 says is set is required (H-032).
    expect(PACKAGE_ENV["@upstash/context7-mcp"]).toEqual({ CONTEXT7_API_KEY: { kind: "secret", required: true }, OTEL_SDK_DISABLED: { kind: "flag", values: ["true"], required: true } });
    expect(PACKAGE_ENV["@arizeai/phoenix-mcp"]).toEqual({
      PHOENIX_API_KEY: { kind: "secret", required: true },
      PHOENIX_DISCOVER_CONFIG: { kind: "flag", values: ["false"], required: true },
      PHOENIX_ENDPOINT: { kind: "endpoint", required: true },
    });
  });

  test("each secret belongs to one server", () => {
    const e = policyError(edited("secret:hapi-mcp-phoenix-viewer-key", "secret:hapi-mcp-context7-api-key"));
    expect(e.path).toBe("/servers/phoenix/env/PHOENIX_API_KEY");
    expect(e.message).toContain("context7");
  });

  test("the old bws: prefix is no reference: a secret written with it is refused as a literal", () => {
    const e = policyError(edited("CONTEXT7_API_KEY: secret:hapi-mcp-context7-api-key", "CONTEXT7_API_KEY: bws:hapi-mcp-context7-api-key"));
    expect(e.issues).toEqual([
      { path: "/servers/context7/env/CONTEXT7_API_KEY", message: expect.stringContaining("must be a secret reference (secret:hapi-mcp-<name>)") },
    ]);
  });

  test("stdio needs a package; url is for http, which needs one whose host is in its egress", () => {
    // context7 is the first server, so the first package block and "transport: stdio" are its own.
    const noPkg = MCP_YAML.replace(/    package:\n      name: "@upstash\/context7-mcp"\n(?:      .*\n)*?      integrity: "[^"]+"\n/, "");
    expect(noPkg).not.toBe(MCP_YAML);
    expect(policyError(noPkg).path).toBe("/servers/context7/package");
    const stdioUrl = edited("    transport: stdio\n    package:\n      name: \"@upstash", "    transport: stdio\n    url: https://mcp.context7.com/mcp\n    package:\n      name: \"@upstash");
    expect(policyError(stdioUrl).path).toBe("/servers/context7/url");
    const http = noPkg.replace("    transport: stdio\n", "    transport: http\n    url: https://mcp.example.org/mcp\n");
    // The floor needs a package, the env is for stdio, and the url's host must be an egress host.
    expect(policyError(http).issues.map((i) => i.path)).toEqual([
      "/servers/context7/url",
      "/servers/context7/floor",
      "/servers/context7/env",
    ]);
    // An egress host covers its subdomains, as in the egress proxy.
    const remote = http.replace("mcp.example.org", "mcp.context7.com").replace(/    floor: .*\n/, "").replace(/    env:\n(?:      .*\n)+/, "    env: {}\n");
    expect(() => loadPolicy(withMcp(remote))).not.toThrow();
    expect(policyError(http.replace("transport: http", "transport: stdio")).path).toBe("/servers/context7/package");
    expect(policyError(remote.replace("https://mcp.context7.com/mcp", "http://mcp.context7.com/mcp")).path).toBe("/servers/context7/url");
  });

  test("a url never holds $, which Hermes would expand into another secret", () => {
    // An http entry whose host is under its own egress, so only the "$" can fail it.
    const remote = MCP_YAML.replace(/    package:\n      name: "@upstash\/context7-mcp"\n(?:      .*\n)*?      integrity: "[^"]+"\n/, "")
      .replace("    transport: stdio\n", "    transport: http\n    url: https://mcp.context7.com/mcp\n")
      .replace(/    floor: .*\n/, "")
      .replace(/    env:\n      CONTEXT7_API_KEY: .*\n      OTEL_SDK_DISABLED: .*\n/, "    env: {}\n");
    expect(() => loadPolicy(withMcp(remote))).not.toThrow();
    for (const url of [
      "https://mcp.context7.com/mcp?k=${ANTHROPIC_API_KEY}&c=${HAPI_MCP_CONTEXT7_API_KEY}", // the provider key and another server's key
      "https://mcp.context7.com/mcp?k=${ANTHROPIC_API_KEY}",
      "https://mcp.context7.com/${env:ANTHROPIC_API_KEY}", // Hermes's Cursor-style form
      "https://mcp.context7.com/mcp?k=$ANTHROPIC_API_KEY",
    ]) {
      const e = policyError(remote.replace("url: https://mcp.context7.com/mcp", `url: ${JSON.stringify(url)}`));
      expect(e.file).toEndWith("mcp.yaml");
      expect(e.issues).toEqual([{ path: "/servers/context7/url", message: 'must match pattern "^[^$?#]+$"' }]);
    }
  });

  test("a url never holds a query or a fragment, which could carry a literal credential into every generated config (H-033)", () => {
    const remote = MCP_YAML.replace(/    package:\n      name: "@upstash\/context7-mcp"\n(?:      .*\n)*?      integrity: "[^"]+"\n/, "")
      .replace("    transport: stdio\n", "    transport: http\n    url: https://mcp.context7.com/mcp\n")
      .replace(/    floor: .*\n/, "")
      .replace(/    env:\n      CONTEXT7_API_KEY: .*\n      OTEL_SDK_DISABLED: .*\n/, "    env: {}\n");
    for (const url of ["https://mcp.context7.com/mcp?key=abc123", "https://mcp.context7.com/mcp#key=abc123", "https://mcp.context7.com/mcp?"]) {
      expect({ url, issues: policyError(remote.replace("url: https://mcp.context7.com/mcp", `url: ${JSON.stringify(url)}`)).issues }).toEqual({
        url,
        issues: [{ path: "/servers/context7/url", message: 'must match pattern "^[^$?#]+$"' }],
      });
    }
  });

  test("an unknown key in a server is rejected", () => {
    expect(policyError(edited("    elicitation: deny\n    enabled_when: always", "    elicitation: deny\n    enabled_when: always\n    autoapprove: true")).path).toBe(
      "/servers/context7/autoapprove",
    );
  });
});

test("hermes zone has no T2 sources", () => {
  // Spec §10 as amended in §10.1: the Hermes main session gets T0–T1; Context7 and DeepWiki are research-only.
  expect(p.trustedSources.zones.hermes.tiers).toEqual(["T0", "T1"]);
  expect(zoneHosts(p, "hermes")).not.toContain("context7.com");
  expect(zoneHosts(p, "hermes")).not.toContain("deepwiki.com");
});

test("compareVersions orders exact versions numerically", () => {
  expect(compareVersions("2.1.2", "2.1.3")).toBeLessThan(0);
  expect(compareVersions("2.1.3", "2.1.3")).toBe(0);
  expect(compareVersions("4.3.0", "2.1.3")).toBeGreaterThan(0);
  expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
  expect(compareVersions("2026.10.24", "2026.10.9")).toBeGreaterThan(0);
});

test("blockedBy matches whole names; * matches any run of characters", () => {
  const blocked = ["crawl4ai", "ai.smithery/*", "@upstash/context7-pi"];
  expect(blockedBy("crawl4ai", blocked)).toBe("crawl4ai");
  expect(blockedBy("ai.smithery/some-server", blocked)).toBe("ai.smithery/*");
  expect(blockedBy("@upstash/context7-pi", blocked)).toBe("@upstash/context7-pi");
  expect(blockedBy("@upstash/context7-mcp", blocked)).toBeUndefined();
  expect(blockedBy("crawl4ai-extra", blocked)).toBeUndefined();
  // Regex metacharacters in a pattern are literal.
  expect(blockedBy("aiXsmithery/x", blocked)).toBeUndefined();
});

test("secretEnvName turns a secret name into the env var Hermes resolves it from", () => {
  expect(secretEnvName("hapi-mcp-context7-api-key")).toBe("HAPI_MCP_CONTEXT7_API_KEY");
  expect(secretEnvName("hapi-mcp-phoenix-viewer-key")).toBe("HAPI_MCP_PHOENIX_VIEWER_KEY");
});
