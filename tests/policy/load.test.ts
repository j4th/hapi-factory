import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import type { Policy, ZoneName } from "../../src/policy/types";

// Copies of policy/ with one file changed, for the negative tests. Removed after each test.
let temps: string[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
function policyWith(file: string, content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-policy-"));
  temps.push(dir);
  cpSync("policy", dir, { recursive: true });
  if (content === null) unlinkSync(join(dir, file));
  else writeFileSync(join(dir, file), content);
  return dir;
}
function policyError(dir: string): PolicyError {
  try {
    loadPolicy(dir);
  } catch (e) {
    if (e instanceof PolicyError) return e;
    throw e;
  }
  throw new Error("expected loadPolicy to throw a PolicyError");
}
/** A zone's effective allowlist: its own hosts plus the hosts of every source tier it lists. */
function zoneAllowlist(p: Policy, zone: ZoneName): string[] {
  const z = p.trustedSources.zones[zone];
  return [...new Set([...z.hosts, ...z.tiers.flatMap((t) => p.trustedSources.tiers[t].hosts)])];
}

test("loads repo policy", () => {
  const p = loadPolicy("policy");
  expect(p.protectedPaths["AGENTS.md"]).toEqual({ interactive: "ask", unattended: "deny", workers: "deny" });
  expect(p.protectedPaths[".pi/**"]?.interactive).toBe("deny");
  expect(p.budgets.workspaces["hapi-factory"]).toBe(100);
  expect(p.flags.jev).toEqual({ enabled: true, fallback: "haiku", via: "openrouter" });
});

test("rejects unknown keys with file and path", () => {
  expect(() => loadPolicy("tests/fixtures/policy-unknown-key")).toThrow(/budgets\.yaml.*\/wokspaces/);
  const e = policyError("tests/fixtures/policy-unknown-key");
  expect(e.file).toBe(join("tests/fixtures/policy-unknown-key", "budgets.yaml"));
  expect(e.path).toBe("/wokspaces");
});

describe("policy values (spec §8.2, §10, §12, §13.3)", () => {
  const p = loadPolicy("policy");

  test("protected paths are exactly spec §8.2", () => {
    const ask = { interactive: "ask", unattended: "deny", workers: "deny" } as const;
    const deny = { interactive: "deny", unattended: "deny", workers: "deny" } as const;
    expect(p.protectedPaths).toEqual({
      "AGENTS.md": ask,
      ".factory/**": ask,
      ".github/**": ask,
      "mise.toml": ask,
      ".pi/**": deny,
      ".agents/**": ask,
      ".archon/**": deny,
    });
  });

  test("flags are exactly spec §13.3", () => {
    expect(p.flags).toEqual({
      metrics: { enabled: true, merge_outcomes: true },
      otel: { enabled: false, content_capture: "off" },
      jev: { enabled: true, fallback: "haiku", via: "openrouter" },
      coderabbit: { enabled: true, include_in_rework: true },
      thresholds: { run_usd: 3, interventions: 1, review_rounds: 2 },
      on_flag: ["label_pr", "chat_alert"],
    });
  });

  test("budgets and approvals", () => {
    expect(p.budgets).toEqual({
      workspaces: { "hapi-hermes": 60, "hapi-factory": 100, "hapi-evals": 40 },
      openrouter_monthly_usd: 20,
      jev_monthly_usd: 2,
      run_usd: 3,
      hermes_max_turns: 60,
    });
    expect(p.approvals).toEqual([
      "merge",
      "new_dependency",
      "new_skill_or_mcp",
      "ci_workflow_change",
      "outbound_message",
      "spend_above_threshold",
    ]);
  });

  test("roles map every role to a tier", () => {
    expect(p.roles).toEqual({
      hermes_main: "large",
      hermes_auxiliary: "small",
      planner: "large",
      implement: "large",
      review: "medium",
      scout: "small",
      router: "small",
      eval_judge: "medium",
    });
  });

  test("anthropic roster follows spec §12", () => {
    const r = p.rosters.anthropic;
    // implement (large): Opus 5.5 on Pi, effort low, retry high
    expect(r.large).toEqual({ provider: "pi", model: "anthropic/claude-opus-5-5", effort: "low", retry_effort: "high" });
    // review (medium): Sonnet 5.5 at medium, via the Claude provider
    expect(r.medium).toEqual({ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" });
    expect(r.small.model).toBe("anthropic/claude-haiku-5-5");
  });

  test("budget roster is Haiku 5.5 on every tier", () => {
    for (const spec of Object.values(p.rosters.budget)) expect(spec.model).toMatch(/(^|\/)claude-haiku-5-5$/);
  });

  test("portable roster uses only zero-retention OpenCode Go models, with review on a different family", () => {
    // 0-day retention, no training, per https://opencode.ai/docs/go/ (checked 2026-10-26).
    // DeepSeek is left out on purpose: its ZDR agreement is renewed monthly (spec §12).
    const zeroRetention = new Set([
      "gemini-4-argon", "glm-5.3-flash", "glm-5.3", "glm-5.2", "kimi-k3.1-pro", "kimi-k3", "kimi-k2.7-code",
      "longcat-2.0", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.5", "mimo-v2.5-pro", "minimax-m3.1-flash",
      "minimax-m3", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus", "hy4-preview", "hy3", "step-5-preview",
    ]);
    const r = p.rosters.portable;
    for (const spec of Object.values(r)) {
      expect(spec.provider).toBe("pi");
      const [vendor, id] = spec.model.split("/");
      expect(vendor).toBe("opencode-go");
      expect(zeroRetention.has(id ?? "")).toBe(true);
    }
    expect(r.large.model).toBe("opencode-go/kimi-k3.1-pro");
    expect(r.medium.model).toBe("opencode-go/glm-5.3");
    const family = (m: string) => m.split("/")[1]?.match(/^[a-z]+/)?.[0];
    expect(family(r.large.model)).not.toBe(family(r.medium.model));
  });

  test("trusted-source zones", () => {
    const { zones, tiers } = p.trustedSources;
    expect(zones.archon.hosts).toEqual([
      "api.anthropic.com", "openrouter.ai", "opencode.ai", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org",
    ]);
    expect(zones.hermes.hosts).toEqual(["api.anthropic.com", "openrouter.ai", "api.github.com", "github.com", "slack.com"]);
    expect(zones.research.openWeb).toBe(true);
    // Spec §10: Pi workers get T0–T1, the Hermes main session T0–T2, and only research touches T3.
    expect(zones.archon.tiers).toEqual(["T0", "T1"]);
    expect(zones.hermes.tiers).toEqual(["T0", "T1", "T2"]);
    expect(zones.research.tiers).toEqual(["T0", "T1", "T2", "T3"]);
    expect(zones.archon.openWeb).toBeUndefined();
    expect(zones.hermes.openWeb).toBeUndefined();
    expect(tiers.T0.hosts).toEqual([]);
    expect(tiers.T3.hosts).toEqual([]);
    expect(tiers.T2.hosts).toEqual(["context7.com", "deepwiki.com"]);
  });

  test("the archon zone has no forge route, counting the hosts its tiers add", () => {
    const hosts = zoneAllowlist(p, "archon");
    expect(hosts).toContain("api.anthropic.com");
    expect(hosts.filter((h) => /(^|\.)github(usercontent)?\.com$/.test(h))).toEqual([]);
  });

  test("commands", () => {
    expect(p.commands.workers.tools).toEqual(["read", "grep", "find", "ls", "edit", "write", "bash"]);
    // Argv-exact rules, keyed by id (ruling 5's initial list, made structured by the security review).
    expect(Object.keys(p.commands.hermes.allow)).toEqual([
      "hapi-status",
      "hapi-workorder-validate",
      "git-status",
      "git-diff",
      "git-log",
      "git-add",
      "git-commit",
      "git-switch-plan",
      "git-push-plan",
    ]);
    // A plan branch is the only thing Hermes may push: no ':' refspec, no '+', no flags.
    expect(p.commands.hermes.allow["git-push-plan"]).toEqual({
      command: ["git", "push", "origin"],
      args: ["^plan/[a-z0-9][a-z0-9-]*$"],
      flags: {},
    });
    expect(Object.keys(p.commands.hermes.allow["git-diff"]!.flags)).toEqual([
      "--stat", "--name-only", "--name-status", "--cached", "--no-color",
    ]);
    expect(Object.keys(p.commands.hermes.allow["git-log"]!.flags)).toEqual(["--oneline", "-n", "--stat", "--no-color"]);
    expect(Object.keys(p.commands.hermes.allow["git-commit"]!.flags)).toEqual(["-m", "--trailer"]);
  });
});

describe("loadPolicy rejects bad policy with the file and path", () => {
  test("a missing file", () => {
    const e = policyError(policyWith("flags.yaml", null));
    expect(e.file).toEndWith("flags.yaml");
    expect(e.message).toContain("flags.yaml");
  });

  test("a missing roster", () => {
    const e = policyError(policyWith("rosters/portable.yaml", null));
    expect(e.file).toEndWith(join("rosters", "portable.yaml"));
  });

  test("invalid YAML, including a duplicate key", () => {
    const dup = 'protected_paths:\n  "AGENTS.md": { interactive: ask, unattended: deny, workers: deny }\n' +
      '  "AGENTS.md": { interactive: allow, unattended: allow, workers: allow }\n';
    const e = policyError(policyWith("protected_paths.yaml", dup));
    expect(e.file).toEndWith("protected_paths.yaml");
    expect(e.path).toBe("");
  });

  test("a model id where roles.yaml needs a tier", () => {
    const roles = readFileSync("policy/roles.yaml", "utf8").replace(/^implement: large/m, "implement: claude-opus-5-5");
    const e = policyError(policyWith("roles.yaml", roles));
    expect(e.file).toEndWith("roles.yaml");
    expect(e.path).toBe("/implement");
  });

  test("a Pi model without its vendor prefix", () => {
    const roster = readFileSync("policy/rosters/anthropic.yaml", "utf8").replace("anthropic/claude-opus-5-5", "claude-opus-5-5");
    const e = policyError(policyWith("rosters/anthropic.yaml", roster));
    expect(e.path).toBe("/large/model");
  });

  test("open-web tier T3 in the archon zone", () => {
    const ts = readFileSync("policy/trusted_sources.yaml", "utf8").replace("tiers: [T0, T1]", "tiers: [T0, T1, T3]");
    const e = policyError(policyWith("trusted_sources.yaml", ts));
    expect(e.path).toBe("/zones/archon/tiers/2");
  });

  test("a host that isn't a plain domain", () => {
    const ts = readFileSync("policy/trusted_sources.yaml", "utf8").replace("- opencode.ai", "- https://opencode.ai");
    const e = policyError(policyWith("trusted_sources.yaml", ts));
    expect(e.path).toBe("/zones/archon/hosts/2");
  });

  test("a forge host in the archon zone, or in a tier the archon zone reaches (spec §4.3)", () => {
    const ts = readFileSync("policy/trusted_sources.yaml", "utf8");
    const archon = policyError(policyWith("trusted_sources.yaml", ts.replace("- opencode.ai", "- gitlab.com")));
    expect(archon.path).toBe("/zones/archon/hosts/2");
    expect(archon.message).toContain('"gitlab.com" is a forge host (gitlab.com)');
    // The first "- pypi.org" is in T1, which the archon zone lists.
    const t1 = policyError(policyWith("trusted_sources.yaml", ts.replace("- pypi.org", "- raw.githubusercontent.com")));
    expect(t1.path).toBe("/tiers/T1/hosts/1");
    expect(t1.message).toContain("forge host (githubusercontent.com)");
    // The hermes zone may reach the forge.
    expect(() => loadPolicy(policyWith("trusted_sources.yaml", ts.replace("- slack.com", "- slack.com\n      - gitlab.com")))).not.toThrow();
  });

  test("a protected path entry missing a mode", () => {
    const pp = readFileSync("policy/protected_paths.yaml", "utf8").replace(
      '"mise.toml":   { interactive: ask, unattended: deny, workers: deny }',
      '"mise.toml":   { interactive: ask, unattended: deny }',
    );
    const e = policyError(policyWith("protected_paths.yaml", pp));
    expect(e.path).toBe("/protected_paths/mise.toml/workers");
  });
});

/**
 * The places in a JSON Schema where an object is left open to unknown keys: a node
 * with `properties` or `patternProperties` whose additionalProperties isn't false,
 * or a node whose type is or includes "object" whose additionalProperties is
 * neither false nor itself a schema. `if`, `then` and `else` only add conditions to
 * an enclosing object schema, which is the one that closes the shape, so they are
 * exempt (closing them would break the condition).
 */
function openObjects(node: unknown, where: string, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n, i) => openObjects(n, `${where}/${i}`, out));
    return out;
  }
  if (node === null || typeof node !== "object") return out;
  const o = node as Record<string, unknown>;
  const closed = o.additionalProperties === false;
  const schemaValued = o.additionalProperties !== null && typeof o.additionalProperties === "object";
  const types = Array.isArray(o.type) ? o.type : [o.type];
  if ((o.properties !== undefined || o.patternProperties !== undefined) && !closed) out.push(where);
  else if (types.includes("object") && !closed && !schemaValued) out.push(where);
  for (const [k, v] of Object.entries(o)) if (!["if", "then", "else"].includes(k)) openObjects(v, `${where}/${k}`, out);
  return out;
}

test("openObjects flags every open object shape", () => {
  expect(openObjects({ type: "object" }, "#")).toEqual(["#"]);
  expect(openObjects({ type: ["object", "null"] }, "#")).toEqual(["#"]);
  expect(openObjects({ type: "object", additionalProperties: true }, "#")).toEqual(["#"]);
  expect(openObjects({ properties: { a: {} } }, "#")).toEqual(["#"]);
  expect(openObjects({ type: "object", properties: {}, additionalProperties: { type: "string" } }, "#")).toEqual(["#"]);
  expect(openObjects({ $defs: { x: { type: "object" } } }, "#")).toEqual(["#/$defs/x"]);
  // Closed, or a map whose values are themselves checked by a schema.
  expect(openObjects({ type: "object", properties: { a: {} }, additionalProperties: false }, "#")).toEqual([]);
  expect(openObjects({ type: "object", propertyNames: {}, additionalProperties: { type: "string" } }, "#")).toEqual([]);
  expect(openObjects({ if: { type: "object", properties: { a: {} } }, then: { type: "object" } }, "#")).toEqual([]);
});

test("every object schema sets additionalProperties: false", () => {
  const files = readdirSync("policy/schemas").filter((f) => f.endsWith(".schema.json"));
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.flatMap((f) => openObjects(JSON.parse(readFileSync(join("policy/schemas", f), "utf8")), f));
  expect(offenders).toEqual([]);
});
