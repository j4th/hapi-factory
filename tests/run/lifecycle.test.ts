/**
 * `hapi run start|supervise|stop`, finalize and reaping (src/run/lifecycle.ts;
 * design §3.1, §6a items 11, 12, 14, 16), with every docker and git call
 * recorded and answered by the fake world in ./helpers.ts. The order of steps
 * is the contract: nothing is created before the work order, the env file and
 * the admission checks pass, and anything created is removed again if a later
 * step fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli";
import { START_USAGE } from "../../src/run/cli";
import { bundleProblem, finalizeRun, guardProblems, reapRuns, runStart, runStop, runSupervise, STOP_GRACE_S } from "../../src/run/lifecycle";
import { readRecord, RUN_ID, runKey } from "../../src/run/records";
import { reexecScript, runCommand } from "../../src/stack/up";
import { loadWorkOrder } from "../../src/workorder/validate";
import { capture, caught, cleanup, tempDir } from "../secrets/helpers";
import { REPO } from "../stack/helpers";
import { type Call, completedOutputs, fakeRepo, fakeRun, fakeSecret, file, NOW, SHA, seedRun, writeArchonEnv, writeOrder } from "./helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const N = `hapi-run-${ID}`;
const ARCHON_RUN = "f0e1d2c3-0000-4000-8000-000000000001";
const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** A fake world with the archon env file in place, a source repo and a valid work order. */
function ready(o: Parameters<typeof fakeRun>[0] = {}) {
  const f = fakeRun(o);
  const secret = fakeSecret("ANTHROPIC_API_KEY");
  writeArchonEnv(f.xdg, { ANTHROPIC_API_KEY: secret });
  return { ...f, secret, repo: fakeRepo(f.tmp), order: writeOrder(f.tmp) };
}

/** The calls that create, connect or run something (not listings, inspects or git). */
const changes = (calls: Call[]) => calls.filter((c) => c.cmd[0] === "docker" && !["ps", "inspect", "ls"].includes(c.cmd[1] === "network" || c.cmd[1] === "volume" ? c.cmd[2]! : c.cmd[1]!));
const locksIn = (xdg: string) => (existsSync(join(xdg, "hapi", "locks")) ? readdirSync(join(xdg, "hapi", "locks")).filter((n) => n.endsWith(".lock")) : []);

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
    writeArchonEnv(f.xdg, { PI_OFFLINE: "0" });
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
});

describe("hapi run start: the order of steps", () => {
  test("start validates, locks and writes record.json and run.json, then creates the network and checks it, connects egress, makes and chowns the volumes, runs the container and spawns the supervisor; it prints the run id", async () => {
    const { out } = capture();
    const seen: string[] = [];
    let f!: ReturnType<typeof ready>;
    f = ready({
      onCall: (cmd) => {
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
    expect(made.slice(0, 5)).toEqual([
      ["docker", "network", "create", "--internal", ...labels, N],
      ["docker", "network", "connect", "--alias", "egress-archon", N, "hapi-egress-archon-1"],
      ["docker", "volume", "create", ...labels, `${N}-work`],
      ["docker", "volume", "create", ...labels, `${N}-out`],
      [
        "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true",
        ...labels, "-v", `${N}-work:/w`, "-v", `${N}-out:/o`, "--entrypoint", "chown", "hapi-factory/archon:0.12.1", "1001:1001", "/w", "/o",
      ],
    ]);
    expect(made[5]!.slice(0, 7)).toEqual(["docker", "run", "-d", "--pull", "never", "--name", N]);
    expect(made).toHaveLength(6);
    // The network was checked right after it was made.
    const at = (pred: (c: string[]) => boolean) => f.calls.findIndex((c) => pred(c.cmd));
    expect(at((c) => c[2] === "inspect")).toBe(at((c) => c[2] === "create" && c[1] === "network") + 1);
    expect(f.spawned).toEqual([["hapi", "run", "supervise", id]]);
    // Step 1 happened, under the lock, before anything was created; the lock is released after.
    expect(seen).toEqual(["record true", "run.json true", "locks 1"]);
    expect(locksIn(f.xdg)).toEqual([]);

    const dir = join(f.deps.stateDir, id);
    expect(JSON.parse(readFileSync(join(dir, "run.json"), "utf8"))).toEqual({
      run_id: id, work_order: "0003-check-run", traceparent: TRACEPARENT, budget_usd: 1.5, public: true, workflow: "hapi-check-run", started_at: NOW.toISOString(),
    });
    const gitDir = realpathSync(join(f.repo, ".git"));
    expect(await readRecord(f.deps.stateDir, id)).toEqual({
      runId: id, key: runKey("0003-check-run", SHA), project: "hapi", repo: gitDir, sha: SHA, workOrder: "0003-check-run", workflow: "hapi-check-run",
      container: N, network: N, volumes: { work: `${N}-work`, out: `${N}-out` },
      startedAt: NOW.toISOString(), deadline: new Date(NOW.getTime() + 30 * 60_000).toISOString(), status: "live",
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
});

describe("hapi run start: rollback", () => {
  const steps = ["docker network connect", "docker volume create", "docker run --rm", "docker run -d"];

  test("on any failure after the lock, start removes what it created (disconnecting egress before removing the network) and releases the lock", async () => {
    for (const failing of [...steps, "spawn"]) {
      const { err } = capture();
      const f = ready(failing === "spawn" ? {} : { failing: [failing] });
      if (failing === "spawn") {
        f.deps.spawnDetached = () => {
          throw new Error("cannot start the supervisor");
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

  test("a run network that isn't internal or isn't private stops start, and what it made is removed", async () => {
    for (const o of [{ internal: false }, { subnet: "100.64.0.0/24" }]) {
      const { err } = capture();
      const f = ready(o);
      expect(await runStart(["--repo", f.repo, "--work-order", f.order], f.deps)).toBe(1);
      expect(err.at(-1)).toMatch(/^hapi run start: network hapi-run-[0-9a-f]{12} (is not internal|has subnet 100\.64\.0\.0\/24)/);
      expect(changes(f.calls).some((c) => c.cmd[1] === "run" || c.cmd[2] === "connect")).toBe(false);
      expect([f.world.networks.size, readdirSync(f.deps.stateDir)]).toEqual([0, []]);
    }
  });
});

describe("hapi run supervise", () => {
  test("supervise waits for the run, until its deadline at most, then finalizes it", async () => {
    capture();
    const f = fakeRun();
    await seedRun(f, { id: ID, outputs: completedOutputs() });
    expect(await runSupervise([ID], f.deps)).toBe(0);
    expect(f.calls.find((c) => c.cmd[0] === "timeout")!.cmd).toEqual(["timeout", String(29 * 60), "docker", "wait", N]);
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
    expect(f.calls.some((c) => c.cmd[0] === "timeout")).toBe(false);
    expect((await readRecord(f.deps.stateDir, ID))!.status).toBe("timed-out");
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
    expect(done).toEqual({ ...rec, status: "succeeded" });
    expect(await readRecord(f.deps.stateDir, ID)).toEqual(done);
    const out = join(f.deps.stateDir, ID, "out");
    expect(readdirSync(out).sort()).toEqual(["result.json", "run.bundle", "transcript.jsonl"]);
    const cmds = f.calls.map((c) => c.cmd);
    const at = (pred: (c: string[]) => boolean) => cmds.findIndex(pred);
    const order = [
      at((c) => c[1] === "run" && c.includes("--entrypoint")), // the copy-out listing
      at((c) => c.includes("list-heads")),
      at((c) => c[1] === "rm"),
      at((c) => c[2] === "disconnect"),
      at((c) => c[2] === "rm" && c[1] === "network"),
      at((c) => c[2] === "rm" && c[1] === "volume"),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(cmds[order[2]!]).toEqual(["docker", "rm", "-f", N]);
    expect(cmds[order[3]!]).toEqual(["docker", "network", "disconnect", "-f", N, "hapi-egress-archon-1"]);
    expect(f.world.containers.size + f.world.networks.size + f.world.volumes.size).toBe(0);

    // A paused run exits 0 (spike 07 finding 5), so the status comes from Archon, and paused is failed.
    const g = fakeRun();
    const paused = await finalizeRun(await seedRun(g, { id: ID, running: false, outputs: completedOutputs("paused") }), g.deps);
    expect(paused.status).toBe("failed");
    expect(paused.reason).toBe("the run paused (Archon status paused): v1 answers no approval, so a paused run fails (design §3.1)");
    const h = fakeRun();
    const failed = await finalizeRun(await seedRun(h, { id: ID, running: false, outputs: completedOutputs("failed") }), h.deps);
    expect([failed.status, failed.reason]).toEqual(["failed", "the workflow failed (Archon status failed)"]);
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
    const f = fakeRun();
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
    expect(stop).toBeLessThan(cmds.findIndex((c) => c.startsWith("docker run --rm")));
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
