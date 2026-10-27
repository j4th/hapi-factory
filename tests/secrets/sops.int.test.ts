/**
 * HAPI_INT=1 only: the real sops and age-keygen that mise pins, round-tripping
 * through `hapi secrets init`, a fill-in (as `secrets:edit` would), `check` and
 * `resolve`. Everything happens in a temp directory with a temp HOME and a
 * throwaway key that is deleted afterwards; the real ~/.config is never read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { secretsInit } from "../../src/secrets/init";
import { secretsCheck, secretsResolve } from "../../src/secrets/provider";
import { runSops } from "../../src/secrets/providers/sops";
import { parseEnvFile } from "../../src/secrets/files";
import { capture, cleanup, fullStore, tempDir } from "./helpers";

afterEach(cleanup);

/** The directory of a mise-pinned binary (`mise which`), so the test runs the pinned version, not whatever is on PATH. */
function pinnedDir(bin: string): string {
  const r = Bun.spawnSync(["mise", "which", bin], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`mise which ${bin} failed: run \`mise install\``);
  return dirname(r.stdout.toString().trim());
}

describe.skipIf(!process.env.HAPI_INT)("sops + age round trip (real binaries, throwaway key)", () => {
  test("init, fill in, check and resolve", async () => {
    const { out, err } = capture();
    const root = tempDir("hapi-sops-int-");
    const home = join(root, "home");
    const xdg = join(root, "run");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: [pinnedDir("sops"), pinnedDir("age-keygen"), "/usr/bin", "/bin"].join(":") };
    const versions = Bun.spawnSync(["sops", "--version", "--disable-version-check"], { env, stdout: "pipe" }).stdout.toString();
    expect(versions).toStartWith("sops 3.13.3");

    // The key outside sops's default place, so the wrong-key check at the end has no other key to fall back on.
    expect(await secretsInit(["--age-key", "keys/age.txt"], { env, cwd: root })).toBe(0);
    const config = join(home, ".config", "hapi", "secrets.yaml");
    const file = join(home, ".config", "hapi", "secrets.enc.yaml");
    const ageKey = join(root, "keys", "age.txt");
    expect(statSync(ageKey).mode & 0o777).toBe(0o600);
    const recipient = /age public key: (age1[0-9a-z]+)/.exec(out.join("\n"))![1]!;

    // The fresh store has every name, all empty: check exits 1 and lists each as empty.
    out.length = 0;
    expect(await secretsCheck([], { env })).toBe(1);
    expect(out.filter((l) => l.startsWith("empty    ")).length).toBe(15);

    // Fill it in as `mise run secrets:edit` would: the plaintext goes to sops on stdin, never to disk.
    const values = { ...fullStore(), "hapi-host-planner-app-private-key": "-----BEGIN FAKE-----\nnot a key\n-----END FAKE-----\n" };
    const enc = await runSops(["--config", "/dev/null", "encrypt", "--age", recipient, "--input-type", "yaml", "--output-type", "yaml", "--filename-override", file], {
      env: { PATH: env.PATH, HOME: home, SOPS_DISABLE_VERSION_CHECK: "1" },
      stdin: stringify(values),
    });
    expect(enc.code).toBe(0);
    writeFileSync(file, enc.stdout, { mode: 0o600 });
    expect(enc.stdout).not.toContain("fake-hapi");

    out.length = 0;
    expect(await secretsCheck([], { env })).toBe(0);
    expect(out.every((l) => l.startsWith("found    "))).toBe(true);

    out.length = 0;
    expect(await secretsResolve(["--config", config], { env })).toBe(0);
    const host = parseEnvFile(readFileSync(join(xdg, "hapi", "env", "host.env"), "utf8"));
    expect(host.HAPI_PLANNER_APP_PRIVATE_KEY).toBe(values["hapi-host-planner-app-private-key"]);
    expect(parseEnvFile(readFileSync(join(xdg, "hapi", "env", "archon.env"), "utf8")).CLAUDE_API_KEY).toBe("fake-hapi-archon-anthropic-api-key-value");
    expect([...out, ...err].join("\n")).not.toContain("fake-hapi");

    // A different key can't decrypt it: the error is sops's first line, scrubbed, and nothing is written.
    const other = join(root, "other", "keys.txt");
    mkdirSync(dirname(other), { mode: 0o700 });
    expect(Bun.spawnSync(["age-keygen", "-o", other], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    writeFileSync(config, stringify({ provider: "sops", sops: { file, age_key_file: other } }));
    await expect(secretsCheck([], { env })).rejects.toThrow(/^sops could not decrypt .*secrets\.enc\.yaml \(exit 128\): Failed to get the data key required to decrypt the SOPS file\.$/);
  });
});
