/**
 * The kinds of run the engine starts (design §3.1, §3.4): the `worker` that does a work order's pieces, the
 * `verify` that runs its repo's gates, the `review` of its diff, and a `fix` round on a review's findings. Every
 * kind still runs the worker's container (src/run/spec.ts); Plan 03 Task 8 gives each kind a profile of its own.
 */
export type RunKind = "worker" | "verify" | "review" | "fix";

export const RUN_KINDS: readonly RunKind[] = ["worker", "verify", "review", "fix"];

/**
 * The CodeRabbit CLI step's own bound in a review run (`timeout 1800 cr review ...`, Task 11's `coderabbit` node),
 * in seconds. A review run's deadline adds it to the work order's `budget.minutes` when `runs.phases.coderabbit` is
 * on, so the supervisor never stops a review while its CLI step is still inside its own bound (ruling m17).
 */
export const CODERABBIT_CLI_TIMEOUT_S = 1800;
