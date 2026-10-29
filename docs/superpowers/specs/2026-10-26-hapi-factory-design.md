# hapi-factory — design

- **Date:** 2026-10-26
- **Status:** draft for review
- **Owner:** the operator
- **Repo:** this repository (`factor`) becomes `hapi-factory`. Its name is my assumption: this is where the design was written.
- **Evidence base:** a recon report and research notes, kept private; [docs/research/README.md](../../research/README.md) lists them and the conclusions this spec adopted. All facts are as of 2026-10-26.

Tags used throughout:
- **[user]** — decided by the operator in the brainstorm.
- **[call]** — the designer's call. Open to override; the builder may refine within the stated intent.
- **[verify]** — a fact or behavior the builder must confirm early, usually with a throwaway spike, before depending on it.

---

## 1. Intent

hapi-factory is a **public, best-practices reference stack** for an end-to-end agentic software factory. **HAPi** stands for **H**ermes + **A**rchon + **Pi** [user]. It composes existing tools into one working system, covering the layer most factories skip: discovery research, architecture, threat modeling and breaking work into tasks. It shows how to do that with good productivity, portability, observability and security [user].

### Why

- The operator's earlier home-rolled kit worked, but it became a maintenance job [user]:
  - keeping up with new models and upstream changes;
  - context ballooning;
  - being tied to one harness.
- The kit was **copied into each repo** that used it. Every upgrade turned into a loop: upgrade in a repo → find problems → file upstream → re-ingest into every downstream repo → repeat [user].
- The operator wants to be less hands-on: in the loop for intent and review, not for babysitting [user].
- It doubles as learning and a showcase: security is designed in from the start, not bolted on, following SANS SEC545 (securing AI systems) [user].

### Success

- **v1** is a **net-new, minimal MCP server**, taken from a Hermes conversation through research, architecture, threat model and work orders to merged PRs through the full stack. **Its subject is uncommitted:** picking it with Hermes is the conversation's first step, so it is part of what v1 tests (§15; H-177) [user].
  - The operator chose net-new over their existing mtg repo [user]. That repo already carries so much context and old-kit instructions that "drop this into other repos" would become a rabbit hole before the core loop works.
  - The designer first chose Odoo (CRM and finance) and set a v1 scope for it [call]. On 2026-10-27 the operator reopened the subject: a dead-simple energy and weather data server is the other candidate so far, and the brainstorm decides [user].
  - Section 15 gives the definition of done.
- **Phase 2** is the existing mtg MCP server [user]. Retire the old kit, have Hermes triage its open issues, then do one full run-through as a bundled PR (or a single PR if one issue merits it).
- **Longer term**, other people can stand the stack up with mise, point it at their own repos, and learn from how it's composed [user].

---

## 2. Goals, non-goals, anti-goals

### Goals

1. **Layered roles** [user]:
   - Hermes coordinates: intake, brainstorming, research, planning, context-file upkeep.
   - Archon moves runs through stages.
   - Pi implements.
   - Decision support (gates, independent review, evals) sits where the implementer can't reach it.
2. **Low upkeep** [user]:
   - One central engine, outside target repos, updated in one place.
   - Target repos carry only a small contract (§7).
3. **Model-portable and harness-portable** [user]:
   - Swapping the models for a role is a config change.
   - The work order is harness-neutral, so Claude Code can become a worker later without redesign.
4. **Security by design** [user]: defense in depth, zero trust wherever possible, standards and practices enforced by the pipeline itself (§11).
5. **Mostly hands-off** [user]: the operator approves at two points per feature (§5) and is otherwise pulled in only when a run gets stuck or crosses a threshold.
6. **Measured** [user]: lightweight numbers on every run, configurable by flags (§13).
7. **One dependency to start**: mise [user], plus a container runtime, which the security baseline requires [call].

### Non-goals for v1 [call, unless marked]

- **GitLab support.** GitHub comes first, but the design stays forge-agnostic and documents the GitLab lift (§16) [user].
- **The Claude Code worker lane and the direct Hermes → Pi lane.** The work-order contract is designed for both. They're built in phase 4 [user, for "later"].
- **Onboarding existing repos.** Existing-repo onboarding and a general `onboard` tool come later [user]. v1 creates the new repo from the contract template. mtg is onboarded by hand in phase 2, and only then is a general tool extracted.
- **The showcase beyond the minimal v1 scope**, such as write tools (for Odoo, finance mutations). Those come later.
- **Team or multi-user operation**, hosted SaaS, or Windows/macOS support.
- **Archon's bundled SDLC pack and its merge queue.** We write a few small workflows of our own and let GitHub's branch rules do the merging (§9.2).
- **Parallel runs across one repo.** Runs queue per repo.
- **Security-research providers.** Connecting **abliteration.ai** for security-research work is planned downstream [user, heads-up]. It's not in v1. When added, it needs:
  - its own Hermes profile and roster;
  - its own capped key and Console-style workspace;
  - its own data-boundary review (terms and retention checked first).

  It's never available to the default factory rosters, its outputs are treated as untrusted, and its content stays out of public repos unless sanitized.
- **Depending on TypeSafe Jev.** Jev *is* used in v1 as a best-effort decision signal (§9.5) [user]. But the factory must work fully with `jev.enabled: false`, and Jev is never a security control.

### Anti-goals: failure even if it technically works [user]

| Anti-goal | How it's measured on every run (§13) |
|---|---|
| Poor output | Merged without changes? Number of review rounds, and rejected PRs |
| Poor token efficiency | Cost and tokens per merged PR, per role |
| Worse controls than today | A baseline security checklist (§11.8) passes in CI and in an audit task |
| More mucking around | Human interventions per run; time spent per upgrade |

---

## 3. Constraints

- **Models and money**
  - **The budget is a fixed monthly API credit, $200 in the reference setup** [user; verified]. Some Claude subscriptions include a monthly credit for the Anthropic Console API, and the reference setup funds its Console key from one. Such a credit refreshes each cycle, doesn't roll over and **does not cover Claude Code**, so the factory's spend and the operator's own interactive Claude Code use are separate budgets, and cost per run matters.
  - Subscription OAuth is never used in Hermes, Pi or Archon [call; Anthropic terms].
  - A cheap provider (via OpenRouter) is used for end-to-end testing once the base works [user].
  - **The credit is the hard ceiling for now** [user]: an exhausted credit stops requests, so the caps below keep the factory inside it.
  - Workspace limits split it [call; adjust in `budgets.yaml`]:
    - `hapi-hermes` $60
    - `hapi-factory` $100
    - `hapi-evals` $40
  - **OpenRouter key cap:** $20 a month, daily-reset limits per key [call]. Pending the provider-subscription decision (§12).
  - **Jev:** its own OpenRouter key capped at $2 a month [call].
- **Platform**
  - Linux. This machine first, then a VM soon after [user].
  - The remote path is first-class: a fresh VM goes from install mise, to clone, to `mise run up` [user].
- **Forge:** GitHub first [user]. All forge calls go through one interface, so a GitLab adapter can be added later (§16) [call].
- **Versions** move fast. Hermes ships about 3,000 commits a week, Pi several releases a week, and Archon breaks compatibility in most minor releases. **Pin every tool and upgrade on purpose, behind evals** [call].
- **Pi version.** Archon v0.12.1 embeds **Pi SDK 1.3.0**. Pin the standalone Pi CLI to match, or test the skew [verify].

---

## 4. Architecture

### 4.1 Roles

| Layer | Component | Owns | Never does |
|---|---|---|---|
| Coordinator | Hermes Agent (pinned stable, v0.22.x) | Conversation, brainstorming, discovery research, architecture and threat-model drafts, work orders, context-file upkeep, research freshness, status reporting | Holds merge rights. Holds factory-run credentials. Answers factory approvals. Merges. |
| Run engine | Archon (pinned v0.12.x), small custom workflows | Run state (the single owner), stage order, gates, fan-out decisions, retries, per-run worktrees, cost records | Pushes to the forge or opens PRs (the harvester does, §9.4) |
| Worker | Pi, embedded in Archon via its SDK | Edits inside one worktree, within one bounded step | Web access, secrets, edits to protected paths |
| Decision support | Code gates (mise tasks), a separate reviewer, CI required checks, evals, human merge. **Signals:** Jev typed decisions (§9.5) and CodeRabbit PR reviews (§9.6). | Acceptance; routing and depth decisions | Trusting the worker's own claims; letting a signal grant permission |
| Record | GitHub plus repo files | Durable history: PRs, labels, commits with trailers, work orders, research, designs | — |

### 4.2 Flow

```
You ── chat / TUI ──► HERMES  (container, user `hapi`)
 │                     ├─ research role (web only) ─► docs/research/*.md
 │                     └─ planning skill ─► branch plan/<feature> ─► planning PR (lane:planning)
 │◄── review + merge ── GitHub ◄─┘
 │                         │ merge to main adds .factory/work/<id>/
 │                         ▼
 │                  host poller ─► `archon trigger fire` (no inbound endpoint)
 │                         ▼
 │                  ARCHON  (container)  workflow: factory-task (one run per work order)
 │                     ├─ prepare: load work order, strip .pi/ and .agents/, decide one-step vs fan-out
 │                     ├─ implement: Pi (+ hapi-guard), model tier from roster
 │                     ├─ gates: mise run check | smoke | scan  (+ scope check)
 │                     ├─ review: independent session, different model
 │                     └─ commit with trailers ─► local mirror ref refs/hapi/<run-id>
 │                         ▼
 │                  host harvester ─► push factory/<id>, open PR (lane:factory)
 └──── review + merge ── GitHub (ruleset: your approval + required checks)
```

### 4.3 Trust zones [call]

| Zone | Runs as | Has | Lacks |
|---|---|---|---|
| Host admin | The operator | Org/repo admin, kill switches, key management | — |
| `hapi` host user | Dedicated Linux user running rootless containers, the poller and the harvester | GitHub App private keys (to mint short-lived tokens), container control | Your personal credentials and sessions |
| Hermes container | `hapi` | A capped Anthropic key (Hermes workspace), search API key, chat gateway token, a 1-hour `hapi-planner` GitHub token minted per session | Merge rights, Archon or Pi keys, write access to protected branches |
| Archon container | `hapi` | Capped model keys (factory workspace), read-only local git mirror, run DB | **Any forge write credential.** No egress to the forge. |
| o11y (optional) | A separate Unix user | Collector and trace store | Anything the agents can write to or delete |

Two facts drive this layout:
1. Archon approvals can be answered by any local process, including a Pi step via `ARCHON_CLI_COMMAND`.
2. Pi runs in-process with Archon.

So **nothing inside the Archon container is a human-approval boundary**. The boundary is GitHub's ruleset plus the operator's review, and the Archon zone has no forge write credentials at all.

### 4.4 Many repos, trust domains [user asked; call]

**Segment by trust domain, not by repo.**
- **Inside one trust domain:** one Hermes profile (its own config, `.env`, memory, sessions, skills, cron and state DB) and one Archon instance serve many repos, through registered codebases, per-repo worktrees and the shared home-scoped workflow pack. Per-repo isolation within a domain:
  - a work order names exactly **one** repo;
  - GitHub tokens are minted for that repo only;
  - each repo has its own overlay and egress;
  - each repo has its own run queue (resource `github:<owner>/<repo>:factory`).
- **A new trust domain** gets its own Hermes profile, Archon container and zone, model workspace and spend cap, and Slack channel. Examples: the downstream abliteration.ai security work, or any client or private code. This stops memory and skill bleed between domains: a poisoned memory in one domain can't steer another.
- **No run ever spans two repos.** A cross-repo feature is one work order per repo, coordinated by Hermes.
- **v1 has one domain** ("oss": hapi-factory, the v1 showcase repo, later mtg).

---

## 5. Lanes, approvals and commits

### 5.1 Lanes [user]

Lanes are routed by **PR labels**. The **work-order file** says what to build.

| Label | Who works | Used for |
|---|---|---|
| `lane:planning` | Hermes only | Research, designs, threat models, work orders, context files, doc-only tweaks |
| `lane:factory` | Archon + Pi | Building a merged work order |
| `lane:direct` | The operator, hands-on in Pi (later Claude Code; later still, Hermes driving Pi for one-off work) | Work they want to drive themselves |

All lanes share:
- the same CI gates;
- the operator's approval at merge;
- commit trailers recording the lane (§13.2).

Git tags are only for releasing and pinning hapi-factory itself.

### 5.2 Approval points [user]

1. **Merging the planning PR** is design approval. It replaces "Yes, approve" in plan mode.
2. **Merging the delivery PR** is acceptance.

Nothing else blocks unless a threshold is crossed or a run fails.

Review comments or "request changes" on a planning PR go back to Hermes, which revises the branch [call]:
- The **host poller** picks the comments up. There's no inbound webhook, so a home machine needs no public endpoint.
- It queues them and sends the operator a chat alert.
- Hermes revises in an **interactive** session when the operator says go. That respects §8.2, where unattended sessions can't touch `.factory/**`, and keeps PR comment text from strangers on a public repo out of any unattended, write-capable route.
- Only comments from maintainers are queued.

A **lightweight lane** exists for tiny changes: a `lane:planning` doc-only PR with no design doc [call].

**Rework on delivery PRs** [user chose the label option]:
- The operator requests changes and adds `hapi:rework`. Adding labels needs at least triage permission, so it's a trusted human act.
- The poller starts a **follow-up run on the same `factory/<id>` branch**. Inputs:
  - the unchanged work order;
  - **review comments from maintainers only** (untrusted text, passed as data to the planning step of the run, never as instructions to tools).
- Rounds are sequential. Each round's run id is recorded on the PR. The `review_rounds` threshold flags the PR when exceeded.
- So runs start from **a merge or a maintainer's rework label**. Nothing else starts one.
- A work order still maps to exactly one delivery PR.

### 5.3 One plan, one run, one PR [user]

- A planning PR can carry several work orders. **Each work order produces exactly one Archon run and one delivery PR.**
- Several runs from one plan is ruled out as a trap [user]. Related small changes are **bundled** into one work order [user]. Independent pieces of real size become separate work orders (Hermes splits them during planning).
- Inside a run, each step starts with a fresh context and passes its own gates. Each piece produces its own commit, so the PR can be reviewed one commit at a time.
- A failed run **resumes** from the failed step [verified: Archon resume replays completed nodes].

### 5.4 Fan-out inside a run [call]

- **Hermes proposes** the pieces in the work order: each piece's files and a rough size.
- **Archon decides in code.** The `prepare` step reads `pieces` and applies policy thresholds, for example: fan out only if there are 2 or more pieces, each `size` is `medium` or larger, and the file scopes are disjoint. Otherwise it runs one implement step.
- Fan-out children share the run's checkout. Children of one `fan_out` node are allowed to [verified].
- After implementing, a **scope check** fails the run if any piece touched files outside its declared scope.
- Rationale: each child is a full agent session with its own setup cost. Anthropic's measurements show splitting only pays for large routine work or work bigger than one context window. Three one-line edits in three files is **one step** [user example].

### 5.5 Branches over a feature [call]

1. Hermes creates `plan/<feature>` in its own clone at the start of a feature. As research and planning progress, it commits research notes, the design doc, the threat model and work orders. Durable mid-conversation; each commit is a replayable snapshot.
2. Hermes opens the planning PR, labeled `lane:planning`. CODEOWNERS routes it to the operator.
3. Merging it puts `.factory/work/<id>/` on `main`.
4. The host poller finds work orders on `main` with no run yet and fires the trigger.
5. Archon works in its own worktree, cut from the merge commit (`isolation: worktree`), and commits to a local ref.
6. The harvester pushes `factory/<id>` and opens the delivery PR, labeled `lane:factory`.

No long-lived feature branches. A feature that must land all at once goes behind a feature flag.

---

## 6. The work order

Hermes writes work orders on the planning branch. They are immutable once merged: a new attempt is a new work order or a re-run of the same id at a new commit. Suggested schema [call; the builder finalizes it as a JSON Schema in `policy/schemas/`]:

```
.factory/work/0002-search-partners-tool/
  task.md        # goal, context, acceptance criteria, out-of-scope, links to research/design
  order.yaml     # machine-readable contract (below)
```

Illustrative. Real paths come from the repo the template creates.

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
egress_extra: []                    # public hosts the run needs beyond its zone's (none here: see the rules)
trace:
  traceparent: "00-<trace-id>-<span-id>-01"     # minted by a script when the order is created
sources: ["docs/research/odoo-external-api.md", "docs/design/odoo-mcp.md"]
```

Rules:
- `egress_extra` adds **public hosts only**. Every allowlisted zone's proxy refuses private addresses (`to_localnet`, before its allowlist) and allows only HTTPS to port 443, so a private smoke sidecar, such as an Odoo container on the zone's network, is never reached through it. The smoke check reaches the sidecar directly on the zone's internal network, with its name in the run's `NO_PROXY`. Never loosen `to_localnet` for it (H-192).
- `traceparent` and `id` are written by **deterministic code**, Hermes's `dispatch`/`new-work-order` tool, never by the model.
- The schema check runs:
  - in Hermes before the planning PR is opened;
  - in CI on the planning PR;
  - in Archon's `prepare` step.
- A frozen work order, the repo at that commit and its expected outcome make up an **eval case** (§14).

---

## 7. The per-repo contract

A target repo needs only these files [user: central engine, small contract]:

| File | Purpose |
|---|---|
| `AGENTS.md` | Short, always-loaded must-know rules: how to build and test, forbidden actions. One file, and **no `CLAUDE.md`**, so Claude Code reads it natively later. |
| `mise.toml` | Standard tasks the gates call: `setup`, `test`, `lint`, `check` (all three), plus optional `smoke` and `scan`. Also one-click setup for new humans [user]. |
| `.factory/config.yaml` | The repo's overlay on the central policy: extra protected paths, extra egress hosts, default risk, workflow choice |
| `.factory/work/<id>/` | Work orders (§6) |
| `docs/research/`, `docs/design/` | Hermes's dated research notes, designs and threat models |
| `.github/workflows/hapi-gates.yml` | A thin wrapper calling hapi-factory's **reusable workflow, pinned by tag**: runs `mise run check` and the secret, SAST and dependency scans, validates work-order schemas, enforces commit trailers |
| `.github/CODEOWNERS` | The operator owns every protected path (§8.2): the agent instruction files at any depth, `.factory/**`, `.github/**`, `mise.toml` and every other mise config file, `.coderabbit.yaml`, `.gitleaks.toml` |
| Ruleset (forge setting, not a file) | `main` protected; one approving review required, and the PR author can't approve; required checks; no bypass for the Apps |

**New repos (v1):** `mise run new-repo -- <name>`, run by the operator with their own credentials, creates the repo from `templates/repo-contract/` [call]. That template holds:
- `AGENTS.md`, `mise.toml` tasks, `.factory/config.yaml`, CODEOWNERS, the CI wrapper;
- the ruleset, applied by API;
- installation of both GitHub Apps on the repo.

Agents never create repos.

**Existing repos:** onboarded by hand in phase 2, starting with mtg, through a Hermes `lane:planning` PR. A general `mise run onboard` tool is extracted only afterwards [user: avoid the rabbit hole].

`mise` tasks in target repos are repo-controlled code. The factory only runs them **inside the Archon container** [call].

The onboarding PR must also **remove or harden any CI workflow that runs an AI agent with secrets on PR, issue or comment triggers**. That's §11.7, and the 2026 "Comment and Control" incident class. `mise run audit` fails until that's done [call].

---

## 8. Policy as config

### 8.1 One policy, many enforcement points [user wants first-class guardrails through config; design is the designer's]

`policy/` in hapi-factory is the single source of truth. Each repo's `.factory/config.yaml` may only **tighten** it, except for `egress_extra`, which needs a reviewed planning PR. A generator, run as `mise run policy:build` [user: mise for generator work], writes each tool's native config:

| Policy file | Compiled into |
|---|---|
| `protected_paths.yaml` | Hermes `security.protected_instruction_files`, the hapi-path-guard plugin and a command allowlist; Pi hapi-guard; later, Claude Code permission rules; CI path checks |
| `commands.yaml` | Hermes `hapi-cmd-allow` hook (default-deny, fail-closed); Archon `allowed_tools` per node |
| `trusted_sources.yaml` (§10) | The egress proxy allowlist (the real boundary), Hermes's web backend pins and blocklist, Anthropic `allowed_domains` |
| `budgets.yaml` | Hermes `max_turns`; Archon `budget` on per-task children; hapi-guard limits; provider key limits (documented, applied by hand or API) |
| `approvals.yaml` | Which actions need the operator. Fixed short list: merge, new dependencies, new skills or MCP servers, CI workflow changes, outbound messages, spend above threshold |
| `roles.yaml` + `rosters/*.yaml` | Archon tiers and aliases; Hermes model, auxiliary and delegation settings (§12) |
| `flags.yaml` | Metrics and observability switches and thresholds (§13) |

### 8.2 Protected paths, per mode [user]

```yaml
protected_paths:
  "**/AGENTS.md":       { interactive: ask, unattended: deny, workers: deny }
  "**/AGENTS.override.md": { interactive: ask, unattended: deny, workers: deny }
  "**/AGENT.md":        { interactive: ask, unattended: deny, workers: deny }
  "**/CLAUDE.md":       { interactive: ask, unattended: deny, workers: deny }
  "**/CLAUDE.local.md": { interactive: ask, unattended: deny, workers: deny }
  "**/GEMINI.md":       { interactive: ask, unattended: deny, workers: deny }
  "**/HERMES.md":       { interactive: ask, unattended: deny, workers: deny }
  "**/.hermes.md":      { interactive: ask, unattended: deny, workers: deny }
  "**/SOUL.md":         { interactive: ask, unattended: deny, workers: deny }
  "**/REVIEW.md":       { interactive: ask, unattended: deny, workers: deny }
  "**/.cursorrules":    { interactive: ask, unattended: deny, workers: deny }
  "**/.windsurfrules":  { interactive: ask, unattended: deny, workers: deny }
  "**/.claude/**":      { interactive: ask, unattended: deny, workers: deny }
  "**/.hermes/**":      { interactive: ask, unattended: deny, workers: deny }
  "**/.cursor/**":      { interactive: ask, unattended: deny, workers: deny }
  "**/.clinerules/**":  { interactive: ask, unattended: deny, workers: deny }
  "**/.rules/**":       { interactive: ask, unattended: deny, workers: deny }
  ".factory/**": { interactive: ask, unattended: deny, workers: deny }
  ".github/**":  { interactive: ask, unattended: deny, workers: deny }
  "mise.toml":   { interactive: ask, unattended: deny, workers: deny }
  "**/.mise.toml":          { interactive: ask, unattended: deny, workers: deny }
  "**/mise.local.toml":     { interactive: ask, unattended: deny, workers: deny }
  "**/.mise.local.toml":    { interactive: ask, unattended: deny, workers: deny }
  "**/mise.*.toml":         { interactive: ask, unattended: deny, workers: deny }
  "**/.mise.*.toml":        { interactive: ask, unattended: deny, workers: deny }
  "**/mise/**":             { interactive: ask, unattended: deny, workers: deny }
  "**/.mise/**":            { interactive: ask, unattended: deny, workers: deny }
  "**/.config/mise.toml":   { interactive: ask, unattended: deny, workers: deny }
  "**/.config/mise.*.toml": { interactive: ask, unattended: deny, workers: deny }
  "**/.config/mise/**":     { interactive: ask, unattended: deny, workers: deny }
  "**/mise-tasks/**":       { interactive: ask, unattended: deny, workers: deny }
  "**/.mise-tasks/**":      { interactive: ask, unattended: deny, workers: deny }
  "**/.tool-versions":      { interactive: ask, unattended: deny, workers: deny }
  ".pi/**":      { interactive: deny, unattended: deny, workers: deny }
  ".agents/**":  { interactive: ask, unattended: deny, workers: deny }
  ".archon/**":  { interactive: deny, unattended: deny, workers: deny }
  ".coderabbit.yaml":      { interactive: ask, unattended: deny, workers: deny }
  ".coderabbit.yml":       { interactive: ask, unattended: deny, workers: deny }
  ".coderabbit.config.ts": { interactive: ask, unattended: deny, workers: deny }
  "**/.git/**": { interactive: deny, unattended: deny, workers: deny }
  "**/.gitleaks.toml":  { interactive: ask, unattended: deny, workers: deny }
  "**/.gitleaksignore": { interactive: ask, unattended: deny, workers: deny }
```

- **interactive** means the operator is in a Hermes session (or later a direct-lane Pi session).
  - `ask` puts the diff in front of them to approve.
  - Hermes's built-in protected-instruction gate already asks on `AGENTS.md`.
  - hapi-path-guard extends it to globs.
- **unattended** covers Hermes cron, webhook and API surfaces. Always deny.
- **workers** covers Pi or Claude Code inside Archon. Always deny.
- **Agent instruction files at any depth** (added 2026-10-27, the operator's ruling; it replaced the root-only `AGENTS.md`): Pi, Hermes, the later Claude Code lane and CodeRabbit read nested `AGENTS.md`, `CLAUDE.md` and the rest as instructions for that subtree, so a write persists into every later session there. Matching ignores case (Pi also loads `AGENTS.MD` and `CLAUDE.MD`, Hermes's own gate ignores case, and on a case-insensitive filesystem `Agents.md` is `AGENTS.md`). Workers read them and never need to write one: a work order that needs one says so in its PR, and the operator adds it.
- **`.coderabbit.*`** (added 2026-10-27, the operator's ruling): CodeRabbit reviews a same-repo PR with that PR branch's own config, so a PR that edits it could weaken its own review (§9.6).
- **Every mise config file at any depth** (added 2026-10-28, in Plan 01's final review), with `mise.toml`'s modes: mise loads each over `mise.toml` (`mise config ls`), so a `.mise.toml` could redefine the `test` task the gates run. hapi-factory's own CI fails on any of them, and the in-run gates will too.
- **git's own files at any depth** (`**/.git/**`, deny everywhere; added the same day): git runs the commands `.git/config` names (`core.fsmonitor`, `diff.external`, `credential.helper`) from the git argv Hermes's rules allow, and a linked worktree's `.git` file names the git dir git uses. No agent edits them directly.
- **gitleaks's `.gitleaks.toml` and `.gitleaksignore`** (added the same day): either could turn a repo's secret scan off. hapi-factory's own scans name their config, and its CI refuses a `.gitleaksignore`.
- **Backstop:** CODEOWNERS plus the ruleset. A guard failing locally can't land a change.

---

## 9. Components

### 9.1 Hermes (coordinator)

**Install:** pinned stable tag, whole process in a container (Hermes ships Docker and Compose), run as `hapi`. Install through mise if feasible, otherwise mise wraps the official installer [verify].

**Defaults to flip on day one** [call; from report §Hermes]:

| Setting | Value |
|---|---|
| `skills.write_approval`, `memory.write_approval` | `true` |
| `skills.guard_agent_created` | `true` (a scanner, not a boundary) |
| `security.protected_instruction_files` | on (default), extended by hapi-path-guard |
| `approvals.mode` | `manual`. `cron_mode`, `unattended_mode` and `single_query_mode` stay `deny`. **Yolo and `mode: off` are forbidden by policy, and a CI or audit check enforces it.** |
| `plugins.isolation` | `host` |
| `auth.adopt_external_logins` | `false` |
| `web.keyless_fallback`, `web.keyless_rescue` | `false`; pin one search backend |
| `security.allow_lazy_installs` | `false` |
| `agent.max_turns` | 30–100 (default 500) |
| `auxiliary.*`, `delegation.model`, `cron.model` | Haiku 5.5 |
| `cache_ttl` | `auto` (opt-in) |
| `container_persistent` | `false` for sessions touching external input |
| Gateway | **Slack**, Socket Mode, so there's no inbound endpoint [user leaning; call]. Allowlist the operator's Slack user ID only. Collaborators are added later by ID. |

**Chat** [user leaning to Slack over Telegram, for collaborators; call on details]:
- A dedicated free Slack workspace or private channels:
  - `#hapi-intake` for talking to Hermes;
  - `#hapi-alerts` for poller, harvester and flag notices.
- Messages carry links and summaries, never code or secrets, since Slack is a third party.
- Signal stays possible later as a DM channel.
- The record of truth stays on GitHub.

**Coexistence:** an operator who already runs a personal Hermes (`~/.hermes`, as their own user, with their own `gh` credentials) keeps it for personal use. It's never pointed at hapi-managed repos. The hapi Hermes starts **fresh** in the `hapi` zone, with no imported memories or skills [call; confirm at review].

**Use (vetted)** [call; from `hermes_plugins.md`]:
- `hermes_otel`, pinned ≥ 1.31 for an inbound `HERMES_OTEL_TRACEPARENT`, with `content_capture` set to preview or off
- `advanced-delegation`
- core 1Password or Bitwarden secrets
- the official `bubblewrap` sandbox plugin
- `skill-integrity`
- `custom-dangerous-patterns`
- the bundled `grounded-citations` skill, extended with retrieval dates
- Hermes **native** web backends in the research zone: Brave (search) + Exa contents (extract), with keyless fallback off (§10.1)
- Archon's `archon-cli` skill, vendored and pinned, for status only (§9.2)

**Build** [call]:
1. **`hapi-path-guard`**, a Python plugin. Prompts on glob matches in interactive sessions and blocks in unattended ones (via `ctx.current_cron_execution()` and `ctx.session_surface()`); blocks under yolo. It must also cover shell writes, since the core gate misses them (#143266; seen in spike T9, docs/spikes/02-hermes-path-guard.md). Spike T9 also found that returning `approve` already gets the interactive/unattended split from Hermes's approval modes.
2. **`hapi-cmd-allow`**, a default-deny `pre_tool_call` shell hook with `fail_closed: true`.
3. **`hapi-planning` skill**: brainstorm → research brief → design and threat model → work orders → planning PR. It uses `new-work-order` (deterministic id and `traceparent`, schema validation).
4. **`hapi-research` profile**, quarantined in **its own container**: web tools only, no terminal, no repo write, no secrets except spend-capped, search-only keys (§10.1). It returns a schema-validated brief, and the **`hapi-research-note` skill** writes `docs/research/<topic>.md` with retrieval dates, source hashes and a `recheck_by` date.
5. **Freshness job**: a cron pre-run script that checks `recheck_by` dates and wakes the agent only when something is stale, so it costs nothing otherwise. It opens `lane:planning` update PRs.
6. **`hapi-status` tool**, fixed-argv: `archon workflow status/list/cancel/resume`.
   - `resume` re-drives a run that a merge already approved, with no new inputs. It's also available to the operator as `mise run factory:resume -- <run-id>` [call].
   - Hermes **cannot answer Archon approvals or start new factory runs** in v1. New runs start only from merges.
7. **`hapi-gh-token` helper**: mints a 1-hour `hapi-planner` GitHub App installation token scoped to one repo, outside the agent. Overrides the bundled skill's advice to use a classic PAT.

### 9.2 Archon (run engine)

**Install:** pinned release binary and provider executables, with checksums recorded by us. Runs in a container as `hapi`. Re-run `archon provider add` after each upgrade.

**Hardening** [call; verified options]:
- `HOST=127.0.0.1`
- `ARCHON_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`
- Web console only through an SSH tunnel or an authenticating proxy that strips and sets `X-Archon-User`
- Triggered runs execute as a `factory-bot` member user

**Workflows:** a small, tagged, home-scoped pack (`~/.archon/workflows/hapi/`, shipped from `archon/` in this repo) with a `compatibility.archon` range. CI runs `archon validate workflows --json`, **fails on parse warnings** (unknown keys are otherwise dropped silently), and runs `archon workflow test` stub fixtures.

`factory-task` steps [call; the builder writes the YAML. A documented-fields skeleton is in `archon_plugins_integration.md` §Q4]:

1. **`prepare`** (script)
   - Validate the work order.
   - Strip `.pi/` and `.agents/` from the worktree (restored before commit).
   - Decide one-step vs fan-out (§5.4).
   - Export `WORK_ORDER_ID` and `TRACEPARENT`.
2. **`implement`** (Pi)
   - Tier from the roster: Opus 5.5 at low effort.
   - On failure, one `implement-retry` at high effort. A sequence, **not** a `loop:`, so budgets stay usable.
   - `allowed_tools` from policy; extensions on, so hapi-guard loads (§9.3).
3. **`gates`** (bash, in parallel): `mise run check`, `mise run smoke` (if `verify.smoke`), `mise run scan`, scope check, protected-path diff check.
4. **`review`**: separate session, different model, read-only (`mutates_checkout: false`), with an output schema `{verdict, findings}`.
   - Default: the **Claude provider** on the Anthropic roster. It gets enforced schemas, a sandbox and `maxBudgetUsd`.
   - On the portable roster: Pi with a different model family.
   - The review is advisory. The operator's merge decides.
5. **`commit`** (script): commit per piece with trailers (§13.2), then update the local mirror ref `refs/hapi/<run-id>`.

**Budgets:** `budget: {max_spend_usd, max_work_units}` sits on `factory-task`, which has no loops. A dispatcher with `fan_out` can't carry a budget, so each child carries its own.

**Not used in v1:** the SDLC pack, the Archon merge queue, Archon approval nodes as security controls, the Slack plugin (optional later).

### 9.3 Pi (worker)

- **Pinned** to the version Archon embeds (1.3.0 for Archon 0.12.1) [verify skew].
- **Worker environment:**
  - `PI_OFFLINE=1`. Blocks the repo-settings package auto-install, which otherwise runs even with extensions off. **Critical.**
  - `PI_TELEMETRY=0`
  - A `PI_CODING_AGENT_DIR` whose `models.json` (with `maxTokens` around 64K) nothing in the container can change. Spike T8 found Pi must write its own cache and sessions there, so the directory is a tmpfs with hapi's files bound read-only into it (docs/spikes/01-pi-under-archon.md).
  - `hapi-guard` as the only user-level extension.
- **Repo `.pi/` can't be excluded under Archon today.** Pi trusts every project under the SDK, and Archon only toggles extensions all-on or all-off. So `prepare` strips `.pi/` and `.agents/`, and hapi-guard blocks writes to them.
  - Longer term: upstream an Archon PR to honor Pi's native project trust [call; good showcase contribution].
  - **[verify]:** the user-level extension loads with the repo dirs stripped, and `PI_OFFLINE=1` blocks the install path.
- **`hapi-guard`**, built in-house from Pi's official `protected-paths.ts` and `permission-gate.ts`, and the `pi-budget`/`pi-spend-guard` patterns. Sketch in `pi_extensions.md` §Q3.
  - `tool_call`: block protected paths, including `.pi/**`, `.agents/**`, `.archon/**` and `.factory/**`.
  - Budgets: sum `ctx.sessionManager.getEntries()` usage; hard-stop by throwing from a hook, which makes Archon fail the node.
  - `before_provider_request` and `cache_warming_decision`: clamp `max_tokens`, keep caching on.
  - Read `traceparent` and the work-order id from the work-order file. Archon's `extensionFlags` are literal and can't carry them.
  - Emit normalized events and optional OTel spans.
  - **Jev-backed level 6 gates**, layered after the deterministic rules: the bash gate, write gate (credentials) and result screen (§9.5). Behind `jev.enabled`.
- **Skip:** community subagent, sandbox and web packages. They either bypass the guard or are stale.

### 9.4 Host poller and harvester (ours) [call]

Small scripts run by `hapi` (systemd user timers, installed by `mise run up`):

- **Poller:** reads the forge via a read-only token or the public API. No inbound endpoint. It fires `archon trigger fire` for:
  - merged work orders on `main` with no run, one fire per work order (`--delivery-id <merge-sha>:<work-order-id>`: spike T10 found that a shared key starts only the first);
  - delivery PRs newly labeled `hapi:rework` by a maintainer, passing maintainer review comments as data (§5.2).

  It also queues maintainer comments on planning PRs for Hermes and posts alerts to `#hapi-alerts`.
- **Mirror:** keeps a local bare mirror the Archon container fetches from. Archon has no route to the forge.
- **Harvester:** watches for `refs/hapi/<run-id>`. With a 1-hour `hapi-factory` GitHub App token, it pushes `factory/<id>`, opens the PR from a template (work order, run link, cost, gate results, review findings), adds `lane:factory` and a `hapi:flagged` label if thresholds were crossed. It never merges.
- All forge calls go through one `forge` interface, so GitHub is one adapter (§16).

---

### 9.5 Decision signals: Jev [user: use it properly where useful, but the factory must work without it; call: placement]

**What Jev is.** TypeSafe's "System One" typed decision model: JSON in, decisions out.
- You send a `state` and typed questions:
  - `noul`: a yes/no probability;
  - `choice`: one of up to 255 declared options, each with a probability;
  - `score`: a position on 2–10 described levels.
- About 300 ms per call, a fraction of a cent.
- Access is via OpenRouter (`typesafe/jev-*`) or TypeSafe directly.
- **Reference implementation:** `disler/ten-levels-of-jev` (MIT, single commit, 2026-09-27). We reuse three things from it:
  - its **tested client and offline mock** (`apps/ten-levels/src/core/`: `client.ts`, `mock.ts`, `types.ts`), so decisions can be unit-tested and run in CI at zero cost;
  - its **ten question-design rules** (below);
  - its **`hyper-jev` skill**, vendored and pinned into `.agents/skills/`, so Hermes and Pi can build Jev integrations in target repos such as Odoo MCP.

**The ten rules we follow** (from ten-levels-of-jev, `apps/ten-levels/README.md`):
1. One snap judgment per question.
2. Fan out: ask every question you might need in one call.
3. Numbers, dates and counting stay in code.
4. Confidence is a second axis: a **floor** (below it, a human decides) and a **bar** (above it, auto-act).
5. Always give an `other` exit.
6. Describe situations, not degrees.
7. **Questions and thresholds live together in one reviewable file per decision.**
8. Isolate the state; send only what the question needs.
9. Use a second request only for real dependencies.
10. Prune choice lists in code before hitting the 255 cap.

**Contract** [call]:
- Every decision is a file in `policy/decisions/<name>.ts`, holding its questions, thresholds and fallback default. CODEOWNERS covers it.
- All calls go through one `decide()` helper, built on the vendored client, which records the question, answer, probability, confidence, latency, cost and fallback use in run metrics.
- Hermes's Python side calls it through a small `hapi decide` CLI.
- With `jev.enabled: false`, or on error, `decide()` falls back in this order:
  1. a Haiku 5.5 classifier asked the same typed question;
  2. the decision file's deterministic default.

**Hard rules:**
- Never used for authorization, arithmetic, dates or as a security boundary. ten-levels' own warning: "treat a security gate as one signal, not the only control." In its live runs an agent routed around a write gate with a bash heredoc.
- A Jev answer can only make the factory **more careful** (block, flag, review deeper, ask the operator), or choose among options that are all already allowed.

**Where each level is used:**

| Level (ten-levels) | hapi-factory use | Phase |
|---|---|---|
| **1 Single decisions:** prompt-injection gate | Screen every untrusted text crossing into an agent: queued PR comments, rework comments, CodeRabbit comments, research briefs, webhook payloads. Above threshold, the text is wrapped as quoted data with a warning banner and the operator is flagged. Content is never silently dropped. | v1 |
| **2 Multiple choice:** fan-out triage | Hermes intake, one call: lane (planning, factory, direct, other) + category + urgency, shown to the operator as a suggestion. Phase 2 mtg issue triage adds "bundle with #N?" | v1 (intake); 2 (mtg triage) |
| **3 Composite scoring:** code-review risk | Archon, after implement: score security risk, complexity, convention drift and change size, with **weights in code**. This picks review depth: standard, or an extra security lens plus a stronger reviewer. It can only raise depth above the work order's declared `risk`. | v1 |
| **4 Confidence gating:** bash gate, citation check | (a) The **citation check** in `hapi-research-note`: does the source support the claim, and is the quote faithful? Low confidence marks the claim "unverified" in the note. (b) Confidence floor/bar semantics for every gate below. | v1 |
| **5 Routing:** model router | Archon `prepare`: least-cost tier plus effort for implement, within the roster. Retry still escalates to high. Also picks the review lens. | v1 |
| **6 Guardrail hooks:** bash gate, write gate, result screen | In **hapi-guard**, layered *after* the deterministic rules. The deterministic protected-path block makes no Jev call. Then three Jev gates: the **bash gate** (irreversible or destructive intent: block), the **write gate** (does the content hold a credential? block) and the **result screen** (tool output carrying instructions gets a data banner). The container stays the real boundary. | v1 |
| **7 Should I compact** | Context control, the pain point that started the project. (a) Pi steps that run long: turn-end compaction signal and cut point. (b) Long Hermes sessions such as brainstorms: suggest compressing or starting fresh at a natural boundary. Behind a flag; v1 steps are short by design. **[verify]** against Anthropic's history-edit rejection first. | 3 |
| **8–9 Cheap reads, files at scale** | **Scout pre-pass** as an Archon script step before implement: ask "is this file relevant to the work order?" over the repo in parallel, pruned in code, capped at 255. Pi gets a short `relevant_files` list instead of exploring, which serves the token-efficiency anti-goal. Optionally, give Pi the `ask_jev_file_*` tools so it can ask a question without reading a file into context. | v1 (pre-pass); 3 (tools) |
| **10 Agentic Jev:** triage a failure, judge a diff | Placed **in code**, not left to the agent: after a gate fails, classify the failure (bug in code, wrong test, flaky, environment, out of scope, other) to decide between retry, re-running gates, or stop-and-flag. After implement, ask "does the diff stay within the work order's intent?" (flag only). Giving Pi the `ask_jev` tool itself is a phase 3 experiment. | v1 (in code); 3 (tool) |
| `hapi-heads-up` | "Is there something worth flagging to the operator now?" gates whether a note is posted | 3 |
| Freshness job | "Has this source materially changed since the note?" | v1 |

**Lessons carried over from ten-levels' "Where it can still fail":**
- **The agent can read its own environment.** Pi gets the minimum env, and the Jev key is its **own** OpenRouter key with a tiny monthly cap ($2), since it's visible inside the Archon zone.
- **The mock is shape, not intelligence.** CI tests the decision files' contracts and thresholds on the mock. Eval runs exercise live Jev.
- **Calibration:** evals record each decision against the later outcome. Was the "flaky" call right? Did a "low risk" order need rework? Did the injection screen fire on benign comments? Thresholds are tuned in the decision files, never in prompts.

**Data boundary:** Jev receives decision state such as comment text, diff summaries, file contents for the scout pass, and failure logs. This is acceptable for public repos in v1. **[verify]** TypeSafe's and OpenRouter's retention terms for Jev before enabling it on private repos.

### 9.6 CodeRabbit [user: considering; call: role]

- **Role:** CodeRabbit is a second-vendor PR reviewer, **free for public repositories** (verified on its pricing page, 2026-10-26). That gives an independent model family and vendor on top of the in-run review, at no token cost. Installed as a GitHub App on hapi-managed public repos, configured by a `.coderabbit.yaml` in the contract template.
- **On delivery and planning PRs:** its findings go into the PR record. The harvester's PR summary also links them.
- **Rework:** when the operator applies `hapi:rework`, CodeRabbit's comments are included alongside maintainer comments, as **data** from an allowlisted bot identity.
- **Metrics:** its finding counts per PR are recorded, which feeds the "poor output" measure.
- **Never a merge authority or a required check in v1.** Like any LLM reviewer, its output can be steered by PR content. The operator's merge decides.
- **Cost lever** [call]: on `risk: low` work orders, the in-run review may drop to a cheaper tier, leaning on CodeRabbit plus the operator. Evals must show this doesn't raise rework.
- **[verify]:**
  - which features the free open-source tier includes;
  - whether CodeRabbit's CLI (pre-PR review "in coding-agent loops") is usable on the free tier, as an optional in-run step;
  - its data-retention terms (`trust.coderabbit.ai`) before using it on private repos;
  - GitLab support, which matters for §16.

## 10. Web and documentation access

`policy/trusted_sources.yaml` has four tiers [call; from report]:
- **T0:** pinned local snapshots
- **T1:** first-party domains and package registries
- **T2:** curated aggregators, such as Context7 (pinned 4.x client; ContextCrush was fixed server-side, see §10.1) and DeepWiki
- **T3:** the open web

Who gets which tier:
- **Only `hapi-research`** touches T3. It returns schema-validated briefs; nothing raw goes downstream.
- **The Hermes main session** gets T0–T1. T2 and T3 content reaches it only as schema-validated briefs from `hapi-research` (amended 2026-10-26 after the MCP research, §10.1).
- **Pi workers** get T0–T1, and in practice no web tools at all. Their egress is model APIs, the local mirror, package registries and the work order's `egress_extra` hosts.
- Enforcement lives below the agent: a default-deny egress proxy per container. The builder picks the tool, such as sandbox-runtime, iron-proxy (Docker backend only) or Smokescreen.

For the mtg pilot, Hermes confirms the endpoint change **from a first-party source** and records it. The worker never researches it.

### 10.1 MCP servers per layer [user: add an MCP layer with base configs; call: contents, from the MCP baseline research ([docs/research](../../research/README.md)), 2026-10-26]

MCP servers are packages that put text into an agent's context. Each one is therefore two risks:
- a **supply-chain** risk: code we run;
- an **untrusted-input** source: text the model reads.

**Single source of truth:**
- **`policy/mcp.yaml`,** the catalog of approved servers. Each entry gives:
  - the zone(s) that may load it;
  - its transport;
  - an **exact pin** (version + registry integrity, or OCI digest);
  - an advisory **version floor** our own check enforces, because some advisories, like Context7's, have no OSV record and scanners stay silent;
  - a `tools.include` allowlist (read-only tools only);
  - `env`, by secret name (`secret:<name>`, resolved by the secret provider, §11.5): each server gets only its own key;
  - its allowed egress hosts;
  - `trust: untrusted`;
  - elicitation `deny`.
- **`policy/mcp.lock.json`** stores each server's raw `tools/list` output, `instructions`, prompts and resources, plus their hash.

**Who gets what (v1):**

| Layer / zone | MCP servers | Notes |
|---|---|---|
| `hapi-research` (`research` zone, **its own container**) | **Context7** (`@upstash/context7-mcp`, T2) | The only general docs server with version-addressed library ids and a pinnable local client. Library-owner and teamspace "rules" can't be switched off client-side, so it stays quarantined: egress `context7.com` only, always with an API key, `OTEL_SDK_DISABLED=true`, no proxy or URL overrides beyond the zone's own. |
| Hermes main session (`hermes` zone) | **None in v1.** Optional: **Arize Phoenix MCP** (`@arizeai/phoenix-mcp`, stdio) whenever the o11y profile runs | Phoenix needs a VIEWER-role key, `PHOENIX_DISCOVER_CONFIG=false`, an explicit `PHOENIX_ENDPOINT`, the 23 read-only tools only, and `phoenix-support` excluded (it forwards queries to a third party). |
| Archon Pi workers / Claude review nodes | **None** | Workers see T0–T1 only. Docs reach them as research notes and reviewed, hashed snapshots. |
| Claude Code lane (phase 4) | Generated from the same catalog, with `--strict-mcp-config` | Context7 only under research-zone quarantine. |

**Web search is NOT an MCP server.** The research zone uses Hermes's **native** `web_search` / `web_extract`:
- **Brave** for search, **Exa contents** (or Firecrawl) for extract;
- `keyless_fallback: false`, never `web.backend: nous`;
- `security.allow_private_urls: false`;
- vendor extras pre-installed at image build, from Hermes's own exact pins.

Why native beats an MCP server here:
- The native path exposes a fixed, Hermes-owned two-tool schema, so there's no vendor tool text to rug-pull.
- It has a fail-closed SSRF guard.
- The four leading search APIs (Brave, Firecrawl, Exa, Parallel) were statistically tied on the only independent benchmark. Brave is fastest and cheapest per search, and Exa contents is $1 per 1k pages.

**Research-zone keys:** `hapi-research` holds only **spend-capped, search-only** keys: Brave, Exa and Context7 [call]. That's a deliberate exception to "no secrets": low value and capped, with no repo or forge access.

**Deliberately not used in v1** (one line each; reasons in the research note):
- **GitHub MCP:** forge actions go through `src/forge/`. A read-only GitHub MCP is a phase-2 candidate for mtg triage.
- **Firecrawl, Tavily, Perplexity and other search MCPs:** native backends cover them.
- **Reference servers** (filesystem, git, memory, time, sequential-thinking): native tools cover them, and git and filesystem would bypass our command and path policies.
- **Playwright MCP:** Microsoft now recommends its CLI plus skills.
- **MCP gateways** (Docker MCP Gateway, etc.): they need the Docker socket, have heavy advisory histories, and none defends against tool poisoning.
- **Lookalike packages** are blocked by name, e.g. `@modelcontextprotocol/server-brave-search`, Crawl4AI and `ai.smithery/*`.

**Controls:**
- **Pin:** one image per server, built from a committed lockfile and pinned by digest. A bare `npx`/`uvx pkg@x.y.z` doesn't pin the dependency tree.
- **Cooldown:** 14-day release cooldown, with a **security-fix exception** recorded in the catalog.
- **Run stdio servers inside their zone's container,** so the zone's Squid allowlist binds them. Egress is per zone, not per server, in v1. Accepted, because no research-zone server holds a second secret. Per-server isolation (e.g. ToolHive with explicit deny-by-default profiles) is a phase-2 option.
- **Rug-pull defense:** `hapi mcp pin` records `mcp.lock.json`. Every connect, `hapi audit` (`mcp.tool-hashes`) and stack start-up fail closed on drift. Re-approval is a planning PR, since `new_skill_or_mcp` is on the approvals list. Remote-only endpoints count as review events.
- **CI scanning** on every change to the catalog or lockfile:
  1. Cisco `mcp-scanner` (offline YARA and static checks over the lockfile; never runs servers);
  2. Snyk Agent Scan (sandboxed; it runs servers and uploads their descriptions);
  3. our advisory-floor check.

  Scanners are a floor, not a verdict.
- **Untrusted output:** **[verify in Plan 04]** whether a Hermes post-tool hook can run the injection screen (§9.5, L1) over MCP results. Either way, the human gate is the planning PR, since nothing from the research zone reaches workers without it.
- **Context7 security note:** ContextCrush (CVE-2026-75130, ≤ 2.1.2) was fixed on Upstash's **backend** on 2026-02-23, so a client pin can't enforce it. We pin a current 4.x client and enforce a floor above 2.1.2 ourselves, but the rules channel stays a live injection path. That's the reason for the quarantine.

---

## 11. Security

### 11.1 Method (SEC545-aligned) [call]

- **Threat model:** `docs/security/threat-model.md`, using **CSA MAESTRO** (7 layers, 6 steps) as the method.
- **Threat catalog:**
  - **OWASP Top 10 for Agentic Applications 2026** (ASI01–ASI10)
  - OWASP LLM Top 10 (2025 IDs, with a 2026 crosswalk)
  - OWASP MCP Top 10 and the Agentic Skills Top 10 (draft)
  - **MITRE ATLAS** v2026.09 agent techniques
- **Controls:** **OWASP AISVS** levels 1–2.
- **Grouping:** the six **SANS Critical AI Security Guidelines** domains.
- **Anchors:**
  - NIST SP 800-207/207A (zero trust, workload identity)
  - SSDF 800-218/218A, run as pipeline stages
  - SLSA v1.2. Source L4 two-party review is the target. Solo operation is a documented deviation: the operator plus an independent automated review.

### 11.2 Rule of Two per stage [call]

| Stage | Untrusted input | Sensitive access | State change | Compensating control |
|---|---|---|---|---|
| Hermes main session | Yes (chat, PR comments, briefs) | Minimal (planning token, capped key) | Yes (planning branch, messages) | Protected paths, cmd allowlist, PR review |
| hapi-research | Yes (T3 web) | None | None (returns a brief) | Quarantine and schema |
| Archon implement | Repo contents, work order | Capped model keys | Worktree only | Container, egress allowlist, hapi-guard, scope checks, no forge creds |
| Review | The diff | Read-only | None | Separate session and model |
| Harvester and merge | Indirect | Forge write | Yes | Deterministic code; the operator's approval; required checks |

### 11.3 Isolation

**Baseline:**
- Dedicated `hapi` Linux user
- Rootless containers; Docker vs Podman is the builder's call [verify Hermes on rootless Podman]
- Hermes and Archon in separate containers on a private network
- Ephemeral worktrees
- Non-persistent containers for externally fed sessions

**Next level:** a microVM per run, or one container per run [call].

### 11.4 Egress

Default-deny proxy per container, generated from policy.
- **Residual risk:** allowed hosts (package registries, smoke hosts) are exfiltration channels. Registry publishing would need attacker-supplied tokens.
- **Next level:** a read-only method filter on registries, or pull-through caches.

### 11.5 Identity and secrets

- **Two GitHub Apps:**
  - `hapi-planner`: Hermes; push `plan/*`, open PRs, labels.
  - `hapi-factory`: harvester; push `factory/*`, open PRs, labels.
  - Both use 1-hour installation tokens minted outside the agents. Neither can merge or bypass rulesets.
- **Console workspaces with spend limits:** `hapi-hermes`, `hapi-factory`, `hapi-evals`. The default workspace can't be capped, so it's unused.
- **OpenRouter:** one key per role and environment, with a daily `limit`. Zero-data-retention is enforced (`zdr`) for every non-Anthropic model.
- **Secrets** come from a pluggable **secret provider** at start, injected per zone as `0600` env files on the host's tmpfs [user: "portable across secret managers"; "sops and age to start", 2026-10-26]. **Fail closed:** if the configured provider fails or any name is missing or empty, nothing starts. There is no automatic fallback.
  - The repo ships **logical names only** (`stack/secrets.yaml`: zone → env var → name). Provider bindings and values live outside the public repo.
  - **Default: sops + age.** One encrypted file (`secrets.enc.yaml`) and an age key in the standard place for the user that runs the stack. No service; encrypted at rest; the encrypted file can be backed up in a private repo, the key never. Onboarding is `mise run secrets:init`.
  - **Keys and recovery:** every store is encrypted to one age key per machine or user (generated where it lives, never copied) plus one **recovery recipient**, whose identity is wrapped with a tool-generated 10-word passphrase (`recovery.age`). The user's backup job is the 10 words. Recipient changes re-key the data key. Removing a key doesn't undo old copies in git history, so a compromised key also means reissuing the credentials inside. Recipients are post-quantum by default, and mixing PQ and classic recipients is refused [call, from the 2026-10-26 key-recovery research].
  - **Optional: Bitwarden Secrets Manager** (`bws`), bound by name → id in the local config.
  - **Explicit downgrade: `env-file`** (plaintext, `0600`, outside every checkout). `hapi audit` reports it.
  - Never in a repo `.env` (Hermes's 1Password integration falls back to `.env`, which fails open).
  - **Docker keeps a copy** (found in Plan 01's final review, 2026-10-28): Compose passes each zone's env file to the container as its environment, which hapi's Docker keeps in the container's config on hapi's disk for as long as the container exists, reboots included; `mise run down` removes it. An accepted residual (H-189), beside the next one.
- **Residual risk:** model keys are visible inside their containers, and in Docker's config of each on hapi's disk, bounded by spend caps and egress. **Next level:** a credential-injecting proxy; for Docker's copy, secrets passed as files the containers read at start, or encrypted storage.

### 11.6 Supply chain

- Skill and memory write approval on; community hubs off.
- Pinned versions, SHAs and checksums for Hermes, plugins, Archon, Pi and hapi-guard.
- Release-age cooldowns in package managers.
- An approval gate for any new dependency, plus the slopsquatting check. The approvals list covers new dependencies.
- Our own skills live in this repo, reviewed like code.

### 11.7 Gates in CI (reusable workflow) [call]

- gitleaks, Semgrep or Opengrep, OSV-Scanner, zizmor
- Actions pinned to SHAs
- No AI agent with secrets on PR- or issue-triggered workflows
- Work-order schema check
- Trailer enforcement on `lane:factory` commits
- Protected-path diff check
- **Next level:** Syft SBOM, cosign or artifact attestations, immutable releases

### 11.8 Baseline checklist and kill switches

`mise run audit` verifies the flipped defaults (§9.1, §9.2, §9.3), rulesets, App permissions, spend limits and pins. It runs in CI on hapi-factory and on demand. This is the "worse controls" measure.

Kill switches, fastest first:
1. Zero or revoke the provider keys.
2. Suspend the GitHub App installations.
3. `mise run down` as host admin.
4. Firewall-drop the `hapi` user.

### 11.9 Residual risks (accepted for v1, documented in the threat model)

1. Pi runs in-process with Archon. It can read Archon state, answer Archon approvals and alter local run records.
   - Mitigation: the human boundary is on GitHub; there are no forge credentials in the zone.
   - Next level: ship run events off-box.
2. Egress channels via allowed hosts (§11.4).
3. Model keys inside containers (§11.5).
4. Holes in Hermes's protected-file gate (shell writes, `always` carry-over).
   - Mitigation: hapi-path-guard, the command allowlist and the PR backstop.
5. Prompt injection via repo content. Mitigations:
   - strip `.pi/` and `.agents/`;
   - CODEOWNERS on `AGENTS.md`;
   - workers have no web;
   - the reviewer is advisory.
6. LLM review can be manipulated. It's advisory; the operator merges.

---

## 12. Models and cost [call; from report §cost]

**Rosters** (`policy/rosters/`) map tiers (`small`/`medium`/`large`) per role, and are selected per run:

| Roster | Use | Mapping |
|---|---|---|
| `budget` | First end-to-end runs | Haiku 5.5 everywhere. Keep prompts under 100K tokens. |
| `anthropic` | Normal operation | Hermes main: Opus 5.5 at low–medium effort. Auxiliaries: Haiku 5.5. Implement: Opus 5.5 low, retry high. Review: Sonnet 5.5 or Opus 5.5 at medium, via the Claude provider. Scout and router: Haiku 5.5. |
| `portable` | Proving model portability | One OpenRouter model for implement (e.g. Kimi K3.1 Pro, or DeepSeek V4.1 Flash / GLM-5.3 Flash for plumbing tests), with ZDR enforced. A different family for review. |

Cost rules:
- **Caching on everywhere.** Running without it cost 3.3× in Anthropic's measurements.
- **Never edit the system prompt mid-run.** Put timestamps in the newest turn.
- **Switch models only at step boundaries.** Caches are per model.
- **`max_tokens` around 64K** for Opus.
- **Escalate effort before changing model.**
- **Hard caps live at the provider** (workspaces and keys). Archon budgets and hapi-guard are the in-run caps.
- **Handle Anthropic's 429 `enforced_spend_limit_reached`** as terminal. Don't retry it.
- **[verify early]:** Anthropic rejects edited conversation history for accounts created on or after 2026-08-31. Make sure Hermes compression and Pi compaction don't break on that. Settled by spike T11 (docs/spikes/04-anthropic-history-and-billing.md):
  - the operator's account isn't enforced, on Haiku 5.5, Sonnet 5.5 or Opus 5.5;
  - opted in as an enforced account would be, neither harness fails. Pi sends `drop_block` for models its catalog flags, so compaction drops the kept turn's reasoning, but an unflagged model would fail its node (H-184). Hermes gets one 400 per compression, then strips the stale blocks and resends (H-185).
- **[verify]:** a one-dollar test of whether Claude-provider (Agent SDK) review draws on the API credit. The credits doc says the Agent SDK is covered. Spike T11 ran one such node, on Sonnet 5.5 with the archon zone's key as its only credential. The Console confirmation is open (H-187), because the Console's usage was hours behind.
- **Provider subscriptions: decided after v1, from measured numbers** [call].
  - **The question** [user]: is the factory better funded by one larger Claude plan's API credit, or by a smaller Claude plan for interactive work plus a cheaper coding plan for the factory?
  - **How it was evaluated** (2026-10-26, the private provider-subscriptions research, [docs/research](../../research/README.md)): each plan against what an unattended factory needs. Terms that allow unattended, third-party-harness use; data retention and training; the models it serves; and its price against the API credit it would replace.
  - **How it gets decided:** after v1, from the factory's own numbers: cost per run on each roster (§13), eval pass rates (§14) and how much of the credit the factory actually uses.
  - **What it found:**
    - **A smaller Claude plan** halves both the price and the included API credit ($100 a month with a $100 credit, against $200 and $200), and cuts the interactive Claude Code limits to roughly a quarter.
    - **ChatGPT Plus/Pro through Pi's "Sign in with ChatGPT"** has terms that explicitly allow third-party and unattended use (2026-09-29). Caveats:
      - training is on by default and must be opted out;
      - the 5-hour window is shared with personal ChatGPT use.
      - Archon supports Pi subscription OAuth for non-Anthropic providers.
    - **OpenCode Go / Go Plus** ($10/$40) carries strong open models such as Kimi K3.1 Pro, with no retention for most of them.
    - **Z.ai's** plan is second-tier and restricts automation. Its Singapore jurisdiction makes training terms unclear.
    - **Mistral** has no coding plan.
    - **Kimi's and Alibaba's** plans forbid third-party-harness use.
  - **For v1:** the Anthropic credit plus **OpenCode Go ($10/month)** for the `portable` roster [call; to try one provider outside the two largest labs].
    - OpenCode is run by **Anomaly**, the team behind SST; the repo moved from `sst/opencode` to `anomalyco/opencode` (MIT).
    - OpenCode Go serves Kimi K3.1 Pro, GLM-5.3 and others, with no retention for most open models.
    - Pi and Hermes are its validated clients.
    - The contracting entity is **Anomaly Innovations, Inc.** (privacy policy and terms effective 2026-03-06). I couldn't confirm its state or headquarters from its pages.
    - **Privacy, per model:** 0-day retention and no training for most open models (Kimi K3.1 Pro, GLM-5.x, Qwen3.8, MiniMax, DeepSeek V4.x). 30-day retention, no training, for the GPT, Grok and Claude Haiku endpoints. Meta Muse Spark *trains*, so it's blocked by default.
    - DeepSeek's zero-retention agreement is renewed monthly (current one valid through 2026-10-31). Don't depend on it.
    - Upstream hosting providers aren't named.
    - **Guardrails:** "traffic is monitored for abuse". No content-moderation layer is described beyond the models' own. Spending is capped by monthly dollar limits, with 5-hour (20%) and weekly (50%) allowances.
    - **Settings for us:**
      - keep training endpoints blocked;
      - keep regions EU/US;
      - **keep Extra Usage off**, so the limit is a hard cap;
      - use only 0-day-retention models in the `portable` roster;
      - fall back to the `budget` roster when an allowance runs out.
    - OpenRouter with ZDR is the fallback if OpenCode Go's limits or terms don't fit.
  - **GLM-5.3 is mid-pack, not out of contention.** On the one hard benchmark that still separates models (Vals Terminal-Bench 4.0) it scores 38.9% (#13), against Kimi K3.1 Pro at 63.6% (#3) and Opus 5.5 at 65%. On the saturated SWE-bench Verified it scores 95.4%. Use it for cheap roles; our own evals decide anything more.
  - After v1, choose the mix by **cost per merged PR** and the four anti-goal measures. Every extra provider adds terms to track and a data boundary to manage.
  - Whatever is chosen becomes a roster, with a fallback chain so caps don't stall unattended runs. Nothing else in the design changes.

---

## 13. Observability, provenance and metrics

### 13.1 Always on, no extra dependency [user: lightweight; call: shape]

- **Structured logs.** Every component writes JSON lines keyed by `work_order_id` and `trace_id`.
- **Per-run record.** Archon's DB and transcripts, plus `metrics.json` in each run's artifacts:
  - cost and tokens by role and model
  - wall time
  - turns
  - gate results
  - review verdict
  - human interventions
  - tool versions
  - roster

  A local `~/.hapi/metrics.jsonl` gets one line per run.
- **Merge outcome.** After merge, the harvester appends: merged without changes? Number of review rounds? Time to merge?
- **Upkeep.** `mise run upgrade` records its own duration and what broke.

### 13.2 Commit trailers (provenance) [call]

Every factory-lane commit carries:
- `Work-Order: <id>`
- `Hapi-Run: <archon-run-id>`
- `Hapi-Lane: factory`
- `Trace-Id: <id>`
- `Agent: pi@<ver>`
- `Model: <id>`

CI enforces them on `lane:factory` PRs. Direct-lane commits get `Hapi-Lane: direct` from an optional git hook. This fills the "run provenance" gap no framework covers. Run manifests go in git notes as a next-level option.

### 13.3 Flags and thresholds [user: configurable by flags]

```yaml
# policy/flags.yaml
metrics:      { enabled: true, merge_outcomes: true }
otel:         { enabled: false, content_capture: off }   # off | preview
jev:          { enabled: true, fallback: haiku, via: openrouter }  # fallback: haiku | none
coderabbit:   { enabled: true, include_in_rework: true }
thresholds:                                              # crossing one flags the run
  run_usd: 3.00
  interventions: 1
  review_rounds: 2
on_flag: [label_pr, chat_alert]          # chat_alert posts to Slack #hapi-alerts
```

A flagged run gets `hapi:flagged` on its PR and an alert in `#hapi-alerts`.

### 13.4 Optional observability profile (`mise run o11y:up`) [call; from `observability_stack.md`]

- **Stack:** an OpenTelemetry Collector (redaction processor, token-authenticated ingest) feeding **Arize Phoenix**, with the tag pinned and a mounted volume. **Langfuse v4** is the documented alternative.
- **Isolation:** runs as a separate Unix user, so agents with Docker access can't delete it.
- **Trace propagation:**
  - `traceparent` is minted with the work order (§6) and injected by wrapper scripts (W3C `TRACEPARENT` env).
  - hermes_otel ≥ 1.31 takes `HERMES_OTEL_TRACEPARENT`, but per process. One trace per work order needs our dispatch tooling.
  - The Claude provider honors `TRACEPARENT` in SDK sessions. Its telemetry settings must go in `~/.archon/.env` or Claude settings, because Archon strips `CLAUDE_CODE_*` from the shell environment.
  - hapi-guard emits Pi spans.
  - Archon has no OpenTelemetry. A small bridge reads its run events over REST/SSE and emits OTLP.
- **Attribute mapping:** the Collector maps Claude Code's token attributes to `gen_ai.usage.*`.
- **[verify]:**
  - trace context survives `archon trigger fire` and detached runs: settled by spike T10 for a `TRACEPARENT` exported into `fire`'s environment, which every node of the detached run inherits, Pi's shell included. The `traceparent` input reaches bash nodes only, as `$INPUTS_TRACEPARENT`, and a queued request run by a later drain is untested (docs/spikes/03-archon-budget-trigger-env.md);
  - spans flush before process exit.

---

## 14. Evals

- `evals/cases/<id>/` holds a frozen work order, a repo URL and SHA, and expected-outcome checks (tests, diff scope, smoke).
- `mise run eval [--roster X]` re-runs the factory on the cases and reports the four anti-goal measures.
- The suite gates upgrades to Archon, Pi and hapi-guard, plus roster changes.
- **Planning-side evals gate Hermes upgrades** [call]. Factory cases start from a frozen work order, so they never exercise Hermes.
  - `evals/planning/<id>/` holds a recorded intake prompt and expected-outcome checks.
  - A case passes when all of these hold:
    - Hermes produces a **schema-valid work order**;
    - its declared file scope matches the expected files;
    - its research note cites at least one **first-party** source with a retrieval date;
    - no protected-path rule is violated.
  - Plan *quality* stays human-judged in v1.
- Evals also record **Jev and CodeRabbit signal quality**: decision vs later outcome, and findings vs rework. That's how thresholds get tuned (§9.5–9.6).
- Start with **case 1 = the v1 pilot**. Grow toward 20–50 cases drawn from real failures and from the mtg repo's history. Track pass^k on repeated trials [call; Anthropic guidance].

---

## 15. Phases

| Phase | Scope | Done when |
|---|---|---|
| 0. Foundations | Repo skeleton, `mise.toml`, `policy/` + generator (minimum: protected paths, commands, budgets, rosters, flags), containers for Hermes and Archon, egress proxy, `hapi` user, GitHub Apps, Console workspaces and keys, defaults flipped, `mise run audit`, threat model v0 | `mise run up` on this machine brings the stack up; `mise run audit` passes |
| **1. v1: a net-new MCP server (minimal), its subject picked with Hermes** | Repo template and `mise run new-repo`. `hapi-planning`, `hapi-research`/`hapi-research-note` and `new-work-order`. Poller (merge + rework label), mirror, harvester, `factory-task`, hapi-guard, CI reusable workflow, metrics and trailers, Slack gateway and alerts. A local sidecar on the private network for smoke: a subject-agnostic one until the brainstorm, then the one its design names (H-177). Eval case 1 and planning eval 1. | See below |
| 2. Brownfield: mtg MCP | Retire the old kit in mtg by hand through a Hermes planning PR: trim `AGENTS.md`; remove `CLAUDE.md`, `HERMES.md`, `.pi/`, `.claude/`, `.agents/skills/`; harden or remove the comment-triggered Claude workflows [user]. Hermes triages open issues, then one full run-through as a bundled PR (or a single PR if an issue merits it) [user]. Then extract a general `onboard` tool. | mtg run-through merged; old kit gone; audit passes on mtg |
| 3. Showcase depth and VM | The showcase beyond minimal (more tools, a real fan-out case), the optional o11y profile, more eval cases, published write-up. Same mise path on a fresh VM, with remote access via tunnel or proxy. Optional **`hapi-heads-up`** Hermes plugin: a tool-less, cheap-model pass over recent context after each turn that posts a note to Slack only when something is worth flagging. The main agent never sees it unless the operator forwards it. Modeled on Claude Code's "You should know" side agent [call]. | Fresh VM → `mise run up` → eval suite passes |
| 4. More lanes | Claude Code worker lane; Hermes → Pi direct lane (review the open Hermes PR #106739 pi-agent skill as a starting point) | Same eval cases pass with the Claude Code worker |
| 5. GitLab | GitLab forge adapter (§16) | Pilot eval passes on GitLab |

**v1 scope: one MCP server, minimal** [call; the subject reopened by the operator, 2026-10-27]:
- A read-only MCP server over one data source. **The subject is uncommitted, and picking it is part of the v1 test:** the operator brainstorms it with Hermes in `#hapi-intake` (step 2 below), and nothing built before then assumes it (H-177) [user]. The candidates so far are Odoo's external API (the first pick) and public energy and weather data.
- At most **two or three work orders**, bundled where related. For example, for Odoo:
  - (1) the server skeleton with config, auth handling and a health tool;
  - (2) one read-only CRM tool, such as `search_partners`;
  - optionally (3) one read-only finance tool, such as `list_invoices`.
- No write tools, no hosting, local stdio transport.
- Smoke tests run against a **local sidecar** on the private network: for Odoo, the official Odoo and Postgres images; for a public data API, a stub serving recorded responses. The worker needs no external egress beyond model APIs, which is a strong security property for the pilot. Until the brainstorm, Plans 03 and 05 smoke-test against a subject-agnostic sidecar.
- Hermes decides the exact cut during planning, and the operator approves it at the planning PR.

**v1 definition of done** [user scope; call specifics]:
1. The operator runs `mise run new-repo -- <name>`. The repo exists with the contract, ruleset and both Apps installed.
2. In Slack (`#hapi-intake`), the operator brainstorms the showcase with Hermes, starting with its subject.
   - `hapi-research` produces dated, first-party-sourced notes on the chosen data source's API and the MCP spec.
   - Hermes drafts `docs/design/<name>.md`, `docs/security/threat-model.md` (MAESTRO, scoped to this server) and the work orders on `plan/<name>`.
   - Hermes opens a `lane:planning` PR.
3. The operator merges it. Exactly **one** Archon run per work order starts within the poll interval, without the operator touching Archon.
4. Each run:
   - Pi builds inside the container, with `.pi/` stripped and hapi-guard active.
   - `mise run check` and `mise run smoke` pass against its sidecar.
   - The scope check passes.
   - The independent review returns `ready`.
5. The harvester opens one `lane:factory` PR per work order, with trailers and the run summary.
   - The rework label is exercised at least once.
   - The operator merges the PRs.
6. `metrics.json` and `metrics.jsonl` record cost, turns, interventions and merge outcomes. Targets: ≤ $3 per run on the `anthropic` roster, total v1 build ≤ $25 [call].
7. Eval case 1 (a frozen work order) passes on the `budget` roster, and once on `portable`. Planning eval 1 (the recorded intake) passes.
   - Jev decisions are recorded in run metrics.
   - The eval passes once more with `jev.enabled: false`, which proves the fallback.
   - CodeRabbit has reviewed the delivery PRs, with its findings linked in the PR summary.
8. `mise run audit` passes throughout.

---

## 16. Forge portability

**Rule:** workflows, scripts and skills never call `gh` directly. They call one `forge` interface: our harvester and poller adapter, and Archon's `archon forge <op>` where Archon needs forge data.

**GitLab lift** (from `archon_plugins_integration.md` §Q8):

| Piece | Lift |
|---|---|
| CI | Small. A `.gitlab-ci.yml` running the same mise tasks. |
| Hermes | Small. GitLab webhook tokens are supported; skills move from `gh` to `glab`. |
| Our poller and harvester | Small to medium. A GitLab adapter. |
| Archon forge plugin (if Archon needs forge data) | The bulk, weeks. No GitLab plugin exists, and the bundled adapter only covers mentions and cleanup. |
| Identity and approval rules | Medium. Project access tokens; check which GitLab tier code-owner approvals need. |

Because v1 keeps Archon off the forge (§9.4), hapi-factory may need little or none of the Archon GitLab work.

---

## 17. Distribution and upkeep [user]

- **The engine** is hapi-factory, installed once per machine. Target repos reference it, they don't copy it:
  - the reusable CI workflow pinned by tag;
  - the policy overlay;
  - mise tasks.
- **Harness add-ons** (Hermes plugins and skills, Pi `hapi-guard`, later a Claude Code plugin) are thin, versioned and shipped from this repo.
- **Upgrades:** monthly, or on security advisories, behind `mise run eval`. Release notes go in `docs/upgrades/`.
- **Public repo, docs-first.** Each component's README says why it's there and which control or pillar it serves.

---

## 18. Left to the builder

- Container runtime (rootless Docker or Podman), the compose layout, and the egress proxy implementation, within §11.3–11.4.
- The exact JSON Schema for work orders and metrics.
- Workflow YAML, script languages, the poller interval, and the repo layout of hapi-factory. Suggested: `policy/ generators/ stack/ hermes/ archon/ pi/ scripts/ o11y/ evals/ templates/repo-contract/ docs/`.
- Which search backend, within §10's constraints.
- Fan-out thresholds, within §5.4.
- Whether to upstream the Archon Pi-trust fix during phase 1 or later.
- Deduplicating the trigger key when one merge carries several work orders: settled by spike T10, one delivery ID per work order (§9.4; docs/spikes/03-archon-budget-trigger-env.md).
- The toolchain mise installs inside the Archon container.
- How the ruleset lets the operator merge PRs they authored themselves (`lane:direct`). Rulesets don't let an author approve their own PR. Use an owner-only bypass that the Apps and agents can never use.

## 19. Verify early (spikes)

1. Pi under Archon: does a user-level `hapi-guard` load with `.pi/` stripped, does `PI_OFFLINE=1` block repo-driven package installs, and does throwing from a hook fail the node?
2. Pi SDK 1.3.0 (Archon) vs CLI 1.4.0 config compatibility.
3. Hermes: does a `pre_tool_call` approve decision plus a Python-plugin surface check work under `plugins.isolation: host`? Can hapi-path-guard catch shell writes?
4. Archon: does `budget` work on `factory-task`? Does `trigger fire` carry inputs and `TRACEPARENT` into Pi bash?
5. Anthropic: does the history-edit rejection hit Hermes or Pi compaction? A one-dollar Agent SDK billing test.
6. Hermes install via mise; Hermes Docker backend on rootless Podman.
7. Hermes's Slack gateway runs in Socket Mode, with no inbound endpoint, and supports a user-ID allowlist.
8. A private smoke sidecar runs where the Archon container can reach it, and `mise run smoke` can seed or replay its data. As first written: the official Odoo and Postgres images, with minimal CRM and invoice data. Until the brainstorm picks the subject: a subject-agnostic one (H-177).
