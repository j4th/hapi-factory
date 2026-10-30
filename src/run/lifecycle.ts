/**
 * `hapi run start`, `stop` and `supervise` (design §3.1; §6a items 11, 12, 14
 * and 16), on the host, as the hapi user: as anyone else each re-execs
 * `mise run hapi -- run <sub> ...` as hapi (`reexecScript("hapi")`, as `up`
 * does), and HAPI_ALLOW_CURRENT_USER=1 is the same dev-only downgrade. The
 * re-exec runs in hapi's checkout, so `start` first makes `--repo` and
 * `--work-order` absolute from the caller's working dir (a path that isn't
 * there is a usage error).
 *
 * `start`, in order, refusing at the first failure:
 * 1. reap (`reapRuns`), then validate: the work order (`validateWorkOrder`;
 *    `egress_extra` is refused until a per-run proxy exists, H-088), the
 *    budget (`--budget-usd` only lowers it), the archon zone's env file
 *    (missing: run `mise run up`), the source repo and its HEAD (host git with
 *    no config), and the run container's whole argv (`runArgs`);
 * 2. under the launcher's lock: admission (the key, one live run per repo,
 *    `runs.max_live`; ./records.ts), then the run's dir with record.json and
 *    run.json;
 * 3. the run's own network, `--internal`, checked with `networkProblem`;
 * 4. `egress-archon` joined to it under the alias the proxy variables name
 *    (spike 07 finding 13);
 * 5. the two volumes, chowned to 1001 by a one-shot helper with CAP_CHOWN
 *    alone: a fresh volume's root is root's (spike 07 finding 12). Like every
 *    helper, it runs under the host's `timeout` (./copyout.ts `bounded`);
 * 6. the run container, its secrets passed by name, their values in the docker
 *    CLI's env only;
 * 7. a detached `hapi run supervise <id>`, awaited until its process has
 *    started: one that can't start is a failed step.
 * A failure in 3-7 removes what start made (egress disconnected before its
 * network goes) and the run's dir, then releases the lock. start prints the
 * run id and returns at once. A supervisor that starts and then dies is left
 * to the reap (below): nothing in start can see it.
 *
 * `supervise` waits for the container (`docker wait` under a host `timeout`
 * to the run's deadline, the work order's budget.minutes), stops it at the
 * deadline, then finalizes. `stop` stops one run. Either records why it is
 * stopping before it stops the container (`stopRequested`), so whichever
 * process finalizes records it. The stop grace is `STOP_GRACE_S`.
 *
 * `finalizeRun`, under the run's own lock and once only: stop the container if
 * it still runs (no volume a live worker can write is ever read), copy the
 * outputs out (./copyout.ts), check the bundle (exactly one head, `HEAD`,
 * read by host git with hardened flags in an empty dir: spike 07 finding 19),
 * read Archon's status from result.json (a paused run exits 0, so the exit code
 * is never the status: spike 07 finding 5), check that the guard ran in every
 * Pi attempt (design §6a item 7; spike 08 finding 10), remove every object of
 * the run, and write the record. A run whose container is gone was removed
 * around hapi (`mise run down`, a cleanup), which is removing its volumes too,
 * so nothing is copied and it fails: a copy-out helper would race that removal
 * (`volume is in use`).
 *
 * `reapRuns` runs first in `start` and `stop` (`supervise` is spawned by a
 * start that has just reaped): it finalizes a live record whose container has
 * exited, and stops and finalizes one past its deadline, so a supervisor that
 * died leaves nothing behind for long. Then retention, fail-closed: it deletes
 * a finished run's dir only once record.json's `harvestedAt` (Plan 03's
 * harvester sets it) is more than `runs.retention_days` ago, so an output no
 * harvester has read is never lost.
 *
 * Everything that comes out of a run is untrusted data: stored and checked,
 * never executed, never read by git with its own config, never printed raw.
 */
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RunFile } from "../generate/archon";
import { ENV_DIR, parseEnvFile, runtimeDir } from "../secrets/files";
import { composeServices } from "../stack/compose";
import { currentUserOverride, definedEnv, HAPI_USER, networkProblem, reexec, removeRuns, runCommand } from "../stack/up";
import { loadWorkOrder } from "../workorder/validate";
import { parseRunId, parseStart, runDeps, START_USAGE, STOP_USAGE, SUPERVISE_USAGE } from "./cli";
import { bounded, copyOut, HELPER_HOST_TIMEOUT_S, timedOut } from "./copyout";
import {
  capacityProblem,
  containerExists,
  createRun,
  isLive,
  keyProblem,
  listRecords,
  liveRuns,
  lockHeld,
  newRunId,
  readRecord,
  recordDir,
  removeRunDir,
  runKey,
  type RunRecord,
  type RunStatus,
  withRunLock,
  withStartLock,
  writeRecord,
} from "./records";
import { APP_USER, PROXY_ALIAS, runArgs, type RunDeps, type RunInputs, runLabels, runName } from "./spec";

/**
 * `docker stop -t`: seconds between TERM and KILL. Not Docker's 10: after the workflow ends, run.sh starts the
 * Archon CLI (bun) up to three more times for its read-back (result.json, the transcript), and a KILL inside
 * that leaves a stopped run without its outputs. Spike 07 saw a bash-only run's post-run steps take under a second.
 */
export const STOP_GRACE_S = 30;
/** How long `finalizeRun` waits for another process finalizing the same run: the listing and four reads at their host bound and KILL, and the rest. */
const FINALIZE_WAIT_S = 900;

const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.slice(0, 300) || "(no error output)";
/** Printable ASCII only, and short: for a name a run made (a node path, an attempt id, a ref). */
const safe = (s: string) => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 100);

/**
 * Run `body` with the whole `RunDeps`, as hapi: anyone else re-execs `hapi run <sub> <args>` as hapi first.
 * A failure prints `hapi run <sub>: <message>` and returns 1.
 */
export async function asHapi(sub: string, args: string[], partial: Partial<RunDeps>, body: (d: RunDeps) => Promise<number>): Promise<number> {
  const env = partial.env ?? process.env;
  const run = partial.run ?? runCommand;
  const who = currentUserOverride(env, partial.user);
  if (!who.isHapi && !who.override) return reexec("hapi", ["run", sub, ...args], run, env, who.user, `run ${sub}`);
  try {
    if (who.override) {
      console.error(
        `hapi run ${sub}: warning: HAPI_ALLOW_CURRENT_USER=1: running as ${who.user}, not ${HAPI_USER}: a dev-only downgrade (your own Docker, not hapi's rootless one); the run container is labelled org.hapi.dev-override=1`,
      );
    }
    return await body(await runDeps({ ...partial, env, run, user: who.user }));
  } catch (e) {
    console.error(`hapi run ${sub}: ${(e as Error).message}`);
    return 1;
  }
}

/** The archon zone's secrets, from `$XDG_RUNTIME_DIR/hapi/env/archon.env` (`hapi secrets resolve` writes it). Fails closed when it is missing. */
export async function archonSecrets(env: RunDeps["env"]): Promise<Record<string, string>> {
  const file = join(runtimeDir(env), ENV_DIR, "archon.env");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${file} is missing: run \`mise run up\` first`);
    throw new Error(`cannot read ${file} (${code ?? "error"}): run hapi run as the user that ran \`mise run up\``);
  }
  try {
    return parseEnvFile(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/** The git dir to bind as the source, its real path: `<repo>/.git`, or `repo` itself when it is bare. */
async function sourceGitDir(repo: string): Promise<string> {
  const abs = resolve(repo);
  const kind = async (p: string) => {
    try {
      const s = await stat(p);
      return s.isDirectory() ? "dir" : s.isFile() ? "file" : "other";
    } catch {
      return "none";
    }
  };
  let dir: string | undefined;
  if ((await kind(join(abs, ".git"))) === "dir") dir = join(abs, ".git");
  else if ((await kind(join(abs, "HEAD"))) === "file" && (await kind(join(abs, "objects"))) === "dir" && (await kind(join(abs, "refs"))) === "dir") dir = abs;
  if (dir === undefined) throw new Error(`${abs} is not a git repository with a .git dir, nor a bare one: name a checkout (not a linked worktree) or a bare repo`);
  return realpath(dir);
}

/**
 * Host git with an empty environment but PATH (and `o.env`), no system or global config, no hooks and no
 * fsmonitor: the start of every git command the launcher runs. `o.git` goes before the `-c` options.
 */
function hardenedGit(d: Pick<RunDeps, "env">, o: { env?: string[]; git?: string[] } = {}): { cmd: string[]; env: Record<string, string> } {
  const PATH = d.env.PATH ?? "/usr/bin:/bin";
  return {
    cmd: ["env", "-i", `PATH=${PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", ...(o.env ?? []), "git", ...(o.git ?? []), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    env: { PATH },
  };
}

/** The commit the source's HEAD names. The repo is the operator's (Plan 03: the mirror), read with no config of its own. */
async function headOf(gitDir: string, d: RunDeps): Promise<string> {
  const git = hardenedGit(d);
  const r = await d.run([...git.cmd, "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir, "rev-parse", "--verify", "HEAD^{commit}"], { env: git.env, inherit: false });
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new Error(`cannot read the commit HEAD names in ${gitDir} (git rev-parse exited ${r.code}): the source must have a commit checked out`);
  }
  return sha;
}

/**
 * Steps 3-7 of start (see the module comment), each of which throws on failure. Only the run container's
 * docker CLI gets the secrets, in its env; an error from it is scrubbed of their values.
 */
async function createRunObjects(d: RunDeps, rec: RunRecord, argv: string[], secrets: Record<string, string>): Promise<void> {
  const labels = runLabels(d.project, rec.runId);
  const must = async (what: string, cmd: string[], env = definedEnv(d.env)) => {
    const r = await d.run(cmd, { env, inherit: false });
    if (r.code !== 0) {
      let why = firstLine(r.stderr);
      for (const v of Object.values(secrets)) if (v.length >= 4) why = why.replaceAll(v, "[a secret value]");
      // `cmd` starts with `timeout` only when it is a helper `bounded` put under the host's bound.
      const how = cmd[0] === "timeout" && timedOut(r.code) ? `timed out after ${HELPER_HOST_TIMEOUT_S} s` : "failed";
      throw new Error(`${what} ${how} (exit ${r.code}): ${why}`);
    }
    return r;
  };
  await must(`docker network create ${rec.network}`, ["docker", "network", "create", "--internal", ...labels, rec.network]);
  const inspect = await must(`docker network inspect ${rec.network}`, ["docker", "network", "inspect", rec.network]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    parsed = undefined;
  }
  const problem = networkProblem(Array.isArray(parsed) ? parsed[0] : undefined);
  if (problem !== undefined) throw new Error(problem);
  await must(`docker network connect ${rec.network} ${d.egress}`, ["docker", "network", "connect", "--alias", PROXY_ALIAS, rec.network, d.egress]);
  for (const v of [rec.volumes.work, rec.volumes.out]) await must(`docker volume create ${v}`, ["docker", "volume", "create", ...labels, v]);
  await must("the volume chown helper", bounded([
    "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", "0:0", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true",
    ...labels, "-v", `${rec.volumes.work}:/w`, "-v", `${rec.volumes.out}:/o`, "--entrypoint", "chown", d.image, APP_USER, "/w", "/o",
  ]));
  await must(`docker run ${rec.container}`, argv, { ...definedEnv(d.env), ...secrets });
  await d.spawnDetached(["hapi", "run", "supervise", rec.runId]);
}

/** Whether nothing is at `p` (ENOENT, or a file where a dir was named). A path that can't be looked at for another reason is left to the step that reads it. */
async function absent(p: string): Promise<boolean> {
  try {
    await stat(p);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

/** `hapi run start --repo <path> --work-order <file> [--public] [--budget-usd <n>] [--retry-of <run-id>]`: see the module comment. */
export async function runStart(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const parsed = parseStart(args);
  if (parsed === undefined) {
    console.error(START_USAGE);
    return 2;
  }
  // The re-exec runs in hapi's checkout (`reexecScript`), so both paths are made absolute here, from the caller's
  // working dir, and one that isn't there is a usage error before anything runs.
  const opts = { ...parsed, repo: resolve(parsed.repo), workOrder: resolve(parsed.workOrder) };
  for (const [flag, p] of [["--repo", opts.repo], ["--work-order", opts.workOrder]] as const) {
    if (await absent(p)) {
      console.error(`hapi run start: ${flag} ${p} does not exist: name a path relative to where you run hapi, or an absolute one`);
      console.error(START_USAGE);
      return 2;
    }
  }
  // parseStart has checked that each value follows its flag and that none starts with "-", so only the two values match.
  const absolute = args.map((a, i) => (args[i - 1] === "--repo" ? opts.repo : args[i - 1] === "--work-order" ? opts.workOrder : a));
  return asHapi("start", absolute, deps, async (d) => {
    await reapRuns(d);
    const order = loadWorkOrder(opts.workOrder);
    if (order.egress_extra.length > 0) throw new Error("egress_extra isn't supported yet (design §3.1, H-088); remove it or wait for the per-run proxy");
    if (opts.budgetUsd !== undefined && opts.budgetUsd > order.budget.usd) {
      console.error(`hapi run start: --budget-usd ${opts.budgetUsd} is above the work order's budget.usd (${order.budget.usd}): it may only lower it`);
      console.error(START_USAGE);
      return 2;
    }
    const secrets = await archonSecrets(d.env);
    const repo = await sourceGitDir(opts.repo);
    const sha = await headOf(repo, d);
    const service = (await composeServices(d.root)).archon;
    if (service === undefined) throw new Error("stack/compose.yaml has no archon service: the run container is made from it");

    const runId = newRunId();
    const inputs: RunInputs = { runId, repo, sha, workOrder: order, public: opts.public, budgetUsd: opts.budgetUsd ?? order.budget.usd, packDir: d.packDir };
    const argv = runArgs(service, inputs, d, Object.keys(secrets));
    const started = d.now();
    const name = runName(d.project, runId);
    const rec: RunRecord = {
      runId, key: runKey(order.id, sha), project: d.project, repo, sha, workOrder: order.id, workflow: order.workflow,
      container: name, network: name, volumes: { work: `${name}-work`, out: `${name}-out` },
      startedAt: started.toISOString(), deadline: new Date(started.getTime() + order.budget.minutes * 60_000).toISOString(), status: "live",
      ...(opts.retryOf === undefined ? {} : { retryOf: opts.retryOf }),
    };
    const runFile: RunFile = {
      run_id: runId, work_order: order.id, traceparent: order.trace.traceparent, budget_usd: inputs.budgetUsd, public: opts.public, workflow: order.workflow, started_at: rec.startedAt,
    };

    await withStartLock(d, async () => {
      const records = await listRecords(d.stateDir);
      const refused =
        keyProblem(records, { key: rec.key, workOrder: order.id, sha, ...(opts.retryOf === undefined ? {} : { retryOf: opts.retryOf }) }) ??
        capacityProblem(await liveRuns(d), records, repo, d);
      if (refused !== undefined) throw new Error(refused);
      await createRun(d.stateDir, rec, runFile);
      try {
        await createRunObjects(d, rec, argv, secrets);
      } catch (e) {
        let cleanup = "What start had created was removed.";
        try {
          await removeRuns(d.project, d.run, d.env, { runId, egress: d.egress });
        } catch (x) {
          cleanup = `Removing what start had created failed too (${(x as Error).message}): \`mise run down\` removes it.`;
        }
        await removeRunDir(d.stateDir, runId);
        throw new Error(`${(e as Error).message}. ${cleanup}`);
      }
    });
    console.log(runId);
    return 0;
  });
}

/**
 * Record why run `rec` is being stopped (unless an earlier stop did), then stop its container with
 * `STOP_GRACE_S`. A stop that fails is an error only if the container still runs.
 */
async function requestStop(d: RunDeps, rec: RunRecord, why: NonNullable<RunRecord["stopRequested"]>): Promise<void> {
  await withRunLock(d, rec.runId, async () => {
    const disk = await readRecord(d.stateDir, rec.runId);
    if (disk?.status === "live" && disk.stopRequested === undefined) await writeRecord(d.stateDir, { ...disk, stopRequested: why });
  });
  await stopContainer(d, rec);
}

async function stopContainer(d: RunDeps, rec: RunRecord): Promise<void> {
  const r = await d.run(["docker", "stop", "-t", String(STOP_GRACE_S), rec.container], { env: definedEnv(d.env), inherit: false });
  if (r.code !== 0 && (await isLive(d, rec.runId))) throw new Error(`docker stop ${rec.container} failed (exit ${r.code}): ${firstLine(r.stderr)}`);
}

/**
 * What is wrong with `file`, a run's bundle, or undefined: it must list exactly one head, `HEAD` (spike 07
 * finding 19). Read by host git with no system or global config, hooks or fsmonitor, from an empty temp dir
 * that repo discovery can't leave (GIT_CEILING_DIRECTORIES), so nothing the run wrote configures it. The
 * bundle is only listed, never verified or fetched here: that needs the base commit (Plan 03's harvester).
 */
export async function bundleProblem(file: string, d: Pick<RunDeps, "run" | "env">): Promise<string | undefined> {
  const empty = await mkdtemp(join(tmpdir(), "hapi-bundle-"));
  try {
    const git = hardenedGit(d, { env: [`GIT_CEILING_DIRECTORIES=${dirname(empty)}`], git: ["-C", empty] });
    const r = await d.run([...git.cmd, "bundle", "list-heads", file], { env: git.env, inherit: false });
    if (r.code !== 0) return `run.bundle is not a bundle git can read (git bundle list-heads exited ${r.code}): kept, never fetched`;
    const refs = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "").map((l) => l.slice(l.indexOf(" ") + 1));
    const head = refs.indexOf("HEAD");
    const extra = head === -1 ? refs : refs.filter((_, i) => i !== head);
    if (head !== -1 && extra.length === 0) return undefined;
    return `unexpected refs in run.bundle: ${extra.length === 0 ? "(none)" : extra.slice(0, 10).map(safe).join(", ")}`;
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

/**
 * The guard-ran check (design §6a item 7; spike 08 finding 10). A guard that fails to load fails open, so
 * every Pi attempt the transcript shows (a `node_start` row with `execution.binding.provider` "pi") must have
 * a `session_start` record in the decision log with the same run, node and attempt
 * (`execution.runId`, `.path`, `.attempt.id`). Returns a problem per attempt without one; a missing
 * transcript, or a line of it that isn't JSON, fails the check rather than passing it.
 */
export function guardProblems(transcript: string | undefined, decisions: string | undefined): string[] {
  if (transcript === undefined) return ["no transcript.jsonl was copied out, so the guard-ran check could not be made"];
  const started = new Set<string>();
  for (const line of (decisions ?? "").split("\n")) {
    let rec: { event?: unknown; run?: unknown; node?: unknown; attempt?: unknown } | null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a line the guard didn't write can only take a record away, never add one
    }
    if (rec?.event === "session_start" && typeof rec.run === "string" && typeof rec.node === "string" && typeof rec.attempt === "string") {
      started.add(JSON.stringify([rec.run, rec.node, rec.attempt]));
    }
  }
  const problems: string[] = [];
  for (const [i, line] of transcript.split("\n").entries()) {
    if (line.trim() === "") continue;
    let row: { type?: unknown; execution?: { runId?: unknown; path?: unknown; attempt?: { id?: unknown }; binding?: { provider?: unknown } } } | null;
    try {
      row = JSON.parse(line);
    } catch {
      return [`transcript.jsonl line ${i + 1} is not JSON, so the guard-ran check can't be made`];
    }
    if (row?.type !== "node_start" || row.execution?.binding?.provider !== "pi") continue;
    const { runId, path } = row.execution;
    const attempt = row.execution.attempt?.id;
    if (typeof runId !== "string" || typeof path !== "string" || typeof attempt !== "string") {
      problems.push(`a Pi node_start row in transcript.jsonl (line ${i + 1}) has no run, node or attempt id`);
    } else if (!started.has(JSON.stringify([runId, path, attempt]))) problems.push(`guard did not run in node ${safe(path)} attempt ${safe(attempt)}`);
  }
  return problems.length <= 5 ? problems : [...problems.slice(0, 5), `and ${problems.length - 5} more Pi attempts without a guard record`];
}

/** Archon's status of the run, from out/result.json's `run.status` (`workflow get`), or why it can't be read. */
async function archonStatus(out: string, copied: string[]): Promise<{ status: string } | { problem: string }> {
  if (!copied.includes("result.json")) return { problem: "no result.json was copied out" };
  let doc: { run?: { status?: unknown } } | null = null;
  try {
    doc = JSON.parse(await readFile(join(out, "result.json"), "utf8"));
  } catch {
    doc = null;
  }
  const status = doc?.run?.status;
  return typeof status === "string" ? { status } : { problem: "out/result.json does not hold a run's status" };
}

/** Why a run Archon didn't complete failed. A paused run fails: v1 has no approval nodes, and nothing can answer one (design §3.1). */
function statusReason(status: string): string {
  if (status === "paused") return "the run paused (Archon status paused): v1 answers no approval, so a paused run fails (design §3.1)";
  if (status === "failed") return "the workflow failed (Archon status failed)";
  return /^[a-z_]{1,32}$/.test(status) ? `Archon reports the run ${status}, not completed` : "Archon reports a status that is none of its own";
}

/** finalizeRun's work, holding the run's lock. */
async function finalizeLocked(rec: RunRecord, d: RunDeps): Promise<RunRecord> {
  const disk = (await readRecord(d.stateDir, rec.runId)) ?? rec;
  if (disk.status !== "live") return disk;
  // No volume a live worker can still write is ever read.
  if (await isLive(d, disk.runId)) await stopContainer(d, disk);
  const out = join(recordDir(d.stateDir, disk.runId), "out");
  const reasons: string[] = [];
  if (disk.stopRequested === "timed-out") reasons.push(`the run passed its deadline (${disk.deadline}, from the work order's budget.minutes) and was stopped`);
  if (disk.stopRequested === "stopped") reasons.push("stopped by `hapi run stop`");

  const problems: string[] = [];
  let archon: Awaited<ReturnType<typeof archonStatus>> = { problem: "nothing was copied out" };
  if (!(await containerExists(d, disk.runId))) {
    // Removed around hapi (`mise run down`, a cleanup: `docker wait` returns as `rm -f` kills it), and its volumes
    // are going too: a helper would race that removal for them, and its `-v` of one just removed would make an
    // unlabelled volume that nothing removes.
    problems.push("the run's container was removed before the run was finalized (`mise run down`, or a cleanup): nothing was copied out");
  } else {
    const copy = await copyOut(disk.volumes.out, out, d.runs.output_limits_mb, d);
    problems.push(...copy.problems);
    if (copy.copied.includes("run.bundle")) {
      const p = await bundleProblem(join(out, "run.bundle"), d);
      if (p !== undefined) problems.push(p);
    }
    archon = await archonStatus(out, copy.copied);
    if ("problem" in archon) problems.push(archon.problem);
    const read = async (name: string) => (copy.copied.includes(name) ? readFile(join(out, name), "utf8") : undefined);
    problems.push(...guardProblems(await read("transcript.jsonl"), await read("decisions.jsonl")));
  }

  let status: RunStatus;
  if (disk.stopRequested !== undefined) status = disk.stopRequested;
  else if (problems.length > 0) status = "failed";
  else if ("status" in archon && archon.status === "completed") status = "succeeded";
  else {
    status = "failed";
    if ("status" in archon) problems.push(statusReason(archon.status));
  }
  reasons.push(...problems);

  try {
    await removeRuns(d.project, d.run, d.env, { runId: disk.runId, egress: d.egress });
  } catch (e) {
    reasons.push(`cleanup left run objects behind: ${(e as Error).message}; \`mise run down\` removes them`);
  }
  const done: RunRecord = { ...disk, status, ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}) };
  await writeRecord(d.stateDir, done);
  return done;
}

/**
 * Finish run `rec`: see the module comment. Idempotent: a run that has ended is returned as recorded. If
 * another process is finalizing it, waits for that one (up to FINALIZE_WAIT_S) and returns what it recorded.
 */
export async function finalizeRun(rec: RunRecord, deps: RunDeps): Promise<RunRecord> {
  for (let waited = 0; ; waited++) {
    try {
      return await withRunLock(deps, rec.runId, () => finalizeLocked(rec, deps));
    } catch (e) {
      if (!lockHeld(e) || waited >= FINALIZE_WAIT_S) throw e;
      await Bun.sleep(1000);
    }
  }
}

/**
 * Repair what a dead supervisor left, under the launcher's lock: every live record whose container has
 * exited is finalized, and every one past its deadline is stopped (timed-out) and finalized. A run another
 * process is finalizing is left to it. Then retention (see the module comment): a finished run harvested
 * more than `runs.retention_days` ago loses its dir. Throws after trying every run, naming those it couldn't
 * finish.
 */
export async function reapRuns(deps: RunDeps): Promise<void> {
  await withStartLock(deps, async () => {
    const failures: string[] = [];
    for (const rec of (await listRecords(deps.stateDir)).filter((r) => r.status === "live")) {
      try {
        if (await isLive(deps, rec.runId)) {
          if (deps.now().getTime() < Date.parse(rec.deadline)) continue;
          await requestStop(deps, rec, "timed-out");
        }
        const done = await withRunLock(deps, rec.runId, () => finalizeLocked(rec, deps));
        console.error(`hapi run: reaped run ${rec.runId}: ${done.status}`);
      } catch (e) {
        if (!lockHeld(e)) failures.push(`run ${rec.runId}: ${(e as Error).message}`);
      }
    }
    const keep = deps.runs.retention_days * 86_400_000;
    for (const rec of await listRecords(deps.stateDir)) {
      // Only a time hapi's harvester wrote: anything else, or none, keeps the run.
      const harvested = typeof rec.harvestedAt === "string" ? Date.parse(rec.harvestedAt) : Number.NaN;
      if (rec.status === "live" || !Number.isFinite(harvested) || deps.now().getTime() - harvested <= keep) continue;
      try {
        await removeRunDir(deps.stateDir, rec.runId);
        console.error(`hapi run: removed run ${rec.runId}: harvested ${rec.harvestedAt}, more than runs.retention_days (${deps.runs.retention_days}) ago`);
      } catch (e) {
        failures.push(`run ${rec.runId}: removing its dir failed: ${(e as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(`reaping left runs unfinished: ${failures.join("; ")}`);
  });
}

/** How a run ended, as `supervise`, `stop` and `watch` print it. */
export const ended = (rec: RunRecord) => `run ${rec.runId}: ${rec.status}${rec.reason === undefined ? "" : `: ${rec.reason}`}`;

/** `hapi run supervise <run-id>` (internal; start spawns it): wait, stop at the deadline, finalize. */
export async function runSupervise(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const id = parseRunId(args);
  if (id === undefined) {
    console.error(SUPERVISE_USAGE);
    return 2;
  }
  return asHapi("supervise", args, deps, async (d) => {
    // No reap: the start that spawns this has just reaped, and still holds the launcher's lock.
    const rec = await readRecord(d.stateDir, id);
    if (rec === undefined) throw new Error(`there is no run ${id} in ${d.stateDir}`);
    if (rec.status !== "live") return 0;
    const left = Math.ceil((Date.parse(rec.deadline) - d.now().getTime()) / 1000);
    let overdue = left <= 0;
    if (!overdue) {
      // The host's timeout ends `docker wait` (exit 124) at the deadline; the container's own exit code is never the status.
      const w = await d.run(["timeout", String(left), "docker", "wait", rec.container], { env: definedEnv(d.env), inherit: false });
      overdue = w.code === 124;
      if (!overdue && w.code !== 0 && (await isLive(d, id))) {
        throw new Error(`cannot wait for ${rec.container} (docker wait exited ${w.code}): the next \`hapi run\` command reaps it at its deadline`);
      }
    }
    if (overdue) await requestStop(d, rec, "timed-out");
    console.log(ended(await finalizeRun(rec, d)));
    return 0;
  });
}

/** `hapi run stop <run-id>`: stop one run, and finalize it as stopped. */
export async function runStop(args: string[], deps: Partial<RunDeps> = {}): Promise<number> {
  const id = parseRunId(args);
  if (id === undefined) {
    console.error(STOP_USAGE);
    return 2;
  }
  return asHapi("stop", args, deps, async (d) => {
    try {
      await reapRuns(d);
    } catch (e) {
      console.error(`hapi run stop: warning: ${(e as Error).message}`);
    }
    const rec = await readRecord(d.stateDir, id);
    if (rec === undefined) throw new Error(`there is no run ${id} in ${d.stateDir}`);
    if (rec.status !== "live") {
      console.log(`run ${id} has already ended: ${rec.status}`);
      return 0;
    }
    await requestStop(d, rec, "stopped");
    console.log(ended(await finalizeRun(rec, d)));
    return 0;
  });
}
