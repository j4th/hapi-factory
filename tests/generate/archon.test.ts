import { expect, test } from "bun:test";
import YAML from "yaml";
import { emitArchon, PI_AGENT_DIR } from "../../src/generate/archon";
import { loadPolicy } from "../../src/policy/load";
import { ROLES, type Tier } from "../../src/policy/types";

const p = loadPolicy("policy");
const TIERS: Tier[] = ["small", "medium", "large"];
// A Pi ref is "<vendor>/<id>"; a claude-provider model is a bare id. The id is what follows the first "/".
const modelId = (model: string) => model.slice(model.indexOf("/") + 1);
const config = (...args: Parameters<typeof emitArchon>) => YAML.parse(emitArchon(...args)["config.yaml"]!);

test("emitArchon returns config.yaml and archon.env", () => {
  expect(Object.keys(emitArchon(p)).sort()).toEqual(["archon.env", "config.yaml"]);
});

test("archon env is loopback with telemetry off", () => {
  const env = emitArchon(p)["archon.env"]!;
  expect(env).toMatch(/^HOST=127\.0\.0\.1$/m);
  expect(env).toMatch(/^ARCHON_TELEMETRY_DISABLED=1$/m);
  expect(env).toMatch(/^DO_NOT_TRACK=1$/m);
  expect(env).toMatch(/^PI_OFFLINE=1$/m);
  expect(env).toMatch(/^PI_TELEMETRY=0$/m);
});

test("archon env points Pi at the read-only agent dir that holds build/pi", () => {
  expect(emitArchon(p)["archon.env"]).toContain(`\nPI_CODING_AGENT_DIR=${PI_AGENT_DIR}\n`);
  expect(PI_AGENT_DIR.startsWith("/")).toBe(true);
});

test("archon env is plain KEY=value lines, comments and blank lines, each key once", () => {
  const lines = emitArchon(p)["archon.env"]!.trimEnd().split("\n");
  const settings = lines.filter((l) => l !== "" && !l.startsWith("#"));
  for (const l of settings) expect(l).toMatch(/^[A-Z][A-Z0-9_]*=[^\s"']+$/);
  const keys = settings.map((l) => l.split("=")[0]);
  expect(new Set(keys).size).toBe(keys.length);
});

test("archon tiers come from the selected roster", () => {
  const c = config(p, "budget");
  for (const tier of TIERS) expect(modelId(c.tiers[tier].model)).toBe("claude-haiku-5-5");
  expect(c.tiers).toEqual({
    small: { provider: "pi", model: "anthropic/claude-haiku-5-5", effort: "low" },
    medium: { provider: "claude", model: "claude-haiku-5-5", effort: "medium" },
    large: { provider: "pi", model: "anthropic/claude-haiku-5-5", effort: "low" },
  });
});

test("archon defaults to the anthropic roster; portable runs every tier on Pi", () => {
  expect(config(p).tiers.large).toEqual({ provider: "pi", model: "anthropic/claude-opus-5-5", effort: "low" });
  expect(config(p).tiers.medium).toEqual({ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" });
  const portable = config(p, "portable");
  for (const tier of TIERS) expect(portable.tiers[tier].provider).toBe("pi");
  expect(portable.tiers.large.model).toBe("opencode-go/kimi-k3.1-pro");
});

test("archon aliases name each Archon role's tier, with a retry alias at the tier's retry effort", () => {
  const c = config(p);
  const large = { provider: "pi", model: "anthropic/claude-opus-5-5", effort: "low" };
  expect(c.aliases).toEqual({
    "@eval-judge": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    "@implement": large,
    "@implement-retry": { ...large, effort: "high" },
    "@planner": large,
    "@planner-retry": { ...large, effort: "high" },
    "@review": { provider: "claude", model: "claude-sonnet-5-5", effort: "medium" },
    "@router": { provider: "pi", model: "anthropic/claude-haiku-5-5", effort: "low" },
    "@scout": { provider: "pi", model: "anthropic/claude-haiku-5-5", effort: "low" },
  });
});

test("every role but Hermes's gets an alias, so a role added to ROLES can't be left without one", () => {
  const c = config(p);
  const archonRoles = ROLES.filter((r) => !r.startsWith("hermes_"));
  expect(archonRoles.length).toBeGreaterThan(0);
  // Every role roles.yaml defines is in ROLES, and the base aliases are exactly the non-Hermes roles.
  expect(Object.keys(p.roles).sort()).toEqual([...ROLES].sort());
  const base = Object.keys(c.aliases).filter((a) => !a.endsWith("-retry"));
  expect(base.sort()).toEqual(archonRoles.map((r) => `@${r.replaceAll("_", "-")}`).sort());
});

test("a role moved to another tier moves its alias", () => {
  const c = config({ ...p, roles: { ...p.roles, review: "large" } });
  expect(c.aliases["@review"].model).toBe("anthropic/claude-opus-5-5");
  expect(c.aliases["@review-retry"].effort).toBe("high");
});

test("emitArchon is deterministic", () => {
  expect(emitArchon(p, "portable")).toEqual(emitArchon(loadPolicy("policy"), "portable"));
});
