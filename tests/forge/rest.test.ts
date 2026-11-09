import { describe, expect, test } from "bun:test";
import { GITHUB_API as API, ForgeError, MAX_PAGES, paginate, rest, restOk } from "../../src/forge/github/rest";
import { caught, fakeFetch } from "./helpers";

const TOKEN = "fake-token-rest-77ab";

describe("rest", () => {
  test("rest sends hapi's headers, refuses redirects, and returns the response headers", async () => {
    const f = fakeFetch({ [`GET ${API}/x`]: { status: 200, body: { a: 1 }, headers: { "x-ratelimit-remaining": "42" } } });
    const r = await rest(f.fetch, "GET", "/x", TOKEN);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ a: 1 });
    expect(r.headers.get("x-ratelimit-remaining")).toBe("42");
    expect(f.calls[0]!.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "x-github-api-version": "2026-03-10",
      "user-agent": "hapi-factory/0.1.0",
    });
    expect(f.calls[0]!.redirect).toBe("error");
  });

  test("paginate asks for 100 a page and follows Link rel=\"next\" to the last page", async () => {
    const next = `${API}/repositories/9/pulls?state=all&per_page=100&page=2`;
    const f = fakeFetch({
      [`GET ${API}/repos/o/r/pulls?state=all&per_page=100`]: { status: 200, body: [1, 2], headers: { link: `<${next}>; rel="next", <${API}/x>; rel="last"` } },
      [`GET ${next}`]: { status: 200, body: [3] },
    });
    const items = await paginate(f.fetch, "/repos/o/r/pulls?state=all", TOKEN, (j) => (Array.isArray(j) ? j : undefined));
    expect(items).toEqual([1, 2, 3]);
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/repos/o/r/pulls?state=all&per_page=100`, `GET ${next}`]);
  });

  test("paginate fails rather than truncating past MAX_PAGES pages", async () => {
    expect(MAX_PAGES).toBe(10);
    const endless = async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      calls++;
      return new Response("[1]", { status: 200, headers: { link: `<${API}/repos/o/r/issues/1/comments?page=${calls + 1}>; rel="next"` } });
    };
    let calls = 0;
    const e = await caught(paginate(endless as unknown as typeof fetch, "/repos/o/r/issues/1/comments", TOKEN, (j) => (Array.isArray(j) ? j : undefined)));
    expect(e.message).toBe("GitHub: GET /repos/o/r/issues/1/comments: more than 10 pages of 100: refusing a partial list");
    expect(calls).toBe(10);
  });

  test("a next link off api.github.com is refused, never sent the token", async () => {
    const f = fakeFetch({
      [`GET ${API}/x?per_page=100`]: { status: 200, body: [1], headers: { link: '<https://example.invalid/x?page=2>; rel="next"' } },
    });
    const e = await caught(paginate(f.fetch, "/x", TOKEN, (j) => (Array.isArray(j) ? j : undefined)));
    expect(e.message).toBe("GitHub: refusing a URL off https://api.github.com: https://example.invalid");
    expect(f.calls).toHaveLength(1);
  });

  test("paginate needs a list on every page", async () => {
    const f = fakeFetch({ [`GET ${API}/x?per_page=100`]: { status: 200, body: { nope: 1 } } });
    const e = await caught(paginate(f.fetch, "/x", TOKEN, (j) => (Array.isArray(j) ? j : undefined)));
    expect(e.message).toBe("GitHub: GET /x: page 1 is not a list");
  });

  test("a forge error names the method, the path without its query and GitHub's message, and never the token", async () => {
    const f = fakeFetch({ [`GET ${API}/repos/o/r/pulls?state=all`]: { status: 401, body: { message: "Bad credentials" } } });
    const e = await caught(restOk(f.fetch, "GET", "/repos/o/r/pulls?state=all", TOKEN, 200));
    expect(e).toBeInstanceOf(ForgeError);
    expect(e.message).toBe("GitHub: GET /repos/o/r/pulls: HTTP 401: Bad credentials");
    expect((e as ForgeError).status).toBe(401);
    const boom = (async () => {
      throw new Error(`socket closed: ${TOKEN}`);
    }) as unknown as typeof fetch;
    const e2 = await caught(restOk(boom, "GET", "/x", TOKEN, 200));
    expect(e2.message).toBe("GitHub: GET /x: socket closed: [redacted]");
    expect((e2 as ForgeError).status).toBe(0);
    expect(e2.message).not.toContain(TOKEN);
  });

  test("a success reply whose body can't be read is a status-0 ForgeError, with no token in it", async () => {
    const garbled = (async () => new Response("<html>not json " + TOKEN, { status: 200 })) as unknown as typeof fetch;
    const e = (await caught(restOk(garbled, "GET", "/x?y=1", TOKEN, 200))) as ForgeError;
    expect(e).toBeInstanceOf(ForgeError);
    expect(e.status).toBe(0);
    expect(e.message).toBe("GitHub: GET /x: HTTP 200: the reply body could not be read as JSON");
  });

  test("a 429, or a 403 with x-ratelimit-remaining 0, is a rate-limited ForgeError", async () => {
    const f = fakeFetch({
      [`GET ${API}/a`]: { status: 429, body: { message: "slow down" } },
      [`GET ${API}/b`]: { status: 403, body: { message: "rate limit" }, headers: { "x-ratelimit-remaining": "0" } },
      [`GET ${API}/c`]: { status: 403, body: { message: "no" }, headers: { "x-ratelimit-remaining": "5" } },
    });
    for (const [p, want] of [["/a", true], ["/b", true], ["/c", false]] as const) {
      const e = (await caught(restOk(f.fetch, "GET", p, TOKEN, 200))) as ForgeError;
      expect(e.rateLimited).toBe(want);
    }
  });
});
