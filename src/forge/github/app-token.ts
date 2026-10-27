/**
 * GitHub App installation tokens (spec §4.3, §4.4, §11.5): 1-hour tokens,
 * minted outside the agents, for exactly one repository each.
 *
 * - `appJwt`: the App's JWT, RS256 via crypto.subtle (no dependency), issued
 *   60 s in the past for clock drift and valid 9 minutes (GitHub allows 10).
 * - `findInstallationId`: the App's installation on one repo.
 * - `mintInstallationToken`: POST /app/installations/{id}/access_tokens with
 *   one repository and explicit permissions. It checks the response before
 *   returning the token: its permissions must not exceed the request
 *   (`metadata: read` is implicit; GitHub adds it to every token), and its
 *   repositories must equal the request. A broader token throws
 *   `TokenScopeError` and is revoked at once.
 * - `hapi token mint --app planner|factory --repo owner/name`: reads the App's
 *   id and key from the host zone's env file and writes the token to a 0600
 *   file, deleting token files more than an hour old. It never prints the token.
 *
 * No error message holds a token, a JWT or key material.
 */
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENV_DIR, parseEnvFile, runtimeDir, secureDir, writeSecretFile } from "../../secrets/files";
import { HAPI_VERSION } from "../../version";

export const GITHUB_API = "https://api.github.com";
/** The REST API version hapi was written against (docs.github.com, 2026-10-26). */
export const GITHUB_API_VERSION = "2026-03-10";

export type Permissions = Record<string, "read" | "write">;

/** A token request, or the token GitHub returned, is broader than one repo and the listed permissions. */
export class TokenScopeError extends Error {
  override name = "TokenScopeError";
  constructor(
    message: string,
    /** For a returned token: whether it was revoked. */
    readonly revoked = false,
  ) {
    super(message);
  }
}

/**
 * The two Apps (spec §11.5) and the permissions each token asks for. They match
 * the App settings in docs/runbooks/github-apps.md. Neither has administration
 * or workflows, and neither is a bypass actor on any ruleset.
 */
export const APPS = {
  /** Hermes: pushes plan/* branches, opens planning PRs, labels them. */
  planner: {
    name: "hapi-planner",
    envPrefix: "HAPI_PLANNER",
    permissions: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" },
  },
  /** The harvester: pushes factory/* branches, opens delivery PRs, labels them. */
  factory: {
    name: "hapi-factory",
    envPrefix: "HAPI_FACTORY",
    permissions: { contents: "write", pull_requests: "write", metadata: "read" },
  },
} as const satisfies Record<string, { name: string; envPrefix: string; permissions: Permissions }>;
export type AppName = keyof typeof APPS;

const BAD_KEY = "the App private key is not a valid RSA private key (the PEM from the App's settings page, PKCS#1 or PKCS#8)";

/** DER length bytes. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let m = n; m > 0; m >>= 8) bytes.unshift(m & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }. */
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** Wrap a PKCS#1 RSAPrivateKey as PKCS#8 PrivateKeyInfo, which is all crypto.subtle imports. */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const inner = [0x02, 0x01, 0x00, ...RSA_ALGORITHM, 0x04, ...derLength(pkcs1.length)];
  const head = [0x30, ...derLength(inner.length + pkcs1.length), ...inner];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head);
  out.set(pkcs1, head.length);
  return out;
}

/** Import a PEM RSA private key (GitHub's PKCS#1, or PKCS#8) for RS256 signing. */
async function signingKey(pem: string): Promise<CryptoKey> {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/.exec(pem);
  if (!m) throw new Error(BAD_KEY);
  // A PEM pasted into a vault with literal "\n" sequences reads the same.
  const body = m[2]!.replace(/\\n|\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error(BAD_KEY);
  const der = new Uint8Array(Buffer.from(body, "base64"));
  try {
    return await crypto.subtle.importKey("pkcs8", m[1] ? pkcs1ToPkcs8(der) : der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new Error(BAD_KEY);
  }
}

/**
 * The App's JWT: RS256, `iat` = now - 60 s, `exp` = now + 540 s. `iss` takes
 * GitHub's two documented forms: a numeric App ID as a JSON number, or a
 * Client ID (`Iv...`) as a string. `nowMs` is milliseconds, like Date.now().
 */
export async function appJwt(appId: string, privateKeyPem: string, nowMs: number): Promise<string> {
  if (!/^[A-Za-z0-9._-]+$/.test(appId)) throw new Error("the App id must be the App's App ID or Client ID");
  const key = await signingKey(privateKeyPem);
  const now = Math.floor(nowMs / 1000);
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const iss = /^\d+$/.test(appId) ? Number(appId) : appId;
  const signingInput = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString("base64url")}`;
}

/** One GitHub REST call. Redirects are refused, so a credential never follows one. */
async function github(f: typeof fetch, method: string, path: string, bearer: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await f(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${bearer}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": `hapi-factory/${HAPI_VERSION}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** GitHub's error `message`, as ": <message>", one line and short; "" if there is none. */
function ghMessage(json: unknown): string {
  const message = asRecord(json)?.message;
  if (typeof message !== "string") return "";
  const line = message.replace(/\s+/g, " ").trim();
  return `: ${line.length > 200 ? `${line.slice(0, 200)}...` : line}`;
}

/** A repository name as GitHub allows it, without the owner. */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Check a token request before anything is sent. Scope problems throw TokenScopeError. */
function checkRequest(o: MintOptions): void {
  if (!Number.isSafeInteger(o.installationId) || o.installationId <= 0) throw new Error("the installation id must be a positive integer");
  // Spec §4.4: tokens are minted for one repo only. Without `repositories`, GitHub covers every repo of the installation.
  if (o.repositories.length !== 1) {
    throw new TokenScopeError(`a token is for exactly one repository; the request names ${o.repositories.length}`);
  }
  for (const repo of o.repositories) {
    if (repo.includes("/")) throw new Error(`repositories takes the repository name only, without the owner: ${JSON.stringify(repo)}`);
    if (!REPO_NAME.test(repo) || repo === "." || repo === "..") throw new Error(`not a repository name: ${JSON.stringify(repo)}`);
  }
  const names = Object.keys(o.permissions);
  if (names.length === 0) {
    throw new TokenScopeError("a token request must list its permissions: with none, GitHub grants every permission the installation has");
  }
  for (const name of names) {
    if (!/^[a-z_]+$/.test(name)) throw new Error(`not a GitHub permission name: ${JSON.stringify(name)}`);
    const level = o.permissions[name];
    if (level !== "read" && level !== "write") throw new Error(`permission ${name} must be read or write`);
  }
}

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Why GitHub's token is broader than the request, or undefined if it isn't. Anything unchecked counts as broader. */
function scopeProblem(o: MintOptions, r: Record<string, unknown>): string | undefined {
  const granted = asRecord(r.permissions);
  if (granted === undefined) return "the response lists no permissions to check";
  const broader: string[] = [];
  for (const [name, level] of Object.entries(granted)) {
    // GitHub adds metadata: read to every installation token.
    const asked = Object.hasOwn(o.permissions, name) ? o.permissions[name] : name === "metadata" ? "read" : undefined;
    const got = typeof level === "string" && Object.hasOwn(LEVELS, level) ? LEVELS[level]! : Infinity;
    if (asked === undefined || got > LEVELS[asked]!) broader.push(`${name}: ${String(level)}`);
  }
  if (broader.length > 0) {
    const requested = Object.entries(o.permissions).map(([n, l]) => `${n}: ${l}`).join(", ");
    return `it has ${broader.join(", ")} (requested ${requested})`;
  }
  if (r.repository_selection !== "selected") return `its repository_selection is ${JSON.stringify(r.repository_selection)}, not "selected"`;
  if (!Array.isArray(r.repositories)) return "the response lists no repositories to check";
  const got = r.repositories.map((x) => {
    const name = asRecord(x)?.name;
    return typeof name === "string" ? name : "(unnamed)";
  });
  const want = o.repositories.map((n) => n.toLowerCase());
  if (got.length !== want.length || got.some((n, i) => n.toLowerCase() !== want[i])) {
    return `it covers ${got.length === 0 ? "no repositories" : got.join(", ")} (requested ${o.repositories.join(", ")})`;
  }
  return undefined;
}

/** Revoke an installation token with its own credential. Resolves to whether GitHub confirmed it (204). */
async function revoke(f: typeof fetch, token: string): Promise<boolean> {
  try {
    return (await github(f, "DELETE", "/installation/token", token)).status === 204;
  } catch {
    return false;
  }
}

export interface MintOptions {
  /** The App ID (or Client ID): the JWT's `iss`. */
  appId: string;
  privateKeyPem: string;
  installationId: number;
  /** Exactly one repository name, without the owner. */
  repositories: string[];
  /** At least one permission. */
  permissions: Permissions;
  fetch?: typeof fetch;
  /** Milliseconds, like Date.now (the default). */
  now?: () => number;
}

/**
 * Mint a 1-hour installation token for one repository with exactly the
 * listed permissions (or fewer). Throws TokenScopeError if the request names
 * other than one repository or no permissions (nothing is sent), or if
 * GitHub's token is broader than the request; that token is revoked first.
 */
export async function mintInstallationToken(o: MintOptions): Promise<{ token: string; expiresAt: string }> {
  checkRequest(o);
  const f = o.fetch ?? fetch;
  const jwt = await appJwt(o.appId, o.privateKeyPem, (o.now ?? Date.now)());
  const body = { repositories: o.repositories, permissions: o.permissions };
  const { status, json } = await github(f, "POST", `/app/installations/${o.installationId}/access_tokens`, jwt, body);
  if (status !== 201) throw new Error(`GitHub refused the token request: HTTP ${status}${ghMessage(json)}`);
  const r = asRecord(json);
  if (r === undefined || typeof r.token !== "string" || r.token === "") throw new Error("GitHub's token response has no token");
  // A token we won't use is revoked, like every other rejected 201.
  if (typeof r.expires_at !== "string" || Number.isNaN(Date.parse(r.expires_at))) {
    const revoked = await revoke(f, r.token);
    throw new Error(
      "GitHub's token response has no valid expires_at. " +
        (revoked
          ? "The token was revoked."
          : "The token could not be revoked, so it may stay valid for up to an hour; suspend the App's installation if that is too long (docs/runbooks/github-apps.md)."),
    );
  }
  const problem = scopeProblem(o, r);
  if (problem !== undefined) {
    const revoked = await revoke(f, r.token);
    throw new TokenScopeError(
      `GitHub's token is broader than requested: ${problem}. ` +
        (revoked
          ? "It was revoked."
          : `It could not be revoked, so it stays valid until ${r.expires_at}; suspend the App's installation if that is too long (docs/runbooks/github-apps.md).`),
      revoked,
    );
  }
  return { token: r.token, expiresAt: r.expires_at };
}

/** The installation id of the App (by its JWT) on `owner/repo`. Fails if the App isn't installed there, or is suspended. */
export async function findInstallationId(o: {
  appId: string;
  privateKeyPem: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<number> {
  const jwt = await appJwt(o.appId, o.privateKeyPem, (o.now ?? Date.now)());
  const where = `${o.owner}/${o.repo}`;
  const { status, json } = await github(o.fetch ?? fetch, "GET", `/repos/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/installation`, jwt);
  if (status === 404) throw new Error(`the App is not installed on ${where} (GitHub 404): install it there (docs/runbooks/github-apps.md)`);
  if (status !== 200) throw new Error(`GitHub: the App's installation on ${where}: HTTP ${status}${ghMessage(json)}`);
  const r = asRecord(json);
  const id = r?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("GitHub's installation response has no id");
  if (r!.suspended_at !== null && r!.suspended_at !== undefined) {
    throw new Error(`the App's installation on ${where} is suspended (since ${String(r!.suspended_at)}); unsuspend it to mint tokens`);
  }
  return id;
}

/** Delete token files (and leftover temp files) in `dir` last modified more than an hour before `nowMs`: their tokens have expired. */
async function removeExpiredTokens(dir: string, nowMs: number): Promise<void> {
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".token") && !(name.startsWith(".") && name.endsWith(".tmp"))) continue;
    const path = join(dir, name);
    const st = await lstat(path);
    if (st.isFile() && st.mtimeMs < nowMs - 3_600_000) await rm(path, { force: true });
  }
}

const USAGE = "usage: hapi token mint --app planner|factory --repo owner/name";
/** owner/name: a GitHub login (letters, digits, hyphens) and a repository name. */
const OWNER_REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

export interface TokenDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/**
 * `hapi token mint --app planner|factory --repo owner/name`: mint a 1-hour
 * token for that one repo with the App's permissions (`APPS`), and write it to
 * `$XDG_RUNTIME_DIR/hapi/tokens/<app>.<owner>.<repo>.token` (mode 0600). Prints
 * the path and expiry, never the token. The App's id and key come from
 * `$XDG_RUNTIME_DIR/hapi/env/host.env`, which `hapi secrets resolve` writes.
 * XDG_RUNTIME_DIR is checked (ours, 0700) before host.env is read, and each
 * mint deletes the token files in tokens/ that are more than an hour old
 * (installation tokens last one hour).
 */
export async function tokenMint(args: string[], deps: TokenDeps = {}): Promise<number> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if ((flag !== "--app" && flag !== "--repo") || value === undefined || value.startsWith("-")) {
      console.error(USAGE);
      return 2;
    }
    flags[flag] = value;
  }
  const app = flags["--app"];
  const m = OWNER_REPO.exec(flags["--repo"] ?? "");
  if ((app !== "planner" && app !== "factory") || !m || m[2] === "." || m[2] === "..") {
    console.error(USAGE);
    return 2;
  }
  const owner = m[1]!;
  const repo = m[2]!;
  const spec = APPS[app];

  const dir = runtimeDir(deps.env ?? process.env);
  await secureDir(dir, dirname(dir));
  const hostEnv = join(dir, ENV_DIR, "host.env");
  let text: string;
  try {
    text = await readFile(hostEnv, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`no ${hostEnv}: run \`hapi secrets resolve\` first; it writes the App keys there`);
    throw new Error(`cannot read ${hostEnv}${code ? ` (${code})` : ""}`);
  }
  let values: Record<string, string>;
  try {
    values = parseEnvFile(text);
  } catch (e) {
    throw new Error(`${hostEnv}: ${(e as Error).message}; run \`hapi secrets resolve\` to rewrite it`);
  }
  const idName = `${spec.envPrefix}_APP_ID`;
  const keyName = `${spec.envPrefix}_APP_PRIVATE_KEY`;
  for (const name of [idName, keyName]) {
    if (!values[name]) throw new Error(`${hostEnv} has no ${name}: it is in the host zone of stack/secrets.yaml, so run \`hapi secrets resolve\` to rewrite it`);
  }
  const common = {
    appId: values[idName]!,
    privateKeyPem: values[keyName]!,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const installationId = await findInstallationId({ ...common, owner, repo });
  const { token, expiresAt } = await mintInstallationToken({ ...common, installationId, repositories: [repo], permissions: { ...spec.permissions } });

  const tokens = join(dir, "tokens");
  await secureDir(tokens, dirname(dir));
  await removeExpiredTokens(tokens, (deps.now ?? Date.now)());
  const file = join(tokens, `${app}.${owner}.${repo}.token`);
  await writeSecretFile(file, `${token}\n`);
  console.log(`${file} (expires ${expiresAt})`);
  return 0;
}
