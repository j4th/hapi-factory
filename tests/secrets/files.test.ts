import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envFileText, parseEnvFile, runtimeDir, writeSecretFiles } from "../../src/secrets/files";

const FAKE = "fake-secret-value-7f3a";

let temps: string[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  temps = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-files-"));
  temps.push(dir);
  return dir;
}

describe("env files", () => {
  test("envFileText writes NAME='value' lines under a comment header, sorted by name, and parseEnvFile reads them back", () => {
    const text = envFileText("hermes", { SLACK_BOT_TOKEN: "b", ANTHROPIC_API_KEY: "a\nb" });
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("ANTHROPIC_API_KEY='a\nb'\nSLACK_BOT_TOKEN='b'\n");
    expect(parseEnvFile(text)).toEqual({ ANTHROPIC_API_KEY: "a\nb", SLACK_BOT_TOKEN: "b" });
  });

  test("envFileText refuses a value with a single quote or NUL, naming the key, never the value", () => {
    expect(() => envFileText("archon", { OPENCODE_API_KEY: `${FAKE}'x` })).toThrow(/archon\/OPENCODE_API_KEY: .*single quote/);
    expect(() => envFileText("archon", { OPENCODE_API_KEY: `${FAKE}\0` })).toThrow(/archon\/OPENCODE_API_KEY: .*NUL/);
    try {
      envFileText("archon", { OPENCODE_API_KEY: `${FAKE}'x` });
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE);
    }
  });

  test("parseEnvFile refuses anything but comments, blank lines and NAME='value', and never echoes the file", () => {
    for (const bad of [`A=${FAKE}\n`, `A='${FAKE}`, `A='x' ${FAKE}\n`, `A='x'\nA='y'\n`, `a='${FAKE}'\n`]) {
      let message = "";
      try {
        parseEnvFile(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/env file/);
      expect(message).not.toContain(FAKE);
    }
  });
});

describe("writeSecretFiles", () => {
  test("writes every file with mode 0600 and leaves no temp file", async () => {
    const dir = tempDir();
    await writeSecretFiles({ [join(dir, "a.env")]: "A='1'\n", [join(dir, "b.env")]: "B='2'\n" });
    expect(readdirSync(dir).sort()).toEqual(["a.env", "b.env"]);
    for (const f of ["a.env", "b.env"]) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "b.env"), "utf8")).toBe("B='2'\n");
  });

  test("replaces an existing file in one step", async () => {
    const dir = tempDir();
    const file = join(dir, "a.env");
    await writeSecretFiles({ [file]: "A='old'\n" });
    await writeSecretFiles({ [file]: "A='new'\n" });
    expect(readFileSync(file, "utf8")).toBe("A='new'\n");
    expect(readdirSync(dir)).toEqual(["a.env"]);
  });

  test("if one file can't be written, none is, and no temp file is left", async () => {
    const dir = tempDir();
    await expect(writeSecretFiles({ [join(dir, "a.env")]: "A='1'\n", [join(dir, "missing", "b.env")]: "B='2'\n" })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("runtimeDir", () => {
  test("is $XDG_RUNTIME_DIR/hapi, and there is no fallback", () => {
    expect(runtimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/hapi");
    expect(() => runtimeDir({})).toThrow(/XDG_RUNTIME_DIR is not set/);
    expect(() => runtimeDir({ XDG_RUNTIME_DIR: "" })).toThrow(/XDG_RUNTIME_DIR is not set/);
    expect(() => runtimeDir({ XDG_RUNTIME_DIR: "run/user/1000" })).toThrow(/XDG_RUNTIME_DIR must be an absolute path/);
  });
});
