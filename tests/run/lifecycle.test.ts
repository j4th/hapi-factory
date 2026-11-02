/**
 * `hapi run start|supervise|stop`, finalize and reaping (src/run/lifecycle.ts;
 * design §3.1, §6a items 11, 12, 14, 16), with every docker and git call
 * recorded and answered by the fake world in ./helpers.ts. The order of steps
 * is the contract: nothing is created before the work order, the env file and
 * the admission checks pass, and anything created is removed again if a later
 * step fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import YAML from "yaml";
import { main } from "../../src/cli";
import { emitEgress } from "../../src/generate/egress";
import { emitPi } from "../../src/generate/pi";
import { loadPolicy } from "../../src/policy/load";
import { applyOverlay } from "../../src/policy/overlay";
import type { Policy, RepoOverlay, Tier } from "../../src/policy/types";
import { runDeps, START_USAGE } from "../../src/run/cli";
import { COPY_SCRIPT, HELPER_HOST_TIMEOUT_S, HELPER_KILL_AFTER_S, HELPER_TIMEOUT_S, LIST_SCRIPT } from "../../src/run/copyout";
import { CLEAN_SCRIPT, GIB, volumeDir } from "../../src/run/disk";
import { MAX_OUTPUTS, type RunKind } from "../../src/run/kinds";
import {
  bundleProblem, EXIT_FORMAT, FINALIZE_WAIT_S, finalizeRun, guardProblems, LOGS_SCRIPT, reapRuns, rolesProblem, runStart, runStop, runSupervise, type StartOptions, startRun,
} from "../../src/run/lifecycle";
import { lockHeld, withStackLock } from "../../src/run/locks";
import { listRecords, PER_RUN_FILES, readRecord, RUN_ID, runKey, withRunLock, withStartLock } from "../../src/run/records";
import { sidecarArgs } from "../../src/run/sidecar";
import { STOP_GRACE_S } from "../../src/run/spec";
import { reexecScript, runCommand } from "../../src/stack/up";
import { loadWorkOrder } from "../../src/workorder/validate";
import { capture, caught, cleanup, tempDir } from "../secrets/helpers";
import { REPO } from "../stack/helpers";
import { type Call, completedOutputs, fakeRepo, fakeRun, fakeSecret, file, NOW, SHA, SHA2, seedRun, stubPack, unbounded, writeOrder, writeZoneEnv } from "./helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const N = `hapi-run-${ID}`;
const ARCHON_RUN = "f0e1d2c3-0000-4000-8000-000000000001";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/**
 * A fake world with both zones' env files in place, a source repo, a valid work order, and a pack that holds the
 * verify and review workflows too (`stubPack`). The review zone's values are its own, none of them the archon zone's
 * (the real zone reuses the archon zone's Anthropic key), so a test sees which file a value came from; it has no
 * CodeRabbit key, as the real zone needn't until phases.coderabbit is on (`withCodeRabbitKey`).
 */
function ready(o: Parameters<typeof fakeRun>[0] = {}) {
  const f = fakeRun(o);
  f.deps.packDir = stubPack(["factory-verify", "factory-review"]);
  const secret = fakeSecret("ANTHROPIC_API_KEY");
  writeZoneEnv(f.xdg, "archon", { ANTHROPIC_API_KEY: secret });
  const review = { ANTHROPIC_API_KEY: fakeSecret("REVIEW_ANTHROPIC_API_KEY"), CLAUDE_API_KEY: fakeSecret("REVIEW_CLAUDE_API_KEY") };
  writeZoneEnv(f.xdg, "review", review);
  return { ...f, secret, review, repo: fakeRepo(f.tmp), order: writeOrder(f.tmp) };
}

/** Adds CodeRabbit's key to `f`'s review zone file, as resolve writes it once the store holds the optional name; returns its value. */
function withCodeRabbitKey(f: ReturnType<typeof ready>): string {
  const key = fakeSecret("CODERABBIT_API_KEY");
  writeZoneEnv(f.xdg, "review", { ...f.review, CODERABBIT_API_KEY: key });
  return key;
}

/** An inputs dir in `tmp` holding `files` (name to text): what Task 13 hands a review or fix run. */
function inputsIn(tmp: string, files: Record<string, string> = {}, name = "inputs"): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  for (const [n, text] of Object.entries(files)) writeFileSync(join(dir, n), text);
  return dir;
}

/** The `docker network disconnect` calls made, as argv. */
const disconnects = (calls: Call[]) => calls.map((c) => c.cmd).filter((c) => c[1] === "network" && c[2] === "disconnect");

/** The calls that create, connect or run something (not listings, inspects, `docker info` or git), a helper with its host bound. */
const changes = (calls: Call[]) =>
  calls.filter((c) => {
    const d = unbounded(c.cmd);
    return d[0] === "docker" && !["ps", "inspect", "ls", "info"].includes(d[1] === "network" || d[1] === "volume" ? d[2]! : d[1]!);
  });
const locksIn = (xdg: string) => (existsSync(join(xdg, "hapi", "locks")) ? readdirSync(join(xdg, "hapi", "locks")).filter((n) => n.endsWith(".lock")) : []);
const POLICY: Policy = loadPolicy(join(REPO, "policy"));
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** The effective policy's hash, as a run's record carries it: here, the central policy's, with no overlay. */
const POLICY_HASH = sha256(JSON.stringify(POLICY));
/** The model `@implement` names for the fixture's work order (roles.implement small) on the anthropic roster. */
const IMPLEMENT_MODEL = POLICY.rosters.anthropic.small.model;

describe("hapi run start: refusals", () => {
  test("start refuses when the archon env file is missing (Review Focus 1)", async () => {
    const { err } = capture();
    const f = fakeRun();
    expect(await runStart(["--repo", fakeRepo(f.tmp), "--work-order", writeOrder(f.tmp)], f.deps)).toBe(1);
    expect(err).toEqual([`hapi run start: ${join(f.xdg, "hapi", "env", "archon.env")} is missing: run \`mise run up\` first`]);
    expect(changes(f.calls)).toEqual([]);
    expect(existsSync(f.deps.stateDir) ? readdirSync(f.deps.stateDir) : []).toEqual([]);
  });

  test("start refuses a work order with egress_extra", async () => {
    const { err } = capture();
    const f = ready();
    expect(await runStart(["--repo", f.repo, "--work-order", join(REPO, "tests", "fixtures", "order-0002.yaml")], f.deps)).toBe(1);
    expect(err).toEqual(["hapi run start: egress_extra isn't supported yet (design §3.1, H-088); remove it or wait for the per-run proxy"]);
    expect(changes(f.calls)).toEqual([]);
  });

  test("start refuses a work order whose workflow isn't in hapi's pack, such as one of Archon's bundled workflows", async () => {
    const { err } = capture();
    const f = ready();
    const order = writeOrder(f.tmp, { workflow: "archon-assist" });
    expect(await runStart(["--repo", f.repo, "--work-order", order], f.deps)).toBe(1);
    expect(err).toEqual([
      `hapi run start: the work order's workflow "archon-assist" is not in hapi's pack (${f.deps.packDir}): a run may use only the pack's workflows, never one of Archon's bundled ones, which hapi doesn't review`,
    ]);
    expect(changes(f.calls)).toEqual([]);
    expect(existsSync(f.deps.stateDir) ? readdirSync(f.deps.stateDir) : []).toEqual([]);
  });

  test("start refuses when hapi's pack has a node that would drop hapi-guard", async () => {
    const { err } = capture();
    const f = ready();
    const pack = join(f.tmp, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "hapi-check-run.yaml"), "name: hapi-check-run\nnodes:\n  - id: work\n    provider: pi\n    pi: { enableExtensions: false }\n");
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], { ...f.deps, packDir: pack })).toBe(1);
    expect(err).toEqual([
      "hapi run start: hapi's pack has a problem: hapi-check-run.yaml: node work sets pi.enableExtensions: false, so hapi-guard would not load in it",
    ]);
    expect(changes(f.calls)).toEqual([]);
    expect(existsSync(f.deps.stateDir) ? readdirSync(f.deps.stateDir) : []).toEqual([]);
  });

  test("start refuses when hapi's pack is missing", async () => {
    const { err } = capture();
    const f = ready();
    const pack = join(f.tmp, "no-pack");
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], { ...f.deps, packDir: pack })).toBe(1);
    expect(err).toEqual([`hapi run start: no workflow pack at ${pack} (ENOENT): a run binds it at /.archon/workflows/hapi`]);
    expect(changes(f.calls)).toEqual([]);
    expect(existsSync(f.deps.stateDir) ? readdirSync(f.deps.stateDir) : []).toEqual([]);
  });

  test("start refuses when a pack file doesn't parse as YAML", async () => {
    const { err } = capture();
    const f = ready();
    const pack = join(f.tmp, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "hapi-check-run.yaml"), "name: hapi-check-run\nnodes: [\n");
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], { ...f.deps, packDir: pack })).toBe(1);
    expect(err).toEqual(["hapi run start: hapi's pack has a problem: hapi-check-run.yaml: does not parse as YAML"]);
    expect(changes(f.calls)).toEqual([]);
  });

  test("start refuses a pack workflow whose name isn't its file's stem, so hapi's check and Archon's lookup can't name different workflows", async () => {
    const { err } = capture();
    const f = ready();
    const pack = join(f.tmp, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "hapi-check-run.yaml"), "name: hapi-check-run\nnodes:\n  - id: work\n    bash: 'true'\n");
    writeFileSync(join(pack, "hapi-other.yaml"), "name: archon-assist\nnodes:\n  - id: work\n    bash: 'true'\n");
    writeFileSync(join(pack, "hapi-unnamed.yaml"), "nodes:\n  - id: work\n    bash: 'true'\n");
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], { ...f.deps, packDir: pack })).toBe(1);
    expect(err).toEqual([
      "hapi run start: hapi's pack has a problem: " +
        'hapi-other.yaml: its name is "archon-assist", not its file\'s stem "hapi-other", which Archon may look it up by; ' +
        'hapi-unnamed.yaml: its name is missing, not its file\'s stem "hapi-unnamed", which Archon may look it up by',
    ]);
    expect(changes(f.calls)).toEqual([]);
  });

  test("start refuses a bad work order with validateWorkOrder's messages", async () => {
    const { err } = capture();
    const f = ready();
    const bad = join(REPO, "tests", "fixtures", "order-bad-traceparent.yaml");
    const why = (() => {
      try {
        loadWorkOrder(bad);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("expected the fixture to be invalid");
    })();
    expect(why).toContain("/trace/traceparent");
    expect(await runStart(["--repo", f.repo, "--work-order", bad], f.deps)).toBe(1);
    expect(err).toEqual([`hapi run start: ${why}`]);
    expect(changes(f.calls)).toEqual([]);
  });

  test("start refuses a repo that has no .git dir and isn't a bare repo", async () => {
    const { err } = capture();
    const f = ready();
    const plain = join(f.tmp, "plain");
    mkdirSync(plain);
    expect(await runStart(["--repo", plain, "--work-order", f.order], f.deps)).toBe(1);
    expect(err[0]).toBe(`hapi run start: ${plain} is not a git repository with a .git dir, nor a bare one: name a checkout (not a linked worktree) or a bare repo`);
  });

  test("a secret that would shadow the run's environment is refused before anything starts", async () => {
    const { err } = capture();
    const f = ready();
    writeZoneEnv(f.xdg, "archon", { PI_OFFLINE: "0" });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
    expect(err[0]).toMatch(/^hapi run start: the archon zone's env file: PI_OFFLINE is reserved/);
    expect(changes(f.calls)).toEqual([]);
  });

  test("usage errors exit 2 and run nothing; --budget-usd may only lower the work order's budget", async () => {
    const { err } = capture();
    const f = ready();
    for (const args of [
      [],
      ["--repo", f.repo],
      ["--work-order", f.order],
      ["--repo", f.repo, "--work-order", f.order, "--budget-usd", "abc"],
      ["--repo", f.repo, "--work-order", f.order, "--budget-usd", "0"],
      ["--repo", f.repo, "--work-order", f.order, "--retry-of", "../x"],
      ["--repo", f.repo, "--work-order", f.order, "--public", "yes"],
      ["--repo", f.repo, "--repo", f.repo, "--work-order", f.order],
    ]) {
      expect([args, await runStart(args, f.deps)]).toEqual([args, 2]);
    }
    expect(f.calls).toEqual([]);
    expect(err.every((l) => l.endsWith(START_USAGE))).toBe(true);
    expect(START_USAGE).toBe("usage: hapi run start --repo <path> --work-order <file> [--public] [--budget-usd <n>] [--retry-of <run-id>]");
    // Above the work order's 3 USD: a usage error, found once the work order is read, before anything is created.
    err.length = 0;
    expect(await runStart(["--repo", f.repo, "--work-order", f.order, "--budget-usd", "3.5"], f.deps)).toBe(2);
    expect(err).toEqual(["hapi run start: --budget-usd 3.5 is above the work order's budget.usd (3): it may only lower it", START_USAGE]);
    expect(changes(f.calls)).toEqual([]);
  });

  test("start refuses a run when the run disk fails its check and runs.disk.enforcement is hard (H-217)", async () => {
    const { err } = capture();
    // The check is made before the start lock: no lock is held when it asks Docker for its data root.
    const locksAtInfo: number[] = [];
    let f!: ReturnType<typeof ready>;
    f = ready({ disk: "missing", onCall: (cmd) => void (cmd[1] === "info" && locksAtInfo.push(locksIn(f.xdg).length)) });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
    expect(err).toEqual([`hapi run start: the run disk ${f.deps.diskDir} does not exist: set it up as docs/runbooks/runs.md#the-run-disk says (H-217)`]);
    expect(locksAtInfo).toEqual([0]);
    expect(changes(f.calls)).toEqual([]);
    expect(await listRecords(f.deps.stateDir)).toEqual([]);
    // Any problem refuses, Docker's data root's filesystem among them.
    const g = ready({ disk: { onDataRoot: true } });
    expect(await runStart(["--repo", g.repo, "--work-order", g.order], g.deps)).toBe(1);
    expect(err.at(-1)).toBe(`hapi run start: the run disk ${g.deps.diskDir} is on the same filesystem as Docker's data root (/fake/docker-root): a run that filled it would fill Docker's disk`);
    expect(changes(g.calls)).toEqual([]);
  });

  test("with runs.disk.enforcement soft, start warns and starts the run", async () => {
    const { out, err } = capture();
    const f = ready({ disk: { bytes: 64 * GIB }, runs: { disk: { gb: 20, enforcement: "soft" } } });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(0);
    expect(err).toEqual([
      `hapi run start: warning: the run disk ${f.deps.diskDir} is 64.0 GB, more than runs.disk.gb (20): it would let a run grow past its cap; runs.disk.enforcement is soft, so the run starts anyway`,
    ]);
    expect(out).toEqual([expect.stringMatching(RUN_ID)]);
  });

  test("a docker info that fails refuses the run: the check can't be made without Docker's data root", async () => {
    const { err } = capture();
    const f = ready({ failing: ["docker info"], runs: { disk: { gb: 20, enforcement: "soft" } } });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
    expect(err).toEqual(["hapi run start: cannot read Docker's data root (docker info exited 1): boom"]);
    expect(changes(f.calls)).toEqual([]);
  });
});

describe("hapi run start: the order of steps", () => {
  test("start validates, locks and writes record.json and run.json, then creates the network and checks it, connects egress, makes and chowns the volumes, runs the container and spawns the supervisor; it prints the run id", async () => {
    const { out } = capture();
    const seen: string[] = [];
    let f!: ReturnType<typeof ready>;
    f = ready({
      onCall: (cmd) => {
        if (cmd[1] === "volume" && cmd[2] === "create") {
          // The volume's bind dir is there, the run's alone (0700), before Docker is asked to make the volume on it.
          const dir = join(f.deps.diskDir, cmd.at(-1)!);
          seen.push(`${cmd.at(-1)!.split("-").at(-1)} dir ${existsSync(dir) ? (statSync(dir).mode & 0o777).toString(8) : "missing"}`);
        }
        if (cmd[1] !== "network" || cmd[2] !== "create") return;
        const id = cmd.at(-1)!.replace("hapi-run-", "");
        const dir = join(f.deps.stateDir, id);
        seen.push(`record ${existsSync(join(dir, "record.json"))}`, `run.json ${existsSync(join(dir, "run.json"))}`, `locks ${locksIn(f.xdg).length}`);
      },
    });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order, "--public", "--budget-usd", "1.5"], f.deps)).toBe(0);
    expect(out).toHaveLength(1);
    const id = out[0]!;
    expect(id).toMatch(RUN_ID);
    const N = `hapi-run-${id}`;
    const labels = ["--label", `org.hapi.run=${id}`, "--label", "org.hapi.project=hapi"];
    const made = changes(f.calls).map((c) => c.cmd);
    const bindTo = (v: string) => ["--driver", "local", "--opt", "type=none", "--opt", "o=bind", "--opt", `device=${join(f.deps.diskDir, v)}`];
    expect(made.slice(0, 5)).toEqual([
      ["docker", "network", "create", "--internal", ...labels, N],
      ["docker", "network", "connect", "--alias", "egress-archon", N, "hapi-egress-archon-1"],
      ["docker", "volume", "create", ...bindTo(`${N}-work`), ...labels, `${N}-work`],
      ["docker", "volume", "create", ...bindTo(`${N}-out`), ...labels, `${N}-out`],
      [
        "timeout", "-k", String(HELPER_KILL_AFTER_S), String(HELPER_HOST_TIMEOUT_S),
        "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true",
        // Its run's labels, so `down` finds it, and org.hapi.helper=chown, so the audit holds it to the helpers' invariants.
        ...labels, "--label", "org.hapi.helper=chown", "-v", `${N}-work:/w`, "-v", `${N}-out:/o`, "--entrypoint", "chown", "hapi-factory/archon:0.12.1", "1001:1001", "/w", "/o",
      ],
    ]);
    expect(made[5]!.slice(0, 7)).toEqual(["docker", "run", "-d", "--pull", "never", "--name", N]);
    expect(made).toHaveLength(6);
    // The network was checked right after it was made.
    const at = (pred: (c: string[]) => boolean) => f.calls.findIndex((c) => pred(c.cmd));
    expect(at((c) => c[2] === "inspect")).toBe(at((c) => c[2] === "create" && c[1] === "network") + 1);
    expect(f.spawned).toEqual([["hapi", "run", "supervise", id]]);
    // Step 1 happened, under the lock, before anything was created; the lock is released after.
    expect(seen).toEqual(["record true", "run.json true", "locks 1", "work dir 700", "out dir 700"]);
    expect(locksIn(f.xdg)).toEqual([]);

    const dir = join(f.deps.stateDir, id);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toEqual({
      run_id: id, work_order: "0003-check-run", traceparent: TRACEPARENT, budget_usd: 1.5, public: true, workflow: "hapi-check-run", started_at: NOW.toISOString(),
      kind: "worker", round: 0, turns: 10, base: SHA, sha: SHA, model: IMPLEMENT_MODEL,
    });
    const gitDir = realpathSync(join(f.repo, ".git"));
    expect(await readRecord(f.deps.stateDir, id)).toEqual({
      runId: id, key: runKey("0003-check-run", SHA), project: "hapi", repo: gitDir, sha: SHA, workOrder: "0003-check-run", workflow: "hapi-check-run",
      container: N, network: N, volumes: { work: `${N}-work`, out: `${N}-out` },
      startedAt: NOW.toISOString(), deadline: new Date(NOW.getTime() + 30 * 60_000).toISOString(), status: "live",
      kind: "worker", round: 0, budgetUsd: 1.5, roster: "anthropic", policyHash: POLICY_HASH, model: IMPLEMENT_MODEL,
    });
    // run.json is read by the container's uid (another host uid under rootless Docker); record.json is hapi's alone.
    expect([statSync(dir).mode & 0o777, statSync(join(dir, "record.json")).mode & 0o777, statSync(join(dir, "run.json")).mode & 0o777]).toEqual([0o700, 0o600, 0o644]);
    // The source's HEAD came from host git with no config of its own.
    const head = f.calls.find((c) => c.cmd.includes("rev-parse"))!.cmd;
    expect(head.slice(0, 5)).toEqual(["env", "-i", `PATH=${f.deps.env.PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"]);
    expect(head.slice(5)).toEqual(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, "rev-parse", "--verify", "HEAD^{commit}"]);
  });

  test("the run's volumes are owned by 1001 before the run container starts", async () => {
    capture();
    const f = ready();
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(0);
    expect(f.world.ownersAtRun).toEqual(["1001:1001", "1001:1001"]);
  });

  test("the secrets reach only the run container's docker CLI, by env, never argv; the budget defaults to the work order's", async () => {
    const { out } = capture();
    const f = ready();
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(0);
    const run = f.calls.find((c) => c.cmd[2] === "-d")!;
    expect(run.env.ANTHROPIC_API_KEY).toBe(f.secret);
    expect(run.cmd.join("\n")).not.toContain(f.secret);
    expect(run.cmd).toContain("ANTHROPIC_API_KEY");
    for (const c of f.calls.filter((c) => c !== run)) expect(JSON.stringify(c)).not.toContain(f.secret);
    expect(JSON.parse(readFileSync(join(f.deps.stateDir, out[0]!, "run.json"), "utf8"))).toMatchObject({ budget_usd: 3, public: false });
  });

  test("as another user, every run command re-execs `mise run hapi -- run <sub> ...` as hapi before it looks at Docker or the state dir", async () => {
    const { err } = capture();
    const f = ready({ user: "dev" });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(0);
    expect(await runStop([ID], f.deps)).toBe(0);
    expect(await runSupervise([ID], f.deps)).toBe(0);
    expect(f.calls.map((c) => c.cmd)).toEqual([
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "run", "start", "--repo", f.repo, "--work-order", f.order],
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "run", "stop", ID],
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "run", "supervise", ID],
    ]);
    expect(err[0]).toBe("hapi run start: running as hapi (sudo -u hapi -H), not dev. For development only, HAPI_ALLOW_CURRENT_USER=1 runs it as dev instead (docs/runbooks/stack.md).");
    expect(existsSync(f.deps.stateDir)).toBe(false);
  });

  test("a relative --repo or --work-order is made absolute from the caller's directory before the re-exec, which runs in hapi's checkout", async () => {
    capture();
    const f = ready({ user: "dev" });
    const rel = (p: string) => relative(process.cwd(), p);
    expect([isAbsolute(rel(f.repo)), isAbsolute(rel(f.order))]).toEqual([false, false]);
    expect(await runStart(["--public", "--repo", rel(f.repo), "--work-order", rel(f.order), "--budget-usd", "1.50"], f.deps)).toBe(0);
    // `reexecScript` cd's to hapi's checkout, where `--repo .` would name hapi-factory itself.
    expect(f.calls.map((c) => c.cmd)).toEqual([
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "run", "start", "--public", "--repo", f.repo, "--work-order", f.order, "--budget-usd", "1.50"],
    ]);
  });

  test("a --repo or --work-order that isn't there, from the caller's directory, is a usage error before any re-exec", async () => {
    const { err } = capture();
    const f = ready({ user: "dev" });
    const missing = join(f.tmp, "no-such-repo");
    expect(await runStart(["--repo", relative(process.cwd(), missing), "--work-order", f.order], f.deps)).toBe(2);
    expect(await runStart(["--repo", f.repo, "--work-order", join(f.order, "x.yaml")], f.deps)).toBe(2);
    expect(f.calls).toEqual([]);
    expect(err).toEqual([
      `hapi run start: --repo ${missing} does not exist: name a path relative to where you run hapi, or an absolute one`,
      START_USAGE,
      `hapi run start: --work-order ${join(f.order, "x.yaml")} does not exist: name a path relative to where you run hapi, or an absolute one`,
      START_USAGE,
    ]);
  });
});

describe("hapi run start: rollback", () => {
  const steps = ["docker network connect", "docker volume create", "docker run --rm", "docker run -d"];

  test("on any failure after the lock, start removes what it created (disconnecting egress before removing the network) and releases the lock", async () => {
    for (const failing of [...steps, "spawn"]) {
      const { err } = capture();
      const f = ready(failing === "spawn" ? {} : { failing: [failing] });
      if (failing === "spawn") {
        // As the real one fails: child_process.spawn reports ENOENT, EACCES or EAGAIN on its `error` event, after it has returned.
        f.deps.spawnDetached = async () => {
          await Bun.sleep(1);
          throw new Error("cannot start hapi run supervise: spawn EAGAIN");
        };
      }
      expect([failing, await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)]).toEqual([failing, 1]);
      expect([failing, f.world.containers.size, f.world.networks.size, f.world.volumes.size]).toEqual([failing, 0, 0, 0]);
      expect([failing, readdirSync(f.deps.stateDir)]).toEqual([failing, []]);
      expect([failing, locksIn(f.xdg)]).toEqual([failing, []]);
      const cmds = f.calls.map((c) => c.cmd.join(" "));
      const disconnect = cmds.findIndex((c) => c.startsWith("docker network disconnect -f hapi-run-"));
      const rm = cmds.findIndex((c) => c.startsWith("docker network rm hapi-run-"));
      expect([failing, disconnect > 0, disconnect < rm]).toEqual([failing, true, true]);
      expect(err.at(-1)).toMatch(/^hapi run start: .*What start had created was removed\.$/);
    }
  });

  test("a chown helper that never returns fails start at the host's bound instead of hanging, and what start made is removed", async () => {
    const { err } = capture();
    const f = ready({ hangs: (c) => c.includes("chown") });
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
    expect(err.at(-1)).toBe(`hapi run start: the volume chown helper timed out after ${HELPER_HOST_TIMEOUT_S} s (exit 137): (no error output). What start had created was removed.`);
    expect([f.world.containers.size, f.world.networks.size, f.world.volumes.size, readdirSync(f.deps.stateDir), locksIn(f.xdg)]).toEqual([0, 0, 0, [], []]);
    expect(f.spawned).toEqual([]);
  });

  test("the host's supervisor spawn settles once the child has started, and rejects when it can't start", async () => {
    const dir = tempDir("hapi-run-spawn-");
    const d = await runDeps({ root: dir, stateDir: join(dir, "state"), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, image: "x", runs: fakeRun().deps.runs });
    await d.spawnDetached(["true"]);
    expect(statSync(join(dir, "state", "supervise.log")).mode & 0o777).toBe(0o600);
    const missing = join(dir, "no-such-supervisor");
    const e = await caught(d.spawnDetached([missing]));
    expect(e.message).toStartWith(`cannot start ${missing}: `);
    expect(e.message).toContain("ENOENT");
  });

  test("a run network that isn't internal or isn't private stops start, and what it made is removed", async () => {
    for (const o of [{ internal: false }, { subnet: "100.64.0.0/24" }]) {
      const { err } = capture();
      const f = ready(o);
      expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
      expect(err.at(-1)).toMatch(/^hapi run start: network hapi-run-[0-9a-f]{12} (is not internal|has subnet 100\.64\.0\.0\/24)/);
      expect(changes(f.calls).some((c) => unbounded(c.cmd)[1] === "run" || c.cmd[2] === "connect")).toBe(false);
      expect([f.world.networks.size, readdirSync(f.deps.stateDir)]).toEqual([0, []]);
    }
  });
});

describe("startRun", () => {
  const P = "0a0b0c0d0e0f";
  /** A ready world (`ready`), its work order parsed, the source's git dir, and `base`: a worker's StartOptions with no retry, as a hand run's. */
  function api(o: Parameters<typeof fakeRun>[0] = {}) {
    const f = ready(o);
    const order = loadWorkOrder(f.order);
    const gitDir = realpathSync(join(f.repo, ".git"));
    const base = (over: Partial<StartOptions> = {}): StartOptions => ({ repoGitDir: gitDir, workOrder: order, taskMd: "# 0003\n", sha: SHA, public: true, kind: "worker", ...over });
    return { f, order, gitDir, base };
  }
  type Api = ReturnType<typeof api>;
  const runJson = (f: Api["f"], id: string) => JSON.parse(readFileSync(join(f.deps.stateDir, id, "run.json"), "utf8"));
  const ids = (f: Api["f"]) => (existsSync(f.deps.stateDir) ? readdirSync(f.deps.stateDir).filter((n) => RUN_ID.test(n)).sort() : []);

  test("startRun returns the record it wrote, with its kind, round, budget, roster and the effective policy's hash", async () => {
    const { out } = capture();
    const { f, order, base } = api();
    const rec = await startRun(f.deps, base());
    expect(rec).toEqual((await readRecord(f.deps.stateDir, rec.runId))!);
    expect([rec.kind, rec.round, rec.budgetUsd, rec.roster, rec.key]).toEqual(["worker", 0, 3, "anthropic", runKey("0003-check-run", SHA)]);
    expect(rec.retry).toBeUndefined(); // a hand run's: no retry, so the two-part key
    expect(rec.policyHash).toBe(sha256(JSON.stringify(loadPolicy(join(REPO, "policy")))));
    // What an eval compares (design §3.8, m20): the model the run's alias names.
    expect(rec.model).toBe(POLICY.rosters.anthropic[order.roles.implement].model);
    expect(runJson(f, rec.runId)).toMatchObject({ kind: "worker", round: 0, turns: order.budget.turns, base: SHA });
    // The API prints nothing: the caller gets the record, or the refusal as a thrown error.
    expect(out).toEqual([]);
    expect(f.spawned).toEqual([["hapi", "run", "supervise", rec.runId]]);
  });

  test("every refusal throws its text before anything is made", async () => {
    capture();
    const cases: [what: string, over: (a: Api) => Partial<StartOptions>, text: (a: Api) => string, setup?: (a: Api) => unknown][] = [
      ["the work order's egress_extra", (a) => ({ workOrder: { ...a.order, egress_extra: ["docs.example.org"] } }), () => "egress_extra isn't supported yet (design §3.1, H-088); remove it or wait for the per-run proxy"],
      ["the overlay's egress_extra", () => ({ overlay: { egress_extra: ["docs.example.org"] } }), () => "the repo's .factory/config.yaml adds egress_extra hosts, which aren't supported yet (H-207): remove them"],
      ["a budget above the work order's", () => ({ budgetUsd: 3.5 }), () => "the run's budget 3.5 is above the work order's budget.usd (3): it may only lower it"],
      ["a commit id that isn't one", () => ({ sha: "--output=x" }), () => '"--output=x" is not a commit id: 40 or 64 lower-case hex digits'],
      ["a commit the source doesn't hold", () => ({ sha: "0".repeat(40) }), (a) => `${"0".repeat(40)} is not a commit in ${a.gitDir} (git rev-parse exited 0): fetch it into the source first`],
      ["a parent with no record", () => ({ kind: "fix", parent: P }), (a) => `the parent run ${P} has no record in ${a.f.deps.stateDir}`],
      ["no parent", () => ({ kind: "fix" }), () => "a fix run needs its parent (StartOptions.parent), the work order's worker run: its base commit is that run's sha"],
      [
        "a parent that isn't a worker run",
        () => ({ kind: "fix", parent: "0b0c0d0e0f0a" }),
        () => "the parent run 0b0c0d0e0f0a is a fix run, not the work order's worker run: a fix run's base commit is its worker run's sha",
        (a) => seedRun(a.f, { id: "0b0c0d0e0f0a", kind: "fix", objects: false }),
      ],
      [
        "no build/roster",
        () => ({}),
        (a) => `${join(a.f.deps.buildDir, "roster")} is missing or names no roster (budget, anthropic or portable): \`mise run up\` writes it`,
        (a) => rmSync(join(a.f.deps.buildDir, "roster")),
      ],
      ["a retry of -1", () => ({ retry: -1 }), () => "the run's retry -1 is not a whole number of at least 0"],
      ["a retry of 1.5", () => ({ retry: 1.5 }), () => "the run's retry 1.5 is not a whole number of at least 0"],
    ];
    for (const [what, over, text, setup] of cases) {
      const a = api();
      await setup?.(a);
      const before = ids(a.f);
      const e = await caught(startRun(a.f.deps, a.base(over(a))));
      expect([what, e.message]).toEqual([what, text(a)]);
      expect([what, changes(a.f.calls)]).toEqual([what, []]);
      expect([what, ids(a.f)]).toEqual([what, before]);
    }
  });

  test("startRun also refuses a role its kind can't run on the roster (m16), a bad round, kind or budget, a parent it can't take, and an inputs dir, naming each, before anything is made", async () => {
    capture();
    const seeded = (o: Partial<Parameters<typeof seedRun>[1]> = {}) => (a: Api) => seedRun(a.f, { id: P, status: "succeeded", objects: false, ...o });
    const onRoster = (roster: string) => async (a: Api) => {
      await seeded()(a);
      writeFileSync(join(a.f.deps.buildDir, "roster"), `${roster}\n`);
    };
    const roles = (a: Api, implement: Tier, review: Tier) => ({ workOrder: { ...a.order, roles: { implement, review } } });
    const cases: [what: string, over: (a: Api) => Partial<StartOptions>, text: string, setup?: (a: Api) => unknown][] = [
      [
        "a worker's implement on a claude tier",
        (a) => roles(a, "medium", "medium"),
        "the work order's roles.implement is medium, a claude tier in the anthropic roster: implement runs on Pi, so it must name a pi tier",
      ],
      [
        "a review on a pi tier",
        (a) => ({ ...roles(a, "small", "small"), kind: "review", parent: P }),
        "the work order's roles.review is small, a pi tier in the anthropic roster: the review runs in Claude Code, so it must name a claude tier",
        seeded(),
      ],
      [
        "a review on the portable roster, which has no claude tier",
        (a) => ({ ...roles(a, "large", "medium"), kind: "review", parent: P }),
        "the work order's roles.review is medium, a pi tier in the portable roster: the review runs in Claude Code, so it must name a claude tier",
        onRoster("portable"),
      ],
      [
        "a review whose claude tier runs implement's model too",
        (a) => ({ ...roles(a, "medium", "medium"), kind: "review", parent: P }),
        "the work order's roles.review is medium, whose model in the budget roster, claude-sonnet-5-5, is roles.implement's (medium) too: a review must run on another model than the work it reviews",
        onRoster("budget"),
      ],
      ["a round of -1", () => ({ round: -1 }), "the run's round -1 is not a whole number of at least 0"],
      ["a round of 0.5", () => ({ round: 0.5 }), "the run's round 0.5 is not a whole number of at least 0"],
      ["a kind that isn't one", () => ({ kind: "build" as RunKind }), '"build" is not a run kind (worker, verify, review or fix)'],
      ["a budget below 0", () => ({ budgetUsd: -1 }), "the run's budget -1 is not a number of at least 0"],
      ["a budget that isn't a number", () => ({ budgetUsd: Number.NaN }), "the run's budget NaN is not a number of at least 0"],
      [
        "a fix's budget above its round's cap",
        () => ({ kind: "fix", parent: P, round: 1, budgetUsd: 2 }),
        `the run's budget 2 is above a fix run's cap, the smaller of the work order's budget.usd (3) and runs.phases.round_usd (${POLICY.runs.phases.round_usd}): it may only lower it`,
        seeded(),
      ],
      ["a worker with a parent", () => ({ parent: P }), "a worker run takes no parent: it is the work order's first run, and its own base", seeded()],
      ["a parent that isn't a run id", () => ({ kind: "fix", parent: "../x" }), 'the parent run "../x" is not a run id: twelve lower-case hex digits'],
      [
        "a parent of another work order",
        () => ({ kind: "fix", parent: P }),
        `the parent run ${P} is a run of work order 0099-other, not of 0003-check-run`,
        seeded({ workOrder: "0099-other" }),
      ],
      ["a worker with an inputs dir", (a) => ({ inputsDir: inputsIn(a.f.tmp) }), "a worker run takes no inputs dir"],
      ["a forgeRepo that isn't one", () => ({ forgeRepo: "not a repo" }), 'the run\'s forgeRepo "not a repo" is not a GitHub repository\'s owner/name'],
      // An overlay that loosens the central policy, or fails its schema, names the repo's file (the poller's discovery refuses both first).
      [
        "an overlay that loosens the policy",
        () => ({ overlay: { budgets: { run_usd: 100 } } }),
        "the repo's .factory/config.yaml: /budgets/run_usd: raises budgets.run_usd from 3 to 100; overlays may only tighten policy",
      ],
      ["an overlay that fails its schema", () => ({ overlay: { nope: 1 } as RepoOverlay }), "the repo's .factory/config.yaml: /nope: unknown key"],
    ];
    for (const [what, over, text, setup] of cases) {
      const a = api();
      await setup?.(a);
      const before = ids(a.f);
      const e = await caught(startRun(a.f.deps, a.base(over(a))));
      expect([what, e.message]).toEqual([what, text]);
      expect([what, changes(a.f.calls)]).toEqual([what, []]);
      expect([what, ids(a.f)]).toEqual([what, before]);
    }
  });

  test("rolesProblem, per kind (m16): a worker's implement on a pi tier; a review's on a claude tier whose model isn't implement's; no check for verify or fix", () => {
    const { anthropic, budget, portable } = POLICY.rosters;
    // A worker is checked for implement alone: review: small (a pi tier) passes, and so does every roster's pi tier.
    expect(rolesProblem("worker", { implement: "small", review: "small" }, anthropic, "anthropic")).toBeUndefined();
    for (const [roster, name] of [[anthropic, "anthropic"], [budget, "budget"], [portable, "portable"]] as const) {
      expect([name, rolesProblem("worker", { implement: "large", review: "small" }, roster, name)]).toEqual([name, undefined]);
    }
    expect(rolesProblem("worker", { implement: "medium", review: "small" }, anthropic, "anthropic")).toContain("roles.implement is medium, a claude tier");
    // A review: a claude tier, on another model than implement's (the vendor dropped: anthropic/claude-haiku-5-5 is claude-haiku-5-5).
    expect(rolesProblem("review", { implement: "small", review: "medium" }, anthropic, "anthropic")).toBeUndefined();
    expect(rolesProblem("review", { implement: "large", review: "medium" }, anthropic, "anthropic")).toBeUndefined();
    expect(rolesProblem("review", { implement: "large", review: "large" }, anthropic, "anthropic")).toBe(
      "the work order's roles.review is large, a pi tier in the anthropic roster: the review runs in Claude Code, so it must name a claude tier",
    );
    // The budget roster's review tier is Sonnet (Task 11), so its review runs on another model than its Haiku implement.
    for (const implement of ["small", "large"] as const) expect([implement, rolesProblem("review", { implement, review: "medium" }, budget, "budget")]).toEqual([implement, undefined]);
    expect(rolesProblem("review", { implement: "medium", review: "medium" }, budget, "budget")).toBe(
      "the work order's roles.review is medium, whose model in the budget roster, claude-sonnet-5-5, is roles.implement's (medium) too: a review must run on another model than the work it reviews",
    );
    // So no review runs on portable (no claude tier) yet (H-249).
    for (const review of ["small", "medium", "large"] as const) expect(rolesProblem("review", { implement: "large", review }, portable, "portable")).toContain("a pi tier in the portable roster");
    // A verify runs no model, and a fix runs implement's, which its worker was checked for.
    for (const kind of ["verify", "fix"] as const) expect([kind, rolesProblem(kind, { implement: "medium", review: "small" }, portable, "portable")]).toEqual([kind, undefined]);
  });

  test("a worker starts on the portable roster, whatever its review tier: only a review needs a claude tier", async () => {
    capture();
    const { f, base } = api();
    writeFileSync(join(f.deps.buildDir, "roster"), "portable\n");
    const rec = await startRun(f.deps, base());
    expect([rec.roster, rec.model]).toEqual(["portable", POLICY.rosters.portable.small.model]);
  });

  test("under a soft run disk, startRun returns the warning on its result and prints nothing; the record holds no warning", async () => {
    const { out, err } = capture();
    const { f, base } = api({ disk: { bytes: 64 * GIB }, runs: { disk: { gb: 20, enforcement: "soft" } } });
    const rec = await startRun(f.deps, base());
    expect(rec.warnings).toEqual([
      `the run disk ${f.deps.diskDir} is 64.0 GB, more than runs.disk.gb (20): it would let a run grow past its cap; runs.disk.enforcement is soft, so the run starts anyway`,
    ]);
    expect([out, err]).toEqual([[], []]);
    const { warnings: _, ...written } = rec;
    expect(await readRecord(f.deps.stateDir, rec.runId)).toEqual(written);
    // With no warning there is no `warnings` key at all.
    const g = api();
    expect(Object.hasOwn(await startRun(g.f.deps, g.base()), "warnings")).toBe(false);
  });

  test("a held start lock throws an error lockHeld recognizes, so the poller tries again next tick", async () => {
    capture();
    const { f, base } = api();
    const e = await withStartLock(f.deps, () => startRun(f.deps, base()).catch((x: unknown) => x));
    expect(lockHeld(e)).toBe(true);
    expect(changes(f.calls)).toEqual([]);
  });

  test("the run's hapi-guard.json and run-config.yaml come from the policy with the repo's overlay, for build/roster's roster (H-172); order.json and task.md are the host's copies, all 0644", async () => {
    capture();
    const { f, order, base } = api();
    writeFileSync(join(f.deps.buildDir, "roster"), "budget\n");
    const overlay: RepoOverlay = { protected_paths: { "secret-dir/**": { interactive: "ask", unattended: "deny", workers: "deny" } } };
    const rec = await startRun(f.deps, base({ overlay }));
    const dir = join(f.deps.stateDir, rec.runId);
    const read = (name: string) => readFileSync(join(dir, name), "utf8");
    const applied = applyOverlay(loadPolicy(join(REPO, "policy")), overlay);
    expect(read("hapi-guard.json")).toBe(emitPi(applied, "budget")["hapi-guard.json"]!);
    expect(JSON.parse(read("hapi-guard.json")).protected_paths["secret-dir/**"]).toBe("deny");
    const config = YAML.parse(read("run-config.yaml"));
    // The work order's tiers, not roles.yaml's (implement: large there).
    expect(config.aliases["@implement"]).toEqual(config.tiers[order.roles.implement]);
    expect(config.aliases["@review"]).toEqual(config.tiers[order.roles.review]);
    expect(config.tiers.large.model).toBe(POLICY.rosters.budget.large.model);
    expect(JSON.parse(read("order.json"))).toEqual(order);
    expect(read("task.md")).toBe("# 0003\n");
    for (const name of PER_RUN_FILES) expect([name, statSync(join(dir, name)).mode & 0o777]).toEqual([name, 0o644]);
    expect([rec.roster, rec.policyHash]).toEqual(["budget", sha256(JSON.stringify(applied))]);
    // The run container binds the run's own copies, never build/'s.
    const argv = f.calls.find((c) => c.cmd[1] === "run" && c.cmd[2] === "-d")!.cmd;
    for (const [name, dest] of [["hapi-guard.json", "/opt/hapi/pi-agent/hapi-guard.json"], ["run-config.yaml", "/opt/hapi/run-config.yaml"], ["order.json", "/run/hapi/order.json"], ["task.md", "/run/hapi/task.md"]] as const) {
      expect(argv).toContain(`${join(dir, name)}:${dest}:ro`);
    }
    // No task text is an empty task.md, still bound.
    const g = api();
    const { taskMd: _, ...untasked } = g.base();
    const none = await startRun(g.f.deps, untasked);
    expect(readFileSync(join(g.f.deps.stateDir, none.runId, "task.md"), "utf8")).toBe("");
  });

  test("a fix round is keyed fix:<round>, takes its parent's sha as base, and is capped at the round's turns and dollars", async () => {
    capture();
    const { f, order, base } = api();
    const ph = loadPolicy(join(REPO, "policy")).runs.phases;
    // The worker ran at a second commit; the fix starts from SHA, so its base differs from its own commit.
    await seedRun(f, { id: P, status: "succeeded", objects: false, sha: SHA2 });
    // More turns than a round may take, so the cap shows.
    const long = { ...order, budget: { ...order.budget, turns: ph.round_turns + 10 } };
    const rec = await startRun(f.deps, base({ workOrder: long, kind: "fix", parent: P, round: 1, inputsDir: inputsIn(f.tmp, { "findings.md": "# findings\n" }) }));
    expect([rec.key, rec.parent, rec.round, rec.budgetUsd, rec.sha]).toEqual([runKey("0003-check-run", SHA, "fix:1"), P, 1, Math.min(3, ph.round_usd), SHA]);
    expect(rec.retry).toBeUndefined();
    expect(rec.model).toBe(POLICY.rosters.anthropic[order.roles.implement].model);
    expect(runJson(f, rec.runId)).toMatchObject({ kind: "fix", round: 1, turns: Math.min(long.budget.turns, ph.round_turns), base: SHA2, budget_usd: Math.min(3, ph.round_usd) });
  });

  test("a verify run takes a budget of 0 and names no model; a review run names review's; every kind's deadline is its work order's budget.minutes, CodeRabbit on or not (m18, m20)", async () => {
    capture();
    const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
    const v = api();
    await seedRun(v.f, { id: P, status: "succeeded", objects: false });
    const verify = await startRun(v.f.deps, v.base({ kind: "verify", parent: P, budgetUsd: 0 }));
    expect([verify.budgetUsd, verify.model, verify.key, verify.deadline]).toEqual([0, undefined, runKey("0003-check-run", SHA, "verify:0"), minutes(30)]);
    expect(runJson(v.f, verify.runId)).toMatchObject({ kind: "verify", budget_usd: 0, turns: 10 });
    // A review, on a claude tier with another model than implement's: with phases.coderabbit on too, its deadline is still the work order's minutes.
    for (const overlay of [undefined, { runs: { phases: { coderabbit: true } } }]) {
      const r = api();
      if (overlay !== undefined) withCodeRabbitKey(r.f);
      await seedRun(r.f, { id: P, status: "succeeded", objects: false });
      const reviewed = { ...r.order, roles: { implement: "small" as const, review: "medium" as const } };
      const review = await startRun(r.f.deps, r.base({ workOrder: reviewed, kind: "review", parent: P, inputsDir: inputsIn(r.f.tmp, { "diff.patch": "x\n" }), ...(overlay === undefined ? {} : { overlay }) }));
      expect([review.model, review.deadline]).toEqual([POLICY.rosters.anthropic.medium.model, minutes(30)]);
    }
  });

  describe("the kinds (design §3.5)", () => {
    const L = "0c0d0e0f0a0b";
    /** A world whose work order may be reviewed (roles.review on a claude tier with another model), with its worker run P seeded. */
    async function kinded(o: Parameters<typeof fakeRun>[0] = {}) {
      const a = api(o);
      await seedRun(a.f, { id: P, status: "succeeded", objects: false });
      const reviewed = { ...a.order, roles: { implement: "small" as const, review: "medium" as const } };
      const review = (over: Partial<StartOptions> = {}): StartOptions =>
        a.base({ workOrder: reviewed, kind: "review", parent: P, inputsDir: inputsIn(a.f.tmp, { "diff.patch": "diff --git a/x b/x\n", "verify.json": "{}\n" }, `inputs-${randomName()}`), ...over });
      return { ...a, review };
    }
    let counter = 0;
    const randomName = () => String(counter++);
    const runCall = (calls: Call[]) => calls.find((c) => c.cmd[1] === "run" && c.cmd[2] === "-d")!;

    test("a verify run's docker CLI gets no secret, in env or argv; egress-archon joins its network as a worker's does; its container carries org.hapi.kind=verify", async () => {
      capture();
      const { f, base } = await kinded();
      const rec = await startRun(f.deps, base({ kind: "verify", parent: P, budgetUsd: 0 }));
      const name = `hapi-run-${rec.runId}`;
      expect(f.calls.filter((c) => c.cmd[2] === "connect").map((c) => c.cmd)).toEqual([["docker", "network", "connect", "--alias", "egress-archon", name, "hapi-egress-archon-1"]]);
      const run = runCall(f.calls);
      for (const v of [f.secret, ...Object.values(f.review)]) {
        expect(Object.values(run.env)).not.toContain(v);
        expect(JSON.stringify(f.calls)).not.toContain(v);
      }
      // No `-e NAME` at all: every -e is the service's K=V.
      expect(run.cmd.filter((a, i) => run.cmd[i - 1] === "-e" && !a.includes("="))).toEqual([]);
      // Its proxy entry carries no key: the proxy variables name egress-archon with no credential in them, and the
      // archon zone's Squid config adds no header (and no peer login) to any request it passes on.
      const proxies = run.cmd.filter((a) => /^(HTTPS?_PROXY|https?_proxy)=/.test(a));
      expect(proxies).toHaveLength(4);
      for (const a of proxies) {
        const u = new URL(a.slice(a.indexOf("=") + 1));
        expect([a, u.hostname, u.username, u.password]).toEqual([a, "egress-archon", "", ""]);
      }
      expect(emitEgress(POLICY)["archon.squid.conf"]!).not.toMatch(/header|login=|cache_peer/i);
      expect(f.world.containers.get(name)!.labels["org.hapi.kind"]).toBe("verify");
      expect(run.cmd.slice(-5)).toEqual(["/opt/hapi/verify.sh", "factory-verify", SHA, "0003-check-run", TRACEPARENT]);
      expect([rec.workflow, runJson(f, rec.runId).workflow, Object.hasOwn(runJson(f, rec.runId), "coderabbit")]).toEqual(["factory-verify", "factory-verify", false]);
      expect(existsSync(join(f.deps.stateDir, rec.runId, "inputs"))).toBe(false);
      // It reads no zone's env file, so it starts with neither in place.
      const g = await kinded();
      rmSync(join(g.f.xdg, "hapi", "env"), { recursive: true });
      expect((await startRun(g.f.deps, g.base({ kind: "verify", parent: P, budgetUsd: 0 }))).kind).toBe("verify");
    });

    test("a review run's docker CLI env holds the review zone's values and none of the archon zone's, and egress-review joins its network as egress-review", async () => {
      capture();
      const { f, review } = await kinded();
      const rec = await startRun(f.deps, review());
      const name = `hapi-run-${rec.runId}`;
      expect(f.calls.filter((c) => c.cmd[2] === "connect").map((c) => c.cmd)).toEqual([["docker", "network", "connect", "--alias", "egress-review", name, "hapi-egress-review-1"]]);
      const run = runCall(f.calls);
      expect([run.env.ANTHROPIC_API_KEY, run.env.CLAUDE_API_KEY]).toEqual([f.review.ANTHROPIC_API_KEY, f.review.CLAUDE_API_KEY]);
      expect(Object.values(run.env)).not.toContain(f.secret);
      expect(run.cmd.join("\n")).not.toContain(f.review.ANTHROPIC_API_KEY);
      expect(run.cmd.filter((a, i) => run.cmd[i - 1] === "-e" && !a.includes("="))).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);
      expect(run.cmd).toContain("HTTPS_PROXY=http://egress-review:3128");
      expect(f.world.containers.get(name)!.labels["org.hapi.kind"]).toBe("review");
      expect(run.cmd.slice(-5)).toEqual(["/opt/hapi/review.sh", "factory-review", SHA, "0003-check-run", TRACEPARENT]);
      // run.json says whether CodeRabbit's step runs: the overlaid phases.coderabbit, off by default, on by the repo's overlay.
      expect(runJson(f, rec.runId)).toMatchObject({ kind: "review", workflow: "factory-review", coderabbit: POLICY.runs.phases.coderabbit });
      const g = await kinded();
      const key = withCodeRabbitKey(g.f);
      const on = await startRun(g.f.deps, g.review({ overlay: { runs: { phases: { coderabbit: true } } } }));
      expect(runJson(g.f, on.runId).coderabbit).toBe(true);
      // CodeRabbit's key is the review zone's alone: by name on argv, its value in the review container's docker CLI env only.
      const cr = runCall(g.f.calls.filter((c) => c.cmd.includes("org.hapi.kind=review")));
      expect(cr.cmd.filter((a, i) => cr.cmd[i - 1] === "-e" && !a.includes("="))).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CODERABBIT_API_KEY"]);
      expect(cr.env.CODERABBIT_API_KEY).toBe(key);
      expect(cr.cmd.join("\n")).not.toContain(key);
      // With phases.coderabbit off, the review container isn't given the key, though review.env holds it.
      const h = await kinded();
      const held = withCodeRabbitKey(h.f);
      await startRun(h.f.deps, h.review());
      const off = runCall(h.f.calls);
      expect(off.cmd.filter((a, i) => off.cmd[i - 1] === "-e" && !a.includes("="))).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"]);
      expect(Object.values(off.env)).not.toContain(held);
      expect(JSON.stringify(h.f.calls)).not.toContain(held);
    });

    test("a review run with phases.coderabbit on and no CODERABBIT_API_KEY in the review zone's file is refused before anything is made: no automatic fallback", async () => {
      capture();
      const { f, review } = await kinded();
      const before = ids(f);
      const on = { overlay: { runs: { phases: { coderabbit: true } } } };
      expect((await caught(startRun(f.deps, review(on)))).message).toBe(
        "runs.phases.coderabbit is on for this run, but the review zone's env file has no CODERABBIT_API_KEY: store hapi-review-coderabbit-api-key (`mise run secrets:edit`, docs/runbooks/provider-keys.md) and run `mise run up`, or leave phases.coderabbit off",
      );
      expect([changes(f.calls), ids(f)]).toEqual([[], before]);
      // An empty value is no key either.
      writeZoneEnv(f.xdg, "review", { ...f.review, CODERABBIT_API_KEY: " " });
      expect((await caught(startRun(f.deps, review(on)))).message).toContain("the review zone's env file has no CODERABBIT_API_KEY");
      // With phases.coderabbit off, the review starts without the key.
      writeZoneEnv(f.xdg, "review", f.review);
      expect((await startRun(f.deps, review())).kind).toBe("review");
      // A worker never needs it, whatever the overlay says.
      const w = api();
      expect((await startRun(w.f.deps, w.base(on))).kind).toBe("worker");
    });

    test("a review run without its zone file is refused", async () => {
      capture();
      const { f, review } = await kinded();
      rmSync(join(f.xdg, "hapi", "env", "review.env"));
      const before = ids(f);
      expect((await caught(startRun(f.deps, review()))).message).toBe(`${join(f.xdg, "hapi", "env", "review.env")} is missing: run \`mise run up\` first`);
      expect([changes(f.calls), ids(f)]).toEqual([[], before]);
    });

    test("a review run whose budget is below the review node's own dollar cap is refused: Claude Code holds the review to that cap alone (ruling b2(5), H-259)", async () => {
      capture();
      const { f, review } = await kinded();
      const before = ids(f);
      const cap = POLICY.runs.phases.round_usd;
      const e = await caught(startRun(f.deps, review({ budgetUsd: cap / 2 })));
      expect(e.message).toBe(
        `a review run's budget, ${cap / 2}, is below its review node's own cap, factory-review's maxBudgetUsd (${cap}): Claude Code holds the review to that cap alone, so a lower budget can't be kept (H-259); give the review at least ${cap}, or lower the node's cap`,
      );
      expect([changes(f.calls), ids(f)]).toEqual([[], before]);
      // At the cap, it starts.
      expect((await startRun(f.deps, review({ budgetUsd: cap }))).budgetUsd).toBe(cap);
      // A pack whose review node has no cap is refused too: the review would have no dollar bound at all.
      const g = await kinded();
      const pack = g.f.deps.packDir;
      const yaml = readFileSync(join(pack, "factory-review.yaml"), "utf8");
      writeFileSync(join(pack, "factory-review.yaml"), yaml.replace(/^ {4}maxBudgetUsd: .*\n/m, ""));
      expect((await caught(startRun(g.f.deps, g.review()))).message).toBe(`factory-review's review node in hapi's pack (${pack}) has no maxBudgetUsd: a review run's dollars are bounded by it alone`);
    });

    test("a review run whose build has no Claude Code managed settings is refused, never run without them: docker would bind an empty dir in their place (fail-closed)", async () => {
      capture();
      const { f, review } = await kinded();
      const file = join(f.deps.buildDir, "claude", "managed-settings.json");
      rmSync(file);
      const before = ids(f);
      expect((await caught(startRun(f.deps, review()))).message).toBe(`${file} is not a file: a review run binds it at /etc/claude-code/managed-settings.json (\`mise run up\` writes it)`);
      expect([changes(f.calls), ids(f)]).toEqual([[], before]);
      // A dir in its place is refused the same way.
      mkdirSync(file);
      expect((await caught(startRun(f.deps, review()))).message).toBe(`${file} is not a file: a review run binds it at /etc/claude-code/managed-settings.json (\`mise run up\` writes it)`);
      // A worker binds none, so it starts.
      expect((await startRun(f.deps, (await kinded()).base())).kind).toBe("worker");
    });

    test("startRun writes the sidecar's port into run.json when the overlay names one (factory-task's preflight probes it)", async () => {
      capture();
      const SIDECAR: RepoOverlay = { sidecar: { name: "bun-http", data_dir: "smoke" } };
      const a = await kinded();
      const rec = await startRun(a.f.deps, a.base({ overlay: SIDECAR }));
      expect(runJson(a.f, rec.runId).sidecar_port).toBe(POLICY.sidecars["bun-http"]!.port);
      expect(POLICY.sidecars["bun-http"]!.port).toBe(8080);
      for (const [what, overlay] of [["no overlay", undefined], ["an overlay without a sidecar", {}]] as const) {
        const b = await kinded();
        const r = await startRun(b.f.deps, b.base(overlay === undefined ? {} : { overlay }));
        expect([what, "sidecar_port" in runJson(b.f, r.runId)]).toEqual([what, false]);
      }
    });

    test("run.json's sha is the commit the run starts from, for every kind; its base is the work order's worker's", async () => {
      capture();
      const a = await kinded();
      const rec = await startRun(a.f.deps, a.review({ sha: SHA2 }));
      expect([runJson(a.f, rec.runId).sha, runJson(a.f, rec.runId).base]).toEqual([SHA2, SHA]);
    });

    test("run.json's model is the record's, the one its alias names: implement's for a worker or a fix, review's for a review, none for a verify", async () => {
      capture();
      // Each start in a world of its own: one live run per repo.
      const a = await kinded();
      const worker = await startRun(a.f.deps, a.base());
      expect([runJson(a.f, worker.runId).model, worker.model]).toEqual([IMPLEMENT_MODEL, IMPLEMENT_MODEL]);
      const b = await kinded();
      const fix = await startRun(b.f.deps, b.base({ kind: "fix", parent: P, inputsDir: inputsIn(b.f.tmp, { "findings.md": "x\n" }, "inputs-fix") }));
      expect(runJson(b.f, fix.runId).model).toBe(IMPLEMENT_MODEL);
      const c = await kinded();
      const review = await startRun(c.f.deps, c.review());
      expect(runJson(c.f, review.runId).model).toBe(POLICY.rosters.anthropic.medium.model);
      const d = await kinded();
      const verify = await startRun(d.f.deps, d.base({ kind: "verify", parent: P, budgetUsd: 0 }));
      expect("model" in runJson(d.f, verify.runId)).toBe(false);
    });

    test("a fix or review run needs an inputs dir holding its kind's inputs alone (a fix's findings.md; a review's diff.patch, and verify.json), copied into its run dir 0755 with 0644 files; a worker or verify run takes none", async () => {
      capture();
      type K = Awaited<ReturnType<typeof kinded>>;
      const holding = (k: K, make: (dir: string) => void) => {
        const dir = inputsIn(k.f.tmp, {}, `in-${randomName()}`);
        make(dir);
        return dir;
      };
      const cases: [what: string, over: (k: K) => StartOptions, text: (k: K, o: StartOptions) => string][] = [
        ["a fix without one", (k) => k.base({ kind: "fix", parent: P }), () => "a fix run needs an inputs dir (StartOptions.inputsDir): its findings go in it"],
        [
          "a review without one",
          (k) => {
            const { inputsDir: _, ...none } = k.review();
            return none;
          },
          () => "a review run needs an inputs dir (StartOptions.inputsDir): the diff and verify's results go in it",
        ],
        ["a verify with one", (k) => k.base({ kind: "verify", parent: P, inputsDir: inputsIn(k.f.tmp, {}, "v") }), () => "a verify run takes no inputs dir: its source already holds the bundle's commits"],
        ["a worker with one", (k) => k.base({ inputsDir: inputsIn(k.f.tmp, {}, "w") }), () => "a worker run takes no inputs dir"],
        [
          "a symlink",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: holding(k, (d) => symlinkSync("/etc/passwd", join(d, "findings.md"))) }),
          (_, o) => `${o.inputsDir}/findings.md: the inputs dir holds only regular files, not a symlink or a directory`,
        ],
        [
          "a directory",
          (k) => k.review({ inputsDir: holding(k, (d) => mkdirSync(join(d, "diff.patch"))) }),
          (_, o) => `${o.inputsDir}/diff.patch: the inputs dir holds only regular files, not a symlink or a directory`,
        ],
        [
          "a name that isn't plain",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: holding(k, (d) => writeFileSync(join(d, "evil\u001b[2Jname"), "x")) }),
          () => "the inputs dir holds a name that isn't plain ([A-Za-z0-9._-], at most 64 characters): not shown",
        ],
        [
          "a bundle",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: holding(k, (d) => writeFileSync(join(d, "run.bundle"), "# v2 git bundle\n")) }),
          (_, o) => `${o.inputsDir}/run.bundle is not one of a fix run's inputs (findings.md): an inputs dir never holds a bundle`,
        ],
        [
          "a review's input in a fix's",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: holding(k, (d) => (writeFileSync(join(d, "findings.md"), "f\n"), writeFileSync(join(d, "diff.patch"), "d\n"))) }),
          (_, o) => `${o.inputsDir}/diff.patch is not one of a fix run's inputs (findings.md)`,
        ],
        [
          "a fix's input in a review's",
          (k) => k.review({ inputsDir: holding(k, (d) => (writeFileSync(join(d, "diff.patch"), "d\n"), writeFileSync(join(d, "findings.md"), "f\n"))) }),
          (_, o) => `${o.inputsDir}/findings.md is not one of a review run's inputs (diff.patch, verify.json)`,
        ],
        [
          "a fix's with no findings",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: holding(k, () => {}) }),
          (_, o) => `${o.inputsDir} has no findings.md: a fix run's inputs dir must hold it`,
        ],
        [
          "a review's with no diff",
          (k) => k.review({ inputsDir: holding(k, (d) => writeFileSync(join(d, "verify.json"), "{}\n")) }),
          (_, o) => `${o.inputsDir} has no diff.patch: a review run's inputs dir must hold it`,
        ],
        [
          "a path that isn't a dir",
          (k) => k.base({ kind: "fix", parent: P, inputsDir: join(k.f.tmp, "order.yaml") }),
          (k) => `the inputs dir ${join(k.f.tmp, "order.yaml")} is not a directory`,
        ],
      ];
      for (const [what, over, text] of cases) {
        const k = await kinded();
        const o = over(k);
        const before = ids(k.f);
        const e = await caught(startRun(k.f.deps, o));
        expect([what, e.message]).toEqual([what, text(k, o)]);
        expect([what, changes(k.f.calls), ids(k.f)]).toEqual([what, [], before]);
      }

      // Accepted: copied into the run's dir, the dir 0755 and each file 0644 whatever the source's modes, and bound read-only.
      const k = await kinded();
      const dir = inputsIn(k.f.tmp, { "findings.md": "# findings\n" }, "fix-in");
      chmodSync(join(dir, "findings.md"), 0o600);
      const old = process.umask(0o077);
      let rec: Awaited<ReturnType<typeof startRun>>;
      try {
        rec = await startRun(k.f.deps, k.base({ kind: "fix", parent: P, round: 1, inputsDir: dir }));
      } finally {
        process.umask(old);
      }
      const copy = join(k.f.deps.stateDir, rec.runId, "inputs");
      expect([statSync(copy).mode & 0o777, readdirSync(copy), statSync(join(copy, "findings.md")).mode & 0o777]).toEqual([0o755, ["findings.md"], 0o644]);
      expect(readFileSync(join(copy, "findings.md"), "utf8")).toBe("# findings\n");
      expect(runCall(k.f.calls).cmd).toContain(`${copy}:/run/hapi/inputs:ro`);
      // A review's holds the diff and verify's results, or the diff alone (a review whose verify phase is off).
      const r = await kinded();
      const reviewed = await startRun(r.f.deps, r.review());
      expect(readdirSync(join(r.f.deps.stateDir, reviewed.runId, "inputs")).sort()).toEqual(["diff.patch", "verify.json"]);
      const e = await kinded();
      const diffOnly = await startRun(e.f.deps, e.review({ inputsDir: inputsIn(e.f.tmp, { "diff.patch": "x\n" }, "diff-only") }));
      expect(readdirSync(join(e.f.deps.stateDir, diffOnly.runId, "inputs"))).toEqual(["diff.patch"]);
    });

    test("one live run per GitHub repo (m23): a verify on a scratch source counts against a run live on the mirror of the same forgeRepo", async () => {
      capture();
      const { f, base, gitDir } = await kinded({ runs: { max_live: 2 } });
      const scratch = realpathSync(join(fakeRepo(f.tmp, "scratch"), ".git"));
      // A run of another work order of the same repo, live on the mirror.
      await seedRun(f, { id: L, repo: gitDir, workOrder: "0004-other", forgeRepo: "example-owner/sandbox" });
      const e = await caught(startRun(f.deps, base({ repoGitDir: scratch, kind: "verify", parent: P, budgetUsd: 0, forgeRepo: "example-owner/sandbox" })));
      expect(e.message).toBe(`run ${L} is live for example-owner/sandbox: one live run per repo (H-090); wait for it, or stop it with \`hapi run stop ${L}\``);
      expect(changes(f.calls)).toEqual([]);
      // GitHub's names aren't case-sensitive: the same repo spelt another way is the same repo.
      const upper = await caught(startRun(f.deps, base({ repoGitDir: scratch, kind: "verify", parent: P, budgetUsd: 0, forgeRepo: "Example-Owner/Sandbox" })));
      expect(upper.message).toStartWith(`run ${L} is live for example-owner/sandbox: one live run per repo (H-090)`);
      // Another GitHub repo's verify, below max_live, starts, and its record names its repo, lower-cased.
      const other = await startRun(f.deps, base({ repoGitDir: scratch, kind: "verify", parent: P, budgetUsd: 0, forgeRepo: "Example-Owner/Other" }));
      expect([other.repo, other.forgeRepo]).toEqual([scratch, "example-owner/other"]);
      expect((await readRecord(f.deps.stateDir, other.runId))!.forgeRepo).toBe("example-owner/other");
    });
  });

  describe("the smoke sidecar (design §3.3, H-192)", () => {
    const SMOKE = { "smoke/server.ts": "Bun.serve({ fetch: () => new Response('ok') });\n", "smoke/fortunes.json": '["a"]\n', "README.md": "not data\n" };
    const SIDECAR: RepoOverlay = { sidecar: { name: "bun-http", data_dir: "smoke" } };
    /** A world whose source holds the smoke data, whose work order smokes, and whose worker run P is seeded. */
    async function smoking(o: Parameters<typeof fakeRun>[0] = {}) {
      const a = api({ tree: SMOKE, ...o });
      await seedRun(a.f, { id: P, status: "succeeded", objects: false });
      const order = { ...a.order, verify: { smoke: true }, roles: { implement: "small" as const, review: "medium" as const } };
      const opts = (over: Partial<StartOptions> = {}) => a.base({ workOrder: order, overlay: SIDECAR, ...over });
      return { ...a, order, opts };
    }
    const sidecarCalls = (calls: Call[]) => calls.filter((c) => c.cmd[1] === "run" && c.cmd[2] === "-d" && c.cmd.includes("org.hapi.kind=sidecar"));

    test("a run whose work order smokes and whose overlay names a sidecar starts it on the run's network after the volume chown and before the run container; finalize removes it with the run", async () => {
      capture();
      for (const [kind, over] of [["worker", {}], ["verify", { kind: "verify", parent: P, budgetUsd: 0 }], ["fix", { kind: "fix", parent: P }]] as const) {
        const s = await smoking();
        const rec = await startRun(s.f.deps, s.opts({ ...over, ...(kind === "fix" ? { inputsDir: inputsIn(s.f.tmp, { "findings.md": "x\n" }) } : {}) }));
        const name = `hapi-run-${rec.runId}`;
        const dir = join(s.f.deps.stateDir, rec.runId, "sidecar");
        const made = changes(s.f.calls).map((c) => unbounded(c.cmd));
        // The network, egress, the two volumes, the chown, then the sidecar, then the run container.
        expect([kind, made.length]).toEqual([kind, 7]);
        expect([kind, made[4]!.at(-3)]).toEqual([kind, "1001:1001"]);
        expect([kind, made[5]]).toEqual([kind, sidecarArgs(s.f.deps, rec, POLICY.sidecars["bun-http"]!, dir)]);
        expect([kind, made[6]!.slice(0, 7)]).toEqual([kind, ["docker", "run", "-d", "--pull", "never", "--name", name]]);
        // The run says it has one, so the audit expects it on the run's network.
        expect([kind, s.f.world.containers.get(name)!.labels["org.hapi.sidecar"]]).toEqual([kind, "bun-http"]);
        expect([kind, s.f.world.containers.get(`${name}-sidecar`)!.labels]).toEqual([
          kind,
          {
            "org.hapi.run": rec.runId, "org.hapi.project": "hapi", "org.hapi.kind": "sidecar", "org.hapi.started-by": "hapi", "org.hapi.dev-override": "0",
            "com.docker.compose.project": "", "com.docker.compose.service": "", "com.docker.compose.version": "",
          },
        ]);
        // Its data: the data dir at the run's commit, read from the source by host git, 0755 and 0644, and nothing else of the tree.
        expect([kind, readdirSync(dir).sort(), (statSync(dir).mode & 0o777).toString(8)]).toEqual([kind, ["fortunes.json", "server.ts"], "755"]);
        expect([kind, readFileSync(join(dir, "server.ts"), "utf8"), (statSync(join(dir, "server.ts")).mode & 0o777).toString(8)]).toEqual([kind, SMOKE["smoke/server.ts"], "644"]);
        const listed = s.f.calls.find((c) => c.cmd.includes("ls-tree") && c.cmd.includes("-r"))!.cmd;
        expect([kind, listed.slice(-8)]).toEqual([kind, ["ls-tree", "-r", "-z", "-l", "--full-tree", SHA, "--", "smoke/"]]);
        expect([kind, listed.slice(listed.indexOf("--git-dir"), listed.indexOf("--git-dir") + 2)]).toEqual([kind, ["--git-dir", s.gitDir]]);
        // No secret reaches the sidecar's docker CLI: its env is the host's own.
        const sc = sidecarCalls(s.f.calls)[0]!;
        for (const v of [s.f.secret, ...Object.values(s.f.review)]) expect([kind, Object.values(sc.env).includes(v)]).toEqual([kind, false]);
        // finalize removes it with the run: by the run's labels, with the run container.
        s.f.world.outputs = {};
        s.f.world.containers.get(name)!.running = false;
        await finalizeRun(rec, s.f.deps);
        expect([kind, s.f.calls.find((c) => c.cmd[1] === "rm")!.cmd.slice(3).sort()]).toEqual([kind, [name, `${name}-sidecar`].sort()]);
        expect([kind, s.f.world.containers.size, s.f.world.networks.size]).toEqual([kind, 0, 0]);
      }
    });

    test("a review run, or a work order with verify.smoke false, gets no sidecar", async () => {
      capture();
      const cases: [what: string, opts: (s: Awaited<ReturnType<typeof smoking>>) => StartOptions][] = [
        ["a review", (s) => s.opts({ kind: "review", parent: P, inputsDir: inputsIn(s.f.tmp, { "diff.patch": "x\n" }) })],
        ["verify.smoke false", (s) => s.opts({ workOrder: { ...s.order, verify: { smoke: false } } })],
        ["an overlay that names no sidecar", (s) => s.opts({ overlay: {} })],
        ["no overlay", (s) => s.base({ workOrder: s.order })],
      ];
      for (const [what, opts] of cases) {
        const s = await smoking();
        const rec = await startRun(s.f.deps, opts(s));
        expect([what, sidecarCalls(s.f.calls)]).toEqual([what, []]);
        expect([what, s.f.calls.some((c) => c.cmd.includes("ls-tree") && c.cmd.includes("-r"))]).toEqual([what, false]);
        expect([what, existsSync(join(s.f.deps.stateDir, rec.runId, "sidecar"))]).toEqual([what, false]);
        expect([what, s.f.world.containers.get(`hapi-run-${rec.runId}`)!.labels["org.hapi.sidecar"]]).toEqual([what, undefined]);
      }
    });

    test("a data dir the export refuses, or a sidecar that fails to start, stops start, and what it made is removed", async () => {
      capture();
      // No file under the data dir at the run's commit: refused after the run's dir is made, before any Docker object.
      const s = await smoking({ tree: { "README.md": "x\n" } });
      const e = await caught(startRun(s.f.deps, s.opts()));
      expect(e.message).toBe(`smoke holds no file at ${SHA}. What start had created was removed.`);
      expect([changes(s.f.calls), ids(s.f)]).toEqual([[], [P]]);
      // A sidecar whose docker run fails: the run container never starts, and every object of the run goes.
      const t = await smoking({ failing: ["docker run -d --pull never --name hapi-run-"] });
      const f = await caught(startRun(t.f.deps, t.opts()));
      expect(f.message).toMatch(/^docker run hapi-run-[0-9a-f]{12}-sidecar failed \(exit 1\): boom\. What start had created was removed\.$/);
      expect(changes(t.f.calls).filter((c) => c.cmd[1] === "run" && c.cmd[2] === "-d").length).toBe(1);
      expect([t.f.world.containers.size, t.f.world.networks.size, t.f.world.volumes.size, ids(t.f)]).toEqual([0, 0, 0, [P]]);
    });
  });

  test("an engine pass never meets a hand run's key, and a retry's worker starts beside a succeeded worker of the same commit", async () => {
    capture();
    const seeded = async () => {
      const a = api();
      await seedRun(a.f, { id: P, status: "succeeded", objects: false, key: runKey("0003-check-run", SHA) });
      return a;
    };
    const hand = await seeded();
    expect((await caught(startRun(hand.f.deps, hand.base()))).message).toBe(`run ${P} of work order 0003-check-run at ${SHA.slice(0, 12)} already succeeded: a work order runs once per commit`);
    const first = await seeded();
    const zero = await startRun(first.f.deps, first.base({ retry: 0 }));
    expect([zero.key, zero.retry]).toEqual([runKey("0003-check-run", SHA, "worker:0"), 0]);
    const retried = await seeded();
    const one = await startRun(retried.f.deps, retried.base({ retry: 1 }));
    expect([one.key, one.retry, Object.hasOwn(one, "retryOf")]).toEqual([runKey("0003-check-run", SHA, "worker:0:retry1"), 1, false]);
    expect(one).toEqual((await readRecord(retried.f.deps.stateDir, one.runId))!);
  });

  test("with real git: a hand run reads the overlay at its source's HEAD as a blob, and refuses a symlink or a directory there", async () => {
    const dir = tempDir("hapi-run-overlay-");
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      expect([a.join(" "), r.exitCode]).toEqual([a.join(" "), 0]);
      return r.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, ".factory"));
    writeFileSync(join(dir, ".factory", "config.yaml"), 'protected_paths:\n  "secret-dir/**": { interactive: ask, unattended: deny, workers: deny }\n');
    git("add", "-A");
    git("commit", "-q", "-m", "overlay");
    /** A hand run from `dir`, its git calls on real git (`env -i ... git`), the rest on the fake. */
    const start = async () => {
      const f = ready();
      const fake = f.deps.run;
      f.deps.run = (cmd, o) => (cmd[0] === "env" && cmd.includes("git") && !cmd.includes("list-heads") ? runCommand(cmd, o) : fake(cmd, o));
      const { out, err } = capture();
      const code = await runStart(["--repo", dir, "--work-order", f.order], f.deps);
      return { f, code, out, err };
    };
    const one = await start();
    expect(one.code).toBe(0);
    const head = git("rev-parse", "HEAD");
    const rec = (await readRecord(one.f.deps.stateDir, one.out.at(-1)!))!;
    expect([rec.sha, JSON.parse(readFileSync(join(one.f.deps.stateDir, rec.runId, "hapi-guard.json"), "utf8")).protected_paths["secret-dir/**"]]).toEqual([head, "deny"]);
    const at = join(dir, ".factory", "config.yaml");
    const symlink = () => symlinkSync("../README.md", at);
    // git tracks no empty directory, so this one holds a file.
    const directory = () => (mkdirSync(at), writeFileSync(join(at, "x"), "x\n"));
    for (const make of [symlink, directory]) {
      rmSync(at, { recursive: true, force: true });
      make();
      git("add", "-A");
      git("commit", "-q", "-m", "not a file");
      const bad = await start();
      expect([bad.code, bad.err.at(-1)]).toEqual([1, `hapi run start: .factory/config.yaml at ${git("rev-parse", "HEAD").slice(0, 12)} is not a regular file`]);
      expect(changes(bad.f.calls)).toEqual([]);
    }
  });

  test("a hand run (`hapi run start`) reads the repo's overlay at the run's commit and the task.md beside its work order (spec §3.5)", async () => {
    const { out } = capture();
    const overlay = 'protected_paths:\n  "secret-dir/**": { interactive: ask, unattended: deny, workers: deny }\n';
    const f = ready({ overlay });
    writeFileSync(join(f.tmp, "task.md"), "# 0003: check the run\n");
    expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(0);
    const dir = join(f.deps.stateDir, out[0]!);
    expect(JSON.parse(readFileSync(join(dir, "hapi-guard.json"), "utf8")).protected_paths["secret-dir/**"]).toBe("deny");
    expect(readFileSync(join(dir, "task.md"), "utf8")).toBe("# 0003: check the run\n");
    const gitDir = realpathSync(join(f.repo, ".git"));
    const lsTree = f.calls.find((c) => c.cmd.includes("ls-tree"))!.cmd;
    expect(lsTree).toEqual([
      "env", "-i", `PATH=${f.deps.env.PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
      "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, "ls-tree", "-z", SHA, "--", ".factory/config.yaml",
    ]);
    // With no overlay in the repo, central policy, and no task.md: an empty one.
    const { out: out2 } = capture();
    const g = ready();
    expect(await runStart(["--repo", g.repo, "--work-order", g.order], g.deps)).toBe(0);
    const rec = (await readRecord(g.deps.stateDir, out2.at(-1)!))!;
    expect(rec.policyHash).toBe(POLICY_HASH);
    expect(readFileSync(join(g.deps.stateDir, rec.runId, "task.md"), "utf8")).toBe("");
    // An overlay that fails its schema refuses the run, naming the commit's file.
    const { err } = capture();
    const h = ready({ overlay: "budgets: { nope: 1 }\n" });
    expect(await runStart(["--repo", h.repo, "--work-order", h.order], h.deps)).toBe(1);
    expect(err.at(-1)).toStartWith(`hapi run start: ${SHA.slice(0, 12)}:.factory/config.yaml: `);
    expect(changes(h.calls)).toEqual([]);
  });
});

describe("hapi run supervise", () => {
  test("supervise waits for the run, until its deadline at most, then finalizes it", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, outputs: completedOutputs() });
    expect(await runSupervise([ID], f.deps)).toBe(0);
    expect(f.calls.find((c) => c.cmd.includes("wait"))!.cmd).toEqual(["timeout", String(29 * 60), "docker", "wait", N]);
    expect((await readRecord(f.deps.stateDir, ID))!.status).toBe("succeeded");
  });

  test("supervise stops the container at the deadline and records timed-out", async () => {
    capture();
    const f = fakeRun({ waitCode: 124 });
    await seedRun(f, { id: ID, outputs: completedOutputs("failed") });
    expect(await runSupervise([ID], f.deps)).toBe(0);
    const cmds = f.calls.map((c) => c.cmd.join(" "));
    expect(cmds).toContain(`docker stop -t ${STOP_GRACE_S} ${N}`);
    const rec = (await readRecord(f.deps.stateDir, ID))!;
    expect(rec.status).toBe("timed-out");
    expect(rec.reason).toStartWith(`the run passed its deadline (${rec.deadline}, from the work order's budget.minutes) and was stopped`);
    expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);
  });

  test("a run already past its deadline is stopped without waiting", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, deadline: new Date(NOW.getTime() - 1000).toISOString(), outputs: completedOutputs() });
    expect(await runSupervise([ID], f.deps)).toBe(0);
    expect(f.calls.some((c) => c.cmd.includes("wait"))).toBe(false);
    expect((await readRecord(f.deps.stateDir, ID))!.status).toBe("timed-out");
  });

  test("a supervisor at the deadline of a run whose container was removed around hapi still records timed-out: the no-container refusal is `stop`'s alone (H-218)", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, deadline: new Date(NOW.getTime() - 1000).toISOString(), outputs: completedOutputs() });
    f.world.containers.delete(N);
    expect(await runSupervise([ID], f.deps)).toBe(0);
    const rec = (await readRecord(f.deps.stateDir, ID))!;
    expect([rec.status, rec.stopRequested]).toEqual(["timed-out", "timed-out"]);
    expect(rec.reason).toContain("the run's container was removed before the run was finalized");
  });

  test("supervise of a run that has ended does nothing", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, status: "succeeded", objects: false });
    expect(await runSupervise([ID], f.deps)).toBe(0);
    expect(f.calls.filter((c) => c.cmd.join(" ").includes(ID))).toEqual([]);
  });
});

describe("finalizeRun", () => {
  test("finalize copies out into <record>/out/, checks the bundle, reads out/result.json, maps paused to failed, applies the guard-ran check, removes the container, disconnects egress from the network, removes the network and volumes, and writes record.json", async () => {
    capture();
    const f = fakeRun();
    const rec = await seedRun(f, { id: ID, running: false, outputs: { ...completedOutputs(), "run.bundle": file(new Uint8Array([0x23, 0x20, 0xff])) } });
    const done = await finalizeRun(rec, f.deps);
    // The container's exit code, as Docker recorded it, is kept on the record (never read as its status).
    expect(done).toEqual({ ...rec, status: "succeeded", exitCode: 0 });
    expect(await readRecord(f.deps.stateDir, ID)).toEqual(done);
    const out = join(f.deps.stateDir, ID, "out");
    expect(readdirSync(out).sort()).toEqual(["result.json", "run.bundle", "transcript.jsonl"]);
    const cmds = f.calls.map((c) => c.cmd);
    const at = (pred: (c: string[]) => boolean) => cmds.findIndex(pred);
    const order = [
      at((c) => c.includes(LIST_SCRIPT)), // the copy-out listing
      at((c) => c.includes("list-heads")),
      at((c) => c[1] === "rm"),
      at((c) => c[2] === "disconnect"),
      at((c) => c[2] === "rm" && c[1] === "network"),
      at((c) => c[2] === "rm" && c[1] === "volume"),
      at((c) => unbounded(c).at(-1) === CLEAN_SCRIPT), // the run disk's cleanup, once the volumes are gone
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(cmds[order[2]!]).toEqual(["docker", "rm", "-f", N]);
    expect(cmds[order[3]!]).toEqual(["docker", "network", "disconnect", "-f", N, "hapi-egress-archon-1"]);
    expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);
    expect(readdirSync(f.deps.diskDir)).toEqual([]);

    // A paused run exits 0 (spike 07 finding 5), so the status comes from Archon, and paused is failed.
    const g = fakeRun();
    const paused = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: completedOutputs("paused") }), g.deps);
    expect(paused.status).toBe("failed");
    expect(paused.reason).toBe("the run paused (Archon status paused): v1 answers no approval, so a paused run fails (design §3.1)");
    const h = fakeRun();
    const failed = await finalizeRun(await seedRun(h, { id: ID, running: false, outputs: completedOutputs("failed") }), h.deps);
    expect([failed.status, failed.reason]).toEqual(["failed", "the workflow failed (Archon status failed)"]);
  });

  test("finalize copies out each kind's own outputs: a verify run's verify.json comes out, and a run.bundle in its /out is a name no verify run leaves", async () => {
    capture();
    const f = fakeRun();
    const done = await finalizeRun(await seedRun(f, { id: ID, kind: "verify", running: false, outputs: { ...completedOutputs(), "verify.json": file('{"check":"passed"}\n') } }), f.deps);
    expect(done.status).toBe("succeeded");
    expect(readdirSync(join(f.deps.stateDir, ID, "out")).sort()).toEqual(["result.json", "transcript.jsonl", "verify.json"]);
    const g = fakeRun();
    const bundled = await finalizeRun(
      await seedRun(g, { id: ID, kind: "verify", running: false, outputs: { ...completedOutputs(), "verify.json": file("{}\n"), "run.bundle": file(new Uint8Array([0x23])) } }),
      g.deps,
    );
    expect([bundled.status, bundled.reason]).toEqual(["failed", "the run's output volume holds 1 names that are not run outputs (run.bundle): not copied"]);
    expect(readdirSync(join(g.deps.stateDir, ID, "out")).sort()).toEqual(["result.json", "transcript.jsonl", "verify.json"]);
    // Never read, so never checked as a bundle.
    expect(g.calls.some((c) => c.cmd.includes("list-heads"))).toBe(false);
    // A review's own: its decisions and CodeRabbit's NDJSON.
    const h = ready();
    const reviewed = await finalizeRun(
      await seedRun(h, { id: ID, kind: "review", running: false, outputs: { ...completedOutputs(), "decisions.jsonl": file(""), "coderabbit.ndjson": file('{"type":"complete"}\n') } }),
      h.deps,
    );
    expect(reviewed.status).toBe("succeeded");
    expect(readdirSync(join(h.deps.stateDir, ID, "out")).sort()).toEqual(["coderabbit.ndjson", "decisions.jsonl", "result.json", "transcript.jsonl"]);
  });

  test("finalize and a rolled-back start disconnect only the egress the run joined: hapi-egress-archon-1 for verify, hapi-egress-review-1 for review", async () => {
    capture();
    for (const [kind, egress] of [["verify", "hapi-egress-archon-1"], ["review", "hapi-egress-review-1"]] as const) {
      const f = ready();
      const done = await finalizeRun(await seedRun(f, { id: ID, kind, running: false, outputs: completedOutputs() }), f.deps);
      expect([kind, done.status, disconnects(f.calls)]).toEqual([kind, "succeeded", [["docker", "network", "disconnect", "-f", N, egress]]]);
      expect([kind, f.world.networks.size]).toEqual([kind, 0]);
    }
    // A review's start that fails at its `docker run` disconnects egress-review, and never egress-archon.
    const f = ready({ failing: ["docker run -d"] });
    await seedRun(f, { id: "0a0b0c0d0e0f", status: "succeeded", objects: false });
    const order = { ...loadWorkOrder(f.order), roles: { implement: "small" as const, review: "medium" as const } };
    const gitDir = realpathSync(join(f.repo, ".git"));
    const e = await caught(startRun(f.deps, { repoGitDir: gitDir, workOrder: order, sha: SHA, public: false, kind: "review", parent: "0a0b0c0d0e0f", inputsDir: inputsIn(f.tmp, { "diff.patch": "x\n" }) }));
    expect(e.message).toMatch(/^docker run hapi-run-[0-9a-f]{12} failed \(exit 1\): boom\. What start had created was removed\.$/);
    expect(disconnects(f.calls).map((c) => c.at(-1))).toEqual(["hapi-egress-review-1"]);
    expect([f.world.containers.size, f.world.networks.size, f.world.volumes.size]).toEqual([0, 0, 0]);
  });

  test("finalize disconnects egress-archon before removing the network", async () => {
    capture();
    const f = fakeRun();
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
    // Docker refuses to remove a network with an endpoint attached (spike 07 finding 13); the fake does too.
    expect(done.status).toBe("succeeded");
    expect(f.world.networks.size).toBe(0);
    const cmds = f.calls.map((c) => c.cmd.join(" "));
    expect(cmds.indexOf(`docker network disconnect -f ${N} hapi-egress-archon-1`)).toBeLessThan(cmds.indexOf(`docker network rm ${N}`));
  });

  test("a run with no result.json, or one that doesn't parse, fails", async () => {
    capture();
    // With the env file, so the container's (empty) log is kept and adds nothing to the reason.
    const f = ready();
    const none = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { "transcript.jsonl": file("{}\n") } }), f.deps);
    expect([none.status, none.reason]).toEqual(["failed", "no result.json was copied out"]);
    const g = fakeRun();
    const bad = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: { "result.json": file("not json"), "transcript.jsonl": file("{}\n") } }), g.deps);
    expect([bad.status, bad.reason]).toEqual(["failed", "out/result.json does not hold a run's status"]);
  });

  test("a copy-out problem fails the run, and the outputs that were fine are kept", async () => {
    capture();
    const f = fakeRun();
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { ...completedOutputs(), "decisions.jsonl": { kind: "symlink" } } }), f.deps);
    expect(done.status).toBe("failed");
    expect(done.reason).toBe("decisions.jsonl in the run's output volume is not a regular file (a symlink, a FIFO or a directory): not copied");
    expect(readdirSync(join(f.deps.stateDir, ID, "out")).sort()).toEqual(["result.json", "transcript.jsonl"]);
  });

  test("a run container still running is stopped before its volume is read", async () => {
    capture();
    const f = fakeRun();
    await finalizeRun(await seedRun(f, { id: ID, running: true, outputs: completedOutputs() }), f.deps);
    const cmds = f.calls.map((c) => c.cmd.join(" "));
    const stop = cmds.indexOf(`docker stop -t ${STOP_GRACE_S} ${N}`);
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(cmds.findIndex((c) => c.includes("docker run --rm")));
  });

  test("a run whose container was removed around hapi (`mise run down`, a cleanup) is not copied out, and keeps its volumes and their dirs, since nothing was copied out (H-209)", async () => {
    capture();
    const f = fakeRun();
    const rec = await seedRun(f, { id: ID, running: false, outputs: completedOutputs() });
    // What `docker rm -f` leaves while the rest of the removal is still to come: the volumes, the network.
    f.world.containers.delete(N);
    const done = await finalizeRun(rec, f.deps);
    const REMOVED = "the run's container was removed before the run was finalized (`mise run down`, or a cleanup): nothing was copied out";
    const KEPT = `the finalize left the run's volumes ${N}-work and ${N}-out in place, since nothing was copied out (H-209)`;
    expect([done.status, done.reason]).toEqual(["failed", `${REMOVED}; ${KEPT}`]);
    // The copy-out half: no volume is inspected or mounted, and nothing is copied.
    const helpers = f.calls.filter((c) => unbounded(c.cmd)[1] === "run");
    expect(helpers.concat(f.calls.filter((c) => c.cmd.join(" ").startsWith("docker volume inspect")))).toEqual([]);
    expect(f.calls.some((c) => c.cmd.includes(LIST_SCRIPT) || c.cmd.includes(COPY_SCRIPT))).toBe(false);
    expect(existsSync(join(f.deps.stateDir, ID, "out"))).toBe(false);
    // The network goes; both volumes stay, with their dirs on the run disk, for the outputs a finished run left in them.
    expect(f.world.networks.size).toBe(0);
    expect([...f.world.volumes.keys()].sort()).toEqual([`${N}-out`, `${N}-work`]);
    expect([existsSync(volumeDir(f.deps.diskDir, `${N}-work`)), existsSync(volumeDir(f.deps.diskDir, `${N}-out`))]).toEqual([true, true]);
    expect(f.calls.some((c) => unbounded(c.cmd).at(-1) === CLEAN_SCRIPT)).toBe(false);
    expect(f.calls.filter((c) => c.cmd[1] === "volume" && ["ls", "rm"].includes(c.cmd[2]!))).toEqual([]);
    // A stop asked for first still says how the run ended.
    const g = fakeRun();
    const stopped = await seedRun(g, { id: ID, running: false, stopRequested: "stopped", outputs: completedOutputs() });
    g.world.containers.delete(N);
    const s = await finalizeRun(stopped, g.deps);
    expect([s.status, s.reason]).toEqual(["stopped", `stopped by \`hapi run stop\`; ${REMOVED}; ${KEPT}`]);
    expect([...g.world.volumes.keys()].sort()).toEqual([`${N}-out`, `${N}-work`]);
  });

  test("finalize writes the outcome to record.json before it removes the run's objects (H-219)", async () => {
    capture();
    let f!: ReturnType<typeof fakeRun>;
    let atRemoval: string | undefined;
    f = fakeRun({
      onCall: (cmd) => {
        if (atRemoval === undefined && cmd[0] === "docker" && cmd[1] === "rm") atRemoval = JSON.parse(readFileSync(join(f.deps.stateDir, ID, "record.json"), "utf8")).status;
      },
    });
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
    expect([done.status, atRemoval]).toEqual(["succeeded", "succeeded"]);
    // A removal that fails adds the cleanup's reason to the record as it then is: a write made meanwhile (a harvester's harvestedAt, say) stays.
    let g!: ReturnType<typeof fakeRun>;
    const HARVESTED = "2026-10-29T12:05:00.000Z";
    g = fakeRun({
      failing: [`docker network rm ${N}`],
      onCall: (cmd) => {
        if (cmd.join(" ") !== `docker network rm ${N}`) return;
        const file = join(g.deps.stateDir, ID, "record.json");
        writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), harvestedAt: HARVESTED }));
      },
    });
    const left = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: completedOutputs() }), g.deps);
    expect([left.status, left.harvestedAt, left.reason?.startsWith("cleanup left run objects behind: ")]).toEqual(["succeeded", HARVESTED, true]);
    expect(await readRecord(g.deps.stateDir, ID)).toEqual(left);
  });

  test("finalize records the run's spend when it is known, and the turns its guard counted (m20)", async () => {
    capture();
    const f = fakeRun();
    const outputs = { ...completedOutputs(), "decisions.jsonl": file('{"event":"budget","decision":"allow","rule":"spend","cost_usd":0.42}\n') };
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, budgetUsd: 3, outputs }), f.deps);
    expect([done.status, done.spendUsd, done.turns]).toEqual(["succeeded", 0.42, undefined]);
    expect(await readRecord(f.deps.stateDir, ID)).toEqual(done);
    // With the ledger's turns too.
    const g = fakeRun();
    const counted = { ...completedOutputs(), "decisions.jsonl": file('{"event":"budget","decision":"allow","rule":"spend","cost_usd":0.1,"turns":3}\n') };
    const t = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: counted }), g.deps);
    expect([t.spendUsd, t.turns]).toEqual([0.1, 3]);
    // Neither the guard's nor Archon's: no spend is recorded, so a cap counts the run at its whole budget.
    const h = fakeRun();
    const none = await finalizeRun(await seedRun(h, { id: ID, running: false, budgetUsd: 3, outputs: completedOutputs() }), h.deps);
    expect([Object.hasOwn(none, "spendUsd"), Object.hasOwn(none, "turns")]).toEqual([false, false]);
  });

  test("a copy-out helper that never returns fails the run at the host's bound instead of hanging finalize, which still cleans up and lets go of the run's lock", async () => {
    capture();
    const f = fakeRun({ hangs: (c) => c.includes(COPY_SCRIPT) && c.at(-2) === "transcript.jsonl" });
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
    expect([done.status, done.reason]).toEqual([
      "failed",
      `copying transcript.jsonl out timed out (after ${HELPER_TIMEOUT_S} s in the helper, or ${HELPER_HOST_TIMEOUT_S} s in all): not copied; no transcript.jsonl was copied out, so the guard-ran check could not be made`,
    ]);
    expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);
    expect(locksIn(f.xdg)).toEqual([]);
  });

  test("finalize is idempotent: a run that has ended is returned as recorded, with no docker call", async () => {
    capture();
    const f = fakeRun();
    const rec = await seedRun(f, { id: ID, running: false, outputs: completedOutputs() });
    const done = await finalizeRun(rec, f.deps);
    const calls = f.calls.length;
    expect(await finalizeRun(rec, f.deps)).toEqual(done);
    expect(f.calls.length).toBe(calls);
  });

  test("a cleanup that fails is noted in the reason and leaves the outcome as it was", async () => {
    capture();
    const f = fakeRun({ failing: [`docker volume rm ${N}`] });
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
    expect(done.status).toBe("succeeded");
    expect(done.reason).toMatch(new RegExp(`^cleanup left run objects behind: removing the runs of hapi left something behind: docker volume rm ${N}-work ${N}-out failed \\(exit 1\\): boom; \`mise run down\` removes them$`));
  });
});

test("a finalize waits long enough for every kind's bounded calls", () => {
  // The stop's grace, then the four fixed calls (the container's exit code, the listing, the container's log, the
  // cleanup helper) and a read per output of the kind with the most (MAX_OUTPUTS), each at its host bound and KILL,
  // and 100 s for the rest.
  expect(FINALIZE_WAIT_S).toBe(STOP_GRACE_S + (4 + MAX_OUTPUTS) * (HELPER_HOST_TIMEOUT_S + HELPER_KILL_AFTER_S) + 100);
  // 30 + 8 × 160 + 100: Task 4's 1250, with one more bounded call for the exit code.
  expect(FINALIZE_WAIT_S).toBe(1410);
});

test("finalize records the container's exit code as Docker recorded it, under the helpers' host bound, and never as the status; one it can't read is left out", async () => {
  capture();
  const f = fakeRun({ exitCode: 3 });
  const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
  // Archon says completed, so the run succeeded: the exit code is evidence for Task 12, not the status.
  expect([done.status, done.exitCode]).toEqual(["succeeded", 3]);
  expect((await readRecord(f.deps.stateDir, ID))!.exitCode).toBe(3);
  const inspect = f.calls.map((c) => c.cmd).find((c) => c.includes(EXIT_FORMAT))!;
  expect(EXIT_FORMAT).toBe("{{.State.Status}} {{.State.ExitCode}}");
  expect(inspect).toEqual(["timeout", "-k", String(HELPER_KILL_AFTER_S), String(HELPER_HOST_TIMEOUT_S), "docker", "inspect", "--format", EXIT_FORMAT, N]);
  // Read before the container is removed.
  const cmds = f.calls.map((c) => c.cmd.join(" "));
  expect(cmds.findIndex((c) => c.includes(EXIT_FORMAT))).toBeLessThan(cmds.indexOf(`docker rm -f ${N}`));
  const unread: [Parameters<typeof fakeRun>[0], string][] = [[{ failing: ["docker inspect"] }, "fails"], [{ hangs: (c) => c.includes(EXIT_FORMAT) }, "hangs"]];
  for (const [o, why] of unread) {
    const g = fakeRun(o);
    const left = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: completedOutputs() }), g.deps);
    expect([why, left.status, Object.hasOwn(left, "exitCode")]).toEqual([why, "succeeded", false]);
  }
  // A container that never started (Docker says `created`, and exit code 0) has none to keep.
  const c = fakeRun();
  await seedRun(c, { id: ID, running: false, outputs: completedOutputs() });
  c.world.containers.get(N)!.state = "created";
  expect(Object.hasOwn(await finalizeRun((await readRecord(c.deps.stateDir, ID))!, c.deps), "exitCode")).toBe(false);
  // A container removed around hapi has no exit code to read.
  const h = fakeRun();
  const gone = await finalizeRun(await seedRun(h, { id: ID, objects: false }), h.deps);
  expect(Object.hasOwn(gone, "exitCode")).toBe(false);
});

test("finalize copies out holding the run disk's lock, and while down holds it a reap leaves the run to the next one (H-210)", async () => {
  capture();
  const f = fakeRun();
  let during: unknown;
  const run = f.deps.run;
  f.deps.run = async (cmd, o) => {
    if (cmd.includes(LIST_SCRIPT)) during = await withStackLock(f.deps, "stack-down", async () => {}).catch((e: unknown) => e);
    return run(cmd, o);
  };
  expect((await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps)).status).toBe("succeeded");
  expect(lockHeld(during)).toBe(true);
  // The lock is let go once the copy-out is done: down can take it again.
  await withStackLock(f.deps, "stack-down", async () => {});

  // While `down` holds it, a reap leaves the exited run live, for the next reap, and runs no helper on it.
  const g = fakeRun();
  await seedRun(g, { id: ID, running: false, outputs: completedOutputs() });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const down = withStackLock(g.deps, "stack-down", () => (entered(), held));
  await inside;
  try {
    await reapRuns(g.deps);
    expect((await readRecord(g.deps.stateDir, ID))!.status).toBe("live");
    expect(g.calls.filter((c) => unbounded(c.cmd)[1] === "run")).toEqual([]);
    expect(readdirSync(g.deps.diskDir).sort()).toEqual([`${N}-out`, `${N}-work`]);
  } finally {
    release();
    await down;
  }
  // The next reap finalizes it.
  await reapRuns(g.deps);
  expect((await readRecord(g.deps.stateDir, ID))!.status).toBe("succeeded");
});

test("a finalize on the stop path waits out a short `down` hold of the run disk's lock, then finalizes (H-210)", async () => {
  const { out } = capture();
  let released = false;
  let copiedAfterRelease: boolean | undefined;
  const f = fakeRun({ onCall: (cmd) => void (cmd.includes(LIST_SCRIPT) && (copiedAfterRelease = released)) });
  await seedRun(f, { id: ID, outputs: completedOutputs("failed") });
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const down = withStackLock(f.deps, "stack-down", async () => {
    entered();
    await Bun.sleep(300);
    released = true;
  });
  await inside;
  expect(await runStop([ID], f.deps)).toBe(0);
  await down;
  // finalizeRun met the held lock, tried again a second later, and copied out only once `down` had let go.
  expect(copiedAfterRelease).toBe(true);
  expect(out).toEqual([`run ${ID}: stopped: stopped by \`hapi run stop\``]);
  expect(readdirSync(f.deps.diskDir)).toEqual([]);
});

describe("the container's log, when no result.json came out (final review C-1)", () => {
  const ESC = String.fromCharCode(27);
  const OUT = (f: { deps: { stateDir: string } }) => join(f.deps.stateDir, ID, "out");

  test("a run that died in the prelude keeps its log's tail in out/container.log (0600), sanitized then redacted, and its last line in the reason, before removal", async () => {
    capture();
    const f = ready();
    f.world.logs.set(N, `Cloning into '/work/repo'...\n${ESC}[31mfatal: could not read ${f.secret}${ESC}[0m\n${ESC}]0;title${String.fromCharCode(7)}\nfatal: ${"x".repeat(300)}\n\n`);
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: {} }), f.deps);
    const kept = readFileSync(join(OUT(f), "container.log"), "utf8");
    expect(kept).toBe(`Cloning into '/work/repo'...\nfatal: could not read [hapi: ANTHROPIC_API_KEY redacted]\n\nfatal: ${"x".repeat(300)}\n\n`);
    expect(statSync(join(OUT(f), "container.log")).mode & 0o777).toBe(0o600);
    expect(done.status).toBe("failed");
    expect(done.reason).toBe(
      `no result.json was copied out; no transcript.jsonl was copied out, so the guard-ran check could not be made; the container's last log line: fatal: ${"x".repeat(193)}…`,
    );
    // Read through its host bound, before the container went.
    const cmds = f.calls.map((c) => c.cmd);
    const logs = cmds.findIndex((c) => c.includes(LOGS_SCRIPT));
    expect(cmds[logs]!.slice(0, 4)).toEqual(["timeout", "-k", "10", "150"]);
    expect(unbounded(cmds[logs]!)).toEqual(["sh", "-c", `exec docker logs --tail 200 "$1" 2>&1`, "hapi-logs", N]);
    expect(logs).toBeLessThan(cmds.findIndex((c) => c.join(" ") === `docker rm -f ${N}`));
    expect(f.world.containers.size).toBe(0);
  });

  test("a review run's kept log is redacted with the review zone's values too, and isn't kept without review.env", async () => {
    capture();
    const f = ready();
    f.world.logs.set(N, `a ${f.secret} b ${f.review.ANTHROPIC_API_KEY} c ${f.review.CLAUDE_API_KEY}\n`);
    await finalizeRun(await seedRun(f, { id: ID, kind: "review", running: false, outputs: {} }), f.deps);
    // The two zones hold ANTHROPIC_API_KEY with different values, so each is redacted, the review's named for its zone.
    expect(readFileSync(join(OUT(f), "container.log"), "utf8")).toBe("a [hapi: ANTHROPIC_API_KEY redacted] b [hapi: ANTHROPIC_API_KEY (review zone) redacted] c [hapi: CLAUDE_API_KEY redacted]\n");
    const g = ready();
    rmSync(join(g.xdg, "hapi", "env", "review.env"));
    g.world.logs.set(N, `b ${g.review.ANTHROPIC_API_KEY}\n`);
    const done = await finalizeRun(await seedRun(g, { id: ID, kind: "review", running: false, outputs: {} }), g.deps);
    expect(done.reason).toContain(`the container's log was not kept, since nothing could redact it: ${join(g.xdg, "hapi", "env", "review.env")} is missing`);
    expect(existsSync(join(OUT(g), "container.log"))).toBe(false);
    // A worker's log needs only the archon zone's file.
    const h = ready();
    rmSync(join(h.xdg, "hapi", "env", "review.env"));
    h.world.logs.set(N, `x ${h.secret}\n`);
    await finalizeRun(await seedRun(h, { id: ID, running: false, outputs: {} }), h.deps);
    expect(readFileSync(join(OUT(h), "container.log"), "utf8")).toBe("x [hapi: ANTHROPIC_API_KEY redacted]\n");
  });

  test("a run whose result.json came out keeps no log", async () => {
    capture();
    const f = ready();
    f.world.logs.set(N, "all fine\n");
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: completedOutputs() }), f.deps);
    expect(done.status).toBe("succeeded");
    expect(existsSync(join(OUT(f), "container.log"))).toBe(false);
    expect(f.calls.some((c) => c.cmd.includes(LOGS_SCRIPT))).toBe(false);
  });

  test("an empty log is kept, and adds nothing to the reason", async () => {
    capture();
    const f = ready();
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { "transcript.jsonl": file("{}\n") } }), f.deps);
    expect(done.reason).toBe("no result.json was copied out");
    expect(readFileSync(join(OUT(f), "container.log"), "utf8")).toBe("");
  });

  test("a docker logs that fails or hangs, or no env file to redact with, is noted in the reason, and finalize goes on", async () => {
    capture();
    const cases: [Parameters<typeof fakeRun>[0], string, boolean][] = [
      [{ failing: ["sh -c"] }, "the container's log could not be read (docker logs exited 1)", true],
      [{ hangs: (c) => c[0] === "sh" }, "reading the container's log timed out after 150 s", true],
      [{}, "the container's log was not kept, since nothing could redact it: ", false],
    ];
    for (const [o, note, envFile] of cases) {
      const f = envFile ? ready(o) : fakeRun(o);
      const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { "transcript.jsonl": file("{}\n") } }), f.deps);
      expect([note, done.status, done.reason?.startsWith(`no result.json was copied out; ${note}`)]).toEqual([note, "failed", true]);
      expect(existsSync(join(OUT(f), "container.log"))).toBe(false);
      expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);
    }
  });
});

describe("the bundle check", () => {
  test("a bundle with unexpected refs fails the run and names them; the bundle is kept, never fetched", async () => {
    capture();
    for (const [heads, names] of [
      [`${SHA} HEAD\n${SHA} refs/heads/main\n`, "refs/heads/main"],
      [`${SHA} refs/heads/x\n`, "refs/heads/x"],
      [`${SHA} HEAD\n${SHA} HEAD\n`, "HEAD"],
      ["", "(none)"],
      [`${SHA} refs/tags/\u001b[2Jx\n`, "refs/tags/?[2Jx"],
    ] as const) {
      const f = fakeRun({ heads });
      const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { ...completedOutputs(), "run.bundle": file("bundle") } }), f.deps);
      expect([heads, done.status, done.reason]).toEqual([heads, "failed", `unexpected refs in run.bundle: ${names}`]);
      expect(existsSync(join(f.deps.stateDir, ID, "out", "run.bundle"))).toBe(true);
      expect(f.calls.some((c) => c.cmd.includes("fetch") || c.cmd.includes("clone"))).toBe(false);
    }
  });

  test("the bundle is read by host git with no config, no hooks and no fsmonitor, in an empty temp dir no repo discovery can leave", async () => {
    capture();
    const f = fakeRun();
    let cwdWas: string[] | undefined;
    const run = f.deps.run;
    f.deps.run = async (cmd, o) => {
      if (cmd.includes("list-heads")) cwdWas = readdirSync(cmd[cmd.indexOf("-C") + 1]!);
      return run(cmd, o);
    };
    await finalizeRun(await seedRun(f, { id: ID, running: false, outputs: { ...completedOutputs(), "run.bundle": file("bundle") } }), f.deps);
    const cmd = f.calls.find((c) => c.cmd.includes("list-heads"))!.cmd;
    const tmp = cmd[cmd.indexOf("-C") + 1]!;
    expect(cmd).toEqual([
      "env", "-i", `PATH=${f.deps.env.PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", `GIT_CEILING_DIRECTORIES=${join(tmp, "..")}`,
      "git", "-C", tmp, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "bundle", "list-heads", join(f.deps.stateDir, ID, "out", "run.bundle"),
    ]);
    expect(cwdWas).toEqual([]);
    expect(existsSync(tmp)).toBe(false);
  });

  test("with real git: a bundle of a detached HEAD passes, one with a branch too names it", async () => {
    const dir = tempDir("hapi-run-bundle-");
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...a], { stdout: "pipe", stderr: "pipe" });
      expect([a.join(" "), r.exitCode, r.stderr.toString()]).toEqual([a.join(" "), 0, expect.any(String)]);
      return r.stdout.toString().trim();
    };
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "--detach");
    git("commit", "-q", "--allow-empty", "-m", "work");
    const one = join(dir, "one.bundle");
    const two = join(dir, "two.bundle");
    git("bundle", "create", one, `${base}..HEAD`);
    git("branch", "extra");
    git("bundle", "create", two, `${base}..HEAD`, "extra");
    const deps = { run: runCommand, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };
    expect(await bundleProblem(one, deps)).toBeUndefined();
    expect(await bundleProblem(two, deps)).toBe("unexpected refs in run.bundle: refs/heads/extra");
    writeFileSync(join(dir, "junk.bundle"), "not a bundle\n");
    expect(await bundleProblem(join(dir, "junk.bundle"), deps)).toMatch(/^run\.bundle is not a bundle git can read \(git bundle list-heads exited \d+\): kept, never fetched$/);
  });
});

describe("the guard-ran check", () => {
  const row = (path: string, attempt: string, provider?: string, runId = ARCHON_RUN) =>
    JSON.stringify({ type: "node_start", execution: { runId, path, attempt: { id: attempt }, ...(provider === undefined ? {} : { binding: { provider } }), node: { kind: provider ? "agent" : "bash" } } });
  const start = (node: string, attempt: string, run = ARCHON_RUN) => JSON.stringify({ ts: NOW.toISOString(), run, node, attempt, event: "session_start", decision: "allow", rule: "session", reason: "" });

  test("every Pi node_start row needs a session_start record with the same run, node and attempt", () => {
    const transcript = [row("implement", "a1", "pi"), row("implement", "a2", "pi"), row("check", "b1"), row("review", "c1", "claude"), '{"type":"node_complete"}', ""].join("\n");
    const decisions = [start("implement", "a1"), start("implement", "a2", "0000"), JSON.stringify({ event: "tool_call", run: ARCHON_RUN, node: "implement", attempt: "a2" })].join("\n");
    expect(guardProblems(transcript, decisions)).toEqual(["guard did not run in node implement attempt a2"]);
    expect(guardProblems(transcript, [decisions, start("implement", "a2")].join("\n"))).toEqual([]);
    // No Pi node: nothing to check, with or without a decision log.
    expect(guardProblems(row("check", "b1"), undefined)).toEqual([]);
  });

  test("a missing transcript, or a line of it that isn't JSON, fails the check rather than passing it", () => {
    expect(guardProblems(undefined, undefined)).toEqual(["no transcript.jsonl was copied out, so the guard-ran check could not be made"]);
    expect(guardProblems(`${row("implement", "a1", "pi")}\n{oops\n`, start("implement", "a1"))).toEqual(["transcript.jsonl line 2 is not JSON, so the guard-ran check can't be made"]);
    expect(guardProblems(JSON.stringify({ type: "node_start", execution: { binding: { provider: "pi" } } }), undefined)).toEqual(["a Pi node_start row in transcript.jsonl (line 1) has no run, node or attempt id"]);
  });

  test("a Pi attempt without a guard record fails the run (Review Focus 6)", async () => {
    capture();
    const f = fakeRun();
    const outputs = completedOutputs("completed", `${row("implement", "a1", "pi")}\n${row("implement", "a2", "pi")}\n`);
    outputs["decisions.jsonl"] = file(`${start("implement", "a1")}\n`);
    const done = await finalizeRun(await seedRun(f, { id: ID, running: false, outputs }), f.deps);
    expect([done.status, done.reason]).toEqual(["failed", "guard did not run in node implement attempt a2"]);
  });
});

describe("reapRuns", () => {
  test("reap finalizes an exited run and stops an overdue one (Review Focus 2)", async () => {
    capture();
    const f = fakeRun();
    const [A, B, C, D] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"];
    await seedRun(f, { id: A, running: false, outputs: completedOutputs() });
    await seedRun(f, { id: B, running: true, deadline: new Date(NOW.getTime() - 1000).toISOString(), outputs: completedOutputs() });
    await seedRun(f, { id: C, running: true });
    await seedRun(f, { id: D, status: "failed", objects: false });
    await reapRuns(f.deps);
    const status = async (id: string) => (await readRecord(f.deps.stateDir, id))!.status;
    expect([await status(A), await status(B), await status(C), await status(D)]).toEqual(["succeeded", "timed-out", "live", "failed"]);
    const cmds = f.calls.map((c) => c.cmd.join(" "));
    expect(cmds).toContain(`docker stop -t ${STOP_GRACE_S} hapi-run-${B}`);
    expect(cmds.some((c) => c.startsWith(`docker stop`) && c.endsWith(C))).toBe(false);
    // The live, in-time run keeps its container; the others are gone.
    expect([...f.world.containers.keys()]).toEqual([`hapi-run-${C}`]);
    expect(cmds.filter((c) => c.includes(D))).toEqual([]);
  });

  test("a reap that can't tell whether a run is live leaves it live and says which", async () => {
    capture();
    const f = fakeRun({ failing: ["docker ps --filter label=org.hapi.run=aaaaaaaaaaaa"] });
    await seedRun(f, { id: "aaaaaaaaaaaa", running: false });
    const e = await caught(reapRuns(f.deps));
    expect(e.message).toMatch(/^reaping left runs unfinished: run aaaaaaaaaaaa: docker ps .* failed \(exit 1\): boom$/);
    expect((await readRecord(f.deps.stateDir, "aaaaaaaaaaaa"))!.status).toBe("live");
  });

  test("reap empties and removes a run disk dir whose volume is gone and whose run isn't live, and keeps the rest", async () => {
    const { err } = capture();
    const f = fakeRun();
    const [A, B, C] = ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc"];
    const disk = (name: string, file = true) => {
      mkdirSync(join(f.deps.diskDir, name), { mode: 0o700 });
      if (file) writeFileSync(join(f.deps.diskDir, name, "f"), "x");
    };
    // A: no volume and no record (a start rolled back, or a down that left it). B: its volume is still there.
    disk(`hapi-run-${A}-work`);
    disk(`hapi-run-${B}-out`);
    f.world.volumes.set(`hapi-run-${B}-out`, { labels: { "org.hapi.run": B, "org.hapi.project": "hapi" }, owner: "1001:1001", files: new Map() });
    // C: a live run (its record says so), whose volumes another process may be removing: never swept.
    await seedRun(f, { id: C, running: true });
    for (const v of ["work", "out"]) f.world.volumes.delete(`hapi-run-${C}-${v}`);
    // Neither a run's dir of another project nor the filesystem's own lost+found.
    disk(`other-run-${A}-work`);
    disk("lost+found", false);
    await reapRuns(f.deps);
    expect(readdirSync(f.deps.diskDir).sort()).toEqual(["hapi-run-bbbbbbbbbbbb-out", "hapi-run-cccccccccccc-out", "hapi-run-cccccccccccc-work", "lost+found", "other-run-aaaaaaaaaaaa-work"]);
    expect(err).toEqual([`hapi run: removed run ${A}'s dirs on the run disk: their volumes were gone`]);
    // The listing is the project's labelled volumes.
    expect(f.calls.filter((c) => c.cmd[1] === "volume").map((c) => c.cmd)).toEqual([["docker", "volume", "ls", "-q", "--filter", "label=org.hapi.run", "--filter", "label=org.hapi.project=hapi"]]);
  });

  test("the sweep leaves a run's dirs to the finalize that holds its lock: it writes the outcome before it removes them (H-219), so the record alone can't say they are done", async () => {
    const { err } = capture();
    const f = fakeRun();
    const A = "aaaaaaaaaaaa";
    // What a finalize leaves for the moment between its removeRuns and its removeVolumeDirs: an ended record, no volume, the dirs.
    await seedRun(f, { id: A, status: "succeeded", objects: false });
    for (const v of ["work", "out"]) {
      mkdirSync(join(f.deps.diskDir, `hapi-run-${A}-${v}`), { mode: 0o700 });
      writeFileSync(join(f.deps.diskDir, `hapi-run-${A}-${v}`, "f"), "x");
    }
    await withRunLock(f.deps, A, () => reapRuns(f.deps));
    expect(readdirSync(f.deps.diskDir).sort()).toEqual([`hapi-run-${A}-out`, `hapi-run-${A}-work`]);
    expect(f.calls.some((c) => unbounded(c.cmd).at(-1) === CLEAN_SCRIPT)).toBe(false);
    expect(err).toEqual([]);
    // Once that finalize has let go, a reap removes them, as for any run whose volumes are gone.
    await reapRuns(f.deps);
    expect(readdirSync(f.deps.diskDir)).toEqual([]);
  });

  test("a run disk dir the reap can't empty is a failure: the run disk stops new starts until it is cleaned (fail-closed); with nothing to sweep, nothing is listed", async () => {
    capture();
    const f = fakeRun({ failing: ["docker run --rm"] });
    mkdirSync(join(f.deps.diskDir, "hapi-run-aaaaaaaaaaaa-out"), { mode: 0o700 });
    writeFileSync(join(f.deps.diskDir, "hapi-run-aaaaaaaaaaaa-out", "f"), "x");
    expect((await caught(reapRuns(f.deps))).message).toBe("reaping left runs unfinished: run aaaaaaaaaaaa: emptying run aaaaaaaaaaaa's dirs on the run disk failed (helper exit 1)");
    const g = fakeRun({ failing: ["docker volume ls"] });
    mkdirSync(join(g.deps.diskDir, "hapi-run-aaaaaaaaaaaa-out"), { mode: 0o700 });
    expect((await caught(reapRuns(g.deps))).message).toMatch(/^reaping left runs unfinished: the run disk's sweep: docker volume ls -q .* failed \(exit 1\): boom$/);
    // No run's dir, or no run disk at all: no listing.
    const h = fakeRun();
    await reapRuns(h.deps);
    await reapRuns({ ...h.deps, diskDir: join(h.tmp, "no-run-disk") });
    expect(h.calls).toEqual([]);
  });
});

describe("hapi run stop", () => {
  test(`stop sends docker stop -t ${STOP_GRACE_S} and finalizes as stopped`, async () => {
    const { out } = capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, outputs: completedOutputs("failed") });
    expect(await runStop([ID], f.deps)).toBe(0);
    // 30 s, not Docker's 10: after the workflow ends, run.sh starts the Archon CLI up to three more times for its read-back.
    expect(STOP_GRACE_S).toBe(30);
    expect(f.calls.map((c) => c.cmd)).toContainEqual(["docker", "stop", "-t", "30", N]);
    const rec = (await readRecord(f.deps.stateDir, ID))!;
    expect([rec.status, rec.reason, rec.stopRequested]).toEqual(["stopped", "stopped by `hapi run stop`", "stopped"]);
    expect(out).toEqual([`run ${ID}: stopped: stopped by \`hapi run stop\``]);
    expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);
  });

  test("the stop is recorded before the container is stopped, so a supervisor that finalizes first records it too", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, outputs: completedOutputs("failed") });
    const run = f.deps.run;
    let seen: string | undefined;
    f.deps.run = async (cmd, o) => {
      if (cmd[1] === "stop") seen = (await readRecord(f.deps.stateDir, ID))!.stopRequested;
      return run(cmd, o);
    };
    await runStop([ID], f.deps);
    expect(seen).toBe("stopped");
  });

  test("stop refuses a run whose container doesn't exist yet, as in start's creation window, and records nothing (H-218)", async () => {
    const { err } = capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, objects: false });
    // Start holds its lock while it makes the run: the stop's reap can't take it, and the record is live with no container yet.
    expect(await withStartLock(f.deps, () => runStop([ID], f.deps))).toBe(1);
    expect(err.at(-1)).toBe(
      `hapi run stop: run ${ID} has no container yet: its start may still be making it, so wait and stop it again; a container removed around hapi is reaped by the next \`hapi run\` command`,
    );
    expect((await readRecord(f.deps.stateDir, ID))!.stopRequested).toBeUndefined();
    expect(f.calls.filter((c) => c.cmd[1] === "stop")).toEqual([]);
  });

  test("a stop outranks the deadline while the run is live; a run another process is finalizing keeps how it ends", async () => {
    const { err } = capture();
    const STOPPED = ["stopped", "stopped by `hapi run stop`", "stopped"];
    const ending = async (f: ReturnType<typeof fakeRun>) => {
      const r = (await readRecord(f.deps.stateDir, ID))!;
      return [r.status, r.reason, r.stopRequested];
    };
    const past = new Date(NOW.getTime() - 1000).toISOString();
    // The deadline's stop, in its grace: the record already says timed-out.
    const a = fakeRun();
    await seedRun(a, { id: ID, stopRequested: "timed-out", outputs: completedOutputs() });
    expect(await runStop([ID], a.deps)).toBe(0);
    expect(await ending(a)).toEqual(STOPPED);
    // Past its deadline, its supervisor gone: the stop's own reap leaves it to the stop.
    const b = fakeRun();
    await seedRun(b, { id: ID, deadline: past, outputs: completedOutputs() });
    const seen: (string | undefined)[] = [];
    const run = b.deps.run;
    b.deps.run = async (cmd, o) => {
      if (cmd[1] === "stop") seen.push((await readRecord(b.deps.stateDir, ID))!.stopRequested);
      return run(cmd, o);
    };
    expect(await runStop([ID], b.deps)).toBe(0);
    expect(await ending(b)).toEqual(STOPPED);
    expect([seen.length > 0, seen.every((x) => x === "stopped")]).toEqual([true, true]);
    // Never the reverse: the deadline's reap leaves a stop as it is.
    const c = fakeRun();
    await seedRun(c, { id: ID, stopRequested: "stopped", deadline: past, outputs: completedOutputs() });
    await reapRuns(c.deps);
    expect(await ending(c)).toEqual(STOPPED);
    // Another process finalizing it (it holds the run's lock): the stop fails, and the record is as it was.
    const d = fakeRun();
    await seedRun(d, { id: ID, outputs: completedOutputs() });
    expect(await withRunLock(d.deps, ID, () => runStop([ID], d.deps))).toBe(1);
    expect(err.at(-1)).toStartWith("hapi run stop: another command");
    const rec = (await readRecord(d.deps.stateDir, ID))!;
    expect([rec.status, rec.stopRequested]).toEqual(["live", undefined]);
  });

  test("stop of a run that has ended says so and changes nothing; an unknown run is an error", async () => {
    const { out, err } = capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, status: "succeeded", objects: false });
    expect(await runStop([ID], f.deps)).toBe(0);
    expect(out).toEqual([`run ${ID} has already ended: succeeded`]);
    expect(f.calls.filter((c) => c.cmd[1] === "stop")).toEqual([]);
    expect(await runStop(["cccccccccccc"], f.deps)).toBe(1);
    expect(err).toEqual([`hapi run stop: there is no run cccccccccccc in ${f.deps.stateDir}`]);
  });

  test("stop and supervise take exactly one run id", async () => {
    const { err } = capture();
    const f = fakeRun();
    for (const args of [[], [ID, ID], ["../x"], ["--all"]]) {
      expect(await runStop(args, f.deps)).toBe(2);
      expect(await runSupervise(args, f.deps)).toBe(2);
    }
    expect(f.calls).toEqual([]);
    expect(err).toContain("usage: hapi run stop <run-id>");
    expect(err).toContain("usage: hapi run supervise <run-id>");
  });
});

describe("the hapi CLI", () => {
  test("registers run start, run stop and run supervise, each with its usage", async () => {
    const { out, err } = capture();
    expect(await main(["--help"])).toBe(0);
    for (const name of ["run start", "run stop", "run supervise"]) expect(out.join("\n")).toMatch(new RegExp(`^  ${name} +\\S`, "m"));
    expect(await main(["run", "start"])).toBe(2);
    expect(await main(["run", "stop"])).toBe(2);
    expect(await main(["run", "supervise", "x"])).toBe(2);
    expect(err).toEqual([START_USAGE, "usage: hapi run stop <run-id>", "usage: hapi run supervise <run-id>"]);
  });
});
