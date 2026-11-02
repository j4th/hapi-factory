/**
 * hapi-guard: the Pi extension that guards every worker run (spec §9.3; design
 * §3.3 and §6a; register H-087, H-089, H-181(d), H-184). `hapi policy build`
 * bundles this entry into build/pi/extensions/hapi-guard.js, one self-contained
 * file that imports nothing but `node:*`, and the run container binds it
 * read-only into Pi's agent dir. Each Pi node attempt is a fresh process that
 * imports it and runs the factory once (spike 08, finding 2).
 *
 * The factory never throws: Pi records a load error and Archon never reads it,
 * so a throw would leave the node unguarded (finding 8). Bad settings register
 * only a session_start that throws `hapi-guard: <problem>; the node fails
 * closed`, and Task 7 fails any run in which a Pi attempt left no session_start
 * record. The guard registers no tools and no flags (pi-api.ts). Pi also sends
 * the model a `__pi_deferred_placeholder__` tool beside the node's
 * `allowed_tools` (finding 12); like any tool the guard doesn't know, a call to
 * it is blocked.
 *
 * The hooks, in the order Pi fires them:
 *
 * - `session_start` (config.ts, model.ts, context.ts, budget.ts): the resolved
 *   model against its pin, Pi's agent dir against `agent_dir_allowed` (and
 *   extensions/ holding only this bundle), the worktree without `.pi/`,
 *   `.agents/` or `.archon/` (H-181(d)), no context file Pi would load from
 *   outside the worktree, the ledger read, then the first decision-log record;
 * - `before_agent_start` (context.ts): the repo's AGENTS.md (or CLAUDE.md) out
 *   of the system prompt and after the work order, as the repo's conventions
 *   (H-228(a));
 * - `tool_call`: rule 1 (paths.ts) and rule 6 (secrets.ts) for write and edit;
 *   rule 6, rule 7 (shell.ts) and the bash gate (gates.ts) for bash, then rule
 *   8's `unset` prefix. A throw here only becomes an error result, so every
 *   refusal is `{ block: true, reason }` instead (design §6a item 8);
 * - `tool_result`: rule 6's redaction, then the result screen;
 * - `before_provider_headers`: rule 3's hard stop before every send, retries and
 *   compaction summaries included (finding 5);
 * - `before_provider_request`: rule 4's clamp and H-184's payload check;
 * - `message_end` and `turn_end`: the spend update, the ledger write, the stop;
 *   at `turn_end`, the spend record (the run's total and its turns, H-229), the
 *   result record when the turn ends the session (result.ts, H-228(b)), and the
 *   run's turn budget, `turns` in the run file.
 *
 * Every hook but tool_call fails the node by throwing (brief §2.9). tool_result
 * never throws, since a throw there would drop its redaction: it holds the error,
 * and the next before_provider_headers or turn_end throws it. While an error is
 * held, a screened tool's result is wrapped without asking the screen.
 *
 * A hard stop (the budget or the turns) is final (H-230): Pi can still fire a
 * hook after it, with a context that is stale, so the stop is held, every later
 * hook throws it again before it reads the context, and a tool call is blocked
 * under the stop's own rule.
 *
 * The totals the guard writes (`cost_usd` of a `spend` or `run-budget` record,
 * and `turns`) never fall within a run: Task 7's spendOfRun reads a falling
 * ledger as an unknown spend, counted at the run's whole budget. The ledger
 * keeps what it counted (budget.ts), each process starts from the decision log's
 * highest total so far (a ledger file it can't read counts as 0), and the guard
 * writes the running maximum.
 */
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunFile } from "../generate/archon";
import { Ledger, sessionSpendUsd, usageUsd, usd } from "./budget";
import { type GuardSettings, type Identity, loadIdentity, loadRunFile, loadSettings, Problem } from "./config";
import { contextAboveProblem, type Conventions, conventionsBlock, readConventions, takeConventions } from "./context";
import { ask, bashGate, classifierRecord, type DecideHooks, decideOptions, resultScreen, skipsGate, wrapText } from "./gates";
import { DecisionLog, type Entry } from "./log";
import { bindsThinking, BINDING_BETA, clamp, isPayload, modelProblem, pinOf } from "./model";
import { checkWrite, protectedTable, realDir, type Roots } from "./paths";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent, ToolResultEventResult } from "./pi-api";
import { endsSession, sessionResult } from "./result";
import { findSecret, PATTERN_NAMES, redact, redactDeep, type Secrets, takeSecrets, withUnset } from "./secrets";
import { checkShell } from "./shell";

export interface GuardDeps {
  /** The env the guard reads and scrubs (rule 8). The default export passes `process.env`. */
  env: Record<string, string | undefined>;
  /** Where a write outside the worktree may go. Default "/tmp"; tests use their own. */
  tmpRoot?: string;
  /** `~` in a tool path. Default `os.homedir()`, as Pi's own resolution uses. */
  home?: string;
  /** decide()'s test hooks. */
  decide?: DecideHooks;
}

/** Pi's built-in tools, the only ones Archon gives a node (options-translator.ts:118-136). */
const KNOWN_TOOLS = new Set(["bash", "read", "write", "edit", "grep", "find", "ls"]);
/** What the launcher strips from the clone before a run (design §6a item 1). */
const STRIPPED = [".pi", ".agents", ".archon"];
/** The one file extensions/ may hold. */
const BUNDLE = "hapi-guard.js";

/** A name as it may appear in a message: plain if printable ASCII, JSON-escaped otherwise. */
const shown = (name: string): string => (/^[\x20-\x7e]+$/.test(name) ? name : JSON.stringify(name));
/** A cost in a record: rounded off float noise. */
const round = (n: number): number => Math.round(n * 1e9) / 1e9;

interface Ready {
  settings: GuardSettings;
  run: RunFile & { turns: number };
  id: Identity;
  secrets: Secrets;
  agentDir: string;
}

/** Read everything the guard needs, then take the secrets out of the env. Throws a Problem. */
function prepare(env: GuardDeps["env"]): Ready {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) throw new Problem("PI_CODING_AGENT_DIR is not set");
  const settings = loadSettings(join(agentDir, "hapi-guard.json"));
  const run = loadRunFile(settings.paths.runFile);
  const id = loadIdentity(env);
  return { settings, run, id, agentDir, secrets: takeSecrets(env, settings.secret_env) };
}

function agentDirProblem(dir: string, allowed: string[]): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return "Pi's agent dir can't be read";
  }
  const outside = names.find((n) => !allowed.includes(n));
  if (outside !== undefined) return `Pi's agent dir holds ${shown(outside)}, which isn't one of hapi's files`;
  let extensions: string[] = [];
  try {
    extensions = readdirSync(join(dir, "extensions")).sort();
  } catch {
    // no extensions dir
  }
  const extra = extensions.find((n) => n !== BUNDLE);
  return extra === undefined ? undefined : `Pi's agent dir holds extensions/${shown(extra)}, which isn't one of hapi's files`;
}

function worktreeProblem(cwd: string): string | undefined {
  for (const name of STRIPPED) {
    try {
      lstatSync(join(cwd, name));
      return `the worktree holds ${name}/, which the launcher strips before a run (H-181(d))`;
    } catch {
      // absent, as it should be
    }
  }
  return undefined;
}

/** A refusal of one tool call. `note` is appended inside the reason's "(rule ...)". */
interface Block {
  rule: string;
  reason: string;
  note?: string;
  path?: string;
  secret?: string;
}

function register(pi: ExtensionAPI, r: Ready, deps: GuardDeps): void {
  const { settings: s, run, id, secrets } = r;
  const tmpRoot = deps.tmpRoot ?? "/tmp";
  const home = deps.home ?? homedir();
  const scrubText = (text: string) => redact(text, secrets).text;
  const log = new DecisionLog(s.paths.out, id, run, (v) => redactDeep(v, secrets, new Set()));
  const limit = Math.min(run.budget_usd, s.budgets.run_usd);
  const options = decideOptions(s, run, secrets, deps.decide ?? {});
  const table = protectedTable(s.protected_paths);
  let ledger: Ledger | undefined;
  let flagged = false;
  let turnsFlagged = false;
  /** A hard stop, held: every later hook throws `error` before it reads its context, and a tool call is blocked under `rule` (H-230). */
  let stopped: { rule: "run-budget" | "run-turns"; reason: string; error: string } | undefined;
  const halted = () => {
    if (stopped) throw new Error(stopped.error);
  };
  /** The worktree's context file, as session_start read it. */
  let conventions: Conventions | undefined;
  /** What the decision log already counted beyond what this process could read at session_start (a ledger it can't read counts as 0). */
  const floor = { usd: 0, turns: 0 };
  /** The highest total and turns this process has reached: what it writes never falls. */
  const top = { usd: 0, turns: 0 };
  /**
   * The first error a tool_result caught. Pi keeps a result's original content
   * when tool_result throws, so a throw there (a full /tmp failing the ledger
   * save, say) would undo rule 6's redaction (final review A-1). The error is
   * held instead: every later tool call blocks, every screened result is wrapped
   * unasked, and the next send or turn end throws it, which fails the node.
   */
  let deferred: { error: unknown } | undefined;
  /** Run `f`, holding a throw in `deferred`. False if it threw. */
  const defer = (f: () => void): boolean => {
    try {
      f();
      return true;
    } catch (error) {
      deferred ??= { error };
      return false;
    }
  };
  const rethrow = () => {
    if (deferred) throw deferred.error;
  };
  /** Ledger files already logged as reset. */
  const reported = new Set<string>();
  /** Write a record, but never before session_start's: that one is always an attempt's first. */
  const record = (e: Entry) => {
    if (ledger) log.write(e);
  };
  const started = (): Ledger => {
    if (!ledger) throw new Error("hapi-guard: session_start has not run; the node fails");
    return ledger;
  };
  const roots = (ctx: ExtensionContext): Roots => ({
    named: resolve(ctx.cwd),
    work: realDir(ctx.cwd),
    tmp: realDir(tmpRoot),
    ledger: realDir(s.paths.ledgerDir),
    table,
  });

  /**
   * The run's spend and turns: the other attempts' ledgers, this session's entries plus `pending`, this process's
   * classifier calls and turns, and what the log counted that this process couldn't read; never below the last.
   */
  const spend = (ctx: ExtensionContext, pending = 0): { total: number; turns: number } => {
    const l = started();
    const mine = l.mine(sessionSpendUsd(ctx.sessionManager.getEntries()) + pending);
    const others = l.others();
    for (const name of others.bad) {
      if (reported.has(name)) continue;
      reported.add(name);
      const held = l.held(name);
      const counts = held === undefined ? "its spend counts as 0" : `its spend counts at the ${usd(held)} last read from it`;
      record({ event: "budget", decision: "flag", rule: "ledger-reset", reason: `the ledger file ${shown(name)} can't be read, so ${counts}` });
    }
    top.usd = Math.max(top.usd, others.usd + mine + floor.usd);
    top.turns = Math.max(top.turns, others.turns + l.mineTurns() + floor.turns);
    return { total: top.usd, turns: top.turns };
  };
  const spent = (total: number) => `the run's budget of ${usd(limit)} is spent (${usd(total)})`;
  /**
   * Save this process's spend; with `spend`, write the spend record; at or over the limit, fail the node (hard: the
   * spend record first, once per call, then the stop) or flag the run, once (soft).
   */
  const account = (ctx: ExtensionContext, pending = 0, o: { spend?: boolean } = {}): { total: number; turns: number } => {
    halted();
    const { total, turns } = spend(ctx, pending);
    started().save();
    let wrote = false;
    const spendRecord = () => {
      if (wrote) return;
      wrote = true;
      record({ event: "budget", decision: "allow", rule: "spend", reason: "the run's spend so far", cost_usd: round(total), turns });
    };
    if (o.spend) spendRecord();
    if (total < limit) return { total, turns };
    if (s.budgets.mode === "hard") {
      stopped = { rule: "run-budget", reason: spent(total), error: `hapi-guard: ${spent(total)}; the node fails (budgets.enforcement.hapi_guard: hard)` };
      spendRecord();
      record({ event: "budget", decision: "fail", rule: "run-budget", reason: `${spent(total)}; the node fails`, cost_usd: round(total) });
      throw new Error(stopped.error);
    }
    if (flagged) return { total, turns };
    flagged = true;
    record({
      event: "budget",
      decision: "flag",
      rule: "run-budget",
      reason: `${spent(total)}; the run goes on and is flagged (budgets.enforcement.hapi_guard: soft)`,
      cost_usd: round(total),
    });
    return { total, turns };
  };
  /** Add a classifier call's cost to the ledger. */
  const charge = (ctx: ExtensionContext, costUsd: number) => {
    const l = started();
    l.addClassifier(costUsd);
    l.mine(sessionSpendUsd(ctx.sessionManager.getEntries()));
    l.save();
  };

  pi.on("session_start", (_event, ctx) => {
    const fail = (rule: string, problem: string): never => {
      try {
        log.write({ event: "session_start", decision: "fail", rule, reason: problem });
      } catch {
        // the throw below fails the node either way
      }
      throw new Error(`hapi-guard: ${problem}; the node fails`);
    };
    const problem = modelProblem(ctx.model, s);
    if (problem) fail("model-pin", problem);
    const dir = agentDirProblem(r.agentDir, s.agent_dir_allowed);
    if (dir) fail("agent-dir", dir);
    const tree = worktreeProblem(ctx.cwd);
    if (tree) fail("worktree", tree);
    const outside = contextAboveProblem(ctx.cwd, r.agentDir);
    if (outside) fail("context-file", outside);
    conventions = readConventions(ctx.cwd);
    let session = "";
    try {
      session = ctx.sessionManager.getSessionId();
    } catch {
      // fall back below
    }
    const l = new Ledger(s.paths.ledgerDir, id, session || `pid-${process.pid}`);
    let resets: string[] = [];
    const prior = log.highest();
    try {
      resets = l.open(log.startedAttempts());
      const mine = l.mine(sessionSpendUsd(ctx.sessionManager.getEntries()));
      l.save();
      const others = l.others();
      for (const name of others.bad) reported.add(name);
      floor.usd = Math.max(0, prior.usd - (others.usd + mine));
      floor.turns = Math.max(0, prior.turns - (others.turns + l.mineTurns()));
    } catch {
      fail("ledger", `the budget ledger under ${s.paths.ledgerDir} can't be written`);
    }
    log.write({ event: "session_start", decision: "allow", rule: "session-start", reason: "the model, Pi's agent dir and the worktree match hapi's settings" });
    ledger = l;
    for (const reason of resets) record({ event: "budget", decision: "flag", rule: "ledger-reset", reason });
  });

  async function onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<Block | undefined> {
    const tool = event.toolName;
    if (!ledger) return { rule: "session-start", reason: "session_start has not run, so no tool call is allowed" };
    const block = (b: Block): Block => {
      record({ event: "tool_call", decision: "block", rule: b.rule, reason: b.reason, tool, ...(b.path === undefined ? {} : { path: b.path }), ...(b.secret === undefined ? {} : { secret: b.secret }) });
      return b;
    };
    // Before anything reads `ctx`: after a hard stop it may be stale (H-230).
    if (stopped) return block({ rule: stopped.rule, reason: `${stopped.reason}; no more tool calls` });
    const allow = (): undefined => {
      record({ event: "tool_call", decision: "allow", rule: "rules", reason: "no rule blocked it", tool });
      return undefined;
    };
    if (deferred) return block({ rule: "deferred", reason: "an earlier tool result's bookkeeping failed, so the node fails at its next send" });
    if (!KNOWN_TOOLS.has(tool)) return block({ rule: "unknown-tool", reason: `${shown(tool)} is not a tool hapi-guard knows` });
    if (s.budgets.mode === "hard") {
      const { total } = spend(ctx);
      if (total >= limit) return block({ rule: "run-budget", reason: `${spent(total)}; no more tool calls` });
    }
    const input = event.input;
    const secretBlock = (text: string, what: string, after = ""): Block | undefined => {
      const found = findSecret(text, secrets);
      if (!found) return undefined;
      return block({ rule: "secret", reason: `${what} holds ${found.exact ? "the value of" : "a key shaped like"} ${found.name}${after}`, note: `, secret: ${found.name}`, secret: found.name });
    };

    if (tool === "write" || tool === "edit") {
      if (typeof input.path !== "string") return block({ rule: "bad-input", reason: `${tool}'s path is not a string` });
      const texts = tool === "write" ? [input.content] : Array.isArray(input.edits) ? input.edits.map((e) => (e as { newText?: unknown } | null)?.newText) : [undefined];
      if (texts.length === 0 || texts.some((t) => typeof t !== "string")) {
        return block({ rule: "bad-input", reason: tool === "write" ? "write's content is not a string" : "edit's edits[].newText is not a string" });
      }
      // The path first: a secret must not reach the repo as a file name either.
      const named = secretBlock(input.path, "the path");
      if (named) return named;
      const v = checkWrite(roots(ctx), input.path, ctx.cwd, home);
      if (v.block) return block({ rule: v.rule, reason: v.reason, path: v.path });
      for (const text of texts as string[]) {
        const b = secretBlock(text, "the content", "; secrets never go into files");
        if (b) return b;
      }
      return allow();
    }

    if (tool === "bash") {
      if (typeof input.command !== "string") return block({ rule: "bad-input", reason: "bash's command is not a string" });
      const command = input.command;
      const b = secretBlock(command, "the command");
      if (b) return b;
      const sh = checkShell(command, { cwd: ctx.cwd, home, roots: roots(ctx), piDir: realDir(r.agentDir), out: realDir(s.paths.out) });
      if (sh) return block({ ...sh, note: "; a best-effort check, not a boundary; to only read a file, use the read tool" });
      if (s.gates.bash_gate.enabled && !skipsGate(command, s.gates.bash_gate.skip_commands)) {
        const res = await ask(bashGate, scrubText(command), options);
        charge(ctx, res.costUsd);
        const judged = res.via !== "default";
        const reason =
          res.verdict === "block"
            ? judged
              ? "the bash gate judged this command irreversible or destructive"
              : res.truncated
                ? "this command is over gates.max_state_chars, so it takes the bash gate's fallback, block"
                : "no classifier could judge this command, so it takes the bash gate's fallback, block"
            : res.verdict === "flag"
              ? "the bash gate flagged this command; it runs, and the run is flagged"
              : "the bash gate allowed this command";
        const decision = res.verdict === "block" ? "block" : res.verdict === "flag" ? "flag" : "allow";
        record({ event: "gate", decision, rule: "bash-gate", reason, tool, cost_usd: round(res.costUsd), classifier: classifierRecord(bashGate, res) });
        if (res.verdict === "block") return { rule: "bash-gate", reason, ...(judged ? { note: `, via ${res.via}` } : {}) };
      } else allow();
      input.command = withUnset(command, secrets);
      return undefined;
    }
    return allow();
  }

  pi.on("tool_call", async (event, ctx) => {
    let b: Block | undefined;
    try {
      b = await onToolCall(event, ctx);
    } catch (e) {
      b = { rule: "error", reason: `checking this call failed: ${e instanceof Error ? e.message : String(e)}` };
      try {
        record({ event: "tool_call", decision: "block", rule: b.rule, reason: b.reason, tool: event.toolName });
      } catch {
        // blocked either way
      }
    }
    return b ? { block: true, reason: scrubText(`hapi-guard: ${b.reason} (rule ${b.rule}${b.note ?? ""})`) } : undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const tool = event.toolName;
    const names = new Set<string>();
    const content = event.content.map((part) => (part.type === "text" && typeof part.text === "string" ? { ...part, text: redactDeep(part.text, secrets, names) as string } : part));
    const structured = event.structuredContent === undefined ? undefined : redactDeep(event.structuredContent, secrets, names);
    const changes: ToolResultEventResult | undefined =
      names.size === 0 ? undefined : { content, ...(event.structuredContent === undefined ? {} : { structuredContent: structured }) };
    // From here on nothing may throw, or the redaction is lost: `defer` holds the error for the next send.
    for (const name of [...names].sort()) {
      const held = PATTERN_NAMES.has(name) ? `a key shaped like ${name}` : `the value of ${name}`;
      defer(() => record({ event: "tool_result", decision: "flag", rule: "secret-redacted", reason: `the result held ${held}; the model sees it redacted`, tool, secret: name }));
    }
    if (!ledger) return changes;
    defer(() => account(ctx));
    if (!s.gates.result_screen.enabled || !(s.gates.result_screen.tools as string[]).includes(tool)) return changes;
    const text = content.flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n");
    if (text.trim() === "") return changes;
    // structuredContent is left out of a wrapped result, so Pi drops it: it would carry the unwrapped text.
    const wrapped: ToolResultEventResult = { content: [{ type: "text", text: wrapText(text) }, ...content.filter((p) => p.type !== "text")] };
    // With an error held (a spent hard budget, or bookkeeping that failed), the node fails at its next send, and a
    // classifier call would spend more: the screen isn't asked, and the result takes its fallback, wrapped, so even a
    // replayed session never sees it unscreened.
    if (deferred) {
      const reason = "an error is held, so the node fails at its next send: the result screen was not asked, and the result takes its fallback, wrap";
      defer(() => record({ event: "gate", decision: "wrap", rule: "result-screen", reason, tool }));
      return wrapped;
    }
    const res = await ask(resultScreen, text, options);
    defer(() => charge(ctx, res.costUsd));
    const wrap = res.verdict === "wrap" || res.verdict === "block";
    const decision = wrap ? "wrap" : res.verdict === "flag" ? "flag" : "allow";
    const reason = wrap
      ? res.via === "default"
        ? "no classifier judged this result, so it takes the result screen's fallback, wrap"
        : "the result screen judged this result to carry instructions; it reaches the model quoted, under a banner"
      : res.verdict === "flag"
        ? "the result screen flagged this result; it reaches the model as is"
        : "the result screen allowed this result";
    defer(() => record({ event: "gate", decision, rule: "result-screen", reason, tool, cost_usd: round(res.costUsd), classifier: classifierRecord(resultScreen, res) }));
    return wrap ? wrapped : changes;
  });

  pi.on("before_agent_start", (event, ctx) => {
    started();
    halted();
    const moved = takeConventions(event, ctx.cwd, conventions);
    if ("problem" in moved) {
      record({ event: "agent_start", decision: "fail", rule: "conventions", reason: moved.problem });
      throw new Error(`hapi-guard: ${moved.problem}; the node fails`);
    }
    if (moved.taken.length === 0) return undefined;
    const names = moved.taken.map((c) => c.name).join(" and ");
    const verb = moved.taken.length === 1 ? "reaches" : "reach";
    record({ event: "agent_start", decision: "allow", rule: "conventions", reason: `the repo's ${names} ${verb} the model below the work order, as the repo's conventions` });
    const content = moved.taken.map((c) => conventionsBlock(c.name, scrubText(c.text))).join("\n\n");
    return { message: { customType: "hapi-conventions", content, display: false } };
  });

  pi.on("before_provider_headers", (_event, ctx) => {
    rethrow();
    const l = started();
    l.countSend();
    if (stopped) {
      // A refused send still counts; the save reads no ctx.
      l.save();
      halted();
    }
    account(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    started();
    halted();
    const payload = event.payload;
    if (!isPayload(payload)) {
      const reason = "the provider payload is not an object";
      record({ event: "provider_request", decision: "fail", rule: "payload", reason });
      throw new Error(`hapi-guard: ${reason}; the node fails`);
    }
    const found = pinOf(ctx.model, s);
    if ("problem" in found) {
      record({ event: "provider_request", decision: "fail", rule: "model-pin", reason: found.problem });
      throw new Error(`hapi-guard: ${found.problem}; the node fails`);
    }
    const clamped = clamp(payload, s.max_tokens);
    if (clamped) record({ event: "provider_request", decision: "allow", rule: "max-tokens", reason: clamped });
    if (found.pin.require_compat && !bindsThinking(payload)) {
      const reason = `${found.ref}'s request has neither thinking disabled nor drop_block with the ${BINDING_BETA} beta (H-184)`;
      record({ event: "provider_request", decision: "fail", rule: "drop-block", reason });
      throw new Error(`hapi-guard: ${reason}; the node fails`);
    }
    return undefined;
  });

  pi.on("message_end", (event, ctx) => {
    started();
    halted();
    const m = event.message;
    // Pi persists the message only after the extensions see it (agent-session.js:752-768).
    const persisted = ctx.sessionManager.getEntries().some((e) => e.type === "message" && e.message === m);
    account(ctx, !persisted && (m?.role === "assistant" || m?.role === "toolResult") ? usageUsd(m.usage) : 0);
  });

  pi.on("turn_end", (event, ctx) => {
    rethrow();
    const l = started();
    halted();
    const m = event.message;
    const final = endsSession(m);
    if (final) record({ event: "result", rule: "result", ...sessionResult(m) });
    // Count the turn first, so the spend record's turns include it.
    l.countTurn();
    const { turns } = account(ctx, 0, { spend: true });
    // The turn that ends the session never fails on turns: there is no next one.
    if (final || turns < run.turns) return;
    const used = `the run's turn budget of ${run.turns} is spent (${turns} ${turns === 1 ? "turn" : "turns"})`;
    if (s.budgets.mode === "hard") {
      stopped = { rule: "run-turns", reason: used, error: `hapi-guard: ${used}; the node fails (budgets.enforcement.hapi_guard: hard)` };
      record({ event: "budget", decision: "fail", rule: "run-turns", reason: `${used}; the node fails`, turns });
      throw new Error(stopped.error);
    }
    if (turnsFlagged) return;
    turnsFlagged = true;
    record({ event: "budget", decision: "flag", rule: "run-turns", reason: `${used}; the run goes on and is flagged (budgets.enforcement.hapi_guard: soft)`, turns });
  });
}

/** The guard on `pi`, with explicit dependencies (tests, and the bundle test's runner). Never throws on bad settings. */
export function createGuard(pi: ExtensionAPI, deps: GuardDeps): void {
  let ready: Ready;
  try {
    ready = prepare(deps.env);
  } catch (e) {
    const problem = e instanceof Problem ? e.message : "its settings could not be loaded";
    pi.on("session_start", () => {
      throw new Error(`hapi-guard: ${problem}; the node fails closed`);
    });
    return;
  }
  register(pi, ready, deps);
}

/** Pi's entry point: the guard on this process's own env. It never throws (a throw fails open). */
export default function hapiGuard(pi: ExtensionAPI): void {
  try {
    createGuard(pi, { env: process.env });
  } catch {
    try {
      pi.on("session_start", () => {
        throw new Error("hapi-guard: it could not start; the node fails closed");
      });
    } catch {
      // nothing more can be done from here; Task 7's guard-ran check fails the run
    }
  }
}
