/**
 * The engine's commands (Plan 03 Task 14, src/engine/cli.ts): `hapi poll`, `hapi status`'s usage, `hapi retry` (the
 * operator's next pass of a failed work order, under the poll lock: m19), the re-exec as hapi, and `pipelineDepsOf`,
 * the production wiring of Task 13's `PipelineDeps`. Over `tickWorld` and `fakeRun`: no Docker, no forge, no model.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../../src/decide/record";
import { pipelineDepsOf, pollCommand, POLL_USAGE, RETRY_USAGE, retryCommand, statusCommand, STATUS_USAGE } from "../../src/engine/cli";
import { makeTick, withPollLock } from "../../src/engine/poll";
import { readState, retryState, statePath, type StatusEvent, writeState, type WorkOrderState } from "../../src/engine/state";
import { githubForge } from "../../src/forge";
import { loadPolicy } from "../../src/policy/load";
import { matchCommand } from "../../src/policy/commands";
import { reexecScript } from "../../src/stack/up";
import { fakeRun, fakeSecret, NOW, writeZoneEnv } from "../run/helpers";
import { capture, cleanup } from "../secrets/helpers";
import { MERGE, planningWorld, policyRoot, registered, SANDBOX, SECOND, tickWorld } from "./helpers";

afterEach(cleanup);

const W1 = "0001-skeleton-and-crack-cookie";
const W2 = "0002-search-fortunes";
const W3 = "0003-fortune-of-the-day";
const REASON = "worker run 0a0b0c0d0e0f ended failed: preflight exited 1";

const stateOf = (over: Partial<WorkOrderState>): WorkOrderState => ({
  repo: SANDBOX,
  id: W1,
  mergeSha: MERGE,
  planningPr: 3,
  phase: "failed",
  runs: ["0a0b0c0d0e0f"],
  autoRounds: 1,
  reworkRounds: 0,
  retry: 0,
  reasons: [REASON],
  updatedAt: "2026-10-29T10:00:00.000Z",
  ...over,
});

const eventsOf = (engineDir: string): StatusEvent[] => {
  const file = join(engineDir, "events.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : [];
};

describe("hapi poll", () => {
  test("hapi poll --once runs one tick, and exits 1 only when a repo failed", async () => {
    const { out } = capture();
    const w = tickWorld();
    expect(await pollCommand(["--once"], { run: w.f.deps, poll: w.d })).toBe(0);
    expect(out).toEqual([`${SANDBOX}: nothing to do`, `${SECOND}: nothing to do`]);
    out.length = 0;
    const bad = tickWorld({ fetchFails: { [SECOND]: new Error("cannot fetch example-owner/second into its mirror (git fetch exited 128): fatal: no route") } });
    expect(await pollCommand(["--once"], { run: bad.f.deps, poll: bad.d })).toBe(1);
    expect(out).toContain(`${SECOND}: failed closed: cannot fetch example-owner/second into its mirror (git fetch exited 128): fatal: no route; the next tick retries`);
    // A tick another holds is a skip: exit 0.
    out.length = 0;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(w.engineDir, { recursive: true });
    expect(await withPollLock(w.engineDir, w.f.deps.env, () => pollCommand(["--once"], { run: w.f.deps, poll: w.d }))).toBe(0);
    expect(out).toEqual(["poll: another tick holds the poll lock"]);
  });

  test("M6: hapi poll --once exits 1 when the tick's reap failed", async () => {
    const { out } = capture();
    const w = tickWorld();
    const { chmodSync, mkdirSync } = await import("node:fs");
    mkdirSync(w.f.deps.stateDir, { recursive: true });
    chmodSync(w.f.deps.stateDir, 0o000);
    try {
      expect(await pollCommand(["--once"], { run: w.f.deps, poll: w.d })).toBe(1);
    } finally {
      chmodSync(w.f.deps.stateDir, 0o700);
    }
    expect(out.some((l) => l.startsWith("poll: "))).toBe(true);
  });

  test("hapi poll ticks again every runs.poll_interval_s", async () => {
    const { out, err } = capture();
    const w = tickWorld();
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      throw new Error("stop the loop");
    };
    expect(await pollCommand([], { run: w.f.deps, poll: w.d, sleep })).toBe(1);
    expect(slept).toEqual([120_000]);
    expect(out).toEqual([`${SANDBOX}: nothing to do`, `${SECOND}: nothing to do`]);
    expect(err.at(-1)).toBe("hapi poll: stop the loop");
  });
});

describe("usage", () => {
  test("usage errors exit 2 and run nothing", async () => {
    const { err } = capture();
    const f = fakeRun({ user: "dev" });
    const cases: [(a: string[]) => Promise<number>, string[], string][] = [
      [(a) => pollCommand(a, { run: f.deps }), ["--twice"], POLL_USAGE],
      [(a) => statusCommand(a, { run: f.deps }), ["a/b", "c/d"], STATUS_USAGE],
      [(a) => statusCommand(a, { run: f.deps }), ["x"], STATUS_USAGE],
      ...[[], ["a/b"], ["a/b", "0001-x", "extra"], ["notarepo", "0001-x"], ["a/..", "0001-x"], ["a/b", "../x"], ["a/b", "0001-X"], ["a/b", `0001-${"x".repeat(76)}`]].map(
        (a) => [(x: string[]) => retryCommand(x, { run: f.deps }), a, RETRY_USAGE] as [(a: string[]) => Promise<number>, string[], string],
      ),
    ];
    expect(`0001-${"x".repeat(76)}`).toHaveLength(81);
    for (const [cmd, args, usage] of cases) {
      err.length = 0;
      expect([args, await cmd(args)]).toEqual([args, 2]);
      expect([args, err]).toEqual([args, [usage]]);
    }
    // No re-exec: nothing ran, not even sudo.
    expect(f.calls).toEqual([]);
    expect([POLL_USAGE, STATUS_USAGE, RETRY_USAGE]).toEqual(["usage: hapi poll [--once]", "usage: hapi status [<owner>/<name>]", "usage: hapi retry <owner>/<name> <work-order-id>"]);
  });

  test("as another user, hapi poll re-execs as hapi, and so do hapi retry and hapi status", async () => {
    capture();
    const f = fakeRun({ user: "dev" });
    expect(await pollCommand(["--once"], { run: f.deps })).toBe(0);
    expect(await retryCommand([SANDBOX, W1], { run: f.deps })).toBe(0);
    expect(await statusCommand([SANDBOX], { run: f.deps })).toBe(0);
    expect(f.calls.map((c) => c.cmd)).toEqual([
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "poll", "--once"],
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "retry", SANDBOX, W1],
      ["sudo", "-u", "hapi", "-H", "--", "sh", "-c", reexecScript("hapi"), "hapi-stack", "status", SANDBOX],
    ]);
  });
});

describe("hapi retry", () => {
  function world() {
    const f = fakeRun();
    return { f, engineDir: join(f.tmp, "engine"), run: { ...f.deps, root: policyRoot() } };
  }

  test("hapi retry queues a failed work order under the poll lock, appends one event, and calls no forge or docker", async () => {
    const { out } = capture();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const w = world();
      const failed = stateOf({});
      await writeState(w.engineDir, failed);
      expect(await retryCommand([SANDBOX, W1], { run: w.run, engineDir: w.engineDir })).toBe(0);
      const s = (await readState(w.engineDir, SANDBOX, W1))!;
      expect([s.phase, s.retry]).toEqual(["queued", 1]);
      expect(s).toEqual(retryState(failed, NOW.toISOString()).state);
      expect(eventsOf(w.engineDir)).toEqual([retryState(failed, NOW.toISOString()).event]);
      expect(out).toEqual([
        `hapi retry: ${SANDBOX} ${W1} is queued again (retry 1), with 0 of the repo's work orders ahead of it: a poll tick starts its worker at ${MERGE.slice(0, 12)} once none is ahead and the caps allow`,
      ]);
      expect(w.f.calls).toEqual([]);
      // No token: nothing reached the network.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("hapi retry counts the work orders ahead of it", async () => {
    const { out } = capture();
    const w = world();
    await writeState(w.engineDir, stateOf({}));
    await writeState(w.engineDir, stateOf({ id: W2, phase: "queued", runs: [], reasons: [] }));
    await writeState(w.engineDir, stateOf({ id: W3, phase: "pr", pr: 12, reasons: [] }));
    // Another repo's queued work order isn't ahead of it either.
    await writeState(w.engineDir, stateOf({ repo: SECOND, id: W2, phase: "queued", reasons: [] }));
    expect(await retryCommand([SANDBOX, W1], { run: w.run, engineDir: w.engineDir })).toBe(0);
    expect(out.at(-1)).toContain("with 1 of the repo's work orders ahead of it");
  });

  test("hapi retry refuses while a tick holds the poll lock, past runs.max_retries, or for anything but a failed work order, and changes nothing", async () => {
    const { err } = capture();
    const refused = async (s: WorkOrderState | undefined, want: RegExp, inside?: true) => {
      const w = world();
      if (s !== undefined) await writeState(w.engineDir, s);
      const file = statePath(w.engineDir, SANDBOX, W1);
      const before = readFileSync(file);
      const lines = eventsOf(w.engineDir).length;
      const go = () => retryCommand([SANDBOX, W1], { run: w.run, engineDir: w.engineDir });
      err.length = 0;
      expect(inside ? await withPollLock(w.engineDir, w.run.env, go) : await go()).toBe(1);
      expect(err).toHaveLength(1);
      expect(err[0]).toMatch(want);
      expect(readFileSync(file)).toEqual(before);
      expect(eventsOf(w.engineDir)).toHaveLength(lines);
      return w;
    };
    await refused(stateOf({}), /^hapi retry: another command, .+ hapi never takes the lock \(.+\) while its process runs: run hapi retry again when the tick ends$/, true);
    await refused(stateOf({ phase: "waiting", pr: 12 }), /^hapi retry: work order 0001-skeleton-and-crack-cookie is waiting, not failed: only a failed work order is retried/);
    await refused(stateOf({ retry: 2 }), /^hapi retry: work order 0001-skeleton-and-crack-cookie has been retried 2 times, and runs\.max_retries is 2: /);
    // A second retry after a success.
    const w = world();
    await writeState(w.engineDir, stateOf({}));
    expect(await retryCommand([SANDBOX, W1], { run: w.run, engineDir: w.engineDir })).toBe(0);
    const before = readFileSync(statePath(w.engineDir, SANDBOX, W1));
    err.length = 0;
    expect(await retryCommand([SANDBOX, W1], { run: w.run, engineDir: w.engineDir })).toBe(1);
    expect(err[0]).toMatch(/^hapi retry: work order 0001-skeleton-and-crack-cookie is queued, not failed: only a failed work order is retried/);
    expect(readFileSync(statePath(w.engineDir, SANDBOX, W1))).toEqual(before);
    expect(eventsOf(w.engineDir)).toHaveLength(1);
  });

  test("hapi retry: an unregistered repo or an unknown work order exits 1", async () => {
    const { err } = capture();
    const w = world();
    expect(await retryCommand(["example-owner/nope", W1], { run: w.run, engineDir: w.engineDir })).toBe(1);
    expect(err.at(-1)).toBe("hapi retry: example-owner/nope isn't registered in policy/repos.yaml");
    expect(await retryCommand([SANDBOX, "0009-none"], { run: w.run, engineDir: w.engineDir })).toBe(1);
    expect(err.at(-1)).toBe(`hapi retry: ${SANDBOX} has no work order 0009-none: \`hapi status ${SANDBOX}\` lists them`);
    expect(existsSync(w.engineDir)).toBe(false);
  });

  test("hapi retry is never in Hermes's allowlist", () => {
    const rules = loadPolicy("policy").commands.hermes.allow;
    expect(matchCommand(rules, ["hapi", "retry", SANDBOX, W1]).allowed).toBe(false);
    expect(matchCommand(rules, ["hapi", "retry"]).allowed).toBe(false);
    expect(matchCommand(rules, ["mise", "run", "hapi", "--", "retry", SANDBOX, W1]).allowed).toBe(false);
  });
});

describe("pipelineDepsOf", () => {
  test("pipelineDepsOf binds the repo owner as operator, the repo's visibility, both zones' secrets and the tick's two forges", async () => {
    const f = fakeRun();
    const archon = { ANTHROPIC_API_KEY: fakeSecret("anthropic"), HAPI_JEV_OPENROUTER_API_KEY: fakeSecret("jev"), OPENCODE_API_KEY: fakeSecret("opencode") };
    const review = { ANTHROPIC_API_KEY: fakeSecret("anthropic"), CODERABBIT_API_KEY: fakeSecret("coderabbit") };
    writeZoneEnv(f.xdg, "archon", archon);
    writeZoneEnv(f.xdg, "review", review);
    const policy = registered();
    const engineDir = join(f.tmp, "engine");
    const build = async (o: { private?: boolean } = {}) => {
      const world = planningWorld(SANDBOX, o);
      const minted: string[] = [];
      const tick = makeTick(
        {
          mint: async (_repo, p) => (minted.push(p), { token: `fake-${p}-token`, revoke: async () => {} }),
          forge: (repo, token) => githubForge({ repo, token, fetch: world.fetch }),
        },
        SANDBOX,
        [],
      );
      const emitted: StatusEvent[] = [];
      const d = await pipelineDepsOf(f.deps, policy, engineDir, SANDBOX, tick, async (e) => void emitted.push(e));
      return { d, world, minted, emitted, tick };
    };
    const pub = await build();
    expect(pub.d.operator).toBe("example-owner");
    expect([pub.d.repo, pub.d.engineDir, pub.d.central, pub.d.run]).toEqual([SANDBOX, engineDir, policy, f.deps]);
    expect(pub.d.public).toBe(true);
    expect((await build({ private: true })).d.public).toBe(false);
    // Both zones' names, for redaction; the archon zone's value never lost to the review zone's.
    const secrets = await pub.d.secrets();
    for (const name of [...Object.keys(archon), ...Object.keys(review)]) expect([name, Object.hasOwn(secrets, name)]).toEqual([name, true]);
    expect(Object.values(secrets)).toContain(archon.HAPI_JEV_OPENROUTER_API_KEY);
    // forge("pr") and forge("checks") each over a token of its own purpose: CodeRabbit's round gets both.
    const prForge = await pub.d.forge("pr");
    const checksForge = await pub.d.forge("checks");
    expect(prForge).not.toBe(checksForge);
    expect(await pub.d.forge("pr")).toBe(prForge);
    expect(await pub.d.token("push")).toBe("fake-push-token");
    expect(pub.minted).toEqual(["pr", "checks", "push"]);
    await checksForge.checkRuns("a".repeat(40));
    expect(pub.world.calls.at(-1)!.headers.authorization).toBe("Bearer fake-checks-token");
    // emit only hands the event on: no file is written.
    const event: StatusEvent = { at: NOW.toISOString(), repo: SANDBOX, workOrder: W1, phase: "worker" };
    await pub.d.emit(event);
    expect(pub.emitted).toEqual([event]);
    expect(existsSync(join(engineDir, "events.jsonl"))).toBe(false);
    // The classifier keys, read in-process from the archon zone, never into an environment.
    expect(await pub.d.decideKeys()).toEqual({ jev: archon.HAPI_JEV_OPENROUTER_API_KEY, anthropic: archon.ANTHROPIC_API_KEY });
    expect([process.env.HAPI_JEV_OPENROUTER_API_KEY, process.env.ANTHROPIC_API_KEY]).toEqual([undefined, undefined]);
    // decide is ask; subjects and stat run the engine's own git (diffSubjects's and diffStat's first commands).
    expect(pub.d.decide).toBe(ask);
    await expect(pub.d.subjects({ decision: "diff-screen", scratch: "/nonexistent/scratch.git", base: MERGE, head: "e".repeat(40), goal: "g", skip: [], maxChars: 100, secrets: {} })).rejects.toThrow(/diff --name-only/);
    await expect(pub.d.stat({ scratch: "/nonexistent/scratch.git", base: MERGE, head: "e".repeat(40) })).rejects.toThrow(/diff/);
    expect(f.calls.some((c) => c.cmd.includes("--name-only"))).toBe(true);
    expect(f.calls.some((c) => c.cmd.includes("--numstat"))).toBe(true);
  });
});
