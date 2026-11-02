/**
 * The kinds of run the engine starts (design §3.1, §3.4, §3.5), each a phase of a work order with a run id of its
 * own: the `worker` that does a work order's pieces, the `verify` that runs its repo's gates, the `review` of its
 * diff, and a `fix` round on a review's findings.
 *
 * One profile per kind (`kindProfile`) decides its container: whose keys its docker CLI gets (`zone`), the proxy
 * joined to its network (`egress`), its prelude and workflow, whether it takes an inputs dir, its extra binds and the
 * outputs copy-out reads. Design §3.5's rule is that no container that holds a key ever runs the worker's code:
 * - `worker` and `fix` run in the worker's container: run.sh, the work order's own workflow (its `factory-task`),
 *   the archon zone's keys and egress-archon. A fix also reads the review's findings from its inputs dir;
 * - `verify` holds no key of any kind: verify.sh, `factory-verify`. It still joins egress-archon, so that it can
 *   install from the bundle's own lockfile (`bun ci --frozen-lockfile --ignore-scripts`): only the registries matter
 *   there, since the model APIs are no use without a key. Its `/work` is a fresh volume of its own, so it never
 *   reuses the worker's `node_modules`;
 * - `review` holds the review zone's keys, behind egress-review, and runs none of the repo's code: review.sh makes
 *   its checkout read-only, and `factory-review` runs only a read-only review session and CodeRabbit's CLI. So it
 *   gets no smoke sidecar; every other kind does, when its work order smokes and its repo names one (./sidecar.ts).
 *
 * No container fetches a bundle: every kind's source is `StartOptions.repoGitDir`, which must hold the run's commit.
 * A worker's is the repo's mirror; a verify, review or fix run's is the harvester's checked copy of the mirror with
 * the bundle's commits fetched into it (Task 12), but a rework fix's (Task 13) is the mirror at the PR's head.
 */
import type { Runs } from "../policy/types";
import type { RunDeps } from "./spec";

export type RunKind = "worker" | "verify" | "review" | "fix";

export const RUN_KINDS: readonly RunKind[] = ["worker", "verify", "review", "fix"];

/** The label on a run container (only the container) that names its kind: the audit holds it to that kind's definition. */
export const KIND_LABEL = "org.hapi.kind";

/**
 * The only files an inputs dir may hold, bound read-only at `RUN_PATHS.inputs`. Task 13 writes them; Task 11's
 * prompts read them. A review gets the diff and verify's results; a fix gets the review's findings. The work order
 * and its task text are not inputs: every kind's container has them already, at `RUN_PATHS.order` and
 * `RUN_PATHS.task` (ruling m46), from the one host copy. No base.txt: the base is `RunFile.base`. Never a bundle.
 */
export const RUN_INPUTS = { diff: "diff.patch", verify: "verify.json", findings: "findings.md" } as const;

/** The subdir of a run's record dir that holds its copy of the inputs dir (./records.ts `createRun`), bound at `RUN_PATHS.inputs`. */
export const INPUTS_DIR = "inputs";

export interface KindProfile {
  kind: RunKind;
  /** Whose `<zone>.env` the container's docker CLI gets; undefined: no key at all. */
  zone: "archon" | "review" | undefined;
  /** The proxy joined to the run's network, under this alias: the host the container's proxy variables name. */
  egress: "egress-archon" | "egress-review";
  /** `stack/archon/<prelude>`, bound and run at `/opt/hapi/<prelude>`. */
  prelude: "run.sh" | "verify.sh" | "review.sh";
  /** The workflow the run runs; undefined: the work order's own (its `factory-task`). */
  workflow: "factory-verify" | "factory-review" | undefined;
  /** Whether `StartOptions.inputsDir` is required, copied and bound at `RUN_PATHS.inputs` (and refused when false). */
  inputs: boolean;
  /**
   * Which of `RUN_INPUTS`' files the kind's inputs dir may hold (`allowed`), and must (`required`): a fix's must hold
   * the findings; a review's the diff, and verify's results unless the verify phase is off. Empty for a kind that
   * takes none.
   */
  inputFiles: { required: readonly string[]; allowed: readonly string[] };
  /**
   * Whether a run of the kind may start its repo's smoke sidecar (./sidecar.ts; design §3.3, H-192): when its work
   * order smokes and the repo's overlay names one, it starts on the run's network before the run. True for every
   * kind but review, which runs none of the repo's code.
   */
  sidecar: boolean;
  /** More read-only binds, each through `mountable`: every kind's is empty here (Task 11 gives review's one). */
  extraBinds: (d: Pick<RunDeps, "buildDir">) => [src: string, dst: string][];
  /** The files copy-out reads from `/out`, in order, each capped by its limit in `runs.output_limits_mb`; any other name is reported. */
  outputs: readonly { name: string; limit: keyof Runs["output_limits_mb"] }[];
}

const none = (): [string, string][] => [];

/** A worker's and a fix's outputs: Archon's record, the transcript, the guard's decisions and the bundle of the commits. */
const WORKER_OUTPUTS = [
  { name: "result.json", limit: "result" },
  { name: "transcript.jsonl", limit: "transcript" },
  { name: "decisions.jsonl", limit: "decisions" },
  { name: "run.bundle", limit: "bundle" },
] as const;

const freeze = (p: KindProfile): KindProfile =>
  Object.freeze({
    ...p,
    inputFiles: Object.freeze({ required: Object.freeze([...p.inputFiles.required]), allowed: Object.freeze([...p.inputFiles.allowed]) }),
    outputs: Object.freeze(p.outputs.map((o) => Object.freeze({ ...o }))),
  });
const NO_INPUTS = { required: [], allowed: [] };

const PROFILES: Readonly<Record<RunKind, KindProfile>> = Object.freeze({
  worker: freeze({ kind: "worker", zone: "archon", egress: "egress-archon", prelude: "run.sh", workflow: undefined, inputs: false, inputFiles: NO_INPUTS, sidecar: true, extraBinds: none, outputs: WORKER_OUTPUTS }),
  fix: freeze({
    kind: "fix", zone: "archon", egress: "egress-archon", prelude: "run.sh", workflow: undefined, inputs: true,
    inputFiles: { required: [RUN_INPUTS.findings], allowed: [RUN_INPUTS.findings] }, sidecar: true, extraBinds: none, outputs: WORKER_OUTPUTS,
  }),
  // Its results are verify.json, held to result.json's limit; it commits nothing, so it leaves no bundle, and it runs no model, so no decisions.
  verify: freeze({
    kind: "verify", zone: undefined, egress: "egress-archon", prelude: "verify.sh", workflow: "factory-verify", inputs: false, inputFiles: NO_INPUTS, sidecar: true, extraBinds: none,
    outputs: [{ name: "result.json", limit: "result" }, { name: "transcript.jsonl", limit: "transcript" }, { name: "verify.json", limit: "result" }],
  }),
  // Its verdict and findings are the review node's structured output in its result.json and transcript (Tasks 11, 12):
  // there is no review.json. decisions.jsonl is a Pi-run review's (the portable roster); coderabbit.ndjson is CodeRabbit's CLI's.
  review: freeze({
    kind: "review", zone: "review", egress: "egress-review", prelude: "review.sh", workflow: "factory-review", inputs: true,
    // verify.json is absent when runs.phases.verify is off (design §3.5: every phase is a knob).
    inputFiles: { required: [RUN_INPUTS.diff], allowed: [RUN_INPUTS.diff, RUN_INPUTS.verify] }, sidecar: false, extraBinds: none,
    outputs: [
      { name: "result.json", limit: "result" },
      { name: "transcript.jsonl", limit: "transcript" },
      { name: "decisions.jsonl", limit: "decisions" },
      { name: "coderabbit.ndjson", limit: "decisions" },
    ],
  }),
});

/** The profile of `kind` (frozen: a caller that needs another, a test's, spreads it). Throws for a kind that isn't one. */
export function kindProfile(kind: RunKind): KindProfile {
  if (!RUN_KINDS.includes(kind)) throw new Error(`${JSON.stringify(kind)} is not a run kind (${RUN_KINDS.join(", ").replace(/, ([^,]+)$/, " or $1")})`);
  return PROFILES[kind];
}

/** The most outputs any kind copies out: a finalize's wait is sized for it (./lifecycle.ts `FINALIZE_WAIT_S`). */
export const MAX_OUTPUTS: number = Math.max(...RUN_KINDS.map((k) => PROFILES[k].outputs.length));

/** The zone whose proxy variables a container of `p` carries: the review zone's for a review, the archon zone's for every other kind. */
export function proxyZoneOf(p: Pick<KindProfile, "egress">): "archon" | "review" {
  return p.egress === "egress-review" ? "review" : "archon";
}

/** The proxy containers joined to a run of `p`'s network: the project's egress-archon (`RunDeps.egress`), or its egress-review. */
export function egressOf(d: Pick<RunDeps, "project" | "egress">, p: Pick<KindProfile, "egress">): string[] {
  return p.egress === "egress-archon" ? [d.egress] : [`${d.project}-egress-review-1`];
}
