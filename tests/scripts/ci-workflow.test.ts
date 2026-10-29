/**
 * .github/workflows/ci.yml: where its checks sit among the steps, and the
 * mise-config check run for real, as CI runs it (`bash -e`), on throwaway
 * checkouts with the pinned mise, offline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
