# Spike 03: Archon budget, trigger inputs and environment

- **Plan 01 Task 10**, for Plan 03 (the run engine and the poller). Run on 2026-10-28.
- **Archon:** v0.12.1, the stack's pinned image, with the Pi SDK 1.3.0 it embeds.
- **Result: all three work, with limits Plan 03 must design around.**
  - **The budget** loads and stops a run, but its ceiling is soft by one node.
  - **Trigger inputs** reach bash nodes as `$INPUTS_*`. A repeated delivery ID starts no second run, and is refused with different inputs, so the poller needs one ID per work order.
  - **`WORKFLOW_ID`** reaches every node, Pi's shell included, and so does a `TRACEPARENT` exported into the process that runs the workflow. The `traceparent` input does not become `TRACEPARENT`.

## Setup

- **Where:** the operator's own Docker, as its own Compose project, `hapi-t10`. `down -v` removed it afterwards. The Archon service was set up as in spike 01: the Pi directory on a tmpfs, with hapi's files bound read-only into it (H-181).
- **A probe extension**, `t10-probe.ts`, in `PI_CODING_AGENT_DIR/extensions/`. It logs whether `WORKFLOW_ID` and `TRACEPARENT` are set in the Pi process, and blocks every bash command but one: `env | grep -E '^(WORKFLOW_ID|TRACEPARENT|ARCHON_NODE_EXECUTION|ARCHON_CLI_COMMAND|INPUTS_[A-Z0-9_]+)=' | sort`. So the model could never print the archon zone's keys.
- **Workflows**, all of which passed `validate workflows` with no issues:
  - **`t10`:** `budget: { max_spend_usd: 0.05 }`, declared inputs `work_order_id` and `traceparent`, and three nodes: bash `before`, a Pi node `probe` that runs the probe command (`allowed_tools: [bash]`), and bash `after`.
  - **`t10-tiny`:** `max_spend_usd: 0.0001`, a Pi node `first`, then a Pi node `second` and a bash node `after`, both depending only on `first`.
  - **`t10-env`:** a bash node running `env | grep -E '^(TRACEPARENT|WORKFLOW_ID)='`, then the Pi probe.
- **The trigger.** In 0.12.1, `trigger fire` takes `--config <timer-binding.json>`, and `--inputs` names a *file*, not a JSON string as Task 10 wrote it. The binding has:
  - `version: 1` and `sourceInstanceId: t10-spike`;
  - `bindingId`, `hostId: t10-host`, and `runAsUserId` from `archon trigger whoami`, which needs `$USER` or `ARCHON_USER_ID`, and the container sets neither;
  - `resource: github:example/t10:factory`, with `overlap: queue`;
  - `launch: { cwd: /tmp/target, workflowName: t10, inputs: {}, isolation: { kind: in-place } }`;
  - a `schedule`.

  ```bash
  archon trigger fire --config /tmp/t10-trigger.json --delivery-id spike-1 --inputs /tmp/t10-inputs.json
  ```

  The inputs file: `{ "work_order_id": "w1", "traceparent": "00-5bb585c1…-4a49671b…-01" }`.

## Evidence

| Check | Result |
|---|---|
| The budget loads | `t10` and `t10-tiny` validate, and `t10` ran to `completed`, at a cost of $0.0006. |
| Inputs in bash nodes | `before: INPUTS_WORK_ORDER_ID=w1 INPUTS_TRACEPARENT=00-5bb585c1…-01 WORKFLOW_ID=3559dfd3-…`, and `after` the same. The receipt recorded them as the binding's `eventInputs`, which Archon hands only to a workflow that declares them. |
| Pi's shell | It printed `ARCHON_CLI_COMMAND=["/usr/local/bin/bun","--no-env-file","/app/packages/cli/src/cli.ts"]`, `ARCHON_NODE_EXECUTION={"runId":…,"path":"probe",…}` and `WORKFLOW_ID=3559dfd3-…`. **No `INPUTS_*`, and no `TRACEPARENT`.** The extension logged `WORKFLOW_ID="3559dfd3-…" TRACEPARENT=unset` in the Pi process. |
| The same delivery ID again | The same receipt (`52adfe74-…`) and the same run (`3559dfd3-…`). No second run, and `trigger list` shows one receipt. |
| One delivery ID, two work orders (a follow-up, after PR #8's review) | In a throwaway container from the same image, with no network, and a bash-only workflow declaring `work_order_id`. `--delivery-id sha1` with `w1` admitted a run. `sha1` with `w2` exited 1: "Delivery ID 'sha1' was already used with different inputs". `sha1` with `w1` again returned the first receipt and run. `sha1:w2` with `w2` admitted a second run. Each run's bash node printed its own work order. |
| `TRACEPARENT` exported into `workflow run` | Both the bash node and Pi's shell printed it unchanged (`00-8d5ea97a…-01`), and the Pi process had it at load. |
| `TRACEPARENT` exported into `trigger fire` (a new delivery ID) | The triggered run's Pi shell printed it, so the detached run inherits `fire`'s environment. |
| What `fire`'s exit means | It exited 0 while the run was still `pending`. The run went on in a detached process and was `completed` about 2 s later. |
| The budget stop (`t10-tiny`) | `first` ran and cost $0.000165, over the $0.0001 ceiling. Then `dag.run_budget_refused` with `spend_exhausted` for **both** `second` (Pi) and `after` (bash): "Workflow 't10-tiny' reached its run budget of $0.0001 ($0.0002 spent); node 'second' was not started. Resuming this run refuses again". The run failed, exit 1. |
| Egress | 5 tunnels, all `api.anthropic.com`. |

## Findings

1. **The budget's ceiling is soft by one node.** Archon admits each AI attempt only while spend is below `max_spend_usd` (`admitRunBudgetAttempt` in `packages/workflows/src/run-budget.ts`). So the attempt that crosses the ceiling always finishes, and a run can overshoot by a whole node's cost. Afterwards every node is refused, bash ones included, and resuming refuses again.
   - **A spend-limited run is also refused once any node's cost is unknown.** The source names a resumed Claude session, or an attempt that failed with a provider error such as a rate limit.
   - **So:** `max_spend_usd` bounds the number of nodes, not dollars. The in-node cap is hapi-guard's (`budgets.run_usd`, H-087), and the hard cap is the provider's (GR-7).
2. **Trigger inputs are bash-only, and bash nodes are checked.** A declared input reaches bash and script nodes as `INPUTS_<UPPER_SNAKE>`. It doesn't reach an AI node's environment; an AI node gets inputs only through its prompt. The validator rejects a bash node that reads a variable no binding, input or engine provides, so `$TRACEPARENT` can't be read by name unless it is configured.
3. **Delivery IDs deduplicate, so the key is per work order.** Archon keys a receipt on `(sourceInstanceId, deliveryId)`, and with a delivery ID its content digest covers only the event inputs (`packages/cli/src/commands/trigger.ts`). So re-firing the same ID with the same inputs returns the first receipt and run, and a re-fire is safe. The same ID with different inputs is refused (`SourceReceiptDigestConflictError`). A planning PR can carry several work orders, each with its own run (spec §5.3), so a bare `--delivery-id <merge-sha>`, as spec §9.4 had it, would start the first and refuse the rest. The merge fire's key is `<merge-sha>:<work-order-id>`, and a rework round needs its own.
4. **`fire` returns at admission, not completion.** The poller can't take `fire`'s exit code as the run's result. The run's own status (`archon workflow get <run-id>`) or the harvester's ref (`refs/hapi/<run-id>`) is.
5. **Trace context travels by process environment.** A `TRACEPARENT` exported into `fire` or `workflow run` reaches every node of the run that process starts, Pi's shell included. That settles spec §13.4's `[verify]` for that case. The `traceparent` input is only `$INPUTS_TRACEPARENT` in bash nodes. **Untested, and worth checking in Plan 03:** a request queued behind another run on the same resource (`overlap: queue`) is executed by whichever process drains it later, with that process's `TRACEPARENT`. One per-process variable can't carry a per-request trace, so the reliable source is the request's own `traceparent` input.
6. **Pi's shell can run Archon's CLI.** `ARCHON_CLI_COMMAND` (the `bun … cli.ts` command) and `ARCHON_NODE_EXECUTION` are in every AI node's environment (`buildAiNodeEnvironment` in `packages/workflows/src/exec-environment.ts`). So a Pi step can call `archon`, including answering approvals and changing run state. This is spec §4.3's concern and Residual 1's, now seen.
7. **`trigger fire` needs a user and a binding file.** `runAsUserId` comes from `archon trigger whoami`, run with the same `/.archon` as the host and a `USER` or `ARCHON_USER_ID`. The poller writes the binding and inputs files; the Task 10 command (`--inputs '<json>'`, no `--config`) doesn't run on 0.12.1.

## Decision

The poller-to-trigger design stands (spec §9.4): `trigger fire` with a binding per repo, a delivery ID, and the work order's values as a declared `inputs:`. Four changes:
- **Delivery IDs:** one per work order, `<merge-sha>:<work-order-id>`, since one merge can carry several.
- **Run results:** the poller reads them from the run's status, not from `fire`.
- **Trace context:** it comes from the request's `traceparent` input.
- **Spend:** `max_spend_usd` counts as a node-count bound, never a dollar cap.

## Consequences

- **Plan 03 (H-183):** findings 1 to 7, in how `factory-task` declares its budget and inputs, how the poller writes bindings and delivery IDs and reads results, how trace context is set per request, and how Pi's access to `ARCHON_CLI_COMMAND` is limited.
- **The threat model:** IS-9 records the budget's semantics, and Residual 1 cites finding 6.
- **Spec §13.4:** the `[verify]` on trace context and detached runs is settled for an exported `TRACEPARENT`, and the queued case is open.
- **Spec §9.4 and §18:** the poller fires one delivery ID per work order, which settles §18's trigger-key item (finding 3).
