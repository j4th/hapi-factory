/**
 * The runtime.* checks read the running containers (`docker inspect`):
 * the run container's definition (and any live run's mounts and environment),
 * Hermes's effective approval settings (its argv, its env and the config
 * mounted at $HERMES_HOME), and the labels `hapi stack up` puts on every
 * container (the dev bypass).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import * as spec from "../../src/run/spec";
import { cleanup, cleanWorld, type Container, only, runContainer } from "./helpers";

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
    live.Mounts = live.Mounts.filter((m) => m.Destination !== "/.archon/.env" && !(m.Type === "tmpfs" && m.Destination === "/opt/hapi/pi-agent"));
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
