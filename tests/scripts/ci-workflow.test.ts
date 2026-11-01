/**
 * .github/workflows/ci.yml, hapi-factory's own CI: three jobs, `build` (the toolchain, type-check and unit tests),
 * `secrets` (the history scan) and the aggregator `ci`, the required check. Where `build`'s checks sit among its steps,
 * and its mise-file scan and mise-config check run for real, as CI runs them (`bash -e`), on throwaway checkouts.
 * `secrets` is gates.yml's history scan, byte for byte but the gitleaks --config, and runs for real here too, with the
 * gitleaks mise.toml pins, against this repo's .githooks/gitleaks.toml. Also: the root mise.lock CI installs from
 * covers every mise.toml pin, with a checksum.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { aiWorkflowProblems } from "../../src/audit/checks/github";

const REPO = resolve(import.meta.dir, "../..");
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  permissions?: unknown;
  env?: Record<string, string>;
  defaults?: unknown;
  steps: Step[];
  [k: string]: unknown;
}
const TEXT = await Bun.file(join(REPO, ".github", "workflows", "ci.yml")).text();
const doc = YAML.parse(TEXT) as { permissions: unknown; jobs: Record<string, Job> };
const { build, secrets } = doc.jobs as { build: Job; secrets: Job };
const aggregator = doc.jobs.ci!;
/** gates.yml's scan job, whose history scan `secrets` runs. */
const gatesScan = (YAML.parse(await Bun.file(join(REPO, ".github", "workflows", "gates.yml")).text()) as { jobs: { scan: Job } }).jobs.scan;
/** `build`'s steps: the existing checks the tests below place and run. */
const steps: Step[] = build.steps;
const MISE_SCAN = "Only the root mise.toml configures mise";
const MISE_CHECK = "mise loads no config or tasks but the root mise.toml";
const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test("the mise-file scan runs right after checkout, before mise-action reads, installs from or exports the env of any mise file", () => {
  const scan = at((s) => s.name === MISE_SCAN);
  expect(scan).toBeGreaterThan(at((s) => s.uses?.startsWith("actions/checkout@") === true));
  expect(scan).toBeLessThan(at((s) => s.uses?.startsWith("jdx/mise-action@") === true));
});

test("every mise install in CI is --locked, so a tool the root mise.lock doesn't cover fails instead of resolving a version", () => {
  const installs = steps.flatMap((s) => (s.run ?? "").match(/\bmise install\b[^&|;\n]*/g) ?? []);
  expect(installs.length).toBeGreaterThan(0);
  for (const install of installs) expect(install).toMatch(/^mise install --locked\b/);
});

test("the root mise.lock locks every mise.toml tool at its pinned version, with a sha256 and an https URL for CI's linux-x64 runner", async () => {
  const pinned = Bun.TOML.parse(await Bun.file(join(REPO, "mise.toml")).text()) as { tools: Record<string, string> };
  const locked = Bun.TOML.parse(await Bun.file(join(REPO, "mise.lock")).text()) as {
    tools: Record<string, { version: string; [platform: string]: unknown }[]>;
  };
  expect(Object.keys(locked.tools).sort()).toEqual(Object.keys(pinned.tools).sort());
  for (const [tool, version] of Object.entries(pinned.tools)) {
    const entry = locked.tools[tool]?.find((e) => e.version === version);
    expect([tool, entry?.version]).toEqual([tool, version]);
    expect([tool, entry?.["platforms.linux-x64"]]).toEqual([
      tool,
      expect.objectContaining({ checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), url: expect.stringMatching(/^https:\/\//) }),
    ]);
  }
});

test("the mise-config check runs once mise is installed, before any step that installs tools or runs a task", () => {
  const check = at((s) => s.name === MISE_CHECK);
  expect(check).toBeGreaterThan(at((s) => s.uses?.startsWith("jdx/mise-action@") === true));
  const first = at((s) => /\bmise (install|run)\b/.test(s.run ?? ""));
  expect(first).toBeGreaterThan(check);
});

describe("the mise-file scan, run on a throwaway checkout", () => {
  const script = steps.find((s) => s.name === MISE_SCAN)?.run ?? "exit 99";
  /** A checkout holding mise.toml, a .git dir and `files`; the step's exit code and output. */
  const scan = (files: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "hapi-ci-scan-mise-"));
    temps.push(root);
    const all = { "mise.toml": '[tasks.test]\nrun = "true"\n', ".git/HEAD": "ref: refs/heads/main\n", ".git/mise.toml": "", ...files };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    // Only find on PATH: the scan runs before mise-action, so it must not need mise, jq or anything else.
    const bin = mkdtempSync(join(tmpdir(), "hapi-ci-scan-bin-"));
    temps.push(bin);
    symlinkSync(Bun.which("find")!, join(bin, "find"));
    const r = Bun.spawnSync([Bun.which("bash")!, "-e", "-c", script], { cwd: root, env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("passes with only the root mise.toml and mise.lock, whatever else is named like mise", () => {
    const r = scan({ "mise.lock": "", "src/mise.ts": "", "docs/mise.md": "", "misery.toml": "", "mise-notes/a.md": "", "docs/mise.lockfile.md": "", ".config/other.toml": "" });
    expect([r.code, r.out]).toEqual([0, ""]);
  });

  for (const path of [
    ".mise.toml",
    "mise.local.toml",
    ".mise.local.toml",
    "mise.ci.toml",
    ".mise.ci.toml",
    "mise/config.toml",
    "mise/conf.d/extra.toml",
    "mise/tasks/extra",
    ".mise/config.toml",
    ".mise/tasks/extra",
    ".config/mise.toml",
    ".config/mise.local.toml",
    ".config/mise/config.toml",
    ".config/mise/conf.d/extra.toml",
    ".config/mise/tasks/extra",
    "mise-tasks/extra",
    ".mise-tasks/extra",
    ".tool-versions",
    "mise.ci.lock",
    "mise.local.lock",
    "MISE.LOCK",
    "src/mise.toml",
    "pkg/mise.lock",
    "pkg/.mise.toml",
    "pkg/.tool-versions",
    "MISE.TOML",
    ".Mise.Toml",
  ]) {
    test(`fails on ${path}, naming it`, () => {
      const r = scan({ [path]: "" });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(path.split("/")[0]!);
      expect(r.out).not.toContain(".git/");
    });
  }
});

/** mise and jq that run (a mise shim with no version set doesn't); the step needs both. */
const runs = (cmd: string) => Bun.which(cmd) !== null && Bun.spawnSync([cmd, "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!runs("mise") || !runs("jq"))("the mise-config check, run on a throwaway checkout", () => {
  const script = steps.find((s) => s.name === MISE_CHECK)?.run ?? "exit 99";
  /** A checkout holding mise.toml with two tasks, plus `files`; the step's exit code and output. */
  const check = (files: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), "hapi-ci-mise-"));
    temps.push(root);
    const all = { "mise.toml": '[tasks.test]\nrun = "true"\n\n[tasks.lint]\nrun = "true"\n', ...files };
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
      if (text.startsWith("#!")) chmodSync(join(root, path), 0o755);
    }
    const r = Bun.spawnSync(["bash", "-e", "-c", script], { cwd: root, env: { ...process.env, MISE_OFFLINE: "1" }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("passes with only the root mise.toml", () => {
    expect(check().code).toBe(0);
  });

  const TOML = '[tasks.test]\nrun = "echo not the tests"\n';
  const TASK = "#!/bin/sh\necho not the tests\n";
  for (const [path, text] of [
    [".mise.toml", TOML],
    ["mise.local.toml", TOML],
    [".mise.local.toml", TOML],
    ["mise/config.toml", TOML],
    ["mise/conf.d/extra.toml", TOML],
    [".mise/config.toml", TOML],
    [".config/mise.toml", TOML],
    [".config/mise.local.toml", TOML],
    [".config/mise/config.toml", TOML],
    [".config/mise/conf.d/extra.toml", TOML],
    [".tool-versions", "bun 1.4.4\n"],
    ["mise-tasks/extra", TASK],
    [".mise-tasks/extra", TASK],
    ["mise/tasks/extra", TASK],
    [".mise/tasks/extra", TASK],
    [".config/mise/tasks/extra", TASK],
  ] as const) {
    test(`fails on ${path}, naming it`, () => {
      const r = check({ [path]: text });
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`/${path}`);
    });
  }
});

test("ci.yml has three jobs, build, secrets and the aggregator ci (the required check), each least-privileged", () => {
  expect(Object.keys(doc.jobs)).toEqual(["build", "secrets", "ci"]);
  for (const [id, job] of Object.entries(doc.jobs)) expect([id, job.name, job["runs-on"], typeof job["timeout-minutes"]]).toEqual([id, id, "ubuntu-latest", "number"]);
  expect(doc.permissions).toEqual({});
  expect(build.permissions).toEqual({ contents: "read" });
  expect(secrets.permissions).toEqual({ contents: "read" });
  // build keeps its steps; the history scan left it, and so did the full-history checkout it needed.
  expect(build.steps.map((s) => s.uses?.replace(/@.*$/, "") ?? s.name)).toEqual(["actions/checkout", MISE_SCAN, "jdx/mise-action", MISE_CHECK, "Install tools, type-check, unit tests"]);
  expect(build.steps[0]!.with).toEqual({ "persist-credentials": false });
  expect(aiWorkflowProblems(".github/workflows/ci.yml", TEXT)).toEqual([]);
  // Every action pinned to a full SHA, with its tag in a comment.
  for (const [, ref, comment] of TEXT.matchAll(/^\s*- uses: (\S+)(.*)$/gm)) expect([ref, comment]).toEqual([expect.stringMatching(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/), expect.stringMatching(/^ # v\d/)]);
});

test("the ci job passes only when build and secrets both succeeded, runs even when one failed, and holds nothing", () => {
  expect(aggregator.needs).toEqual(["build", "secrets"]);
  expect(aggregator.if).toBe("always()");
  expect(aggregator.permissions).toEqual({});
  expect(aggregator.steps.length).toBe(1);
  const s = aggregator.steps[0]!;
  expect(s.uses).toBeUndefined();
  expect(s.env).toEqual({ BUILD: "${{ needs.build.result }}", SECRETS: "${{ needs.secrets.result }}" });
  expect(s.run).not.toContain("${{");
  const cwd = mkdtempSync(join(tmpdir(), "hapi-ci-agg-"));
  temps.push(cwd);
  for (const [b, sec, code] of [
    ["success", "success", 0],
    ["failure", "success", 1],
    ["success", "failure", 1],
    ["success", "skipped", 1],
    ["cancelled", "success", 1],
    ["", "success", 1],
  ] as const) {
    const r = Bun.spawnSync(["bash", "-e", "-c", s.run!], { cwd, env: { PATH: process.env.PATH!, BUILD: b, SECRETS: sec }, stdout: "pipe", stderr: "pipe" });
    expect([b, sec, r.exitCode]).toEqual([b, sec, code]);
    if (code === 1) expect(r.stdout.toString()).toContain("::error::ci needs both build and secrets to succeed");
  }
});

const ATTRS = "Git diffs every path as text, whatever the PR's .gitattributes say";
const REFUSE = "A PR can't bring its own gitleaks config";
const INSTALL_GITLEAKS = "Install gitleaks, checked against its pinned sha256";
const GITVER = "git is 2.40 or later";
const DRYRUN = "git log runs clean, exactly as gitleaks will run it";
const SCAN = "Scan the whole history for secrets (gitleaks)";
/** The history scan's steps, in order, in gates.yml's scan job and in ci.yml's secrets job alike. */
const SHARED = [ATTRS, REFUSE, INSTALL_GITLEAKS, GITVER, DRYRUN, SCAN];
const GATES_CONFIG = '"$RUNNER_TEMP/bin/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" ';
const OUR_CONFIG = '"$RUNNER_TEMP/bin/gitleaks" git --config .githooks/gitleaks.toml ';

test("secrets runs no PR code: no mise, no action but the pinned checkout, a fresh full-history checkout, bash with pipefail", () => {
  expect(secrets.steps.filter((s) => s.uses !== undefined).map((s) => s.uses)).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"]);
  expect(secrets.steps[0]!.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
  for (const s of secrets.steps.slice(1)) {
    const code = s.run!.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
    expect([s.name, /\bmise\b/i.test(code)]).toEqual([s.name, false]);
  }
  // The gitleaks step's exit comes through `| tee`: Actions adds pipefail only with a shell named.
  expect(secrets.defaults).toEqual({ run: { shell: "bash" } });
  for (const s of secrets.steps) expect([s.name, (s as { shell?: string }).shell]).toEqual([s.name, undefined]);
});

test("secrets' history scan is gates.yml's, byte for byte, but the gitleaks --config: this repo's .githooks/gitleaks.toml", () => {
  const ours = secrets.steps.slice(1);
  expect(ours.map((s) => s.name)).toEqual(SHARED);
  // In gates.yml the same steps run back to back.
  const start = gatesScan.steps.findIndex((s) => s.name === ATTRS);
  const theirs = gatesScan.steps.slice(start, start + SHARED.length);
  expect(theirs.map((s) => s.name)).toEqual(SHARED);
  for (const [i, name] of SHARED.entries()) {
    const want = { ...theirs[i]! };
    if (name === SCAN) {
      expect(want.run!.split(GATES_CONFIG).length).toBe(2);
      want.run = want.run!.replace(GATES_CONFIG, OUR_CONFIG);
    }
    expect([name, ours[i]]).toEqual([name, want]);
  }
  expect(secrets.steps[0]).toEqual(gatesScan.steps[0]!);
});

test("secrets installs the gitleaks gates.yml pins: mise.toml's version, and the root mise.lock's linux-x64 file and checksum", () => {
  const pins = { GITLEAKS_URL: gatesScan.env!.GITLEAKS_URL!, GITLEAKS_SHA256: gatesScan.env!.GITLEAKS_SHA256! };
  expect(secrets.env).toEqual(pins);
  const pinned = (Bun.TOML.parse(readFileSync(join(REPO, "mise.toml"), "utf8")) as { tools: Record<string, string> }).tools.gitleaks!;
  const locked = (Bun.TOML.parse(readFileSync(join(REPO, "mise.lock"), "utf8")) as { tools: Record<string, Record<string, unknown>[]> }).tools.gitleaks!.find((e) => e.version === pinned)!;
  const linux = locked["platforms.linux-x64"] as { url: string; checksum: string };
  expect([linux.url, linux.checksum]).toEqual([pins.GITLEAKS_URL, `sha256:${pins.GITLEAKS_SHA256}`]);
  expect(pins.GITLEAKS_URL).toContain(`/v${pinned}/gitleaks_${pinned}_linux_x64.tar.gz`);
});

/** The gitleaks mise.toml pins, or undefined when mise can't say (the scan tests then skip, but never in CI). */
const gitleaks = (() => {
  const r = Bun.spawnSync(["mise", "which", "gitleaks"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  const path = r.stdout.toString().trim();
  return r.exitCode === 0 && path !== "" ? path : undefined;
})();
const inCI = (process.env.CI ?? "") !== "";
/** gitleaks's own findings line; `INF no leaks found` doesn't match. */
const FOUND = /WRN leaks found: [1-9]/;
/** The history scan as ci.yml ran it before Task 5's fix round 5 (H-241), in the job that had run the PR's code: the controls. */
const OLD_SCAN = `if [[ -e .gitleaksignore ]]; then
  echo "::error::.gitleaksignore would hide gitleaks findings. Remove it; the operator allows a false positive in .githooks/gitleaks.toml."
  exit 1
fi
mise exec -- gitleaks git --config .githooks/gitleaks.toml --ignore-gitleaks-allow --redact --no-banner --no-color -v .
`;

// In CI a missing gitleaks fails these tests instead of skipping them.
describe.skipIf(gitleaks === undefined && !inCI)("the secrets job, run as CI runs it, on a throwaway repo with this repo's .githooks/gitleaks.toml", () => {
  /** Each test builds and scans a few repos, about a second alone and more under the whole suite's load. */
  const SLOW = 30_000;
  /** A GitHub token shape, built at run time so no scan of this repo flags this file. */
  const token = () => {
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return `ghp_${[...randomBytes(36)].map((b) => alnum[b % alnum.length]).join("")}`;
  };
  const secret = (t: string) => `GITHUB_TOKEN=${t}\n`;
  type Write = (path: string, text: string) => void;
  type Git = (...args: string[]) => void;
  type Build = (write: Write, git: Git) => void;
  /**
   * A repo on `main` whose first commit holds this repo's .githooks/gitleaks.toml, then what `build` writes and
   * commits, and a RUNNER_TEMP with gitleaks linked in (the install is the network's).
   */
  const makeRepo = (build: Build) => {
    const root = mkdtempSync(join(tmpdir(), "hapi-ci-scan-"));
    const runnerTemp = mkdtempSync(join(tmpdir(), "hapi-ci-rt-"));
    temps.push(root, runnerTemp);
    mkdirSync(join(runnerTemp, "bin"));
    symlinkSync(gitleaks!, join(runnerTemp, "bin", "gitleaks"));
    const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    const git: Git = (...args) => {
      const r = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
      expect([args.join(" "), r.exitCode]).toEqual([args.join(" "), 0]);
    };
    const write: Write = (path, text) => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    git("init", "-q", "-b", "main");
    mkdirSync(join(root, ".githooks"));
    cpSync(join(REPO, ".githooks", "gitleaks.toml"), join(root, ".githooks", "gitleaks.toml"));
    git("add", "-A");
    git("commit", "-q", "-m", "the hooks' gitleaks config");
    build(write, git);
    return { root, runnerTemp };
  };
  /** The secrets job's steps after checkout, in order, but the install; or `script` alone, the control. */
  const scan = (build: Build, script?: string) => {
    const { root, runnerTemp } = makeRepo(build);
    const bin = mkdtempSync(join(tmpdir(), "hapi-ci-bin-"));
    temps.push(bin);
    // For the control: a mise that only runs `mise exec -- gitleaks …`, as mise-action's would.
    writeFileSync(join(bin, "mise"), `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -- ] && [ "$3" = gitleaks ] || exit 127\nshift 3\nexec "${gitleaks}" "$@"\n`);
    chmodSync(join(bin, "mise"), 0o755);
    const runner = { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp };
    const run = (sc: string) => {
      const r = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", sc], { cwd: root, env: runner, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    if (script !== undefined) return run(script);
    let last = { code: 0, out: "" };
    for (const s of secrets.steps.slice(1)) {
      if (s.name === INSTALL_GITLEAKS) continue;
      last = run(s.run!);
      if (last.code !== 0) return last;
    }
    return last;
  };
  const files =
    (f: Record<string, string>): Build =>
    (write, git) => {
      for (const [path, text] of Object.entries(f)) write(path, text);
      git("add", "-A");
      git("commit", "-q", "-m", "add files");
    };

  test("passes on a clean history with no ERR or WRN line, and finds a token", () => {
    const clean = scan(files({ "README.md": "# A project\n" }));
    expect(clean.code).toBe(0);
    expect(clean.out).not.toMatch(/(^|\s)(ERR|WRN)(\s|$)/m);
    const found = scan(files({ "config.env": secret(token()) }));
    expect(found.code).toBe(1);
    expect(found.out).toMatch(FOUND);
  }, SLOW);

  // Holes the old step left (H-241), one from each of the gates' fix rounds 2–4: each found now, and missed by the old step.
  const hiding: [what: string, build: (t: string) => Build][] = [
    ["a root .gitattributes with * -diff", (t) => files({ ".gitattributes": "* -diff\n", "config.env": secret(t) })],
    [
      "an evil merge",
      (t) => (write, git) => {
        git("checkout", "-q", "-b", "side");
        write("s", "side\n");
        git("add", "-A");
        git("commit", "-q", "-m", "side");
        git("checkout", "-q", "main");
        write("m", "main\n");
        git("add", "-A");
        git("commit", "-q", "-m", "main");
        git("merge", "-q", "--no-commit", "--no-ff", "side");
        write("config.env", secret(t));
        git("add", "-A");
        git("commit", "-q", "-m", "merge side");
      },
    ],
    [
      "a token moved out of node_modules/",
      (t) => (write, git) => {
        write("node_modules/pkg/index.js", `${"x\n".repeat(20)}${secret(t)}`);
        git("add", "-A");
        git("commit", "-q", "-m", "a dependency");
        git("mv", "node_modules/pkg", "src");
        git("commit", "-q", "-m", "move it");
      },
    ],
  ];
  for (const [what, build] of hiding) {
    test(`${what} doesn't hide a token, as it did from the old step`, () => {
      const r = scan(build(token()));
      expect([what, r.code]).toEqual([what, 1]);
      expect([what, r.out]).toEqual([what, expect.stringMatching(FOUND)]);
      expect([what, scan(build(token()), OLD_SCAN).code]).toEqual([what, 0]);
    }, SLOW);
  }

  test("an inline gitleaks:allow comment doesn't hide a token, and a root .gitleaks.toml or .gitleaksignore fails the scan before gitleaks runs", () => {
    expect(scan(files({ "config.env": `${secret(token()).trimEnd()} # gitleaks:allow\n` })).out).toMatch(FOUND);
    for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
      const r = scan(files({ [file]: "[allowlist]\npaths = ['''.*''']\n", "config.env": secret(token()) }));
      expect([file, r.code]).toEqual([file, 1]);
      expect(r.out).toContain("::error::a root .gitleaks.toml or .gitleaksignore would change what gitleaks finds");
    }
  }, SLOW);

  test("the config is the checkout's .githooks/gitleaks.toml, so a commit that edits it changes the scan: why .githooks/** is protected", () => {
    const r = scan(files({ ".githooks/gitleaks.toml": "[extend]\nuseDefault = true\n[allowlist]\npaths = ['''config\\.env''']\n", "config.env": secret(token()) }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("INF no leaks found");
  }, SLOW);
});
