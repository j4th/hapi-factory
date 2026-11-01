/** Shared fixtures for the decide tests: gates, canned Jev and Anthropic replies, a recording fetch. */
import type { Gates } from "../../src/policy/types";
import type { Questions } from "../../src/decide/vendor/ten-levels/types";

export const GATES: Gates = {
  bash_gate: { enabled: true, skip_commands: [] },
  result_screen: { enabled: true, tools: ["bash", "read"] },
  max_state_chars: 6000,
  classifiers: {
    jev: { model: "~typesafe/jev-latest", unknown_call_usd: 0.001 },
    haiku: { model: "claude-haiku-5-5", input_per_mtok: 0.1, output_per_mtok: 0.5 },
  },
};

/** Obviously fake keys: nothing here looks like a real credential. */
export const FAKE_JEV_KEY = "fake-jev-key";
export const FAKE_ANTHROPIC_KEY = "fake-anthropic-key";

export interface Seen {
  url: string;
  headers: Headers;
  body: any;
}

/**
 * A fetch that records each request and answers with `reply(seen)`. The Anthropic
 * SDK calls it with a Request-like init; Jev's client calls it with (url, init).
 */
export function recordingFetch(reply: (seen: Seen) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = init?.body === undefined || init.body === null ? "" : String(init.body);
    const s: Seen = { url, headers: new Headers(init?.headers), body: text ? JSON.parse(text) : undefined };
    seen.push(s);
    return reply(s);
  }) as typeof fetch;
  return { fetch: f, seen };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Jev (System One) reply for the bash-gate questions. */
export function jevReply(opts: { irreversible: number; destructive: number; cost?: number }): Response {
  const i = opts.irreversible;
  return json({
    model: "jev-1.13.0",
    answers: {
      effect: {
        type: "choice",
        choice: i >= 0.5 ? "irreversible" : "read_only",
        probabilities: { read_only: 1 - i, reversible: 0, irreversible: i },
        confidence: 0.9,
      },
      destructive_intent: { type: "noul", noul: opts.destructive },
    },
    usage: { input_tokens: 100, output_tokens: 20, ...(opts.cost === undefined ? {} : { cost: opts.cost }) },
  });
}

/** An Anthropic Messages reply holding `answers` as the JSON text block. */
export function haikuReply(
  answers: unknown,
  extra: { stop_reason?: string; input_tokens?: number; output_tokens?: number } = {},
): Response {
  return json({
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(answers) }],
    stop_reason: extra.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: extra.input_tokens ?? 1000, output_tokens: extra.output_tokens ?? 200 },
  });
}

/** The bash-gate's questions answered by Haiku. */
export const bashHaikuAnswers = (irreversible: number, destructive: number) => ({
  effect: { choice: "irreversible", probabilities: { read_only: 1 - irreversible, reversible: 0, irreversible } },
  destructive_intent: { noul: destructive },
});

export const isOpenrouter = (s: Seen): boolean => new URL(s.url).host === "openrouter.ai";

export type { Questions };
