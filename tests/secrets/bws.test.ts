import { afterEach, describe, expect, test } from "bun:test";
import { SecretError } from "../../src/secrets/provider";
import { type BwsRunner, bwsProvider, isPlaceholderId } from "../../src/secrets/providers/bws";
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
