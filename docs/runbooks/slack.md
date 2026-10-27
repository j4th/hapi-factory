# Runbook: Slack

Hermes talks to you through Slack, in Socket Mode, so there is no inbound endpoint (spec §9.1). This runbook sets up the workspace, the app and its three secrets. You do it by hand. The gateway itself is tried out in Plan 01 Task 13 (the Socket Mode spike) and built in Plan 04.

## The workspace

- **Use a dedicated Slack workspace for hapi**, not a personal or work one. **Slack's free plan is fine.**
- **Channels:**
  - **`#hapi-intake`**: where you talk to Hermes. One thread per feature.
  - **`#hapi-alerts`**: posts from the bot only: the poller, the harvester and flag notices.
  - **A DM with the bot**, for ad-hoc chat.
- Slack is a third party. Messages carry links and summaries, never code or secrets (spec §9.1). The record of truth stays on GitHub.

## The app

1. **Generate the manifest from the hapi Hermes container.** Inside the container (Plan 01 Task 13, once Task 5's stack runs), run:

   ```bash
   hermes slack manifest --agent-view --write
   ```

   It writes `slack-manifest.json` in that Hermes's home directory. **Never generate it from your personal Hermes** (`~/.hermes`). The manifest lists the commands of the Hermes that made it, and your personal Hermes is never pointed at hapi (spec §9.1, Coexistence).
2. **Create the app from it:** at api.slack.com/apps, choose **Create New App → From a manifest**, pick the hapi workspace, and paste the manifest.
3. **Scopes:** first try without any `files:*` scope. Hermes posts links and summaries, not files. Add a `files:*` scope only if a feature turns out to need it.
4. **App Home → Show Tabs:** turn on the **Messages Tab**, and allow users to send messages from it. Without that, you can't DM the bot.
5. **Socket Mode** is on in the manifest. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope. That is `SLACK_APP_TOKEN` (`xapp-...`).
6. **Install the app to the workspace.** The **Bot User OAuth Token** on the OAuth page is `SLACK_BOT_TOKEN` (`xoxb-...`).
7. **Find your Slack member ID:** your profile → the **⋯** menu → **Copy member ID**. That is `SLACK_ALLOWED_USERS`. List only yourself. Collaborators are added later, by member ID, comma-separated.
8. **Invite the bot** to `#hapi-intake` and `#hapi-alerts` (`/invite @<the bot's name>` in each).

## The secrets

Add all three to your secrets store (`mise run secrets:edit`) under these logical names ([docs/secrets.md](../secrets.md#adding-a-secret)). `stack/secrets.yaml` already puts them in the `hermes` zone:

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
| Home channel | `#hapi-alerts` | Where scheduled and cron messages go. Hermes takes it as the channel's ID (`SLACK_HOME_CHANNEL`). |

## Check it (Plan 01 Task 13)

- Your DMs to the bot get an answer.
- A second test user's DMs are ignored, with no reply at all.
- No inbound port opens: `ss -ltn` inside the Hermes container shows no new listener.

## Kill switch

To cut Hermes off from Slack, revoke the bot token on the app's **OAuth & Permissions** page and the app-level token under **Basic Information**. Then rotate both ([docs/secrets.md](../secrets.md#rotating-a-secret)).
