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
import * as spec from "../../src/run/spec";
import { cleanup, cleanWorld, type Container, DOCKER_ROOT, goodDisks, helperContainer, type Kind, only, REPO, REVIEW_ZONE_KEYS, runContainer, tempDir } from "./helpers";

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

    test("with no zoneKeys in its context, the zones are stack/secrets.yaml's: until the review zone is there, a review container holding a key fails", async () => {
      const w = await cleanWorld();
      delete w.ctx.zoneKeys;
      const review = runContainer(w, "aaaaaaaaaaaa", { kind: "review" });
      setEnv(review, "ANTHROPIC_API_KEY", VALUE);
      const worker = runContainer(w, "bbbbbbbbbbbb", { kind: "worker" });
      setEnv(worker, "OPENCODE_API_KEY", VALUE);
      w.containers.push(review, worker);
      const r = await check(w, "runtime.run-container");
      expect(r.detail).toContain("hapi-run-aaaaaaaaaaaa: ANTHROPIC_API_KEY is set: a review container holds only its zone's keys");
      expect(r.detail).not.toContain("hapi-run-bbbbbbbbbbbb");
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
      expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("1 live run containers are as their kind's definition says")]);
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
        ["its run's id under another name", (w) => edited(runContainer(w, "aaaaaaaaaaaa"), (c) => void (c.Name = "/hapi-run-aaaaaaaaaaaa-copy")), "hapi-run-aaaaaaaaaaaa-copy: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa) nor a hapi helper"],
        ["its run's id under a random name", (w) => edited(runContainer(w, "aaaaaaaaaaaa"), (c) => void (c.Name = "/nifty_name")), "nifty_name: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa) nor a hapi helper"],
        [
          "a bare org.hapi.run with no helper label",
          () => edited(helperContainer("copyout"), (c) => delete c.Config.Labels["org.hapi.helper"]),
          "quirky_name: carries org.hapi.run=(empty) but is neither its run's container (a run's name) nor a hapi helper",
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
          "evil: carries org.hapi.run=aaaaaaaaaaaa but is neither its run's container (hapi-run-aaaaaaaaaaaa) nor a hapi helper",
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
    expect(r.detail).toContain("4 containers");
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
    expect([r.status, r.detail]).toEqual(["pass", expect.stringContaining("5 containers")]);
    const stray = helperContainer("clean");
    delete stray.Config.Labels["org.hapi.helper"];
    w.containers.push(stray);
    const s = await check(w, "runtime.dev-override");
    expect(s.status).toBe("fail");
    expect(s.detail).toContain("quirky_name was not started through `hapi stack up`");
  });

  test("a run container started as hapi with no bypass is counted among the containers that pass", async () => {
    const w = await cleanWorld();
    w.containers.push(runContainer(w));
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("5 containers");
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
