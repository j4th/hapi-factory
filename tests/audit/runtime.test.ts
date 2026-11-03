/**
 * The runtime.* checks read the running containers (`docker inspect`):
 * the run container's definition (and any live run's mounts and environment),
 * Hermes's effective approval settings (its argv, its env and the config
 * mounted at $HERMES_HOME), the labels `hapi stack up` puts on every
 * container (the dev bypass), and the run disk against `runs.disk` (H-217).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { diskProblem, GIB } from "../../src/run/disk";
import { RUN_DISK } from "../../src/run/locks";
import * as sidecar from "../../src/run/sidecar";
import * as spec from "../../src/run/spec";
import { loadManifest, MANIFEST_FILE, manifestEntries } from "../../src/secrets/manifest";
import { cleanup, cleanWorld, type Container, DOCKER_ROOT, goodDisks, helperContainer, type Kind, only, REPO, REVIEW_ZONE_KEYS, runContainer, SIDECAR_IMAGE, sidecarContainer, tempDir } from "./helpers";

afterEach(cleanup);

type World = Awaited<ReturnType<typeof cleanWorld>>;
const check = async (w: World, id: string) => only(await runAudit(w.ctx), id);
const svc = (w: World, service: string) => w.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === service)!;
const setEnv = (c: Container, name: string, value: string | undefined) => {
  c.Config.Env = c.Config.Env.filter((e) => !e.startsWith(`${name}=`));
  if (value !== undefined) c.Config.Env.push(`${name}=${value}`);
};

describe("runtime.run-container", () => {
  /** The check, with `runArgs` (the run definition) returning `edit` of the real argv. */
  async function withSpec(edit: (argv: string[]) => string[]) {
    const real = spec.runArgs;
    const spy = spyOn(spec, "runArgs").mockImplementation((...a) => edit(real(...a)));
    try {
      return await check(await cleanWorld(), "runtime.run-container");
    } finally {
      spy.mockRestore();
    }
  }
  /** Drops the `flag value` pair whose value satisfies `test`. */
  const without = (flag: string, test: (v: string) => boolean) => (argv: string[]) => argv.filter((a, i) => !(argv[i - 1] === flag && test(a)) && !(a === flag && test(argv[i + 1] ?? "")));

  test("the run definition (runArgs) passes with no Docker needed, and says no run was live", async () => {
    const w = await cleanWorld();
    w.dockerDown = true;
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("/opt/hapi/pi-agent");
    expect(r.detail).toContain("no live run container was checked");
    // Every kind's definition is checked, each with its own prelude and proxy.
    expect(r.detail).toContain("for each of the 4 run kinds (worker, verify, review and fix)");
  });

  test("a spec that drops the Pi dir's tmpfs fails, naming it", async () => {
    const r = await withSpec(without("--tmpfs", (v) => v.startsWith("/opt/hapi/pi-agent:")));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no tmpfs at /opt/hapi/pi-agent");
  });

  test("a tmpfs with other options than size=64m,uid=1001,gid=1001,mode=0700 fails", async () => {
    const r = await withSpec((argv) => argv.map((a) => (a.startsWith("/opt/hapi/pi-agent:") ? "/opt/hapi/pi-agent:size=64m,uid=1001,gid=1001,mode=1777" : a)));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("size=64m,uid=1001,gid=1001,mode=0700");
  });

  test("a run definition that drops any host bind fails, naming it: the guard's extensions and settings, the run layer, the git config, the prelude, the run file, the work order and its task text, and the source", async () => {
    for (const dest of ["/opt/hapi/pi-agent/settings.json", "/opt/hapi/pi-agent/extensions", "/opt/hapi/run-config.yaml", "/home/appuser/.gitconfig", "/opt/hapi/run.sh", "/run/hapi/run.json", "/run/hapi/order.json", "/run/hapi/task.md", "/src/repo.git"]) {
      const r = await withSpec(without("-v", (v) => v.endsWith(`:${dest}:ro`)));
      expect([dest, r.status]).toEqual([dest, "fail"]);
      expect(r.detail).toContain(`nothing is bound at ${dest}`);
    }
  });

  test("a writable models.json fails, naming the file", async () => {
    const r = await withSpec((argv) => argv.map((a) => (a.endsWith(":/opt/hapi/pi-agent/models.json:ro") ? a.slice(0, -3) : a)));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/opt/hapi/pi-agent/models.json is not bound read-only");
  });

  test("no /.archon/.env bound fails: Archon would read a planted one over the environment", async () => {
    const r = await withSpec(without("-v", (v) => v.endsWith(":/.archon/.env:ro")));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("nothing is bound at /.archon/.env");
  });

  test("a missing default pack dir, a changed environment value and a published port each fail", async () => {
    let r = await withSpec(without("-v", (v) => v.endsWith(":/.archon/workflows/hapi:ro")));
    expect([r.status, r.detail]).toEqual(["fail", expect.stringContaining("nothing is bound at /.archon/workflows/hapi")]);
    r = await withSpec((argv) => argv.map((a) => (a === "PI_OFFLINE=1" ? "PI_OFFLINE=0" : a)));
    expect([r.status, r.detail]).toEqual(["fail", expect.stringContaining("PI_OFFLINE is not 1")]);
    r = await withSpec((argv) => [...argv.slice(0, 3), "-p", "3090:3090", ...argv.slice(3)]);
    expect([r.status, r.detail]).toEqual(["fail", expect.stringContaining("publishes a port")]);
  });

  test("a spec the launcher can't build fails, with the reason", async () => {
    const spy = spyOn(spec, "runArgs").mockImplementation(() => {
      throw new Error("stack/compose.yaml: archon: key \"ports\" isn't translated into the run container");
    });
    try {
      const r = await check(await cleanWorld(), "runtime.run-container");
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("isn't translated");
    } finally {
      spy.mockRestore();
    }
  });

  test("live run containers that match pass, counted", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w), runContainer(w, "0123456789ab"));
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("2 live run containers");
  });

  test("a live run container whose mounts differ fails, naming it and the mount", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    live.Mounts.find((m) => m.Destination === "/opt/hapi/pi-agent/models.json")!.RW = true;
    live.Mounts = live.Mounts.filter((m) => m.Destination !== "/.archon/.env");
    delete live.HostConfig!.Tmpfs!["/opt/hapi/pi-agent"];
    w.containers.push(live, runContainer(w, "0123456789ab"));
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("hapi-run-ab12cd34ef56");
    expect(r.detail).toContain("/opt/hapi/pi-agent/models.json is not mounted read-only");
    expect(r.detail).toContain("nothing is mounted at /.archon/.env");
    expect(r.detail).toContain("no tmpfs at /opt/hapi/pi-agent");
    expect(r.detail).not.toContain("hapi-run-0123456789ab");
  });

  test("a live run container's environment must have every value, and no published port", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    setEnv(live, "PI_TELEMETRY", "1");
    setEnv(live, "PI_OFFLINE", undefined);
    live.HostConfig = { PortBindings: { "3090/tcp": [{ HostIp: "0.0.0.0", HostPort: "3090" }] } };
    w.containers.push(live);
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("PI_TELEMETRY is not 0");
    expect(r.detail).toContain("PI_OFFLINE is not set");
    expect(r.detail).toContain("publishes a port");
    expect(r.detail).not.toContain("PI_TELEMETRY=1");
  });

  test("a live run container is held to every bind of the run definition, not a short list", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    for (const dest of ["/opt/hapi/pi-agent/settings.json", "/opt/hapi/pi-agent/extensions", "/opt/hapi/run.sh", "/home/appuser/.gitconfig", "/src/repo.git"]) live.Mounts.find((m) => m.Destination === dest)!.RW = true;
    w.containers.push(live);
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    for (const dest of ["/opt/hapi/pi-agent/settings.json", "/opt/hapi/pi-agent/extensions", "/opt/hapi/run.sh", "/home/appuser/.gitconfig", "/src/repo.git"]) expect(r.detail).toContain(`${dest} is not mounted read-only`);
  });

  test("an unexpected mount, a wrong pack source and a missing run volume fail", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    live.Mounts.push({ Type: "bind", Source: "/home/hapi", Destination: "/host", RW: false });
    live.Mounts.find((m) => m.Destination === "/.archon/workflows/hapi")!.Source = "/tmp/planted-pack";
    live.Mounts = live.Mounts.filter((m) => m.Destination !== "/out");
    w.containers.push(live);
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/host is mounted but the run definition has no such mount");
    expect(r.detail).toContain("/.archon/workflows/hapi is mounted from /tmp/planted-pack, not the default pack dir");
    expect(r.detail).toContain("nothing is mounted at /out");
  });

  test("a live run container's hardening must be the definition's: capabilities, root fs, no-new-privileges, user, pids, memory", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    Object.assign(live.HostConfig!, { CapDrop: [], ReadonlyRootfs: false, SecurityOpt: [], PidsLimit: 0, Memory: 0 });
    live.Config.User = "0:0";
    delete live.HostConfig!.Tmpfs!["/tmp"];
    w.containers.push(live);
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    for (const part of ["does not drop ALL capabilities", "root filesystem is not read-only", "no-new-privileges:true is not set", "runs as 0:0, not 1001:1001", "pids limit is 0, not 2048", "memory limit is 0, not 4294967296", "no tmpfs at /tmp"]) expect(r.detail).toContain(part);
  });

  test("a run definition without the hardening flags or the stop timeout fails, naming each (final review B-2)", async () => {
    const drop = (flag: string) => without(flag, () => true);
    const r = await withSpec((argv) =>
      [drop("--cap-drop"), drop("--security-opt"), drop("--pids-limit"), drop("--memory"), drop("--stop-timeout")].reduce((a, f) => f(a), argv).filter((a) => a !== "--read-only").map((a, i, all) => (all[i - 1] === "--user" ? "0:0" : a)),
    );
    expect(r.status).toBe("fail");
    for (const part of [
      "it does not drop ALL capabilities",
      "its root filesystem is not read-only",
      "it does not set no-new-privileges:true",
      "it has no pids limit",
      "it has no memory limit",
      "it runs as 0:0, not 1001:1001",
      "its stop timeout is Docker's default, not 30",
    ]) expect(r.detail).toContain(part);
  });

  test("a run's prelude is its PID 1: a definition without --init=false fails, and so does a live run container with an init process (HostConfig.Init)", async () => {
    const r = await withSpec((argv) => argv.filter((a) => a !== "--init=false"));
    expect(r.status).toBe("fail");
    for (const k of ["worker", "verify", "review", "fix"]) expect(r.detail).toContain(`${k}: it doesn't set --init=false: its prelude must be PID 1 whatever the daemon's default`);
    const w = await cleanWorld();
    const live = runContainer(w, "aaaaaaaaaaaa", { kind: "verify" });
    live.HostConfig!.Init = true;
    w.containers.push(live, runContainer(w, "bbbbbbbbbbbb", { kind: "review" }));
    const v = await check(w, "runtime.run-container");
    expect(v.status).toBe("fail");
    expect(v.detail).toContain("hapi-run-aaaaaaaaaaaa: its HostConfig.Init is true, not false: an init process may be its PID 1, not its prelude");
    expect(v.detail).not.toContain("hapi-run-bbbbbbbbbbbb");
    // Unset takes the daemon's default, which may be "init": true: it must be false.
    const u = await cleanWorld();
    const unset = runContainer(u, "aaaaaaaaaaaa");
    unset.HostConfig!.Init = null;
    u.containers.push(unset);
    expect((await check(u, "runtime.run-container")).detail).toContain("hapi-run-aaaaaaaaaaaa: its HostConfig.Init is unset (the daemon's default), not false");
    // Docker uses the last --init flag: a definition that ends on --init fails, one that ends on --init=false passes.
    let r2 = await withSpec((argv) => [...argv.slice(0, argv.indexOf("--init=false") + 1), "--init", ...argv.slice(argv.indexOf("--init=false") + 1)]);
    expect(r2.detail).toContain("worker: it doesn't set --init=false");
    r2 = await withSpec((argv) => [...argv.slice(0, argv.indexOf("--init=false")), "--init", ...argv.slice(argv.indexOf("--init=false"))]);
    expect(r2.status).toBe("pass");
  });

  test("a live run container's stop timeout must be the definition's", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    delete live.Config.StopTimeout;
    const other = runContainer(w, "0123456789ab");
    other.Config.StopTimeout = 10;
    w.containers.push(live, other);
    const r = await check(w, "runtime.run-container");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("hapi-run-ab12cd34ef56: its stop timeout is Docker's default, not 30");
    expect(r.detail).toContain("hapi-run-0123456789ab: its stop timeout is 10, not 30");
  });

  describe("the kinds (design §3.5)", () => {
    const KINDS: Kind[] = ["worker", "verify", "review", "fix"];
    /** A key-shaped value, built at run time so no scanner sees a key in the source. */
    const VALUE = ["fake", "audit", "zone", "key", "0123456789"].join("-");

    test("each live container is held to its own kind's definition; one without org.hapi.kind is held to the worker's, and an unknown kind fails", async () => {
      const w = await cleanWorld();
      w.containers.push(runContainer(w), ...KINDS.map((kind, i) => runContainer(w, `aaaaaaaaaaa${i}`, { kind })));
      const r = await check(w, "runtime.run-container");
      expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("5 live run containers are as their kind's definition says")]);

      const v = await cleanWorld();
      // A worker's container that says it is a verify's; a review's that says nothing (so it is held to the worker's); a kind that isn't one.
      v.containers.push(
        runContainer(v, "aaaaaaaaaaaa", { labels: { "org.hapi.kind": "verify" } }),
        (() => {
          const c = runContainer(v, "bbbbbbbbbbbb", { kind: "review" });
          delete c.Config.Labels["org.hapi.kind"];
          return c;
        })(),
        runContainer(v, "cccccccccccc", { labels: { "org.hapi.kind": "build" } }),
        runContainer(v, "dddddddddddd", { kind: "fix" }),
      );
      const bad = await check(v, "runtime.run-container");
      expect(bad.status).toBe("fail");
      for (const part of [
        "hapi-run-aaaaaaaaaaaa: nothing is mounted at /opt/hapi/verify.sh",
        "/opt/hapi/run.sh is mounted but the run definition has no such mount",
        "it runs sh /opt/hapi/run.sh hapi-check-run, not sh /opt/hapi/verify.sh factory-verify",
        "hapi-run-bbbbbbbbbbbb: nothing is mounted at /opt/hapi/run.sh",
        "/run/hapi/inputs is mounted but the run definition has no such mount",
        "HTTP_PROXY is not http://egress-archon:3128",
        "hapi-run-cccccccccccc: carries org.hapi.kind=build, which is no run kind",
      ]) expect([part, bad.detail.includes(part)]).toEqual([part, true]);
      expect(bad.detail).not.toContain("hapi-run-dddddddddddd");
      // A label value that isn't plain is not shown.
      const u = await cleanWorld();
      u.containers.push(runContainer(u, "aaaaaaaaaaaa", { labels: { "org.hapi.kind": "x\u001b[2Jy" } }));
      expect((await check(u, "runtime.run-container")).detail).toContain("carries org.hapi.kind=(a value that is not shown), which is no run kind");
    });

    test("a live verify container holding any key fails, naming the variable, never its value; one whose proxy isn't egress-archon's fails as an env mismatch", async () => {
      const w = await cleanWorld();
      const live = runContainer(w, "aaaaaaaaaaaa", { kind: "verify" });
      for (const name of ["ANTHROPIC_API_KEY", "BRAVE_SEARCH_API_KEY", "HAPI_FACTORY_APP_PRIVATE_KEY"]) setEnv(live, name, VALUE);
      w.containers.push(live);
      const r = await check(w, "runtime.run-container");
      expect(r.status).toBe("fail");
      for (const name of ["ANTHROPIC_API_KEY", "BRAVE_SEARCH_API_KEY", "HAPI_FACTORY_APP_PRIVATE_KEY"]) expect(r.detail).toContain(`${name} is set: a verify container holds no key`);
      expect(r.detail).not.toContain(VALUE);
      // Its own environment holds no key: git's config pairs are no zone's names (spike 09, T19: the check must not match GIT_CONFIG_KEY_<n>).
      const clean = await cleanWorld();
      const plain = runContainer(clean, "aaaaaaaaaaaa", { kind: "verify" });
      expect(plain.Config.Env.some((e) => e.startsWith("GIT_CONFIG_KEY_0="))).toBe(true);
      clean.containers.push(plain);
      expect((await check(clean, "runtime.run-container")).status).toBe("pass");
      // Its proxy is the archon zone's: the review zone's is an env mismatch.
      const p = await cleanWorld();
      const proxied = runContainer(p, "aaaaaaaaaaaa", { kind: "verify" });
      setEnv(proxied, "HTTPS_PROXY", "http://egress-review:3128");
      p.containers.push(proxied);
      expect((await check(p, "runtime.run-container")).detail).toContain("hapi-run-aaaaaaaaaaaa: HTTPS_PROXY is not http://egress-archon:3128");
    });

    test("a live review container carrying an archon-zone key fails, and one holding only the review zone's keys passes", async () => {
      expect(REVIEW_ZONE_KEYS).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CODERABBIT_API_KEY"]);
      const w = await cleanWorld();
      const ok = runContainer(w, "aaaaaaaaaaaa", { kind: "review" });
      for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]) setEnv(ok, name, VALUE);
      w.containers.push(ok);
      expect((await check(w, "runtime.run-container")).status).toBe("pass");
      const v = await cleanWorld();
      const bad = runContainer(v, "aaaaaaaaaaaa", { kind: "review" });
      for (const name of ["ANTHROPIC_API_KEY", "OPENCODE_API_KEY"]) setEnv(bad, name, VALUE);
      v.containers.push(bad);
      const r = await check(v, "runtime.run-container");
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("OPENCODE_API_KEY is set: a review container holds only its zone's keys");
      expect(r.detail).not.toContain("ANTHROPIC_API_KEY is set");
      expect(r.detail).not.toContain(VALUE);
      // A worker holds the archon zone's keys, and none of another zone's: CodeRabbit's is the review zone's, Slack's Hermes's.
      const x = await cleanWorld();
      const worker = runContainer(x, "aaaaaaaaaaaa", { kind: "worker" });
      for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENCODE_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY"]) setEnv(worker, name, VALUE);
      const fix = runContainer(x, "bbbbbbbbbbbb", { kind: "fix" });
      for (const name of ["CODERABBIT_API_KEY", "SLACK_BOT_TOKEN"]) setEnv(fix, name, VALUE);
      x.containers.push(worker, fix);
      const y = await check(x, "runtime.run-container");
      expect(y.detail).not.toContain("hapi-run-aaaaaaaaaaaa");
      for (const name of ["CODERABBIT_API_KEY", "SLACK_BOT_TOKEN"]) expect(y.detail).toContain(`${name} is set: a fix container holds only its zone's keys`);
    });

    test("a live run container is on its own internal network alone, which holds only it and its kind's proxy: another network, the default bridge, an extra endpoint, the other zone's proxy or a network that isn't internal each fail", async () => {
      const N = "hapi-run-aaaaaaaaaaaa";
      const cases: [what: string, kind: Kind, edit: (c: Container, w: World) => void, part: string][] = [
        ["another network", "worker", (c) => void (c.NetworkSettings!.Networks.hapi_archon = {}), `it is on ${N}, hapi_archon, not on its own network ${N} alone`],
        [
          "the default bridge",
          "verify",
          (c) => {
            c.HostConfig!.NetworkMode = "bridge";
            c.NetworkSettings!.Networks = { bridge: {} };
          },
          `its network is bridge, not its own network ${N}; it is on bridge, not on its own network ${N} alone`,
        ],
        [
          "an extra endpoint",
          "fix",
          (_, w) => void (w.networks.get(N)!.Containers["id-x"] = { Name: "hapi-hermes-1" }),
          `its network ${N} holds hapi-egress-archon-1, hapi-hermes-1, ${N}, not exactly hapi-egress-archon-1 and ${N}`,
        ],
        [
          "egress-archon on a review's network",
          "review",
          (_, w) => void (w.networks.get(N)!.Containers = { "id-run-aaaaaaaaaaaa": { Name: N }, "id-hapi-egress-archon-1": { Name: "hapi-egress-archon-1" } }),
          `its network ${N} holds hapi-egress-archon-1, ${N}, not exactly hapi-egress-review-1 and ${N}`,
        ],
        ["a network that isn't internal", "worker", (_, w) => void (w.networks.get(N)!.Internal = false), `network ${N} is not internal: it would have a route out around the proxy`],
        ["a network docker can't find", "worker", (_, w) => void w.networks.delete(N), `its network ${N} could not be inspected (docker network inspect exited 1)`],
        [
          "another container under the run's name",
          "worker",
          (_, w) => void (w.networks.get(N)!.Containers = { "id-someone-else": { Name: N }, "id-hapi-egress-archon-1": { Name: "hapi-egress-archon-1" } }),
          `its network ${N} has no endpoint of this container's id under its name`,
        ],
      ];
      for (const [what, kind, edit, part] of cases) {
        const w = await cleanWorld();
        const live = runContainer(w, "aaaaaaaaaaaa", { kind });
        edit(live, w);
        w.containers.push(live);
        const r = await check(w, "runtime.run-container");
        expect([what, r.status]).toEqual([what, "fail"]);
        expect([what, r.detail.includes(`${N}: ${part}`) || r.detail.includes(part)]).toEqual([what, true]);
      }
      // A review's own network, with egress-review, passes; and the check read it with docker network inspect.
      const ok = await cleanWorld();
      ok.containers.push(runContainer(ok, "aaaaaaaaaaaa", { kind: "review" }));
      expect((await check(ok, "runtime.run-container")).status).toBe("pass");
      expect(ok.calls).toContainEqual(["docker", "network", "inspect", N]);
    });

    test("with no zoneKeys in its context, the zones are stack/secrets.yaml's, its review zone included: a review container holding the review zone's keys passes, and an archon-only key fails", async () => {
      const w = await cleanWorld();
      delete w.ctx.zoneKeys;
      const review = runContainer(w, "aaaaaaaaaaaa", { kind: "review" });
      for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CODERABBIT_API_KEY"]) setEnv(review, name, VALUE);
      const worker = runContainer(w, "bbbbbbbbbbbb", { kind: "worker" });
      setEnv(worker, "OPENCODE_API_KEY", VALUE);
      w.containers.push(review, worker);
      expect((await check(w, "runtime.run-container")).status).toBe("pass");
      // CodeRabbit's key is the review zone's alone: a worker holding it fails, and so does a review holding OpenCode's.
      const v = await cleanWorld();
      delete v.ctx.zoneKeys;
      const bad = runContainer(v, "aaaaaaaaaaaa", { kind: "review" });
      setEnv(bad, "OPENCODE_API_KEY", VALUE);
      const leaky = runContainer(v, "bbbbbbbbbbbb", { kind: "worker" });
      setEnv(leaky, "CODERABBIT_API_KEY", VALUE);
      v.containers.push(bad, leaky);
      const r = await check(v, "runtime.run-container");
      expect(r.detail).toContain("hapi-run-aaaaaaaaaaaa: OPENCODE_API_KEY is set: a review container holds only its zone's keys");
      expect(r.detail).toContain("hapi-run-bbbbbbbbbbbb: CODERABBIT_API_KEY is set: a worker container holds only its zone's keys");
      expect(r.detail).not.toContain(VALUE);
    });

    test("the real manifest's review zone is Task 8's fixture", () => {
      const review = manifestEntries(loadManifest(join(REPO, MANIFEST_FILE))).filter((e) => e.zone === "review").map((e) => e.key);
      expect(review).toEqual(REVIEW_ZONE_KEYS);
    });

    test("every kind's run definition is checked: an inputs bind, a kind label or a review proxy dropped fails, naming the kind", async () => {
      let r = await withSpec(without("-v", (v) => v.endsWith(":/run/hapi/inputs:ro")));
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("review: nothing is bound at /run/hapi/inputs");
      expect(r.detail).toContain("fix: nothing is bound at /run/hapi/inputs");
      expect(r.detail).not.toMatch(/(worker|verify): nothing is bound at \/run\/hapi\/inputs/);
      r = await withSpec(without("--label", (v) => v.startsWith("org.hapi.kind=")));
      for (const k of KINDS) expect(r.detail).toContain(`${k}: it does not label its container org.hapi.kind=${k}`);
      r = await withSpec((argv) => argv.map((a) => a.replace("egress-review", "egress-archon")));
      expect(r.detail).toContain("review: HTTP_PROXY is not http://egress-review:3128");
      expect(r.detail).not.toContain("worker:");
      // A verify definition that binds a secret by name: verify holds no key.
      r = await withSpec((argv) => (argv.includes("/opt/hapi/verify.sh") ? [...argv.slice(0, argv.indexOf("-w")), "-e", "ANTHROPIC_API_KEY", ...argv.slice(argv.indexOf("-w"))] : argv));
      expect(r.detail).toContain("verify: it passes ANTHROPIC_API_KEY, a key, to a container that holds none");
      // The check also gives runArgs the archon zone's names for a verify: it must refuse them. One that drops them instead fails.
      const real = spec.runArgs;
      const calls: string[][] = [];
      const spy = spyOn(spec, "runArgs").mockImplementation((service, inputs, d, names, profile) => {
        calls.push(names);
        return real(service, inputs, d, profile.zone === undefined ? [] : names, profile);
      });
      try {
        r = await check(await cleanWorld(), "runtime.run-container");
      } finally {
        spy.mockRestore();
      }
      expect(r.detail).toContain("verify: runArgs binds the archon zone's keys into it when given them, where it must refuse them: it holds no key");
      expect(calls).toContainEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "OPENCODE_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY"]);
      // The real runArgs refuses them, so the clean world passes.
      expect((await check(await cleanWorld(), "runtime.run-container")).status).toBe("pass");
    });
  });

  describe("the smoke sidecar (design §3.3, H-192)", () => {
    const VALUE = ["fake", "audit", "sidecar", "key", "0123456789"].join("-");
    const R = "aaaaaaaaaaaa";
    const RUN = `hapi-run-${R}`;
    /**
     * One clean world per test, which each case resets to the stack's own containers and then gives a live run of
     * `kind` that has a sidecar, and the sidecar, both changed by `edit`. Only runtime.run-container runs (`ctx.only`),
     * so a case costs one check, not a whole audit and a fresh world.
     */
    async function sidecarWorld() {
      const w = await cleanWorld();
      w.ctx.only = ["runtime.run-container"];
      const stack = [...w.containers];
      const withSidecar = async (kind: Kind = "verify", edit: (sc: Container, run: Container, w: World) => void = () => {}) => {
        w.containers = [...stack];
        w.networks = new Map();
        const run = runContainer(w, R, { kind, sidecar: "bun-http" });
        const sc = sidecarContainer(R);
        edit(sc, run, w);
        w.containers.push(run, sc);
        return check(w, "runtime.run-container");
      };
      return { w, withSidecar };
    }
    /** Each case's `edit` fails the sidecar's check, naming `part` against the sidecar or its run, and never shows VALUE. */
    async function failsEach(cases: [what: string, edit: (sc: Container, run: Container, w: World) => void, part: string][]) {
      const { withSidecar } = await sidecarWorld();
      for (const [what, edit, part] of cases) {
        const r = await withSidecar("verify", edit);
        expect([what, r.status]).toEqual([what, "fail"]);
        expect([what, r.detail.includes(`${RUN}-sidecar: `) || r.detail.includes(`${RUN}: `), r.detail.includes(part)]).toEqual([what, true, true]);
        expect([what, r.detail.includes(VALUE)]).toEqual([what, false]);
      }
    }

    test("a run that has a sidecar, and its sidecar, pass: the run's network holds exactly the run, its proxy and its sidecar", async () => {
      const { withSidecar } = await sidecarWorld();
      for (const kind of ["worker", "verify", "fix"] as const) {
        const r = await withSidecar(kind);
        expect([kind, r.status, r.detail]).toEqual([kind, "pass", expect.stringContaining("1 live run container is as its kind's definition says")]);
        expect([kind, r.detail.includes("and 1 smoke sidecars as policy/sidecars.yaml says (its image, read-only, /data read-only, no key, on its run's network alone)")]).toEqual([kind, true]);
      }
      // A stopped sidecar (one that crashed) isn't checked, and has no endpoint on the run's network, so none is expected.
      const stopped = await withSidecar("verify", (sc, _, w) => {
        sc.State.Running = false;
        delete w.networks.get(RUN)!.Containers[`id-sidecar-${R}`];
      });
      expect([stopped.status, stopped.detail]).toEqual(["pass", expect.not.stringContaining("smoke sidecars")]);
    }, 30_000);

    test("a live sidecar runs policy's image, by digest, and its hardening: read-only, every capability dropped and none added, not privileged, no new privileges, 1001, policy's limits", async () => {
      await failsEach([
        ["an image policy doesn't list", (sc) => void (sc.Config.Image = `example/evil:1@sha256:${"e".repeat(64)}`), `runs example/evil:1@sha256:${"e".repeat(64)}, which policy/sidecars.yaml doesn't list`],
        ["the policy's image by tag alone", (sc) => void (sc.Config.Image = "oven/bun:1.4.4-slim"), "runs oven/bun:1.4.4-slim, which policy/sidecars.yaml doesn't list"],
        ["a writable root", (sc) => void (sc.HostConfig!.ReadonlyRootfs = false), "its root filesystem is not read-only"],
        ["root", (sc) => void (sc.Config.User = "0:0"), "it runs as 0:0, not 1001:1001"],
        ["no capability dropped", (sc) => void (sc.HostConfig!.CapDrop = []), "it does not drop ALL capabilities"],
        ["a capability added", (sc) => void (sc.HostConfig!.CapAdd = ["CAP_NET_RAW"]), "it adds NET_RAW, where a sidecar adds none"],
        ["privileged", (sc) => void (sc.HostConfig!.Privileged = true), "it is privileged (--privileged), where a sidecar holds no privilege"],
        ["no no-new-privileges", (sc) => void (sc.HostConfig!.SecurityOpt = []), "no-new-privileges:true is not set"],
        ["policy's pids limit raised", (sc) => void (sc.HostConfig!.PidsLimit = 4096), "its pids limit is 4096, not 128"],
        ["policy's memory raised", (sc) => void (sc.HostConfig!.Memory = 4 * 1024 ** 3), `its memory limit is ${4 * 1024 ** 3}, not ${512 * 1024 ** 2}`],
      ]);
    }, 30_000);

    test("a live sidecar's data is read-only at /data, its one mount, and it holds no key, publishes no port and runs policy's command there", async () => {
      await failsEach([
        ["/data writable", (sc) => void (sc.Mounts[0]!.RW = true), "/data is not mounted read-only"],
        ["no /data", (sc) => void (sc.Mounts = []), "nothing is mounted at /data"],
        ["another mount", (sc) => void sc.Mounts.push({ Type: "bind", Source: "/srv", Destination: "/srv", RW: false }), "/srv is mounted but the run definition has no such mount"],
        ["a writable /tmp of another size", (sc) => void (sc.HostConfig!.Tmpfs = { "/tmp": "size=1g" }), "the tmpfs at /tmp has options size=1g, not size=64m,uid=1001,gid=1001,mode=0700"],
        ["a zone's key", (sc) => void sc.Config.Env.push(`ANTHROPIC_API_KEY=${VALUE}`), "ANTHROPIC_API_KEY is set: a sidecar holds no key"],
        ["CodeRabbit's key", (sc) => void sc.Config.Env.push(`CODERABBIT_API_KEY=${VALUE}`), "CODERABBIT_API_KEY is set: a sidecar holds no key"],
        ["another port", (sc) => setEnv(sc, "PORT", "9090"), "PORT is not 8080"],
        ["a published port", (sc) => void (sc.HostConfig!.PortBindings = { "8080/tcp": [{ HostPort: "8080" }] }), "it publishes a port"],
        ["another command", (sc) => void (sc.Args = ["/data/other.ts"]), "it runs bun /data/other.ts, not bun /data/server.ts"],
        ["another working dir", (sc) => void (sc.Config.WorkingDir = "/"), "its working dir is /, not /data"],
      ]);
    }, 30_000);

    test("a live sidecar is on its run's network alone as hapi-sidecar, carries no Compose or helper label, and its run exists and names it", async () => {
      await failsEach([
        ["another network too", (sc) => void (sc.NetworkSettings!.Networks.bridge = {}), `it is on bridge, ${RUN}, not on its run's network ${RUN} alone`],
        ["no hapi-sidecar alias", (sc) => void (sc.NetworkSettings!.Networks[RUN] = { Aliases: [] }), `it is not hapi-sidecar on ${RUN}`],
        ["a Compose label", (sc) => void (sc.Config.Labels["com.docker.compose.project"] = "hapi"), "it carries com.docker.compose.project=hapi: a sidecar is no service of the Compose project"],
        ["a helper label", (sc) => void (sc.Config.Labels["org.hapi.helper"] = "copyout"), "it carries org.hapi.helper=copyout: a sidecar is no helper"],
        ["a run that names no sidecar", (_, run) => void delete run.Config.Labels["org.hapi.sidecar"], `its run ${RUN} carries no org.hapi.sidecar label: the run started no sidecar`],
        ["a run that names another", (_, run) => void (run.Config.Labels["org.hapi.sidecar"] = "postgres"), `${RUN}: carries org.hapi.sidecar=postgres, which policy/sidecars.yaml doesn't list`],
        ["no run container", (_, run) => void (run.Name = "/somewhere_else"), `its run's container ${RUN} doesn't exist`],
      ]);
    }, 30_000);

    test("the policy sidecar a live one is held to is the one its run names, not the first with its image: two sidecars of one image, with other limits, are told apart", async () => {
      const dir = join(tempDir("hapi-audit-sidecars-"), "policy");
      cpSync(join(REPO, "policy"), dir, { recursive: true });
      const text = readFileSync(join(dir, "sidecars.yaml"), "utf8");
      const big = `  bun-big:\n    image: ${SIDECAR_IMAGE}\n    command: ["bun", "/data/server.ts"]\n    port: 8080\n    limits: { pids: 256, memory_mb: 1024, data_files: 256, data_mb: 16 }\n`;
      writeFileSync(join(dir, "sidecars.yaml"), `${text}${big}`);
      const { w, withSidecar } = await sidecarWorld();
      w.ctx.policyDir = dir;
      // The run names bun-big; the sidecar has bun-big's limits: it passes, though bun-http (listed first) has its image too.
      const asBig = (sc: Container, run: Container) => {
        run.Config.Labels["org.hapi.sidecar"] = "bun-big";
        sc.HostConfig!.PidsLimit = 256;
        sc.HostConfig!.Memory = 1024 ** 3;
      };
      expect((await withSidecar("verify", asBig)).status).toBe("pass");
      // With bun-http's limits under a run that names bun-big, it fails against bun-big's.
      const small = await withSidecar("verify", (_, run) => void (run.Config.Labels["org.hapi.sidecar"] = "bun-big"));
      expect([small.status, small.detail.includes("its pids limit is 128, not 256"), small.detail.includes(`its memory limit is ${512 * 1024 ** 2}, not ${1024 ** 3}`)]).toEqual(["fail", true, true]);
      // And bun-big's limits under a run that names bun-http fail against bun-http's.
      const named = await withSidecar("verify", (sc) => void (sc.HostConfig!.PidsLimit = 256));
      expect([named.status, named.detail.includes("its pids limit is 256, not 128")]).toEqual(["fail", true]);
      // Another policy sidecar's image under a run that names bun-http is not bun-http's.
      const other = `example/postgres:17@sha256:${"c".repeat(64)}`;
      const pg = `  postgres:\n    image: ${other}\n    command: ["postgres"]\n    port: 5432\n    limits: { pids: 128, memory_mb: 512, data_files: 256, data_mb: 16 }\n`;
      writeFileSync(join(dir, "sidecars.yaml"), `${text}${big}${pg}`);
      const swapped = await withSidecar("verify", (sc) => void (sc.Config.Image = other));
      expect([swapped.status, swapped.detail.includes(`runs ${other}, not policy's bun-http image ${SIDECAR_IMAGE}`)]).toEqual(["fail", true]);
    }, 30_000);

    test("the run's network holds its sidecar exactly when the run says it has one: none declared and one there, one declared and none there, or an endpoint that isn't its sidecar each fail", async () => {
      const N = RUN;
      const cases: [what: string, make: (w: World) => Container[], part: string][] = [
        [
          "a sidecar the run doesn't declare",
          (w) => {
            const run = runContainer(w, R, { kind: "verify", sidecar: "bun-http" });
            delete run.Config.Labels["org.hapi.sidecar"];
            return [run, sidecarContainer(R)];
          },
          `its network ${N} holds hapi-egress-archon-1, ${N}, ${N}-sidecar, not exactly hapi-egress-archon-1 and ${N}`,
        ],
        ["a declared sidecar that isn't there", (w) => [runContainer(w, R, { kind: "verify", sidecar: "bun-http" })], `its network ${N}'s endpoint ${N}-sidecar is not its run's sidecar`],
        [
          "a declared sidecar's endpoint taken by another container",
          (w) => {
            const run = runContainer(w, R, { kind: "verify", sidecar: "bun-http" });
            const other = helperContainer("copyout", R, "quirky_name");
            other.Id = `id-sidecar-${R}`;
            return [run, other];
          },
          `its network ${N}'s endpoint ${N}-sidecar is not its run's sidecar`,
        ],
        [
          "a declared sidecar not on the network",
          (w) => {
            const run = runContainer(w, R, { kind: "verify", sidecar: "bun-http" });
            delete w.networks.get(N)!.Containers[`id-sidecar-${R}`];
            return [run, sidecarContainer(R)];
          },
          `its network ${N} holds hapi-egress-archon-1, ${N}, not exactly hapi-egress-archon-1, ${N} and ${N}-sidecar`,
        ],
        [
          "an unexpected third endpoint",
          (w) => {
            const run = runContainer(w, R, { kind: "worker" });
            w.networks.get(N)!.Containers["id-hapi-hermes-1"] = { Name: "hapi-hermes-1" };
            return [run];
          },
          `its network ${N} holds hapi-egress-archon-1, hapi-hermes-1, ${N}, not exactly hapi-egress-archon-1 and ${N}`,
        ],
        [
          "a review that says it has a sidecar",
          (w) => [runContainer(w, R, { kind: "review", sidecar: "bun-http" }), sidecarContainer(R)],
          `${N}: carries org.hapi.sidecar=bun-http, but a review run has no sidecar`,
        ],
      ];
      for (const [what, make, part] of cases) {
        const w = await cleanWorld();
        w.containers.push(...make(w));
        const r = await check(w, "runtime.run-container");
        expect([what, r.status, r.detail.includes(part)]).toEqual([what, "fail", true]);
      }
      // Without a sidecar, a run's network holds exactly the run and its proxy, as before.
      const plain = await cleanWorld();
      plain.containers.push(runContainer(plain, R, { kind: "verify" }));
      expect((await check(plain, "runtime.run-container")).status).toBe("pass");
    });

    test("each policy sidecar's definition (sidecarArgs) is checked with no Docker needed: a dropped hardening flag, a limit other than policy's or a writable /data fails, naming the sidecar", async () => {
      const ok = await cleanWorld();
      ok.dockerDown = true;
      const r = await check(ok, "runtime.run-container");
      expect([r.status, r.detail.includes("each of policy/sidecars.yaml's 1 sidecars (sidecarArgs, src/run/sidecar.ts) runs read-only as 1001:1001")]).toEqual(["pass", true]);
      const real = sidecar.sidecarArgs;
      const cases: [what: string, edit: (argv: string[]) => string[], part: string][] = [
        ["no --read-only", (argv) => argv.filter((a) => a !== "--read-only"), "bun-http: its root filesystem is not read-only"],
        ["a raised pids limit", (argv) => argv.map((a, i) => (argv[i - 1] === "--pids-limit" ? "4096" : a)), "bun-http: its pids limit is 4096, not policy's 128"],
        ["a writable /data", (argv) => argv.map((a) => a.replace(":/data:ro", ":/data")), "bun-http: its data is not its one bind, read-only at /data"],
        ["a key passed by name", (argv) => [...argv.slice(0, argv.indexOf("--entrypoint")), "-e", "ANTHROPIC_API_KEY", ...argv.slice(argv.indexOf("--entrypoint"))], "bun-http: it passes ANTHROPIC_API_KEY, a key, to a container that holds none"],
      ];
      for (const [what, edit, part] of cases) {
        const spy = spyOn(sidecar, "sidecarArgs").mockImplementation((...a) => edit(real(...a)));
        try {
          const w = await cleanWorld();
          w.dockerDown = true;
          const bad = await check(w, "runtime.run-container");
          expect([what, bad.status, bad.detail.includes(`the sidecar definition (sidecarArgs, src/run/sidecar.ts) of policy/sidecars.yaml's ${part}`)]).toEqual([what, "fail", true]);
        } finally {
          spy.mockRestore();
        }
      }
    });

    test("only a container named <run>-sidecar labelled org.hapi.kind=sidecar is a sidecar: one under another name, or without the label, is a stray", async () => {
      const cases: [what: string, edit: (sc: Container) => void, part: string][] = [
        ["another name", (sc) => void (sc.Name = "/nifty_name"), `nifty_name: carries org.hapi.run=${R} but is neither its run's container (${RUN}), its run's sidecar (${RUN}-sidecar) nor a hapi helper`],
        ["no kind label", (sc) => void delete sc.Config.Labels["org.hapi.kind"], `${RUN}-sidecar: carries org.hapi.run=${R} but is neither`],
        ["another run's id", (sc) => void (sc.Config.Labels["org.hapi.run"] = "bbbbbbbbbbbb"), `${RUN}-sidecar: carries org.hapi.run=bbbbbbbbbbbb but is neither`],
      ];
      const { withSidecar } = await sidecarWorld();
      for (const [what, edit, part] of cases) {
        const r = await withSidecar("verify", edit);
        expect([what, r.status, r.detail.includes(part)]).toEqual([what, "fail", true]);
      }
      expect(SIDECAR_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    }, 30_000);
  });

  describe("what a container labelled org.hapi.run is: a run's own, a hapi helper, or a stray, which fails", () => {
    const VALUE = ["fake", "audit", "helper", "key", "0123456789"].join("-");
    /** The run id `helperContainer` labels a chown or cleanup helper with by default. */
    const HELPER_RUN = "ab12cd34ef56";
    /** `c`, changed by `f`. */
    const edited = (c: Container, f: (c: Container) => void) => (f(c), c);

    test("a copy-out, chown or cleanup helper caught mid-flight is held to the helpers' invariants, not a kind's definition, and isn't counted as a run", async () => {
      const w = await cleanWorld();
      w.containers.push(runContainer(w, "cccccccccccc"), helperContainer("copyout", "cccccccccccc", "nifty_copy"), helperContainer("chown", "dddddddddddd", "nifty_chown"), helperContainer("clean", "eeeeeeeeeeee", "nifty_clean"));
      const r = await check(w, "runtime.run-container");
      expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("1 live run container is as its kind's definition says")]);
      expect(r.detail).toContain("and 3 helpers as the helpers are made");
      // Each alone passes too: the chown helper's CAP_CHOWN is the one capability a helper may add.
      for (const kind of ["copyout", "chown", "clean"] as const) {
        const v = await cleanWorld();
        v.containers.push(helperContainer(kind));
        expect([kind, (await check(v, "runtime.run-container")).status]).toEqual([kind, "pass"]);
      }
    });

    test("a container labelled org.hapi.run that is neither its run's container nor a hapi helper fails: another name, a bare label, an unknown helper", async () => {
      const cases: [what: string, make: (w: World) => Container, part: string][] = [
        ["its run's id under another name", (w) => edited(runContainer(w, "aaaaaaaaaaaa"), (c) => void (c.Name = "/hapi-run-aaaaaaaaaaaa-copy")), "hapi-run-aaaaaaaaaaaa-copy: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa), its run's sidecar (hapi-run-aaaaaaaaaaaa-sidecar) nor a hapi helper"],
        ["its run's id under a random name", (w) => edited(runContainer(w, "aaaaaaaaaaaa"), (c) => void (c.Name = "/nifty_name")), "nifty_name: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa), its run's sidecar (hapi-run-aaaaaaaaaaaa-sidecar) nor a hapi helper"],
        [
          "a bare org.hapi.run with no helper label",
          () => edited(helperContainer("copyout"), (c) => delete c.Config.Labels["org.hapi.helper"]),
          "quirky_name: carries org.hapi.run=(empty) but is neither its run's container (a run's name), its run's sidecar nor a hapi helper",
        ],
        ["a helper label that names no helper", () => edited(helperContainer("clean"), (c) => void (c.Config.Labels["org.hapi.helper"] = "other")), `quirky_name: carries org.hapi.run=${HELPER_RUN} but is neither`],
        [
          // The re-review's case: a labelled container on the default bridge, holding a key, with no capability dropped and a writable root.
          "a labelled /evil on bridge holding a key",
          (w) => {
            const c = runContainer(w, "aaaaaaaaaaaa", { kind: "verify" });
            c.Name = "/evil";
            c.HostConfig!.NetworkMode = "bridge";
            c.NetworkSettings = { Networks: { bridge: {} } };
            c.Config.Env.push(`ANTHROPIC_API_KEY=${VALUE}`);
            c.HostConfig!.CapDrop = [];
            c.HostConfig!.ReadonlyRootfs = false;
            return c;
          },
          "evil: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa), its run's sidecar (hapi-run-aaaaaaaaaaaa-sidecar) nor a hapi helper",
        ],
      ];
      for (const [what, make, part] of cases) {
        const w = await cleanWorld();
        w.containers.push(make(w));
        const r = await check(w, "runtime.run-container");
        expect([what, r.status, r.detail.includes(part)]).toEqual([what, "fail", true]);
        expect([what, r.detail.includes(VALUE)]).toEqual([what, false]);
      }
    });

    test("a helper fails unless it is on no network, holds no zone key, is --rm with a read-only root, drops ALL and adds no capability but chown's CHOWN", async () => {
      const cases: [what: string, make: () => Container, part: string][] = [
        [
          "a copy-out helper on a run's network",
          () => {
            const c = helperContainer("copyout");
            c.HostConfig!.NetworkMode = "hapi-run-ab12cd34ef56";
            c.NetworkSettings = { Networks: { "hapi-run-ab12cd34ef56": {} } };
            return c;
          },
          "a helper is on no network, but its network is hapi-run-ab12cd34ef56 and it is on hapi-run-ab12cd34ef56",
        ],
        [
          "a chown helper on bridge",
          () => {
            const c = helperContainer("chown");
            c.HostConfig!.NetworkMode = "bridge";
            c.NetworkSettings = { Networks: { bridge: {} } };
            return c;
          },
          "a helper is on no network, but its network is bridge and it is on bridge",
        ],
        ["a cleanup helper holding a zone key", () => edited(helperContainer("clean"), (c) => void c.Config.Env.push(`OPENCODE_API_KEY=${VALUE}`)), "OPENCODE_API_KEY is set: a helper holds no key"],
        ["one that isn't --rm", () => edited(helperContainer("copyout"), (c) => void (c.HostConfig!.AutoRemove = false)), "it isn't --rm (HostConfig.AutoRemove)"],
        ["a writable root", () => edited(helperContainer("copyout"), (c) => void (c.HostConfig!.ReadonlyRootfs = false)), "its root filesystem is not read-only"],
        ["no capability dropped", () => edited(helperContainer("clean"), (c) => void (c.HostConfig!.CapDrop = [])), "it does not drop ALL capabilities"],
        ["a copy-out helper adding CHOWN", () => edited(helperContainer("copyout"), (c) => void (c.HostConfig!.CapAdd = ["CAP_CHOWN"])), "it adds CHOWN, where a copyout helper may add none"],
        ["a chown helper adding SYS_ADMIN too", () => edited(helperContainer("chown"), (c) => void (c.HostConfig!.CapAdd = ["CAP_CHOWN", "CAP_SYS_ADMIN"])), "it adds CHOWN, SYS_ADMIN, where a chown helper may add CHOWN"],
      ];
      for (const [what, make, part] of cases) {
        const w = await cleanWorld();
        w.containers.push(make());
        const r = await check(w, "runtime.run-container");
        expect([what, r.status, r.detail.includes(`quirky_name: ${part}`)]).toEqual([what, "fail", true]);
        expect([what, r.detail.includes(VALUE)]).toEqual([what, false]);
      }
    });

    test("D50, D49: a helper's user, mounts, no-new-privileges and privilege are as its kind makes it", async () => {
      const cases: [what: string, make: () => Container, part: string][] = [
        ["a copy-out helper as root", () => edited(helperContainer("copyout"), (c) => void (c.Config.User = "0:0")), "it runs as 0:0, not 1001:1001, as a copyout helper does"],
        ["a chown helper as 1001", () => edited(helperContainer("chown"), (c) => void (c.Config.User = "1001:1001")), "it runs as 1001:1001, not 0:0, as a chown helper does"],
        ["a cleanup helper with no user", () => edited(helperContainer("clean"), (c) => void (c.Config.User = "")), "it runs as (the image's user), not 1001:1001, as a clean helper does"],
        ["a copy-out helper writing /out", () => edited(helperContainer("copyout"), (c) => void (c.Mounts![0]!.RW = true)), "its mounts are not exactly a run's out volume (hapi-run-<id>-out) at /out, read-only"],
        ["a copy-out helper with a second mount", () => edited(helperContainer("copyout"), (c) => void c.Mounts!.push({ Type: "bind", Source: "/home/hapi", Destination: "/h", RW: false })), "its mounts are not exactly a run's out volume (hapi-run-<id>-out) at /out, read-only"],
        ["a chown helper on another run's volume", () => edited(helperContainer("chown"), (c) => void (c.Mounts![0]!.Name = "hapi-run-ffffffffffff-work")), "its mounts are not exactly its run's volumes hapi-run-ab12cd34ef56-work at /w and hapi-run-ab12cd34ef56-out at /o"],
        ["a cleanup helper outside the run disk", () => edited(helperContainer("clean"), (c) => void (c.Mounts![0]!.Source = "/home/hapi/.ssh")), "its mounts are not only its run's dirs on the run disk (/var/lib/hapi/rundisk/hapi-run-ab12cd34ef56-work at /w, -out at /o)"],
        ["no no-new-privileges", () => edited(helperContainer("chown"), (c) => void (c.HostConfig!.SecurityOpt = [])), "no-new-privileges:true is not set"],
        ["a privileged helper", () => edited(helperContainer("copyout"), (c) => void (c.HostConfig!.Privileged = true)), "it is privileged (--privileged)"],
      ];
      for (const [what, make, part] of cases) {
        const w = await cleanWorld();
        w.containers.push(make());
        const r = await check(w, "runtime.run-container");
        expect([what, r.status, r.detail]).toEqual([what, "fail", expect.stringContaining(`quirky_name: ${part}`)]);
      }
    });

    test("M11, D49: a run container that is privileged, or adds a capability, fails", async () => {
      for (const [what, edit, part] of [
        ["privileged", (c: Container) => void (c.HostConfig!.Privileged = true), "it is privileged (--privileged)"],
        ["an added capability", (c: Container) => void (c.HostConfig!.CapAdd = ["CAP_SYS_ADMIN"]), "it adds SYS_ADMIN, where a run container adds none"],
      ] as const) {
        const w = await cleanWorld();
        w.containers.push(edited(runContainer(w, "aaaaaaaaaaaa"), edit));
        const r = await check(w, "runtime.run-container");
        expect([what, r.status, r.detail]).toEqual([what, "fail", expect.stringContaining(`hapi-run-aaaaaaaaaaaa: ${part}`)]);
      }
    });

    test("D51: a run container with no Id fails: its endpoint can't be matched by id", async () => {
      const w = await cleanWorld();
      w.containers.push(runContainer(w, "aaaaaaaaaaaa"));
      // docker ps lists it, but its inspect carries no Id.
      const real = w.ctx.exec;
      w.ctx.exec = async (cmd) => {
        const r = await real(cmd);
        if (cmd[0] !== "docker" || cmd[1] !== "inspect") return r;
        const xs = JSON.parse(r.stdout) as Container[];
        return { ...r, stdout: JSON.stringify(xs.map((x) => (x.Name === "/hapi-run-aaaaaaaaaaaa" ? (({ Id: _, ...rest }) => rest)(x) : x))) };
      };
      const r = await check(w, "runtime.run-container");
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("hapi-run-aaaaaaaaaaaa: it has no container id, so its endpoint on hapi-run-aaaaaaaaaaaa can't be matched by id");
    });

    test("D44, D52: a stray's run name is never shown raw, a missing network mode says (none), and the live count reads right", async () => {
      const w = await cleanWorld();
      w.containers.push(edited(helperContainer("clean", "x$(id)y"), (c) => delete c.Config.Labels["org.hapi.helper"]));
      const r = await check(w, "runtime.run-container");
      expect(r.status).toBe("fail");
      expect(r.detail).not.toContain("$(id)");
      expect(r.detail).toContain("its run's container ((a value that is not shown))");
      const n = await cleanWorld();
      n.containers.push(edited(helperContainer("copyout"), (c) => delete c.HostConfig!.NetworkMode));
      expect((await check(n, "runtime.run-container")).detail).toContain("a helper is on no network, but its network is (none) and");
      const one = await cleanWorld();
      one.containers.push(runContainer(one, "aaaaaaaaaaaa"));
      expect((await check(one, "runtime.run-container")).detail).toContain("1 live run container is as its kind's definition says");
    });

    test("a container named hapi-run-<id> with a helper label still gets the whole run check", async () => {
      const w = await cleanWorld();
      const c = runContainer(w, "aaaaaaaaaaaa", { kind: "verify", labels: { "org.hapi.helper": "copyout" } });
      c.Config.Env.push(`ANTHROPIC_API_KEY=${VALUE}`);
      w.containers.push(c);
      const r = await check(w, "runtime.run-container");
      expect(r.status).toBe("fail");
      expect(r.detail).toContain("hapi-run-aaaaaaaaaaaa: ANTHROPIC_API_KEY is set: a verify container holds no key");
      // A helper's own shape under a run's name, with that run's id, is held to the run definition, and fails it.
      const v = await cleanWorld();
      v.containers.push(helperContainer("chown", "aaaaaaaaaaaa", "hapi-run-aaaaaaaaaaaa"));
      const u = await check(v, "runtime.run-container");
      expect(u.status).toBe("fail");
      expect(u.detail).toContain("hapi-run-aaaaaaaaaaaa: no tmpfs at /tmp");
    });
  });

  test("a stopped run container is not checked", async () => {
    const w = await cleanWorld();
    const live = runContainer(w);
    live.Mounts = [];
    live.State.Running = false;
    w.containers.push(live);
    expect((await check(w, "runtime.run-container")).status).toBe("pass");
  });

  test("run containers carry no Compose labels, so the stack's checks never see one as a service", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w));
    // The fake `docker ps` filters on labels as Docker does: the blank label doesn't match project=hapi.
    const r = await check(w, "runtime.hermes-no-yolo");
    expect(r.status).toBe("pass");
    const ps = w.calls.filter((c) => c[1] === "ps" && c.includes("label=com.docker.compose.project=hapi"));
    expect(ps.length).toBe(1);
  });
});

describe("runtime.hermes-no-yolo", () => {
  test("no yolo flag or variable, and approvals as policy says in the mounted config, passes", async () => {
    const r = await check(await cleanWorld(), "runtime.hermes-no-yolo");
    expect(r.status).toBe("pass");
  });

  test("--yolo in the container's argv fails", async () => {
    const w = await cleanWorld();
    svc(w, "hermes").Args = ["gateway", "run", "--yolo"];
    const r = await check(w, "runtime.hermes-no-yolo");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("--yolo");
  });

  test("HERMES_YOLO_MODE (or HERMES_YOLO) set in its env fails; set to 0 it doesn't", async () => {
    for (const [name, value, status] of [
      ["HERMES_YOLO_MODE", "1", "fail"],
      ["HERMES_YOLO_MODE", "true", "fail"],
      ["HERMES_YOLO", "yes", "fail"],
      ["HERMES_YOLO_MODE", "0", "pass"],
      ["HERMES_YOLO_MODE", "", "pass"],
    ] as const) {
      const w = await cleanWorld();
      setEnv(svc(w, "hermes"), name, value);
      const r = await check(w, "runtime.hermes-no-yolo");
      expect([name, value, r.status]).toEqual([name, value, status]);
      if (status === "fail") expect(r.detail).toContain(name);
    }
  });

  test("HERMES_KANBAN_DISPATCH_IN_GATEWAY set in its env fails, since it turns the Kanban dispatcher back on over the config; set to 0 it doesn't", async () => {
    for (const [value, status] of [["1", "fail"], ["true", "fail"], ["0", "pass"], ["", "pass"]] as const) {
      const w = await cleanWorld();
      setEnv(svc(w, "hermes"), "HERMES_KANBAN_DISPATCH_IN_GATEWAY", value);
      const r = await check(w, "runtime.hermes-no-yolo");
      expect([value, r.status]).toEqual([value, status]);
      if (status === "fail") expect(r.detail).toContain("HERMES_KANBAN_DISPATCH_IN_GATEWAY");
    }
  });

  test("a mounted config that leaves the Kanban dispatcher on fails: no kanban block, dispatch in the gateway, or dispatch_profiles not an empty list", async () => {
    const edits: [string, (text: string) => string, string][] = [
      ["no kanban block", (s) => s.replace(/^kanban:\n(?:  .*\n)+/m, ""), "kanban.dispatch_in_gateway"],
      ["dispatch_in_gateway: true", (s) => s.replace("dispatch_in_gateway: false", "dispatch_in_gateway: true"), "kanban.dispatch_in_gateway"],
      ["dispatch_profiles omitted", (s) => s.replace(/^  dispatch_profiles: \[\]\n/m, ""), "kanban.dispatch_profiles"],
      ["auto_decompose: true", (s) => s.replace("auto_decompose: false", "auto_decompose: true"), "kanban.auto_decompose"],
    ];
    for (const [what, edit, named] of edits) {
      const w = await cleanWorld();
      const file = join(w.build, "hermes", "config.yaml");
      const before = readFileSync(file, "utf8");
      writeFileSync(file, edit(before));
      expect([what, readFileSync(file, "utf8") !== before]).toEqual([what, true]);
      const r = await check(w, "runtime.hermes-no-yolo");
      expect([what, r.status]).toEqual([what, "fail"]);
      expect(r.detail).toContain(named);
    }
  });

  test("approvals.mode off fails, however YAML spells it (Hermes reads YAML 1.1, where a bare off or no is false)", async () => {
    for (const spelling of ["off", '"off"', "OFF", "no", "false"]) {
      const w = await cleanWorld();
      const file = join(w.build, "hermes", "config.yaml");
      writeFileSync(file, readFileSync(file, "utf8").replace("mode: manual", `mode: ${spelling}`));
      const r = await check(w, "runtime.hermes-no-yolo");
      expect([spelling, r.status]).toEqual([spelling, "fail"]);
      expect(r.detail).toContain("approvals.mode is off");
    }
  });

  test("an unattended approval mode that approves fails", async () => {
    const w = await cleanWorld();
    const file = join(w.build, "hermes", "config.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace("cron_mode: deny", "cron_mode: approve"));
    const r = await check(w, "runtime.hermes-no-yolo");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("approvals.cron_mode approves");
  });

  test("HERMES_HOME moved, or no config mounted read-only at $HERMES_HOME/config.yaml, fails", async () => {
    const w = await cleanWorld();
    setEnv(svc(w, "hermes"), "HERMES_HOME", "/tmp/elsewhere");
    let r = await check(w, "runtime.hermes-no-yolo");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("HERMES_HOME is not /opt/data");

    const v = await cleanWorld();
    svc(v, "hermes").Mounts = svc(v, "hermes").Mounts.filter((m) => m.Destination !== "/opt/data/config.yaml");
    r = await check(v, "runtime.hermes-no-yolo");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no read-only config mounted at /opt/data/config.yaml");
  });

  test("the stack not running is a skip", async () => {
    const w = await cleanWorld();
    w.containers.length = 0;
    const r = await check(w, "runtime.hermes-no-yolo");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("the stack is not running");
  });
});

describe("runtime.dev-override", () => {
  test("every container started by `hapi stack up` as hapi passes", async () => {
    const r = await check(await cleanWorld(), "runtime.dev-override");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("5 containers");
  });

  test("a stack started with HAPI_ALLOW_CURRENT_USER=1 fails in normal mode, naming who started it", async () => {
    const w = await cleanWorld();
    for (const c of w.containers) Object.assign(c.Config.Labels, { "org.hapi.dev-override": "1", "org.hapi.started-by": "operator" });
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("HAPI_ALLOW_CURRENT_USER=1");
    expect(r.detail).toContain("operator");
  });

  test("with --dev it is a skip, saying what it found and why it doesn't fail", async () => {
    const w = await cleanWorld();
    for (const c of w.containers) Object.assign(c.Config.Labels, { "org.hapi.dev-override": "1", "org.hapi.started-by": "operator" });
    w.ctx.dev = true;
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("--dev");
    expect(r.detail).toContain("operator");
  });

  test("`unknown` or an empty label means not started through `hapi stack up`, which fails, never reads as no bypass", async () => {
    for (const value of ["unknown", ""]) {
      const w = await cleanWorld();
      w.containers[0]!.Config.Labels["org.hapi.dev-override"] = value;
      const r = await check(w, "runtime.dev-override");
      expect([value, r.status]).toEqual([value, "fail"]);
      expect(r.detail).toContain("not started through `hapi stack up`");
    }
  });

  test("a `0` label from anyone but hapi fails: `up` sets 0 only for hapi", async () => {
    const w = await cleanWorld();
    w.containers[1]!.Config.Labels["org.hapi.started-by"] = "operator";
    expect((await check(w, "runtime.dev-override")).status).toBe("fail");
  });

  test("this shell's own HAPI_ALLOW_CURRENT_USER=1 (as a user other than hapi) fails too (currentUserOverride)", async () => {
    const w = await cleanWorld();
    w.ctx.user = "operator";
    w.ctx.env.HAPI_ALLOW_CURRENT_USER = "1";
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("this shell sets HAPI_ALLOW_CURRENT_USER=1");
  });

  test("live run containers are covered: a bypass or a launcher-less one fails, naming it", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w, "aaaaaaaaaaaa", { labels: { "org.hapi.dev-override": "1", "org.hapi.started-by": "operator" } }), runContainer(w, "bbbbbbbbbbbb", { labels: { "org.hapi.dev-override": "unknown" } }));
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("hapi-run-aaaaaaaaaaaa was started with HAPI_ALLOW_CURRENT_USER=1 by operator");
    expect(r.detail).toContain("hapi-run-bbbbbbbbbbbb was not started through `hapi stack up`");
  });

  test("a helper caught mid-flight carries no stack labels and is skipped; a stray labelled org.hapi.run is not", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w), helperContainer("copyout"), helperContainer("chown", "dddddddddddd", "nifty_chown"));
    const r = await check(w, "runtime.dev-override");
    expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("6 containers")]);
    const stray = helperContainer("clean");
    delete stray.Config.Labels["org.hapi.helper"];
    w.containers.push(stray);
    const s = await check(w, "runtime.dev-override");
    expect(s.status).toBe("fail");
    expect(s.detail).toContain("quirky_name was not started through `hapi stack up`");
  });

  test("D45, D46: a label value is never shown raw; a helper of another project isn't skipped", async () => {
    const edited = (c: Container, f: (c: Container) => void) => (f(c), c);
    const w = await cleanWorld();
    w.containers[0]!.Config.Labels["org.hapi.dev-override"] = "x\u001b[2Jy";
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("fail");
    expect(r.detail).not.toContain("\u001b");
    expect(r.detail).toContain("org.hapi.dev-override=(a value that is not shown)");
    const by = await cleanWorld();
    Object.assign(by.containers[0]!.Config.Labels, { "org.hapi.dev-override": "1", "org.hapi.started-by": "a`b" });
    expect((await check(by, "runtime.dev-override")).detail).toContain("by (a value that is not shown)");
    // A stack service that carries a helper's labels, of hapi's project or another, is held to the stack labels.
    for (const project of ["hapi", "elsewhere"]) {
      const other = await cleanWorld();
      const archon = svc(other, "hermes");
      Object.assign(archon.Config.Labels, { "org.hapi.run": "", "org.hapi.project": project, "org.hapi.helper": "copyout", "org.hapi.dev-override": "1", "org.hapi.started-by": "operator" });
      const o = await check(other, "runtime.dev-override");
      expect([project, o.status]).toEqual([project, "fail"]);
      expect(o.detail).toContain(`${archon.Name.replace(/^\//, "")} was started with HAPI_ALLOW_CURRENT_USER=1 by operator`);
    }
  });

  test("a run container started as hapi with no bypass is counted among the containers that pass", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w));
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("6 containers");
  });

  test("a run's smoke sidecar carries the launcher's started-by and dev-override labels (m24), so it is held to them like any container", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w, "aaaaaaaaaaaa", { sidecar: "bun-http" }), sidecarContainer("aaaaaaaaaaaa"));
    const r = await check(w, "runtime.dev-override");
    expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("7 containers")]);
    for (const [labels, part] of [
      [{ "org.hapi.dev-override": "1", "org.hapi.started-by": "operator" }, "hapi-run-aaaaaaaaaaaa-sidecar was started with HAPI_ALLOW_CURRENT_USER=1 by operator"],
      [{ "org.hapi.dev-override": "" }, "hapi-run-aaaaaaaaaaaa-sidecar was not started through `hapi stack up`"],
    ] as const) {
      const v = await cleanWorld();
      const sc = sidecarContainer("aaaaaaaaaaaa");
      Object.assign(sc.Config.Labels, labels);
      v.containers.push(runContainer(v, "aaaaaaaaaaaa", { sidecar: "bun-http" }), sc);
      const bad = await check(v, "runtime.dev-override");
      expect([bad.status, bad.detail.includes(part)]).toEqual(["fail", true]);
    }
  });

  test("the stack not running is a skip", async () => {
    const w = await cleanWorld();
    w.containers.length = 0;
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("the stack is not running");
  });
});

describe("runtime.run-disk", () => {
  test("runtime.run-disk passes a writable run disk of its own within runs.disk.gb, apart from Docker's data root", async () => {
    const w = await cleanWorld();
    const r = await check(w, "runtime.run-disk");
    expect([r.status, r.detail]).toEqual(["pass", "/var/lib/hapi/rundisk: its own filesystem, 19.5 GB of runs.disk.gb's 20, apart from Docker's data root (/home/hapi/.local/share/docker), writable"]);
    expect(w.calls).toContainEqual(["docker", "info", "--format", "{{.DockerRootDir}}"]);
  });

  test("runtime.run-disk fails a missing run disk with the launcher's own reason", async () => {
    const w = await cleanWorld();
    w.ctx.probeFs = (p) => (p === RUN_DISK ? undefined : goodDisks(p));
    const r = await check(w, "runtime.run-disk");
    const why = diskProblem(RUN_DISK, { gb: 20, enforcement: "hard" }, DOCKER_ROOT, w.ctx.probeFs);
    expect(why).toStartWith("the run disk /var/lib/hapi/rundisk does not exist");
    expect([r.status, r.detail]).toEqual(["fail", `${why}; runs.disk.enforcement is hard, so \`hapi run start\` refuses every run`]);
    // Too big, too: the same reason as the launcher's.
    const v = await cleanWorld();
    v.ctx.probeFs = (p) => (p === RUN_DISK ? { dev: 2, bytes: 64 * GIB, writable: true } : goodDisks(p));
    expect((await check(v, "runtime.run-disk")).detail).toStartWith("the run disk /var/lib/hapi/rundisk is 64.0 GB, more than runs.disk.gb (20)");
  });

  test("with runs.disk.enforcement soft, a failing run disk still fails: runs start without the cap", async () => {
    const w = await cleanWorld();
    const policy = join(tempDir("hapi-audit-policy-"), "policy");
    cpSync(join(REPO, "policy"), policy, { recursive: true });
    const runs = join(policy, "runs.yaml");
    writeFileSync(runs, readFileSync(runs, "utf8").replace(/^(disk:.*\n(?: .*\n)*?  enforcement:) hard/m, "$1 soft"));
    w.ctx.policyDir = policy;
    w.ctx.probeFs = (p) => (p === RUN_DISK ? { dev: 1, bytes: 19.5 * GIB, writable: true } : goodDisks(p));
    const r = await check(w, "runtime.run-disk");
    expect([r.status, r.detail]).toEqual([
      "fail",
      "the run disk /var/lib/hapi/rundisk is not its own filesystem (it shares /var/lib/hapi's): mount the run disk there (docs/runbooks/runs.md#the-run-disk); runs.disk.enforcement is soft, so `hapi run start` warns and starts every run anyway",
    ]);
  });

  test("runtime.run-disk skips without Docker", async () => {
    for (const how of ["throws", "daemon down"]) {
      const w = await cleanWorld();
      if (how === "throws") {
        const exec = w.ctx.exec;
        w.ctx.exec = async (cmd, o) => {
          if (cmd[0] === "docker") throw new Error("cannot run docker: is it installed and on PATH?");
          return exec(cmd, o);
        };
      } else w.dockerDown = true;
      const r = await check(w, "runtime.run-disk");
      expect([how, r.status]).toEqual([how, "skip"]);
      expect(r.detail).toStartWith("docker info failed");
    }
  });
});

describe("runtime.poller-timer", () => {
  const SHOW = ["systemctl", "--user", "show", "hapi-poll.timer", "--property=ActiveState"];
  /** The systemctl calls the audit made, each with the env assignments `env` was given before it. */
  const showCalls = (w: World) => w.calls.filter((c) => c[0] === "env" && c.includes("systemctl"));

  test("passes when hapi-poll.timer is active in hapi's user manager, asked with systemctlEnv's XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS (T20)", async () => {
    const w = await cleanWorld();
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["pass", "hapi-poll.timer is active in hapi's user manager"]);
    const xdg = w.ctx.env.XDG_RUNTIME_DIR!;
    expect(showCalls(w)).toEqual([["env", `XDG_RUNTIME_DIR=${xdg}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${xdg}/bus`, ...SHOW]]);
  });

  test("a DBUS_SESSION_BUS_ADDRESS already set is passed as it is", async () => {
    const w = await cleanWorld();
    w.ctx.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1001/bus";
    await check(w, "runtime.poller-timer");
    expect(showCalls(w)[0]).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus");
  });

  test("an inactive timer fails: no merged work order starts until it runs", async () => {
    const w = await cleanWorld();
    w.timer = { code: 0, out: "ActiveState=inactive\n" };
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["fail", "the stack is up, but hapi-poll.timer is inactive: no merged work order starts until it runs. `mise run up` starts it (docs/runbooks/stack.md)"]);
  });

  test("any other state fails the same way, naming it; an answer with no ActiveState fails too", async () => {
    for (const [out, says] of [
      ["ActiveState=failed\n", "hapi-poll.timer is failed"],
      ["Id=hapi-poll.timer\n", "systemctl --user show hapi-poll.timer printed no ActiveState"],
    ] as const) {
      const w = await cleanWorld();
      w.timer = { code: 0, out };
      const r = await check(w, "runtime.poller-timer");
      expect([out, r.status, r.detail]).toEqual([out, "fail", expect.stringContaining(says)]);
    }
  });

  test("run as another user it skips: the timer is in hapi's user manager", async () => {
    const w = await cleanWorld();
    w.ctx.user = "dev";
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["skip", "run the audit as hapi: hapi-poll.timer is in hapi's user manager (systemctl --user)"]);
    expect(showCalls(w)).toEqual([]);
  });

  test("under the dev bypass it skips: `mise run up` installs no timer then", async () => {
    const w = await cleanWorld();
    w.ctx.user = "dev";
    w.ctx.env.HAPI_ALLOW_CURRENT_USER = "1";
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["skip", "HAPI_ALLOW_CURRENT_USER=1: `mise run up` installs no poller timer under the dev bypass"]);
    expect(showCalls(w)).toEqual([]);
  });

  test("with no stack container it skips, as the other runtime checks do; with no Docker, saying so", async () => {
    const w = await cleanWorld();
    w.containers = [];
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["skip", "the stack is not running (no container of the Compose project hapi): `mise run up` starts it"]);
    const down = await cleanWorld();
    down.dockerDown = true;
    const d = await check(down, "runtime.poller-timer");
    expect([d.status, d.detail.toLowerCase()]).toEqual(["skip", expect.stringContaining("docker")]);
    expect(showCalls(w)).toEqual([]);
  });

  test("M15: a stack whose containers are all stopped is not up: it skips, asking nothing", async () => {
    const w = await cleanWorld();
    for (const c of w.containers) c.State = { Running: false };
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["skip", "the stack is not running (no container of the Compose project hapi): `mise run up` starts it"]);
    expect(showCalls(w)).toEqual([]);
  });

  test("when systemctl exits non-zero, or can't be run, it skips, naming the first line of its error", async () => {
    const w = await cleanWorld();
    w.timer = { code: 1, out: "Failed to connect to bus: No medium found\nmore\n" };
    const r = await check(w, "runtime.poller-timer");
    expect([r.status, r.detail]).toEqual(["skip", "cannot ask hapi's user manager: systemctl --user show hapi-poll.timer exited 1: Failed to connect to bus: No medium found"]);
    const t = await cleanWorld();
    const real = t.ctx.exec;
    t.ctx.exec = async (cmd, o) => {
      if (cmd.includes("systemctl")) throw new Error("cannot run env: is it installed and on PATH?");
      return real(cmd, o);
    };
    const e = await check(t, "runtime.poller-timer");
    expect([e.status, e.detail]).toEqual(["skip", "cannot ask hapi's user manager: cannot run env: is it installed and on PATH?"]);
  });
});
