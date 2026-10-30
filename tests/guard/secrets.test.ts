/**
 * Rule 6 (secrets in writes, the write gate's local half) and rule 8 (the
 * shell's environment). Every key-shaped sample is built at run time, never
 * written as a literal, so the pre-commit gitleaks scan passes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KEY_PATTERNS } from "../../policy/decisions/write-gate";
import { wrapText } from "../../src/guard/gates";
import hapiGuard from "../../src/guard/index";
import { assistant, cleanupAll, FAKE_ENV, FakePi, gatesOff, RUN_ID, setup } from "./harness";

afterEach(cleanupAll);

const pick = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** One sample per KEY_PATTERNS name, assembled from parts and random bytes. */
const SAMPLES: Record<string, string> = {
  anthropic: ["sk", "ant", pick(ALNUM, 24)].join("-"),
  openrouter: ["sk", "or", "v1", pick("0123456789abcdef", 64)].join("-"),
  "github-token": "gh" + "p_" + pick(ALNUM, 36),
  "github-pat": "github" + "_pat_" + pick(ALNUM, 60),
  slack: ["xo" + "xb", pick("0123456789", 10), pick(ALNUM, 8)].join("-"),
  "aws-key-id": "AK" + "IA" + pick(UPPER, 16),
  "private-key": "-----BEGIN " + "RSA PRIVATE KEY-----",
  "age-key": "AGE-SECRET-" + "KEY-1" + pick(UPPER, 58),
};

describe("writes (rule 6)", () => {
  test("a write or edit whose new text holds an exact secret value blocks with secret: <NAME>", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    expect(await h.tool("write", { path: "notes.md", content: `token=${FAKE_ENV.OPENCODE_API_KEY}\n` })).toEqual({
      block: true,
      reason: "hapi-guard: the content holds the value of OPENCODE_API_KEY; secrets never go into files (rule secret, secret: OPENCODE_API_KEY)",
    });
    const e = await h.tool("edit", { path: "notes.md", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: `x${FAKE_ENV.HAPI_JEV_OPENROUTER_API_KEY}` }] });
    expect(e?.reason).toContain("secret: HAPI_JEV_OPENROUTER_API_KEY");
    expect(h.log().filter((r) => r.rule === "secret").map((r) => [r.tool, r.secret])).toEqual([
      ["write", "OPENCODE_API_KEY"],
      ["edit", "HAPI_JEV_OPENROUTER_API_KEY"],
    ]);
    // The old text is what is already there: only the new text is checked.
    expect(await h.tool("edit", { path: "notes.md", edits: [{ oldText: FAKE_ENV.CLAUDE_API_KEY, newText: "redacted" }] })).toBeUndefined();
  });

  test("a write or edit whose path holds a secret value or a key-shaped string blocks: a secret never becomes a file name", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    expect(await h.tool("write", { path: `notes-${SAMPLES["github-token"]}.md`, content: "x" })).toEqual({
      block: true,
      reason: "hapi-guard: the path holds a key shaped like github-token (rule secret, secret: github-token)",
    });
    const e = await h.tool("edit", { path: `src/${FAKE_ENV.CLAUDE_API_KEY}/a.ts`, edits: [{ oldText: "a", newText: "b" }] });
    expect(e?.reason).toBe("hapi-guard: the path holds the value of CLAUDE_API_KEY (rule secret, secret: CLAUDE_API_KEY)");
    // The path is checked before rule 1, so even a path outside the worktree is reported as a secret, and never logged as one.
    expect((await h.tool("write", { path: `/etc/${FAKE_ENV.OPENCODE_API_KEY}`, content: "x" }))?.reason).toContain("secret: OPENCODE_API_KEY");
    const blocks = h.log().filter((r) => r.rule === "secret");
    expect(blocks.map((r) => [r.tool, r.secret, "path" in r])).toEqual([
      ["write", "github-token", false],
      ["edit", "CLAUDE_API_KEY", false],
      ["write", "OPENCODE_API_KEY", false],
    ]);
  });

  test("each KEY_PATTERNS sample blocks with secret: <pattern name>", async () => {
    expect(Object.keys(SAMPLES)).toEqual(KEY_PATTERNS.map((k) => k.name));
    const h = setup({ settings: gatesOff });
    await h.start();
    for (const [name, sample] of Object.entries(SAMPLES)) {
      const r = await h.tool("write", { path: "config.txt", content: `value: ${sample}\n` });
      expect([name, r?.block, r?.reason?.includes(`secret: ${name})`)]).toEqual([name, true, true]);
    }
  });
});

test("a bash command holding a secret value, or a key-shaped string, blocks", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const r = await h.tool("bash", { command: `curl -H "x-api-key: ${FAKE_ENV.ANTHROPIC_API_KEY}" https://example.invalid` });
  expect(r).toEqual({ block: true, reason: "hapi-guard: the command holds the value of ANTHROPIC_API_KEY (rule secret, secret: ANTHROPIC_API_KEY)" });
  expect((await h.tool("bash", { command: `echo ${SAMPLES["github-token"]} > t` }))?.reason).toContain("secret: github-token");
});

test("no record or reason holds a value", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const reasons: string[] = [];
  for (const value of Object.values(FAKE_ENV)) {
    for (const r of [
      await h.tool("write", { path: `notes-${value}.md`, content: value }),
      await h.tool("write", { path: `/etc/${value}`, content: "x" }),
      await h.tool("bash", { command: `echo ${value}` }),
      await h.tool("edit", { path: "AGENTS.md", edits: [{ oldText: "a", newText: value }] }),
      // A name the guard logs as given (the tool field and the unknown-tool reason), so the log's scrub is what keeps it out.
      await h.tool(`tool-${value}`, {}),
    ]) if (r?.reason) reasons.push(r.reason);
    await h.result("bash", [{ type: "text", text: `out ${value} out` }]);
  }
  expect(reasons.length).toBe(20);
  const log = readFileSync(join(h.out, "decisions.jsonl"), "utf8");
  for (const value of Object.values(FAKE_ENV)) {
    expect(log.includes(value)).toBe(false);
    expect(reasons.some((r) => r.includes(value))).toBe(false);
  }
  expect(log).toContain("[hapi: OPENCODE_API_KEY redacted]");
});

describe("the shell's environment (rule 8): neither the delete nor the unset is a boundary", () => {
  test("a bash tool_call's command is prefixed with unset <secret_env>", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    const input = { command: "env | sort" };
    expect(await h.tool("bash", input)).toBeUndefined();
    expect(input.command).toBe("unset ANTHROPIC_API_KEY CLAUDE_API_KEY HAPI_JEV_OPENROUTER_API_KEY OPENCODE_API_KEY; env | sort");
  });

  test("GIT_CONFIG_KEY_n and BUN_OPTIONS are never deleted or unset", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    expect([h.env.GIT_CONFIG_COUNT, h.env.GIT_CONFIG_KEY_0, h.env.GIT_CONFIG_VALUE_0, h.env.BUN_OPTIONS]).toEqual(["1", "core.hooksPath", "/dev/null", "--no-install"]);
    const input = { command: "git status" };
    await h.tool("bash", input);
    expect(input.command).not.toMatch(/GIT_CONFIG|BUN_OPTIONS/);
  });

  test("the factory deletes every secret_env name from the env it is given, after copying the values its classifiers need", () => {
    const h = setup({ settings: gatesOff });
    for (const name of Object.keys(FAKE_ENV)) expect([name, name in h.env]).toEqual([name, false]);
    expect(h.env.PATH).toBe("/usr/bin:/bin");
  });

  test("the default export scrubs the guard's own process.env", async () => {
    const h = setup({ settings: gatesOff }); // only for its files
    const saved = { ...process.env };
    try {
      Object.assign(process.env, { ...FAKE_ENV, PI_CODING_AGENT_DIR: h.agentDir, WORKFLOW_ID: "wf-x", ARCHON_NODE_EXECUTION: h.env.ARCHON_NODE_EXECUTION, GIT_CONFIG_KEY_0: "core.hooksPath" });
      hapiGuard(new FakePi() as any);
      for (const name of Object.keys(FAKE_ENV)) expect([name, process.env[name]]).toEqual([name, undefined]);
      expect(process.env.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

test("tool_result text holding a secret value is redacted to [hapi: <NAME> redacted] before the model sees it", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const r = await h.result("bash", [{ type: "text", text: `ANTHROPIC_API_KEY=${FAKE_ENV.ANTHROPIC_API_KEY}\nok` }], {
    structuredContent: { output: `ANTHROPIC_API_KEY=${FAKE_ENV.ANTHROPIC_API_KEY}\nok`, exit_code: 0 },
  });
  expect(r).toEqual({
    content: [{ type: "text", text: "ANTHROPIC_API_KEY=[hapi: ANTHROPIC_API_KEY redacted]\nok" }],
    structuredContent: { output: "ANTHROPIC_API_KEY=[hapi: ANTHROPIC_API_KEY redacted]\nok", exit_code: 0 },
  });
  const rec = h.log().at(-1);
  expect([rec.event, rec.decision, rec.rule, rec.secret]).toEqual(["tool_result", "flag", "secret-redacted", "ANTHROPIC_API_KEY"]);
  expect(await h.result("read", [{ type: "text", text: "nothing secret" }])).toBeUndefined();
});

test("a key-shaped string is redacted to [hapi: <pattern name> redacted], in tool results and records, and logged like a value", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const token = SAMPLES["github-token"]!;
  const aws = SAMPLES["aws-key-id"]!;
  const r = await h.result("read", [{ type: "text", text: `GH=${token}\nAWS=${aws} ${FAKE_ENV.CLAUDE_API_KEY}` }], { structuredContent: { text: token } });
  expect(r).toEqual({
    content: [{ type: "text", text: "GH=[hapi: github-token redacted]\nAWS=[hapi: aws-key-id redacted] [hapi: CLAUDE_API_KEY redacted]" }],
    structuredContent: { text: "[hapi: github-token redacted]" },
  });
  const recs = h.log().filter((x) => x.rule === "secret-redacted");
  expect(recs.map((x) => [x.event, x.decision, x.secret, x.reason])).toEqual([
    ["tool_result", "flag", "CLAUDE_API_KEY", "the result held the value of CLAUDE_API_KEY; the model sees it redacted"],
    ["tool_result", "flag", "aws-key-id", "the result held a key shaped like aws-key-id; the model sees it redacted"],
    ["tool_result", "flag", "github-token", "the result held a key shaped like github-token; the model sees it redacted"],
  ]);
  // A name the guard logs as given is scrubbed of a key shape too.
  await h.tool(`tool-${token}`, {});
  expect(readFileSync(join(h.out, "decisions.jsonl"), "utf8").includes(token)).toBe(false);
});

test("a private key is redacted whole, from its BEGIN line to its END line, or to the end of the text, marked so, with no END line (ledger 168)", async () => {
  const h = setup({ settings: gatesOff });
  await h.start();
  const body = Array.from({ length: 4 }, () => randomBytes(48).toString("base64"));
  const begin = "-----BEGIN " + "RSA PRIVATE KEY-----";
  const end = "-----END " + "RSA PRIVATE KEY-----";
  const NO_END = "[hapi: private-key redacted to the end of the text: no END line]";
  const outs: string[] = [];
  const check = async (t: string, want: string) => {
    const r = (await h.result("read", [{ type: "text", text: t }])) as { content: { text: string }[] };
    outs.push(r.content[0]!.text);
    expect(r.content[0]!.text).toBe(want);
  };
  await check(`before\n${begin}\n${body.join("\n")}\n${end}\nafter`, "before\n[hapi: private-key redacted]\nafter");
  // With no END line the span runs to the end of the text, prose and all, and the marker says so: fail-closed.
  await check(`x ${begin}\n${body.slice(0, 2).join("\n")}\nprose after it goes too`, `x ${NO_END}`);
  // Two blocks are each redacted, and the text between them stays.
  await check(`${begin}\n${body[0]}\n${end}\nkeep this\n${begin}\n${body[1]}\n${end}\ntail`, "[hapi: private-key redacted]\nkeep this\n[hapi: private-key redacted]\ntail");
  // A service-account JSON file: the key is one string, its newlines escaped as \n.
  const json = (key: string) => JSON.stringify({ type: "service_account", private_key: key, client_email: "x@example.invalid" });
  await check(json(`${begin}\n${body.join("\n")}\n${end}\n`), json("[hapi: private-key redacted]\n"));
  // An indented YAML block scalar, and CRLF line ends with trailing spaces.
  await check(`key: |\n  ${begin}\n${body.map((l) => `  ${l}`).join("\n")}\n  ${end}\nnext: 1`, "key: |\n  [hapi: private-key redacted]\nnext: 1");
  await check(`${begin}  \r\n${body.map((l) => `${l} `).join("\r\n")}\r\n${end}\r\nok`, "[hapi: private-key redacted]\r\nok");
  // The truncating redaction is recorded like any other.
  const recs = h.log().filter((r) => r.rule === "secret-redacted");
  expect(recs.map((r) => r.secret)).toEqual(Array(outs.length).fill("private-key"));
  const shown = outs.join("\n") + readFileSync(join(h.out, "decisions.jsonl"), "utf8");
  for (const line of body) expect(shown.includes(line)).toBe(false);
  // Finding one still needs only the BEGIN line: a write that holds the block blocks.
  expect((await h.tool("write", { path: "notes.txt", content: `${begin}\n${body[0]}\n${end}\n` }))?.reason).toContain("secret: private-key");
  expect((await h.tool("bash", { command: `printf '%s' '${begin}'` }))?.reason).toContain("secret: private-key");
});

describe("a tool_result whose bookkeeping throws still returns its redaction (final review A-1)", () => {
  test("an unwritable ledger: the result is redacted, and the next tool call, send and turn end fail", async () => {
    const h = setup({ settings: gatesOff });
    await h.start();
    const dir = join(h.ledgerDir, RUN_ID);
    chmodSync(dir, 0o500);
    try {
      const r = await h.result("bash", [{ type: "text", text: `ANTHROPIC_API_KEY=${FAKE_ENV.ANTHROPIC_API_KEY}` }]);
      expect(r).toEqual({ content: [{ type: "text", text: "ANTHROPIC_API_KEY=[hapi: ANTHROPIC_API_KEY redacted]" }] });
      expect((await h.tool("bash", { command: "ls" }))?.reason).toStartWith("hapi-guard: an earlier tool result's bookkeeping failed");
      await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow("EACCES");
      await expect(h.fire("turn_end", { turnIndex: 0, message: { role: "assistant" } })).rejects.toThrow("EACCES");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  const HELD = "an error is held, so the node fails at its next send: the result screen was not asked, and the result takes its fallback, wrap";
  const gates = (h: ReturnType<typeof setup>) => h.log().filter((x) => x.event === "gate").map((x) => [x.decision, x.rule, x.reason, "classifier" in x]);

  test("an unwritable ledger with the result screen on: each result is redacted and wrapped, with no classifier call", async () => {
    const h = setup({ settings: (s) => (s.gates.bash_gate.enabled = false) });
    await h.start();
    const dir = join(h.ledgerDir, RUN_ID);
    chmodSync(dir, 0o500);
    try {
      const r = await h.result("bash", [{ type: "text", text: `ANTHROPIC_API_KEY=${FAKE_ENV.ANTHROPIC_API_KEY}` }], { structuredContent: { output: "x" } });
      expect(r).toEqual({ content: [{ type: "text", text: wrapText("ANTHROPIC_API_KEY=[hapi: ANTHROPIC_API_KEY redacted]") }] });
      // One with nothing to redact is wrapped too, never passed on unscreened.
      expect(await h.result("read", [{ type: "text", text: "plain text" }])).toEqual({ content: [{ type: "text", text: wrapText("plain text") }] });
      expect(gates(h)).toEqual([["wrap", "result-screen", HELD, false], ["wrap", "result-screen", HELD, false]]);
      await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow("EACCES");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a spent hard budget: the result is redacted and wrapped (not screened), and the next send fails", async () => {
    const h = setup({ run: (r) => (r.budget_usd = 0.01) });
    await h.start();
    h.entries.push(assistant(0.02));
    const r = await h.result("read", [{ type: "text", text: `key ${FAKE_ENV.OPENCODE_API_KEY}` }]);
    expect(r).toEqual({ content: [{ type: "text", text: wrapText("key [hapi: OPENCODE_API_KEY redacted]") }] });
    expect(gates(h)).toEqual([["wrap", "result-screen", HELD, false]]);
    await expect(h.fire("before_provider_headers", { headers: {} })).rejects.toThrow("the run's budget of $0.01 is spent ($0.02)");
  });
});
