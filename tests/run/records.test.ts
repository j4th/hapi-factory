/**
 * Run records and admission (src/run/records.ts): the key (a work order runs
 * once per commit), the global cap (runs.max_live) and one live run per repo
 * (H-090), checked under the launcher's lock, with liveness from Docker's
 * labels, never a pid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { runStart } from "../../src/run/lifecycle";
import { isLive, keyProblem, RUN_ID, runKey, type RunRecord } from "../../src/run/records";
import { PROJECT_LABEL, RUN_LABEL } from "../../src/stack/up";
import { capture, cleanup } from "../secrets/helpers";
import { fakeRepo, fakeRun, fakeSecret, SHA, seedRun, writeArchonEnv, writeOrder } from "./helpers";

afterEach(cleanup);

const KEY = runKey("0003-check-run", SHA);

function rec(runId: string, status: RunRecord["status"], startedAt: string, key = KEY): RunRecord {
  const name = `hapi-run-${runId}`;
  return {
    runId, key, project: "hapi", repo: "/srv/repo/.git", sha: SHA, workOrder: "0003-check-run", workflow: "hapi-check-run",
    container: name, network: name, volumes: { work: `${name}-work`, out: `${name}-out` }, startedAt, deadline: startedAt, status,
  };
}

describe("runKey", () => {
  test("is the SHA-256 hex of the work order id and the commit: the same pair always has the same key, any other pair another", () => {
    expect(KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(runKey("0003-check-run", SHA)).toBe(KEY);
    expect(runKey("0003-check-run", SHA.replace("4", "5"))).not.toBe(KEY);
    expect(runKey("0004-other", SHA)).not.toBe(KEY);
    // The two parts can't be shifted into each other.
    expect(runKey("a", "bc")).not.toBe(runKey("ab", "c"));
  });
});

describe("keyProblem", () => {
  const want = { key: KEY, workOrder: "0003-check-run", sha: SHA };

  test("the key refuses a live or succeeded run, and a failed one unless --retry-of names it", () => {
    expect(keyProblem([], want)).toBeUndefined();
    // Another key is another work order or commit.
    expect(keyProblem([rec("aaaaaaaaaaaa", "live", "2026-10-29T10:00:00Z", "f".repeat(64))], want)).toBeUndefined();

    expect(keyProblem([rec("aaaaaaaaaaaa", "live", "2026-10-29T10:00:00Z")], want)).toBe(
      "run aaaaaaaaaaaa of work order 0003-check-run at 4bf92f3577b3 is live: a work order runs once per commit; wait for it, or stop it with `hapi run stop aaaaaaaaaaaa`",
    );
    expect(keyProblem([rec("aaaaaaaaaaaa", "succeeded", "2026-10-29T10:00:00Z")], { ...want, retryOf: "aaaaaaaaaaaa" })).toBe(
      "run aaaaaaaaaaaa of work order 0003-check-run at 4bf92f3577b3 already succeeded: a work order runs once per commit",
    );
    for (const status of ["failed", "timed-out", "stopped"] as const) {
      const runs = [rec("aaaaaaaaaaaa", status, "2026-10-29T10:00:00Z")];
      expect(keyProblem(runs, want)).toBe(`run aaaaaaaaaaaa of work order 0003-check-run at 4bf92f3577b3 ended ${status}: pass --retry-of aaaaaaaaaaaa to run it again`);
      expect(keyProblem(runs, { ...want, retryOf: "aaaaaaaaaaaa" })).toBeUndefined();
    }
  });

  test("--retry-of must name the last run of the key: not an older one, not another key's, not one that never was", () => {
    const runs = [rec("bbbbbbbbbbbb", "failed", "2026-10-29T11:00:00Z"), rec("aaaaaaaaaaaa", "failed", "2026-10-29T10:00:00Z")];
    expect(keyProblem(runs, { ...want, retryOf: "bbbbbbbbbbbb" })).toBeUndefined();
    expect(keyProblem(runs, { ...want, retryOf: "aaaaaaaaaaaa" })).toBe("--retry-of aaaaaaaaaaaa is not the last run of work order 0003-check-run at 4bf92f3577b3: that is bbbbbbbbbbbb");
    expect(keyProblem([], { ...want, retryOf: "cccccccccccc" })).toBe("--retry-of cccccccccccc: work order 0003-check-run at 4bf92f3577b3 has no run to retry");
  });
});

describe("admission, under the lock", () => {
  async function start(f: ReturnType<typeof fakeRun>, repo: string) {
    writeArchonEnv(f.xdg, { ANTHROPIC_API_KEY: fakeSecret("ANTHROPIC_API_KEY") });
    return runStart(["--repo", repo, "--work-order", writeOrder(f.tmp)], f.deps);
  }
  const LIVE_LIST = ["docker", "ps", "--filter", "label=org.hapi.run", "--filter", "label=org.hapi.project=hapi", "--format", '{{.Label "org.hapi.run"}}\t{{.Names}}'];
  const created = (f: ReturnType<typeof fakeRun>) => f.calls.filter((c) => ["create", "connect"].includes(c.cmd[2] ?? "") || c.cmd[1] === "run");

  test("max_live is enforced under the lock", async () => {
    const { err } = capture();
    let locks: string[] | undefined;
    const f = fakeRun({
      onCall: (cmd) => {
        if (cmd.join(" ") === LIVE_LIST.join(" ")) locks = readdirSync(join(f.xdg, "hapi", "locks")).filter((n) => n.endsWith(".lock"));
      },
    });
    await seedRun(f, { id: "aaaaaaaaaaaa", repo: "/srv/other/.git" });
    expect(await start(f, fakeRepo(f.tmp))).toBe(1);
    expect(err).toEqual(["hapi run start: 1 runs are live and runs.max_live is 1 (policy/runs.yaml): wait for one to end, or stop one with `hapi run stop <id>`"]);
    // The live runs were counted while the lock was held, and the lock is gone again.
    expect(locks).toHaveLength(1);
    expect(readdirSync(join(f.xdg, "hapi", "locks")).filter((n) => n.endsWith(".lock"))).toEqual([]);
    expect(created(f)).toEqual([]);
    expect(readdirSync(f.deps.stateDir)).toEqual(["aaaaaaaaaaaa"]);
  });

  test("a second live run for one repo is refused (H-090), even below max_live", async () => {
    const { err } = capture();
    const f = fakeRun({ runs: { max_live: 2 } });
    const repo = fakeRepo(f.tmp);
    await seedRun(f, { id: "aaaaaaaaaaaa", repo: realpathSync(join(repo, ".git")) });
    expect(await start(f, repo)).toBe(1);
    expect(err).toEqual([
      `hapi run start: run aaaaaaaaaaaa is live for ${realpathSync(join(repo, ".git"))}: one live run per repo (H-090); wait for it, or stop it with \`hapi run stop aaaaaaaaaaaa\``,
    ]);
    expect(created(f)).toEqual([]);
    // Another repo, below the cap, starts.
    capture();
    expect(await start(f, fakeRepo(f.tmp, "other"))).toBe(0);
  });

  test("a live run with no record can't be placed in a repo, so it is refused rather than ignored", async () => {
    const { err } = capture();
    const f = fakeRun({ runs: { max_live: 2 } });
    f.world.containers.set("hapi-run-dddddddddddd", { name: "hapi-run-dddddddddddd", labels: { "org.hapi.run": "dddddddddddd", "org.hapi.project": "hapi" }, running: true });
    expect(await start(f, fakeRepo(f.tmp))).toBe(1);
    expect(err[0]).toBe(
      `hapi run start: run dddddddddddd is live but has no record in ${f.deps.stateDir}, so its repo is unknown: remove it with \`docker rm -f hapi-run-dddddddddddd\`, or \`mise run down\``,
    );
  });

  test("a helper container (a run label, but not a run's name) is not counted as a live run", async () => {
    capture();
    const f = fakeRun();
    f.world.containers.set("quirky_name", { name: "quirky_name", labels: { "org.hapi.run": "", "org.hapi.project": "hapi" }, running: true });
    expect(await start(f, fakeRepo(f.tmp))).toBe(0);
  });
});

describe("liveness", () => {
  test("liveness comes from docker ps --filter label=org.hapi.run=<id> --filter label=org.hapi.project=<project>, not a pid", async () => {
    const project = "hapi-int-ab12cd34";
    const f = fakeRun({ project });
    await seedRun(f, { id: "aaaaaaaaaaaa" });
    await seedRun(f, { id: "bbbbbbbbbbbb", running: false });
    expect(await isLive(f.deps, "aaaaaaaaaaaa")).toBe(true);
    expect(await isLive(f.deps, "bbbbbbbbbbbb")).toBe(false);
    const filters = (id: string) => ["--filter", `label=${RUN_LABEL}=${id}`, "--filter", `label=${PROJECT_LABEL}=${project}`];
    expect(f.calls.map((c) => c.cmd)).toEqual([
      ["docker", "ps", ...filters("aaaaaaaaaaaa"), "--format", "{{.Names}}"],
      ["docker", "ps", ...filters("bbbbbbbbbbbb"), "--format", "{{.Names}}"],
    ]);
    // The record holds no pid to go stale.
    const record = JSON.parse(readFileSync(join(f.deps.stateDir, "aaaaaaaaaaaa", "record.json"), "utf8"));
    expect(Object.keys(record).some((k) => /pid/i.test(k))).toBe(false);
  });

  test("when Docker can't say, liveness throws rather than answering no", async () => {
    const f = fakeRun({ failing: ["docker ps"] });
    await expect(isLive(f.deps, "aaaaaaaaaaaa")).rejects.toThrow(/docker ps .* failed \(exit 1\): boom/);
  });

  test("a run id is twelve lower-case hex digits", () => {
    expect(RUN_ID.test("ab12cd34ef56")).toBe(true);
    for (const id of ["AB12CD34EF56", "ab12cd34ef5", "ab12cd34ef567", "../etc/x", ""]) expect(RUN_ID.test(id)).toBe(false);
  });
});
