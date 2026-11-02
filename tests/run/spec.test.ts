/**
 * The run container's `docker run` arguments (src/run/spec.ts): built from
 * stack/compose.yaml's profile-only archon service and the run's inputs, in a
 * fixed order, with every secret passed by name only. Pure: nothing runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROSTERS } from "../../src/generate/index";
import { runDeps } from "../../src/run/cli";
import { type KindProfile, kindProfile } from "../../src/run/kinds";
import { readRoster, runArgs, type RunInputs, runName, STOP_GRACE_S, TRANSLATED_KEYS } from "../../src/run/spec";
import { type ComposeService, composeServices } from "../../src/stack/compose";
import { proxyEnv, serviceEnvironment } from "../../src/stack/env";
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
const W = kindProfile("worker");

function inputs(over: Partial<RunInputs> = {}): RunInputs {
  return { runId: ID, repo: "/srv/src/.git", sha: SHA, workOrder: ORDER, public: false, budgetUsd: 3, packDir: join(REPO, "archon", "workflows", "hapi"), ...over };
}

describe("readRoster", () => {
  test("readRoster is build/roster's one word, which `mise run up` writes: a roster's name, or an error naming the fix", () => {
    const f = fakeRun();
    const file = join(f.deps.buildDir, "roster");
    expect(readRoster(f.deps.buildDir)).toBe("anthropic");
    for (const name of ROSTERS) {
      writeFileSync(file, `${name}\n`);
      expect(readRoster(f.deps.buildDir)).toBe(name);
    }
    const fix = `${file} is missing or names no roster (budget, anthropic or portable): \`mise run up\` writes it`;
    for (const text of ["", "cheap\n", "budget anthropic\n", "Budget\n"]) {
      writeFileSync(file, text);
      expect(() => readRoster(f.deps.buildDir)).toThrow(fix);
    }
    rmSync(file);
    expect(() => readRoster(f.deps.buildDir)).toThrow(fix);
  });
});

describe("runArgs", () => {
  test("the argv, exactly and in order: name and labels, the hardening, its own network, the tmpfs mounts, the read-only binds, the volumes, the environment, the secrets by name, then the prelude", async () => {
    const f = fakeRun();
    const N = runName("hapi", ID);
    expect(N).toBe(`hapi-run-${ID}`);
    const digest = buildDigest(Object.keys(BUILD_FILES).map((p) => `build/${p}`), f.tmp);
    const pi = (x: string) => `${join(f.deps.buildDir, "pi", x)}:/opt/hapi/pi-agent/${x}:ro`;
    const ar = (x: string, dest: string) => `${join(f.deps.buildDir, "archon", x)}:${dest}:ro`;
    // The run's own files, generated per run from the overlaid policy (H-172) and the host's copies of its work order.
    const own = (x: string, dest: string) => `${join(f.deps.stateDir, ID, x)}:${dest}:ro`;
    expect(runArgs(await archon(), inputs(), f.deps, ["ANTHROPIC_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY"], W)).toEqual([
      "docker", "run", "-d", "--pull", "never", "--name", N,
      "--label", `org.hapi.run=${ID}`, "--label", "org.hapi.project=hapi", "--label", "org.hapi.kind=worker",
      "--label", "org.hapi.stack=hapi-factory", "--label", "org.hapi.started-by=hapi", "--label", "org.hapi.dev-override=0", "--label", `org.hapi.build-sha256=${digest}`,
      "--label", "com.docker.compose.project=", "--label", "com.docker.compose.service=", "--label", "com.docker.compose.version=",
      "--user", "1001:1001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "2048", "--memory", "4g",
      "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", "--stop-timeout", "30", "--init=false", "--network", N,
      "--tmpfs", "/tmp:size=1g,uid=1001,gid=1001,mode=1777",
      "--tmpfs", "/home/appuser:size=256m,uid=1001,gid=1001,mode=0700",
      "--tmpfs", "/.archon:size=512m,uid=1001,gid=1001,mode=0700",
      "--tmpfs", "/opt/hapi/pi-agent:size=64m,uid=1001,gid=1001,mode=0700",
      "-v", pi("models.json"), "-v", pi("models-store.json"), "-v", own("hapi-guard.json", "/opt/hapi/pi-agent/hapi-guard.json"), "-v", pi("settings.json"), "-v", pi("extensions"),
      "-v", ar("config.yaml", "/.archon/config.yaml"), "-v", ar("empty.env", "/.archon/.env"), "-v", `${join(REPO, "archon", "workflows", "hapi")}:/.archon/workflows/hapi:ro`,
      "-v", own("run-config.yaml", "/opt/hapi/run-config.yaml"), "-v", ar("gitconfig", "/home/appuser/.gitconfig"),
      "-v", `${join(REPO, "stack", "archon", "run.sh")}:/opt/hapi/run.sh:ro`,
      "-v", `${join(f.deps.stateDir, ID, "run.json")}:/run/hapi/run.json:ro`,
      "-v", `${join(f.deps.stateDir, ID, "order.json")}:/run/hapi/order.json:ro`,
      "-v", `${join(f.deps.stateDir, ID, "task.md")}:/run/hapi/task.md:ro`,
      "-v", "/srv/src/.git:/src/repo.git:ro",
      "-v", `${N}-work:/work`, "-v", `${N}-out:/out`,
      ...Object.entries(serviceEnvironment("archon")).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-e", "ANTHROPIC_API_KEY", "-e", "HAPI_JEV_OPENROUTER_API_KEY",
      "-w", "/app", "--entrypoint", "sh", "hapi-factory/archon:0.12.1", "/opt/hapi/run.sh", "hapi-check-run", SHA, "0003-check-run", TRACEPARENT,
    ]);
  });

  test("the labels say who started the run and whether the dev bypass did, as up's do", async () => {
    const f = fakeRun({ user: "dev", env: { HAPI_ALLOW_CURRENT_USER: "1", HOME: "/home/dev" } });
    const argv = runArgs(await archon(), inputs(), f.deps, [], W);
    expect(argv).toContain("org.hapi.started-by=dev");
    expect(argv).toContain("org.hapi.dev-override=1");
    // A changed generated file changes the digest label.
    const before = argv.find((a) => a.startsWith("org.hapi.build-sha256="));
    await Bun.write(join(f.deps.buildDir, "pi", "models.json"), '{"providers":{"edited":{}}}\n');
    expect(runArgs(await archon(), inputs(), f.deps, [], W).find((a) => a.startsWith("org.hapi.build-sha256="))).not.toBe(before);
  });

  test("the image's Compose labels are blanked, so compose-label tools never see a run as the archon service", async () => {
    // The Compose-built image carries these three (docker image inspect hapi-factory/archon:0.12.1), and a container inherits its image's labels.
    const argv = runArgs(await archon(), inputs(), fakeRun().deps, [], W);
    for (const k of ["project", "service", "version"]) expect(argv).toContain(`com.docker.compose.${k}=`);
    expect(argv.filter((a) => a.startsWith("com.docker.compose.")).every((a) => a.endsWith("="))).toBe(true);
  });

  test("test-project runs are named <project>-run-<id> and carry org.hapi.int", async () => {
    const project = "hapi-int-ab12cd34";
    const f = fakeRun({ project });
    const N = runName(project, ID);
    expect(N).toBe(`${project}-run-${ID}`);
    const argv = runArgs(await archon(), inputs(), f.deps, [], W);
    expect(argv.slice(0, 13)).toEqual(["docker", "run", "-d", "--pull", "never", "--name", N, "--label", `${RUN_LABEL}=${ID}`, "--label", `${PROJECT_LABEL}=${project}`, "--label", `org.hapi.int=${project}`]);
    expect(argv).toContain(`${N}-work:/work`);
    expect(argv[argv.indexOf("--network") + 1]).toBe(N);
    // hapi's own runs carry no org.hapi.int.
    expect(runArgs(await archon(), inputs(), fakeRun().deps, [], W).some((a) => a.startsWith("org.hapi.int="))).toBe(false);
  });

  test("packDir defaults to <root>/archon/workflows/hapi, and a test passes its own", async () => {
    const f = fakeRun();
    const d = await runDeps({ root: REPO, env: f.deps.env, user: "hapi", run: f.deps.run });
    expect(d.packDir).toBe(join(REPO, "archon", "workflows", "hapi"));
    expect(runArgs(await archon(), inputs({ packDir: "/srv/fixtures/run-pack" }), f.deps, [], W)).toContain("/srv/fixtures/run-pack:/.archon/workflows/hapi:ro");
  });

  test("no secret value appears in argv: each secret is `-e NAME`, its value left to the docker CLI's own env", async () => {
    const f = fakeRun();
    const secrets = { ANTHROPIC_API_KEY: fakeSecret("ANTHROPIC_API_KEY") };
    const argv = runArgs(await archon(), inputs(), f.deps, Object.keys(secrets), W);
    expect(argv.join("\n")).not.toContain(secrets.ANTHROPIC_API_KEY);
    expect(argv.filter((a, i) => argv[i - 1] === "-e" && a.startsWith("ANTHROPIC_API_KEY"))).toEqual(["ANTHROPIC_API_KEY"]);
  });

  test("a secret may not shadow the service's environment or take a reserved name", async () => {
    const f = fakeRun();
    const service = await archon();
    for (const name of ["PI_OFFLINE", "HTTPS_PROXY", "GIT_CONFIG_COUNT", "LD_PRELOAD"]) {
      expect(() => runArgs(service, inputs(), f.deps, [name], W)).toThrow(`the archon zone's env file: ${name} is reserved`);
    }
    expect(() => runArgs(service, inputs(), f.deps, ["lower_case"], W)).toThrow(/the archon zone's env file holds a name that is not an env name/);
    // A review's errors name its own zone.
    expect(() => runArgs(service, inputs(), f.deps, ["PI_OFFLINE"], kindProfile("review"))).toThrow("the review zone's env file: PI_OFFLINE is reserved");
  });

  test("a service key outside TRANSLATED_KEYS is refused", async () => {
    const f = fakeRun();
    const service = await archon();
    for (const key of Object.keys(service)) expect([key, TRANSLATED_KEYS.includes(key)]).toEqual([key, true]);
    for (const key of ["ports", "cap_add", "privileged", "network_mode", "volumes", "command"]) {
      expect(() => runArgs({ ...service, [key]: ["x"] }, inputs(), f.deps, [], W)).toThrow(
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
    for (const [service, error] of cases) expect(() => runArgs(service, inputs(), f.deps, [], W)).toThrow(error);
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
        expect(() => runArgs(service, inputs(), fakeRun().deps, [], W)).toThrow(`stack/compose.yaml: archon: ${error}`);
      });
    }
  });

  test("every kind runs with --init=false, so its prelude is PID 1 whatever the daemon's default", async () => {
    const s = await archon();
    for (const kind of ["worker", "verify", "review", "fix"] as const) {
      const argv = runArgs(s, inputs(), fakeRun().deps, [], kindProfile(kind));
      expect([kind, argv.filter((a) => a.startsWith("--init"))]).toEqual([kind, ["--init=false"]]);
    }
  });

  test("the stop timeout is STOP_GRACE_S, the same as `hapi run stop`'s, so a daemon stop gives the prelude its grace too", async () => {
    const argv = runArgs(await archon(), inputs(), fakeRun().deps, [], W);
    expect(argv[argv.indexOf("--stop-timeout") + 1]).toBe(String(STOP_GRACE_S));
    expect(STOP_GRACE_S).toBe(30);
  });

  test("a build dir that isn't there is named, with the fix", async () => {
    const f = fakeRun();
    const missing = join(f.tmp, "nowhere", "build");
    const service = await archon();
    expect(() => runArgs(service, inputs(), { ...f.deps, buildDir: missing }, [], W)).toThrow(`cannot read the build at ${missing} (ENOENT): \`mise run up\` writes it`);
  });

  describe("the kinds (design §3.5)", () => {
    const SECRETS = ["ANTHROPIC_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY"];
    /** `argv` with the one run of `from` (a subsequence) replaced by `to`. */
    const splice = (argv: string[], from: string[], to: string[]) => {
      const at = argv.findIndex((_, i) => from.every((x, j) => argv[i + j] === x));
      expect([from, at >= 0, argv.findIndex((_, i) => i > at && from.every((x, j) => argv[i + j] === x))]).toEqual([from, true, -1]);
      return [...argv.slice(0, at), ...to, ...argv.slice(at + from.length)];
    };
    const prelude = (p: string) => `${join(REPO, "stack", "archon", p)}:/opt/hapi/${p}:ro`;
    /** The argv's last ten: the working dir, the entrypoint, the image, the prelude and its four arguments. */
    const tail = (p: string, workflow: string) => ["-w", "/app", "--entrypoint", "sh", "hapi-factory/archon:0.12.1", `/opt/hapi/${p}`, workflow, SHA, "0003-check-run", TRACEPARENT];
    const SOURCE = "/srv/src/.git:/src/repo.git:ro";

    test("each kind's argv differs from the worker's exactly as its profile says", async () => {
      const f = fakeRun();
      const s = await archon();
      const inputsBind = `${join(f.deps.stateDir, ID, "inputs")}:/run/hapi/inputs:ro`;
      const worker = runArgs(s, inputs(), f.deps, SECRETS, W);
      expect(worker.slice(-10)).toEqual(tail("run.sh", "hapi-check-run"));
      const as = (kind: string, argv: string[]) => splice(argv, ["org.hapi.kind=worker"], [`org.hapi.kind=${kind}`]);

      // verify: no secret at all, the archon zone's proxy as the worker has it, verify.sh, no inputs, factory-verify.
      let want = as("verify", worker);
      want = splice(want, [prelude("run.sh")], [prelude("verify.sh")]);
      want = splice(want, ["-e", "ANTHROPIC_API_KEY", "-e", "HAPI_JEV_OPENROUTER_API_KEY"], []);
      want = [...want.slice(0, -10), ...tail("verify.sh", "factory-verify")];
      const verify = runArgs(s, inputs(), f.deps, [], kindProfile("verify"));
      expect(verify).toEqual(want);
      expect(verify.filter((a, i) => verify[i - 1] === "-e" && !a.includes("="))).toEqual([]);
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(verify).toContain(`${k}=http://egress-archon:3128`);
      expect(verify.some((a) => a.includes("/run/hapi/inputs"))).toBe(false);
      // A verify run is given no zone's secrets, so a name passed to it is refused, never bound.
      expect(() => runArgs(s, inputs(), f.deps, ["ANTHROPIC_API_KEY"], kindProfile("verify"))).toThrow("a verify run holds no key: it is given no zone's secrets");

      // review: the review zone's proxy (NO_PROXY and no_proxy loopback only: a review has no sidecar) and keys, review.sh, its inputs, factory-review.
      want = as("review", worker);
      want = splice(want, [prelude("run.sh")], [prelude("review.sh")]);
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) want = splice(want, [`${k}=http://egress-archon:3128`], [`${k}=http://egress-review:3128`]);
      for (const k of ["NO_PROXY", "no_proxy"]) want = splice(want, [`${k}=localhost,127.0.0.1,::1,hapi-sidecar`], [`${k}=localhost,127.0.0.1,::1`]);
      want = splice(want, ["-e", "ANTHROPIC_API_KEY", "-e", "HAPI_JEV_OPENROUTER_API_KEY"], ["-e", "ANTHROPIC_API_KEY", "-e", "CLAUDE_API_KEY"]);
      want = splice(want, [SOURCE], [SOURCE, "-v", inputsBind]);
      want = [...want.slice(0, -10), ...tail("review.sh", "factory-review")];
      const review = runArgs(s, inputs(), f.deps, ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"], kindProfile("review"));
      expect(review).toEqual(want);
      for (const k of ["NO_PROXY", "no_proxy"]) {
        expect(review).toContain(`${k}=${proxyEnv("review")[k]}`);
        expect(review).not.toContain(`${k}=${serviceEnvironment("archon")[k]}`);
        // Every other kind keeps the archon zone's, which names the sidecar.
        expect(worker).toContain(`${k}=localhost,127.0.0.1,::1,hapi-sidecar`);
      }

      // fix: the kind label and the inputs bind; the rest is the worker's.
      want = splice(as("fix", worker), [SOURCE], [SOURCE, "-v", inputsBind]);
      expect(runArgs(s, inputs(), f.deps, SECRETS, kindProfile("fix"))).toEqual(want);
    });

    test("the kind label is on the run container only, right after its run labels", async () => {
      const project = "hapi-int-ab12cd34";
      const f = fakeRun({ project });
      const argv = runArgs(await archon(), inputs(), f.deps, [], kindProfile("review"));
      expect(argv.slice(7, 15)).toEqual(["--label", `${RUN_LABEL}=${ID}`, "--label", `${PROJECT_LABEL}=${project}`, "--label", `org.hapi.int=${project}`, "--label", "org.hapi.kind=review"]);
      expect(argv.filter((a) => a.startsWith("org.hapi.kind="))).toEqual(["org.hapi.kind=review"]);
    });

    test("a profile's extra binds are bound read-only through mountable, right after the inputs bind", async () => {
      const f = fakeRun();
      const s = await archon();
      let given: unknown;
      const extra = (binds: [string, string][]): KindProfile => ({ ...kindProfile("review"), extraBinds: (d) => ((given = d.buildDir), binds) });
      const argv = runArgs(s, inputs(), f.deps, [], extra([["/b/claude/x.json", "/etc/x.json"]]));
      const at = argv.indexOf(`${join(f.deps.stateDir, ID, "inputs")}:/run/hapi/inputs:ro`);
      expect(argv.slice(at + 1, at + 3)).toEqual(["-v", "/b/claude/x.json:/etc/x.json:ro"]);
      expect(given).toBe(f.deps.buildDir);
      expect(() => runArgs(s, inputs(), f.deps, [], extra([["/b:x", "/etc/x.json"]]))).toThrow('cannot mount /b:x into the run container: its path holds ":" or ","');
      // A kind with no inputs dir binds its extras right after the source.
      const verify = runArgs(s, inputs(), f.deps, [], { ...kindProfile("verify"), extraBinds: () => [["/b/y", "/etc/y"]] });
      expect(verify.slice(verify.indexOf(SOURCE) + 1, verify.indexOf(SOURCE) + 3)).toEqual(["-v", "/b/y:/etc/y:ro"]);
    });

    test("the review proxy alias is egress-review, and its NO_PROXY is loopback only: only the archon zone's names the sidecar", () => {
      expect(new URL(proxyEnv("review").HTTP_PROXY!).hostname).toBe("egress-review");
      expect(proxyEnv("review").NO_PROXY).toBe("localhost,127.0.0.1,::1");
      expect(proxyEnv("archon").NO_PROXY).toBe("localhost,127.0.0.1,::1,hapi-sidecar");
    });

    test("a run with a sidecar says so on its container, org.hapi.sidecar=<name> right after its kind label; a run without one has no such label", async () => {
      const f = fakeRun();
      const s = await archon();
      const plain = runArgs(s, inputs(), f.deps, [], W);
      expect(plain.some((a) => a.startsWith("org.hapi.sidecar"))).toBe(false);
      const smoked = runArgs(s, inputs({ sidecar: "bun-http" }), f.deps, [], kindProfile("verify"));
      const at = smoked.indexOf("org.hapi.kind=verify");
      expect(smoked.slice(at + 1, at + 3)).toEqual(["--label", "org.hapi.sidecar=bun-http"]);
      // Otherwise the argv is the plain one's.
      expect(smoked.filter((a, i) => a !== "org.hapi.sidecar=bun-http" && smoked[i + 1] !== "org.hapi.sidecar=bun-http")).toEqual(runArgs(s, inputs(), f.deps, [], kindProfile("verify")));
      // A review has no sidecar: one named for it is refused, never labelled.
      expect(() => runArgs(s, inputs({ sidecar: "bun-http" }), f.deps, [], kindProfile("review"))).toThrow("a review run has no sidecar");
      expect(() => runArgs(s, inputs({ sidecar: "Bad Name" }), f.deps, [], W)).toThrow('the sidecar "Bad Name" is not a sidecar\'s name');
    });
  });

  test('a path holding ":" or "," is refused, never handed to -v', async () => {
    const service = await archon();
    const f = fakeRun();
    expect(() => runArgs(service, inputs({ repo: "/srv/a:b/.git" }), f.deps, [], W)).toThrow('cannot mount /srv/a:b/.git into the run container: its path holds ":" or ","');
    expect(() => runArgs(service, inputs({ packDir: "/srv/pack,ro" }), f.deps, [], W)).toThrow('cannot mount /srv/pack,ro into the run container: its path holds ":" or ","');
    // The run's own hapi-guard.json is the first of its files that is bound.
    expect(() => runArgs(service, inputs(), { ...f.deps, stateDir: "/srv/state:x" }, [], W)).toThrow(/cannot mount \/srv\/state:x\/ab12cd34ef56\/hapi-guard.json into the run container/);
  });
});
