import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JevClient } from "../../src/decide/vendor/ten-levels/client";

const dir = "src/decide/vendor/ten-levels";
const sha256 = (file: string): string => createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");

test("the vendored files match SOURCE.md", () => {
  const source = readFileSync(join(dir, "SOURCE.md"), "utf8");
  const rows = [...source.matchAll(/^\| (\S+) \| `([0-9a-f]{64})` \| `([0-9a-f]{64})` \|$/gm)];
  expect(rows.map((r) => r[1]).sort()).toEqual(["LICENSE", "client.ts", "helpers.ts", "mock.ts", "types.ts"]);
  for (const [, file, , patched] of rows) expect(sha256(file as string)).toBe(patched as string);
  expect(source).toContain("777adaf47d37ae0553220d35b2f15b3a3a063305");
  expect(source).toContain("sharedJev()");
});

test("the unpatched files are byte-identical to upstream", () => {
  const source = readFileSync(join(dir, "SOURCE.md"), "utf8");
  for (const [, file, original, patched] of source.matchAll(/^\| (\S+) \| `([0-9a-f]{64})` \| `([0-9a-f]{64})` \|$/gm)) {
    if (file === "client.ts" || file === "mock.ts") expect(patched).not.toBe(original);
    else expect(patched).toBe(original);
  }
});

test("the license keeps its copyright line", () => {
  expect(readFileSync(join(dir, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 IndyDevDan / AgenticEngineer.com");
});

test("the client never reads a key from the environment", () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "fake-or-key";
  try {
    expect(() => new JevClient({ provider: "openrouter" })).toThrow("needs a nonblank apiKey");
    expect(() => new JevClient({ provider: "openrouter", apiKey: "   " })).toThrow("needs a nonblank apiKey");
  } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});
