import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { SecretError } from "../../src/secrets/provider";
import { generateWords, newIdentity, parseWords, passphraseOf, readRecoveryWords, showAndConfirmWords, unwrapIdentity, WORD_COUNT, wrapIdentity } from "../../src/secrets/recovery";
import { WORDLIST } from "../../src/secrets/wordlist";
import { caught, cleanup, FAKE_AGE_DIR, fakeTools, fakeTty } from "./helpers";

afterEach(cleanup);

const env = { PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`, HOME: "/nonexistent/home" };

describe("the word list", () => {
  test("is the 2048-word BIP-39 English list age uses for `age -p`", () => {
    expect(WORDLIST.length).toBe(2048);
    expect(new Set(WORDLIST).size).toBe(2048);
    expect(WORDLIST.every((w) => /^[a-z]{3,8}$/.test(w))).toBe(true);
    expect([...WORDLIST].sort()).toEqual([...WORDLIST]);
    // The SHA-256 of bitcoin/bips bip-0039/english.txt (one word per line).
    expect(createHash("sha256").update(`${WORDLIST.join("\n")}\n`).digest("hex")).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  });
});

describe("the recovery words", () => {
  test("words are 10 from the 2048-word list via crypto RNG; input normalisation; a non-list word is named by position", () => {
    // crypto.getRandomValues by default, one uint16 per word, taken mod 2048 (uniform: 65536 = 32 x 2048).
    const spy = spyOn(crypto, "getRandomValues");
    const words = generateWords();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(words.length).toBe(WORD_COUNT);
    expect(WORD_COUNT).toBe(10);
    expect(words.every((w) => WORDLIST.includes(w))).toBe(true);
    const fixed = generateWords((a) => {
      a.set([0, 1, 2047, 2048, 4095, 65535, 1024, 3, 2051, 100]);
      return a;
    });
    expect(fixed).toEqual([0, 1, 2047, 0, 2047, 2047, 1024, 3, 3, 100].map((i) => WORDLIST[i]!));
    // Two draws differ (2^-110 odds otherwise).
    expect(generateWords()).not.toEqual(generateWords());

    // Spaces, hyphens, case and extra whitespace don't matter; the passphrase is the words joined by "-", as age's own.
    const ten = WORDLIST.slice(0, 10);
    expect(parseWords(`  ${ten.slice(0, 5).join("   ").toUpperCase()}\n${ten.slice(5).join("-")}\t`)).toEqual(ten);
    expect(passphraseOf(ten)).toBe(ten.join("-"));

    // A typo is named by its position, never echoed; so is a wrong count.
    const typo = [...ten];
    typo[3] = "abandonn";
    const e = (() => {
      try {
        parseWords(typo.join(" "));
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected a throw");
    })();
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toBe("word 4 is not in the list (check its spelling)");
    expect(() => parseWords(ten.slice(0, 9).join(" "))).toThrow(/^expected 10 words, got 9$/);
    expect(() => parseWords("")).toThrow(/^expected 10 words, got 0$/);
  });

  test("show and confirm: shown once, then 2 words asked at random positions; a mismatch re-shows them, up to 3 tries", async () => {
    const words = WORDLIST.slice(100, 110);
    const ok = fakeTty();
    await showAndConfirmWords(words, ok.tty, { confirm: true });
    expect(ok.shown).toEqual([words]);
    const text = ok.writes.join("");
    expect(text).toContain("Store these 10 words where you keep things you can't lose (a password manager, paper in a safe, or both). With recovery.age they open your secrets if every machine is lost.");
    // After "stored", the screen (and scrollback) is cleared before the check.
    expect(text).toContain("\x1b[2J\x1b[3J\x1b[H");
    const asked = ok.prompts.filter((p) => p.startsWith("Word "));
    expect(asked.length).toBe(2);
    expect(new Set(asked).size).toBe(2);

    const wrong = fakeTty({ answer: () => "zoo" });
    const e = await caught(showAndConfirmWords(words, wrong.tty, { confirm: true }));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toMatch(/^the recovery words weren't confirmed after 3 tries/);
    expect(wrong.shown.length).toBe(3);
    expect(e.message).not.toContain(words[0]);

    // Case and spaces don't matter in an answer.
    const sloppy = fakeTty({ answer: (p, w) => `  ${w[p - 1]!.toUpperCase()} ` });
    await showAndConfirmWords(words, sloppy.tty, { confirm: true });
    expect(sloppy.shown.length).toBe(1);

    // Without confirmation (tests and CI fixtures only), they are shown and nothing is asked.
    const shown = fakeTty();
    await showAndConfirmWords(words, shown.tty, { confirm: false });
    expect([shown.shown, shown.prompts]).toEqual([[words], []]);
  });

  test("reading the words back: a typo gets 'word N is not in the list' and another try, up to 3", async () => {
    const words = WORDLIST.slice(200, 210);
    const typo = [...words];
    typo[6] = "notaword";
    const t = fakeTty({ typed: [typo.join(" "), words.join(" ")] });
    expect(await readRecoveryWords(t.tty)).toEqual(words);
    expect(t.writes.join("")).toContain("word 7 is not in the list (check its spelling)");
    expect(t.writes.join("")).not.toContain("notaword");

    const bad = fakeTty({ typed: ["a b c", "a b c", "a b c"] });
    await expect(readRecoveryWords(bad.tty)).rejects.toThrow(/^expected 10 words, got 3$/);
    expect(bad.prompts.length).toBe(3);
  });
});

describe("the recovery identity", () => {
  test("is made in memory, wrapped with the words on fd 3 (never argv or env), and unwrapped only with the same words", async () => {
    const t = fakeTools();
    const id = await newIdentity(t.ageKeygen, env, true);
    expect(id.identity).toStartWith("AGE-SECRET-KEY-PQ-1");
    expect(id.recipient).toStartWith("age1pq1");
    // The recipient comes from `age-keygen -y` on stdin: a wrapped file can't give it later.
    expect(t.calls.map((c) => c.args)).toEqual([["-pq"], ["-y"]]);
    expect(t.calls[1]!.stdin).toBe(id.text);

    const words = WORDLIST.slice(300, 310);
    const wrapped = await wrapIdentity(t.age, env, id.text, words);
    expect(wrapped).toStartWith("-----BEGIN AGE ENCRYPTED FILE-----\n");
    const wrap = t.calls[2]!;
    expect(wrap.args).toEqual(["-e", "-a", "-j", "batchpass"]);
    expect(wrap.env).toEqual({ ...env, AGE_PASSPHRASE_FD: "3" });
    expect(wrap.fd3).toBe(passphraseOf(words));
    expect(wrap.stdin).toBe(id.text);

    const back = await unwrapIdentity({ age: t.age, ageKeygen: t.ageKeygen }, env, wrapped, words, { file: "/x/recovery.age", recipient: id.recipient });
    expect(back).toBe(id.identity);
    const unwrap = t.calls[3]!;
    expect(unwrap.args).toEqual(["-d", "-j", "batchpass"]);
    expect(unwrap.fd3).toBe(passphraseOf(words));

    // Wrong words: a clear error, never a word. A file whose key isn't the recorded recipient: refused.
    const other = WORDLIST.slice(310, 320);
    const e = await caught(unwrapIdentity({ age: t.age, ageKeygen: t.ageKeygen }, env, wrapped, other, { file: "/x/recovery.age", recipient: id.recipient }));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toBe("the words don't open /x/recovery.age: check each word and their order");
    await expect(unwrapIdentity({ age: t.age, ageKeygen: t.ageKeygen }, env, wrapped, words, { file: "/x/recovery.age", recipient: "age1pq1other" })).rejects.toThrow(
      /\/x\/recovery\.age opens, but its key is not the store's recovery recipient/,
    );

    for (const c of t.calls) {
      const where = JSON.stringify([c.args, c.env]);
      for (const w of [...words, id.identity]) expect(where).not.toContain(w);
    }
  });

  test("a classic identity when pq is off; a keygen that prints the wrong kind is refused, unshown", async () => {
    const t = fakeTools();
    const id = await newIdentity(t.ageKeygen, env, false);
    expect(id.identity).toStartWith("AGE-SECRET-KEY-1");
    expect(id.recipient).toMatch(/^age1[02-9ac-hj-np-z]{58}$/);
    const liar = async () => ({ code: 0, stdout: "AGE-SECRET-KEY-1FAKEKEYX\n", stderr: "" });
    const e = await caught(newIdentity(liar, env, true));
    expect(e.message).toBe("age-keygen printed something that isn't one post-quantum age key (not shown)");
    expect(e.message).not.toContain("FAKEKEYX");
  });
});
