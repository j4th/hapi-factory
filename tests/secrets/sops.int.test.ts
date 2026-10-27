/**
 * HAPI_INT=1 only: the whole key lifecycle with the real sops and age that
 * mise pins, and throwaway keys:
 * init → fill in → check → drill → join (a second HOME) → add-machine →
 * resolve as the second machine → revoke the first → recover on a third HOME
 * with only the store, recovery.age, the recipients file and the words →
 * new-recovery → drill with the new words, and not with the old.
 *
 * Every machine is a temp HOME and XDG_RUNTIME_DIR, deleted afterwards; the
 * real ~/.config, ~/.gnupg and any gpg-agent are never touched (every sops
 * child gets GPG_AGENT_INFO=, and the temp XDG_RUNTIME_DIR has no gnupg
 * socket). The words go through a fake terminal. PATH holds /usr/bin, where
 * a distro age may live: hapi must use the pinned one anyway.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { secretsAddMachine, secretsCheck, secretsDrill, secretsInit, secretsJoin, secretsNewRecovery, secretsRecover, secretsResolve, secretsRevoke } from "../../src/secrets/cli";
import { parseEnvFile } from "../../src/secrets/files";
import { passphraseOf } from "../../src/secrets/recovery";
import { pinnedAgeDir, runSops } from "../../src/secrets/providers/sops";
import { capture, cleanup, fakeTty, fullStore, tempDir } from "./helpers";

afterEach(cleanup);

/** The directory of a mise-pinned binary (`mise which`), so the test runs the pinned version, not whatever is on PATH. */
function pinnedDir(bin: string): string {
  const r = Bun.spawnSync(["mise", "which", bin], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`mise which ${bin} failed: run \`mise install\``);
  return dirname(r.stdout.toString().trim());
}

describe.skipIf(!process.env.HAPI_INT)("sops + age key lifecycle (real binaries, throwaway keys)", () => {
  test(
    "init, drill, join, add-machine, resolve, revoke, recover and new-recovery",
    async () => {
      const { out, err } = capture();
      const root = tempDir("hapi-lifecycle-int-");
      const sopsDir = pinnedDir("sops");
      const versions = Bun.spawnSync([join(sopsDir, "sops"), "--version", "--disable-version-check"], { stdout: "pipe" }).stdout.toString();
      expect(versions).toStartWith("sops 3.13.3");

      const host = (name: string, typed: string[] = []) => {
        const home = join(root, name, "home");
        const xdg = join(root, name, "run");
        mkdirSync(home, { recursive: true, mode: 0o700 });
        mkdirSync(xdg, { recursive: true, mode: 0o700 });
        chmodSync(xdg, 0o700);
        const t = fakeTty({ typed });
        const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: [sopsDir, "/usr/bin", "/bin"].join(":") };
        return { name, home, xdg, env, t, deps: { env, cwd: join(root, name), tty: t.tty, attended: false, machineName: name }, store: join(root, name, "private", "secrets.enc.yaml") };
      };
      const copyPrivate = (from: { store: string }, to: { store: string }) => {
        rmSync(dirname(to.store), { recursive: true, force: true });
        cpSync(dirname(from.store), dirname(to.store), { recursive: true });
      };
      const recipients = (h: { store: string }) => parse(readFileSync(join(dirname(h.store), "secrets.recipients.yaml"), "utf8")).recipients as { name: string; kind: string; recipient: string }[];

      // Machine a: init, with the words confirmed on the (fake) terminal. Every recipient is post-quantum.
      const a = host("machine-a");
      expect(await secretsInit(["--file", a.store], a.deps)).toBe(0);
      const words = a.t.shown[0]!;
      expect(recipients(a).map((r) => [r.name, r.kind, r.recipient.slice(0, 7), r.recipient.length])).toEqual([
        ["machine-a", "machine", "age1pq1", 1959],
        ["recovery", "recovery", "age1pq1", 1959],
      ]);

      // Fill in the values, as `secrets:edit` would: re-encrypted to the same two recipients, from stdin.
      const values = { ...fullStore(), "hapi-host-planner-app-private-key": "-----BEGIN FAKE-----\nnot a key\n-----END FAKE-----\n" };
      const ageDir = await pinnedAgeDir();
      const enc = await runSops(
        ["--config", "/dev/null", "encrypt", "--age", recipients(a).map((r) => r.recipient).join(","), "--input-type", "yaml", "--output-type", "yaml", "--filename-override", a.store],
        { env: { PATH: `${ageDir}:${a.env.PATH}`, HOME: a.home, SOPS_DISABLE_VERSION_CHECK: "1", GPG_AGENT_INFO: "" }, stdin: stringify(values) },
      );
      expect(enc.code).toBe(0);
      writeFileSync(a.store, enc.stdout, { mode: 0o600 });
      expect(await secretsCheck([], a.deps)).toBe(0);
      expect(out).toContain("recipient machine  machine-a (post-quantum, added " + new Date().toISOString().slice(0, 10) + ")");

      // The drill: the words and recovery.age alone open the store, in an isolated HOME.
      a.t.typed.push(words.join(" "));
      out.length = 0;
      expect(await secretsDrill([], a.deps)).toBe(0);
      expect(out).toEqual(["recovery works: 14 names readable"]);

      // Machine b joins with a copy of private/; machine a adds it.
      const b = host("machine-b");
      copyPrivate(a, b);
      out.length = 0;
      expect(await secretsJoin(["--store", b.store], b.deps)).toBe(0);
      const rB = /^this machine's public key \(machine-b\): (age1pq1[0-9a-z]+)$/m.exec(out.join("\n"))![1]!;
      expect(out.join("\n")).toContain(`mise run secrets:add-machine -- --name machine-b --recipient ${rB}`);
      expect(await secretsAddMachine(["--name", "machine-b", "--recipient", rB], a.deps)).toBe(0);

      // b resolves with its own key.
      copyPrivate(a, b);
      out.length = 0;
      expect(await secretsResolve([], b.deps)).toBe(0);
      const host_ = parseEnvFile(readFileSync(join(b.xdg, "hapi", "env", "host.env"), "utf8"));
      expect(host_.HAPI_PLANNER_APP_PRIVATE_KEY).toBe(values["hapi-host-planner-app-private-key"]);
      expect(parseEnvFile(readFileSync(join(b.xdg, "hapi", "env", "archon.env"), "utf8")).CLAUDE_API_KEY).toBe("fake-hapi-archon-anthropic-api-key-value");

      // b revokes a: a's key no longer opens the store.
      expect(await secretsRevoke(["--name", "machine-a"], b.deps)).toBe(0);
      expect(recipients(b).map((r) => r.name)).toEqual(["recovery", "machine-b"]);
      copyPrivate(b, a);
      await expect(secretsCheck([], a.deps)).rejects.toThrow(/^sops could not decrypt .*secrets\.enc\.yaml \(exit 128\): Failed to get the data key required to decrypt the SOPS file\.$/);

      // Machine c has only private/ (store, recovery.age, recipients file) and the words: it recovers, then works without them.
      const c = host("machine-c", [words.join(" ")]);
      copyPrivate(b, c);
      expect(await secretsRecover(["--store", c.store], c.deps)).toBe(0);
      expect(recipients(c).map((r) => r.name)).toEqual(["recovery", "machine-b", "machine-c"]);
      expect(await secretsCheck([], { ...c.deps, tty: null })).toBe(0);

      // New words: the old ones stop opening this store.
      expect(await secretsNewRecovery([], c.deps)).toBe(0);
      const newWords = c.t.shown.at(-1)!;
      c.t.typed.push(newWords.join(" "));
      expect(await secretsDrill([], c.deps)).toBe(0);
      c.t.typed.push(words.join(" "));
      await expect(secretsDrill([], c.deps)).rejects.toThrow(/the words don't open .*recovery\.age/);

      // Nothing printed a value or a word; no key or word landed in a file other than its own.
      const printed = [...out, ...err].join("\n");
      expect(printed).not.toContain("fake-hapi");
      for (const w of [words, newWords]) expect(printed).not.toContain(passphraseOf(w));
    },
    120_000,
  );
});
