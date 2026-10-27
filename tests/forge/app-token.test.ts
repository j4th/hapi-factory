import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPS,
  appJwt,
  findInstallationId,
  mintInstallationToken,
  TokenScopeError,
  tokenMint,
} from "../../src/forge/github/app-token";
import { envFileText } from "../../src/secrets/files";

// A throwaway key pair, made per run: no key material is ever committed. GitHub's own keys are PKCS#1.
const { privateKey: PKCS1_PEM, publicKey: PUBLIC_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
const PKCS8_PEM = createPrivateKey(PKCS1_PEM).export({ type: "pkcs8", format: "pem" }) as string;
const NOW_MS = 1_700_000_000_000;
const NOW_S = NOW_MS / 1000;
const TOKEN = "fake-installation-token-9c1e";
const API = "https://api.github.com";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
type Reply = { status: number; body?: unknown };
/** A fake fetch: `routes` maps "METHOD url" to a reply. Records every call. */
function fakeFetch(routes: Record<string, Reply | ((c: Call) => Reply)>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (route === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const reply = typeof route === "function" ? route(call) : route;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch: f as unknown as typeof fetch, calls };
}
const granted = (permissions: Record<string, string>, repositories = ["odoo-mcp"], extra: Record<string, unknown> = {}) => ({
  status: 201,
  body: {
    token: TOKEN,
    expires_at: "2023-11-14T23:13:20Z",
    permissions,
    repository_selection: "selected",
    repositories: repositories.map((name) => ({ name, full_name: `example-owner/${name}` })),
    ...extra,
  },
});
const MINT = `POST ${API}/app/installations/123/access_tokens`;
const REVOKE = `DELETE ${API}/installation/token`;
const o = {
  appId: "123456",
  privateKeyPem: PKCS1_PEM,
  installationId: 123,
  repositories: ["odoo-mcp"],
  permissions: { contents: "write", pull_requests: "write" } as Record<string, "read" | "write">,
  now: () => NOW_MS,
};
const caught = async (p: Promise<unknown>): Promise<Error> => {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
};
const b64json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
/** Check an `Authorization: Bearer <jwt>` header: RS256, signed by our key, iat = now - 60, exp = now + 540, iss = the App id. */
function expectAppJwt(authorization: string | undefined, appId: string | number = 123456) {
  expect(authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  const [h, p, s] = authorization!.slice("Bearer ".length).split(".") as [string, string, string];
  expect(b64json(h)).toEqual({ alg: "RS256", typ: "JWT" });
  expect(b64json(p)).toEqual({ iat: NOW_S - 60, exp: NOW_S + 540, iss: appId });
  expect(verify("sha256", Buffer.from(`${h}.${p}`), PUBLIC_PEM, Buffer.from(s, "base64url"))).toBe(true);
}

describe("mintInstallationToken", () => {
  test("mintInstallationToken sends scoped request", async () => {
    const f = fakeFetch({ [MINT]: granted({ contents: "write", pull_requests: "write", metadata: "read" }) });
    expect(await mintInstallationToken({ ...o, fetch: f.fetch })).toEqual({ token: TOKEN, expiresAt: "2023-11-14T23:13:20Z" });
    expect(f.calls.length).toBe(1);
    const call = f.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${API}/app/installations/123/access_tokens`);
    expect(call.body).toEqual({ repositories: ["odoo-mcp"], permissions: { contents: "write", pull_requests: "write" } });
    expect(call.headers.accept).toBe("application/vnd.github+json");
    expect(call.headers["x-github-api-version"]).toBe("2026-03-10");
    expectAppJwt(call.headers.authorization);
  });

  test("a PKCS#8 key works as well as GitHub's PKCS#1", async () => {
    const f = fakeFetch({ [MINT]: granted({ contents: "write", pull_requests: "write" }) });
    await mintInstallationToken({ ...o, privateKeyPem: PKCS8_PEM, fetch: f.fetch });
    expectAppJwt(f.calls[0]!.headers.authorization);
  });

  test("mintInstallationToken rejects broader permissions", async () => {
    const f = fakeFetch({ [MINT]: granted({ contents: "write", administration: "write" }), [REVOKE]: { status: 204 } });
    const e = await caught(mintInstallationToken({ ...o, fetch: f.fetch }));
    expect(e).toBeInstanceOf(TokenScopeError);
    expect(e.message).toContain("administration: write");
    expect(e.message).not.toContain(TOKEN);
    // The broader token is revoked at once, with its own credential.
    expect((e as TokenScopeError).revoked).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([MINT, REVOKE]);
    expect(f.calls[1]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("a higher level than requested is broader; so is metadata above read", async () => {
    for (const permissions of [{ contents: "write" }, { contents: "admin" }, { contents: "read", metadata: "write" }, { contents: "read", issues: "read" }]) {
      const f = fakeFetch({ [MINT]: granted(permissions), [REVOKE]: { status: 204 } });
      const e = await caught(mintInstallationToken({ ...o, permissions: { contents: "read" }, fetch: f.fetch }));
      expect(e).toBeInstanceOf(TokenScopeError);
    }
  });

  test("metadata: read is implicit (GitHub adds it to every token); narrower permissions are fine", async () => {
    const f = fakeFetch({ [MINT]: granted({ contents: "read", metadata: "read" }) });
    await expect(mintInstallationToken({ ...o, fetch: f.fetch })).resolves.toEqual({ token: TOKEN, expiresAt: "2023-11-14T23:13:20Z" });
  });

  test("the token's repositories must equal the request", async () => {
    const replies: Reply[] = [
      granted({ contents: "write" }, ["odoo-mcp", "mtg"]),
      granted({ contents: "write" }, ["mtg"]),
      granted({ contents: "write" }, [], { repository_selection: "all", repositories: undefined }),
      granted({ contents: "write" }, ["odoo-mcp"], { repository_selection: "all" }),
      { status: 201, body: { token: TOKEN, expires_at: "2023-11-14T23:13:20Z", permissions: { contents: "write" } } },
      { status: 201, body: { token: TOKEN, expires_at: "2023-11-14T23:13:20Z", repository_selection: "selected", repositories: [{ name: "odoo-mcp" }] } },
    ];
    for (const reply of replies) {
      const f = fakeFetch({ [MINT]: reply, [REVOKE]: { status: 204 } });
      const e = await caught(mintInstallationToken({ ...o, fetch: f.fetch }));
      expect(e).toBeInstanceOf(TokenScopeError);
      expect(e.message).not.toContain(TOKEN);
      expect(f.calls.map((c) => c.method)).toEqual(["POST", "DELETE"]);
    }
    // Repository names are case-insensitive on GitHub.
    const f = fakeFetch({ [MINT]: granted({ contents: "write" }, ["Odoo-MCP"]) });
    await expect(mintInstallationToken({ ...o, fetch: f.fetch })).resolves.toBeDefined();
  });

  test("if the revoke fails, the error says so and when the token expires", async () => {
    const f = fakeFetch({ [MINT]: granted({ administration: "write" }), [REVOKE]: { status: 500 } });
    const e = await caught(mintInstallationToken({ ...o, fetch: f.fetch }));
    expect(e).toBeInstanceOf(TokenScopeError);
    expect((e as TokenScopeError).revoked).toBe(false);
    expect(e.message).toContain("could not be revoked");
    expect(e.message).toContain("2023-11-14T23:13:20Z");
  });

  test("the request must name exactly one repository and at least one permission; nothing is sent otherwise", async () => {
    const f = fakeFetch({});
    for (const repositories of [[], ["odoo-mcp", "mtg"]]) {
      await expect(mintInstallationToken({ ...o, repositories, fetch: f.fetch })).rejects.toThrow(TokenScopeError);
    }
    // No permissions would mean every permission the installation has.
    await expect(mintInstallationToken({ ...o, permissions: {}, fetch: f.fetch })).rejects.toThrow(TokenScopeError);
    await expect(mintInstallationToken({ ...o, repositories: ["example-owner/odoo-mcp"], fetch: f.fetch })).rejects.toThrow(/name only, without the owner/);
    await expect(mintInstallationToken({ ...o, permissions: { contents: "admin" } as never, fetch: f.fetch })).rejects.toThrow(/read or write/);
    await expect(mintInstallationToken({ ...o, installationId: 0, fetch: f.fetch })).rejects.toThrow(/installation id/);
    expect(f.calls).toEqual([]);
  });

  test("a GitHub error names the status and GitHub's message", async () => {
    const f = fakeFetch({ [MINT]: { status: 422, body: { message: "The permissions requested are not granted to this installation." } } });
    await expect(mintInstallationToken({ ...o, fetch: f.fetch })).rejects.toThrow(/HTTP 422: The permissions requested are not granted/);
  });

  test("a bad private key fails without echoing it", async () => {
    const f = fakeFetch({});
    const body = PKCS1_PEM.split("\n")[1]!;
    for (const privateKeyPem of ["not a key", PKCS1_PEM.replace(body, body.replace(/[A-Za-z]/g, "A")), "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"]) {
      const e = await caught(mintInstallationToken({ ...o, privateKeyPem, fetch: f.fetch }));
      expect(e.message).toMatch(/not a valid RSA private key/);
      expect(e.message).not.toContain(body.slice(0, 20));
    }
    expect(f.calls).toEqual([]);
  });
});

describe("appJwt and findInstallationId", () => {
  test("appJwt is RS256 with iat 60 s back and exp 9 minutes ahead; iss is a numeric App ID or a Client ID string", async () => {
    expectAppJwt(`Bearer ${await appJwt("123456", PKCS1_PEM, NOW_MS)}`, 123456);
    expectAppJwt(`Bearer ${await appJwt("Iv23liFakeClientId", PKCS1_PEM, NOW_MS)}`, "Iv23liFakeClientId");
    await expect(appJwt("123 456", PKCS1_PEM, NOW_MS)).rejects.toThrow(/App ID or Client ID/);
  });

  test("findInstallationId reads the repo's installation with the App JWT", async () => {
    const f = fakeFetch({ [`GET ${API}/repos/example-owner/odoo-mcp/installation`]: { status: 200, body: { id: 987, suspended_at: null } } });
    expect(await findInstallationId({ appId: "123456", privateKeyPem: PKCS1_PEM, owner: "example-owner", repo: "odoo-mcp", fetch: f.fetch, now: () => NOW_MS })).toBe(987);
    expectAppJwt(f.calls[0]!.headers.authorization);
  });

  test("an App that isn't installed on the repo, or a suspended installation, fails clearly", async () => {
    const args = { appId: "123456", privateKeyPem: PKCS1_PEM, owner: "example-owner", repo: "odoo-mcp", now: () => NOW_MS };
    await expect(findInstallationId({ ...args, fetch: fakeFetch({}).fetch })).rejects.toThrow(/not installed on example-owner\/odoo-mcp/);
    const suspended = fakeFetch({ [`GET ${API}/repos/example-owner/odoo-mcp/installation`]: { status: 200, body: { id: 987, suspended_at: "2026-10-26T00:00:00Z" } } });
    await expect(findInstallationId({ ...args, fetch: suspended.fetch })).rejects.toThrow(/suspended/);
  });
});

describe("hapi token mint", () => {
  let temps: string[] = [];
  let restore: (() => void)[] = [];
  afterEach(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
    for (const r of restore) r();
    temps = [];
    restore = [];
  });
  function capture(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
    const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
    restore.push(() => log.mockRestore(), () => error.mockRestore());
    return { out, err };
  }
  /** A runtime dir holding a host.env with the given values, as `hapi secrets resolve` writes it. */
  function xdgWithHostEnv(values: Record<string, string> | null): string {
    const xdg = mkdtempSync(join(tmpdir(), "hapi-token-"));
    temps.push(xdg);
    mkdirSync(join(xdg, "hapi"), { mode: 0o700 });
    if (values !== null) writeFileSync(join(xdg, "hapi", "host.env"), envFileText("host", values), { mode: 0o600 });
    return xdg;
  }
  const planner = { HAPI_PLANNER_APP_ID: "123456", HAPI_PLANNER_APP_PRIVATE_KEY: PKCS1_PEM };

  test("the Apps' permissions are exactly the runbook's, with no administration or workflows", () => {
    expect(APPS.planner).toEqual({
      name: "hapi-planner",
      envPrefix: "HAPI_PLANNER",
      permissions: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" },
    });
    expect(APPS.factory).toEqual({
      name: "hapi-factory",
      envPrefix: "HAPI_FACTORY",
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });
  });

  test("mints a one-repo token into a 0600 file and prints the path, never the token", async () => {
    const { out } = capture();
    const xdg = xdgWithHostEnv(planner);
    const f = fakeFetch({
      [`GET ${API}/repos/example-owner/odoo-mcp/installation`]: { status: 200, body: { id: 123, suspended_at: null } },
      [MINT]: granted({ ...APPS.planner.permissions }),
    });
    expect(await tokenMint(["--app", "planner", "--repo", "example-owner/odoo-mcp"], { fetch: f.fetch, env: { XDG_RUNTIME_DIR: xdg }, now: () => NOW_MS })).toBe(0);
    const file = join(xdg, "hapi", "tokens", "planner.example-owner.odoo-mcp.token");
    expect(out).toEqual([`${file} (expires 2023-11-14T23:13:20Z)`]);
    expect(readFileSync(file, "utf8")).toBe(`${TOKEN}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(xdg, "hapi", "tokens")).mode & 0o777).toBe(0o700);
    expect(f.calls[1]!.body).toEqual({ repositories: ["odoo-mcp"], permissions: APPS.planner.permissions });
    expect(out.join("\n")).not.toContain(TOKEN);
  });

  test("usage errors exit 2", async () => {
    const { err } = capture();
    const deps = { fetch: fakeFetch({}).fetch, env: {} };
    for (const args of [[], ["--app", "planner"], ["--app", "admin", "--repo", "example-owner/x"], ["--app", "factory", "--repo", "x"], ["--app", "factory", "--repo", "example-owner/x/y"], ["--app", "factory", "--repo", "example-owner/.."]]) {
      expect(await tokenMint(args, deps)).toBe(2);
    }
    expect(err.join("\n")).toContain("usage: hapi token mint --app planner|factory --repo owner/name");
  });

  test("needs XDG_RUNTIME_DIR and a resolved host.env with the App's id and key", async () => {
    const f = fakeFetch({});
    const args = ["--app", "factory", "--repo", "example-owner/odoo-mcp"];
    await expect(tokenMint(args, { fetch: f.fetch, env: {} })).rejects.toThrow(/XDG_RUNTIME_DIR is not set/);
    await expect(tokenMint(args, { fetch: f.fetch, env: { XDG_RUNTIME_DIR: xdgWithHostEnv(null) } })).rejects.toThrow(/hapi secrets resolve/);
    await expect(tokenMint(args, { fetch: f.fetch, env: { XDG_RUNTIME_DIR: xdgWithHostEnv(planner) } })).rejects.toThrow(/HAPI_FACTORY_APP_ID/);
    expect(f.calls).toEqual([]);
  });
});
