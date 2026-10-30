/**
 * stack/archon/run.sh, the fixed prelude a run container executes as `sh /opt/hapi/run.sh <workflow> <sha>
 * <work-order-id> <traceparent>` (design §3.1, §6a; spike 07). Read as text for what must and must not be in
 * it, then run for real on a temp tree with a stand-in `bun` for the Archon CLI: the paths are rewritten into
 * the temp dir, everything else (git, the sparse strip, the trap, the post-run steps) is the script's own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../stack/helpers";
import { cleanup, tempDir } from "../secrets/helpers";

afterEach(cleanup);

const FILE = join(REPO, "stack", "archon", "run.sh");
const text = readFileSync(FILE, "utf8");
/** The script's lines that are code, not comments. */
const code = text.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
const HAVE_JQ = Bun.spawnSync(["jq", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

describe("the text of run.sh", () => {
  test("it passes sh -n", () => {
    const r = Bun.spawnSync(["sh", "-n", FILE], { stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stderr.toString()]).toEqual([0, ""]);
  });

  test("it starts with set -eu and makes Archon's workspace directories", () => {
    expect(code.slice(0, 2)).toEqual(["set -eu", "mkdir -p /.archon/workspaces /.archon/worktrees"]);
  });

  test("it clones sparse and strips .pi, .agents and .archon: the sparse patterns are exactly '/*' '!/.pi/' '!/.agents/' '!/.archon/'", () => {
    expect(text).toContain("git clone --no-checkout --no-hardlinks /src/repo.git /work/repo");
    expect(text).toContain("git -C /work/repo sparse-checkout set --no-cone '/*' '!/.pi/' '!/.agents/' '!/.archon/'");
    expect(text).toContain('git -C /work/repo checkout --detach "$2"');
    expect(text).toContain("git -C /work/repo remote remove origin");
    // The strip comes between the clone and the checkout, or the checkout would write them.
    const at = (s: string) => text.indexOf(s);
    expect([at("git clone"), at("sparse-checkout set"), at("checkout --detach"), at("remote remove origin")]).toEqual(
      [at("git clone"), at("sparse-checkout set"), at("checkout --detach"), at("remote remove origin")].sort((a, b) => a - b),
    );
  });

  test("`cd /work` never appears: Archon starts from /app with --cwd /work/repo, and nothing cds into the clone", () => {
    expect(text).not.toContain("cd /work");
    expect(code.filter((l) => /(^|[;&|(]\s*)cd\s/.test(l.trim()) || /^\s*cd\s/.test(l))).toEqual(["cd /app"]);
    expect(text).toContain("workflow run");
    expect(text).toContain('workflow run "$1" --cwd /work/repo --no-worktree --config /opt/hapi/run-config.yaml');
    expect(text).toContain("bun --no-env-file /app/packages/cli/src/cli.ts");
  });

  test("it passes both --input work_order_id= and --input traceparent=", () => {
    expect(text).toContain('--input work_order_id="$3"');
    expect(text).toContain('--input traceparent="$4"');
  });

  test("it traps TERM and INT and forwards TERM to the workflow's process", () => {
    expect(text).toContain(`trap 'kill -TERM "$pid" 2>/dev/null' TERM INT`);
  });

  test('the workflow\'s code is captured with wait "$pid" || rc=$?, never under set -e, and a trapped signal that ends wait early is waited out', () => {
    expect(text).toContain('rc=0; wait "$pid" || rc=$?');
    expect(text).toContain('while kill -0 "$pid" 2>/dev/null; do wait "$pid" || rc=$?; done');
    // No bare `wait` that set -e could abort on.
    for (const l of code) if (/\bwait\b/.test(l)) expect(l).toMatch(/\|\| rc=\$\?/);
  });

  test("after the workflow ends, set +e: no step-4 line can abort the script, and it ends with exit \"$rc\"", () => {
    const after = code.slice(code.indexOf("set +e") + 1);
    expect(code).toContain("set +e");
    expect(after.at(-1)).toBe('exit "$rc"');
    for (const l of after.slice(0, -1)) {
      expect([l, /\bexit\b/.test(l)]).toEqual([l, false]);
      expect([l, /\bset -[a-z]*e/.test(l)]).toEqual([l, false]);
    }
    // Each failure is noted on stderr.
    expect(after.filter((l) => l.includes(">&2")).length).toBeGreaterThanOrEqual(4);
  });

  test("after the workflow: the bundle, then the strip of .archon/.pi/.agents, then the read-back, then the validated transcript copy", () => {
    const at = (needle: string) => text.indexOf(needle);
    const order = [at("bundle create"), at("rm -rf /work/repo/.archon /work/repo/.pi /work/repo/.agents"), at("workflow runs --json"), at("workflow get"), at("cp \"$real\"")];
    expect(order.every((n) => n > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(text).toContain("realpath");
  });

  test("it writes result.json, the transcript from workflow get's transcript_path, and the bundle only if HEAD moved; and never the launcher's run.json", () => {
    expect(text).toContain("/out/result.json");
    expect(text).toContain("/out/transcript.jsonl");
    expect(text).toContain("transcript_path");
    expect(text).toContain("/out/run.bundle");
    expect(text).toContain('bundle create /out/run.bundle "$2..HEAD"');
    expect(text).toContain("workflow runs --json --cwd /work/repo");
    expect(text).toContain("workflow get");
    expect(text).toContain("--json --verbose --cwd /work/repo");
    expect(text).not.toContain("/run/hapi/run.json");
    expect(text).not.toMatch(/\/out\/run\.json/);
  });
});

/** A sandbox: the script with its absolute paths moved under `root`, a source repo, and a stand-in bun. */
function sandbox() {
  const root = tempDir("hapi-prelude-");
  const bin = join(root, "bin");
  for (const d of ["bin", "app", "out", "work", "state", "archon"]) mkdirSync(join(root, d), { recursive: true });
  // A source repo with one commit, bare, as /src/repo.git is.
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.toString().trim();
  };
  const seed = join(root, "seed");
  mkdirSync(join(seed, ".archon"), { recursive: true });
  git(seed, "init", "-q");
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, ".archon", "config.yaml"), "decoy: true\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "A");
  const sha = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", seed, join(root, "src.git"));
  const script = text
    .replaceAll("/.archon/workspaces", `${root}/archon/workspaces`)
    .replace("/.archon/worktrees", `${root}/archon/worktrees`)
    .replaceAll("/src/repo.git", `${root}/src.git`)
    .replaceAll("/work/repo", `${root}/work/repo`)
    .replaceAll("/out/", `${root}/out/`)
    .replaceAll("/opt/hapi/run-config.yaml", `${root}/run-config.yaml`)
    .replaceAll("/app", `${root}/app`);
  const file = join(root, "run.sh");
  writeFileSync(file, script);
  // The stand-in Archon CLI: records how it was started, and does what the test's env says.
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh
shift 2
case "$1 $2" in
"workflow run")
  pwd > "${root}/state/run.cwd"; echo "$@" > "${root}/state/run.args"
  echo started > "${root}/state/started"
  if [ -n "$FAKE_SLEEP" ]; then
    trap 'echo got-term > "${root}/state/term"; kill "$s" 2>/dev/null; exit 143' TERM
    sleep 30 & s=$!; wait "$s"
  fi
  if [ -n "$FAKE_PLANT" ]; then
    mkdir -p "${root}/work/repo/.archon" "${root}/work/repo/.pi" "${root}/work/repo/.agents"
    echo "planted: true" > "${root}/work/repo/.archon/config.yaml"
  fi
  if [ -n "$FAKE_COMMIT" ]; then
    (cd "${root}/work/repo" && echo more >> README.md && git -c user.name=t -c user.email=t@example.invalid commit -qam B)
  fi
  exit "\${FAKE_RC:-0}" ;;
"workflow runs")
  if [ -e "${root}/work/repo/.archon" ] || [ -e "${root}/work/repo/.pi" ] || [ -e "${root}/work/repo/.agents" ]; then echo present > "${root}/state/readback.saw-dirs"; fi
  echo '{"runs":[{"id":"5299f3cc-f79d-43a2-98a9-a14cca1818c6","status":"failed"}],"total":1}' ;;
"workflow get") [ -n "$FAKE_GET_FAILS" ] && exit 1; printf '{"status":"failed","transcript_path":"%s"}\n' "\${FAKE_TP:-${root}/archon/workspaces/_local/repo/logs/5299f3cc-f79d-43a2-98a9-a14cca1818c6.jsonl}" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(join(root, "state", "outside.jsonl"), "outside\n");
  const RUN_ID = "5299f3cc-f79d-43a2-98a9-a14cca1818c6";
  const logs = join(root, "archon", "workspaces", "_local", "repo", "logs");
  mkdirSync(logs, { recursive: true });
  const transcript = join(logs, `${RUN_ID}.jsonl`);
  writeFileSync(transcript, '{"type":"node_start"}\n');
  const start = (env: Record<string, string> = {}) =>
    Bun.spawn(["sh", file, "hapi-check-run", sha, "0001-wo", "00-aaaa-bbbb-01"], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
  return { root, sha, start, transcript, logs, RUN_ID };
}

describe.skipIf(!HAVE_JQ)("run.sh, run on a sandbox with a stand-in Archon CLI", () => {
  test("a clean run: stripped checkout, the CLI started from /app with the right arguments, outputs written, exit 0, no bundle", async () => {
    const s = sandbox();
    const p = s.start();
    expect(await p.exited).toBe(0);
    // Git's own progress lines are on stderr; the prelude notes only failures, with its "prelude:" prefix.
    expect(await new Response(p.stderr).text()).not.toContain("prelude:");
    const clone = join(s.root, "work", "repo");
    // The strip: no .archon in the working tree, yet the index still has it as skip-worktree (status is clean).
    expect(existsSync(join(clone, "README.md"))).toBe(true);
    expect(existsSync(join(clone, ".archon"))).toBe(false);
    expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: clone, stdout: "pipe" }).stdout.toString()).toBe("");
    expect(Bun.spawnSync(["git", "remote"], { cwd: clone, stdout: "pipe" }).stdout.toString()).toBe("");
    // The CLI ran from /app (here the sandbox's), not from the clone.
    expect(readFileSync(join(s.root, "state", "run.cwd"), "utf8").trim()).toBe(join(s.root, "app"));
    expect(readFileSync(join(s.root, "state", "run.args"), "utf8").trim()).toBe(
      `workflow run hapi-check-run --cwd ${clone} --no-worktree --config ${s.root}/run-config.yaml --input work_order_id=0001-wo --input traceparent=00-aaaa-bbbb-01`,
    );
    const result = JSON.parse(readFileSync(join(s.root, "out", "result.json"), "utf8"));
    expect(Object.keys(result)).toEqual(["runs", "run"]);
    expect(result.runs.runs[0].id).toBe(s.RUN_ID);
    expect(result.run.status).toBe("failed");
    expect(readFileSync(join(s.root, "out", "transcript.jsonl"), "utf8")).toBe('{"type":"node_start"}\n');
    expect(existsSync(join(s.root, "out", "run.bundle"))).toBe(false);
  });

  test("a failed run still leaves its outputs, and the script exits with the workflow's code", async () => {
    const s = sandbox();
    const p = s.start({ FAKE_RC: "42" });
    expect(await p.exited).toBe(42);
    expect(existsSync(join(s.root, "out", "result.json"))).toBe(true);
    expect(existsSync(join(s.root, "out", "transcript.jsonl"))).toBe(true);
  });

  test("when HEAD moved, the bundle holds <sha>..HEAD", async () => {
    const s = sandbox();
    const p = s.start({ FAKE_COMMIT: "1" });
    expect(await p.exited).toBe(0);
    const bundle = join(s.root, "out", "run.bundle");
    expect(existsSync(bundle)).toBe(true);
    const heads = Bun.spawnSync(["git", "bundle", "list-heads", bundle], { cwd: s.root, stdout: "pipe", stderr: "pipe" });
    expect(heads.stdout.toString()).toContain("HEAD");
  });

  test("a read-back that fails is noted on stderr and aborts nothing: result.json says null, the exit code is the workflow's", async () => {
    const s = sandbox();
    const p = s.start({ FAKE_GET_FAILS: "1", FAKE_RC: "3" });
    expect(await p.exited).toBe(3);
    expect(await new Response(p.stderr).text()).toContain("workflow get failed");
    const result = JSON.parse(readFileSync(join(s.root, "out", "result.json"), "utf8"));
    expect(result.run).toBeNull();
    expect(result.runs.total).toBe(1);
    expect(existsSync(join(s.root, "out", "transcript.jsonl"))).toBe(false);
  });

  test("before any Archon read-back, the repo's .archon, .pi and .agents are gone (a worker-planted config is never loaded), and the bundle was made first", async () => {
    const s = sandbox();
    const p = s.start({ FAKE_PLANT: "1", FAKE_COMMIT: "1" });
    expect(await p.exited).toBe(0);
    const clone = join(s.root, "work", "repo");
    for (const d of [".archon", ".pi", ".agents"]) expect([d, existsSync(join(clone, d))]).toEqual([d, false]);
    expect(existsSync(join(s.root, "state", "readback.saw-dirs"))).toBe(false);
    expect(existsSync(join(s.root, "out", "run.bundle"))).toBe(true);
  });

  describe("the transcript path comes from state the worker can write, so only this run's own log is copied", () => {
    const copied = (s: ReturnType<typeof sandbox>) => existsSync(join(s.root, "out", "transcript.jsonl"));

    test("a plain file at .../logs/<run id>.jsonl is copied", async () => {
      const s = sandbox();
      const p = s.start();
      expect(await p.exited).toBe(0);
      expect(copied(s)).toBe(true);
      expect(await new Response(p.stderr).text()).not.toContain("transcript path");
    });

    test("a symlink at the right name is not copied, nor is a file reached through a linked directory", async () => {
      const s = sandbox();
      rmSync(s.transcript);
      symlinkSync(join(s.root, "state", "outside.jsonl"), s.transcript);
      const p = s.start();
      expect(await p.exited).toBe(0);
      expect(copied(s)).toBe(false);
      expect(await new Response(p.stderr).text()).toContain("transcript path");
      const t = sandbox();
      const other = join(t.root, "elsewhere");
      mkdirSync(other);
      writeFileSync(join(other, `${t.RUN_ID}.jsonl`), "x\n");
      const via = join(t.root, "archon", "workspaces", "_local", "link-logs");
      symlinkSync(other, via);
      const q = t.start({ FAKE_TP: join(via, `${t.RUN_ID}.jsonl`) });
      expect(await q.exited).toBe(0);
      expect(copied(t)).toBe(false);
    });

    test("/proc/self/environ and a file outside /.archon/workspaces are not copied", async () => {
      for (const tp of ["/proc/self/environ", "/etc/passwd"]) {
        const s = sandbox();
        const p = s.start({ FAKE_TP: tp });
        expect(await p.exited).toBe(0);
        expect([tp, copied(s)]).toEqual([tp, false]);
        expect(await new Response(p.stderr).text()).toContain("outside this run's logs");
      }
      const s = sandbox();
      const p = s.start({ FAKE_TP: join(s.root, "state", "outside.jsonl") });
      expect(await p.exited).toBe(0);
      expect(copied(s)).toBe(false);
    });

    test("a log of another run, or outside a logs/ directory, is not copied", async () => {
      for (const where of ["other-run", "not-logs"]) {
        const s = sandbox();
        const state = join(s.root, "archon", "workspaces", "_local", "repo", "state");
        mkdirSync(state, { recursive: true });
        const tp = where === "other-run" ? join(s.logs, "00000000-0000-0000-0000-000000000000.jsonl") : join(state, `${s.RUN_ID}.jsonl`);
        writeFileSync(tp, "x\n");
        const p = s.start({ FAKE_TP: tp });
        expect(await p.exited).toBe(0);
        expect([where, copied(s)]).toEqual([where, false]);
      }
    });
  });

  test("TERM reaches the workflow's process, and the outputs are still written", async () => {
    const s = sandbox();
    const p = s.start({ FAKE_SLEEP: "1" });
    for (let i = 0; i < 200 && !existsSync(join(s.root, "state", "started")); i++) await Bun.sleep(25);
    expect(existsSync(join(s.root, "state", "started"))).toBe(true);
    p.kill("SIGTERM");
    expect(await p.exited).toBe(143);
    expect(existsSync(join(s.root, "state", "term"))).toBe(true);
    expect(existsSync(join(s.root, "out", "result.json"))).toBe(true);
  });
});
