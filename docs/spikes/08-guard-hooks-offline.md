# Spike 08: the guard's hooks, offline

- **Plan 02 Task 1 (spike T16)**, for Tasks 4, 5, 7 and 10. Run on 2026-10-29.
- **Where:** the operator's own Docker, in spike 07's run container (the same argv, prelude and env), with `--network none`. The API keys were fake (`fake-not-a-key…`). The only "provider" was a loopback fake inside the container, so nothing left it and no model was called. Objects were named `hapi-t15-run-t16-*` and removed afterwards.
- **Pi:** the SDK 1.3.0 embedded in Archon 0.12.1 (image `hapi-factory/archon:0.12.1`). The extension was built with the host's Bun 1.4.4 and loaded by the image's Bun 1.4.2.
- **Result: the hooks work as Task 5 plans, with two exceptions that change it.**
  - **Deleting a key from `process.env` doesn't keep it out of the shell.** Every name the factory deleted was back in the `bash` tool's environment (finding 7).
  - **Pinning only `compat.supportsMidConvoEffort` doesn't undo a planted catalog overlay.** The other compat flags stay lost, and the request changes (finding 9).
  - **The rest holds:**
    - the bundle loads under `BUN_OPTIONS=--no-install`;
    - `session_start` sees the pinned model;
    - `before_provider_request` sees `drop_block` and the binding beta, and the clamp works in place;
    - the auth header survives the delete, for Anthropic and OpenCode Go;
    - a `session_start` throw fails the node;
    - a factory throw leaves it unguarded, without a trace;
    - the guard-ran check can join on the attempt id.
  - **The portable roster's large tier, `opencode-go/kimi-k3.1-pro`, isn't in Pi 1.3.0's catalog,** and fails every node (finding 13).

## Setup

- **The test extension,** `spikes/scratch/16/ext/t16.ts`, imports only `node:fs`. It logs JSON lines to `/tmp/t16.log`, which the prelude copies to `/out`: names, shapes and non-secret ids, never a key's value. Its hooks:
  - **factory:** logs which secret names are set, then deletes `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `OPENCODE_API_KEY`, `HAPI_JEV_OPENROUTER_API_KEY` and a non-secret marker, `T16_DELETE_ME`;
  - **`session_start`:** logs `ctx.cwd`, `ctx.model` (provider, id, api, baseUrl, cost, compat, maxTokens, contextWindow, header names), `WORKFLOW_ID`, the parsed `ARCHON_NODE_EXECUTION`, the Pi directory's entries and the session file;
  - **`before_provider_request`:** logs the payload's keys, `max_tokens`, `thinking`, `betas`, `output_config` and the effort messages, then clamps `max_tokens` to 64000 in place;
  - **`before_provider_headers`:** logs the header names, and whether an auth header is among them;
  - **`tool_call`, `tool_result`, `message_end`, `turn_end` and `agent_end`:** log names, sizes and usage.

  `T16_MODE` switches on `factory-throw`, `session-throw`, `keep-keys` or `unset-prefix`.
- **The bundle:**
  - built by `spikes/scratch/16/build.ts`, which runs `Bun.build({ entrypoints: ["ext/t16.ts"], target, format: "esm" })` for `target: "node"` and `"bun"`;
  - the `node` output went to `extensions/t16.js`;
  - `build-banner.ts` checked a `banner` and that two builds give the same bytes.
- **Pi's directory:** a tmpfs, with `models.json`, `settings.json` (`{}`) and `extensions/` bound read-only. The `models.json` variants:
  - **`pi-agent/`, Task 4's pins:**
    - `providers.anthropic.baseUrl: https://api.anthropic.com`;
    - `modelOverrides` for `claude-haiku-5-5` and `claude-opus-5-5`: `{ maxTokens: 64000, cost: <catalog, tiers included>, compat: { supportsMidConvoEffort: true } }`;
    - the same for `opencode-go`'s `glm-5.3-flash` and `glm-5.3`, without `compat`;
  - **`pi-fake/`:** the same pins, with both providers' `baseUrl` on the loopback fake;
  - **`pi-fake-nopin/` and `pi-nopin/`:** no pins;
  - **`pi-fullcompat/`:** the pins with the catalog's whole `compat` object.
- **The fakes** (`spikes/scratch/16/fake/`, started by the prelude before Archon, on `127.0.0.1:18080`):
  - `server.py` answers 400 to everything. It logs the path, the header names, each auth header's **length** (never its value), `anthropic-beta`, and the body's `model`, `max_tokens` and `thinking`.
  - `script.py` plays a model: its first answer is one `bash` tool call, its second is `OK`, both with fixed usage (1000 in, 2000 out). The tool call prints which key names are in the shell's environment, and counts, never values.
- **The workflows** (`spikes/scratch/16/wf/`), each with one Pi node: `provider: pi`, `effort: low`, `allowed_tools: []` (`[bash]` for `t16-tool`), and `enableExtensions` from the `--config` run layer, as Task 6 ships it.
  - `t16-pi`: `anthropic/claude-haiku-5-5`, and run r1 had `retry: { max_attempts: 1, delay_ms: 1000, on_error: all }`;
  - `t16-opencode`: `opencode-go/glm-5.3-flash`;
  - `t16-kimi`: `opencode-go/kimi-k3.1-pro`;
  - `t16-plant`: a bash node copies a planted `models-store.json` into Pi's directory, then the Pi node runs;
  - `t16-tool`: the scripted tool call.
- **The plant:** the catalog's Haiku 5.5 entry with cost 0, no `compat` and `baseUrl: http://127.0.0.1:18080`, under `{ "anthropic": { "models": [...], "lastModified": 4102444800000 } }` (the year 2100, after the catalog's `generatedAt`).

## Evidence

Raw output is in `spikes/scratch/16/evidence/t16-<run>/` (`stderr.txt`, `out/t16.log`, `out/t16-fake.log`, `out/result.json`, `out/transcript.jsonl`).

| Run | What happened |
|---|---|
| bundle | `target=node`: line 1 `// ext/t16.ts` (Bun's entry-path comment), imports `["node:fs"]`. `target=bun`: line 1 `// @bun`, imports `["fs"]`. With `banner`, `node` puts the banner first, then a blank line, then the path comment; `bun` puts `// @bun` before the banner. Two builds were byte-identical, for both targets. The unused `node:path` import was dropped. |
| r1: `t16-pi`, pins, offline, retried once | **Loaded** under `BUN_OPTIONS=--no-install`. `factory` ran in `bun /app/packages/providers/src/community/pi/plugin.ts`, cwd `/app`, once per attempt (pids 116, then 149). `factory-deleted`: every name false. `session_start`: `cwd /work/repo`, model `anthropic/claude-haiku-5-5`, api `anthropic-messages`, baseUrl `https://api.anthropic.com`, cost `{0.1, 0.5, 0.01, 0.125, tiers >100000: 0.5/2.5/0.05/0.625}`, compat the catalog's six flags (`supportsMidConvoEffort: true` among them), maxTokens 64000, contextWindow 1000000, no headers. `ctx.mode` `print`, `hasUI` true. Pi dir: `auth.json, extensions, models-store.json, models.json, sessions, settings.json`. Each send fired `before_provider_headers` (`names: []`) and then `before_provider_request`: `max_tokens 64000`, `thinking {type: adaptive, display: summarized, block_binding: {prefix_mismatch_behavior: drop_block}}`, `betas [mid-conversation-output-config-2026-07-01, thinking-binding-controls-2026-08-01]`, `output_config {effort: high}`. Then `turn_end` with stopReason `error`, `Request timed out.`, usage all 0. Pi retried each attempt itself 3 times, at +2 s, +4 s and +8 s, each firing both hooks. Archon then ran attempt 2 in a new process, with a new `session_start`. The node failed: `provider reported unknown: Request timed out.` |
| r2: pins, fake Anthropic (400) | The wire request: `POST /v1/messages?beta=true`, **`x-api-key` present (14 bytes, the fake key's length) after the factory deleted `ANTHROPIC_API_KEY`**. `anthropic-beta: mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01`, `max_tokens 64000`, the same `thinking`. The hook's payload carried the active effort as a trailing message, `{role: system, output_config: {effort: low}}`. One request per attempt: a 400 isn't retried by Pi. |
| r3: no pins, fake, `keep-keys` | The hook saw `max_tokens 128000` (the catalog's). **The wire got 64000**, the in-place clamp. `x-api-key` was present (14 bytes), the same as r2. |
| r4: `opencode-go/glm-5.3-flash`, fake | `session_start`: provider `opencode-go`, api `openai-completions`, cost `{0.15, 0.5, 0.03, 0}`, compat `{supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: max_tokens}`, maxTokens 64000. `before_provider_headers` names: `x-opencode-client, x-opencode-session`. Payload: `max_tokens 64000`, `reasoning_effort low`. Wire: `POST /v1/chat/completions`, **`Authorization` present (21 bytes, `Bearer ` plus the key) after the factory deleted `OPENCODE_API_KEY`**. |
| r5: `factory-throw`, fake | Only the `factory` line was logged. **The request reached the fake with `x-api-key`: the node ran unguarded.** The node failed on the fake's 400. Nothing in stdout, stderr, the transcript or `result.json` mentions the extension. |
| r6: `session-throw`, fake | `[work] Failed: Node 'work' failed: provider reported unknown: Pi extension '/opt/hapi/pi-agent/extensions/t16.js' failed during 'session_start': T16: session-throw`. **The fake got no request.** |
| r7: plant, no pins, fake | `session_start`: **cost all 0, compat null, baseUrl `http://127.0.0.1:18080` (the planted one), maxTokens 128000.** Payload: `thinking {type: enabled, budget_tokens: 2048}`, `betas [interleaved-thinking-2025-05-14]`, so no `drop_block`. **The request went to the planted host, with the key.** |
| r8: plant, Task 4's pins | cost, maxTokens 64000 and baseUrl `https://api.anthropic.com` came back. **compat was only `{supportsMidConvoEffort: true}`.** The payload had `drop_block`, and betas `[interleaved-thinking-2025-05-14, mid-conversation-output-config-2026-07-01, thinking-binding-controls-2026-08-01]`: one more than r1. No request reached the fake. The store still held the plant afterwards. |
| r10: plant, the whole compat pinned | compat equals the catalog's six flags. Payload and betas are the same as r1's. |
| r9: `models-store.json` bound read-only as `{}` | The node ran normally: one `session_start`, one request to the fake, no error or warning in any log. |
| r11: `opencode-go/kimi-k3.1-pro` | `session_start` fired. Then: `Node 'work' failed: the provider's configuration must be fixed before it can run; retrying will not help: Pi model not found: provider='opencode-go' model='kimi-k3.1-pro'. … this model id is not in the Pi model catalog. If the model is newer than your catalog, refresh it with 'pi update --models'; Archon reads the refreshed store at /opt/hapi/pi-agent/m…`. No request was sent. |
| r12, r12b, r12c: `t16-tool`, scripted fake | **Completed.** `tool_call` bash: input keys `[command]`, cwd `/work/repo`; `process.env` still had every deleted name unset. `tool_result`: `[text]`, `structuredContent` keys `exit_code, output, truncated, wall_time_seconds`. **The shell's output (r12c): `ANTHROPIC_API_KEY`, `OPENCODE_API_KEY`, `CLAUDE_API_KEY`, `HAPI_JEV_OPENROUTER_API_KEY` and `T16_DELETE_ME` all `in the shell env`.** The Pi process's `/proc/$PPID/environ` and the Archon CLI's (the grandparent) both hold `ANTHROPIC_API_KEY`. `GIT_CONFIG_COUNT=13 BUN_OPTIONS=--no-install`, and `command /dev/null`. The tools sent to the model: `["bash","__pi_deferred_placeholder__"]`. Usage per call: 1000 in, 2000 out, `cost.total 0.0011` from the pinned prices. The node's `execution.spend.costUsd {source: provider, value: 0.0022}`, and `metadata.total_cost_usd 0.0022`. |
| r12d: `unset-prefix` | The `tool_call` handler set `event.input.command = "unset <the five names>\n" + command`. **All five were `not in the shell env`.** `/proc/$PPID/environ` and the grandparent's still hold the key. The transcript's `tool_call` event shows the original command, without the `unset`. |
| r1: the join (`out/result.json`, `out/transcript.jsonl`) | **`nodes[]` holds one entry for the node,** carrying the last attempt's `execution.attempt.id` (`8773e55b…`) and `sessionIds` for both attempts. The provider is at `execution.binding.provider: "pi"`; also `binding.model.requested: anthropic/claude-haiku-5-5` and `execution.node.kind: agent`. **The transcript holds a `node_start` and a `node_error` row per attempt.** Each has `execution.{runId, path: "work", attempt.id, binding.provider: "pi"}`: `ddd5f86b…`, then `8773e55b…`. These equal the guard's `ARCHON_NODE_EXECUTION` `runId`, `path` and `attempt.id`, attempt for attempt. `provider_event` rows carry `attemptId`. |

## Findings

1. **The bundle: `target: "node"` with a banner.** It keeps `node:*` specifiers and puts the banner on line 1, then Bun's `// <entry path>` comment. `target: "bun"` puts `// @bun` first and rewrites `node:fs` to `fs`. Builds are byte-identical, so the path comment is stable as long as the build root is.
   - **Ruling for Plan 02:** matches the plan (Task 4, `bundleEntry`). Its "starts with the // notice" test holds. Keep `root` fixed, since the path comment depends on it.
2. **The `.js` bundle loads from Pi's tmpfs directory under `BUN_OPTIONS=--no-install`.** The factory runs in Pi's own child process (`bun …/pi/plugin.ts`) with cwd `/app`, not the clone, so a repo's `bunfig.toml` doesn't reach it. A new process, a new factory and a new `session_start` come with each node attempt.
   - **Ruling for Plan 02:** matches the plan (Task 5; design §6a item 6).
3. **At `session_start`:**
   - `ctx.cwd` is `/work/repo`;
   - `ctx.model` has the resolved `baseUrl`, `cost` (tiers included), `compat`, `maxTokens` and `contextWindow`, with no `headers`;
   - `WORKFLOW_ID` is the run id;
   - `ARCHON_NODE_EXECUTION` is JSON `{runId, path, invocation: {id, startedAt, loopPath, checkoutStart}, attempt: {id, startedAt, checkoutStart}}`. **The attempt is an object with a uuid `id`, not a number.**
   - **Ruling for Plan 02:**
     - Task 5's decision-log record changes from `attempt: number` to `attempt: string`, holding `ARCHON_NODE_EXECUTION.attempt.id`;
     - `node` is `.path`, and `run` is `WORKFLOW_ID`;
     - the model checks at `session_start` match the plan, with the compat check widened by finding 9.
4. **At `before_provider_request`, the Anthropic payload has what H-184 needs.**
   - It carries `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, and `betas` includes `thinking-binding-controls-2026-08-01`.
   - The top-level `output_config.effort` is always `"high"` for these models. The node's effort (`low`) travels as a trailing `{role: system, output_config: {effort}}` message in `messages`.
   - Mutating `payload.max_tokens` in place reaches the wire (128000 became 64000), and the pin already gives 64000.
   - Pi retries a failed send up to 3 times within one attempt (connection errors; a 400 isn't retried), and each retry fires both hooks again.
   - **Ruling for Plan 02:** matches the plan (Task 5's clamp and payload checks). The guard must not assert the top-level `output_config.effort`. The budget hook must count each retry as a send.
5. **`before_provider_headers` fires before `before_provider_request`, and sees only extra headers.** For Anthropic its `headers` object was empty; for OpenCode Go it held `x-opencode-client` and `x-opencode-session`. The SDK adds auth, `anthropic-beta` and `anthropic-version` after the hook. So the guard can't see or check the auth header or the beta header there.
   - **Ruling for Plan 02:** Task 5: the budget's hard stop in `before_provider_headers` works as planned, since it fires on every send. A header-based check of `anthropic-beta` isn't possible there, so it stays the payload's `betas` check in `before_provider_request`. Not run here: Pi's compaction-summary requests, which by its source skip `before_provider_request` but still fire `before_provider_headers`.
6. **Auth survives `delete process.env.<KEY>` in the factory,** for Anthropic (`x-api-key`) and OpenCode Go (`Authorization: Bearer`). Archon sets the runtime key before the extensions load, so the request takes the key from there, not from the env.
   - **Ruling for Plan 02:** matches the plan. The guard doesn't need to keep `OPENCODE_API_KEY`, and there's nothing to register (Step 5(d)).
7. **Deleting keys from `process.env` doesn't keep them out of the shell.** Every name the factory deleted came back in the `bash` tool's environment, a non-secret marker included, while `process.env` in the extension stayed clean. Archon's bash spawn hook merges the request env, which is the Archon CLI's whole environment, over Pi's (`options-translator.ts`, `buildBashSpawnHook`). So design §6a item 10's "keeps keys out of the shell by deleting them from `process.env`" doesn't hold.
   - **What does work:** a `tool_call` handler that prefixes `unset <names>` to the bash command (r12d) clears them from the shell and its children. It has the same shape as Pi's own `commandPrefix` setting, which applies only to Pi's built-in `bash`, not Archon's. The transcript still records the original command.
   - **What stays:** the shell can still read the Pi process's and the Archon CLI's `/proc/<pid>/environ`, both of which hold the key. That is design §3.3 rule 8's "it isn't a boundary".
   - **The rest of the env reaches the shell, as wanted:** the git env config and `BUN_OPTIONS`.
   - **Ruling for Plan 02:**
     - **Task 5, rule 8:** keep the factory's delete, for the guard's own process, and add the `unset` prefix on every `bash` `tool_call`, naming `secret_env`. Neither is a boundary.
     - **Task 5's tests:** `the factory deletes every secret_env name from process.env` doesn't prove the property. Add `a bash tool_call's command is prefixed with unset <secret_env>`, and never unset `GIT_CONFIG_*` or `BUN_OPTIONS`.
     - **Task 10:** the threat model says the keys stay readable through `/proc/<parent>/environ`.
8. **A factory throw leaves the node unguarded, without a trace.** The request went out with the key, and no log, transcript row or `result.json` field names the extension. A `session_start` throw fails the node before any request, with `Pi extension '<path>' failed during 'session_start': <message>`.
   - **Ruling for Plan 02:** matches the plan (design §6a item 7). The factory never throws, and Task 7's guard-ran check is the only thing that catches a guard that didn't load.
9. **A planted `models-store.json` takes full effect unless the whole catalog entry's risky fields are pinned.** With no pins, Pi used the plant:
   - cost 0, which blinds the guard's budget and Archon's `max_spend_usd`;
   - no `compat`, so no `drop_block`, and budget-based thinking;
   - a planted `baseUrl`, so **the request, with the key, went to the planted host**.

   **Task 4's pins** (cost, `maxTokens`, `compat.supportsMidConvoEffort`, the provider's `baseUrl`) restored cost, `maxTokens`, `baseUrl` and `drop_block`, but not the other five compat flags. Without them the request gained `interleaved-thinking-2025-05-14`. **Pinning the catalog's whole `compat` object** gave exactly the unplanted request.

   **Binding `models-store.json` read-only as `{}`** ran without error, and a read-only bind can't be written, as `models.json` shows (spike 07's `Read-only file system`): that closes the vector. Pi didn't overwrite the plant during a run either. And per r11's error text, a planted store can also add models.
   - **Ruling for Plan 02:**
     - **Task 4:** each roster model's `modelOverrides` pins the catalog's whole `compat` object, not only `supportsMidConvoEffort`. Task 4's `pi.test.ts` expectation changes to match. Task 4 also generates `build/pi/models-store.json` as `{}`.
     - **Task 7:** `runArgs` binds that `{}` read-only at `/opt/hapi/pi-agent/models-store.json`, beside `models.json`.
     - **Task 5:** at `session_start`, compare the whole resolved `compat`, `cost`, `maxTokens` and `baseUrl` with `hapi-guard.json`'s `models` entry, and fail the node on any difference.
     - The read-only store closes the plant, and the pins and the guard's check stay as defence in depth.
10. **The guard-ran join.** `workflow get --json --verbose`'s `nodes[]` holds one entry per node, with only the last attempt's id (plus every attempt's `sessionIds`), so it can't show that each attempt was guarded. The transcript can: it has one `node_start` row per attempt. Each row's `execution.runId`, `execution.path` and `execution.attempt.id` equal the guard's `ARCHON_NODE_EXECUTION`. The provider is `execution.binding.provider` (`"pi"`), and the kind is `execution.node.kind` (`"agent"`).
    - **Ruling for Plan 02:** Task 7's guard-ran check reads `out/transcript.jsonl`.
      - **The attempts to check:** every `type: "node_start"` row with `execution.binding.provider == "pi"`.
      - **The join:** `(execution.runId, execution.path, execution.attempt.id)` = the decision log's `(run, node, attempt)` on a `session_start` record.
      - **The failure reason:** `guard did not run in node <path> attempt <attempt id>`.
      - r11's model-not-found failure still logged `session_start`, so a misconfigured model doesn't break the join. Not run: an attempt that fails before Pi's process starts.
11. **Cost and usage.** `message_end` and `turn_end` carry `usage.cost.total`, computed from the pinned prices (0.0011 for 1000 in and 2000 out on Haiku 5.5). Archon's node `costUsd` and the run's `metadata.total_cost_usd` (0.0022) equal the sum of the node's two assistant messages. A failed send reports zero usage.
    - **Ruling for Plan 02:** matches the plan (Task 5 rule 3).
12. **Tool events.** `tool_call` for `bash` carries `input.command`, and `ctx.cwd` is the clone. `tool_result` gives `content: [text]` plus `structuredContent {exit_code, output, truncated, wall_time_seconds}`. Pi also sends the model a `__pi_deferred_placeholder__` tool beside the node's `allowed_tools`.
    - **Ruling for Plan 02:** matches the plan (Task 5's rules 1, 6 and 7, and the result screen's wrap, which drops `structuredContent`). The placeholder goes in Task 5's notes. The scripted model never called it, so what a call to it does wasn't run.
13. **The catalog** (`spikes/scratch/16/pi-catalog-1.3.0.json`, for Task 4).
    - **Sources:** Pi 1.3.0's catalog, `generatedAt 2026-10-15T19:00:55.287Z`. sha256:
      - `anthropic.json`: `91f5da01452c7746645d3405bc91e09f849e4e4687c7c7ff22d8976eafe64b87`;
      - `opencode-go.json`: `39408ee6da7302e3202d7f7b27d31d4d50a05c340bebd7da25ee23755d506475`;
      - `.manifest.json`: `894a2cf1ce96333027615324165a5d377ad2ad450b4fe04b3d1810f08c1be5d0`.
    - **The roster models** (prices in USD per MTok: input / output / cache read / cache write):

      | Model | Prices | maxTokens | contextWindow | `supportsMidConvoEffort` | baseUrl |
      |---|---|---|---|---|---|
      | `anthropic/claude-haiku-5-5` | 0.1 / 0.5 / 0.01 / 0.125, and above 100000 input tokens 0.5 / 2.5 / 0.05 / 0.625 | 128000 | 1000000 | true | `https://api.anthropic.com` |
      | `anthropic/claude-opus-5-5` | 4 / 20 / 0.2 / 5 | 128000 | 1000000 | true | `https://api.anthropic.com` |
      | `opencode-go/glm-5.3-flash` | 0.15 / 0.5 / 0.03 / 0 | 131072 | 1000000 | none | `https://opencode.ai/inference/go/v1` |
      | `opencode-go/glm-5.3` | 1.4 / 4.4 / 0.26 / 0 | 131072 | 1000000 | none | `https://opencode.ai/inference/go/v1` |

    - **`opencode-go/kimi-k3.1-pro` (the portable roster's large tier) is not in the catalog.** The nearest are `kimi-k3` and `kimi-k2.7-code`. A node on it fails with `Pi model not found` (r11).
    - **Not run:** `glm-5.3`'s `thinkingLevelMap.medium` is `null`, and the portable roster runs it at `effort: medium`.
    - **Ruling for Plan 02:**
      - **Task 4:** `pi-catalog-1.3.0.json` comes from this file. The generator refuses every Pi roster model the pinned catalog lacks, not only Anthropic ones (H-184's check, widened): `policy/rosters/portable.yaml: opencode-go/kimi-k3.1-pro: not in Pi 1.3.0's catalog`.
      - **The register:** the portable roster's large tier needs the operator's choice of model, and the `glm-5.3` medium effort needs checking. `policy/rosters/portable.yaml` is protected, so both go to the register, not to an edit here.

## Decision

hapi-guard keeps the shape Task 5 plans: one `node`-target bundle that registers no tools, with these hooks:
- `session_start` for the settings, model and directory checks;
- `before_provider_request` for the clamp and the payload checks;
- `before_provider_headers` and `turn_end` for the budget.

Four rulings change later tasks:
- **Task 5:** the attempt is a string id; rule 8 adds an `unset` prefix to every bash command, since deleting from `process.env` doesn't reach the shell; and `session_start` compares the whole pinned model entry.
- **Task 4:** the pins carry the catalog's whole `compat`; it generates a `{}` `models-store.json`; and it refuses any Pi roster model the catalog lacks.
- **Task 7:** `runArgs` binds the `{}` `models-store.json` read-only, and the guard-ran check joins the transcript's per-attempt `node_start` rows on `(runId, path, attempt.id)`.
- **The register:** the portable roster's `kimi-k3.1-pro` has no Pi 1.3.0 model behind it.

## Consequences

- **Task 4:**
  - `src/generate/pi-catalog-1.3.0.json` from the capture, with its sha256s;
  - each pin's `compat` is the catalog's whole object;
  - `build/pi/models-store.json` is generated as `{}`;
  - the refusal covers every Pi roster model.
- **Task 5:**
  - `attempt: string`;
  - the `unset` prefix on `bash`, plus its test;
  - the whole-model comparison at `session_start`;
  - no header-based beta check;
  - the budget counts Pi's in-attempt retries.
- **Task 7:**
  - the read-only `models-store.json` bind;
  - the guard-ran join reads `transcript.jsonl`'s `node_start` rows where `execution.binding.provider` is `pi`.
- **Task 10 (threat model):**
  - the keys stay readable through `/proc/<parent>/environ` (finding 7);
  - a factory throw is silent (finding 8);
  - the catalog-overlay vector, and what closes it (finding 9).
- **The register:** the portable roster's large tier (`opencode-go/kimi-k3.1-pro`, not in the catalog), and `glm-5.3` at `effort: medium` (not run).
