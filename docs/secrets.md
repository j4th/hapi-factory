# Secrets

Secrets come from **Bitwarden Secrets Manager** (`bws`) when the stack starts, never from `.env` files on disk (spec §11.5). They land in mode-`0600` files on the user's own tmpfs, `$XDG_RUNTIME_DIR/hapi/`, and only once every key has resolved. GitHub tokens are minted outside the agents, for one repo at a time, and last one hour.

The rules:
- **The repo holds placeholder ids, never values and never your real ids.** [`stack/secrets.map.yaml`](../stack/secrets.map.yaml) maps each env var to a bws secret id, and every id in it is a placeholder. Your filled-in copy lives outside the repo, and you pass it with `--map` ([filling in the map](#filling-in-the-map-the operator)). A test checks that the committed map holds only placeholder ids.
- **Fail closed.** If any secret is missing, empty or unreadable, `hapi secrets resolve` writes nothing and names the key. So the stack never starts with an empty variable.
- **No value is ever printed.** Not on stdout or stderr, not in an error message, not in a log. Errors name the zone and the key, and say why.
- **The bws access token stays in your environment.** `bws` reads `BWS_ACCESS_TOKEN` itself. hapi never passes it on a command line and never writes it anywhere.

This page covers:
- [the zones and their keys](#the-zones-and-their-keys);
- [the secrets map](#the-secrets-map-stacksecretsmapyaml);
- [setting up Bitwarden](#setting-up-bitwarden-secrets-manager-the operator) and [filling in the map](#filling-in-the-map-the operator);
- [`hapi secrets resolve`](#hapi-secrets-resolve) and [the env files it writes](#the-env-files);
- [`hapi token mint`](#hapi-token-mint);
- [rotating a secret](#rotating-a-secret) and [open items](#open-items).

Where each key comes from: [provider keys](runbooks/provider-keys.md) (Anthropic, OpenCode Go, OpenRouter, Brave, Exa, Context7), [Slack](runbooks/slack.md) and [GitHub Apps](runbooks/github-apps.md).

## The zones and their keys

Each zone gets its own env file. A container sees only its own zone's file (spec §4.3).

| Zone | Env var | What it is | bws key (its name in the vault) | Runbook |
|---|---|---|---|---|
| `hermes` | `ANTHROPIC_API_KEY` | API key of the Console workspace `hapi-hermes` ($60/month) | `hapi-hermes-anthropic-api-key` | [provider keys](runbooks/provider-keys.md#anthropic-console-workspaces) |
| `hermes` | `SLACK_BOT_TOKEN` | The Slack app's bot token (`xoxb-...`) | `hapi-hermes-slack-bot-token` | [Slack](runbooks/slack.md) |
| `hermes` | `SLACK_APP_TOKEN` | The app-level Socket Mode token (`xapp-...`) | `hapi-hermes-slack-app-token` | [Slack](runbooks/slack.md) |
| `hermes` | `SLACK_ALLOWED_USERS` | Your Slack member ID; comma-separated if there are more | `hapi-hermes-slack-allowed-users` | [Slack](runbooks/slack.md) |
| `archon` | `ANTHROPIC_API_KEY` | API key of the Console workspace `hapi-factory` ($100/month). Pi reads this name. | `hapi-archon-anthropic-api-key` | [provider keys](runbooks/provider-keys.md#anthropic-console-workspaces) |
| `archon` | `CLAUDE_API_KEY` | **The same secret** (the same id): Archon's `claude` nodes read this name | (the same) | |
| `archon` | `OPENCODE_API_KEY` | OpenCode Go, for the `portable` roster | `hapi-archon-opencode-api-key` | [provider keys](runbooks/provider-keys.md#opencode-go) |
| `archon` | `HAPI_JEV_OPENROUTER_API_KEY` | The OpenRouter key `hapi-jev` ($2/month), for Jev decisions (spec §9.5) | `hapi-archon-jev-openrouter-api-key` | [provider keys](runbooks/provider-keys.md#openrouter) |
| `research` | `BRAVE_SEARCH_API_KEY` | Brave Search, Hermes's search backend | `hapi-research-brave-search-api-key` | [provider keys](runbooks/provider-keys.md#search-keys-brave-exa-context7) |
| `research` | `EXA_API_KEY` | Exa, Hermes's contents (extract) backend | `hapi-research-exa-api-key` | [provider keys](runbooks/provider-keys.md#search-keys-brave-exa-context7) |
| `research` | `HAPI_MCP_CONTEXT7_API_KEY` | Context7, for `policy/mcp.yaml`'s `context7` server | `hapi-mcp-context7-api-key` | [provider keys](runbooks/provider-keys.md#search-keys-brave-exa-context7) |
| `host` | `HAPI_PLANNER_APP_ID` | The `hapi-planner` App's App ID | `hapi-host-planner-app-id` | [GitHub Apps](runbooks/github-apps.md) |
| `host` | `HAPI_PLANNER_APP_PRIVATE_KEY` | Its private key (the PEM) | `hapi-host-planner-app-private-key` | [GitHub Apps](runbooks/github-apps.md) |
| `host` | `HAPI_FACTORY_APP_ID` | The `hapi-factory` App's App ID | `hapi-host-factory-app-id` | [GitHub Apps](runbooks/github-apps.md) |
| `host` | `HAPI_FACTORY_APP_PRIVATE_KEY` | Its private key (the PEM) | `hapi-host-factory-app-private-key` | [GitHub Apps](runbooks/github-apps.md) |

Why it is laid out this way:
- **The GitHub App keys are in `host`, never in a container.** Spec §4.3 gives the App private keys to the `hapi` host user only. Host tools mint 1-hour tokens from them (`hapi token mint`, later the harvester and the `hapi-gh-token` helper, spec §9.1). The Hermes container gets a 1-hour `hapi-planner` token per session, never the key, so it can never mint its own. A test checks that no other zone holds an App key. `host.env` must never be a container's env file.
- **Research holds only search keys** (spec §10.1): spend-capped, search-only, with no repo or forge access.
- **Jev's key is not `OPENROUTER_API_KEY`.** Pi reads `OPENROUTER_API_KEY` for any `openrouter/` model, so under that name Pi could bill model calls to Jev's $2 key. Plan 02's `decide()` helper passes `HAPI_JEV_OPENROUTER_API_KEY` to the Jev client itself.
- **Names that hapi owns start with `HAPI_`.** The other names are the ones each tool reads (Hermes, Pi, Archon).
- **The bws key names are labels.** `hapi secrets resolve` looks secrets up by id, so a name only helps you find the secret in the vault. MCP keys are the exception: their names come from `policy/mcp.yaml`, and their env vars are derived from them (next section).

## The secrets map, `stack/secrets.map.yaml`

```yaml
# yaml-language-server: $schema=../policy/schemas/secrets-map.schema.json
hermes:
  ANTHROPIC_API_KEY: 00000000-0000-0000-0000-000000000101     # hapi-hermes-anthropic-api-key: ...
archon:
  ANTHROPIC_API_KEY: 00000000-0000-0000-0000-000000000201
  CLAUDE_API_KEY: 00000000-0000-0000-0000-000000000201        # the same secret
research:
  HAPI_MCP_CONTEXT7_API_KEY: 00000000-0000-0000-0000-000000000303
host:
  HAPI_PLANNER_APP_ID: 00000000-0000-0000-0000-000000000401
```

- **Shape:** zone → env var name → bws secret id. The schema is [`policy/schemas/secrets-map.schema.json`](../policy/schemas/secrets-map.schema.json). All four zones are required, and no other key is allowed. A name is `^[A-Z_][A-Z0-9_]*$`. An id is a UUID.
- **Two names may share one id.** `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY` in `archon` do, and bws is asked once.
- **Placeholders.** The committed file has placeholder ids, `00000000-0000-0000-0000-...`. `hapi secrets resolve` refuses a placeholder by key, before it calls bws, and `--dry-run` lists it as `placeholder`. A real bws id is a random UUID, so it never looks like one.
- **Real ids stay out of the repo.** An id is useless without the machine account's access token, so it isn't a secret. But it is specific to your vault, and this repo is public: the committed map is a template, and each deployment keeps its filled-in copy outside the repo. A unit test fails if `stack/secrets.map.yaml` holds anything but placeholders, so `mise run test` and CI catch a real id committed by mistake.
- **A mistake is never echoed.** If a secret is pasted where an id goes, the loader says `stack/secrets.map.yaml: /hermes/ANTHROPIC_API_KEY: must match pattern ...` without the value. A key that isn't an env name is shown as `(a name that is not an env name, not shown)`.

**MCP references.** `policy/mcp.yaml` names a server's secret by its bws key, as `bws:hapi-mcp-<slug>` ([docs/policy.md](policy.md#mcpyaml)). The generated configs read it from `${HAPI_MCP_<SLUG>}`: the key upper-cased, with `-` as `_` (`secretEnvName`). So the map must have that env var in the server's zone. For Context7 that is `HAPI_MCP_CONTEXT7_API_KEY` in `research`. `hapi secrets resolve` checks every MCP server each zone loads (`mcpSecretGaps`), and so does a unit test against the committed files. A missing one fails, naming it:

```text
hapi secrets resolve: research/HAPI_MCP_CONTEXT7_API_KEY: not in the secrets map, but policy/mcp.yaml's context7 server needs it (bws:hapi-mcp-context7-api-key); add its bws id to the research zone
```

The Phoenix MCP server loads only while the observability profile runs (`flags.otel.enabled: true`). Before you turn that on, add `HAPI_MCP_PHOENIX_VIEWER_KEY` (bws key `hapi-mcp-phoenix-viewer-key`, a VIEWER-role key) to the `hermes` zone. Until you do, `hapi secrets resolve` fails.

## Setting up Bitwarden Secrets Manager (the operator)

Do this once, in the Bitwarden web app.

1. **Enable Secrets Manager** for your Bitwarden organization, and create a **project** named `hapi`. Every hapi secret goes in it, and nothing else does.
2. **Create a machine account**, `hapi-resolver`, with **Can read** access to the `hapi` project only. hapi only ever reads secrets.
3. **Create an access token** for it, with an expiry date (90 days is a good default). Bitwarden shows it once.
4. **Keep the token in your shell's environment only.** Never put it in a file, a shell rc file, `mise.toml` or a `.env`. To set it for one shell without echoing it or saving it in history:

   ```bash
   read -rs BWS_ACCESS_TOKEN && export BWS_ACCESS_TOKEN
   ```

5. **If your account is on Bitwarden's EU cloud, point bws at it**, once per machine. This writes bws's own config file, which holds no secret:

   ```bash
   bws config server-base https://vault.bitwarden.eu
   ```

6. **Check it** with a dry run (below). It reads every secret and prints only `found`, `missing` or `placeholder`.

## Filling in the map (the operator)

**Never fill in `stack/secrets.map.yaml` itself.** It is the public template. Copy it outside the repo, to hapi's local config directory, and fill in the copy. Do this as the user that runs the stack (`hapi`, from Plan 01 Task 5 on), from the repo root:

```bash
mkdir -p -m 0700 "${XDG_CONFIG_HOME:-$HOME/.config}/hapi"
install -m 0600 stack/secrets.map.yaml "${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.map.yaml"
```

Then, for each key in [the table](#the-zones-and-their-keys):

1. Get the value from its runbook.
2. In the Bitwarden web app, open the `hapi` project and add a **new secret**. Use the bws key from the table as its name, and paste the value. **Don't use `bws secret create` on the command line:** the value would end up in your shell history and in the process list.
3. Copy the new secret's **id** from the web app.
4. Replace that key's placeholder **in your copy** with it.

Then check the copy. Every key should say `found`:

```bash
hapi secrets resolve --dry-run --map "${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.map.yaml"
```

Don't commit the copy, and don't copy it back into the repo. If the template changes (a new key in a later task), add the same key to your copy; the dry run names any key your copy lacks that the MCP catalog needs. Back the copy up somewhere private if you like: it holds ids, not values. Plan 01 Task 4b builds its local config on this directory.

## `hapi secrets resolve`

```text
hapi secrets resolve [--dry-run] [--map file] [--policy dir]
```

- `--map`: the secrets map. Pass your filled-in copy, `"${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.map.yaml"`. The default is the committed template, `stack/secrets.map.yaml`, whose placeholders it refuses.
- `--policy`: the policy directory whose MCP catalog the map must cover. Default `policy`.

Elsewhere in these docs, "run `hapi secrets resolve`" means with `--map` pointing at your copy.

**Without `--dry-run`** it:
1. loads and checks the map, and checks it covers the MCP catalog;
2. needs `XDG_RUNTIME_DIR` (below);
3. reads every secret with `bws secret get <id> --output json --color no`, into memory;
4. checks each value: not empty or blank, no single quote, no NUL (an env file can't carry those literally);
5. only then writes `$XDG_RUNTIME_DIR/hapi/<zone>.env` for every zone, and prints each path.

Any failure at steps 1–4 throws a `SecretError` naming `zone/KEY` and writes nothing. `hapi` prints it and exits 1:

```text
hapi secrets resolve: hermes/ANTHROPIC_API_KEY: bws secret get failed: bws exited with status 1: Error: 0: Missing access token
hapi secrets resolve: hermes/SLACK_APP_TOKEN: the secret is empty
hapi secrets resolve: research/EXA_API_KEY: still a placeholder bws id (docs/secrets.md: Filling in the map)
```

**`XDG_RUNTIME_DIR`** must be set to an absolute path. It is the user's own tmpfs (systemd creates `/run/user/<uid>` at login, mode 0700), so nothing survives a reboot. **There is no fallback**: never `/tmp`, never the repo. If it isn't set, the command fails and says so. Outside a login session (under `sudo -iu hapi`, say), set it yourself with `export XDG_RUNTIME_DIR=/run/user/$(id -u)` if that directory exists. `loginctl enable-linger hapi` (Plan 01 Task 5) keeps it for the `hapi` user.

**With `--dry-run`** it looks up every key as a real run would and prints one line per key. It writes nothing, so it needs no `XDG_RUNTIME_DIR`. It exits 0 only if every key is `found`:

```text
found        hermes/ANTHROPIC_API_KEY
missing      archon/OPENCODE_API_KEY (bws secret get failed: bws exited with status 1: ...)
placeholder  research/EXA_API_KEY (still a placeholder bws id (docs/secrets.md: Filling in the map))
```

Plan 01 Task 5's `mise run up` runs the real thing before it starts any container, and aborts if it fails.

## The env files

`$XDG_RUNTIME_DIR/hapi/` holds one file per zone: `hermes.env`, `archon.env`, `research.env` and `host.env`.

- **Modes:** the directory is `0700` and each file `0600`, whatever the umask. The directory must be a real directory owned by you. A symlink or someone else's directory is refused, and a looser mode is tightened.
- **Atomic:** every file is written to a temp file in the same directory, and the temp files are renamed into place only when all of them are written. A reader sees the old file or the new one, never half of one. Nothing is written until every key has resolved.
- **Format:** a comment header, then one `NAME='value'` per key, sorted by name. **Docker Compose reads a single-quoted value literally** in an `env_file`: no `${...}` interpolation, no escapes, and newlines kept. So a value with `$`, `"`, `#`, spaces or backslashes, or a multi-line PEM, arrives exactly as stored. (Checked with Docker Compose v5.6.1, `docker compose config`.) An unquoted `KEY=abc$def` would arrive as `abc`, which is why hapi always quotes. A value can't hold a single quote, so a secret with one is refused by key. Rotate it to one without.
- **`host.env` is for host tools only.** It holds the GitHub App private keys. Task 5's compose file gives each container its own zone's file and never `host.env`.

## `hapi token mint`

```text
hapi token mint --app planner|factory --repo owner/name
```

It mints a 1-hour installation token for **one** repo, with the App's fixed permissions, and writes it to `$XDG_RUNTIME_DIR/hapi/tokens/<app>.<owner>.<repo>.token` (mode `0600`, directory `0700`, atomically). It prints the path and the expiry, **never the token**:

```text
/run/user/1001/hapi/tokens/planner.<owner>.hapi-factory.token (expires 2026-10-26T19:04:11Z)
```

| `--app` | App | Token permissions |
|---|---|---|
| `planner` | `hapi-planner` (Hermes) | `contents: write`, `pull_requests: write`, `issues: read`, `metadata: read` |
| `factory` | `hapi-factory` (the harvester) | `contents: write`, `pull_requests: write`, `metadata: read` |

How it works:
1. It reads the App's id and key from `$XDG_RUNTIME_DIR/hapi/host.env` (`HAPI_<APP>_APP_ID`, `HAPI_<APP>_APP_PRIVATE_KEY`). Run `hapi secrets resolve` first.
2. It signs the App's JWT: RS256 through `crypto.subtle`, `iat` 60 s in the past (for clock drift), `exp` 9 minutes ahead, and `iss` the App ID as a number (a Client ID, `Iv...`, also works, as a string). GitHub's PKCS#1 PEM and PKCS#8 both work.
3. It looks up the App's installation on that repo (`GET /repos/{owner}/{repo}/installation`). It fails if the App isn't installed there, or if the installation is suspended (kill switch 2, spec §11.8).
4. It asks for a token for that one repository with exactly the permissions above (`POST /app/installations/{id}/access_tokens`).
5. **It checks the token GitHub returns.** Its `permissions` must not exceed the request: no extra permission and no higher level. `metadata: read` is implicit, since GitHub adds it to every token. Its repositories must equal the request: `repository_selection: selected`, and exactly that one repo. Anything broader throws `TokenScopeError`. **The token is revoked at once** (`DELETE /installation/token`). If the revoke fails, the error says when the token expires.

`mintInstallationToken` (in `src/forge/github/app-token.ts`) also refuses, before sending anything, a request for anything but exactly one repository, or with no permissions. With no permissions, GitHub would grant every permission the installation has. With no repositories, it would cover every repo of the installation. Plans 03 and 04 call it in-process from the harvester and the `hapi-gh-token` helper.

**To use a token** without printing it: `GH_TOKEN="$(cat <file>)" gh api ...`. **To revoke it early:** `GH_TOKEN="$(cat <file>)" gh api -X DELETE /installation/token`, then delete the file.

## Error messages name keys, never values

This is a rule for every hapi command (README, "Adding a command"):
- Name the zone, the key, the file and line, or the JSON Pointer. Never print the value.
- Don't pass through text that might hold one: bws's stdout, `JSON.parse`'s own message (it can quote its input), a GitHub response body other than its `message`.
- A name or id that fails validation is not echoed either, in case a secret was pasted in its place.

Tests feed fake values through every failure path and check they never reach a message, stdout or stderr.

## Rotating a secret

1. Put the new value in the existing bws secret (Bitwarden web app → the secret → edit). Its id doesn't change, so the map doesn't either.
2. Revoke the old value at the vendor.
3. Run `hapi secrets resolve`, then restart that zone's container (Task 5: `mise run down && mise run up`).

To rotate a GitHub App private key, see [the GitHub Apps runbook](runbooks/github-apps.md#rotating-a-private-key).

## Open items

- **The research container's model key.** `hapi-research` (Plan 04) runs Hermes, so it needs a model key as well as its search keys. Plan 04 decides which capped key it gets, and adds it to the `research` zone.
- **One machine account reads every zone.** A per-zone project and machine account would limit what one leaked access token exposes. The resolver takes one token today.
- **Ids aren't cross-checked against bws key names.** `bws secret get` returns the secret's name. Checking it against the expected name would catch an id pasted into the wrong zone, such as Hermes's Anthropic key in `archon`.
