# Spike 04: Anthropic's history-editing check, and Agent SDK billing

- **Plan 01 Task 11**, for Plans 02, 04 and 06 (the worker, the coordinator, evals). Run on 2026-10-28.
- **Images:** Hermes v0.22.5 and Archon 0.12.1, the stack's pinned ones, with the Pi SDK 1.3.0 Archon embeds.
- **Result: nothing breaks, on this account or on one that enforces the check.**
  - **This account isn't enforced.** An edited history with a replayed thinking block is accepted, on Haiku 5.5, Sonnet 5.5 and Opus 5.5.
  - **Pi** sends `drop_block` itself, so compaction costs the kept turn's reasoning, not a failure. That protection is per model, though, and without it Pi fails the node.
  - **Hermes** breaks the history at every compression, and on an enforced account recovers after one rejected request.
  - **The Claude-provider node** ran on the archon zone's API key, its only credential. Whether the Console shows it billed to `hapi-factory`, and so to the API credit, is open (H-187), because the Console's usage was hours behind.

## The check

Claude 5.5 models bind each thinking block to the conversation before it: the `system` prompt, the `tools` list and every earlier message. When a request replays a block after any of those changed, the API acts on the mismatch.
- **Enforced by default:** for accounts created on or after 2026-08-31. Such a request is a 400.
- **On older accounts:** the block passes, unless the request opts in through `thinking.block_binding.prefix_mismatch_behavior`, under the beta `thinking-binding-controls-2026-08-01`. `"error"` gets the enforced 400; `"drop_block"` drops the block and reports it.
- **Where it bites:** compaction that summarizes older turns but replays newer ones with their thinking (Anthropic's model migration guide, "preserved thinking").

## Setup

- **Where:** the operator's own Docker, as its own Compose project, `hapi-t11`. `down -v` removed it afterwards.
- **Keys:** the plan named the `hapi-evals` key, which doesn't exist yet (the evals plan adds it, docs/runbooks/provider-keys.md). So the spike used the zones' own keys, as spikes 01 and 03 did: the hermes zone's (workspace `hapi-hermes`) for the probe and Hermes, the archon zone's (`hapi-factory`) for Pi and the Claude node.
- **The direct probe**, `probe.py`, run in the hermes container with the API through the zone's proxy. Per model:
  1. a question, with adaptive thinking at effort `high`; each answer carried one signed thinking block;
  2. that history replayed unchanged, with a follow-up question;
  3. the same, with the first user turn edited (`09:40` to `09:45`) and no beta header;
  4. the edit, with the beta and the field unset;
  5. the edit, with `"error"`;
  6. the edit, with `"drop_block"`.
- **Hermes:** the stack's `hermes` and `egress-hermes` services, with `mise run policy:build`'s config plus three changes: `model.default: claude-haiku-5-5`, Slack off, and a compression trigger the spike could reach:

  ```yaml
  compression:
    enabled: true
    threshold_tokens: 19000   # the session's first request was 16,107 input tokens: system and tools
    tail_mode: legacy
    target_ratio: 0.10
    protect_first_n: 1
    protect_last_n: 2
  ```

  - **A spike-only `sitecustomize.py`**, bind-mounted into the container's `site-packages`, wrapped the Anthropic SDK's `Messages.create` and `Messages.stream`. It logged each request's shape: roles, block types, a short hash of each thinking signature, and hashes of `system` and `tools`, never text. With a mode file holding `error`, it also added the beta and `"error"`, the check an enforced account gets by default.
  - **The turns** were `hermes chat -Q --oneshot --reasoning high --resume <session> -q …`, each solving a one-line equation and listing 12 or 40 facts, so each one thought and grew the history. The requests come from the gateway process, which the CLI talks to.
- **Pi:** the stack's `archon` and `egress-archon`, with the Pi directory on a tmpfs as in spike 01 (H-181), holding:
  - a test `models.json`: `contextWindow: 16000` and `maxTokens: 4000` for Haiku 5.5;
  - a `settings.json` with `compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 4000 }`;
  - a probe extension, `t11-probe.ts`. It logged each request's thinking settings, betas, roles and block types; each response's status; Anthropic's `input_transformations` from `message_start`; and each compaction. It allowed only `read` of `docs/<letter>.txt`.

  The workflow `t11-pi-haiku` had one Pi node (`allowed_tools: [read]`) reading five files of about 6K tokens one at a time, then summing their `MAGIC` lines. For the control, the extension replaced Pi's `drop_block` with `"error"` (`before_provider_request` can replace the payload).
- **Opus 5.5 and Sonnet 5.5** ran in the probe only. Neither harness's replay path branches by model within the 5.5 family:
  - Hermes replays all prior thinking from Haiku 5.5, Sonnet 4.6 and Opus 4.5 up (`agent/anthropic_thinking_policy.py`);
  - Pi's `drop_block` follows a catalog flag that all three carry (finding 3).

  So the harness runs stayed on Haiku 5.5, and Opus's prices stayed out of them.
- **The Claude node,** `t11-claude`: one `provider: claude` node on `claude-sonnet-5-5`, with the prompt "Reply with the single word OK, and use no tools."

## Evidence

**The direct probe.** Input tokens are in brackets; a dropped block isn't billed.

| Request | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|
| Unchanged replay | 200 (323) | 200 (245) | 200 (229) |
| Edited, no header | 200 (323) | 200 (245) | 200 (229) |
| Edited, beta, field unset | 200, `thinking_mismatch_allowed` at `messages.1.content.0` | the same | the same |
| Edited, `"error"` | 400 | 400 | 400 |
| Edited, `"drop_block"` | 200 (99), `thinking_dropped`, `prefix_binding_mismatch` | 200 (101), the same | 200 (99), the same |

The 400, the same on all three: "`messages.1.content.0`: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". Content before this block differs from when it was created, first at `messages.0.content.0`."

**Hermes, on Haiku 5.5.**

| Run | What happened |
|---|---|
| Session 1, `"error"` | Turns 2 and 3 were append-only, with the same `system` and `tools` hashes. At turn 4 a compression "made no progress". At turn 5 one ran its summary call, then logged "Compaction tool refresh added tools: ['skill_manage']" and "Compaction rebuilt a drifted system prompt (11692 -> 12206 chars)". The compression itself was refused, since the summary would have been larger. The request then went out with the new `system` and `tools`, and got the 400: "The `system` prompt and the `tools` list both differ from when this block was created". Hermes logged "Thinking block signature recovery: suppressed rejected Anthropic replay blocks from 3 carrier/message(s) (canonical messages unchanged)", resent without them, and the turn completed. On the next turn the system prompt changed once more, with no compression: the same 400 and recovery (2 blocks). This session had been restarted after turn 1 to load the compression settings. |
| Session 2, `"error"` | A fresh session, with no restart. At turn 4 the compression committed (7 messages to 3), with the same tool refresh and system-prompt rebuild. The next request carried the kept reply's thinking block: one 400, one block suppressed, and the turn completed. At turn 5 it committed again (5 to 3): the same. Then Hermes stopped compressing (`compression_ineffective_count: 2`) until its recovery deadline. |
| Session 2, as shipped | With the hook off, a later compression committed (15 to 3). The next request replayed the kept reply's thinking block with no header: 200. |

**Pi, on Haiku 5.5.**

| Run | What happened |
|---|---|
| As shipped | Every request had `thinking: {"type": "adaptive", "display": "summarized", "block_binding": {"prefix_mismatch_behavior": "drop_block"}}` and the betas `mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01` and `inline-tools-2026-09-15`. Pi compacted mid-run three times. Each request after a compaction had the shape `user[summary] … assistant[thinking+signature, text, tool_use] user[tool_result]`, and Anthropic answered 200 with `thinking_dropped` (`prefix_binding_mismatch`) at `messages.2.content.0`, on every request after, since Pi keeps sending the block. The node completed with the right sum (70), for $0.0089. The compactions cost context: the model lost a value it had read, and read `a.txt` again. |
| `"error"` | The first request after the first compaction got the 400 ("Content before this block was rewritten since it was created"), then "Node 'read' failed: provider reported unknown: 400 …", and the workflow failed, exit 1. Pi didn't retry. $0.0018. |

**The Claude node.** It completed ("OK", 3.1 s) from 18:30:15 to 18:30:19 UTC, and Archon recorded `costUsd` from the provider: $0.0498. The operator checked the Console a few minutes later:
- **API keys:** `hapi-hermes` showed $0.17, which also covers spikes 02 and 06. `hapi-factory` showed $0.01.
- **Usage for `hapi-factory`:** only Haiku 5.5, 110,582 tokens in over 30 days.

That's less than this spike's Pi runs alone used, plus spikes 01 and 03. The Pi runs' own requests used 91,353 input tokens over 12 requests, by Anthropic's usage fields, before their four compaction summary calls. So the Console was behind, and didn't show the Sonnet 5.5 call yet.

**Egress.** The hermes zone: 84 tunnels to `api.anthropic.com` and 4 to `openrouter.ai`. It refused `hermes-agent.nousresearch.com` (8), `raw.githubusercontent.com` (8) and `portal.nousresearch.com` (4), as in spikes 02 and 06. The archon zone: 10, all to `api.anthropic.com`.

**Spend: about $0.21.**
- `hapi-hermes`: about $0.15. The probe was about $0.03. Hermes's two sessions were $0.107 from its own token counts at Haiku 5.5's prices, plus its title and summary calls.
- `hapi-factory`: $0.06. The Pi runs were $0.0089 and $0.0018, and the Claude node $0.0498.

## Findings

1. **This account isn't enforced.** On all three models, an edited history with its thinking block replayed was accepted without the header, and the block reached the model: the input tokens matched the unchanged replay. With the beta, the API flagged it `thinking_mismatch_allowed`. So the operator's organization isn't enforced, which by Anthropic's rule means it was created before 2026-08-31, and nothing in hapi fails on it today.
   - **But others are enforced.** Anyone who runs hapi-factory from an account created since then gets the 400 by default, and so would a new organization of the operator's.
   - **So test as enforced.** A request that opts in with `"error"` reproduces it exactly, and the operator's own runs won't show the failure otherwise.
2. **Pi as shipped is safe on either kind of account.** Pi 1.3.0 sends the beta and `drop_block` on every request (`buildParams` in `pi-ai/dist/api/anthropic-messages.js`), which opts it in to the check with dropping. After each compaction, Anthropic drops the kept turn's reasoning and reports it, and the node carries on.
   - **The costs:** that turn's thinking, and the same drop reported again on each later request.
3. **That protection is per model, and Pi has no fallback.** Pi sends `drop_block` only for a model whose catalog entry has `compat.supportsMidConvoEffort: true`, as Haiku 5.5, Sonnet 5.5 and Opus 5.5 do in 1.3.0.
   - **Without it, the node fails:** with `"error"`, the first request after a compaction got the 400, and Pi failed the node without retrying.
   - **Which models lack it:** a custom `models.json` entry, a Claude model newer than Pi's catalog, or Claude through another route such as OpenRouter. On an enforced account, each would fail its node at its first compaction.
   - **A `models.json` override can turn the flag off** (`compat` is overridable). hapi's generated file doesn't, today.
4. **Hermes breaks the history at every compression, and recovers.**
   - **Why each compression breaks it:** a compression that commits replaces the middle of the history while the kept tail keeps its thinking. Hermes's compaction also rebuilds a "drifted" system prompt and refreshes the tools list (adding `skill_manage`), even when the compression is refused.
   - **What happens next:** on an enforced account, the next request is a 400. Hermes's signature recovery (`agent/anthropic_thinking_replay.py`) strips the rejected blocks from the request copy and resends, and the turn completes. That was seen four times, and no turn failed.
   - **The cost of each compression:** one rejected request (rejected before any output), the kept turns' reasoning, and a full prompt-cache rewrite, since `system` and `tools` changed. That rewrite is about 16K tokens: on Opus 5.5, about $0.08 at $5 per million for cache writes.
   - **On this account,** the stale blocks reach the model without a word.
   - **Not explained:** why the system prompt grew 11,692 to 12,206 characters and `skill_manage` appeared only at compaction. It was the same in a session with no restart, so the spike's mid-session config change didn't cause it.
5. **Hermes's compression backs off.** After two compressions that left the context near the trigger, Hermes stopped compressing until a recovery deadline (`compression_ineffective_count: 2`). This has nothing to do with the check, but Plan 04's compression settings have to sit well above the base prompt, which was 16K tokens here.
6. **Billing is open.** The node's only credential was the archon zone's API key. The zone has no `CLAUDE_CODE_OAUTH_TOKEN`, and the spike's fresh home volume held no Claude login. So it can only have billed to `hapi-factory`'s key, which draws on the API credit. API-key usage never draws on a Claude subscription.
   - **Not proof:** Archon's $0.0498 is Claude Code's own estimate, which it makes however it is authenticated.
   - **What settles it:** the operator seeing the call in the Console (H-187).

## Decision

Both harnesses stay as they are for v1, since neither fails, on this account or on an enforced one. hapi holds the protection that keeps it so:
- **Pi:** every Anthropic model hapi runs keeps Pi's `drop_block`.
- **Hermes:** Plan 04 decides whether one rejected request per compression is acceptable, or whether to keep `system` and `tools` fixed from the session's start.
- **Evals:** they run opted in to `"error"`, so hapi is tested as an enforced account sees it.

## Consequences

- **Plan 02 (H-184):** Pi's `drop_block` for every Anthropic model in the rosters.
- **Plan 04 (H-185):** Hermes's compression under the check, and its settings.
- **Plan 06 (H-186):** testing opted in to the check, and the `hapi-evals` key.
- **Spec §12:** the `[verify early]` on the history check is settled. The billing `[verify]` waits on the Console (H-187).
