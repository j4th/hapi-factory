/**
 * Test infrastructure for the forge: `fakeFetch` (a recording fetch over a route table) and
 * `fakeForge` (one stateful fake GitHub). Tasks 12, 13 and 14 test through
 * `githubForge({ repo, token, fetch: fakeForge().fetch })`, so the real adapter runs in their tests too.
 * No network, no token that is real.
 */
import { CODERABBIT } from "../../src/forge/github/forge";
import type { Permission } from "../../src/forge";

const API = "https://api.github.com";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}
export type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** A fake fetch: `routes` maps "METHOD url" to a reply. Records every call. */
export function fakeFetch(routes: Record<string, Reply | ((c: Call) => Reply)>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = record(input, init);
    calls.push(call);
    const route = routes[`${call.method} ${call.url}`];
    if (route === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return toResponse(typeof route === "function" ? route(call) : route);
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

function record(input: string | URL | Request, init: RequestInit): Call {
  return {
    method: init.method ?? "GET",
    url: String(input),
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    redirect: init.redirect,
  };
}

function toResponse(reply: Reply): Response {
  const status = reply.status;
  return new Response(status === 204 || reply.body === undefined ? null : JSON.stringify(reply.body), { status, headers: reply.headers ?? {} });
}

export const OPERATOR = { id: 1, login: "example-owner", type: "User" };
export const STRANGER = { id: 2, login: "example-stranger", type: "User" };
export const FACTORY_BOT = { id: 3, login: "hapi-factory[bot]", type: "Bot" };
export const CODERABBIT_BOT = { id: CODERABBIT.userId, login: "coderabbitai[bot]", type: "Bot" };
type Actor = { id: number; login: string; type: string };
const APP_ID = 1002;

interface PrRec {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  title: string;
  body: string;
  labels: string[];
}
interface CommentRec { id: number; issue: number; user: Actor; viaApp: boolean; body: string; at: string }
interface EventRec { id: number; issue: number; event: "labeled" | "unlabeled"; label: string; actor: Actor; viaApp: boolean; at: string }
interface ReviewRec { id: number; pr: number; user: Actor; commitId: string; at: string }
interface ReviewCommentRec { id: number; pr: number; reviewId: number | null; inReplyTo: number | undefined; user: Actor; commitId: string; path: string; body: string; at: string }
interface CheckRec { sha: string; name: string; appId: number; status: string; conclusion: string | null; title: string | null; summary: string | null }
interface Failure { method: string; prefix: string; status: number; headers: Record<string, string> | undefined }

const legacy = (p: Permission): string => (p === "maintain" ? "write" : p === "triage" ? "read" : p);

/** One stateful fake GitHub for one repo. Every write changes its state. */
export function fakeForge(o: { repo?: string; private?: boolean; pageSize?: number } = {}) {
  const repo = o.repo ?? "example-owner/hapi-sandbox";
  const pageSize = o.pageSize ?? 100;
  const R = `/repos/${repo}`;
  const prs = new Map<number, PrRec>();
  const refs = new Map<string, string>();
  const collaborators = new Map<string, Permission>();
  const comments: CommentRec[] = [];
  const events: EventRec[] = [];
  const reviews: ReviewRec[] = [];
  const reviewComments: ReviewCommentRec[] = [];
  const checks: CheckRec[] = [];
  const failures: Failure[] = [];
  const calls: Call[] = [];
  let nextPr = 1;
  let nextId = 1000;
  let nextEvent = 1;
  let clock = Date.parse("2026-11-01T00:00:00.000Z");
  const tick = (): string => new Date((clock += 1000)).toISOString();
  const user = (a: Actor) => ({ id: a.id, login: a.login, type: a.type });
  const viaApp = (v: boolean) => (v ? { id: 1002 } : null);

  const prJson = (p: PrRec, single: boolean) => ({
    number: p.number,
    state: p.state,
    draft: p.draft,
    title: p.title,
    body: p.body,
    node_id: `PR_${p.number}`,
    head: { ref: p.headRef, sha: p.headSha },
    base: { ref: p.baseRef },
    labels: p.labels.map((name) => ({ name })),
    merged_at: p.merged ? "2026-11-01T00:00:00Z" : null,
    ...(single ? { merged: p.merged } : {}),
  });

  const addEvent = (issue: number, event: "labeled" | "unlabeled", label: string, actor: Actor, app: boolean) =>
    events.push({ id: nextEvent++, issue, event, label, actor, viaApp: app, at: tick() });

  const page = <T>(url: URL, items: T[], wrap: (xs: T[]) => unknown): Reply => {
    const per = Math.max(1, Math.min(Number(url.searchParams.get("per_page") ?? 30), pageSize));
    const n = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = items.slice((n - 1) * per, n * per);
    const headers: Record<string, string> = {};
    if (n * per < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(n + 1));
      headers.link = `<${next.toString()}>; rel="next"`;
    }
    return { status: 200, body: wrap(slice), headers };
  };

  const route = (method: string, url: URL, body: any): Reply => {
    const p = url.pathname;
    if (method === "DELETE" && p === "/installation/token") return { status: 204 };
    if (method === "POST" && p === "/graphql") {
      const id = String(body?.variables?.id ?? "");
      const pr = prs.get(Number(id.replace(/^PR_/, "")));
      if (typeof body?.query !== "string" || !body.query.includes("markPullRequestReadyForReview") || pr === undefined) {
        return { status: 200, body: { errors: [{ message: "Could not resolve to a node" }] } };
      }
      pr.draft = false;
      return { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } };
    }
    if (!p.startsWith(R)) return { status: 404, body: { message: "Not Found" } };
    const rest = p.slice(R.length);
    let m: RegExpExecArray | null;
    if (method === "GET" && rest === "") return { status: 200, body: { full_name: repo, private: o.private ?? false, default_branch: "main" } };
    if (method === "GET" && rest === "/pulls") {
      const head = url.searchParams.get("head") ?? "";
      const state = url.searchParams.get("state") ?? "open";
      const list = [...prs.values()].filter(
        (x) => (head === "" || `${repo.split("/")[0]}:${x.headRef}` === head) && (state === "all" || x.state === state),
      );
      return page(url, list, (xs) => xs.map((x) => prJson(x, false)));
    }
    if (method === "POST" && rest === "/pulls") {
      const n = addPr({ head: body.head, base: body.base, draft: body.draft === true, body: body.body, title: body.title });
      return { status: 201, body: prJson(prs.get(n)!, true) };
    }
    if ((m = /^\/pulls\/(\d+)$/.exec(rest)) && (method === "GET" || method === "PATCH")) {
      const pr = prs.get(Number(m[1]));
      if (pr === undefined) return { status: 404, body: { message: "Not Found" } };
      if (method === "PATCH") {
        if (typeof body?.body === "string") pr.body = body.body;
        if (typeof body?.title === "string") pr.title = body.title;
      }
      return { status: 200, body: prJson(pr, true) };
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/labels$/.exec(rest))) {
      const pr = prs.get(Number(m[1]));
      if (pr === undefined) return { status: 404, body: { message: "Not Found" } };
      for (const l of body.labels as string[]) {
        if (!pr.labels.includes(l)) pr.labels.push(l);
        addEvent(pr.number, "labeled", l, FACTORY_BOT, true);
      }
      return { status: 200, body: pr.labels.map((name) => ({ name })) };
    }
    if (method === "POST" && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const id = comment(Number(m[1]), FACTORY_BOT, body.body, true);
      return { status: 201, body: { id, body: body.body } };
    }
    if (method === "PATCH" && (m = /^\/issues\/comments\/(\d+)$/.exec(rest))) {
      const c = comments.find((x) => x.id === Number(m![1]));
      if (c === undefined) return { status: 404, body: { message: "Not Found" } };
      c.body = body.body;
      return { status: 200, body: { id: c.id, body: c.body } };
    }
    if (method === "GET" && (m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
      const list = comments.filter((c) => c.issue === Number(m![1]));
      return page(url, list, (xs) =>
        xs.map((c) => ({ id: c.id, user: user(c.user), performed_via_github_app: viaApp(c.viaApp), body: c.body, created_at: c.at })),
      );
    }
    if (method === "GET" && (m = /^\/issues\/(\d+)\/events$/.exec(rest))) {
      const list = events.filter((e) => e.issue === Number(m![1]));
      return page(url, list, (xs) =>
        xs.map((e) => ({ id: e.id, event: e.event, label: { name: e.label }, actor: user(e.actor), performed_via_github_app: viaApp(e.viaApp), created_at: e.at })),
      );
    }
    if (method === "GET" && (m = /^\/collaborators\/([^/]+)\/permission$/.exec(rest))) {
      const login = decodeURIComponent(m[1]!);
      const perm = collaborators.get(login);
      if (perm === undefined) return { status: 404, body: { message: "Not Found" } };
      return { status: 200, body: { permission: legacy(perm), role_name: perm, user: { login } } };
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) {
      const list = reviews.filter((r) => r.pr === Number(m![1]));
      return page(url, list, (xs) => xs.map((r) => ({ id: r.id, user: user(r.user), commit_id: r.commitId, state: "COMMENTED", submitted_at: r.at })));
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)\/comments$/.exec(rest))) {
      const list = reviewComments.filter((r) => r.pr === Number(m![1]));
      return page(url, list, (xs) =>
        xs.map((r) => ({
          id: r.id,
          pull_request_review_id: r.reviewId,
          ...(r.inReplyTo === undefined ? {} : { in_reply_to_id: r.inReplyTo }),
          user: user(r.user),
          commit_id: r.commitId,
          path: r.path,
          body: r.body,
          created_at: r.at,
        })),
      );
    }
    if (method === "GET" && (m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
      const list = checks.filter((c) => c.sha === decodeURIComponent(m![1]!));
      return page(url, list, (xs) => ({
        total_count: list.length,
        check_runs: xs.map((c) => ({
          name: c.name,
          app: { id: c.appId },
          head_sha: c.sha,
          status: c.status,
          conclusion: c.conclusion,
          output: { title: c.title, summary: c.summary },
        })),
      }));
    }
    return { status: 404, body: { message: "Not Found" } };
  };

  const fetchFake = async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = record(input, init);
    calls.push(call);
    const url = new URL(call.url);
    const fi = failures.findIndex((x) => x.method === call.method && (url.pathname + url.search).startsWith(x.prefix));
    if (fi >= 0) {
      const [f] = failures.splice(fi, 1);
      return toResponse({ status: f!.status, body: { message: "failed on purpose" }, headers: f!.headers ?? {} });
    }
    if (url.origin !== API) return toResponse({ status: 404, body: { message: "Not Found" } });
    return toResponse(route(call.method, url, call.body));
  };

  function addPr(a: { head: string; base?: string; state?: "open" | "closed"; merged?: boolean; draft?: boolean; body?: string; title?: string }): number {
    const n = nextPr++;
    prs.set(n, {
      number: n,
      state: a.merged ? "closed" : (a.state ?? "open"),
      merged: a.merged ?? false,
      draft: a.draft ?? false,
      headRef: a.head,
      headSha: refs.get(a.head) ?? "0".repeat(40),
      baseRef: a.base ?? "main",
      title: a.title ?? "",
      body: a.body ?? "",
      labels: [],
    });
    return n;
  }

  function comment(n: number, who: Actor, body: string, app = false): number {
    const id = nextId++;
    comments.push({ id, issue: n, user: who, viaApp: app, body, at: tick() });
    return id;
  }

  return {
    fetch: fetchFake as unknown as typeof fetch,
    calls,
    repo,
    prs,
    collaborators,
    push(ref: string, sha: string): void {
      refs.set(ref, sha);
      for (const p of prs.values()) if (p.state === "open" && p.headRef === ref) p.headSha = sha;
    },
    addPr,
    comment,
    label(n: number, name: string, actor: Actor, a: { viaApp?: boolean; action?: "labeled" | "unlabeled" } = {}): void {
      const action = a.action ?? "labeled";
      const pr = prs.get(n);
      if (pr !== undefined) pr.labels = action === "labeled" ? [...new Set([...pr.labels, name])] : pr.labels.filter((l) => l !== name);
      addEvent(n, action, name, actor, a.viaApp ?? false);
    },
    review(n: number, who: Actor, commitId: string): number {
      const id = nextId++;
      reviews.push({ id, pr: n, user: who, commitId, at: tick() });
      return id;
    },
    reviewComment(n: number, a: { reviewId: number | null; inReplyTo?: number; user: Actor; commitId: string; path?: string; body: string }): number {
      const id = nextId++;
      reviewComments.push({ id, pr: n, reviewId: a.reviewId, inReplyTo: a.inReplyTo, user: a.user, commitId: a.commitId, path: a.path ?? "src/x.ts", body: a.body, at: tick() });
      return id;
    },
    checkRun(sha: string, c: { name: string; appId: number; status: string; conclusion?: string | null; title?: string | null; summary?: string | null }): void {
      checks.push({ sha, name: c.name, appId: c.appId, status: c.status, conclusion: c.conclusion ?? null, title: c.title ?? null, summary: c.summary ?? null });
    },
    /** The next call to `method` whose path (with query) starts with `pathPrefix` gets `status`, once. */
    failNext(method: string, pathPrefix: string, status: number, headers?: Record<string, string>): void {
      failures.push({ method, prefix: pathPrefix, status, headers });
    },
    appId: APP_ID,
  };
}
