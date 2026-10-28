# Secrets

Secrets come from a **pluggable secret provider** when the stack starts, never from a `.env` file in a repo (spec §11.5). They land in mode-`0600` files on the user's own tmpfs, `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`, and only once every name has resolved. GitHub tokens are minted outside the agents, for one repo at a time, and last one hour.

Secrets come in three parts:

| Part | Where | What it holds |
|---|---|---|
| **The manifest** | [`stack/secrets.yaml`](../stack/secrets.yaml), committed and public | Per zone, which env var gets which **logical name** (`hapi-hermes-anthropic-api-key`). No ids, no values. It is the single list of what must exist. |
| **The local config** | `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`, outside the repo | Which provider you use, and how to reach its store. No secret. |
| **The store** | The provider's own data | The values, under their logical names |

The providers:
- **sops + age, the default for everyone.** One encrypted file, encrypted to one age key per machine or user plus a recovery key that 10 words unlock ([keys and recovery](#keys-and-recovery)). No service to run, encrypted at rest, and the encrypted file can be backed up in a private repo. Onboarding is `mise run secrets:init`.
- **Bitwarden Secrets Manager (`bws`), optional.** The config binds each logical name to a bws secret id.
- **`env-file`, an explicit downgrade.** A plaintext `0600` file outside every checkout. Every run warns about it, and `hapi audit` fails on it (`secrets.provider`, [docs/audit.md](audit.md#secretsprovider)).

The rules:
- **The repo holds logical names only.** Never a value, and never an id or a path from your deployment.
- **Fail closed, with no automatic fallback.** If the configured provider fails, or any name is missing or empty, `hapi secrets resolve` writes nothing and names the secret. So the stack never starts with an empty variable. hapi never tries another provider.
- **No value is ever printed.** Not on stdout or stderr, not in an error message, not in a log. Errors name the zone, the env var, the logical name, the file or the exit code.
- **Keys and plaintext stay outside the checkout**, `private/` included. hapi refuses an age key file or an env-file store inside it.

This page covers:
- [the zones and their keys](#the-zones-and-their-keys) and [the manifest](#the-manifest-stacksecretsyaml);
- [the local config](#the-local-config);
- [getting started with sops + age](#getting-started-with-sops--age) and [adding a secret](#adding-a-secret);
- [keys and recovery](#keys-and-recovery): per-machine keys, the 10 words, post-quantum keys, and `join`, `add-machine`, `recover`, `drill`, `revoke` and `new-recovery`, with [a worked example](#worked-example-a-laptop-a-vm-and-the-hapi-user) and [lost vs compromised keys](#a-lost-key-a-compromised-key-lost-or-exposed-words);
- the commands: [`hapi secrets init`](#hapi-secrets-init), [`edit`](#hapi-secrets-edit), [`check`](#hapi-secrets-check) and [`resolve`](#hapi-secrets-resolve), and [the env files](#the-env-files);
- [rotating a secret](#rotating-a-secret) and [replacing a machine's key](#replacing-a-machines-key);
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
- **No env name hapi sets itself.** The containers get hapi's own settings from `stack/compose.yaml`'s `environment:`: each zone's proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in both cases), Archon's `HOST=127.0.0.1`, the telemetry switches, Pi's `PI_OFFLINE` and `PI_CODING_AGENT_DIR`, `ARCHON_DOCKER` and Hermes's `HERMES_HOME`. Compose puts `environment:` above the env file, so a secret could never override them anyway, and the loader refuses the names outright, in any zone, with `ALL_PROXY` too: `stack/secrets.yaml: /archon/HOST: HOST is reserved: hapi sets it in the containers itself ...`. The list is `RESERVED_ENV_NAMES` in `src/stack/env.ts`, the one place it is kept; a unit test checks the compose file against it.
- **No process-control or trust-store name.** hapi doesn't set these, so `environment:` can't shadow them, and a secret under one of them would change how a process in the container runs, which code it loads or which TLS certificates it trusts. So the loader refuses them too, in any zone: exact names (`PATH`, `HOME`, `BASH_ENV`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `GIT_SSH_COMMAND`, `XDG_CONFIG_HOME`, ...: `CONTROL_ENV_NAMES`) and anything under a prefix (`LD_`, `DYLD_`, `GIT_CONFIG_`, `NODE_`, `BUN_`, `NPM_CONFIG_`, `PYTHON`, `PIP_`, `UV_`, `MISE_`, `HERMES_`, `ARCHON_`, `PI_`, `CLAUDE_CODE_`: `CONTROL_ENV_PREFIXES`), with the rule in the error (`/hermes/LD_PRELOAD: LD_PRELOAD is reserved: env names starting LD_ ...`). `CLAUDE_CODE_` also keeps `CLAUDE_CODE_OAUTH_TOKEN` out, since the factory bills by API key and never uses subscription OAuth.
- **No endpoint override.** A name ending `_BASE_URL`, `_API_BASE`, `_API_URL` or `_ENDPOINT` (`ANTHROPIC_BASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`: `CONTROL_ENV_SUFFIXES`) would send a client's requests, and the key that goes with them, somewhere else. An endpoint is policy, committed and reviewed, not a secret, so the loader refuses those names too; the egress allowlists are the second check. A credential that is itself a URL, such as a webhook, ends in plain `_URL` and is allowed. All three lists live beside `RESERVED_ENV_NAMES` in `src/stack/env.ts`, and `reservedEnvRule` is the one check; no name in today's manifest is affected.
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
- **`sops.age_key_file` is optional.** Without it, hapi uses sops's own default, `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`, and tells sops so explicitly. It is *this machine's* key; other machines have their own.
- **Beside `sops.file`** sit its recipients file (`secrets.recipients.yaml` for `secrets.enc.yaml`) and `recovery.age` ([keys and recovery](#keys-and-recovery)). The config doesn't name them: hapi finds them next to the store.
- **A mistake is never echoed.** An error shows only the config's own keys and logical names; anything else in a JSON Pointer shows as `<key>` or `<name>`.

## Getting started with sops + age

Do this as the user that runs the stack (`hapi`, from Plan 01 Task 5 on), from the repo root, in a terminal.

1. **Install the pinned tools:** `mise install`. It installs `sops` and `age` (with `age-keygen` and `age-plugin-batchpass`) at the versions in `mise.toml`. hapi uses only that age, never one on your `PATH`: the distro's age 1.1.1 has no post-quantum keys and no batchpass.
2. **Create your store:**

   ```bash
   mise run secrets:init                                     # the store in ~/.config/hapi/
   mise run secrets:init -- --file private/secrets.enc.yaml  # or in private/, to back it up to your private repo
   ```

   It makes this machine's age key (or reuses yours), a recovery key, the encrypted store (every manifest name, empty), its recipients file, `recovery.age` and the config ([details](#hapi-secrets-init)).
3. **Store the 10 words.** init shows them once, on your terminal, and then asks you to type two of them back. Store them where you keep things you can't lose (a password manager, paper in a safe, or both). With `recovery.age` they open your secrets if every machine is lost ([why](#keys-and-recovery)).
4. **Prove they work:** `mise run secrets:drill`. Type the words; it says `recovery works: 14 names readable` ([details](#hapi-secrets-drill)).
5. **Fill in each value:** `mise run secrets:edit`. Your editor opens the decrypted file. Replace each `""` with the value from its runbook, then save and quit; sops encrypts it again ([adding a secret](#adding-a-secret)).
6. **Check it:** `mise run secrets:check`. Every line should say `found`, the recipients are listed, and it exits 0.

Each further machine or user (a VM, the `hapi` user) gets its own key with `join` and `add-machine`: see [the worked example](#worked-example-a-laptop-a-vm-and-the-hapi-user). `mise run up` runs `hapi secrets resolve` before it starts any container, and aborts if it fails ([the stack runbook](runbooks/stack.md#4-mise-run-up-and-mise-run-down)).

### Adding a secret

Run `mise run secrets:edit` and add, or fill in, one line per secret, under its logical name:

```yaml
hapi-hermes-anthropic-api-key: sk-ant-...
hapi-host-planner-app-id: "1234567"
hapi-host-planner-app-private-key: |
  -----BEGIN RSA PRIVATE KEY-----
  ...
  -----END RSA PRIVATE KEY-----
```

- Every value is a top-level string. A multi-line value, such as a PEM, is a YAML block scalar (`|`), its lines indented with spaces ([the GitHub Apps runbook](runbooks/github-apps.md#adding-the-id-and-key) has the Vim commands).
- **Quote a value YAML would read as something else,** such as a number (a GitHub App ID) or `true`. Unquoted, it isn't a string, and `check` and `resolve` stop with `<name> is not a string`.
- A value can't hold a single quote (`'`) or NUL: an env file can't carry them literally ([the env files](#the-env-files)). `check` reports such a value as `invalid`.
- **Don't use `sops set` or put a value on any command line:** it ends up in your shell history and in the process list.
- Then `mise run secrets:check`.

## Keys and recovery

**hapi never backs up a key by copying it.** Every store is encrypted to:
- **one age key per machine or user**, generated where it lives and never copied: your laptop, the VM and the `hapi` user each have their own;
- **one recovery (break-glass) recipient**, whose private key is wrapped with **10 words** that hapi generates, and kept as `recovery.age` beside the store.

Any one of them opens the store: sops makes one data key per store and wraps it separately for each recipient. This is the disaster-recovery pattern the sops docs recommend (several master keys, one of them kept offline), and the one age's author and Flux use. A copied key is a master key in a second place you can no longer account for. A key that never leaves its machine dies with it, and that's fine: the other recipients still open the store, and the machine is simply revoked.

**Your one backup job is the 10 words.** Store them where you keep things you can't lose: a password manager, paper in a safe, or both. `recovery.age` is useless without them, so it may sit in `private/` and be backed up with the store. Keep the words apart from it: never in the repo, `private/` or a note beside a copy of `recovery.age`.

What sits where:

| File | Where | What it is |
|---|---|---|
| The store, `secrets.enc.yaml` | anywhere (`private/` is fine) | the values, encrypted to every recipient |
| The recipients file, `secrets.recipients.yaml` | beside the store | each recipient's name, kind and public key, and `recovery.age`'s SHA-256: no secret |
| `recovery.age` | beside the store | the recovery key, wrapped with the 10 words (age's scrypt passphrase format, mode `0600`) |
| This machine's key, `keys.txt` | `~/.config/sops/age/` by default, **never** in a checkout | this machine's age identity, mode `0600` |
| The config, `secrets.yaml` | `~/.config/hapi/` by default | which store and which key this machine uses |
| The store's lock | `$XDG_RUNTIME_DIR/hapi/locks/`, never beside the store | while a command runs: which command holds the store, and its pid ([one command at a time](#the-commands)) |

### The recipients file

```yaml
# The age recipients secrets.enc.yaml is encrypted to, written by hapi secrets (docs/secrets.md#keys-and-recovery).
pq: true
recipients:
  - name: laptop-user
    kind: machine
    recipient: age1pq1...      # 1959 characters
    added: 2026-10-26
  - name: recovery
    kind: recovery
    recipient: age1pq1...
    added: 2026-10-26
    recovery_age_sha256: 9f86d081...   # recovery.age's SHA-256, 64 hex characters
```

- It sits beside the store, at the same basename stem: `private/secrets.enc.yaml` → `private/secrets.recipients.yaml`. The schema is [`policy/schemas/secrets-recipients.schema.json`](../policy/schemas/secrets-recipients.schema.json).
- A `name` matches `^[a-z0-9][a-z0-9-]{0,62}$`; `recovery` is the recovery recipient's. The default machine name is `<hostname>-<user>`, normalised to that pattern.
- **It must agree with the store.** `check` and every command below compare it with the recipients in the store's own sops metadata (read without decrypting). Drift either way is an error that names the recipient: `the store is encrypted to age1pq1qxyz…, which the recipients file doesn't list`, or `the recipients file lists vm-hapi (age1pq1…), but the store isn't encrypted to it`. Public keys aren't secret. It means one of the two files was changed outside hapi, or the two come from different commits: restore both from the same commit.
- **It records `recovery.age`'s SHA-256** in the recovery entry (`recovery_age_sha256`, required there and nowhere else). `recovery.age` is wrapped with the words, and its age header (an `scrypt` stanza: a salt and a work factor) names no recipient, so this is how `check` ties it to the recovery recipient without the words. A `recovery.age` from another commit or another store is an error for `check`, and `drill` and `recover` stop on it before asking for the words: `<dir>/recovery.age is not the recovery.age the recipients file records for recovery (age1pq1…): its SHA-256 differs, …`. `init` and `new-recovery` write it.
- **Age recipients only.** A store that is also encrypted to any other kind of sops master key (PGP, AWS, GCP or HuaweiCloud KMS, Azure Key Vault, Vault transit, or key groups) is refused by `check`, `resolve`, `edit` and every command below, naming the key type: `has a PGP key (sops.pgp) in its sops metadata, besides its age recipients`. So is any metadata field that sops 3.13.3, the pinned sops, doesn't write, whatever its value (`has a field hapi doesn't know (sops.<field>: it may hold a key)`): a newer sops's key type would be one. Such a key opens the store without being in the recipients file, and `sops rotate --rm-age` keeps it, so revoking a party who planted one (with raw `sops rotate -i --add-pgp`, say) would leave them able to read the reissued credentials. Remove it (`sops rotate -i --rm-pgp`, `--rm-kms` and so on) or restore the store from a commit without it, and unless you added it yourself, reissue every credential in the store.
- Change it only through the commands below. Each one writes the store and the recipients file in step.

### Post-quantum by default

Keys come from `age-keygen -pq`: a hybrid ML-KEM-768 + X25519 key pair (identity `AGE-SECRET-KEY-PQ-1...`, recipient `age1pq1...`), which age's own man page recommends for most uses. The costs:
- **Size:** each post-quantum recipient adds about 5 KB to the store (a 1959-character public key and its wrapped data key). A store with three machines and the recovery key is about 20 KB.
- **No P-256 hardware plugins.** The YubiKey and TPM age plugins make P-256 keys only, which can't join a post-quantum set.

**A mix is refused.** sops accepts a store with both post-quantum and classic recipients without a word, and the file is then only as strong as its classic recipient (age itself refuses a mix). So `check` and every command refuse one. `pq: false` makes a store all-classic (X25519) instead: `mise run secrets:init -- --classic`, the trade-off for hardware plugins later. `init` and `join` reuse an existing key only if its kind matches the store's, and otherwise stop and say why.

### The commands

Each is also a mise task: `mise run secrets:<command> -- <flags>`. `--config` picks the config as [above](#the-local-config).

| Command | Run it on | What it does |
|---|---|---|
| [`init`](#hapi-secrets-init) | the first machine | this machine's key, the recovery key and its words, the store, its recipients file, `recovery.age` and the config |
| [`join --store <file>`](#hapi-secrets-join) | a new machine or user | its own key and config; prints the `add-machine` command. It doesn't touch the store. |
| [`add-machine --name <n> --recipient <age1...>`](#hapi-secrets-add-machine) | a machine whose key opens the store | adds that public key |
| [`recover [--store <file>]`](#hapi-secrets-recover) | a box with the store, `recovery.age`, the recipients file and the words, but no key that opens them | makes its own key and adds it, with the words |
| [`drill`](#hapi-secrets-drill) | any machine with the store and `recovery.age` | proves the words open the store |
| [`revoke --name <n>`](#hapi-secrets-revoke) | a machine whose key opens the store | removes a recipient |
| [`new-recovery`](#hapi-secrets-new-recovery) | a machine whose key opens the store | new recovery key and words, for lost or exposed ones |

**Every recipient change makes a new data key.** It runs `sops --config /dev/null rotate -i --add-age … / --rm-age …` (never `updatekeys`, which keeps the old data key, so a removed key holder with an old copy could still read secrets added later). sops works on a temp copy beside the store; hapi checks the copy is encrypted to exactly the recipients asked for, renames it over the store in one step, then (for `new-recovery`) renames the new `recovery.age`, written beside it beforehand, into place, and only then rewrites the recipients file. If anything fails, all three stay as they were. The order is chosen so that a command killed between two of those steps always leaves a state `check` reports ([an interrupted command](#an-interrupted-command)).

**One command at a time.** Each of these commands, and [`edit`](#hapi-secrets-edit), holds the store's lock from before it reads the store until it is done, so two commands can't interleave and lose an update.
- **Where:** `$XDG_RUNTIME_DIR/hapi/locks/<SHA-256 of the store's real path>.lock` (the file `0600`, the directory `0700`), on your tmpfs. Never beside the store: `private/` is a git repo, and a lock committed there would stop every other machine. So these commands need `XDG_RUNTIME_DIR`, as `resolve` does ([below](#hapi-secrets-resolve)).
- **What:** one line, made whole and at once (a temp file hard-linked into place, which fails if a lock exists): `hapi secrets add-machine, pid 4242 (start 98765), started 2026-10-27T09:00:00.000Z, id 1a2b3c4d, store <checkout>/private/secrets.enc.yaml`. The start is the process's start time, so a pid reused by a later process isn't taken for the holder.
- **Released** when the command ends, however it ends, and on Ctrl-C, `SIGTERM` or `SIGHUP` too: hapi handles those signals itself while it holds the lock, removes the lock, prints `hapi secrets <command>: cancelled (SIGINT); released the lock on <store>` and exits 128 + the signal's number (130 for Ctrl-C). While the store, `recovery.age` and the recipients file are being renamed into place, a signal waits until they are, so Ctrl-C never leaves them half done.
- **A second command** while the first runs stops, naming it, and never takes a lock whose process still runs:

  ```text
  hapi secrets add-machine: another command, hapi secrets drill (pid 4242, started 2026-10-27T09:00:00.000Z), is using <checkout>/private/secrets.enc.yaml: wait for it to end, or stop it, and run this again. hapi never takes the lock (...) while its process runs
  ```
- **A stale lock**, whose process is gone (killed with `SIGKILL`, a crash), is removed by the next command, which says so in one line and goes on: `hapi secrets add-machine: removed a stale lock on <store>: hapi secrets drill (pid 4242, started …) is no longer running`. Then run `mise run secrets:check`: a command killed outright may have left the store and its recipients file out of step ([an interrupted command](#an-interrupted-command)). A reboot clears the tmpfs, and every lock with it.

The lock guards one copy of the store on one machine, for one user. Other machines' copies meet through git, and `check` reports a copy whose store and recipients file disagree. `check` and `resolve` only read, so they don't take the lock.

#### `hapi secrets join`

```text
hapi secrets join --store <file> [--name name] [--config file] [--age-key file]
```

For a new machine or user, with a copy of `private/` (the store, its recipients file and `recovery.age`), from a pull of the private repo, say. It makes this machine's key (`--age-key`, default sops's own path; an existing key is reused if its kind matches) and its config, and never overwrites either. Then it prints this machine's public key and the exact command to run on a machine that already has access:

```text
this machine's public key (vm-user): age1pq1...
next, on a machine whose key already opens the store, run:
  mise run secrets:add-machine -- --name vm-user --recipient age1pq1...
```

A name already in the recipients file is refused. The key is made in memory and written `0600` in a `0700` directory, never inside a checkout.

#### `hapi secrets add-machine`

```text
hapi secrets add-machine --name <n> --recipient <age1...> [--config file]
```

It checks the recipient's form (`age1pq1` and 1952 characters, or `age1` and 58) and kind (post-quantum or classic, as the store is), refuses a name or recipient that is already there, then adds it with `rotate -i --add-age` and updates the recipients file. Then bring the updated store and recipients file to the new machine (commit and push `private/`, then pull it there) and run `mise run secrets:check` on it.

#### `hapi secrets recover`

```text
hapi secrets recover [--store file] [--name name] [--config file] [--age-key file]
```

For a box that has the store, `recovery.age` and the recipients file, but no key that opens them: a new laptop after the old one died, say. Give `--store` if the box has no config yet.
1. It joins: this machine's key and config, as `join` would.
2. It checks `recovery.age` is the one the recipients file records, then reads the 10 words on the terminal (spaces, hyphens and case don't matter; a word not in the list is named by its position: `word 4 is not in the list`; Ctrl-C cancels, with echo back on), and unwraps the recovery key **in memory**.
3. It adds this machine's key with `rotate -i --add-age`, handing the recovery key to that one sops child as `SOPS_AGE_KEY`.
4. It updates the recipients file.

After that the machine works without the words. Then revoke the machine whose key was lost: `mise run secrets:revoke -- --name <old>`. A name that is already taken (the dead machine's, say) is refused, so pick another `--name`.

#### `hapi secrets drill`

```text
hapi secrets drill [--config file]
```

It proves your backup works, without changing anything. It reads the words, unwraps the recovery key, and decrypts the store in a sops child whose `HOME` and `XDG_CONFIG_HOME` are a fresh temp directory under `$XDG_RUNTIME_DIR/hapi/`, so no machine key can be loaded, and whose only key is the recovery one. It prints `recovery works: N names readable`, never a value, and deletes the temp directory. Besides that, it writes only [the lock](#the-commands), on your tmpfs, which it removes when it ends. Run it after `init`, after `new-recovery`, and now and then.

#### `hapi secrets revoke`

```text
hapi secrets revoke --name <n> [--config file]
```

It removes a recipient with `rotate -i --rm-age` and updates the recipients file. It refuses to remove the last machine key (nothing could open the store) or the only recovery recipient (use `new-recovery`). It ends with sops's documented order for a compromised key: **if this key may be compromised, also reissue every credential in the store: copies of the store in git history stay readable by the removed key forever.**

#### `hapi secrets new-recovery`

```text
hapi secrets new-recovery [--config file] [--no-confirm]
```

For words that are lost or exposed, or a `recovery.age` that no longer matches the recipients file. It needs a working machine key. It makes a new recovery key and 10 new words, with the same show-and-confirm as `init`; adds the new recipient (`rotate -i --add-age`), then removes the old one (`--rm-age`); and replaces `recovery.age` and the recipients file (with the new `recovery.age`'s SHA-256). That replace is the one deliberate one: the old `recovery.age` is kept in memory and put back if any step fails. Then run `mise run secrets:drill` with the new words.

`--no-confirm` skips the word check, as for `init`. It exists only for tests and non-interactive CI fixtures, and is refused when a person is at the terminal (stdin is a terminal, or `/dev/tty` opens). Without a terminal the new words are not shown at all, so that store's `recovery.age` can't be opened.

#### An interrupted command

**Ctrl-C, `SIGTERM` or `SIGHUP`** leave nothing to repair: the command releases [the lock](#the-commands), turns the terminal's echo back on if it was reading the words, and exits 130 (or 143, 129). A signal that arrives while the store, `recovery.age` and the recipients file are being renamed into place waits until they are.

**A command killed outright** (`SIGKILL`, a crash, a power cut) can leave two things behind.

**The lock.** The next command finds its process gone, removes it, and says so (`removed a stale lock on …`). After that message, run `mise run secrets:check` before anything else.

**A store, recovery.age and recipients file out of step.** A recipient change renames the new store into place, then (for `new-recovery`) the new `recovery.age`, then rewrites the recipients file. Killed between two of those, the store is encrypted to the new recipients while the recipients file still lists the old ones, and for `new-recovery`, `recovery.age` may be the new one while the recipients file records the old one's SHA-256. `mise run secrets:check` reports each: [drift](#the-recipients-file), naming the recipient, and `recovery.age is not the recovery.age the recipients file records`. Every command refuses the store until it is fixed.

Drift is also how a recipient planted with raw sops shows up (someone with write access to the store, adding their own key). So don't make the recipients file match the store by copying in whatever the store lists:
- **A recipient the recipients file is missing:** add its entry back only if its whole public key, in the store's `sops.age[].recipient`, is exactly the one the interrupted command was adding: the `--recipient` you gave `add-machine`, or for `recover`, this machine's own (`mise exec -- age-keygen -y <its key file>`). Give it the `name` you used, `kind: machine` and today's date as `added`.
- **An entry the store lacks:** delete it only if it is the recipient the interrupted `revoke` was removing.
- **Anything else, or any doubt** (and always after an interrupted `new-recovery`, whose new recovery key you never saw): **restore the store, its recipients file and `recovery.age` from the same commit**, the state before the command: `git -C private checkout HEAD -- secrets.enc.yaml secrets.recipients.yaml recovery.age` (for a store in `private/`, committed before the command), then run the command again (`new-recovery` makes new words again; forget the ones it showed). Use a commit `check` passes on. And **treat a recipient you didn't add as a possible compromise**: restore a commit without it (or, if it is listed in the recipients file there too, revoke it), and reissue every credential in the store, since its holder could read every copy made while it was there ([a compromised key](#a-lost-key-a-compromised-key-lost-or-exposed-words)).

`check` passes once they agree. Also delete any `.secrets.enc.yaml.*.tmp`, `.recovery.age.*.tmp` or `.secrets.recipients.yaml.*.tmp` file left beside the store: a half-done copy (encrypted, never plaintext; a `.recovery.age.*.tmp` is a new recovery key wrapped with the words `new-recovery` showed, so it holds nothing the restored store needs).

### Worked example: a laptop, a VM and the `hapi` user

The store lives in `private/`, which is its own git repo pushed to your private remote.

1. **On the laptop:** `mise run secrets:init -- --file private/secrets.enc.yaml`. Store the 10 words. `mise run secrets:drill`, then `mise run secrets:edit` to fill in the values. Commit and push `private/`.
2. **On the VM**, with the repo cloned and `private/` pulled: `mise run secrets:join -- --store private/secrets.enc.yaml`. It prints an `add-machine` command with the VM's public key.
3. **On the laptop:** run that command (`mise run secrets:add-machine -- --name vm-user --recipient age1pq1...`, `vm-user` being the VM's `<hostname>-<user>`). Commit and push `private/`.
4. **On the VM:** pull `private/`, then `mise run secrets:check`.
5. **The `hapi` user** that runs the stack is another user, so it gets its own key the same way, under its own name (`hapi`). You copy the store, its recipients file and `recovery.age` into hapi's config dir with `scripts/copy-secrets-to-hapi.sh`, as yourself, from your checkout: it hands the three files to a `tar` running as hapi, which writes them into `~/.config/hapi/`, because root never writes into hapi's home ([why](runbooks/stack.md#hardening)). As `hapi`, with `XDG_RUNTIME_DIR` exported: `mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name hapi`. Then `add-machine` in a checkout whose key opens the store, the three files copied again, and `check` as `hapi`. The full steps are in [the stack runbook](runbooks/stack.md#3-the-hapi-users-secrets).

Now any one of the three keys, or the words with `recovery.age`, opens the store, and none of them was ever copied.

### A lost key, a compromised key, lost or exposed words

- **A lost key** (the machine died, the key file was deleted): nothing leaked. On any machine whose key still opens the store, `revoke --name <lost>`. If none does, `recover` on a new machine with the words, then revoke the lost one.
- **A compromised key** (copied, stolen, or on a machine you no longer trust): `revoke --name <it>`, which makes a new data key, commit and push the store, then **reissue every credential in the store** at its vendor ([rotating a secret](#rotating-a-secret)). Removing a key doesn't undo the past: it still opens every old copy of the store, in `private/`'s git history, say, forever.
- **Lost words:** `new-recovery`, on a machine whose key opens the store. If no machine opens it and the words are lost, the store is gone: that is what the words are for.
- **Exposed words:** `new-recovery`, then treat it as a compromised key: old copies of the store and of `recovery.age` still open with the old words, so reissue every credential.

### Later add-ons

Not built; each would be one more recipient. The last two are sops master keys of another kind, which hapi refuses today ([age recipients only](#the-recipients-file)), so each needs hapi support first:
- **Hardware keys** (YubiKey or TPM through age plugins): a key that can't be copied off the device. They are P-256 only, so the store would have to be `pq: false`.
- **Shamir key groups** (sops `key_groups` with `shamir_threshold`): "any 2 of 3 people" for a team, instead of one set of words.
- **A cloud KMS key** as a recipient: recovery through a cloud account, at the cost of depending on one (about $1 per key a month on AWS).

### Threat notes: keys and recovery

- **The words plus `recovery.age` are a master key.** Either alone is nothing: the words are 10 words from age's 2048-word list (about 110 bits, drawn by hapi with `crypto.getRandomValues`), behind age's scrypt. Keep them apart.
- **The words and the recovery key live only in memory.** The words are shown on, and read from, your terminal (`/dev/tty`, echo off), never stdout or stderr. Ctrl-C at the prompt kills the shell reading the line (left behind, it would swallow the next line you type at your prompt) and turns echo back on. hapi hands the passphrase to age on file descriptor 3 (`AGE_PASSPHRASE_FD`, through the bundled `age-plugin-batchpass`), never on a command line, in an environment variable or in a file. The unwrapped recovery key goes to age-keygen and age on stdin; it is never on a command line or in a file, and in an environment variable only for the one sops child that needs it, as `SOPS_AGE_KEY`, in `recover` and `drill`. (`new-recovery` rotates with this machine's key, so its sops child never gets the recovery key.) Tests check every tool call, file and message for them, the integration test with the real binaries included.
- **sops never gets a wrapped key.** A passphrase-wrapped key in sops's key sources would make sops prompt through gpg-agent or the terminal, on every decrypt, on every machine. hapi unwraps `recovery.age` itself and hands the plain key to the one sops child that needs it (in `recover` and `drill`), as `SOPS_AGE_KEY`.
- **No gpg-agent.** sops's gpg-agent client ignores `GNUPGHOME` and `$HOME`, so a sandboxed `HOME` still reaches your real agent. Every sops child hapi runs gets `GPG_AGENT_INFO=` (empty), which keeps sops off any agent.
- **The pinned age, always.** hapi finds it with `mise where age` and checks `age --version` is at least the pin (1.3.2); its directory leads the `PATH` of every age and sops child (sops runs age plugins from `PATH`).
- **Without hapi:** `recovery.age` is a standard age passphrase-encrypted file, and its passphrase is the 10 words joined by hyphens (`word-word-...`), like age's own generated ones. `mise exec -- age -d recovery.age` asks for it.

## `hapi secrets init`

```text
hapi secrets init [--config file] [--file file] [--age-key file] [--name name] [--classic] [--no-confirm]
mise run secrets:init [-- flags]
```

- `--config`: where to write the config (default as [above](#the-local-config)).
- `--file`: the store. Default `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.enc.yaml`. It may be in the checkout's `private/`. Its recipients file and `recovery.age` go beside it.
- `--age-key`: this machine's age key file. Default sops's own, `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`. It may **not** be inside the checkout.
- `--name`: this machine's name in the recipients file. Default `<hostname>-<user>`, normalised to `^[a-z0-9][a-z0-9-]{0,62}$`.
- `--classic`: all-classic (X25519) keys instead of post-quantum ([the trade-off](#post-quantum-by-default)).
- `--no-confirm`: skip the word check. It exists only for tests and non-interactive CI fixtures, and is refused when a person is at the terminal (stdin is a terminal, or `/dev/tty` opens).
- A relative path is relative to the current directory; `~` is your `$HOME`.

What it does:
1. **It never overwrites anything.** If the config, the store, `recovery.age` or the recipients file exists, it stops: `<path> already exists, and hapi secrets init never overwrites anything: run \`hapi secrets check\` to see what your store holds`. It also refuses two of those paths, or the age key, being the same file.
2. **This machine's key.** If the key file exists, it is reused once it passes the [key checks](#threat-notes) and its kind matches (post-quantum by default). Otherwise `age-keygen -pq` makes one, in memory for now.
3. **The recovery key and its 10 words**, in memory: `age-keygen -pq` (its public key read back with `age-keygen -y`, since that can't read a wrapped file later), and 10 words from age's 2048-word list.
4. **The words, shown once** on your terminal, with what to do with them. Once you say they're stored, the screen is cleared and it asks for 2 of them, at random positions. A mismatch shows them again, up to 3 tries, then it stops. Without a terminal it stops before anything is made.
5. **Only then:** the recovery key is wrapped with the words (`age -e -a -j batchpass`, the passphrase on a pipe), and the template (every logical name in the manifest, each `""`) is piped on stdin to `sops encrypt --age <this machine>,<recovery> --input-type yaml --output-type yaml --filename-override <file>`, with `--config /dev/null` so no `.sops.yaml` can change it. **Plaintext never touches disk.** sops's output is checked to be encrypted, to exactly those two recipients, before anything is written. (sops leaves an empty string as `""`: there is nothing to encrypt.)
6. **The writes:** this machine's key (if new), the store, `recovery.age`, the recipients file and the config (`provider: sops`, both paths absolute). Each is mode `0600`, in a directory made or tightened to `0700`, and **no-replace**: written to a temp file and hard-linked into place, so a file that appeared after the checks is never replaced. If one fails, the ones already written are removed.

An abort at any step writes nothing. It refuses a new file directly in `$HOME` or `~/.config`, which it won't tighten to `0700`. Then it lists what it wrote and the next steps, `mise run secrets:drill` and `mise run secrets:edit`.

## `hapi secrets edit`

```text
hapi secrets edit [--config file]
mise run secrets:edit
```

For the sops provider only. Holding the store's [lock](#the-commands), it first runs the store checks every lifecycle command runs: the file's shape, age recipients and nothing else (no [other master key](#the-recipients-file), no metadata field hapi doesn't know), and the recipients file in step with the store, with no post-quantum/classic mix. So new values never go into a store that a key outside the recipients file could open. Then it checks the age key, and runs `sops edit` on the configured file in your terminal, with your `$EDITOR`. sops decrypts the file into a temp file for the editor and encrypts it again when you quit.

- **The temp file is on your tmpfs.** hapi sets `TMPDIR` to `$XDG_RUNTIME_DIR/hapi`, so it needs `XDG_RUNTIME_DIR` ([below](#hapi-secrets-resolve)). Make sure your editor doesn't copy the buffer anywhere else. Neovim keeps swap files under `~/.local/state/nvim/` and history in its ShaDa file, Vim keeps registers in `~/.viminfo`, and either keeps an undo file if your config turns one on. So run `EDITOR='nvim --clean -n' mise run secrets:edit`, or `EDITOR='vim --clean -n' mise run secrets:edit`: `--clean` skips your config and the history file, and `-n` the swap file. nano, by default, keeps nothing outside the temp file.
- **Your shell's `SOPS_*` variables are dropped**, so they can't add a recipient or a key; hapi sets `SOPS_AGE_KEY_FILE`, `SOPS_DISABLE_VERSION_CHECK=1` and `GPG_AGENT_INFO=`, and puts the pinned age first on `PATH`. sops runs with `--config /dev/null`.
- If you quit without a change, sops exits 200, which hapi treats as success.
- **Ctrl-C in the editor is the editor's.** It reaches hapi too (they share the terminal), so while `sops edit` runs, hapi ignores it, as `system(3)` does; a `SIGTERM` or `SIGHUP` waits until sops ends, then hapi releases the lock and exits.

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
recipient machine  laptop-user (post-quantum, added 2026-10-26)
recipient recovery recovery (post-quantum, added 2026-10-26)
```

- `found`: present and usable. `missing`: not in the store. `empty`: `""` or blank. `invalid`: present, but a value `resolve` refuses. A missing [MCP mapping](#mcp-secrets) is a `missing` line too.
- `unknown`: a name in the store (for bws, in `bws.ids`) that the manifest doesn't list. It doesn't fail the check. A name that isn't a logical name is shown as `(a name that is not a logical name, not shown)`, in case a value was pasted as a key.
- `recipient` (sops only): each of the store's recipients, with its kind and whether the store is post-quantum ([keys and recovery](#keys-and-recovery)).
- **It exits 1 if anything is missing, empty or invalid**, and says so on stderr. A provider failure (sops can't decrypt, say) is an error, exit 1. For sops, so is a missing or invalid recipients file, [drift](#the-recipients-file) between it and the store, a post-quantum/classic mix, or a master key in the store that [isn't an age recipient](#the-recipients-file), or a metadata field hapi doesn't know.
- For sops it is also an error when `recovery.age` isn't the one the recipients file [records](#the-recipients-file) (its SHA-256 differs). After drift it ends with what to do: add a missing recipient back only if it is exactly the key an interrupted command was adding, otherwise restore all three files from one commit and treat the recipient as a compromise ([an interrupted command](#an-interrupted-command)).
- **It warns, and still exits 0,** when the store has no recovery recipient (`if every machine key is lost, so is the store`) or `recovery.age` is missing beside it.

## `hapi secrets resolve`

```text
hapi secrets resolve [--config file] [--dry-run]
```

`--dry-run` is [`hapi secrets check`](#hapi-secrets-check). Without it, in order:

| Step | On failure |
|---|---|
| 1. `XDG_RUNTIME_DIR` must be set to an absolute path | a plain `Error` |
| 2. load the manifest (`stack/secrets.yaml`) and check it against its schema | a `PolicyError`, naming the file and JSON Pointer |
| 3. load the config; a missing file, then the schema | a `SecretError` ("no secrets config at ..."), then a `PolicyError` |
| 4. check the manifest maps every MCP reference (`mcpSecretGaps`) | a `SecretError` |
| 5. check `XDG_RUNTIME_DIR` is a real directory, yours, mode `0700` as systemd makes it, and make `hapi/` in it (`0700`) | a plain `Error` |
| 6. fetch every logical name once, from the configured provider only (for sops: the pinned age, the key checks, the file's shape, then `sops decrypt`) | a `SecretError` naming the file, the exit code or the names |
| 7. check every value: present, not empty or blank, no single quote, no NUL | a `SecretError` naming `zone/ENV (name)` |
| 8. write the whole set ([the env files](#the-env-files)) and print each path | |

Nothing is written unless every step passes. `hapi` prints the error and exits 1:

```text
hapi secrets resolve: hermes/ANTHROPIC_API_KEY (hapi-hermes-anthropic-api-key) is not in the sops store (/home/hapi/.config/hapi/secrets.enc.yaml has no hapi-hermes-anthropic-api-key): add it with `mise run secrets:edit`
hapi secrets resolve: hermes/SLACK_APP_TOKEN (hapi-hermes-slack-app-token) is empty: fill it in with `mise run secrets:edit`
hapi secrets resolve: sops could not decrypt /home/hapi/.config/hapi/secrets.enc.yaml (exit 128): Failed to get the data key required to decrypt the SOPS file.
hapi secrets resolve: age key file /home/hapi/.config/sops/age/keys.txt has group or other permission bits (mode 0644): run chmod 600 /home/hapi/.config/sops/age/keys.txt
```

**`XDG_RUNTIME_DIR`** is the user's own tmpfs (systemd creates `/run/user/<uid>` at login, mode 0700), so nothing survives a reboot. **There is no fallback**: never `/tmp`, never the repo. Outside a login session (under `sudo -iu hapi`, say), set it yourself with `export XDG_RUNTIME_DIR=/run/user/$(id -u)` if that directory exists. `loginctl enable-linger hapi` (which `scripts/host-setup.sh` turns on) keeps it for the `hapi` user.

## The env files

Consumers read **`$XDG_RUNTIME_DIR/hapi/env/<zone>.env`**: `hermes.env`, `archon.env`, `research.env` and `host.env`.

- **The whole set at once.** `env` is a symlink to a generation directory, `env.<random>/` (`0700`). Each resolve writes every zone file into a fresh generation, then swaps the symlink with one `rename`, then deletes the generation it replaced, and any other more than a minute old (one a crash left behind; a younger one may be a concurrent resolve's, still being written, and is left for a later run). A reader sees the old set or the new one, never a mix, and a zone file the manifest no longer has disappears with the old generation. If `env` is a real directory, not hapi's symlink, resolve refuses to touch it. It also removes the `<zone>.env` files an earlier version wrote directly in `$XDG_RUNTIME_DIR/hapi/` (regular files only).
- **Modes:** each file `0600`, whatever the umask; `hapi/` and each generation `0700`. `XDG_RUNTIME_DIR` itself must be yours and exactly `0700`.
- **Format:** a comment header, then one `NAME='value'` per env var, sorted by name. **Docker Compose reads a single-quoted value literally** in an `env_file`: no `${...}` interpolation, no escapes, and newlines kept. So a value with `$`, `"`, `#`, spaces or backslashes, or a multi-line PEM, arrives exactly as stored. (Checked with Docker Compose v5.6.1, `docker compose config`.) An unquoted `KEY=abc$def` would arrive as `abc`, which is why hapi always quotes. A value can't hold a single quote, so a secret with one is refused by name. Rotate it to one without.
- **`host.env` is for host tools only.** It holds the GitHub App private keys. `stack/compose.yaml` gives each container its own zone's file and never `host.env`, and the stack's integration tests check that no container sees a `host.env` value.
- **A zone's file is its container's only `env_file`, and it can't override hapi's own settings.** Those are in the service's `environment:`, which Compose puts above `env_file`; the integration test appends overriding lines (`HOST='0.0.0.0'`, `HTTPS_PROXY=...`) to the files it resolved and checks that the containers still get hapi's values. The manifest may not name them at all ([the manifest](#the-manifest-stacksecretsyaml)).

## Rotating a secret

1. Put the new value under the same logical name in your store (`mise run secrets:edit`).
2. Revoke the old value at the vendor.
3. Run `mise run up`. It resolves again, and Compose recreates each container whose env file changed. For the `hapi` user, copy the store to it first ([re-syncing](runbooks/stack.md#re-syncing-after-you-edit-the-store)).

To rotate a GitHub App private key, see [the GitHub Apps runbook](runbooks/github-apps.md#rotating-a-private-key).

## Replacing a machine's key

To move one machine to a new key (a fresh start, or a key that may have leaked), add the new key as a recipient, switch to it, then revoke the old one. On that machine:

```bash
new=~/.config/sops/age/keys.new.txt
(umask 077 && mise exec -- age-keygen -pq -o "$new")        # -pq unless the store is pq: false
mise run secrets:add-machine -- --name <name>-new --recipient "$(mise exec -- age-keygen -y "$new")"   # <name>: this machine's, as check lists it
# point sops.age_key_file in ~/.config/hapi/secrets.yaml at "$new", then:
mise run secrets:check
mise run secrets:revoke -- --name <the old name>
```

Then shred the old key file. If the old key may have leaked, also [rotate every secret](#rotating-a-secret): it still opens old copies of the store. Every step makes a new data key; hapi never uses `sops updatekeys`, which doesn't.

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

**Why it is audited:** the values sit on disk in plaintext, readable by anything that runs as you and by any backup of your home directory. So `resolve` and `check` print a warning on every run, and `hapi audit` fails on the config as a downgrade (`secrets.provider`: `describeSecretsConfig` returns `downgrade: true`; `--dev` makes it a skip, [docs/audit.md](audit.md#secretsprovider)). Move to sops + age when you can: `mise run secrets:init`, copy each value across with `mise run secrets:edit`, then shred the env file.

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
- Don't pass through text that might hold one: a tool's stdout, `JSON.parse`'s own message (it can quote its input), a GitHub response body other than its `message`. For a tool's stderr (sops, age, age-keygen, bws), hapi shows only the first line, without ANSI codes, and after each `:` keeps only a segment that is a path, since a parse error can quote the file.
- A name, id or key that fails validation is not echoed either, in case a secret was pasted in its place.

The error kinds: a `PolicyError` when the manifest or the config doesn't match its schema; a plain `Error` for `XDG_RUNTIME_DIR`; a `SecretError` for a missing config, the provider and the store. Tests feed fake values through every failure path and check they never reach a message, stdout or stderr.

## Threat notes

- **Each machine's age key opens the store.** It and any copy of the encrypted file together are every secret, which is why keys are never copied and a lost or doubtful one is revoked ([keys and recovery](#keys-and-recovery); the words have [their own notes](#threat-notes-keys-and-recovery)). hapi checks the key file before every decrypt, edit and recipient change: it must exist, be owned by you, have no group or other permission bit, hold plain age identities only (`AGE-SECRET-KEY-1...` or `AGE-SECRET-KEY-PQ-1...` lines, and comments), not be the store's `recovery.age`, and sit **outside the hapi-factory checkout, `private/` included**, because `private/` is pushed to the private remote next to the encrypted file. So sops never gets a wrapped key, such as `recovery.age` named as `age_key_file` by mistake, or a plugin's: it would prompt for the first and run a plugin for the second. The checkout is the worktree hapi runs from (`git rev-parse --show-toplevel`) and the repo's main worktree (the parent of `git rev-parse --git-common-dir`), so a key in the main checkout's `private/` is refused even when hapi runs from a `.worktrees/` worktree; git runs with every `GIT_*` variable cleared. If git can't say (it isn't installed, the directory isn't a checkout, or git refuses a checkout another user owns as "dubious ownership"), hapi stops with git's error instead of guessing, since a guessed boundary could leave the main worktree's `private/` outside it: run hapi as the user that owns its checkout. sops 3.13 also reads its own default key file (under `$HOME/.config/sops/age/`, or `$XDG_CONFIG_HOME` for `edit`) as well as the one it is told to use, so when that exists it must pass the same checks. (It also tries `~/.ssh/id_ed25519` and `id_rsa`, but only for an SSH recipient, and hapi's store is encrypted to age recipients.)
- **Decrypted values exist only in memory and in the `0600` tmpfs files.** `resolve` decrypts into its own memory (sops's output on a pipe, never a file), and writes only the zone env files on `XDG_RUNTIME_DIR`. `sops edit`'s temp file is on the tmpfs too. The sops child gets a minimal environment (`PATH` with the pinned age first, `HOME`, `SOPS_AGE_KEY_FILE`, `SOPS_DISABLE_VERSION_CHECK=1`, `GPG_AGENT_INFO=`), so no other secret in your shell reaches it, it never dials a gpg-agent, and it can't phone home for a version check.
- **Each container sees its own zone's values.** `stack/compose.yaml` gives each container its zone's env file and no other; `host.env` goes to no container. Model keys are still visible inside their own containers, bounded by spend caps and egress (spec §11.5, residual risk).
- **The encrypted file is checked before it is decrypted.** Every top-level value must be sops-encrypted (or `""`), and it must be encrypted to an age recipient and to no other kind of master key: a PGP, cloud KMS or Vault key, or key groups, would open it without appearing in the [recipients file](#the-recipients-file). Besides `age`, only sops 3.13.3's bookkeeping (`lastmodified`, `mac`, `version`, `shamir_threshold`, `mac_only_encrypted`, and the `unencrypted_`/`encrypted_` `suffix`, `regex` and `comment_regex` settings) and empty key lists may be there. Any other key list, and any field hapi doesn't know, whatever its value, is refused; a field whose name isn't a plain identifier is not shown. A file with a value `unencrypted_suffix` or `unencrypted_regex` left in plaintext is refused, so a plaintext secret never sits in `private/` looking encrypted.
- **No automatic fallback.** `providerFor` builds exactly the configured provider. If it fails, nothing is written and nothing starts.
- **bws:** the access token is a bearer credential for every hapi secret; keep it in your environment only, with an expiry. **env-file:** plaintext on disk, audited.

## Open items

- **The research container's model key.** `hapi-research` (Plan 04) runs Hermes, so it needs a model key as well as its search keys. Plan 04 decides which capped key it gets, and adds it to the `research` zone of the manifest.
- **One store reads every zone.** A key, or a bws machine account, per zone would limit what one leaked key exposes. The resolver uses one store today.
- **A store made before recovery keys** (by an earlier `hapi secrets init`) has no recipients file, so `check`, `edit` and the lifecycle commands refuse it. There is no migration command: make a new store with `mise run secrets:init` at another path, read the old values with raw sops and the old age key, in your terminal, `GPG_AGENT_INFO= SOPS_AGE_KEY_FILE=<the old age key> mise exec -- sops --config /dev/null decrypt <the old store>` (it prints every value: never redirect it to a file), and type or paste each into the new store with `mise run secrets:edit`. Then delete the old store, and its key once nothing else uses it.
- **bws ids aren't cross-checked against secret names.** `bws secret get` returns the secret's name. Checking it against the logical name would catch an id bound to the wrong name.
