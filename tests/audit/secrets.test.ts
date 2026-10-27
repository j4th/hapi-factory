/**
 * secrets.provider (spec §11.5, H-027): the configured provider, the
 * env-file downgrade reported, and for sops the recipients file and
 * recovery.age beside the store. secrets.check (H-028): what `resolve` would
 * find, through the provider contract (`checkSecrets`): every name found,
 * none empty or invalid, no MCP reference unmapped. Fakes for sops and the
 * checkout boundary; every value is an obviously fake string.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { FAKE_AGE_DIR, fullStore, sopsConfig, sopsStore } from "../secrets/helpers";
import { cleanup, cleanWorld, only, tempDir } from "./helpers";

afterEach(cleanup);

type World = Awaited<ReturnType<typeof cleanWorld>>;
const results = async (w: World) => {
  const all = await runAudit(w.ctx);
  return { provider: only(all, "secrets.provider"), check: only(all, "secrets.check") };
};

/** A sops store with every name filled, its config at $HAPI_SECRETS_CONFIG, and the fakes the provider needs. */
async function sopsWorld(values = fullStore()) {
  const w = await cleanWorld();
  const dir = tempDir("hapi-audit-store-");
  const store = sopsStore(dir, values);
  w.ctx.env.HAPI_SECRETS_CONFIG = sopsConfig(dir, store);
  const checkout = tempDir("hapi-audit-checkout-");
  w.ctx.secrets = { sops: store.run, ageDir: async () => FAKE_AGE_DIR, repoRoot: async () => checkout };
  return { w, store };
}

/** An env-file store (the downgrade) holding `values`. */
async function envFileWorld(values = fullStore()) {
  const w = await cleanWorld();
  const dir = tempDir("hapi-audit-envfile-");
  const file = join(dir, "secrets.env");
  writeFileSync(file, Object.entries(values).map(([k, v]) => `${k.toUpperCase().replaceAll("-", "_")}='${v}'\n`).join(""), { mode: 0o600 });
  const config = join(dir, "secrets.yaml");
  writeFileSync(config, `provider: env-file\nenv_file:\n  file: ${file}\n`);
  w.ctx.env.HAPI_SECRETS_CONFIG = config;
  const checkout = tempDir("hapi-audit-checkout-");
  w.ctx.secrets = { repoRoot: async () => checkout };
  return w;
}

describe("secrets.provider and secrets.check", () => {
  test("no secrets config is a skip for both, naming where it looked", async () => {
    const w = await cleanWorld();
    const r = await results(w);
    expect(r.provider.status).toBe("skip");
    expect(r.provider.detail).toContain(join(w.ctx.env.HOME!, ".config", "hapi", "secrets.yaml"));
    expect(r.check.status).toBe("skip");
  });

  test("sops with its recipients file and recovery.age, every name found: both pass, and no value is printed", async () => {
    const { w, store } = await sopsWorld();
    const r = await results(w);
    expect(r.provider).toMatchObject({ status: "pass" });
    expect(r.provider.detail).toContain("sops");
    expect(r.provider.detail).toContain(store.recipients);
    expect(r.provider.detail).toContain(store.recovery);
    expect(r.check.status).toBe("pass");
    expect(r.check.detail).toMatch(/\d+ secrets found/);
    for (const v of Object.values(fullStore())) expect(`${r.provider.detail} ${r.check.detail}`).not.toContain(v);
  });

  test("no recovery.age beside the store, or recipients that don't match it, fails secrets.provider", async () => {
    let { w, store } = await sopsWorld();
    rmSync(store.recovery);
    let r = await results(w);
    expect(r.provider.status).toBe("fail");
    expect(r.provider.detail).toContain("no recovery.age");

    ({ w, store } = await sopsWorld());
    rmSync(store.recipients);
    r = await results(w);
    expect(r.provider.status).toBe("fail");
    expect(r.provider.detail).toContain("recipients");
  });

  test("a missing or empty secret fails secrets.check, naming it, never its value", async () => {
    const values = fullStore();
    delete values["hapi-archon-opencode-api-key"];
    values["hapi-hermes-slack-bot-token"] = "";
    const { w } = await sopsWorld(values);
    const r = await results(w);
    expect(r.check.status).toBe("fail");
    expect(r.check.detail).toContain("archon/OPENCODE_API_KEY (hapi-archon-opencode-api-key) is missing");
    expect(r.check.detail).toContain("hermes/SLACK_BOT_TOKEN (hapi-hermes-slack-bot-token) is empty");
  });

  test("a value resolve would refuse is invalid, and fails", async () => {
    const values = fullStore();
    values["hapi-research-exa-api-key"] = "it's quoted";
    const { w } = await sopsWorld(values);
    const r = await results(w);
    expect(r.check.status).toBe("fail");
    expect(r.check.detail).toContain("research/EXA_API_KEY (hapi-research-exa-api-key) is invalid");
    expect(r.check.detail).not.toContain("it's quoted");
  });

  test("the env-file provider is a downgrade: a fail in normal mode, a skip with --dev; its check still runs", async () => {
    const w = await envFileWorld();
    let r = await results(w);
    expect(r.provider.status).toBe("fail");
    expect(r.provider.detail).toContain("env-file");
    expect(r.provider.detail).toContain("downgrade");
    expect(r.check.status).toBe("pass");

    w.ctx.dev = true;
    r = await results(w);
    expect(r.provider.status).toBe("skip");
    expect(r.provider.detail).toContain("--dev");
  });

  test("a provider that fails is a fail, not a skip (fail closed)", async () => {
    const { w } = await sopsWorld();
    w.ctx.secrets = { ...w.ctx.secrets, sops: async () => ({ code: 128, stdout: "", stderr: "Failed to get the data key" }) };
    const r = await results(w);
    expect(r.check.status).toBe("fail");
    expect(r.check.detail).toContain("128");
  });

  test("a config that doesn't load is a fail", async () => {
    const w = await cleanWorld();
    const dir = tempDir();
    mkdirSync(join(dir, "c"));
    writeFileSync(join(dir, "c", "secrets.yaml"), "provider: vault\n");
    w.ctx.env.HAPI_SECRETS_CONFIG = join(dir, "c", "secrets.yaml");
    const r = await results(w);
    expect(r.provider.status).toBe("fail");
    expect(r.check.status).toBe("fail");
  });
});
