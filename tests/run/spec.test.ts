/**
 * The run container's `docker run` arguments (src/run/spec.ts): built from
 * stack/compose.yaml's profile-only archon service and the run's inputs, in a
 * fixed order, with every secret passed by name only. Pure: nothing runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runDeps } from "../../src/run/cli";
import { runArgs, type RunInputs, runName, STOP_GRACE_S, TRANSLATED_KEYS } from "../../src/run/spec";
import { type ComposeService, composeServices } from "../../src/stack/compose";
import { serviceEnvironment } from "../../src/stack/env";
import { buildDigest, PROJECT_LABEL, RUN_LABEL } from "../../src/stack/up";
import type { WorkOrder } from "../../src/workorder/validate";
import { cleanup } from "../secrets/helpers";
import { REPO } from "../stack/helpers";
import { BUILD_FILES, fakeRun, fakeSecret, SHA } from "./helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const ORDER = { id: "0003-check-run", workflow: "hapi-check-run", trace: { traceparent: TRACEPARENT }, budget: { usd: 3, turns: 10, minutes: 30 } } as WorkOrder;
const archon = async (): Promise<ComposeService> => (await composeServices(REPO)).archon!;

function inputs(over: Partial<RunInputs> = {}): RunInputs {
  return { runId: ID, repo: "/srv/src/.git", sha: SHA, workOrder: ORDER, public: false, budgetUsd: 3, packDir: join(REPO, "archon", "workflows", "hapi"), ...over };
}

describe("runArgs", () => {
  test("the argv, exactly and in order: name and labels, the hardening, its own network, the tmpfs mounts, the read-only binds, the volumes, the environment, the secrets by name, then the prelude", async () => {
    const f = fakeRun();
    const N = runName("hapi", ID);
    expect(N).toBe(`hapi-run-${ID}`);
    const digest = buildDigest(Object.keys(BUILD_FILES).map((p) => `build/${p}`), f.tmp);
    const pi = (x: string) => `${join(f.deps.buildDir, "pi", x)}:/opt/hapi/pi-agent/${x}:ro`;
    const ar = (x: string, dest: string) => `${join(f.deps.buildDir, "archon", x)}:${dest}:ro`;
    expect(runArgs(await archon(), inputs(), f.deps, ["ANTHROPIC_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY"])).toEqual([
      "docker", "run", "-d", "--pull", "never", "--name", N,
      "--label", `org.hapi.run=${ID}`, "--label", "org.hapi.project=hapi",
      "--label", "org.hapi.stack=hapi-factory", "--label", "org.hapi.started-by=hapi", "--label", "org.hapi.dev-override=0", "--label", `org.hapi.build-sha256=${digest}`,
      "--label", "com.docker.compose.project=", "--label", "com.docker.compose.service=", "--label", "com.docker.compose.version=",
      "--user", "1001:1001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "2048", "--memory", "4g",
      "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "--stop-timeout", "30", "--network", N,
      "--tmpfs", "/tmp:size=1g,uid=1001,gid=1001,mode=1777",
      "--tmpfs", "/home/appuser:size=256m,uid=1001,gid=1001,mode=0700",
      "--tmpfs", "/.archon:size=512m,uid=1001,gid=1001,mode=0700",
      "--tmpfs", "/opt/hapi/pi-agent:size=64m,uid=1001,gid=1001,mode=0700",
      "-v", pi("models.json"), "-v", pi("models-store.json"), "-v", pi("hapi-guard.json"), "-v", pi("settings.json"), "-v", pi("extensions"),
      "-v", ar("config.yaml", "/.archon/config.yaml"), "-v", ar("empty.env", "/.archon/.env"), "-v", `${join(REPO, "archon", "workflows", "hapi")}:/.archon/workflows/hapi:ro`,
      "-v", ar("run-config.yaml", "/opt/hapi/run-config.yaml"), "-v", ar("gitconfig", "/home/appuser/.gitconfig"),
      "-v", `${join(REPO, "stack", "archon", "run.sh")}:/opt/hapi/run.sh:ro`,
      "-v", `${join(f.deps.stateDir, ID, "run.json")}:/run/hapi/run.json:ro`,
      "-v", "/srv/src/.git:/src/repo.git:ro",
      "-v", `${N}-work:/work`, "-v", `${N}-out:/out`,
      ...Object.entries(serviceEnvironment("archon")).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-e", "ANTHROPIC_API_KEY", "-e", "HAPI_JEV_OPENROUTER_API_KEY",
      "-w", "/app", "--entrypoint", "sh", "hapi-factory/archon:0.12.1", "/opt/hapi/run.sh", "hapi-check-run", SHA, "0003-check-run", TRACEPARENT,
    ]);
  });

  test("the labels say who started the run and whether the dev bypass did, as up's do", async () => {
    const f = fakeRun({ user: "dev", env: { HAPI_ALLOW_CURRENT_USER: "1", HOME: "/home/dev" } });
    const argv = runArgs(await archon(), inputs(), f.deps, []);
    expect(argv).toContain("org.hapi.started-by=dev");
    expect(argv).toContain("org.hapi.dev-override=1");
    // A changed generated file changes the digest label.
    const before = argv.find((a) => a.startsWith("org.hapi.build-sha256="));
    await Bun.write(join(f.deps.buildDir, "pi", "models.json"), '{"providers":{"edited":{}}}\n');
    expect(runArgs(await archon(), inputs(), f.deps, []).find((a) => a.startsWith("org.hapi.build-sha256="))).not.toBe(before);
  });

  test("the image's Compose labels are blanked, so compose-label tools never see a run as the archon service", async () => {
    // The Compose-built image carries these three (docker image inspect hapi-factory/archon:0.12.1), and a container inherits its image's labels.
    const argv = runArgs(await archon(), inputs(), fakeRun().deps, []);
    for (const k of ["project", "service", "version"]) expect(argv).toContain(`com.docker.compose.${k}=`);
    expect(argv.filter((a) => a.startsWith("com.docker.compose.")).every((a) => a.endsWith("="))).toBe(true);
  });

  test("test-project runs are named <project>-run-<id> and carry org.hapi.int", async () => {
    const project = "hapi-int-ab12cd34";
    const f = fakeRun({ project });
    const N = runName(project, ID);
    expect(N).toBe(`${project}-run-${ID}`);
    const argv = runArgs(await archon(), inputs(), f.deps, []);
    expect(argv.slice(0, 13)).toEqual(["docker", "run", "-d", "--pull", "never", "--name", N, "--label", `${RUN_LABEL}=${ID}`, "--label", `${PROJECT_LABEL}=${project}`, "--label", `org.hapi.int=${project}`]);
    expect(argv).toContain(`${N}-work:/work`);
    expect(argv[argv.indexOf("--network") + 1]).toBe(N);
    // hapi's own runs carry no org.hapi.int.
    expect(runArgs(await archon(), inputs(), fakeRun().deps, []).some((a) => a.startsWith("org.hapi.int="))).toBe(false);
  });

  test("packDir defaults to <root>/archon/workflows/hapi, and a test passes its own", async () => {
    const f = fakeRun();
    const d = await runDeps({ root: REPO, env: f.deps.env, user: "hapi", run: f.deps.run });
    expect(d.packDir).toBe(join(REPO, "archon", "workflows", "hapi"));
    expect(runArgs(await archon(), inputs({ packDir: "/srv/fixtures/run-pack" }), f.deps, [])).toContain("/srv/fixtures/run-pack:/.archon/workflows/hapi:ro");
  });

  test("no secret value appears in argv: each secret is `-e NAME`, its value left to the docker CLI's own env", async () => {
    const f = fakeRun();
    const secrets = { ANTHROPIC_API_KEY: fakeSecret("ANTHROPIC_API_KEY") };
    const argv = runArgs(await archon(), inputs(), f.deps, Object.keys(secrets));
    expect(argv.join("\n")).not.toContain(secrets.ANTHROPIC_API_KEY);
    expect(argv.filter((a, i) => argv[i - 1] === "-e" && a.startsWith("ANTHROPIC_API_KEY"))).toEqual(["ANTHROPIC_API_KEY"]);
  });

  test("a secret may not shadow the service's environment or take a reserved name", async () => {
    const f = fakeRun();
    const service = await archon();
    for (const name of ["PI_OFFLINE", "HTTPS_PROXY", "GIT_CONFIG_COUNT", "LD_PRELOAD"]) {
      expect(() => runArgs(service, inputs(), f.deps, [name])).toThrow(`the archon zone's env file: ${name} is reserved`);
    }
    expect(() => runArgs(service, inputs(), f.deps, ["lower_case"])).toThrow(/the archon zone's env file holds a name that is not an env name/);
  });

  test("a service key outside TRANSLATED_KEYS is refused", async () => {
    const f = fakeRun();
    const service = await archon();
    for (const key of Object.keys(service)) expect([key, TRANSLATED_KEYS.includes(key)]).toEqual([key, true]);
    for (const key of ["ports", "cap_add", "privileged", "network_mode", "volumes", "command"]) {
      expect(() => runArgs({ ...service, [key]: ["x"] }, inputs(), f.deps, [])).toThrow(
        `stack/compose.yaml: archon: key "${key}" isn't translated into the run container; add it to src/run/spec.ts or remove it`,
      );
    }
  });

  test("a value the launcher can't translate faithfully is refused, naming the key", async () => {
    const f = fakeRun();
    const s = await archon();
    const env = s.environment as Record<string, unknown>;
    const cases: [ComposeService, RegExp][] = [
      [{ ...s, restart: "unless-stopped" }, /archon: restart is "unless-stopped": a run container is one-shot, so it must be "no"/],
      [{ ...s, user: "0:0" }, /archon: user is "0:0": the run container runs as 1001:1001/],
      [{ ...s, environment: { ...env, HOST_VALUE: null } }, /archon: environment HOST_VALUE has no value/],
      [{ ...s, environment: { ...env, FROM_SHELL: "${HOME}" } }, /archon: environment FROM_SHELL holds a Compose interpolation/],
      [{ ...s, environment: ["A=1"] }, /archon: environment must be a mapping/],
      [{ ...s, labels: { ...(s.labels as object), "org.hapi.other": "${X:-y}" } }, /archon: label "org.hapi.other" holds a Compose interpolation/],
      [{ ...s, logging: { driver: "json-file", options: { "max-size": "10m" }, extra: 1 } }, /archon: logging key "extra" isn't translated/],
    ];
    for (const [service, error] of cases) expect(() => runArgs(service, inputs(), f.deps, [])).toThrow(error);
  });

  describe("a service without one of the hardening keys is refused, naming it (final review B-2)", () => {
    const cases: [string, (s: ComposeService) => ComposeService, string][] = [
      ["read_only", ({ read_only: _, ...s }) => s, "read_only is undefined: the run container's root filesystem must be read-only (read_only: true)"],
      ["read_only false", (s) => ({ ...s, read_only: false }), "read_only is false: the run container's root filesystem must be read-only (read_only: true)"],
      ["cap_drop", ({ cap_drop: _, ...s }) => s, "cap_drop does not include ALL: the run container drops every capability"],
      ["cap_drop without ALL", (s) => ({ ...s, cap_drop: ["NET_RAW"] }), "cap_drop does not include ALL: the run container drops every capability"],
      ["security_opt", ({ security_opt: _, ...s }) => s, "security_opt does not include no-new-privileges:true: the run container gains no privileges"],
      ["security_opt without no-new-privileges", (s) => ({ ...s, security_opt: ["seccomp=unconfined"] }), "security_opt does not include no-new-privileges:true"],
      ["pids_limit", ({ pids_limit: _, ...s }) => s, "pids_limit is not set: the run container has a pid limit"],
      ["mem_limit", ({ mem_limit: _, ...s }) => s, "mem_limit is not set: the run container has a memory limit"],
    ];
    for (const [what, change, error] of cases) {
      test(what, async () => {
        const service = change(await archon());
        expect(() => runArgs(service, inputs(), fakeRun().deps, [])).toThrow(`stack/compose.yaml: archon: ${error}`);
      });
    }
  });

  test("the stop timeout is STOP_GRACE_S, the same as `hapi run stop`'s, so a daemon stop gives the prelude its grace too", async () => {
    const argv = runArgs(await archon(), inputs(), fakeRun().deps, []);
    expect(argv[argv.indexOf("--stop-timeout") + 1]).toBe(String(STOP_GRACE_S));
    expect(STOP_GRACE_S).toBe(30);
  });

  test("a build dir that isn't there is named, with the fix", async () => {
    const f = fakeRun();
    const missing = join(f.tmp, "nowhere", "build");
    const service = await archon();
    expect(() => runArgs(service, inputs(), { ...f.deps, buildDir: missing }, [])).toThrow(`cannot read the build at ${missing} (ENOENT): \`mise run up\` writes it`);
  });

  test('a path holding ":" or "," is refused, never handed to -v', async () => {
    const service = await archon();
    const f = fakeRun();
    expect(() => runArgs(service, inputs({ repo: "/srv/a:b/.git" }), f.deps, [])).toThrow('cannot mount /srv/a:b/.git into the run container: its path holds ":" or ","');
    expect(() => runArgs(service, inputs({ packDir: "/srv/pack,ro" }), f.deps, [])).toThrow('cannot mount /srv/pack,ro into the run container: its path holds ":" or ","');
    expect(() => runArgs(service, inputs(), { ...f.deps, stateDir: "/srv/state:x" }, [])).toThrow(/cannot mount \/srv\/state:x\/ab12cd34ef56\/run.json into the run container/);
  });
});
