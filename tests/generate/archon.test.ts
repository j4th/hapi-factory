import { expect, test } from "bun:test";
import YAML from "yaml";
import { ARCHON_ENV, emitArchon, PI_AGENT_DIR, RUN_PATHS, type RunFile } from "../../src/generate/archon";
import { loadPolicy } from "../../src/policy/load";
import { ROLES, type Tier } from "../../src/policy/types";

const p = loadPolicy("policy");
const TIERS: Tier[] = ["small", "medium", "large"];
// A Pi ref is "<vendor>/<id>"; a claude-provider model is a bare id. The id is what follows the first "/".
const modelId = (model: string) => model.slice(model.indexOf("/") + 1);
const config = (...args: Parameters<typeof emitArchon>) => YAML.parse(emitArchon(...args)["config.yaml"]!);

test("emitArchon returns the five Archon files", () => {
  expect(Object.keys(emitArchon(p)).sort()).toEqual(["archon.env", "config.yaml", "empty.env", "gitconfig", "run-config.yaml"]);
});

test("RUN_PATHS holds the run container's fixed paths", () => {
  expect(RUN_PATHS).toEqual({
    piDir: "/opt/hapi/pi-agent",
    out: "/out",
    work: "/work/repo",
    source: "/src/repo.git",
    runFile: "/run/hapi/run.json",
    ledgerDir: "/tmp/hapi-guard",
    pack: "/.archon/workflows/hapi",
  });
  expect(RUN_PATHS.piDir).toBe(PI_AGENT_DIR);
  const run: RunFile = { run_id: "r", work_order: "w", traceparent: "t", budget_usd: 1, public: false, workflow: "x", started_at: "now" };
  expect(Object.keys(run)).toHaveLength(7);
});

test("config.yaml holds assistants.pi.enableExtensions: true for every roster (H-181(b))", () => {
  for (const roster of ["anthropic", "budget", "portable"] as const) {
    expect(config(p, roster).assistants).toEqual({ pi: { enableExtensions: true } });
  }
});

test("run-config.yaml holds enableExtensions, autoResumeOnQuotaReset: false and the same tiers and aliases", () => {
  for (const roster of ["anthropic", "budget", "portable"] as const) {
    const run = YAML.parse(emitArchon(p, roster)["run-config.yaml"]!);
    const global = config(p, roster);
    expect(run.assistants).toEqual({ pi: { enableExtensions: true } });
    expect(run.workflows).toEqual({ autoResumeOnQuotaReset: false });
    expect(run.tiers).toEqual(global.tiers);
    expect(run.aliases).toEqual(global.aliases);
  }
  expect(emitArchon(p)["run-config.yaml"]).toContain("Do not edit it by hand");
});

test("gitconfig trusts the source clone and Archon's workspace dirs, and names the worker", () => {
  const text = emitArchon(p)["gitconfig"]!;
  const lines = text.split("\n");
  const safe = lines.filter((l) => l.startsWith("\tdirectory = ")).map((l) => l.slice("\tdirectory = ".length));
  expect(safe).toEqual(["/src/repo.git", "/.archon/workspaces", "/.archon/workspaces/*", "/.archon/worktrees", "/.archon/worktrees/*"]);
  expect(safe[0]).toBe(RUN_PATHS.source);
  expect(lines).toContain("[safe]");
  expect(text).toContain("[user]\n\tname = hapi-factory worker\n\temail = worker@hapi.invalid\n");
  expect(lines.filter((l) => l.startsWith("#")).join("\n")).toContain("Do not edit it by hand");
});

test("empty.env holds only # lines", () => {
  const lines = emitArchon(p)["empty.env"]!.trimEnd().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((l) => l.startsWith("#"))).toBe(true);
  expect(lines.join("\n")).toContain("Do not edit it by hand");
});

const GIT_CONFIG_PAIRS = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["push.gpgSign", "false"],
  ["log.showSignature", "false"],
  ["core.askPass", ""],
  ["protocol.ext.allow", "never"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["submodule.recurse", "false"],
  ["core.attributesFile", "/dev/null"],
] as const;

/** The run container's whole non-proxy environment, name and value, in order (Plan 02 Task 6). */
const EXPECTED_ENV: [string, string][] = [
  ["ARCHON_TELEMETRY_DISABLED", "1"],
  ["DO_NOT_TRACK", "1"],
  ["PI_OFFLINE", "1"],
  ["PI_TELEMETRY", "0"],
  ["PI_CODING_AGENT_DIR", PI_AGENT_DIR],
  ["BUN_OPTIONS", "--no-install"],
  ["GIT_CONFIG_NOSYSTEM", "1"],
  ["GIT_CONFIG_GLOBAL", "/home/appuser/.gitconfig"],
  ["GIT_CONFIG_COUNT", "13"],
  ...GIT_CONFIG_PAIRS.flatMap(([k, v], i): [string, string][] => [
    [`GIT_CONFIG_KEY_${i}`, k],
    [`GIT_CONFIG_VALUE_${i}`, v],
  ]),
  ["GIT_ALLOW_PROTOCOL", "file"],
  ["GIT_PROTOCOL_FROM_USER", "0"],
  ["GIT_TERMINAL_PROMPT", "0"],
  ["GIT_ASKPASS", ""],
  ["GIT_PAGER", "cat"],
  ["GIT_EDITOR", "false"],
  ["CLAUDE_BIN_PATH", "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"],
  ["ARCHON_DOCKER", "true"],
];

test("ARCHON_ENV is exactly the run container's environment, in order, and has no server settings (no HOST)", () => {
  expect(ARCHON_ENV.map(([name, value]) => [name, value])).toEqual(EXPECTED_ENV);
  expect(ARCHON_ENV.map(([name]) => name)).not.toContain("HOST");
  // Every entry says why.
  for (const [name, , why] of ARCHON_ENV) expect([name, why.length > 10]).toEqual([name, true]);
});

test("archon env holds each ARCHON_ENV line once, in order, with its why line above it", () => {
  const text = emitArchon(p)["archon.env"]!;
  const settings = text.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
  expect(settings).toEqual(EXPECTED_ENV.map(([k, v]) => `${k}=${v}`));
});

test("archon env points Pi at the read-only agent dir that holds build/pi", () => {
  expect(emitArchon(p)["archon.env"]).toContain(`\nPI_CODING_AGENT_DIR=${PI_AGENT_DIR}\n`);
  expect(PI_AGENT_DIR.startsWith("/")).toBe(true);
});

test("archon env is plain KEY=value lines, comments and blank lines, each key once", () => {
  const lines = emitArchon(p)["archon.env"]!.trimEnd().split("\n");
  const settings = lines.filter((l) => l !== "" && !l.startsWith("#"));
  for (const l of settings) expect(l).toMatch(/^[A-Z][A-Z0-9_]*=[^\s"']*$/);
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
  expect(portable.tiers.large.model).toBe("opencode-go/kimi-k3");
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
