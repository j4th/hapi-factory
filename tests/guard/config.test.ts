/** hapi-guard's settings: a bad hapi-guard.json, run.json or Archon env fails the node closed at session_start (design §6a item 7). */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupAll, setup } from "./harness";

afterEach(cleanupAll);

/** The handlers a bad setup registers, and what its session_start throws. */
async function failure(h: ReturnType<typeof setup>): Promise<{ events: string[]; message: string }> {
  const events = [...h.pi.handlers.keys()];
  let message = "";
  try {
    await h.start();
  } catch (e) {
    message = (e as Error).message;
  }
  return { events, message };
}

const MARKER = "MARKER-not-for-the-message";

describe("a missing or invalid hapi-guard.json or run.json registers only a failing session_start", () => {
  test("hapi-guard.json missing", async () => {
    const h = setup({ settingsText: null });
    const { events, message } = await failure(h);
    expect(events).toEqual(["session_start"]);
    expect(message).toBe(`hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: can't be read; the node fails closed`);
  });

  test("hapi-guard.json not JSON: the message names the file, never its content", async () => {
    const h = setup({ settingsText: `{ "session": "workers", ${MARKER}` });
    const { events, message } = await failure(h);
    expect(events).toEqual(["session_start"]);
    expect(message).toBe(`hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: not valid JSON; the node fails closed`);
  });

  test("hapi-guard.json with a field of the wrong type: the field is named, its value never", async () => {
    const h = setup({ settings: (s) => (s.budgets.run_usd = MARKER) });
    const { events, message } = await failure(h);
    expect(events).toEqual(["session_start"]);
    expect(message).toBe(`hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: budgets.run_usd must be a number of at least 0; the node fails closed`);
  });

  for (const [what, change, field] of [
    ["an unknown budget mode", (s: any) => (s.budgets.mode = MARKER), "budgets.mode must be one of hard, soft"],
    ["a protected path that isn't deny", (s: any) => (s.protected_paths["AGENTS.md"] = "allow"), "protected_paths.AGENTS.md must be deny"],
    ["a model pin without base_url", (s: any) => delete s.models["anthropic/claude-haiku-5-5"].base_url, "models.anthropic/claude-haiku-5-5.base_url must be a string"],
    ["a result-screen tool the guard can't screen", (s: any) => (s.gates.result_screen.tools = ["bash", MARKER]), "gates.result_screen.tools[1] must be one of bash, read"],
    ["a relative path", (s: any) => (s.paths.out = "out"), "paths.out must be an absolute path"],
    ["a secret_env name that isn't an env name", (s: any) => s.secret_env.push(`A;${MARKER}`), "secret_env[4] must be an env name"],
  ] as const) {
    test(`hapi-guard.json with ${what}`, async () => {
      const h = setup({ settings: change });
      const { message } = await failure(h);
      expect(message).toBe(`hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: ${field}; the node fails closed`);
      expect(message).not.toContain(MARKER);
    });
  }

  test("a secret_env that names GIT_CONFIG_* or BUN_OPTIONS is refused: the git hardening and --no-install must reach the shell", async () => {
    for (const name of ["GIT_CONFIG_KEY_0", "GIT_CONFIG_COUNT", "BUN_OPTIONS"]) {
      const h = setup({ settings: (s) => s.secret_env.push(name) });
      const { message } = await failure(h);
      expect(message).toBe(`hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: secret_env names ${name}, which the shell must keep; the node fails closed`);
    }
  });

  test("gates on with no classifier at all is refused (turn the gate off instead)", async () => {
    const h = setup({ settings: (s) => (s.jev = { enabled: false, fallback: "none" }) });
    const { message } = await failure(h);
    expect(message).toBe(
      `hapi-guard: ${join(h.agentDir, "hapi-guard.json")}: a gate is on with no classifier (jev.enabled false, jev.fallback none); the node fails closed`,
    );
  });

  test("run.json missing", async () => {
    const h = setup({ runText: null });
    const { events, message } = await failure(h);
    expect(events).toEqual(["session_start"]);
    expect(message).toBe(`hapi-guard: ${h.runFile}: can't be read; the node fails closed`);
  });

  test("run.json not JSON, or with a bad field: the file and field are named, never the content", async () => {
    const a = setup({ runText: `{"run_id": "${MARKER}"` });
    expect((await failure(a)).message).toBe(`hapi-guard: ${a.runFile}: not valid JSON; the node fails closed`);
    const b = setup({ run: (r) => (r.public = MARKER) });
    expect((await failure(b)).message).toBe(`hapi-guard: ${b.runFile}: public must be a boolean; the node fails closed`);
    const c = setup({ run: (r) => (r.budget_usd = -1) });
    expect((await failure(c)).message).toBe(`hapi-guard: ${c.runFile}: budget_usd must be a number of at least 0; the node fails closed`);
  });
});

describe("the Archon env the guard reads", () => {
  test("PI_CODING_AGENT_DIR unset", async () => {
    const h = setup({ env: { PI_CODING_AGENT_DIR: undefined } });
    expect(await failure(h)).toEqual({ events: ["session_start"], message: "hapi-guard: PI_CODING_AGENT_DIR is not set; the node fails closed" });
  });

  test("WORKFLOW_ID unset, or ARCHON_NODE_EXECUTION missing or without an attempt id", async () => {
    expect((await failure(setup({ env: { WORKFLOW_ID: undefined } }))).message).toBe("hapi-guard: WORKFLOW_ID is not set; the node fails closed");
    expect((await failure(setup({ env: { ARCHON_NODE_EXECUTION: `{${MARKER}` } }))).message).toBe(
      "hapi-guard: ARCHON_NODE_EXECUTION is not valid JSON; the node fails closed",
    );
    expect((await failure(setup({ env: { ARCHON_NODE_EXECUTION: JSON.stringify({ path: "work", attempt: {} }) } }))).message).toBe(
      "hapi-guard: ARCHON_NODE_EXECUTION has no path and attempt.id; the node fails closed",
    );
  });

  test("a bad setup leaves the secrets in the env: the node fails before any shell runs", async () => {
    const h = setup({ settingsText: null });
    expect(h.env.ANTHROPIC_API_KEY).toBeDefined();
    expect(h.pi.registered).toEqual([]);
  });
});
