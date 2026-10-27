import { describe, expect, test } from "bun:test";
import { emitEgress } from "../../src/generate/egress";
import { forgeDomain } from "../../src/policy/hosts";
import { cidrContains } from "../../src/stack/cidr";
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
/** The allowlist's dstdomain values, without the -n flag. */
const allowed = (text: string) =>
  directives(text)
    .filter((l) => l.startsWith("acl allowed dstdomain "))
    .map((l) => l.split(" ").at(-1)!);
/** The to_localnet ranges. */
const toLocalnet = (text: string) => directives(text).find((l) => l.startsWith("acl to_localnet dst "))!.split(" ").slice(3);
/**
 * The ip_literal ACL's regular expressions. Squid's are POSIX extended; these
 * patterns mean the same in JavaScript.
 */
function ipLiteral(text: string): RegExp[] {
  const words = directives(text).find((l) => l.startsWith("acl ip_literal "))!.split(" ");
  expect(words.slice(0, 4)).toEqual(["acl", "ip_literal", "dstdom_regex", "-n"]); // -n: never a DNS lookup
  return words.slice(4).map((r) => new RegExp(r));
}
/** Squid's dstdomain match, by name only (-n): ".example.com" is that domain or a subdomain. */
const dstdomainMatches = (value: string, host: string) => host === value.slice(1) || host.endsWith(value);
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
  // -n: match by name only, never by a reverse lookup of an IP address (see the IP-literal tests).
  expect(c).toContain("acl allowed dstdomain -n .api.anthropic.com");
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
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16", "100.64.0.0/10", "::/96", "fc00::/7", "fe80::/10"]) {
    expect(toLocalnet(c)).toContain(range);
  }
  expect(c).not.toContain("dstdomain");
  expect(lines).toContain("http_access allow CONNECT");
  expect(lines).toContain("http_access allow http_proto port_80");
  expect(c.trim().endsWith("http_access deny all")).toBe(true);
});

test("research zone's plain HTTP is the http scheme on port 80, so ftp://host:80/ is refused", () => {
  const lines = directives(conf("research"));
  expect(lines).toContain("acl port_80 port 80");
  expect(lines).toContain("acl http_proto proto HTTP");
  // The only allows: HTTPS tunnels (CONNECT is limited to 443 above) and http:// URLs on port 80.
  expect(lines.filter((l) => l.startsWith("http_access allow"))).toEqual(["http_access allow CONNECT", "http_access allow http_proto port_80"]);
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

    test(`${zone}: refuses the unspecified address and the NAT64 prefixes, whatever a name resolves to`, () => {
      const ranges = toLocalnet(conf(zone));
      // On Linux, connecting to :: reaches the local host. A NAT64 translator maps its
      // prefixes onto IPv4 addresses, private ones included. ::/96 holds :: and ::1.
      for (const range of ["::/96", "64:ff9b::/96", "64:ff9b:1::/48", "fc00::/7", "fe80::/10", "ff00::/8"]) expect(ranges).toContain(range);
      for (const address of ["::", "::1", "::10.9.9.9"]) expect(ranges.some((r) => cidrContains(r, address))).toBe(true);
    });

    test(`${zone}: refuses the IPv6 ranges that embed or reach an IPv4 or internal address (the Task 5 decision)`, () => {
      // ::/96 IPv4-compatible (::a.b.c.d), 2002::/16 6to4 (2002:AABB:CCDD::, a relay reaches a.b.c.d),
      // 2001::/32 Teredo (an obfuscated IPv4 server and client), 100::/64 discard-only, fec0::/10
      // site-local (deprecated, internal). No public host is reached at any of them.
      const ranges = toLocalnet(conf(zone));
      for (const range of ["::/96", "2002::/16", "2001::/32", "100::/64", "fec0::/10"]) expect(ranges).toContain(range);
      // 2001::/32 is Teredo only: the documentation prefix 2001:db8::/32 and other 2001: space stay outside it.
      expect(cidrContains("2001::/32", "2001:db8::1")).toBe(false);
      expect(cidrContains("2001::/32", "2001:0:4136:e378::1")).toBe(true);
    });

    test(`${zone}: no to_localnet range is covered by another, so squid -k parse stays clean`, () => {
      // Squid ignores an entry another entry covers, with a warning ("Ignoring ::1 because it is
      // already covered by ::/96"), which is why ::/128 and ::1 are not listed beside ::/96.
      const ranges = toLocalnet(conf(zone));
      const covered = ranges.flatMap((a) => ranges.filter((b) => a !== b && cidrContains(b, a)).map((b) => `${a} in ${b}`));
      expect(covered).toEqual([]);
    });

    test(`${zone}: IPv4-mapped addresses are covered by the IPv4 ranges, never by an ::ffff:0:0/96 entry`, () => {
      // Squid holds every IPv4 address in its IPv4-mapped form (::ffff:a.b.c.d), so 10.0.0.0/8
      // already covers ::ffff:10.0.0.0/104. An ::ffff:0:0/96 entry would match every IPv4
      // address and refuse all IPv4 egress (checked with Squid 7.6).
      const ranges = toLocalnet(conf(zone));
      expect(ranges.filter((r) => r.startsWith("::ffff:"))).toEqual([]);
      for (const range of ["0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]) expect(ranges).toContain(range);
    });

    test(`${zone}: says why refusing the NAT64 prefixes costs IPv4-only sites behind DNS64`, () => {
      // DNS64 synthesises 64:ff9b::/96 addresses for IPv4-only sites, which to_localnet refuses.
      expect(conf(zone)).toMatch(/DNS64/);
    });

    test(`${zone}: no cache, logs to stdout, no pid file, no pinger, no client addresses upstream`, () => {
      const lines = directives(conf(zone));
      for (const d of [
        "http_port 3128",
        `visible_hostname hapi-egress-${zone}`,
        "pid_filename none",
        "pinger_enable off",
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

describe("no zone lets an IP-literal destination through, the research zone included (ruling R1)", () => {
  // Each address as a client writes it, and as Squid 7.6 rewrites it for its ACLs:
  // [::ffff:1.2.3.4] becomes 1.2.3.4, and 0x7f.1, 2130706433 and 127.1 become 127.0.0.1.
  const LITERALS = ["1.2.3.4", "[2001:db8::1]", "2001:db8::1", "[::ffff:1.2.3.4]", "::ffff:1.2.3.4", "[64:ff9b::102:304]", "[::]", "0.0.0.0", "127.0.0.1", "[2606:4700::1111]"];
  test("research: ip_literal refuses every literal form before either allow, public addresses included", () => {
    const c = conf("research");
    const lines = directives(c).filter((l) => l.startsWith("http_access "));
    const firstAllow = lines.findIndex((l) => l.startsWith("http_access allow"));
    expect(lines.indexOf("http_access deny ip_literal")).toBeGreaterThan(-1);
    expect(lines.indexOf("http_access deny ip_literal")).toBeLessThan(firstAllow);
    const patterns = ipLiteral(c);
    for (const host of LITERALS) expect({ host, refused: patterns.some((r) => r.test(host)) }).toEqual({ host, refused: true });
    for (const host of ["example.com", "cafe.de", "bad.cafe", "1password.com", "123.example.org"]) {
      expect({ host, refused: patterns.some((r) => r.test(host)) }).toEqual({ host, refused: false });
    }
    // The same ACL, word for word, as the allowlisted zones'.
    expect(directives(c).find((l) => l.startsWith("acl ip_literal "))).toBe(directives(conf("archon")).find((l) => l.startsWith("acl ip_literal ")));
  });

  for (const zone of ["hermes", "archon"] as const) {
    test(`${zone}: the allowlist matches by name only, and ip_literal refuses 1.2.3.4, [2001:db8::1] and ::ffff:1.2.3.4 before it`, () => {
      const c = conf(zone);
      const lines = directives(c);
      // Every allowlist line has -n: no reverse lookup, whose answer the address's owner controls.
      const acls = lines.filter((l) => l.startsWith("acl allowed "));
      expect(acls.length).toBeGreaterThan(0);
      for (const l of acls) expect(l).toMatch(/^acl allowed dstdomain -n \.[a-z0-9.-]+$/);
      expect(lines.indexOf("http_access deny ip_literal")).toBeGreaterThan(-1);
      expect(lines.indexOf("http_access deny ip_literal")).toBeLessThan(lines.indexOf("http_access allow CONNECT allowed"));
      const patterns = ipLiteral(c);
      for (const host of LITERALS) {
        expect({ host, refused: patterns.some((r) => r.test(host)) }).toEqual({ host, refused: true });
        // And no allowlist entry could match it by name anyway.
        expect(allowed(c).filter((d) => dstdomainMatches(d, host))).toEqual([]);
      }
    });

    test(`${zone}: ip_literal never refuses a host name, even one spelled only with hex digits`, () => {
      const patterns = ipLiteral(conf(zone));
      for (const host of [...zoneHosts(p, zone), "cafe.de", "bad.cafe", "dead.beef.ad", "1password.com", "123.example.org"]) {
        expect({ host, refused: patterns.some((r) => r.test(host)) }).toEqual({ host, refused: false });
      }
    });
  }
});

test("hermes allowlist covers its tiers, GitHub and Slack; a subdomain of a listed domain is folded into it", () => {
  // api.github.com is covered by .github.com, and Squid warns when both are listed. No T2 hosts
  // (context7.com, deepwiki.com): the hermes zone lists T0-T1 only (spec §10.1).
  expect(allowed(conf("hermes"))).toEqual([
    ".api.anthropic.com",
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

describe("every host is checked before it reaches squid.conf (a policy built in code skips the schema)", () => {
  const BAD = [
    "api.anthropic.com\nhttp_access allow all",
    "pypi.org\r\nacl x src all",
    "api.anthropic.com http_access allow all",
    "1.2.3.4",
    "[2001:db8::1]",
    ".pypi.org",
    "pypi.org:443",
    "",
  ];

  test("a host that is not a plain domain name is refused in the archon and hermes zones", () => {
    for (const bad of BAD) {
      expect(() => emitEgress(withArchonHosts(["api.anthropic.com", bad]))).toThrow(
        `archon zone: ${JSON.stringify(bad)} is not a plain domain name`,
      );
      const q = structuredClone(p);
      q.trustedSources.zones.hermes.hosts.push(bad);
      expect(() => emitEgress(q)).toThrow(`hermes zone: ${JSON.stringify(bad)} is not a plain domain name`);
    }
  });

  test("a tier's hosts are checked too, and so is a host that isn't a string", () => {
    const q = structuredClone(p);
    q.trustedSources.tiers.T1.hosts.push("pypi.org\nhttp_access allow all");
    expect(() => emitEgress(q)).toThrow(/is not a plain domain name/);
    const r = structuredClone(p);
    (r.trustedSources.zones.archon.hosts as unknown[]).push(42);
    expect(() => emitEgress(r)).toThrow("archon zone: 42 is not a plain domain name");
  });

  test("an unknown source tier is refused before its name reaches a comment", () => {
    const q = structuredClone(p);
    (q.trustedSources.zones.archon.tiers as string[]).push("T1\nhttp_access allow all");
    expect(() => emitEgress(q)).toThrow(`archon zone: unknown source tier ${JSON.stringify("T1\nhttp_access allow all")}`);
  });

  test("hosts are lowercased first, so a mixed-case host is emitted once, as Squid would match it", () => {
    const q = structuredClone(p);
    q.trustedSources.zones.hermes.hosts.push("Slack.COM", "Docs.Example.ORG");
    expect(allowed(conf("hermes", q))).toEqual([...allowed(conf("hermes")), ".docs.example.org"].sort());
  });

  test("a mixed-case forge host in the archon zone is refused", () => {
    expect(() => emitEgress(withArchonHosts(["api.anthropic.com", "GitHub.com"]))).toThrow(/"GitHub\.com" is a forge host \(github\.com\)/);
    const viaTier = structuredClone(p);
    viaTier.trustedSources.tiers.T1.hosts.push("Raw.GitHubUserContent.com");
    expect(() => emitEgress(viaTier)).toThrow(/"Raw\.GitHubUserContent\.com" is a forge host \(githubusercontent\.com\)/);
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
