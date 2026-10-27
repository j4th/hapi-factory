import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../src/cli";
import { PolicyError } from "../../src/policy/load";
import { secretEnvName } from "../../src/policy/mcp";
import { envFileText, parseEnvFile } from "../../src/secrets/files";
import type { Manifest } from "../../src/secrets/manifest";
import { providerFor, secretsCheck, secretsEdit, secretsResolve } from "../../src/secrets/cli";
import { checkSecrets, configPath, describeSecretsConfig, loadSecretsConfig, resolveSecrets, SecretError, type SecretProvider } from "../../src/secrets/provider";
import { capture, caught, cleanup, FAKE_AGE_DIR, fullStore, sopsConfig, sopsStore, tempDir } from "./helpers";

// Obviously fake values: none of them is, or looks like, a real credential.
const FAKE = "sk-SECRET-123";

afterEach(cleanup);

/** A fake provider over `values`. It follows the contract: every name asked for, or a SecretError naming the missing ones. */
function fakeProvider(values: Record<string, string>, o: { name?: SecretProvider["name"]; fail?: Error } = {}) {
  const calls: string[][] = [];
  const provider: SecretProvider = {
    name: o.name ?? "sops",
    downgrade: o.name === "env-file",
    list: async () => Object.keys(values),
    fetch: async (names) => {
      calls.push(names);
      if (o.fail) throw o.fail;
      const missing = names.filter((n) => !Object.hasOwn(values, n));
      if (missing.length > 0) throw new SecretError(`the fake store has no ${missing.join(", ")}`, missing);
      return new Map(names.map((n) => [n, values[n]!]));
    },
  };
  return { provider, calls };
}
const outDirIn = (dir: string) => join(dir, "hapi");
const mode = (path: string) => statSync(path).mode & 0o777;

describe("resolveSecrets", () => {
  const manifest: Manifest = {
    hermes: { ANTHROPIC_API_KEY: "hapi-hermes-key", SLACK_BOT_TOKEN: "hapi-slack" },
    archon: { ANTHROPIC_API_KEY: "hapi-archon-key", CLAUDE_API_KEY: "hapi-archon-key" },
  };

  test("fetches each logical name once, then writes <outDir>/env/<zone>.env (0600) for every zone", async () => {
    const outDir = outDirIn(tempDir());
    const { provider, calls } = fakeProvider({ "hapi-hermes-key": "h", "hapi-slack": "s", "hapi-archon-key": "a" });
    const paths = await resolveSecrets(manifest, provider, { outDir });
    expect(calls).toEqual([["hapi-archon-key", "hapi-hermes-key", "hapi-slack"]]);
    expect(paths).toEqual({ hermes: join(outDir, "env", "hermes.env"), archon: join(outDir, "env", "archon.env") });
    expect(lstatSync(join(outDir, "env")).isSymbolicLink()).toBe(true);
    expect(mode(outDir)).toBe(0o700);
    expect(mode(paths.hermes!)).toBe(0o600);
    expect(parseEnvFile(readFileSync(paths.archon!, "utf8"))).toEqual({ ANTHROPIC_API_KEY: "a", CLAUDE_API_KEY: "a" });
    expect(parseEnvFile(readFileSync(paths.hermes!, "utf8"))).toEqual({ ANTHROPIC_API_KEY: "h", SLACK_BOT_TOKEN: "s" });
  });

  test("resolve fails closed when the store lacks a manifest name, and writes nothing", async () => {
    const outDir = outDirIn(tempDir());
    const { provider } = fakeProvider({ "hapi-hermes-key": FAKE, "hapi-slack": "s" });
    const e = await caught(resolveSecrets(manifest, provider, { outDir }));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toContain("archon/ANTHROPIC_API_KEY (hapi-archon-key), archon/CLAUDE_API_KEY (hapi-archon-key)");
    expect(e.message).toContain("mise run secrets:edit");
    expect(e.message).not.toContain(FAKE);
    expect(existsSync(join(outDir, "env"))).toBe(false);

    // A provider that breaks the contract (returns without a name instead of throwing) fails the same way.
    const lying: SecretProvider = { ...provider, fetch: async () => new Map([["hapi-hermes-key", FAKE]]) };
    const e2 = await caught(resolveSecrets(manifest, lying, { outDir }));
    expect(e2).toBeInstanceOf(SecretError);
    expect(e2.message).toMatch(/hermes\/SLACK_BOT_TOKEN \(hapi-slack\)/);
    expect(existsSync(join(outDir, "env"))).toBe(false);
  });

  test("an empty value counts as missing", async () => {
    const outDir = outDirIn(tempDir());
    for (const empty of ["", "  \n"]) {
      const { provider } = fakeProvider({ "hapi-hermes-key": "h", "hapi-slack": empty, "hapi-archon-key": "a" });
      const e = await caught(resolveSecrets(manifest, provider, { outDir }));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toBe("hermes/SLACK_BOT_TOKEN (hapi-slack) is empty: fill it in with `mise run secrets:edit`");
    }
    const { provider } = fakeProvider({ "hapi-hermes-key": "", "hapi-slack": "", "hapi-archon-key": "a" });
    expect((await caught(resolveSecrets(manifest, provider, { outDir }))).message).toBe(
      "hermes/ANTHROPIC_API_KEY (hapi-hermes-key), hermes/SLACK_BOT_TOKEN (hapi-slack) are empty: fill them in with `mise run secrets:edit`",
    );
    expect(existsSync(join(outDir, "env"))).toBe(false);
  });

  test("a value never appears in an error or in stderr", async () => {
    const { err } = capture();
    const outDir = outDirIn(tempDir());
    // A value an env file can't carry is refused by zone, env var and name, never shown.
    const quoted = fakeProvider({ "hapi-hermes-key": `${FAKE}\n'tail`, "hapi-slack": "s", "hapi-archon-key": "a" });
    const e1 = await caught(resolveSecrets(manifest, quoted.provider, { outDir }));
    expect(e1.message).toMatch(/^hermes\/ANTHROPIC_API_KEY \(hapi-hermes-key\): .*single quote/);
    expect(e1.message).not.toContain(FAKE);
    // A value next to a missing one is never in the error.
    const partial = fakeProvider({ "hapi-hermes-key": `${FAKE}\n`, "hapi-slack": "s" });
    const e2 = await caught(resolveSecrets(manifest, partial.provider, { outDir }));
    expect(e2.message).not.toContain(FAKE);
    expect(err.join("\n")).not.toContain(FAKE);
    expect(existsSync(join(outDir, "env"))).toBe(false);
  });

  test("a bad zone, env name or logical name built in code is refused before anything is fetched, and not echoed", async () => {
    const outDir = outDirIn(tempDir());
    const { provider, calls } = fakeProvider({});
    for (const bad of [{ [FAKE]: { A: "hapi-a" } }, { hermes: { [FAKE]: "hapi-a" } }, { hermes: { A: FAKE } }] as Manifest[]) {
      const e = await caught(resolveSecrets(bad, provider, { outDir }));
      expect(e.message).not.toContain(FAKE);
    }
    expect(calls).toEqual([]);
  });

  test("the XDG_RUNTIME_DIR check comes first: a loose runtime root fails before the store is read", async () => {
    const xdg = tempDir();
    chmodSync(xdg, 0o755);
    const { provider, calls } = fakeProvider({ "hapi-hermes-key": "h", "hapi-slack": "s", "hapi-archon-key": "a" });
    await expect(resolveSecrets(manifest, provider, { outDir: outDirIn(xdg) })).rejects.toThrow(/XDG_RUNTIME_DIR/);
    expect(calls).toEqual([]);
  });
});

describe("checkSecrets", () => {
  test("reports found, missing and empty per env var, and the store's unknown names; never a value", async () => {
    const manifest: Manifest = { hermes: { A: "hapi-a", B: "hapi-b" }, research: { C: "hapi-c", D: "hapi-a" } };
    const { provider, calls } = fakeProvider({ "hapi-a": FAKE, "hapi-c": " ", "hapi-old": FAKE });
    const r = await checkSecrets(manifest, provider);
    expect(r.entries).toEqual([
      { zone: "hermes", key: "A", name: "hapi-a", status: "found" },
      { zone: "hermes", key: "B", name: "hapi-b", status: "missing" },
      { zone: "research", key: "C", name: "hapi-c", status: "empty" },
      { zone: "research", key: "D", name: "hapi-a", status: "found" },
    ]);
    expect(r.unknown).toEqual(["hapi-old"]);
    expect(calls).toEqual([["hapi-a", "hapi-c"]]); // only names the store holds; unknown ones are never fetched
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });

  test("a value resolve would refuse is reported as invalid, with the reason", async () => {
    const { provider } = fakeProvider({ "hapi-a": `${FAKE}'` });
    const r = await checkSecrets({ hermes: { A: "hapi-a" } }, provider);
    expect(r.entries).toEqual([{ zone: "hermes", key: "A", name: "hapi-a", status: "invalid", reason: expect.stringContaining("single quote") }]);
    expect(JSON.stringify(r)).not.toContain(FAKE);
  });
});

describe("the local config", () => {
  test("its path: --config, else $HAPI_SECRETS_CONFIG, else ${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml", () => {
    const home = "/home/example";
    expect(configPath({ env: { HOME: home } })).toBe("/home/example/.config/hapi/secrets.yaml");
    expect(configPath({ env: { HOME: home, XDG_CONFIG_HOME: "/xdg" } })).toBe("/xdg/hapi/secrets.yaml");
    // A relative XDG_CONFIG_HOME is invalid by the XDG spec, so it is ignored.
    expect(configPath({ env: { HOME: home, XDG_CONFIG_HOME: "rel" } })).toBe("/home/example/.config/hapi/secrets.yaml");
    expect(configPath({ env: { HOME: home, HAPI_SECRETS_CONFIG: "~/s.yaml" } })).toBe("/home/example/s.yaml");
    expect(configPath({ config: "c.yaml", env: { HOME: home, HAPI_SECRETS_CONFIG: "/env.yaml" }, cwd: "/work" })).toBe("/work/c.yaml");
    expect(() => configPath({ env: {} })).toThrow(/HOME/);
  });

  test("a missing config says how to make one", () => {
    const path = join(tempDir(), "secrets.yaml");
    const e = (() => {
      try {
        loadSecretsConfig(path, { HOME: "/home/example" });
      } catch (err) {
        return err as Error;
      }
      throw new Error("expected an error");
    })();
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toBe(`no secrets config at ${path}: run \`mise run secrets:init\``);
  });

  test("~ expands to $HOME, relative paths resolve against the config's directory, and the age key defaults to sops's own path", () => {
    const dir = tempDir();
    const path = join(dir, "secrets.yaml");
    writeFileSync(path, "provider: sops\nsops:\n  file: store/secrets.enc.yaml\n  age_key_file: ~/keys/age.txt\n");
    expect(loadSecretsConfig(path, { HOME: "/home/example" })).toEqual({
      path,
      provider: "sops",
      sops: { file: join(dir, "store", "secrets.enc.yaml"), age_key_file: "/home/example/keys/age.txt" },
    });
    writeFileSync(path, "provider: sops\nsops: { file: /s/secrets.enc.yaml }\n");
    expect(loadSecretsConfig(path, { HOME: "/home/example" })).toMatchObject({ sops: { age_key_file: "/home/example/.config/sops/age/keys.txt" } });
    expect(loadSecretsConfig(path, { HOME: "/home/example", XDG_CONFIG_HOME: "/xdg" })).toMatchObject({ sops: { age_key_file: "/xdg/sops/age/keys.txt" } });
    writeFileSync(path, "provider: env-file\nenv_file: { file: ../plain/secrets.env }\n");
    expect(loadSecretsConfig(path, {})).toEqual({ path, provider: "env-file", env_file: { file: join(dir, "..", "plain", "secrets.env") } });
  });

  test("exactly the selected provider's block: it is required, and any other block is refused", () => {
    const dir = tempDir();
    const path = join(dir, "secrets.yaml");
    const issues = (text: string) => {
      writeFileSync(path, text);
      try {
        loadSecretsConfig(path, { HOME: "/home/example" });
      } catch (e) {
        if (e instanceof PolicyError) return e.issues.map((i) => i.path);
        throw e;
      }
      return [];
    };
    expect(issues("provider: sops\n")).toEqual(["/sops"]);
    expect(issues("provider: bws\nsops: { file: x }\n")).toEqual(["/bws", "/sops"]);
    expect(issues("provider: sops\nsops: { file: x }\nenv_file: { file: y }\n")).toEqual(["/env_file"]);
    expect(issues("provider: vault\n")).toEqual(["/provider"]);
    expect(issues(`provider: bws\nbws:\n  ids:\n    hapi-a: 11111111-1111-4111-8111-111111111111\n`)).toEqual([]);
  });

  test("a secret pasted into the config is never echoed: only known keys and logical names are shown", () => {
    const dir = tempDir();
    const path = join(dir, "secrets.yaml");
    const message = (text: string) => {
      writeFileSync(path, text);
      try {
        loadSecretsConfig(path, {});
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    };
    const asId = message(`provider: bws\nbws:\n  ids:\n    hapi-a: ${FAKE}\n`);
    expect(asId).toContain("/bws/ids/hapi-a");
    expect(asId).not.toContain(FAKE);
    const asName = message(`provider: bws\nbws:\n  ids:\n    ${FAKE}: 11111111-1111-4111-8111-111111111111\n`);
    expect(asName).toContain("/bws/ids/<name>");
    expect(asName).not.toContain(FAKE);
    const asKey = message(`provider: sops\nsops: { file: x }\n${FAKE}: 1\n`);
    expect(asKey).toContain("/<key>");
    expect(asKey).not.toContain(FAKE);
  });

  test("describeSecretsConfig: the provider, whether it is a downgrade, and the files it uses", () => {
    expect(describeSecretsConfig({ path: "/c/secrets.yaml", provider: "sops", sops: { file: "/s/secrets.enc.yaml", age_key_file: "/k/keys.txt" } })).toEqual({
      provider: "sops",
      downgrade: false,
      files: ["/c/secrets.yaml", "/s/secrets.enc.yaml", "/k/keys.txt"],
    });
    expect(describeSecretsConfig({ path: "/c/secrets.yaml", provider: "bws", bws: { ids: {} } })).toEqual({ provider: "bws", downgrade: false, files: ["/c/secrets.yaml"] });
    expect(describeSecretsConfig({ path: "/c/secrets.yaml", provider: "env-file", env_file: { file: "/p/secrets.env" } })).toEqual({
      provider: "env-file",
      downgrade: true,
      files: ["/c/secrets.yaml", "/p/secrets.env"],
    });
  });

  test("providerFor builds the configured provider, and only that one", () => {
    const sops = providerFor({ path: "/c", provider: "sops", sops: { file: "/s", age_key_file: "/k" } });
    expect([sops.name, sops.downgrade]).toEqual(["sops", false]);
    const bws = providerFor({ path: "/c", provider: "bws", bws: { ids: {} } });
    expect([bws.name, bws.downgrade]).toEqual(["bws", false]);
    const envFile = providerFor({ path: "/c", provider: "env-file", env_file: { file: "/p" } });
    expect([envFile.name, envFile.downgrade]).toEqual(["env-file", true]);
  });
});

describe("hapi secrets resolve, check and edit", () => {
  /** A temp HOME and XDG_RUNTIME_DIR, a full sops store and its config. Never the real HOME. */
  function setup(values = fullStore()) {
    const root = tempDir();
    const home = join(root, "home");
    const xdg = join(root, "run");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    const store = sopsStore(root, values);
    const config = sopsConfig(root, store);
    const env = { HOME: home, XDG_RUNTIME_DIR: xdg, PATH: "/usr/bin:/bin" };
    return { root, home, xdg, store, config, env, deps: { env, sops: store.run, ageDir: async () => FAKE_AGE_DIR } };
  }

  test("resolve writes $XDG_RUNTIME_DIR/hapi/env/<zone>.env and prints only the paths", async () => {
    const { out } = capture();
    const s = setup();
    expect(await secretsResolve(["--config", s.config], s.deps)).toBe(0);
    const dir = join(s.xdg, "hapi", "env");
    expect(out).toEqual(["archon", "hermes", "host", "research"].map((z) => join(dir, `${z}.env`)));
    expect(parseEnvFile(readFileSync(join(dir, "archon.env"), "utf8"))).toEqual({
      ANTHROPIC_API_KEY: "fake-hapi-archon-anthropic-api-key-value",
      CLAUDE_API_KEY: "fake-hapi-archon-anthropic-api-key-value",
      HAPI_JEV_OPENROUTER_API_KEY: "fake-hapi-archon-jev-openrouter-api-key-value",
      OPENCODE_API_KEY: "fake-hapi-archon-opencode-api-key-value",
    });
    expect(out.join("\n")).not.toContain("fake-hapi");
    // The config's provider is the one used: sops, decrypting the configured file once.
    expect(s.store.calls.length).toBe(1);
    expect(s.store.calls[0]!.args.at(-1)).toBe(s.store.file);
  });

  test("without XDG_RUNTIME_DIR it fails clearly and reads nothing (no /tmp fallback)", async () => {
    const s = setup();
    for (const env of [{ HOME: s.home }, { HOME: s.home, XDG_RUNTIME_DIR: "" }, { HOME: s.home, XDG_RUNTIME_DIR: "relative/dir" }]) {
      await expect(secretsResolve(["--config", s.config], { ...s.deps, env })).rejects.toThrow(/XDG_RUNTIME_DIR/);
    }
    expect(s.store.calls).toEqual([]);
  });

  test("check lists every env var as found, missing or empty, and unknown store names; exits 1 if anything is missing or empty", async () => {
    const { out, err } = capture();
    const values = fullStore();
    delete values["hapi-archon-opencode-api-key"];
    values["hapi-research-exa-api-key"] = "";
    values["hapi-old-key"] = "x";
    const s = setup(values);
    expect(await secretsCheck(["--config", s.config], { ...s.deps, env: { HOME: s.home } })).toBe(1);
    expect(out).toContain("found    hermes/ANTHROPIC_API_KEY (hapi-hermes-anthropic-api-key)");
    expect(out).toContain("missing  archon/OPENCODE_API_KEY (hapi-archon-opencode-api-key)");
    expect(out).toContain("empty    research/EXA_API_KEY (hapi-research-exa-api-key)");
    expect(out).toContain("unknown  hapi-old-key (in the store, not in stack/secrets.yaml)");
    expect(out.slice(-2)).toEqual(["recipient machine  test-machine (post-quantum, added 2026-10-26)", "recipient recovery recovery (post-quantum, added 2026-10-26)"]);
    expect(out.length).toBe(18);
    expect(err.join("\n")).toContain("2 of 15 secrets are missing or empty: archon/OPENCODE_API_KEY, research/EXA_API_KEY");
    expect([...out, ...err].join("\n")).not.toContain("fake-hapi");
  });

  test("check exits 0 when every env var is found, and needs no XDG_RUNTIME_DIR; --dry-run is the same as check", async () => {
    const { out } = capture();
    const s = setup();
    expect(await secretsCheck(["--config", s.config], { ...s.deps, env: { HOME: s.home } })).toBe(0);
    const checked = [...out];
    out.length = 0;
    expect(await secretsResolve(["--config", s.config, "--dry-run"], { ...s.deps, env: { HOME: s.home } })).toBe(0);
    expect(out).toEqual(checked);
    expect(existsSync(join(s.xdg, "hapi"))).toBe(false);
  });

  test("an unknown name that isn't a logical name is not shown, in case it is a pasted value", async () => {
    const { out } = capture();
    const s = setup({ ...fullStore(), [FAKE]: "x" });
    expect(await secretsCheck(["--config", s.config], s.deps)).toBe(0);
    expect(out).toContain("unknown  (a name that is not a logical name, not shown) (in the store, not in stack/secrets.yaml)");
    expect(out.join("\n")).not.toContain(FAKE);
  });

  test("the config defaults to ${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml under the given HOME", async () => {
    const s = setup();
    mkdirSync(join(s.home, ".config", "hapi"), { recursive: true });
    writeFileSync(join(s.home, ".config", "hapi", "secrets.yaml"), readFileSync(s.config));
    capture();
    expect(await secretsCheck([], s.deps)).toBe(0);
    await expect(secretsCheck([], { ...s.deps, env: { HOME: join(s.root, "elsewhere") } })).rejects.toThrow(/no secrets config at .*elsewhere\/\.config\/hapi\/secrets\.yaml: run `mise run secrets:init`/);
  });

  test("no automatic fallback: a failing configured provider is the error", async () => {
    const s = setup();
    const bwsCalls: string[][] = [];
    // Even with a working env file and bws runner on hand, sops is what the config picks, and its failure is final.
    const plain = join(s.root, "plain.env");
    writeFileSync(plain, envFileText("store", Object.fromEntries(Object.entries(fullStore()).map(([k, v]) => [secretEnvName(k), v]))), { mode: 0o600 });
    const deps = {
      ...s.deps,
      sops: async () => ({ code: 128, stdout: "", stderr: "Failed to get the data key required to decrypt the SOPS file.\n\nGroup 0: FAILED\n" }),
      bws: async (args: string[]) => {
        bwsCalls.push(args);
        return "{}";
      },
    };
    const e = await caught(secretsResolve(["--config", s.config], deps));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toBe(`sops could not decrypt ${s.store.file} (exit 128): Failed to get the data key required to decrypt the SOPS file.`);
    expect(bwsCalls).toEqual([]);
    expect(existsSync(join(s.xdg, "hapi", "env"))).toBe(false);
  });

  test("a store missing an MCP server's secret is caught by the manifest check before anything is read", async () => {
    const s = setup();
    const dir = tempDir();
    const manifestFile = join(dir, "secrets.yaml");
    writeFileSync(manifestFile, "hermes: {}\narchon: {}\nresearch: {}\nhost: {}\n");
    await expect(secretsResolve(["--config", s.config], { ...s.deps, manifestFile })).rejects.toThrow(
      /research\/HAPI_MCP_CONTEXT7_API_KEY: .*policy\/mcp\.yaml's context7 server needs secret:hapi-mcp-context7-api-key/,
    );
    expect(s.store.calls).toEqual([]);
  });

  test("an env-file config is warned about as a downgrade on every run", async () => {
    const { err } = capture();
    const s = setup();
    const plain = join(s.root, "plain.env");
    writeFileSync(plain, envFileText("store", Object.fromEntries(Object.entries(fullStore()).map(([k, v]) => [secretEnvName(k), v]))), { mode: 0o600 });
    const config = join(s.root, "env-file.yaml");
    writeFileSync(config, `provider: env-file\nenv_file: { file: ${plain} }\n`);
    expect(await secretsResolve(["--config", config], s.deps)).toBe(0);
    expect(err.join("\n")).toMatch(/env-file provider is a downgrade/);
  });

  test("through `hapi`: exit 1, and stderr names the problem", async () => {
    const { out, err } = capture();
    const s = setup();
    const config = join(s.root, "env-file.yaml");
    // An env file that isn't 0600: refused before it is read. `main` uses the real runners and env, and this config needs neither.
    const plain = join(s.root, "loose.env");
    writeFileSync(plain, "HAPI_A='x'\n", { mode: 0o644 });
    writeFileSync(config, `provider: env-file\nenv_file: { file: ${plain} }\n`);
    expect(await main(["secrets", "check", "--config", config])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/^hapi secrets check: env file .*loose\.env must be mode 0600/m);
  });

  test("usage errors exit 2", async () => {
    const { err } = capture();
    const deps = { env: {} };
    expect(await secretsResolve(["--nope"], deps)).toBe(2);
    expect(await secretsResolve(["--config"], deps)).toBe(2);
    expect(await secretsResolve(["--map", "x"], deps)).toBe(2);
    expect(await secretsCheck(["--dry-run"], deps)).toBe(2);
    expect(await secretsEdit(["--file", "x"], deps)).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi secrets resolve [--config file] [--dry-run]");
    expect(err.join("\n")).toContain("usage: hapi secrets check [--config file]");
    expect(err.join("\n")).toContain("usage: hapi secrets edit [--config file]");
  });

  test("edit runs `sops edit` on the configured file, interactively, with the age key set and plaintext temp files on the tmpfs", async () => {
    const { err } = capture();
    const s = setup();
    const runs: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    const interactive = async (cmd: string, args: string[], o: { env: Record<string, string> }) => {
      runs.push({ cmd, args, env: o.env });
      return 0;
    };
    const env = { ...s.env, EDITOR: "vi", TERM: "xterm", SOPS_AGE_KEY: "AGE-NOT-A-KEY", SOPS_AGE_RECIPIENTS: "age1other" };
    expect(await secretsEdit(["--config", s.config], { ...s.deps, env, interactive })).toBe(0);
    expect(runs).toEqual([
      {
        cmd: "sops",
        args: ["--config", "/dev/null", "edit", "--input-type", "yaml", "--output-type", "yaml", s.store.file],
        env: {
          HOME: s.home,
          XDG_RUNTIME_DIR: s.xdg,
          // The pinned age first, for any age plugin sops runs; and no gpg-agent.
          PATH: `${FAKE_AGE_DIR}:/usr/bin:/bin`,
          GPG_AGENT_INFO: "",
          EDITOR: "vi",
          TERM: "xterm",
          // Every other SOPS_* variable is dropped, so the shell can't add a recipient or a key.
          SOPS_AGE_KEY_FILE: s.store.ageKeyFile,
          SOPS_DISABLE_VERSION_CHECK: "1",
          TMPDIR: join(s.xdg, "hapi"),
        },
      },
    ]);
    // sops exits 200 when the file was not changed: that's fine.
    expect(await secretsEdit(["--config", s.config], { ...s.deps, interactive: async () => 200 })).toBe(0);
    expect(await secretsEdit(["--config", s.config], { ...s.deps, interactive: async () => 1 })).toBe(1);
    expect(err).toEqual(["hapi secrets edit: sops exited with status 1; the file is unchanged unless sops said otherwise"]);
  });

  test("edit works with sops only, and needs XDG_RUNTIME_DIR for sops's plaintext temp file", async () => {
    const s = setup();
    const interactive = async () => 0;
    const config = join(s.root, "bws.yaml");
    writeFileSync(config, "provider: bws\nbws: { ids: {} }\n");
    await expect(secretsEdit(["--config", config], { ...s.deps, interactive })).rejects.toThrow(/sops provider only/);
    await expect(secretsEdit(["--config", s.config], { ...s.deps, env: { HOME: s.home }, interactive })).rejects.toThrow(/XDG_RUNTIME_DIR/);
  });
});

describe("checkSecrets", () => {
  test("masks an unknown name that isn't a logical name in the API itself, not only in the CLI", async () => {
    const manifest: Manifest = { hermes: { ANTHROPIC_API_KEY: "hapi-hermes-key" } };
    const { provider } = fakeProvider({ "hapi-hermes-key": "h", "hapi-old-key": "x", [FAKE]: "y" });
    const { unknown } = await checkSecrets(manifest, provider);
    expect(unknown).toEqual(["hapi-old-key", "(a name that is not a logical name, not shown)"]);
    expect(JSON.stringify(unknown)).not.toContain(FAKE);
  });
});
