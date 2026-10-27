import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SecretError } from "../../src/secrets/provider";
import { envFileProvider } from "../../src/secrets/providers/env-file";
import { caught, cleanup, tempDir } from "./helpers";

const FAKE = "sk-SECRET-123";

afterEach(cleanup);

function setup(text = `# a plaintext store\nHAPI_A='${FAKE}'\nHAPI_B=''\nHAPI_OLD_KEY='x'\nNOT_HAPI='y'\n`) {
  const dir = tempDir();
  const checkout = tempDir();
  const file = join(dir, "secrets.env");
  writeFileSync(file, text, { mode: 0o600 });
  const provider = envFileProvider({ file, repoRoot: async () => checkout });
  return { dir, checkout, file, provider };
}

describe("the env-file provider", () => {
  test("env-file provider: downgrade, refuses a file inside the checkout or not 0600", async () => {
    const s = setup();
    expect([s.provider.name, s.provider.downgrade]).toEqual(["env-file", true]);
    for (const m of [0o640, 0o644, 0o400, 0o700]) {
      chmodSync(s.file, m);
      const e = await caught(s.provider.fetch(["hapi-a"]));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/env file .*secrets\.env must be mode 0600 \(it is 0\d+\)/);
    }
    chmodSync(s.file, 0o600);
    await expect(envFileProvider({ file: s.file, repoRoot: async () => s.checkout, uid: process.getuid!() + 1 }).fetch(["hapi-a"])).rejects.toThrow(
      /owned by uid \d+, not you/,
    );
    // Inside the checkout, private/ included: plaintext there could be committed, or pushed to the private remote.
    // A first segment that merely starts with ".." ("..plain", "..secrets.env") is still inside.
    for (const rel of ["secrets.env", join("private", "secrets.env"), join("..plain", "secrets.env"), "..secrets.env"]) {
      const inside = join(s.checkout, rel);
      mkdirSync(join(inside, ".."), { recursive: true });
      writeFileSync(inside, "HAPI_A='x'\n", { mode: 0o600 });
      const e = await caught(envFileProvider({ file: inside, repoRoot: async () => s.checkout }).fetch(["hapi-a"]));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/inside the hapi-factory checkout/);
    }
  });

  test("reads NAME='value' lines, where NAME is secretEnvName(logical name); missing names are a SecretError", async () => {
    const s = setup();
    expect([...(await s.provider.fetch(["hapi-a", "hapi-b"]))]).toEqual([
      ["hapi-a", FAKE],
      ["hapi-b", ""],
    ]);
    const e = await caught(s.provider.fetch(["hapi-a", "hapi-c"]));
    expect(e).toBeInstanceOf(SecretError);
    expect((e as SecretError).missing).toEqual(["hapi-c"]);
    expect(e.message).toBe(`${s.file} has no HAPI_C (hapi-c)`);
    expect(e.message).not.toContain(FAKE);
  });

  test("list gives the store's names as logical names where they map back, else as written", async () => {
    expect((await setup().provider.list()).sort()).toEqual(["NOT_HAPI", "hapi-a", "hapi-b", "hapi-old-key"]);
  });

  test("a malformed file names the line, never the text; a missing file says so", async () => {
    const s = setup(`HAPI_A=${FAKE}\n`);
    const e = await caught(s.provider.fetch(["hapi-a"]));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toMatch(/malformed env file at line 1/);
    expect(e.message).not.toContain(FAKE);
    await expect(envFileProvider({ file: join(s.dir, "nope.env"), repoRoot: async () => s.checkout }).fetch(["hapi-a"])).rejects.toThrow(/does not exist/);
  });
});
