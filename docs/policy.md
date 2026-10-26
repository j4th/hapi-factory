# Policy, repo overlays and work orders

`policy/` is the single source of truth for what the factory's agents may do (spec §8). Each tool's native config is generated from it, so a rule lives in one place and is enforced at several points: Hermes, Archon, Pi, the egress proxies and CI. This page covers:

- [the policy files](#the-policy-files) and what each one holds;
- [how policy is validated](#validation-and-errors);
- [repo overlays](#repo-overlays-factoryconfigyaml), which may only tighten policy;
- [work orders](#work-orders), with `hapi workorder validate`;
- [the TypeScript API](#typescript-api) that later code builds on.

The generator that compiles policy into tool configs (`hapi policy build`) arrives in Plan 01 Task 3. Until then, policy is loaded and validated, but nothing is generated from it.

## The policy files

| File | Schema | What it holds | Compiled into (spec §8.1) |
|---|---|---|---|
| `protected_paths.yaml` | `policy-protected-paths` | Paths agents can't change freely, with a mode per session kind | Hermes `security.protected_instruction_files`, the hapi-path-guard plugin and a command allowlist; Pi hapi-guard; later, Claude Code permission rules; CI path checks |
| `commands.yaml` | `policy-commands` | Hermes's command allowlist; the Pi built-in tools workers get | The Hermes `hapi-cmd-allow` hook (default-deny, fail-closed; Plan 04); Archon `allowed_tools` per node |
| `trusted_sources.yaml` | `policy-trusted-sources` | Source tiers T0–T3, and the hosts each egress zone may reach | The egress proxy allowlists (the real boundary); Hermes's web backend pins and blocklist; Anthropic `allowed_domains` |
| `budgets.yaml` | `policy-budgets` | Workspace and key caps, the per-run target, Hermes's turn limit | Hermes `max_turns`; Archon `budget` on per-task children; hapi-guard limits; provider key limits (documented, applied by hand or API) |
| `approvals.yaml` | `policy-approvals` | The fixed short list of actions that always need the operator | Not compiled in Plan 01; later plans enforce it |
| `roles.yaml` | `policy-roles` | The default model tier per role | With the rosters: Archon tiers and aliases; Hermes model, auxiliary and delegation settings |
| `rosters/{budget,anthropic,portable}.yaml` | `policy-roster` | Tier → provider, model and effort, one file per roster | See `roles.yaml` |
| `flags.yaml` | `policy-flags` | Metrics and observability switches, signal switches, run thresholds | Metrics, observability and run flagging (spec §13; later plans) |

The schemas are in `policy/schemas/`, named `<schema>.schema.json`. `policy-defs.schema.json` holds the definitions they share: modes, tiers, host names, repo paths. Each policy file starts with a `# yaml-language-server: $schema=...` line, so an editor with the YAML language server checks it as you type.

### `protected_paths.yaml`

```yaml
protected_paths:
  "AGENTS.md":   { interactive: ask, unattended: deny, workers: deny }
  ".pi/**":      { interactive: deny, unattended: deny, workers: deny }
  # ... and .factory/**, .github/**, mise.toml, .agents/**, .archon/** (exactly spec §8.2)
```

Keys are globs relative to a repo's root. Each entry sets all three modes:

| Session kind | Who | What it means |
|---|---|---|
| `interactive` | the operator is in the session (Hermes, or later a direct-lane Pi session) | `ask` puts the diff in front of him to approve |
| `unattended` | Hermes cron, webhook and API surfaces | Always `deny` |
| `workers` | Pi or Claude Code inside Archon | Always `deny` |

A mode is `allow`, `ask` or `deny`, and they tighten in that order: **allow < ask < deny**. A path that isn't listed is `allow` in every mode. The backstop is CODEOWNERS plus the `main` rulesets: a guard that fails locally still can't land a change.

### `commands.yaml`

- **`hermes.allow`** is the list of shell command patterns Hermes may run, such as `git switch -c plan/*` or `hapi workorder validate *`. Everything else is denied. `*` matches any arguments. This is an initial list; Plan 04 refines it when it builds the `hapi-cmd-allow` hook.
- **`workers.tools`** is the set of Pi built-in tools that factory worker nodes get: `read`, `grep`, `find`, `ls`, `edit`, `write` and `bash`. These are the only names allowed. Workers get no web tools (spec §10).

### `trusted_sources.yaml`

**Tiers** (spec §10):

| Tier | What | Hosts |
|---|---|---|
| `T0` | Pinned local snapshots | None; no network access needed |
| `T1` | First-party domains and package registries | `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` |
| `T2` | Curated aggregators | `context7.com`, `deepwiki.com` |
| `T3` | The open web | Not a list. Only a zone with `openWeb: true` reaches it. |

**Zones.** There is one zone per container network, and each has its own egress proxy:

| Zone | Tiers | Own hosts | Notes |
|---|---|---|---|
| `hermes` | T0–T2 | `api.anthropic.com`, `openrouter.ai`, `api.github.com`, `github.com`, `slack.com` | The Hermes main session |
| `archon` | T0–T1 | `api.anthropic.com`, `openrouter.ai`, `opencode.ai`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | Archon and its Pi workers. **No forge host**: the Archon zone has no route to GitHub (spec §4.3). |
| `research` | T0–T3 | None | `openWeb: true`. Only hapi-research touches the open web. Private address ranges stay blocked. |

A zone's allowlist is its own `hosts` **plus** the hosts of every tier it lists. Hosts are plain, lowercase domains with at least two labels: no scheme, port, path, wildcard or leading dot, and no IP addresses. The egress generator allows each domain and its subdomains, so `slack.com` also covers `wss-primary.slack.com`.

The schema enforces spec §10's tier entitlements: the `hermes` zone may list only T0–T2, the `archon` zone only T0–T1, and only the `research` zone may set `openWeb`.

### `budgets.yaml`

All amounts are in USD.

| Key | Value | Meaning |
|---|---|---|
| `workspaces.hapi-hermes` | 60 | Monthly limit on the Hermes Anthropic Console workspace |
| `workspaces.hapi-factory` | 100 | Monthly limit on the factory workspace |
| `workspaces.hapi-evals` | 40 | Monthly limit on the evals workspace |
| `openrouter_monthly_usd` | 20 | Monthly cap on the OpenRouter key |
| `jev_monthly_usd` | 2 | Monthly cap on Jev's own OpenRouter key |
| `run_usd` | 3.00 | Target spend per factory run |
| `hermes_max_turns` | 60 | Hermes `agent.max_turns` |

The monthly caps are enforced at the provider. the operator sets them on the Console workspaces and OpenRouter keys; the Task 4 runbook covers it. The workspaces add up to the $200/month credit, and the default workspace is unused.

### `approvals.yaml`

This file is a plain list, not a mapping: `merge`, `new_dependency`, `new_skill_or_mcp`, `ci_workflow_change`, `outbound_message`, `spend_above_threshold`. These are the actions that always need the operator (spec §5.2, §8.1). Only these six names are valid.

### `roles.yaml` and `rosters/`

`roles.yaml` gives each role its default tier:

| Role | Tier |
|---|---|
| `hermes_main`, `planner`, `implement` | `large` |
| `review`, `eval_judge` | `medium` |
| `hermes_auxiliary`, `scout`, `router` | `small` |

A **roster** maps each tier to the Archon provider, model and effort that serve it. A run selects one roster, and a work order may pick a different tier for `implement` and `review`. Neither roles nor work orders ever name a model.

```yaml
# policy/rosters/anthropic.yaml
small:  { provider: pi, model: anthropic/claude-haiku-5-5, effort: low }
medium: { provider: claude, model: claude-sonnet-5-5, effort: medium }
large:  { provider: pi, model: anthropic/claude-opus-5-5, effort: low, retry_effort: high }
```

- **`provider`** is the Archon provider that runs the tier. `pi` is the embedded Pi SDK; `claude` is Claude Code via the Agent SDK.
- **`model`** depends on the provider. For `pi`, it's a Pi model ref, `<vendor>/<model-id>` (the schema checks the form). For `claude`, it's an Anthropic model id.
- **`effort`** uses Archon's ladder: `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.
- **`retry_effort`** is optional. It is the effort a retry escalates to, before any change of model.

| Roster | Use (spec §12) | small | medium | large |
|---|---|---|---|---|
| `anthropic` | Normal operation | Haiku 5.5 on Pi | Sonnet 5.5 via the Claude provider | Opus 5.5 on Pi, effort low, retry high |
| `budget` | The first end-to-end runs | Haiku 5.5 on Pi | Haiku 5.5 via the Claude provider | Haiku 5.5 on Pi |
| `portable` | Proving model portability | `opencode-go/glm-5.3-flash` | `opencode-go/glm-5.3` | `opencode-go/kimi-k3.1-pro`, retry high |

**The `portable` roster** runs every tier on Pi through OpenCode Go. It may use **only models with 0-day retention and no training**. The ids and terms were checked against <https://opencode.ai/docs/go/> on 2026-10-26. DeepSeek is left out because its zero-retention agreement is renewed monthly. Review (GLM) runs on a different model family from implement (Kimi).

A unit test enforces both of these rules. If you change the roster, check the model's terms on that page first, then update the test's list.

### `flags.yaml`

This file is exactly spec §13.3:

| Key | Value |
|---|---|
| `metrics` | `{ enabled: true, merge_outcomes: true }` |
| `otel` | `{ enabled: false, content_capture: off }` (`off` or `preview`) |
| `jev` | `{ enabled: true, fallback: haiku, via: openrouter }` (`fallback` is `haiku` or `none`) |
| `coderabbit` | `{ enabled: true, include_in_rework: true }` |
| `thresholds` | `{ run_usd: 3.00, interventions: 1, review_rounds: 2 }`. Crossing any one flags the run. |
| `on_flag` | `[label_pr, chat_alert]`. A flagged run gets `hapi:flagged` on its PR and an alert in Slack `#hapi-alerts`. |

## Validation and errors

Every file is checked against its JSON Schema (draft 2020-12, with Ajv in strict mode, collecting all errors).

**Every object in every schema sets `additionalProperties: false`, so an unknown or misspelled key is an error, never silently ignored.** A unit test walks the schemas to check this.

YAML is parsed as YAML 1.2, so `off` and `yes` stay strings. A **duplicate key** is a parse error, so a second entry can't silently override the first.

When a file fails, `loadPolicy` throws a `PolicyError` with these fields:

| Field | What it holds |
|---|---|
| `file` | The file that failed |
| `path` | A [JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901) into that file. `""` means the whole file (a missing file or a YAML syntax error). |
| `issues` | Every problem found in the file |
| `message` | `file: path: problem; path: problem; ...` |

Unknown keys are reported first, because one is usually the typo behind a "missing required key" next to it. For example, with `workspaces` misspelled in `budgets.yaml`:

```text
policy/budgets.yaml: /wokspaces: unknown key; /workspaces: missing required key
```

In a JSON Pointer, a `/` inside a key is written `~1` and a `~` is written `~0`. So the `workers` mode of `.pi/**` is `/protected_paths/.pi~1**/workers`.

**To change policy:**
1. Edit the YAML.
2. Run `mise run test`. The unit tests load `policy/` and check its values against the spec.
3. Open a PR. `policy/` changes go through review like any other code.

## Repo overlays (`.factory/config.yaml`)

A target repo can adjust the central policy with an overlay in its `.factory/config.yaml` (spec §7). **An overlay may only tighten policy.** The one exception is `egress_extra`: it may add hosts, and the overlay file is itself protected (`.factory/**`), so adding one goes through a reviewed planning PR.

An overlay has three keys. **Any other key is rejected.**

| Key | What it may do |
|---|---|
| `protected_paths` | **Add** a path, or **raise** a listed path's modes (allow < ask < deny). An entry may name only some of the three modes; the others keep their current value, which is `allow` for a path the base policy doesn't list. `null` asks to remove the path, and that is **always rejected**. |
| `egress_extra` | **Add** hosts to the `archon` zone's allowlist. The rules are the same as for any host. A **forge host** (`github.com`, `githubusercontent.com`, `githubassets.com`, `ghcr.io`, or a subdomain of one) is rejected, because the Archon zone must never reach the forge (spec §4.3). |
| `budgets` | **Lower** any budget in `budgets.yaml`. Each value must be at most the base value. |

The overlay is checked in two stages:
1. **`loadOverlay(file)`** checks the file against `repo-overlay.schema.json`. That catches unknown keys, bad modes and malformed hosts, and throws a `PolicyError`.
2. **`applyOverlay(policy, overlay)`** compares the overlay with the base policy. It throws a `PolicyLoosenError` at the **first** change that would loosen policy. The error's `path` is a JSON Pointer into the overlay, and its message names the path or glob as written. **A loosening change is never merged silently.** `applyOverlay` returns a new policy and changes neither input. It also re-runs the schema check, so an overlay built in code gets the same checks as one read from a file.

### An accepted overlay

```yaml
# .factory/config.yaml
protected_paths:
  "src/secrets/**": { interactive: deny, unattended: deny, workers: deny }   # a new path
  "AGENTS.md": { interactive: deny }      # ask -> deny is tighter; unattended and workers stay deny
egress_extra: ["odoo.internal"]           # the private Odoo sidecar the smoke check needs
budgets:
  run_usd: 2.00                           # lower than the base's 3.00
```

The result has `src/secrets/**` and `AGENTS.md` denied in every mode, and `odoo.internal` in the archon zone's hosts. Its `budgets.run_usd` is 2. This file is `tests/fixtures/overlay-tighten.yaml`.

### Rejected overlays

These are the real error messages:

| Overlay | Error |
|---|---|
| `protected_paths: { "AGENTS.md": { interactive: allow } }` | `PolicyLoosenError: /protected_paths/AGENTS.md/interactive: loosens "AGENTS.md" interactive from ask to allow; overlays may only tighten policy` |
| `protected_paths: { ".github/**": null }` | `PolicyLoosenError: /protected_paths/.github~1**: removes protected path ".github/**"; overlays may only tighten policy` |
| `egress_extra: ["github.com"]` | `PolicyLoosenError: /egress_extra/0: "github.com" is a forge host (github.com); the archon zone has no forge route (spec §4.3); overlays may only tighten policy` |
| `budgets: { run_usd: 5.00 }` | `PolicyLoosenError: /budgets/run_usd: raises budgets.run_usd from 3 to 5; overlays may only tighten policy` |
| `commands: { hermes: { allow: ["*"] } }` | `PolicyError: .factory/config.yaml: /commands: unknown key` |

## Work orders

A work order is the machine-readable contract for one factory run (spec §6). Hermes writes it on the planning branch as `.factory/work/<id>/order.yaml`, next to a `task.md` that holds the goal, context and acceptance criteria. Once merged, it is immutable: a new attempt is a new work order, or a re-run of the same id at a new commit.

```yaml
id: 0002-search-partners-tool
lane: factory
workflow: factory-task              # Archon workflow name (home-scoped pack)
risk: medium                        # low | medium | high: drives review depth and thresholds
roles:                              # abstract tiers, never model ids
  implement: medium
  review: medium
budget: { usd: 3.00, turns: 40, minutes: 30 }
pieces:
  - id: search-partners
    files: ["src/odoo_mcp/tools/partners.py", "tests/tools/test_partners.py"]   # declared scope
    size: small
verify:
  smoke: true                       # run `mise run smoke` against the local Odoo sidecar
egress_extra: ["odoo.internal"]     # hosts the smoke check needs (here: the private sidecar)
trace:
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
sources: ["docs/research/odoo-external-api.md", "docs/design/odoo-mcp.md"]
```

The schema is `policy/schemas/work-order.schema.json`. **Every field is required, and unknown keys are rejected.**

| Field | Rule |
|---|---|
| `id` | At least 4 digits, a hyphen, then a lowercase slug, e.g. `0002-search-partners-tool`. At most 80 characters. It names the directory and the `factory/<id>` branch. |
| `lane` | `planning`, `factory` or `direct` (spec §5.1) |
| `workflow` | A lowercase slug: an Archon workflow name |
| `risk` | `low`, `medium` or `high` |
| `roles.implement`, `roles.review` | A tier: `small`, `medium` or `large`. A model id is rejected. |
| `budget` | `usd` greater than 0; `turns` and `minutes` whole numbers, at least 1 |
| `pieces` | At least one. Each has a unique slug `id`, a non-empty list of `files` and a `size` tier. |
| `verify.smoke` | `true` or `false` |
| `egress_extra` | A list of hosts (it may be empty), with the same host rules as policy |
| `trace.traceparent` | A W3C traceparent matching `^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$` |
| `sources` | A list of repo files the order rests on (it may be empty) |

**Paths** in `files` and `sources` must be relative to the repo root. An absolute path, a `..` segment or a backslash is rejected, so a declared scope can't point outside the repo.

`id` and `traceparent` are written by deterministic code (Hermes's `new-work-order` tool), never by the model. The same schema check runs in three places:
- in Hermes, before the planning PR is opened;
- in CI, on the planning PR;
- in Archon's `prepare` step.

### `hapi workorder validate <path>`

```bash
mise run hapi -- workorder validate .factory/work/0002-search-partners-tool/order.yaml
```

- **Valid:** it prints the work order's `id` to stdout and exits `0`.
- **Invalid:** it prints one `path: message` line per problem to stderr and exits `1`. For example: `/trace/traceparent: must match pattern "^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$"`. A file that can't be read or parsed is reported at `(root)`.
- **Wrong arguments:** with no path, or more than one, it prints usage and exits `2`.

## TypeScript API

Later plans build on these functions:

| Function | Module | What it does |
|---|---|---|
| `loadPolicy(dir): Policy` | `src/policy/load.ts` | Loads and validates `policy/`. Throws `PolicyError { file, path, message, issues }`. |
| `loadOverlay(file): RepoOverlay` | `src/policy/overlay.ts` | Loads and schema-checks an overlay. Throws `PolicyError`. |
| `applyOverlay(p, o): Policy` | `src/policy/overlay.ts` | Tighten-only merge. Throws `PolicyLoosenError { path, message }`. |
| `validateWorkOrder(obj): WorkOrder` | `src/workorder/validate.ts` | Validates a parsed work order. Throws `WorkOrderError { path, message, issues }`. |
| `loadWorkOrder(file): WorkOrder` | `src/workorder/validate.ts` | Reads, parses and validates a work-order file |

The types (`Policy`, `Mode`, `Tier`, `Roster`, `ZoneName` and the rest) are in `src/policy/types.ts`; `WorkOrder` is in `src/workorder/validate.ts`. Schema compilation and error formatting are in `src/policy/schema.ts`.
