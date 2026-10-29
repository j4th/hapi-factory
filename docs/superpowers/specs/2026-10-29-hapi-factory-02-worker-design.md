# hapi-factory Plan 02: the worker — design

- **Date:** 2026-10-29
- **Status:** draft for review
- **Owner:** the operator
- **Parent spec:** [2026-10-26-hapi-factory-design.md](2026-10-26-hapi-factory-design.md) (the "spec" below). This document narrows it for Plan 02 and, where it says so, changes it. Where the two disagree, this one wins for Plan 02, and Plan 02 adds an "As built" note to the spec at each place it changes.
- **Register:** the "## Plan 02 Worker" section of [handoffs.md](../plans/handoffs.md) (H-087, H-088, H-089, H-152, H-181, H-182, H-184, H-196, H-197). Each item is pulled into a plan task; where this document changes an item, the change is said here and in the register.
- **Plan sequence:** Plan 01's table ([foundations plan](../plans/2026-10-26-hapi-factory-01-foundations.md), "Plan sequence"): Plan 02 produces `decide(name, state)` and hapi-guard, for Plans 03–07.

Tags, as in the spec: **[user]** decided by the operator in the Plan 02 brainstorm (2026-10-29); **[call]** the designer's call, open to override; **[verify]** a fact the builder confirms early, before depending on it.

---

## 1. Intent

A Pi worker that runs safely inside Archon, where **nothing the worker writes outlives its run except the commit it produced** (spec DS-17, threat L4.10). Plan 02 is the containment and guard layer the run engine (Plan 03) stands on. It is not the run engine.

**Why now:** today no Pi node can run in the stack at all (spike T8: Pi can't write its directory, H-181(a)). And spike T8 plus this brainstorm found that the long-lived Archon container gives a worker more reach than the spec assumed:
- Archon's API on `127.0.0.1:3090` needs no login on a loopback-only install, and its trusted identity header is accepted from any local client (Archon docs, "API Reference > Authentication", fetched 2026-10-29). Pi's shell runs in that container, so a poisoned worker could approve its own paused steps, start or cancel runs and read other runs, over HTTP or through the run database, which it can write as the same user.
- `$HOME` (`archon-home`) and `/.archon` (`archon-data`) are persistent volumes, so a planted `~/.gitconfig`, Bun cache entry or worktree file reaches later runs (H-182).

**How the operator wants it built** [user]: fast and properly, security first. No extra "try it" work; the plan's own verification is the demo.

## 2. Goals, non-goals, anti-goals

### Goals
1. **A fresh container for every run** (§3.1), so per-run isolation holds by construction rather than by cleanup.
2. **hapi-guard**, Pi's only user extension (§3.3): protected paths, the run budget, the token clamp, the `.pi/`/`.agents/` backstop, the `drop_block` check, trace context, a decision log, and the Jev level-6 gates.
3. **`decide()`** (§3.4): the one helper every Jev decision goes through, with the vendored ten-levels client and mock, decision files, the Haiku fallback and the `hapi decide` CLI.
4. **A live view out of the run** (§3.2), one way: information leaves the run container; nothing reaches back in.
5. **Every limit configurable per enforcer, fail-closed by default** (§3.5) [user].
6. The rest of the Plan 02 register, the audit and the threat model brought up to date (§3.6, §3.7).

### Non-goals for Plan 02
- The `factory-task` workflow pack, the poller, the mirror, the harvester, the scope and protected-path diff gates, the independent review, `metrics.json` (Plan 03).
- Anything Hermes-side (Plan 04), the repo contract (Plan 05), evals (Plan 06).
- A web UI for runs (§3.2: registered for the optional observability profile, spec §13.4).
- A per-run egress proxy (§3.1, "egress_extra").
- Separating the worker's shell from the Archon process by uid, namespace or microVM (spec §11.3, "Next level"); the run container is the boundary.
- An option for hapi-guard to inject `drop_block` itself for a model that lacks it (§3.3; refused instead).
- **Resuming a failed run** [user]: dropped. A failed run starts over from the same work order and merge commit, as a restarted one already does (the operator's 2026-10-28 ruling, H-161), so no run state is kept for a retry to pick up. The cost is paying again for the steps that had passed, which the budget bounds. Resume is registered to reconsider later, with the observability work.
- **Pi sub-agents** [call]: Pi 1.3.0 ships none by design (its README: it "skips features like sub-agents and plan mode"); they come only from extensions or packages, and the spec already skips community sub-agent packages (§9.3). With hapi-guard the only extension and `PI_OFFLINE=1`, a worker can't load one. Parallel work stays Archon's fan-out, decided in code from the work order's pieces (spec §5.4), where every child is its own guarded Pi session. A one-level sub-agent tool inside hapi-guard (the child gets a cheaper model, keeps the guard, and has no sub-agent tool of its own, as Pi's own durable example does) is registered for when evals show a need.

### Anti-goals: failure even if it technically works
- An enforcer that evaluates globs differently from `src/policy/paths.ts` (H-087, H-089): any difference loosens policy.
- Anything from one run reaching a later run: files, caches, config, sessions, database rows.
- Host-side code that executes, sources or interprets anything a run produced, or runs git with a run's config.
- A secret value in an error, log, argv, transcript, event or the repo.
- A silent fallback or a fail-open default.
- An unpinned download inside the run container (H-181(c)).
- Sending a suspected credential to an outside service to ask whether it is one (§3.4).

## 3. Design

### 3.1 The run container [user: one container per run; call: its shape]

**Replaces the long-lived `archon` service.** `mise run up` keeps `egress-archon` (and the other zones) running; it no longer starts an `archon` container, and the `archon-home` and `archon-data` volumes go away. Removing the old volumes on the real host is an operator step in the plan's rollout (a stop-class action: the operator runs it).

**The launcher:** `hapi run start` (run as hapi, on the host) starts one hardened, one-shot Archon container for one run and returns at once with a run id. Plan 03's poller calls the same launcher. `hapi run stop <id>` stops one. Run containers carry a label, so `mise run down` and kill switch 3 (docs/runbooks/kill-switches.md) stop them too; the runbook is updated to say so.
- Inside, the container runs `archon workflow run` in the foreground with no server (`archon serve` is never started), then exits. So no Archon API exists for a worker to reach (AC-13 gets stronger; AC-16's "can't answer approvals" holds for the run's own process only, see §4).
- **Inputs:** a validated work order and a read-only source repository to clone from. In Plan 02 the source is a local repository the caller names; in Plan 03 it is the mirror. The launcher validates the work order on the host (`validateWorkOrder`) before starting anything. It binds the central `hapi-guard.json`; Plan 03 binds a per-run one generated from the repo's overlay instead (H-172).
- **How many runs, and which** [call]: with no Archon server there is no `archon trigger fire`, `overlap: queue` or trigger receipt (H-183(c)), so the launcher takes their place on the host:
  - **One live run per repo** (spec §4.4, H-090): the launcher holds a per-repo lock and refuses a second run for a repo with one live. Queueing is the caller's job: Plan 03's poller keeps the per-repo queue and calls the launcher when the repo is free.
  - **A global cap,** `runs.max_live` in policy, default **1**, so the host's memory (each run container may take 4g) and the spend stay bounded; a run past the cap is refused, not queued.
  - **No duplicates:** a run is keyed by its work-order id and source commit; the launcher refuses a key it has already started, which makes a re-fire safe as trigger receipts did.
  - **Its own network:** each run gets its own internal network, with `egress-archon` connected to it for the run's life, so two live runs (once the cap allows them) can't reach each other or each other's smoke sidecars. The proxy already refuses local destinations (`to_localnet`, DS-5), so it can't bridge them.
  - **Time:** the launcher stops a run that passes its work order's `budget.minutes` and records it as timed out.
  - **Pauses:** v1 uses no Archon approval nodes (spec §9.2, "Not used in v1"), and with no server nothing could answer one without writing into the run, so a run that pauses is failed.
- **`egress_extra`** [call]: the launcher refuses a work order with a non-empty `egress_extra`, with an error saying it isn't supported yet. v1 needs none (the worker needs no egress beyond model APIs, spec §15), and refusing leaves no runtime path that could bypass `emitEgress`/`checkedHosts`, which is what H-088 asks. A per-run proxy built from `emitEgress` is registered for the first plan that needs it.
- **Outputs:** one per-run output directory on the host, the only writable bind mount, holding exactly what may leave the run: a git bundle of the run's commits, the Archon run transcript, the guard's decision log and a small machine-readable result (status, run ids, spend). Plan 03's harvester reads only these.

**Everything else in the container dies with it:**
- `$HOME` is a tmpfs. Into it, read-only: a generated `~/.gitconfig`; generated Claude Code settings (no hooks, no plugins, telemetry off unless `otel.enabled`), for Plan 03's Claude-provider review node; a global `.bunfig.toml` that turns Bun's auto-install off (H-181(c)); and the home-scoped workflow pack (Plan 02 ships only its own check workflows; Plan 03 ships `factory-task`). Package caches (Bun, npm, uv) live in the tmpfs, so they start empty every run.
- `PI_CODING_AGENT_DIR` is a tmpfs (`size=64m,uid=1001,gid=1001,mode=0700`) with `models.json`, `hapi-guard.json`, `extensions/` and an empty `settings.json` bound read-only into it (H-181(a), as spike T8 ran it). Pi writes only its cache and sessions there.
- `/.archon` (Archon's run database, workspaces and worktrees) is per-run storage that is deleted with the container: a tmpfs or an anonymous volume, the builder's choice by size. The generated `config.yaml` is bound read-only over it.
- The image's root stays read-only, with the hardening anchor (DS-6), uid 1001, the `archon-net` network and the archon zone's env file, as today.

**Git inside the run** [call]:
- Every git process in the container gets `core.hooksPath=/dev/null` and `core.fsmonitor=false`, plus the other settings that make git run a program, through git's environment config (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`, which outranks the repo's `.git/config`), set by the launcher so no worker step can unset it for Archon's own git commands. `GIT_CONFIG_NOSYSTEM=1`, and `GIT_CONFIG_GLOBAL` points at the read-only generated `~/.gitconfig`. [verify] the exact list against the pinned git's docs, including `safe.directory` for the read-only source mount.
- The clone's `.git/config` is created fresh per run, so a write to it can't reach a later run. hapi-guard still refuses `**/.git/**` (H-182, H-191).

**Host side** [call]: the host treats the output directory as untrusted data. It reads the bundle only with its own git and hardened flags (`git bundle verify`, then a fetch into a clean repository), never runs git inside anything the run wrote, and never sources or executes a file from it. Plan 03's diff and scope gates run on the host against the bundle, after the run, not inside the container, so a planted hook or a late edit inside the run can't change what was checked. (Registered for Plan 03.)

### 3.2 The live view [user: bubble the live view out; call: how]

- `hapi run watch <id>` follows a run's transcript from the host while it runs (Archon's `workflow logs --follow --format text` semantics: it stays attached across pauses and ends when the run does), then prints the result.
- **One way:** it reads; it never writes to the run, answers a pause or calls Archon. No port is published (AC-13).
- **Untrusted text:** it strips terminal control and escape sequences before printing, and shows nothing the guard has marked as a secret.
- **A web UI** comes with the optional observability profile (spec §13.4), whose event bridge turns Archon's run events into spans for Phoenix. Registered for that profile (spec phase 3), not built in Plan 02. Plan 02's guard events (§3.3) use the work order's `traceparent`, so they join those traces later.
- `hapi run list` shows the runs the host knows (from the output directories). This also answers H-198 more simply than it was posed: the host already knows every run, so `hapi-status` can read host-side run records instead of reaching into Archon. H-198 is updated, not closed; it stays Plan 04's.

### 3.3 hapi-guard [spec §9.3; register H-087, H-089, H-181(b)(d), H-184]

**Packaging** [call]: written in TypeScript in this repo, bundled into one self-contained file with no imports left to resolve (so Bun has nothing to fetch, H-181(c)), generated into `build/pi/extensions/` and bound read-only into the run container. It reuses `src/policy/paths.ts` itself, bundled in, so it can't drift from the policy's matcher, and it passes `tests/policy/paths.test.ts`'s vectors (H-087, H-089). The audit's `generated.drift` covers the bundle.

**Inputs:** `hapi-guard.json` (from `src/generate/pi.ts`, extended), and the work order file the launcher binds read-only (its id and `traceparent`; Archon's `extensionFlags` can't carry them, spec §9.3).

**Rules, deterministic, no model call:**
1. **Protected paths:** a `write` or `edit` whose resolved path is protected for `workers` (strictest mode across every matching glob, after normalization and resolving symlinks, then relativizing to the worktree) is blocked with a reason. A write outside the run's worktree is blocked too, except under `/tmp`. [verify] each file tool's input shape on Pi 1.3.0 (T8 saw `write`'s absolute `input.path` and `input.content`).
2. **The backstop** (H-181(d)): at `session_start`, if the working directory holds `.pi/` or `.agents/`, the guard throws, which fails the node (T8 finding 5). It can't stop a repo extension's import-time code; Plan 03's strip is the prevention.
3. **The budget** (§3.5): the limit is the lower of the work order's `budget.usd` and the policy's `run_usd`, and an override can only lower it. The guard sums the session's usage, plus the cost of its own classifier calls (§3.4), and stops the run when its total reaches the limit. In hard mode (the default) it throws from the hook that sees the crossing, which fails the node; a request that would start after the limit is refused before it is sent. The run's total across Pi nodes is kept in the Archon process's memory, not in a file the shell could edit [verify that Pi keeps extension state across sessions in one process; if not, a file in the tmpfs with the residual noted]. Archon's `max_spend_usd` and the provider caps stay as the second and third lines (spike T10).
4. **The token clamp:** `before_provider_request` caps `max_tokens` at the policy value (64000) and keeps prompt caching on.
5. **`drop_block`** (H-184): the generator refuses a roster whose Anthropic model doesn't resolve with `compat.supportsMidConvoEffort` under hapi's `models.json` (a test, plus the audit), so the flag is set for every Anthropic model hapi runs. Refusing is the only behaviour in Plan 02; a guard-injected flag is out of scope (§2).
6. **Secrets in writes** (the write gate's deterministic half, §3.4): content written by `write`/`edit`, and a `bash` command's text, are checked for the exact values of the secrets in the zone's environment and for known key formats; a match is blocked, and the decision log records the secret's name, never its value.
7. **Shell commands:** a best-effort check blocks `bash` commands that plainly write to a protected path (redirections, `tee`, `rm`, `mv`, `cp`, `sed -i`, `git config` and the like naming one). It can be got around (an interpreter one-liner), so it is a signal and an early stop, not a boundary; the boundary for protected files is the host-side diff gate (§3.1).
8. **The shell's environment** [call]: where Pi's API allows it without replacing its `bash` tool wholesale, the worker's shell runs without the model and Jev keys in its environment, which keeps them out of casual output (`env`, error dumps, the transcript). It isn't a boundary: the shell can still read its parent process's environment. [verify] Pi 1.3.0's bash tool options; if it can't be done cleanly, register it and say so in the threat model.

**Then the level-6 gates (spec §9.5),** layered after the rules above and never instead of them. Each asks its question through `decide()`, so `jev.enabled` only picks who answers (Jev, or the Haiku classifier), as the spec's fallback order says; it doesn't turn the gates off. Each gate has its own on/off setting (§3.5).
- **The bash gate:** is this command's intent irreversible or destructive? Block above the bar. It screens every `bash` call by default.
- **The result screen:** does this tool output carry instructions? Wrap it as quoted data with a banner (never drop it). It screens the output of `bash` and `read` by default, security first; the set of tools is a setting.
- **The write gate** changes from the spec [call]: its credential check is rule 6 above, run locally, and the content is never sent to Jev or the fallback classifier. Asking an outside model "is this a key?" leaks the key if it is one.
- **What a gate sends:** only what its question needs (ten-levels rule 8), capped in size by a setting, and first stripped of the exact secret values rule 6 knows.
- **Cost and failure:** every classifier call's cost counts toward the run's budget (rule 3), and every fallback is logged and flags the run, never silent. A gate whose classifiers all fail takes its decision file's default, fail-closed (block, or wrap). A policy that leaves a gate on with no classifier at all (`jev.enabled: false` with `fallback: none`) fails to load; turning a gate off is said explicitly instead.

**Events:** every decision (rule or gate, allow or block, with the reason, the work-order id and the trace context) is appended to the decision log in the output directory, as JSON lines. OTel spans come later with the observability profile; Plan 02 only keeps the fields they need.

**Archon config** (H-181(b), H-152): the generated `config.yaml` sets `assistants.pi.enableExtensions: true` explicitly, and the audit's `tools.archon-validate` reads it back, since Archon 0.12.1 ignores an unknown or misspelled top-level key without a word.

### 3.4 `decide()` and Jev [spec §9.5]

As the spec's contract, with these Plan 02 specifics:
- **The client and mock** are vendored from `disler/ten-levels-of-jev` (MIT, its single commit as of 2026-09-27) with the license and the source commit recorded; nothing is fetched at build or run time.
- **Decision files** live in `policy/decisions/<name>.ts`, one per decision, holding its questions, thresholds (floor and bar), the fallback default and which way the default fails. Plan 02 writes the three level-6 gates' files (bash gate, result screen; the write gate's file records that its credential check is local). Later plans add theirs.
- **The fallback order** as the spec and `policy/flags.yaml` (`jev: { enabled, fallback: haiku }`): Jev, then a Haiku 5.5 classifier asked the same typed question, then the decision file's default. Each gate's default is fail-closed (block, or wrap for the result screen) unless its decision file says otherwise (§3.5).
- **The key** is `HAPI_JEV_OPENROUTER_API_KEY`, never `OPENROUTER_API_KEY` (DP-8).
- **Data boundary** [call on enforcement]: Jev stays acceptable for public repos only until H-128 and H-072 are answered (H-040). The launcher's caller says whether the repo is public (the poller, from the forge on the host, in Plan 03; the operator, by a flag, in Plan 02); the work order, which a model wrote, never can. A repo not marked public gets no Jev calls at all: its gates use the Haiku classifier, which adds no new recipient, since the worker's own model calls already go to Anthropic.
- **The Jev key's daily limit** ($0.06, docs/runbooks/provider-keys.md) can run out within a run; then `decide()` falls back to Haiku as on any Jev error, logged and flagged as above.
- **`hapi decide <name>`** takes the state as a file or on stdin, never in argv, and prints the decision as JSON. Plan 02 builds it as a self-contained program, bundled the same way as the guard, and tests it on the host. Shipping it into the Hermes image, with a Jev key of the Hermes zone's own (spec §11.5: one key per role), is Plan 04's (registered), since the Hermes container can reach neither the host nor the archon zone.
- **Every call is recorded** (question, answer, probability, confidence, latency, cost, fallback used) in the decision log, for Plan 06's calibration.
- [verify] that the archon zone's proxy reaches `openrouter.ai` from inside the guard (it is on the zone's list in `policy/trusted_sources.yaml`) and that the bundled client honours `HTTPS_PROXY`.

### 3.5 Limits are per-enforcer config [user]

The operator's rule, for every limit and gate: a sane, fail-closed default, and a setting per enforcement point, in `policy/`.
- **The budget:** `policy/budgets.yaml` gains a mode per enforcer for `run_usd`: hapi-guard `hard` and Archon `hard` by default; either can be set to `soft`, where crossing it flags the run (spec §13.3's `thresholds.run_usd`) instead of stopping it. For example, a user who accepts a run going over can make it soft in Pi and keep Archon hard.
- **Jev gates:** each decision file states its floor, its bar and which way it fails; policy turns each gate on or off, sets which tools the result screen covers and caps what a gate sends.
- **Runs:** `runs.max_live` (default 1) and the output-directory retention.
- The schema, the generators, the audit and docs/policy.md change together; a policy that leaves every enforcer soft loads, but the audit reports it.

### 3.6 The rest of the register

- **H-196:** `mise run audit` (and the `secrets:*` tasks) get hapi's `~/.local/bin` on `PATH` the way `up` does, and the stack runbook's troubleshooting table says what the error means.
- **H-197, adapted:** there is no long-lived Archon container to inspect, so the read-only checks move to the run container's definition and to the integration test. The audit requires the tmpfs (size, uid, mode) and each bound file read-only in the generated run definition; the integration test starts a run container with a bash-only check workflow (no model call) and probes the tmpfs as writable and `models.json` as `EROFS`. docs/audit.md (`runtime.archon-env`, `generated.drift`'s note) and DS-11 follow.
- **H-152:** the read-back for `assistants` (§3.3).
- **H-088:** satisfied by refusing `egress_extra` (§3.1).
- **H-089:** the guard's glob dialect is the policy's (§3.3).
- **H-090 and H-183(c)** are updated for the launcher (§3.1): the per-repo queue stays Plan 03's, in the poller, and the launcher's lock, cap and run key replace `trigger fire`'s receipts and `overlap: queue`.
- **H-182's Plan 03 half** shrinks: no reused worktrees and no cross-run sharing under `archon-data` exist any more. What stays for Plan 03: the read-only workflow pack and the host-side gates on the bundle.

### 3.7 Docs and the threat model

- The spec gets an "As built (noted <date>, H-NNN)" note at §5.3 and §9.1 #6 (no resume: a failed run starts over), §9.2 (hardening: no server, no web console), §9.3 (the Pi directory, the guard as built), §9.5 (the write gate's local credential check, and how the public-repo rule is enforced) and §11.3 (one container per run is now the baseline).
- `docs/security/threat-model.md`: DS-11, DS-15, DS-16, DS-17, IS-9 and AC-13 change status or wording; L4.10 gains the per-run container. New residuals:
  - a worker can tamper with its own run's Archon database and the guard's fallbacks in its own container (it can't reach another run);
  - the shell can read its parent's environment (rule 8);
  - the shell can call the model APIs itself with the zone's keys (with `curl`, or a script that loads the Pi SDK Archon ships), outside Pi's session and so outside the guard's budget; only the provider caps and the zone's egress list bound it. Registered as later hardening: a model gateway that adds the key at the egress, so no model key enters the run container.
- `docs/policy.md` names Plan 02's guard beside Plan 04's (H-087). A runbook covers `hapi run start|watch|list|stop` and the operator's paid check. docs/runbooks/stack.md and kill-switches.md follow the service change.

## 4. Verification

- **Unit tests, no model calls:** the guard's rules against Pi's extension API with test contexts, including the glob vectors; `decide()` on the vendored mock; the generators and the audit checks; the launcher's argument building and refusals.
- **Integration tests, no model calls:** a bash-only check workflow in a real run container proves the mounts, the tmpfs, the git hardening (a planted `core.hooksPath` or `core.fsmonitor` in the clone's config never runs), Bun's auto-install being off, the bundle and transcript export, `watch`, `stop` and `down`. Tests clean up only their own Docker objects and never resolve a real secrets store.
- **One paid check** [user], run by the operator as hapi from their own terminal at the end of the plan, against the live stack: one Haiku 5.5 Pi node that (a) is asked to write a protected file and is blocked, (b) runs with a tiny `run_usd` override so the budget stops it on its first request, and (c) makes one Jev bash-gate call, for which the operator marks the check's synthetic repo public. Expected cost: a few cents. The plan gives the operator complete, pasteable commands.

## 5. Constraints carried from Plan 01

- Protected paths need the operator's explicit OK for each change: `stack/**` (the compose change), `policy/**` (budgets, decision files), `mise.toml`/`mise.lock` (any new tool), `.github/**`.
- Pins stay exact: Archon 0.12.1 and Pi 1.3.0; anything vendored records its source commit and license.
- Secrets never in errors, logs, argv or the repo; no automatic secret fallback; fail closed.
- Commits only when the operator asks, staged by explicit path; personal strings checked before any push; PRs from a `plan/**` branch.
- TDD for every behaviour change.

## 6. Left to the builder

- Whether the launcher drives `docker compose run` against a profile-only service (keeping the hardening anchor and env file in one place) or builds `docker run` arguments itself; the exact mount points and label names.
- Tmpfs or anonymous volume for `/.archon`, by measured size.
- How Archon is given the clone as a codebase with a remote (spike T8 finding 8: worktree mode needs one), and whether runs use worktree mode at all inside a single-run container.
- How `watch` follows the transcript (the output mount, or `docker logs` of the foreground run), as long as it stays one-way.
- The decision log's exact fields, the bundler, and how the guard is tested against Pi's API.
- Output-directory retention: a fail-closed default (keep until harvested, then a set number of days), as a setting.

## 6a. Corrections from planning research (2026-10-29)

Read-only research for the plan, in the pinned image and upstream sources at their pinned tags, changed how some of §3 is built, not what it is for. Where this list and §3 disagree, this list wins. Each item is settled by the plan's spikes before anything depends on it.

1. **A repo's own `.archon/` reconfigures a run before any node runs.** Archon merges `<cwd>/.archon/config.yaml` over the global config (it can set `assistants.pi.enableExtensions: false`, rebind tiers and aliases, add node env and repo `worktree.postCreate` commands), and a repo's `.archon/workflows/<file>.yaml` overrides a home-scoped workflow of the same file name. So the strip covers `.archon/` as well as `.pi/` and `.agents/`, and it runs in the launcher's fixed prelude, before `archon workflow run` starts, not in a workflow node: the clone is checked out sparse, without those three root directories, so a later commit doesn't record them as deleted. H-161's strip moves from Plan 03 to Plan 02. The launcher also passes Archon's strict `--config` run layer, which pins `assistants.pi.enableExtensions: true` and `workflows.autoResumeOnQuotaReset: false` over anything a repo says.
2. **`/.archon/.env` and the process cwd's `.archon/.env` are loaded with override at every Archon CLI start.** The launcher binds an empty read-only `/.archon/.env`, and the CLI's process cwd is always `/app`, never the clone.
3. **Archon's home-scoped workflows live in `/.archon/workflows/`** when `ARCHON_DOCKER=true`, not in `$HOME`. Plan 02's check workflows are bound read-only at `/.archon/workflows/hapi/`.
4. **The image's entrypoint always starts the server.** The run container overrides `--entrypoint` with the fixed prelude, which does the entrypoint's other useful steps itself (the workspace dirs, `CLAUDE_BIN_PATH`).
5. **Bun's global `.bunfig.toml` does not turn runtime auto-install off** on Bun 1.4.2, nor does a global security scanner. `BUN_OPTIONS=--no-install` in the run container's environment does, for every `bun` and `bunx` from any directory. `npx` and `uvx` are explicit downloads it doesn't cover: an in-run residual bounded by the zone's egress list, registered.
6. **Each Pi node runs in a fresh `bun` process,** so the guard's run total can't live in memory. It lives in a ledger file in the container's tmpfs, which the worker can edit: a residual (§3.7), behind Archon's `max_spend_usd` and the provider caps.
7. **A guard that fails to load fails open:** Pi records the load error and Archon never reads it. So the guard's factory never throws (bad settings register handlers that fail the node at `session_start`), and the host fails a run in which any Pi node attempt left no `session_start` record in the decision log.
8. **A throw from `tool_call` blocks the call but doesn't fail the node.** The budget's hard stop throws from `before_provider_headers` (which every request fires, compaction summaries included) and from `turn_end`.
9. **Pi's directory is writable and later nodes read it:** a planted `models-store.json` can change a model's cost, `compat` or `baseUrl`, and planted `AGENTS.md`, `SYSTEM.md` or `bin/` there reach later nodes. hapi's `models.json` pins each roster model's cost, `compat.supportsMidConvoEffort` and `maxTokens` through `modelOverrides` (applied last), and the provider's `baseUrl`; the guard checks the resolved model and the outgoing payload, and fails the node if Pi's directory holds anything but hapi's files and Pi's own cache and sessions.
10. **The guard can't replace Archon's `bash` tool, and a tool an extension registers ignores `allowed_tools`.** The guard registers no tools, and keeps keys out of the shell by deleting them from `process.env` in its factory, after copying out what its own classifiers need (rule 8).
11. **The output directory.** Under rootless Docker the run's uid maps to a host uid hapi can't delete files of, so nothing is bind-mounted writable from the host: the run writes its outputs to a per-run volume, and the host copies each expected file out through a fresh helper container (read-only mount, no network), one known name at a time with a size cap, into a hapi-owned directory.
12. **`docker run`, not `docker compose run`:** Compose's `run` can't give a run its own network or tmpfs mounts, and `compose down` never stops a `docker run` container. The `archon` service stays in `stack/compose.yaml` as a profile-only service, the reviewed source of the image, user, limits and environment; the launcher builds `docker run` arguments from it and refuses any key it doesn't translate. `mise run down` and kill switch 3 stop run containers by label first.
13. **The git hardening's limits.** git's environment config outranks a repo's `.git/config` and `include.path` for single-valued keys, so `core.hooksPath=/dev/null`, `core.fsmonitor=false` and the other settings that run a program hold for Archon's own git. Name-indexed drivers (`filter.<name>.*`, `diff.<name>.textconv`, `merge.<name>.driver`) and the first-wins `remote.<name>.uploadpack` can't be neutralised that way: an in-run residual (same uid, same container), with the host-side checks on the bundle as the boundary. A `safe.directory` grant for the read-only source must be in the generated `~/.gitconfig` and name `<source>/.git`, since git's local transport doesn't pass env grants to `upload-pack`.
14. **A paused run exits 0,** so the launcher reads the run's status from Archon, never the exit code alone.
15. **Claude Code's settings move to Plan 03** [call]. Plan 02 runs no Claude-provider node, so settings for one couldn't be tested here, and the tmpfs `$HOME` already gives the property H-182 asks for: nothing a run writes there persists. Plan 03 generates them, read-only, with the review node that uses them.
16. **Fresh volumes need chowning.** A named volume mounted at a path the image lacks has a root-owned root, so the launcher chowns each run volume to uid 1001 with a one-shot helper before the run starts.

## 7. Verify early

1. Pi 1.3.0 keeps an extension's module state across the Pi sessions of one Archon process (§3.3 rule 3).
2. Pi 1.3.0's file tools' and `bash`'s input shapes, and whether the bash tool's environment can be set from an extension (§3.3 rules 1, 7, 8).
3. `archon workflow run` in a fresh container: codebase registration, the database location, and that nothing in it needs the server.
4. git's environment config outranks a planted `.git/config` for hooks and fsmonitor on the pinned git, and the full list of settings that run programs.
5. Bun's global `.bunfig.toml` (or its security-scanner setting) turns auto-install off for every `bun` the container runs, wherever it starts.
6. The guard's bundled Jev client reaches `openrouter.ai` through the zone's proxy.
