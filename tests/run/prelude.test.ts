/**
 * stack/archon/run.sh, verify.sh and review.sh, the fixed preludes a run container executes as `sh /opt/hapi/<prelude>
 * <workflow> <sha> <work-order-id> <traceparent>` (design §3.1, §3.5, §6a; spike 07; spike 09, T17 and T19). Read as
 * text for what must and must not be in them, then run for real on a temp tree with a stand-in `bun` for the Archon
 * CLI: the paths are rewritten into the temp dir, everything else (git, the sparse strip, the trap, the post-run
 * steps) is the script's own. verify.sh and review.sh are run.sh with their own edits, and the three share their
 * regions byte for byte (ruling m46).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../stack/helpers";
import { cleanup, tempDir } from "../secrets/helpers";

afterEach(cleanup);

const read = (name: string) => readFileSync(join(REPO, "stack", "archon", name), "utf8");
const FILE = join(REPO, "stack", "archon", "run.sh");
const text = read("run.sh");
const VERIFY = read("verify.sh");
const REVIEW = read("review.sh");
/** A script's lines that are code, not comments. */
const codeOf = (t: string) => t.split("\n").filter((l) => l.trim() !== "" && !/^\s*#/.test(l));
const code = codeOf(text);
const HAVE_JQ = Bun.spawnSync(["jq", "--version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

/** verify.sh's and review.sh's sparse patterns: run.sh's three, plus Claude Code's files (spike 09, T19: .claude/ and CLAUDE.md at any depth). */
const SPARSE = "git -C /work/repo sparse-checkout set --no-cone '/*' '!/.pi/' '!/.agents/' '!/.archon/' '!.claude/' '!CLAUDE.md' '!/.mcp.json'";
/** Their strip after the workflow, of the same six. */
const STRIP = 'rm -rf /work/repo/.archon /work/repo/.pi /work/repo/.agents /work/repo/.claude /work/repo/CLAUDE.md /work/repo/.mcp.json || echo "prelude: strip failed" >&2';
/** review.sh's read-only checkout, .git aside, never following a symlink out of it. */
const CHMOD = "find /work/repo -path /work/repo/.git -prune -o ! -type l -exec chmod a-w {} +";
/** review.sh's symlinks, each checked out again as a plain file holding its target's text, before the chmod; a status that isn't clean then ends it. */
const PLAIN_LINKS = [
  "git -C /work/repo config core.symlinks false",
  "find /work/repo -path /work/repo/.git -prune -o -type l -exec rm -f {} +",
  "git -C /work/repo checkout -- .",
  "st=$(git -C /work/repo status --porcelain)",
  'if [ -n "$st" ]; then echo "prelude: the checkout is not clean once its symlinks are plain files" >&2; exit 1; fi',
];
/** verify.sh's and review.sh's kill of what the workflow left running, right after `set +e`: only as PID 1, the container's init. */
const KILL = 'if [ "$$" = 1 ]; then kill -s KILL -1 2>/dev/null; fi';
/**
 * The regions every prelude holds as run.sh does, byte for byte, comments and all, each from its first text to its
 * last: the start, the clone, the checkout and the remote's removal, the CLI's run with its trap and wait up to
 * `set +e`, and the read-back to the end.
 */
const SHARED: [from: string, to: string][] = [
  ["set -eu\n", "/.archon/worktrees\n"],
  ["git clone --no-checkout", "\n"],
  ['git -C /work/repo checkout --detach "$2"\n', "git -C /work/repo remote remove origin\n"],
  ["# Archon starts from /app", "set +e\n"],
  ['CLI="bun --no-env-file', 'exit "$rc"\n'],
];
/** The text of region `r` in `t`, which must hold its start exactly once. */
const region = (t: string, [from, to]: [string, string]) => {
  const at = t.indexOf(from);
  if (at === -1 || t.indexOf(from, at + 1) !== -1) throw new Error(`the region ${JSON.stringify(from)} is not in the script exactly once`);
  const end = t.indexOf(to, at + from.length);
  return t.slice(at, end + to.length);
};

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

  test("it traps TERM and INT and forwards TERM to the workflow's process, set before bun starts, with a body that can't fail under set -e", () => {
    const trap = `trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT`;
    expect(text).toContain(trap);
    // pid is set (empty) first, for set -u; the trap is in place before the `&`; pid=$! comes right after it.
    const bun = code.findIndex((l) => l.startsWith("bun ") && l.endsWith(" &"));
    expect(code.slice(bun - 2, bun + 2)).toEqual(["pid=", trap, code[bun]!, "pid=$!"]);
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

/** The six paths a repo could steer Archon, Pi or Claude Code with, at the clone's root. */
const STEERING = [".archon", ".pi", ".agents", ".claude", "CLAUDE.md", ".mcp.json"];

/** A sandbox: the script `script` with its absolute paths moved under `root`, a source repo, and a stand-in bun. */
function sandbox(script0: string = text) {
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
  for (const d of [".archon", ".claude", "sub"]) mkdirSync(join(seed, d), { recursive: true });
  git(seed, "init", "-q");
  writeFileSync(join(seed, "README.md"), "hello\n");
  writeFileSync(join(seed, ".archon", "config.yaml"), "decoy: true\n");
  // What Claude Code would load from a checkout (spike 09, T19): its settings' hooks, CLAUDE.md, and an MCP server.
  writeFileSync(join(seed, ".claude", "settings.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch /tmp/hook"}]}]}}\n');
  writeFileSync(join(seed, "CLAUDE.md"), "decoy: ask before every edit\n");
  writeFileSync(join(seed, ".mcp.json"), '{"mcpServers":{"x":{"command":"sh"}}}\n');
  writeFileSync(join(seed, "sub", "CLAUDE.md"), "decoy: nested\n");
  writeFileSync(join(seed, "sub", "keep.txt"), "kept\n");
  // Links out of the checkout: to a file of the run's own user (as `x -> /out` would be), to a dir, and to nothing.
  symlinkSync(join(root, "state", "outside.jsonl"), join(seed, "link"));
  symlinkSync(join(root, "state"), join(seed, "d"));
  symlinkSync(join(root, "nowhere"), join(seed, "dangling"));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "A");
  const sha = git(seed, "rev-parse", "HEAD");
  git(root, "clone", "-q", "--bare", seed, join(root, "src.git"));
  const script = script0
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
    mkdir -p "${root}/work/repo/.archon" "${root}/work/repo/.pi" "${root}/work/repo/.agents" "${root}/work/repo/.claude"
    echo "planted: true" > "${root}/work/repo/.archon/config.yaml"
    echo planted > "${root}/work/repo/CLAUDE.md"; echo '{}' > "${root}/work/repo/.mcp.json"
  fi
  if [ -n "$FAKE_COMMIT" ]; then
    (cd "${root}/work/repo" && echo more >> README.md && git -c user.name=t -c user.email=t@example.invalid commit -qam B)
  fi
  exit "\${FAKE_RC:-0}" ;;
"workflow runs")
  : > "${root}/state/readback.saw"
  for d in ${STEERING.join(" ")}; do if [ -e "${root}/work/repo/$d" ]; then echo "$d" >> "${root}/state/readback.saw"; fi; done
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

/** Which of the six steering paths the stand-in CLI's read-back found in the clone. */
const saw = (s: ReturnType<typeof sandbox>) => readFileSync(join(s.root, "state", "readback.saw"), "utf8").split("\n").filter((l) => l !== "");

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
    // The read-back saw none of the three; Claude Code's files are verify's and review's to strip, not the worker's.
    expect(saw(s).filter((d) => [".archon", ".pi", ".agents"].includes(d))).toEqual([]);
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

describe("the text of verify.sh and review.sh", () => {
  for (const [name, t] of [["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) {
    test(`${name} passes sh -n, clones with exactly '/*' '!/.pi/' '!/.agents/' '!/.archon/' '!.claude/' '!CLAUDE.md' '!/.mcp.json', makes no bundle, and keeps run.sh's trap, wait and set +e shape`, () => {
      const r = Bun.spawnSync(["sh", "-n", join(REPO, "stack", "archon", name)], { stdout: "pipe", stderr: "pipe" });
      expect([name, r.exitCode, r.stderr.toString()]).toEqual([name, 0, ""]);
      const c = codeOf(t);
      expect(c.filter((l) => l.includes("sparse-checkout"))).toEqual([SPARSE]);
      // No bundle: a verify or review run commits nothing that leaves it.
      for (const no of ["bundle create", "head=$(", "/out/run.bundle"]) expect([name, no, t.includes(no)]).toEqual([name, no, false]);
      // run.sh's shape: pid set empty, the trap, bun in the background, pid=$!, every wait guarded, then set +e to the end.
      const trap = `trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT`;
      const bun = c.findIndex((l) => l.startsWith("bun ") && l.endsWith(" &"));
      expect(c.slice(bun - 2, bun + 2)).toEqual(["pid=", trap, c[bun]!, "pid=$!"]);
      for (const l of c) if (/\bwait\b/.test(l)) expect(l).toMatch(/\|\| rc=\$\?/);
      const after = c.slice(c.indexOf("set +e") + 1);
      expect(after.at(-1)).toBe('exit "$rc"');
      for (const l of after.slice(0, -1)) expect([l, /\bexit\b/.test(l) || /\bset -[a-z]*e/.test(l)]).toEqual([l, false]);
      // The six steering paths go after the workflow and before any read-back.
      expect(c.filter((l) => l.startsWith("rm -rf "))).toEqual([STRIP]);
      expect(t.indexOf(STRIP)).toBeGreaterThan(t.indexOf("set +e"));
      expect(t.indexOf(STRIP)).toBeLessThan(t.indexOf("workflow runs --json"));
    });
  }

  test("verify.sh is run.sh with the seven sparse patterns, no bundle, the guarded kill after set +e and the six-path strip; review.sh is verify.sh with its symlinks made plain files and the checkout made read-only right after the remote goes", () => {
    const want = code
      .map((l) => (l.startsWith("git -C /work/repo sparse-checkout set") ? SPARSE : l.startsWith("rm -rf /work/repo/.archon") ? STRIP : l))
      .filter((l) => !l.startsWith("head=") && !l.includes("bundle create"))
      .flatMap((l) => (l === "set +e" ? [l, KILL] : [l]));
    expect(want).toHaveLength(code.length - 1);
    expect(codeOf(VERIFY)).toEqual(want);
    const at = want.indexOf("git -C /work/repo remote remove origin");
    expect(codeOf(REVIEW)).toEqual([...want.slice(0, at + 1), ...PLAIN_LINKS, CHMOD, ...want.slice(at + 1)]);
  });

  test("the kill of what the workflow left runs only as PID 1, never in run.sh, and is the preludes' one kill of every process", () => {
    for (const [name, t] of [["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) {
      const c = codeOf(t);
      expect([name, c.filter((l) => /\bkill\b/.test(l) && !l.includes('"$pid"'))]).toEqual([name, [KILL]]);
      // Right after set +e: the strip and the read-back come after it.
      expect([name, c[c.indexOf("set +e") + 1]]).toEqual([name, KILL]);
    }
    expect(codeOf(text).some((l) => l.includes("kill -s KILL -1"))).toBe(false);
    // The guard holds in a sandbox: the shell isn't PID 1, so the line does nothing (the session it runs in lives on).
    const r = Bun.spawnSync(["sh", "-c", `${KILL}; echo alive`], { stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stdout.toString()]).toEqual([0, "alive\n"]);
  });

  test("the three preludes' shared regions are byte-equal, comments too (ruling m46): a change to one is a change to all three", () => {
    for (const r of SHARED) {
      const want = region(text, r);
      expect(want.length).toBeGreaterThan(r[0].length);
      for (const [name, t] of [["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) expect([name, r[0], region(t, r)]).toEqual([name, r[0], want]);
    }
    // Together the regions are all of run.sh's code but its sparse patterns and its bundle-and-strip lines.
    const shared = codeOf(SHARED.map((r) => region(text, r)).join("\n"));
    expect(code.filter((l) => !shared.includes(l))).toEqual([code.find((l) => l.includes("sparse-checkout"))!, ...code.filter((l) => l.startsWith("head=") || l.includes("bundle create") || l.startsWith("rm -rf "))]);
  });

  test("neither runs the repo's code itself: no install, no mise, no repo script; their only bun is Archon's CLI, started from /app, and nothing cds into the clone", () => {
    for (const [name, t] of [["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) {
      const c = codeOf(t);
      expect([name, c.filter((l) => /\bbun\b/.test(l) && !l.includes("bun --no-env-file /app/packages/cli/src/cli.ts"))]).toEqual([name, []]);
      expect([name, c.filter((l) => /\b(mise|npm|npx|bunx|pnpm|yarn|make)\b|bun (install|ci|run|x)\b/.test(l))]).toEqual([name, []]);
      expect([name, c.filter((l) => /(^|[;&|(]\s*)cd\s/.test(l.trim()))]).toEqual([name, ["cd /app"]]);
    }
  });

  test("every prelude keeps /work holding only repo/ (spike 09, T17: Pi loads /work/AGENTS.md)", () => {
    for (const [name, t] of [["run.sh", text], ["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) {
      const paths = [...codeOf(t).join("\n").matchAll(/\/work(?![A-Za-z0-9_])(?:\/[A-Za-z0-9._/-]*)?/g)].map((m) => m[0]);
      expect([name, paths.length > 0, paths.filter((p) => p !== "/work/repo" && !p.startsWith("/work/repo/"))]).toEqual([name, true, []]);
    }
  });

  test("their headers say what each container holds: verify no key and only egress-archon; review the review zone's keys and no repo code", () => {
    const header = (t: string) => t.slice(0, t.indexOf("set -eu"));
    expect(header(VERIFY)).toContain("/opt/hapi/verify.sh");
    expect(header(VERIFY)).toMatch(/holds no key/);
    expect(header(VERIFY)).toContain("egress-archon");
    expect(header(REVIEW)).toContain("/opt/hapi/review.sh");
    expect(header(REVIEW)).toContain("egress-review");
    expect(header(REVIEW)).toMatch(/runs none of the repo's code/);
    for (const t of [VERIFY, REVIEW]) expect(header(t)).toContain("tests/run/prelude.test.ts");
  });
});

describe.skipIf(!HAVE_JQ)("verify.sh and review.sh, run on a sandbox with a stand-in Archon CLI", () => {
  /** The clone's paths, relative to it, .git's aside. */
  const tree = (dir: string, at = ""): string[] =>
    readdirSync(join(dir, at)).filter((n) => !(at === "" && n === ".git")).flatMap((n) => {
      const rel = at === "" ? n : `${at}/${n}`;
      return lstatSync(join(dir, rel)).isDirectory() ? [rel, ...tree(dir, rel)] : [rel];
    });

  for (const [name, script] of [["verify.sh", VERIFY], ["review.sh", REVIEW]] as const) {
    test(`a real ${name} run checks out <sha> without .claude/, CLAUDE.md or .mcp.json, writes result.json, and leaves no run.bundle`, async () => {
      const s = sandbox(script);
      const clone = join(s.root, "work", "repo");
      try {
        const p = s.start();
        expect(await p.exited).toBe(0);
        expect(await new Response(p.stderr).text()).not.toContain("prelude:");
        expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: clone, stdout: "pipe" }).stdout.toString().trim()).toBe(s.sha);
        expect(tree(clone).sort()).toEqual(["README.md", "d", "dangling", "link", "sub", "sub/keep.txt"]);
        // The stripped paths stay in the index as skip-worktree entries: nothing reads as deleted.
        expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: clone, stdout: "pipe" }).stdout.toString()).toBe("");
        expect(readdirSync(join(s.root, "work"))).toEqual(["repo"]);
        expect(saw(s)).toEqual([]);
        expect(JSON.parse(readFileSync(join(s.root, "out", "result.json"), "utf8")).run.status).toBe("failed");
        expect(readFileSync(join(s.root, "out", "transcript.jsonl"), "utf8")).toBe('{"type":"node_start"}\n');
        expect(readdirSync(join(s.root, "out")).sort()).toEqual(["result.json", "transcript.jsonl"]);
      } finally {
        Bun.spawnSync(["chmod", "-R", "u+w", clone]);
      }
    });
  }

  test("a verify.sh run whose checks move HEAD still makes no bundle, and its steering paths planted in the run are gone before the read-back", async () => {
    const s = sandbox(VERIFY);
    const p = s.start({ FAKE_COMMIT: "1", FAKE_PLANT: "1", FAKE_RC: "7" });
    expect(await p.exited).toBe(7);
    expect(existsSync(join(s.root, "out", "run.bundle"))).toBe(false);
    for (const d of STEERING) expect([d, existsSync(join(s.root, "work", "repo", d))]).toEqual([d, false]);
    expect(saw(s)).toEqual([]);
    expect(existsSync(join(s.root, "out", "result.json"))).toBe(true);
  });

  test("review.sh checks every symlink out again as a plain file holding its target's text (a file link, a dir link and a dangling one), and the status stays clean", async () => {
    const s = sandbox(REVIEW);
    const clone = join(s.root, "work", "repo");
    try {
      const p = s.start();
      expect(await p.exited).toBe(0);
      expect(await new Response(p.stderr).text()).not.toContain("prelude:");
      for (const [name, target] of [["link", join(s.root, "state", "outside.jsonl")], ["d", join(s.root, "state")], ["dangling", join(s.root, "nowhere")]]) {
        const st = lstatSync(join(clone, name!));
        expect([name, st.isSymbolicLink(), st.isFile(), readFileSync(join(clone, name!), "utf8")]).toEqual([name, false, true, target]);
      }
      expect(Bun.spawnSync(["git", "-C", clone, "config", "core.symlinks"], { stdout: "pipe" }).stdout.toString()).toBe("false\n");
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: clone, stdout: "pipe" }).stdout.toString()).toBe("");
      // The index still records each as a link (mode 120000): the review reads what the change committed.
      expect(Bun.spawnSync(["git", "-C", clone, "ls-files", "-s", "link", "d", "dangling"], { stdout: "pipe" }).stdout.toString().split("\n").filter(Boolean).every((l) => l.startsWith("120000 "))).toBe(true);
      // Archon ran, after all of it.
      expect(existsSync(join(s.root, "state", "started"))).toBe(true);
    } finally {
      Bun.spawnSync(["chmod", "-R", "u+w", clone]);
    }
  });

  test("review.sh ends before Archon starts when the checkout isn't clean once its symlinks are plain files", async () => {
    const s = sandbox(REVIEW);
    const clone = join(s.root, "work", "repo");
    // A git that reports the checkout changed, and is otherwise the real one.
    const realGit = Bun.which("git")!;
    writeFileSync(join(s.root, "bin", "git"), `#!/bin/sh\nif [ "$3" = status ]; then echo " M README.md"; exit 0; fi\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    try {
      const p = s.start();
      expect(await p.exited).toBe(1);
      expect(await new Response(p.stderr).text()).toContain("prelude: the checkout is not clean once its symlinks are plain files");
      expect(existsSync(join(s.root, "state", "started"))).toBe(false);
      expect(existsSync(join(s.root, "out", "result.json"))).toBe(false);
    } finally {
      Bun.spawnSync(["chmod", "-R", "u+w", clone]);
    }
  });

  test("review.sh leaves the checkout's files and dirs unwritable, .git aside", async () => {
    const s = sandbox(REVIEW);
    const clone = join(s.root, "work", "repo");
    try {
      const p = s.start();
      expect(await p.exited).toBe(0);
      const paths = ["", ...tree(clone)];
      expect(paths.sort()).toEqual(["", "README.md", "d", "dangling", "link", "sub", "sub/keep.txt"]);
      expect(paths.filter((p) => lstatSync(join(clone, p)).isSymbolicLink())).toEqual([]);
      for (const rel of paths) expect([rel, lstatSync(join(clone, rel)).mode & 0o222]).toEqual([rel, 0]);
      // No link was followed: their targets, out of the checkout, keep their write bits.
      for (const t of ["state/outside.jsonl", "state"]) expect([t, lstatSync(join(s.root, t)).mode & 0o200]).toEqual([t, 0o200]);
      // git still writes its own dir (the remote's removal did), so .git keeps its owner's write bit.
      expect(lstatSync(join(clone, ".git")).mode & 0o200).toBe(0o200);
      expect(lstatSync(join(clone, ".git", "config")).mode & 0o200).toBe(0o200);
      // The checkout is the same: only its modes changed.
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: clone, stdout: "pipe" }).stdout.toString()).toBe("");
    } finally {
      Bun.spawnSync(["chmod", "-R", "u+w", clone]);
    }
  });
});
