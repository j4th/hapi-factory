# Runbook: Slack

Hermes talks to you through Slack, in Socket Mode, so there is no inbound endpoint (spec §9.1). This runbook sets up the workspace, the app and its three secrets. You do it by hand. The gateway itself is tried out in Plan 01 Task 13 (the Socket Mode spike) and built in Plan 04.

**Do this before stage b of the stack** ([docs/runbooks/stack.md](stack.md)). `mise run up` refuses to start with an empty secret, the three Slack values included, so they must be in your store first. Nothing here needs the stack: the app's manifest comes from a one-off container of the pinned Hermes image, with no network, no gateway and no secrets.

## The workspace

- **Use a dedicated Slack workspace for hapi**, not a personal or work one. **Slack's free plan is fine.**
- **Channels:**
  - **`#hapi-intake`**: where you talk to Hermes. One thread per feature.
  - **`#hapi-alerts`**: posts from the bot only: the poller, the harvester and flag notices.
  - **A DM with the bot**, for ad-hoc chat.
- **Make `#hapi-intake` and `#hapi-alerts` private, with only you and the bot in them.** Anyone else in the workspace is off the allowlist, so Hermes rejects their own messages. Whether its context for a thread it answers includes their messages is untested (H-179), and if it does, that is a way around the allowlist.
- Slack is a third party. Messages carry links and summaries, never code or secrets (spec §9.1). The record of truth stays on GitHub.

## The app

1. **Generate the manifest from the pinned Hermes image**, on any machine with Docker, outside your checkout (the file holds no secret):

   ```bash
   docker run --rm --init --network none --user 10000:10000 --read-only --cap-drop ALL \
     --security-opt no-new-privileges:true --tmpfs /tmp --entrypoint hermes \
     nousresearch/hermes-agent:v0.22.5@sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d \
     slack manifest --agent-view > slack-manifest.json
   ```

   - The image is the stack's own: the `FROM` line of `stack/hermes/Dockerfile`, tag and digest (a test keeps the two equal). The container is hardened like the stack's `hermes` service, has no network at all, and runs no gateway; `hermes slack manifest` without `--write` prints the manifest to stdout. Checked on 2026-10-27 with that digest: it exits 0, prints the manifest (Socket Mode on, 50 slash commands), and needs nothing else.
   - **Never generate it from your personal Hermes** (`~/.hermes`). The manifest lists the commands of the Hermes that made it, and your personal Hermes is never pointed at hapi (spec §9.1, Coexistence).
   - It lists the commands built into Hermes v0.22.5. When Plan 04 adds hapi's own commands, regenerate it from the running stack (`docker compose -p hapi exec hermes hermes slack manifest --agent-view`, as hapi) and update the app's manifest (**Features → App Manifest**).
2. **Create the app from it:** at api.slack.com/apps, choose **Create New App → From a manifest**, pick the hapi workspace, and paste the manifest.
3. **Scopes:** first try without any `files:*` scope. Hermes posts links and summaries, not files. The manifest asks for `files:read` and `files:write` under `oauth_config.scopes.bot`: delete both before you paste it. Add a `files:*` scope only if a feature turns out to need it.
4. **App Home → Show Tabs:** turn on the **Messages Tab**, and allow users to send messages from it. Without that, you can't DM the bot.
5. **Socket Mode** is on in the manifest. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope. That is `SLACK_APP_TOKEN` (`xapp-...`).
6. **Install the app to the workspace.** The **Bot User OAuth Token** on the OAuth page is `SLACK_BOT_TOKEN` (`xoxb-...`).
7. **Find your Slack member ID:** your profile → the **⋯** menu → **Copy member ID**. That is `SLACK_ALLOWED_USERS`. List only yourself. Collaborators are added later, by member ID, comma-separated.
8. **Invite the bot** to `#hapi-intake` and `#hapi-alerts` (`/invite @<the bot's name>` in each).

## The secrets

Add all three to your secrets store (`mise run secrets:edit`), before stage b, under these logical names ([docs/secrets.md](../secrets.md#adding-a-secret)). `stack/secrets.yaml` already puts them in the `hermes` zone:

| Env var | Logical name | Value |
|---|---|---|
| `SLACK_BOT_TOKEN` | `hapi-hermes-slack-bot-token` | The bot token, `xoxb-...` |
| `SLACK_APP_TOKEN` | `hapi-hermes-slack-app-token` | The app-level token, `xapp-...` |
| `SLACK_ALLOWED_USERS` | `hapi-hermes-slack-allowed-users` | Your Slack member ID |

Your member ID isn't a secret, but it is a personal identifier, and this repo is public. Keeping it in your secrets store keeps it out of the repo. Do the same with any channel ID.

## Hermes settings

Plan 04 compiles these into Hermes's generated config. For the Task 13 spike, set them by hand in the container's Hermes config:

| Setting | Value | Why |
|---|---|---|
| `slack.unauthorized_dm_behavior` | `ignore` | The default, `pair`, answers a stranger's DM with a pairing prompt. `ignore` drops it silently. |
| Home channel | `#hapi-alerts` | Where scheduled and cron messages go. Hermes takes it as the channel's ID (`SLACK_HOME_CHANNEL`), which belongs in your store (H-179). Until Plan 04 maps it, Hermes's first reply asks you to run `/hermes sethome`: ignore it, since that would make your DM the home channel. |

## Check it (Plan 01 Task 13)

Run on 2026-10-28, and passed: [spike 06](../spikes/06-hermes-slack-socket-mode.md).

- Your DMs to the bot get an answer.
- A second test user's DMs are ignored, with no reply at all. Hermes logs `Early reject of unauthorized user`.
- No inbound port opens. The image has no `ss`, so list the container's listeners from `/proc` (addresses in hex, little-endian: `0100007F:21C2` is `127.0.0.1:8642`). Each must be on `127.0.0.1`, or `127.0.0.11`, Docker's DNS:

  ```bash
  docker exec hapi-hermes-1 cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == "0A" {print $2}'
  ```

## Kill switch

To cut Hermes off from Slack, revoke the bot token on the app's **OAuth & Permissions** page and the app-level token under **Basic Information**. Then rotate both ([docs/secrets.md](../secrets.md#rotating-a-secret)).
