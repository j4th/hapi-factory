import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { applyOverlay, loadOverlay, PolicyLoosenError } from "../../src/policy/overlay";
import { effectiveModes } from "../../src/policy/paths";
import type { RepoOverlay } from "../../src/policy/types";

const p = loadPolicy("policy");

function loosenError(fn: () => unknown): PolicyLoosenError {
  try {
    fn();
  } catch (e) {
    if (e instanceof PolicyLoosenError) return e;
    throw e;
  }
  throw new Error("expected a PolicyLoosenError");
}

describe("applyOverlay", () => {
  test("applyOverlay tightens", () => {
    const deny = { interactive: "deny", unattended: "deny", workers: "deny" } as const;
    const r = applyOverlay(p, { protected_paths: { "src/secrets/**": deny, "**/AGENTS.md": { interactive: "deny" } } });
    expect(r.protectedPaths["src/secrets/**"]).toEqual(deny);
    // A partial entry changes only the modes it names.
    expect(r.protectedPaths["**/AGENTS.md"]).toEqual({ interactive: "deny", unattended: "deny", workers: "deny" });
    expect(r.protectedPaths[".github/**"]).toEqual(p.protectedPaths[".github/**"]!);
    // The base policy is not mutated.
    expect(p.protectedPaths["src/secrets/**"]).toBeUndefined();
    expect(p.protectedPaths["**/AGENTS.md"]?.interactive).toBe("ask");
  });

  test("a new glob adds rules only for the modes it names", () => {
    const r = applyOverlay(p, { protected_paths: { "infra/**": { workers: "deny" } } });
    // allow in a stored entry means "this glob adds no rule for that session".
    expect(r.protectedPaths["infra/**"]).toEqual({ interactive: "allow", unattended: "allow", workers: "deny" });
    expect(effectiveModes(r, "infra/main.tf")).toEqual({ interactive: "allow", unattended: "allow", workers: "deny" });
  });

  test("a new glob that overlaps a protected one can tighten it, but never loosen it", () => {
    const r = applyOverlay(p, { protected_paths: { ".github/workflows/**": { workers: "deny" } } });
    // Modes combine strictest-wins across every matching glob, so the unnamed modes
    // (stored as allow) leave .github/** in force for the workflow files.
    expect(effectiveModes(r, ".github/workflows/ci.yml")).toEqual(p.protectedPaths[".github/**"]!);
    const t = applyOverlay(p, { protected_paths: { ".github/workflows/**": { interactive: "deny" } } });
    expect(effectiveModes(t, ".github/workflows/ci.yml")).toEqual({ interactive: "deny", unattended: "deny", workers: "deny" });
    expect(effectiveModes(t, ".github/CODEOWNERS")).toEqual(p.protectedPaths[".github/**"]!);
  });

  test("a new glob may not name allow: it can't change anything, so it reads as a loosening attempt", () => {
    const all = { interactive: "allow", unattended: "allow", workers: "allow" } as const;
    const e = loosenError(() => applyOverlay(p, { protected_paths: { ".github/workflows/**": all } }));
    expect(e.path).toBe("/protected_paths/.github~1workflows~1**/interactive");
    expect(e.message).toContain('".github/workflows/**"');
    expect(e.message).toContain("strictest");
    // The first allow is reported even when other modes tighten.
    const mixed = loosenError(() => applyOverlay(p, { protected_paths: { "infra/**": { interactive: "deny", workers: "allow" } } }));
    expect(mixed.path).toBe("/protected_paths/infra~1**/workers");
  });

  test("another spelling of a protected path is rejected by the schema, not merged", () => {
    for (const glob of ["./AGENTS.md", "docs/../AGENTS.md", ".github//workflows/**"]) {
      let err: unknown;
      try {
        applyOverlay(p, { protected_paths: { [glob]: { workers: "deny" } } });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PolicyError);
      expect((err as PolicyError).issues).toEqual([
        { path: `/protected_paths/${glob.replaceAll("/", "~1")}`, message: "invalid key" },
      ]);
    }
  });

  test("an entry equal to the base is accepted", () => {
    const r = applyOverlay(p, { protected_paths: { ".pi/**": { interactive: "deny", unattended: "deny", workers: "deny" } } });
    expect(r.protectedPaths).toEqual(p.protectedPaths);
  });

  test("applyOverlay rejects loosening", () => {
    expect(() => applyOverlay(p, { protected_paths: { "AGENTS.md": { interactive: "allow" } } })).toThrow(PolicyLoosenError);
    const e = loosenError(() => applyOverlay(p, { protected_paths: { "AGENTS.md": { interactive: "allow" } } }));
    expect(e.path).toBe("/protected_paths/AGENTS.md/interactive");
    expect(e.message).toContain("AGENTS.md");
    expect(e.message).toContain("ask");
    expect(e.message).toContain("allow");
  });

  test("loosening deny to ask is rejected too, and the message names the glob as written", () => {
    const e = loosenError(() => applyOverlay(p, { protected_paths: { ".pi/**": { interactive: "ask" } } }));
    expect(e.path).toBe("/protected_paths/.pi~1**/interactive");
    expect(e.message).toContain('".pi/**"');
  });

  test("applyOverlay rejects removing a protected path", () => {
    const e = loosenError(() => applyOverlay(p, { protected_paths: { "AGENTS.md": null } }));
    expect(e.path).toBe("/protected_paths/AGENTS.md");
    expect(e.message).toContain("AGENTS.md");
  });

  test("applyOverlay allows egress_extra additions", () => {
    const r = applyOverlay(p, { egress_extra: ["odoo.internal"] });
    expect(r.trustedSources.zones.archon.hosts).toContain("odoo.internal");
    expect(r.trustedSources.zones.hermes.hosts).not.toContain("odoo.internal");
    expect(p.trustedSources.zones.archon.hosts).not.toContain("odoo.internal");
  });

  test("egress_extra already in the zone is not duplicated", () => {
    const r = applyOverlay(p, { egress_extra: ["pypi.org"] });
    expect(r.trustedSources.zones.archon.hosts.filter((h) => h === "pypi.org")).toHaveLength(1);
  });

  test("egress_extra can't give the archon zone a forge route (spec §4.3)", () => {
    for (const host of ["github.com", "api.github.com", "raw.githubusercontent.com", "ghcr.io"]) {
      const e = loosenError(() => applyOverlay(p, { egress_extra: ["odoo.internal", host] }));
      expect(e.path).toBe("/egress_extra/1");
      expect(e.message).toContain(host);
    }
  });

  test("egress_extra can't add any forge, GitHub or not (forge-agnostic)", () => {
    const forges: [string, string][] = [
      ["gitlab.com", "gitlab.com"],
      ["registry.gitlab.com", "gitlab.com"],
      ["bitbucket.org", "bitbucket.org"],
      ["api.bitbucket.org", "bitbucket.org"],
      ["githubassets.com", "githubassets.com"],
      ["pkg.ghcr.io", "ghcr.io"],
    ];
    for (const [host, forge] of forges) {
      const e = loosenError(() => applyOverlay(p, { egress_extra: [host] }));
      expect(e.path).toBe("/egress_extra/0");
      expect(e.message).toContain(`"${host}" is a forge host (${forge})`);
    }
    // Case doesn't hide a forge (Squid matches domains case-insensitively): the overlay
    // schema's hostname is lowercase, so a mixed-case host is refused before the forge check.
    for (const host of ["GitHub.com", "Raw.GitHubUserContent.com"]) {
      expect(() => applyOverlay(p, { egress_extra: [host] })).toThrow("/egress_extra/0: must match pattern");
    }
    // Look-alikes are other domains, not forge hosts.
    const r = applyOverlay(p, { egress_extra: ["notgithub.com", "github.com.mirror.internal", "gitlab.company.internal"] });
    expect(r.trustedSources.zones.archon.hosts).toContain("notgithub.com");
  });

  test("the result shares no objects with the input policy", () => {
    const base = loadPolicy("policy"); // a private copy: if this test fails, the shared p stays intact
    const r = applyOverlay(base, {
      protected_paths: { "src/secrets/**": { workers: "deny" } },
      egress_extra: ["odoo.internal"],
      budgets: { run_usd: 2 },
    });
    r.protectedPaths["**/AGENTS.md"]!.interactive = "allow"; // an entry the overlay didn't touch
    r.protectedPaths[".pi/**"]!.workers = "allow";
    r.trustedSources.zones.archon.hosts.push("evil.example");
    r.trustedSources.zones.hermes.hosts.push("evil.example");
    r.budgets.workspaces["hapi-hermes"] = 999;
    r.commands.hermes.allow["git-push-plan"]!.args[0] = "^.*$";
    expect(base).toEqual(loadPolicy("policy"));
  });

  test("default_risk and workflow are exposed as result.repo (spec §7); they aren't policy, so tighten-only doesn't apply", () => {
    const r = applyOverlay(p, { default_risk: "high", workflow: "factory-task" });
    expect(r.repo).toEqual({ default_risk: "high", workflow: "factory-task" });
    // Any risk is accepted, "low" included: it is the default for new work orders, not a limit.
    expect(applyOverlay(p, { default_risk: "low" }).repo).toEqual({ default_risk: "low" });
    expect(applyOverlay(p, { workflow: "factory-docs" }).repo).toEqual({ workflow: "factory-docs" });
    // Nothing else changes, and the input is untouched.
    const { repo: _repo, ...rest } = r;
    expect(rest).toEqual(p);
    expect(p.repo).toBeUndefined();
    // Without them, there is no repo key at all.
    expect("repo" in applyOverlay(p, { budgets: { run_usd: 1 } })).toBe(false);
  });

  test("budgets may be lowered", () => {
    const r = applyOverlay(p, { budgets: { run_usd: 1.5, workspaces: { "hapi-factory": 50 } } });
    expect(r.budgets.run_usd).toBe(1.5);
    expect(r.budgets.workspaces).toEqual({ "hapi-hermes": 60, "hapi-factory": 50, "hapi-evals": 40 });
    expect(r.budgets.hermes_max_turns).toBe(60);
    expect(p.budgets.run_usd).toBe(3);
  });

  test("raising a budget is rejected", () => {
    expect(loosenError(() => applyOverlay(p, { budgets: { run_usd: 10 } })).path).toBe("/budgets/run_usd");
    expect(loosenError(() => applyOverlay(p, { budgets: { workspaces: { "hapi-evals": 41 } } })).path).toBe(
      "/budgets/workspaces/hapi-evals",
    );
  });

  test("an empty overlay changes nothing", () => {
    expect(applyOverlay(p, {})).toEqual(p);
  });

  test("an overlay built in code gets the schema check too", () => {
    const bad = { commands: { hermes: { allow: ["rm -rf *"] } } } as unknown as RepoOverlay;
    let err: unknown;
    try {
      applyOverlay(p, bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PolicyError);
    expect((err as PolicyError).path).toBe("/commands");
  });
});

describe("loadOverlay", () => {
  test("hapi-factory's own overlay protects policy/** and stack/** like AGENTS.md", () => {
    const r = applyOverlay(p, loadOverlay(".factory/config.yaml"));
    const ask = { interactive: "ask", unattended: "deny", workers: "deny" } as const;
    for (const file of ["policy/protected_paths.yaml", "policy/rosters/budget.yaml", "stack/compose.yaml", "stack/secrets.yaml"]) {
      expect(effectiveModes(r, file)).toEqual(ask);
      expect(effectiveModes(p, file)).toEqual({ interactive: "allow", unattended: "allow", workers: "allow" }); // central policy: every repo
    }
    expect(effectiveModes(r, "src/cli.ts")).toEqual({ interactive: "allow", unattended: "allow", workers: "allow" });
  });

  let temps: string[] = [];
  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    temps = [];
  });
  function overlayFile(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hapi-overlay-"));
    temps.push(dir);
    const file = join(dir, "config.yaml");
    writeFileSync(file, yaml);
    return file;
  }
  function policyError(file: string): PolicyError {
    try {
      loadOverlay(file);
    } catch (e) {
      if (e instanceof PolicyError) return e;
      throw e;
    }
    throw new Error("expected loadOverlay to throw a PolicyError");
  }

  test("loads the example overlay", () => {
    const o = loadOverlay("tests/fixtures/overlay-tighten.yaml");
    const r = applyOverlay(p, o);
    expect(r.protectedPaths["src/secrets/**"]).toEqual({ interactive: "deny", unattended: "deny", workers: "deny" });
    expect(r.trustedSources.zones.archon.hosts).toContain("odoo.internal");
    expect(r.budgets.run_usd).toBe(2);
    expect(r.repo).toEqual({ default_risk: "medium", workflow: "factory-task" });
  });

  test("default_risk must be a risk and workflow a slug", () => {
    expect(policyError(overlayFile("default_risk: extreme\n")).path).toBe("/default_risk");
    for (const w of ["Factory-Task", "factory_task", "../factory-task", "factory-", "-factory", "factory--task"]) {
      expect(policyError(overlayFile(`workflow: "${w}"\n`)).path).toBe("/workflow");
    }
    expect(loadOverlay(overlayFile("default_risk: low\nworkflow: factory-task\n"))).toEqual({
      default_risk: "low",
      workflow: "factory-task",
    });
  });

  test("a null entry loads, and applyOverlay rejects it as a removal", () => {
    const o = loadOverlay("tests/fixtures/overlay-remove.yaml");
    expect(o.protected_paths?.["AGENTS.md"]).toBeNull();
    expect(loosenError(() => applyOverlay(p, o)).path).toBe("/protected_paths/AGENTS.md");
  });

  test("anything other than protected_paths, egress_extra, budgets, default_risk and workflow is rejected", () => {
    for (const key of ["commands", "trusted_sources", "approvals", "flags", "roles", "rosters"]) {
      const e = policyError(overlayFile(`${key}: {}\n`));
      expect(e.path).toBe(`/${key}`);
      expect(e.message).toContain("config.yaml");
    }
  });

  test("an unknown budget key is rejected", () => {
    expect(policyError(overlayFile("budgets:\n  run_usdd: 1\n")).path).toBe("/budgets/run_usdd");
  });

  test("an unknown mode value is rejected", () => {
    expect(policyError(overlayFile('protected_paths:\n  "x/**": { workers: never }\n')).path).toBe(
      "/protected_paths/x~1**/workers",
    );
  });

  test("an egress_extra entry must be a plain domain", () => {
    expect(policyError(overlayFile('egress_extra: ["https://odoo.internal"]\n')).path).toBe("/egress_extra/0");
    expect(policyError(overlayFile('egress_extra: [".odoo.internal"]\n')).path).toBe("/egress_extra/0");
  });

  test("a missing file", () => {
    expect(policyError(join(tmpdir(), "hapi-no-such-overlay.yaml")).file).toEndWith("hapi-no-such-overlay.yaml");
  });
});
