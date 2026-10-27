import { describe, expect, test } from "bun:test";
import { emitHermes } from "../../src/generate/hermes";
import { checkOwnRefs, emitMcp, emitMcpJson, hermesMcpServers } from "../../src/generate/mcp";
import { loadPolicy } from "../../src/policy/load";

const p = loadPolicy("policy");
// Parsed JSON is untyped.
const parsed = (zone: "hermes" | "research", policy = p): any => JSON.parse(emitMcpJson(policy, zone));

describe("emitMcpJson", () => {
  test("emitMcpJson writes a scanner-compatible file per zone", () => {
    const research = parsed("research");
    expect(Object.keys(research)).toEqual(["$comment", "mcpServers"]);
    expect(Object.keys(research.mcpServers)).toEqual(["context7"]);
    // A pinned command: the exact version, never a range or a tag.
    expect(research.mcpServers.context7).toEqual({
      type: "stdio",
      command: "npx",
      args: ["--yes", "@upstash/context7-mcp@4.3.0"],
      env: { CONTEXT7_API_KEY: "${HAPI_MCP_CONTEXT7_API_KEY}", OTEL_SDK_DISABLED: "true" },
    });
  });

  test("the scanner file covers the whole catalog for the zone, o11y-gated servers included", () => {
    const hermes = parsed("hermes");
    expect(Object.keys(hermes.mcpServers)).toEqual(["phoenix"]);
    expect(hermes.mcpServers.phoenix.args).toEqual(["--yes", "@arizeai/phoenix-mcp@4.3.16"]);
    expect(hermes.mcpServers.phoenix.env).toEqual({
      PHOENIX_API_KEY: "${HAPI_MCP_PHOENIX_VIEWER_KEY}",
      PHOENIX_DISCOVER_CONFIG: "false",
      PHOENIX_ENDPOINT: "http://phoenix.hapi.internal:6006",
    });
  });

  test("secrets appear only as ${NAME} references to their secret name", () => {
    for (const zone of ["hermes", "research"] as const) {
      const text = emitMcpJson(p, zone);
      expect(text).not.toContain("secret:");
      for (const server of Object.values(parsed(zone).mcpServers) as any[]) {
        for (const value of Object.values(server.env) as string[]) {
          expect(value.startsWith("${") ? /^\$\{HAPI_MCP_[A-Z0-9_]+\}$/.test(value) : !value.includes("$")).toBe(true);
        }
      }
    }
  });

  test("the notice is the first key, and the archon zone has no file", () => {
    expect(parsed("research").$comment).toContain("Do not edit it by hand");
    expect(parsed("research").$comment).toContain("policy/mcp.yaml");
    expect(Object.keys(emitMcp(p)).sort()).toEqual(["hermes.mcp.json", "research.mcp.json"]);
    expect(() => emitMcpJson(p, "archon" as never)).toThrow(/archon zone gets no MCP servers/);
  });

  test("an http server is a url entry", () => {
    const q = structuredClone(p);
    q.mcp.servers["docs-remote"] = {
      zones: ["research"],
      transport: "http",
      url: "https://mcp.example.org/mcp",
      tools: { include: ["search"], deny: [] },
      env: {},
      egress: ["example.org"],
      trust: "untrusted",
      elicitation: "deny",
    };
    expect(parsed("research", q).mcpServers["docs-remote"]).toEqual({ type: "http", url: "https://mcp.example.org/mcp" });
    expect(hermesMcpServers(q, "research")["docs-remote"]).toEqual({
      url: "https://mcp.example.org/mcp",
      tools: { include: ["search"], prompts: false, resources: false },
      trust: "untrusted",
      elicitation: { enabled: false },
      sampling: { enabled: false },
    });
  });

  test("the emitters re-check a policy built in code, which skips the loader", () => {
    const interp = structuredClone(p);
    interp.mcp.servers.context7!.env.OTEL_SDK_DISABLED = "${ANTHROPIC_API_KEY}";
    expect(() => emitMcp(interp)).toThrow(/\/servers\/context7\/env\/OTEL_SDK_DISABLED/);
    const archon = structuredClone(p);
    archon.mcp.servers.context7!.zones = ["archon"];
    expect(() => emitMcp(archon)).toThrow(/\/servers\/context7\/zones\/0/);
    const write = structuredClone(p);
    write.mcp.servers.phoenix!.tools.include.push("upsert-prompt");
    expect(() => hermesMcpServers(write, "hermes", { o11y: true })).toThrow(/upsert-prompt/);
    // A literal secret would be written in plaintext into the Hermes config and research.mcp.json.
    const literal = structuredClone(p);
    literal.mcp.servers.context7!.env.CONTEXT7_API_KEY = "ctx7sk-FAKE-NOT-A-REAL-KEY";
    expect(() => emitMcpJson(literal, "research")).toThrow(/\/servers\/context7\/env\/CONTEXT7_API_KEY: CONTEXT7_API_KEY names a secret/);
    expect(() => hermesMcpServers(literal, "research")).toThrow(/must be a secret reference/);
    const hijack = structuredClone(p);
    hijack.mcp.servers.phoenix!.env.NODE_OPTIONS = "--require /tmp/x.js";
    expect(() => emitHermes(hijack, { o11y: true })).toThrow(/\/servers\/phoenix\/env\/NODE_OPTIONS: a server may not set NODE_OPTIONS/);
  });

  test("an entry with an image is refused until image launch lands, because the npx command would ignore it", () => {
    const image = `ghcr.io/example/context7@sha256:${"a".repeat(64)}`;
    const q = structuredClone(p);
    q.mcp.servers.context7!.image = image;
    const message =
      `MCP server context7 sets image ${image}, but the generators can't launch a server from its image yet (Plan 04 builds the per-server images). ` +
      "The npx command would ignore the image and run the package with an unpinned dependency tree and no integrity check, so remove image until image launch lands (spec §10.1)";
    expect(() => emitMcpJson(q, "research")).toThrow(message);
    expect(() => hermesMcpServers(q, "research")).toThrow(message);
    expect(() => emitMcp(q)).toThrow(message);
    // Phoenix: the Hermes config refuses it with o11y on, and the scanner file always does.
    const r = structuredClone(p);
    r.mcp.servers.phoenix!.image = `ghcr.io/example/phoenix-mcp@sha256:${"b".repeat(64)}`;
    expect(() => emitHermes(r, { o11y: true })).toThrow(/MCP server phoenix sets image/);
    expect(() => emitMcpJson(r, "hermes")).toThrow(/MCP server phoenix sets image/);
    expect(() => emitHermes(r)).not.toThrow();
  });

  test("an http url holding ${...} is never emitted: it could carry the provider key or another server's key", () => {
    // The reviewer's probe: the host is under the entry's own egress, so only the "$" can fail it.
    for (const url of [
      "https://mcp.context7.com/mcp?k=${ANTHROPIC_API_KEY}&c=${HAPI_MCP_CONTEXT7_API_KEY}",
      "https://mcp.context7.com/mcp?k=${ANTHROPIC_API_KEY}",
      "https://mcp.context7.com/${env:ANTHROPIC_API_KEY}",
    ]) {
      const q = structuredClone(p);
      q.mcp.servers["docs-remote"] = {
        zones: ["research"],
        transport: "http",
        url,
        tools: { include: ["search"], deny: [] },
        env: {},
        egress: ["context7.com"],
        trust: "untrusted",
        elicitation: "deny",
      };
      expect(() => emitMcpJson(q, "research")).toThrow(/\/servers\/docs-remote\/url: must match pattern/);
      expect(() => hermesMcpServers(q, "research")).toThrow(/\/servers\/docs-remote\/url: must match pattern/);
      expect(() => emitMcp(q)).toThrow(/\/servers\/docs-remote\/url/);
    }
  });
  test("emitMcp is deterministic", () => {
    expect(emitMcp(p)).toEqual(emitMcp(loadPolicy("policy")));
  });
});

describe("hermesMcpServers", () => {
  test("only enabled servers of the zone, with the include list, untrusted, no elicitation or sampling", () => {
    expect(hermesMcpServers(p, "hermes")).toEqual({});
    const hermes = hermesMcpServers(p, "hermes", { o11y: true });
    expect(Object.keys(hermes)).toEqual(["phoenix"]);
    const phoenix = hermes.phoenix as any;
    expect(phoenix.command).toBe("npx");
    expect(phoenix.args).toEqual(["--yes", "@arizeai/phoenix-mcp@4.3.16"]);
    expect(phoenix.tools.include).toEqual(p.mcp.servers.phoenix!.tools.include);
    expect([phoenix.tools.prompts, phoenix.tools.resources]).toEqual([false, false]);
    expect(phoenix.trust).toBe("untrusted");
    expect(phoenix.elicitation).toEqual({ enabled: false });
    expect(phoenix.sampling).toEqual({ enabled: false });
    expect(Object.keys(hermesMcpServers(p, "research"))).toEqual(["context7"]);
  });
});

describe("checkOwnRefs", () => {
  const context7 = p.mcp.servers.context7!;

  test("a server's own secret references, as env values, pass; every real entry passes", () => {
    const entry = { type: "stdio", command: "npx", args: ["--yes", "x@1.0.0"], env: { CONTEXT7_API_KEY: "${HAPI_MCP_CONTEXT7_API_KEY}", OTEL_SDK_DISABLED: "true" } };
    expect(checkOwnRefs("context7", context7, entry)).toBe(entry);
    expect(() => emitMcp(p)).not.toThrow();
    expect(() => hermesMcpServers(p, "hermes", { o11y: true })).not.toThrow();
  });

  test("any other $ in any field of the entry throws, so a future field (headers) is covered too", () => {
    const cases: [object, RegExp][] = [
      [{ type: "http", url: "https://mcp.context7.com/mcp?k=${ANTHROPIC_API_KEY}" }, /context7: url is .*ANTHROPIC_API_KEY/],
      [{ url: "https://mcp.context7.com/mcp", headers: { Authorization: "Bearer ${HAPI_MCP_PHOENIX_VIEWER_KEY}" } }, /context7: headers\.Authorization/],
      // Its own key, but outside env: Hermes would send it in a header.
      [{ url: "https://mcp.context7.com/mcp", headers: { "X-Key": "${HAPI_MCP_CONTEXT7_API_KEY}" } }, /context7: headers\.X-Key/],
      [{ command: "npx", args: ["--yes", "x@1.0.0", "--key=${ANTHROPIC_API_KEY}"] }, /context7: args\.2/],
      [{ env: { CONTEXT7_API_KEY: "${HAPI_MCP_PHOENIX_VIEWER_KEY}" } }, /context7: env\.CONTEXT7_API_KEY/], // another server's key
      [{ env: { CONTEXT7_API_KEY: "${env:HAPI_MCP_CONTEXT7_API_KEY}" } }, /context7: env\.CONTEXT7_API_KEY/], // not the exact reference
      [{ env: { EXTRA: "prefix-${HAPI_MCP_CONTEXT7_API_KEY}" } }, /context7: env\.EXTRA/],
      [{ headers: { "${ANTHROPIC_API_KEY}": "x" } }, /context7: headers has the key/],
    ];
    for (const [entry, message] of cases) expect(() => checkOwnRefs("context7", context7, entry)).toThrow(message);
  });
});
