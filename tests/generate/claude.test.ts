/**
 * Claude Code's managed settings for the review (src/generate/claude.ts; H-205, design §6a item 15; spike 09, T19).
 * The file is bound read-only at CLAUDE_MANAGED_PATH in a review run's container alone (src/run/kinds.ts), where it
 * outranks every other settings source, and the review node loads none of those (`settingSources: []`).
 * tests/run/factory.int.test.ts runs it under Claude Code 2.1.302 in the image.
 */
import { expect, test } from "bun:test";
import { CLAUDE_MANAGED_PATH, emitClaude } from "../../src/generate/claude";
import { RUN_PATHS } from "../../src/generate/archon";
import { loadPolicy } from "../../src/policy/load";
import { RUN_INPUTS } from "../../src/run/kinds";

const p = loadPolicy("policy");
const settings = (policy = p) => JSON.parse(emitClaude(policy)["managed-settings.json"]!);

test("emitClaude writes Claude Code's managed settings: no hooks, no plugins, no project MCP, managed rules only, a read-only toolset, the review's three reads, no /proc, telemetry off", () => {
  expect(Object.keys(emitClaude(p))).toEqual(["managed-settings.json"]);
  expect(settings()).toEqual({
    disableAllHooks: true,
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    enableAllProjectMcpServers: false,
    enabledPlugins: {},
    strictKnownMarketplaces: [],
    permissions: {
      // The review's reads outside its checkout, by full path (T19 r4b; ruling I4): bypass mode is off, so any other
      // read outside /work/repo asks for a grant no one is there to give.
      allow: ["Read(//run/hapi/inputs/**)", "Read(//run/hapi/order.json)", "Read(//run/hapi/task.md)"],
      // Every tool that writes, runs or reaches out, and every read of /proc: the environment there holds the review
      // zone's keys, and a deny holds for a symlink's target too (the operator's argv exception, condition 2).
      // Agent is Claude Code 2.1.302's subagent tool (T19 r2 listed it); Task its older name.
      deny: ["Agent", "Bash", "Edit", "MultiEdit", "NotebookEdit", "Task", "WebFetch", "WebSearch", "Write", "Read(//proc/**)"],
      disableBypassPermissionsMode: "disable",
    },
    env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" },
  });
});

test("the grants are the paths the review prompt reads: the host's order and task, and the inputs dir", () => {
  const allow: string[] = settings().permissions.allow;
  expect(allow).toEqual([`Read(/${RUN_PATHS.inputs}/**)`, `Read(/${RUN_PATHS.order})`, `Read(/${RUN_PATHS.task})`]);
  // The inputs dir holds only RUN_INPUTS' files; the order and task are never among them (ruling m46).
  for (const name of Object.values(RUN_INPUTS)) expect([name, ["order.json", "task.md"].includes(name)]).toEqual([name, false]);
  // Nothing else under /run/hapi: run.json is the launcher's, and its base commit isn't the review's to read.
  expect(allow.some((r) => r.includes("run.json") || r === "Read(//run/hapi/**)")).toBe(false);
});

test("with flags.otel.enabled, env also turns Claude Code's OpenTelemetry on", () => {
  const on = structuredClone(p);
  on.flags.otel.enabled = true;
  expect(settings(on).env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_ENABLE_TELEMETRY: "1" });
  // The rest is the same file.
  const { env: _a, ...rest } = settings(on);
  const { env: _b, ...base } = settings();
  expect(rest).toEqual(base);
});

test("it is plain JSON, two-space indented with a final newline, deterministic, and has no $comment: Claude Code ignoring a managed file it can't read would fail open", () => {
  const text = emitClaude(p)["managed-settings.json"]!;
  expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  expect(text).toBe(emitClaude(loadPolicy("policy"))["managed-settings.json"]!);
  expect(text).not.toContain("$comment");
});

test("the managed path is Claude Code's on Linux (spike 09, T19 finding 13)", () => {
  expect(CLAUDE_MANAGED_PATH).toBe("/etc/claude-code/managed-settings.json");
});
