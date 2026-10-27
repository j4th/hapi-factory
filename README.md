# hapi-factory

hapi-factory is a public, best-practices reference stack for an end-to-end agentic software factory. **HAPi** stands for **H**ermes + **A**rchon + **Pi**: Hermes is the coordinator you talk to, Archon is the run engine and Pi is the worker. The stack puts existing tools together into one working system. It also covers the steps most factories skip: discovery research, architecture, threat modeling and breaking work into tasks. Security is designed in from the start: one policy compiled into every tool's config, rootless containers behind default-deny egress, secrets from a pluggable secret provider (sops + age by default), short-lived GitHub App tokens, and an audit that catches drift. Read the design in [docs/superpowers/specs/2026-10-26-hapi-factory-design.md](docs/superpowers/specs/2026-10-26-hapi-factory-design.md). It is the binding reference for everything here.

> **Status: Plan 01 (Phase 0 foundations) is in progress.** Today the repo has the pinned toolchain, the `hapi` CLI skeleton, CI, `policy/` with its JSON Schemas, loader, tighten-only repo overlay and work-order validator, the generators that compile policy into Hermes, Archon, Pi and egress-proxy configs (`mise run policy:build`), the pinned per-zone MCP catalog with its tool-description lock, fail-closed secrets from a pluggable provider, sops + age by default (`mise run secrets:init`, `hapi secrets resolve`) with per-machine keys and a 10-word recovery key, scoped GitHub App token minting (`hapi token mint`), the stack itself (`stack/compose.yaml`: Hermes and Archon on internal-only networks behind per-zone Squid egress proxies, started by `mise run up` as the `hapi` user, with `scripts/host-setup.sh` for the one-time host setup and integration tests that prove the egress boundary on real Docker), the audit (`mise run audit`: config drift, the running stack's settings, pins, Archon's and Hermes's own validation, the MCP lock, the secrets setup, and each repo's rulesets, App permissions and AI workflows), the setup runbooks, the MAESTRO threat model v0 ([docs/security/threat-model.md](docs/security/threat-model.md)) and the kill-switch runbook ([docs/runbooks/kill-switches.md](docs/runbooks/kill-switches.md)). Anything marked *arrives in Plan 01 Task N* is not built yet. The plan is [docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md).

## Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Repo layout](#repo-layout)
- [mise tasks](#mise-tasks)
- [The `hapi` CLI](#the-hapi-cli)
- [Toolchain and pinning](#toolchain-and-pinning)
- [CI](#ci)
- [Using hapi-factory with another repo](#using-hapi-factory-with-another-repo)
- [Manual setup steps (the operator)](#manual-setup-steps-the operator)
- [Documentation map](#documentation-map)

## Prerequisites

- **Linux.** It is the only supported OS (spec §3).
- **[mise](https://mise.jdx.dev/getting-started.html) 2026.10.9 or newer.** It installs every other tool at a pinned version. `mise.toml` enforces the minimum with `min_version`.
- **Docker Engine with Compose v2.** You need it only for the stack and the integration tests. Linting and unit tests don't need Docker. The stack runs on rootless Docker as a dedicated `hapi` user, which `scripts/host-setup.sh` creates ([docs/runbooks/stack.md](docs/runbooks/stack.md)).
- **git.**

You don't need to install Bun, Node, Python, uv, gh, gitleaks, sops or age yourself. `mise install` installs them all.

## Quick start

```bash
git clone https://github.com/j4th/hapi-factory.git   # the public remote is a manual step, see below
cd hapi-factory
mise trust                   # first time only: let mise load this repo's mise.toml
mise install                 # install the exact tool versions pinned in mise.toml
git config core.hooksPath .githooks   # the commit hooks: gitleaks on staged changes, and no personal strings
mise run lint                # install JS deps from bun.lock, then type-check
mise run test                # run the unit tests
mise run hapi -- --version   # run the CLI (prints 0.1.0)
```

The unit tests need no secrets. To run the stack you also need a secrets store ([docs/secrets.md](docs/secrets.md#getting-started-with-sops--age)):

```bash
mise run secrets:init        # this machine's key, a recovery key, the encrypted store (all empty) and the config
                             # it shows 10 recovery words once: store them where you can't lose them
mise run secrets:drill       # prove the words open the store
mise run secrets:edit        # fill in each value in your editor; sops encrypts it again
mise run secrets:check       # every secret should say found
```

Another machine or user gets its own key, never a copy: `secrets:join` there, then `secrets:add-machine` where the store already opens ([docs/secrets.md](docs/secrets.md#keys-and-recovery)).

The stack runs as a dedicated `hapi` user on rootless Docker. Set the host up once with `sudo scripts/host-setup.sh`, give `hapi` its own key to the store, then `mise run up` from any account ([docs/runbooks/stack.md](docs/runbooks/stack.md)).

## Repo layout

What exists now:

| Path | What it is |
|---|---|
| `mise.toml` | Tool pins and the [mise tasks](#mise-tasks). This is a protected path (spec §8.2): an interactive agent session must ask the operator before editing it, and unattended sessions and workers may not edit it at all. |
| `package.json`, `bun.lock` | JS project metadata and dependencies, pinned to exact versions: `ajv` (JSON Schema validation) and `yaml` at runtime, `typescript` and `@types/bun` for development. The lockfile is committed. |
| `.factory/config.yaml` | hapi-factory's own repo overlay (spec §7): when the factory works on this repo, it also protects `policy/**`, `stack/**` and `.githooks/**`. An overlay can only tighten the central policy, and `.factory/**` is itself a protected path. Enforced once Plan 03's run engine loads overlays (H-172). |
| `.githooks/` | The commit hooks, installed with `git config core.hooksPath .githooks`. `pre-commit` runs gitleaks, at the version `mise.toml` pins, on the staged changes, then stops the commit if a staged line or path holds one of the operator's personal strings (`private/personal-strings.txt`). `commit-msg` checks the message the same way. In a clone without `private/`, the personal-strings check is skipped with a notice. Don't bypass them with `--no-verify`. A protected path in hapi-factory's overlay, since they run on your machine at every commit. |
| `.coderabbit.yaml` | CodeRabbit's review-only config (spec §9.6): every way it can write to the repo is off, and its tools stay on as a second opinion beside CI. A protected path, since CodeRabbit reviews a PR with that branch's own copy. |
| `bunfig.toml` | Bun install settings: exact versions and a 3-day release-age cooldown (see [Toolchain and pinning](#toolchain-and-pinning)). |
| `tsconfig.json` | Strict TypeScript settings, used only for type-checking. Bun runs the `.ts` files directly. |
| `src/cli.ts` | The `hapi` CLI: the entry point, the command registry and `main(argv)`. |
| `src/version.ts` | `HAPI_VERSION`. It must match `version` in `package.json`, and a test checks that it does. |
| `policy/` | The single source of truth: protected paths, commands, trusted sources, budgets, approvals, roles, flags, the model rosters (`policy/rosters/`), and the MCP catalog (`mcp.yaml`) with its tool-description lock (`mcp.lock.json`). See [docs/policy.md](docs/policy.md) and [docs/mcp.md](docs/mcp.md). |
| `policy/schemas/` | JSON Schemas (draft 2020-12) for every policy file, the MCP lock, the repo overlay (`.factory/config.yaml`), the work order (`order.yaml`), the secrets manifest (`stack/secrets.yaml`), the local secrets config and a sops store's recipients file |
| `src/policy/` | `loadPolicy` (load and validate `policy/`), `loadOverlay` and `applyOverlay` (the repo overlay, which may only tighten policy), `effectiveModes` (a file's protected-path modes: the strictest across every matching glob), `matchCommand` (whether Hermes's argv-exact command rules allow a command), `forgeDomain` (forge hosts, which the archon zone may never reach), `isHostname` (a plain domain name, as the schema defines it), `zoneHosts` (an egress zone's allowlist), `serversForZone` (a zone's MCP servers, with the catalog's floor, blocklist and tool checks in `mcp.ts`), the policy types and the shared schema checker |
| `src/mcp/` | The MCP tool-description lock (`lock.ts`): `hashToolSurface`, `verifyLock`, and the `hapi mcp verify` and `hapi mcp pin` commands |
| `src/workorder/` | `validateWorkOrder` and the `hapi workorder validate` command |
| `stack/secrets.yaml` | The secrets manifest: per zone (`hermes`, `archon`, `research`, `host`), which env var gets which logical name (`hapi-hermes-anthropic-api-key`). Public and provider-neutral: no ids, no values. It is the single list of what your store must hold. See [docs/secrets.md](docs/secrets.md#the-manifest-stacksecretsyaml). |
| `src/secrets/` | `manifest.ts`: `loadManifest` and `mcpSecretGaps` (the manifest covers the MCP catalog's `secret:` references). `provider.ts`: the `SecretProvider` interface, `SecretError`, `loadSecretsConfig` (the local config), `resolveSecrets` (fail-closed: every name into memory, then the env files), `checkSecrets` and `describeSecretsConfig`. `cli.ts`: every `hapi secrets` command handler, and `providerFor` (exactly the configured provider, no fallback). `providers/`: `sops.ts` (the default, and the pinned-age lookup), `bws.ts` (optional) and `env-file.ts` (a downgrade). `init.ts`: `hapi secrets init`. `lifecycle.ts`: per-machine keys and recipient changes: `join`, `add-machine`, `recover`, `drill`, `revoke` and `new-recovery`. `store-files.ts`: what init and those commands share: the no-replace writes, the path checks, the config text, and the store's lock (under `$XDG_RUNTIME_DIR/hapi/locks/`, never beside the store; a stale one is cleared) that every lifecycle command and `edit` hold. `interrupt.ts`: what a command undoes on Ctrl-C, `SIGTERM` or `SIGHUP` (the lock, the terminal's echo), and the steps a signal waits for. `recipients.ts`: the recipients file (with `recovery.age`'s SHA-256), the post-quantum/classic check and drift against the store. `recovery.ts` and `wordlist.ts`: the recovery key and its 10 words (age's BIP-39 list, BSD-3-Clause). `files.ts`: secrets on disk: `runtimeDir` (`$XDG_RUNTIME_DIR/hapi`, no fallback), `secureDir` (0700 under a 0700 `XDG_RUNTIME_DIR`), `writeSecretFiles` (the whole set at once, by symlink swap), `writeNewSecretFile` (no-replace), the env-file format, and the checks that keep keys and plaintext outside the checkout. |
| `src/forge/` | Every forge call goes through here (spec §16). `github/app-token.ts`: `appJwt`, `findInstallationId`, `mintInstallationToken` (one repo, checked scope, a broader token revoked) and `hapi token mint` |
| `src/generate/` | The config generators and `hapi policy build`: one pure emitter per tool (`hermes.ts`, `archon.ts`, `pi.ts`, `egress.ts`, and `mcp.ts` for the MCP servers) and `buildAll` (`index.ts`). See [docs/generated-configs.md](docs/generated-configs.md). |
| `build/` | Generated by `mise run policy:build`, and gitignored: `hermes/config.yaml`, `archon/config.yaml` and `archon.env`, `pi/models.json` and `hapi-guard.json`, `egress/{hermes,archon,research}.squid.conf`, `mcp/{hermes,research}.mcp.json`. Never edit it by hand. |
| `stack/compose.yaml` | The stack: `hermes`, `archon` and one Squid egress proxy per zone (`egress-hermes`, `egress-archon`, `egress-research`), on internal-only zone networks whose one way out is the zone's proxy. Every service hardened (no capabilities, non-root, read-only, limits, no published ports), every image pinned by digest. See [docs/runbooks/stack.md](docs/runbooks/stack.md). |
| `stack/hermes/Dockerfile`, `stack/archon/Dockerfile` | The Hermes (v0.22.5) and Archon (0.12.1, with Pi 1.3.0 and baked Node, uv and Python toolchains) images, each `FROM` pinned by digest |
| `scripts/host-setup.sh` | The one-time host setup, run by the host admin with `sudo`: the `hapi` user, rootless Docker with lingering, a pinned mise and hapi's own checkout. Idempotent. |
| `scripts/copy-secrets-to-hapi.sh` | Hands the `hapi` user its copy of your secrets store (the store, its recipients file and `recovery.age`), run as yourself: a `tar` running as hapi writes them, since root never writes into hapi's home. |
| `src/audit/` | `hapi audit` (`index.ts`: `runAudit`, the command, and the order of the checks; `types.ts`: a check's result and the context every check gets, whose `exec` and `fetch` the tests replace with fakes) and the checks, one file per group in `checks/`: `generated.ts` (config drift and the containers' build labels), `runtime.ts` (the running containers), `pins.ts`, `tools.ts` (Archon's and Hermes's own validation, in their images), `mcp.ts` (the MCP lock), `secrets.ts` and `github.ts` (rulesets, App permissions, AI workflows). See [docs/audit.md](docs/audit.md). |
| `src/stack/` | `hapi stack up` and `hapi stack down` (`up.ts`): the re-exec as `hapi`, the dev bypass (`currentUserOverride`), the policy build, secrets and Compose steps, and the zone-network check; `cidr.ts`, the CIDR maths it shares with the egress tests; `env.ts`, the environment hapi sets in each zone container (`serviceEnvironment`) and the env names no secret may have (`RESERVED_ENV_NAMES`) |
| `tests/` | Unit tests for `bun test`. `tests/fixtures/` holds example work orders, overlays, a broken policy directory, and `command-vectors.json`, the command-allowlist cases that Plan 04's Python hook must also pass. `tests/docs/` checks the GitHub ruleset JSON in this README and the GitHub Apps runbook, and the threat model's residual and register entries and the repo paths it and the kill-switch runbook name. `tests/audit/` runs every audit check over a world of fakes, with fixtures captured from the pinned Archon and Hermes images and a copy of a comment-triggered AI workflow. Integration tests are `*.int.test.ts` (`tests/stack/` for the stack's egress boundary on real Docker and Squid), run by `mise run test:int`. |
| `.github/workflows/ci.yml` | [CI](#ci) for this repo. |
| `docs/policy.md` | The policy files (the MCP catalog and its lock included), the command-allowlist semantics, the overlay rule, the work-order format and the `hapi mcp` commands |
| `docs/audit.md` | `hapi audit`: every check, what it verifies and why, its credential, how to fix a failure and what its skip means; `--strict` and `--dev`; the GitHub permissions each read needs |
| `docs/generated-configs.md` | Every file under `build/`: what it is, which policy files feed it, what each hardening setting does and why, and how to regenerate it |
| `docs/mcp.md` | The MCP layer: which zone gets which server, how to add or upgrade one, the release cooldown, advisory floors, the tool-description lock and the CI scanners |
| `docs/secrets.md` | Secrets: manifest, config and store; the zones and their keys; sops + age onboarding; keys and recovery (per-machine keys, the 10 recovery words, post-quantum keys and the lifecycle commands); `hapi secrets init`, `edit`, `check` and `resolve`; the env files; rotation; optional bws; the env-file downgrade; `hapi token mint`; threat notes |
| `docs/runbooks/` | Runbooks: [the stack](docs/runbooks/stack.md) (host setup, the `hapi` user's secrets, `up`/`down`, troubleshooting, what each test proves), [the kill switches](docs/runbooks/kill-switches.md), [GitHub Apps and rulesets](docs/runbooks/github-apps.md), [provider keys and spend caps](docs/runbooks/provider-keys.md), [Slack](docs/runbooks/slack.md) |
| `docs/security/threat-model.md` | The threat model, v0: CSA MAESTRO's layers and steps over the Phase 0 stack and the planned Phase 1 flow, each threat with its OWASP and MITRE ATLAS IDs, every control grouped by SANS domain with its status, spec §11.9's six residual risks and the other accepted residuals |
| `docs/superpowers/specs/` | The design spec. It is the binding authority. |
| `docs/superpowers/plans/` | Implementation plans. Plan 01 is the current one. |
| `docs/research/` | What the research behind the design covered, and which of its conclusions the spec adopted, by section. The sources themselves are private. |

Still to come in Plan 01:

| Path | What it will be | Arrives in |
|---|---|---|
| `docs/spikes/` | Results of the verify-early spikes. `spikes/scratch/` holds throwaway spike work and is gitignored. | Tasks 8–14 |

## mise tasks

Run `mise tasks` to list them with descriptions. Run any of them with `mise run <task>`.

| Task | What it does | Status |
|---|---|---|
| `setup` | `bun install --frozen-lockfile`: installs the JS dependencies exactly as `bun.lock` records them. It fails if `package.json` and `bun.lock` disagree. | Works |
| `lint` | Runs `setup`, then type-checks the whole project with `bunx tsc --noEmit` (strict). | Works |
| `test` | `bun test`: the unit suite. It needs no Docker, network or secrets. Integration tests are skipped unless `HAPI_INT` is set. | Works |
| `test:int` | `bun test .int.test.ts` with `HAPI_INT=1`: every integration test. The stack's egress boundary on real Docker and Squid, in a throwaway Compose project it removes afterwards; the real sops + age lifecycle; `policy:build`'s flags through mise. They need Docker, and the internet for the tests named so (skipped with a warning offline). See [docs/runbooks/stack.md](docs/runbooks/stack.md#what-the-tests-prove). | Works |
| `hapi` | `bun run src/cli.ts`: runs the [`hapi` CLI](#the-hapi-cli). Put `--` before the CLI's arguments: `mise run hapi -- --help`. | Works |
| `secrets:init` | `hapi secrets init`: sets up the default sops + age store: this machine's key, a recovery key wrapped with 10 words it shows once and checks you kept, an encrypted file of every name in `stack/secrets.yaml` (all empty), its recipients file, `recovery.age` and the config. It never overwrites anything. Flags after `--`, e.g. `mise run secrets:init -- --file private/secrets.enc.yaml`. See [docs/secrets.md](docs/secrets.md#hapi-secrets-init). | Works |
| `secrets:edit` | `hapi secrets edit`: opens your sops store in `$EDITOR` (`sops edit`), with the plaintext temp file on your tmpfs. | Works |
| `secrets:check` | `hapi secrets check`: prints `found`, `missing`, `empty` or `invalid` for every secret in the manifest, never a value, and the store's recipients; exits 1 unless all are found and the recipients agree with the store. | Works |
| `secrets:drill` | `hapi secrets drill`: proves your 10 recovery words and `recovery.age` open the store, in an isolated temp dir. Prints a count, never a value. See [docs/secrets.md](docs/secrets.md#hapi-secrets-drill). | Works |
| `secrets:join`, `secrets:add-machine` | A new machine or user makes its own key (`join --store <file>`), and a machine that opens the store adds it (`add-machine --name <n> --recipient <age1...>`). See [docs/secrets.md](docs/secrets.md#keys-and-recovery). | Works |
| `secrets:recover`, `secrets:revoke`, `secrets:new-recovery` | Give a box its own key with the 10 words; remove a recipient; replace lost or exposed words. Each recipient change makes a new data key. See [docs/secrets.md](docs/secrets.md#keys-and-recovery). | Works |
| `policy:build` | `hapi policy build`: compiles `policy/` into the Hermes, Archon, Pi, egress and MCP configs under `build/`. Pass CLI flags after `--`, e.g. `mise run policy:build -- --roster budget`. See [docs/generated-configs.md](docs/generated-configs.md). | Works |
| `audit` | `hapi audit`: checks the deployed config, the running stack, the pins, Archon's and Hermes's own validation, the MCP lock, the secrets setup and each `--repo`'s GitHub settings against policy. One line per check (`pass`, `fail` or `skip`, with why) and a summary; exits 1 on any fail. Run it as `hapi`; `--strict` turns every skip into a fail, e.g. `mise run audit -- --strict --repo <owner>/<name> --github-token-file <file>` (the operator's token, `0600`: a strict run fails without it). See [docs/audit.md](docs/audit.md). | Works |
| `up` | `hapi stack up`: as the `hapi` user (it re-execs with `sudo -u hapi -H`, passing your flags as separate arguments, never through a login shell), builds policy, resolves secrets, then starts the stack and waits until every service is healthy. Nothing starts if a step before Compose fails. Flags after `--`, e.g. `mise run up -- --roster budget`. See [docs/runbooks/stack.md](docs/runbooks/stack.md#4-mise-run-up-and-mise-run-down). | Works |
| `down` | `hapi stack down`: stops the stack and removes its containers and networks, keeping its volumes. It is kill switch 3 ([docs/runbooks/kill-switches.md](docs/runbooks/kill-switches.md)). | Works |

A task that isn't built yet is a stub that prints which task implements it and **exits 1**, so a stub can never pass as a real check. None is left in Plan 01's tasks.

## The `hapi` CLI

`hapi` is a single TypeScript CLI, run on Bun. It owns policy loading, config generation, secrets, forge tokens and audit.

```text
Usage: hapi <command> [args...]
       hapi --version | --help
```

You can run it two ways:

- `mise run hapi -- <command> [args...]`. The `--` is needed. Without it, mise reads flags such as `--help` as its own.
- `bun run src/cli.ts <command> [args...]`, inside the repo with the mise tools active.

**Exit codes:**
- `0`: success.
- `1`: the command failed. If a command throws, `hapi` prints `hapi <command>: <message>` to stderr.
- `2`: a usage error: an unknown command, no command at all, or the wrong arguments for a command.

**Commands:**

| Command | What it does | Arrives in |
|---|---|---|
| `--version` | Prints the version (`0.1.0`) | Works |
| `--help`, `-h` | Prints usage and the registered commands | Works |
| `workorder validate <path>` | Validates a work order (`order.yaml`) against `policy/schemas/work-order.schema.json`. Valid: prints its `id` and exits 0. Invalid: prints one `path: message` line per problem to stderr (e.g. `/trace/traceparent: must match pattern ...`) and exits 1. See [docs/policy.md](docs/policy.md#work-orders). | Works |
| `policy build [--policy dir] [--out dir] [--roster name]` | Loads and checks `--policy` (default `policy`), writes the generated configs under `--out` (default `build`) and prints each path. `--roster` (`budget`, `anthropic` or `portable`; default `anthropic`) picks Archon's tiers and Pi's models; Hermes always uses `anthropic`. A usage error exits 2; a bad policy file exits 1 and names the file. See [docs/generated-configs.md](docs/generated-configs.md). | Works |
| `mcp verify [--policy dir] [--lock file]` | Checks every MCP server's live tool surface against `policy/mcp.lock.json`. Prints `ok`, `changed` or `unpinned` per server, and `orphaned` for a lock entry whose server left the catalog, and exits 1 unless all are `ok`. Until the live fetch is wired it exits 1. See [docs/policy.md](docs/policy.md#hapi-mcp-verify-and-hapi-mcp-pin). | The command works now; the live fetch arrives in Plan 04 |
| `mcp pin --server name [--policy dir] [--lock file]` | Records one MCP server's live tool surface and its hash in `policy/mcp.lock.json`. A re-pin is a reviewed change ([docs/mcp.md](docs/mcp.md#adding-or-upgrading-a-server)). | The command works now; the live fetch arrives in Plan 04 |
| `secrets init [--config file] [--file file] [--age-key file] [--name name] [--classic] [--no-confirm]` | Sets up the default sops + age store: reuses or makes this machine's post-quantum age key (outside the checkout, `0600`), makes a recovery key and 10 words, shows the words once on the terminal and asks for 2 of them back, then encrypts every manifest name with an empty value to both keys by piping it to `sops encrypt` (plaintext never touches disk), and writes the store, `recovery.age`, the recipients file and the config, each no-replace. It never overwrites anything, and an abort writes nothing. See [docs/secrets.md](docs/secrets.md#hapi-secrets-init). | Works |
| `secrets join --store file [--name name] [--config file] [--age-key file]` | On a new machine or user: makes its own key and config for a copy of the store, without touching the store, and prints the `add-machine` command to run where the store already opens. See [docs/secrets.md](docs/secrets.md#hapi-secrets-join). | Works |
| `secrets add-machine --name name --recipient age1... [--config file]` | Adds a machine's public key (`sops rotate -i --add-age`, a new data key) and its recipients-file entry. Refuses a duplicate, a malformed key or a post-quantum/classic mix. See [docs/secrets.md](docs/secrets.md#hapi-secrets-add-machine). | Works |
| `secrets recover [--store file] [--name name] [--config file] [--age-key file]` | For a box with the store, `recovery.age`, the recipients file and the words, but no key: makes its own key, reads the words, and adds itself with the unwrapped recovery key (in memory). See [docs/secrets.md](docs/secrets.md#hapi-secrets-recover). | Works |
| `secrets drill [--config file]` | Proves the words open the store: decrypts it in an isolated temp `HOME` with only the recovery key, and prints `recovery works: N names readable`, never a value. See [docs/secrets.md](docs/secrets.md#hapi-secrets-drill). | Works |
| `secrets revoke --name name [--config file]` | Removes a recipient (`sops rotate -i --rm-age`); refuses the last machine key or the only recovery recipient, and reminds you to reissue the credentials if the key may be compromised. See [docs/secrets.md](docs/secrets.md#hapi-secrets-revoke). | Works |
| `secrets new-recovery [--config file] [--no-confirm]` | Replaces the recovery key, its words and `recovery.age` (lost or exposed words), with the same show-and-confirm as `init`. See [docs/secrets.md](docs/secrets.md#hapi-secrets-new-recovery). | Works |
| `secrets edit [--config file]` | Runs `sops edit` on the configured file in your terminal (sops provider only), holding the store's lock, after the same store checks as the lifecycle commands (age recipients only, the recipients file in step) and the age key checks, with `TMPDIR` on your tmpfs, your shell's `SOPS_*` variables dropped and `GPG_AGENT_INFO=`. See [docs/secrets.md](docs/secrets.md#hapi-secrets-edit). | Works |
| `secrets check [--config file]` | Reads the configured store and prints `found`, `missing`, `empty` or `invalid` for every env var of `stack/secrets.yaml`, `missing` for an MCP reference it doesn't map, and `unknown` for store names it doesn't list; for sops, also the store's recipients. Never a value; writes nothing; exits 1 if anything is missing, empty or invalid, or the recipients file disagrees with the store, mixes post-quantum and classic keys, or records another `recovery.age` than the one beside the store. It warns when there is no recovery recipient or `recovery.age`. See [docs/secrets.md](docs/secrets.md#hapi-secrets-check). | Works |
| `secrets resolve [--config file] [--dry-run]` | Resolves `stack/secrets.yaml` from the configured provider (the config at `--config`, `$HAPI_SECRETS_CONFIG` or `~/.config/hapi/secrets.yaml`), all into memory first, then writes `$XDG_RUNTIME_DIR/hapi/env/<zone>.env` (mode `0600`) as one set, by symlink swap, and prints each path. A provider failure, or any missing or empty secret, fails, naming it, and nothing is written; there is no fallback to another provider. It fails if `XDG_RUNTIME_DIR` is unset or isn't yours and `0700` (no `/tmp` fallback). `--dry-run` is `secrets check`. See [docs/secrets.md](docs/secrets.md#hapi-secrets-resolve). | Works |
| `token mint --app planner\|factory --repo owner/name` | Mints a 1-hour GitHub App installation token for that one repo, with the App's fixed permissions. It reads the App's id and key from `$XDG_RUNTIME_DIR/hapi/env/host.env`, rejects (and revokes) a token broader than requested or without a valid expiry, deletes token files more than an hour old, and writes the token to `$XDG_RUNTIME_DIR/hapi/tokens/<app>.<owner>.<repo>.token` (mode `0600`). It prints the path and expiry, never the token. See [docs/secrets.md](docs/secrets.md#hapi-token-mint). | Works |
| `stack up [--roster name] [--config file]` | Starts the stack ([docs/runbooks/stack.md](docs/runbooks/stack.md#4-mise-run-up-and-mise-run-down)). As any user but `hapi` it re-execs `mise run up` as `hapi` with `sudo -u hapi -H`, in hapi's checkout, each flag an argument of its own, never re-parsed by a login shell; `HAPI_ALLOW_CURRENT_USER=1` skips that, a dev-only downgrade it warns about and labels. Then `hapi policy build`, `hapi secrets resolve`, `docker compose up --no-start --build`, a check that every zone network is internal and private, and `docker compose up -d --wait`. Any failure before Compose starts nothing, and is printed with exit 1. | Works |
| `stack down` | `docker compose -p hapi down`: removes the stack's containers and networks, keeping its volumes. It needs no compose file or `XDG_RUNTIME_DIR`, and re-execs as `hapi` like `up`. | Works |
| `audit [--repo owner/name ...] [--strict] [--dev] [--github-token-file path] [--build-dir dir] [--policy dir]` | Runs every audit check ([docs/audit.md](docs/audit.md)) and prints one line per check and a summary. The `github.*` and `repo.*` checks run once per `--repo` and make GET requests only, with the operator's token from `--github-token-file` (never printed) or a read-only App token it mints and revokes. A skip (no stack, no `--repo`, no credentials) is never a pass; `--strict` makes it a fail, and `--dev` makes the dev-only downgrades a skip. Exits 1 on any fail, 2 on a usage error. | Works |

**Adding a command (for contributors).** Write the handler in its own module, as `policyBuild` is in `src/generate/index.ts`. Then register it in the *Commands* section at the bottom of `src/cli.ts`:

```ts
import { policyBuild } from "./generate/index";
register("policy build", policyBuild, "Compile policy/ into Hermes, Archon, Pi, egress and MCP configs under build/");
```

Here is how commands work:
- A name can be several words. `main` matches the longest registered name against the leading words of argv, and passes the remaining args to the handler.
- No word in a name may start with `-`.
- Registering the same name twice throws.
- A handler gets the args after its name, as `(args: string[]) => number | Promise<number>`, and returns the exit code.
- Print results to stdout and diagnostics to stderr.
- **Error messages name keys, never values.** Name the zone, key, file, line or JSON Pointer; never print a secret or token, and never pass through text that might hold one (a tool's stdout, `JSON.parse`'s own message). See [docs/secrets.md](docs/secrets.md#error-messages-name-keys-never-values).

## Toolchain and pinning

`mise.toml` pins every tool to an exact version. For each tool's version, read `mise.toml`; this README doesn't copy them, so they can't drift apart.

| Tool | Why it's here |
|---|---|
| `bun` | Runtime, package manager and test runner for the `hapi` CLI |
| `node` | For Node-based tools (for example a standalone Pi CLI later) |
| `uv`, `python` | Python tooling on the Hermes side |
| `gh` | GitHub CLI, used only for the operator's manual setup steps. Factory code calls GitHub through `src/forge/`, never raw `gh` (spec §11). |
| `gitleaks` | Secret scanning |
| `sops` | The default secret provider: one age-encrypted file, decrypted into memory when the stack starts (spec §11.5, [docs/secrets.md](docs/secrets.md)) |
| `age` | Provides `age`, `age-keygen` and `age-plugin-batchpass`: the keys the sops file is encrypted to, and the wrapped recovery key. hapi uses this pinned age (`mise where age`, at least 1.3.2), never one on `PATH` |

`bws` (Bitwarden Secrets Manager) is an optional provider and isn't pinned here; a bws user pins it in their own gitignored `mise.local.toml` ([docs/secrets.md](docs/secrets.md#optional-bitwarden-secrets-manager-bws)).

**Supply-chain defaults** (spec §11.6–11.7):
- **Exact versions everywhere.** That covers `mise.toml`, `package.json` (`bunfig.toml` sets `exact = true`, so `bun add` never writes `^`) and the mise version CI uses.
- **A committed lockfile.** `bun.lock` is in git, and `mise run setup` installs with `--frozen-lockfile`.
- **A release-age cooldown.** `bunfig.toml` sets `minimumReleaseAge` to 3 days, so Bun won't resolve a package version published less than 3 days ago.
- **Pinned actions.** CI actions are pinned to full commit SHAs, CI runs with a read-only token, and checkout doesn't persist credentials.
- **No plaintext secrets on disk.** `.env*`, `private/`, `keys.txt`, `*.agekey`, `secrets.env` and `mise.local.toml` are gitignored. The store is encrypted (sops + age) by default, and resolved secrets are written only to `0600` files on the user's tmpfs (`$XDG_RUNTIME_DIR/hapi/env/`), never to the repo or a `.env` file on disk.

**To upgrade a tool:**
1. Find the version with `mise ls-remote <tool>` or `mise latest <tool>`.
2. Bump it in `mise.toml`.
3. Run `mise install && mise run lint && mise run test`.
4. Say why in the PR.

For JS dependencies, use `bun add -d <pkg>@<exact-version>` (or without `-d` for a runtime dependency) and commit `bun.lock` with the change.

## CI

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`. Its one job, `ci`, runs on `ubuntu-latest`:

1. Checks out the repo.
2. Installs the pinned mise with `jdx/mise-action`.
3. Runs `mise install && mise run lint && mise run test`.

The `main-protect` ruleset requires the `ci` check to pass, and nobody can bypass it, not even the repo admin (see the manual steps below). The reusable security-gates workflow for target repos (gitleaks, SAST, OSV-Scanner, zizmor, work-order schema, commit trailers) is separate; it arrives in Plan 05 (spec §11.7).

## Using hapi-factory with another repo

**This isn't ready yet.** Target repos will *reference* hapi-factory rather than copy it (spec §17), through a small per-repo contract (spec §7):
- `AGENTS.md`;
- `mise.toml` tasks;
- a `.factory/config.yaml` policy overlay, which may only tighten the central policy (see [docs/policy.md](docs/policy.md#repo-overlays-factoryconfigyaml));
- a thin CI wrapper around the reusable gates workflow, pinned by tag;
- CODEOWNERS and a `main` ruleset.

Plan 05 builds the template and `mise run new-repo`. This section will become the step-by-step drop-in guide at that point.

## Manual setup steps (the operator)

These steps are outward-facing or privileged, so agents never do them; the operator does them by hand. Later tasks add their own steps here.

**The order.** Each step needs the ones before it:
1. Your secrets store, the provider keys and the MCP keys ([Tasks 4, 4b and 4c](#plan-01-tasks-4-4b-and-4c-your-secrets-store-provider-keys-and-slack), [Task 3b](#plan-01-task-3b-mcp-server-keys)).
2. The Slack app (step 3 of Tasks 4, 4b and 4c).
3. Task 7b, the pre-publish cleanup. Agents do most of it; you approve its gated steps: the edits to protected files, the license and the history rewrite.
4. Publishing, the GitHub Apps and CodeRabbit ([Publishing](#publishing-after-task-7b-the-remotes-the-rulesets-and-the-apps)). The rulesets need a public repo, and the Apps need the rulesets.
5. The host and the stack, stage b ([Task 5](#plan-01-task-5-the-host-and-the-stack-stage-b)). `mise run up` refuses an empty secret, so the Slack and App values must be in your store first.

### Plan 01 Task 3b: MCP server keys

`policy/mcp.yaml` names each MCP server's secret by its logical name (`secret:hapi-mcp-<name>`). Add each to your secrets store under exactly this name (`mise run secrets:edit`, [docs/secrets.md](docs/secrets.md#adding-a-secret)):

| Logical name | Manifest entry | What it is | Needed when |
|---|---|---|---|
| `hapi-mcp-context7-api-key` | `research` / `HAPI_MCP_CONTEXT7_API_KEY` (already in `stack/secrets.yaml`) | A Context7 API key, on a spend-capped, search-only account (spec §10.1). Task 4's [provider-keys runbook](docs/runbooks/provider-keys.md#search-keys-brave-exa-context7) covers it. | Now: `hapi secrets resolve` needs every name in the manifest |
| `hapi-mcp-phoenix-viewer-key` | `hermes` / `HAPI_MCP_PHOENIX_VIEWER_KEY` (add it to the manifest then) | A Phoenix API key minted by a **VIEWER**-role user, never an admin or member | Before you turn on the observability profile (`flags.otel.enabled: true`); until it's in the manifest and your store, `hapi secrets resolve` fails |

Each key belongs to one server only. The generated configs reference it as `${HAPI_MCP_<NAME>}` (for example `${HAPI_MCP_CONTEXT7_API_KEY}`), never by value. See [docs/mcp.md](docs/mcp.md) and [docs/secrets.md](docs/secrets.md#mcp-secrets).

### Plan 01 Tasks 4, 4b and 4c: your secrets store, provider keys and Slack

Do these in order. Each runbook gives the logical name each secret goes under in your store.

1. **Your secrets store (sops + age, the default):** `mise run secrets:init -- --file private/secrets.enc.yaml`, in a terminal (the store, its recipients file and `recovery.age` in `private/`, so they are backed up with your private repo; this machine's key stays in `~/.config/sops/age/` and is never copied). It shows **10 recovery words** once: store them where you keep things you can't lose (a password manager, paper in a safe, or both), and type back the two it asks for. Then `mise run secrets:drill` to prove the words open the store ([docs/secrets.md](docs/secrets.md#getting-started-with-sops--age)). Later, the `hapi` user and the VM each get their own key with `secrets:join` and `secrets:add-machine` ([keys and recovery](docs/secrets.md#keys-and-recovery)). Bitwarden is an optional alternative ([docs/secrets.md](docs/secrets.md#optional-bitwarden-secrets-manager-bws)).
2. **Provider keys:** the Anthropic Console workspaces `hapi-hermes` ($60), `hapi-factory` ($100) and `hapi-evals` ($40), OpenCode Go, the OpenRouter key `hapi-jev` ($2/month, set as a $0.06 limit that resets daily, with ZDR enforced unless the documented Jev exception applies), and the Brave, Exa and Context7 search keys ([provider keys](docs/runbooks/provider-keys.md)). Add each to your store with `mise run secrets:edit`.
3. **Slack:** a dedicated workspace, `#hapi-intake` and `#hapi-alerts`, and the app's tokens ([Slack](docs/runbooks/slack.md)). The app is created from a manifest that a one-off `docker run` of the pinned Hermes image prints, with no network and no stack, so do this before the stack's stage b: `mise run up` refuses an empty secret.
4. **Check:** `mise run secrets:check`. Expected: every line says `found` and it exits 0, with the recipients listed (this machine and `recovery`) and no value printed. Until you have made the Slack app (step 3) and the GitHub Apps ([Publishing](#publishing-after-task-7b-the-remotes-the-rulesets-and-the-apps), step 6), their values show as `empty` and it exits 1 naming just those: the three Slack values (`hapi-hermes-slack-bot-token`, `hapi-hermes-slack-app-token`, `hapi-hermes-slack-allowed-users`) and the four App values (`hapi-host-planner-app-id`, `hapi-host-planner-app-private-key`, `hapi-host-factory-app-id`, `hapi-host-factory-app-private-key`).

### Publishing, after Task 7b: the remotes, the rulesets and the Apps

Set `OWNER` to your GitHub login first (`export OWNER=<your-login>`); the commands below use it.

1. **Both repos already exist, private and empty:** `$OWNER/hapi-factory` and `$OWNER/hapi-factory-private`. **Push nothing until Task 7b is done.** Until its history rewrite, the history still holds the research and the personal details that Task 7b removes (H-056), and a push can't be taken back.

2. **Push the cleaned history,** once Task 7b's checks pass. Confirm each first push yourself. `private/` already holds the research in its own repo; commit your secrets store there too before its first push, so it is backed up with the repo (it is encrypted, so that's safe):

   ```bash
   git remote add origin "https://github.com/$OWNER/hapi-factory.git"
   git push -u origin main
   git push -u origin plan-01-foundations   # then open a PR from it into main
   git -C private add secrets.enc.yaml secrets.recipients.yaml recovery.age
   git -C private commit -m "The secrets store, its recipients file and recovery.age"
   git -C private remote add origin "https://github.com/$OWNER/hapi-factory-private.git"
   git -C private push -u origin main
   ```

3. **Make hapi-factory public;** hapi-factory-private stays private. Free-plan rulesets need a public repo.

   ```bash
   gh repo edit "$OWNER/hapi-factory" --visibility public --accept-visibility-change-consequences
   gh repo edit "$OWNER/hapi-factory" --description "Hermes + Archon + Pi: a reference stack for an end-to-end agentic software factory"
   ```

4. **Add two rulesets on `main`.** Together they make the operator the only one who can merge into `main` (always through a PR), require a passing `ci` check for every merge, the operator's included, and block force-pushes and deletion. They are two rulesets, not one, because a ruleset's bypass list covers *every* rule in that ruleset. If the approval bypass and the `ci` check sat in one ruleset, the bypass would also let a merge through with `ci` red or missing. GitHub applies every ruleset that targets a branch, and a bypass in one ruleset doesn't carry over to another.

   - **`main-protect`** holds the required `ci` check and the force-push and deletion blocks. It has **no bypass actors**. Nobody, the operator included, can merge with `ci` failing or not yet run, force-push `main` or delete it. This is how every lane, `lane:direct` included, gets the same CI gates (spec §5.1).
   - **`main-review`** holds the pull-request rule (1 approving review, from a code owner) and **Restrict updates**. Its only bypass actor is the repository Admin role, in PR-only mode. Without that bypass, the operator couldn't merge his own `lane:direct` PRs, because GitHub doesn't let a PR's author approve it (spec §18). The bypass covers these two rules and nothing else; **`ci` can never be bypassed**. Because the bypass is PR-only, it applies only when merging a PR. the operator still can't push straight to `main`.
   - **Restrict updates is what stops an App merging** (spec §11.5: "Neither can merge"). It lets only the ruleset's bypass actors update `main`, and merging a PR updates `main`. So once the operator has approved an App's PR and `ci` is green, the App still can't merge it through the API; only the operator can, through the Admin bypass. It sits in `main-review`, never in `main-protect`: `main-protect` has no bypass actors, so there it would stop every merge, the operator's included. The code-owner review is a second layer: with `.github/CODEOWNERS` naming only the operator ([GitHub Apps runbook](docs/runbooks/github-apps.md#code-owners-a-second-layer)), an App's approval doesn't count either.

   The GitHub Apps get no bypass in either ruleset. `integration_id` 15368 is GitHub Actions, so only Actions can satisfy the `ci` check. In `bypass_actors`, `actor_id` 5 is the repository Admin role.

   ```bash
   gh api -X POST repos/$OWNER/hapi-factory/rulesets --input - <<'EOF'
   {
     "name": "main-protect",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "required_status_checks", "parameters": {
           "strict_required_status_checks_policy": false,
           "required_status_checks": [ { "context": "ci", "integration_id": 15368 } ] } }
     ]
   }
   EOF

   gh api -X POST repos/$OWNER/hapi-factory/rulesets --input - <<'EOF'
   {
     "name": "main-review",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [
       { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
     ],
     "rules": [
       { "type": "pull_request", "parameters": {
           "required_approving_review_count": 1,
           "dismiss_stale_reviews_on_push": true,
           "require_code_owner_review": true,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false } },
       { "type": "update" }
     ]
   }
   EOF
   ```

   **Check the result.** Run `gh api repos/$OWNER/hapi-factory/rulesets`, or open **Settings → Rules → Rulesets**. You should see both rulesets, and `main-protect` should list no bypass actors. To see the combined rules that apply to `main`, run `gh api repos/$OWNER/hapi-factory/rules/branches/main`.

   Then open a test PR and confirm three things:
   - The `ci` check runs and is required.
   - Merging needs the admin bypass. Because of Restrict updates, every merge into `main` is the operator's, through that bypass, even after an approval.
   - While `ci` is still running or has failed, merging stays blocked, even with the admin bypass.

   Once the GitHub Apps exist, also confirm that **an App's merge call is refused**, even with the operator's approval and `ci` green ([GitHub Apps runbook, Check it](docs/runbooks/github-apps.md#check-it)).

   These commands follow GitHub's REST docs, but nobody has run them yet. If GitHub rejects a field, set up the same two rulesets in the UI. Keep the rules split the same way: never put the `ci` check in a ruleset that has a bypass actor, and never put Restrict updates in one that has none. `tests/docs/rulesets.test.ts` holds this JSON to those rules.

5. **CODEOWNERS:** your own PR adds `.github/CODEOWNERS` with `* @<your-login>`, before either App is installed. `main-review` requires a code owner's review, and with you as the only code owner, no App's approval counts ([GitHub Apps runbook](docs/runbooks/github-apps.md#code-owners-a-second-layer)).

6. **The GitHub Apps:** `hapi-planner` and `hapi-factory`, with exactly their permissions, installed on selected repos only, their keys in your store under the `host` zone, then the `agent-branch-scope` and `tags-admin-only` rulesets ([GitHub Apps](docs/runbooks/github-apps.md)). Then check that an App's merge call is refused, even with your approval and `ci` green ([Check it](docs/runbooks/github-apps.md#check-it)).

7. **CodeRabbit (optional),** once CODEOWNERS is merged and its threat-model entry and audit checks (H-169) are on `main`: install it on hapi-factory only, never on hapi-factory-private. Never tick its "Commit the changes to this branch" checkbox or run `@coderabbitai autopilot` on a factory or planning PR: either commits under your own GitHub sign-in, past the factory's checks. The register's H-164 has the checks to run after installing.

8. **Task 5's host setup clones from this remote** once it's pushed: `scripts/host-setup.sh` defaults to your checkout's `origin`. Until then, give it your checkout's path ([Plan 01 Task 5](#plan-01-task-5-the-host-and-the-stack-stage-b)).

### Plan 01 Task 5: the host and the stack (stage b)

Task 5 wrote the stack and proved its egress boundary on the build host's own Docker, with fake secrets (stage a). What remains is the real host, as the operator, following [docs/runbooks/stack.md](docs/runbooks/stack.md):

0. **The Slack app and the GitHub Apps first,** with their values in your store ([Tasks 4, 4b and 4c](#plan-01-tasks-4-4b-and-4c-your-secrets-store-provider-keys-and-slack), step 3; [Publishing](#publishing-after-task-7b-the-remotes-the-rulesets-and-the-apps), step 6): `mise run up` refuses an empty secret.
1. **Host setup, once:** `sudo scripts/host-setup.sh "$PWD"` from your checkout (or with no argument once the GitHub remote exists; with an SSH `origin`, pass its HTTPS URL, since hapi clones it with its own credentials). It creates the `hapi` user, rootless Docker with lingering, a pinned mise and hapi's checkout, then prints the next steps. Check: `sudo -iu hapi docker info --format '{{.SecurityOptions}}'` contains `rootless`.
2. **hapi's toolchain:** as `hapi`, `export XDG_RUNTIME_DIR=/run/user/$(id -u)`, then `cd ~/hapi-factory && mise trust && mise install && mise run setup`.
3. **hapi's secrets:** as yourself, from your checkout, `scripts/copy-secrets-to-hapi.sh` (it hands your store, its recipients file and `recovery.age` to a `tar` running as hapi, which writes them into hapi's `~/.config/hapi/`: root never writes into hapi's home); as `hapi`, `mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name hapi`; run the `add-machine` command it prints in your checkout; run `scripts/copy-secrets-to-hapi.sh` again; as `hapi`, `mise run secrets:check`.
4. **Start and test:**
   - Run `mise run up`.
   - As `hapi`, run `mise run test:int`. It runs its own throwaway copy of the stack, with its own generated configs, so it leaves the running stack and the checkout's `build/` alone.
   - Check that `docker compose -p hapi ps` shows all five services healthy.

   Until the Slack and App values are in your store, and copied to hapi, `up` stops at the secrets step.
5. **The audit, last:** as `hapi`, in its checkout, with the stack up, `mise run audit -- --strict --repo "$OWNER/hapi-factory" --github-token-file <file>` (your own GitHub token in a `0600` file, which the bypass-actor checks need). Expected, until Plan 04 wires the live MCP fetch (H-101): every check `pass` except one fail, `mcp.tool-hashes`, whose detail starts `--strict: skipped:` (it can't compare a running server's tool surface yet), so `13 pass, 1 fail, 0 skip` and exit 1; any other fail is real. After H-101: exit 0, `0 fail` ([docs/audit.md](docs/audit.md), [the stack runbook](docs/runbooks/stack.md#5-the-audit)).

## Documentation map

| Document | What's in it |
|---|---|
| [Design spec](docs/superpowers/specs/2026-10-26-hapi-factory-design.md) | Intent, architecture, policy, security, phases. It is the binding authority. |
| [The audit](docs/audit.md) | `hapi audit` / `mise run audit`: each check, what it verifies and why, its credential, how to fix a failure, what a skip means, `--strict` and `--dev` |
| [Policy](docs/policy.md) | Each policy file and its schema (the MCP catalog `mcp.yaml` and its lockfile included), how Hermes's command rules match (and what the Plan 04 hook must do first), the tighten-only overlay rule with examples, the work-order format, `hapi workorder validate`, and `hapi mcp verify` and `hapi mcp pin` |
| [Generated configs](docs/generated-configs.md) | Each file `hapi policy build` writes under `build/`, its policy sources, every hardening setting and why, how protected paths stay strictest-wins, and how to regenerate |
| [Secrets](docs/secrets.md) | Manifest, config and store; the zones and their keys; sops + age onboarding and adding a secret; keys and recovery: per-machine keys, the 10 recovery words, post-quantum keys, `join`, `add-machine`, `recover`, `drill`, `revoke` and `new-recovery`, with a worked example; `hapi secrets init`, `edit`, `check` and `resolve` and the env files; rotating a secret or replacing a machine's key; optional bws; the env-file downgrade; `hapi token mint`; the "keys, never values" rule; threat notes |
| [Threat model](docs/security/threat-model.md) | v0, with CSA MAESTRO: the system and its trust boundaries, the Rule of Two per stage, threats per layer with OWASP ASI, LLM and MCP Top 10 and MITRE ATLAS IDs, cross-layer chains, every control by SANS domain with its status, spec §11.9's six residual risks and the other accepted residuals, each with an owner control and a next level; how to update it |
| [Runbook: the stack](docs/runbooks/stack.md) | What runs where, host setup (`scripts/host-setup.sh`), the `hapi` user's toolchain and secrets (join, add-machine, re-syncing), `mise run up` and `down`, the dev bypass, the pinned images and their digests, the hardening and its exceptions, troubleshooting, and what each test proves |
| [Runbook: kill switches](docs/runbooks/kill-switches.md) | Spec §11.8's four kill switches, fastest first: disable the provider keys, suspend the GitHub Apps, stop the stack (with a fallback that needs no checkout or mise, and a hard stop), firewall-drop the `hapi` user; for each, what it stops and doesn't, how to confirm and undo it, and how fast it works |
| [Runbook: GitHub Apps](docs/runbooks/github-apps.md) | Creating `hapi-planner` and `hapi-factory` with exact permissions, the rulesets (both on `main`, Restrict updates so no App can merge, code owners, branch and tag scope), checks (including that an App's merge call is refused), suspending an installation, rotating a key |
| [Runbook: provider keys](docs/runbooks/provider-keys.md) | The Console workspaces and their limits, OpenCode Go settings, the OpenRouter keys (daily-reset limits, ZDR guardrails, the Jev exception if it has no ZDR endpoint), the Brave, Exa and Context7 search keys, and where each goes |
| [Runbook: Slack](docs/runbooks/slack.md) | The workspace and channels, creating the app from Hermes's manifest, the three Slack secrets, Hermes's Slack settings |
| [MCP servers](docs/mcp.md) | Which zone gets which MCP server and why, how to add or upgrade one (a planning PR plus a re-pin), the release cooldown and its security-fix exception, advisory floors, the tool-description lock and the CI scanners |
| [Plan 01: Foundations](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md) | Tasks 1–14: toolchain, policy, generators, secrets, stack, audit, threat model, spikes |
| [Research](docs/research/README.md) | What the research behind the design covered, and the conclusions the spec adopted, by section (the sources are private) |
| `docs/spikes/` | Spike results, which arrive in Plan 01 Tasks 8–14 |
