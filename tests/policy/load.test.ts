import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FORGE_DOMAINS, forgeDomain } from "../../src/policy/hosts";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import rolesSchema from "../../policy/schemas/policy-roles.schema.json";
import runsSchema from "../../policy/schemas/policy-runs.schema.json";
import { ROLES, type Policy, type ZoneName } from "../../src/policy/types";

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
  expect(p.protectedPaths["**/AGENTS.md"]).toEqual({ interactive: "ask", unattended: "deny", workers: "deny" });
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

  test("protected paths are exactly spec §8.2 with its as-built additions (design §3.3's MCP configs, H-302's .gitattributes)", () => {
    const ask = { interactive: "ask", unattended: "deny", workers: "deny" } as const;
    const deny = { interactive: "deny", unattended: "deny", workers: "deny" } as const;
    expect(p.protectedPaths).toEqual({
      "**/AGENTS.md": ask,
      "**/AGENTS.override.md": ask,
      "**/AGENT.md": ask,
      "**/CLAUDE.md": ask,
      "**/CLAUDE.local.md": ask,
      "**/GEMINI.md": ask,
      "**/HERMES.md": ask,
      "**/.hermes.md": ask,
      "**/SOUL.md": ask,
      "**/REVIEW.md": ask,
      "**/.cursorrules": ask,
      "**/.windsurfrules": ask,
      "**/.claude/**": ask,
      "**/.hermes/**": ask,
      "**/.cursor/**": ask,
      "**/.clinerules/**": ask,
      "**/.rules/**": ask,
      "**/.mcp.json": ask,
      "**/.vscode/mcp.json": ask,
      "**/.gitattributes": ask,
      ".factory/**": ask,
      ".github/**": ask,
      "mise.toml": ask,
      "**/mise.toml": ask,
      "**/mise.lock": ask,
      "**/mise.*.lock": ask,
      "**/.mise.toml": ask,
      "**/mise.local.toml": ask,
      "**/.mise.local.toml": ask,
      "**/mise.*.toml": ask,
      "**/.mise.*.toml": ask,
      "**/mise/**": ask,
      "**/.mise/**": ask,
      "**/.config/mise.toml": ask,
      "**/.config/mise.*.toml": ask,
      "**/.config/mise/**": ask,
      "**/mise-tasks/**": ask,
      "**/.mise-tasks/**": ask,
      "**/.tool-versions": ask,
      ".pi/**": deny,
      ".agents/**": ask,
      ".archon/**": deny,
      ".coderabbit.yaml": ask,
      ".coderabbit.yml": ask,
      ".coderabbit.config.ts": ask,
      "**/.git/**": deny,
      "**/.gitleaks.toml": ask,
      "**/.gitleaksignore": ask,
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
      repo_monthly_usd: 25,
      daily_usd: 10,
      enforcement: { hapi_guard: "hard", archon: "hard", poller: "hard" },
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

  test("loads the new limits exactly", () => {
    expect(p.budgets.enforcement).toEqual({ hapi_guard: "hard", archon: "hard", poller: "hard" });
    expect(p.runs).toEqual({
      max_live: 1,
      retention_days: 14,
      output_limits_mb: { bundle: 256, transcript: 64, decisions: 16, result: 4 },
      disk: { gb: 20, enforcement: "hard" },
      poll_interval_s: 120,
      max_auto_rounds: 3,
      max_retries: 2,
      max_rework_rounds: 3,
      inputs_mb: 16,
      work_order_kb: 1024,
      phases: {
        verify: true,
        review: true,
        coderabbit: false,
        require_acceptance: true,
        fix_rounds_before_pr: 1,
        fix_rounds_on_pr: 1,
        round_turns: 40,
        round_usd: 1,
      },
    });
    // The design screens every bash call by default: the skip list starts empty.
    expect(p.gates).toEqual({
      bash_gate: { enabled: true, skip_commands: [] },
      result_screen: { enabled: true, tools: ["bash", "read"] },
      max_state_chars: 6000,
      classifiers: {
        jev: { model: "~typesafe/jev-latest", unknown_call_usd: 0.001 },
        haiku: { model: "claude-haiku-5-5", input_per_mtok: 0.1, output_per_mtok: 0.5 },
      },
    });
  });

  test("loads the repo registry and the sidecars exactly", () => {
    expect(p.repos).toEqual({ installations: { planner: 176015763, factory: 176015322 }, repos: {} });
    expect(p.sidecars).toEqual({
      "bun-http": {
        image: "oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
        command: ["bun", "/data/server.ts"],
        port: 8080,
        // Fail-closed defaults (ruling m47(5)): the container's limits, and the caps on its data's export.
        limits: { pids: 128, memory_mb: 512, data_files: 256, data_mb: 16 },
      },
    });
  });

  test("a fix round's cap above run_usd fails to load", () => {
    const text = readFileSync("policy/runs.yaml", "utf8").replace("round_usd: 1.00", "round_usd: 3.50");
    const dir = policyWith("runs.yaml", text);
    const e = policyError(dir);
    expect(e.file).toBe(join(dir, "runs.yaml"));
    expect(e.issues[0]!.path).toBe("/phases/round_usd");
    expect(e.message).toContain("phases.round_usd 3.5 is more than budgets.run_usd 3: a fix round must fit in one run's budget");
  });

  test("zero fix rounds load; a negative one, a poll under 30 s or a 0 GB disk doesn't", () => {
    const runs = readFileSync("policy/runs.yaml", "utf8");
    const zero = policyWith("runs.yaml", runs.replace("fix_rounds_on_pr: 1", "fix_rounds_on_pr: 0"));
    expect(loadPolicy(zero).runs.phases.fix_rounds_on_pr).toBe(0);
    const cases: [string, string, string][] = [
      ["fix_rounds_on_pr: 1", "fix_rounds_on_pr: -1", "/phases/fix_rounds_on_pr"],
      ["poll_interval_s: 120", "poll_interval_s: 10", "/poll_interval_s"],
      ["gb: 20", "gb: 0", "/disk/gb"],
    ];
    for (const [from, to, path] of cases) {
      const e = policyError(policyWith("runs.yaml", runs.replace(from, to)));
      expect(e.issues.map((i) => i.path)).toContain(path);
    }
  });

  test("repos.yaml takes owner/name keys, positive installation ids and a date", () => {
    const repos = (installations: string, key: string, registered: string) =>
      `installations: ${installations}\nrepos:\n  ${key}: { registered: "${registered}" }\n`;
    const ok = repos("{ planner: 1, factory: 2 }", "example-owner/hapi-sandbox-fortune", "2026-10-31");
    expect(loadPolicy(policyWith("repos.yaml", ok)).repos).toEqual({
      installations: { planner: 1, factory: 2 },
      repos: { "example-owner/hapi-sandbox-fortune": { registered: "2026-10-31" } },
    });
    const bad = (text: string) => policyError(policyWith("repos.yaml", text));
    const good = "example-owner/hapi-sandbox-fortune";
    let e = bad(repos("{ planner: 1, factory: 2 }", "hapi-sandbox-fortune", "2026-10-31"));
    expect(e.issues).toContainEqual({ path: "/repos/hapi-sandbox-fortune", message: "invalid key" });
    e = bad(repos("{ planner: 1, factory: 2 }", "example-owner/..", "2026-10-31"));
    expect(e.issues.map((i) => i.path)).toContain("/repos/example-owner~1..");
    e = bad(repos("{ planner: 0, factory: 2 }", good, "2026-10-31"));
    expect(e.issues.map((i) => i.path)).toContain("/installations/planner");
    e = bad(repos("{ planner: 1, factory: 2 }", good, "31-10-2026"));
    expect(e.issues.map((i) => i.path)).toContain("/repos/example-owner~1hapi-sandbox-fortune/registered");
    // M22: two keys that differ only in case are one GitHub repo, registered twice.
    e = bad(`installations: { planner: 1, factory: 2 }\nrepos:\n  ${good}: { registered: "2026-10-31" }\n  Example-Owner/Hapi-Sandbox-Fortune: { registered: "2026-11-01" }\n`);
    expect(e.issues).toEqual([
      { path: "/repos/Example-Owner~1Hapi-Sandbox-Fortune", message: `the same GitHub repo as ${good} (GitHub names ignore case): register each repo once` },
    ]);
    expect(e.file).toBe(join(dirname(e.file), "repos.yaml"));
  });

  test("sidecars.yaml pins each image by digest", () => {
    const text = readFileSync("policy/sidecars.yaml", "utf8");
    const bad = (t: string) => policyError(policyWith("sidecars.yaml", t)).issues.map((i) => i.path);
    expect(bad(text.replace(/@sha256:[0-9a-f]{64}/, ""))).toContain("/sidecars/bun-http/image");
    expect(bad(text.replace("port: 8080", "port: 70000"))).toContain("/sidecars/bun-http/port");
    expect(bad(text.replace(/command: \[.*\]/, "command: []"))).toContain("/sidecars/bun-http/command");
  });

  test("sidecars.yaml sets each sidecar's limits, every one a whole number of at least 1, and nothing else", () => {
    const text = readFileSync("policy/sidecars.yaml", "utf8");
    const bad = (t: string) => policyError(policyWith("sidecars.yaml", t)).issues.map((i) => i.path);
    for (const [from, to, path] of [
      ["pids: 128", "pids: 0", "/sidecars/bun-http/limits/pids"],
      ["memory_mb: 512", "memory_mb: 1.5", "/sidecars/bun-http/limits/memory_mb"],
      ["data_files: 256", "data_files: -1", "/sidecars/bun-http/limits/data_files"],
      ["data_mb: 16", "data_mb: 16\n      cpus: 2", "/sidecars/bun-http/limits/cpus"],
    ] as const) {
      expect(text).toContain(from);
      expect([from, bad(text.replace(from, to))]).toEqual([from, expect.arrayContaining([path])]);
    }
    // No limits at all: refused, never a sidecar without them.
    const without = text.replace(/\n    limits:[^\n]*(\n      [^\n]*)+/, "");
    expect(without).not.toContain("pids:");
    expect(bad(without)).toContain("/sidecars/bun-http/limits");
  });

  test("rejects an unknown enforcement", () => {
    const text = readFileSync("policy/budgets.yaml", "utf8").replace(/archon: hard/, "archon: off");
    const e = policyError(policyWith("budgets.yaml", text));
    expect(e.file).toEndWith("budgets.yaml");
    expect(e.message).toContain("/enforcement/archon: must be one of: hard, soft");
  });

  test("rejects max_live 0", () => {
    const text = readFileSync("policy/runs.yaml", "utf8").replace(/max_live: 1/, "max_live: 0");
    const e = policyError(policyWith("runs.yaml", text));
    expect(e.file).toEndWith("runs.yaml");
    expect(e.path).toBe("/max_live");
  });

  describe("a gate that is on needs Haiku as the fallback (Plan 02 has no other classifier for a repo that isn't public)", () => {
    const jev = (enabled: boolean, fallback: string) =>
      readFileSync("policy/flags.yaml", "utf8").replace(/^jev:.*$/m, `jev:          { enabled: ${enabled}, fallback: ${fallback}, via: openrouter }`);
    // The engine's diff-screen off, so each refusal names only its gate (the engine's decisions are held the same way below).
    const gates = readFileSync("policy/gates.yaml", "utf8").replace(/(diff-screen:[^\n]*\n\s*mode:) enforce/, "$1 off");
    const off = (text: string, gate: string) => text.replace(new RegExp(`(${gate}:\\s*enabled:) true`), "$1 false");
    const message =
      "on, but flags.jev.fallback is none, so a run that isn't public has no classifier whatever flags.jev.enabled says: set fallback to haiku, or turn the gate off here";

    test("jev off with fallback haiku loads", () => {
      expect(loadPolicy(policyWith("flags.yaml", jev(false, "haiku"))).flags.jev).toEqual({ enabled: false, fallback: "haiku", via: "openrouter" });
    });

    for (const enabled of [true, false]) {
      test(`jev ${enabled ? "on" : "off"} with fallback none is refused, naming each gate that is on`, () => {
        for (const gate of ["bash_gate", "result_screen"]) {
          const dir = policyWith("flags.yaml", jev(enabled, "none"));
          // Leave only this gate on.
          writeFileSync(join(dir, "gates.yaml"), off(gates, gate === "bash_gate" ? "result_screen" : "bash_gate"));
          const e = policyError(dir);
          expect(e.file).toEndWith("gates.yaml");
          expect(e.issues).toEqual([{ path: `/${gate}/enabled`, message }]);
        }
      });
    }

    test("both gates off with fallback none loads", () => {
      for (const enabled of [true, false]) {
        const dir = policyWith("flags.yaml", jev(enabled, "none"));
        writeFileSync(join(dir, "gates.yaml"), off(off(gates, "result_screen"), "bash_gate"));
        const p = loadPolicy(dir);
        expect([p.flags.jev.enabled, p.gates.bash_gate.enabled, p.gates.result_screen.enabled]).toEqual([enabled, false, false]);
      }
    });
  });

  test("loads the engine's decisions, and keeps them out of the guard's gates", () => {
    expect(p.decisions).toEqual({ mode: "enforce", max_calls_per_head: 24, by_name: { "diff-screen": { mode: "enforce", on_unscreened: "hold", skip_paths: ["bun.lock"] } } });
    expect("decisions" in p.gates).toBe(false);
  });

  describe("an engine decision that is on while flags.jev.fallback is none is refused", () => {
    const flags = readFileSync("policy/flags.yaml", "utf8").replace(/^jev:.*$/m, "jev:          { enabled: true, fallback: none, via: openrouter }");
    const gatesOff = readFileSync("policy/gates.yaml", "utf8")
      .replace(/(bash_gate:\s*enabled:) true/, "$1 false")
      .replace(/(result_screen:\s*enabled:) true/, "$1 false");
    const decision = (mode: string, text = gatesOff) => text.replace(/(diff-screen:[^\n]*\n\s*mode:) enforce/, `$1 ${mode}`);
    const models = (mode: string, text = gatesOff) => text.replace(/^(  mode:) enforce/m, `$1 ${mode}`);
    const dirWith = (gates: string) => {
      const dir = policyWith("flags.yaml", flags);
      writeFileSync(join(dir, "gates.yaml"), gates);
      return dir;
    };
    const message =
      "on, but flags.jev.fallback is none, so a run that isn't public has no classifier whatever flags.jev.enabled says: set fallback to haiku, or turn the gate off here";

    test("shadow, enforce and notes are refused", () => {
      for (const text of [decision("shadow"), gatesOff, models("notes")]) {
        const e = policyError(dirWith(text));
        expect(e.file).toEndWith("gates.yaml");
        expect(e.issues).toEqual([{ path: "/decisions/by_name/diff-screen/mode", message }]);
      }
    });

    test("the decision off, or decision models off, loads", () => {
      expect(loadPolicy(dirWith(decision("off"))).decisions.by_name["diff-screen"]!.mode).toBe("off");
      const p = loadPolicy(dirWith(models("off")));
      expect([p.decisions.mode, p.decisions.by_name["diff-screen"]!.mode]).toEqual(["off", "enforce"]);
    });

    test("a malformed decisions block is a schema error", () => {
      const shipped = readFileSync("policy/gates.yaml", "utf8");
      const bad = [
        decision("on", shipped),
        shipped.replace("      on_unscreened: hold", "      on_unscreened: hold\n      extra: 1"),
        shipped.replace("  by_name:", "  by_name:\n    nope:\n      mode: off\n      on_unscreened: hold"),
        shipped.replace(/    diff-screen:[\s\S]*$/, "    {}\n").replace("  by_name:\n    {}", "  by_name: {}"),
        models("shadow", shipped),
        shipped.replace("skip_paths: [bun.lock]", 'skip_paths: ["**/bun.lock"]'),
        shipped.replace(/^  mode: enforce[^\n]*\n/m, ""),
      ];
      for (const text of bad) {
        const e = policyError(policyWith("gates.yaml", text));
        expect(e.file).toEndWith("gates.yaml");
        expect(e.path.startsWith("/decisions")).toBe(true);
      }
    });
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

  test("ROLES, which the Role type comes from, is exactly the roles schema's list", () => {
    const roles: string[] = [...ROLES].sort();
    expect(roles).toEqual([...rolesSchema.required].sort());
    expect(roles).toEqual(Object.keys(rolesSchema.properties).sort());
  });

  test("anthropic roster follows spec §12", () => {
    const r = p.rosters.anthropic;
    // implement (large): Opus 5.5 on Pi, effort low, retry high
    expect(r.large).toEqual({ provider: "pi", model: "anthropic/claude-opus-5-5", effort: "low", retry_effort: "high" });
    // review (medium): Sonnet 5.5 at medium, via the Claude provider
    expect(r.medium).toEqual({ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" });
    expect(r.small.model).toBe("anthropic/claude-haiku-5-5");
  });

  test("budget roster is Haiku 5.5 on every tier but review's, which is Sonnet 5.5", () => {
    // Haiku on every tier but review's, Sonnet, so a review runs on another model than implement's (Plan 03 Task 11).
    expect(Object.fromEntries(Object.entries(p.rosters.budget).map(([t, spec]) => [t, spec.model]))).toEqual({ small: "anthropic/claude-haiku-5-5", medium: "claude-sonnet-5-5", large: "anthropic/claude-haiku-5-5" });
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
    expect(r.large.model).toBe("opencode-go/kimi-k3");
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
    // Spec §10 (amended by §10.1): Pi workers and the Hermes main session get T0–T1, and only research
    // touches T2 and T3.
    expect(zones.archon.tiers).toEqual(["T0", "T1"]);
    expect(zones.hermes.tiers).toEqual(["T0", "T1"]);
    expect(zones.research.tiers).toEqual(["T0", "T1", "T2", "T3"]);
    expect(zones.archon.openWeb).toBeUndefined();
    expect(zones.hermes.openWeb).toBeUndefined();
    // The review container (design §3.5): the review model's API and CodeRabbit's three hosts, no tier, so no registry.
    expect(zones.review).toEqual({ tiers: [], hosts: ["api.anthropic.com", "cli.coderabbit.ai", "app.coderabbit.ai", "ide.coderabbit.ai"] });
    expect(tiers.T0.hosts).toEqual([]);
    expect(tiers.T3.hosts).toEqual([]);
    expect(tiers.T2.hosts).toEqual(["context7.com", "deepwiki.com"]);
  });

  test("the archon zone has no forge route, counting the hosts its tiers add", () => {
    const hosts = zoneAllowlist(p, "archon");
    expect(hosts).toContain("api.anthropic.com");
    // Every forge domain the schema names (GitHub, GitLab and Bitbucket included), in any case.
    expect(FORGE_DOMAINS).toEqual(expect.arrayContaining(["github.com", "githubusercontent.com", "gitlab.com", "bitbucket.org"]));
    expect(hosts.filter((h) => forgeDomain(h) !== undefined)).toEqual([]);
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
    const base = readFileSync("policy/trusted_sources.yaml", "utf8");
    const ts = base.replace(/(\n  archon:[^\n]*\n    tiers: )\[T0, T1\]/, "$1[T0, T1, T3]");
    expect(ts).not.toBe(base);
    const e = policyError(policyWith("trusted_sources.yaml", ts));
    expect(e.path).toBe("/zones/archon/tiers/2");
  });

  test("a T2 or T3 tier in the hermes zone (spec §10.1: aggregators are research-only)", () => {
    const ts = readFileSync("policy/trusted_sources.yaml", "utf8");
    expect(ts.split("tiers: [T0, T1]\n    hosts:\n      - api.anthropic.com\n      - openrouter.ai\n      - api.github.com").length).toBe(2);
    for (const tier of ["T2", "T3"]) {
      const hermes = ts.replace(
        "tiers: [T0, T1]\n    hosts:\n      - api.anthropic.com\n      - openrouter.ai\n      - api.github.com",
        `tiers: [T0, T1, ${tier}]\n    hosts:\n      - api.anthropic.com\n      - openrouter.ai\n      - api.github.com`,
      );
      expect(policyError(policyWith("trusted_sources.yaml", hermes)).path).toBe("/zones/hermes/tiers/2");
    }
  });

  test("the review zone lists no tier, and no forge host", () => {
    const ts = readFileSync("policy/trusted_sources.yaml", "utf8");
    const at = "  review:";
    expect(ts.split(at).length).toBe(2);
    const tiered = policyError(policyWith("trusted_sources.yaml", ts.replace(/(\n  review:[^\n]*\n    tiers: )\[\]/, "$1[T1]")));
    expect(tiered.path).toBe("/zones/review/tiers");
    const forge = policyError(policyWith("trusted_sources.yaml", ts.replace("- ide.coderabbit.ai", "- ide.coderabbit.ai\n      - github.com")));
    expect(forge.path).toBe("/zones/review/hosts/4");
    expect(forge.message).toContain('"github.com" is a forge host (github.com); the review zone has no forge route (design §3.5)');
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

describe("policy-runs.schema.json", () => {
  test("its descriptions say what the launcher does, as runs.yaml's comments do (final review C-2; CodeRabbit, PR #13)", () => {
    const p = runsSchema.properties;
    expect(p.max_live.description).not.toMatch(/queued/);
    expect(p.retention_days.description).toMatch(/harvestedAt/);
    expect(p.output_limits_mb.description).toMatch(/not copied out/);
    expect(p.output_limits_mb.description).not.toMatch(/stops a run/);
  });
});
