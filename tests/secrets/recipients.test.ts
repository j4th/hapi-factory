import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyError } from "../../src/policy/load";
import { SecretError } from "../../src/secrets/provider";
import {
  loadRecipients,
  machineName,
  parseRecipients,
  recipientProblems,
  recipientsPath,
  recipientsText,
  recipientType,
  recoveryDigest,
  recoveryPath,
  shortRecipient,
  storeRecipients,
} from "../../src/secrets/recipients";
import { caught, cleanup, FAKE_RECOVERY_AGE, fakeRecipient, recipientsFileText, sopsFileText, tempDir } from "./helpers";

afterEach(cleanup);

const A = fakeRecipient(10);
const B = fakeRecipient(11);
const R = fakeRecipient(12);
const CLASSIC = fakeRecipient(13, false);

describe("the recipients file", () => {
  test("sits beside the store, at the same basename stem, with recovery.age", () => {
    expect(recipientsPath("/p/private/secrets.enc.yaml")).toBe("/p/private/secrets.recipients.yaml");
    expect(recipientsPath("/p/store.yaml")).toBe("/p/store.recipients.yaml");
    expect(recipientsPath("/p/store.enc.yml")).toBe("/p/store.recipients.yaml");
    expect(recoveryPath("/p/private/secrets.enc.yaml")).toBe("/p/private/recovery.age");
  });

  test("recipient forms: post-quantum (age1pq1, 1959 characters) or classic X25519 (age1, 62); anything else is neither", () => {
    expect(A.length).toBe(1959);
    expect(recipientType(A)).toBe("pq");
    expect(recipientType(CLASSIC)).toBe("classic");
    for (const bad of ["age1", `${A}q`, A.slice(0, -1), A.toUpperCase(), `${CLASSIC}q`, "age1tag1qqqq", "ssh-ed25519 AAAA", `${CLASSIC.slice(0, -1)}b`]) {
      expect([bad.slice(0, 12), recipientType(bad)]).toEqual([bad.slice(0, 12), undefined]);
    }
    expect(shortRecipient(A)).toBe(`${A.slice(0, 16)}…${A.slice(-8)}`);
    expect(shortRecipient(CLASSIC)).toBe(`${CLASSIC.slice(0, 16)}…${CLASSIC.slice(-8)}`);
  });

  test("is schema-checked: names, kinds, unique names and recipients, and every recipient of the file's kind (PQ by default)", () => {
    const good = recipientsFileText([
      { name: "laptop-user", kind: "machine", recipient: A },
      { name: "recovery", kind: "recovery", recipient: R },
    ]);
    expect(parseRecipients(good, "/r.yaml")).toEqual({
      pq: true,
      recipients: [
        { name: "laptop-user", kind: "machine", recipient: A, added: "2026-10-26" },
        { name: "recovery", kind: "recovery", recipient: R, added: "2026-10-26", recovery_age_sha256: recoveryDigest(FAKE_RECOVERY_AGE) },
      ],
    });
    const problem = (text: string) => {
      try {
        parseRecipients(text, "/r.yaml");
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    };
    // Schema: a bad name, kind or date; an unknown key.
    expect(problem(recipientsFileText([{ name: "Laptop", kind: "machine", recipient: A }]))).toBeInstanceOf(PolicyError);
    expect(problem(recipientsFileText([{ name: "-x", kind: "machine", recipient: A }]))).toBeInstanceOf(PolicyError);
    expect(problem(recipientsFileText([{ name: "a".repeat(64), kind: "machine", recipient: A }]))).toBeInstanceOf(PolicyError);
    expect(problem(recipientsFileText([{ name: "x", kind: "backup" as "machine", recipient: A }]))).toBeInstanceOf(PolicyError);
    expect(problem("pq: true\nrecipients: []\n")).toBeInstanceOf(PolicyError);
    expect(problem(`pq: true\nextra: 1\nrecipients:\n  - { name: x, kind: machine, recipient: ${A}, added: 2026-10-26 }\n`)).toBeInstanceOf(PolicyError);
    expect(problem(`pq: true\nrecipients:\n  - { name: x, kind: machine, recipient: ${A}, added: yesterday }\n`)).toBeInstanceOf(PolicyError);
    // recovery.age's SHA-256: required on the recovery entry, lower-case hex, and on no machine entry.
    const digest = recoveryDigest(FAKE_RECOVERY_AGE);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const issues = (text: string) => (problem(text) as PolicyError).message;
    expect(issues(`pq: true\nrecipients:\n  - { name: recovery, kind: recovery, recipient: ${R}, added: 2026-10-26 }\n`)).toMatch(/\/recipients\/0\/recovery_age_sha256: missing required key/);
    expect(issues(`pq: true\nrecipients:\n  - { name: recovery, kind: recovery, recipient: ${R}, added: 2026-10-26, recovery_age_sha256: ${digest.toUpperCase()} }\n`)).toMatch(/\/recipients\/0\/recovery_age_sha256: must match pattern/);
    expect(issues(`pq: true\nrecipients:\n  - { name: x, kind: machine, recipient: ${A}, added: 2026-10-26, recovery_age_sha256: ${digest} }\n`)).toMatch(/\/recipients\/0\/recovery_age_sha256: not allowed here/);
    // Duplicates, by name or by recipient.
    expect(problem(recipientsFileText([{ name: "x", kind: "machine", recipient: A }, { name: "x", kind: "machine", recipient: B }])).message).toMatch(/name x appears twice/);
    expect(problem(recipientsFileText([{ name: "x", kind: "machine", recipient: A }, { name: "y", kind: "machine", recipient: A }])).message).toMatch(/y has the same recipient as x/);
    // A PQ/classic mix, or a recipient of the wrong kind for `pq`, is refused.
    const mix = problem(recipientsFileText([{ name: "x", kind: "machine", recipient: A }, { name: "y", kind: "machine", recipient: CLASSIC }]));
    expect(mix).toBeInstanceOf(SecretError);
    expect(mix.message).toMatch(/pq: true, but y is a classic \(X25519\) recipient: hapi refuses to mix post-quantum and classic recipients/);
    expect(problem(recipientsFileText([{ name: "x", kind: "machine", recipient: A }], false)).message).toMatch(/pq: false, but x is a post-quantum recipient/);
    expect(parseRecipients(recipientsFileText([{ name: "x", kind: "machine", recipient: CLASSIC }], false), "/r.yaml").pq).toBe(false);
  });

  test("written as YAML with a header and read back the same; a missing file is a SecretError", async () => {
    const dir = tempDir();
    const path = join(dir, "secrets.recipients.yaml");
    const file = { pq: true, recipients: [{ name: "laptop-user", kind: "machine" as const, recipient: A, added: "2026-10-26" }] };
    const text = recipientsText(file, join(dir, "secrets.enc.yaml"));
    expect(text).toStartWith("# The age recipients ");
    writeFileSync(path, text);
    expect(await loadRecipients(path)).toEqual(file);
    const e = await caught(loadRecipients(join(dir, "nope.recipients.yaml")));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toMatch(/no recipients file at .*nope\.recipients\.yaml/);
  });
});

describe("drift against the store", () => {
  const file = (pq = true, ...rs: [string, "machine" | "recovery", string][]) => ({ pq, recipients: rs.map(([name, kind, recipient]) => ({ name, kind, recipient, added: "2026-10-26" })) });

  test("the store's recipients come from its sops metadata, read without decrypting", () => {
    expect(storeRecipients(sopsFileText({ "hapi-a": "enc" }, {}, [A, R]))).toEqual([A, R]);
    expect(storeRecipients("hapi-a: x\n")).toEqual([]);
  });

  test("drift in either direction is named, by name or by public key; a PQ/classic mix in the store is named too", () => {
    const f = file(true, ["laptop", "machine", A], ["recovery", "recovery", R]);
    expect(recipientProblems(f, [A, R])).toEqual([]);
    expect(recipientProblems(f, [R, A])).toEqual([]);
    expect(recipientProblems(f, [A, R, B])).toEqual([`the store is encrypted to ${shortRecipient(B)}, which the recipients file doesn't list`]);
    expect(recipientProblems(f, [A])).toEqual([`the recipients file lists recovery (${shortRecipient(R)}), but the store isn't encrypted to it`]);
    expect(recipientProblems(f, [A, R, CLASSIC])).toEqual([
      `the store mixes post-quantum and classic recipients (${shortRecipient(CLASSIC)} is classic), which drops post-quantum protection: hapi refuses a mix`,
      `the store is encrypted to ${shortRecipient(CLASSIC)}, which the recipients file doesn't list`,
    ]);
    expect(recipientProblems(f, [A, R, A])).toEqual([`the store lists ${shortRecipient(A)} twice`]);
  });
});

describe("the machine name", () => {
  test("defaults to <hostname>-<user>, normalised to ^[a-z0-9][a-z0-9-]{0,62}$", () => {
    expect(machineName("Laptop.local", "Example_User")).toBe("laptop-local-example-user");
    expect(machineName("--box--", "u")).toBe("box-u");
    expect(machineName("é", "")).toBe("machine");
    const long = machineName("h".repeat(80), "user");
    expect(long).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    expect(long.length).toBe(63);
  });
});
