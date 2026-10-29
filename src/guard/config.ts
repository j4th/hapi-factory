/**
 * hapi-guard's inputs, read once in the factory (design §3.3 "Inputs", §6a item 7):
 *
 * - `hapi-guard.json` in Pi's agent dir (`$PI_CODING_AGENT_DIR`), written by
 *   `hapi policy build` (src/generate/pi.ts; docs/generated-configs.md);
 * - the run file (`paths.runFile`, a `RunFile` from src/generate/archon.ts) the
 *   launcher binds read-only: the work order's id, its trace context, the run's
 *   budget and whether the repo is public;
 * - Archon's per-node env: `WORKFLOW_ID` and `ARCHON_NODE_EXECUTION`
 *   (`{runId, path, invocation, attempt: {id, ...}}`, spike 08 finding 3), the
 *   decision log's join keys for Task 7's guard-ran check.
 *
 * Anything missing or malformed is a `Problem`: the factory then registers only
 * a session_start that throws, so the node fails closed rather than running
 * unguarded (a factory throw fails open, spike 08 finding 8). A problem names
 * the file and the field, never a value: a malformed file might hold anything.
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { RunFile } from "../generate/archon";
import type { Gates } from "../policy/types";

/** One pinned model: the catalog entry the resolved model must equal at session_start (spike 08, finding 9). */
export interface ModelPin {
  base_url: string;
  cost: unknown;
  compat: Record<string, unknown>;
  max_tokens: number;
  /** True for anthropic/*: Pi must send drop_block (H-184). */
  require_compat: boolean;
}

/** hapi-guard.json, as docs/generated-configs.md describes it. */
export interface GuardSettings {
  session: "workers";
  combine: "strictest";
  protected_paths: Record<string, "deny">;
  budgets: { run_usd: number; mode: "hard" | "soft" };
  max_tokens: number;
  models: Record<string, ModelPin>;
  secret_env: string[];
  agent_dir_allowed: string[];
  gates: Gates;
  jev: { enabled: boolean; fallback: "haiku" | "none" };
  paths: { out: string; runFile: string; ledgerDir: string };
}

/** Who this process is guarding: the decision log's join keys (Task 7). */
export interface Identity {
  /** WORKFLOW_ID. */
  run: string;
  /** ARCHON_NODE_EXECUTION.path. */
  node: string;
  /** ARCHON_NODE_EXECUTION.attempt.id: a string id, not a number (spike 08, finding 3). */
  attempt: string;
}

/** A setting that can't be used. Its message is safe to show: file and field, no value. */
export class Problem extends Error {
  override name = "Problem";
}

/** The env names the shell must keep: git's env config (the run's git hardening) and Bun's --no-install (design §6a items 5, 13). */
export const SHELL_KEEPS = /^(GIT_CONFIG_.*|BUN_OPTIONS)$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Field checkers. Each throws a Problem naming `at`, the field's path, and never the value. */
function obj(v: unknown, at: string): Obj {
  if (!isObj(v)) throw new Problem(`${at} must be an object`);
  return v;
}
function str(v: unknown, at: string): string {
  if (typeof v !== "string" || v === "") throw new Problem(`${at} must be a string`);
  return v;
}
function num(v: unknown, at: string, min = 0): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) throw new Problem(`${at} must be a number of at least ${min}`);
  return v;
}
function bool(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new Problem(`${at} must be a boolean`);
  return v;
}
function oneOf<T extends string>(v: unknown, at: string, options: readonly T[]): T {
  if (!options.includes(v as T)) throw new Problem(`${at} must be ${options.length === 1 ? options[0] : `one of ${options.join(", ")}`}`);
  return v as T;
}
function list<T>(v: unknown, at: string, each: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v)) throw new Problem(`${at} must be a list`);
  return v.map((x, i) => each(x, `${at}[${i}]`));
}
function absPath(v: unknown, at: string): string {
  const s = str(v, at);
  if (!isAbsolute(s)) throw new Problem(`${at} must be an absolute path`);
  return s;
}

/** Parse a JSON file, or a Problem that names the file: never the parser's message, which can quote the content. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Problem(`${file}: can't be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Problem(`${file}: not valid JSON`);
  }
}

/** Prefix a field problem with its file. */
function inFile<T>(file: string, read: () => T): T {
  try {
    return read();
  } catch (e) {
    if (e instanceof Problem && !e.message.startsWith(`${file}:`)) throw new Problem(`${file}: ${e.message}`);
    throw e;
  }
}

function gates(v: unknown, at: string): Gates {
  const g = obj(v, at);
  const bash = obj(g.bash_gate, `${at}.bash_gate`);
  const screen = obj(g.result_screen, `${at}.result_screen`);
  const classifiers = obj(g.classifiers, `${at}.classifiers`);
  const jev = obj(classifiers.jev, `${at}.classifiers.jev`);
  const haiku = obj(classifiers.haiku, `${at}.classifiers.haiku`);
  return {
    bash_gate: { enabled: bool(bash.enabled, `${at}.bash_gate.enabled`), skip_commands: list(bash.skip_commands, `${at}.bash_gate.skip_commands`, str) },
    result_screen: {
      enabled: bool(screen.enabled, `${at}.result_screen.enabled`),
      tools: list(screen.tools, `${at}.result_screen.tools`, (x, a) => oneOf(x, a, ["bash", "read"] as const)),
    },
    max_state_chars: num(g.max_state_chars, `${at}.max_state_chars`, 1),
    classifiers: {
      jev: { model: str(jev.model, `${at}.classifiers.jev.model`), unknown_call_usd: num(jev.unknown_call_usd, `${at}.classifiers.jev.unknown_call_usd`) },
      haiku: {
        model: oneOf(haiku.model, `${at}.classifiers.haiku.model`, ["claude-haiku-5-5"] as const),
        input_per_mtok: num(haiku.input_per_mtok, `${at}.classifiers.haiku.input_per_mtok`),
        output_per_mtok: num(haiku.output_per_mtok, `${at}.classifiers.haiku.output_per_mtok`),
      },
    },
  };
}

/** Read and check hapi-guard.json. Throws a Problem. */
export function loadSettings(file: string): GuardSettings {
  const raw = readJson(file);
  if (!isObj(raw)) throw new Problem(`${file}: must be an object`);
  return inFile(file, () => {
    const s = raw;
    oneOf(s.session, "session", ["workers"] as const);
    oneOf(s.combine, "combine", ["strictest"] as const);
    const protectedPaths = obj(s.protected_paths, "protected_paths");
    for (const [glob, mode] of Object.entries(protectedPaths)) oneOf(mode, `protected_paths.${glob}`, ["deny"] as const);
    const budgets = obj(s.budgets, "budgets");
    const models: Record<string, ModelPin> = {};
    for (const [ref, pin] of Object.entries(obj(s.models, "models"))) {
      const m = obj(pin, `models.${ref}`);
      if (!("cost" in m)) throw new Problem(`models.${ref}.cost must be set`);
      models[ref] = {
        base_url: str(m.base_url, `models.${ref}.base_url`),
        cost: m.cost,
        compat: obj(m.compat, `models.${ref}.compat`),
        max_tokens: num(m.max_tokens, `models.${ref}.max_tokens`, 1),
        require_compat: bool(m.require_compat, `models.${ref}.require_compat`),
      };
    }
    const secretEnv = list(s.secret_env, "secret_env", (x, at) => {
      if (typeof x !== "string" || !ENV_NAME.test(x)) throw new Problem(`${at} must be an env name`);
      if (SHELL_KEEPS.test(x)) throw new Problem(`secret_env names ${x}, which the shell must keep`);
      return x;
    });
    const paths = obj(s.paths, "paths");
    const jev = obj(s.jev, "jev");
    const settings: GuardSettings = {
      session: "workers",
      combine: "strictest",
      protected_paths: protectedPaths as Record<string, "deny">,
      budgets: { run_usd: num(budgets.run_usd, "budgets.run_usd"), mode: oneOf(budgets.mode, "budgets.mode", ["hard", "soft"] as const) },
      max_tokens: num(s.max_tokens, "max_tokens", 1),
      models,
      secret_env: secretEnv,
      agent_dir_allowed: list(s.agent_dir_allowed, "agent_dir_allowed", str),
      gates: gates(s.gates, "gates"),
      jev: { enabled: bool(jev.enabled, "jev.enabled"), fallback: oneOf(jev.fallback, "jev.fallback", ["haiku", "none"] as const) },
      paths: { out: absPath(paths.out, "paths.out"), runFile: absPath(paths.runFile, "paths.runFile"), ledgerDir: absPath(paths.ledgerDir, "paths.ledgerDir") },
    };
    // decide() refuses a gate with no classifier; loadPolicy refuses it too, so this file was edited (design §3.3, "Cost and failure").
    const gateOn = settings.gates.bash_gate.enabled || settings.gates.result_screen.enabled;
    if (gateOn && !settings.jev.enabled && settings.jev.fallback === "none") {
      throw new Problem("a gate is on with no classifier (jev.enabled false, jev.fallback none)");
    }
    return settings;
  });
}

/** Read and check the run file. Throws a Problem. */
export function loadRunFile(file: string): RunFile {
  const raw = readJson(file);
  if (!isObj(raw)) throw new Problem(`${file}: must be an object`);
  return inFile(file, () => {
    const r = raw;
    return {
      run_id: str(r.run_id, "run_id"),
      work_order: str(r.work_order, "work_order"),
      traceparent: str(r.traceparent, "traceparent"),
      budget_usd: num(r.budget_usd, "budget_usd"),
      public: bool(r.public, "public"),
      workflow: str(r.workflow, "workflow"),
      started_at: str(r.started_at, "started_at"),
    };
  });
}

/** The node attempt this process runs, from Archon's env (exec-environment.ts:81-90). Throws a Problem. */
export function loadIdentity(env: Record<string, string | undefined>): Identity {
  const run = env.WORKFLOW_ID;
  if (!run) throw new Problem("WORKFLOW_ID is not set");
  const text = env.ARCHON_NODE_EXECUTION;
  if (!text) throw new Problem("ARCHON_NODE_EXECUTION is not set");
  let execution: unknown;
  try {
    execution = JSON.parse(text);
  } catch {
    throw new Problem("ARCHON_NODE_EXECUTION is not valid JSON");
  }
  const e = isObj(execution) ? execution : {};
  const attempt = isObj(e.attempt) ? e.attempt.id : undefined;
  if (typeof e.path !== "string" || e.path === "" || typeof attempt !== "string" || attempt === "") {
    throw new Problem("ARCHON_NODE_EXECUTION has no path and attempt.id");
  }
  return { run, node: e.path, attempt };
}
