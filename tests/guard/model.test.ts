/**
 * The model pins and H-184's runtime half: at session_start the resolved model
 * must equal its pin in hapi-guard.json (spike 08, finding 9), and every
 * request is clamped and, for an Anthropic model, checked for drop_block.
 * Also Pi's directory and the worktree backstop (H-181(d)).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import catalog from "../../src/generate/pi-catalog-1.3.0.json";
import { cleanupAll, gatesOff, pinnedModel, setup } from "./harness";

afterEach(cleanupAll);

async function startError(h: ReturnType<typeof setup>): Promise<string> {
  try {
    await h.start();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
}

const HAIKU = "anthropic/claude-haiku-5-5";

describe("at session_start, the resolved model must equal its pin", () => {
  test("the pinned model starts, and the record says so", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    const r = h.log()[0];
    expect([r.event, r.decision, r.rule]).toEqual(["session_start", "allow", "session-start"]);
  });

  test("it fails unless ctx.model.compat.supportsMidConvoEffort === true (anthropic)", async () => {
    const model = pinnedModel();
    model.compat = { ...model.compat, supportsMidConvoEffort: false };
    const h = setup({ settings: gatesOff, model });
    expect(await startError(h)).toBe(`hapi-guard: ${HAIKU} resolved without compat.supportsMidConvoEffort, so Pi won't send drop_block (H-184); the node fails`);
    expect(h.log().map((r) => [r.event, r.decision, r.rule])).toEqual([["session_start", "fail", "model-pin"]]);
  });

  for (const [what, change, message] of [
    ["the base URL", (m: any) => (m.baseUrl = "http://127.0.0.1:18080"), `baseUrl is "http://127.0.0.1:18080", not the pinned "https://api.anthropic.com"`],
    ["the cost", (m: any) => (m.cost.input = 0), "cost differs from the pin"],
    ["the cost's tiers", (m: any) => (m.cost.tiers = []), "cost differs from the pin"],
    ["the whole compat, not only supportsMidConvoEffort", (m: any) => delete m.compat.supportsStrictTools, "compat differs from the pin"],
    ["compat gone", (m: any) => (m.compat = null), "resolved without compat.supportsMidConvoEffort"],
    ["maxTokens", (m: any) => (m.maxTokens = 128000), "maxTokens is 128000, not the pinned 64000"],
    ["headers", (m: any) => (m.headers = { "anthropic-beta": "interleaved-thinking-2025-05-14" }), "has headers, which no pin sets"],
  ] as const) {
    test(`it fails when ${what} differs (a planted models-store.json)`, async () => {
      const model = pinnedModel();
      change(model);
      expect(await startError(setup({ settings: gatesOff, model }))).toContain(message);
    });
  }

  test("an unpinned model, or none, fails", async () => {
    const other = { ...pinnedModel(), id: "claude-sonnet-5-5" };
    expect(await startError(setup({ settings: gatesOff, model: other }))).toBe(
      "hapi-guard: anthropic/claude-sonnet-5-5 has no pin in hapi-guard.json's models; the node fails",
    );
    expect(await startError(setup({ settings: gatesOff, model: undefined }))).toBe("hapi-guard: the session has no model; the node fails");
  });
});

/** An Anthropic payload as Pi 1.3.0 builds it for a 5.5 model (anthropic-messages.js:893-991; spike 08 r1). */
const anthropicPayload = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 128000,
  stream: true,
  betas: ["mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01"],
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
  output_config: { effort: "high" },
});

describe("at before_provider_request", () => {
  test("it clamps payload.max_tokens to 64000 in place and leaves cache_control alone", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    const payload = anthropicPayload();
    const before = structuredClone(payload);
    expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
    expect(payload.max_tokens).toBe(64000);
    expect({ ...payload, max_tokens: before.max_tokens }).toEqual(before);
    const r = h.log().at(-1);
    expect([r.event, r.decision, r.rule, r.reason]).toEqual(["provider_request", "allow", "max-tokens", "max_tokens 128000 clamped to 64000"]);
  });

  test("a budget-based thinking request keeps budget_tokens below the clamped max_tokens", async () => {
    // Budget-based thinking fails H-184's check, so this is a pin without require_compat.
    const h = setup({ settings: (s) => (gatesOff(s), (s.models[HAIKU].require_compat = false)) });
    await h.start();
    const payload = { max_tokens: 100000, thinking: { type: "enabled", budget_tokens: 90000 } };
    expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
    expect(payload).toEqual({ max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 63999 } });
  });

  test("for a require_compat model it fails unless thinking is disabled, or drop_block comes with the binding beta", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    const fail = `hapi-guard: ${HAIKU}'s request has neither thinking disabled nor drop_block with the thinking-binding-controls-2026-08-01 beta (H-184); the node fails`;
    // drop_block and the beta: passes.
    expect(await h.fire("before_provider_request", { payload: anthropicPayload() })).toBeUndefined();
    // Thinking disabled: passes, with no binding (the API rejects one with thinking off).
    expect(await h.fire("before_provider_request", { payload: { ...anthropicPayload(), thinking: { type: "disabled" }, betas: [] } })).toBeUndefined();
    // No binding: the planted-overlay request of spike 08 r7.
    await expect(
      h.fire("before_provider_request", { payload: { ...anthropicPayload(), thinking: { type: "enabled", budget_tokens: 2048 }, betas: ["interleaved-thinking-2025-05-14"] } }),
    ).rejects.toThrow(fail);
    // drop_block without the beta, and the beta without drop_block.
    await expect(h.fire("before_provider_request", { payload: { ...anthropicPayload(), betas: ["mid-conversation-output-config-2026-07-01"] } })).rejects.toThrow(fail);
    await expect(h.fire("before_provider_request", { payload: { ...anthropicPayload(), thinking: { type: "adaptive" } } })).rejects.toThrow(fail);
    // The top-level output_config.effort is not checked (spike 08, finding 4).
    expect(await h.fire("before_provider_request", { payload: { ...anthropicPayload(), output_config: { effort: "low" } } })).toBeUndefined();
    expect(h.log().filter((r) => r.decision === "fail").map((r) => [r.event, r.rule])).toEqual([
      ["provider_request", "drop-block"],
      ["provider_request", "drop-block"],
      ["provider_request", "drop-block"],
    ]);
  });

  test("an opencode-go request passes the payload check and is clamped", async () => {
    const glm = (catalog.models as any)["opencode-go/glm-5.3-flash"];
    const settings = (s: any) => {
      gatesOff(s);
      s.models["opencode-go/glm-5.3-flash"] = { base_url: glm.baseUrl, cost: glm.cost, compat: glm.compat, max_tokens: 64000, require_compat: false };
    };
    const h = setup({ settings, model: { provider: "opencode-go", id: "glm-5.3-flash", baseUrl: glm.baseUrl, cost: glm.cost, compat: glm.compat, maxTokens: 64000 } });
    await h.start();
    const payload = { model: "glm-5.3-flash", max_tokens: 131072, reasoning_effort: "low", messages: [] };
    expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
    expect(payload.max_tokens).toBe(64000);
  });

  test("a payload that is not an object fails the node: it is never sent unchecked", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    for (const payload of [undefined, null, "text", [anthropicPayload()]]) {
      await expect(h.fire("before_provider_request", { payload })).rejects.toThrow("hapi-guard: the provider payload is not an object; the node fails");
    }
    expect(h.log().filter((r) => r.decision === "fail").map((r) => [r.event, r.rule, r.reason])).toEqual(
      Array(4).fill(["provider_request", "payload", "the provider payload is not an object"]),
    );
  });

  test("a model with no pin at request time fails", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    h.ctx.model = { ...pinnedModel(), id: "claude-sonnet-5-5" };
    await expect(h.fire("before_provider_request", { payload: anthropicPayload() })).rejects.toThrow("anthropic/claude-sonnet-5-5 has no pin");
  });
});

describe("Pi's directory and the worktree", () => {
  test("session_start fails if PI_CODING_AGENT_DIR holds a name outside agent_dir_allowed", async () => {
    for (const name of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md", "bin"]) {
      const h = setup({ settings: gatesOff });
      if (name === "bin") mkdirSync(join(h.agentDir, name));
      else writeFileSync(join(h.agentDir, name), "planted\n");
      expect([name, await startError(h)]).toEqual([name, `hapi-guard: Pi's agent dir holds ${name}, which isn't one of hapi's files; the node fails`]);
      expect(h.log()[0].rule).toBe("agent-dir");
    }
  });

  test("session_start fails if extensions/ holds anything but hapi-guard.js", async () => {
    const ok = setup({ settings: gatesOff });
    writeFileSync(join(ok.agentDir, "extensions", "hapi-guard.js"), "// bundle\n");
    expect(await startError(ok)).toBe("");
    const h = setup({ settings: gatesOff });
    writeFileSync(join(h.agentDir, "extensions", "evil.ts"), "export default () => {}\n");
    expect(await startError(h)).toBe("hapi-guard: Pi's agent dir holds extensions/evil.ts, which isn't one of hapi's files; the node fails");
  });

  test("session_start fails if ctx.cwd holds .pi/, .agents/ or .archon/ (H-181(d), design §6a item 1)", async () => {
    for (const name of [".pi", ".agents", ".archon"]) {
      const h = setup({ settings: gatesOff });
      mkdirSync(join(h.work, name));
      expect([name, await startError(h)]).toEqual([name, `hapi-guard: the worktree holds ${name}/, which the launcher strips before a run (H-181(d)); the node fails`]);
      expect(h.log()[0].rule).toBe("worktree");
    }
  });
});
