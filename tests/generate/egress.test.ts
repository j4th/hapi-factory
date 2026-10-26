import { describe, expect, test } from "bun:test";
import { emitEgress } from "../../src/generate/egress";
import { forgeDomain } from "../../src/policy/hosts";
import { loadPolicy } from "../../src/policy/load";
import { applyOverlay } from "../../src/policy/overlay";
import type { Policy, ZoneName } from "../../src/policy/types";
import { zoneHosts } from "../../src/policy/zones";

const p = loadPolicy("policy");
const ZONES: ZoneName[] = ["hermes", "archon", "research"];
const conf = (zone: ZoneName, policy: Policy = p) => emitEgress(policy)[`${zone}.squid.conf`]!;
/** The directive lines: comments and blank lines dropped. */
const directives = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
const allowed = (text: string) =>
  directives(text)
    .filter((l) => l.startsWith("acl allowed dstdomain "))
    .map((l) => l.slice("acl allowed dstdomain ".length));
/** A copy of the policy with the archon zone's hosts or a tier's hosts changed. */
function withArchonHosts(hosts: string[]): Policy {
  const q = structuredClone(p);
  q.trustedSources.zones.archon.hosts = hosts;
  return q;
}

test("emitEgress returns one squid.conf per zone", () => {
  expect(Object.keys(emitEgress(p)).sort()).toEqual(["archon.squid.conf", "hermes.squid.conf", "research.squid.conf"]);
});

test("egress archon allowlist is exact and denies by default", () => {
  const c = conf("archon");
  expect(c).toContain("acl allowed dstdomain .api.anthropic.com");
  expect(c).not.toMatch(/dstdomain .*github\.com/); // Archon zone has no forge route
  expect(c.trim().endsWith("http_access deny all")).toBe(true);
  expect(allowed(c)).toEqual([
    ".api.anthropic.com",
    ".files.pythonhosted.org",
    ".opencode.ai",
    ".openrouter.ai",
    ".pypi.org",
    ".registry.npmjs.org",
  ]);
  // Allowlisted zones are HTTPS-only: the one allow is CONNECT to an allowed domain.
  expect(directives(c).filter((l) => l.startsWith("http_access allow"))).toEqual(["http_access allow CONNECT allowed"]);
});

test("research zone allows open web but blocks private ranges", () => {
  const c = conf("research");
  const lines = directives(c);
  expect(lines).toContain("http_access deny to_localnet");
  const toLocalnet = lines.find((l) => l.startsWith("acl to_localnet dst "))!.split(" ").slice(3);
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "::1", "fc00::/7", "fe80::/10"]) {
    expect(toLocalnet).toContain(range);
  }
  expect(c).not.toContain("dstdomain");
  expect(lines).toContain("http_access allow CONNECT");
  expect(lines).toContain("http_access allow plain_http");
  expect(c.trim().endsWith("http_access deny all")).toBe(true);
});

describe("every zone", () => {
  for (const zone of ZONES) {
    test(`${zone}: refuses other clients and private ranges before any allow, CONNECT only to 443, deny all last`, () => {
      const lines = directives(conf(zone)).filter((l) => l.startsWith("http_access "));
      const firstAllow = lines.findIndex((l) => l.startsWith("http_access allow"));
      expect(firstAllow).toBeGreaterThan(0);
      for (const rule of ["http_access deny !zone_clients", "http_access deny to_localnet", "http_access deny CONNECT !https_port"]) {
        const at = lines.indexOf(rule);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at).toBeLessThan(firstAllow);
      }
      expect(lines.at(-1)).toBe("http_access deny all");
      expect(directives(conf(zone))).toContain("acl https_port port 443");
    });

    test(`${zone}: no cache, logs to stdout, no pid file, no client addresses upstream`, () => {
      const lines = directives(conf(zone));
      for (const d of [
        "http_port 3128",
        `visible_hostname hapi-egress-${zone}`,
        "pid_filename none",
        "cache deny all",
        "access_log stdio:/dev/stdout",
        "cache_log /dev/stdout",
        "forwarded_for delete",
        "httpd_suppress_version_string on",
      ]) {
        expect(lines).toContain(d);
      }
    });
  }
});

test("allowlisted zones refuse IP-literal destinations before the allow, so no reverse lookup can match", () => {
  for (const zone of ["hermes", "archon"] as const) {
    const lines = directives(conf(zone));
    expect(lines).toContain("http_access deny ip_literal");
    expect(lines.indexOf("http_access deny ip_literal")).toBeLessThan(lines.indexOf("http_access allow CONNECT allowed"));
  }
});

test("hermes allowlist covers its tiers, GitHub and Slack; a subdomain of a listed domain is folded into it", () => {
  // api.github.com is covered by .github.com, and Squid warns when both are listed.
  expect(allowed(conf("hermes"))).toEqual([
    ".api.anthropic.com",
    ".context7.com",
    ".deepwiki.com",
    ".files.pythonhosted.org",
    ".github.com",
    ".openrouter.ai",
    ".pypi.org",
    ".registry.npmjs.org",
    ".slack.com",
  ]);
});

describe("the archon zone has no forge route", () => {
  test("the policy's archon allowlist holds no forge host", () => {
    expect(zoneHosts(p, "archon").filter((h) => forgeDomain(h) !== undefined)).toEqual([]);
  });

  test("emitEgress refuses a policy built in code that puts a forge host in the archon zone", () => {
    expect(() => emitEgress(withArchonHosts(["api.anthropic.com", "raw.githubusercontent.com"]))).toThrow(
      /"raw\.githubusercontent\.com" is a forge host \(githubusercontent\.com\)/,
    );
    const viaTier = structuredClone(p);
    viaTier.trustedSources.tiers.T1.hosts.push("gitlab.com");
    expect(() => emitEgress(viaTier)).toThrow(/"gitlab\.com" is a forge host/);
  });

  test("the hermes zone may reach the forge", () => {
    expect(allowed(conf("hermes"))).toContain(".github.com");
  });
});

test("only the research zone may reach the open web", () => {
  const q = structuredClone(p);
  q.trustedSources.zones.hermes.openWeb = true;
  expect(() => emitEgress(q)).toThrow(/openWeb.*hermes/);
});

test("an overlay's egress_extra host reaches the archon proxy", () => {
  expect(allowed(conf("archon", applyOverlay(p, { egress_extra: ["docs.example.org"] })))).toContain(".docs.example.org");
});

test("an empty allowlist refuses everything and names no undefined ACL", () => {
  const q = withArchonHosts([]);
  q.trustedSources.zones.archon.tiers = ["T0"];
  const lines = directives(conf("archon", q));
  expect(lines.filter((l) => l.includes(" allowed"))).toEqual([]); // Squid refuses a config naming an undefined ACL
  expect(lines.filter((l) => l.startsWith("http_access allow"))).toEqual([]);
  expect(lines.at(-1)).toBe("http_access deny all");
});

test("emitEgress is deterministic", () => {
  expect(emitEgress(p)).toEqual(emitEgress(loadPolicy("policy")));
});
