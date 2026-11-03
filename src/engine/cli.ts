/**
 * The run engine's commands (design §3.4, §3.8; Plan 03 Task 14), each as hapi, as the `hapi run` commands are (an
 * other user re-execs `mise run hapi -- <command>` as hapi; src/run/lifecycle.ts `asHapi`):
 *
 * - **`hapi poll [--once]`**: one tick (./poll.ts `pollTick`), or a tick every `runs.poll_interval_s`. The systemd
 *   user timer (`build/systemd/hapi-poll.timer`, src/generate/systemd.ts) runs `poll --once`. With `--once` it exits 1
 *   when a repo's tick failed closed, so the service's status says so; a skipped tick (another holds the poll lock)
 *   exits 0.
 * - **`hapi status [<owner>/<name>]`**: each planning PR's work orders, as its status comment shows them, from local
 *   state alone: no git, no forge, no Docker.
 * - **`hapi retry <owner>/<name> <work-order-id>`** (the operator's call of 2026-11-01, m19): from the operator's
 *   own terminal, a `failed` work order with no PR goes back to the end of its repo's queue for a fresh pass, under
 *   the poll lock, at most `runs.max_retries` times; a later tick starts its worker. It reads hapi's local state and
 *   the central policy alone: no git, no token, no forge or Docker call. It is never in Hermes's allowlist (H-245):
 *   only a human starts the next attempt after a failure.
 *
 * `pollDeps` and `pipelineDepsOf` are the production wiring of the poller's and the state machine's deps.
 */
import { join } from "node:path";
import { ask } from "../decide/record";
import { githubForge, forgeToken } from "../forge";
import { parseOwnerRepo } from "../forge/github/app-token";
import { loadPolicy } from "../policy/load";
import type { Policy } from "../policy/types";
import { asHapi, redactionValues, startRun, zoneSecrets } from "../run/lifecycle";
import { lockHeld } from "../run/records";
import { sanitizeTerminal } from "../run/sanitize";
import type { RunDeps } from "../run/spec";
import { diffSubjects } from "./decisions";
import { discoverWorkOrders, type DiscoverDeps, firstAddedBy, pinWorkOrder, planningPrOf, readWorkOrder } from "./discover";
import { diffStat, push, runGates } from "./harvest";
import { engineDirOf, ensureMirror, fetchMirror, type MirrorDeps } from "./mirror";
import { advance, type PipelineDeps } from "./pipeline";
import { ACTIVE, formatTick, type PollDeps, pollTick, QUEUE, type Tick, withPollLock } from "./poll";
import { appendEvent, modelsLine, rowsOf, statusTable, totalOf } from "./status";
import { listStates, readState, retryProblem, retryState, type WorkOrderState, writeState } from "./state";
import { isWorkOrderId } from "../workorder/validate";

export const POLL_USAGE = "usage: hapi poll [--once]";
export const STATUS_USAGE = "usage: hapi status [<owner>/<name>]";
export const RETRY_USAGE = "usage: hapi retry <owner>/<name> <work-order-id>";

/** The central policy of the checkout `d.root` names. */
const centralOf = (d: Pick<RunDeps, "root">): Policy => loadPolicy(join(d.root, "policy"));
/** Throws unless `repo` is registered. */
function registeredIn(central: Policy, repo: string): void {
  if (!Object.hasOwn(central.repos.repos, repo)) throw new Error(`${repo} isn't registered in policy/repos.yaml`);
}

/**
 * Task 13's `PipelineDeps` for one repo and tick: the tick's forges and tokens, both zones' secrets for redaction, the
 * host gates, the never-forced push, startRun (its warnings to `warn`), the repo owner as the operator, the repo's
 * visibility, the decision models' subjects, stat, `ask` and keys (read in-process, never put in an environment).
 */
export async function pipelineDepsOf(run: RunDeps, policy: Policy, engineDir: string, repo: string, t: Tick, emit: PipelineDeps["emit"], warn: (w: string) => void = () => {}): Promise<PipelineDeps> {
  const owner = parseOwnerRepo(repo);
  if (owner === undefined) throw new Error(`not an owner/name: ${JSON.stringify(repo.slice(0, 120))}`);
  const d: PipelineDeps = {
    run,
    engineDir,
    repo,
    central: policy,
    forge: (p) => t.forge(p),
    token: (p) => t.token(p),
    // Both zones' values by name (the review zone's under its own name where it differs), for redaction only.
    secrets: () => redactionValues(run.env, "review"),
    gates: (o, r) => runGates(d, o, r),
    pushBranch: (o) => push(run, o),
    public: await t.isPublic(),
    subjects: (o) => diffSubjects(run, o),
    stat: (o) => diffStat(run, o),
    decide: ask,
    decideKeys: async () => {
      const z = await zoneSecrets("archon", run.env);
      return { jev: z.HAPI_JEV_OPENROUTER_API_KEY, anthropic: z.ANTHROPIC_API_KEY };
    },
    start: async (o) => {
      const r = await startRun(run, o);
      for (const w of r.warnings ?? []) warn(w);
      return r;
    },
    emit,
    operator: owner.owner,
  };
  return d;
}

/** The poller's `advance`: Task 13's, its events only collected, so the poller appends them once the state is written. */
export function engineAdvance(run: RunDeps, policy: Policy, engineDir: string): PollDeps["advance"] {
  return async (s, order, t) => {
    const events: Awaited<ReturnType<PollDeps["advance"]>>["events"] = [];
    const warnings: string[] = [];
    const d = await pipelineDepsOf(run, policy, engineDir, s.repo, t, async (e) => void events.push(e), (w) => void warnings.push(w));
    const state = await advance(d, s, order);
    return { state, events, ...(warnings.length > 0 ? { warnings } : {}) };
  };
}

/** The poller's production deps over `run`, with `over` in place of any (tests). */
export async function pollDeps(run: RunDeps, over: Partial<PollDeps> = {}): Promise<PollDeps> {
  const policy = over.policy ?? centralOf(run);
  const engineDir = over.engineDir ?? engineDirOf(run.env);
  const md: MirrorDeps = { run: run.run, env: run.env, engineDir };
  const dd: DiscoverDeps = { ...md, central: policy };
  return {
    run,
    policy,
    engineDir,
    mint: (repo, p) => forgeToken(run.env, repo, p, { registry: policy.repos }),
    forge: (repo, token) => githubForge({ repo, token }),
    fetchMirror: async (repo, token) => {
      await ensureMirror(md, repo);
      await fetchMirror(md, repo, token);
    },
    discover: (repo, known, problems) => discoverWorkOrders(dd, repo, known, problems),
    readOrder: (repo, id, mergeSha) => readWorkOrder(dd, repo, id, mergeSha),
    planningPr: (repo, mergeSha) => planningPrOf(md, repo, mergeSha),
    problemPr: async (repo, path) => {
      const sha = await firstAddedBy(md, repo, path);
      return sha === undefined ? undefined : planningPrOf(md, repo, sha);
    },
    pin: (repo, id, mergeSha) => pinWorkOrder(md, repo, id, mergeSha),
    advance: engineAdvance(run, policy, engineDir),
    ...over,
  };
}

/** `hapi poll [--once]`: see the module comment. */
export async function pollCommand(args: string[], deps: { run?: Partial<RunDeps>; poll?: Partial<PollDeps>; sleep?: (ms: number) => Promise<void> } = {}): Promise<number> {
  if (!(args.length === 0 || (args.length === 1 && args[0] === "--once"))) {
    console.error(POLL_USAGE);
    return 2;
  }
  const once = args.length === 1;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  return asHapi(["poll"], args, deps.run ?? {}, async (d) => {
    const pd = await pollDeps(d, deps.poll);
    for (;;) {
      const report = await pollTick(pd);
      for (const line of formatTick(report)) console.log(line);
      if (once) return report.repos.some((r) => r.error !== undefined) ? 1 : 0;
      await sleep(pd.policy.runs.poll_interval_s * 1000);
    }
  });
}

/** Each planning PR's block for `hapi status`: its header, the table, the total and the decision-models line. */
async function statusBlocks(d: RunDeps, central: Policy, engineDir: string, states: WorkOrderState[]): Promise<string[]> {
  const groups = new Map<string, WorkOrderState[]>();
  for (const s of states) {
    const key = `${s.repo}\0${s.planningPr ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const blocks: string[] = [];
  const keys = [...groups.keys()].sort((a, b) => {
    const [ra, pa] = a.split("\0");
    const [rb, pb] = b.split("\0");
    return ra! < rb! ? -1 : ra! > rb! ? 1 : (Number(pa) || Number.MAX_SAFE_INTEGER) - (Number(pb) || Number.MAX_SAFE_INTEGER);
  });
  for (const key of keys) {
    const mine = groups.get(key)!.sort((a, b) => (a.id < b.id ? -1 : 1));
    const first = mine[0]!;
    const rows = await rowsOf(d.stateDir, mine, central.budgets.run_usd, engineDir, central.gates.classifiers.jev.unknown_call_usd, d.now());
    const lines = [first.planningPr === undefined ? `${first.repo} (no planning PR)` : `${first.repo} planning PR #${first.planningPr}`, statusTable(rows), `Total: $${totalOf(rows).toFixed(2)}`];
    const m = modelsLine(central.decisions.mode);
    if (m !== undefined) lines.push(m);
    blocks.push(sanitizeTerminal(lines.join("\n")));
  }
  return blocks;
}

/** `hapi status [<owner>/<name>]`: see the module comment. */
export async function statusCommand(args: string[], deps: { run?: Partial<RunDeps>; engineDir?: string } = {}): Promise<number> {
  if (args.length > 1 || (args.length === 1 && parseOwnerRepo(args[0]!) === undefined)) {
    console.error(STATUS_USAGE);
    return 2;
  }
  const repo = args[0];
  return asHapi(["status"], args, deps.run ?? {}, async (d) => {
    const central = centralOf(d);
    if (repo !== undefined) registeredIn(central, repo);
    const engineDir = deps.engineDir ?? engineDirOf(d.env);
    const states = repo === undefined ? (await listStates(engineDir)).filter((s) => Object.hasOwn(central.repos.repos, s.repo)) : await listStates(engineDir, repo);
    if (states.length === 0) {
      console.log(repo === undefined ? "hapi status: no work order has a state yet" : `hapi status: ${repo} has no work order with a state yet`);
      return 0;
    }
    for (const block of await statusBlocks(d, central, engineDir, states)) console.log(block);
    return 0;
  });
}

/** `hapi retry <owner>/<name> <work-order-id>`: see the module comment. */
export async function retryCommand(args: string[], deps: { run?: Partial<RunDeps>; engineDir?: string } = {}): Promise<number> {
  const [repo, id] = args;
  if (args.length !== 2 || parseOwnerRepo(repo!) === undefined || !isWorkOrderId(id!) || id!.length > 80) {
    console.error(RETRY_USAGE);
    return 2;
  }
  return asHapi(["retry"], args, deps.run ?? {}, async (d) => {
    const central = centralOf(d);
    registeredIn(central, repo!);
    const engineDir = deps.engineDir ?? engineDirOf(d.env);
    const line = await withPollLock(engineDir, d.env, async () => {
      const s = await readState(engineDir, repo!, id!);
      if (s === undefined) throw new Error(`${repo} has no work order ${id}: \`hapi status ${repo}\` lists them`);
      const why = retryProblem(s, central.runs.max_retries);
      if (why !== undefined) throw new Error(why);
      const { state, event } = retryState(s, d.now().toISOString());
      await writeState(engineDir, state);
      await appendEvent(engineDir, event);
      const ahead = (await listStates(engineDir, repo)).filter((x) => x.id !== id && x.pr === undefined && (ACTIVE.includes(x.phase) || QUEUE.includes(x.phase))).length;
      return `hapi retry: ${repo} ${id} is queued again (retry ${state.retry}), with ${ahead} of the repo's work orders ahead of it: a poll tick starts its worker at ${state.mergeSha.slice(0, 12)} once none is ahead and the caps allow`;
    }).catch((e: unknown) => {
      if (lockHeld(e)) throw new Error(`${(e as Error).message}: run hapi retry again when the tick ends`);
      throw e;
    });
    console.log(line);
    return 0;
  });
}
