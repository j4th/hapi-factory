import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { blockedBy, compareVersions, secretEnvName, serversForZone } from "../../src/policy/mcp";
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
      env: { CONTEXT7_API_KEY: "bws:hapi-mcp-context7-api-key", OTEL_SDK_DISABLED: "true" },
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
      PHOENIX_API_KEY: "bws:hapi-mcp-phoenix-viewer-key",
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

  test("env values are bws:hapi-mcp-<name> references or literals with no $ interpolation", () => {
    const interp = policyError(edited('OTEL_SDK_DISABLED: "true"', 'OTEL_SDK_DISABLED: "${ANTHROPIC_API_KEY}"'));
    expect(interp.path).toBe("/servers/context7/env/OTEL_SDK_DISABLED");
    const badRef = policyError(edited("bws:hapi-mcp-context7-api-key", "bws:context7"));
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

  test("each bws key belongs to one server", () => {
    const e = policyError(edited("bws:hapi-mcp-phoenix-viewer-key", "bws:hapi-mcp-context7-api-key"));
    expect(e.path).toBe("/servers/phoenix/env/PHOENIX_API_KEY");
    expect(e.message).toContain("context7");
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

test("secretEnvName turns a bws key name into the env var Hermes resolves it from", () => {
  expect(secretEnvName("hapi-mcp-context7-api-key")).toBe("HAPI_MCP_CONTEXT7_API_KEY");
  expect(secretEnvName("hapi-mcp-phoenix-viewer-key")).toBe("HAPI_MCP_PHOENIX_VIEWER_KEY");
});
