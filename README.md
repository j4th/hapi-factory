# hapi-factory

hapi-factory is a public, best-practices reference stack for an end-to-end agentic software factory. **HAPi** stands for **H**ermes + **A**rchon + **Pi**: Hermes is the coordinator you talk to, Archon is the run engine and Pi is the worker. The stack puts existing tools together into one working system. It also covers the steps most factories skip: discovery research, architecture, threat modeling and breaking work into tasks. Security is designed in from the start: one policy compiled into every tool's config, rootless containers behind default-deny egress, secrets from a vault, short-lived GitHub App tokens, and an audit that catches drift. Read the design in [docs/superpowers/specs/2026-10-26-hapi-factory-design.md](docs/superpowers/specs/2026-10-26-hapi-factory-design.md). It is the binding reference for everything here.

> **Status: Plan 01 (Phase 0 foundations) is in progress.** Today the repo has the pinned toolchain, the `hapi` CLI skeleton, CI, `policy/` with its JSON Schemas, loader, tighten-only repo overlay and work-order validator, the generators that compile policy into Hermes, Archon, Pi and egress-proxy configs (`mise run policy:build`), the pinned per-zone MCP catalog with its tool-description lock, fail-closed secrets from Bitwarden (`hapi secrets resolve`), scoped GitHub App token minting (`hapi token mint`), and the setup runbooks. Anything marked *arrives in Plan 01 Task N* is not built yet. The plan is [docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md).

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
- **[mise](https://mise.jdx.dev/getting-started.html) 2026.10.3 or newer.** It installs every other tool at a pinned version. `mise.toml` enforces the minimum with `min_version`.
- **Docker Engine with Compose v2.** You need it only for the stack and the integration tests (*arrives in Plan 01 Task 5*). Linting and unit tests don't need Docker. The stack runs on rootless Docker as a dedicated `hapi` user, which `scripts/host-setup.sh` creates (*arrives in Plan 01 Task 5*).
- **git.**

You don't need to install Bun, Node, Python, uv, gh, gitleaks or `bws` yourself. `mise install` installs them all.

## Quick start

```bash
git clone https://github.com/j4th/hapi-factory.git   # the public remote is a manual step, see below
cd hapi-factory
mise trust                   # first time only: let mise load this repo's mise.toml
mise install                 # install the exact tool versions pinned in mise.toml
mise run lint                # install JS deps from bun.lock, then type-check
mise run test                # run the unit tests
mise run hapi -- --version   # run the CLI (prints 0.1.0)
```

## Repo layout

What exists now:

| Path | What it is |
|---|---|
| `mise.toml` | Tool pins and the [mise tasks](#mise-tasks). This is a protected path (spec §8.2): an interactive agent session must ask the operator before editing it, and unattended sessions and workers may not edit it at all. |
| `package.json`, `bun.lock` | JS project metadata and dependencies, pinned to exact versions: `ajv` (JSON Schema validation) and `yaml` at runtime, `typescript` and `@types/bun` for development. The lockfile is committed. |
| `bunfig.toml` | Bun install settings: exact versions and a 3-day release-age cooldown (see [Toolchain and pinning](#toolchain-and-pinning)). |
| `tsconfig.json` | Strict TypeScript settings, used only for type-checking. Bun runs the `.ts` files directly. |
| `src/cli.ts` | The `hapi` CLI: the entry point, the command registry and `main(argv)`. |
| `src/version.ts` | `HAPI_VERSION`. It must match `version` in `package.json`, and a test checks that it does. |
| `policy/` | The single source of truth: protected paths, commands, trusted sources, budgets, approvals, roles, flags, the model rosters (`policy/rosters/`), and the MCP catalog (`mcp.yaml`) with its tool-description lock (`mcp.lock.json`). See [docs/policy.md](docs/policy.md) and [docs/mcp.md](docs/mcp.md). |
| `policy/schemas/` | JSON Schemas (draft 2020-12) for every policy file, the MCP lock, the repo overlay (`.factory/config.yaml`), the work order (`order.yaml`) and the secrets map (`stack/secrets.map.yaml`) |
| `src/policy/` | `loadPolicy` (load and validate `policy/`), `loadOverlay` and `applyOverlay` (the repo overlay, which may only tighten policy), `effectiveModes` (a file's protected-path modes: the strictest across every matching glob), `matchCommand` (whether Hermes's argv-exact command rules allow a command), `forgeDomain` (forge hosts, which the archon zone may never reach), `isHostname` (a plain domain name, as the schema defines it), `zoneHosts` (an egress zone's allowlist), `serversForZone` (a zone's MCP servers, with the catalog's floor, blocklist and tool checks in `mcp.ts`), the policy types and the shared schema checker |
| `src/mcp/` | The MCP tool-description lock (`lock.ts`): `hashToolSurface`, `verifyLock`, and the `hapi mcp verify` and `hapi mcp pin` commands |
| `src/workorder/` | `validateWorkOrder` and the `hapi workorder validate` command |
| `stack/secrets.map.yaml` | The secrets map template: which Bitwarden secret fills which env var, per zone (`hermes`, `archon`, `research`, `host`). It holds placeholder bws secret ids, never values and never real ids. Each deployment fills in a copy outside the repo and passes it with `--map`. See [docs/secrets.md](docs/secrets.md#filling-in-the-map-the operator). |
| `src/secrets/` | `bws.ts`: `resolveSecrets` (fail-closed: every key into memory, then the env files), `checkSecrets` (the dry run), `mcpSecretGaps` (the map covers the MCP catalog's bws references), `loadSecretMap` and `hapi secrets resolve`. `files.ts`: secrets on disk: `runtimeDir` (`$XDG_RUNTIME_DIR/hapi`, no fallback), `secureDir` (0700), `writeSecretFiles` (0600, atomic) and the env-file format. |
| `src/forge/` | Every forge call goes through here (spec §16). `github/app-token.ts`: `appJwt`, `findInstallationId`, `mintInstallationToken` (one repo, checked scope, a broader token revoked) and `hapi token mint` |
| `src/generate/` | The config generators and `hapi policy build`: one pure emitter per tool (`hermes.ts`, `archon.ts`, `pi.ts`, `egress.ts`, and `mcp.ts` for the MCP servers) and `buildAll` (`index.ts`). See [docs/generated-configs.md](docs/generated-configs.md). |
| `build/` | Generated by `mise run policy:build`, and gitignored: `hermes/config.yaml`, `archon/config.yaml` and `archon.env`, `pi/models.json` and `hapi-guard.json`, `egress/{hermes,archon,research}.squid.conf`, `mcp/{hermes,research}.mcp.json`. Never edit it by hand. |
| `tests/` | Unit tests for `bun test`. `tests/fixtures/` holds example work orders, overlays, a broken policy directory, and `command-vectors.json`, the command-allowlist cases that Plan 04's Python hook must also pass. `tests/docs/` checks the GitHub ruleset JSON in this README and the GitHub Apps runbook. |
| `.github/workflows/ci.yml` | [CI](#ci) for this repo. |
| `docs/policy.md` | The policy files (the MCP catalog and its lock included), the command-allowlist semantics, the overlay rule, the work-order format and the `hapi mcp` commands |
| `docs/generated-configs.md` | Every file under `build/`: what it is, which policy files feed it, what each hardening setting does and why, and how to regenerate it |
| `docs/mcp.md` | The MCP layer: which zone gets which server, how to add or upgrade one, the release cooldown, advisory floors, the tool-description lock and the CI scanners |
| `docs/secrets.md` | Secrets: the zones and their keys, the secrets map, setting up Bitwarden, `hapi secrets resolve`, the env files, `hapi token mint`, rotation |
| `docs/runbooks/` | Manual setup runbooks: [GitHub Apps and rulesets](docs/runbooks/github-apps.md), [provider keys and spend caps](docs/runbooks/provider-keys.md), [Slack](docs/runbooks/slack.md) |
| `docs/superpowers/specs/` | The design spec. It is the binding authority. |
| `docs/superpowers/plans/` | Implementation plans. Plan 01 is the current one. |
| `reports/`, `research_notes/` | The evidence the design rests on: the recon report and the research notes. |

Still to come in Plan 01:

| Path | What it will be | Arrives in |
|---|---|---|
| `docs/runbooks/` | The kill-switch runbook | Task 7 |
| `scripts/host-setup.sh`, `stack/compose.yaml` and the Dockerfiles, `src/stack/` | The one-time host setup (the `hapi` user and rootless Docker), the Compose stack and Squid egress | Task 5 |
| `tests/stack/` | Integration tests (`*.int.test.ts`), run by `mise run test:int` | Task 5 |
| `src/audit/` | `hapi audit`, the drift and settings checks | Task 6 |
| `docs/security/threat-model.md` | Threat model v0 | Task 7 |
| `docs/spikes/` | Results of the verify-early spikes. `spikes/scratch/` holds throwaway spike work and is gitignored. | Tasks 8–14 |

## mise tasks

Run `mise tasks` to list them with descriptions. Run any of them with `mise run <task>`.

| Task | What it does | Status |
|---|---|---|
| `setup` | `bun install --frozen-lockfile`: installs the JS dependencies exactly as `bun.lock` records them. It fails if `package.json` and `bun.lock` disagree. | Works |
| `lint` | Runs `setup`, then type-checks the whole project with `bunx tsc --noEmit` (strict). | Works |
| `test` | `bun test`: the unit suite. It needs no Docker, network or secrets. Integration tests are skipped unless `HAPI_INT` is set. | Works |
| `test:int` | `bun test tests/stack` with `HAPI_INT=1`: the integration tests. They need Docker. | The task exists. Its tests arrive in Plan 01 Task 5, and until then it fails with "did not match any test files". |
| `hapi` | `bun run src/cli.ts`: runs the [`hapi` CLI](#the-hapi-cli). Put `--` before the CLI's arguments: `mise run hapi -- --help`. | Works |
| `policy:build` | `hapi policy build`: compiles `policy/` into the Hermes, Archon, Pi, egress and MCP configs under `build/`. Pass CLI flags after `--`, e.g. `mise run policy:build -- --roster budget`. See [docs/generated-configs.md](docs/generated-configs.md). | Works |
| `audit` | Checks deployed config, pins and settings against policy, and exits non-zero on drift. | Stub. Arrives in Plan 01 Task 6. |
| `up` | Builds policy, resolves secrets, then starts the stack. | Stub. Arrives in Plan 01 Task 5. |
| `down` | Stops the stack. It is also a kill switch. | Stub. Arrives in Plan 01 Task 5. |

The stubs print which task implements them and **exit 1**. That is on purpose: a stub can never pass as a real check. This matters most for `audit`.

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
| `mcp verify [--policy dir] [--lock file]` | Checks every MCP server's live tool surface against `policy/mcp.lock.json`. Prints `ok`, `changed` or `unpinned` per server, and `orphaned` for a lock entry whose server left the catalog, and exits 1 unless all are `ok`. Until the live fetch is wired it exits 1. See [docs/policy.md](docs/policy.md#hapi-mcp-verify-and-hapi-mcp-pin). | The command works now; the live fetch arrives in Plan 01 Task 5 |
| `mcp pin --server name [--policy dir] [--lock file]` | Records one MCP server's live tool surface and its hash in `policy/mcp.lock.json`. A re-pin is a reviewed change ([docs/mcp.md](docs/mcp.md#adding-or-upgrading-a-server)). | The command works now; the live fetch arrives in Plan 01 Task 5 |
| `secrets resolve [--dry-run] [--map file] [--policy dir]` | Resolves the secrets map given with `--map` (your filled-in copy, outside the repo; the default, `stack/secrets.map.yaml`, is the placeholder template and is refused) from Bitwarden, all into memory first, then writes `$XDG_RUNTIME_DIR/hapi/<zone>.env` (mode `0600`, directory `0700`, atomically) and prints each path. Any missing or empty secret fails, naming the key, and nothing is written. It fails if `XDG_RUNTIME_DIR` is unset (no `/tmp` fallback), or if the map misses a bws reference of the MCP catalog in `--policy` (default `policy`). `--dry-run` prints `found`, `missing` or `placeholder` per key, never a value, writes nothing, and exits 1 unless every key is found. See [docs/secrets.md](docs/secrets.md#hapi-secrets-resolve). | Works |
| `token mint --app planner\|factory --repo owner/name` | Mints a 1-hour GitHub App installation token for that one repo, with the App's fixed permissions. It reads the App's id and key from `$XDG_RUNTIME_DIR/hapi/host.env`, rejects (and revokes) a token broader than requested, and writes the token to `$XDG_RUNTIME_DIR/hapi/tokens/<app>.<owner>.<repo>.token` (mode `0600`). It prints the path and expiry, never the token. See [docs/secrets.md](docs/secrets.md#hapi-token-mint). | Works |
| `audit [--repo owner/name ...]` | Runs the audit checks, and exits 1 if any check fails | Plan 01 Task 6 |

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
| `bitwarden-secrets-manager` | Provides `bws`. Secrets come from Bitwarden Secrets Manager when the stack starts, never from `.env` files (spec §11.5). |

**Supply-chain defaults** (spec §11.6–11.7):
- **Exact versions everywhere.** That covers `mise.toml`, `package.json` (`bunfig.toml` sets `exact = true`, so `bun add` never writes `^`) and the mise version CI uses.
- **A committed lockfile.** `bun.lock` is in git, and `mise run setup` installs with `--frozen-lockfile`.
- **A release-age cooldown.** `bunfig.toml` sets `minimumReleaseAge` to 3 days, so Bun won't resolve a package version published less than 3 days ago.
- **Pinned actions.** CI actions are pinned to full commit SHAs, CI runs with a read-only token, and checkout doesn't persist credentials.
- **No secrets on disk.** `.env*` files are gitignored. Secrets are written only to `0600` files on the user's tmpfs (`$XDG_RUNTIME_DIR/hapi/`), never to the repo or a `.env` file on disk.

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

These steps are outward-facing or privileged, so agents never do them; the operator does them by hand. Later tasks add their own steps here (`sudo scripts/host-setup.sh` in Task 5).

### Plan 01 Task 1: the GitHub remote and the `main` rulesets

1. **Rename the local repo to `hapi-factory`.** This is already done: the working directory is `hapi-factory`.

2. **Create the public repo and push `main`.**

   ```bash
   gh repo create j4th/hapi-factory --public \
     --description "Hermes + Archon + Pi: a reference stack for an end-to-end agentic software factory" \
     --source . --remote origin
   git push -u origin main
   git push -u origin plan-01-foundations   # then open a PR from it into main
   ```

3. **Add two rulesets on `main`.** Together they make the operator the only one who can merge into `main` (always through a PR), require a passing `ci` check for every merge, the operator's included, and block force-pushes and deletion. They are two rulesets, not one, because a ruleset's bypass list covers *every* rule in that ruleset. If the approval bypass and the `ci` check sat in one ruleset, the bypass would also let a merge through with `ci` red or missing. GitHub applies every ruleset that targets a branch, and a bypass in one ruleset doesn't carry over to another.

   - **`main-protect`** holds the required `ci` check and the force-push and deletion blocks. It has **no bypass actors**. Nobody, the operator included, can merge with `ci` failing or not yet run, force-push `main` or delete it. This is how every lane, `lane:direct` included, gets the same CI gates (spec §5.1).
   - **`main-review`** holds the pull-request rule (1 approving review, from a code owner) and **Restrict updates**. Its only bypass actor is the repository Admin role, in PR-only mode. Without that bypass, the operator couldn't merge his own `lane:direct` PRs, because GitHub doesn't let a PR's author approve it (spec §18). The bypass covers these two rules and nothing else; **`ci` can never be bypassed**. Because the bypass is PR-only, it applies only when merging a PR. the operator still can't push straight to `main`.
   - **Restrict updates is what stops an App merging** (spec §11.5: "Neither can merge"). It lets only the ruleset's bypass actors update `main`, and merging a PR updates `main`. So once the operator has approved an App's PR and `ci` is green, the App still can't merge it through the API; only the operator can, through the Admin bypass. It sits in `main-review`, never in `main-protect`: `main-protect` has no bypass actors, so there it would stop every merge, the operator's included. The code-owner review is a second layer: with `.github/CODEOWNERS` naming only the operator ([GitHub Apps runbook](docs/runbooks/github-apps.md#code-owners-a-second-layer)), an App's approval doesn't count either.

   The GitHub Apps get no bypass in either ruleset. `integration_id` 15368 is GitHub Actions, so only Actions can satisfy the `ci` check. In `bypass_actors`, `actor_id` 5 is the repository Admin role.

   ```bash
   gh api -X POST repos/j4th/hapi-factory/rulesets --input - <<'EOF'
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

   gh api -X POST repos/j4th/hapi-factory/rulesets --input - <<'EOF'
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

   **Check the result.** Run `gh api repos/j4th/hapi-factory/rulesets`, or open **Settings → Rules → Rulesets**. You should see both rulesets, and `main-protect` should list no bypass actors. To see the combined rules that apply to `main`, run `gh api repos/j4th/hapi-factory/rules/branches/main`.

   Then open a test PR and confirm three things:
   - The `ci` check runs and is required.
   - Merging needs the admin bypass. Because of Restrict updates, every merge into `main` is the operator's, through that bypass, even after an approval.
   - While `ci` is still running or has failed, merging stays blocked, even with the admin bypass.

   Once the GitHub Apps exist, also confirm that **an App's merge call is refused**, even with the operator's approval and `ci` green ([GitHub Apps runbook, Check it](docs/runbooks/github-apps.md#check-it)).

   These commands follow GitHub's REST docs, but nobody has run them yet. If GitHub rejects a field, set up the same two rulesets in the UI. Keep the rules split the same way: never put the `ci` check in a ruleset that has a bypass actor, and never put Restrict updates in one that has none. `tests/docs/rulesets.test.ts` holds this JSON to those rules.

4. **Task 5 needs this remote.** Task 5's `scripts/host-setup.sh` clones hapi-factory from `github.com/j4th/hapi-factory` into `/home/hapi/hapi-factory`.

### Plan 01 Task 3b: MCP server keys

`policy/mcp.yaml` names each MCP server's secret by its Bitwarden (`bws`) key. Store each in Bitwarden Secrets Manager under exactly this name, and put its id under the env var shown in your copy of the secrets map, outside the repo ([docs/secrets.md](docs/secrets.md#filling-in-the-map-the operator)):

| bws key | Map entry | What it is | Needed when |
|---|---|---|---|
| `hapi-mcp-context7-api-key` | `research` / `HAPI_MCP_CONTEXT7_API_KEY` (already in the template, as a placeholder) | A Context7 API key, on a spend-capped, search-only account (spec §10.1). Task 4's [provider-keys runbook](docs/runbooks/provider-keys.md#search-keys-brave-exa-context7) covers it. | Now: `hapi secrets resolve` needs every key in the map |
| `hapi-mcp-phoenix-viewer-key` | `hermes` / `HAPI_MCP_PHOENIX_VIEWER_KEY` (add it then) | A Phoenix API key minted by a **VIEWER**-role user, never an admin or member | Before you turn on the observability profile (`flags.otel.enabled: true`); until it's in the map, `hapi secrets resolve` fails |

Each key belongs to one server only. The generated configs reference it as `${HAPI_MCP_<NAME>}` (for example `${HAPI_MCP_CONTEXT7_API_KEY}`), never by value. See [docs/mcp.md](docs/mcp.md) and [docs/secrets.md](docs/secrets.md#the-secrets-map-stacksecretsmapyaml).

### Plan 01 Task 4: Bitwarden, provider keys, Slack and the GitHub Apps

Do these in order. Each runbook says which bws key each secret goes under.

1. **Bitwarden Secrets Manager:** a `hapi` project, a read-only machine account and its access token, kept only in your shell's environment as `BWS_ACCESS_TOKEN` ([docs/secrets.md](docs/secrets.md#setting-up-bitwarden-secrets-manager-the operator)).
2. **Provider keys:** the Anthropic Console workspaces `hapi-hermes` ($60), `hapi-factory` ($100) and `hapi-evals` ($40), OpenCode Go, the OpenRouter key `hapi-jev` ($2/month, set as a $0.06 limit that resets daily, with ZDR enforced by a guardrail), and the Brave, Exa and Context7 search keys ([provider keys](docs/runbooks/provider-keys.md)).
3. **Slack:** a dedicated workspace, `#hapi-intake` and `#hapi-alerts`, and the app's tokens ([Slack](docs/runbooks/slack.md)). The app is created from the hapi Hermes container's manifest, so this step waits for Plan 01 Task 13; until then its three keys stay placeholders.
4. **GitHub Apps and rulesets:** `hapi-planner` and `hapi-factory` with exactly their permissions, their keys in Bitwarden, and the rulesets: Restrict updates on `main-review`, so that no App can merge, and code-owner review ([GitHub Apps](docs/runbooks/github-apps.md)). The rulesets need the repo to be public. Then check that an App's merge call is refused.
5. **Fill in the map, outside the repo:** copy `stack/secrets.map.yaml` to `~/.config/hapi/secrets.map.yaml` and replace each placeholder in the copy with the secret's id from the Bitwarden web app ([docs/secrets.md](docs/secrets.md#filling-in-the-map-the operator)). Never fill in or commit `stack/secrets.map.yaml` itself: it is the public template, and a unit test fails if it holds anything but placeholders.
6. **Check:** `mise run hapi -- secrets resolve --dry-run --map ~/.config/hapi/secrets.map.yaml`. Expected: every key `found`, no value printed, exit 0.

## Documentation map

| Document | What's in it |
|---|---|
| [Design spec](docs/superpowers/specs/2026-10-26-hapi-factory-design.md) | Intent, architecture, policy, security, phases. It is the binding authority. |
| [Policy](docs/policy.md) | Each policy file and its schema (the MCP catalog `mcp.yaml` and its lockfile included), how Hermes's command rules match (and what the Plan 04 hook must do first), the tighten-only overlay rule with examples, the work-order format, `hapi workorder validate`, and `hapi mcp verify` and `hapi mcp pin` |
| [Generated configs](docs/generated-configs.md) | Each file `hapi policy build` writes under `build/`, its policy sources, every hardening setting and why, how protected paths stay strictest-wins, and how to regenerate |
| [Secrets](docs/secrets.md) | The zones and their keys, the secrets map template and its placeholders, filling in your copy outside the repo, setting up Bitwarden, `hapi secrets resolve` and its env files, `hapi token mint`, the "keys, never values" rule, rotation |
| [Runbook: GitHub Apps](docs/runbooks/github-apps.md) | Creating `hapi-planner` and `hapi-factory` with exact permissions, the rulesets (both on `main`, Restrict updates so no App can merge, code owners, branch and tag scope), checks (including that an App's merge call is refused), suspending an installation, rotating a key |
| [Runbook: provider keys](docs/runbooks/provider-keys.md) | The Console workspaces and their limits, OpenCode Go settings, the OpenRouter keys (daily-reset limits, ZDR guardrails, the Jev exception if it has no ZDR endpoint), the Brave, Exa and Context7 search keys, and where each goes |
| [Runbook: Slack](docs/runbooks/slack.md) | The workspace and channels, creating the app from Hermes's manifest, the three Slack secrets, Hermes's Slack settings |
| [MCP servers](docs/mcp.md) | Which zone gets which MCP server and why, how to add or upgrade one (a planning PR plus a re-pin), the release cooldown and its security-fix exception, advisory floors, the tool-description lock and the CI scanners |
| [Plan 01: Foundations](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md) | Tasks 1–14: toolchain, policy, generators, secrets, stack, audit, threat model, spikes |
| [Recon report](reports/Agentic%20software%20factory%20recon.md) | The evidence the design rests on, with sources and versions |
| [`research_notes/`](research_notes/) | Detailed research notes behind the report |
| `docs/security/`, `docs/spikes/`, the kill-switch runbook | The threat model, spike results and the kill-switch runbook, which arrive in Plan 01 Tasks 7–14 |
