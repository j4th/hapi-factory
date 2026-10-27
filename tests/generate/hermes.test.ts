import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import YAML from "yaml";
import { emitHermes } from "../../src/generate/hermes";
import { loadPolicy } from "../../src/policy/load";
import { globMatches } from "../../src/policy/paths";
import type { PathModes, Policy } from "../../src/policy/types";

const p = loadPolicy("policy");
const ASK: PathModes = { interactive: "ask", unattended: "deny", workers: "deny" };
const DENY: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };
const WORKERS_ONLY: PathModes = { interactive: "allow", unattended: "allow", workers: "deny" };

const withPaths = (protectedPaths: Record<string, PathModes>): Policy => ({ ...p, protectedPaths });
// Parsed YAML is untyped.
const config = (policy: Policy = p): any => YAML.parse(emitHermes(policy)["config.yaml"]!);

test("emitHermes returns only config.yaml", () => {
  expect(Object.keys(emitHermes(p))).toEqual(["config.yaml"]);
});

test("hermes flips defaults", () => {
  const c = config();
  expect(c.skills.write_approval).toBe(true);
  expect(c.skills.guard_agent_created).toBe(true);
  expect(c.memory.write_approval).toBe(true);
  expect(c.approvals.mode).toBe("manual");
  expect([c.approvals.cron_mode, c.approvals.unattended_mode, c.approvals.single_query_mode]).toEqual(["deny", "deny", "deny"]);
  expect(c.plugins.isolation).toBe("host");
  expect(c.auth.adopt_external_logins).toBe(false);
  expect(c.web.keyless_fallback).toBe(false);
  expect(c.web.keyless_rescue).toBe(false);
  expect(c.security.allow_lazy_installs).toBe(false);
  expect(c.agent.max_turns).toBe(60);
  expect(Object.values(c.auxiliary).every((s: any) => s.model === "claude-haiku-5-5")).toBe(true);
  expect(c.hooks_auto_accept).toBe(false);
  // At the pinned tag v0.22.5, spec §9.1's `cache_ttl` is `prompt_caching.cache_ttl`, and
  // `container_persistent` is under `terminal` (hermes_cli/config_defaults.py).
  expect(c.prompt_caching.cache_ttl).toBe("auto");
  expect(c.terminal.container_persistent).toBe(false);
  // A delegated child must never auto-approve a dangerous command (hermes_plugins.md, #120000).
  expect(c.delegation.subagent_auto_approve).toBe(false);
});

test("every Hermes auxiliary slot, delegation and cron run Haiku 5.5 on the anthropic provider", () => {
  const c = config();
  const haiku = { provider: "anthropic", model: "claude-haiku-5-5" };
  // The 19 auxiliary slots at v0.22.5. A slot left out would fall back to the main (Opus) model.
  expect(Object.keys(c.auxiliary)).toHaveLength(19);
  for (const slot of ["approval", "background_review", "compression", "curator", "review", "title_generation", "vision"]) {
    expect(c.auxiliary[slot]).toEqual(haiku);
  }
  expect(c.delegation).toMatchObject(haiku);
  expect(c.cron).toEqual({ model_provider: "anthropic", model: "claude-haiku-5-5" });
});

test("the Hermes main model is the anthropic roster's hermes_main tier", () => {
  const c = config();
  expect(c.model).toEqual({ provider: "anthropic", default: "claude-opus-5-5" });
  expect(c.agent.reasoning_effort).toBe("low");
});

test("a claude-provider tier's Anthropic model id passes through to Hermes", () => {
  // The anthropic roster's medium tier is {provider: claude, model: claude-sonnet-5-5, effort: medium}.
  const c = config({ ...p, roles: { ...p.roles, hermes_main: "medium", hermes_auxiliary: "medium" } });
  expect(c.model).toEqual({ provider: "anthropic", default: "claude-sonnet-5-5" });
  expect(c.agent.reasoning_effort).toBe("medium");
  expect(c.auxiliary.compression).toEqual({ provider: "anthropic", model: "claude-sonnet-5-5" });
});

test("Hermes refuses a hermes_* tier that maps to a model of another vendor: it runs on the anthropic provider", () => {
  const openrouter = { provider: "pi" as const, model: "openrouter/qwen/qwen3-coder", effort: "low" as const };
  for (const [role, tier] of [["hermes_main", "large"], ["hermes_auxiliary", "small"]] as const) {
    const anthropic = { ...p.rosters.anthropic, [tier]: openrouter };
    expect(() => emitHermes({ ...p, rosters: { ...p.rosters, anthropic } })).toThrow(
      `Hermes runs on the anthropic provider, but ${role} maps to "openrouter/qwen/qwen3-coder" in the anthropic roster`,
    );
  }
});

test("hermes emits no hooks and never turns approvals off", () => {
  const c = config();
  // Plan 01 has no hapi-cmd-allow script yet; a fail_closed hook pointing at a missing script
  // would block every tool call.
  expect(c.hooks).toBeUndefined();
  expect(c.approvals.mode).not.toBe("off");
});

test("max_turns follows budgets.yaml", () => {
  expect(config({ ...p, budgets: { ...p.budgets, hermes_max_turns: 40 } }).agent.max_turns).toBe(40);
});

describe("protected instruction files", () => {
  test("hermes protected_instruction_files lists filename rules", () => {
    const c = config();
    expect(c.security.protected_instruction_files).toBe(true);
    expect(c.security.protected_instruction_extra_patterns).toEqual([".coderabbit.config.ts", ".coderabbit.yaml", ".coderabbit.yml", "AGENTS.md", "mise.toml"]);
  });

  test("directory globs Hermes can't express are named in a comment pointing at hapi-path-guard", () => {
    const text = emitHermes(p)["config.yaml"]!;
    const comment = text
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#"))
      .join("\n");
    for (const glob of [".agents/**", ".archon/**", ".factory/**", ".github/**", ".pi/**"]) expect(comment).toContain(glob);
    expect(comment).toContain("hapi-path-guard");
  });

  test("a glob ending in a file name becomes its basename; one that adds no Hermes rule is left out", () => {
    const c = config(
      withPaths({
        "docs/SECRET.md": ASK,
        "**/*.pem": { interactive: "allow", unattended: "deny", workers: "deny" },
        "build.sh": WORKERS_ONLY, // only workers: no rule for any Hermes session
        "keys/**": DENY,
      }),
    );
    expect(c.security.protected_instruction_extra_patterns).toEqual(["*.pem", "SECRET.md"]);
  });

  test("the patterns are a superset: every file a Hermes-relevant glob matches, some pattern matches", () => {
    const paths = { "AGENTS.md": ASK, "docs/*.md": ASK, "a/**/key?.txt": DENY, "x/y/z.cfg": ASK };
    const patterns: string[] = config(withPaths(paths)).security.protected_instruction_extra_patterns;
    // fnmatch on the basename, as Hermes applies it ([] never appears: the glob syntax forbids it).
    const fnmatch = (pat: string, name: string) =>
      new RegExp(`^${pat.replace(/[.+^${}()|\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(name);
    const files = ["AGENTS.md", "docs/README.md", "docs/a.md", "a/key1.txt", "a/b/c/keyZ.txt", "x/y/z.cfg"];
    for (const [glob] of Object.entries(paths)) {
      for (const file of files.filter((f) => globMatches(glob, f))) {
        expect(patterns.some((pat) => fnmatch(pat, basename(file)))).toBe(true);
      }
    }
  });

  test("overlapping globs give the same patterns in either key order", () => {
    const a = emitHermes(withPaths({ "**/SECRET.md": ASK, "docs/SECRET.md": DENY, ".github/**": ASK, ".github/workflows/**": DENY }));
    const b = emitHermes(withPaths({ ".github/workflows/**": DENY, ".github/**": ASK, "docs/SECRET.md": DENY, "**/SECRET.md": ASK }));
    expect(a).toEqual(b);
    expect(YAML.parse(a["config.yaml"]!).security.protected_instruction_extra_patterns).toEqual(["SECRET.md"]);
  });
});

test("emitHermes is deterministic", () => {
  expect(emitHermes(p)).toEqual(emitHermes(loadPolicy("policy")));
});

describe("MCP servers (spec §10.1)", () => {
  test("emitHermes carries mcp_servers only for enabled hermes-zone servers, with include lists and env by name", () => {
    // o11y off (flags.otel.enabled is false): the Hermes main session has no MCP server at all.
    expect(config().mcp_servers).toBeUndefined();
    const c = YAML.parse(emitHermes(p, { o11y: true })["config.yaml"]!);
    // Phoenix only: Context7 is research-zone only and never reaches the main session.
    expect(Object.keys(c.mcp_servers)).toEqual(["phoenix"]);
    const phoenix = c.mcp_servers.phoenix;
    expect(phoenix.command).toBe("npx");
    expect(phoenix.args).toEqual(["--yes", "@arizeai/phoenix-mcp@4.3.16"]);
    expect(phoenix.tools.include).toEqual(p.mcp.servers.phoenix!.tools.include);
    expect(phoenix.tools.include).not.toContain("phoenix-support");
    expect(phoenix.tools.include).toHaveLength(23);
    // The key is referenced by name, resolved by Hermes from its env; no value is in the file.
    expect(phoenix.env).toEqual({
      PHOENIX_API_KEY: "${HAPI_MCP_PHOENIX_VIEWER_KEY}",
      PHOENIX_DISCOVER_CONFIG: "false",
      PHOENIX_ENDPOINT: "http://phoenix.hapi.internal:6006",
    });
    expect(phoenix.trust).toBe("untrusted");
    expect(phoenix.elicitation).toEqual({ enabled: false });
  });

  test("the o11y default follows flags.otel.enabled; the option overrides it", () => {
    const on = structuredClone(p);
    on.flags.otel.enabled = true;
    expect(Object.keys(config(on).mcp_servers)).toEqual(["phoenix"]);
    expect(YAML.parse(emitHermes(on, { o11y: false })["config.yaml"]!).mcp_servers).toBeUndefined();
  });

  test("a string literal stays a string in YAML", () => {
    const text = emitHermes(p, { o11y: true })["config.yaml"]!;
    expect(text).toContain('PHOENIX_DISCOVER_CONFIG: "false"');
  });
});
