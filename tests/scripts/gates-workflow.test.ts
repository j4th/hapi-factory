/**
 * .github/workflows/gates.yml, the reusable gates workflow every repo made from templates/repo-contract calls. Its
 * shape: a workflow_call with no permissions and three jobs, `scan`, `check` and the aggregator `gates`, whose check
 * (`ci / gates`) is the required one. `scan` never runs anything the PR controls: no mise, no action but checkout,
 * scanners installed from sha256-pinned release URLs and run by absolute path under `env -i` with the gates' own
 * config. Its steps run for real here, under `bash -e -o pipefail` as Actions runs them, on throwaway repos: the
 * config refusals, a checksum mismatch, the scanners' argv and environment (stubs), gitleaks itself (the pin
 * mise.toml holds), the trailer check, and the aggregator.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const ci: Step[] = YAML.parse(await Bun.file(join(REPO, ".github", "workflows", "ci.yml")).text()).jobs.ci.steps;
const MISE_SCAN = "Only the root mise.toml configures mise";
const MISE_CHECK = "mise loads no config or tasks but the root mise.toml";
const CONFIGS = "The scanners' configs are the gates' own";
const INSTALL = "Install the scanners, each checked against its pinned sha256";
const SECRETS = "Scan the whole history for secrets (gitleaks)";
const OSV = "Known vulnerabilities in bun.lock (OSV-Scanner)";
const ZIZMOR = "Workflow security (zizmor)";
const TRAILERS = "Factory commits carry their trailers";
const step = (job: Job, name: string) => job.steps.find((s) => s.name === name)!;
/** The clean environment every scanner, and the trailer check's git, runs in. */
const CLEAN = 'env -i PATH=/usr/bin:/bin HOME="$RUNNER_TEMP" GIT_NO_REPLACE_OBJECTS=1';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
/** Run one step's script as Actions does (`bash -e -o pipefail`), in `cwd`, with exactly `env`. */
const runStep = (script: string, cwd: string, env: Record<string, string>) => {
  const r = Bun.spawnSync(["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

test("gates.yml is a workflow_call with no permissions, and three jobs: scan, check and the aggregator gates", () => {
  expect(Object.keys(doc.on)).toEqual(["workflow_call"]);
  expect(doc.permissions).toEqual({});
  expect(Object.keys(doc.jobs)).toEqual(["scan", "check", "gates"]);
  for (const [id, job] of Object.entries(doc.jobs)) {
    expect([id, job.name, job["runs-on"]]).toEqual([id, id, "ubuntu-latest"]);
    expect([id, typeof job["timeout-minutes"]]).toEqual([id, "number"]);
  }
  expect(scan.permissions).toEqual({ contents: "read" });
  expect(check.permissions).toEqual({ contents: "read" });
  expect(scan.steps.map((s) => s.uses?.replace(/@.*$/, "") ?? s.name)).toEqual(["actions/checkout", MISE_SCAN, CONFIGS, INSTALL, SECRETS, OSV, ZIZMOR, TRAILERS]);
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

describe("the scan job never runs anything the PR controls", () => {
  test("no step in scan uses mise (the action, the binary or a task), and its only action is checkout", () => {
    for (const s of scan.steps) {
      if (s.uses !== undefined) expect(s.uses).toStartWith("actions/checkout@");
      expect([s.name, /(^|[\s;&|(])mise\s+(exec|run|install|x|use|trust|tasks|config|which|where|activate|env|ls)\b/m.test(s.run ?? "")]).toEqual([s.name, false]);
      expect([s.name, /\bmise-action\b/.test(s.uses ?? "")]).toEqual([s.name, false]);
    }
    // Nothing at the job level a PR could use either: the env holds only the pinned URLs and checksums.
    expect(Object.keys(scan.env ?? {}).sort()).toEqual(["GITLEAKS_SHA256", "GITLEAKS_URL", "OSV_SCANNER_SHA256", "OSV_SCANNER_URL", "ZIZMOR_SHA256", "ZIZMOR_URL"]);
  });

  test("every scanner runs by absolute path under env -i with GIT_NO_REPLACE_OBJECTS=1 and the gates' own config", () => {
    expect(step(scan, SECRETS).run).toContain(`${CLEAN} \\\n  "$RUNNER_TEMP/bin/gitleaks" git --config "$RUNNER_TEMP/gitleaks.toml" --ignore-gitleaks-allow --redact --no-banner --no-color -v .`);
    expect(step(scan, OSV).run).toContain(`${CLEAN} \\\n  "$RUNNER_TEMP/bin/osv-scanner" scan source --config "$RUNNER_TEMP/osv-scanner.toml" --lockfile bun.lock`);
    expect(step(scan, ZIZMOR).run).toContain(`${CLEAN} GH_TOKEN="$GH_TOKEN" \\\n  "$RUNNER_TEMP/bin/zizmor" --no-config --no-ignores --format=github .github/workflows`);
    // zizmor runs online (impostor-commit, ref-confusion) on the job's read-only token, passed by name.
    expect(step(scan, ZIZMOR).run).not.toContain("--offline");
    expect(step(scan, ZIZMOR).env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    // The trailer check's git is the absolute /usr/bin/git in the same clean environment, and every git call goes through it.
    const trailers = step(scan, TRAILERS).run!;
    expect(trailers).toContain(`git() { ${CLEAN} /usr/bin/git "$@"; }`);
    expect(trailers.split("\n").filter((l) => /(^|\$\()\s*git /.test(l.trim())).length).toBeGreaterThan(0);
    for (const s of [SECRETS, OSV, ZIZMOR]) expect([s, step(scan, s).run!.split(CLEAN).length - 1]).toEqual([s, 1]);
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

describe("the scanners' configs are the gates' own", () => {
  const configs = (files: Record<string, string>) => {
    const root = tempDir("hapi-gates-cfg-");
    const runnerTemp = tempDir("hapi-gates-rt-");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return { ...runStep(step(scan, CONFIGS).run!, root, { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp }), runnerTemp };
  };

  test("with neither gitleaks file, it writes gitleaks's default rules and an empty OSV-Scanner config", () => {
    const r = configs({ "README.md": "# x\n", "osv-scanner.toml": "[[IgnoredVulns]]\nid = \"GHSA-x\"\n", ".github/zizmor.yml": "rules: {}\n" });
    expect(r.code).toBe(0);
    expect(readFileSync(join(r.runnerTemp, "gitleaks.toml"), "utf8")).toBe("[extend]\nuseDefault = true\n");
    expect(readFileSync(join(r.runnerTemp, "osv-scanner.toml"), "utf8")).toBe("");
  });

  for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
    test(`a root ${file} fails the step, saying so`, () => {
      const r = configs({ [file]: "x\n" });
      expect(r.code).toBe(1);
      expect(r.out).toContain("::error::a root .gitleaks.toml or .gitleaksignore would change what gitleaks finds");
      expect(existsSync(join(r.runnerTemp, "gitleaks.toml"))).toBe(false);
    });
  }
});

test("the install fails closed: a download that doesn't match its pinned sha256 is never unpacked or installed", () => {
  const runnerTemp = tempDir("hapi-gates-install-");
  const bin = tempDir("hapi-gates-fakebin-");
  // A curl that "downloads" bytes that aren't the release: the -o file gets them.
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { printf "not the release" > "$2"; exit 0; }; shift; done\nexit 1\n');
  chmodSync(join(bin, "curl"), 0o755);
  const r = runStep(step(scan, INSTALL).run!, tempDir("hapi-gates-cwd-"), { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, ...scan.env! });
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("FAILED");
  expect(readdirSync(join(runnerTemp, "bin"))).toEqual([]);
});

describe("each scanner gets exactly its flags and a clean environment", () => {
  /** Stub scanners that record their argv and the environment they were started with (/proc/<pid>/environ). */
  const stubs = () => {
    const runnerTemp = tempDir("hapi-gates-stub-");
    mkdirSync(join(runnerTemp, "bin"));
    for (const tool of ["gitleaks", "osv-scanner", "zizmor"]) {
      writeFileSync(join(runnerTemp, "bin", tool), `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/${tool}.argv"\ntr '\\0' '\\n' < /proc/$$/environ | sort > "$HOME/${tool}.env"\n`);
      chmodSync(join(runnerTemp, "bin", tool), 0o755);
    }
    return runnerTemp;
  };
  // What a PR could try to set, or what a runner might carry: none of it may reach a scanner.
  const polluted = { GITLEAKS_CONFIG: "/tmp/x.toml", GITLEAKS_CONFIG_TOML: "[allowlist]\npaths = ['''.*''']", ZIZMOR_CONFIG: "/tmp/z.yml", OSV_SCANNER_CONFIG: "/tmp/o.toml", GIT_DIR: "/tmp/elsewhere" };
  const cases = [
    [SECRETS, "gitleaks", ["git", "--config", "RT/gitleaks.toml", "--ignore-gitleaks-allow", "--redact", "--no-banner", "--no-color", "-v", "."], []],
    [OSV, "osv-scanner", ["scan", "source", "--config", "RT/osv-scanner.toml", "--lockfile", "bun.lock"], []],
    [ZIZMOR, "zizmor", ["--no-config", "--no-ignores", "--format=github", ".github/workflows"], ["GH_TOKEN=fake-actions-token"]],
  ] as const;
  for (const [name, tool, argv, extra] of cases) {
    test(`${tool}: ${argv.join(" ")}`, () => {
      const runnerTemp = stubs();
      const r = runStep(step(scan, name).run!, tempDir("hapi-gates-co-"), { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp, GH_TOKEN: "fake-actions-token", ...polluted });
      expect(r.code).toBe(0);
      expect(readFileSync(join(runnerTemp, `${tool}.argv`), "utf8").trim().split("\n")).toEqual(argv.map((a) => a.replace("RT/", `${runnerTemp}/`)));
      expect(readFileSync(join(runnerTemp, `${tool}.env`), "utf8").trim().split("\n")).toEqual(
        ["GIT_NO_REPLACE_OBJECTS=1", ...extra, `HOME=${runnerTemp}`, "PATH=/usr/bin:/bin"].sort(),
      );
    });
  }
});

/** The gitleaks mise.toml pins, or undefined when mise can't say (the real-scan tests then skip). */
const gitleaks = (() => {
  const r = Bun.spawnSync(["mise", "which", "gitleaks"], { cwd: REPO, stdout: "pipe", stderr: "ignore" });
  const path = r.stdout.toString().trim();
  return r.exitCode === 0 && path !== "" ? path : undefined;
})();

describe.skipIf(gitleaks === undefined)("the real gitleaks, run as the scan job runs it, on a throwaway repo", () => {
  /** A GitHub token shape, built at run time so no scan of this repo flags this file. */
  const token = () => {
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    return `ghp_${[...randomBytes(36)].map((b) => alnum[b % alnum.length]).join("")}`;
  };
  /** A repo whose one commit holds `files`; the configs step then the secrets step, with `env` added to the runner's. */
  const scanRepo = (files: Record<string, string>, env: Record<string, string> = {}) => {
    const root = tempDir("hapi-gates-gl-");
    const runnerTemp = tempDir("hapi-gates-glrt-");
    mkdirSync(join(runnerTemp, "bin"));
    symlinkSync(gitleaks!, join(runnerTemp, "bin", "gitleaks"));
    const genv = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
    for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "add files"]]) {
      expect(Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, env: genv, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    const runner = { PATH: process.env.PATH!, RUNNER_TEMP: runnerTemp, ...env };
    const c = runStep(step(scan, CONFIGS).run!, root, runner);
    if (c.code !== 0) return c;
    return runStep(step(scan, SECRETS).run!, root, runner);
  };

  test("passes on a clean history, and finds a token", () => {
    expect(scanRepo({ "README.md": "# A project\n" }).code).toBe(0);
    expect(scanRepo({ "config.env": `GITHUB_TOKEN=${token()}\n` }).code).toBe(1);
  });

  test("an inline gitleaks:allow comment doesn't hide a token", () => {
    expect(scanRepo({ "config.env": `GITHUB_TOKEN=${token()} # gitleaks:allow\n` }).code).toBe(1);
  });

  test("a config in the runner's environment never reaches gitleaks (env -i): GITLEAKS_CONFIG_TOML allowlisting everything changes nothing", () => {
    const allowAll = "[extend]\nuseDefault = true\n[allowlist]\npaths = ['''.*''']\n";
    const dir = tempDir("hapi-gates-glcfg-");
    writeFileSync(join(dir, "allow.toml"), allowAll);
    const r = scanRepo({ "config.env": `GITHUB_TOKEN=${token()}\n` }, { GITLEAKS_CONFIG_TOML: allowAll, GITLEAKS_CONFIG: join(dir, "allow.toml") });
    expect(r.code).toBe(1);
  });

  test("a .gitleaks.toml or .gitleaksignore in the commit fails the scan before gitleaks runs", () => {
    for (const file of [".gitleaks.toml", ".gitleaksignore"]) {
      const r = scanRepo({ [file]: "[allowlist]\npaths = ['''.*''']\n", "config.env": `GITHUB_TOKEN=${token()}\n` });
      expect([file, r.code]).toEqual([file, 1]);
      expect(r.out).toContain("would change what gitleaks finds");
    }
  });
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
