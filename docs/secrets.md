# Secrets

Secrets come from a **pluggable secret provider** when the stack starts, never from a `.env` file in a repo (spec §11.5). They land in mode-`0600` files on the user's own tmpfs, `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`, and only once every name has resolved. GitHub tokens are minted outside the agents, for one repo at a time, and last one hour.

Secrets come in three parts:

| Part | Where | What it holds |
|---|---|---|
| **The manifest** | [`stack/secrets.yaml`](../stack/secrets.yaml), committed and public | Per zone, which env var gets which **logical name** (`hapi-hermes-anthropic-api-key`). No ids, no values. It is the single list of what must exist. |
| **The local config** | `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`, outside the repo | Which provider you use, and how to reach its store. No secret. |
| **The store** | The provider's own data | The values, under their logical names |

The providers:
- **sops + age, the default for everyone.** One encrypted file and an age key. No service to run, encrypted at rest, and the encrypted file can be backed up in a private repo. Onboarding is `mise run secrets:init`.
- **Bitwarden Secrets Manager (`bws`), optional.** The config binds each logical name to a bws secret id.
- **`env-file`, an explicit downgrade.** A plaintext `0600` file outside every checkout. Every run warns about it, and `hapi audit` (Plan 01 Task 6) reports it.

The rules:
- **The repo holds logical names only.** Never a value, and never an id or a path from your deployment.
- **Fail closed, with no automatic fallback.** If the configured provider fails, or any name is missing or empty, `hapi secrets resolve` writes nothing and names the secret. So the stack never starts with an empty variable. hapi never tries another provider.
- **No value is ever printed.** Not on stdout or stderr, not in an error message, not in a log. Errors name the zone, the env var, the logical name, the file or the exit code.
- **Keys and plaintext stay outside the checkout**, `private/` included. hapi refuses an age key file or an env-file store inside it.

This page covers:
- [the zones and their keys](#the-zones-and-their-keys) and [the manifest](#the-manifest-stacksecretsyaml);
- [the local config](#the-local-config);
- [getting started with sops + age](#getting-started-with-sops--age), [backing up the age key](#backing-up-the-age-key) and [adding a secret](#adding-a-secret);
- the commands: [`hapi secrets init`](#hapi-secrets-init), [`edit`](#hapi-secrets-edit), [`check`](#hapi-secrets-check) and [`resolve`](#hapi-secrets-resolve), and [the env files](#the-env-files);
- [rotating a secret](#rotating-a-secret) and [rotating the age key](#rotating-the-age-key);
- [optional: Bitwarden](#optional-bitwarden-secrets-manager-bws) and [the env-file downgrade](#the-env-file-downgrade);
- [`hapi token mint`](#hapi-token-mint), [error messages](#error-messages-name-keys-never-values), [threat notes](#threat-notes) and [open items](#open-items).

Where each value comes from: [provider keys](runbooks/provider-keys.md) (Anthropic, OpenCode Go, OpenRouter, Brave, Exa, Context7), [Slack](runbooks/slack.md) and [GitHub Apps](runbooks/github-apps.md).

## The zones and their keys

Each zone gets its own env file. A container sees only its own zone's file (spec §4.3).

| Zone | Env var | What it is | Logical name | Runbook |
|---|---|---|---|---|
| `hermes` | `ANTHROPIC_API_KEY` | API key of the Console workspace `hapi-hermes` ($60/month) | `hapi-hermes-anthropic-api-key` | [provider keys](runbooks/provider-keys.md#anthropic-console-workspaces) |
| `hermes` | `SLACK_BOT_TOKEN` | The Slack app's bot token (`xoxb-...`) | `hapi-hermes-slack-bot-token` | [Slack](runbooks/slack.md) |
| `hermes` | `SLACK_APP_TOKEN` | The app-level Socket Mode token (`xapp-...`) | `hapi-hermes-slack-app-token` | [Slack](runbooks/slack.md) |
| `hermes` | `SLACK_ALLOWED_USERS` | Your Slack member ID; comma-separated if there are more | `hapi-hermes-slack-allowed-users` | [Slack](runbooks/slack.md) |
| `archon` | `ANTHROPIC_API_KEY` | API key of the Console workspace `hapi-factory` ($100/month). Pi reads this name. | `hapi-archon-anthropic-api-key` | [provider keys](runbooks/provider-keys.md#anthropic-console-workspaces) |
| `archon` | `CLAUDE_API_KEY` | **The same secret**: Archon's `claude` nodes read this name | `hapi-archon-anthropic-api-key` | |
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
- **Names that hapi owns start with `HAPI_`.** The other env var names are the ones each tool reads (Hermes, Pi, Archon).

## The manifest, `stack/secrets.yaml`

```yaml
# yaml-language-server: $schema=../policy/schemas/secrets-manifest.schema.json
hermes:
  ANTHROPIC_API_KEY: hapi-hermes-anthropic-api-key   # Console workspace hapi-hermes ($60/month)
archon:
  ANTHROPIC_API_KEY: hapi-archon-anthropic-api-key
  CLAUDE_API_KEY: hapi-archon-anthropic-api-key      # the same secret
research:
  HAPI_MCP_CONTEXT7_API_KEY: hapi-mcp-context7-api-key
host:
  HAPI_PLANNER_APP_ID: hapi-host-planner-app-id
```

- **Shape:** zone → env var → logical name. The schema is [`policy/schemas/secrets-manifest.schema.json`](../policy/schemas/secrets-manifest.schema.json). The zones are exactly `hermes`, `archon`, `research` and `host`, all required. An env var is `^[A-Z_][A-Z0-9_]*$`. A logical name is `^hapi-[a-z0-9]+(-[a-z0-9]+)*$`.
- **One logical name may fill several env vars.** `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY` in `archon` share one, and the store is asked for it once.
- **It is the single list of what must exist.** `hapi secrets resolve` fails if the store lacks a name, and `hapi secrets check` names it. There is no copy to keep in sync.
- **A mistake is never echoed.** If a value is pasted where a name goes, the loader says `stack/secrets.yaml: /hermes/ANTHROPIC_API_KEY: must match pattern ...` without the value. A key that isn't one of the four zones shows as `<zone>`, and one that isn't an env name as `<ENV>`.

### MCP secrets

`policy/mcp.yaml` names a server's secret by its logical name, as `secret:hapi-mcp-<slug>` ([docs/policy.md](policy.md#mcpyaml)). The generated configs read it from `${HAPI_MCP_<SLUG>}`: the name upper-cased, with `-` as `_` (`secretEnvName`). So the manifest must map that env var to that name in the server's zone. For Context7 that is `HAPI_MCP_CONTEXT7_API_KEY: hapi-mcp-context7-api-key` in `research`. `hapi secrets resolve` and `check` test every MCP server each zone loads (`mcpSecretGaps`), and so does a unit test against the committed files. A gap fails, naming it:

```text
hapi secrets resolve: research/HAPI_MCP_CONTEXT7_API_KEY: policy/mcp.yaml's context7 server needs secret:hapi-mcp-context7-api-key; map HAPI_MCP_CONTEXT7_API_KEY to hapi-mcp-context7-api-key in the research zone of stack/secrets.yaml
```

The Phoenix MCP server loads only while the observability profile runs (`flags.otel.enabled: true`). Before you turn that on, add `HAPI_MCP_PHOENIX_VIEWER_KEY: hapi-mcp-phoenix-viewer-key` (a VIEWER-role key) to the `hermes` zone, and the value to your store. Until you do, `hapi secrets resolve` fails.

### Adding a name to the manifest

A new secret is a PR that adds its line to `stack/secrets.yaml`, with a comment saying where the value comes from, and updates [the table above](#the-zones-and-their-keys). Once it merges, everyone's `mise run secrets:check` reports the new name as `missing` until they add it to their store ([adding a secret](#adding-a-secret)), and `hapi secrets resolve` refuses to write anything until then:

```text
missing  archon/NEW_API_KEY (hapi-archon-new-api-key)
hapi secrets check: 1 of 16 secrets are missing or empty: archon/NEW_API_KEY. Fill them in with `mise run secrets:edit` (docs/secrets.md).
```

A name your store holds but the manifest no longer lists shows as `unknown` (`unknown  hapi-old-key (in the store, not in stack/secrets.yaml)`). That doesn't fail the check; delete it from the store when you're ready.

## The local config

Where it is, first match wins:
1. `--config <file>` on the command line;
2. `$HAPI_SECRETS_CONFIG`;
3. `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`.

If there is no file there, every command but `init` stops with `no secrets config at <path>: run \`mise run secrets:init\``.

```yaml
provider: sops            # sops | bws | env-file
sops:     { file: /home/hapi/.config/hapi/secrets.enc.yaml, age_key_file: /home/hapi/.config/sops/age/keys.txt }
# bws:      { ids: { hapi-hermes-anthropic-api-key: 3f6b1c2e-... } }
# env_file: { file: /home/hapi/.config/hapi/secrets.env }
```

- The schema is [`policy/schemas/secrets-config.schema.json`](../policy/schemas/secrets-config.schema.json).
- **Exactly the selected provider's block.** It is required, and any other block is refused (`/bws: the provider is sops, so only its sops block may be set; remove bws`), so a config never names two stores and there is nothing to fall back on.
- **Paths:** a leading `~` is your `$HOME`; a relative path is relative to the config file's directory. `hapi secrets init` writes absolute paths.
- **`sops.age_key_file` is optional.** Without it, hapi uses sops's own default, `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`, and tells sops so explicitly.
- **A mistake is never echoed.** An error shows only the config's own keys and logical names; anything else in a JSON Pointer shows as `<key>` or `<name>`.

## Getting started with sops + age

Do this as the user that runs the stack (`hapi`, from Plan 01 Task 5 on), from the repo root.

1. **Install the pinned tools:** `mise install`. It installs `sops` and `age` (with `age-keygen`) at the versions in `mise.toml`.
2. **Create your store:**

   ```bash
   mise run secrets:init                                     # the encrypted file in ~/.config/hapi/
   mise run secrets:init -- --file private/secrets.enc.yaml  # or in private/, to back it up to your private repo
   ```

   It makes an age key (or reuses yours), an encrypted file holding every manifest name with an empty value, and the config. It prints the age public key ([details](#hapi-secrets-init)).
3. **Back up the age key** now ([how](#backing-up-the-age-key)).
4. **Fill in each value:** `mise run secrets:edit`. Your editor opens the decrypted file. Replace each `""` with the value from its runbook, then save and quit; sops encrypts it again ([adding a secret](#adding-a-secret)).
5. **Check it:** `mise run secrets:check`. Every line should say `found`, and it exits 0.

Plan 01 Task 5's `mise run up` runs `hapi secrets resolve` before it starts any container, and aborts if it fails.

### Backing up the age key

**The age key is the master key.** Without it, the encrypted file can't be opened, by you or anyone. With it, anyone who also has a copy of the encrypted file (from `private/`'s remote, say) has every secret. So:
- keep one copy **offline**, for example as a secure note in your password manager (the key file is three lines of text);
- never put it in a repo, `private/` included: hapi refuses a key file inside the checkout, and `.gitignore` lists `keys.txt` and `*.agekey` in case one lands there;
- keep the file mode `0600` (or `0400`): hapi refuses one with any group or other permission bit.

To restore it on a new machine, write it back to the same path without it touching your shell history, then check:

```bash
mkdir -p -m 0700 ~/.config/sops/age
(umask 077 && cat > ~/.config/sops/age/keys.txt)   # paste the key, then press Ctrl-D
mise run secrets:check
```

### Adding a secret

Run `mise run secrets:edit` and add, or fill in, one line per secret, under its logical name:

```yaml
hapi-hermes-anthropic-api-key: sk-ant-...
hapi-host-planner-app-private-key: |
  -----BEGIN RSA PRIVATE KEY-----
  ...
  -----END RSA PRIVATE KEY-----
```

- Every value is a top-level string. A multi-line value, such as a PEM, is a YAML block scalar (`|`).
- A value can't hold a single quote (`'`) or NUL: an env file can't carry them literally ([the env files](#the-env-files)). `check` reports such a value as `invalid`.
- **Don't use `sops set` or put a value on any command line:** it ends up in your shell history and in the process list.
- Then `mise run secrets:check`.

## `hapi secrets init`

```text
hapi secrets init [--config file] [--file file] [--age-key file]
mise run secrets:init [-- flags]
```

- `--config`: where to write the config (default as [above](#the-local-config)).
- `--file`: the encrypted file. Default `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.enc.yaml`. It may be in the checkout's `private/`.
- `--age-key`: the age key file. Default sops's own, `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`. It may **not** be inside the checkout.
- A relative path is relative to the current directory; `~` is your `$HOME`.

What it does:
1. **It never overwrites anything.** If the config or the encrypted file exists, it stops: `<path> already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`.
2. **The age key.** If the key file exists, it is reused once it passes the [key checks](#threat-notes). Otherwise `age-keygen -o` makes it, in a directory made or tightened to `0700`, and the file ends up `0600`. The public key comes from `age-keygen -y`.
3. **The encrypted file.** The template (every logical name in the manifest, each `""`) is built in memory and piped on stdin to `sops encrypt --age <public key> --input-type yaml --output-type yaml --filename-override <file>`, with `--config /dev/null` so no `.sops.yaml` can change it. **Plaintext never touches disk.** sops's output is checked to be encrypted before it is written. (sops leaves an empty string as `""`: there is nothing to encrypt.)
4. **The config:** `provider: sops`, with both paths absolute.

Each file is written atomically with mode `0600`, in a directory made or tightened to `0700`; so it refuses a new file directly in `$HOME` or `~/.config`, which it won't tighten. Then it prints the age public key, `back up <age key path> offline (e.g. in your password manager): without it the encrypted file can't be opened`, and the next step, `mise run secrets:edit`.

## `hapi secrets edit`

```text
hapi secrets edit [--config file]
mise run secrets:edit
```

For the sops provider only. It checks the age key, then runs `sops edit` on the configured file in your terminal, with your `$EDITOR`. sops decrypts the file into a temp file for the editor and encrypts it again when you quit.

- **The temp file is on your tmpfs.** hapi sets `TMPDIR` to `$XDG_RUNTIME_DIR/hapi`, so it needs `XDG_RUNTIME_DIR` ([below](#hapi-secrets-resolve)). Make sure your editor doesn't copy the buffer anywhere else: Neovim, for one, keeps swap files under `~/.local/state/nvim/` by default (run it with `-n` for no swap file).
- **Your shell's `SOPS_*` variables are dropped**, so they can't add a recipient or a key; hapi sets `SOPS_AGE_KEY_FILE` and `SOPS_DISABLE_VERSION_CHECK=1`. sops runs with `--config /dev/null`.
- If you quit without a change, sops exits 200, which hapi treats as success.

## `hapi secrets check`

```text
hapi secrets check [--config file]
hapi secrets resolve --dry-run [--config file]
mise run secrets:check
```

It reads the store as `resolve` would and prints one line per env var of the manifest. It never prints a value, writes nothing, and needs no `XDG_RUNTIME_DIR`:

```text
found    hermes/ANTHROPIC_API_KEY (hapi-hermes-anthropic-api-key)
empty    hermes/SLACK_BOT_TOKEN (hapi-hermes-slack-bot-token)
missing  archon/OPENCODE_API_KEY (hapi-archon-opencode-api-key)
invalid  research/EXA_API_KEY (hapi-research-exa-api-key): the value holds a single quote ('), which an env file can't carry literally; rotate the secret to one without
unknown  hapi-old-key (in the store, not in stack/secrets.yaml)
```

- `found`: present and usable. `missing`: not in the store. `empty`: `""` or blank. `invalid`: present, but a value `resolve` refuses. A missing [MCP mapping](#mcp-secrets) is a `missing` line too.
- `unknown`: a name in the store (for bws, in `bws.ids`) that the manifest doesn't list. It doesn't fail the check. A name that isn't a logical name is shown as `(a name that is not a logical name, not shown)`, in case a value was pasted as a key.
- **It exits 1 if anything is missing, empty or invalid**, and says so on stderr. A provider failure (sops can't decrypt, say) is an error, exit 1.

## `hapi secrets resolve`

```text
hapi secrets resolve [--config file] [--dry-run]
```

`--dry-run` is [`hapi secrets check`](#hapi-secrets-check). Without it, in order:

| Step | On failure |
|---|---|
| 1. `XDG_RUNTIME_DIR` must be set to an absolute path | a plain `Error` |
| 2. load the manifest (`stack/secrets.yaml`) and check it against its schema | a `PolicyError`, naming the file and JSON Pointer |
| 3. check it maps every MCP reference (`mcpSecretGaps`) | a `SecretError` |
| 4. load the config; a missing file, then the schema | a `SecretError` ("no secrets config at ..."), then a `PolicyError` |
| 5. check `XDG_RUNTIME_DIR` is a real directory, yours, mode `0700` as systemd makes it, and make `hapi/` in it (`0700`) | a plain `Error` |
| 6. fetch every logical name once, from the configured provider only (for sops: the key checks, the file's shape, then `sops decrypt`) | a `SecretError` naming the file, the exit code or the names |
| 7. check every value: present, not empty or blank, no single quote, no NUL | a `SecretError` naming `zone/ENV (name)` |
| 8. write the whole set ([the env files](#the-env-files)) and print each path | |

Nothing is written unless every step passes. `hapi` prints the error and exits 1:

```text
hapi secrets resolve: hermes/ANTHROPIC_API_KEY (hapi-hermes-anthropic-api-key) is not in the sops store (/home/hapi/.config/hapi/secrets.enc.yaml has no hapi-hermes-anthropic-api-key): add it with `mise run secrets:edit`
hapi secrets resolve: hermes/SLACK_APP_TOKEN (hapi-hermes-slack-app-token) is empty: fill it in with `mise run secrets:edit`
hapi secrets resolve: sops could not decrypt /home/hapi/.config/hapi/secrets.enc.yaml (exit 128): Failed to get the data key required to decrypt the SOPS file.
hapi secrets resolve: age key file /home/hapi/.config/sops/age/keys.txt has group or other permission bits (mode 0644): run chmod 600 /home/hapi/.config/sops/age/keys.txt
```

**`XDG_RUNTIME_DIR`** is the user's own tmpfs (systemd creates `/run/user/<uid>` at login, mode 0700), so nothing survives a reboot. **There is no fallback**: never `/tmp`, never the repo. Outside a login session (under `sudo -iu hapi`, say), set it yourself with `export XDG_RUNTIME_DIR=/run/user/$(id -u)` if that directory exists. `loginctl enable-linger hapi` (Plan 01 Task 5) keeps it for the `hapi` user.

## The env files

Consumers read **`$XDG_RUNTIME_DIR/hapi/env/<zone>.env`**: `hermes.env`, `archon.env`, `research.env` and `host.env`.

- **The whole set at once.** `env` is a symlink to a generation directory, `env.<random>/` (`0700`). Each resolve writes every zone file into a fresh generation, then swaps the symlink with one `rename`, then deletes the old generation. A reader sees the old set or the new one, never a mix, and a zone file the manifest no longer has disappears with the old generation. If `env` is a real directory, not hapi's symlink, resolve refuses to touch it.
- **Modes:** each file `0600`, whatever the umask; `hapi/` and each generation `0700`. `XDG_RUNTIME_DIR` itself must be yours and exactly `0700`.
- **Format:** a comment header, then one `NAME='value'` per env var, sorted by name. **Docker Compose reads a single-quoted value literally** in an `env_file`: no `${...}` interpolation, no escapes, and newlines kept. So a value with `$`, `"`, `#`, spaces or backslashes, or a multi-line PEM, arrives exactly as stored. (Checked with Docker Compose v5.6.1, `docker compose config`.) An unquoted `KEY=abc$def` would arrive as `abc`, which is why hapi always quotes. A value can't hold a single quote, so a secret with one is refused by name. Rotate it to one without.
- **`host.env` is for host tools only.** It holds the GitHub App private keys. Task 5's compose file gives each container its own zone's file and never `host.env`.

## Rotating a secret

1. Put the new value under the same logical name in your store (`mise run secrets:edit`).
2. Revoke the old value at the vendor.
3. Run `hapi secrets resolve`, then restart that zone's container (Task 5: `mise run down && mise run up`).

To rotate a GitHub App private key, see [the GitHub Apps runbook](runbooks/github-apps.md#rotating-a-private-key).

## Rotating the age key

Do this if the key may have leaked, or to move to a new one. `sops rotate` makes a new data key and re-encrypts every value, and `--add-age` / `--rm-age` swap the recipient. Run the pinned sops through mise, with the old key to decrypt:

```bash
file=~/.config/hapi/secrets.enc.yaml        # your sops.file
old=~/.config/sops/age/keys.txt             # your sops.age_key_file
new=~/.config/sops/age/keys.new.txt
mise exec -- age-keygen -o "$new"
mise exec -- env SOPS_AGE_KEY_FILE="$old" sops rotate -i \
  --add-age "$(mise exec -- age-keygen -y "$new")" --rm-age "$(mise exec -- age-keygen -y "$old")" "$file"
mv "$new" "$old"                            # or point sops.age_key_file at "$new"
mise run secrets:check
```

Then back up the new key and destroy the old key and its backup. **An old copy of the encrypted file still opens with the old key** (in `private/`'s history, say), so if the old key leaked, also [rotate every secret](#rotating-a-secret). `sops updatekeys` does the same recipient change from a `.sops.yaml`'s creation rules; hapi doesn't use one.

## Optional: Bitwarden Secrets Manager (`bws`)

bws isn't in `mise.toml`. Add it in your own `mise.local.toml` at the repo root (gitignored), pinned exactly, then `mise install`:

```toml
[tools]
bitwarden-secrets-manager = "2.1.0"   # provides `bws`
```

Set up Bitwarden once, in its web app:
1. **Enable Secrets Manager** for your organization, and create a **project** named `hapi`. Every hapi secret goes in it, and nothing else does.
2. **Create a machine account**, `hapi-resolver`, with **Can read** access to the `hapi` project only. hapi only ever reads secrets.
3. **Create an access token** for it, with an expiry date (90 days is a good default). Bitwarden shows it once.
4. **Keep the token in your shell's environment only**, as `BWS_ACCESS_TOKEN`. Never put it in a file, a shell rc file, `mise.toml` or a `.env`. To set it for one shell without echoing it or saving it in history: `read -rs BWS_ACCESS_TOKEN && export BWS_ACCESS_TOKEN`.
5. **If your account is on Bitwarden's EU cloud**, point bws at it once per machine: `bws config server-base https://vault.bitwarden.eu`.
6. For each secret, add a **new secret** in the `hapi` project, named by its logical name, and paste the value. **Don't use `bws secret create` on the command line:** the value would end up in your shell history and in the process list.

Then write the config by hand (`${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`, mode `0600`), binding each logical name to its secret's id from the web app:

```yaml
provider: bws
bws:
  ids:
    hapi-hermes-anthropic-api-key: 3f6b1c2e-0000-4000-8000-000000000000   # the secret's id
    # ... one line per logical name in stack/secrets.yaml
```

- hapi runs `bws secret get <id> --output json --color no` once per id. A placeholder id (`00000000-0000-0000-0000-...`) is refused.
- `BWS_ACCESS_TOKEN` comes from your environment only. hapi never passes it on a command line, never writes it, and masks it in any bws error it shows.
- **What bws keeps on disk:** its config file, `~/.config/bws/config` (`BWS_CONFIG_FILE`, or `bws --config-file`), which holds settings such as the server URL and no secret; and a login state file per access token, under its state directory (`bws config state-dir`), which keeps the session between runs. Turn that off with `bws config state-opt-out true` if you don't want any state kept.
- `hapi secrets edit` doesn't apply: edit the values in Bitwarden. `check` lists a name with no id as `missing`, and a bound name the manifest doesn't list as `unknown`.

## The env-file downgrade

```yaml
provider: env-file
env_file: { file: ~/.config/hapi/secrets.env }
```

The store is one plaintext file of `NAME='value'` lines, NAME being the logical name upper-cased with `-` as `_` (`hapi-hermes-anthropic-api-key` → `HAPI_HERMES_ANTHROPIC_API_KEY`). It exists for a host that can't run sops. It must be mode `0600`, yours, and **outside the hapi-factory checkout, `private/` included**: plaintext there could be committed, or pushed to the private remote. hapi refuses it otherwise.

**Why it is audited:** the values sit on disk in plaintext, readable by anything that runs as you and by any backup of your home directory. So `resolve` and `check` print a warning on every run, and `hapi audit` (Plan 01 Task 6) reports the config as a downgrade (`describeSecretsConfig` returns `downgrade: true`). Move to sops + age when you can: `mise run secrets:init`, copy each value across with `mise run secrets:edit`, then shred the env file.

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
1. It checks `XDG_RUNTIME_DIR` (yours, `0700`), then reads the App's id and key from `$XDG_RUNTIME_DIR/hapi/env/host.env` (`HAPI_<APP>_APP_ID`, `HAPI_<APP>_APP_PRIVATE_KEY`). Run `hapi secrets resolve` first.
2. It signs the App's JWT: RS256 through `crypto.subtle`, `iat` 60 s in the past (for clock drift), `exp` 9 minutes ahead, and `iss` the App ID as a number (a Client ID, `Iv...`, also works, as a string). GitHub's PKCS#1 PEM and PKCS#8 both work.
3. It looks up the App's installation on that repo (`GET /repos/{owner}/{repo}/installation`). It fails if the App isn't installed there, or if the installation is suspended (kill switch 2, spec §11.8).
4. It asks for a token for that one repository with exactly the permissions above (`POST /app/installations/{id}/access_tokens`).
5. **It checks the token GitHub returns.** Its `permissions` must not exceed the request: no extra permission and no higher level. `metadata: read` is implicit, since GitHub adds it to every token. Its repositories must equal the request: `repository_selection: selected`, and exactly that one repo. It must have a valid `expires_at`. Anything else throws (`TokenScopeError` for a broader token), and **the token is revoked at once** (`DELETE /installation/token`). If the revoke fails, the error says how long the token stays valid.
6. It deletes the token files in `tokens/` that are more than an hour old (their tokens have expired), then writes the new one.

`mintInstallationToken` (in `src/forge/github/app-token.ts`) also refuses, before sending anything, a request for anything but exactly one repository, or with no permissions. With no permissions, GitHub would grant every permission the installation has. With no repositories, it would cover every repo of the installation. Plans 03 and 04 call it in-process from the harvester and the `hapi-gh-token` helper.

**To use a token** without printing it: `GH_TOKEN="$(cat <file>)" gh api ...`. **To revoke it early:** `GH_TOKEN="$(cat <file>)" gh api -X DELETE /installation/token`, then delete the file.

## Error messages name keys, never values

This is a rule for every hapi command (README, "Adding a command"):
- Name the zone, the env var, the logical name, the file and line, the JSON Pointer or the exit code. Never print the value.
- Don't pass through text that might hold one: a tool's stdout, `JSON.parse`'s own message (it can quote its input), a GitHub response body other than its `message`. For a tool's stderr (sops, age-keygen, bws), hapi shows only the first line, without ANSI codes, and after each `:` keeps only a segment that is a path, since a parse error can quote the file.
- A name, id or key that fails validation is not echoed either, in case a secret was pasted in its place.

The error kinds: a `PolicyError` when the manifest or the config doesn't match its schema; a plain `Error` for `XDG_RUNTIME_DIR`; a `SecretError` for a missing config, the provider and the store. Tests feed fake values through every failure path and check they never reach a message, stdout or stderr.

## Threat notes

- **The age key is the master key.** It and any copy of the encrypted file together are every secret. hapi checks the key file before every decrypt and every edit: it must exist, be owned by you, have no group or other permission bit, and sit **outside the hapi-factory checkout, `private/` included**, because `private/` is pushed to the private remote next to the encrypted file. The checkout is found with `git rev-parse --show-toplevel`. sops 3.13 also reads its own default key file (under `$HOME/.config/sops/age/`, or `$XDG_CONFIG_HOME` for `edit`) as well as the one it is told to use, so when that exists it must pass the same checks. (It also tries `~/.ssh/id_ed25519` and `id_rsa`, but only for an SSH recipient, and hapi's store is encrypted to an age recipient.)
- **Decrypted values exist only in memory and in the `0600` tmpfs files.** `resolve` decrypts into its own memory (sops's output on a pipe, never a file), and writes only the zone env files on `XDG_RUNTIME_DIR`. `sops edit`'s temp file is on the tmpfs too. The sops child gets a minimal environment (`PATH`, `HOME`, `SOPS_AGE_KEY_FILE`, `SOPS_DISABLE_VERSION_CHECK=1`), so no other secret in your shell reaches it, and it can't phone home for a version check.
- **Each container sees its own zone's values.** Task 5 gives each container its zone's env file and no other; `host.env` goes to no container. Model keys are still visible inside their own containers, bounded by spend caps and egress (spec §11.5, residual risk).
- **The encrypted file is checked before it is decrypted.** Every top-level value must be sops-encrypted (or `""`), and it must be encrypted to an age recipient. A file with a value `unencrypted_suffix` or `unencrypted_regex` left in plaintext is refused, so a plaintext secret never sits in `private/` looking encrypted.
- **No automatic fallback.** `providerFor` builds exactly the configured provider. If it fails, nothing is written and nothing starts.
- **bws:** the access token is a bearer credential for every hapi secret; keep it in your environment only, with an expiry. **env-file:** plaintext on disk, audited.

## Open items

- **The research container's model key.** `hapi-research` (Plan 04) runs Hermes, so it needs a model key as well as its search keys. Plan 04 decides which capped key it gets, and adds it to the `research` zone of the manifest.
- **One store reads every zone.** A key, or a bws machine account, per zone would limit what one leaked key exposes. The resolver uses one store today.
- **bws ids aren't cross-checked against secret names.** `bws secret get` returns the secret's name. Checking it against the logical name would catch an id bound to the wrong name.
