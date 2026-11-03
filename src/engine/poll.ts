/**
 * The poller's tick (design §3.4; Plan 03 Task 14): `hapi poll` runs one every `runs.poll_interval_s` from a systemd
 * user timer, as hapi, and works through each repo `policy/repos.yaml` registers, in sorted order.
 *
 * 1. **The poll lock** (`withPollLock`, keyed by the engine dir): one tick at a time, and `hapi retry` (./cli.ts)
 *    takes it too, so only its holder writes a state file or `events.jsonl`. A tick that finds it held skips.
 * 2. **The reap** (`reapRuns`), so a run whose container exited is finalized before the tick reads it.
 * 3. **Each repo**, in a `try` of its own, so a failure in one never touches another:
 *    1. the mirror fetched (a `mirror` token), then discovery, given the id of every state the repo has (`known`:
 *       every work order ever taken up, settled ones too), so nothing is ever keyed twice;
 *    2. each newly merged work order gets its state (`newState`): `held` when its pieces overlap another of the same
 *       merge (`overlapProblem`), else `queued`. It is pinned at its merge, then written under its own lock, then its
 *       one event is appended;
 *    3. one pipeline per repo (H-090): every state with a PR advances each tick; then the one active state with no
 *       PR; if there is none, the head of the queue: the oldest `cap-stopped` state, else the oldest `queued` one
 *       (by `updatedAt`, then id), so a cap-stopped work order keeps every queued one waiting. Spec §3.4's "one live
 *       run per repo" holds strictly too: startRun admits a run only when no other run of its GitHub repo is live
 *       (`capacityProblem`, by `forgeRepo`, m23), so a PR-time fix started beside another run waits a tick;
 *    4. each is advanced at its merge (`readOrder`, so one deleted from main since still advances), under its own
 *       lock: `advance` (Task 13) resolves, then the state is written, then its events appended, in order. A throw
 *       writes nothing (Review Focus 4). A held lock leaves that work order for the next tick. A work order that can't
 *       be read, or whose overlay the central policy now refuses (m15), is a problem and waits;
 *    5. each planning PR its states or problems name gets its status comment (./status.ts), with the caps of its
 *       first work order's overlay; the forge is asked for only when the comment must change.
 *    A throw anywhere in a repo's tick (a forge error, a git failure, a rate limit: GitHub's secondary one is a 403
 *    with retry-after) fails that repo closed with its first lines, the tick's tokens redacted; the next tick
 *    retries. Every token the repo's tick minted is revoked in its `finally`, and each is minted for one tick alone.
 *
 * The tick writes to GitHub only through `advance` and the status comment.
 */
import { mkdir, rm } from "node:fs/promises";
import type { Forge } from "../forge";
import type { TokenPurpose } from "../forge/github/token";
import { PolicyError } from "../policy/load";
import { applyOverlay, PolicyLoosenError } from "../policy/overlay";
import type { Policy } from "../policy/types";
import { reapRuns } from "../run/lifecycle";
import { lockHeld } from "../run/records";
import { errorText, redactSecrets, sanitizeTerminal } from "../run/sanitize";
import type { RunDeps } from "../run/spec";
import { withStoreLock } from "../secrets/store-files";
import { definedEnv, type Env } from "../stack/up";
import { type DiscoverProblem, type Discovered, overlapProblem } from "./discover";
import { headsFile } from "./pipeline";
import { appendEvent, markPath, renderFinal, renderStatus, rowsOf, settledRows, upsertStatusComment } from "./status";
import { listStates, newState, type Phase, type StatusEvent, withOrderLock, type WorkOrderState, writeState } from "./state";

/** A repo's tick's credentials and forges, each made when first asked for and kept for the tick alone. */
export interface Tick {
  token(p: TokenPurpose): Promise<string>;
  /** `githubForge` over `token(p)`: the `pr` and `checks` forges are two tokens, each with its purpose's permissions alone. */
  forge(p: "pr" | "checks"): Promise<Forge>;
  /** The repo isn't private, asked of GitHub at most once a tick. */
  isPublic(): Promise<boolean>;
}

/** What `advance` gave: the state to write, and the events it emitted, appended only once the state is written. */
export interface Advanced {
  state: WorkOrderState;
  events: StatusEvent[];
  /** startRun's warnings (a soft disk cap), for the tick report. */
  warnings?: string[];
}

export interface PollDeps {
  run: RunDeps;
  /** The central policy: `policy/repos.yaml` names the repos, `gates.yaml` the decision models. */
  policy: Policy;
  engineDir: string;
  /** Production: `forgeToken(run.env, repo, p)`. */
  mint(repo: string, p: TokenPurpose): Promise<{ token: string; revoke(): Promise<void> }>;
  /** Production: `githubForge({ repo, token })`. */
  forge(repo: string, token: string): Forge;
  /** Production: `ensureMirror`, then `fetchMirror`, so the first tick makes the mirror. */
  fetchMirror(repo: string, token: string): Promise<void>;
  discover(repo: string, known: ReadonlySet<string>, problems: DiscoverProblem[]): Promise<Discovered[]>;
  readOrder(repo: string, id: string, mergeSha: string): Promise<Discovered>;
  planningPr(repo: string, mergeSha: string): Promise<number | undefined>;
  /** The planning PR whose merge first added `path` (Task 6's `firstAddedBy`, then `planningPrOf`). */
  problemPr(repo: string, path: string): Promise<number | undefined>;
  /** Production: `pinWorkOrder`, as a work order's first state is written. */
  pin(repo: string, id: string, mergeSha: string): Promise<void>;
  advance(s: WorkOrderState, order: Discovered, t: Tick): Promise<Advanced>;
}

/** Where a work order has nothing more to do on its own (but `hapi retry` for a failed one). */
export const SETTLED: readonly Phase[] = ["merged", "closed", "failed"];
/** A run of the pipeline before its PR: at most one per repo. */
export const ACTIVE: readonly Phase[] = ["worker", "verify", "review", "fix", "harvest"];
/** On a PR: advanced every tick. */
export const ON_PR: readonly Phase[] = ["pr", "pr-review", "pr-fix", "waiting"];
/** The repo's queue, cap-stopped at its head: it advances only when nothing is ACTIVE. */
export const QUEUE: readonly Phase[] = ["cap-stopped", "queued"];

/** One repo's part of a tick, as `formatTick` prints it. */
export interface RepoTick {
  repo: string;
  /** `<id> <phase>`, each new state. */
  created: string[];
  /** `<id> <from> -> <to>`, each phase that changed. */
  moved: string[];
  /** `#<planning PR> <action>`, each status comment write. */
  comments: string[];
  /** `<path>: <reason>`, each work order that can't run. */
  problems: string[];
  warnings: string[];
  /** Why the repo's tick failed closed. */
  error?: string;
}

export interface TickReport {
  skipped?: string;
  reap?: string;
  repos: RepoTick[];
}

/** A token the tick minted, for its revoke. */
export interface Minted {
  purpose: TokenPurpose;
  token: string;
  revoke(): Promise<void>;
}

/** Run `fn` holding the poll lock (keyed by the engine dir): a tick, or `hapi retry`. Fails at once while another holds it. */
export function withPollLock<T>(engineDir: string, env: Env, fn: () => Promise<T>): Promise<T> {
  return withStoreLock(engineDir, "poll", fn, { env: definedEnv(env) });
}

/** A repo's `Tick`: each token minted once, when first asked for, and pushed onto `minted` for the tick's revoke. */
export function makeTick(d: Pick<PollDeps, "mint" | "forge">, repo: string, minted: Minted[]): Tick {
  const tokens = new Map<TokenPurpose, Promise<string>>();
  const forges = new Map<"pr" | "checks", Promise<Forge>>();
  let pub: Promise<boolean> | undefined;
  const token = (p: TokenPurpose): Promise<string> => {
    let t = tokens.get(p);
    if (t === undefined) {
      t = d.mint(repo, p).then((m) => {
        minted.push({ purpose: p, token: m.token, revoke: () => m.revoke() });
        return m.token;
      });
      tokens.set(p, t);
    }
    return t;
  };
  const forge = (p: "pr" | "checks"): Promise<Forge> => {
    let f = forges.get(p);
    if (f === undefined) {
      f = token(p).then((t) => d.forge(repo, t));
      forges.set(p, f);
    }
    return f;
  };
  const isPublic = (): Promise<boolean> => (pub ??= forge("pr").then(async (f) => !(await f.repoInfo()).private));
  return { token, forge, isPublic };
}

const ms = (t: string) => {
  const x = Date.parse(t);
  return Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY;
};
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Oldest first: `updatedAt` as an instant, then id. */
const byAge = (a: WorkOrderState, b: WorkOrderState) => ms(a.updatedAt) - ms(b.updatedAt) || byId(a, b);
/** One line, the tick's tokens redacted (each under its purpose's name), at most 600 characters. */
function shown(e: unknown, minted: Minted[]): string {
  let text = errorText(e, { firstLines: true });
  text = redactSecrets(text, Object.fromEntries(minted.map((m) => [`${m.purpose} token`, m.token])));
  for (const m of minted) if (m.token !== "") text = text.split(m.token).join(`[hapi: ${m.purpose} token redacted]`);
  text = sanitizeTerminal(text.replace(/\s*\n\s*/g, " ")).trim();
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/** A work order that can't run: its order.yaml, why, and the planning PR whose status comment lists it. */
interface Problem extends DiscoverProblem {
  pr: number | undefined;
}

/** The states to advance this tick (see the module comment, step 3.3). */
export function toAdvance(states: WorkOrderState[]): WorkOrderState[] {
  const live = states.filter((s) => s.phase !== "held" && !SETTLED.includes(s.phase));
  const onPr = live.filter((s) => s.pr !== undefined).sort(byId);
  const noPr = live.filter((s) => s.pr === undefined);
  const active = noPr.filter((s) => ACTIVE.includes(s.phase)).sort(byAge)[0];
  const head = active ?? noPr.filter((s) => s.phase === "cap-stopped").sort(byAge)[0] ?? noPr.filter((s) => s.phase === "queued").sort(byAge)[0];
  return head === undefined ? onPr : [...onPr, head];
}

/** One tick (see the module comment). Throws only when the engine dir can't be made, or the poll lock can't be taken for another reason than its holder. */
export async function pollTick(d: PollDeps): Promise<TickReport> {
  await mkdir(d.engineDir, { recursive: true, mode: 0o700 });
  let entered = false;
  try {
    return await withPollLock(d.engineDir, d.run.env, async () => {
      entered = true;
      const report: TickReport = { repos: [] };
      try {
        await reapRuns(d.run);
      } catch (e) {
        report.reap = shown(e, []);
      }
      for (const repo of Object.keys(d.policy.repos.repos).sort()) report.repos.push(await tickRepo(d, repo));
      return report;
    });
  } catch (e) {
    if (!entered && lockHeld(e)) return { skipped: "another tick holds the poll lock", repos: [] };
    throw e;
  }
}

/** One repo's tick: see the module comment, step 3. */
async function tickRepo(d: PollDeps, repo: string): Promise<RepoTick> {
  const r: RepoTick = { repo, created: [], moved: [], comments: [], problems: [], warnings: [] };
  const minted: Minted[] = [];
  const tick = makeTick(d, repo, minted);
  try {
    await work(d, repo, tick, r);
  } catch (e) {
    r.error = shown(e, minted);
  } finally {
    for (const m of minted) {
      try {
        await m.revoke();
      } catch (e) {
        console.error(`hapi poll: ${repo}: revoking the ${m.purpose} token failed: ${shown(e, minted)}`);
      }
    }
  }
  return r;
}

async function work(d: PollDeps, repo: string, tick: Tick, r: RepoTick): Promise<void> {
  const now = d.run.now().toISOString();
  const problems: Problem[] = [];
  const problem = (p: Problem) => {
    problems.push(p);
    r.problems.push(`${sanitizeTerminal(p.path.replace(/[\r\n]+/g, " "))}: ${sanitizeTerminal(p.reason.replace(/\s*[\r\n]+\s*/g, " "))}`);
  };
  // Each work order read at its merge, once a tick: a new one's from discovery, a stated one's rebuilt (readOrder).
  const orders = new Map<string, Promise<Discovered>>();
  const readOrder = (id: string, mergeSha: string): Promise<Discovered> => {
    const key = `${id}@${mergeSha}`;
    let o = orders.get(key);
    if (o === undefined) {
      o = d.readOrder(repo, id, mergeSha);
      o.catch(() => {});
      orders.set(key, o);
    }
    return o;
  };

  // 1. The mirror, then discovery, never re-keying a work order that has a state.
  await d.fetchMirror(repo, await tick.token("mirror"));
  const known = await listStates(d.engineDir, repo);
  const found: DiscoverProblem[] = [];
  const discovered = await d.discover(repo, new Set(known.map((s) => s.id)), found);
  for (const p of found) problem({ path: p.path, reason: p.reason, pr: await d.problemPr(repo, p.path) });

  // 2. Each newly merged work order's state: held when it overlaps another of its merge.
  const byMerge = new Map<string, Discovered[]>();
  for (const o of discovered) byMerge.set(o.mergeSha, [...(byMerge.get(o.mergeSha) ?? []), o]);
  const held = new Map<string, string>();
  for (const group of byMerge.values()) for (const [id, why] of overlapProblem(group)) held.set(id, why);
  for (const o of [...discovered].sort(byId)) {
    if (known.some((s) => s.id === o.id)) continue;
    const s = newState(o, await d.planningPr(repo, o.mergeSha), now, held.get(o.id));
    await d.pin(repo, o.id, o.mergeSha);
    const made = await withOrderLock(d.engineDir, s, d.run.env, async () => {
      await writeState(d.engineDir, s);
      await appendEvent(d.engineDir, { at: now, repo, workOrder: s.id, phase: s.phase, ...(s.phase === "held" ? { verdict: s.verdict, reason: s.reasons[0] } : {}) });
      return true;
    }).catch((e: unknown) => {
      if (lockHeld(e)) return false; // its state is made on the next tick
      throw e;
    });
    if (!made) continue;
    orders.set(`${o.id}@${o.mergeSha}`, Promise.resolve(o));
    r.created.push(`${s.id} ${s.phase}`);
  }

  // 3 and 4. One pipeline per repo; every work order on a PR each tick.
  for (const s of toAdvance(await listStates(d.engineDir, repo))) {
    const path = `.factory/work/${s.id}/order.yaml`;
    let order: Discovered;
    try {
      order = await readOrder(s.id, s.mergeSha);
    } catch (e) {
      problem({ path, reason: shown(e, []), pr: s.planningPr });
      continue;
    }
    try {
      await withOrderLock(d.engineDir, s, d.run.env, async () => {
        const a = await d.advance(s, order, tick);
        if (JSON.stringify(a.state) !== JSON.stringify(s)) await writeState(d.engineDir, a.state);
        // Retired: its heads cache is never read again (advance has unpinned it).
        if ((a.state.phase === "merged" || a.state.phase === "closed") && a.state.phase !== s.phase) await rm(headsFile(d.engineDir, repo, s.id), { force: true });
        for (const e of a.events) await appendEvent(d.engineDir, e);
        if (a.state.phase !== s.phase) r.moved.push(`${s.id} ${s.phase} -> ${a.state.phase}`);
        for (const w of a.warnings ?? []) r.warnings.push(sanitizeTerminal(w.replace(/[\r\n]+/g, " ")));
      });
    } catch (e) {
      if (lockHeld(e)) continue; // another holder: the next tick
      if (e instanceof PolicyLoosenError || e instanceof PolicyError) {
        problem({ path, reason: shown(e, []), pr: s.planningPr });
        continue;
      }
      throw e;
    }
  }

  // 5. The status comment of each planning PR the repo's states or problems name.
  const states = await listStates(d.engineDir, repo);
  const prs = new Set([...states.map((s) => s.planningPr), ...problems.map((p) => p.pr)].filter((n): n is number => n !== undefined));
  for (const pr of [...prs].sort((a, b) => a - b)) {
    const mine = states.filter((s) => s.planningPr === pr).sort(byId);
    const budgets = await budgetsOf(d.policy, mine[0], readOrder);
    const rows = await rowsOf(d.run.stateDir, mine, budgets.run_usd, d.engineDir, d.policy.gates.classifiers.jev.unknown_call_usd, d.run.now());
    const open = problems.filter((p) => p.pr === pr).map(({ path, reason }) => ({ path, reason }));
    const body = renderStatus(rows, { monthlyUsd: budgets.repo_monthly_usd, dailyUsd: budgets.daily_usd }, open, d.policy.decisions.mode);
    const settled = settledRows(rows);
    const final = settled && open.length === 0 ? renderFinal(rows) : undefined;
    for (const a of await upsertStatusComment(() => tick.forge("pr"), pr, body, final, markPath(d.engineDir, repo, pr), settled)) r.comments.push(`#${pr} ${a}`);
  }
}

/**
 * A planning PR's budgets: its first work order's overlay over the central policy (one planning PR's work orders share
 * its merge, and so its `.factory/config.yaml`), or the central policy's with none, or when it can't be read or applied.
 */
async function budgetsOf(central: Policy, first: WorkOrderState | undefined, readOrder: (id: string, mergeSha: string) => Promise<Discovered>): Promise<Policy["budgets"]> {
  if (first === undefined) return central.budgets;
  try {
    const o = await readOrder(first.id, first.mergeSha);
    return o.overlay === undefined ? central.budgets : applyOverlay(central, o.overlay).budgets;
  } catch {
    return central.budgets;
  }
}

/** The tick report, one line per repo, then its problems, warnings and error, through `sanitizeTerminal`. */
export function formatTick(r: TickReport): string[] {
  const lines: string[] = [];
  if (r.skipped !== undefined) lines.push(`poll: ${r.skipped}`);
  if (r.reap !== undefined) lines.push(`poll: ${r.reap}`);
  for (const x of r.repos) {
    const entries = [...x.created, ...x.moved, ...x.comments];
    if (entries.length > 0) lines.push(`${x.repo}: ${entries.join("; ")}`);
    else if (x.error === undefined) lines.push(`${x.repo}: nothing to do`);
    for (const p of x.problems) lines.push(`${x.repo}: can't run ${p}`);
    for (const w of x.warnings) lines.push(`${x.repo}: warning: ${w}`);
    if (x.error !== undefined) lines.push(`${x.repo}: failed closed: ${x.error}; the next tick retries`);
  }
  return lines.map((l) => sanitizeTerminal(l));
}
