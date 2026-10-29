/**
 * .github/workflows/ci.yml: where its checks sit among the steps, and three of
 * them run for real, as CI runs them (`bash -e`), on throwaway checkouts: the
 * mise-file scan, which needs only bash and find; the mise-config check with the
 * pinned mise, offline; and the history scan with the gitleaks mise.toml pins (a
 * stub `mise` on PATH runs it). Also: the root mise.lock CI installs from covers
 * every mise.toml pin, with a checksum.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

const REPO = resolve(import.meta.dir, "../..");
interface Step {
  name?: string;
  uses?: string;
  run?: string;
}
const steps: Step[] = YAML.parse(await Bun.file(join(REPO, ".github", "workflows", "ci.yml")).text()).jobs.ci.steps;
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

const SCAN = "Scan the whole history for secrets (gitleaks)";

test("the history scan uses .githooks/gitleaks.toml and ignores inline gitleaks:allow comments", () => {
  const run = steps.find((s) => s.name === SCAN)?.run ?? "";
  expect(run).toContain("gitleaks git --config .githooks/gitleaks.toml --ignore-gitleaks-allow ");
});

/** The gitleaks mise.toml pins, or undefined when mise can't say (the scan tests then skip). */
const gitleaks = (() => {
  const r = Bun.spawnSync(["mise", "which", "gitleaks"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  const path = r.stdout.toString().trim();
  return r.exitCode === 0 && path !== "" ? path : undefined;
})();

describe.skipIf(gitleaks === undefined)("the history scan, run on a throwaway repo", () => {
  const script = steps.find((s) => s.name === SCAN)?.run ?? "exit 99";
  /** A GitHub token shape, built at run time so no scan of this repo flags this file. */
  const token = () => {
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return `ghp_${[...randomBytes(36)].map((b) => alnum[b % alnum.length]).join("")}`;
  };
  /** A repo whose one commit holds `files`, checked out with .githooks/gitleaks.toml; the step's exit code and output. */
  const scan = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "hapi-ci-scan-"));
    const bin = mkdtempSync(join(tmpdir(), "hapi-ci-bin-"));
    temps.push(root, bin);
    writeFileSync(join(bin, "mise"), `#!/bin/sh\n[ "$1" = exec ] && [ "$2" = -- ] && [ "$3" = gitleaks ] || exit 127\nshift 3\nexec "${gitleaks}" "$@"\n`);
    chmodSync(join(bin, "mise"), 0o755);
    const gitConfig = join(bin, "gitconfig");
    writeFileSync(gitConfig, "");
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: bin,
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    cpSync(join(REPO, ".githooks", "gitleaks.toml"), join(root, ".githooks", "gitleaks.toml"));
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "add files"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    const r = Bun.spawnSync(["bash", "-e", "-c", script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("passes on a clean history, and finds a token", () => {
    expect(scan({ "README.md": "# A project\n" }).code).toBe(0);
    expect(scan({ "config.env": `GITHUB_TOKEN=${token()}\n` }).code).toBe(1);
  });

  test("an inline gitleaks:allow comment doesn't hide a token", () => {
    expect(scan({ "config.env": `GITHUB_TOKEN=${token()} # gitleaks:allow\n` }).code).toBe(1);
  });

  test("a .gitleaks.toml in the commit doesn't turn the scan off", () => {
    expect(scan({ ".gitleaks.toml": "[allowlist]\npaths = ['''.*''']\n", "config.env": `GITHUB_TOKEN=${token()}\n` }).code).toBe(1);
  });

  test("a .gitleaksignore, which gitleaks always reads and no flag turns off, fails the step, saying so", () => {
    const r = scan({ ".gitleaksignore": "config.env:generic-api-key:1\n", "README.md": "# A project\n" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(".gitleaksignore would hide gitleaks findings");
  });
});
