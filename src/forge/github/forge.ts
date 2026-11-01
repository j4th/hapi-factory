/** `githubForge`: the forge interface (src/forge/index.ts) over GitHub REST, and one GraphQL mutation. */
import type { CheckRun, Forge, IssueComment, LabelEvent, Permission, PrInfo, Review, ReviewComment } from "../index";
import { parseOwnerRepo } from "./app-token";
import { ForgeError, asRecord, paginate, replyError, rest, restOk } from "./rest";

/** CodeRabbit's bot user id and App id: the only place they are written. Task 13's engine and the fake forge import them. */
export const CODERABBIT = { userId: 136622811, appId: 347564 } as const;

const PERMISSIONS: readonly string[] = ["admin", "maintain", "write", "triage", "read", "none"];
const isPermission = (v: unknown): v is Permission => typeof v === "string" && PERMISSIONS.includes(v);
const MARK_READY = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";

const asList = (j: unknown): unknown[] | undefined => (Array.isArray(j) ? j : undefined);

export function githubForge(o: { repo: string; token: string; fetch?: typeof fetch }): Forge {
  const target = parseOwnerRepo(o.repo);
  if (target === undefined) throw new Error(`githubForge: not an owner/name repository: ${JSON.stringify(o.repo)}`);
  const f = o.fetch ?? fetch;
  const t = o.token;
  const R = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;
  const bad = (method: string, path: string, what: string) => new ForgeError(`GitHub: ${method} ${path}: ${what}`, 0, false);

  /** Field readers: a field of the wrong type fails the read with `an item has no <field>`. */
  const reader = (method: string, path: string) => {
    const miss = (field: string) => bad(method, path, `an item has no ${field}`);
    const rec = (v: unknown, field: string): Record<string, unknown> => asRecord(v) ?? (() => { throw miss(field); })();
    const str = (r: Record<string, unknown>, k: string, label = k): string => (typeof r[k] === "string" ? (r[k] as string) : (() => { throw miss(label); })());
    const num = (r: Record<string, unknown>, k: string, label = k): number => (typeof r[k] === "number" ? (r[k] as number) : (() => { throw miss(label); })());
    const sub = (r: Record<string, unknown>, k: string): Record<string, unknown> => {
      const v = asRecord(r[k]);
      if (v === undefined) throw miss(`${k}.id`);
      return v;
    };
    const person = (r: Record<string, unknown>, k: string) => {
      const u = sub(r, k);
      return { id: num(u, "id", `${k}.id`), login: str(u, "login", `${k}.login`), type: str(u, "type", `${k}.type`) };
    };
    return { rec, str, num, sub, person, miss };
  };

  const toPr = (json: unknown, method: string, path: string): PrInfo => {
    const { rec, str, num, sub, miss } = reader(method, path);
    const r = rec(json, "number");
    const head = sub(r, "head");
    const base = sub(r, "base");
    if (!Array.isArray(r.labels)) throw miss("labels");
    const state = str(r, "state");
    return {
      number: num(r, "number"),
      state: state === "open" ? "open" : "closed",
      merged: typeof r.merged === "boolean" ? r.merged : r.merged_at !== null && r.merged_at !== undefined,
      draft: r.draft === true,
      headSha: str(head, "sha", "head.sha"),
      headRef: str(head, "ref", "head.ref"),
      baseRef: str(base, "ref", "base.ref"),
      body: typeof r.body === "string" ? r.body : "",
      labels: r.labels.map((l) => str(rec(l, "labels.name"), "name", "labels.name")),
    };
  };

  const list = async <T>(path: string, items: (j: unknown) => unknown[] | undefined, map: (item: unknown, r: ReturnType<typeof reader>) => T): Promise<T[]> => {
    const r = reader("GET", path.split("?")[0]!);
    return (await paginate(f, path, t, items)).map((x) => map(x, r));
  };

  const forge: Forge = {
    async repoInfo() {
      const r = reader("GET", R);
      const j = r.rec(await restOk(f, "GET", R, t, 200), "private");
      if (typeof j.private !== "boolean") throw r.miss("private");
      return { private: j.private, defaultBranch: r.str(j, "default_branch") };
    },
    async findPr(headRef) {
      const path = `${R}/pulls?state=all&head=${encodeURIComponent(`${target.owner}:${headRef}`)}`;
      const prs = await list(path, asList, (x) => toPr(x, "GET", `${R}/pulls`));
      const open = prs.filter((p) => p.state === "open");
      const pool = open.length > 0 ? open : prs;
      return pool.sort((a, b) => b.number - a.number)[0];
    },
    async pr(n) {
      return toPr(await restOk(f, "GET", `${R}/pulls/${n}`, t, 200), "GET", `${R}/pulls/${n}`);
    },
    async openPr(a) {
      const body = { title: a.title, head: a.head, base: a.base, body: a.body, draft: a.draft };
      return toPr(await restOk(f, "POST", `${R}/pulls`, t, 201, body), "POST", `${R}/pulls`);
    },
    async editPrBody(n, body) {
      await restOk(f, "PATCH", `${R}/pulls/${n}`, t, 200, { body });
    },
    async markReady(n) {
      const path = `${R}/pulls/${n}`;
      const r = reader("GET", path);
      const j = r.rec(await restOk(f, "GET", path, t, 200), "node_id");
      if (j.draft !== true) return;
      const res = await rest(f, "POST", "/graphql", t, { query: MARK_READY, variables: { id: r.str(j, "node_id") } });
      if (res.status !== 200) throw replyError("POST", "/graphql", res);
      const errors = asRecord(res.json)?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        const msg = asRecord(errors[0])?.message;
        throw bad("POST", "/graphql", typeof msg === "string" ? msg.replace(/\s+/g, " ").slice(0, 200) : "the mutation returned errors");
      }
    },
    async addLabels(n, labels) {
      await restOk(f, "POST", `${R}/issues/${n}/labels`, t, 200, { labels });
    },
    async createComment(n, body) {
      const path = `${R}/issues/${n}/comments`;
      const r = reader("POST", path);
      return r.num(r.rec(await restOk(f, "POST", path, t, 201, { body }), "id"), "id");
    },
    async editComment(id, body) {
      await restOk(f, "PATCH", `${R}/issues/comments/${id}`, t, 200, { body });
    },
    issueComments: (n): Promise<IssueComment[]> =>
      list(`${R}/issues/${n}/comments`, asList, (x, r) => {
        const c = r.rec(x, "id");
        const u = r.person(c, "user");
        return { id: r.num(c, "id"), userId: u.id, userLogin: u.login, userType: u.type, viaApp: c.performed_via_github_app != null, body: typeof c.body === "string" ? c.body : "", createdAt: r.str(c, "created_at") };
      }),
    async labelEvents(n): Promise<LabelEvent[]> {
      const all = await list(`${R}/issues/${n}/events`, asList, (x, r) => {
        const e = r.rec(x, "event");
        const action = r.str(e, "event");
        if (action !== "labeled" && action !== "unlabeled") return undefined;
        return { action, label: r.str(r.sub(e, "label"), "name", "label.name"), actor: r.person(e, "actor"), viaApp: e.performed_via_github_app != null, at: r.str(e, "created_at") } satisfies LabelEvent;
      });
      return all.filter((e): e is LabelEvent => e !== undefined);
    },
    async permission(login): Promise<Permission> {
      const path = `${R}/collaborators/${encodeURIComponent(login)}/permission`;
      const res = await rest(f, "GET", path, t);
      if (res.status === 404) return "none";
      if (res.status !== 200) throw replyError("GET", path, res);
      const j = asRecord(res.json);
      if (isPermission(j?.role_name)) return j.role_name;
      if (isPermission(j?.permission)) return j.permission;
      return "none";
    },
    reviews: (n): Promise<Review[]> =>
      list(`${R}/pulls/${n}/reviews`, asList, (x, r) => {
        const v = r.rec(x, "id");
        return { id: r.num(v, "id"), userId: r.person(v, "user").id, commitId: r.str(v, "commit_id"), state: r.str(v, "state"), submittedAt: typeof v.submitted_at === "string" ? v.submitted_at : "" };
      }),
    reviewComments: (n): Promise<ReviewComment[]> =>
      list(`${R}/pulls/${n}/comments`, asList, (x, r) => {
        const c = r.rec(x, "id");
        return {
          id: r.num(c, "id"),
          reviewId: typeof c.pull_request_review_id === "number" ? c.pull_request_review_id : null,
          inReplyTo: typeof c.in_reply_to_id === "number" ? c.in_reply_to_id : null,
          userId: r.person(c, "user").id,
          commitId: r.str(c, "commit_id"),
          path: r.str(c, "path"),
          body: typeof c.body === "string" ? c.body : "",
          createdAt: r.str(c, "created_at"),
        };
      }),
    checkRuns: (sha): Promise<CheckRun[]> =>
      list(`${R}/commits/${encodeURIComponent(sha)}/check-runs`, (j) => { const c = asRecord(j)?.check_runs; return Array.isArray(c) ? c : undefined; }, (x, r) => {
        const c = r.rec(x, "name");
        const out = asRecord(c.output);
        return {
          name: r.str(c, "name"),
          appId: r.num(r.sub(c, "app"), "id", "app.id"),
          headSha: r.str(c, "head_sha"),
          status: r.str(c, "status"),
          conclusion: typeof c.conclusion === "string" ? c.conclusion : null,
          title: typeof out?.title === "string" ? out.title : null,
          summary: typeof out?.summary === "string" ? out.summary : null,
        };
      }),
  };
  return forge;
}
