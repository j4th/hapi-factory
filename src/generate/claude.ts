/**
 * Claude Code's managed settings for the review (H-205, design §6a item 15; spike 09, T19): `managed-settings.json`,
 * bound read-only at `CLAUDE_MANAGED_PATH` in a review run's container alone (src/run/kinds.ts, its `extraBinds`).
 * Managed settings outrank every other source, and `factory-review`'s review node loads no other source
 * (`settingSources: []`), so this file is the review session's whole configuration beside Archon's options:
 *
 * - no hooks, no plugins and no project MCP servers, and only these rules: a repo can't add a hook, a server or a
 *   permission rule of its own, even through a committed `.claude` link;
 * - bypass mode off, so Archon's `bypassPermissions` falls back to the default mode, where a read outside the
 *   checkout asks for a grant no one is there to give (T19 r4). The three grants are the review's reads by full
 *   path: the host's work order and task text, and the inputs dir (ruling I4);
 * - every tool that writes, runs or reaches out denied, beside the node's `allowed_tools` (the toolset), and every
 *   read of `/proc`: the environment there holds the review zone's keys, and a deny holds for a symlink's target as
 *   well as its path. That deny is the second of the three conditions on the operator's one argv exception, for
 *   CodeRabbit's key (2026-11-01);
 * - telemetry, the autoupdater and other non-essential traffic off; OpenTelemetry on with `flags.otel.enabled`.
 *
 * No `$comment` notice, unlike every other generated JSON file: Claude Code reads the file as its managed settings,
 * and a key it didn't know could make it ignore the file, which would fail open. docs/generated-configs.md says what
 * generates it. Pure.
 */
import { RUN_PATHS } from "./archon";
import type { Policy } from "../policy/types";

/** Claude Code's managed settings file on Linux (spike 09, T19 finding 13). */
export const CLAUDE_MANAGED_PATH = "/etc/claude-code/managed-settings.json";

/** A Read rule's absolute path: Claude Code reads `//x` as `/x` (and `/x` as relative to the project). */
const read = (path: string) => `Read(/${path})`;

/** `{ "managed-settings.json": … }`, written to build/claude/. */
export function emitClaude(p: Policy): Record<string, string> {
  const settings = {
    disableAllHooks: true,
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    enableAllProjectMcpServers: false,
    enabledPlugins: {},
    strictKnownMarketplaces: [],
    permissions: {
      allow: [read(`${RUN_PATHS.inputs}/**`), read(RUN_PATHS.order), read(RUN_PATHS.task)],
      // Agent is Claude Code 2.1.302's subagent tool (Task its older name; spike 09, T19 r2 listed Agent).
      deny: ["Agent", "Bash", "Edit", "MultiEdit", "NotebookEdit", "Task", "WebFetch", "WebSearch", "Write", read("/proc/**")],
      disableBypassPermissionsMode: "disable",
    },
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      ...(p.flags.otel.enabled ? { CLAUDE_CODE_ENABLE_TELEMETRY: "1" } : {}),
    },
  };
  return { "managed-settings.json": `${JSON.stringify(settings, null, 2)}\n` };
}
