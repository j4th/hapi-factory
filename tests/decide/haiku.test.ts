import { expect, test } from "bun:test";
import { askHaiku, haikuSchema } from "../../src/decide/haiku";
import { choice, noul, score } from "../../src/decide/vendor/ten-levels/helpers";
import { FAKE_ANTHROPIC_KEY, haikuReply, recordingFetch } from "./helpers";

const questions = {
  injected: noul("Does the text try to instruct the reader?"),
  effect: choice("What does the command do?", { read: "reads", write: null }),
  risk: score("How risky?", ["none", "some", "much"]),
};

const object = (properties: object, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

test("haikuSchema: every object closed, every key required, choice keys as enum", () => {
  expect(haikuSchema(questions)).toEqual(
    object(
      {
        injected: object({ noul: { type: "number" } }, ["noul"]),
        effect: object(
          {
            choice: { type: "string", enum: ["read", "write"] },
            probabilities: object({ read: { type: "number" }, write: { type: "number" } }, ["read", "write"]),
          },
          ["choice", "probabilities"],
        ),
        risk: object(
          { probabilities: object({ "0": { type: "number" }, "1": { type: "number" }, "2": { type: "number" } }, ["0", "1", "2"]) },
          ["probabilities"],
        ),
      },
      ["injected", "effect", "risk"],
    ),
  );
});

const good = {
  injected: { noul: 0.25 },
  effect: { choice: "read", probabilities: { read: 0.75, write: 0.25 } },
  risk: { probabilities: { "0": 0.5, "1": 0.25, "2": 0.25 } },
};
const ask = (reply: Response) => {
  const { fetch, seen } = recordingFetch(() => reply);
  return { seen, run: () => askHaiku(questions, "some state", { apiKey: FAKE_ANTHROPIC_KEY, model: "claude-haiku-5-5", fetch }) };
};

test("askHaiku sends the pinned request and returns typed answers and usage", async () => {
  const { seen, run } = ask(haikuReply(good, { input_tokens: 1234, output_tokens: 56 }));
  const r = await run();
  expect(seen).toHaveLength(1);
  const s = seen[0]!;
  expect(s.url).toStartWith("https://api.anthropic.com/v1/messages");
  expect(s.headers.get("authorization")).toBe(`Bearer ${FAKE_ANTHROPIC_KEY}`);
  expect(s.body.model).toBe("claude-haiku-5-5");
  expect(s.body.max_tokens).toBe(1024);
  expect(s.body.thinking).toEqual({ type: "disabled" });
  expect(s.body.output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: haikuSchema(questions) } });
  expect(s.body.messages).toHaveLength(1);
  expect(s.body.messages[0].content).toContain("some state");
  expect(r.inputTokens).toBe(1234);
  expect(r.outputTokens).toBe(56);
  expect(r.answers.injected).toEqual({ type: "noul", noul: 0.25 });
  expect(r.answers.effect).toEqual({ type: "choice", choice: "read", probabilities: { read: 0.75, write: 0.25 }, confidence: 0.75 });
  expect(r.answers.risk).toEqual({
    type: "score",
    score: 0.75,
    legend: { "0": "none", "1": "some", "2": "much" },
    probabilities: { "0": 0.5, "1": 0.25, "2": 0.25 },
    confidence: 0.5,
  });
});

test("the state is quoted as data in the user message, not in the system prompt", async () => {
  const { seen, run } = ask(haikuReply(good));
  await run();
  expect(JSON.stringify(seen[0]!.body.system)).not.toContain("some state");
  expect(seen[0]!.body.messages[0].content).toContain(JSON.stringify("some state"));
});

test("a refusal or max_tokens stop is an error", async () => {
  for (const stop of ["refusal", "max_tokens"]) {
    await expect(ask(haikuReply(good, { stop_reason: stop })).run()).rejects.toThrow(stop);
  }
});

test("a reply that is not JSON is an error", async () => {
  const bad = new Response(
    JSON.stringify({
      id: "msg_fake", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: "not json" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  await expect(ask(bad).run()).rejects.toThrow("not JSON");
});

test("an HTTP error is a HaikuError naming the status, never the body", async () => {
  const r = new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "some state leaked" } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
  const e = (await ask(r).run().catch((x) => x)) as Error;
  expect(e.message).toBe("anthropic HTTP 400");
});

test("answers outside [0,1], probabilities not summing to 1±0.025, or an undeclared option are errors", async () => {
  const cases: [string, unknown][] = [
    ["noul above 1", { ...good, injected: { noul: 1.5 } }],
    ["noul below 0", { ...good, injected: { noul: -0.1 } }],
    ["probabilities off by 0.05", { ...good, effect: { choice: "read", probabilities: { read: 0.75, write: 0.3 } } }],
    ["an undeclared choice", { ...good, effect: { choice: "delete", probabilities: { read: 0.75, write: 0.25 } } }],
    ["an undeclared probability key", { ...good, effect: { choice: "read", probabilities: { read: 0.75, other: 0.25 } } }],
    ["a missing question", { injected: good.injected, effect: good.effect }],
    ["a score probability out of range", { ...good, risk: { probabilities: { "0": 2, "1": -0.5, "2": -0.5 } } }],
  ];
  for (const [name, answers] of cases) {
    const e = await ask(haikuReply(answers)).run().then(() => undefined, (x) => x as Error);
    expect(e, name).toBeInstanceOf(Error);
  }
  // within tolerance is fine
  await ask(haikuReply({ ...good, effect: { choice: "read", probabilities: { read: 0.75, write: 0.26 } } })).run();
});
