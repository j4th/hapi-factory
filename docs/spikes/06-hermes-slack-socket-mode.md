# Spike 06: Hermes's Slack gateway in Socket Mode

- **Plan 01 Task 13**, for Plan 04 (the coordinator's gateway). Run on 2026-10-28.
- **Hermes:** v0.22.5, the stack's pinned image (`stack/hermes/Dockerfile`).
- **Result: passes.** The gateway connects over Socket Mode through the hermes zone's proxy and opens no inbound port. It answers the allowlisted member and drops another member's DM without any reply.

## Setup

- **Where:** the operator's own Docker, not the `hapi` user's rootless Docker; that is stage b (H-080). It ran as its own Compose project, `hapi-t13`, so its volume and networks were never the real stack's, and `down -v` removed them afterwards.
- **What:** the stack's own `hermes` and `egress-hermes` services from `stack/compose.yaml`, with the hermes zone's secrets from `hapi secrets resolve` (the Anthropic key and the three Slack values) and the config `mise run policy:build` generates (roster `anthropic`).
- **One change**, in a gitignored override under `spikes/scratch/13/`: the generated `config.yaml` plus the setting docs/runbooks/slack.md lists for Plan 04 to compile, mounted read-only over `/opt/data/config.yaml`:

  ```yaml
  slack:
    unauthorized_dm_behavior: ignore
  ```

  ```bash
  docker compose -p hapi-t13 -f stack/compose.yaml -f spikes/scratch/13/compose.t13.yaml up -d --build --wait hermes
  ```

- **Slack:** the workspace and app as docs/runbooks/slack.md sets them up (H-066). The allowlist holds only the operator's member ID. A second workspace member, not on it, played the stranger.

## Evidence

Slack IDs are shown as `[slack-id]`.

1. **Socket Mode, through the proxy.** Hermes's `gateway.log`:

   ```text
   INFO hermes_plugins.platforms__slack.adapter: [Slack] Using proxy for Slack transport: http://egress-hermes:3128
   INFO hermes_plugins.platforms__slack.adapter: [Slack] Authenticated as @hermes in workspace hapi-factory (team: [slack-id])
   INFO hermes_plugins.platforms__slack.adapter: [Slack] Socket Mode connected (1 workspace(s))
   INFO gateway.run: ✓ slack connected
   ```

   The healthcheck (`hermes gateway status` prints "Gateway is running") passed within 10 seconds of the start.
2. **No inbound port.** No port is published (`docker ps`, and the compose config has none). `ss` isn't in the image, so the listeners come from `/proc/net/tcp` and `/proc/net/tcp6` (state `0A`), and their owners from each socket's inode under `/proc/<pid>/fd`. All are loopback:

   | Listener | Owner |
   |---|---|
   | `127.0.0.1:8642` | the `hermes` process: its API server |
   | `127.0.0.1:38179` | the `hermes` process |
   | `127.0.0.11:37737` | no process in the container: Docker's embedded DNS |

   The zone network, `hapi-t13_hermes-net`, is `internal: true`. PR #5's review asked for UDP too, so the gateway was started again the same way (connected, no message sent) and stopped: `docker port` printed nothing for either container, and the only UDP socket was on `127.0.0.11`, owned by no process in the container, so Docker's DNS.
3. **The operator's DM is answered.** "Reply with just the word pong, and don't use any tools." was logged as `inbound message: platform=slack ...`, then `response ready: ... time=4.1s api_calls=1 response=202 chars`. The reply was "pong" plus Hermes's home-channel prompt (finding 3).
4. **The stranger's DM gets nothing.** (DMs only: a stranger's channel messages are finding 5.) `WARNING ... [Slack] Early reject of unauthorized user [slack-id] in channel [slack-id]`. There is no `inbound message`, no session and no API call. `/opt/data/sessions` holds one session, the operator's. The stranger saw no reply, not even a pairing prompt.
5. **Egress.** The proxy's log for the whole run. Squid logs a tunnel when it closes, so the WebSocket shows up only after `stop`.

   | Count | Result | Host |
   |---|---|---|
   | 26 | `TCP_TUNNEL/200` | `slack.com` |
   | 1 | `TCP_TUNNEL/200` | `wss-primary.slack.com`: the Socket Mode WebSocket, open 610 s |
   | 6 | `TCP_TUNNEL/200` | `api.anthropic.com` |
   | 1 | `TCP_TUNNEL/200` | `openrouter.ai` |
   | 2 | `TCP_DENIED/403` | `hermes-agent.nousresearch.com` |
   | 2 | `TCP_DENIED/403` | `raw.githubusercontent.com` |
   | 1 | `TCP_DENIED/403` | `portal.nousresearch.com` |

   Every host let through is on the hermes zone's list in `policy/trusted_sources.yaml`; `.slack.com` covers `wss-primary.slack.com`.
6. **The env names (H-065).** The running binary read `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_ALLOWED_USERS` as `stack/secrets.yaml` maps them: it authenticated, connected and applied the allowlist. The research container wasn't run, so `BRAVE_SEARCH_API_KEY` and `EXA_API_KEY` move to H-099, as H-065 says.
7. **Cleanup.** `docker compose -p hapi-t13 ... down -v` removed both containers, the `hapi-t13_hermes-data` volume (and the test session in it) and both networks. None of them is left.

## Findings

1. **The generated config has no version stamp.** `errors.log` says: `config migration skipped: This config predates version 12 (~2 years old) and can no longer be auto-migrated.` `hapi policy build` writes no `_config_version`, so Hermes reads the file's version as 0 (v0.22.5's latest is 51) and skips migrating it.
   - **Hermes still loads every setting as written.** The spike checked only the Slack setting on a live message. So the audit's `tools.hermes-validate` was run on 2026-10-28, offline in the pinned image. It loads the file with Hermes's own `load_config()` and finds every generated value as written. Among them: `approvals.mode: manual`, with cron, unattended and single-query `deny`; memory and skill write approval; `agent.max_turns: 60`; the protected instruction files; and `allow_lazy_installs: false`. Hermes's `validate_config_structure` reports nothing.
   - **What stays open:** whether those settings hold on live actions (an interactive write prompts, a cron one is denied, a skill write needs approval) is spike T9's. Plan 04's generator stamps `_config_version` with the image's latest, held by a test, so a later image migrates from the right version and the warning goes.
2. **Hermes reaches for hosts outside its zone.** About 30 seconds after the start it tried `hermes-agent.nousresearch.com`, `raw.githubusercontent.com` and `portal.nousresearch.com`. The proxy refused each one (403), and the gateway kept running. It also fetched about 786 KB from `openrouter.ai`, which the zone allows, likely the model catalog. Plan 04 finds the setting behind each request (update checks, the skills hub, the Nous portal, the catalog) and turns off what hapi doesn't use, so a denial in the zone's log stays a signal, not noise.
3. **No home channel.** Hermes's first reply ended: "No home channel is set for Slack. … Type /hermes sethome to make this chat your home channel". The home channel is `#hapi-alerts` (docs/runbooks/slack.md), which Hermes takes as `SLACK_HOME_CHANNEL`, the channel's ID. A channel ID stays out of the public repo, so Plan 04 maps `SLACK_HOME_CHANNEL` in the hermes zone of `stack/secrets.yaml` to a value in the store. Then the prompt never appears, and `/hermes sethome` is never needed.
4. **The gateway logs each inbound message's full text** (`gateway.run: inbound message: ... msg="..."`, at INFO). Slack messages never carry secrets (spec §9.1), but this makes Hermes's logs as sensitive as the chat. Plan 04 decides the log level and how long `/opt/data/logs` keeps them.
5. **Members off the allowlist can still post in channels.** Their own messages are rejected early, as above. Whether Hermes's context for a thread it answers includes other members' messages wasn't tested. If it does, that is a prompt-injection path around the allowlist. Plan 04 tests it in `#hapi-intake`. Until then, keep `#hapi-intake` and `#hapi-alerts` private, with only the operator and the bot in them.

## Decision

The gateway design stands as spec §9.1 has it: Socket Mode, so there is no inbound endpoint, and a member-ID allowlist. Once `unauthorized_dm_behavior: ignore` is set, a stranger gets no reply at all.

## Consequences

- **Plan 04** compiles `slack.unauthorized_dm_behavior: ignore` into the generated config, since the spike set it by hand. Without it, a stranger's DM gets a pairing prompt. Plan 04 also takes findings 1–5 (H-179).
- **Stage b (H-080)** runs the same three checks on the real stack, as hapi on rootless Docker.
- **The threat model:** AC-12 stays documented, not verified live until stage b and Plan 04's setting. Its status records this run.
