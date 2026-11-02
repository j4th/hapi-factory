/**
 * stack/compose.yaml and the Dockerfiles, read as files: the zones, networks,
 * env files, mounts, pins and hardening that the spec requires (§4.3, §10,
 * §11.3-11.6). No Docker needed; tests/stack/egress.int.test.ts runs the same
 * file on a real Docker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ARCHON_ENV, emitArchon, PI_AGENT_DIR } from "../../src/generate/archon";
import { PROXY_PORT } from "../../src/generate/egress";
import { loadPolicy } from "../../src/policy/load";
import { ENV_DIR } from "../../src/secrets/files";
import { SECRET_ZONES } from "../../src/secrets/manifest";
import { proxyEnv, RESERVED_ENV_NAMES, serviceEnvironment, SIDECAR_ALIAS, ZONE_SERVICES } from "../../src/stack/env";
import { composeFile, REPO } from "./helpers";

const c = composeFile();
const text = readFileSync(join(REPO, "stack", "compose.yaml"), "utf8");
const svc = (name: string) => c.services[name] as Record<string, any>;
const ZONES = ["hermes", "archon", "research", "review"] as const;
const PROXIES = ZONES.map((z) => `egress-${z}`);
const DIGEST = /@sha256:[0-9a-f]{64}$/;
/** A pinned image: name:tag@sha256:digest, never latest. */
const pinned = (image: string) => DIGEST.test(image) && /:[^:@/]+@sha256:/.test(image) && !/:latest@/.test(image);
const envFile = (zone: string) => `\${XDG_RUNTIME_DIR:?set XDG_RUNTIME_DIR to your own runtime dir, e.g. /run/user/<uid> (docs/runbooks/stack.md)}/hapi/${ENV_DIR}/${zone}.env`;

/** Every image a Dockerfile pulls: FROM lines and COPY --from=<image>. */
function dockerfileImages(path: string): string[] {
  const lines = readFileSync(join(REPO, path), "utf8").split("\n");
  const from = lines.filter((l) => /^FROM /i.test(l)).map((l) => l.split(/\s+/)[1]!);
  const copy = lines.flatMap((l) => [.../--from=(\S+)/.exec(l)?.slice(1) ?? []]).filter((s) => s.includes("/") || s.includes(":"));
  return [...from, ...copy];
}

test("six services: hermes, archon and one egress proxy per zone (research's own service comes in Plan 04; a review is a run container of archon)", () => {
  expect(Object.keys(c.services).sort()).toEqual(["archon", "egress-archon", "egress-hermes", "egress-research", "egress-review", "hermes"]);
  expect(c.name).toBe("hapi");
});

describe("networks", () => {
  test("hermes-net, archon-net, research-net and review-net are internal; outbound is the proxies' only way out", () => {
    expect(Object.keys(c.networks).sort()).toEqual(["archon-net", "hermes-net", "outbound", "research-net", "review-net"]);
    for (const z of ZONES) expect([z, c.networks[`${z}-net`]?.internal]).toEqual([z, true]);
    expect(c.networks.outbound?.internal).toBeUndefined();
    // The proxies can't reach each other on outbound.
    expect((c.networks.outbound as any).driver_opts["com.docker.network.bridge.enable_icc"]).toBe("false");
  });

  test("each zone's containers are on its network only, and only the proxies join outbound", () => {
    const nets = (name: string) => Object.keys(svc(name).networks ?? {}).sort();
    for (const z of ZONES) expect(nets(`egress-${z}`)).toEqual([`${z}-net`, "outbound"].sort());
    expect(nets("hermes")).toEqual(["hermes-net"]);
    // archon is the run service: the launcher gives each run container a network of its own.
    expect(nets("archon")).toEqual([]);
    for (const [name, s] of Object.entries(c.services)) {
      expect([name, s.network_mode]).toEqual([name, undefined]);
      if (!name.startsWith("egress-")) expect([name, Object.keys((s.networks as object) ?? {}).includes("outbound")]).toEqual([name, false]);
    }
  });

  test("no service publishes a port to the host", () => {
    for (const [name, s] of Object.entries(c.services)) expect([name, s.ports, s.expose]).toEqual([name, undefined, undefined]);
  });
});

describe("hardening, on every service", () => {
  // archon is `profiles: ["run"]`, `restart: "no"` and has no health check: it is the template of one container per run.
  for (const name of ["hermes", "archon", ...PROXIES]) {
    test(`${name}: no capabilities, no new privileges, a non-root user, pid and memory limits, a read-only root${name === "archon" ? ", no restart" : ", a health check"}`, () => {
      const s = svc(name);
      expect(s.cap_drop).toEqual(["ALL"]);
      expect(s.cap_add).toBeUndefined();
      expect(s.privileged).toBeUndefined();
      expect(s.security_opt).toContain("no-new-privileges:true");
      expect(String(s.user)).toMatch(/^[1-9]\d*:[1-9]\d*$/);
      expect(typeof s.pids_limit).toBe("number");
      expect(s.pids_limit).toBeGreaterThan(0);
      expect(String(s.mem_limit)).toMatch(/^\d+[mg]$/);
      expect(s.read_only).toBe(true);
      if (name === "archon") {
        expect(s.profiles).toEqual(["run"]);
        expect(s.restart).toBe("no");
        expect(s.healthcheck).toBeUndefined();
      } else {
        expect(s.profiles).toBeUndefined();
        expect(s.healthcheck?.test).toBeDefined();
        expect(s.restart).toBe("unless-stopped");
      }
      // The labels Task 6's audit reads: who started the stack, and whether the dev bypass was on. A stack
      // started without `hapi stack up` (a raw `docker compose up`) says `unknown`, never "not dev-override".
      expect(s.labels["org.hapi.started-by"]).toBe("${HAPI_STARTED_BY:-unknown}");
      expect(s.labels["org.hapi.dev-override"]).toBe("${HAPI_DEV_OVERRIDE:-unknown}");
      // The digest of build/: a policy change recreates the containers that mount its files.
      expect(s.labels["org.hapi.build-sha256"]).toBe("${HAPI_BUILD_SHA256:-}");
    });
  }

  test("tmpfs mounts are size-capped; only hermes's /run may execute (s6-overlay runs from it)", () => {
    for (const [name, s] of Object.entries(c.services)) {
      for (const t of (s.tmpfs as string[] | undefined) ?? []) {
        expect([name, t, /size=\d+[kmg]/.test(t)]).toEqual([name, t, true]);
        const exec = t.split(":")[1]?.split(",").includes("exec") ?? false;
        expect([name, t, exec]).toEqual([name, t, name === "hermes" && t.startsWith("/run:")]);
      }
    }
  });
});

describe("pins", () => {
  test("every image is pinned by tag and digest: the proxies' Squid in compose.yaml, and every FROM and COPY --from in the Dockerfiles", () => {
    for (const p of PROXIES) expect([p, pinned(svc(p).image)]).toEqual([p, true]);
    for (const p of PROXIES) expect(svc(p).image).toBe(svc("egress-archon").image);
    for (const [name, file] of [["hermes", "stack/hermes/Dockerfile"], ["archon", "stack/archon/Dockerfile"]] as const) {
      expect(svc(name).build).toEqual({ context: `./${name}` });
      const images = dockerfileImages(file);
      expect(images.length).toBeGreaterThan(0);
      for (const image of images) expect([file, image, pinned(image)]).toEqual([file, image, true]);
    }
    expect(text).not.toMatch(/:latest\b/);
  });

  test("the pinned versions: Hermes v0.22.5, Archon 0.12.1 (with Pi 1.3.0 checked at build), Squid from Canonical's ubuntu/squid", () => {
    expect(dockerfileImages("stack/hermes/Dockerfile")).toEqual([expect.stringMatching(/^nousresearch\/hermes-agent:v0\.22\.5@sha256:/)]);
    // The last FROM is the image the Archon container runs; the others are build stages it copies from.
    const archonFrom = readFileSync(join(REPO, "stack", "archon", "Dockerfile"), "utf8").split("\n").filter((l) => l.startsWith("FROM "));
    expect(archonFrom.at(-1)).toMatch(/^FROM ghcr\.io\/coleam00\/archon:0\.12\.1@sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(REPO, "stack", "archon", "Dockerfile"), "utf8")).toContain('"1.3.0"');
    expect(svc("egress-archon").image).toMatch(/^ubuntu\/squid:[\d.]+-\d\d\.\d\d_\w+@sha256:/);
  });

  test("the run image carries mise by digest, the repo contract's tools at their pins, and CodeRabbit's CLI by checksum (H-208; spike 09, T18)", () => {
    const docker = readFileSync(join(REPO, "stack", "archon", "Dockerfile"), "utf8");
    const lines = docker.split("\n");
    const froms = lines.filter((l) => l.startsWith("FROM "));
    // mise's stage, by tag and digest, before the archon FROM, which stays last.
    const mise = froms.findIndex((l) => /^FROM jdxcode\/mise:2026\.10\.9@sha256:[0-9a-f]{64} AS mise$/.test(l));
    expect(mise).toBeGreaterThan(-1);
    expect(mise).toBeLessThan(froms.length - 1);
    expect(froms.at(-1)).toMatch(/^FROM ghcr\.io\/coleam00\/archon:0\.12\.1@/);
    expect(docker).toContain("COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise");
    // Every tool the template's mise.toml pins is installed at that version (Bun.TOML.parse, as mise reads it).
    const template = Bun.TOML.parse(readFileSync(join(REPO, "templates", "repo-contract", "mise.toml.tmpl"), "utf8")) as { tools: Record<string, string> };
    const install = lines.find((l) => l.startsWith("RUN mise install "))!;
    expect(Object.keys(template.tools).length).toBeGreaterThan(0);
    for (const [name, version] of Object.entries(template.tools)) expect([name, install.split(/\s+/).includes(`${name}@${version}`)]).toEqual([name, true]);
    expect(docker).toContain("RUN mise --version | grep -q '^2026\\.10\\.9 '");
    // mise's settings are the image's ENV lines, never the run's environment (ARCHON_ENV is unchanged).
    const env = (name: string) => new RegExp(`^ENV (?:.*\\s)?${name}=`, "m");
    const settings = { MISE_DATA_DIR: "/opt/hapi/mise", MISE_CACHE_DIR: "/opt/hapi/mise-cache", MISE_TRUSTED_CONFIG_PATHS: "/work/repo", MISE_OFFLINE: "1", MISE_LOCKED: "1", MISE_SHIMS_DIR: "/tmp/mise-shims" };
    for (const [name, value] of Object.entries(settings)) {
      expect([name, env(name).test(docker.replace(/\\\n\s*/g, " "))]).toEqual([name, true]);
      expect([name, docker.replace(/\\\n\s*/g, " ").includes(`${name}=${value}`)]).toEqual([name, true]);
      expect([name, ARCHON_ENV.some(([n]) => n === name)]).toEqual([name, false]);
    }
    // Never the auto-installs at 0: mise run would fall back to the image's own Bun without a word (T18 finding 5).
    for (const name of ["MISE_EXEC_AUTO_INSTALL", "MISE_TASK_RUN_AUTO_INSTALL", "MISE_NOT_FOUND_AUTO_INSTALL"]) expect([name, docker.includes(name)]).toEqual([name, false]);
    // The install runs before the settings that make mise read-only and offline.
    expect(docker.indexOf("RUN mise install ")).toBeLessThan(docker.indexOf("MISE_OFFLINE=1"));
    // CodeRabbit's CLI 0.9.1 (the review's CodeRabbit node), checked against its signed release's SHA-256.
    expect(docker).toMatch(/^ADD --checksum=sha256:[0-9a-f]{64} https:\/\/cli\.coderabbit\.ai\/releases\/0\.9\.1\/coderabbit-linux-x64\.zip /m);
    expect(docker).toContain('test "$(HOME=/tmp/coderabbit-home CODERABBIT_CLI_DISABLE_AUTO_UPDATE=1 CR_CLI_TELEMETRY_DISABLED=1 cr --version)" = 0.9.1');
  });

  test("the built images get fixed local names, so a test project reuses them instead of making one per run", () => {
    expect(svc("hermes").image).toBe("hapi-factory/hermes:v0.22.5");
    expect(svc("archon").image).toBe("hapi-factory/archon:0.12.1");
  });

  test("a built image is only ever built, never pulled: a raw `docker compose up` or `pull` never asks a registry for hapi-factory/*", () => {
    for (const [name, s] of Object.entries(c.services)) {
      expect([name, s.pull_policy]).toEqual([name, s.build === undefined ? undefined : "build"]);
    }
  });
});

describe("the egress proxies", () => {
  for (const z of ZONES) {
    test(`egress-${z}: Squid in the foreground, as a non-root user, on its zone's generated config, mounted read-only`, () => {
      const s = svc(`egress-${z}`);
      expect(s.entrypoint).toEqual(["/usr/sbin/squid-gnutls"]);
      expect(s.command).toEqual(["-N", "-f", "/etc/squid/hapi.conf"]);
      expect(s.volumes).toEqual([`../build/egress/${z}.squid.conf:/etc/squid/hapi.conf:ro`]);
      expect(s.env_file).toBeUndefined();
      expect(JSON.stringify(s.healthcheck.test)).toContain(String(PROXY_PORT));
    });
  }
});

describe("the zone services", () => {
  test("each one's only env_file is its own zone's secrets, at $XDG_RUNTIME_DIR/hapi/env/<zone>.env, and never host.env", () => {
    expect(svc("hermes").env_file).toEqual([envFile("hermes")]);
    expect(svc("archon").env_file).toEqual([envFile("archon")]);
    expect(SECRET_ZONES).toContain("host");
    expect(text).not.toContain("host.env");
  });

  for (const z of ZONE_SERVICES) {
    test(`${z}: HTTP(S)_PROXY points at egress-${z}, loopback goes direct${z === "archon" ? " and so does the run's sidecar, and it depends on nothing (a run container starts when the launcher says)" : ", and it starts once its proxy is healthy"}`, () => {
      const env = svc(z).environment as Record<string, string>;
      for (const v of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect([v, env[v]]).toEqual([v, `http://egress-${z}:${PROXY_PORT}`]);
      for (const v of ["NO_PROXY", "no_proxy"]) expect([v, env[v]]).toEqual([v, z === "archon" ? "localhost,127.0.0.1,::1,hapi-sidecar" : "localhost,127.0.0.1,::1"]);
      expect(svc(z).depends_on).toEqual(z === "archon" ? undefined : { [`egress-${z}`]: { condition: "service_healthy" } });
    });

    test(`${z}: its environment: is exactly serviceEnvironment("${z}"), every name reserved, so no secret can override it`, () => {
      // Compose puts environment: above env_file, and the manifest loader refuses these names (tests/secrets/manifest.test.ts).
      expect(svc(z).environment).toEqual(serviceEnvironment(z));
      for (const name of Object.keys(svc(z).environment)) expect([name, RESERVED_ENV_NAMES.includes(name)]).toEqual([name, true]);
    });
  }

  test("the archon zone's NO_PROXY names hapi-sidecar, so a run reaches its sidecar directly; no other zone's does", () => {
    // Directly, so the proxies' to_localnet is never loosened: the sidecar's address is on the run's private network.
    expect(SIDECAR_ALIAS).toBe("hapi-sidecar");
    for (const zone of ["hermes", "archon", "research", "review"] as const) {
      const direct = zone === "archon" ? "localhost,127.0.0.1,::1,hapi-sidecar" : "localhost,127.0.0.1,::1";
      expect([zone, proxyEnv(zone).NO_PROXY, proxyEnv(zone).no_proxy]).toEqual([zone, direct, direct]);
    }
    for (const v of ["NO_PROXY", "no_proxy"]) {
      expect([v, svc("archon").environment[v].split(",").includes(SIDECAR_ALIAS)]).toEqual([v, true]);
      expect([v, svc("hermes").environment[v].split(",").includes(SIDECAR_ALIAS)]).toEqual([v, false]);
    }
  });

  test("egress-review is the review zone's proxy alone: no service has review.env as its env_file, since the launcher gives a review run its zone's keys itself", () => {
    expect(svc("egress-review").networks).toEqual({ "review-net": {}, outbound: {} });
    for (const [name, s] of Object.entries(c.services)) expect([name, JSON.stringify(s.env_file ?? []).includes("review.env")]).toEqual([name, false]);
  });

  test("archon: every setting of the generated build/archon/archon.env is in its environment:, with the same value, and there are ARCHON_ENV.length of them", () => {
    const generated = emitArchon(loadPolicy(join(REPO, "policy")))["archon.env"]!
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]);
    expect(generated.length).toBe(ARCHON_ENV.length);
    for (const [name, value] of generated) expect([name, svc("archon").environment[name!]]).toEqual([name, value]);
  });

  test("archon has no volumes, networks, ports or healthcheck: its mounts, networks and tmpfs are the launcher's, per run", () => {
    const s = svc("archon");
    expect(s.volumes).toBeUndefined();
    expect(s.networks).toBeUndefined();
    expect(s.network_mode).toBeUndefined();
    expect(s.ports).toBeUndefined();
    expect(s.expose).toBeUndefined();
    expect(s.healthcheck).toBeUndefined();
    expect(s.depends_on).toBeUndefined();
    // Server-era leftovers: nothing binds the server, and no text names one.
    expect(JSON.stringify(s)).not.toMatch(/3090|archon-data|archon-home/);
  });

  test("archon: the user, the Pi agent dir its environment names, and ARCHON_DOCKER", () => {
    const s = svc("archon");
    expect(s.environment.PI_CODING_AGENT_DIR).toBe(PI_AGENT_DIR);
    expect(s.environment.ARCHON_DOCKER).toBe("true");
    expect(s.user).toBe("1001:1001");
  });

  test("hermes: its generated config read-only over its data volume, the gateway as the main program", () => {
    const s = svc("hermes");
    expect(s.volumes).toEqual(["hermes-data:/opt/data", "../build/hermes/config.yaml:/opt/data/config.yaml:ro"]);
    expect(s.command).toEqual(["gateway", "run"]);
    expect(s.user).toBe("10000:10000");
  });

  test("the named volumes are exactly hermes-data: a run's state lives in its own labelled volumes, made by the launcher", () => {
    expect(Object.keys(c.volumes ?? {}).sort()).toEqual(["hermes-data"]);
  });
});
