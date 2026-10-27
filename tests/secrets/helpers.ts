/**
 * Test helpers for tests/secrets: temp dirs, console capture, and fakes for
 * the sops store and its runner. Nothing here reads the real HOME, the real
 * ~/.config or a real key: every path is under a fresh temp directory, and
 * every value is an obviously fake string.
 */
import { spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { SopsRunner } from "../../src/secrets/providers/sops";

const temps: string[] = [];
const restores: (() => void)[] = [];

/** Undo everything: call it from afterEach. */
export function cleanup(): void {
  for (const r of restores.splice(0)) r();
  for (const d of temps.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
}

/** A fresh directory, mode 0700 and ours, like $XDG_RUNTIME_DIR. Removed by `cleanup`. */
export function tempDir(prefix = "hapi-secrets-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Capture console.log and console.error until `cleanup`. */
export function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restores.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}

export const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};

/** A recipient-shaped string (no key behind it) and an encrypted-looking value, as sops writes them. */
export const FAKE_RECIPIENT = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
export const ENC = "ENC[AES256_GCM,data:ZmFrZQ==,iv:ZmFrZQ==,tag:ZmFrZQ==,type:str]";

/** The text of a sops-encrypted YAML file holding `names` (values look encrypted; "" stays "", as sops leaves it). */
export function sopsFileText(names: Record<string, "" | "enc">, metadata: Record<string, unknown> = {}): string {
  const doc: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(names)) doc[name] = v === "" ? "" : ENC;
  doc.sops = { age: [{ recipient: FAKE_RECIPIENT, enc: "-----BEGIN AGE ENCRYPTED FILE-----\nZmFrZQ==\n-----END AGE ENCRYPTED FILE-----\n" }], version: "3.13.3", ...metadata };
  return stringify(doc);
}

/**
 * A sops store in `dir`: `secrets.enc.yaml` shaped like sops's output for
 * `values`, and a 0600 age key file at `keys.txt` (fake content). Returns the
 * paths and a fake SopsRunner that "decrypts" to `values` and records each call.
 */
export function sopsStore(dir: string, values: Record<string, string>) {
  const file = join(dir, "secrets.enc.yaml");
  writeFileSync(file, sopsFileText(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v === "" ? "" : "enc"]))));
  const ageKeyFile = join(dir, "age", "keys.txt");
  mkdirSync(join(dir, "age"), { mode: 0o700, recursive: true });
  writeFileSync(ageKeyFile, "# not a real age key (unit-test fixture)\n", { mode: 0o600 });
  const calls: { args: string[]; env: Record<string, string>; stdin?: string }[] = [];
  const run: SopsRunner = async (args, o) => {
    calls.push({ args, env: o.env, ...(o.stdin === undefined ? {} : { stdin: o.stdin }) });
    return { code: 0, stdout: JSON.stringify(values), stderr: "" };
  };
  return { file, ageKeyFile, run, calls };
}

/** A secrets config file for the sops store in `dir`. */
export function sopsConfig(dir: string, store: { file: string; ageKeyFile: string }): string {
  const path = join(dir, "secrets.yaml");
  writeFileSync(path, stringify({ provider: "sops", sops: { file: store.file, age_key_file: store.ageKeyFile } }));
  return path;
}

/** Every logical name stack/secrets.yaml lists, with a fake value each. */
export function fullStore(): Record<string, string> {
  const names = [
    "hapi-hermes-anthropic-api-key", "hapi-hermes-slack-bot-token", "hapi-hermes-slack-app-token", "hapi-hermes-slack-allowed-users",
    "hapi-archon-anthropic-api-key", "hapi-archon-opencode-api-key", "hapi-archon-jev-openrouter-api-key",
    "hapi-research-brave-search-api-key", "hapi-research-exa-api-key", "hapi-mcp-context7-api-key",
    "hapi-host-planner-app-id", "hapi-host-planner-app-private-key", "hapi-host-factory-app-id", "hapi-host-factory-app-private-key",
  ];
  return Object.fromEntries(names.map((n) => [n, `fake-${n}-value`]));
}
