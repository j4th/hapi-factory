import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli";
import { loadPolicy, PolicyError } from "../../src/policy/load";
import {
  type BwsRunner,
  checkSecrets,
  isPlaceholderId,
  loadSecretMap,
  mcpSecretGaps,
  resolveSecrets,
  SECRET_ZONES,
  SecretError,
  type SecretMap,
  secretsResolve,
} from "../../src/secrets/bws";
import { parseEnvFile } from "../../src/secrets/files";

// Obviously fake values: none of them is, or looks like, a real credential.
const FAKE = "fake-secret-value-7f3a";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const MAP_FILE = "stack/secrets.map.yaml";

let temps: string[] = [];
let restore: (() => void)[] = [];
afterEach(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  for (const r of restore) r();
  temps = [];
  restore = [];
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hapi-secrets-"));
  temps.push(dir);
  return dir;
}
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restore.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}
/** A fake bws: `values` maps a secret id to its value; any other id fails as bws does on a 404. Records every call. */
function fakeBws(values: Record<string, string>): { bws: BwsRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    bws: async (args) => {
      calls.push(args);
      const id = args[2]!;
      if (!Object.hasOwn(values, id)) throw new Error("404 Resource not found");
      return JSON.stringify({ object: "secret", id, key: "some-key", value: values[id] });
    },
  };
}
const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe("resolveSecrets", () => {
  test("resolveSecrets writes 0600 env files", async () => {
    const outDir = join(tempDir(), "hapi");
    const { bws } = fakeBws({ [ID_A]: "x", [ID_B]: "y" });
    const paths = await resolveSecrets({ archon: { ANTHROPIC_API_KEY: ID_A }, hermes: { SLACK_BOT_TOKEN: ID_B } }, { bws, outDir });
    expect(paths).toEqual({ archon: join(outDir, "archon.env"), hermes: join(outDir, "hermes.env") });
    expect(mode(paths.archon!)).toBe(0o600);
    expect(mode(paths.hermes!)).toBe(0o600);
    expect(mode(outDir)).toBe(0o700);
    expect(parseEnvFile(readFileSync(paths.archon!, "utf8"))).toEqual({ ANTHROPIC_API_KEY: "x" });
    expect(parseEnvFile(readFileSync(paths.hermes!, "utf8"))).toEqual({ SLACK_BOT_TOKEN: "y" });
    // Written atomically: no temp file is left behind.
    expect(readdirSync(outDir).sort()).toEqual(["archon.env", "hermes.env"]);
  });

  test("resolveSecrets fails closed on missing secret", async () => {
    const outDir = tempDir();
    await expect(resolveSecrets({ archon: { ANTHROPIC_API_KEY: "id-1" } }, { bws: async () => { throw new Error("404"); }, outDir }))
      .rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(existsSync(join(outDir, "archon.env"))).toBe(false); // nothing partial left behind
  });

  test("a miss in one zone leaves no file for any zone, and the error is a SecretError naming zone and key", async () => {
    const outDir = tempDir();
    const { bws } = fakeBws({ [ID_A]: FAKE });
    const e = await caught(resolveSecrets({ hermes: { ANTHROPIC_API_KEY: ID_A }, research: { EXA_API_KEY: ID_B } }, { bws, outDir }));
    expect(e).toBeInstanceOf(SecretError);
    expect((e as SecretError).zone).toBe("research");
    expect((e as SecretError).key).toBe("EXA_API_KEY");
    expect(e.message).toContain("research/EXA_API_KEY");
    expect(readdirSync(outDir)).toEqual([]);
  });

  test("a thrown error never contains a secret value", async () => {
    const outDir = tempDir();
    // KEY_A resolves to FAKE; KEY_B then fails. The error names KEY_B, never FAKE.
    const { bws } = fakeBws({ [ID_A]: FAKE });
    const e1 = await caught(resolveSecrets({ archon: { KEY_A: ID_A, KEY_B: ID_B } }, { bws, outDir }));
    expect(e1.message).toContain("KEY_B");
    expect(e1.message).not.toContain(FAKE);

    // bws prints something that isn't JSON but holds the value: JSON.parse's own message would quote it.
    const e2 = await caught(resolveSecrets({ archon: { KEY_A: ID_A } }, { bws: async () => `value: ${FAKE}`, outDir }));
    expect(e2.message).toContain("KEY_A");
    expect(e2.message).not.toContain(FAKE);

    // A value an env file can't carry is refused by key, not shown.
    const quoted = `${FAKE}'tail`;
    const e3 = await caught(resolveSecrets({ archon: { KEY_A: ID_A } }, { bws: fakeBws({ [ID_A]: quoted }).bws, outDir }));
    expect(e3.message).toContain("KEY_A");
    expect(e3.message).toContain("single quote");
    expect(e3.message).not.toContain(FAKE);
    expect(readdirSync(outDir)).toEqual([]);
  });

  test("an empty or blank secret counts as missing", async () => {
    const outDir = tempDir();
    for (const value of ["", "  \n"]) {
      const e = await caught(resolveSecrets({ hermes: { SLACK_APP_TOKEN: ID_A } }, { bws: fakeBws({ [ID_A]: value }).bws, outDir }));
      expect(e).toBeInstanceOf(SecretError);
      expect(e.message).toMatch(/SLACK_APP_TOKEN: .*empty/);
    }
    const noValue = await caught(resolveSecrets({ hermes: { SLACK_APP_TOKEN: ID_A } }, { bws: async () => '{"id":"x"}', outDir }));
    expect(noValue.message).toMatch(/SLACK_APP_TOKEN: .*no string value/);
    expect(readdirSync(outDir)).toEqual([]);
  });

  test("calls `bws secret get <id> --output json --color no`, once per id", async () => {
    const outDir = tempDir();
    const f = fakeBws({ [ID_A]: "k" });
    await resolveSecrets({ archon: { ANTHROPIC_API_KEY: ID_A, CLAUDE_API_KEY: ID_A } }, { bws: f.bws, outDir });
    expect(f.calls).toEqual([["secret", "get", ID_A, "--output", "json", "--color", "no"]]);
    expect(parseEnvFile(readFileSync(join(outDir, "archon.env"), "utf8"))).toEqual({ ANTHROPIC_API_KEY: "k", CLAUDE_API_KEY: "k" });
  });

  test("values with $, quotes, #, spaces, backslashes and newlines round-trip literally", async () => {
    const outDir = tempDir();
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIfake+/=\n-----END RSA PRIVATE KEY-----\n";
    const odd = 'a$b ${HOME} "q" #c \\d';
    const { bws } = fakeBws({ [ID_A]: pem, [ID_B]: odd });
    await resolveSecrets({ host: { HAPI_PLANNER_APP_PRIVATE_KEY: ID_A, ODD: ID_B } }, { bws, outDir });
    const text = readFileSync(join(outDir, "host.env"), "utf8");
    expect(parseEnvFile(text)).toEqual({ HAPI_PLANNER_APP_PRIVATE_KEY: pem, ODD: odd });
    // Single quotes: Docker Compose reads them literally (no ${...} interpolation, newlines kept).
    expect(text).toContain(`ODD='${odd}'\n`);
  });

  test("a placeholder id fails before bws is called", async () => {
    const outDir = tempDir();
    const f = fakeBws({});
    const e = await caught(resolveSecrets({ research: { BRAVE_SEARCH_API_KEY: "00000000-0000-0000-0000-000000000301" } }, { bws: f.bws, outDir }));
    expect(e).toBeInstanceOf(SecretError);
    expect(e.message).toMatch(/research\/BRAVE_SEARCH_API_KEY: .*placeholder/);
    expect(f.calls).toEqual([]);
  });

  test("a bad zone, env name or id is refused before bws is called, and a bad name or id is not echoed", async () => {
    const outDir = tempDir();
    const f = fakeBws({});
    await expect(resolveSecrets({ nope: { A: ID_A } } as SecretMap, { bws: f.bws, outDir })).rejects.toThrow(/unknown secrets zone 'nope'/);
    const badName = await caught(resolveSecrets({ hermes: { [`${FAKE}=x`]: ID_A } }, { bws: f.bws, outDir }));
    expect(badName.message).toMatch(/hermes: an env name/);
    expect(badName.message).not.toContain(FAKE);
    for (const id of ["--access-token=x", "", `${FAKE} x`]) {
      const badId = await caught(resolveSecrets({ hermes: { SLACK_BOT_TOKEN: id } }, { bws: f.bws, outDir }));
      expect(badId).toBeInstanceOf(SecretError);
      expect(badId.message).toMatch(/hermes\/SLACK_BOT_TOKEN: .*not a bws secret id/);
      if (id !== "") expect(badId.message).not.toContain(id);
    }
    expect(f.calls).toEqual([]);
  });

  test("an existing outDir is tightened to 0700; a symlinked outDir is refused", async () => {
    const base = tempDir();
    const loose = join(base, "loose");
    mkdirSync(loose, { mode: 0o755 });
    await resolveSecrets({ hermes: { A: ID_A } }, { bws: fakeBws({ [ID_A]: "v" }).bws, outDir: loose });
    expect(mode(loose)).toBe(0o700);

    const link = join(base, "link");
    symlinkSync(loose, link);
    await expect(resolveSecrets({ hermes: { A: ID_A } }, { bws: fakeBws({ [ID_A]: "v" }).bws, outDir: link })).rejects.toThrow(/not a directory/);
  });
});

describe("checkSecrets (dry run)", () => {
  test("reports found, missing and placeholder per key, and never a value", async () => {
    const { bws, calls } = fakeBws({ [ID_A]: FAKE, [ID_C]: "" });
    const results = await checkSecrets(
      { hermes: { SLACK_BOT_TOKEN: ID_A, SLACK_APP_TOKEN: ID_B }, research: { EXA_API_KEY: "00000000-0000-0000-0000-000000000302", BRAVE_SEARCH_API_KEY: ID_C } },
      { bws },
    );
    expect(results.map(({ zone, key, status }) => ({ zone, key, status }))).toEqual([
      { zone: "hermes", key: "SLACK_BOT_TOKEN", status: "found" },
      { zone: "hermes", key: "SLACK_APP_TOKEN", status: "missing" },
      { zone: "research", key: "EXA_API_KEY", status: "placeholder" },
      { zone: "research", key: "BRAVE_SEARCH_API_KEY", status: "missing" },
    ]);
    expect(JSON.stringify(results)).not.toContain(FAKE);
    expect(calls.length).toBe(3); // the placeholder is never looked up
  });
});

describe("stack/secrets.map.yaml", () => {
  const map = loadSecretMap(MAP_FILE);

  test("has the four zones and holds only bws secret ids, never values", () => {
    expect(Object.keys(map).sort()).toEqual([...SECRET_ZONES].sort());
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const zone of SECRET_ZONES) {
      for (const [key, id] of Object.entries(map[zone]!)) {
        expect(`${zone}/${key}=${id}`).toMatch(new RegExp(`=${UUID.source.slice(1)}`, "i"));
      }
    }
    // The file text has no line that assigns anything but an id (comments aside).
    const assignments = readFileSync(MAP_FILE, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l !== "" && !/^[a-z]+:$/.test(l));
    for (const line of assignments) expect(line).toMatch(/^[A-Z][A-Z0-9_]*: [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test("names exactly the keys each zone needs", () => {
    const keys = (zone: keyof typeof map) => Object.keys(map[zone]!).sort();
    expect(keys("hermes")).toEqual(["ANTHROPIC_API_KEY", "SLACK_ALLOWED_USERS", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"]);
    expect(keys("archon")).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "HAPI_JEV_OPENROUTER_API_KEY", "OPENCODE_API_KEY"]);
    expect(keys("research")).toEqual(["BRAVE_SEARCH_API_KEY", "EXA_API_KEY", "HAPI_MCP_CONTEXT7_API_KEY"]);
    expect(keys("host")).toEqual(["HAPI_FACTORY_APP_ID", "HAPI_FACTORY_APP_PRIVATE_KEY", "HAPI_PLANNER_APP_ID", "HAPI_PLANNER_APP_PRIVATE_KEY"]);
  });

  test("GitHub App private keys stay in the host zone, never in a container's env file (spec §4.3)", () => {
    for (const zone of SECRET_ZONES.filter((z) => z !== "host")) {
      expect(Object.keys(map[zone]!).filter((k) => /APP_PRIVATE_KEY|GITHUB/.test(k))).toEqual([]);
    }
  });

  test("Pi and Archon's Claude nodes share the hapi-factory workspace key; Hermes has its own", () => {
    expect(map.archon!.CLAUDE_API_KEY).toBe(map.archon!.ANTHROPIC_API_KEY!);
    expect(map.hermes!.ANTHROPIC_API_KEY).not.toBe(map.archon!.ANTHROPIC_API_KEY!);
  });

  test("the committed map is a template: every id is a placeholder, unique per secret (real ids live in a copy outside the repo)", () => {
    // The repo is public, and a deployment's real bws ids never enter it: the filled-in copy
    // lives outside the repo and is passed with --map (docs/secrets.md, "Filling in the map").
    // So this fails if anyone fills in stack/secrets.map.yaml itself.
    const ids = SECRET_ZONES.flatMap((z) => Object.values(map[z]!));
    expect(ids.filter((id) => !isPlaceholderId(id))).toEqual([]);
    // One secret per id, except CLAUDE_API_KEY, which reuses ANTHROPIC_API_KEY's in the archon zone.
    expect(new Set(ids).size).toBe(ids.length - 1);
  });

  test("covers every bws reference of the MCP servers each zone loads (policy/mcp.yaml)", () => {
    expect(mcpSecretGaps(loadPolicy("policy"), map)).toEqual([]);
  });

  test("turning on o11y needs the Phoenix key in the hermes zone", () => {
    expect(mcpSecretGaps(loadPolicy("policy"), map, { o11y: true })).toEqual([
      { zone: "hermes", server: "phoenix", env: "HAPI_MCP_PHOENIX_VIEWER_KEY", bwsKey: "hapi-mcp-phoenix-viewer-key" },
    ]);
  });
});

describe("loadSecretMap", () => {
  function mapFile(text: string): string {
    const file = join(tempDir(), "secrets.map.yaml");
    writeFileSync(file, text);
    return file;
  }
  const full = (extra = "") =>
    `hermes:\n  A: ${ID_A}\narchon:\n  B: ${ID_B}\nresearch:\n  C: ${ID_C}\nhost:\n  D: ${ID_A}\n${extra}`;

  test("loads a valid map", () => {
    expect(loadSecretMap(mapFile(full()))).toEqual({ hermes: { A: ID_A }, archon: { B: ID_B }, research: { C: ID_C }, host: { D: ID_A } });
  });

  test("a secret pasted in place of an id is refused without echoing it", () => {
    const e = (() => {
      try {
        loadSecretMap(mapFile(full().replace(`A: ${ID_A}`, `A: ${FAKE}`)));
      } catch (err) {
        return err as PolicyError;
      }
      throw new Error("expected a PolicyError");
    })();
    expect(e).toBeInstanceOf(PolicyError);
    expect(e.message).toContain("/hermes/A");
    expect(e.message).not.toContain(FAKE);
  });

  test("a secret pasted as a key name is refused without echoing it", () => {
    let message = "";
    try {
      loadSecretMap(mapFile(full().replace("  A:", `  ${FAKE}:`)));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/\/hermes\/\(a name that is not an env name, not shown\)/);
    expect(message).not.toContain(FAKE);
  });

  test("an unknown or missing zone is refused", () => {
    expect(() => loadSecretMap(mapFile(full("extra:\n  E: " + ID_A + "\n")))).toThrow(/\/extra: unknown key/);
    expect(() => loadSecretMap(mapFile(`hermes:\n  A: ${ID_A}\n`))).toThrow(/\/archon: missing required key/);
  });
});

describe("hapi secrets resolve", () => {
  /** A complete map file with non-placeholder ids, covering policy/mcp.yaml's research-zone reference. */
  function mapFile(): string {
    const file = join(tempDir(), "secrets.map.yaml");
    writeFileSync(
      file,
      `hermes:\n  SLACK_BOT_TOKEN: ${ID_A}\narchon:\n  ANTHROPIC_API_KEY: ${ID_B}\nresearch:\n  HAPI_MCP_CONTEXT7_API_KEY: ${ID_C}\nhost:\n  HAPI_PLANNER_APP_ID: ${ID_A}\n`,
    );
    return file;
  }

  test("writes $XDG_RUNTIME_DIR/hapi/<zone>.env and prints only the paths", async () => {
    const { out } = capture();
    const xdg = tempDir();
    const { bws } = fakeBws({ [ID_A]: FAKE, [ID_B]: "b", [ID_C]: "c" });
    expect(await secretsResolve(["--map", mapFile()], { bws, env: { XDG_RUNTIME_DIR: xdg } })).toBe(0);
    const dir = join(xdg, "hapi");
    expect(out).toEqual(["archon", "hermes", "host", "research"].map((z) => join(dir, `${z}.env`)).sort());
    expect(mode(dir)).toBe(0o700);
    expect(parseEnvFile(readFileSync(join(dir, "hermes.env"), "utf8"))).toEqual({ SLACK_BOT_TOKEN: FAKE });
    expect(out.join("\n")).not.toContain(FAKE);
  });

  test("without XDG_RUNTIME_DIR it fails clearly and writes nothing (no /tmp fallback)", async () => {
    const { bws, calls } = fakeBws({ [ID_A]: FAKE });
    for (const env of [{}, { XDG_RUNTIME_DIR: "" }, { XDG_RUNTIME_DIR: "relative/dir" }]) {
      await expect(secretsResolve(["--map", mapFile()], { bws, env })).rejects.toThrow(/XDG_RUNTIME_DIR/);
    }
    expect(calls).toEqual([]);
  });

  test("--dry-run lists every key as found or missing, never a value, and needs no XDG_RUNTIME_DIR", async () => {
    const { out, err } = capture();
    const { bws } = fakeBws({ [ID_A]: FAKE, [ID_C]: "c" });
    expect(await secretsResolve(["--dry-run", "--map", mapFile()], { bws, env: {} })).toBe(1);
    expect(out).toEqual([
      "found        hermes/SLACK_BOT_TOKEN",
      "missing      archon/ANTHROPIC_API_KEY (bws secret get failed: 404 Resource not found)",
      "found        research/HAPI_MCP_CONTEXT7_API_KEY",
      "found        host/HAPI_PLANNER_APP_ID",
    ]);
    expect(err.join("\n")).toContain("1 of 4 secrets not found: archon/ANTHROPIC_API_KEY");
    expect([...out, ...err].join("\n")).not.toContain(FAKE);
  });

  test("--dry-run exits 0 when every key is found", async () => {
    capture();
    const { bws } = fakeBws({ [ID_A]: FAKE, [ID_B]: "b", [ID_C]: "c" });
    expect(await secretsResolve(["--dry-run", "--map", mapFile()], { bws, env: {} })).toBe(0);
  });

  test("--dry-run on the committed map reports every key as a placeholder", async () => {
    const { out } = capture();
    const { bws, calls } = fakeBws({});
    expect(await secretsResolve(["--dry-run"], { bws, env: {} })).toBe(1);
    expect(out.length).toBe(15);
    expect(out.every((l) => l.startsWith("placeholder  "))).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a map that misses an MCP server's bws reference fails, naming the env var and bws key", async () => {
    const file = join(tempDir(), "secrets.map.yaml");
    writeFileSync(file, `hermes:\n  A: ${ID_A}\narchon:\n  B: ${ID_B}\nresearch:\n  C: ${ID_C}\nhost:\n  D: ${ID_A}\n`);
    const { bws, calls } = fakeBws({ [ID_A]: "a", [ID_B]: "b", [ID_C]: "c" });
    const xdg = tempDir();
    await expect(secretsResolve(["--map", file], { bws, env: { XDG_RUNTIME_DIR: xdg } })).rejects.toThrow(
      /research\/HAPI_MCP_CONTEXT7_API_KEY: .*policy\/mcp\.yaml.*context7.*bws:hapi-mcp-context7-api-key/,
    );
    expect(calls).toEqual([]);
    expect(existsSync(join(xdg, "hapi"))).toBe(false);
  });

  test("a failure after a value was fetched names the failing key, never the value, and writes nothing", async () => {
    const { out, err } = capture();
    const xdg = tempDir();
    const file = join(tempDir(), "secrets.map.yaml");
    writeFileSync(file, `hermes:\n  KEY_A: ${ID_A}\n  KEY_B: ${ID_B}\narchon: {}\nresearch:\n  HAPI_MCP_CONTEXT7_API_KEY: ${ID_A}\nhost: {}\n`);
    const { bws } = fakeBws({ [ID_A]: FAKE });
    const e = await caught(secretsResolve(["--map", file], { bws, env: { XDG_RUNTIME_DIR: xdg } }));
    expect(e.message).toContain("hermes/KEY_B");
    expect(e.message).not.toContain(FAKE);
    expect([...out, ...err].join("\n")).not.toContain(FAKE);
    expect(existsSync(join(xdg, "hapi", "hermes.env"))).toBe(false);
  });

  test("through `hapi`: exit 1, and stderr names the key", async () => {
    const { out, err } = capture();
    const xdg = tempDir();
    const file = join(tempDir(), "secrets.map.yaml");
    // `main` uses the real bws runner, so this map fails on a placeholder id before bws could run: a unit test
    // never reaches the vault, even with BWS_ACCESS_TOKEN set.
    writeFileSync(file, `hermes:\n  KEY_A: 00000000-0000-0000-0000-000000000999\narchon: {}\nresearch:\n  HAPI_MCP_CONTEXT7_API_KEY: ${ID_B}\nhost: {}\n`);
    const saved = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = xdg;
    restore.push(() => {
      if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = saved;
    });
    expect(await main(["secrets", "resolve", "--map", file])).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/^hapi secrets resolve: hermes\/KEY_A: still a placeholder bws id/);
    expect(existsSync(join(xdg, "hapi"))).toBe(false);
  });

  test("usage errors exit 2", async () => {
    const { err } = capture();
    expect(await secretsResolve(["--nope"], { bws: fakeBws({}).bws, env: {} })).toBe(2);
    expect(await secretsResolve(["--map"], { bws: fakeBws({}).bws, env: {} })).toBe(2);
    expect(err.join("\n")).toContain("usage: hapi secrets resolve [--dry-run] [--map file] [--policy dir]");
  });
});
