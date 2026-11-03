/**
 * The work order's state machine (design §3.4, §3.5, §3.6, §3.9; Plan 03 Task 13): `advance` moves one work order
 * one step, from merged to settled, so a crash at any point resumes without a second run or PR (H-166(c), H-183(c)).
 *
 * - **The caller's contract.** Task 14 calls `advance` under the work order's lock and writes the state it returns
 *   only once it resolves, so a throw leaves the state file as it was. `advance` writes no state and no event file:
 *   each call makes at most one transition and starts at most one run, and hands that transition's one event to
 *   `d.emit`. A step whose state changes but whose phase doesn't (the operator's latest action, the PR's head in
 *   `waiting`) emits nothing.
 * - **The current pass** is the runs in `s.runs` whose record's `retry` is the state's (`hapi retry` starts a new
 *   pass: every run of it is keyed `…:retry<n>`, so it never meets an earlier pass's). A run a lost state never
 *   listed (a crash between a start and the state's write) is adopted first: an engine run of this work order, this
 *   pass and this repo, whose key is the engine's, keyed at the merge (a worker) or naming the pass's worker as its
 *   parent. Each step also looks for its run by key before it starts one, so a replay never starts a second.
 * - **Starting a run** (`begin`): the key; then the caps (`capProblem`: the repo's month, then the day, an unknown
 *   spend at the full budget), then the automatic-round cap for a worker or an automatic fix; then a review's or a
 *   fix's inputs dir (`RUN_INPUTS`' files, at most `runs.inputs_mb`); then `d.start`. A refusal by a cap keeps the
 *   work order where it is with the cap's text (`queued` goes to `cap-stopped`, and a blocked verify or review stays
 *   in its own phase); a soft cap starts the run with the text in the event, and flags the PR (`hapi:flagged`) once
 *   there is one. A start that throws keeps the phase with the error (its causes too); a held lock propagates.
 * - **Routing**: a stopped run (only the operator's `hapi run stop` gives `stopped`) ends the automatic work first:
 *   `failed` with no PR, `waiting` with one; nothing more is pushed or started but a maintainer's rework. A worker
 *   that failed or timed out fails the work order. Then verify (when on), review (when on), a fix before the PR when
 *   the review asks for one and `fix_rounds_before_pr` allows, the harvest, the PR, CodeRabbit's round on it
 *   (`pr-review`, then `pr-fix`), and `waiting`, where a maintainer's `hapi:rework` label starts a rework.
 * - **The operator always wins.** At the top of every step with a PR: merged or closed settles it; then the
 *   operator's actions since `lastHumanAt` set it and restart the automatic-round count; and in an automatic chain
 *   (a PR, no rework yet) an action, a pending rework request or anyone else on the PR moves it to `waiting` with
 *   `Needs your decision`, leaving a live run to end under its own caps, never harvested.
 * - **Decisions never route.** No rule here reads a screen or a decision's effect: a hold reaches the verdict and the
 *   reasons only through the harvester's `outcome`.
 * - **Re-renders**: a move to `waiting` with a reason, and `ci / gates` completing on the PR's head, re-render the
 *   PR's body (./harvest.ts `rerender`) once no run of the work order is live, asking and pushing nothing.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONTRACT_CHECK, type Forge, type PrInfo, type ReviewComment } from "../forge";
import { parseOwnerRepo } from "../forge/github/app-token";
import { PolicyError } from "../policy/load";
import { PolicyLoosenError } from "../policy/overlay";
import type { Phases, Policy } from "../policy/types";
import { RUN_INPUTS, type RunKind } from "../run/kinds";
import type { StartOptions } from "../run/lifecycle";
import { keyPart, listRecords, lockHeld, RUN_ID, recordDir, runKey, type RunRecord, writeWhole } from "../run/records";
import { errorText, sanitizeTerminal } from "../run/sanitize";
import { runSpend } from "../run/spend";
import { autoRoundsProblem, capProblem } from "./caps";
import { CR_CLEAN, crFindings, maintainerComments, operatorActions, othersOnPr, reworkRequest } from "./coderabbit";
import { scratchGit } from "./decisions";
import { type Discovered, unpinWorkOrder } from "./discover";
import { codeRabbitResult, quoteUntrusted, type ReviewResult, reviewResult, type CodeRabbitResult, verifyResult } from "./evidence";
import { harvest, type HarvestDeps, type HarvestInput, policyOf, rerender, type Round, scratchPath, worse } from "./harvest";
import { mirrorPath } from "./mirror";
import { BEGIN, plain } from "./pr";
import { listStates, type Phase, type StatusEvent, transition, type WorkOrderState } from "./state";

export interface PipelineDeps extends HarvestDeps {
  /** Production: `(o) => startRun(d.run, o)`. */
  start(o: StartOptions): Promise<RunRecord>;
  /** Production: Task 14's collector; the poller appends what it collected to events.jsonl once the state is written. */
  emit(e: StatusEvent): Promise<void>;
  /** The repo owner's login (`new-repo` makes repos only on a personal account): the operator. */
  operator: string;
}

/** GitHub Actions' App id: the `ci / gates` check run counts only from it (as `main-protect` requires it). */
const ACTIONS_APP_ID = 15368;
/** What a soft cap's reason ends with: kept through the pass, so the PR is flagged once it exists. */
const SOFT = " (budgets.enforcement.poller is soft, so the run started anyway)";
const MIB = 1024 * 1024;
const NOT_ADVANCED: readonly Phase[] = ["held", "failed", "merged", "closed"];
/** Phases of an automatic chain on a PR: an operator action, a rework request or anyone else stops it. */
const CHAIN: readonly Phase[] = ["pr", "pr-review", "pr-fix", "verify", "review", "harvest"];
/** Of those, the ones inside the automatic fix round: what it made is never pushed once the operator acts. */
const IN_ROUND: readonly Phase[] = ["pr-fix", "verify", "review", "harvest"];

const h7 = (sha: string) => sha.slice(0, 7);
const kindOf = (r: RunRecord): RunKind => r.kind ?? "worker";
const isSource = (r: RunRecord) => kindOf(r) === "worker" || kindOf(r) === "fix";
/** A time as an instant (ms), for every comparison here: GitHub gives whole seconds, the host milliseconds; one that doesn't parse sorts first. */
const ms = (t: string) => {
  const x = Date.parse(t);
  return Number.isFinite(x) ? x : Number.NEGATIVE_INFINITY;
};
/** The latest of some times, as an instant (its own text kept). */
const latest = (xs: (string | undefined)[]) => xs.filter((x): x is string => x !== undefined && Number.isFinite(Date.parse(x))).sort((a, b) => ms(a) - ms(b)).at(-1);
/** By startedAt, as instants. */
const byStart = (a: RunRecord, b: RunRecord) => ms(a.startedAt) - ms(b.startedAt);
const dedupe = (xs: string[]) => [...new Set(xs)];
const sticky = (reasons: readonly string[]) => reasons.filter((r) => r.endsWith(SOFT));

/** An error's message and its causes', for a reason (src/run/sanitize.ts, where the CLI's own error line gets it too). */
export { errorText };

/** One advance's working set. `s` is the state as the advance has changed it so far. */
interface Ctx {
  d: PipelineDeps;
  order: Discovered;
  policy: Policy;
  phases: Phases;
  s: WorkOrderState;
  /** Every run record. */
  all: RunRecord[];
  /** The current pass, by startedAt (then by its place in `s.runs`). */
  pass: RunRecord[];
  /** Runs of the pass a lost state never listed, adopted by this advance. */
  lost: Set<string>;
  at: string;
  forge?: Forge;
  pr?: PrInfo;
  /** Why the automatic chain on the PR stops this advance: an operator action, a rework request, someone else. */
  halt?: string;
  /** A maintainer's pending rework request. */
  rework?: { at: string; by: string };
}

/** A run to start: its kind, round, commit and source, its budget, whether it is automatic, and a review's or fix's inputs. */
interface Step {
  kind: RunKind;
  round: number;
  sha: string;
  source: string;
  budgetUsd: number;
  /** A worker or an automatic fix: the automatic-round cap applies, and the count rises. */
  auto: boolean;
  inputs?: () => Promise<Record<string, string>>;
}
type Begun = { run: RunRecord; warn?: string } | { refused: string; why: "cap" | "auto" | "start" | "inputs" };

/**
 * Move work order `s0` one step (see the module comment). Returns the state to write; `held`, `failed`, `merged`
 * and `closed` come back as they are. Throws (the state stays as it was) on a host failure: the forge, git, a
 * record hapi didn't write, a held lock.
 */
export async function advance(d: PipelineDeps, s0: WorkOrderState, order: Discovered): Promise<WorkOrderState> {
  if (NOT_ADVANCED.includes(s0.phase)) return s0;
  const at = d.run.now().toISOString();
  let policy: Policy;
  try {
    policy = policyOf(d.central, order);
  } catch (e) {
    // Central policy tightened since the work order was read (m15): this work order waits, and the repo's tick goes on.
    if (!(e instanceof PolicyLoosenError) && !(e instanceof PolicyError)) throw e;
    return hold({ d, s: s0, at } as Ctx, `.factory/config.yaml at ${s0.mergeSha.slice(0, 12)}: ${errorText(e)}`);
  }
  const all = await listRecords(d.run.stateDir);
  const c: Ctx = { d, order, policy, phases: policy.runs.phases, s: s0, all, pass: [], lost: new Set(), at };
  adopt(c);
  if (c.s.pr !== undefined) {
    const settled = await prTop(c);
    if (settled !== undefined) return settled;
  }
  switch (c.s.phase) {
    case "queued":
    case "cap-stopped":
      return queued(c);
    case "worker":
      return worker(c);
    case "verify":
      return verify(c);
    case "review":
      return review(c);
    case "fix":
    case "pr-fix":
      return fix(c);
    case "harvest":
      return harvestStep(c);
    case "pr":
      return prStep(c);
    case "pr-review":
      return prReview(c);
    case "waiting":
      return waiting(c);
    default:
      return c.s;
  }
}

// --- the pass and its runs ---------------------------------------------------------------------------------------

/** Adopt the runs a lost state never listed (see the module comment), and build the pass. */
function adopt(c: Ctx): void {
  const listed = new Set(c.s.runs);
  const repo = c.order.repo.toLowerCase();
  const engine = (r: RunRecord) =>
    !listed.has(r.runId) && r.workOrder === c.s.id && r.retry === c.s.retry && r.forgeRepo === repo && r.key === runKey(c.s.id, r.sha, keyPart(kindOf(r), r.round ?? 0, r.retry));
  const workers = new Set(c.all.filter((r) => listed.has(r.runId) && kindOf(r) === "worker" && (r.retry ?? 0) === c.s.retry).map((r) => r.runId));
  const lost: RunRecord[] = [];
  for (const r of c.all) {
    if (engine(r) && kindOf(r) === "worker" && r.sha === c.s.mergeSha) {
      lost.push(r);
      workers.add(r.runId);
    }
  }
  for (const r of c.all) if (engine(r) && kindOf(r) !== "worker" && r.parent !== undefined && workers.has(r.parent)) lost.push(r);
  lost.sort(byStart);
  if (lost.length > 0) c.s = { ...c.s, runs: [...c.s.runs, ...lost.map((r) => r.runId)] };
  c.lost = new Set(lost.map((r) => r.runId));
  const place = new Map(c.s.runs.map((id, i) => [id, i]));
  c.pass = c.all
    .filter((r) => place.has(r.runId) && (r.retry ?? 0) === c.s.retry)
    .sort((a, b) => byStart(a, b) || place.get(a.runId)! - place.get(b.runId)!);
}

const ofKind = (c: Ctx, k: RunKind) => c.pass.filter((r) => kindOf(r) === k);
/** The pass's runs after `r`. */
const after = (c: Ctx, r: RunRecord) => c.pass.slice(c.pass.indexOf(r) + 1);
/** The pass's newest worker or fix run. */
const source = (c: Ctx) => c.pass.filter(isSource).at(-1);
/** The pass's worker: every later run's parent. */
const passWorker = (c: Ctx) => ofKind(c, "worker").at(-1);
/** The pass's fix runs a lost state didn't start: the next fix's round is one more. */
const fixesDone = (c: Ctx) => ofKind(c, "fix").filter((r) => !c.lost.has(r.runId)).length;
const outOf = (c: Ctx, r: RunRecord) => join(recordDir(c.d.run.stateDir, r.runId), "out");
const spent = (c: Ctx, r: RunRecord) => runSpend(c.d.run.stateDir, r, c.policy.budgets.run_usd).usd;
const scratch = (c: Ctx) => scratchPath(c.d.engineDir, c.d.repo, c.s.id);
const roundBudget = (c: Ctx) => Math.min(c.order.workOrder.budget.usd, c.phases.round_usd);
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * `<engineDir>/heads/<owner>/<name>/<id>.json` (0600, dirs 0700): each source run's head once its host gates passed.
 * A run's bundle never changes, so a step that needs that head again (a verify or review a cap blocked, a harvest
 * replayed) reads it here instead of running the gates again (a fetch, a repack and a gitleaks pass each time). A
 * cache only: a file that doesn't parse reads as empty, and the gates run again. The poller (./poll.ts) deletes it
 * when it writes the work order's state merged or closed.
 */
export function headsFile(engineDir: string, repo: string, id: string): string {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${repo}`);
  return join(engineDir, "heads", r.owner, r.name, `${id}.json`);
}
const headsPath = (c: Ctx): string => headsFile(c.d.engineDir, c.s.repo, c.s.id);
async function readHeads(c: Ctx): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(headsPath(c), "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((e): e is [string, string] => RUN_ID.test(e[0]) && typeof e[1] === "string" && COMMIT.test(e[1])));
}
async function cacheHead(c: Ctx, runId: string, head: string): Promise<void> {
  const heads = await readHeads(c);
  if (heads[runId] === head) return;
  const file = headsPath(c);
  const made = await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (made !== undefined) for (let d = dirname(file); d.length >= made.length; d = dirname(d)) await chmod(d, 0o700);
  await writeWhole(file, `${JSON.stringify({ ...heads, [runId]: head })}\n`);
}

/**
 * The head source run `src` gave, by its host gates (or the cache of a pass the gates gave before); the gates' details
 * when they refuse it; `live` when a run of the pass is live, since the gates write the scratch a run clones from.
 */
async function gatedHead(c: Ctx, src: RunRecord): Promise<{ head: string } | { problems: string[] } | { live: true }> {
  const heads = await readHeads(c);
  const cached = heads[src.runId];
  if (cached !== undefined) {
    // A cache hit only while the scratch holds that commit (D76): a purge or a fresh scratch drops it, and the gates
    // run again on the bundle.
    if ((await scratchGit(c.d.run, scratch(c), ["cat-file", "-e", `${cached}^{commit}`])).code === 0) return { head: cached };
    const { [src.runId]: _, ...rest } = heads;
    await writeWhole(headsPath(c), `${JSON.stringify(rest)}\n`);
  }
  if (c.pass.some((r) => r.status === "live")) return { live: true };
  const g = await c.d.gates(c.order, src);
  if (g.problems.length > 0 || g.head === undefined) return { problems: g.problems.length > 0 ? g.problems.map((p) => p.detail) : [`${kindOf(src)} run ${src.runId}'s bundle has no head`] };
  await cacheHead(c, src.runId, g.head);
  return { head: g.head };
}

// --- moving -----------------------------------------------------------------------------------------------------

/** One transition to `to`, with `c.s` as the step left it; its event goes to `d.emit`. */
async function move(c: Ctx, to: Phase, o: { reason?: string | undefined; run?: string | undefined; usd?: number | undefined } = {}): Promise<WorkOrderState> {
  const { state, event } = transition(c.s, to, {
    at: c.at,
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.run === undefined ? {} : { run: o.run }),
    ...(o.usd === undefined ? {} : { usd: o.usd }),
  });
  await c.d.emit(event);
  c.s = state;
  return state;
}

/** Stay where it is, with `reason` first (a cap, a start that failed): an event only when the reasons change, and `updatedAt` kept. */
async function hold(c: Ctx, reason: string): Promise<WorkOrderState> {
  const reasons = dedupe([reason, ...sticky(c.s.reasons)]);
  if (reasons.length === c.s.reasons.length && reasons.every((r, i) => r === c.s.reasons[i])) return c.s;
  const s = { ...c.s, reasons };
  await c.d.emit(transition(s, s.phase, { at: c.at, reason }).event);
  return s;
}

/** `failed` with `reasons`: the work order has no PR. */
async function fail(c: Ctx, reasons: string[], o: { run?: string; usd?: number } = {}): Promise<WorkOrderState> {
  c.s = { ...c.s, reasons };
  return move(c, "failed", { reason: reasons[0], ...o });
}

/** `waiting`: with a reason, `Needs your decision` and the reason added, and the PR's body re-rendered once nothing is live. */
async function wait(c: Ctx, reason: string | undefined, o: { run?: string; usd?: number } = {}): Promise<WorkOrderState> {
  if (reason !== undefined) c.s = { ...c.s, verdict: worse(c.s.verdict ?? "ready", "decision"), reasons: dedupe([...c.s.reasons, reason]) };
  const s = await move(c, "waiting", { reason, ...o });
  if (reason !== undefined) await renderPr(c, undefined);
  return s;
}

/** The automatic round halted before its verify or review started (final review I4): `waiting` with the halt, the start's refusal dropped. */
function halted(c: Ctx): Promise<WorkOrderState> {
  c.s = { ...c.s, reasons: sticky(c.s.reasons) };
  return wait(c, c.halt);
}

/** A run's own stop (`hapi run stop`): the automatic work ends. */
function stopped(c: Ctx, r: RunRecord): Promise<WorkOrderState> {
  const why = r.reason ?? "no reason recorded";
  const o = { run: r.runId, usd: spent(c, r) };
  if (c.s.pr === undefined) return fail(c, [`${kindOf(r)} run ${r.runId} ended stopped: ${why}`], o);
  return wait(c, `round ${r.round ?? 0}'s ${kindOf(r)} run ended stopped: ${why}; the PR is unchanged`, o);
}

/** A review's or fix's inputs over `runs.inputs_mb`: the run can't happen, ever, with these inputs. */
function inputsRefused(c: Ctx, reason: string): Promise<WorkOrderState> {
  return c.s.pr === undefined ? fail(c, [reason]) : c.s.phase === "waiting" ? hold(c, reason) : wait(c, reason);
}

/** In `waiting`, a run that will never start (the rework cap): Needs your decision with why, once, and the PR says so. */
async function refuse(c: Ctx, reason: string): Promise<WorkOrderState> {
  if (c.s.reasons.includes(reason)) {
    await converge(c);
    return c.s;
  }
  c.s = { ...c.s, verdict: worse(c.s.verdict ?? "ready", "decision"), reasons: dedupe([...c.s.reasons, reason]) };
  await c.d.emit(transition(c.s, c.s.phase, { at: c.at, reason }).event);
  await renderPr(c, undefined);
  return c.s;
}

/** The phase `succ` (a run started after the step's own) says a lost state had reached. */
async function successor(c: Ctx, succ: RunRecord, usd?: number): Promise<WorkOrderState> {
  const k = kindOf(succ);
  const to: Phase = k === "fix" ? (c.s.pr === undefined ? "fix" : "pr-fix") : k === "worker" ? "worker" : k;
  const counted = k === "fix" && c.lost.has(succ.runId);
  c.s = { ...c.s, autoRounds: counted ? c.s.autoRounds + 1 : c.s.autoRounds, reasons: sticky(c.s.reasons) };
  return move(c, to, { run: succ.runId, usd });
}

// --- starting a run ---------------------------------------------------------------------------------------------

/** Start `step`, or find its run by key (see the module comment). */
async function begin(c: Ctx, step: Step): Promise<Begun> {
  const key = runKey(c.s.id, step.sha, keyPart(step.kind, step.round, c.s.retry));
  const found = c.all.filter((r) => r.key === key).sort(byStart).at(-1);
  if (found !== undefined) return { run: found };
  const cap = await capProblem(c.d, c.order.repo, c.policy, step.budgetUsd, c.s);
  if (cap !== undefined && "refuse" in cap) return { refused: cap.refuse, why: "cap" };
  if (step.auto) {
    const a = autoRoundsProblem(c.s, c.policy.runs.max_auto_rounds);
    if (a !== undefined) return { refused: a, why: "auto" };
  }
  const parent = passWorker(c);
  if (step.kind !== "worker" && parent === undefined) {
    // Final review I3: the reaper (runs.retention_days) removes a waiting PR's runs once their month ended; a step
    // that needs the pass's worker as its parent can't start, and says so instead of failing the repo's tick.
    const what = step.kind === "fix" && !step.auto ? "rework" : `${step.kind} run`;
    return {
      refused: `work order ${c.s.id}'s worker run of pass ${c.s.retry} has no record (runs.retention_days removed it once its month ended): no ${what} can start${c.s.pr === undefined ? "" : ` on #${c.s.pr}`}; close the PR, or plan the work again under a new work order id`,
      why: "start",
    };
  }
  let inputsDir: string | undefined;
  if (step.inputs !== undefined) {
    const dir = await writeInputs(c, step, await step.inputs());
    if ("refused" in dir) return { refused: dir.refused, why: "inputs" };
    inputsDir = dir.path;
  }
  const o: StartOptions = {
    repoGitDir: step.source,
    workOrder: c.order.workOrder,
    taskMd: c.order.taskMd,
    sha: step.sha,
    public: c.d.public,
    kind: step.kind,
    ...(step.kind === "worker" ? {} : { parent: parent!.runId }),
    round: step.round,
    retry: c.s.retry,
    budgetUsd: step.budgetUsd,
    ...(c.order.overlay === undefined ? {} : { overlay: c.order.overlay }),
    ...(inputsDir === undefined ? {} : { inputsDir }),
    forgeRepo: c.order.repo,
  };
  try {
    const run = await c.d.start(o);
    return { run, ...(cap !== undefined && "warn" in cap ? { warn: cap.warn } : {}) };
  } catch (e) {
    if (lockHeld(e)) throw e;
    return { refused: errorText(e), why: "start" };
  }
}

/** The step's run is started (or found): it joins the pass, a worker or automatic fix counts, and the phase is `to`. */
async function started(c: Ctx, to: Phase, step: Step, b: { run: RunRecord; warn?: string }, o: { reason?: string; usd?: number | undefined; extra?: Partial<WorkOrderState> } = {}): Promise<WorkOrderState> {
  const counted = c.s.runs.includes(b.run.runId) && !c.lost.has(b.run.runId);
  const runs = c.s.runs.includes(b.run.runId) ? c.s.runs : [...c.s.runs, b.run.runId];
  let reasons = sticky(c.s.reasons);
  if (b.warn !== undefined) {
    reasons = dedupe([...reasons, `${b.warn}${SOFT}`]);
    // A soft cap's start flags the PR (ruling m8); before there is one, the reason stays until the harvest opens it.
    if (c.s.pr !== undefined && c.policy.flags.on_flag.includes("label_pr")) await c.forge!.addLabels(c.s.pr, ["hapi:flagged"]);
  }
  c.s = { ...c.s, runs, autoRounds: step.auto && !counted ? c.s.autoRounds + 1 : c.s.autoRounds, reasons, ...o.extra };
  return move(c, to, { run: b.run.runId, reason: b.warn ?? o.reason, usd: o.usd });
}

/** A verify or review step: into its phase, its run started, or the phase kept with why not (a blocked run stays in its phase). */
async function enter(c: Ctx, to: Phase, step: Step, usd?: number): Promise<WorkOrderState> {
  const b = await begin(c, step);
  if ("run" in b) return started(c, to, step, b, { usd });
  if (b.why === "inputs") return inputsRefused(c, b.refused);
  if (c.s.phase === to) return hold(c, b.refused);
  c.s = { ...c.s, reasons: dedupe([b.refused, ...sticky(c.s.reasons)]) };
  return move(c, to, { reason: b.refused, usd });
}

/** A review's or fix's inputs dir, `<engineDir>/inputs/<owner>/<name>/<id>/<kind>-<round>[-retry<n>]/` (0755, files 0644), at most `runs.inputs_mb`. */
async function writeInputs(c: Ctx, step: Step, files: Record<string, string>): Promise<{ path: string } | { refused: string }> {
  const r = parseOwnerRepo(c.s.repo)!;
  const path = join(c.d.engineDir, "inputs", r.owner, r.name, c.s.id, `${step.kind}-${step.round}${c.s.retry >= 1 ? `-retry${c.s.retry}` : ""}`);
  const bytes = Object.values(files).reduce((n, t) => n + Buffer.byteLength(t), 0);
  const cap = c.d.central.runs.inputs_mb;
  if (bytes > cap * MIB) {
    return { refused: `a ${step.kind} run's inputs (${Object.keys(files).join(", ")}) are ${(bytes / MIB).toFixed(1)} MiB, over runs.inputs_mb (${cap} MiB): refused, never truncated` };
  }
  await rm(path, { recursive: true, force: true });
  const made = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (made !== undefined) for (let d = dirname(path); d.length >= made.length; d = dirname(d)) await chmod(d, 0o700);
  await mkdir(path, { mode: 0o755 });
  await chmod(path, 0o755);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(path, name), text, { flag: "wx" });
    await chmod(join(path, name), 0o644);
  }
  return { path };
}

/** A review of `head` (round `round`): the diff from the merge, and verify's results when a verify run of it left them. */
function reviewStep(c: Ctx, head: string, round: number, verifyRun: RunRecord | undefined): Step {
  return {
    kind: "review",
    round,
    sha: head,
    source: scratch(c),
    budgetUsd: roundBudget(c),
    auto: false,
    inputs: async () => {
      const diff = await scratchGit(c.d.run, scratch(c), ["diff", "--no-color", "--no-ext-diff", "--no-textconv", c.s.mergeSha, head]);
      if (diff.code !== 0) throw new Error(`cannot read the review's diff in the scratch (git diff exited ${diff.code}): ${(diff.stderr ?? "").trim().split("\n")[0] ?? ""}`);
      const files: Record<string, string> = { [RUN_INPUTS.diff]: diff.stdout };
      if (verifyRun !== undefined) {
        const v = await readFile(join(outOf(c, verifyRun), RUN_INPUTS.verify), "utf8").catch(() => undefined);
        if (v !== undefined) files[RUN_INPUTS.verify] = v;
      }
      return files;
    },
  };
}

/** A label for an untrusted name in a quote's banner: one line, printable, at most 120 characters. */
const label = (s: string) => {
  const t = sanitizeTerminal(s.replace(/[\r\n\t]/g, " ")).replace(/[`]/g, "").trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t || "(no name)";
};

/** findings.md: one quoted block per item, or a host line when there is none. */
const findingsMd = (blocks: string[], none: string) => `${blocks.length > 0 ? blocks.join("\n\n") : none}\n`;

/** The review's findings, its criteria not met, and the CLI's major and critical findings, each quoted as data. */
function reviewBlocks(rv: ReviewResult, cr: CodeRabbitResult): string[] {
  const blocks: string[] = [];
  if (rv.state === "ran") {
    rv.findings.forEach((f, i) => blocks.push(quoteUntrusted(`independent review finding ${i + 1} (${f.severity})`, `${f.path}: ${f.summary}`)));
    rv.criteria.forEach((x, i) => {
      if (x.mark !== "met") blocks.push(quoteUntrusted(`independent review criterion ${i + 1} (${x.mark === "partly" ? "partly met" : "unmet"})`, `${x.criterion}\n${x.evidence}`));
    });
  }
  if (cr.state === "reviewed") {
    cr.findings
      .filter((f) => f.severity === "critical" || f.severity === "major")
      .forEach((f, i) => blocks.push(quoteUntrusted(`CodeRabbit CLI finding ${i + 1} on ${label(f.file)}`, `${f.title}\n${f.text}`)));
  }
  return blocks;
}

/** CodeRabbit's PR comments, each quoted as data. */
const crBlocks = (findings: ReviewComment[]) => findings.map((f) => quoteUntrusted(`CodeRabbit review comment ${f.id} on ${label(f.path)}`, f.body));

// --- the steps before the PR -------------------------------------------------------------------------------------

async function queued(c: Ctx): Promise<WorkOrderState> {
  const step: Step = { kind: "worker", round: 0, sha: c.s.mergeSha, source: mirrorPath(c.d.engineDir, c.d.repo), budgetUsd: Math.min(c.order.workOrder.budget.usd, c.policy.budgets.run_usd), auto: true };
  const b = await begin(c, step);
  if ("run" in b) return started(c, "worker", step, b);
  if (b.why === "cap") {
    if (c.s.phase === "cap-stopped") return hold(c, b.refused);
    c.s = { ...c.s, reasons: [b.refused] };
    return move(c, "cap-stopped", { reason: b.refused });
  }
  if (b.why === "auto") return fail(c, [b.refused]);
  return hold(c, b.refused);
}

async function worker(c: Ctx): Promise<WorkOrderState> {
  const w = passWorker(c);
  if (w === undefined) return queued(c);
  return fromSource(c, w);
}

/** A worker's or fix's run, as the step's own: wait for it, route its end, or check its gates and go on. */
async function fromSource(c: Ctx, src: RunRecord): Promise<WorkOrderState> {
  if (src.status === "stopped") return stopped(c, src);
  if (c.halt !== undefined) return wait(c, c.halt);
  if (src.status === "live") return c.s;
  const usd = spent(c, src);
  const succ = after(c, src)[0];
  if (succ !== undefined) return successor(c, succ, usd);
  const k = src.round ?? 0;
  const o = { run: src.runId, usd };
  if (src.status !== "succeeded") {
    const why = `${src.status}: ${src.reason ?? "no reason recorded"}`;
    if (kindOf(src) === "worker") return fail(c, [`worker run ${src.runId} ended ${why}`], o);
    if (c.s.pr === undefined) return toHarvest(c, `round ${k}'s fix run ${src.runId} ended ${why}`, o);
    return wait(c, `round ${k}'s fix run ended ${why}; the PR is unchanged`, o);
  }
  const g = await gatedHead(c, src);
  if ("live" in g) return c.s;
  if ("problems" in g) {
    if (kindOf(src) === "worker") return fail(c, g.problems, o);
    const refused = `round ${k}'s fix run was refused by the host gates: ${g.problems.join("; ")}`;
    if (c.s.pr === undefined) return toHarvest(c, refused, o);
    return wait(c, `${refused}; the PR is unchanged`, o);
  }
  return checks(c, g.head, k, usd);
}

/** To the harvest with `reason` kept in the state's reasons, so the harvest carries it to the PR (design §3.9). */
function toHarvest(c: Ctx, reason: string, o: { run?: string; usd?: number } = {}): Promise<WorkOrderState> {
  c.s = { ...c.s, reasons: dedupe([...c.s.reasons, reason]) };
  return move(c, "harvest", { reason, ...o });
}

/** After a source run whose gates pass: verify, else review, else the harvest. */
function checks(c: Ctx, head: string, round: number, usd?: number): Promise<WorkOrderState> {
  if (c.phases.verify) return enter(c, "verify", { kind: "verify", round, sha: head, source: scratch(c), budgetUsd: 0, auto: false }, usd);
  if (c.phases.review) return enter(c, "review", reviewStep(c, head, round, undefined), usd);
  return move(c, "harvest", { usd });
}


async function verify(c: Ctx): Promise<WorkOrderState> {
  const src = source(c);
  if (src === undefined) return queued(c);
  const v = after(c, src).filter((r) => kindOf(r) === "verify").at(-1);
  if (v === undefined) {
    // An operator action while the start waits wins (final review I4): the round's result is never pushed, and the
    // start's refusal, now moot, gives way to the halt.
    if (c.halt !== undefined) return halted(c);
    // Its start was refused (a cap, an error): try again, on the head the gates gave (cached), or say why not.
    const g = await gatedHead(c, src);
    if ("live" in g) return c.s;
    if ("problems" in g) return hold(c, `the host gates refuse ${kindOf(src)} run ${src.runId}'s bundle now: ${g.problems.join("; ")}`);
    return enter(c, "verify", { kind: "verify", round: src.round ?? 0, sha: g.head, source: scratch(c), budgetUsd: 0, auto: false });
  }
  if (v.status === "stopped") return stopped(c, v);
  if (c.halt !== undefined) return wait(c, c.halt);
  if (v.status === "live") return c.s;
  const usd = spent(c, v);
  const succ = after(c, v)[0];
  if (succ !== undefined) return successor(c, succ, usd);
  // A verify that failed or timed out is read as it is: no verify.json is `broken`.
  const r = verifyResult(outOf(c, v), c.order.workOrder, c.phases, { exitCode: v.exitCode, acceptanceFiles: undefined });
  const passed = r.state === "unconfirmed" || (r.state === "ran" && r.check !== "failed" && r.smoke !== "failed" && r.acceptance !== "failed");
  if (passed && c.phases.review) return enter(c, "review", reviewStep(c, v.sha, v.round ?? 0, v), usd);
  return move(c, "harvest", { run: v.runId, usd });
}

async function review(c: Ctx): Promise<WorkOrderState> {
  const src = source(c);
  if (src === undefined) return queued(c);
  const rv = after(c, src).filter((r) => kindOf(r) === "review").at(-1);
  if (rv === undefined) {
    // An operator action while the start waits wins (final review I4), as in verify().
    if (c.halt !== undefined) return halted(c);
    const v = after(c, src).filter((r) => kindOf(r) === "verify").at(-1);
    if (v !== undefined) return enter(c, "review", reviewStep(c, v.sha, src.round ?? 0, v));
    const g = await gatedHead(c, src);
    if ("live" in g) return c.s;
    if ("problems" in g) return hold(c, `the host gates refuse ${kindOf(src)} run ${src.runId}'s bundle now: ${g.problems.join("; ")}`);
    return enter(c, "review", reviewStep(c, g.head, src.round ?? 0, undefined));
  }
  if (rv.status === "stopped") return stopped(c, rv);
  if (c.halt !== undefined) return wait(c, c.halt);
  if (rv.status === "live") return c.s;
  const usd = spent(c, rv);
  const succ = after(c, rv)[0];
  if (succ !== undefined) return successor(c, succ, usd);
  // Once a PR exists, a review goes to the harvest: the PR's round is CodeRabbit's.
  if (c.s.pr !== undefined) return move(c, "harvest", { run: rv.runId, usd });
  const result = reviewResult(outOf(c, rv), c.phases);
  const cli = codeRabbitResult(outOf(c, rv), c.phases);
  const needs = (result.state === "ran" && result.verdict === "needs-work") || (cli.state === "reviewed" && cli.findings.some((f) => f.severity === "critical" || f.severity === "major"));
  const done = fixesDone(c);
  if (!needs || done >= c.phases.fix_rounds_before_pr) return move(c, "harvest", { run: rv.runId, usd });
  const step: Step = {
    kind: "fix",
    round: done + 1,
    sha: rv.sha,
    source: scratch(c),
    budgetUsd: roundBudget(c),
    auto: true,
    inputs: async () => ({ [RUN_INPUTS.findings]: findingsMd(reviewBlocks(result, cli), "The review said needs-work and listed no finding: read the diff against the work order's acceptance criteria.") }),
  };
  const b = await begin(c, step);
  if ("run" in b) return started(c, "fix", step, b, { usd });
  if (b.why === "auto") return toHarvest(c, b.refused, { usd });
  if (b.why === "inputs") return inputsRefused(c, b.refused);
  return hold(c, b.refused);
}

async function fix(c: Ctx): Promise<WorkOrderState> {
  const f = ofKind(c, "fix").at(-1);
  if (f !== undefined) return fromSource(c, f);
  // No fix run (a state no step writes): as a fix that never happened.
  if (c.s.pr === undefined) return toHarvest(c, "the fix run never started");
  return wait(c, "the fix run never started; the PR is unchanged");
}

/** The run to harvest: with a PR, the pass's newest fix (its chain's own); else the newest worker or fix whose gates passed. */
async function harvestable(c: Ctx): Promise<RunRecord | undefined> {
  const srcs = c.pass.filter((r) => isSource(r) && r.status === "succeeded");
  if (c.s.pr !== undefined) return ofKind(c, "fix").filter((r) => r.status === "succeeded").at(-1) ?? srcs.at(-1);
  const all = c.pass.filter(isSource);
  for (let i = srcs.length - 1; i >= 0; i--) {
    const r = srcs[i]!;
    const next = all[all.indexOf(r) + 1];
    const between = c.pass.slice(c.pass.indexOf(r) + 1, next === undefined ? undefined : c.pass.indexOf(next));
    // A verify or review started on its head only once its gates passed.
    if (between.some((x) => kindOf(x) === "verify" || kindOf(x) === "review")) return r;
    if (!c.phases.verify && !c.phases.review && "head" in (await gatedHead(c, r))) return r;
  }
  return srcs.at(-1);
}

/** The pass's fix rounds, staged by the pass's first harvest and the rework count. */
function roundsOf(c: Ctx): Round[] {
  const first = c.pass.map((r) => r.harvestedAt).filter((x): x is string => x !== undefined && Number.isFinite(Date.parse(x))).sort((a, b) => ms(a) - ms(b))[0];
  const fixes = ofKind(c, "fix");
  const before = fixes.filter((f) => first === undefined || ms(f.startedAt) < ms(first));
  const later = fixes.slice(before.length);
  const rework = Math.min(c.s.reworkRounds, later.length);
  return [
    ...before.map((f) => ({ round: f.round ?? 0, stage: "before-pr" as const, run: f.runId })),
    ...later.map((f, i) => ({ round: f.round ?? 0, stage: i >= later.length - rework ? ("rework" as const) : ("on-pr" as const), run: f.runId })),
  ];
}

/** k of n among the work orders of the same planning PR, by id, and their PRs (m30). */
async function positionOf(c: Ctx): Promise<HarvestInput["position"]> {
  if (c.s.planningPr === undefined) return { k: 1, n: 1, siblings: [] };
  const others = (await listStates(c.d.engineDir, c.s.repo)).filter((x) => x.planningPr === c.s.planningPr && x.id !== c.s.id);
  const ids = [...others.map((x) => x.id), c.s.id].sort();
  return { k: ids.indexOf(c.s.id) + 1, n: ids.length, siblings: others.map((x) => x.pr).filter((p): p is number => p !== undefined).sort((a, b) => a - b) };
}

/** What the harvester reads for `run`: its verify and review, every run of every pass, the pass's rounds and the position. */
async function harvestInput(c: Ctx, run: RunRecord): Promise<HarvestInput> {
  const later = after(c, run);
  const verifyRun = later.filter((r) => kindOf(r) === "verify").at(-1);
  const reviewRun = later.filter((r) => kindOf(r) === "review").at(-1);
  const byId = new Map(c.all.map((r) => [r.runId, r]));
  return {
    order: c.order,
    run,
    ...(verifyRun === undefined ? {} : { verify: verifyRun }),
    ...(reviewRun === undefined ? {} : { review: reviewRun }),
    runs: c.s.runs.map((id) => byId.get(id)).filter((r): r is RunRecord => r !== undefined),
    rounds: roundsOf(c),
    position: await positionOf(c),
  };
}

async function harvestStep(c: Ctx): Promise<WorkOrderState> {
  if (c.halt !== undefined) return wait(c, c.halt);
  const run = await harvestable(c);
  if (run === undefined) return c.s.pr === undefined ? fail(c, ["the pass has no worker or fix run that succeeded: nothing to harvest"]) : wait(c, "the fix round left nothing to harvest; the PR is unchanged");
  // The pass's reasons so far (a fix before the PR that failed or was refused, a soft cap's start) go to the PR too.
  const soft = sticky(c.s.reasons);
  const out = await harvest(c.d, c.s, { ...(await harvestInput(c, run)), carried: c.s.reasons });
  if (out.pr === undefined) {
    c.s = out;
    return fail(c, out.reasons.length > 0 ? out.reasons : ["the harvest had nothing it could push"]);
  }
  c.s = out;
  if (soft.length > 0 && c.policy.flags.on_flag.includes("label_pr")) await (c.forge ?? (await c.d.forge("pr"))).addLabels(out.pr, ["hapi:flagged"]);
  return move(c, "pr", { reason: out.reasons[0] });
}

// --- the PR -----------------------------------------------------------------------------------------------------

/** At the top of every step with a PR (see the module comment): settles a merged or closed PR, else reads the humans. */
async function prTop(c: Ctx): Promise<WorkOrderState | undefined> {
  const forge = await c.d.forge("pr");
  const pr = await forge.pr(c.s.pr!);
  c.forge = forge;
  c.pr = pr;
  if (pr.merged || pr.state === "closed") {
    // Retired: its merge no longer needs its pin (Task 6). The pin of a failed one stays, for `hapi retry`.
    await unpinWorkOrder({ run: c.d.run.run, env: c.d.run.env, engineDir: c.d.engineDir }, c.s.repo, c.s.id);
    return move(c, pr.merged ? "merged" : "closed");
  }
  // A harvest replayed after its push (a write after it failed, or a crash, lost the state): the branch at the head
  // that harvest pushes is the factory's own, never the operator's move.
  let adopted = false;
  if (c.s.phase === "harvest" && pr.headSha !== c.s.prHead) {
    const run = await harvestable(c);
    const g = run === undefined ? undefined : await gatedHead(c, run);
    if (g !== undefined && "head" in g && g.head === pr.headSha) {
      c.s = { ...c.s, prHead: pr.headSha };
      adopted = true;
    }
  }
  const before = c.s.lastHumanAt;
  const acts = await operatorActions(forge, pr, { operator: c.d.operator, since: before, prHead: c.s.prHead, now: c.at });
  const newest = c.pass.filter((r) => isSource(r) && !c.lost.has(r.runId)).at(-1);
  // With no run records (the reaper removed them) and no human action yet, every rework request counts (I3).
  const since = latest([newest?.startedAt, before]) ?? new Date(0).toISOString();
  const rework = await reworkRequest(forge, pr.number, since);
  if (rework !== undefined) c.rework = rework;
  if (acts.length > 0) {
    // lastHumanAt never passes a pending rework request, so it still starts the rework.
    const seen = latest([before, ...acts.filter((a) => rework === undefined || ms(a.at) < ms(rework.at)).map((a) => a.at)]);
    c.s = { ...c.s, autoRounds: 0, ...(seen === undefined ? {} : { lastHumanAt: seen }) };
  }
  if (c.s.reworkRounds === 0 && CHAIN.includes(c.s.phase)) {
    const round = IN_ROUND.includes(c.s.phase);
    // A replayed harvest whose push is adopted above was pushed already (D77): nothing more is.
    const tail = !round ? "the automatic CodeRabbit round is off" : adopted ? "its result was pushed before the operator acted: nothing more is pushed" : "its result is not pushed";
    if (acts.length > 0) {
      const what = acts.at(-1)!.what;
      c.halt = round ? `the operator acted during the automatic fix round (${what}): ${tail}` : `the operator acted on #${pr.number} (${what}): ${tail}`;
    } else if (rework !== undefined) {
      c.halt = `${rework.by} asked for a rework (hapi:rework on #${pr.number})${round ? " during the automatic fix round" : ""}: ${tail}`;
    } else {
      const others = await othersOnPr(forge, pr.number, c.d.operator);
      if (others !== undefined) c.halt = others;
    }
  }
  return undefined;
}

/** The pass's fix rounds on the PR, not counting reworks. */
const onPrRounds = (c: Ctx) => roundsOf(c).filter((r) => r.stage === "on-pr").length;

async function prStep(c: Ctx): Promise<WorkOrderState> {
  if (c.halt !== undefined) return wait(c, c.halt);
  // A draft (Do not merge) gets no CodeRabbit round: CodeRabbit doesn't review drafts (m13).
  if (c.pr!.draft) return wait(c, undefined);
  const round =
    c.policy.flags.coderabbit.enabled && onPrRounds(c) < c.phases.fix_rounds_on_pr && c.s.lastHumanAt === undefined && c.s.reworkRounds === 0;
  return round ? move(c, "pr-review") : wait(c, undefined);
}

async function prReview(c: Ctx): Promise<WorkOrderState> {
  if (c.halt !== undefined) return wait(c, c.halt);
  const pr = c.pr!;
  const cr = await crFindings({ pr: c.forge!, checks: await c.d.forge("checks") }, pr, c.s);
  if ("findings" in cr) {
    const step: Step = {
      kind: "fix",
      round: fixesDone(c) + 1,
      sha: c.s.prHead!,
      source: scratch(c),
      budgetUsd: roundBudget(c),
      auto: true,
      inputs: async () => ({ [RUN_INPUTS.findings]: findingsMd(crBlocks(cr.findings), "CodeRabbit's review listed no finding.") }),
    };
    const b = await begin(c, step);
    if ("run" in b) return started(c, "pr-fix", step, b);
    if (b.why === "auto") return wait(c, b.refused);
    if (b.why === "inputs") return inputsRefused(c, b.refused);
    return hold(c, b.refused);
  }
  if (cr.wait === true) {
    // CodeRabbit may skip a PR without a check: the round waits at most six polls (m13).
    if (Date.parse(c.at) - Date.parse(c.s.updatedAt) > 6 * c.d.central.runs.poll_interval_s * 1000) return wait(c, `CodeRabbit didn't review ${h7(pr.headSha)}`);
    await converge(c);
    return c.s;
  }
  return wait(c, cr.none.startsWith(CR_CLEAN) ? undefined : cr.none);
}

async function waiting(c: Ctx): Promise<WorkOrderState> {
  const pr = c.pr!;
  // Only here does the state take the PR's head, so a moved head is reported once.
  if (c.s.prHead !== pr.headSha) c.s = { ...c.s, prHead: pr.headSha };
  const rework = c.rework;
  if (rework === undefined) {
    await converge(c);
    return c.s;
  }
  // The rework cap, always hard and central (the operator's ruling, 2026-11-03): past it the PR is the operator's.
  const max = c.d.central.runs.max_rework_rounds;
  if (c.s.reworkRounds >= max) {
    return refuse(c, `${c.s.reworkRounds} rework rounds on #${pr.number} (runs.max_rework_rounds: ${max}): close the PR, or plan the work again under a new work order id`);
  }
  const newest = c.pass.filter((r) => isSource(r) && !c.lost.has(r.runId)).at(-1);
  const since = newest?.startedAt ?? new Date(0).toISOString();
  const step: Step = {
    kind: "fix",
    round: fixesDone(c) + 1,
    sha: pr.headSha,
    source: mirrorPath(c.d.engineDir, c.d.repo),
    budgetUsd: roundBudget(c),
    auto: false,
    inputs: async () => {
      const blocks = [await maintainerComments(c.forge!, pr.number, since, c.d.operator)].filter((b) => b !== "");
      if (c.policy.flags.coderabbit.enabled && c.policy.flags.coderabbit.include_in_rework) {
        const cr = await crFindings({ pr: c.forge!, checks: await c.d.forge("checks") }, pr, c.s);
        if ("findings" in cr) blocks.push(...crBlocks(cr.findings));
      }
      return { [RUN_INPUTS.findings]: findingsMd(blocks, `${rework.by} asked for a rework (hapi:rework) and left no comment since the last round: read the PR and its review threads.`) };
    },
  };
  const b = await begin(c, step);
  if ("run" in b) {
    const counted = c.s.runs.includes(b.run.runId) && !c.lost.has(b.run.runId);
    const lastHumanAt = latest([c.s.lastHumanAt, rework.at]) ?? rework.at;
    return started(c, "fix", step, b, {
      reason: `${rework.by} asked for a rework (hapi:rework on #${pr.number})`,
      extra: { reworkRounds: counted ? c.s.reworkRounds : c.s.reworkRounds + 1, autoRounds: 0, lastHumanAt, prHead: pr.headSha },
    });
  }
  return hold(c, b.refused);
}

// --- re-rendering the PR ----------------------------------------------------------------------------------------

/** `ci / gates` on `head`, from GitHub Actions: pending until every such check run completed; passed only when each succeeded. */
async function ciOf(c: Ctx, head: string): Promise<"pending" | "passed" | "failed"> {
  const runs = (await (await c.d.forge("checks")).checkRuns(head)).filter((r) => r.name === CONTRACT_CHECK && r.appId === ACTIONS_APP_ID && r.headSha === head);
  if (runs.length === 0 || runs.some((r) => r.status !== "completed")) return "pending";
  return runs.every((r) => r.conclusion === "success") ? "passed" : "failed";
}

/** The `ci / gates` cell the body shows for `head`, or undefined. */
function ciShown(body: string, head: string): string | undefined {
  return new RegExp(`\\| \`${CONTRACT_CHECK.replace("/", "\\/")}\` \\| ${h7(head)} \\| GitHub Actions, on the pushed head \\| (pending|passed|failed) \\|`).exec(body)?.[1];
}

/** The pass's worker or fix run whose head the PR shows: the one before the first verify or review of `head`. */
function runOfHead(c: Ctx, head: string): RunRecord | undefined {
  const checked = c.pass.find((r) => (kindOf(r) === "verify" || kindOf(r) === "review") && r.sha === head);
  if (checked !== undefined) return c.pass.slice(0, c.pass.indexOf(checked)).filter(isSource).at(-1);
  // Neither phase ran: the newest source, whose gates `rerender` checks against the head.
  return !c.phases.verify && !c.phases.review ? c.pass.filter((r) => isSource(r) && r.status === "succeeded").at(-1) : undefined;
}

/** Re-render the PR's body for its head now, unless a run of the pass is live (the gates write the scratch). */
async function renderPr(c: Ctx, ci: "pending" | "passed" | "failed" | undefined): Promise<void> {
  if (c.pr === undefined || c.forge === undefined || c.s.prHead === undefined) return;
  if (c.pass.some((r) => r.status === "live")) return;
  const run = runOfHead(c, c.s.prHead);
  if (run === undefined) return;
  await rerender(c.d, c.s, await harvestInput(c, run), { forge: c.forge, pr: c.pr, ci: ci ?? (await ciOf(c, c.s.prHead)), phase: c.s.phase });
}

/** In `pr-review` and `waiting`: re-render when `ci / gates` on the head changed, or a reason isn't on the PR yet. */
async function converge(c: Ctx): Promise<void> {
  const pr = c.pr!;
  const head = c.s.prHead;
  if (head === undefined || !pr.body.includes(BEGIN) || c.pass.some((r) => r.status === "live")) return;
  const ci = await ciOf(c, head);
  const missing = c.s.reasons.some((r) => !pr.body.includes(`- ${plain(r)}`));
  if (ciShown(pr.body, head) === ci && !missing) return;
  await renderPr(c, ci);
}
