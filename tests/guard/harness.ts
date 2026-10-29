/**
 * A fake Pi for hapi-guard's tests: it records `on(event, handler)` and calls the
 * handlers with crafted events and a crafted `ctx`, as Pi 1.3.0 would
 * (src/guard/pi-api.ts). Each harness gets its own temp tree standing in for the
 * run container: the worktree, Pi's agent dir, run.json, /out, the guard's /tmp
 * and its ledger. Keys are obviously fake; nothing reaches a network.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitPi } from "../../src/generate/pi";
import { createGuard, type GuardDeps } from "../../src/guard/index";
import type { ExtensionContext, PiModel, SessionEntry } from "../../src/guard/pi-api";
import { loadPolicy } from "../../src/policy/load";

/** Fake values for the archon zone's env names (stack/secrets.yaml): long enough to check, plainly not keys. */
export const FAKE_ENV = {
  ANTHROPIC_API_KEY: "fake-anthropic-key-value-0001",
  CLAUDE_API_KEY: "fake-claude-key-value-0002",
  HAPI_JEV_OPENROUTER_API_KEY: "fake-jev-key-value-0003",
  OPENCODE_API_KEY: "fake-opencode-key-value-0004",
} as const;

export const RUN_ID = "wf-run-0001";

const policy = loadPolicy("policy");
/** hapi-guard.json as `hapi policy build` writes it for the anthropic roster, parsed. */
export const BASE_SETTINGS = JSON.parse(emitPi(policy)["hapi-guard.json"]!);

/** The resolved model Pi would give for a pinned ref: the pin itself, as spike 08 r1 saw it. */
export function pinnedModel(ref = "anthropic/claude-haiku-5-5", settings = BASE_SETTINGS): PiModel {
  const pin = settings.models[ref];
  const slash = ref.indexOf("/");
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    baseUrl: pin.base_url,
    cost: structuredClone(pin.cost),
    compat: structuredClone(pin.compat),
    maxTokens: pin.max_tokens,
  };
}

/** Settings with both gates off, so a test of another rule makes no decide() call. */
export const gatesOff = (s: any) => {
  s.gates.bash_gate.enabled = false;
  s.gates.result_screen.enabled = false;
};

type Fn = (event: any, ctx: ExtensionContext) => unknown;

export class FakePi {
  readonly handlers = new Map<string, Fn[]>();
  readonly registered: string[] = [];
  on(event: string, handler: Fn): () => void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return () => {};
  }
  registerTool(): void {
    this.registered.push("tool");
  }
  registerFlag(): void {
    this.registered.push("flag");
  }
}

export interface SetupOptions {
  /** Change hapi-guard.json before it is written. */
  settings?: (s: any) => void;
  /** Raw hapi-guard.json text, or null for no file. */
  settingsText?: string | null;
  /** Change run.json before it is written. */
  run?: (r: any) => void;
  /** Raw run.json text, or null for no file. */
  runText?: string | null;
  /** Extra env, or a name set to undefined to unset it. */
  env?: Record<string, string | undefined>;
  decide?: GuardDeps["decide"];
  /** Reuse another harness's run dirs (out, ledger, worktree), as a later attempt of the same run would. */
  share?: Harness;
  attempt?: string;
  session?: string;
  model?: PiModel | undefined;
}

const made: string[] = [];

/** Remove every harness's temp tree: call from afterEach. */
export function cleanupAll(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Harness {
  base: string;
  work: string;
  tmp: string;
  home: string;
  agentDir: string;
  out: string;
  ledgerDir: string;
  runFile: string;
  env: Record<string, string | undefined>;
  pi: FakePi;
  ctx: ExtensionContext;
  entries: SessionEntry[];
  attempt: string;
  session: string;
  fire(event: string, payload: Record<string, unknown>): Promise<unknown>;
  start(): Promise<unknown>;
  tool(toolName: string, input: Record<string, unknown>): Promise<any>;
  result(toolName: string, content: { type: string; text?: string }[], extra?: Record<string, unknown>): Promise<any>;
  log(): any[];
  ledger(): any;
}

export function setup(o: SetupOptions = {}): Harness {
  const shared = o.share;
  const base = shared?.base ?? realpathSync(mkdtempSync(join(tmpdir(), "hapi-guard-test-")));
  if (!shared) made.push(base);
  const work = join(base, "work", "repo");
  const tmp = join(base, "tmp");
  const home = join(base, "home");
  const agentDir = join(base, "pi-agent");
  const out = join(base, "out");
  const ledgerDir = join(tmp, "hapi-guard");
  const runFile = join(base, "run", "run.json");
  for (const d of [work, tmp, home, join(agentDir, "extensions"), join(agentDir, "sessions"), join(base, "run")]) mkdirSync(d, { recursive: true });
  for (const f of ["models.json", "models-store.json", "settings.json"]) if (!existsSync(join(agentDir, f))) writeFileSync(join(agentDir, f), "{}\n");

  const settings = structuredClone(BASE_SETTINGS);
  settings.paths = { out, runFile, ledgerDir };
  o.settings?.(settings);
  const settingsPath = join(agentDir, "hapi-guard.json");
  if (o.settingsText === null) rmSync(settingsPath, { force: true });
  else writeFileSync(settingsPath, o.settingsText ?? JSON.stringify(settings, null, 2));

  const run = {
    run_id: "hapi-run-0001",
    work_order: "WO-0001",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    budget_usd: 3,
    public: false,
    workflow: "hapi-check",
    started_at: "2026-10-29T12:00:00Z",
  };
  o.run?.(run);
  if (o.runText === null) rmSync(runFile, { force: true });
  else writeFileSync(runFile, o.runText ?? JSON.stringify(run));

  const attempt = o.attempt ?? "attempt-0001";
  const session = o.session ?? `session-${attempt}`;
  const env: Record<string, string | undefined> = {
    ...FAKE_ENV,
    PATH: "/usr/bin:/bin",
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    WORKFLOW_ID: RUN_ID,
    ARCHON_NODE_EXECUTION: JSON.stringify({
      runId: RUN_ID,
      path: "work",
      invocation: { id: "inv-0001", startedAt: "2026-10-29T12:00:01Z", checkoutStart: "abc" },
      attempt: { id: attempt, startedAt: "2026-10-29T12:00:01Z", checkoutStart: "abc" },
    }),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    BUN_OPTIONS: "--no-install",
  };
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const entries: SessionEntry[] = [];
  const ctx: ExtensionContext = {
    cwd: work,
    model: "model" in o ? o.model : pinnedModel(),
    sessionManager: { getEntries: () => entries, getSessionId: () => session },
  };
  const pi = new FakePi();
  createGuard(pi as any, { env, tmpRoot: tmp, home, decide: o.decide ?? { mock: true } });

  const fire = async (event: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const h of pi.handlers.get(event) ?? []) {
      const r = await h({ type: event, ...payload }, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  };
  let calls = 0;
  return {
    base, work, tmp, home, agentDir, out, ledgerDir, runFile, env, pi, ctx, entries, attempt, session,
    fire,
    start: () => fire("session_start", { reason: "startup" }),
    tool: (toolName, input) => fire("tool_call", { toolCallId: `call-${++calls}`, toolName, input }),
    result: (toolName, content, extra = {}) => fire("tool_result", { toolCallId: `call-${++calls}`, toolName, input: {}, content, isError: false, ...extra }),
    log: () => {
      const f = join(out, "decisions.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    ledger: () => JSON.parse(readFileSync(join(ledgerDir, RUN_ID, `${attempt}.${session}.json`), "utf8")),
  };
}

/** An assistant message entry that cost `usd`. */
export const assistant = (usd: number): SessionEntry => ({ type: "message", message: { role: "assistant", usage: { cost: { total: usd } } } });
