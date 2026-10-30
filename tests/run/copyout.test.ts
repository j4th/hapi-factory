/**
 * Copy-out (src/run/copyout.ts; design §6a item 11, spike 07 finding 14): a
 * run's outputs leave its volume one known name at a time, through a fresh
 * helper container with no network and the volume read-only, each capped, and
 * land 0600 in the hapi-owned record dir. The helper's two scripts also run
 * for real here, on a temp dir standing in for /out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COPY_SCRIPT, copyOut, HELPER_HOST_TIMEOUT_S, HELPER_KILL_AFTER_S, HELPER_TIMEOUT_S, LIST_SCRIPT, OUTPUT_FILES } from "../../src/run/copyout";
import { PROJECT_LABEL, RUN_LABEL } from "../../src/stack/up";
import { cleanup, tempDir } from "../secrets/helpers";
import { type FakeFile, type FakeOptions, fakeRun, file } from "./helpers";

afterEach(cleanup);

const ID = "ab12cd34ef56";
const VOL = `hapi-run-${ID}-out`;
const LIMITS = { bundle: 256, transcript: 64, decisions: 16, result: 4 };
const TIMED_OUT = `timed out (after ${HELPER_TIMEOUT_S} s in the helper, or ${HELPER_HOST_TIMEOUT_S} s in all)`;

/** A world with one output volume holding `files`, and a fresh destination dir. */
function withVolume(files: Record<string, FakeFile>, o: FakeOptions = {}) {
  const f = fakeRun(o);
  f.world.volumes.set(VOL, { labels: { [RUN_LABEL]: ID, [PROJECT_LABEL]: "hapi" }, owner: "1001:1001", files: new Map(Object.entries(files)) });
  const dest = join(f.tmp, "record", "out");
  return { f, dest };
}

const MB = 1024 * 1024;

describe("copyOut", () => {
  test("OUTPUT_FILES are the four names a run may leave, each with its limit", () => {
    expect(OUTPUT_FILES).toEqual(["result.json", "transcript.jsonl", "decisions.jsonl", "run.bundle"]);
  });

  test("copy-out refuses symlinks and oversize files (Review Focus 5), and a non-regular file (FIFO) is refused", async () => {
    const { f, dest } = withVolume({
      "result.json": { kind: "symlink" },
      "decisions.jsonl": { kind: "fifo" },
      "transcript.jsonl": file(new Uint8Array(1 * MB + 1)),
      "run.bundle": { kind: "dir" },
    });
    const r = await copyOut(VOL, dest, { ...LIMITS, transcript: 1 }, f.deps);
    expect(r.copied).toEqual([]);
    expect(r.problems).toEqual([
      "result.json in the run's output volume is not a regular file (a symlink, a FIFO or a directory): not copied",
      "transcript.jsonl is over its 1 MB limit (runs.output_limits_mb.transcript, policy/runs.yaml): not copied",
      "decisions.jsonl in the run's output volume is not a regular file (a symlink, a FIFO or a directory): not copied",
      "run.bundle in the run's output volume is not a regular file (a symlink, a FIFO or a directory): not copied",
    ]);
    // Nothing refused is left behind, not even an empty file.
    expect(readdirSync(dest)).toEqual([]);
    // The helper read at most cap + 1 bytes: enough to see oversize, no more.
    const read = f.calls.find((c) => c.bytes && c.cmd.at(-2) === "transcript.jsonl")!;
    expect(read.cmd.at(-1)).toBe(String(1 * MB + 1));
  });

  test("a file at exactly its limit is copied", async () => {
    const { f, dest } = withVolume({ "result.json": file(new Uint8Array(1 * MB).fill(0x7b)) });
    const r = await copyOut(VOL, dest, { ...LIMITS, result: 1 }, f.deps);
    expect([r.copied, r.problems]).toEqual([["result.json"], []]);
  });

  test("only OUTPUT_FILES are copied; any other name is reported, not copied", async () => {
    const { f, dest } = withVolume({
      "result.json": file("{}"),
      "debug.txt": file("x"),
      ".hidden": file("x"),
      "evil\u001b[2J\nname": file("x"),
    });
    const r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r.copied).toEqual(["result.json"]);
    expect(r.problems).toEqual(["the run's output volume holds 3 names that are not run outputs (debug.txt, .hidden and 1 not shown): not copied"]);
    expect(readdirSync(dest)).toEqual(["result.json"]);
    // Only the listed output names were read.
    expect(f.calls.filter((c) => c.bytes).map((c) => c.cmd.at(-2))).toEqual(["result.json"]);
  });

  test("a missing output is no problem: a bash-only run writes no decisions, an unchanged one no bundle", async () => {
    const { f, dest } = withVolume({ "result.json": file("{}"), "transcript.jsonl": file("{}\n") });
    const r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect([r.copied, r.problems]).toEqual([["result.json", "transcript.jsonl"], []]);
  });

  test("run.bundle round-trips byte for byte: a non-UTF-8 file is copied through runBytes, never decoded", async () => {
    const bytes = new Uint8Array(4096).map((_, i) => (i * 37 + 0x80) & 0xff);
    bytes.set([0xff, 0xfe, 0xc3, 0x28, 0x00], 0);
    const { f, dest } = withVolume({ "run.bundle": file(bytes) });
    const r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r.copied).toEqual(["run.bundle"]);
    expect(new Uint8Array(readFileSync(join(dest, "run.bundle")))).toEqual(bytes);
    // The file itself went through the byte runner; the text runner only listed names.
    const reads = f.calls.filter((c) => c.cmd.includes(COPY_SCRIPT));
    expect(reads.map((c) => c.bytes)).toEqual([true]);
  });

  test("files land 0600 under <record>/out/, and the dir is 0700", async () => {
    const { f, dest } = withVolume({ "result.json": file("{}"), "transcript.jsonl": file("{}\n") });
    // A umask that would leave a plain write group- and world-readable.
    const old = process.umask(0);
    try {
      await copyOut(VOL, dest, LIMITS, f.deps);
    } finally {
      process.umask(old);
    }
    expect(statSync(dest).mode & 0o777).toBe(0o700);
    for (const n of readdirSync(dest)) expect([n, statSync(join(dest, n)).mode & 0o777]).toEqual([n, 0o600]);
  });

  test("a failed or timed-out read leaves no file, even over an earlier copy, and names the exit code", async () => {
    const { f, dest } = withVolume({ "result.json": file("{}") });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "result.json"), "stale");
    const runBytes = f.deps.runBytes;
    f.deps.runBytes = async () => ({ code: 124, stdout: new Uint8Array([1, 2]), stderr: "" });
    let r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r.problems).toEqual([`copying result.json out ${TIMED_OUT}: not copied`]);
    expect(existsSync(join(dest, "result.json"))).toBe(false);
    f.deps.runBytes = async () => ({ code: 125, stdout: new Uint8Array(), stderr: "daemon says no" });
    r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r.problems).toEqual(["copying result.json out failed (helper exit 125): not copied"]);
    f.deps.runBytes = runBytes;
  });

  test("a listing that fails is a problem, and nothing is read", async () => {
    const { f, dest } = withVolume({ "result.json": file("{}") });
    const run = f.deps.run;
    f.deps.run = async (cmd, o) => (cmd.includes(LIST_SCRIPT) ? { code: 125, stdout: "", stderr: "daemon says no" } : run(cmd, o));
    const r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r.copied).toEqual([]);
    expect(r.problems).toEqual(["listing the run's output volume failed (helper exit 125): nothing was copied"]);
    expect(f.calls.some((c) => c.bytes)).toBe(false);
  });

  test("a volume that isn't there is a problem, and no helper mounts it: Docker would make an unlabelled one that nothing removes", async () => {
    const { f, dest } = withVolume({});
    f.world.volumes.delete(VOL);
    const r = await copyOut(VOL, dest, LIMITS, f.deps);
    expect(r).toEqual({ copied: [], problems: [`cannot find the run's output volume ${VOL} (docker volume inspect exited 1): nothing was copied`] });
    expect(f.calls.map((c) => c.cmd)).toEqual([["docker", "volume", "inspect", "--format", "{{.Name}}", VOL]]);
  });

  test("the helper runs --network none --read-only --user 1001:1001 -v <vol>:/out:ro with entrypoint sh, image the archon image", async () => {
    const { f, dest } = withVolume({ "result.json": file("{}") });
    await copyOut(VOL, dest, LIMITS, f.deps);
    expect(f.calls[0]!.cmd).toEqual(["docker", "volume", "inspect", "--format", "{{.Name}}", VOL]);
    const helpers = f.calls.filter((c) => c.cmd.includes("--entrypoint"));
    expect(helpers).toHaveLength(2);
    for (const { cmd } of helpers) {
      const script = cmd.includes(LIST_SCRIPT) ? LIST_SCRIPT : COPY_SCRIPT;
      expect(cmd.slice(0, cmd.indexOf("-c") + 2)).toEqual([
        // The host's bound on the whole helper: TERM, which the docker CLI passes on, then KILL.
        "timeout", "-k", String(HELPER_KILL_AFTER_S), String(HELPER_HOST_TIMEOUT_S),
        "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "1001:1001", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--label", RUN_LABEL, "--label", `${PROJECT_LABEL}=hapi`, "-v", `${VOL}:/out:ro`, "--entrypoint", "sh", "hapi-factory/archon:0.12.1", "-c", script,
      ]);
    }
    // The listing and every read are bounded in time inside the helper too, below the host's bound.
    expect(LIST_SCRIPT).toStartWith(`exec timeout ${HELPER_TIMEOUT_S} sh -c '`);
    expect(COPY_SCRIPT).toContain(`timeout ${HELPER_TIMEOUT_S} head -c "$2" "$f"`);
    expect(HELPER_HOST_TIMEOUT_S).toBeGreaterThan(HELPER_TIMEOUT_S);
  });

  test("a helper that never returns, as on a hung daemon, fails its step at the host's bound instead of hanging", async () => {
    const files = { "result.json": file("{}"), "transcript.jsonl": file("{}\n") };
    const list = withVolume(files, { hangs: (c) => c.includes(LIST_SCRIPT) });
    expect(await copyOut(VOL, list.dest, LIMITS, list.f.deps)).toEqual({ copied: [], problems: [`listing the run's output volume ${TIMED_OUT}: nothing was copied`] });
    const read = withVolume(files, { hangs: (c) => c.includes(COPY_SCRIPT) && c.at(-2) === "result.json" });
    expect(await copyOut(VOL, read.dest, LIMITS, read.f.deps)).toEqual({ copied: ["transcript.jsonl"], problems: [`copying result.json out ${TIMED_OUT}: not copied`] });
    expect(readdirSync(read.dest)).toEqual(["transcript.jsonl"]);
  });
});

describe("the helper's scripts, run for real on a stand-in /out", () => {
  const at = (dir: string, script: string) => script.replaceAll("/out/", `${dir}/`);
  const sh = (dir: string, script: string, ...args: string[]) => Bun.spawnSync(["sh", "-c", at(dir, script), "hapi-copyout", ...args], { stdout: "pipe", stderr: "pipe" });

  function outDir() {
    const dir = tempDir("hapi-run-out-");
    writeFileSync(join(dir, "result.json"), "0123456789");
    writeFileSync(join(dir, ".hidden"), "x");
    symlinkSync("/etc/passwd", join(dir, "transcript.jsonl"));
    mkdirSync(join(dir, "run.bundle"));
    expect(Bun.spawnSync(["mkfifo", join(dir, "decisions.jsonl")]).exitCode).toBe(0);
    return dir;
  }

  test("the list script prints every name, dot names too, NUL-separated", () => {
    const dir = outDir();
    const r = sh(dir, LIST_SCRIPT);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().split("\0").slice(0, -1).sort()).toEqual([".hidden", "decisions.jsonl", "result.json", "run.bundle", "transcript.jsonl"]);
  });

  test("the copy script reads at most the bytes asked of a regular file, refuses a symlink, a FIFO and a directory with 3, and says 4 for a missing name", () => {
    const dir = outDir();
    const read = sh(dir, COPY_SCRIPT, "result.json", "4");
    expect([read.exitCode, read.stdout.toString()]).toEqual([0, "0123"]);
    // [ -f ] alone would follow the symlink and read /etc/passwd; the FIFO would block a bare head.
    for (const name of ["transcript.jsonl", "decisions.jsonl", "run.bundle"]) expect([name, sh(dir, COPY_SCRIPT, name, "100").exitCode]).toEqual([name, 3]);
    expect(sh(dir, COPY_SCRIPT, "missing.json", "100").exitCode).toBe(4);
  });
});
