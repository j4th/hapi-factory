/**
 * .github/workflows/gates.yml, the reusable gates workflow every repo made from templates/repo-contract calls: its
 * shape (a workflow_call with no permissions, one `gates` job, SHA-pinned actions), its two mise steps (ci.yml's,
 * word for word), its secret scan's refusal of a root .gitleaks.toml or .gitleaksignore, and the trailer check,
 * run for real under `bash -e` on throwaway repos, as Actions runs it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const TEXT = await Bun.file(join(REPO, ".github", "workflows", "gates.yml")).text();
const doc = YAML.parse(TEXT);
const steps: Step[] = doc.jobs.gates.steps;
const ci: Step[] = YAML.parse(await Bun.file(join(REPO, ".github", "workflows", "ci.yml")).text()).jobs.ci.steps;
const MISE_SCAN = "Only the root mise.toml configures mise";
const MISE_CHECK = "mise loads no config or tasks but the root mise.toml";
const SECRETS = "Scan the whole history for secrets (gitleaks)";
const TRAILERS = "Factory commits carry their trailers";
const step = (name: string) => steps.find((s) => s.name === name)!;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};

test("gates.yml is a workflow_call with no permissions, one gates job and SHA-pinned actions", () => {
  expect(Object.keys(doc.on)).toEqual(["workflow_call"]);
  expect(doc.permissions).toEqual({});
  expect(Object.keys(doc.jobs)).toEqual(["gates"]);
  const job = doc.jobs.gates;
  expect(job.name).toBe("gates");
  expect(job.permissions).toEqual({ contents: "read" });
  expect(job["runs-on"]).toBe("ubuntu-latest");
  expect(job["timeout-minutes"]).toBe(15);
  expect(steps.map((s) => s.uses?.replace(/@.*$/, "") ?? s.name)).toEqual([
    "actions/checkout",
    MISE_SCAN,
    "jdx/mise-action",
    MISE_CHECK,
    "check",
    SECRETS,
    "Known vulnerabilities in bun.lock (OSV-Scanner)",
    "Workflow security (zizmor)",
    TRAILERS,
  ]);
  expect(steps[0]!.with).toEqual({ "persist-credentials": false, "fetch-depth": 0 });
  expect(steps[2]!.with).toEqual({ version: "2026.10.9" });
  // The pins as written, with their tag comments (YAML drops comments, so read the text).
  const uses = [...TEXT.matchAll(/^\s*- uses: (\S+)(.*)$/gm)];
  expect(uses.length).toBe(2);
  for (const [, ref, comment] of uses) expect([ref, comment]).toEqual([expect.stringMatching(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/), expect.stringMatching(/^ # v\d/)]);
  expect(uses.map((m) => m[1])).toEqual(ci.filter((s) => s.uses !== undefined).map((s) => s.uses));
  expect(aiWorkflowProblems(".github/workflows/gates.yml", TEXT)).toEqual([]);
  expect(step("check").run).toBe("mise install --locked && mise run check");
  expect(step("Known vulnerabilities in bun.lock (OSV-Scanner)").run).toBe("mise exec -- osv-scanner scan source --lockfile bun.lock");
  expect(step("Workflow security (zizmor)").run).toBe("mise exec -- zizmor --offline --format=github .github/workflows");
  // No step installs packages itself: setup is the caller's own `bun ci --frozen-lockfile --ignore-scripts`.
  for (const s of steps) expect([s.name, /\b(bun|npm|pnpm|yarn) (install|i|add|ci)\b|bunx|npx/.test(s.run ?? "")]).toEqual([s.name, false]);
});

test("its mise-file scan is ci.yml's, word for word", () => {
  for (const name of [MISE_SCAN, MISE_CHECK]) {
    const theirs = ci.find((s) => s.name === name)?.run;
    expect(theirs).toBeDefined();
    expect([name, step(name).run]).toEqual([name, theirs]);
  }
});

describe("the secret scan refuses a root .gitleaks.toml or .gitleaksignore before gitleaks runs", () => {
  /** A checkout with `files` and a stub mise that records it ran; the step's exit code and output. */
  const scan = (files: Record<string, string>) => {
    const root = tempDir("hapi-gates-scan-");
    const bin = tempDir("hapi-gates-bin-");
    writeFileSync(join(bin, "mise"), `#!/bin/sh\necho "mise $*"\n`);
    chmodSync(join(bin, "mise"), 0o755);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    const r = Bun.spawnSync(["bash", "-e", "-c", step(SECRETS).run!], { cwd: root, env: { PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("with neither, gitleaks runs with its own rules and inline allows ignored", () => {
    const r = scan({ "README.md": "# x\n" });
    expect(r).toEqual({ code: 0, out: "mise exec -- gitleaks git --ignore-gitleaks-allow --redact --no-banner --no-color -v .\n" });
  });

  for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
    test(`${file} fails the step, saying so, and gitleaks never runs`, () => {
      const r = scan({ [file]: "x\n" });
      expect(r.code).toBe(1);
      expect(r.out).toContain("::error::a root .gitleaks.toml or .gitleaksignore would change what gitleaks finds");
      expect(r.out).not.toContain("mise exec");
    });
  }
});

describe("with real git: the trailer step passes factory commits with all six trailers and fails one without Model", () => {
  const s = step(TRAILERS);

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
    const r = Bun.spawnSync(["bash", "-e", "-c", s.run!], { cwd: root, env: { ...env, HEAD_REF: headRef, BASE_SHA: base, HEAD_SHA: shas.at(-1) ?? base }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), shas };
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
