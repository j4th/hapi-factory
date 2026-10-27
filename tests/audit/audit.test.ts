/**
 * `runAudit` and `hapi audit` (src/audit/), end to end over a world of fakes
 * (./helpers.ts): no Docker, network or secret. The first four tests are the
 * plan's (Task 6 Step 1); the rest hold the command's contract: one line per
 * check, a summary, exit 1 on any fail and 2 on a usage error, `--strict`
 * turning a skip into a fail, and a check that throws failing closed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditCommand, CHECK_IDS, runAudit } from "../../src/audit/index";
import { main } from "../../src/cli";
import { capture, cleanup, cleanWorld, FIXTURES, only } from "./helpers";

afterEach(cleanup);

test("audit detects drift from generated config", async () => {
  const w = await cleanWorld();
  const file = join(w.build, "hermes", "config.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("mode: manual", "mode: off"));
  const results = await runAudit(w.ctx);
  const drift = only(results, "generated.drift");
  expect(drift.status).toBe("fail");
  expect(drift.detail).toContain("hermes/config.yaml");
  expect(drift.detail).toContain("approvals.mode");
  // The running Hermes reads the same file, so the yolo check names it too.
  expect(only(results, "runtime.hermes-no-yolo").status).toBe("fail");
});

test("audit fails on archon parseWarnings", async () => {
  const w = await cleanWorld();
  w.archonValidate = { code: 0, out: { errors: [], parseWarnings: ["unknown key foo"] } };
  const r = only(await runAudit(w.ctx), "tools.archon-validate");
  expect(r.status).toBe("fail");
  expect(r.detail).toContain("unknown key foo");
});

test("audit flags comment-triggered AI workflow", async () => {
  const w = await cleanWorld({ repos: true, workflows: { "claude.yml": readFileSync(join(FIXTURES, "workflows", "claude.yml"), "utf8") } });
  const tokenFile = join(w.ctx.env.HOME!, "gh.token");
  writeFileSync(tokenFile, "fake-operator-token\n", { mode: 0o600 });
  w.ctx.githubTokenFile = tokenFile;
  const r = only(await runAudit(w.ctx), "repo.ai-workflows");
  expect(r.status).toBe("fail");
  expect(r.detail).toContain("example-owner/hapi-factory");
  expect(r.detail).toContain(".github/workflows/claude.yml");
  expect(r.detail).toContain("anthropics/claude-code-action");
  expect(r.detail).toContain("issue_comment");
});

test("audit passes a clean fixture", async () => {
  const w = await cleanWorld();
  const results = await runAudit(w.ctx);
  expect(results.map((r) => r.id).sort()).toEqual([...CHECK_IDS].sort());
  for (const r of results) expect([r.id, r.status, r.detail]).toEqual([r.id, r.status === "skip" ? "skip" : "pass", r.detail]);
  // What can be checked without a repo or a secrets store passes.
  for (const id of ["generated.drift", "runtime.archon-env", "runtime.hermes-no-yolo", "runtime.dev-override", "pins.versions", "tools.archon-validate", "tools.hermes-validate", "mcp.tool-hashes"]) {
    expect([id, only(results, id).status]).toEqual([id, "pass"]);
  }
  for (const id of ["github.rulesets", "github.app-perms", "repo.ai-workflows"]) {
    expect([id, only(results, id).status, only(results, id).detail]).toEqual([id, "skip", "no --repo given"]);
  }
});

describe("hapi audit", () => {
  test("prints one line per check and a summary; exit 0 with no fail", async () => {
    const w = await cleanWorld();
    const { out } = capture();
    expect(await auditCommand([], w.ctx)).toBe(0);
    for (const id of CHECK_IDS) expect(out.some((l) => new RegExp(`^(pass|skip) +${id.replace(".", "\\.")} `).test(l))).toBe(true);
    expect(out.at(-1)).toMatch(/^hapi audit: \d+ pass, 0 fail, \d+ skip$/);
  });

  test("exits 1 on any fail", async () => {
    const w = await cleanWorld();
    w.archonValidate = { code: 1, out: { errors: ["bad node"], parseWarnings: [] } };
    const { out } = capture();
    expect(await auditCommand([], w.ctx)).toBe(1);
    expect(out.some((l) => /^fail +tools\.archon-validate .*bad node/.test(l))).toBe(true);
    expect(out.at(-1)).toMatch(/, 1 fail,/);
  });

  test("--strict turns every skip into a fail, saying why it was a skip", async () => {
    const w = await cleanWorld();
    const { out } = capture();
    expect(await auditCommand(["--strict"], w.ctx)).toBe(1);
    expect(out.some((l) => /^fail +github\.rulesets +--strict: skipped: no --repo given$/.test(l))).toBe(true);
    expect(out.at(-1)).toMatch(/, 0 skip$/);
  });

  test("--repo takes owner/name, more than once; anything else is a usage error (exit 2)", async () => {
    const w = await cleanWorld();
    const { err } = capture();
    for (const bad of [["--repo"], ["--repo", "nope"], ["--repo", "a/b/c"], ["--bogus"], ["--strict", "--strict"], ["stray"], ["--github-token-file"], ["--repo", "-x/y"]]) {
      expect([bad, await auditCommand(bad, w.ctx)]).toEqual([bad, 2]);
    }
    expect(err.join("\n")).toContain("usage: hapi audit");
  });

  test("a check that throws fails closed, naming the error", async () => {
    const w = await cleanWorld();
    w.ctx.policyDir = join(w.ctx.env.HOME!, "no-such-policy");
    const results = await runAudit(w.ctx);
    for (const id of ["generated.drift", "mcp.tool-hashes"]) {
      const r = only(results, id);
      expect([id, r.status]).toEqual([id, "fail"]);
      expect(r.detail).toContain("no-such-policy");
    }
  });

  test("with no Docker, the checks that need it skip, saying so; none passes", async () => {
    for (const how of ["throws", "daemon down"]) {
      const w = await cleanWorld();
      if (how === "throws") {
        w.ctx.exec = async (cmd) => {
          if (cmd[0] === "docker") throw new Error("cannot run docker: is it installed and on PATH?");
          return { code: 0, stdout: "", stderr: "" };
        };
      } else w.dockerDown = true;
      const results = await runAudit(w.ctx);
      for (const id of ["runtime.archon-env", "runtime.hermes-no-yolo", "runtime.dev-override", "tools.archon-validate", "tools.hermes-validate"]) {
        const r = only(results, id);
        expect([how, id, r.status]).toEqual([how, id, "skip"]);
        expect(r.detail.toLowerCase()).toContain("docker");
      }
    }
  });

  test("is registered: `hapi audit --help`-style usage errors go through main", async () => {
    const { err } = capture();
    expect(await main(["audit", "--nope"])).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi audit");
  });
});
