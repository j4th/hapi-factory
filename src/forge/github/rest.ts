/**
 * One GitHub REST call, the paginator and the error type (spec §16). Everything that talks to
 * api.github.com goes through `rest`: redirects are refused, a URL off api.github.com is refused,
 * and no error message holds the bearer.
 */
import { HAPI_VERSION } from "../../version";

export const GITHUB_API = "https://api.github.com";
/** The REST API version hapi was written against (docs.github.com, 2026-10-26). */
export const GITHUB_API_VERSION = "2026-03-10";
/** A listing longer than this many pages of 100 is refused, never truncated. */
export const MAX_PAGES = 10;

/** A failed GitHub call. `status` is 0 when no HTTP answer was read (a fetch that threw, or a reply that did not parse). */
export class ForgeError extends Error {
  override name = "ForgeError";
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(message);
  }
}

export const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** GitHub's error `message`, as ": <message>", one line and short; "" if there is none. */
export function ghMessage(json: unknown): string {
  const message = asRecord(json)?.message;
  if (typeof message !== "string") return "";
  const line = message.replace(/\s+/g, " ").trim();
  return `: ${line.length > 200 ? `${line.slice(0, 200)}...` : line}`;
}

/** An error's message on one line, at most 300 characters, with `secret` replaced by [redacted]. */
export function oneLine(e: unknown, secret?: string): string {
  let text = e instanceof Error ? e.message : String(e);
  if (secret !== undefined && secret !== "") text = text.split(secret).join("[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** The path as an error names it: no origin, no query. */
function shown(path: string): string {
  const rel = path.startsWith(`${GITHUB_API}/`) ? path.slice(GITHUB_API.length) : path;
  const q = rel.indexOf("?");
  return q < 0 ? rel : rel.slice(0, q);
}

const fail = (method: string, path: string, what: string, status = 0, rateLimited = false): ForgeError =>
  new ForgeError(`GitHub: ${method} ${shown(path)}: ${what}`, status, rateLimited);

/** An error for a reply that was not the one wanted. */
export function replyError(method: string, path: string, r: { status: number; json: unknown; headers: Headers }): ForgeError {
  const rateLimited = r.status === 429 || (r.status === 403 && r.headers.get("x-ratelimit-remaining") === "0");
  return fail(method, path, `HTTP ${r.status}${ghMessage(r.json)}`, r.status, rateLimited);
}

/** One GitHub REST call. `path` is `/...` or an absolute URL under api.github.com. Redirects are refused. */
export async function rest(
  f: typeof fetch,
  method: string,
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ status: number; json: unknown; headers: Headers }> {
  let url: string;
  if (path.startsWith("/")) url = `${GITHUB_API}${path}`;
  else if (path.startsWith(`${GITHUB_API}/`)) url = path;
  else {
    let origin = "an unparsable URL";
    try {
      origin = new URL(path).origin;
    } catch {}
    throw new ForgeError(`GitHub: refusing a URL off ${GITHUB_API}: ${origin}`, 0, false);
  }
  let res: Response;
  try {
    res = await f(url, {
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
  } catch (e) {
    throw fail(method, path, oneLine(e, bearer));
  }
  let json: unknown;
  try {
    const text = await res.text();
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, headers: res.headers };
}

/** `rest`, but any status other than `want` is a ForgeError. Resolves to the parsed body. */
export async function restOk(f: typeof fetch, method: string, path: string, bearer: string, want: number, body?: unknown): Promise<unknown> {
  const r = await rest(f, method, path, bearer, body);
  if (r.status !== want) throw replyError(method, path, r);
  return r.json;
}

/**
 * Every item of a listing: 100 a page, following `Link: rel="next"`. A next link off api.github.com is
 * refused before the token is sent, a page that is not a list fails, and more than `maxPages` pages fail
 * rather than return a partial list.
 */
export async function paginate(
  f: typeof fetch,
  path: string,
  bearer: string,
  items: (json: unknown) => unknown[] | undefined,
  maxPages = MAX_PAGES,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let next: string | undefined = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let k = 1; next !== undefined; k++) {
    const r = await rest(f, "GET", next, bearer);
    if (r.status !== 200) throw replyError("GET", next, r);
    const list = items(r.json);
    if (list === undefined) throw fail("GET", path, `page ${k} is not a list`);
    out.push(...list);
    const m = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get("link") ?? "");
    next = m?.[1];
    if (next !== undefined && k >= maxPages) throw fail("GET", path, `more than ${maxPages} pages of 100: refusing a partial list`);
  }
  return out;
}
