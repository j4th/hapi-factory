/**
 * The runtime.* checks read the running containers (`docker inspect`):
 * Archon's environment and read-only mounts, Hermes's effective approval
 * settings (its argv, its env and the config mounted at $HERMES_HOME), and the
 * labels `hapi stack up` puts on every container (the dev bypass).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { cleanup, cleanWorld, type Container, only } from "./helpers";

afterEach(cleanup);

type World = Awaited<ReturnType<typeof cleanWorld>>;
const check = async (w: World, id: string) => only(await runAudit(w.ctx), id);
const svc = (w: World, service: string) => w.containers.find((c) => c.Config.Labels["com.docker.compose.service"] === service)!;
const setEnv = (c: Container, name: string, value: string | undefined) => {
  c.Config.Env = c.Config.Env.filter((e) => !e.startsWith(`${name}=`));
  if (value !== undefined) c.Config.Env.push(`${name}=${value}`);
};

describe("runtime.archon-env", () => {
  test("the running archon has every value of serviceEnvironment(\"archon\"), and its Pi agent dir and config are read-only", async () => {
    const r = await check(await cleanWorld(), "runtime.archon-env");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("hapi-archon-1");
  });

  test("a different or missing value fails, naming the variable and the value policy sets, never the running one", async () => {
    const w = await cleanWorld();
    setEnv(svc(w, "archon"), "PI_TELEMETRY", "1");
    setEnv(svc(w, "archon"), "PI_OFFLINE", undefined);
    const r = await check(w, "runtime.archon-env");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("PI_TELEMETRY is not 0");
    expect(r.detail).toContain("PI_OFFLINE is not set");
    expect(r.detail).not.toContain("PI_TELEMETRY=1");
  });

  test("a writable Pi agent dir fails (Global Constraints: read-only PI_CODING_AGENT_DIR)", async () => {
    const w = await cleanWorld();
    svc(w, "archon").Mounts.find((m) => m.Destination === "/opt/hapi/pi-agent")!.RW = true;
    const r = await check(w, "runtime.archon-env");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/opt/hapi/pi-agent is not mounted read-only");
  });

  test("archon not running is a skip", async () => {
    const w = await cleanWorld();
    svc(w, "archon").State.Running = false;
    const r = await check(w, "runtime.archon-env");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("archon is not running");
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

  test("the stack not running is a skip", async () => {
    const w = await cleanWorld();
    w.containers.length = 0;
    const r = await check(w, "runtime.dev-override");
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("the stack is not running");
  });
});
