/**
 * `hapi decide <name> [--state-file file] [--public] [--mock]`: run one decision
 * (policy/decisions/<name>.ts) on a state and print the result as one JSON line.
 * The state comes from `--state-file` or stdin, never from argv (argv shows in
 * process listings). `--public` marks the run public, so Jev may answer;
 * `--mock` answers offline with the vendored mock, for tests and demos, and
 * needs no policy directory.
 *
 * The run engine's decisions (src/engine/decisions.ts) are here too, so one can be replayed offline: their state is
 * the JSON object the harvester built (`{ goal, path, part, diff }`), so the state text must parse as a JSON object
 * and is passed on as that object, exactly as the harvester sent it.
 *
 * Keys come only from HAPI_JEV_OPENROUTER_API_KEY and ANTHROPIC_API_KEY. Without
 * `--mock` the gates and flags are read from the policy in `$HAPI_POLICY_DIR`
 * (default `policy`, relative to the working directory). This file is also a
 * standalone entry: Task 4 bundles it into build/decide/hapi-decide.js. Plan 04
 * ships that bundle into the Hermes image, with a Hermes-zone Jev key.
 *
 * Exit codes: 0 a result was printed (a fallback verdict still is one), 1 the
 * decision could not run, 2 a usage error.
 */
import { readFileSync } from "node:fs";
import bashGate from "../../policy/decisions/bash-gate";
import diffScreen from "../../policy/decisions/diff-screen";
import resultScreen from "../../policy/decisions/result-screen";
import { loadPolicy } from "../policy/load";
import type { Gates } from "../policy/types";
import { type DecisionFile, decide, type State } from "./index";

const USAGE = "usage: hapi decide <name> [--state-file file] [--public] [--mock]";

/** The decisions `hapi decide` can run: the files that ask a classifier, the guard's gates and the run engine's. */
const DECISIONS: Record<string, DecisionFile<string>> = { "bash-gate": bashGate, "result-screen": resultScreen, "diff-screen": diffScreen };

/** Whether a file is one of the run engine's (an `EngineDecisionFile`, which says its hold and note), whose state is a JSON object. */
const isEngineFile = (file: DecisionFile<string>): boolean => Object.hasOwn(file, "says");

/** An engine decision's state, the JSON object the harvester built; undefined when the text isn't one. */
function engineState(text: string): State | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as State) : undefined;
  } catch {
    return undefined;
  }
}

/** What `--mock` uses in place of policy/gates.yaml: only `max_state_chars` matters to the mock, set to the shipped value. */
const MOCK_GATES: Gates = {
  bash_gate: { enabled: true, skip_commands: [] },
  result_screen: { enabled: true, tools: ["bash", "read"] },
  max_state_chars: 6000,
  classifiers: {
    jev: { model: "~typesafe/jev-latest", unknown_call_usd: 0.001 },
    haiku: { model: "claude-haiku-5-5", input_per_mtok: 0.1, output_per_mtok: 0.5 },
  },
};

export interface DecideDeps {
  /** Reads all of stdin. */
  readStdin?: () => Promise<string>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

function usageError(message?: string): number {
  console.error(message ? `${message}\n${USAGE}` : USAGE);
  return 2;
}

export async function decideCommand(args: string[], deps: DecideDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  let name: string | undefined;
  let stateFile: string | undefined;
  let isPublic = false;
  let mock = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--state-file") {
      stateFile = args[++i];
      if (stateFile === undefined) return usageError();
    } else if (a === "--public") isPublic = true;
    else if (a === "--mock") mock = true;
    else if (a.startsWith("-") || name !== undefined) return usageError();
    else name = a;
  }
  if (name === undefined) return usageError();
  const file = Object.hasOwn(DECISIONS, name) ? DECISIONS[name] : undefined;
  if (!file) return usageError(`hapi decide: unknown decision '${name}'. Known: ${Object.keys(DECISIONS).join(", ")}`);

  const text = stateFile !== undefined ? readFileSync(stateFile, "utf8") : await (deps.readStdin ?? (async () => readFileSync(0, "utf8")))();
  const state = isEngineFile(file) ? engineState(text) : text;
  if (state === undefined) return usageError(`hapi decide: ${name}'s state is the run engine's, a JSON object ({ goal, path, part, diff }), as the harvester built it`);
  const policy = mock ? undefined : loadPolicy(env.HAPI_POLICY_DIR || "policy");
  const result = await decide(file, state, {
    gates: policy?.gates ?? MOCK_GATES,
    jev: { enabled: policy?.flags.jev.enabled ?? false, public: isPublic, apiKey: env.HAPI_JEV_OPENROUTER_API_KEY },
    haiku: { enabled: policy?.flags.jev.fallback === "haiku", apiKey: env.ANTHROPIC_API_KEY },
    mock,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  console.log(JSON.stringify(result));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = await decideCommand(process.argv.slice(2));
  } catch (e) {
    console.error(`hapi decide: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
