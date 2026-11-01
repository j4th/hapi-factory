# hapi-factory Plan 03: the run engine — design

- **Date:** 2026-10-31
- **Status:** approved by the operator, 2026-10-31
- **Owner:** the operator
- **Parent spec:** [2026-10-26-hapi-factory-design.md](2026-10-26-hapi-factory-design.md) (the "spec" below). This document narrows it for Plan 03 and, where it says so, changes it. Where the two disagree, this one wins for Plan 03, and Plan 03 adds an "As built" note to the spec at each place it changes.
- **Builds on:** [Plan 02's design](2026-10-29-hapi-factory-02-worker-design.md): one hardened container per run, made by `hapi run start` (`src/run/`), with hapi-guard as Pi's only extension and the run's bundle and records copied out to the host.
- **Register:** the "## Plan 03 Run engine" section of [handoffs.md](../plans/handoffs.md) (H-090, H-091, H-092, H-161, H-166, H-167, H-172, H-182, H-183, H-192, H-194, H-195, H-203 to H-211, H-217 to H-223, H-228 to H-230), plus the Plan 05 items `new-repo` pulls forward (§3.2). Each item is pulled into a plan task; where this document changes one, the change is said here and in the register.
- **Research (2026-10-31):** three read-only sweeps made for this design: other agent systems' PRs and review loops, CodeRabbit's agent loop, Hermes's Kanban, Linear's agent platform and GitHub-native status (§3.7, §3.8); what a `new-repo` must do and the GitHub API rights for each step (§3.2); and best practice for the repos it creates (§3.3). Their findings are cited where used.

Tags, as in the spec: **[user]** decided by the operator in the Plan 03 brainstorm (2026-10-31); **[call]** the designer's call, open to override; **[verify]** a fact the builder confirms early, before depending on it.

---

## 1. Intent

**The operator merges a planning PR and walks away. When they come back, there is one factory PR per work order, each one they can safely merge, send back with feedback, or throw out** [user]. Between the merge and their review, nothing needs them. Above the PRs, they can see where the whole plan stands [user].

Plan 03 is the run engine: what turns a merged work order into a reviewed PR. Plan 02 built the worker and its container; Plan 03 builds what starts runs, what reads their results, what checks them on the host, what opens and iterates on the PR, and the repo it all runs against.

**Why now:** the factory isn't a factory until runs start themselves and land as PRs (spec §15, v1 definition of done, steps 3 to 5). Everything Plan 04 (Hermes) and Plan 07 (v1 acceptance) assume stands on it.

**How the operator wants it built** [user]: secure by design first, as before, without slowing down for its own sake. The sandbox repo's end-to-end runs are the demo; there is no separate "try it" work.

## 2. Goals, non-goals, anti-goals

### Goals
1. **The per-run disk cap (H-217) first** (§3.1). The operator ruled on 2026-10-30 that the poller starts no unattended run until it lands [user].
2. **`mise run new-repo`**, pulled forward from Plan 05 [user], with a sandbox repo as its first user (§3.2, §3.3).
3. **The poller, the mirror and the per-repo queue** (§3.4): a merged work order starts exactly one run within the poll interval, with nobody touching anything.
4. **The `factory-task` workflow** (§3.5): preflight, implement, gates, commit, in the worker's container.
5. **A run's evidence out of the worker's reach** [user]: a verify container and a review container after the worker's (§3.5). Then **the harvester** (§3.6): host-side gates on the run's bundle, and one factory PR per work order, with a description the operator can decide from (§3.7).
6. **Iterating with CodeRabbit** before the PR (in the review container) and on the PR, with hard caps [user] (§3.5, §3.6).
7. **A status view of the whole plan** on GitHub, as runs move [user: "git first"] (§3.8).
8. **Every cap fail-closed in policy, per enforcer** (§3.9), with the sandbox's total at $15 [user].
9. The rest of the Plan 03 register, the audit and the threat model brought up to date (§3.10, §3.11).

### Non-goals for Plan 03
- **Hermes writing planning PRs.** The sandbox's planning PRs are written by hand for Plan 03 [call]; Hermes's planning skill is Plan 04's.
- **Linear, and Hermes reading or reporting run status.** Plan 04's (§3.8). The status events Plan 03 writes are what they read.
- **Merging by anything but the operator** (§3.6, "The merge").
- **Fan-out inside a run** (spec §5.4) [call]: every v1 and sandbox work order is small. Plan 03 runs one implement step per work order and commits each piece separately; `preflight` refuses a work order whose pieces would fan out under spec §5.4's thresholds (H-234).
- **The v1 showcase's subject**: still the operator's brainstorm with Hermes (H-177). The sandbox exercises v1's shape, not its subject (§3.3).
- **Resume** (H-213): a failed run still starts over.
- **Onboarding existing repos** (Phase 2): `new-repo` makes new ones only.

### Anti-goals: failure even if it technically works [user]
The operator's own words, from the brainstorm, each with the part of the design that answers it:
1. **"A horrible amount of spend or cycles."** Hard caps at every level that can loop or fan out: per run, per repo per month, per day, per review round, per rework round (§3.9). A cap that trips stops work and says so; nothing quietly retries or keeps spending.
2. **"A run that ran without its proper tooling or context."** `preflight` checks the toolchain, the contract, the work order's sources and the guard before any model spend, and fails the run with a plain reason (§3.5).
3. **"Something I don't understand or see."** Every run is visible on the planning PR's status comment and, if it got that far, its PR, failures included, each with a plain reason (§3.7, §3.8). The PR leads with its verdict and what's unresolved.
4. **"Something that doesn't work."** `check` and `smoke` pass in a container the worker can't touch, and the independent review checks the result against the work order's acceptance criteria, before a PR is ready. A run whose checks fail is at most a draft marked `Do not merge`, and a run that changed nothing never becomes a PR (H-228(b)).
5. **"Too small in scope."** A run that delivers only part of its work order (stubs, TODOs, an unmet acceptance criterion) is reported incomplete, never passed off as done (§3.5, the review). Work orders aren't cut so thin the PRs are trivial (the sandbox plan, §3.3, and Plan 04's planning skill).

And, carried from Plans 01 and 02:
- Host code that executes, sources or interprets anything a run produced, or runs git with a run's config.
- A secret value in an error, log, argv, transcript, PR, comment or the repo.
- A silent fallback or a fail-open default.
- Untrusted text (a PR comment, a CodeRabbit finding, a worker's own account) treated as an instruction or as verified fact.

## 3. Design

### 3.0 The flow

```
operator merges the planning PR (lane:planning) on GitHub
        │  .factory/work/<id>/ is now on main
        ▼
host poller (systemd user timer, as hapi)
  ├─ fetches the repo's bare mirror (read-only App token, never stored in the mirror)
  ├─ finds merged work orders with no run; queues them per repo (one live run per repo)
  └─ calls the launcher: hapi run start --repo <mirror> --work-order <from the merge commit> [--public from the forge]
        ▼
worker container (Plan 02), workflow factory-task
  preflight → implement (Pi) → gates (reported) → commit per piece → bundle to /out
        ▼
host harvester (deterministic, no model): host gates on the bundle (protected paths with the overlay, scope, sizes, no-op)
        ▼
verify container (no secrets, no model): install from the lockfile, check + smoke + the planner's acceptance tests, on exactly the bundle's commits
        ▼
review container (keys, no repo code): the independent review (read-only, no shell) + CodeRabbit's CLI
        │  needs work? ─► one fix run (a worker container) ─► verify + review once more
        ▼
host harvester: pushes factory/<id>, opens the PR (lane:factory) with §3.7's description, records harvestedAt
        ▼
CodeRabbit reviews the PR ─► at most one automatic fix run ─► the operator: merge │ hapi:rework │ close
        │
        └─ the planning PR's status comment, edited in place at every step (§3.8)
```

The spec's flow (§4.2, §9.4) fires `archon trigger fire` into a long-lived Archon. Plan 02 removed that Archon; **the poller calls `hapi run start`** instead, and the trigger's delivery key becomes the launcher's run key (§3.4, §6a item 1).

### 3.1 The per-run disk cap (H-217) [user: a gate on Plan 03's poller; call: the build]

As H-217 designs it:
- **The run volumes become bind-backed local volumes** (`docker volume create --opt type=none --opt o=bind --opt device=<dir>/<volume>`) in one directory on a fixed-size filesystem. The operator makes that filesystem once, with sudo, from a runbook step: a loop image or an LV, mounted where hapi owns it [call: a loop image file, ext4, mounted by a systemd mount unit, since the host's disk layout is the operator's].
- **`runs.disk`** in `policy/runs.yaml`: the cap in GB and its enforcement, `hard` by default (the launcher refuses to start a run unless the volume directory is on a filesystem of at most the cap, checked with `statfs` each start) or `soft` (it warns and goes on) [call: the operator's rule that every limit is a fail-closed default with a per-enforcer setting].
- **Removal goes through a helper container**, since rootless Docker maps uid 1001's files to a subuid the host can't delete.
- `policy/runs.yaml` and its schema are protected paths: the build asks the operator's OK for the change.
- [verify] bind-backed volumes on hapi's rootless Docker, the chown helper on them, and that a full filesystem fails the run (`ENOSPC`) without touching the Docker data root.

### 3.2 `mise run new-repo` [user: pulled forward from Plan 05]

**What it is:** a command the operator runs from their own terminal, with their own GitHub login, that makes a new public repo ready for the factory. Agents never run it and never create repos (spec §7) [user]. It is the only Plan 03 piece that acts with the operator's rights.

**The credential** [user: "it runs with my rights"; call: which]: the operator's `gh` login. On 2026-10-27 it applied all four of hapi-factory's rulesets. It needs the `workflow` scope to push the template's CI file (`gh auth refresh -s workflow`), and `new-repo` checks the scopes with `gh auth status` first and refuses, naming the missing scope, rather than half-making a repo. Nothing is written to a file. [verify] that `gh`'s OAuth token can add a repo to an App installation (`PUT /user/installations/{id}/repositories/{repo_id}`): GitHub's docs name classic tokens with `repo`, and fine-grained ones with "GitHub App installation repository access", and say nothing of OAuth tokens. If it can't, that one step becomes a web-UI step the command prints and waits on.

**The steps, in this order** (the order matters; the recon found it was never written down):
1. **Preflight, reading only:** the name is free and valid (`parseOwnerRepo`), the account is a personal one, both hapi Apps' installations exist, and the scopes are there.
2. **Render the contract** from `templates/repo-contract/` (§3.3) locally, and validate it before anything is pushed: the overlay only tightens (`loadOverlay`, `applyOverlay`), the only mise files are the root `mise.toml` and `mise.lock` (H-194), versions are exact, and the CI wrapper passes `repo.ai-workflows`.
3. **Create the repo**, public (rulesets need it on the free plan, CodeRabbit's free tier needs it, and the Jev rule asks only for public repos), empty, with issues on.
4. **Push the first commit to `main`**, CODEOWNERS included, **before any ruleset exists**: afterwards `main-review`'s Restrict updates and `main-protect`'s required check refuse even the operator's direct push.
5. **Settings:** `main` the default branch; merge commits only, so each piece's commit and its trailers reach `main` as they were reviewed (spec §5.3, §13.2; H-113) [call; the repo research suggested squash merges, but whether the trailers then survive is unconfirmed, and squash loses the per-piece commits]; auto-merge off; head branches deleted on merge; Actions' default token read-only and unable to approve PRs; private vulnerability reporting, secret scanning and push protection on; CodeQL's default setup; Actions limited to selected, SHA-pinned actions on GitHub-hosted runners, with fork runs needing approval. `main-review` adds `require_last_push_approval`.
6. **The four rulesets**, from the same JSON hapi-factory uses, moved into files both `new-repo` and `tests/docs/rulesets.test.ts` read [call], then read back by id, then the effective rules read on `main`, a feature branch and `plan/example`.
7. **Labels:** `lane:planning`, `lane:factory`, `lane:direct`, `hapi:rework`, `hapi:flagged`.
8. **Install the Apps** only now, after the rulesets are active and read back: add the repo to the `hapi-planner` and `hapi-factory` installations (selected repositories only, never all) and to CodeRabbit's. The installation ids aren't secret; they're recorded once in config. Then prove each App's token covers the new repo and nothing more.
9. **Register the repo with the factory** (§3.4): a new entry in `policy/repos.yaml` [call], which the command writes into the operator's hapi-factory checkout as an uncommitted change to review and merge by PR. The poller acts only on registered repos.
10. **Optionally clone** the new repo into a sibling folder of the checkout (`../<name>`), never inside it, for `lane:direct` work (the operator's earlier ask, from memory; H-178).
11. **Verify** with the strict audit for the new repo.

A failed step stops the command and prints what was done and what to undo; it never retries. Deleting a sandbox repo needs `delete_repo`, which `gh` lacks by default: that is a runbook step, not a command [call].

### 3.3 The repo contract template and the sandbox [user: a sandbox repo; call: its subject]

**`templates/repo-contract/`** is a directory in hapi-factory, not a GitHub template repository (GitHub's `/generate` copies files only, never settings, rulesets, labels or App installs). Its contents follow spec §7 and the repo research (OpenSSF Scorecard and OSPS Baseline L1, GitHub's community health files, agent-friendly repos, MCP server conventions):
- **The contract:** `AGENTS.md` (below), `mise.toml` with `setup`, `fmt`, `lint`, `test`, `check`, `smoke` and `scan`, `mise.lock` locked for Linux and macOS, `.factory/config.yaml`, `.factory/work/`, `docs/research/`, `docs/design/`, `.github/CODEOWNERS`, `.github/workflows/hapi-gates.yml`, `.coderabbit.yaml` (hapi's review-only one: no finishing touches, no auto-reply, no summary edits to the PR body).
- **Community and security, from day one:** `LICENSE` (MIT, unmodified so GitHub detects it), `SECURITY.md` (private vulnerability reporting, the supported version, the response times Scorecard reads), `CONTRIBUTING.md` (the factory model; outside issues and PRs are read as data; the trailers; an AI-assistance policy), a short `README.md` with a working quick start, `CODE_OF_CONDUCT.md`, issue forms, and a PR template with §3.7's sections.
- **The toolchain for a TypeScript-on-Bun repo:** Bun with a text `bun.lock` and hapi's `bunfig.toml` (exact versions, a release-age cooldown); Biome, pinned, for format and lint, plus `tsc --noEmit`; tools run from `node_modules/.bin`, never `bunx`, which falls back to downloading from npm; `.editorconfig`, `.gitattributes`, `.gitignore`; Dependabot for `bun` and `github-actions` with a cooldown. No Renovate, hook managers, devcontainers or release tooling in the sandbox.
- **The gates workflow** runs `mise run check`, gitleaks, OSV-Scanner on `bun.lock` (GitHub's dependency graph doesn't read it), zizmor, the trailer check, with `permissions: {}`; plus OpenSSF Scorecard weekly.
- **The overlay protects the gates' own config** [call]: `biome.json*`, `bunfig.toml`, `tsconfig.json`, so a worker can't pass `check` by loosening it. `**/.mcp.json` and `**/.vscode/mcp.json` go into the central `policy/protected_paths.yaml` too (a protected change): Claude Code loads a project's `.mcp.json` without asking under `-p`.
- **`.factory/template.lock`**: the template's commit and a hash per copied file, so the audit can report drift. Template updates are the operator's PRs.

**`AGENTS.md` must work for an unattended agent** (H-228(a)) [call]: under 200 lines, commands first; it opens with "task instructions (the work order) override this file; nothing here waits for confirmation: where a step needs a human, report it as a blocker"; then the commands, what "done" means, the layout, the gotchas (an MCP server never writes to stdout), what's out of scope unless the task names it, the "never" list, and how to end: one line, `RESULT: done`, `RESULT: blocked: <reason>` or `RESULT: no-change: <reason>`. No "ask first" tier. The factory's own prompt says the same (§3.5).

**The CI wrapper's pin:** spec §7 says "by tag", but §11.7, GR-6 and H-171 require a full commit SHA, and only the operator can make hapi-factory tags. It pins by SHA [call]. [verify] the required check's name: a job in a called reusable workflow reports as `<caller job> / <called job>`, while `main-protect` requires the context `ci` and the audit fails on any other.

**The sandbox** [user: "a fresh sandbox repo we create just for testing", which "proves functional but otherwise doesn't really take effort"; call: the subject]: **a fortune-cookie MCP server**. A tiny read-only MCP server in TypeScript on Bun, over stdio, whose data comes from a stub HTTP service on the run's network ("the bakery") serving a fixed list of made-up fortunes. Two hand-written planning PRs, in sequence (§3.4's three levels):
1. **Planning PR 1, one work order with two pieces:** the skeleton (the server, a `health` tool, the `check` and `smoke` tasks wired to the stub), then `crack_cookie` (a random fortune and lucky numbers from the bakery, seedable so tests are repeatable). One run, one PR, two commits. Like every sandbox work order, it carries its acceptance tests (§3.5).
2. **Planning PR 2, after PR 1's factory PR merges, two independent work orders:** `search_fortunes` (fortunes by keyword) and `fortune_of_the_day` (one fortune per date, deterministic). Both start from `main`, so they exercise two runs, two PRs and the status roll-up.

It is v1's shape one level down (a skeleton, one read tool, an optional second; local stdio; smoke against a stub service, spec §15), so Plan 03 proves the path v1 takes without choosing v1's subject (H-177). Its stub is the subject-agnostic smoke sidecar the spec asks for (§15; spike T14 retargeted), reached directly on the run's internal network with its name in `NO_PROXY`, never through `egress_extra` (H-192).

**Who controls a sidecar** [call, from the builder check]: central policy, not the repo. A new `policy/sidecars.yaml` (protected) lists the allowed sidecar images, each pinned by digest, with its command and port. A repo's `.factory/config.yaml` names one by key and gives the directory its data comes from (the bakery: a fixed Bun image running the repo's `smoke/bakery.ts` over `smoke/fortunes.json`). The template's overlay makes that directory a protected path for workers, so a worker can't change the data its own smoke test checks against. The launcher starts the sidecar on the run's network before the run and removes it with the run. CI runs the same `smoke` with the same image as a service container, so the required `ci` check is evidence the worker can't touch (§3.6).

### 3.4 The poller, the mirror and the queue [spec §9.4; call: the shape]

**The poller** is ordinary host code, `hapi poll`, run by a systemd user timer as hapi, every `runs.poll_interval_s` (policy; 120 by default) [call]. `mise run up` installs the timer; `mise run down` and kill switch 3 stop it first. Each tick, for each repo in `policy/repos.yaml`:
- **Fetch the mirror**: a bare repo per registered repo in hapi's state directory, fetched with a read-only installation token passed per command (`GIT_ASKPASS` or an `http.extraHeader` in the command's environment), never stored in the mirror's config. The launcher binds the mirror as the run's source, which closes H-211.
- **New work orders:** every `.factory/work/<id>/` on `main` with no run record. A work order's key is its id plus **the merge commit that first added it** (H-183(c)'s `<merge-sha>:<work-order-id>`), so a later commit to `main` never starts it again, and one merge carrying three work orders starts three runs.
- **The queue** (H-090): one live run per repo, `runs.max_live` in all. The launcher already refuses rather than queues; the poller holds the queue and calls the launcher when the repo is free.
- **Work orders in one planning PR are independent; there is no stacking** [user, 2026-10-31, after first choosing to stack: "make sure we're well engineering, not overcomplicating"]. Dependencies are handled at three levels, each with one owner:
  1. **Inside a deliverable, dependent steps are pieces of one work order**: one run, one PR, one commit per piece, done in order in one checkout (spec §5.3: related small changes are bundled into one work order). Archon's own structure is per run; nothing in it links one run to another.
  2. **Work orders in one planning PR each start from `main`** and are mergeable on their own, so the poller never sequences them.
  3. **When one deliverable truly needs another merged first, that's sequencing between planning PRs**: Hermes holds the second planning PR until the first merges (Plan 04), since the operator's acceptance of the first often changes what the second should be. In Plan 03 the operator and the designer do it by hand (§3.3's sandbox).
  - **A plain check catches a cut that isn't independent** [call]: two work orders in one planning PR whose pieces declare overlapping files are held, both marked `Needs your decision` on the status comment, instead of run side by side. No model sizes work orders in Plan 03; in Plan 04, Hermes's planning skill may ask `decide()` a bounded, advisory question per work order (too small to stand alone, too big, quietly dependent), after the plain checks (H-231).
- **Rework:** a factory PR newly labeled `hapi:rework` **by a maintainer**. Labels alone aren't a trusted signal: the Apps' Pull requests write can add one too, so the poller reads the label event's actor and acts only for a human with at least triage permission who is not an App. The run starts on `factory/<id>`'s head with the unchanged work order and the maintainers' review comments since the last round, passed as data (spec §5.2).
- **The CodeRabbit round on the PR** (§3.6).
- **The public flag** comes from the forge's repo visibility, never from the work order (Plan 02, §3.4).
- **Caps** (§3.9): before calling the launcher, the poller checks the repo's monthly and the day's spend against policy. A run whose spend is unknown counts at its full budget.
- **Status** (§3.8): the poller writes the status events and the planning PR's comment.

The poller never retries a failed run on its own [call]: the failure shows on the status comment with its reason, and the operator re-runs it (`hapi run start --retry-of`, as in Plan 02) or changes the work order by a new planning PR.

### 3.5 A run's three containers [user: the review in a separate container, 2026-10-31; call: the split]

**Why three** [user]: the review, the gates and CodeRabbit's CLI were going to run in the worker's own container, where a compromised worker can forge their results (the threat model accepts that a worker can edit its own run's records) and read CodeRabbit's key from its parent's environment. So "Ready to merge" would have rested partly on what the worker can edit. The operator chose a separate review container. One refinement [call]: **no container that holds a key ever runs the worker's code**, since a test the worker wrote could read the key or forge the verdict. So the trusted phase is two containers, and every one of the three is a fresh Plan 02 run container started by the host:

**1. The worker container: `factory-task`.** One workflow in hapi's pack, `archon/workflows/hapi/factory-task.yaml`, no `loop:`:
- **`preflight`** (bash; no model): validate the work order against its schema; check the contract is present (`mise.toml` with `check`, and `smoke` when `verify.smoke`); scan for any mise config besides the root `mise.toml` and `mise.lock` before mise runs (H-194); check the work order's `sources` exist; check the toolchain the repo pins is in the image, offline [verify: mise in the run container with no download route; H-208]; check the sidecar answers when `verify.smoke`; and refuse a work order whose pieces would fan out (§2). Any failure ends the run before a model call, with a plain reason (anti-goal 2).
- **`implement`** (Pi, the roster's tier for the work order's `roles.implement`): the factory's fixed prompt, then the work order and its `task.md` as data. The prompt says the work order outranks a repo's interactive conventions, a blocker is written down and the run ends, nothing is ever asked of a human, and the session ends on a `RESULT:` line (H-228(a)). Pi puts a repo's `AGENTS.md` in its system prompt, above the work order, so hapi-guard also wraps it as the repo's conventions, below the work order, through Pi's context-file hooks [verify: `before_agent_start`'s `contextFiles`, or `agentsFilesOverride`, are in pi-mono's main branch; whether Pi 1.3.0 has them is unconfirmed]. On failure, one `implement-retry` at the tier's retry effort (spec §9.2). At its end the session writes **its account** (its choices, the alternatives it weighed, and the impact) to a file in `/out`: the worker's claim, which the PR fences as one (§3.7).
- **`gates`** (bash): `mise run check`, `mise run smoke` when `verify.smoke`, the file-scope check per piece, the mise-config scan again, and **the no-op check**: a run that changed none of its pieces' files, has no `RESULT:` line, or ends on a question fails (H-228(b)). These are fast feedback for the worker, and the PR calls them "reported by the run"; the trusted results come from the verify container.
- **`commit`** (bash): one commit per piece, with the trailers of spec §13.2, then the bundle (Plan 02's one-head bundle check).

**2. The verify container: no secrets, no model.** After the host has read the worker's bundle and passed its own gates (§3.6), it starts a container from the same image with **no key of any kind** in its environment. It checks out exactly the bundle's commits (from a scratch copy of the mirror holding them), installs from the bundle's lockfile itself (`bun ci --frozen-lockfile --ignore-scripts`; it never reuses the worker's `node_modules`, which could fake a result), then runs `mise run check`, `mise run smoke` against a fresh sidecar, and **the work order's acceptance tests**. **Its network** [call, 2026-10-31, while planning; flagged to the operator]: it joins the archon zone's proxy so the install can reach the package registries; it holds no key, so the zone's model APIs are useless to it. Its results are the run's evidence: the repo's own checks, run on exactly these commits, out of the worker's reach. GitHub's CI runs `check` and `smoke` a third time, independently, on the pushed head.

**Acceptance tests are the planner's** [user, 2026-10-31, on a side agent's note that verify would otherwise re-run only tests the worker wrote, which pass even when empty]. A work order carries behaviour-level tests at `.factory/work/<id>/acceptance/` (for an MCP server: an in-process client calling the tools and checking what comes back), written at planning, in the planning PR, so the operator's merge approves them. `.factory/**` is protected from workers, so the worker can't edit them, and the host's protected-path gate catches any attempt. The verify container runs them (`bun test ./.factory/work/<id>/acceptance`). With `phases.require_acceptance` (on by default; an overlay may only switch it on), "Ready to merge" needs them to exist and pass; with none, the best verdict is `Needs your decision`, and a failing one makes the PR a draft `Do not merge`. Plan 03's sandbox planning PRs carry them by hand; in Plan 04, Hermes's planning skill writes them.

**3. The review container: keys, but no repo code runs.** Also fresh, with the review model's key and, if there is one, CodeRabbit's (below). It never runs the repo's code:
- **The independent review:** a separate session, a different model, **read-only tools and no shell**, over the work order, `task.md`, the diff and the verify container's results. The Claude provider on the `anthropic` roster, with Claude Code's settings generated read-only in its `$HOME` (H-205); on a roster without a different family for review, the review's tier maps to one (a protected roster change, asked for at build time). Its output schema: a verdict (`ready`, `needs-work`, `blocked`), findings, and **each acceptance criterion of `task.md` marked met, partly met or unmet**, with evidence (anti-goal 5). Advisory: it never blocks the PR, but it leads the PR's verdict. A prompt injection in the diff can at most steer this advisory verdict.
- **CodeRabbit's CLI** [user: iterate with it locally; call: the shape, from the research], as a deterministic step: `cr review --agent --committed --base-commit <the work order's base> --gate major`. A review that didn't happen (rate-limited, skipped, failed, unreviewed files, unverified findings) is recorded as "not reviewed", never retried after the review began, and named in the PR. **Find out first** [user]: an early check settles whether CodeRabbit's free or open-source plan issues the "Agentic API key from an organization where the user has an assigned seat" unattended use needs (H-167). If none, this step ships off in policy and CodeRabbit's PR review carries its part; a seat is the operator's later decision, with H-168's data.

**The fix round.** If the review's verdict is `needs-work` or CodeRabbit blocks on critical or major findings, the host starts **one fix run**: a worker container on the run's own commits, with the findings as data (IS-7's wrapper), a disposition for each (fixed, or declined with a reason), and its own turn and spend caps. Then verify and review run again once, and the loop stops. A major finding in the fix's own change goes to the top of the PR, unfixed: CodeRabbit-driven fixes have regressed twice in hapi's own history (H-168). Minor findings are listed, not fixed.

**Every phase and round is a knob** [user: "make sure these are knobs you can tune"]: whether the verify container, the review and CodeRabbit's step run; how many fix rounds before the PR and on it; and the turn and spend caps of each round are policy settings with fail-closed defaults (all three phases on, one round each), which a repo's overlay may only tighten (§3.9).

**The budget** (H-204, H-229, H-183(a)): `enforcement.archon: hard` sets `budget.max_work_units`, a bound on nodes, and never `max_spend_usd` [call]. The paid check showed Archon's `max_spend_usd` stops the whole workflow the moment an attempt reports no cost (Run B, 2026-10-31), so a rate limit would end a run instead of letting its retry happen. Dollars are hapi-guard's `run_usd` in every Pi node, and the providers' caps. `hapi run list` shows the guard's ledger spend when Archon has none (H-229).

**The repo's overlay** (H-172): the launcher loads the repo's `.factory/config.yaml` from the merge commit, applies it (`loadOverlay`, `applyOverlay`), and generates a per-run `hapi-guard.json` from the result, bound in place of the central one.

### 3.6 The harvester and the PR [spec §9.4; user: one PR per work order; call: the mechanics]

**The harvester** is deterministic host code, run by the poller after a run is finalized. It never runs a model and never executes or interprets anything the run wrote.
- **Host gates on the bundle** (H-203), read with the host's own git and hardened flags (Plan 02's `bundleProblem`): protected paths (`effectiveModes` over the changed files, with the central policy and the repo's overlay), each piece's file scope, the size limits, and no-op. This is the boundary rule 7 is only a signal for.
- **What a failed run becomes** [call, from the builder check]:
  - **failed the host's protected-path or scope gate, or produced no diff:** never pushed (a pushed branch on a public repo runs that branch's workflows on `push`); the status comment gives the reason.
  - **failed `check`, `smoke` or an acceptance test in the verify container:** pushed and opened as a **draft PR** whose verdict is `Do not merge`, so the operator can see what was tried and send it back with `hapi:rework` or close it. GitHub refuses to merge a draft (anti-goal 4).
  - **passed those, but the review says `needs-work` or `blocked`, an acceptance criterion is unmet, a major CodeRabbit finding is still open after the fix round, or the work order has no acceptance tests while `phases.require_acceptance` is on:** a ready PR whose verdict is `Needs your decision`, with the reasons first. The review stays advisory: it shapes the verdict, never the PR's existence.
  - **passed everything:** a ready PR, `Ready to merge`.
- **The next attempt** [call]: a closed PR settles its work order. A failed run is re-run by the operator (`hapi run start --retry-of`, Plan 02) or reworked by label if it has a draft PR. A changed work order is a new work order id in a new planning PR, since merged work orders are immutable (spec §6); the old id stays settled.
- **Otherwise** it pushes `factory/<id>` with a one-hour `hapi-factory` installation token (`agent-branch-scope` lets the App push only `plan/*` and `factory/*`), opens the PR labelled `lane:factory` with the description of §3.7, adds `hapi:flagged` if a threshold was crossed, and sets `harvestedAt` (H-206). It keeps an unharvested run's volumes until the outputs are read (H-209) and revokes a minted token it couldn't deliver (H-195).

**The CodeRabbit round on the PR** [user: "the harvester also responds to the CodeRabbit PR and works with it", with turn caps; call: the shape]. This **changes spec §5.2 and AC-16**, under which a run starts only from a merge or a maintainer's rework label: it adds exactly one more start, a fix run from CodeRabbit's own review, bounded as follows.
- **Round 0** is CodeRabbit's automatic review when the PR opens. The poller confirms it by the `CodeRabbit` check run (app 347564) on the head commit finishing, not by a PR review object, which a clean incremental review doesn't post. A skipped or rate-limited review still shows a passing check, so the poller reads the check's text too, and a review that didn't happen is named in the PR.
- **Round 1** is at most one automatic fix run, on findings at major or above that weren't already declined in the run's fix round (§3.5). The findings are data (IS-7's wrapper; the "Supported by static analysis" sections stripped; no code block from a comment ever run). Its single push triggers CodeRabbit's incremental review with no mention.
- **Only CodeRabbit's own review of the head commit can start it** [user, 2026-10-31, on a side agent's note that strangers could steer such runs]. On a public repo anyone can comment on a PR and ask CodeRabbit things, and its replies come under its own name. So the round reads only root inline comments that belong to a review CodeRabbit's bot user (id 136622811, never matched by login) submitted on the PR's current head commit, carrying CodeRabbit's generated-comment marker, in threads no one else has posted in. Never its replies, its chat, a plain PR comment, or a thread a human or another bot joined.
- **Anyone else on the PR turns the round off.** A comment or review on the PR from anyone but the operator, hapi's Apps and CodeRabbit disables the automatic round for that PR; the status comment says why, and the decision is the operator's.
- **Interaction limits are off by default** [call, from the builder check]: `new-repo --collaborators-only` limits a repo's interactions to collaborators (GitHub's interaction limits, renewed at most every six months), so strangers can't comment at all, but it also blocks outside issues, against `CONTRIBUTING.md`'s welcome. Off, "anyone else on the PR turns the round off" is the defence, behind the caps and the operator's merge.
- **Then it's the operator's.** The PR loop ends after round 1's review, or sooner on: CodeRabbit paused, rate-limited or skipped; a finding raised again after a decline; a fix that would need a protected path or a scope change; the budget; or **any action of the operator's** (a comment, a label, a push, a close), which always wins.
- **Never:** an @-mention of CodeRabbit, its Fix comments or Autofix, ticking its checkboxes, replying to or resolving its threads, a force-push, or reading its green check as approval.

**The merge** [user, 2026-10-31: the operator raised merging through Hermes; designer's recommendation, accepted as "aligned"]: stays the operator's click on GitHub. No App gets merge rights, so a prompt injection in a comment, a finding or a card can't become a merge. Hermes (Plan 04) is the checkmark, not the hand: it shows the verdict and the plan's state, and records the merge after the operator makes it.

### 3.7 The factory PR's description [user: "clear choices that were made, impact"; call: the template, from the research]

The research compared Copilot's coding agent, Codex, Jules, Devin, OpenHands, Factory, Cursor and Claude Code's GitHub Action. The operator's draft (asked, built, choices with alternatives and why, impact, each check's result, cost, unresolved) already goes further than most. What it adds is a split between **what the host verified** and **what the worker claims**, and structure a re-render can't break. Top to bottom:

| # | Section | Written by |
|---|---|---|
| 1 | **Verdict:** `Ready to merge`, `Needs your decision` or `Do not merge`, with a green, yellow or red risk. It maps to the operator's three moves. | host |
| 2 | **Unresolved**, then **check this yourself**: what the run couldn't verify, the assumptions it made, unmet acceptance criteria | host, from the review and the gates |
| 3 | **Links:** the work order (k of n), "Part of #<planning PR>", its sibling PRs (independent, any merge order), the run id and trace | host |
| 4 | **Asked and built:** the work order's goal, the diff's size, a rollback note | host |
| 5 | **Evidence:** each gate with the head commit, command and result: `check`, `smoke`, scope, the host diff gate, the review's verdict, CodeRabbit's. Restated after every round | host |
| 6 | **Review rounds n of cap:** each finding fixed (commit), declined (why) or deferred | host |
| 7 | **Cost and turns**, one line | host |
| 8 | **The worker's account:** choices, alternatives, why, impact. Fenced and labelled as the worker's claim | worker (untrusted) |
| 9 | A hidden state block (`<!-- hapi:pr v1 {...} -->`): work order, status, round, head commit, verdict | host |

The host's part sits between markers (`<!-- hapi:begin -->`, `<!-- hapi:end -->`), so a re-render never overwrites what the operator adds below. The host's text has no task-list checkboxes, since the operator's tick would be overwritten. CodeRabbit writes its summary in its own walkthrough, not the PR body (already set in hapi's `.coderabbit.yaml`).

### 3.8 The status view [user: "git first"; Slack with Hermes for current work, repo docs and Linear for the overall picture]

**Where the operator looks** [user]: Slack with Hermes, day to day, for current work and state through the tools it's given; repo docs and Linear for where things stand overall. Repo docs hold the why; they don't copy run status [call].

**The source of truth** is the host: run records plus GitHub's PR state. **Plan 03 writes**:
- **status events**, one JSON line per transition (queued, preflight-failed, running, gates-failed, PR opened, CodeRabbit round, rework, merged, closed, cap-stopped), in hapi's state directory. Plan 04's Hermes and any later board read these.
- **a status comment on the planning PR**, written only by the poller with the `hapi-factory` token (Pull requests write covers issue comments, so no new permission): created once, edited in place when its content changes, one row per work order (state, run, PR, rounds, cost), the plan's total against its caps, and one final comment when the plan settles.
- **`hapi status`**, the same view in the terminal.

**The mapping, for Plan 04's Linear** [user]: a Hermes planning chat produces any number of projects or planning PRs; a Linear project (a plan ahead) holds any number of planning PRs; a planning PR produces any number of work-order PRs. In Linear a planning PR is an issue, in a project or on its own, and each work order is a sub-issue, one per factory PR. The research's cautions go with it to Plan 04: Linear's GitHub integration is a powerful writer (cancelling an issue closes its linked PRs; Diffs review actions run as the operator's GitHub user), so the board is a one-way projection written by host code with an app-actor token, and Hermes reads it through the read-only MCP endpoint (H-232).

**Hermes's Kanban** (in v0.22.5) can carry the bubble-up: a card made from a Slack thread wakes that thread when the host comments on it. Whether Plan 04 uses it is Plan 04's decision. Its dispatcher, on by default, spawns workers with full terminal access and no approval step; that was pinned off on 2026-10-31, ahead of this plan [user].

**For evals** [user: "think of how we are going to run and save our evals"]: each run's record carries what an eval needs to compare runs: the model and roster per phase, a hash of the effective policy and config, cost, turns, rounds, the verdict and the acceptance criteria's marks. Running evals and saving their results (possibly a results folder where people submit results for different models, rosters and configs) is Plan 06's, registered as H-233.

### 3.9 Caps [user: anti-goal 1; call: the levels and defaults]

Every cap is a fail-closed default in policy with a per-enforcer setting, `hard` by default (the operator's rule), and every default below is a starting point to tune [user: "config, but that's a good start"]. New keys are in protected files, so the build asks the operator's OK.

| Cap | Where | Default | What trips it does |
|---|---|---|---|
| Per run, dollars | `budgets.run_usd` (exists) | 3.00 | hapi-guard fails the node (Plan 02) |
| Per run, nodes | `factory-task`'s `max_work_units` | builder sets, from the node count | Archon refuses further nodes |
| Per repo, per month | `budgets.repo_monthly_usd` (new), central default, lowered by an overlay | 25 centrally; **15 for the sandbox** [user] | the poller starts no new run for that repo and says so on the status comment |
| Per day, all repos | `budgets.daily_usd` (new) | builder proposes | the poller starts nothing until the day turns |
| Before the PR | `gates.coderabbit` or similar (new) | 1 fix round, then verify and review once more | the loop stops; the PR says so |
| CodeRabbit, on the PR | as above | 1 automatic round | the PR is the operator's |
| CodeRabbit CLI reviews per hour | host-wide counter | the plan's limit (3 an hour on the free tier) | the round is skipped and named in the PR |
| Automatic rounds per work order [user: "limit how many turns it'll thrash against itself before waiting for a human"] | new, in policy | 3 runs with no human action between them (the first, the fix before the PR, the CodeRabbit fix on it) | the factory stops and waits for the operator; the status comment and the PR say so |
| Rework rounds | `thresholds.review_rounds` (exists) | 2 | the PR is flagged |
| Retries | none automatic | — | — |

**How spend is counted** [user: reported spend, plus the provider's limit]: the poller counts each run's reported spend (the guard's ledger and the classifiers' costs), and an unknown spend counts at the run's full budget. Reported figures are written inside the run's containers, so they catch honest runaways (loops, retries), not a compromised worker, which could report $0 or use the zone's key directly. **The hard stop no worker can get around is the provider's own limit**: the operator lowers the `hapi-factory` Anthropic Console workspace's monthly limit to about $25 while the sandbox runs (a stop-class step in the runbook; it is $100 today). The $15 covers the sandbox's end-to-end runs; a paid spike while building gets the operator's OK each time, as Plan 02's paid check did.

### 3.10 The rest of the register

Each item lands in the task that touches its file: H-218 and H-219 (the launcher's lock and finalize order), H-220 (prefix a run's lines in `watch`, and the bidi controls), H-221 (the test gaps), H-222 (wording), H-223 (rule 7's refinements, including the conditional, pipeline and option-led `cd` of H-223(b)), H-230 (the stale context after a hard stop), H-207 (a per-run proxy, still refused: the sandbox needs none), H-208 (`noexec` tmpfs: tools run through their interpreter or from the image), H-210 (a lock `down` and finalize share), H-166 and H-167 (§3.5, §3.6), H-091 and H-195 (the harvester's tokens), H-092 (the operator's merge is a bypass), H-161 (the threat-model statuses), H-182 (what may outlive a run: only the harvested commit).

### 3.11 The threat model and docs
- The threat model gains the run engine's controls as they land (H-161), and the changes this design makes: the one automatic CodeRabbit run (AC-16, spec §5.2), the label-actor check, and the poller and harvester as deterministic writers.
- A runbook for the poller and the harvester; `new-repo` in the README and a runbook; the disk-cap setup step; the sandbox walkthrough.
- `docs/policy.md` and `docs/generated-configs.md` for every new key.

## 4. Verification [user: "lgtm for the first swing"]

Plan 03 is done when, on the sandbox repo:
1. `mise run new-repo` (run by the operator) has created it with the contract, rulesets, both Apps, labels and CodeRabbit.
2. The sandbox's two planning PRs (§3.3) are merged in turn.
3. Within the poll interval, exactly one run starts per work order, with nobody touching anything.
4. Each run passes `preflight` and builds; its verify container passes `check`, `smoke` against the bakery and the work order's acceptance tests; the host's gates pass; its review container gives the review's verdict and CodeRabbit's (or names why CodeRabbit was skipped); at most one fix round runs.
5. The harvester opens one factory PR per work order, with §3.7's description and the trailers.
6. CodeRabbit's PR review starts one automatic fix run, and a rework the operator asks for by label works too.
7. Planning PR 2's status comment shows both work orders' states as their runs move.
8. The operator merges the three factory PRs, and the strict audit still passes.
9. Total spend stays under $15, and every cap that tripped along the way stopped things and said so.

Plus the plan's own tests, as before: unit tests for every new module, integration tests where Docker or git is real, and the audit's new checks.

## 5. Constraints carried from Plans 01 and 02
- **Stop-class actions** are the operator's: creating repos and Apps, repo settings and rulesets, pushes to shared branches, merges, sudo, real secrets. `new-repo` and the disk-cap setup are commands the operator runs; nothing in the factory runs them.
- **Protected paths** need the operator's explicit OK per change: here, `policy/**` (the new keys, `policy/repos.yaml`, `policy/sidecars.yaml`, the `.mcp.json` paths, and a roster's review tier), `stack/**` (the timer and the run volumes), `.github/**`, and `.coderabbit.*`.
- **Secrets** never in errors, logs, argv, PRs, comments or the repo; tokens per command, never stored in a mirror's config; no automatic fallback.
- **No personal information** in the public repo; the operator is "the operator".
- **Agents make no model calls in tests**; tests clean up only their own Docker objects and never resolve a real secret.
- **Workflows** fan out to fewer than ten agents.

## 6. Left to the builder
- The exact policy keys and schemas for the new caps, `runs.poll_interval_s`, `runs.disk` and `policy/repos.yaml`.
- `factory-task`'s YAML, its node names and `max_work_units`.
- The status comment's layout and the status event's fields.
- The template's file contents, within §3.3's lists and rules.
- How the harvester renders §3.7 (a template file in the pack).
- Labels' colours and descriptions.

## 6a. Corrections from planning research (2026-10-31)
1. **No `archon trigger fire`.** Spec §4.2 and §9.4 fire a trigger into a long-lived Archon. Plan 02 removed it; the poller calls `hapi run start`, and H-183(c)'s delivery key becomes the launcher's run key: the work order's id and the merge commit that first added it.
2. **CodeRabbit's review is confirmed by its check run, not a review object** (H-166(a)): on PR #13, its clean incremental review posted none. A skipped or rate-limited review still passes the check.
3. **The CLI's unattended key** needs a paid seat, or an open-source plan that issues one (unconfirmed, H-167).
4. **Labels aren't proof of a human** (spec §5.2): the Apps can add them. The poller checks the label event's actor.
5. **The CI wrapper pins by SHA, not tag** (spec §7 against §11.7), and its required check's name is to be verified (§3.3).
6. **The reusable-workflow call isn't covered by Actions' SHA-pinning policy or workflow lockfiles**, so the wrapper's SHA pin is the only pin; Dependabot bumps it.
7. **`bunx` downloads from npm** when a binary isn't installed (and the npm package named `tsc` isn't TypeScript), so contract tasks run tools from `node_modules/.bin`. hapi-factory's own `lint` task has the same pattern: fix it there too.
8. **GitHub's dependency graph doesn't parse `bun.lock`**, so Dependabot alerts miss transitive dependencies; OSV-Scanner is the failing vulnerability gate.

## 7. Verify early
1. Bind-backed volumes on a fixed-size filesystem under hapi's rootless Docker; `ENOSPC` fails the run without touching the data root (§3.1).
2. `gh`'s login adding a repo to an App installation (§3.2).
3. The required check's name with a reusable-workflow wrapper (§3.3).
4. mise in the run container with no download route: whether the repo's pinned tools resolve from the image (§3.5, H-208).
5. CodeRabbit's CLI in the review container, and whether its free or open-source plan issues an unattended key (H-167): its key, its egress hosts (`cli.coderabbit.ai`, `app.coderabbit.ai`, `ide.coderabbit.ai`, with WebSocket upgrades), and `--agent`'s exit codes (§3.5).
6. The Claude provider as the review in the review container, with read-only tools, no shell and its generated settings (H-205); and the verify container checking out exactly the bundle's commits with no key in its environment.
7. The poller reading a label event's actor, and CodeRabbit's check run on a head commit, with the `hapi-factory` App's token (§3.4, §3.6).
8. A systemd user timer under hapi with the stack's environment (§3.4).
9. Pi 1.3.0's context-file hooks, for wrapping a repo's `AGENTS.md` below the work order (§3.5).
10. Whether CodeRabbit lets anyone but collaborators start a review or chat on a public repo, and whether a factory PR is skipped as "bot user detected" (§3.6).
11. The MCP SDK's `serveStdio` under Bun (the sandbox's smoke settles it).

## 8. Settled with the operator after the builder check (2026-10-31)
1. **Isolation:** the review and CodeRabbit run outside the worker's container [user]; the split into a keyless verify container and a review container that runs no repo code is the designer's [call] (§3.5).
2. **Dependencies:** no stacking; pieces inside a work order, independent work orders, Hermes sequencing planning PRs [user] (§3.4).
3. **Spend:** reported spend, plus the operator lowering the Console workspace's limit while the sandbox runs [user] (§3.9).
4. **CodeRabbit's CLI key:** find out first; off in policy if the free plan issues none [user] (§3.5).
5. **Acceptance tests** written at planning and required for "Ready to merge" [user, after approval, on a side agent's note] (§3.5); and the verify container joining the archon zone's proxy, with no keys, to install from the lockfile [call, flagged] (§3.5).
6. **The builder check's other three questions** became calls: where a smoke sidecar is defined (§3.3), what a failed run becomes and what starts the next attempt (§3.6), and interaction limits off by default (§3.6).
