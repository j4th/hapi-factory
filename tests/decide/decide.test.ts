import { describe, expect, test } from "bun:test";
import { decide, type DecideOptions } from "../../src/decide/index";
import bashGate from "../../policy/decisions/bash-gate";
import { FAKE_ANTHROPIC_KEY, FAKE_JEV_KEY, GATES, bashHaikuAnswers, haikuReply, isOpenrouter, jevReply, json, recordingFetch, type Seen } from "./helpers";

const base = (over: Partial<DecideOptions> = {}): DecideOptions => ({
  gates: GATES,
  jev: { enabled: true, public: true, apiKey: FAKE_JEV_KEY },
  haiku: { enabled: true, apiKey: FAKE_ANTHROPIC_KEY },
  retryDelayMs: 0,
  ...over,
});

/** Jev answers `jev` (or fails with 503 when null); Haiku answers `haiku` (or fails with 400 when null). */
function route(jev: Response | null, haiku: Response | null) {
  return recordingFetch((s: Seen) =>
    isOpenrouter(s) ? (jev ? (jev.clone() as Response) : json({}, 503)) : haiku ? (haiku.clone() as Response) : json({ type: "error", error: { type: "invalid_request_error", message: "no" } }, 400),
  );
}

describe("decide", () => {
  test("public repo, Jev answers", async () => {
    const { fetch, seen } = route(jevReply({ irreversible: 0.9, destructive: 0.1, cost: 0.00042 }), null);
    const r = await decide(bashGate, "rm -rf /", base({ fetch }));
    expect(r.via).toBe("jev");
    expect(r.fallback).toBe(false);
    expect(r.verdict).toBe("block");
    expect(r.costUsd).toBe(0.00042);
    expect(r.error).toBeUndefined();
    expect(r.answers?.destructive_intent).toEqual({ type: "noul", noul: 0.1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${FAKE_JEV_KEY}`);
    expect(seen[0]!.body.model).toBe("~typesafe/jev-latest");
  });

  test("Jev cost unknown counts at gates.classifiers.jev.unknown_call_usd", async () => {
    const { fetch } = route(jevReply({ irreversible: 0.1, destructive: 0.1 }), null);
    const r = await decide(bashGate, "ls", base({ fetch }));
    expect(r.via).toBe("jev");
    expect(r.verdict).toBe("allow");
    expect(r.costUsd).toBe(0.001);
  });

  test("Jev fails, Haiku answers", async () => {
    const { fetch, seen } = route(null, haikuReply(bashHaikuAnswers(0.8, 0.1), { input_tokens: 1000, output_tokens: 200 }));
    const r = await decide(bashGate, "rm -rf /", base({ fetch }));
    expect(seen.filter(isOpenrouter)).toHaveLength(3);
    expect(r.via).toBe("haiku");
    expect(r.fallback).toBe(true);
    expect(r.verdict).toBe("block");
    expect(r.costUsd).toBeCloseTo((1000 / 1e6) * 0.1 + (200 / 1e6) * 0.5, 12);
    expect(r.error).toBe("jev: openrouter HTTP 503.");
  });

  test("a repo not marked public never calls Jev", async () => {
    const { fetch, seen } = route(jevReply({ irreversible: 0, destructive: 0 }), haikuReply(bashHaikuAnswers(0.1, 0.1)));
    const r = await decide(bashGate, "ls", base({ fetch, jev: { enabled: true, public: false, apiKey: FAKE_JEV_KEY } }));
    expect(seen.some(isOpenrouter)).toBe(false);
    expect(r.via).toBe("haiku");
    expect(r.fallback).toBe(false);
    expect(r.verdict).toBe("allow");
  });

  test("both fail: the decision file's fallback, fallback true, error one line without the state", async () => {
    const { fetch } = route(null, null);
    const state = "SECRET-STATE-TEXT";
    const r = await decide(bashGate, state, base({ fetch }));
    expect(r.via).toBe("default");
    expect(r.verdict).toBe(bashGate.fallback);
    expect(r.fallback).toBe(true);
    expect(r.costUsd).toBe(0);
    expect(r.answers).toBeUndefined();
    expect(r.error).toBe("jev: openrouter HTTP 503.; haiku: anthropic HTTP 400");
    expect(r.error).not.toContain(state);
    expect(r.error).not.toContain("\n");
  });

  test("no classifier configured is refused", async () => {
    await expect(
      decide(bashGate, "ls", base({ jev: { enabled: false, public: true, apiKey: undefined }, haiku: { enabled: false, apiKey: undefined } })),
    ).rejects.toThrow("decision bash-gate has no classifier: turn the gate off in policy/gates.yaml instead");
  });

  test("an unset key is an error, not a fallback to another name", async () => {
    const { fetch, seen } = route(null, haikuReply(bashHaikuAnswers(0, 0)));
    const r = await decide(bashGate, "ls", base({ fetch, jev: { enabled: false, public: true, apiKey: undefined }, haiku: { enabled: true, apiKey: undefined } }));
    expect(r.via).toBe("default");
    expect(r.error).toBe("ANTHROPIC_API_KEY is not set");
    expect(seen).toHaveLength(0);
  });

  test("an unset Jev key falls to Haiku and names the variable", async () => {
    const { fetch, seen } = route(null, haikuReply(bashHaikuAnswers(0, 0)));
    const r = await decide(bashGate, "ls", base({ fetch, jev: { enabled: true, public: true, apiKey: undefined } }));
    expect(seen.some(isOpenrouter)).toBe(false);
    expect(r.via).toBe("haiku");
    expect(r.fallback).toBe(true);
    expect(r.error).toBe("HAPI_JEV_OPENROUTER_API_KEY is not set");
  });

  test("Jev only, and the repo isn't public: the default, saying why", async () => {
    const { fetch, seen } = route(null, null);
    const r = await decide(bashGate, "ls", base({ fetch, jev: { enabled: true, public: false, apiKey: FAKE_JEV_KEY }, haiku: { enabled: false, apiKey: undefined } }));
    expect(seen).toHaveLength(0);
    expect(r.via).toBe("default");
    expect(r.error).toBe("jev answers public repos only and this run is not marked public");
  });

  test("over-cap state takes the decision file's fallback, sends nothing, and is marked truncated", async () => {
    const { fetch, seen } = route(jevReply({ irreversible: 0, destructive: 0 }), haikuReply(bashHaikuAnswers(0, 0)));
    for (const state of ["a".repeat(6001), { cmd: "x".repeat(6000) }]) {
      const r = await decide(bashGate, state, base({ fetch }));
      expect(r.verdict).toBe(bashGate.fallback);
      expect(r.via).toBe("default");
      expect(r.fallback).toBe(true);
      expect(r.truncated).toBe(true);
      expect(r.costUsd).toBe(0);
      expect(r.answers).toBeUndefined();
    }
    expect(seen).toHaveLength(0);
    const m = await decide(bashGate, "a".repeat(6001), base({ fetch, mock: true }));
    expect(m.truncated).toBe(true);
  });

  test("state at exactly the cap is sent whole", async () => {
    const state = "\u2603".repeat(6000);
    const count = (s: string) => [...s].filter((c) => c === "\u2603").length;
    const j = route(jevReply({ irreversible: 0, destructive: 0 }), null);
    const r = await decide(bashGate, state, base({ fetch: j.fetch }));
    expect(r.truncated).toBeUndefined();
    expect(count(j.seen[0]!.body.state)).toBe(6000);
    const h = route(null, haikuReply(bashHaikuAnswers(0, 0)));
    await decide(bashGate, state, base({ fetch: h.fetch }));
    expect(count(h.seen.find((s) => !isOpenrouter(s))!.body.messages[0].content)).toBe(6000);
  });

  test("a malformed key is reported by name and never sent or echoed", async () => {
    const { fetch, seen } = route(jevReply({ irreversible: 0, destructive: 0 }), haikuReply(bashHaikuAnswers(0, 0)));
    for (const bad of ["bad\nkey-VALUE", "has space", "   ", "caf\u00e9", "nul\u0000key"]) {
      const r = await decide(bashGate, "ls", base({ fetch, jev: { enabled: true, public: true, apiKey: bad }, haiku: { enabled: true, apiKey: bad } }));
      expect(r.via).toBe("default");
      expect(r.error).toBe("HAPI_JEV_OPENROUTER_API_KEY is malformed; ANTHROPIC_API_KEY is malformed");
    }
    expect(seen).toHaveLength(0);
  });

  test("an unknown error is reported by its name only, never its message", async () => {
    const boom = (async () => {
      throw new TypeError('Headers.append: "Bearer QUOTED-SECRET" is an invalid header value');
    }) as unknown as typeof fetch;
    const r = await decide(bashGate, "ls", base({ fetch: boom }));
    expect(r.error).not.toContain("QUOTED-SECRET");
    expect(r.via).toBe("default");
  });

  test("state is never logged", async () => {
    const { fetch } = route(null, null);
    const logged: string[] = [];
    const orig = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      const r = await decide(bashGate, "STATE-MARKER-123", base({ fetch }));
      expect(r.error).not.toContain("STATE-MARKER-123");
    } finally {
      [console.log, console.error, console.warn] = orig as [typeof console.log, typeof console.error, typeof console.warn];
    }
    expect(logged.join("\n")).not.toContain("STATE-MARKER-123");
  });

  test("mock answers offline, calling nothing", async () => {
    const { fetch, seen } = route(null, null);
    const r = await decide(bashGate, "ls -la", base({ fetch, mock: true, jev: { enabled: false, public: false, apiKey: undefined }, haiku: { enabled: false, apiKey: undefined } }));
    expect(r.via).toBe("mock");
    expect(r.costUsd).toBe(0);
    expect(r.fallback).toBe(false);
    expect(seen).toHaveLength(0);
    expect(["allow", "flag", "block"]).toContain(r.verdict);
  });

  test("a bad Jev reply is a contract error, then Haiku", async () => {
    const { fetch } = route(json({ model: "jev", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), haikuReply(bashHaikuAnswers(0, 0)));
    const r = await decide(bashGate, "ls", base({ fetch }));
    expect(r.via).toBe("haiku");
    expect(r.error).toStartWith("jev: Missing or mismatched answer");
  });
});
