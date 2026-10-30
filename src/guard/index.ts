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
 * - `session_start` (config.ts, model.ts, budget.ts): the resolved model against
 *   its pin, Pi's agent dir against `agent_dir_allowed` (and extensions/ holding
 *   only this bundle), the worktree without `.pi/`, `.agents/` or `.archon/`
 *   (H-181(d)), the ledger read, then the first decision-log record;
 * - `tool_call`: rule 1 (paths.ts) and rule 6 (secrets.ts) for write and edit;
 *   rule 6, rule 7 (shell.ts) and the bash gate (gates.ts) for bash, then rule
 *   8's `unset` prefix. A throw here only becomes an error result, so every
 *   refusal is `{ block: true, reason }` instead (design §6a item 8);
 * - `tool_result`: rule 6's redaction, then the result screen;
 * - `before_provider_headers`: rule 3's hard stop before every send, retries and
 *   compaction summaries included (finding 5);
 * - `before_provider_request`: rule 4's clamp and H-184's payload check;
 * - `message_end` and `turn_end`: the spend update, the ledger write, the stop.
 *
 * Every hook but tool_call fails the node by throwing (brief §2.9). tool_result
 * never throws, since a throw there would drop its redaction: it holds the error,
 * and the next before_provider_headers or turn_end throws it.
 */
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RunFile } from "../generate/archon";
import { Ledger, sessionSpendUsd, usageUsd, usd } from "./budget";
import { type GuardSettings, type Identity, loadIdentity, loadRunFile, loadSettings, Problem } from "./config";
import { ask, bashGate, classifierRecord, type DecideHooks, decideOptions, resultScreen, skipsGate, wrapText } from "./gates";
import { DecisionLog, type Entry } from "./log";
import { bindsThinking, BINDING_BETA, clamp, isPayload, modelProblem, pinOf } from "./model";
import { checkWrite, protectedTable, realDir, type Roots } from "./paths";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolResultEvent, ToolResultEventResult } from "./pi-api";
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
  run: RunFile;
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
  /**
   * The first error a tool_result caught. Pi keeps a result's original content
   * when tool_result throws, so a throw there (a full /tmp failing the ledger
   * save, say) would undo rule 6's redaction (final review A-1). The error is
   * held instead: every later tool call blocks, and the next send or turn end
   * throws it, which fails the node.
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

  /** The run's spend: the other attempts' ledgers, this session's entries plus `pending`, this process's classifier calls. */
  const spend = (ctx: ExtensionContext, pending = 0): { session: number; total: number } => {
    const l = started();
    const session = sessionSpendUsd(ctx.sessionManager.getEntries()) + pending;
    const others = l.others();
    for (const name of others.bad) {
      if (reported.has(name)) continue;
      reported.add(name);
      record({ event: "budget", decision: "flag", rule: "ledger-reset", reason: `the ledger file ${shown(name)} can't be read, so its spend counts as 0` });
    }
    return { session, total: others.usd + l.mine(session) };
  };
  const spent = (total: number) => `the run's budget of ${usd(limit)} is spent (${usd(total)})`;
  /** Save this process's spend; at or over the limit, fail the node (hard) or flag the run, once (soft). */
  const account = (ctx: ExtensionContext, pending = 0): void => {
    const { session, total } = spend(ctx, pending);
    started().save(session);
    if (total < limit) return;
    if (s.budgets.mode === "hard") {
      record({ event: "budget", decision: "fail", rule: "run-budget", reason: `${spent(total)}; the node fails`, cost_usd: round(total) });
      throw new Error(`hapi-guard: ${spent(total)}; the node fails (budgets.enforcement.hapi_guard: hard)`);
    }
    if (flagged) return;
    flagged = true;
    record({
      event: "budget",
      decision: "flag",
      rule: "run-budget",
      reason: `${spent(total)}; the run goes on and is flagged (budgets.enforcement.hapi_guard: soft)`,
      cost_usd: round(total),
    });
  };
  /** Add a classifier call's cost to the ledger. */
  const charge = (ctx: ExtensionContext, costUsd: number) => {
    const l = started();
    l.addClassifier(costUsd);
    l.save(sessionSpendUsd(ctx.sessionManager.getEntries()));
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
    let session = "";
    try {
      session = ctx.sessionManager.getSessionId();
    } catch {
      // fall back below
    }
    const l = new Ledger(s.paths.ledgerDir, id, session || `pid-${process.pid}`);
    let resets: string[] = [];
    try {
      resets = l.open(log.startedAttempts());
      l.save(sessionSpendUsd(ctx.sessionManager.getEntries()));
      for (const name of l.others().bad) reported.add(name);
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
      if (sh) return block({ ...sh, note: "; a best-effort check, not a boundary" });
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
    // Over a hard budget `account` throws: the result is then not screened, which would spend more.
    if (!ledger || !defer(() => account(ctx))) return changes;
    if (!s.gates.result_screen.enabled || !(s.gates.result_screen.tools as string[]).includes(tool)) return changes;
    const text = content.flatMap((p) => (p.type === "text" && typeof p.text === "string" ? [p.text] : [])).join("\n");
    if (text.trim() === "") return changes;
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
    // structuredContent is left out, so Pi drops it: it would carry the unwrapped text.
    if (wrap) return { content: [{ type: "text", text: wrapText(text) }, ...content.filter((p) => p.type !== "text")] };
    return changes;
  });

  pi.on("before_provider_headers", (_event, ctx) => {
    rethrow();
    started().countSend();
    account(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    started();
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
    const m = event.message;
    // Pi persists the message only after the extensions see it (agent-session.js:752-768).
    const persisted = ctx.sessionManager.getEntries().some((e) => e.type === "message" && e.message === m);
    account(ctx, !persisted && (m?.role === "assistant" || m?.role === "toolResult") ? usageUsd(m.usage) : 0);
  });

  pi.on("turn_end", (_event, ctx) => {
    rethrow();
    started();
    account(ctx);
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
