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
 *
 * Every age, age-keygen and sops call hapi makes goes through a recorder
 * around the real binary. At the end, every file under the temp root is
 * scanned: no recovery identity is in any file, each machine identity is only
 * in its own key file, and no passphrase is in any file, argv or env (a
 * recovery identity is in a sops child's env only as SOPS_AGE_KEY).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { secretsAddMachine, secretsCheck, secretsDrill, secretsInit, secretsJoin, secretsNewRecovery, secretsRecover, secretsResolve, secretsRevoke } from "../../src/secrets/cli";
import { parseEnvFile } from "../../src/secrets/files";
import { passphraseOf, unwrapIdentity } from "../../src/secrets/recovery";
import { ageEnv, commandRunner, pinnedAgeDir, runSops, type SopsRunner } from "../../src/secrets/providers/sops";
import { capture, cleanup, fakeTty, fullStore, tempDir, tree } from "./helpers";

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
      const ageDir = await pinnedAgeDir();

      // The real tools, each call recorded (argv and env; stdin and fd 3 are pipes, not recorded).
      const calls: { tool: string; args: string[]; env: Record<string, string> }[] = [];
      const recorded = (tool: string, run: SopsRunner): SopsRunner => (args, o) => (calls.push({ tool, args, env: o.env }), run(args, o));
      const realAge = commandRunner(join(ageDir, "age"));
      const realKeygen = commandRunner(join(ageDir, "age-keygen"));
      const tools = { sops: recorded("sops", runSops), age: recorded("age", realAge), ageKeygen: recorded("age-keygen", realKeygen) };

      const host = (name: string, typed: string[] = []) => {
        const home = join(root, name, "home");
        const xdg = join(root, name, "run");
        mkdirSync(home, { recursive: true, mode: 0o700 });
        mkdirSync(xdg, { recursive: true, mode: 0o700 });
        chmodSync(xdg, 0o700);
        const t = fakeTty({ typed });
        const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: [sopsDir, "/usr/bin", "/bin"].join(":") };
        return {
          name,
          home,
          xdg,
          env,
          t,
          deps: { env, cwd: join(root, name), tty: t.tty, attended: false, machineName: name, ...tools },
          store: join(root, name, "private", "secrets.enc.yaml"),
          key: join(home, ".config", "sops", "age", "keys.txt"),
        };
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

      // Nothing printed a value, a word or a key.
      const printed = [...out, ...err].join("\n");
      expect(printed).not.toContain("fake-hapi");

      // The secrets to look for: both sets of words (as age gets them, and as typed), both recovery identities
      // (unwrapped here, in memory, from a's old recovery.age and c's new one), and each machine's identity.
      const phrases = [words, newWords].flatMap((w) => [passphraseOf(w), w.join(" ")]);
      const recoveryIds = await Promise.all(
        [
          [a, words],
          [c, newWords],
        ].map(async ([h, w]) => {
          const m = h as typeof a;
          const rec = recipients(m).find((r) => r.kind === "recovery")!;
          const file = join(dirname(m.store), "recovery.age");
          return unwrapIdentity({ age: realAge, ageKeygen: realKeygen }, ageEnv(m.env, ageDir), readFileSync(file), w as string[], { file, recipient: rec.recipient });
        }),
      );
      expect(new Set(recoveryIds).size).toBe(2);
      const machineIds = [a, b, c].map((m) => [m.key, readFileSync(m.key, "utf8").split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-PQ-1"))!] as const);
      expect(machineIds.every(([, id]) => id !== undefined)).toBe(true);

      // Every file under the temp root (each HOME, XDG_RUNTIME_DIR and private/); the env symlink's target is scanned as itself.
      const files = tree(root)
        .filter((f) => !lstatSync(join(root, f)).isSymbolicLink())
        .map((f) => [join(root, f), readFileSync(join(root, f), "utf8")] as const);
      expect(files.length).toBeGreaterThan(10);
      for (const [path, text] of files) {
        for (const p of phrases) expect([path, text.includes(p)]).toEqual([path, false]);
        for (const id of recoveryIds) expect([path, text.includes(id)]).toEqual([path, false]);
        for (const [own, id] of machineIds) expect([path, text.includes(id)]).toEqual([path, path === own]);
      }
      for (const secret of [...phrases, ...recoveryIds, ...machineIds.map(([, id]) => id)]) expect(printed.includes(secret)).toBe(false);

      // Every recorded call: no passphrase in argv or env; no identity in argv; a recovery identity only as a sops child's SOPS_AGE_KEY.
      expect(new Set(calls.map((x) => x.tool))).toEqual(new Set(["age", "age-keygen", "sops"]));
      const withRecoveryKey = calls.filter((x) => recoveryIds.includes(x.env.SOPS_AGE_KEY ?? ""));
      expect(withRecoveryKey.map((x) => [x.tool, x.args[2]])).toEqual([
        ["sops", "decrypt"], // a's drill
        ["sops", "rotate"], // c's recover
        ["sops", "decrypt"], // c's drill, new words
      ]);
      for (const x of calls) {
        const { SOPS_AGE_KEY: _key, ...rest } = x.env;
        const seen = JSON.stringify([x.args, rest]);
        for (const secret of [...phrases, ...recoveryIds, ...machineIds.map(([, id]) => id)]) expect([x.tool, x.args[0], seen.includes(secret)]).toEqual([x.tool, x.args[0], false]);
        if (x.tool !== "sops") expect(x.env.SOPS_AGE_KEY).toBeUndefined();
      }
    },
    120_000,
  );
});
