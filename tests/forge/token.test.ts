import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { authedGit } from "../../src/forge/github/git";
import { PURPOSE_PERMISSIONS, forgeToken, type TokenPurpose } from "../../src/forge/github/token";
import { GITHUB_API as API } from "../../src/forge/github/rest";
import { runCommand } from "../../src/stack/up";
import { capture, cleanup, hostEnv, tempDir } from "../audit/helpers";
import { caught, fakeFetch, type Reply } from "./helpers";

afterEach(cleanup);

const REPO = "example-owner/hapi-sandbox";
const MINTED = "fake-minted-token-5e5e";
const registry = { installations: { planner: 11, factory: 12 }, repos: { [REPO]: { registered: "2026-11-01" } } };
const MINT = `POST ${API}/app/installations/12/access_tokens`;
const REVOKE = `DELETE ${API}/installation/token`;

function setup(over: Record<string, Reply> = {}, installation = 12) {
  const xdg = tempDir("hapi-forge-token-");
  const env = { XDG_RUNTIME_DIR: xdg };
  hostEnv(env);
  const f = fakeFetch({
    [`GET ${API}/repos/${REPO}/installation`]: { status: 200, body: { id: installation, suspended_at: null } },
    [MINT]: (c) => ({
      status: 201,
      body: {
        token: MINTED,
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { ...(c.body as any).permissions, metadata: "read" },
        repository_selection: "selected",
        repositories: [{ name: "hapi-sandbox", full_name: REPO }],
      },
    }),
    [REVOKE]: { status: 204 },
    ...over,
  });
  return { xdg, env, f };
}

describe("forgeToken", () => {
  test("forgeToken mints in process for one repo with only its purpose's permissions, and writes no token file", async () => {
    expect(PURPOSE_PERMISSIONS).toEqual({
      mirror: { contents: "read" },
      push: { contents: "write" },
      pr: { pull_requests: "write" },
      checks: { checks: "read" },
    });
    const { xdg, env, f } = setup();
    for (const p of ["mirror", "push", "pr", "checks"] as TokenPurpose[]) {
      const t = await forgeToken(env, REPO, p, { registry, fetch: f.fetch });
      expect(t.token).toBe(MINTED);
      const mint = f.calls.filter((c) => `${c.method} ${c.url}` === MINT).at(-1)!;
      expect(mint.body).toEqual({ repositories: ["hapi-sandbox"], permissions: PURPOSE_PERMISSIONS[p] });
    }
    expect(existsSync(join(xdg, "hapi", "tokens"))).toBe(false);
  });

  test("forgeToken refuses an unregistered repo before asking GitHub, and an installation policy/repos.yaml doesn't record", async () => {
    const { env, f } = setup();
    const e = await caught(forgeToken(env, "example-owner/other", "push", { registry, fetch: f.fetch }));
    expect(e.message).toBe("example-owner/other is not registered in policy/repos.yaml: the factory acts only on registered repos");
    expect(f.calls).toHaveLength(0);
    const w = setup({}, 99);
    const e2 = await caught(forgeToken(w.env, REPO, "push", { registry, fetch: w.f.fetch }));
    expect(e2.message).toBe(
      "the hapi-factory App's installation on example-owner/hapi-sandbox is 99, but policy/repos.yaml records 12: fix one of them before the factory acts on the repo",
    );
    expect(w.f.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("revoke() revokes once and never throws; an unrevoked token's expiry is said", async () => {
    const { env, f } = setup();
    const t = await forgeToken(env, REPO, "push", { registry, fetch: f.fetch });
    await t.revoke();
    await t.revoke();
    expect(f.calls.filter((c) => `${c.method} ${c.url}` === REVOKE)).toHaveLength(1);
    expect(f.calls.find((c) => c.method === "DELETE")!.headers.authorization).toBe(`Bearer ${MINTED}`);

    const { err } = capture();
    const w = setup({ [REVOKE]: { status: 500 } });
    const t2 = await forgeToken(w.env, REPO, "push", { registry, fetch: w.f.fetch });
    await t2.revoke();
    expect(err).toEqual(["hapi: could not revoke a push token for example-owner/hapi-sandbox; it expires at 2030-01-01T00:00:00Z"]);
    expect(err.join("\n")).not.toContain(MINTED);
  });
});

describe("forgeToken purposes and registry", () => {
  test("PURPOSE_PERMISSIONS is frozen, and a mint gets a copy, so nothing can widen a later mint", async () => {
    expect(Object.isFrozen(PURPOSE_PERMISSIONS)).toBe(true);
    for (const p of Object.values(PURPOSE_PERMISSIONS)) expect(Object.isFrozen(p)).toBe(true);
    expect(() => {
      (PURPOSE_PERMISSIONS.push as Record<string, string>).administration = "write";
    }).toThrow();
    const { env, f } = setup();
    await forgeToken(env, REPO, "push", { registry, fetch: f.fetch });
    const mint = f.calls.find((c) => `${c.method} ${c.url}` === MINT)!;
    expect(mint.body).toEqual({ repositories: ["hapi-sandbox"], permissions: { contents: "write" } });
  });

  test("the default registry is policy/repos.yaml: an unregistered repo is refused with no GitHub call", async () => {
    const { env, f } = setup();
    const e = await caught(forgeToken(env, REPO, "push", { fetch: f.fetch }));
    expect(e.message).toBe(`${REPO} is not registered in policy/repos.yaml: the factory acts only on registered repos`);
    expect(f.calls).toHaveLength(0);
  });
});

describe("authedGit", () => {
  test("authedGit hands git the token as an extraheader in exactly three environment entries", () => {
    expect(authedGit("fake-tok")).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: "AUTHORIZATION: basic " + Buffer.from("x-access-token:fake-tok").toString("base64"),
    });
    for (const bad of ["", "a b", "a\nb"]) expect(() => authedGit(bad)).toThrow("authedGit: the token is empty or holds whitespace");
  });

  test("with real git: authedGit's entries reach git as config from the environment, never argv", async () => {
    const T = "fake-tok-real-git";
    const entries = authedGit(T);
    const cmd = ["git", "config", "--get", "http.https://github.com/.extraheader"];
    const r = await runCommand(cmd, { env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...entries }, inherit: false });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(entries.GIT_CONFIG_VALUE_0!);
    // git saw the header in its environment only: the spawned argv is the four words above, and the token is in no entry's key.
    expect(cmd).toEqual(["git", "config", "--get", "http.https://github.com/.extraheader"]);
    expect(Object.keys(entries).some((k) => k.includes(T))).toBe(false);
    expect(r.stdout).not.toContain(T);
  });
});
