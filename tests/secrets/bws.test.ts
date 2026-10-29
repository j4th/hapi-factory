import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretError } from "../../src/secrets/provider";
import { type BwsRunner, bwsFailure, bwsProvider, isPlaceholderId } from "../../src/secrets/providers/bws";
import { caught } from "./helpers";

// Obviously fake values: none of them is, or looks like, a real credential.
const FAKE = "fake-secret-value-7f3a";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

const savedToken = process.env.BWS_ACCESS_TOKEN;
afterEach(() => {
  if (savedToken === undefined) delete process.env.BWS_ACCESS_TOKEN;
  else process.env.BWS_ACCESS_TOKEN = savedToken;
});

/** A fake bws: `values` maps a secret id to its value; any other id fails as bws does on a 404. Records every call. */
function fakeBws(values: Record<string, string>): { run: BwsRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args);
      const id = args[2]!;
      if (!Object.hasOwn(values, id)) throw new Error("404 Resource not found");
      return JSON.stringify({ object: "secret", id, key: "some-key", value: values[id] });
    },
  };
}

describe("the bws provider (optional)", () => {
  test("calls `bws secret get <id> --output json --color no`, once per id, with ids from bws.ids", async () => {
    const f = fakeBws({ [ID_A]: "k", [ID_B]: "" });
    const p = bwsProvider({ ids: { "hapi-a": ID_A, "hapi-a2": ID_A, "hapi-b": ID_B }, run: f.run });
    expect([p.name, p.downgrade]).toEqual(["bws", false]);
    expect([...(await p.fetch(["hapi-a", "hapi-a2", "hapi-b"]))]).toEqual([
      ["hapi-a", "k"],
      ["hapi-a2", "k"],
      ["hapi-b", ""], // an empty secret comes back as "": resolve calls it empty, check reports it
    ]);
    expect(f.calls).toEqual([
      ["secret", "get", ID_A, "--output", "json", "--color", "no"],
      ["secret", "get", ID_B, "--output", "json", "--color", "no"],
    ]);
    expect(await p.list()).toEqual(["hapi-a", "hapi-a2", "hapi-b"]);
  });

  test("a name with no id in bws.ids is missing, by name, and bws is not called for it", async () => {
    const f = fakeBws({ [ID_A]: "k" });
    const e = await caught(bwsProvider({ ids: { "hapi-a": ID_A }, run: f.run }).fetch(["hapi-a", "hapi-b"]));
    expect(e).toBeInstanceOf(SecretError);
    expect((e as SecretError).missing).toEqual(["hapi-b"]);
    expect(e.message).toBe("bws.ids in your secrets config has no id for hapi-b");
    expect(f.calls).toEqual([]);
  });

  test("a placeholder id fails before bws is called; so does an id that isn't one, which is not echoed", async () => {
    const f = fakeBws({});
    expect(isPlaceholderId("00000000-0000-0000-0000-000000000301")).toBe(true);
    expect(isPlaceholderId(ID_A)).toBe(false);
    await expect(bwsProvider({ ids: { "hapi-a": "00000000-0000-0000-0000-000000000301" }, run: f.run }).fetch(["hapi-a"])).rejects.toThrow(
      /^hapi-a: still a placeholder bws id/,
    );
    for (const id of ["--access-token=x", "", `${FAKE} x`]) {
      const e = await caught(bwsProvider({ ids: { "hapi-a": id }, run: f.run }).fetch(["hapi-a"]));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/^hapi-a: not a bws secret id/);
      if (id !== "") expect(e.message).not.toContain(id);
    }
    expect(f.calls).toEqual([]);
  });

  test("bws's own stderr is scrubbed as sops's is: what follows a colon, which could hold a value, never reaches the error", () => {
    process.env.BWS_ACCESS_TOKEN = "fake-access-token-0b1c";
    const e = bwsFailure(1, `\u001b[31mError:\u001b[0m \n   0: Received error message from server: [400] ${FAKE} is not valid\nLocation: crates/bws/src/main.rs:12\n`);
    expect(e.message).toBe("bws exited with status 1: Error (run the same bws command yourself for its full message)");
    expect(e.message).not.toContain(FAKE);
    // The access token is masked even where scrubToolError keeps the text (before the first colon).
    expect(bwsFailure(2, "Invalid access token fake-access-token-0b1c: rejected").message).toBe(
      "bws exited with status 2: Invalid access token [BWS_ACCESS_TOKEN] (run the same bws command yourself for its full message)",
    );
    expect(bwsFailure(3, "").message).toBe("bws exited with status 3 (run the same bws command yourself for its full message)");
  });

  test("a real-format access token (0.<id>.<secret>:<key>) never survives the scrubbing, whole or in pieces", () => {
    // Built at run time, so no scan of this repo flags the file.
    const alnum = (n: number, seed: number) => Array.from({ length: n }, (_, i) => "abcdefghijkLMNOPQRSTUV0123456789"[(i * 7 + seed) % 32]).join("");
    const [id, secret, key] = ["2a8f3c1e-6b4d-4f7a-9c2e-1d5b8e7f0a3c", alnum(30, 3), alnum(24, 11)];
    process.env.BWS_ACCESS_TOKEN = `0.${id}.${secret}:${key}`;
    for (const stderr of [
      `${process.env.BWS_ACCESS_TOKEN} is not a valid access token`, // the token starts the line, colon and all
      `0.${id}.${secret} could not be parsed`, // the part before the colon on its own
      `Error: bad key ${key}`,
    ]) {
      const m = bwsFailure(1, stderr).message;
      for (const part of [id, secret, key]) expect([stderr, m.includes(part)]).toEqual([stderr, false]);
    }
    expect(bwsFailure(1, `${process.env.BWS_ACCESS_TOKEN} is not a valid access token`).message).toBe(
      "bws exited with status 1: [BWS_ACCESS_TOKEN] is not a valid access token (run the same bws command yourself for its full message)",
    );
  });

  test("a bws failure names the logical name and why, never a value or the access token", async () => {
    process.env.BWS_ACCESS_TOKEN = "fake-access-token-0b1c";
    const failing: BwsRunner = async () => {
      throw new Error("bws exited with status 1: \u001b[31mError:\u001b[0m token fake-access-token-0b1c rejected");
    };
    const e1 = await caught(bwsProvider({ ids: { "hapi-a": ID_A }, run: failing }).fetch(["hapi-a"]));
    expect(e1).toBeInstanceOf(SecretError);
    expect(e1.message).toBe("hapi-a: bws secret get failed: bws exited with status 1: Error: token [BWS_ACCESS_TOKEN] rejected");

    // bws prints something that isn't JSON but holds the value: JSON.parse's own message would quote it.
    const e2 = await caught(bwsProvider({ ids: { "hapi-a": ID_A }, run: async () => `value: ${FAKE}` }).fetch(["hapi-a"]));
    expect(e2.message).toBe("hapi-a: bws printed something that is not JSON (not shown)");
    const e3 = await caught(bwsProvider({ ids: { "hapi-a": ID_A }, run: async () => '{"id":"x"}' }).fetch(["hapi-a"]));
    expect(e3.message).toBe("hapi-a: bws returned no string value");
  });
});

describe("runBws", () => {
  test("with no bws on PATH, it says how to pin one in the global mise config, not in a mise.local.toml the audit refuses", () => {
    // In a child bun whose PATH is an empty dir from the start, so no real bws (or a mise shim for one) can resolve.
    const empty = mkdtempSync(join(tmpdir(), "hapi-no-bws-"));
    try {
      const src = JSON.stringify(join(import.meta.dir, "../../src/secrets/providers/bws.ts"));
      const script = `const { runBws } = await import(${src}); try { await runBws(["--version"]); console.log("ran"); } catch (e) { console.log(e.message); }`;
      const r = Bun.spawnSync([process.execPath, "-e", script], { env: { PATH: empty, HOME: empty }, stdout: "pipe", stderr: "pipe" });
      const out = r.stdout.toString();
      expect(out).toContain("mise use -g bitwarden-secrets-manager@2.1.0");
      expect(out).not.toContain("mise.local.toml");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
