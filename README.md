# hapi-factory

hapi-factory is a public, best-practices reference stack for an end-to-end agentic software factory. **HAPi** stands for **H**ermes + **A**rchon + **Pi**: Hermes is the coordinator you talk to, Archon is the run engine and Pi is the worker. The stack puts existing tools together into one working system. It also covers the steps most factories skip: discovery research, architecture, threat modeling and breaking work into tasks. Security is designed in from the start: one policy compiled into every tool's config, rootless containers behind default-deny egress, secrets from a vault, short-lived GitHub App tokens, and an audit that catches drift. Read the design in [docs/superpowers/specs/2026-10-26-hapi-factory-design.md](docs/superpowers/specs/2026-10-26-hapi-factory-design.md). It is the binding reference for everything here.

> **Status: Plan 01 (Phase 0 foundations) is in progress.** Today the repo has the pinned toolchain, the `hapi` CLI skeleton and CI. Anything marked *arrives in Plan 01 Task N* is not built yet. The plan is [docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md).

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
| `mise.toml` | Tool pins and the [mise tasks](#mise-tasks). This is a protected path (spec §8.2), so agents may not edit it. |
| `package.json`, `bun.lock` | JS project metadata and dev dependencies (`typescript`, `@types/bun`), pinned to exact versions. The lockfile is committed. There are no runtime dependencies yet; Task 2 adds `ajv` and `yaml`. |
| `bunfig.toml` | Bun install settings: exact versions and a 3-day release-age cooldown (see [Toolchain and pinning](#toolchain-and-pinning)). |
| `tsconfig.json` | Strict TypeScript settings, used only for type-checking. Bun runs the `.ts` files directly. |
| `src/cli.ts` | The `hapi` CLI: the entry point, the command registry and `main(argv)`. |
| `src/version.ts` | `HAPI_VERSION`. It must match `version` in `package.json`, and a test checks that it does. |
| `tests/` | Unit tests for `bun test`. |
| `.github/workflows/ci.yml` | [CI](#ci) for this repo. |
| `docs/superpowers/specs/` | The design spec. It is the binding authority. |
| `docs/superpowers/plans/` | Implementation plans. Plan 01 is the current one. |
| `reports/`, `research_notes/` | The evidence the design rests on: the recon report and the research notes. |

Still to come in Plan 01:

| Path | What it will be | Arrives in |
|---|---|---|
| `policy/` | The single source of truth: protected paths, commands, trusted sources, budgets, approvals, roles, flags, model rosters and their JSON Schemas | Task 2 |
| `src/policy/`, `src/workorder/` | The policy loader, the repo-overlay merge (which may only tighten policy) and the work-order validator | Task 2 |
| `src/generate/`, `build/` | Generators that compile `policy/` into Hermes, Archon, Pi and egress configs under `build/`. `build/` is generated and gitignored. | Task 3 |
| `src/secrets/`, `src/forge/`, `stack/secrets.map.yaml` | Secrets resolved from Bitwarden (`bws`), and GitHub App installation-token minting | Task 4 |
| `docs/runbooks/` | Runbooks for GitHub App setup, provider keys and kill switches | Tasks 4, 7 |
| `scripts/host-setup.sh`, `stack/`, `src/stack/` | The one-time host setup (the `hapi` user and rootless Docker), the Compose stack and Squid egress | Task 5 |
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
| `policy:build` | Compiles `policy/` into configs under `build/`. | Stub. Arrives in Plan 01 Task 3. |
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
- `2`: a usage error, either an unknown command or no command at all.

**Commands:**

| Command | What it does | Arrives in |
|---|---|---|
| `--version` | Prints the version (`0.1.0`) | Works |
| `--help`, `-h` | Prints usage and the registered commands | Works |
| `workorder validate <path>` | Validates a work order against its schema | Plan 01 Task 2 |
| `policy build [--policy dir] [--out dir] [--roster name]` | Compiles policy into `build/` | Plan 01 Task 3 |
| `secrets resolve [--dry-run]` | Resolves the stack's secrets from Bitwarden into `0600` files under `$XDG_RUNTIME_DIR/hapi/` | Plan 01 Task 4 |
| `token mint --app planner\|factory --repo owner/name` | Mints a 1-hour GitHub App installation token | Plan 01 Task 4 |
| `audit [--repo owner/name ...]` | Runs the audit checks, and exits 1 if any check fails | Plan 01 Task 6 |

**Adding a command (for contributors).** Write the handler in its own module, for example `src/policy/build.ts`. Then register it in the *Commands* section at the bottom of `src/cli.ts`:

```ts
import { policyBuild } from "./policy/build";
register("policy build", policyBuild, "Compile policy/ into build/");
```

Here is how commands work:
- A name can be several words. `main` matches the longest registered name against the leading words of argv, and passes the remaining args to the handler.
- No word in a name may start with `-`.
- Registering the same name twice throws.
- A handler gets the args after its name, as `(args: string[]) => number | Promise<number>`, and returns the exit code.
- Print results to stdout and diagnostics to stderr.

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
- **No secrets on disk.** `.env*` files are gitignored, and the design never writes secrets to `.env` files.

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

The `main` ruleset requires the `ci` check to pass (see the manual steps below). The reusable security-gates workflow for target repos (gitleaks, SAST, OSV-Scanner, zizmor, work-order schema, commit trailers) is separate; it arrives in Plan 05 (spec §11.7).

## Using hapi-factory with another repo

**This isn't ready yet.** Target repos will *reference* hapi-factory rather than copy it (spec §17), through a small per-repo contract (spec §7):
- `AGENTS.md`;
- `mise.toml` tasks;
- a `.factory/config.yaml` policy overlay;
- a thin CI wrapper around the reusable gates workflow, pinned by tag;
- CODEOWNERS and a `main` ruleset.

Plan 05 builds the template and `mise run new-repo`. This section will become the step-by-step drop-in guide at that point.

## Manual setup steps (the operator)

These steps are outward-facing or privileged, so agents never do them; the operator does them by hand. Later tasks add their own steps here (GitHub Apps and Bitwarden secrets in Task 4, `sudo scripts/host-setup.sh` in Task 5).

### Plan 01 Task 1: the GitHub remote and the `main` ruleset

1. **Rename the local repo to `hapi-factory`.** This is already done: the working directory is `hapi-factory`.

2. **Create the public repo and push `main`.**

   ```bash
   gh repo create j4th/hapi-factory --public \
     --description "Hermes + Archon + Pi: a reference stack for an end-to-end agentic software factory" \
     --source . --remote origin
   git push -u origin main
   git push -u origin plan-01-foundations   # then open a PR from it into main
   ```

3. **Add a ruleset on `main`.** It needs 1 approving review and a passing `ci` check. It also blocks force-pushes and deletion, and gives the repo admin role, and only that role, a PR-only bypass. Without the bypass, the operator couldn't merge his own `lane:direct` PRs, because GitHub doesn't let a PR's author approve it (spec §18). The GitHub Apps are never given a bypass. `integration_id` 15368 is GitHub Actions, so only Actions can satisfy the `ci` check, and in `bypass_actors`, `actor_id` 5 is the repository Admin role.

   ```bash
   gh api -X POST repos/j4th/hapi-factory/rulesets --input - <<'EOF'
   {
     "name": "main",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [
       { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "pull_request" }
     ],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "pull_request", "parameters": {
           "required_approving_review_count": 1,
           "dismiss_stale_reviews_on_push": true,
           "require_code_owner_review": false,
           "require_last_push_approval": false,
           "required_review_thread_resolution": false } },
       { "type": "required_status_checks", "parameters": {
           "strict_required_status_checks_policy": false,
           "required_status_checks": [ { "context": "ci", "integration_id": 15368 } ] } }
     ]
   }
   EOF
   ```

   Then check it with `gh api repos/j4th/hapi-factory/rulesets`, or under **Settings → Rules → Rulesets**. Open a test PR and confirm two things: the `ci` check runs and is required, and merging is blocked until there's an approval or an admin bypass. The command was written from GitHub's REST docs but hasn't been run yet. If GitHub rejects a field, set the same rules in the UI.

4. **Task 5 needs this remote.** Task 5's `scripts/host-setup.sh` clones hapi-factory from `github.com/j4th/hapi-factory` into `/home/hapi/hapi-factory`.

## Documentation map

| Document | What's in it |
|---|---|
| [Design spec](docs/superpowers/specs/2026-10-26-hapi-factory-design.md) | Intent, architecture, policy, security, phases. It is the binding authority. |
| [Plan 01: Foundations](docs/superpowers/plans/2026-10-26-hapi-factory-01-foundations.md) | Tasks 1–14: toolchain, policy, generators, secrets, stack, audit, threat model, spikes |
| [Recon report](reports/Agentic%20software%20factory%20recon.md) | The evidence the design rests on, with sources and versions |
| [`research_notes/`](research_notes/) | Detailed research notes behind the report |
| `docs/runbooks/`, `docs/security/`, `docs/spikes/` | Runbooks, the threat model and spike results, which arrive in Plan 01 Tasks 4–14 |
