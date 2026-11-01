/**
 * The run disk (src/run/disk.ts; design §3.1, H-217): the check a run disk must
 * pass against `runs.disk` (`diskProblem`, over a fake `FsProbe`), the real
 * probe on a temp dir, Docker's data root as `docker info` says it, and the
 * cleanup helper that empties a run's volume dirs as 1001:1001 (rootless Docker
 * maps uid 1001's files to a subuid hapi can't delete). No run disk is needed:
 * every dir here is a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// disk.ts first: a file whose first import is copyout.ts or spec.ts trips a load cycle that predates it
// (spec.ts -> src/audit/checks/tools.ts -> generated.ts -> runtime.ts, which reads spec.ts's APP_HOME as it loads).
import { CLEAN_SCRIPT, dataRootOf, diskProblem, dockerDataRoot, type FsFacts, type FsProbe, GIB, probeFs, removeVolumeDirs, volumeDir } from "../../src/run/disk";
import { bounded } from "../../src/run/copyout";
import { runLabels } from "../../src/run/spec";
import { caught, cleanup, tempDir } from "../secrets/helpers";
import { fakeRun, unbounded } from "./helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const N = `hapi-run-${ID}`;
const LIMITS = { gb: 20, enforcement: "hard" } as const;
const DIR = "/srv/disk";
const ROOT = "/root-of-docker";

/** A probe of three filesystems: /srv (dev 1), Docker's data root (dev 3), and the run disk as `disk` says (default: its own, dev 2). */
const probe = (disk: FsFacts | undefined): FsProbe => (path) => {
  if (path === "/srv") return { dev: 1, bytes: 500 * GIB, writable: true };
  if (path === ROOT) return { dev: 3, bytes: 500 * GIB, writable: true };
  return path === DIR ? disk : undefined;
};
const good = (over: Partial<FsFacts> = {}): FsFacts => ({ dev: 2, bytes: 19.5 * GIB, writable: true, ...over });

describe("diskProblem", () => {
  test("diskProblem refuses a run disk that isn't there (H-217)", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(undefined))).toBe("the run disk /srv/disk does not exist: set it up as docs/runbooks/runs.md#the-run-disk says (H-217)");
  });

  test("diskProblem refuses a directory that isn't its own filesystem", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good({ dev: 1 })))).toBe(
      "the run disk /srv/disk is not its own filesystem (it shares /srv's): mount the run disk there (docs/runbooks/runs.md#the-run-disk)",
    );
  });

  test("diskProblem refuses a run disk on Docker's data root's filesystem", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good({ dev: 3 })))).toBe(
      "the run disk /srv/disk is on the same filesystem as Docker's data root (/root-of-docker): a run that filled it would fill Docker's disk",
    );
  });

  test("diskProblem refuses a run disk this user can't write", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good({ writable: false })))).toBe(
      "the run disk /srv/disk is not writable by this user: chown it to hapi (docs/runbooks/runs.md#the-run-disk)",
    );
  });

  test("diskProblem refuses a run disk larger than runs.disk.gb", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good({ bytes: 21 * GIB })))).toBe(
      "the run disk /srv/disk is 21.0 GB, more than runs.disk.gb (20): it would let a run grow past its cap",
    );
  });

  test("diskProblem passes a writable filesystem of its own, apart from the data root, of at most runs.disk.gb", () => {
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good()))).toBeUndefined();
    expect(diskProblem(DIR, LIMITS, ROOT, probe(good({ bytes: 20 * GIB })))).toBeUndefined();
  });

  test("a data root this user can't see is a problem, never a pass", () => {
    expect(diskProblem(DIR, LIMITS, "/elsewhere", probe(good()))).toBe(
      "the run disk /srv/disk can't be checked against Docker's data root (/elsewhere), which this user can't see: run it as hapi",
    );
  });
});

test("with real fs: probeFs reports a temp dir's device, size and writability, and nothing for a missing path or a file", () => {
  const dir = tempDir("hapi-run-disk-");
  const fs = statfsSync(dir);
  expect(probeFs(dir)).toEqual({ dev: statSync(dir).dev, bytes: fs.blocks * fs.bsize, writable: true });
  expect(probeFs(join(dir, "missing"))).toBeUndefined();
  expect(probeFs(join(dir, "missing", "deeper"))).toBeUndefined();
  writeFileSync(join(dir, "file"), "x");
  expect(probeFs(join(dir, "file"))).toBeUndefined();
  expect(probeFs(join(dir, "file", "under"))).toBeUndefined();
});

test("Docker's data root is docker info's one absolute line; a failure or any other answer throws, naming the exit and what it said", async () => {
  expect(dataRootOf(0, "/home/hapi/.local/share/docker\n")).toBe("/home/hapi/.local/share/docker");
  expect(() => dataRootOf(1, "", "failed to connect to the docker API at unix:///x.sock\nmore")).toThrow("cannot read Docker's data root (docker info exited 1): failed to connect to the docker API at unix:///x.sock");
  expect(() => dataRootOf(0, "relative/root\n")).toThrow("cannot read Docker's data root (docker info exited 0): relative/root");
  expect(() => dataRootOf(0, "")).toThrow("cannot read Docker's data root (docker info exited 0): (no output)");
  expect(() => dataRootOf(0, "/a\n/b\n")).toThrow("cannot read Docker's data root (docker info exited 0): /a");
  const f = fakeRun();
  expect(await dockerDataRoot(f.deps)).toBe("/fake/docker-root");
  expect(f.calls.map((c) => c.cmd)).toEqual([["docker", "info", "--format", "{{.DockerRootDir}}"]]);
  const g = fakeRun({ failing: ["docker info"] });
  expect((await caught(dockerDataRoot(g.deps))).message).toBe("cannot read Docker's data root (docker info exited 1): boom");
});

test("volumeDir is the volume's name in the run disk, and refuses a path a bind can't hold", () => {
  expect(volumeDir("/var/lib/hapi/rundisk", `${N}-work`)).toBe(`/var/lib/hapi/rundisk/${N}-work`);
  expect(() => volumeDir("/srv/a:b", `${N}-work`)).toThrow(`cannot mount /srv/a:b/${N}-work into a run volume: its path holds ":" or ","`);
});

describe("the cleanup helper", () => {
  /** The run's two dirs on `f`'s run disk, each made, holding a file, only if asked. */
  function dirs(f: ReturnType<typeof fakeRun>, o: { work?: boolean; out?: boolean }) {
    const work = join(f.deps.diskDir, `${N}-work`);
    const out = join(f.deps.diskDir, `${N}-out`);
    for (const [dir, want] of [[work, o.work], [out, o.out]] as const) {
      if (!want) continue;
      mkdirSync(join(dir, "repo"), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "repo", "a.txt"), "the run's\n");
    }
    return { work, out };
  }
  const helperArgv = (mounts: string[]) =>
    bounded([
      "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      ...runLabels("hapi", ID), ...mounts, "--entrypoint", "sh", "hapi-factory/archon:0.12.1", "-c", CLEAN_SCRIPT,
    ]);

  test("the cleanup helper empties only the run's existing dirs as 1001:1001, then they are removed", async () => {
    const f = fakeRun();
    const both = dirs(f, { work: true, out: true });
    await removeVolumeDirs(f.deps, ID);
    expect(f.calls.map((c) => c.cmd)).toEqual([helperArgv(["-v", `${both.work}:/w`, "-v", `${both.out}:/o`])]);
    expect([existsSync(both.work), existsSync(both.out)]).toEqual([false, false]);

    const g = fakeRun();
    const one = dirs(g, { work: true });
    await removeVolumeDirs(g.deps, ID);
    expect(g.calls.map((c) => c.cmd)).toEqual([helperArgv(["-v", `${one.work}:/w`])]);
    expect(existsSync(one.work)).toBe(false);

    const h = fakeRun();
    await removeVolumeDirs(h.deps, ID);
    expect(h.calls).toEqual([]);

    const k = fakeRun({ failing: ["docker run --rm"] });
    const kept = dirs(k, { work: true, out: true });
    expect((await caught(removeVolumeDirs(k.deps, ID))).message).toBe(`emptying run ${ID}'s dirs on the run disk failed (helper exit 1)`);
    expect([existsSync(kept.work), existsSync(kept.out)]).toEqual([true, true]);
  });

  test("an empty dir is removed without the helper: one the chown never reached (a start that failed at `volume create`) is one the helper, as 1001, can't even chmod", async () => {
    // Work empty, out holding a file: the helper empties out alone, then both are gone.
    const f = fakeRun();
    const d = dirs(f, { out: true });
    mkdirSync(d.work, { mode: 0o700 });
    await removeVolumeDirs(f.deps, ID);
    expect(f.calls.map((c) => c.cmd)).toEqual([helperArgv(["-v", `${d.out}:/o`])]);
    expect([existsSync(d.work), existsSync(d.out)]).toEqual([false, false]);
    // Both empty: no helper at all, so one that would fail can't stop it.
    const g = fakeRun({ failing: ["docker run --rm"] });
    for (const v of ["work", "out"]) mkdirSync(join(g.deps.diskDir, `${N}-${v}`), { mode: 0o700 });
    await removeVolumeDirs(g.deps, ID);
    expect(g.calls).toEqual([]);
    expect(readdirSync(g.deps.diskDir)).toEqual([]);
  });

  test("a dir already gone when it is removed counts as removed: that is the goal, so another remover getting there first is no failure", async () => {
    const f = fakeRun();
    const d = dirs(f, { work: true });
    const run = f.deps.run;
    // The helper empties the dir, and another process (a reap's sweep, say) removes it before this one's rmdir.
    f.deps.run = async (cmd, o) => {
      const r = await run(cmd, o);
      if (unbounded(cmd).at(-1) === CLEAN_SCRIPT) rmSync(d.work, { recursive: true });
      return r;
    };
    await removeVolumeDirs(f.deps, ID);
    expect(existsSync(d.work)).toBe(false);
  });

  test("a helper that never returns is stopped at the host's bound, and the dirs are kept", async () => {
    const f = fakeRun({ hangs: (c) => c.at(-1) === CLEAN_SCRIPT });
    const d = dirs(f, { work: true });
    expect((await caught(removeVolumeDirs(f.deps, ID))).message).toBe(`emptying run ${ID}'s dirs on the run disk timed out after 150 s (helper exit 137)`);
    expect(unbounded(f.calls[0]!.cmd).at(-1)).toBe(CLEAN_SCRIPT);
    expect(existsSync(d.work)).toBe(true);
  });

  test("a symlink or a file where a run's dir belongs is refused, never followed or bound", async () => {
    const f = fakeRun();
    const target = tempDir("hapi-run-disk-target-");
    writeFileSync(join(target, "keep.txt"), "not the run's\n");
    symlinkSync(target, join(f.deps.diskDir, `${N}-work`));
    expect((await caught(removeVolumeDirs(f.deps, ID))).message).toBe(
      `${join(f.deps.diskDir, `${N}-work`)} on the run disk is not a directory (a symlink or a file): hapi makes each run's dirs itself, so remove it by hand (docs/runbooks/runs.md#the-run-disk)`,
    );
    expect(f.calls).toEqual([]);
    expect(existsSync(join(target, "keep.txt"))).toBe(true);
  });
});
