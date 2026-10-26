import { describe, expect, test } from "bun:test";
import { emitPi } from "../../src/generate/pi";
import { loadPolicy } from "../../src/policy/load";
import type { PathModes, Policy } from "../../src/policy/types";

const p = loadPolicy("policy");
const models = (...args: Parameters<typeof emitPi>) => JSON.parse(emitPi(...args)["models.json"]!);
const guard = (policy: Policy = p) => JSON.parse(emitPi(policy)["hapi-guard.json"]!);
const withPaths = (protectedPaths: Record<string, PathModes>): Policy => ({ ...p, protectedPaths });

test("emitPi returns models.json and hapi-guard.json", () => {
  expect(Object.keys(emitPi(p)).sort()).toEqual(["hapi-guard.json", "models.json"]);
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

  test("it overrides the selected roster's Pi models by vendor, and nothing else", () => {
    // Claude-provider tiers run on Claude Code, not Pi, so sonnet is absent.
    expect(models(p)).toEqual({
      $schema: "https://pi.dev/schemas/models.schema.json",
      providers: {
        anthropic: { modelOverrides: { "claude-haiku-5-5": { maxTokens: 64000 }, "claude-opus-5-5": { maxTokens: 64000 } } },
      },
    });
    expect(Object.keys(models(p, "budget").providers.anthropic.modelOverrides)).toEqual(["claude-haiku-5-5"]);
    expect(Object.keys(models(p, "portable").providers["opencode-go"].modelOverrides)).toEqual([
      "glm-5.3",
      "glm-5.3-flash",
      "kimi-k3.1-pro",
    ]);
  });

  test("a model id may itself contain slashes: only the first one splits the vendor", () => {
    const portable = { ...p.rosters.portable, small: { provider: "pi" as const, model: "openrouter/qwen/qwen3-coder", effort: "low" as const } };
    const m = models({ ...p, rosters: { ...p.rosters, portable } }, "portable");
    expect(m.providers.openrouter.modelOverrides).toEqual({ "qwen/qwen3-coder": { maxTokens: 64000 } });
  });
});

describe("hapi-guard.json", () => {
  test("pi hapi-guard.json carries workers modes", () => {
    const g = guard();
    expect(g.protected_paths["AGENTS.md"]).toBe("deny");
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

  test("budgets follow budgets.yaml, so a lowered run budget reaches the guard", () => {
    expect(guard({ ...p, budgets: { ...p.budgets, run_usd: 1.5 } }).budgets.run_usd).toBe(1.5);
  });
});

test("emitPi is deterministic", () => {
  expect(emitPi(p, "portable")).toEqual(emitPi(loadPolicy("policy"), "portable"));
});
