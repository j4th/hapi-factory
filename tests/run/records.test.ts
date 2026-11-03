/**
 * Run records and admission (src/run/records.ts): the key (a work order runs
 * once per commit), the global cap (runs.max_live) and one live run per repo
 * (H-090), checked under the launcher's lock, with liveness from Docker's
 * labels, never a pid.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RUN_KINDS } from "../../src/run/kinds";
import { runStart } from "../../src/run/lifecycle";
import { capacityProblem, isLive, keyPart, keyProblem, readRecord, RUN_ID, runKey, type RunRecord } from "../../src/run/records";
import { PROJECT_LABEL, RUN_LABEL } from "../../src/stack/up";
import { capture, caught, cleanup, tempDir } from "../secrets/helpers";
import { fakeRepo, fakeRun, fakeSecret, SHA, seedRun, writeOrder, writeZoneEnv } from "./helpers";

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

  test("a non-worker run's key adds <kind>:<round>; a hand run's key is the two-part key, unchanged, so Plan 02's records stay valid", () => {
    const id = "0003-check-run";
    const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(runKey(id, SHA)).toBe(sha256(`${id}\0${SHA}`));
    expect(runKey(id, SHA, "fix:1")).toBe(sha256(`${id}\0${SHA}\0fix:1`));
    expect(new Set([runKey(id, SHA), runKey(id, SHA, "fix:1"), runKey(id, SHA, "fix:2"), runKey(id, SHA, "verify:0")]).size).toBe(4);
  });
});

describe("keyPart", () => {
  test("keyPart: a hand run keeps the two-part key, and every engine key names its kind, its round and, from the first retry on, its retry", () => {
    expect(keyPart("worker", 0)).toBeUndefined();
    expect(keyPart("worker", 0, 0)).toBe("worker:0");
    expect([keyPart("verify", 0), keyPart("verify", 0, 0), keyPart("fix", 1)]).toEqual(["verify:0", "verify:0", "fix:1"]);
    expect([keyPart("worker", 0, 1), keyPart("review", 0, 2)]).toEqual(["worker:0:retry1", "review:0:retry2"]);
    const id = "0003-check-run";
    const keys = [runKey(id, SHA)];
    for (const [k, r] of [["worker", 0], ["fix", 1]] as const) for (const n of [0, 1, 2]) keys.push(runKey(id, SHA, keyPart(k, r, n)));
    expect(new Set(keys).size).toBe(7);
  });
});

describe("readRecord", () => {
  /** A record dir holding `rec` as record.json, written by hand: readRecord must refuse what hapi never writes. */
  function written(rec: Record<string, unknown>): string {
    const state = tempDir("hapi-records-");
    mkdirSync(join(state, rec.runId as string));
    writeFileSync(join(state, rec.runId as string, "record.json"), JSON.stringify(rec));
    return state;
  }
  const base = { ...rec("aaaaaaaaaaaa", "succeeded", "2026-10-29T10:00:00Z") };

  test("a record whose kind is no run kind is not one hapi wrote", async () => {
    expect(RUN_KINDS).toEqual(["worker", "verify", "review", "fix"]);
    for (const kind of ["build", "", 1, null]) {
      const e = await caught(readRecord(written({ ...base, kind }), "aaaaaaaaaaaa"));
      expect([kind, e.message]).toEqual([kind, expect.stringContaining("is not a run record hapi wrote")]);
    }
    for (const kind of RUN_KINDS) expect((await readRecord(written({ ...base, kind }), "aaaaaaaaaaaa"))!.kind).toBe(kind);
    // A Plan 02 record has no kind, and still reads back.
    expect((await readRecord(written(base), "aaaaaaaaaaaa"))!.kind).toBeUndefined();
  });

  test("a record whose retry isn't a whole number of at least 0 is not one hapi wrote", async () => {
    for (const retry of [-1, 1.5, "1"]) {
      const e = await caught(readRecord(written({ ...base, retry }), "aaaaaaaaaaaa"));
      expect([retry, e.message]).toEqual([retry, expect.stringContaining("is not a run record hapi wrote")]);
    }
    expect((await readRecord(written({ ...base, retry: 0 }), "aaaaaaaaaaaa"))!.retry).toBe(0);
  });

  test("a record whose budget or spend isn't a finite number of at least 0, or whose round or turns isn't a whole number of at least 0, is not one hapi wrote", async () => {
    // JSON has no NaN or Infinity: JSON.stringify writes them as null.
    const bad: [string, unknown][] = [
      ["budgetUsd", -1], ["budgetUsd", Number.NaN], ["budgetUsd", "3"], ["spendUsd", -0.1], ["spendUsd", Number.POSITIVE_INFINITY],
      ["round", -1], ["round", 1.5], ["turns", -1], ["turns", 2.5], ["turns", "2"],
    ];
    for (const [field, value] of bad) {
      const e = await caught(readRecord(written({ ...base, [field]: value }), "aaaaaaaaaaaa"));
      expect([field, value, e.message]).toEqual([field, value, expect.stringContaining("is not a run record hapi wrote")]);
    }
    const good = { ...base, budgetUsd: 0, spendUsd: 0.42, round: 1, turns: 0 };
    expect(await readRecord(written(good), "aaaaaaaaaaaa")).toEqual(good as RunRecord);
  });

  test(`a record whose decisions isn't "off" is not one hapi wrote`, async () => {
    for (const decisions of ["on", "enforce", true, ""]) {
      const e = await caught(readRecord(written({ ...base, decisions }), "aaaaaaaaaaaa"));
      expect([decisions, e.message]).toEqual([decisions, expect.stringContaining("is not a run record hapi wrote")]);
    }
    expect((await readRecord(written({ ...base, decisions: "off" }), "aaaaaaaaaaaa"))!.decisions).toBe("off");
    expect("decisions" in (await readRecord(written(base), "aaaaaaaaaaaa"))!).toBe(false);
  });
});

describe("forgeRepo (m23)", () => {
  test("a record's forgeRepo, when it has one, is a GitHub repository's owner/name", async () => {
    const state = (rec: object) => {
      const dir = tempDir("hapi-records-");
      mkdirSync(join(dir, "aaaaaaaaaaaa"));
      writeFileSync(join(dir, "aaaaaaaaaaaa", "record.json"), JSON.stringify(rec));
      return dir;
    };
    const base = rec("aaaaaaaaaaaa", "succeeded", "2026-10-29T10:00:00Z");
    for (const forgeRepo of ["example-owner", "a/b/c", "../x", "owner/..", "", 7, null]) {
      const e = await caught(readRecord(state({ ...base, forgeRepo }), "aaaaaaaaaaaa"));
      expect([forgeRepo, e.message]).toEqual([forgeRepo, expect.stringContaining("is not a run record hapi wrote")]);
    }
    expect((await readRecord(state({ ...base, forgeRepo: "example-owner/sandbox" }), "aaaaaaaaaaaa"))!.forgeRepo).toBe("example-owner/sandbox");
    expect((await readRecord(state(base), "aaaaaaaaaaaa"))!.forgeRepo).toBeUndefined();
    // The container's exit code, when finalize could read it, is an integer.
    for (const exitCode of [1.5, "0", null]) {
      const e = await caught(readRecord(state({ ...base, exitCode }), "aaaaaaaaaaaa"));
      expect([exitCode, e.message]).toEqual([exitCode, expect.stringContaining("is not a run record hapi wrote")]);
    }
    for (const exitCode of [0, 137, -1]) expect((await readRecord(state({ ...base, exitCode }), "aaaaaaaaaaaa"))!.exitCode).toBe(exitCode);
  });

  test("capacityProblem keys one live run per repo by forgeRepo when the start has one, and by the source's git dir always", () => {
    const d = { stateDir: "/state", project: "hapi", runs: { max_live: 5 } } as Parameters<typeof capacityProblem>[3];
    const mirror = { ...rec("aaaaaaaaaaaa", "live", "2026-10-29T10:00:00Z"), repo: "/engine/mirrors/example-owner/sandbox.git", forgeRepo: "example-owner/sandbox" };
    const refused = "run aaaaaaaaaaaa is live for example-owner/sandbox: one live run per repo (H-090); wait for it, or stop it with `hapi run stop aaaaaaaaaaaa`";
    // A verify from a scratch copy of the same repo: another git dir, the same GitHub repo.
    expect(capacityProblem(["aaaaaaaaaaaa"], [mirror], { repo: "/engine/scratch/0003/repo.git", forgeRepo: "example-owner/sandbox" }, d)).toBe(refused);
    expect(capacityProblem(["aaaaaaaaaaaa"], [mirror], { repo: "/engine/scratch/0003/repo.git", forgeRepo: "example-owner/other" }, d)).toBeUndefined();
    // The same git dir is the same repo, whatever either says of GitHub (a hand run names none).
    expect(capacityProblem(["aaaaaaaaaaaa"], [mirror], { repo: mirror.repo }, d)).toBe(`run aaaaaaaaaaaa is live for ${mirror.repo}: one live run per repo (H-090); wait for it, or stop it with \`hapi run stop aaaaaaaaaaaa\``);
    // GitHub's names aren't case-sensitive, so neither is the comparison.
    expect(capacityProblem(["aaaaaaaaaaaa"], [mirror], { repo: "/engine/scratch/0003/repo.git", forgeRepo: "Example-Owner/Sandbox" }, d)).toBe(refused.replace("for example-owner/sandbox", "for Example-Owner/Sandbox"));
    // A run that isn't live doesn't count.
    expect(capacityProblem([], [mirror], { repo: "/x.git", forgeRepo: "example-owner/sandbox" }, d)).toBeUndefined();
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
    writeZoneEnv(f.xdg, "archon", { ANTHROPIC_API_KEY: fakeSecret("ANTHROPIC_API_KEY") });
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
