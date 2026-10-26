# Policy, repo overlays and work orders

`policy/` is the single source of truth for what the factory's agents may do (spec §8). Each tool's native config is generated from it, so a rule lives in one place and is enforced at several points: Hermes, Archon, Pi, the egress proxies and CI. This page covers:

- [the policy files](#the-policy-files) and what each one holds;
- [how policy is validated](#validation-and-errors);
- [repo overlays](#repo-overlays-factoryconfigyaml), which may only tighten policy;
- [work orders](#work-orders), with `hapi workorder validate`;
- [the TypeScript API](#typescript-api) that later code builds on.

`hapi policy build` (`mise run policy:build`) compiles policy into each tool's config under `build/`. [docs/generated-configs.md](generated-configs.md) describes every generated file, which policy files feed it and what each setting does.

## The policy files

| File | Schema | What it holds | Compiled into (spec §8.1) |
|---|---|---|---|
| `protected_paths.yaml` | `policy-protected-paths` | Paths agents can't change freely, with a mode per session kind | Hermes `security.protected_instruction_files`, the hapi-path-guard plugin and a command allowlist; Pi hapi-guard; later, Claude Code permission rules; CI path checks |
| `commands.yaml` | `policy-commands` | Hermes's command allowlist, as argv-exact rules; the Pi built-in tools workers get | The Hermes `hapi-cmd-allow` hook (default-deny, fail-closed; Plan 04); Archon `allowed_tools` per node |
| `trusted_sources.yaml` | `policy-trusted-sources` | Source tiers T0–T3, and the hosts each egress zone may reach | The egress proxy allowlists (the real boundary); Hermes's web backend pins and blocklist; Anthropic `allowed_domains` |
| `budgets.yaml` | `policy-budgets` | Workspace and key caps, the per-run target, Hermes's turn limit | Hermes `max_turns`; Archon `budget` on per-task children; hapi-guard limits; provider key limits (documented, applied by hand or API) |
| `approvals.yaml` | `policy-approvals` | The fixed short list of actions that always need the operator | Not compiled in Plan 01; later plans enforce it |
| `roles.yaml` | `policy-roles` | The default model tier per role | With the rosters: Archon tiers and aliases; Hermes model, auxiliary and delegation settings |
| `rosters/{budget,anthropic,portable}.yaml` | `policy-roster` | Tier → provider, model and effort, one file per roster | See `roles.yaml` |
| `flags.yaml` | `policy-flags` | Metrics and observability switches, signal switches, run thresholds | Metrics, observability and run flagging (spec §13; later plans) |

The schemas are in `policy/schemas/`, named `<schema>.schema.json`. `policy-defs.schema.json` holds the definitions they share: modes, tiers, risk, host names, forge hosts, repo paths and globs. Each policy file starts with a `# yaml-language-server: $schema=...` line, so an editor with the YAML language server checks it as you type.

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

A mode is `allow`, `ask` or `deny`, and they tighten in that order: **allow < ask < deny**. The backstop is CODEOWNERS plus the `main` rulesets: a guard that fails locally still can't land a change.

#### How globs combine

This rule is binding on every guard and generator that reads `protected_paths`:

> **A file's effective mode, for each session kind, is the strictest mode across every glob that matches it.** It is never the first match, the last match or the most specific match. A file that no glob matches is `allow` in every mode.

So adding a glob can only tighten. A narrower or later glob never loosens a broader one, and `allow` in an entry means "this glob adds no rule for that session kind", not "permit". For example, with `.github/**` at `{ask, deny, deny}`, a second glob `.github/workflows/**: {interactive: deny, unattended: allow, workers: allow}` makes `.github/workflows/ci.yml` `{deny, deny, deny}`, and `.github/CODEOWNERS` stays `{ask, deny, deny}`.

Code reads this with **`effectiveModes(policy, path)`** in `src/policy/paths.ts`, never by looking up a key. It normalizes the path first, so `./AGENTS.md` and `docs/../AGENTS.md` are both `AGENTS.md`. It throws rather than calling a path `allow` when the path:

- is empty, absolute or outside the repo;
- contains NUL, any other control character (U+0000–U+001F and U+007F–U+009F, Unicode category `Cc`) or a backslash. A backslash isn't a separator here, but a guard on another OS or tool could read it as one and see a different path.

The error names the problem, with the path JSON-escaped so it prints safely, e.g. `invalid path ".github\\workflows\\ci.yml": contains a backslash; separate segments with "/"` or `invalid path "a\u001bb": contains a control character (U+001B)`.

A guard that isn't TypeScript, such as the Python hapi-path-guard (Plan 04), must implement the same rule and pass the same cases as `tests/policy/paths.test.ts`.

#### Glob syntax

The schema (`pathGlob` in `policy-defs.schema.json`) accepts only this dialect, in `protected_paths.yaml` and in overlays:

| Glob | Matches |
|---|---|
| `AGENTS.md` | Only the root `AGENTS.md`. A glob is anchored at the repo root and matched against the whole path, case-sensitively. Use `**/AGENTS.md` for every one. |
| `.github/**` | `.github` itself and everything under it. `**` as a whole segment matches zero or more segments. |
| `a/**/b` | `a/b`, `a/x/b`, `a/x/y/b` |
| `*.md`, `docs/?.md` | `*` matches any run of characters within one segment and `?` exactly one. Neither crosses a `/`. Dotfiles aren't special. |

Every other character is literal. A glob may not have a `.`, `..` or empty segment, or a leading or trailing `/`. It may not contain `[`, `]`, `{`, `}`, `!`, a backslash or a control character. `**` must be a whole segment. These rules make each path have one spelling, and they stop another glob dialect from reading a different meaning into a key, such as `!` as negation.

### `commands.yaml`

**`workers.tools`** is the set of Pi built-in tools that factory worker nodes get: `read`, `grep`, `find`, `ls`, `edit`, `write` and `bash`. These are the only names allowed. Workers get no web tools (spec §10).

**`hermes.allow`** holds the commands Hermes may run, as **argv-exact rules** keyed by a rule id. **A command is allowed only if one rule matches its whole argv. Everything else is denied.** The Hermes `hapi-cmd-allow` hook (Plan 04) enforces this list, default-deny and fail-closed.

```yaml
hermes:
  allow:
    git-push-plan:
      command: [git, push, origin]               # the exact leading tokens
      args: ['^plan/[a-z0-9][a-z0-9-]*$']        # one pattern per positional argument
      flags: {}                                  # no flag at all
    git-log:
      command: [git, log]
      args: []
      rest: { pattern: '^...$', max: 20 }        # up to 20 more positionals (revisions, paths)
      flags:
        --oneline: {}                            # a flag without a value
        -n: { value: '^[1-9][0-9]{0,3}$' }       # a flag whose value is the next token
```

#### How a rule matches

`matchCommand(rules, argv)` in `src/policy/commands.ts` is the one definition. A rule matches argv when:

1. **argv starts with exactly `command`**, token for token. So anything before or between those tokens means the rule doesn't match. That covers git's global options (`git -c core.sshCommand=...`, `git -C dir`, `git --git-dir=...`), an environment assignment (`GIT_SSH_COMMAND=... git ...`) and a path to the binary (`/usr/bin/git`).
2. **Every later token is read left to right:**
   - **A token that starts with `-` is a flag.** It must be a key of `flags`, spelled exactly. `--flag=value`, `-n5` and bundled short flags such as `-abc` are unknown flags, and so is `--`. A flag with a `value` pattern takes the **next token** as its value, whatever it looks like (as git does), and that token must match. Flags may repeat, and may come before, between or after positionals.
   - **Any other token is a positional.** The first must match `args[0]`, the second `args[1]`, and so on. After those, up to `rest.max` more must each match `rest.pattern`. Without `rest`, no extra positional is allowed.
3. **Every pattern in `args` got a token.**

**A pattern must match the whole token.** The JavaScript form is `new RegExp("^(?:" + p + ")$", "su")`; the Python form is `re.fullmatch(p, token, re.DOTALL)`. So a top-level alternation can't match a prefix, and `$` never matches before a trailing newline. Patterns are written `^...$`, and the schema keeps them to the subset that JavaScript and Python read the same way:

- no `\d`, `\w`, `\s` or `\b` (or their capitals), no `\A`, `\Z`, `\z`, `\p`, `\k`, `\g` or `\c`, and no backreferences. Write explicit classes such as `[0-9]`;
- groups are only `(...)`, `(?:...)`, `(?=...)` and `(?!...)`. There's no lookbehind, no named group and no inline flag;
- the only escapes are `\n`, `\r`, `\t`, `\f`, `\v`, `\xHH`, `\uHHHH`, and a backslash before a non-alphanumeric character.

`loadPolicy` also compiles every pattern. One that doesn't compile is a `PolicyError` at its path, e.g. `/hermes/allow/git-log/flags/-n/value`.

**The result** is `{allowed, rule?, reason}`. `reason` starts with a stable code, then `: ` and the details. The first failing token decides the code:

| Code | Meaning |
|---|---|
| `match` | Allowed. `rule` is the rule that matched. |
| `empty-argv` | argv is empty |
| `no-rule` | No rule's `command` is a prefix of argv |
| `unknown-flag` | A flag that isn't in the rule's `flags` |
| `missing-value` | A flag that takes a value came last |
| `bad-value` | A flag's value doesn't match its pattern |
| `bad-arg` | A positional doesn't match its pattern |
| `extra-arg` | More positionals than `args` plus `rest.max` |
| `missing-arg` | Fewer positionals than `args` |

argv is allowed if **any** rule matches, whatever the order. When none does, the reason and `rule` come from the candidate whose `command` matched the most tokens, and the first one in file order on a tie. With no candidate, the code is `no-rule` and `rule` is absent. Rule ids start with a letter, so every implementation keeps them in file order. For example:

```text
git push origin plan/x:main  -> bad-arg: argument 1, "plan/x:main", does not match ^plan/[a-z0-9][a-z0-9-]*$ (rule git-push-plan)
git push origin plan/x --delete -> unknown-flag: "--delete" is not an allowed flag of rule git-push-plan
git push --force origin plan/x  -> no-rule: no rule's command is a prefix of the argv, which starts ["git","push","--force","origin"]
```

#### The rules

| Rule | Allows | Notes |
|---|---|---|
| `hapi-status` | `hapi status [<run-id>]` | A lowercase id; no flags |
| `hapi-workorder-validate` | `hapi workorder validate <file>` | One `.yaml` or `.yml` path inside the repo |
| `git-status` | `git status` | Nothing else |
| `git-diff` | `git diff` with `--stat`, `--name-only`, `--name-status`, `--cached`, `--no-color`, and up to 20 revisions or paths | So no `--output`, `--ext-diff`, `--textconv` or `--no-index` |
| `git-log` | `git log` with `--oneline`, `-n <1-9999>`, `--stat`, `--no-color`, and up to 20 revisions or paths | So no `--output`, `--ext-diff`, `--textconv`, `-p` or `--format` |
| `git-add` | `git add <path>...`, 1 to 101 repo paths | No flags, so no `-A` or `-f` |
| `git-commit` | `git commit` with `-m <message>` and `--trailer "Key: value"` | So no `--no-verify` (or `-n`), `--amend`, `-a`, `-c` or `-C` |
| `git-switch-plan` | `git switch -c plan/<slug>` | No start point and no flags |
| `git-push-plan` | `git push origin plan/<slug>` | One plan branch and no flags. So no refspec with `:` (`plan/x:main`), no `+` (force), and no `--force`, `--delete`, `--mirror`, `--all` or `-o` |

**Revisions and paths** (in `git-diff` and `git-log`) start with a letter, digit, `_` or `.`, so never `/`, `-` or `~`. They have no `..` segment, so they never point outside the repo, which would make `git diff` act as `--no-index` and read any file. They hold no `:`, `@`, `$`, `*`, `?`, `[`, `{` or quote. Ranges such as `main...plan/x` and `HEAD~1` are fine. **Repo paths** (in `git-add`) follow the same rules, without `~` and `^`. **A commit message** may hold newlines and tabs, but no other control character, `$` or backtick. **A branch** is `plan/` and a lowercase slug.

#### What the hook must do first (Plan 04)

`matchCommand` checks an argv. Hermes's terminal runs a command line through a shell, so **the `hapi-cmd-allow` hook must make sure the shell will run exactly the argv it checked**:

1. **Tokenize shell-aware**, with POSIX quoting rules (Python's `shlex` in POSIX mode with `punctuation_chars`, or an equivalent).
2. **Refuse any command that contains a shell operator** outside quotes: `;`, `&`, `&&`, `||`, `|`, `(`, `)`, a newline, a `#` that starts a word (a comment), or a redirection such as `<`, `>`, `>>`, `<<`, `<<<`, `<(` or `>(`.
3. **Refuse any expansion**: `$` (so `$VAR` and `$(...)`) or a backtick anywhere outside single quotes, including inside double quotes, where the shell still expands them; and, outside quotes, `*`, `?`, `[`, `{` or a leading `~`.
4. Only then **match the argv** with the same semantics as `matchCommand`, and deny on any error (fail-closed).

The patterns are a second line of defense: no positional pattern accepts `$`, a backtick, `*`, `?`, `[`, `{` or a leading `~`, and the commit-message patterns reject `$` and backticks.

#### Shared test vectors

`tests/fixtures/command-vectors.json` is a JSON list of `{argv, allowed, reason?}`, where `reason` is the expected code (`bad-arg`, `no-rule`, ...). Each vector is checked against the rules in `policy/commands.yaml`. **Both implementations run it:** the TypeScript tests in `tests/policy/commands.test.ts` now, and the Python tests of the `hapi-cmd-allow` hook in Plan 04. The two must agree on every vector. A test also checks that every rule is exercised by at least one allowed vector. When you change `commands.yaml` or the matching semantics, update the vectors in the same change.

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

A zone's allowlist is its own `hosts` **plus** the hosts of every tier it lists (`zoneHosts` in `src/policy/zones.ts` computes it; the egress generator uses it). Hosts are plain, lowercase domains with at least two labels: no scheme, port, path, wildcard or leading dot, and no IP addresses. The egress generator allows each domain and its subdomains, so `slack.com` also covers `wss-primary.slack.com`. It checks every host again before writing it, for a policy built in code ([generated configs](generated-configs.md#buildegresssquidconf)).

The schema enforces spec §10's tier entitlements: the `hermes` zone may list only T0–T2, the `archon` zone only T0–T1, and only the `research` zone may set `openWeb`.

**Forge hosts.** The `archon` zone has no route to a forge (spec §4.3). So the schema rejects a **forge host** in the `archon` zone's `hosts`, and in tiers `T0` and `T1`, which that zone reaches. A forge host is one of these domains or a subdomain of one: `github.com`, `githubusercontent.com`, `githubassets.com`, `ghcr.io`, `gitlab.com` and `bitbucket.org`. The stack is meant to stay forge-agnostic, so GitLab and Bitbucket count too. The list is defined once, as `forgeHost` in `policy-defs.schema.json`. The same check covers [overlay](#repo-overlays-factoryconfigyaml) and [work-order](#work-orders) `egress_extra` hosts, and `forgeDomain` in `src/policy/hosts.ts` reads the same pattern. The `hermes` zone may reach the forge.

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

**Every object in every schema sets `additionalProperties: false`, so an unknown or misspelled key is an error, never silently ignored.** The only exception is a map with free-form keys, such as `protected_paths` or the command rules. There, `propertyNames` checks each key and `additionalProperties` is a schema that checks each value. A unit test walks the schemas to check this. It flags any node with `properties` or `patternProperties` that isn't closed, and any node whose `type` is or includes `object` whose `additionalProperties` is neither `false` nor a schema.

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

An overlay has the five keys below. **Any other key is rejected.** Three of them change policy, and those may only tighten it, except for `egress_extra`. The other two, `default_risk` and `workflow`, are repo settings (spec §7). They don't loosen any policy, so the tighten-only rule doesn't apply to them.

| Key | What it may do |
|---|---|
| `protected_paths` | **Add** a glob, or **raise** a listed glob's modes (allow < ask < deny). An entry may name only some of the three modes. For a glob the base policy lists, the others keep their base value. A **new** glob may name only `ask` or `deny`; naming `allow` is rejected, because under [strictest-wins](#how-globs-combine) it can't change anything and so reads as a loosening attempt. Its unnamed modes are stored as `allow`, which adds no rule. A new glob that overlaps a protected one can tighten files under it but never loosen them. `null` asks to remove the glob, and that is **always rejected**. |
| `egress_extra` | **Add** hosts to the `archon` zone's allowlist. The rules are the same as for any host. A [**forge host**](#trusted_sourcesyaml) (`github.com`, `githubusercontent.com`, `githubassets.com`, `ghcr.io`, `gitlab.com`, `bitbucket.org`, or a subdomain of one) is rejected, because the Archon zone must never reach the forge (spec §4.3). |
| `budgets` | **Lower** any budget in `budgets.yaml`. Each value must be at most the base value. |
| `default_risk` | The risk new work orders for this repo start from: `low`, `medium` or `high`. A repo setting, not policy: any value is accepted, `low` included. |
| `workflow` | The Archon workflow this repo's work orders use by default. A lowercase slug, the same rule as a work order's `workflow` (so `factory-task`, not `Factory_Task` or `factory-`). A repo setting, not policy. |

The overlay is checked in two stages:
1. **`loadOverlay(file)`** checks the file against `repo-overlay.schema.json`. That catches unknown keys, bad modes, globs outside the [glob syntax](#glob-syntax) and malformed hosts, and throws a `PolicyError`.
2. **`applyOverlay(policy, overlay)`** compares the overlay with the base policy. It throws a `PolicyLoosenError` at the **first** change that would loosen policy. The error's `path` is a JSON Pointer into the overlay, and its message names the path or glob as written. **A loosening change is never merged silently.** `applyOverlay` returns a new policy that shares no objects with either input, so changing the result never changes the base policy. It also re-runs the schema check, so an overlay built in code gets the same checks as one read from a file.

`default_risk` and `workflow` are copied to the result's **`repo`** field, `{ default_risk?, workflow? }`, which Plan 03 reads. `repo` is set only when the overlay names one of them; `loadPolicy` never sets it.

### An accepted overlay

```yaml
# .factory/config.yaml
protected_paths:
  "src/secrets/**": { interactive: deny, unattended: deny, workers: deny }   # a new path
  "AGENTS.md": { interactive: deny }      # ask -> deny is tighter; unattended and workers stay deny
egress_extra: ["odoo.internal"]           # the private Odoo sidecar the smoke check needs
budgets:
  run_usd: 2.00                           # lower than the base's 3.00
default_risk: medium                      # repo settings (spec §7), not policy:
workflow: factory-task                    #   exposed as applyOverlay(...).repo
```

The result has `src/secrets/**` and `AGENTS.md` denied in every mode, and `odoo.internal` in the archon zone's hosts. Its `budgets.run_usd` is 2, and its `repo` is `{ default_risk: medium, workflow: factory-task }`. This file is `tests/fixtures/overlay-tighten.yaml`.

A new glob may also overlap a protected one. `".github/workflows/**": { interactive: deny }` is accepted: the workflow files become denied in every mode, and the rest of `.github/**` stays `{ask, deny, deny}`.

### Rejected overlays

These are the real error messages:

| Overlay | Error |
|---|---|
| `protected_paths: { "AGENTS.md": { interactive: allow } }` | `PolicyLoosenError: /protected_paths/AGENTS.md/interactive: loosens "AGENTS.md" interactive from ask to allow; overlays may only tighten policy` |
| `protected_paths: { ".github/**": null }` | `PolicyLoosenError: /protected_paths/.github~1**: removes protected path ".github/**"; overlays may only tighten policy` |
| `protected_paths: { ".github/workflows/**": { interactive: allow, unattended: allow, workers: allow } }` | `PolicyLoosenError: /protected_paths/.github~1workflows~1**/interactive: ".github/workflows/**" is a new glob, where allow can't loosen anything (a file's mode is the strictest across every glob that matches it); name only ask or deny; overlays may only tighten policy` |
| `protected_paths: { "./AGENTS.md": { workers: deny } }` | `PolicyError: .factory/config.yaml: /protected_paths/.~1AGENTS.md: invalid key`. Write `AGENTS.md`: each path has one spelling. |
| `egress_extra: ["github.com"]` | `PolicyLoosenError: /egress_extra/0: "github.com" is a forge host (github.com); the archon zone has no forge route (spec §4.3); overlays may only tighten policy` |
| `egress_extra: ["registry.gitlab.com"]` | `PolicyLoosenError: /egress_extra/0: "registry.gitlab.com" is a forge host (gitlab.com); the archon zone has no forge route (spec §4.3); overlays may only tighten policy` |
| `default_risk: extreme` | `PolicyError: .factory/config.yaml: /default_risk: must be one of: low, medium, high` |
| `workflow: Factory_Task` | `PolicyError: .factory/config.yaml: /workflow: must match pattern "^[a-z0-9]+(?:-[a-z0-9]+)*$"` |
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
| `egress_extra` | A list of hosts (it may be empty), with the same host rules as policy. The hosts join the archon zone for the run (spec §10), so a [forge host](#trusted_sourcesyaml) is rejected, e.g. `/egress_extra/1: "api.github.com" is a forge host (github.com); the archon zone has no forge route (spec §4.3)`. That is the same list an overlay's `egress_extra` is checked against. |
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
| `applyOverlay(p, o): Policy` | `src/policy/overlay.ts` | Tighten-only merge. Throws `PolicyLoosenError { path, message }`. The result's `repo` holds the overlay's `default_risk` and `workflow`. |
| `matchCommand(rules, argv): {allowed, rule?, reason}` | `src/policy/commands.ts` | Whether `commands.yaml`'s `hermes.allow` rules allow an argv ([how a rule matches](#how-a-rule-matches)) |
| `commandRuleIssues(rules): Issue[]` | `src/policy/commands.ts` | The command patterns that don't compile. `loadPolicy` runs it. |
| `forgeDomain(host): string \| undefined` | `src/policy/hosts.ts` | The forge domain a host belongs to, e.g. `raw.githubusercontent.com` → `githubusercontent.com`. Case is ignored, as Squid ignores it, so `GitHub.com` → `github.com`. `FORGE_DOMAINS` lists them. |
| `isHostname(host): boolean` | `src/policy/hosts.ts` | Whether a host is a plain, lowercase domain name: the schema's `hostname` pattern. The egress generator checks every host with it before writing `squid.conf`. |
| `effectiveModes(p, path): PathModes` | `src/policy/paths.ts` | A file's modes: the strictest across every matching glob ([how globs combine](#how-globs-combine)). Every guard and generator uses it, or the same rule. Throws on a path outside the repo, or one with NUL, a control character or a backslash. |
| `globMatches(glob, path): boolean` | `src/policy/paths.ts` | Whether one glob matches an already-normalized repo path |
| `zoneHosts(p, zone): string[]` | `src/policy/zones.ts` | A zone's allowlist: its own hosts plus its tiers' hosts, sorted and de-duplicated. A zone with `openWeb` also reaches any public host, which this list doesn't say. |
| `validateWorkOrder(obj): WorkOrder` | `src/workorder/validate.ts` | Validates a parsed work order. Throws `WorkOrderError { path, message, issues }`. |
| `loadWorkOrder(file): WorkOrder` | `src/workorder/validate.ts` | Reads, parses and validates a work-order file |

The types (`Policy`, `Mode`, `Tier`, `Roster`, `ZoneName` and the rest) are in `src/policy/types.ts`, with `ROLES`, the list of every role that the `Role` type comes from; `WorkOrder` is in `src/workorder/validate.ts`. Schema compilation and error formatting are in `src/policy/schema.ts`.
