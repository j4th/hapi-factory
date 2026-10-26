import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import { applyOverlay, loadOverlay, PolicyLoosenError } from "../../src/policy/overlay";
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
    const r = applyOverlay(p, { protected_paths: { "src/secrets/**": deny, "AGENTS.md": { interactive: "deny" } } });
    expect(r.protectedPaths["src/secrets/**"]).toEqual(deny);
    // A partial entry changes only the modes it names.
    expect(r.protectedPaths["AGENTS.md"]).toEqual({ interactive: "deny", unattended: "deny", workers: "deny" });
    expect(r.protectedPaths[".github/**"]).toEqual(p.protectedPaths[".github/**"]!);
    // The base policy is not mutated.
    expect(p.protectedPaths["src/secrets/**"]).toBeUndefined();
    expect(p.protectedPaths["AGENTS.md"]?.interactive).toBe("ask");
  });

  test("a new path's unnamed modes stay at allow, the base for an unprotected path", () => {
    const r = applyOverlay(p, { protected_paths: { "infra/**": { workers: "deny" } } });
    expect(r.protectedPaths["infra/**"]).toEqual({ interactive: "allow", unattended: "allow", workers: "deny" });
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
  });

  test("a null entry loads, and applyOverlay rejects it as a removal", () => {
    const o = loadOverlay("tests/fixtures/overlay-remove.yaml");
    expect(o.protected_paths?.["AGENTS.md"]).toBeNull();
    expect(loosenError(() => applyOverlay(p, o)).path).toBe("/protected_paths/AGENTS.md");
  });

  test("anything other than protected_paths, egress_extra and budgets is rejected", () => {
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
