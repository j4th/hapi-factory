/**
 * .github/workflows/ci.yml: where its checks sit among the steps, and two of
 * them run for real, as CI runs them (`bash -e`), on throwaway checkouts: the
 * mise-config check with the pinned mise, offline, and the history scan with the
 * gitleaks mise.toml pins (a stub `mise` on PATH runs it).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const MISE_CHECK = "Only the root mise.toml configures mise";
const at = (pred: (s: Step) => boolean) => steps.findIndex(pred);

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

test("the mise-config check runs once mise is installed, before any step that installs tools or runs a task", () => {
  const check = at((s) => s.name === MISE_CHECK);
  expect(check).toBeGreaterThan(at((s) => s.uses?.startsWith("jdx/mise-action@") === true));
  const first = at((s) => /\bmise (install|run)\b/.test(s.run ?? ""));
  expect(first).toBeGreaterThan(check);
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
