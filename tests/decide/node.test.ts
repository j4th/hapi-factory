/** The guard and hapi-decide run under node (Bun.build target node), where fetch and Headers are undici's. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("under node, a malformed key never reaches the result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hapi-decide-node-"));
  try {
    const built = await Bun.build({ entrypoints: ["policy/decisions/bash-gate.ts", "src/decide/index.ts"], root: ".", outdir: dir, target: "node", format: "esm" });
    expect(built.success).toBe(true);
    const script = join(dir, "run.mjs");
    writeFileSync(
      script,
      `import bashGate from "./policy/decisions/bash-gate.js";
import { decide } from "./src/decide/index.js";
import { readFileSync } from "node:fs";
const gates = JSON.parse(readFileSync(new URL("./gates.json", import.meta.url), "utf8"));
const bad = "bad\\nkey-SECRETVALUE";
const out = [];
for (const o of [
  { jev: { enabled: true, public: true, apiKey: bad }, haiku: { enabled: true, apiKey: bad } },
  { jev: { enabled: false, public: false, apiKey: undefined }, haiku: { enabled: true, apiKey: "fake-key-with-bad-fetch" } },
]) {
  out.push(await decide(bashGate, "ls", { gates, ...o, fetch: async () => { throw new TypeError('Headers.append: "Bearer SECRETVALUE" is an invalid header value'); } }));
}
console.log(JSON.stringify(out));
`,
    );
    writeFileSync(
      join(dir, "gates.json"),
      JSON.stringify({
        bash_gate: { enabled: true, skip_commands: [] },
        result_screen: { enabled: true, tools: ["bash"] },
        max_state_chars: 6000,
        classifiers: {
          jev: { model: "m", unknown_call_usd: 0.001 },
          haiku: { model: "claude-haiku-5-5", input_per_mtok: 0.1, output_per_mtok: 0.5 },
        },
      }),
    );
    const p = Bun.spawn(["node", script], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
    const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(err).not.toContain("SECRETVALUE");
    expect(code).toBe(0);
    expect(text).not.toContain("SECRETVALUE");
    const [a, b] = JSON.parse(text);
    expect(a.error).toBe("HAPI_JEV_OPENROUTER_API_KEY is malformed; ANTHROPIC_API_KEY is malformed");
    expect(b.error).toBe("haiku: anthropic connection error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
