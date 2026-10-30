import { describe, expect, test } from "bun:test";
import { RUN_PATHS } from "../../src/generate/archon";
import { emitPi, splitPiRef } from "../../src/generate/pi";
import catalog from "../../src/generate/pi-catalog-1.3.0.json";
import { loadPolicy } from "../../src/policy/load";
import type { ModelSpec, PathModes, Policy, RosterName } from "../../src/policy/types";

const p = loadPolicy("policy");
const models = (...args: Parameters<typeof emitPi>) => JSON.parse(emitPi(...args)["models.json"]!);
const guard = (policy: Policy = p) => JSON.parse(emitPi(policy)["hapi-guard.json"]!);
const withPaths = (protectedPaths: Record<string, PathModes>): Policy => ({ ...p, protectedPaths });

const ROSTERS = ["anthropic", "budget", "portable"] as const;
const CATALOG = catalog.models as unknown as Record<string, { baseUrl: string; cost: unknown; compat: Record<string, unknown>; thinkingLevelMap: Record<string, string | null> }>;
/** A policy whose `roster` has `tier` replaced by a Pi model. */
const withTier = (roster: RosterName, tier: "small" | "medium" | "large", spec: ModelSpec): Policy => ({
  ...p,
  rosters: { ...p.rosters, [roster]: { ...p.rosters[roster], [tier]: spec } },
});

test("emitPi returns models.json, hapi-guard.json, settings.json and models-store.json", () => {
  expect(Object.keys(emitPi(p)).sort()).toEqual(["hapi-guard.json", "models-store.json", "models.json", "settings.json"]);
});

test("settings.json is the notice only, and models-store.json is exactly {}", () => {
  const settings = JSON.parse(emitPi(p)["settings.json"]!);
  expect(Object.keys(settings)).toEqual(["$comment"]);
  expect(settings.$comment).toContain("Do not edit it by hand");
  // Bound read-only over Pi's own store (spike 08, finding 9); a non-empty object could be read as a catalog overlay.
  expect(emitPi(p)["models-store.json"]).toBe("{}\n");
});

describe("models.json", () => {
  test("pi models.json caps maxTokens at 64000", () => {
    for (const roster of ["anthropic", "budget", "portable"] as const) {
      const m = models(p, roster);
      const entries = Object.values(m.providers).flatMap((provider: any) => Object.values(provider.modelOverrides));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e: any) => e.maxTokens === 64000)).toBe(true);
    }
  });

  test("models.json pins cost, maxTokens and the whole compat object for every Pi roster model", () => {
    for (const roster of ROSTERS) {
      const m = models(p, roster);
      const refs = (Object.values(p.rosters[roster]) as ModelSpec[]).filter((s) => s.provider === "pi").map((s) => s.model);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        const { vendor, id } = splitPiRef(ref);
        const pinned = CATALOG[ref]!;
        expect(m.providers[vendor].modelOverrides[id]).toEqual({ maxTokens: 64000, cost: pinned.cost, compat: pinned.compat });
      }
    }
    expect(models(p).providers.anthropic.modelOverrides["claude-haiku-5-5"].cost.tiers).toHaveLength(1);
  });

  test("each provider's baseUrl is pinned to the catalog's", () => {
    expect(models(p).providers.anthropic.baseUrl).toBe("https://api.anthropic.com");
    expect(models(p, "portable").providers["opencode-go"].baseUrl).toBe(CATALOG["opencode-go/kimi-k3"]!.baseUrl);
  });

  test("no models.json entry carries an anthropic-beta header", () => {
    for (const roster of ROSTERS) expect(emitPi(p, roster)["models.json"]!.toLowerCase()).not.toContain("anthropic-beta");
  });

  test("a roster naming a Pi model the 1.3.0 catalog lacks is refused", () => {
    expect(() => emitPi(withTier("portable", "large", { provider: "pi", model: "opencode-go/kimi-k3.1-pro", effort: "low" }), "portable")).toThrow(
      "policy/rosters/portable.yaml: opencode-go/kimi-k3.1-pro: not in Pi 1.3.0's catalog",
    );
  });

  test("an anthropic model the catalog lacks, or one without supportsMidConvoEffort there, is refused (H-184)", () => {
    expect(() => emitPi(withTier("anthropic", "large", { provider: "pi", model: "anthropic/claude-opus-9", effort: "low" }))).toThrow(
      "policy/rosters/anthropic.yaml: anthropic/claude-opus-9: not in Pi 1.3.0's catalog with supportsMidConvoEffort (H-184)",
    );
    const flagless = structuredClone(CATALOG["anthropic/claude-haiku-5-5"]!);
    flagless.compat.supportsMidConvoEffort = false;
    const saved = CATALOG["anthropic/claude-haiku-5-5"]!;
    CATALOG["anthropic/claude-haiku-5-5"] = flagless;
    try {
      expect(() => emitPi(p, "budget")).toThrow("anthropic/claude-haiku-5-5: not in Pi 1.3.0's catalog with supportsMidConvoEffort (H-184)");
    } finally {
      CATALOG["anthropic/claude-haiku-5-5"] = saved;
    }
  });

  test("an anthropic tier whose effort or retry_effort the catalog maps to null is refused; other vendors build anyway", () => {
    const small = { provider: "pi" as const, model: "anthropic/claude-haiku-5-5" };
    // Haiku 5.5's thinkingLevelMap maps "minimal" to null.
    expect(() => emitPi(withTier("budget", "small", { ...small, effort: "minimal" }), "budget")).toThrow(
      "policy/rosters/budget.yaml: anthropic/claude-haiku-5-5: effort 'minimal' maps to null in Pi 1.3.0's catalog",
    );
    expect(() => emitPi(withTier("budget", "small", { ...small, effort: "low", retry_effort: "minimal" }), "budget")).toThrow(/retry_effort 'minimal' maps to null/);
    // kimi-k3 maps low to null (the portable roster's large tier): H-120 tracks choosing its efforts.
    expect(() => emitPi(p, "portable")).not.toThrow();
  });

  test("it starts with the generated-file notice, as a $comment: JSON has no comments", () => {
    for (const roster of ["anthropic", "budget", "portable"] as const) {
      const m = models(p, roster);
      expect(Object.keys(m)[0]).toBe("$comment");
      expect(m.$comment).toContain(`Generated by \`hapi policy build\` from policy/rosters/${roster}.yaml.`);
      expect(m.$comment).toContain("Do not edit it by hand");
    }
  });

  test("it overrides the selected roster's Pi models by vendor, and nothing else", () => {
    // Claude-provider tiers run on Claude Code, not Pi, so sonnet is absent.
    const { $comment, ...m } = models(p);
    expect($comment).toBeString();
    expect(Object.keys(m)).toEqual(["$schema", "providers"]);
    expect(m.$schema).toBe("https://pi.dev/schemas/models.schema.json");
    expect(Object.keys(m.providers)).toEqual(["anthropic"]);
    expect(Object.keys(m.providers.anthropic)).toEqual(["baseUrl", "modelOverrides"]);
    expect(Object.keys(m.providers.anthropic.modelOverrides)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    expect(Object.keys(models(p, "budget").providers.anthropic.modelOverrides)).toEqual(["claude-haiku-5-5"]);
    expect(Object.keys(models(p, "portable").providers["opencode-go"].modelOverrides)).toEqual(["glm-5.3", "glm-5.3-flash", "kimi-k3"]);
  });

  test("splitPiRef refuses a ref without both a vendor and a model id", () => {
    for (const bad of ["claude-haiku-5-5", "/claude-haiku-5-5", "anthropic/", "/", ""]) {
      expect(() => splitPiRef(bad)).toThrow(`not a Pi model ref <vendor>/<model-id>: ${JSON.stringify(bad)}`);
    }
    // emitPi refuses rather than emit a broken ref from a roster built in code.
    const portable = { ...p.rosters.portable, small: { provider: "pi" as const, model: "glm-5.3", effort: "low" as const } };
    expect(() => emitPi({ ...p, rosters: { ...p.rosters, portable } }, "portable")).toThrow(/not a Pi model ref/);
  });

  test("a model id may itself contain slashes: only the first one splits the vendor", () => {
    expect(splitPiRef("openrouter/qwen/qwen3-coder")).toEqual({ vendor: "openrouter", id: "qwen/qwen3-coder" });
    // No catalog entry, so it is refused rather than emitted unpinned.
    const portable = { ...p.rosters.portable, small: { provider: "pi" as const, model: "openrouter/qwen/qwen3-coder", effort: "low" as const } };
    expect(() => emitPi({ ...p, rosters: { ...p.rosters, portable } }, "portable")).toThrow("openrouter/qwen/qwen3-coder: not in Pi 1.3.0's catalog");
  });
});

describe("hapi-guard.json", () => {
  test("pi hapi-guard.json carries workers modes", () => {
    const g = guard();
    expect(g.protected_paths["**/AGENTS.md"]).toBe("deny");
    expect(g.budgets.run_usd).toBe(3);
    expect(g.combine).toBe("strictest");
    expect(g.session).toBe("workers");
    expect(g.max_tokens).toBe(64000);
    expect(Object.keys(g.protected_paths).sort()).toEqual(Object.keys(p.protectedPaths).sort());
  });

  test("it holds deny rules only: allow adds no rule, and ask becomes deny because no human answers a worker", () => {
    const g = guard(
      withPaths({
        "AGENTS.md": { interactive: "ask", unattended: "deny", workers: "deny" },
        "docs/**": { interactive: "ask", unattended: "ask", workers: "allow" },
        "notes.md": { interactive: "ask", unattended: "deny", workers: "ask" },
      }),
    );
    expect(g.protected_paths).toEqual({ "AGENTS.md": "deny", "notes.md": "deny" });
  });

  test("overlapping globs combine strictest-wins in either key order", () => {
    const broad: PathModes = { interactive: "ask", unattended: "ask", workers: "allow" };
    const narrow: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };
    const a = emitPi(withPaths({ ".github/**": broad, ".github/workflows/**": narrow }));
    const b = emitPi(withPaths({ ".github/workflows/**": narrow, ".github/**": broad }));
    expect(a).toEqual(b);
    // .github/** adds no worker rule, so .github/workflows/ci.yml stays deny under any combining rule.
    expect(JSON.parse(a["hapi-guard.json"]!).protected_paths).toEqual({ ".github/workflows/**": "deny" });
  });

  test("an ask glob and a deny glob that overlap both come out deny, in either key order", () => {
    const ask: PathModes = { interactive: "ask", unattended: "deny", workers: "ask" };
    const deny: PathModes = { interactive: "deny", unattended: "deny", workers: "deny" };
    const a = emitPi(withPaths({ ".github/**": ask, ".github/workflows/**": deny }));
    const b = emitPi(withPaths({ ".github/workflows/**": deny, ".github/**": ask }));
    expect(a).toEqual(b);
    // Every rule is deny, so .github/workflows/ci.yml is denied whichever glob an enforcer applies.
    expect(JSON.parse(a["hapi-guard.json"]!).protected_paths).toEqual({ ".github/**": "deny", ".github/workflows/**": "deny" });
  });

  test("its keys come in a fixed order", () => {
    const g = guard();
    expect(Object.keys(g)).toEqual([
      "$comment", "session", "combine", "protected_paths", "budgets", "max_tokens", "models", "secret_env",
      "agent_dir_allowed", "gates", "jev", "paths",
    ]);
    expect(Object.keys(g.budgets)).toEqual(["run_usd", "mode"]);
    expect(Object.keys(g.jev)).toEqual(["enabled", "fallback"]);
  });

  test("budgets.mode, jev, gates and paths follow the policy and RUN_PATHS", () => {
    const g = guard();
    expect(g.budgets.mode).toBe(p.budgets.enforcement.hapi_guard);
    expect(guard({ ...p, budgets: { ...p.budgets, enforcement: { ...p.budgets.enforcement, hapi_guard: "soft" } } }).budgets.mode).toBe("soft");
    expect(g.jev).toEqual({ enabled: p.flags.jev.enabled, fallback: p.flags.jev.fallback });
    expect(g.gates).toEqual(p.gates);
    expect(g.paths).toEqual({ out: RUN_PATHS.out, runFile: RUN_PATHS.runFile, ledgerDir: RUN_PATHS.ledgerDir });
  });

  test("models holds what the guard compares at session_start, for each Pi ref of the roster", () => {
    for (const roster of ROSTERS) {
      const g = JSON.parse(emitPi(p, roster)["hapi-guard.json"]!);
      const refs = (Object.values(p.rosters[roster]) as ModelSpec[]).filter((s) => s.provider === "pi").map((s) => s.model);
      expect(Object.keys(g.models).sort()).toEqual([...new Set(refs)].sort());
      for (const ref of refs) {
        const c = CATALOG[ref]!;
        expect(g.models[ref]).toEqual({ base_url: c.baseUrl, cost: c.cost, compat: c.compat, max_tokens: 64000, require_compat: ref.startsWith("anthropic/") });
      }
    }
  });

  test("secret_env is the archon zone's env names from stack/secrets.yaml, sorted", () => {
    expect(guard().secret_env).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY", "OPENCODE_API_KEY"]);
  });

  test("agent_dir_allowed lists what may sit in Pi's directory", () => {
    expect(guard().agent_dir_allowed).toEqual([
      "auth.json", "auth.json.lock", "extensions", "hapi-guard.json", "models-store.json", "models-store.json.lock", "models.json", "sessions", "settings.json",
    ]);
  });

  test("budgets follow budgets.yaml, so a lowered run budget reaches the guard", () => {
    expect(guard({ ...p, budgets: { ...p.budgets, run_usd: 1.5 } }).budgets.run_usd).toBe(1.5);
  });
});

test("emitPi is deterministic", () => {
  expect(emitPi(p, "portable")).toEqual(emitPi(loadPolicy("policy"), "portable"));
});
