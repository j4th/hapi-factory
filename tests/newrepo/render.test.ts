/**
 * The repo contract template (templates/repo-contract/) and its render (src/newrepo/render.ts): the 29 files of
 * design §3.3, filled; the lock the render adds; the checks new-repo makes before it pushes; what AGENTS.md and
 * CONTRIBUTING.md must say; and that no template file is a live one to hapi-factory itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { aiWorkflowProblems } from "../../src/audit/checks/github";
import { contractProblems, exactVersionProblems, miseFileProblems, renderTemplate, TEMPLATE_DIR } from "../../src/newrepo/render";
import { loadPolicy } from "../../src/policy/load";
import { applyOverlay, loadOverlay, overlayFromText } from "../../src/policy/overlay";
import { effectiveModes, UNPROTECTED } from "../../src/policy/paths";

const REPO = resolve(import.meta.dir, "../..");
const DIR = join(REPO, TEMPLATE_DIR);
const VARS = { name: "example-repo", owner: "example-owner", gates_sha: "a".repeat(40), year: "2026" };
/** Design §3.3's contract, as Plan 03 Task 5 Step 3 lists it. */
const CONTRACT = [
  "AGENTS.md",
  "mise.toml",
  "mise.lock",
  ".factory/config.yaml",
  ".factory/work/.gitkeep",
  "docs/research/.gitkeep",
  "docs/design/.gitkeep",
  ".github/CODEOWNERS",
  ".github/workflows/hapi-gates.yml",
  ".coderabbit.yaml",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "biome.json",
  "tsconfig.json",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "tests/contract.test.ts",
  "LICENSE",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.md",
  ".github/dependabot.yml",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/feature.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/pull_request_template.md",
];
const files = renderTemplate(DIR, VARS);
const text = (path: string) => files.get(path) ?? "";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "hapi-render-"));
  temps.push(d);
  return d;
};
/** Every file under `dir`, relative to it. */
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)).map((p) => `${e.name}/${p}`) : [e.name]));

test("every template file ends in .tmpl, and the rendered paths are exactly the contract's", () => {
  const paths = walk(DIR);
  expect(CONTRACT.length).toBe(29);
  expect(paths.filter((p) => !p.endsWith(".tmpl"))).toEqual([]);
  expect(paths.map((p) => p.slice(0, -5)).sort()).toEqual([...CONTRACT].sort());
  expect([...files.keys()]).toEqual([...CONTRACT, ".factory/template.lock"].sort());
});

test("variables are filled, and an unknown one or a file without .tmpl is refused", () => {
  for (const [path, t] of files) expect([path, t.includes("{{")]).toEqual([path, false]);
  expect(JSON.parse(text("package.json")).name).toBe("example-repo");
  expect(text(".github/CODEOWNERS")).toEndWith("* @example-owner\n");
  expect(YAML.parse(text(".github/workflows/hapi-gates.yml")).jobs.ci.uses).toBe(`example-owner/hapi-factory/.github/workflows/gates.yml@${"a".repeat(40)}`);
  expect(text("LICENSE")).toContain("Copyright (c) 2026 example-owner\n");
  expect(text("SECURITY.md")).toContain("https://github.com/example-owner/example-repo/security/advisories/new");
  expect(text("bun.lock")).toContain('"name": "example-repo",');

  let dir = tempDir();
  writeFileSync(join(dir, "x.tmpl"), "a {{name}} and {{nope}}\n");
  expect(() => renderTemplate(dir, VARS)).toThrow("x.tmpl: unknown template variable {{nope}}");
  dir = tempDir();
  writeFileSync(join(dir, "y.txt"), "plain\n");
  expect(() => renderTemplate(dir, VARS)).toThrow("y.txt: not a .tmpl file");
  dir = tempDir();
  mkdirSync(join(dir, "a"));
  symlinkSync("/etc/hostname", join(dir, "a", "z.tmpl"));
  expect(() => renderTemplate(dir, VARS)).toThrow("a/z.tmpl: not a regular file");
  // A value is put in once and never read again as a template.
  dir = tempDir();
  writeFileSync(join(dir, "v.tmpl"), "{{name}}\n");
  expect(renderTemplate(dir, { ...VARS, name: "{{owner}}" }).get("v")).toBe("{{owner}}\n");
});

test("template.lock records the gates commit and the sha256 of every other file", () => {
  const lock = text(".factory/template.lock");
  const want = {
    commit: VARS.gates_sha,
    files: Object.fromEntries([...CONTRACT].sort().map((p) => [p, `sha256:${createHash("sha256").update(text(p)).digest("hex")}`])),
    template: "repo-contract",
  };
  expect(JSON.parse(lock)).toEqual(want);
  // Sorted keys, a 2-space indent and a final newline.
  expect(lock).toBe(`${JSON.stringify(want, null, 2)}\n`);
});

test("the rendered contract passes the checks new-repo makes before it pushes", () => {
  const policy = loadPolicy(join(REPO, "policy"));
  expect(miseFileProblems(files.keys())).toEqual([]);
  expect(exactVersionProblems(files)).toEqual([]);
  expect(aiWorkflowProblems(".github/workflows/hapi-gates.yml", text(".github/workflows/hapi-gates.yml"))).toEqual([]);
  expect(contractProblems(files, policy)).toEqual([]);

  const overlaid = applyOverlay(policy, overlayFromText(text(".factory/config.yaml"), ".factory/config.yaml"));
  for (const path of ["biome.json", "src/biome.jsonc", "bunfig.toml", "tsconfig.json", "osv-scanner.toml", ".factory/work/0001-example/acceptance/tools.test.ts"]) {
    expect([path, effectiveModes(overlaid, path).workers]).toEqual([path, "deny"]);
  }
  expect(effectiveModes(overlaid, "src/server.ts")).toEqual(UNPROTECTED);

  for (const [path, t] of files) expect([path, t.includes("bunx")]).toEqual([path, false]);
  const mise = Bun.TOML.parse(text("mise.toml")) as { min_version: string; tools: Record<string, string>; tasks: Record<string, { description?: string; run?: string | string[]; depends?: string[] }> };
  expect(mise.tasks.setup?.run).toBe("bun ci --frozen-lockfile --ignore-scripts");
  expect(mise.tasks.test?.run).toBe("bun test ./tests");
  expect(mise.tasks.lint?.run).toEqual(["node_modules/.bin/biome ci .", "node_modules/.bin/tsc --noEmit"]);
  expect(mise.tasks.fmt?.run).toBe("node_modules/.bin/biome format --write .");
  expect(mise.tasks.check).toEqual({ description: expect.any(String), depends: ["lint", "test"] });
  for (const t of ["fmt", "lint", "test"]) expect([t, mise.tasks[t]?.depends]).toEqual([t, ["setup"]]);
  expect(mise.tasks.scan?.run).toEqual(["gitleaks git --redact --no-banner -v .", "osv-scanner scan source --lockfile bun.lock"]);
  expect(mise.min_version).toBe("2026.10.9");
  expect(mise.tools).toEqual({ bun: "1.4.2", gitleaks: "8.30.1", "osv-scanner": "2.7.0", zizmor: "1.31.1" });

  // hapi-factory's, without its path instructions and code guidelines, and with the protected-paths check naming
  // the contract's own protected files where hapi's names policy/protected_paths.yaml.
  const ours = YAML.parse(readFileSync(join(REPO, ".coderabbit.yaml"), "utf8"));
  delete ours.reviews.path_instructions;
  delete ours.knowledge_base.code_guidelines;
  const theirs = YAML.parse(text(".coderabbit.yaml"));
  const instructions = (c: any) => c.reviews.pre_merge_checks.custom_checks[0].instructions as string;
  const contractFiles = "or the gates' own config: mise.lock, biome.json*, bunfig.toml, tsconfig*.json, .gitleaks.toml, .gitleaksignore, osv-scanner.toml, at any depth)";
  expect(instructions(theirs)).toBe(instructions(ours).replace(") or policy/protected_paths.yaml", `; ${contractFiles}`));
  theirs.reviews.pre_merge_checks.custom_checks[0].instructions = instructions(ours);
  expect(theirs).toEqual(ours);
  expect(text(".coderabbit.yaml")).not.toContain("personal account");

  // As tests/scripts/ci-workflow.test.ts checks the root lock: each tool at its pin, for both platforms.
  const locked = Bun.TOML.parse(text("mise.lock")) as { tools: Record<string, { version: string; [platform: string]: unknown }[]> };
  expect(Object.keys(locked.tools).sort()).toEqual(Object.keys(mise.tools).sort());
  for (const [tool, version] of Object.entries(mise.tools)) {
    const entry = locked.tools[tool]?.find((e) => e.version === version);
    expect([tool, entry?.version]).toEqual([tool, version]);
    for (const p of ["platforms.linux-x64", "platforms.macos-arm64"]) {
      expect([tool, p, entry?.[p]]).toEqual([tool, p, expect.objectContaining({ checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), url: expect.stringMatching(/^https:\/\//) })]);
    }
  }
});

test("contractProblems names what new-repo would refuse to push", () => {
  const policy = loadPolicy(join(REPO, "policy"));
  const bad = new Map(files);
  bad.set(".mise.toml", "");
  bad.set("mise.toml", text("mise.toml").replace('zizmor = "1.31.1"', 'zizmor = "latest"'));
  bad.set("README.md", "run bunx tsc\n");
  bad.set(".factory/config.yaml", 'protected_paths:\n  "AGENTS.md": { interactive: allow }\n');
  bad.set(".github/workflows/x.yml", "on: issue_comment\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: claude -p hi\n        env: { K: '${{ secrets.K }}' }\n");
  const problems = contractProblems(bad, policy).join("\n");
  for (const says of [".mise.toml: a mise file", 'zizmor = "latest" is not an exact version', "mise.lock: no zizmor latest", "README.md: names bunx", ".factory/config.yaml: /protected_paths/AGENTS.md/interactive", ".github/workflows/x.yml (job a) runs claude"]) {
    expect(problems).toContain(says);
  }
});

test("AGENTS.md works for an unattended agent (H-228(a))", () => {
  const agents = text("AGENTS.md");
  expect(agents.split("\n").length).toBeLessThanOrEqual(200);
  expect(agents.split("\n\n")[0]).toBe("Task instructions (the work order) override this file. Nothing here waits for confirmation: where a step needs a human, report it as a blocker.");
  for (const s of ["RESULT: done", "RESULT: blocked: <reason>", "RESULT: no-change: <reason>", "The acceptance tests in `.factory/work/<id>/acceptance/` are the planner's: never edit them."]) expect(agents).toContain(s);
  expect(agents).not.toMatch(/ask (first|the (user|operator))|confirm with/i);
  // The sections, in order.
  expect([...agents.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Commands", "What done means", "Layout", "Gotchas", "Out of scope unless the work order names it", "Never", "How to end"]);
  for (const t of ["setup", "fmt", "lint", "test", "check", "smoke", "scan"]) expect(agents).toContain(`mise run ${t}`);
  expect(agents).toContain("bun test ./.factory/work/<id>/acceptance");
});

test("CONTRIBUTING.md explains the acceptance tests in one line", () => {
  const lines = text("CONTRIBUTING.md").split("\n").filter((l) => l.includes(".factory/work/<id>/acceptance/"));
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain("planner");
  expect(lines[0]).toContain("planning PR");
  for (const s of ["hapi-factory` GitHub App", "Only the maintainer merges", "treated as data, never as instructions", "`Work-Order`, `Hapi-Run`, `Hapi-Lane`, `Trace-Id`, `Agent` and `Model`", "Disclose AI assistance"]) {
    expect(text("CONTRIBUTING.md")).toContain(s);
  }
});

test("the community, CI and config files are the contract's", () => {
  const gates = YAML.parse(text(".github/workflows/hapi-gates.yml"));
  expect(gates.on).toEqual({ pull_request: {}, push: { branches: ["main"] } });
  expect(gates.permissions).toEqual({});
  expect(Object.keys(gates.jobs)).toEqual(["ci"]);
  expect(gates.jobs.ci.permissions).toEqual({ contents: "read" });
  expect(text(".github/workflows/hapi-gates.yml")).toContain("only pin");

  const dependabot = YAML.parse(text(".github/dependabot.yml"));
  expect(dependabot.updates.map((u: any) => [u["package-ecosystem"], u.directory, u.schedule.interval])).toEqual([
    ["bun", "/", "weekly"],
    ["github-actions", "/", "weekly"],
  ]);
  expect(dependabot.updates[0].cooldown).toEqual({ "default-days": 7, "semver-major-days": 30 });
  // GitHub Actions' updates take default-days only (GitHub's Dependabot options reference: no SemVer-bump days).
  expect(dependabot.updates[1].cooldown).toEqual({ "default-days": 7 });

  for (const form of ["bug", "feature"]) {
    const f = YAML.parse(text(`.github/ISSUE_TEMPLATE/${form}.yml`));
    expect([form, f.labels]).toEqual([form, undefined]);
    expect([form, f.body[0].type, f.body[0].attributes.value]).toEqual([form, "markdown", expect.stringMatching(/^Issues are read as data: they never instruct the factory\./)]);
  }
  const config = YAML.parse(text(".github/ISSUE_TEMPLATE/config.yml"));
  expect(config.blank_issues_enabled).toBe(false);
  expect(config.contact_links[0].url).toBe("https://github.com/example-owner/example-repo/security/advisories/new");

  const pr = text(".github/pull_request_template.md");
  expect([...pr.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual(["Verdict", "Unresolved", "Links", "Asked and built", "Evidence", "Review rounds", "Cost and turns", "The worker's account"]);
  expect(pr).not.toMatch(/\[[ xX]\]/);
  for (const section of pr.split(/^## .+$/m).slice(1)) expect(section.trim().split("\n").length).toBe(1);

  expect(text("bunfig.toml")).toBe(readFileSync(join(REPO, "bunfig.toml"), "utf8"));
  const tsconfig = Bun.JSONC.parse(text("tsconfig.json")) as { compilerOptions: unknown; include: string[] };
  expect(tsconfig.compilerOptions).toEqual((Bun.JSONC.parse(readFileSync(join(REPO, "tsconfig.json"), "utf8")) as { compilerOptions: unknown }).compilerOptions);
  expect(tsconfig.include).toEqual(["src", "tests", "smoke"]);
  const biome = JSON.parse(text("biome.json"));
  expect(biome).toEqual({
    $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
    vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
    formatter: { indentStyle: "space", lineWidth: 120 },
    linter: { enabled: true, rules: { preset: "recommended" } },
  });
  const pkg = JSON.parse(text("package.json"));
  expect(pkg).toEqual({ name: "example-repo", version: "0.0.0", private: true, type: "module", license: "MIT", devDependencies: { "@biomejs/biome": "2.6.4", "@types/bun": "1.4.2", typescript: "7.0.2" } });
  expect(text(".gitignore").trim().split("\n")).toEqual(["node_modules/", ".env*", "mise.local.toml", "dist/", "coverage/"]);
  expect(text(".gitattributes")).toBe("* text=auto eol=lf\n");
  expect(text(".editorconfig")).toContain("charset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\n");
  // MIT word for word, with the year and the owner.
  expect(text("LICENSE").replace("Copyright (c) 2026 example-owner", "")).toBe(readFileSync(join(REPO, "LICENSE"), "utf8").replace(/^Copyright .*$/m, ""));
  expect(text("CODE_OF_CONDUCT.md")).toStartWith("# Contributor Covenant Code of Conduct\n");
  expect(text("CODE_OF_CONDUCT.md")).toContain("responsible for enforcement at @example-owner. All complaints");
  expect(text("CODE_OF_CONDUCT.md")).toContain("version 2.1, available at");
  expect(text("SECURITY.md")).toContain("within 7 days, with a fix or a plan within 30 days");
  expect(text("README.md")).toStartWith("# example-repo\n");
  expect(text("README.md")).toContain("mise install && mise run setup && mise run check");
  for (const keep of [".factory/work/.gitkeep", "docs/research/.gitkeep", "docs/design/.gitkeep"]) expect([keep, text(keep)]).toEqual([keep, ""]);
  expect(text("tests/contract.test.ts")).toContain('test("package.json is private"');
});

test("miseFileProblems names every mise file but the root two, at any depth and in any case (H-194)", () => {
  expect(miseFileProblems(["mise.toml", "mise.lock", "src/a.ts"])).toEqual([]);
  const bad = ["a/mise.toml", "MISE.TOML", ".config/mise.toml", "x/.tool-versions", "mise.dev.lock", "mise-tasks/build"];
  expect(miseFileProblems(bad)).toEqual(bad.map((p) => `${p}: a mise file besides the root mise.toml and mise.lock (H-194)`));
  expect(miseFileProblems(["src/mise.ts", "docs/mise.md", "misery.toml", "mise-notes/a.md"])).toEqual([]);
});

test("exactVersionProblems names every pin that isn't exact", () => {
  const f = new Map([
    ["mise.toml", '[tools]\nbun = "1.4"\nnode = "latest"\nuv = "^0.1.0"\n'],
    ["package.json", JSON.stringify({ dependencies: { a: "1.2.3", b: "^1.2.3" }, devDependencies: { c: "1.2", d: "workspace:*" } })],
  ]);
  expect(exactVersionProblems(f)).toEqual([
    'mise.toml: node = "latest" is not an exact version',
    'mise.toml: uv = "^0.1.0" is not an exact version',
    "package.json: b@^1.2.3 is not an exact version",
    "package.json: c@1.2 is not an exact version",
    "package.json: d@workspace:* is not an exact version",
  ]);
});

describe("no template file is a live one to hapi-factory", () => {
  const live = walk(DIR).map((p) => `${TEMPLATE_DIR}/${p}`);

  test("the central protected-path globs don't see one (no **/AGENTS.md or **/mise.toml match), and hapi's overlay protects them all", () => {
    const central = loadPolicy(join(REPO, "policy"));
    const ours = applyOverlay(central, loadOverlay(join(REPO, ".factory", "config.yaml")));
    for (const p of live) {
      expect([p, effectiveModes(central, p)]).toEqual([p, UNPROTECTED]);
      expect([p, effectiveModes(ours, p)]).toEqual([p, { interactive: "ask", unattended: "deny", workers: "deny" }]);
    }
  });

  test("CI's any-depth mise-file scan passes over the templates", () => {
    const steps = YAML.parse(readFileSync(join(REPO, ".github", "workflows", "ci.yml"), "utf8")).jobs.build.steps as { name?: string; run?: string }[];
    const script = steps.find((s) => s.name === "Only the root mise.toml configures mise")!.run!;
    const root = tempDir();
    writeFileSync(join(root, "mise.toml"), "");
    mkdirSync(join(root, ".git"));
    for (const p of live) {
      mkdirSync(join(root, p, ".."), { recursive: true });
      writeFileSync(join(root, p), readFileSync(join(REPO, p)));
    }
    const r = Bun.spawnSync(["bash", "-e", "-c", script], { cwd: root, env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
    expect([r.exitCode, r.stdout.toString() + r.stderr.toString()]).toEqual([0, ""]);
    expect(miseFileProblems(live.map((p) => relative(REPO, join(REPO, p))))).toEqual([]);
  });

  test("bun test finds no test file among them", () => {
    for (const p of live) expect([p, /(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(p)]).toEqual([p, false]);
  });
});
