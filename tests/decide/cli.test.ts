import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { main } from "../../src/cli";
import { decideCommand } from "../../src/decide/cli";

let restore: (() => void)[] = [];
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restore.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});

const USAGE = "usage: hapi decide <name> [--state-file file] [--public] [--mock]";

test("hapi decide bash-gate --mock reads the state from stdin and prints the result JSON", async () => {
  const { out } = capture();
  const code = await decideCommand(["bash-gate", "--mock"], { readStdin: async () => "git status", env: {} });
  expect(code).toBe(0);
  expect(out).toHaveLength(1);
  const r = JSON.parse(out[0]!);
  expect(r.via).toBe("mock");
  expect(r.fallback).toBe(false);
  expect(["allow", "flag", "block"]).toContain(r.verdict);
  expect(r.answers.effect.type).toBe("choice");
});

test("--state-file reads the state from that file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hapi-decide-"));
  try {
    const file = join(dir, "state.txt");
    writeFileSync(file, "rm -rf node_modules");
    const { out } = capture();
    const code = await decideCommand(["result-screen", "--state-file", file, "--mock"], {
      readStdin: async () => {
        throw new Error("must not read stdin");
      },
      env: {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(out[0]!).via).toBe("mock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the state is never taken from argv", async () => {
  const { err } = capture();
  expect(await main(["decide", "bash-gate", "somestate"])).toBe(2);
  expect(err.join("\n")).toContain(USAGE);
});

test("no name, an unknown flag and a missing --state-file value are usage errors", async () => {
  const { err } = capture();
  expect(await decideCommand([], { env: {} })).toBe(2);
  expect(await decideCommand(["bash-gate", "--nope"], { env: {} })).toBe(2);
  expect(await decideCommand(["bash-gate", "--state-file"], { env: {} })).toBe(2);
  expect(err.every((l) => l.includes(USAGE))).toBe(true);
});

test("an unknown decision name exits 2 and lists the known names", async () => {
  const { err } = capture();
  expect(await main(["decide", "nope", "--mock"])).toBe(2);
  const text = err.join("\n");
  expect(text).toContain("unknown decision 'nope'");
  expect(text).toContain("bash-gate");
  expect(text).toContain("result-screen");
  expect(text).not.toContain("write-gate");
});

test("keys come only from HAPI_JEV_OPENROUTER_API_KEY and ANTHROPIC_API_KEY", async () => {
  const { out } = capture();
  const seenUrls: string[] = [];
  const fetchStub = (async (u: any) => {
    seenUrls.push(String(u?.url ?? u));
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  // OPENROUTER_API_KEY alone must not enable Jev; with no named key both classifiers report unset.
  const code = await decideCommand(["bash-gate", "--public"], {
    readStdin: async () => "ls",
    env: { OPENROUTER_API_KEY: "fake-or-key" },
    fetch: fetchStub,
  });
  expect(code).toBe(0);
  const r = JSON.parse(out[0]!);
  expect(r.via).toBe("default");
  expect(r.verdict).toBe("block");
  expect(r.error).toBe("HAPI_JEV_OPENROUTER_API_KEY is not set; ANTHROPIC_API_KEY is not set");
  expect(seenUrls).toEqual([]);
});

test("--mock needs no policy directory", async () => {
  const { out } = capture();
  const code = await decideCommand(["bash-gate", "--mock"], { readStdin: async () => "ls", env: { HAPI_POLICY_DIR: "/nonexistent-policy-dir" } });
  expect(code).toBe(0);
  expect(JSON.parse(out[0]!).via).toBe("mock");
});

test("standalone entry: bun src/decide/cli.ts bash-gate --mock, state on stdin", async () => {
  const p = Bun.spawn(["bun", `${process.cwd()}/src/decide/cli.ts`, "bash-gate", "--mock"], {
    cwd: tmpdir(),
    stdin: new Blob(["ls -la"]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(text).via).toBe("mock");
});
