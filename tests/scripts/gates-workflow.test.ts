/**
 * .github/workflows/gates.yml, the reusable gates workflow every repo made from templates/repo-contract calls. Its
 * shape: a workflow_call with no permissions and three jobs, `scan`, `check` and the aggregator `gates`, whose check
 * (`ci / gates`) is the required one. `scan` runs no PR code and ignores the PR's scanner configs, .gitattributes,
 * .mailmap and .gitmodules: no mise, no action but checkout, every path diffed as text, scanners installed from
 * sha256-pinned release URLs and run by absolute path under `env -i` with the gates' own config, gitleaks's own git
 * command run first as a dry run, and gitleaks failing closed. Its steps run for real here, as Actions runs them under
 * `defaults.run.shell: bash` (`bash --noprofile --norc -eo pipefail`), on throwaway repos: the config refusals, a
 * checksum mismatch, the scanners' argv and environment (stubs), the dry run (fake gits and the real one), gitleaks
 * itself (the pin mise.toml holds) against every way a PR could hide history from it, the trailer check, and the
 * aggregator.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { aiWorkflowProblems } from "../../src/audit/checks/github";

const REPO = resolve(import.meta.dir, "../..");
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  permissions?: unknown;
  env?: Record<string, string>;
  steps: Step[];
  [k: string]: unknown;
}
const TEXT = await Bun.file(join(REPO, ".github", "workflows", "gates.yml")).text();
const doc = YAML.parse(TEXT) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };
const { scan, check, gates } = doc.jobs as { scan: Job; check: Job; gates: Job };
/** ci.yml's `build` job: the mise steps gates.yml copies. */
const ci: Step[] = YAML.parse(await Bun.file(join(REPO, ".github", "workflows", "ci.yml")).text()).jobs.build.steps;
const MISE_SCAN = "Only the root mise.toml configures mise";
const MISE_CHECK = "mise loads no config or tasks but the root mise.toml";
const ATTRS = "Git diffs every path as text, whatever the PR's .gitattributes say";
const CONFIGS = "The scanners' configs are the gates' own";
const REFUSE = "A PR can't bring its own gitleaks config";
const INSTALL_GITLEAKS = "Install gitleaks, checked against its pinned sha256";
const INSTALL_OTHERS = "Install OSV-Scanner and zizmor, each checked against its pinned sha256";
const GITVER = "git is 2.40 or later";
const DRYRUN = "git log runs clean, exactly as gitleaks will run it";
const SECRETS = "Scan the whole history for secrets (gitleaks)";
const OSV = "Known vulnerabilities in bun.lock (OSV-Scanner)";
const ZIZMOR = "Workflow security (zizmor)";
const TRAILERS = "Factory commits carry their trailers";
const step = (job: Job, name: string) => job.steps.find((s) => s.name === name)!;
/** The clean environment every scanner, and the trailer check's git, runs in. */
const CLEAN = 'env -i PATH=/usr/bin:/bin HOME="$RUNNER_TEMP" GIT_NO_REPLACE_OBJECTS=1';
/** git's empty tree: as GIT_ATTR_SOURCE, git reads no .gitattributes from the checkout. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** The environment of the history scan's git, the dry run's and gitleaks's alike: no in-tree .gitattributes, no /etc/gitconfig. */
const GIT_ENV = `${CLEAN} GIT_ATTR_SOURCE=${EMPTY_TREE} GIT_CONFIG_NOSYSTEM=1`;
/** The log options gitleaks gets (--log-opts) and the dry run passes to git after gitleaks's own `-C . log -p -U0`. */
const LOG_OPTS = "--full-history --all -m --no-mailmap --no-renames --ignore-submodules=none --no-ext-diff --no-textconv";
/** The gitleaks command as gates.yml ran it before fix round 3 (bcb3cbc): the controls show each hole it left. */
const OLD_GITLEAKS = `${CLEAN} "$RUNNER_TEMP/bin/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --ignore-gitleaks-allow --redact --no-banner --no-color -v .`;
/** The gitleaks step as gates.yml ran it before fix round 4 (1e8c81a), with no dry run before it: the controls show each hole it left. */
const ROUND3_GITLEAKS = String.raw`log="$RUNNER_TEMP/gitleaks.log"
code=0
env -i PATH=/usr/bin:/bin HOME="$RUNNER_TEMP" GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_SOURCE=4b825dc642cb6eb9a060e54bf8d69288fbee4904 \
  "$RUNNER_TEMP/bin/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --log-opts="--full-history --all -m --no-mailmap" \
  --ignore-gitleaks-allow --redact --no-banner --no-color -v . 2>&1 | tee "$log" || code=$?
if grep -Eq '(^|[[:space:]])ERR([[:space:]]|$)' "$log"; then
  echo "::error::gitleaks logged an error, so its scan can't be trusted: the history scan fails closed"
  exit 1
fi
if grep -Eq '(^|[[:space:]])0 commits scanned' "$log"; then
  echo "::error::gitleaks scanned 0 commits: the history scan fails closed"
  exit 1
fi
exit "$code"
`;
/** gitleaks's own findings line; `INF no leaks found` doesn't match. */
const FOUND = /WRN leaks found: [1-9]/;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
/** Run one step's script as Actions does with `shell: bash` (`bash --noprofile --norc -eo pipefail`), in `cwd`, with exactly `env`. */
const runStep = (script: string, cwd: string, env: Record<string, string>) => {
  const r = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

/**
 * The workflow commands the Actions runner would act on in a step's output: it reads a line at a time, splitting on a
 * bare CR as well as LF, takes a line that starts with `::` (after leading space) as a command, and between
 * `::stop-commands::<token>` and `::<token>::` acts on none.
 */
const workflowCommands = (out: string) => {
  const acted: string[] = [];
  let stopped: string | undefined;
  for (const raw of out.split(/\r\n|\r|\n/)) {
    const line = raw.trimStart();
    if (stopped !== undefined) {
      if (line === `::${stopped}::`) stopped = undefined;
      continue;
    }
    const stop = line.match(/^::stop-commands::(.*)$/);
    if (stop) stopped = stop[1];
    else if (line.startsWith("::")) acted.push(line);
  }
  return acted;
};
/** The step's script without its stop-commands lines: the control for the tests above. */
const withoutStopToken = (script: string) =>
  script
    .split("\n")
    .filter((l) => !/::stop-commands::|echo "::\$t::"/.test(l))
    .join("\n");

test("gates.yml is a workflow_call with no permissions, and three jobs: scan, check and the aggregator gates", () => {
  expect(Object.keys(doc.on)).toEqual(["workflow_call"]);
  expect(doc.permissions).toEqual({});
  // Named, so Actions adds pipefail: with no shell, a run step is `bash -e {0}`.
  expect((doc as unknown as { defaults: unknown }).defaults).toEqual({ run: { shell: "bash" } });
  for (const job of [scan, check, gates]) for (const st of job.steps) expect([st.name, (st as { shell?: string }).shell]).toEqual([st.name, undefined]);
  // No job sets a shell of its own but bash either.
  for (const [id, job] of Object.entries(doc.jobs)) {
    const shell = (job.defaults as { run?: { shell?: unknown } } | undefined)?.run?.shell;
    expect([id, shell === undefined || shell === "bash"]).toEqual([id, true]);
  }
  expect(Object.keys(doc.jobs)).toEqual(["scan", "check", "gates"]);
  for (const [id, job] of Object.entries(doc.jobs)) {
    expect([id, job.name, job["runs-on"]]).toEqual([id, id, "ubuntu-latest"]);
    expect([id, typeof job["timeout-minutes"]]).toEqual([id, "number"]);
  }
  expect(scan.permissions).toEqual({ contents: "read" });
  expect(check.permissions).toEqual({ contents: "read" });
  expect(scan.steps.map((s) => s.uses?.replace(/@.*$/, "") ?? s.name)).toEqual(["actions/checkout", MISE_SCAN, CONFIGS, ATTRS, REFUSE, INSTALL_GITLEAKS, GITVER, DRYRUN, SECRETS, INSTALL_OTHERS, OSV, ZIZMOR, TRAILERS]);
  expect(check.steps.map((s) => s.uses?.replace(/@.*$/, "") ?? s.name)).toEqual(["actions/checkout", MISE_SCAN, "jdx/mise-action", MISE_CHECK, "check"]);
  expect(scan.steps[0]!.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
  expect(check.steps[0]!.with).toEqual({ "persist-credentials": false });
  expect(check.steps[2]!.with).toEqual({ version: "2026.10.9" });
  expect(step(check, "check").run).toBe("mise install --locked && mise run check");
  // The pins as written, with their tag comments (YAML drops comments, so read the text).
  const uses = [...TEXT.matchAll(/^\s*- uses: (\S+)(.*)$/gm)];
  expect(uses.length).toBe(3);
  for (const [, ref, comment] of uses) expect([ref, comment]).toEqual([expect.stringMatching(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/), expect.stringMatching(/^ # v\d/)]);
  for (const [, ref] of uses) expect(ci.filter((s) => s.uses !== undefined).map((s) => s.uses)).toContain(ref);
  expect(aiWorkflowProblems(".github/workflows/gates.yml", TEXT)).toEqual([]);
  // No step installs packages itself: setup is the caller's own `bun ci --frozen-lockfile --ignore-scripts`.
  for (const job of [scan, check, gates]) for (const s of job.steps) expect([s.name, /\b(bun|npm|pnpm|yarn|pip|uv|cargo) (install|i|add|ci)\b|bunx|npx|uvx/.test(s.run ?? "")]).toEqual([s.name, false]);
});

test("the gates job passes only when scan and check both succeeded, runs even when one failed, and holds nothing", async () => {
  expect(gates.needs).toEqual(["scan", "check"]);
  expect(gates.if).toBe("always()");
  expect(gates.permissions).toEqual({});
  expect(gates.steps.length).toBe(1);
  const s = gates.steps[0]!;
  expect(s.uses).toBeUndefined();
  expect(s.env).toEqual({ SCAN: "${{ needs.scan.result }}", CHECK: "${{ needs.check.result }}" });
  expect(s.run).not.toContain("${{");
  const cwd = tempDir("hapi-gates-agg-");
  for (const [scanResult, checkResult, code] of [
    ["success", "success", 0],
    ["failure", "success", 1],
    ["success", "failure", 1],
    ["success", "skipped", 1],
    ["cancelled", "success", 1],
    ["", "success", 1],
  ] as const) {
    const r = runStep(s.run!, cwd, { PATH: process.env.PATH!, SCAN: scanResult, CHECK: checkResult });
    expect([scanResult, checkResult, r.code]).toEqual([scanResult, checkResult, code]);
    if (code === 1) expect(r.out).toContain("::error::ci / gates needs both ci / scan and ci / check to succeed");
  }
});

test("its mise-file scan, in both jobs, and its mise-config check are ci.yml's, word for word", () => {
  const theirs = (name: string) => ci.find((s) => s.name === name)?.run;
  expect(theirs(MISE_SCAN)).toBeDefined();
  expect(step(scan, MISE_SCAN).run).toBe(theirs(MISE_SCAN)!);
  expect(step(check, MISE_SCAN).run).toBe(theirs(MISE_SCAN)!);
  expect(step(check, MISE_CHECK).run).toBe(theirs(MISE_CHECK)!);
  // The scan runs before mise-action in check, so a stray mise file never reaches mise-action.
  expect(check.steps.findIndex((s) => s.name === MISE_SCAN)).toBeLessThan(check.steps.findIndex((s) => s.uses?.startsWith("jdx/mise-action@") === true));
});

describe("the scan job runs no PR code, and ignores the PR's scanner configs, .gitattributes and .mailmap", () => {
  test("no run in scan names mise at all, but ci.yml's find-only file scan, and its only action is the pinned checkout", () => {
    expect(scan.steps.filter((s) => s.uses !== undefined).map((s) => s.uses)).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"]);
    for (const s of scan.steps.filter((x) => x.run !== undefined)) {
      // The one exception is ci.yml's mise-file scan, word for word: it only *looks for* mise's file names, with find.
      if (s.name === MISE_SCAN) continue;
      const code = s.run!.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
      expect([s.name, /\bmise\b/i.test(code)]).toEqual([s.name, false]);
    }
    expect(step(scan, MISE_SCAN).run).toBe(ci.find((x) => x.name === MISE_SCAN)!.run!);
    // And that scan needs nothing but find: with only find on PATH, it runs and passes on a clean checkout.
    const root = tempDir("hapi-gates-findonly-");
    writeFileSync(join(root, "mise.toml"), "");
    mkdirSync(join(root, ".git"));
    const bin = tempDir("hapi-gates-findbin-");
    symlinkSync(Bun.which("find")!, join(bin, "find"));
    const r = Bun.spawnSync([Bun.which("bash")!, "-e", "-c", step(scan, MISE_SCAN).run!], { cwd: root, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, ""]);
    // Nothing at the job level a PR could use either: the env holds only the pinned URLs and checksums.
    expect(Object.keys(scan.env ?? {}).sort()).toEqual(["GITLEAKS_SHA256", "GITLEAKS_URL", "OSV_SCANNER_SHA256", "OSV_SCANNER_URL", "ZIZMOR_SHA256", "ZIZMOR_URL"]);
  });

  test("every scanner runs by absolute path under env -i with GIT_NO_REPLACE_OBJECTS=1 and the gates' own config", () => {
    expect(step(scan, SECRETS).run).toContain(
      `${GIT_ENV} \\\n  "$RUNNER_TEMP/bin/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" \\\n  --log-opts="${LOG_OPTS}" \\\n  --ignore-gitleaks-allow --redact --no-banner --no-color -v . 2>&1 | tee "$log" || code=$?`,
    );
    // The dry run: gitleaks's own git command (captured: `git -C . log -p -U0` and the --log-opts words, git found
    // first on PATH=/usr/bin:/bin), with the same environment, its patches discarded and its stderr kept.
    expect(step(scan, DRYRUN).run).toContain(`${GIT_ENV} \\\n  /usr/bin/git -C . log -p -U0 ${LOG_OPTS} \\\n  > /dev/null 2> "$err" || code=$?`);
    expect(step(scan, OSV).run).toContain(`${CLEAN} \\\n  "$RUNNER_TEMP/bin/osv-scanner" scan source --config "$RUNNER_TEMP/osv-scanner.toml" --lockfile bun.lock`);
    expect(step(scan, ZIZMOR).run).toContain(`${CLEAN} GH_TOKEN="$GH_TOKEN" \\\n  "$RUNNER_TEMP/bin/zizmor" --no-config --no-ignores --format=github .github/workflows`);
    // zizmor runs online (impostor-commit, ref-confusion) on the job's read-only token, passed by name.
    expect(step(scan, ZIZMOR).run).not.toContain("--offline");
    expect(step(scan, ZIZMOR).env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    // The trailer check's git is the absolute /usr/bin/git in the same clean environment, and every git call goes through it.
    const trailers = step(scan, TRAILERS).run!;
    expect(trailers).toContain(`git() { ${CLEAN} /usr/bin/git "$@"; }`);
    expect(trailers.split("\n").filter((l) => /(^|\$\()\s*git /.test(l.trim())).length).toBeGreaterThan(0);
    for (const s of [DRYRUN, SECRETS, OSV, ZIZMOR]) expect([s, step(scan, s).run!.split(CLEAN).length - 1]).toEqual([s, 1]);
  });

  test("the scanners are the template's pins, from release URLs with a 64-hex sha256 each", async () => {
    const tools = (Bun.TOML.parse(readFileSync(join(REPO, "templates", "repo-contract", "mise.toml.tmpl"), "utf8")) as { tools: Record<string, string> }).tools;
    const env = scan.env!;
    const want = [
      ["GITLEAKS", "gitleaks/gitleaks", "gitleaks", `gitleaks_${tools.gitleaks}_linux_x64.tar.gz`],
      ["OSV_SCANNER", "google/osv-scanner", "osv-scanner", "osv-scanner_linux_amd64"],
      ["ZIZMOR", "zizmorcore/zizmor", "zizmor", "zizmor-x86_64-unknown-linux-gnu.tar.gz"],
    ] as const;
    for (const [key, project, tool, asset] of want) {
      expect([key, env[`${key}_URL`]]).toEqual([key, `https://github.com/${project}/releases/download/v${tools[tool]}/${asset}`]);
      expect([key, env[`${key}_SHA256`]]).toEqual([key, expect.stringMatching(/^[0-9a-f]{64}$/)]);
    }
    // The same release files the template's mise.lock locks for linux-x64, so the gates and a clone agree.
    const locked = Bun.TOML.parse(readFileSync(join(REPO, "templates", "repo-contract", "mise.lock.tmpl"), "utf8")) as { tools: Record<string, Record<string, any>[]> };
    for (const [key, , tool] of want) {
      const linux = locked.tools[tool]![0]!["platforms.linux-x64"] as { url: string; checksum: string };
      expect([key, linux.url, linux.checksum]).toEqual([key, env[`${key}_URL`] ?? "", `sha256:${env[`${key}_SHA256`] ?? ""}`]);
    }
  });
});

describe("the scanners' configs are the gates' own, and a PR can't bring its own gitleaks config", () => {
  const configs = (files: Record<string, string>) => {
    const root = tempDir("hapi-gates-cfg-");
    const runnerTemp = tempDir("hapi-gates-rt-");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return { ...runStep(step(scan, CONFIGS).run!, root, { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp }), runnerTemp };
  };

  test("with neither gitleaks file, the refusal passes, and the gates write gitleaks's default rules and an empty OSV-Scanner config", () => {
    const r = configs({ "README.md": "# x\n", "osv-scanner.toml": "[[IgnoredVulns]]\nid = \"GHSA-x\"\n", ".github/zizmor.yml": "rules: {}\n" });
    expect(r.code).toBe(0);
    expect(runStep(step(scan, REFUSE).run!, tempDir("hapi-gates-cfgok-"), { PATH: process.env.PATH!, RUNNER_TEMP: r.runnerTemp })).toEqual({ code: 0, out: "" });
    expect(readFileSync(join(r.runnerTemp, "gitleaks.toml"), "utf8")).toBe("[extend]\nuseDefault = true\n");
    expect(readFileSync(join(r.runnerTemp, "osv-scanner.toml"), "utf8")).toBe("");
  });

  for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
    test(`a root ${file} fails the step, saying so, and so does a symlink by that name, even a dangling one`, () => {
      for (const make of ["file", "dangling symlink", "symlink"] as const) {
        const root = tempDir("hapi-gates-cfgl-");
        const runnerTemp = tempDir("hapi-gates-rtl-");
        if (make === "file") writeFileSync(join(root, file), "x\n");
        else if (make === "dangling symlink") symlinkSync(join(root, "not-yet"), join(root, file));
        else {
          writeFileSync(join(root, "real.toml"), "x\n");
          symlinkSync(join(root, "real.toml"), join(root, file));
        }
        const r = runStep(step(scan, REFUSE).run!, root, { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp });
        expect([file, make, r.code]).toEqual([file, make, 1]);
        expect(r.out).toContain("::error::a root .gitleaks.toml or .gitleaksignore would change what gitleaks finds");
        expect(readdirSync(runnerTemp)).toEqual([]);
      }
    });
  }
});

test("each install fails closed: a download that doesn't match its pinned sha256 is never unpacked or installed", () => {
  const bin = tempDir("hapi-gates-fakebin-");
  // A curl that "downloads" bytes that aren't the release: the -o file gets them.
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { printf "not the release" > "$2"; exit 0; }; shift; done\nexit 1\n');
  chmodSync(join(bin, "curl"), 0o755);
  for (const name of [INSTALL_GITLEAKS, INSTALL_OTHERS]) {
    const runnerTemp = tempDir("hapi-gates-install-");
    const r = runStep(step(scan, name).run!, tempDir("hapi-gates-cwd-"), { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, ...scan.env! });
    expect([name, r.code === 0]).toEqual([name, false]);
    expect(r.out).toContain("FAILED");
    expect([name, readdirSync(join(runnerTemp, "bin"))]).toEqual([name, []]);
  }
});

describe("each scanner gets exactly its flags and a clean environment", () => {
  /** Stub scanners that record their argv and the environment they were started with (/proc/<pid>/environ). */
  const stubs = () => {
    const runnerTemp = tempDir("hapi-gates-stub-");
    mkdirSync(join(runnerTemp, "bin"));
    for (const tool of ["gitleaks", "osv-scanner", "zizmor", "git"]) {
      writeFileSync(join(runnerTemp, "bin", tool), `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/${tool}.argv"\ntr '\\0' '\\n' < /proc/$$/environ | sort > "$HOME/${tool}.env"\n`);
      chmodSync(join(runnerTemp, "bin", tool), 0o755);
    }
    return runnerTemp;
  };
  // What a PR could try to set, or what a runner might carry: none of it may reach a scanner.
  const polluted = {
    GITLEAKS_CONFIG: "/tmp/x.toml",
    GITLEAKS_CONFIG_TOML: "[allowlist]\npaths = ['''.*''']",
    ZIZMOR_CONFIG: "/tmp/z.yml",
    OSV_SCANNER_CONFIG: "/tmp/o.toml",
    GIT_DIR: "/tmp/elsewhere",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "log.diffMerges",
    GIT_CONFIG_VALUE_0: "off",
    GIT_EXTERNAL_DIFF: "/tmp/differ",
  };
  const historyEnv = [`GIT_ATTR_SOURCE=${EMPTY_TREE}`, "GIT_CONFIG_NOSYSTEM=1"];
  const cases = [
    [SECRETS, "gitleaks", ["git", "--config", "RT/gitleaks.toml", `--log-opts=${LOG_OPTS}`, "--ignore-gitleaks-allow", "--redact", "--no-banner", "--no-color", "-v", "."], historyEnv],
    // The dry run's /usr/bin/git, swapped for the stub.
    [DRYRUN, "git", ["-C", ".", "log", "-p", "-U0", ...LOG_OPTS.split(" ")], historyEnv],
    [OSV, "osv-scanner", ["scan", "source", "--config", "RT/osv-scanner.toml", "--lockfile", "bun.lock"], []],
    [ZIZMOR, "zizmor", ["--no-config", "--no-ignores", "--format=github", ".github/workflows"], ["GH_TOKEN=fake-actions-token"]],
  ] as const;
  for (const [name, tool, argv, extra] of cases) {
    test(`${tool}: ${argv.join(" ")}`, () => {
      const runnerTemp = stubs();
      const script = step(scan, name).run!.replaceAll("/usr/bin/git", join(runnerTemp, "bin", "git"));
      const r = runStep(script, tempDir("hapi-gates-co-"), { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp, GH_TOKEN: "fake-actions-token", ...polluted });
      expect(r.code).toBe(0);
      expect(readFileSync(join(runnerTemp, `${tool}.argv`), "utf8").trim().split("\n")).toEqual(argv.map((a) => a.replace("RT/", `${runnerTemp}/`)));
      expect(readFileSync(join(runnerTemp, `${tool}.env`), "utf8").trim().split("\n")).toEqual(
        ["GIT_NO_REPLACE_OBJECTS=1", ...extra, `HOME=${runnerTemp}`, "PATH=/usr/bin:/bin"].sort(),
      );
    });
  }
});

describe("the gitleaks step fails closed on what gitleaks 8.30.1 would let pass", () => {
  /** A stub gitleaks that prints `out` and exits `code`; the step's exit code and output. */
  const withStub = (out: string, code: number, edit: (script: string) => string = (x) => x) => {
    const runnerTemp = tempDir("hapi-gates-glstub-");
    mkdirSync(join(runnerTemp, "bin"));
    writeFileSync(join(runnerTemp, "out.txt"), out);
    writeFileSync(join(runnerTemp, "bin", "gitleaks"), `#!/bin/sh\ncat "$HOME/out.txt"\nexit ${code}\n`);
    chmodSync(join(runnerTemp, "bin", "gitleaks"), 0o755);
    return runStep(edit(step(scan, SECRETS).run!), tempDir("hapi-gates-glcwd-"), { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp });
  };
  const CLEAN_RUN = "10:07AM INF 3 commits scanned.\n10:07AM INF scanned ~120 bytes in 116ms\n10:07AM INF no leaks found\n";

  test("a clean scan with no ERR passes, and its log is shown", () => {
    const r = withStub(CLEAN_RUN, 0);
    expect(r.code).toBe(0);
    expect(r.out).toContain("INF 3 commits scanned.");
  });

  test("a finding (exit 1) fails, as a finding: its `WRN leaks found: N` line is no warning to the guard", () => {
    for (const n of [1, 2]) {
      const r = withStub(`10:07AM INF 1 commits scanned.\n10:07AM WRN leaks found: ${n}\n`, 1);
      expect([n, r.code]).toEqual([n, 1]);
      expect(r.out).toContain(`WRN leaks found: ${n}`);
      expect(r.out).not.toContain("::error::");
    }
  });

  test("any other WRN line fails, even when gitleaks exits 0, found nothing and scanned commits", () => {
    const demoted = "10:07AM WRN fatal: bad boolean config value 'you may want to set your diff.renameLimit variable' for 'submodule.sub.shallow'\n";
    for (const out of [
      // What gitleaks 8.30.1 logs when git dies quoting a PR's .gitmodules: a WRN, then a clean-looking scan.
      `${demoted}${CLEAN_RUN}`,
      // A line that only ends like the findings count is still a warning.
      `10:07AM WRN you may want to set your diff.renameLimit WRN leaks found: 3\n${CLEAN_RUN}`,
      // So many that a `grep -q` at the end of the pipe would exit early, SIGPIPE the grep before it, and turn the
      // pipeline's status into "no warning".
      `${demoted.repeat(100_000)}${CLEAN_RUN}`,
    ]) {
      const r = withStub(out, 0);
      expect([out.slice(0, 60), r.code]).toEqual([out.slice(0, 60), 1]);
      expect(r.out).toContain("::error::gitleaks logged a warning other than its findings count");
    }
  });

  test("any ERR line fails, even when gitleaks exits 0 and scanned commits", () => {
    const r = withStub(`10:07AM ERR failed to scan Git repository error="stderr is not empty"\n${CLEAN_RUN}`, 0);
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::gitleaks logged an error, so its scan can't be trusted");
  });

  test('"0 commits scanned" fails, even with no ERR and exit 0', () => {
    const r = withStub("10:07AM INF 0 commits scanned.\n10:07AM INF no leaks found\n", 0);
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::gitleaks scanned 0 commits");
    // "10 commits scanned" is no "0 commits scanned".
    expect(withStub("10:07AM INF 10 commits scanned.\n", 0).code).toBe(0);
  });

  test("the guards read the log as text: a NUL byte in it doesn't blind the WRN guard (grep -a)", () => {
    const out = `10:07AM WRN fatal: bad boolean config value 'you may want to set your diff.renameLimit variable' for 'submodule.sub.shallow'\nx\0y\n${CLEAN_RUN}`;
    const r = withStub(out, 0);
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::gitleaks logged a warning other than its findings count");
    // The control: without -a, GNU grep calls the log a binary file, prints no line, and the warning passes.
    expect(withStub(out, 0, (sc) => sc.replaceAll("grep -a", "grep -")).code).toBe(0);
  });

  test("gitleaks's output is read with no workflow command in it: a random stop token, new on every run, surrounds it", () => {
    // A finding's file name is the PR's: it can end a line with LF or a bare CR and start a command.
    const forged = "10:07AM INF 1 commits scanned.\nFinding:     GITHUB_TOKEN=REDACTED\nFile:        a\n::error::forged by the PR\nCommit:      x\r::add-mask::hidden\n10:07AM WRN leaks found: 1\n";
    const [a, b] = [withStub(forged, 1), withStub(forged, 1)];
    for (const r of [a, b]) {
      expect(r.code).toBe(1);
      const lines = r.out.split("\n");
      expect(lines[0]).toMatch(/^::stop-commands::[0-9a-f]{32}$/);
      const t = lines[0]!.slice("::stop-commands::".length);
      expect(lines.indexOf(`::${t}::`)).toBe(lines.indexOf("10:07AM WRN leaks found: 1") + 1);
      expect(workflowCommands(r.out)).toEqual([]);
    }
    expect(a.out.split("\n")[0]).not.toBe(b.out.split("\n")[0]);
    // The guards' own ::error:: comes after the token's end, so Actions still reads it.
    const warned = withStub(`10:07AM WRN you may want to set your diff.renameLimit\n${CLEAN_RUN}`, 0);
    expect(workflowCommands(warned.out)).toEqual([expect.stringMatching(/^::error::gitleaks logged a warning other than its findings count/)]);
    // The control: without the token, the forged commands would be read.
    expect(workflowCommands(withStub(forged, 1, withoutStopToken).out)).toEqual(["::error::forged by the PR", "::add-mask::hidden"]);
  });

  test("the version gate runs before gitleaks, with the absolute /usr/bin/git, and passes only git 2.40 or later", () => {
    const at = (name: string) => scan.steps.findIndex((x) => x.name === name);
    expect(at(GITVER)).toBeLessThan(at(SECRETS));
    const script = step(scan, GITVER).run!;
    expect(script).toContain("env -i PATH=/usr/bin:/bin /usr/bin/git --version");
    const cwd = tempDir("hapi-gates-gv-");
    for (const [says, code] of [
      ["git version 2.39.5", 1],
      ["git version 1.9.0", 1],
      ["git version 2.40.0", 0],
      ["git version 2.43.0", 0],
      ["git version 2.51.0.windows.1", 0],
      ["git version 3.0.0", 0],
      ["not git at all", 1],
      ["", 1],
    ] as const) {
      // A fake git in place of /usr/bin/git, which only the test swaps.
      const fake = join(cwd, `git-${code}-${says.replace(/\W/g, "_")}`);
      writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${says}'\n`);
      chmodSync(fake, 0o755);
      const r = runStep(script.replaceAll("/usr/bin/git", fake), cwd, { PATH: process.env.PATH! });
      expect([says, r.code]).toEqual([says, code]);
      if (code === 1) expect(r.out).toContain("::error::the history scan needs git 2.40 or later");
    }
  });
});

describe("the dry run fails the scan on anything git does that gitleaks 8.30.1 would scan on through", () => {
  /** The dry run with its /usr/bin/git swapped for a fake (the test's only change), or the real one when `fake` is undefined. */
  const dryRun = (cwd: string, fake?: string, edit: (script: string) => string = (x) => x) => {
    const runnerTemp = tempDir("hapi-gates-dryrt-");
    let script = edit(step(scan, DRYRUN).run!);
    if (fake !== undefined) {
      writeFileSync(join(runnerTemp, "git"), `#!/bin/sh\n${fake}\n`);
      chmodSync(join(runnerTemp, "git"), 0o755);
      script = script.replaceAll("/usr/bin/git", join(runnerTemp, "git"));
    }
    return runStep(script, cwd, { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp });
  };

  test("it runs after the version gate and before gitleaks", () => {
    const at = (name: string) => scan.steps.findIndex((x) => x.name === name);
    expect(at(GITVER)).toBeLessThan(at(DRYRUN));
    expect(at(DRYRUN)).toBe(at(SECRETS) - 1);
  });

  test("a git that exits 128 with no stderr fails it", () => {
    const r = dryRun(tempDir("hapi-gates-dry1-"), "exit 128");
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error::git log, run as gitleaks runs it, exited 128 or wrote to stderr");
  });

  test("a git that writes one stderr line and exits 0 fails it, and the line is shown behind a prefix and a stop token, never as a workflow command", () => {
    const fake = "printf '::warning::text from the PR\\rx ::add-mask::y\\r::error::forged\\n' >&2\nexit 0";
    const r = dryRun(tempDir("hapi-gates-dry2-"), fake);
    expect(r.code).toBe(1);
    expect(r.out).toContain("git: ::warning::text from the PR");
    // Actions reads only the step's own error; the PR's text, CR and all, sits behind the token.
    expect(workflowCommands(r.out)).toEqual([expect.stringMatching(/^::error::git log, run as gitleaks runs it, exited 0 or wrote to stderr/)]);
    // The control: behind the prefix alone, a bare CR would still start the PR's command.
    expect(workflowCommands(dryRun(tempDir("hapi-gates-dry2c-"), fake, withoutStopToken).out)).toContain("::error::forged");
  });

  test("the real git on a clean repo passes, silently", () => {
    const root = tempDir("hapi-gates-dry3-");
    const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    writeFileSync(join(root, "README.md"), "# A project\n");
    for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "commit.gpgSign=false", "commit", "-q", "-m", "readme"]]) {
      expect(Bun.spawnSync(["git", ...a], { cwd: root, env, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    expect(dryRun(root)).toEqual({ code: 0, out: "" });
  });
});

test("every path is diffed as text before gitleaks runs: the attributes step comes first, and writes `* diff`", () => {
  const at = (name: string) => scan.steps.findIndex((x) => x.name === name);
  expect(at(ATTRS)).toBeGreaterThan(0);
  expect(at(ATTRS)).toBeLessThan(at(DRYRUN));
  expect(at(ATTRS)).toBeLessThan(at(SECRETS));
  expect(step(scan, ATTRS).run).toBe("mkdir -p .git/info\nprintf '* diff\\n' > .git/info/attributes\n");
});

/** The gitleaks mise.toml pins, or undefined when mise can't say (the real-scan tests then skip, but never in CI). */
const gitleaks = (() => {
  const r = Bun.spawnSync(["mise", "which", "gitleaks"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  const path = r.stdout.toString().trim();
  return r.exitCode === 0 && path !== "" ? path : undefined;
})();
const inCI = (process.env.CI ?? "") !== "";

test.if(inCI)("in CI, mise has the pinned gitleaks, so the real-gitleaks tests run rather than skip", () => {
  expect(gitleaks).toBeDefined();
});

// In CI a missing gitleaks fails these tests (and the one above) instead of skipping them.
describe.skipIf(gitleaks === undefined && !inCI)("the real gitleaks, run as the scan job runs it, on a throwaway repo", () => {
  /** Each test builds and scans up to four repos, about a second alone and more under the whole suite's load. */
  const SLOW = 30_000;
  /** A GitHub token shape, built at run time so no scan of this repo flags this file. */
  const token = () => {
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return `ghp_${[...randomBytes(36)].map((b) => alnum[b % alnum.length]).join("")}`;
  };
  /** A history-building helper: make a dir, write a file (making its dirs), make a symlink, run git. */
  interface Repo {
    root: string;
    mkdir(path: string): void;
    write(path: string, text: string): void;
    link(path: string, target: string): void;
    git(...args: string[]): void;
    commit(message: string): void;
  }
  /** A fresh repo on `main`, built by `build`, with gitleaks linked into a fresh RUNNER_TEMP/bin. */
  const makeRepo = (build: (r: Repo) => void) => {
    const root = tempDir("hapi-gates-gl-");
    const runnerTemp = tempDir("hapi-gates-glrt-");
    mkdirSync(join(runnerTemp, "bin"));
    symlinkSync(gitleaks!, join(runnerTemp, "bin", "gitleaks"));
    const genv = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, env: genv, stdout: "pipe", stderr: "pipe" });
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 0]);
    };
    git("init", "-q", "-b", "main");
    const repo: Repo = {
      root,
      mkdir(path) {
        mkdirSync(join(root, path), { recursive: true });
      },
      write(path, text) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        rmSync(join(root, path), { force: true });
        writeFileSync(join(root, path), text);
      },
      link(path, target) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        rmSync(join(root, path), { force: true });
        symlinkSync(target, join(root, path));
      },
      git,
      commit(message) {
        git("add", "-A");
        git("commit", "-q", "--allow-empty", "-m", message);
      },
    };
    build(repo);
    return { root, runnerTemp };
  };
  /** How a scan differs from the job's: env added to the runner's, steps left out or replaced, and an edit to each step's script. */
  interface Variant {
    env?: Record<string, string>;
    skip?: string[];
    replace?: Record<string, string>;
    edit?: (script: string) => string;
  }
  /**
   * The scan job's steps on a repo `build` makes, in the job's order, from the first after checkout through gitleaks,
   * but the install (the network's: gitleaks is linked in instead), as `v` varies them.
   */
  const scanHistory = (build: (r: Repo) => void, v: Variant = {}) => {
    const { root, runnerTemp } = makeRepo(build);
    const runner = { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp, ...v.env };
    const upTo = scan.steps.findIndex((x) => x.name === SECRETS);
    let last = { code: 0, out: "" };
    for (const x of scan.steps.slice(1, upTo + 1)) {
      if (x.name === INSTALL_GITLEAKS || v.skip?.includes(x.name!)) continue;
      const script = v.replace?.[x.name!] ?? x.run!;
      last = runStep(v.edit?.(script) ?? script, root, runner);
      if (last.code !== 0) return last;
    }
    return last;
  };
  // The controls: the scan as gates.yml ran it before fix round 3 (bcb3cbc: no version gate, no dry run), with or
  // without the attributes step; before fix round 4 (1e8c81a: no dry run, round 3's gitleaks step); and today's with
  // rename detection back on.
  const before3 = (attrs: boolean): Variant => ({ skip: [GITVER, DRYRUN, ...(attrs ? [] : [ATTRS])], replace: { [SECRETS]: OLD_GITLEAKS } });
  const before4: Variant = { skip: [DRYRUN], replace: { [SECRETS]: ROUND3_GITLEAKS } };
  const renamesOn: Variant = { edit: (s) => s.replaceAll(" --no-renames", "") };
  /** A repo whose one commit holds `files`. */
  const oneCommit = (files: Record<string, string>) => (r: Repo) => {
    for (const [path, text] of Object.entries(files)) r.write(path, text);
    r.commit("add files");
  };
  const scanRepo = (files: Record<string, string>, env: Record<string, string> = {}) => scanHistory(oneCommit(files), { env });

  test("passes on a clean history, and on one with a rename, with no ERR or WRN line; and finds a token", () => {
    const clean = scanRepo({ "README.md": "# A project\n" });
    expect(clean.code).toBe(0);
    expect(clean.out).not.toMatch(/(^|\s)(ERR|WRN)(\s|$)/m);
    expect(clean.out).toMatch(/\s1 commits scanned/);
    const renamed = scanHistory((r) => {
      r.write("README.md", "# A project\n");
      r.write("docs/a.md", "a line\n".repeat(30));
      r.commit("docs");
      r.git("mv", "docs/a.md", "docs/b.md");
      r.commit("rename");
    });
    expect(renamed.code).toBe(0);
    expect(renamed.out).not.toMatch(/(^|\s)(ERR|WRN)(\s|$)/m);
    const found = scanRepo({ "config.env": `GITHUB_TOKEN=${token()}\n` });
    expect(found.code).toBe(1);
    expect(found.out).toMatch(FOUND);
  }, SLOW);

  test("the dry run runs exactly the git command, in exactly the environment, that the real gitleaks runs", () => {
    const { root, runnerTemp } = makeRepo(oneCommit({ "README.md": "# A project\n" }));
    /** A git in `dir` that records its argv and environment there, then runs /usr/bin/git. */
    const recorder = (dir: string) => {
      mkdirSync(dir);
      writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/$$.argv"\ntr '\\0' '\\n' < /proc/$$/environ | sort > "${dir}/$$.env"\nexec /usr/bin/git "$@"\n`);
      chmodSync(join(dir, "git"), 0o755);
      return dir;
    };
    /** The one recorded `git … log …` call. */
    const logCall = (dir: string) => {
      const calls = readdirSync(dir)
        .filter((f) => f.endsWith(".argv"))
        .map((f) => ({ argv: readFileSync(join(dir, f), "utf8").trim().split("\n"), env: readFileSync(join(dir, f.replace(/\.argv$/, ".env")), "utf8").trim().split("\n") }))
        .filter((c) => c.argv.includes("log"));
      expect(calls.length).toBe(1);
      return calls[0]!;
    };
    const runner = { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp };
    expect(runStep(step(scan, CONFIGS).run!, root, runner).code).toBe(0);
    const dry = recorder(join(runnerTemp, "dry"));
    expect(runStep(step(scan, DRYRUN).run!.replaceAll("/usr/bin/git", join(dry, "git")), root, runner).code).toBe(0);
    // gitleaks finds git on its PATH: the recorder first, everything else as the step sets it.
    const real = recorder(join(runnerTemp, "real"));
    const script = step(scan, SECRETS).run!;
    expect(script.split("env -i PATH=/usr/bin:/bin ").length).toBe(2);
    expect(runStep(script.replace("env -i PATH=/usr/bin:/bin ", `env -i PATH=${real}:/usr/bin:/bin `), root, runner).code).toBe(0);
    const [a, b] = [logCall(dry), logCall(real)];
    expect(b.argv).toEqual(["-C", ".", "log", "-p", "-U0", ...LOG_OPTS.split(" ")]);
    expect(a.argv).toEqual(b.argv);
    const path = (env: string[]) => env.filter((l) => l.startsWith("PATH="));
    const rest = (env: string[]) => env.filter((l) => !l.startsWith("PATH="));
    expect(rest(a.env)).toEqual(rest(b.env));
    expect(rest(b.env)).toEqual([`GIT_ATTR_SOURCE=${EMPTY_TREE}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_NO_REPLACE_OBJECTS=1", `HOME=${runnerTemp}`]);
    // The dry run's git is /usr/bin/git, which is what gitleaks's PATH=/usr/bin:/bin finds first.
    expect([path(a.env), path(b.env)]).toEqual([["PATH=/usr/bin:/bin"], [`PATH=${real}:/usr/bin:/bin`]]);
    expect(Bun.which("git", { PATH: "/usr/bin:/bin" })).toBe("/usr/bin/git");
  }, SLOW);

  test("an inline gitleaks:allow comment doesn't hide a token", () => {
    expect(scanRepo({ "config.env": `GITHUB_TOKEN=${token()} # gitleaks:allow\n` }).code).toBe(1);
  }, SLOW);

  test("a config in the runner's environment never reaches gitleaks (env -i): GITLEAKS_CONFIG_TOML allowlisting everything changes nothing", () => {
    const allowAll = "[extend]\nuseDefault = true\n[allowlist]\npaths = ['''.*''']\n";
    const dir = tempDir("hapi-gates-glcfg-");
    writeFileSync(join(dir, "allow.toml"), allowAll);
    const r = scanRepo({ "config.env": `GITHUB_TOKEN=${token()}\n` }, { GITLEAKS_CONFIG_TOML: allowAll, GITLEAKS_CONFIG: join(dir, "allow.toml") });
    expect(r.code).toBe(1);
  }, SLOW);

  // Every way found for a commit to hide a token from gitleaks 8.30.1. Each test asserts the token is *found*
  // (gitleaks's `WRN leaks found: N`), not just that the step failed, so a guard failing the step (the dry run, ERR,
  // WRN or 0 commits) can't stand in for the fix the name gives. And each has its control: the scan as it was before
  // that fix lets the token through (exit 0), so the test exercises the hole the fix closes.
  const secret = (t: string) => `GITHUB_TOKEN=${t}\n`;
  /** The fix round 4 case: git dies quoting a .gitmodules value while diffing a gitlink, after a merge gitleaks has already scanned. */
  const gitmodules = (t: string) => (r: Repo) => {
    r.write("a", "base\n");
    r.commit("base");
    r.git("checkout", "-q", "-b", "side");
    r.write("config.env", secret(t));
    r.commit("A: the token");
    r.git("rm", "-q", "config.env");
    r.write(".gitmodules", '[submodule "sub"]\n\tpath = sub\n\turl = https://example.invalid/sub.git\n\tshallow = you may want to set your diff.renameLimit variable\n');
    r.git("add", ".gitmodules");
    r.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
    r.git("commit", "-q", "-m", "B: the token gone, a .gitmodules and a gitlink");
    r.git("rm", "-q", "--cached", "sub");
    r.git("commit", "-q", "-m", "C: the gitlink gone");
    r.git("checkout", "-q", "main");
    r.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  };
  /** A token committed in `from`, then moved to `to` (`git mv`), with one line edited when `edit` is set. */
  const moved = (from: string, to: string, edit: boolean) => (t: string) => (r: Repo) => {
    const body = (last: string) => `${"x\n".repeat(20)}${secret(t)}${"y\n".repeat(19)}${last}`;
    r.write("README.md", "# A project\n");
    r.commit("readme");
    r.write(from, body("y\n"));
    r.commit(`add ${from}`);
    r.mkdir(join(to, ".."));
    r.git("mv", from, to);
    if (edit) r.write(to, body("z\n"));
    r.commit(`move it to ${to}`);
  };
  const cases: [what: string, build: (t: string) => (r: Repo) => void, foundBy: string, control: Variant][] = [
    // Turned into "Binary files differ", which gitleaks skips. `* diff` (round 2) and GIT_ATTR_SOURCE (round 3) each close these alone.
    ["a root .gitattributes with * -diff", (t) => oneCommit({ ".gitattributes": "* -diff\n", "config.env": secret(t) }), "`* diff` or GIT_ATTR_SOURCE", before3(false)],
    ["a root .gitattributes with * binary", (t) => oneCommit({ ".gitattributes": "* binary\n", "config.env": secret(t) }), "`* diff` or GIT_ATTR_SOURCE", before3(false)],
    ["a nested sub/.gitattributes with * -diff over the secret", (t) => oneCommit({ "sub/.gitattributes": "* -diff\n", "sub/config.env": secret(t) }), "`* diff` or GIT_ATTR_SOURCE", before3(false)],
    ["a NUL byte in the secret's file", (t) => oneCommit({ "config.env": `${secret(t)}\0\n` }), "`* diff`", before3(false)],
    // git writes to stderr, and gitleaks logs an ERR, stops reading, reports the commits it got through and exits 0.
    // Without GIT_ATTR_SOURCE (or --no-mailmap) git warns, and the dry run fails the step with no finding.
    ["a nested [attr] macro, which git refuses outside the root", (t) => oneCommit({ "sub/.gitattributes": "[attr]h -diff\n", "config.env": secret(t) }), "GIT_ATTR_SOURCE", before3(true)],
    ["a negative pattern in .gitattributes", (t) => oneCommit({ ".gitattributes": "!x diff\n", "config.env": secret(t) }), "GIT_ATTR_SOURCE", before3(true)],
    ["a .gitattributes line over 2048 bytes", (t) => oneCommit({ ".gitattributes": `${"a".repeat(3000)} -diff\n`, "config.env": secret(t) }), "GIT_ATTR_SOURCE", before3(true)],
    [
      "a symlinked .gitattributes",
      (t) => (r) => {
        r.write("attrs", "* -diff\n");
        r.link(".gitattributes", "attrs");
        r.write("config.env", secret(t));
        r.commit("a");
      },
      "GIT_ATTR_SOURCE",
      before3(true),
    ],
    [
      "a symlinked .mailmap",
      (t) => (r) => {
        r.write("mm", "x <x@example.invalid>\n");
        r.link(".mailmap", "mm");
        r.write("config.env", secret(t));
        r.commit("a");
      },
      "--no-mailmap",
      before3(true),
    ],
    // Skipped by gitleaks's default `--diff-filter=tuxdb`: a type change, from a symlink or from a gitlink.
    [
      "a type change: a symlink later replaced by a file holding the token",
      (t) => (r) => {
        r.link("config.env", "nowhere");
        r.commit("a link");
        r.write("config.env", secret(t));
        r.commit("now a file");
      },
      "--log-opts, which drops the default --diff-filter",
      before3(true),
    ],
    [
      "a type change: a gitlink later replaced by a file holding the token",
      (t) => (r) => {
        r.write("README.md", "# A project\n");
        r.commit("readme");
        r.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},sub`);
        r.git("commit", "-q", "-m", "a gitlink");
        r.git("rm", "-q", "--cached", "sub");
        r.write("sub", secret(t));
        r.commit("now a file");
      },
      "--log-opts, which drops the default --diff-filter",
      before3(true),
    ],
    // Not shown by `log -p` without -m: an evil merge, whose token is in neither parent.
    [
      "an evil merge",
      (t) => (r) => {
        r.write("a", "base\n");
        r.commit("base");
        r.git("checkout", "-q", "-b", "side");
        r.write("s", "side\n");
        r.commit("side");
        r.git("checkout", "-q", "main");
        r.write("m", "main\n");
        r.commit("main");
        r.git("merge", "-q", "--no-commit", "--no-ff", "side");
        r.write("config.env", secret(t));
        r.commit("merge side");
      },
      "-m",
      before3(true),
    ],
    // git dies quoting the PR's text, and gitleaks logs it as a WRN and passes on what it scanned before (round 4).
    ["a .gitmodules value git dies on, quoting it, behind a merge", gitmodules, "--ignore-submodules=none", before4],
    // A token first committed in a path gitleaks's default allowlist skips (H-240), then moved: with rename detection
    // the move shows only the edited lines, so the token is never scanned anywhere (round 4).
    ["a token moved from node_modules/pkg/index.js to src/app.js", moved("node_modules/pkg/index.js", "src/app.js", false), "--no-renames", renamesOn],
    ["a token moved from logo.png to src/app.ts with a one-line edit", moved("logo.png", "src/app.ts", true), "--no-renames", renamesOn],
    ["a token moved from package-lock.json to config.json", moved("package-lock.json", "config.json", false), "--no-renames", renamesOn],
  ];
  for (const [what, build, foundBy, control] of cases) {
    test(`${what} doesn't hide a token: ${foundBy} finds it`, () => {
      const r = scanHistory(build(token()));
      expect([what, r.code]).toEqual([what, 1]);
      expect([what, r.out]).toEqual([what, expect.stringMatching(FOUND)]);
      expect([what, scanHistory(build(token()), control).code]).toEqual([what, 0]);
    }, SLOW);
  }

  test("the .gitmodules case is closed three times over: without --ignore-submodules=none the dry run fails it, and without the dry run too the WRN guard does", () => {
    const flagOff: Variant = { edit: (s) => s.replaceAll(" --ignore-submodules=none", "") };
    const dry = scanHistory(gitmodules(token()), flagOff);
    expect(dry.code).toBe(1);
    expect(dry.out).toContain("::error::git log, run as gitleaks runs it, exited 128 or wrote to stderr");
    expect(dry.out).toContain("git: fatal: bad boolean config value 'you may want to set your diff.renameLimit variable' for 'submodule.sub.shallow'");
    const wrn = scanHistory(gitmodules(token()), { ...flagOff, skip: [DRYRUN] });
    expect(wrn.code).toBe(1);
    expect(wrn.out).toContain("WRN fatal: bad boolean config value");
    expect(wrn.out).toContain("::error::gitleaks logged a warning other than its findings count");
    expect(wrn.out).not.toMatch(FOUND);
    // What the control let through: the WRN, the merge's commit scanned (so no "0 commits scanned"), "no leaks found", exit 0.
    const before = scanHistory(gitmodules(token()), before4);
    expect(before.code).toBe(0);
    expect(before.out).toMatch(/WRN fatal: bad boolean config value[^\n]*\n[^\n]* INF [1-9]\d* commits scanned\.\n[^]* INF no leaks found/);
  }, SLOW);

  test("GIT_ATTR_SOURCE alone finds a token under a committed * -diff, and only `* diff` finds a NUL-byte token beside other commits", () => {
    // The scan without the attributes step: in-tree attributes are ignored, but a NUL byte still reads as binary.
    const without = (build: (r: Repo) => void) => scanHistory(build, { skip: [ATTRS] });
    // Found, not just failed: a lone binary-looking commit would also trip the "0 commits scanned" guard.
    const attrs = without(oneCommit({ ".gitattributes": "* -diff\n", "config.env": secret(token()) }));
    expect(attrs.code).toBe(1);
    expect(attrs.out).toMatch(FOUND);
    // A history of one NUL-byte commit trips that guard on its own, with no finding; beside a text commit it doesn't
    // ("1 commits scanned"), and only `* diff` finds the token.
    const lone = without(oneCommit({ "config.env": `${secret(token())}\0\n` }));
    expect(lone.out).toContain("::error::gitleaks scanned 0 commits");
    expect(lone.out).not.toMatch(FOUND);
    const beside = (r: Repo) => {
      r.write("README.md", "# A project\n");
      r.commit("readme");
      r.write("config.env", `${secret(token())}\0\n`);
      r.commit("the secret, with a NUL byte");
    };
    expect(without(beside).code).toBe(0);
    const full = scanHistory(beside);
    expect(full.code).toBe(1);
    expect(full.out).toMatch(FOUND);
  }, SLOW);

  test("a .gitleaks.toml or .gitleaksignore in the commit fails the scan before gitleaks runs", () => {
    for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
      const r = scanRepo({ [file]: "[allowlist]\npaths = ['''.*''']\n", "config.env": `GITHUB_TOKEN=${token()}\n` });
      expect([file, r.code]).toEqual([file, 1]);
      expect(r.out).toContain("would change what gitleaks finds");
    }
  }, SLOW);
});

describe("with real git: the trailer step passes factory commits with all six trailers and fails one without Model", () => {
  const s = step(scan, TRAILERS);

  test("it runs on pull requests only, with the refs and SHAs from env, never inline", () => {
    expect(s.if).toBe("github.event_name == 'pull_request'");
    expect(s.env).toEqual({ HEAD_REF: "${{ github.head_ref }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}" });
    expect(s.run).not.toContain("${{");
  });

  const ALL = ["Work-Order: 0001-skeleton", "Hapi-Run: 000000000001", "Hapi-Lane: factory", "Trace-Id: 4bf92f3577b34da6a3ce929d0e0e4736", "Agent: pi@1.3.0", "Model: claude-haiku-4-5"];
  /** A repo with a base commit and one commit per trailer set on top; runs the step with HEAD_REF. */
  const run = (headRef: string, commits: string[][]) => {
    const root = tempDir("hapi-gates-trailers-");
    const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...a], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      expect([a.join(" "), r.exitCode]).toEqual([a.join(" "), 0]);
      return r.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const shas: string[] = [];
    for (const [i, trailers] of commits.entries()) {
      git("commit", "-q", "--allow-empty", "-m", `piece ${i}\n\nWhat it does.\n\n${trailers.join("\n")}`);
      shas.push(git("rev-parse", "HEAD"));
    }
    const r = runStep(s.run!, root, { PATH: process.env.PATH!, RUNNER_TEMP: tempDir("hapi-gates-trt-"), HEAD_REF: headRef, BASE_SHA: base, HEAD_SHA: shas.at(-1) ?? base });
    return { ...r, shas };
  };

  test("all six trailers on every commit pass", () => {
    expect(run("factory/0001-skeleton", [ALL, ALL]).code).toBe(0);
  });

  test("a commit without Model fails, naming it", () => {
    const r = run("factory/0001-skeleton", [ALL, ALL.filter((t) => !t.startsWith("Model:"))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::${r.shas[1]} has no Model trailer`);
    expect(r.out).not.toContain(r.shas[0]!);
  });

  test("an empty trailer, or a lane other than factory, fails too", () => {
    let r = run("factory/x", [ALL.map((t) => (t.startsWith("Agent:") ? "Agent: " : t))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::${r.shas[0]} has no Agent trailer`);
    r = run("factory/x", [ALL.map((t) => (t.startsWith("Hapi-Lane:") ? "Hapi-Lane: planning" : t))]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`::error::${r.shas[0]} has no Hapi-Lane: factory trailer`);
    r = run("factory/x", [[]]);
    expect(r.out.match(/::error::/g)?.length).toBe(6);
  });

  test("a branch that isn't factory/** passes, whatever its commits carry", () => {
    expect(run("plan/x", [[]]).code).toBe(0);
    expect(run("feature/factory/x", [[]]).code).toBe(0);
  });
});
