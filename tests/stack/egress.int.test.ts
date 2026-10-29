/**
 * HAPI_INT=1 only (`mise run test:int`): the stack's network boundary, on a
 * real Docker and real Squid, in a throwaway Compose project of
 * stack/compose.yaml (`hapi-int-<random>`), removed afterwards with its
 * networks and volumes (`docker compose down -v`).
 *
 * No real secret is used. The zone env files are written by hapi's own
 * resolver (`resolveSecrets`) from a fake provider into a temp
 * XDG_RUNTIME_DIR; then the test appends lines to them that try to override
 * hapi's own settings (HERMES_HOME, HTTPS_PROXY, ...), which compose's
 * `environment:` must win against. The test's override (a second compose
 * file) adds only `extra_hosts` on the proxies, which plant names that resolve
 * to private, NAT64, public and other addresses, so the DNS-rebinding checks
 * need no DNS server, blanks Hermes's Slack tokens so the gateway calls nobody,
 * and gives the built images project-named tags.
 *
 * Nothing a running stack uses is touched, so this may run beside `mise run
 * up`'s `hapi` project: the configs are generated into the project's own
 * build dir, which its own copy of stack/ mounts (tests/stack/helpers.ts), and
 * afterAll checks that the checkout's build/ was not written to.
 *
 * External network: the tests whose names say "(internet)" need this host to
 * reach api.anthropic.com, github.com, example.com and 1.1.1.1, and Hermes's
 * image is built on first run. (Archon is a run template, not a service: its
 * run containers are the run integration test's.) Offline, those tests are
 * skipped, with a warning;
 * every refusal is decided by the proxy before it connects anywhere, so those
 * run offline.
 *
 * What each test proves is in docs/runbooks/stack.md#what-the-tests-prove.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAll } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { loadManifest, type Manifest } from "../../src/secrets/manifest";
import { resolveSecrets, type SecretProvider } from "../../src/secrets/provider";
import { cidrContains } from "../../src/stack/cidr";
import { CLIENT_RANGES } from "../../src/generate/egress";
import { serviceEnvironment } from "../../src/stack/env";
import { composeFile, must, online, Project, REPO, treeSnapshot } from "./helpers";

const INT = Boolean(process.env.HAPI_INT);
const ONLINE = INT ? await online() : false;
if (INT && !ONLINE) console.warn("egress.int.test.ts: this host is offline, so the tests marked (internet) and the zone services are skipped");

/** A value with a newline, `$`, `#`, spaces, a backslash and a double quote: it must reach the container byte for byte (H-019). */
const PROBE = 'line one $HOME ${HOME} #not-a-comment\n  two "quoted" \\back slash\t';

/** A fake provider: every logical name gets `fake-<name>-value`; the probe gets PROBE. Never a real secret. */
const fakeProvider: SecretProvider = {
  name: "env-file",
  downgrade: false,
  fetch: async (names) => new Map(names.map((n) => [n, n === "hapi-int-probe" ? PROBE : `fake-${n}-value`])),
  list: async () => [],
};

/** Names the proxies resolve from their own /etc/hosts (the override's extra_hosts). */
const PLANTED = {
  allowlisted: ["pypi.org=10.9.9.9", "registry.npmjs.org=64:ff9b::a09:909", "files.pythonhosted.org=::1", "openrouter.ai=2002:a09:909::1"],
  research: [
    "rebind.hapi.test=10.9.9.9",
    "zero.hapi.test=::",
    "mapped.hapi.test=::ffff:10.9.9.9",
    "nat64.hapi.test=64:ff9b::a09:909",
    "sixtofour.hapi.test=2002:a09:909::1",
    "teredo.hapi.test=2001::a09:909",
    "compat.hapi.test=::10.9.9.9",
    "metadata.hapi.test=169.254.169.254",
    "loopback.hapi.test=127.0.0.1",
    "discard.hapi.test=100::1",
    "sitelocal.hapi.test=fec0::1",
    // The controls: public addresses no range covers.
    "public4.hapi.test=1.1.1.1",
    "public6.hapi.test=2606:4700::1111",
  ],
};

/**
 * Lines appended to each zone's env file after resolve wrote it: values that would undo the hardening if an
 * env file could override compose's `environment:` (the manifest loader refuses these names, so only a hand
 * edit of the file could put them there).
 */
const OVERRIDES: Record<"hermes", Record<string, string>> = {
  hermes: { HERMES_HOME: "/tmp/elsewhere", HTTPS_PROXY: "http://203.0.113.9:3128", NO_PROXY: "*" },
};

describe.skipIf(!INT)("the stack's egress boundary (throwaway compose project)", () => {
  const blank = { SLACK_BOT_TOKEN: "", SLACK_APP_TOKEN: "", SLACK_ALLOWED_USERS: "" };
  // Made in beforeAll, so a skipped run (the unit suite) creates nothing.
  let p: Project;
  // The checkout's own build/, which a running stack bind-mounts: the test must never write there.
  let liveBuild: Record<string, string>;

  beforeAll(async () => {
    liveBuild = treeSnapshot(join(REPO, "build"));
    p = new Project({
      services: {
        "egress-hermes": { extra_hosts: PLANTED.allowlisted },
        "egress-archon": { extra_hosts: PLANTED.allowlisted },
        "egress-research": { extra_hosts: PLANTED.research },
        hermes: { environment: blank },
      },
    });
    // As `mise run up` does: the generated configs (into the project's own build dir), then the zone env files, then the stack.
    await buildAll(loadPolicy(join(REPO, "policy")), p.build);
    const manifest: Manifest = loadManifest(join(REPO, "stack", "secrets.yaml"));
    manifest.hermes = { ...manifest.hermes, HAPI_INT_PROBE: "hapi-int-probe" };
    await resolveSecrets(manifest, fakeProvider, { outDir: join(p.xdg, "hapi") });
    for (const [zone, lines] of Object.entries(OVERRIDES)) {
      appendFileSync(join(p.xdg, "hapi", "env", `${zone}.env`), Object.entries(lines).map(([k, v]) => `${k}='${v}'\n`).join(""));
    }
    await p.mustCompose(["up", "-d", "--wait", "--wait-timeout", "120", "egress-hermes", "egress-archon", "egress-research"]);
  }, 600_000);

  /**
   * Each `ro` mount point of `service` is mounted read-only and each `rw` one read-write (the control: the flags
   * are read, not assumed), from the kernel's own mount table. Then the behaviour: a write to `probe` (by default
   * a new file in /) fails with EROFS. A write as the service's non-root user fails with EACCES anyway on a
   * root-owned or foreign file, so only "Read-only file system" proves the read-only mount (H-146(c)).
   */
  const expectMounts = async (service: string, want: { ro: string[]; rw: string[] }, probe = "/hapi-ro-probe") => {
    const mounts = await p.mounts(service);
    const flag = (point: string) => mounts.get(point)?.[0] ?? "not mounted";
    for (const point of want.ro) expect([service, point, flag(point)]).toEqual([service, point, "ro"]);
    for (const point of want.rw) expect([service, point, flag(point)]).toEqual([service, point, "rw"]);
    const w = await p.exec(service, ["sh", "-c", 'echo x > "$1"', "sh", probe]);
    expect([service, probe, w.code === 0, /Read-only file system/.test(w.stderr)]).toEqual([service, probe, false, true]);
  };

  /**
   * Who is on each network, by service name (`<project>-<service>-1` without the project and index), leaving
   * out the containers the test itself started (the curl clients, the PTR test's proxies).
   */
  const members = async (): Promise<Record<string, string[]>> => {
    const testMade = new Set((await must(["docker", "ps", "-a", "--filter", `label=org.hapi.int=${p.name}`, "--format", "{{.Names}}"])).split("\n").filter(Boolean));
    const out: Record<string, string[]> = {};
    for (const net of ["hermes-net", "archon-net", "research-net", "outbound"]) {
      const [info] = JSON.parse(await must(["docker", "network", "inspect", p.network(net)]));
      out[net] = Object.values((info.Containers ?? {}) as Record<string, { Name: string }>)
        .map((c) => c.Name)
        .filter((n) => !testMade.has(n))
        .map((n) => n.replace(`${p.name}-`, "").replace(/-\d+$/, ""))
        .sort();
    }
    return out;
  };

  afterAll(async () => {
    if (p === undefined) return;
    await p.down();
    // Nothing of the throwaway project is left behind...
    expect(await p.leftovers()).toEqual([]);
    // ...and nothing outside it was touched: the checkout's build/ is as it was, inode for inode.
    expect(treeSnapshot(join(REPO, "build"))).toEqual(liveBuild);
  }, 300_000);

  describe("the networks", () => {
    test("the zone networks are internal and private, inside the proxies' zone_clients ranges; only the proxies join outbound", async () => {
      for (const net of ["hermes-net", "archon-net", "research-net"]) {
        const [info] = JSON.parse(await must(["docker", "network", "inspect", p.network(net)]));
        expect([net, info.Internal]).toEqual([net, true]);
        const subnets: string[] = info.IPAM.Config.map((c: { Subnet: string }) => c.Subnet);
        expect(subnets.length).toBeGreaterThan(0);
        for (const s of subnets) expect([net, s, CLIENT_RANGES.some((r) => cidrContains(r, s))]).toEqual([net, s, true]);
      }
      const [outbound] = JSON.parse(await must(["docker", "network", "inspect", p.network("outbound")]));
      expect(outbound.Internal).toBe(false);
      // Only the proxies so far; the same check runs again once hermes and archon are up (the zone services, below).
      expect(await members()).toEqual({
        "hermes-net": ["egress-hermes"],
        "archon-net": ["egress-archon"],
        "research-net": ["egress-research"],
        outbound: ["egress-archon", "egress-hermes", "egress-research"],
      });
    });

    test("each proxy runs non-root, with no capabilities and a read-only root filesystem and config", async () => {
      for (const zone of ["hermes", "archon", "research"]) {
        const service = `egress-${zone}`;
        const status = (await p.exec(service, ["cat", "/proc/1/status"])).stdout;
        expect([service, /^Uid:\s+(\d+)/m.exec(status)?.[1]]).not.toEqual([service, "0"]);
        expect([service, /^CapEff:\s+(\w+)/m.exec(status)?.[1]]).toEqual([service, "0000000000000000"]);
        expect([service, /^NoNewPrivs:\s+(\d)/m.exec(status)?.[1]]).toEqual([service, "1"]);
        await expectMounts(service, { ro: ["/", "/etc/squid/hapi.conf"], rw: ["/tmp", "/var/spool/squid", "/var/log/squid"] });
      }
    });
  });

  for (const zone of ["archon", "hermes"] as const) {
    describe(`the ${zone} zone (an allowlist)`, () => {
      test.skipIf(!ONLINE)(`egress: allowed host via proxy succeeds (${zone}; internet), in any case: api.anthropic.com, API.Anthropic.COM`, async () => {
        for (const url of ["https://api.anthropic.com/", "https://API.Anthropic.COM/"]) {
          const r = await p.via(zone, url);
          expect([url, r.status]).toEqual([url, 200]);
          expect([url, r.origin >= 200 && r.origin < 500]).toEqual([url, true]);
        }
      });

      test(`egress: disallowed host via proxy is denied (${zone})`, async () => {
        const off = zone === "archon" ? "https://github.com/" : "https://example.com/";
        expect((await p.via(zone, off)).status).toBe(403);
      });

      test("every IP-literal destination is refused, whatever its reverse DNS: v4, v6, bracketed, mapped, NAT64, numeric", async () => {
        const proxy = `egress-${zone}:3128`;
        for (const host of ["203.0.113.7", "1.2.3.4", "[2001:db8::1]", "[::ffff:1.2.3.4]", "[::ffff:203.0.113.7]", "[::]", "[::1]", "[64:ff9b::1.2.3.4]", "2130706433"]) {
          expect([host, await p.raw(`${zone}-net`, proxy, `CONNECT ${host}:443`)]).toEqual([host, 403]);
        }
      });

      test("an allowed name that resolves to a private, loopback, NAT64 or 6to4 address is refused by to_localnet", async () => {
        for (const url of ["https://pypi.org/", "https://registry.npmjs.org/", "https://files.pythonhosted.org/", "https://openrouter.ai/"]) {
          expect([url, (await p.via(zone, url)).status]).toEqual([url, 403]);
        }
      });

      test("plain http:// and any port but 443 are refused, for an allowed host too", async () => {
        expect((await p.via(zone, "http://api.anthropic.com/")).status).toBe(403);
        expect((await p.via(zone, "https://api.anthropic.com:8443/")).status).toBe(403);
      });
    });
  }

  test.skipIf(!ONLINE)("(internet) the hermes zone reaches the forge; the archon zone never does", async () => {
    expect((await p.via("hermes", "https://github.com/")).status).toBe(200);
    expect((await p.via("archon", "https://github.com/")).status).toBe(403);
    expect((await p.via("archon", "https://api.github.com/")).status).toBe(403);
  });

  test("PTR bypass: an IP literal whose reverse DNS is an allowed host is refused; a proxy without -n and ip_literal (the control) lets it through", async () => {
    // Two throwaway proxies on archon-net, each with 203.0.113.7 <-> api.anthropic.com in /etc/hosts, which Squid
    // uses for reverse lookups too: the real archon config, and the control with both defences removed.
    const squidImage = String(composeFile().services["egress-archon"]!.image);
    const real = readFileSync(join(p.build, "egress", "archon.squid.conf"), "utf8");
    const weak = real.replaceAll("dstdomain -n ", "dstdomain ").replace("http_access deny ip_literal\n", "");
    expect(weak).not.toBe(real);
    const proxies: Record<string, string> = {};
    for (const [kind, text] of Object.entries({ real, weak })) {
      const file = join(p.root, `${kind}.squid.conf`);
      await Bun.write(file, text);
      proxies[kind] = await p.start(`ptr-${kind}`, [
        "--network", p.network("archon-net"), "--add-host", "api.anthropic.com:203.0.113.7",
        "--user", "584792:584792", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "-v", `${file}:/etc/squid/hapi.conf:ro`, "--entrypoint", "/usr/sbin/squid-gnutls", squidImage, "-N", "-f", "/etc/squid/hapi.conf",
      ]);
    }
    const ask = async (name: string) => {
      for (let i = 0; i < 40; i++) {
        const status = await p.raw("archon-net", `${name}:3128`, "CONNECT 203.0.113.7:443");
        if (status !== 0) return status;
        await Bun.sleep(250);
      }
      return 0;
    };
    // The control tunnels it (503: it tried, and archon-net has no route out), so the planted PTR works...
    expect(await ask(proxies.weak!)).toBe(503);
    // ...and the real config refuses it before any connection.
    expect(await ask(proxies.real!)).toBe(403);
  }, 120_000);

  describe("the research zone (the open web, minus private ranges)", () => {
    const proxy = "egress-research:3128";
    test.skipIf(!ONLINE)("(internet) a public host works: HTTPS, and GET http://example.com/", async () => {
      expect((await p.via("research", "https://example.com/")).status).toBe(200);
      const r = await p.via("research", "http://example.com/");
      expect(r.status).toBeGreaterThanOrEqual(200);
      expect(r.status).toBeLessThan(400);
    });

    test("every IP-literal destination is refused here too, public or private: v4, v6, bracketed, mapped, NAT64, numeric (ruling R1)", async () => {
      expect((await p.via("research", "http://169.254.169.254/latest/meta-data/")).status).toBe(403);
      expect((await p.via("research", "http://1.1.1.1/")).status).toBe(403);
      for (const host of [
        // Public: refused by ip_literal alone, since no range covers them.
        "1.1.1.1", "203.0.113.7", "2130706433", "[2606:4700::1111]", "[::ffff:1.1.1.1]",
        // Private and the other special ranges.
        "10.0.0.1", "127.0.0.1", "[::]", "[::1]", "[::ffff:10.0.0.1]", "[64:ff9b::a00:1]", "[::10.9.9.9]", "[2002:a09:909::1]", "[2001::a09:909]", "[100::1]", "[fec0::1]",
      ]) {
        expect([host, await p.raw("research-net", proxy, `CONNECT ${host}:443`)]).toEqual([host, 403]);
      }
      for (const host of ["1.1.1.1", "[2606:4700::1111]"]) expect([host, await p.raw("research-net", proxy, `GET http://${host}/`)]).toEqual([host, 403]);
    });

    test("DNS rebinding (static): a name that resolves to a private, unspecified, mapped, NAT64, 6to4, Teredo, IPv4-compatible, metadata, loopback, discard-only or site-local address is refused by to_localnet", async () => {
      for (const name of ["rebind", "zero", "mapped", "nat64", "sixtofour", "teredo", "compat", "metadata", "loopback", "discard", "sitelocal"]) {
        const host = `${name}.hapi.test`;
        expect([host, await p.raw("research-net", proxy, `CONNECT ${host}:443`)]).toEqual([host, 403]);
        expect([host, await p.raw("research-net", proxy, `GET http://${host}/`)]).toEqual([host, 403]);
      }
    });

    test("a public name that resolves to an address no range covers is not refused (the control: the ranges and ip_literal refuse, nothing else)", async () => {
      // 1.1.1.1 and 2606:4700::1111 are public. The proxy tries each (200 with a route, 503 without one), never 403.
      for (const host of ["public4.hapi.test", "public6.hapi.test"]) {
        const status = await p.raw("research-net", proxy, `CONNECT ${host}:443`);
        expect([host, status, status === 403]).toEqual([host, status, false]);
      }
    });

    test("only http:// on port 80: ftp://host:80/, https://host:80/ as a GET, and port 8080 are refused", async () => {
      for (const line of ["GET ftp://example.com:80/", "GET https://example.com:80/", "GET http://example.com:8080/", "CONNECT example.com:8443"]) {
        expect([line, await p.raw("research-net", proxy, line)]).toEqual([line, 403]);
      }
    });
  });

  describe("no way around the proxy", () => {
    test("a direct connection from a zone network fails, by name (no DNS: curl exit 6) and by address (no route: exit 7), with the proxy up", async () => {
      // --max-time 15: the curl image's resolver (musl) retries a SERVFAIL for 5 s before curl reports exit 6, so a
      // 5 s limit would end in exit 28 (timed out), which proves nothing about DNS.
      for (const zone of ["archon", "hermes", "research"]) {
        for (const [url, exit] of [["https://api.anthropic.com/", 6], ["http://1.1.1.1/", 7]] as const) {
          const r = await p.curl(`${zone}-net`, url, undefined, ["--max-time", "15"]);
          expect([zone, url, r.exit, r.status]).toEqual([zone, url, exit, 0]);
        }
      }
    }, 120_000);

    test("no DNS out: a zone network's resolver answers the stack's own names, and no name outside it", async () => {
      for (const zone of ["archon", "hermes", "research"] as const) {
        // The control: Docker's embedded resolver works on this network, for the zone's own proxy...
        const own = await p.inClient(`${zone}-net`, ["nslookup", `egress-${zone}`]);
        expect([zone, own.code, /Address: \d+\.\d+\.\d+\.\d+/.test(own.stdout)]).toEqual([zone, 0, true]);
        // ...and refuses every outside name (SERVFAIL), so DNS is no channel out of an internal network.
        for (const name of ["example.com", "api.anthropic.com"]) {
          const r = await p.inClient(`${zone}-net`, ["nslookup", "-type=a", name]);
          expect([zone, name, r.code === 0, /SERVFAIL|NXDOMAIN|REFUSED/.test(r.stdout + r.stderr)]).toEqual([zone, name, false, true]);
        }
      }
    }, 120_000);

    test.skipIf(!ONLINE)("(internet) the DNS control: the same outside names resolve from a non-internal network", async () => {
      for (const name of ["example.com", "api.anthropic.com"]) {
        const r = await p.inClient("outbound", ["nslookup", "-type=a", name]);
        expect([name, r.code]).toEqual([name, 0]);
      }
    });

    test.skipIf(!ONLINE)("(internet) the control: the same address is reachable from a non-internal network", async () => {
      const r = await p.curl("outbound", "http://1.1.1.1/", undefined, ["--max-time", "10"]);
      expect(r.status).toBeGreaterThan(0);
    });

    test("egress: direct connection is blocked even when proxy is stopped", async () => {
      await p.mustCompose(["stop", "egress-archon"]);
      try {
        expect((await p.via("archon", "https://api.anthropic.com/", ["--max-time", "5"])).status).toBe(0);
        for (const [url, exit] of [["https://api.anthropic.com/", 6], ["http://1.1.1.1/", 7], ["http://[2606:4700:4700::1111]/", 7]] as const) {
          const r = await p.curl("archon-net", url, undefined, ["--max-time", "15"]);
          expect([url, r.exit, r.status]).toEqual([url, exit, 0]);
        }
      } finally {
        await p.mustCompose(["up", "-d", "--wait", "--wait-timeout", "60", "egress-archon"]);
      }
      expect((await p.via("archon", "https://github.com/")).status).toBe(403);
    }, 120_000);
  });

  // archon is the run template, not a service: its run containers are checked by the run integration test (Plan 02 Task 8).
  describe.skipIf(!ONLINE)("(internet) the hermes zone service, hardened, with fake secrets", () => {
    beforeAll(async () => {
      await p.mustCompose(["build", "hermes"], 900_000);
      await p.mustCompose(["up", "-d", "--wait", "--wait-timeout", "240", "hermes"], 600_000);
    }, 1_200_000);

    test("with hermes up, only the proxies join outbound, and hermes is on its own zone network only", async () => {
      expect(await members()).toEqual({
        "hermes-net": ["egress-hermes", "hermes"],
        "archon-net": ["egress-archon"],
        "research-net": ["egress-research"],
        outbound: ["egress-archon", "egress-hermes", "egress-research"],
      });
      for (const service of ["hermes"] as const) {
        const id = (await p.mustCompose(["ps", "-q", service])).trim();
        const nets = Object.keys(JSON.parse(await must(["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id])));
        expect([service, nets]).toEqual([service, [p.network(`${service}-net`)]]);
      }
    });

    test("a zone's env file can't override hapi's own settings: compose's environment: wins, though the file says otherwise", async () => {
      for (const service of ["hermes"] as const) {
        // The control: the env file the container read does hold the overriding lines.
        const file = readFileSync(join(p.xdg, "hapi", "env", `${service}.env`), "utf8");
        for (const [k, v] of Object.entries(OVERRIDES[service])) expect(file).toContain(`${k}='${v}'\n`);
        const env = new Map(
          (await p.exec(service, ["env"])).stdout
            .split("\n")
            .filter((l) => l.includes("="))
            .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const),
        );
        for (const [k, v] of Object.entries(serviceEnvironment(service))) expect([service, k, env.get(k)]).toEqual([service, k, v]);
      }
    });

    test("hermes listens on loopback only: nothing on hermes's network address answers", async () => {
      const listening = (await p.exec("hermes", ["sh", "-c", "cat /proc/net/tcp /proc/net/tcp6"])).stdout
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((f) => f[3] === "0A")
        .map((f) => f[1]!.split(":")[0]!);
      expect(listening.length).toBeGreaterThan(0);
      // /proc/net/tcp writes IPv4 little-endian, so 127.x.x.x ends in 7F (0100007F is 127.0.0.1, and 0B00007F is
      // 127.0.0.11, Docker's embedded DNS); the IPv6 loopback ::1 is 00000000000000000000000001000000.
      const loopback = (a: string) => (a.length === 8 && a.endsWith("7F")) || a === "00000000000000000000000001000000";
      expect(listening.filter((a) => !loopback(a))).toEqual([]);
      expect(listening).toContain("0100007F");
    });

    test("hermes runs as its image's non-root user, with no capabilities, no new privileges and a read-only root", async () => {
      for (const [service, uid] of [["hermes", "10000"]] as const) {
        const status = (await p.exec(service, ["cat", "/proc/1/status"])).stdout;
        expect([service, /^Uid:\s+(\d+)/m.exec(status)?.[1]]).toEqual([service, uid]);
        expect([service, /^CapEff:\s+(\w+)/m.exec(status)?.[1]]).toEqual([service, "0000000000000000"]);
        expect([service, /^NoNewPrivs:\s+(\d)/m.exec(status)?.[1]]).toEqual([service, "1"]);
      }
      await expectMounts("hermes", { ro: ["/", "/opt/data/config.yaml"], rw: ["/tmp", "/run", "/opt/data"] });
    });

    test("hermes sees only its own zone's secrets, never host.env, and its own proxy", async () => {
      const hermes = (await p.exec("hermes", ["env"])).stdout;
      expect(hermes).toContain("ANTHROPIC_API_KEY=fake-hapi-hermes-anthropic-api-key-value");
      expect(hermes).not.toContain("fake-hapi-archon-");
      expect([hermes.includes("fake-hapi-host-"), hermes.includes("fake-hapi-research-"), hermes.includes("APP_PRIVATE_KEY")]).toEqual([false, false, false]);
      for (const v of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) expect(hermes).toContain(`${v}=http://egress-hermes:3128`);
    });

    test("a single-quoted env_file value reaches the container byte for byte (newline, $, #, spaces, backslash, quote)", async () => {
      const r = await p.exec("hermes", ["printenv", "HAPI_INT_PROBE"]);
      expect(r.stdout).toBe(`${PROBE}\n`);
    });

    test("the pinned version: Hermes v0.22.5 (Archon's toolchains are read from a run container, by the run integration test)", async () => {
      expect((await p.exec("hermes", ["hermes", "--version"])).stdout).toContain("Hermes Agent v0.22.5");
    });
  });
});
