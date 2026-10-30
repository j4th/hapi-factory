/**
 * HAPI_INT=1 only (`mise run test:int`), and only with a Docker daemon and the
 * built `hapi-factory/archon:0.12.1` here (else skipped; nothing is pulled): the
 * two audit reads the fakes had assumed, run for real (the task 9 review found
 * both wrong).
 * - tools.archon-validate's `loadConfig` read-back, in a throwaway container of
 *   the local image (no network, read-only, no secret).
 * - runtime.run-container's reading of a live container: a throwaway container
 *   made with the run definition's kinds of flags, inspected, and compared with
 *   the same flags through the parser the audit uses (`shapeOf`, `liveProblems`).
 * It creates and removes only its own objects: one container and one volume named
 * hapi-int-audit-<id>, labelled org.hapi.int=hapi-int-audit-<id>.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExec } from "../../src/audit/index";
import { type Container, liveProblems, shapeOf } from "../../src/audit/checks/runtime";
import { archonValidate } from "../../src/audit/checks/tools";
import { buildAll } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { serviceEnvironment } from "../../src/stack/env";
import { newRun } from "../../src/audit/types";
import { ARCHON_IMAGE, REPO } from "./helpers";

const have = () => {
  if (!process.env.HAPI_INT) return false;
  const r = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", ARCHON_IMAGE], { stdout: "ignore", stderr: "ignore" });
  return r.exitCode === 0;
};
const READY = have();
if (process.env.HAPI_INT && !READY) console.warn(`audit.int.test.ts: Docker or ${ARCHON_IMAGE} is not here (\`mise run up\` builds it), so the audit integration test is skipped`);

const id = `hapi-int-audit-${Math.random().toString(16).slice(2, 10)}`;
const tmp = mkdtempSync(join(tmpdir(), "hapi-int-audit-"));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: process.env.DOCKER_HOST, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
const sh = (cmd: string[]) => Bun.spawnSync(cmd, { env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });

afterAll(() => {
  sh(["docker", "rm", "-f", "-v", id]);
  sh(["docker", "volume", "rm", "-f", `${id}-work`]);
  rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!READY)("the audit against real Docker", () => {
  test("the loadConfig read-back prints true on the real image (tools.archon-validate passes)", async () => {
    const build = join(tmp, "build");
    await buildAll(loadPolicy(join(REPO, "policy")), build, { roster: "anthropic" });
    const run = newRun({ root: REPO, policyDir: join(REPO, "policy"), buildDir: build, repos: [], strict: false, dev: false, env, user: "hapi", exec: defaultExec(env), fetch, now: Date.now });
    const [r] = await archonValidate(run);
    expect([r!.status, r!.detail]).toEqual(["pass", expect.stringContaining("assistants.pi.enableExtensions is true")]);
  }, 600_000);

  test("a real container's tmpfs, binds, hardening and env read back as the flags said", () => {
    const models = join(tmp, "models.json");
    writeFileSync(models, "{}\n");
    const pack = join(tmp, "pack");
    mkdirSync(pack);
    const argv = [
      "docker", "run", "-d", "--pull", "never", "--name", id, "--label", `org.hapi.int=${id}`,
      "--user", "1001:1001", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "2048", "--memory", "4g",
      "--tmpfs", "/tmp:size=1g,uid=1001,gid=1001,mode=1777",
      "--tmpfs", "/opt/hapi/pi-agent:size=64m,uid=1001,gid=1001,mode=0700",
      "-v", `${models}:/opt/hapi/pi-agent/models.json:ro`, "-v", `${pack}:/.archon/workflows/hapi:ro`, "-v", `${id}-work:/work`,
      ...Object.entries(serviceEnvironment("archon")).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint", "sleep", ARCHON_IMAGE, "120",
    ];
    const started = sh(argv);
    expect([started.exitCode, started.stderr.toString()]).toEqual([0, ""]);
    const out = sh(["docker", "inspect", id]);
    expect(out.exitCode).toBe(0);
    const [c] = JSON.parse(out.stdout.toString()) as Container[];
    // Docker lists the --tmpfs mounts only in HostConfig.Tmpfs, not in Mounts.
    expect((c!.Mounts ?? []).some((m) => m.Destination === "/opt/hapi/pi-agent")).toBe(false);
    expect(c!.HostConfig!.Tmpfs!["/opt/hapi/pi-agent"]).toBe("size=64m,uid=1001,gid=1001,mode=0700");
    expect(liveProblems(c!, shapeOf(argv), pack)).toEqual([]);
    // And a flag the container wasn't made with is found.
    const other = shapeOf(argv.map((a) => (a === "2048" ? "4096" : a)));
    expect(liveProblems(c!, other, pack)).toEqual(["its pids limit is 2048, not 4096"]);
  }, 120_000);
});
