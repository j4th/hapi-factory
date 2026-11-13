# Runbook: the run engine

This runbook covers the run engine Plan 03 builds (design: [the run engine's design](../superpowers/specs/2026-10-31-hapi-factory-03-run-engine-design.md), §3.0 to §3.9): what it does with a merged work order, from the poller's tick to the factory PR you merge, rework or close, and what to do when it stops. Its parts:

- [what the engine does](#what-the-engine-does), in nine lines;
- [the poller](#the-poller): its timer, a tick, its lock, its journal, and a tick by hand;
- [the pipeline](#the-pipeline): the work order's phases, the caps' texts, the CodeRabbit round on the PR, rework by label, the operator's actions, a failed work order and `hapi retry`, and a work order that stops its repo's tick;
- [acceptance tests and the verify container](#acceptance-tests-and-the-verify-container);
- [the harvester](#the-harvester): the host gates on a run's bundle, the four verdicts, the decision models, the never-forced push and `harvestedAt`;
- [the factory PR](#the-factory-pr): its nine parts, its markers, and what the harvester reads to write it;
- [the verdicts](#the-verdicts), and your three moves;
- [decisions](#decisions): what the harvester asks a classifier, what an answer can do, the knobs, the ledger and the spend;
- [the status comment, `hapi status` and `events.jsonl`](#the-status-comment-hapi-status-and-eventsjsonl);
- [the caps](#the-caps), in one table;
- [stopping everything](#stopping-everything);
- [troubleshooting](#troubleshooting);
- [end to end on the sandbox](#end-to-end-on-the-sandbox): Task 16's live run on `hapi-sandbox-fortune`, step by step, with what to paste back and when to stop, the planning PRs' files in full, and the record.

Every command below that runs as hapi is run on the host, from your own terminal, in [runs.md's form](runs.md#how-to-run-the-commands): one fixed script handed to hapi's `sh`, with your words as its arguments. hapi's engine state is under `~hapi/.local/state/hapi/engine/` (the engine dir).

## What the engine does

1. You merge a planning PR (`lane:planning`) whose `.factory/work/<id>/` holds one or more work orders.
2. The poller, a systemd user timer as hapi, fetches the repo's bare mirror and takes up each newly merged work order: `queued`, or `held` when two of one merge overlap.
3. One work order at a time per repo, a worker run (Pi, in a container of its own with the archon zone's keys and no forge route) implements it from the merge commit, one commit per piece.
4. The harvester, deterministic host code, checks the run's bundle on the host: protected paths, scope, sizes, trailers and a secret scan.
5. A verify container with no key installs from the lockfile and runs `check`, `smoke` and the planner's acceptance tests on the bundle's head.
6. A review container (its own keys, no repo code) runs the independent review, and CodeRabbit's CLI when it is on; findings at major or above get one fix run, then verify and review once more.
7. The harvester asks its advisory decisions about the diff, pushes `factory/<id>` (never forced) and opens one PR (`lane:factory`) with a verdict and the evidence.
8. The PR waits for you: merge, `hapi:rework` or close. Nothing merges on its own. With `flags.coderabbit.enabled` on (it ships off: [the CodeRabbit round](#the-coderabbit-round)), CodeRabbit's review of the PR comes first, and at most one automatic fix round after it.
9. The planning PR's status comment, `hapi status` and `events.jsonl` show every step; caps bound every run, and a failed work order waits for your `hapi retry`.

## The poller

`hapi poll --once` is one tick (`src/engine/poll.ts`). Two systemd user units, generated into `build/systemd/` ([the units](../generated-configs.md#buildsystemd)), run it as hapi: `mise run up` links and starts `hapi-poll.timer` ([the stack runbook](stack.md#4-mise-run-up-and-mise-run-down), its step 7), and `mise run down` and [kill switch 3](kill-switches.md#3-stop-the-stack) stop it first. The first tick runs `runs.poll_interval_s` (120 s; 30 to 3600, central only) after the timer starts, then one that long after each tick starts. Under the dev bypass no timer is installed: run each tick by hand ([below](#a-tick-by-hand)).

**A tick:**

1. takes **the poll lock**, keyed by the engine dir: one tick at a time, and `hapi retry` takes it too, so only its holder writes a work order's state or `events.jsonl`. A tick that finds it held skips (`poll: another tick holds the poll lock`, exit 0);
2. reaps every run whose container has exited, so a run is finalized before the tick reads it;
3. for each repo `policy/repos.yaml` registers, in sorted order and each on its own (one repo's failure never touches another's):
   - fetches the repo's [mirror](runs.md#the-mirror) with a read-only token minted for this tick alone;
   - finds each work order newly merged on `main` ([discovery](runs.md#discovery): a `.factory/work/<id>/` with no state yet, keyed by its id and the merge commit that first added it, so a later commit never starts it again), and gives it a state: `queued`, or `held` when its pieces overlap another of the same merge;
   - moves one pipeline per repo ([the pipeline](#the-pipeline)): every work order with a PR, each tick; then the one active work order with no PR; if there is none, the head of the queue (the oldest `cap-stopped`, else the oldest `queued`). Each step is taken under that work order's own lock, and a held lock leaves it for the next tick (`<id> waiting: <the lock's holder>`);
   - writes each planning PR's [status comment](#the-status-comment-hapi-status-and-eventsjsonl), asking GitHub only when it must change;
   - revokes every token it minted.

**The work orders it can't read** (a work-order file that fails its check or is over `runs.work_order_kb`, or an overlay the central policy now refuses) are kept to themselves: each is a journal line, `<repo>: can't run <the file and why>`, and a row of the status comment's "Can't run" table, and the work order waits. Fix a work-order file in a new planning PR. An overlay is read at the work order's own merge, so no later planning PR reaches it: revert or narrow the central change, or close the work order's PR (until H-296, such a work order never settles on its own). **A repo's tick that fails** (a forge or git error, a rate limit, an expired token, a state file hapi didn't write, a harvest that throws) fails closed: it writes nothing for the work order it was on, the journal says `<repo>: failed closed: <error>; the next tick retries`, the service exits 1 (as it does when the tick's reap fails, `poll: <why>`), and the other repos go on. One work order that fails the same way every tick stops its repo's later ones: [when one work order stops its repo's tick](#when-one-work-order-stops-its-repos-tick).

**The timer and the journal**, as hapi:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" PATH="$HOME/.local/bin:$PATH"; \
  systemctl --user list-timers hapi-poll.timer --no-pager; \
  journalctl --user -u hapi-poll.service -n 50 --no-pager'
```

Each tick writes a line per repo: what it created, moved or left waiting, and which comments it wrote, or `nothing to do`. The audit's [`runtime.poller-timer`](../audit.md#runtimepoller-timer) fails while the stack is up and the timer isn't active.

### A tick by hand

As hapi; the poll lock keeps it apart from the timer's:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- poll --once'
```

It prints the tick's lines and exits 1 when a repo's tick failed closed, else 0 (a skipped tick included). `hapi poll` without `--once` ticks every `runs.poll_interval_s` until stopped; the timer is the normal way.

## The pipeline

The state machine (`src/engine/pipeline.ts`, `advance`) moves each work order one step at a time, from its merge to a settled phase. Its state is one file per work order, `<engineDir>/orders/<owner>/<name>/<id>.json` (0600, written whole by temp and rename), and the poller writes it only once a step has succeeded, so a crash leaves the last good state. Each step makes at most one transition and starts at most one run, and its one status event goes to `events.jsonl` after the state is written. A crash between a run's start and the state's write is resumed without a second run: the next step adopts a run of the work order's current pass that its state doesn't list (an engine run of this repo, this pass, keyed at the merge or naming the pass's worker as its parent), and every step looks for its run by key before it starts one. A replayed harvest finds the PR it opened and edits it; on a PR, a branch already at the head that harvest pushes is the factory's own push (the write after it failed, or a crash), never read as the operator's move, and isn't pushed again. Each source run's head is kept once its host gates pass (`<engineDir>/heads/<owner>/<name>/<id>.json`), so a verify or review a cap blocked starts on it later without running the gates again, as long as the work order's scratch still holds that commit (else the entry goes and the gates run again on the bundle); one the gates now refuse holds with their details. A stray file under `<engineDir>/orders/` where an owner or repo directory belongs is skipped, never a failed tick. Every time is compared as an instant, since GitHub writes whole seconds and the host milliseconds.

**Decisions never route a phase or start a run.** A decision's hold reaches only the verdict and the reasons, through the harvester's outcome; it never turns the CodeRabbit round off or starts a fix, and every re-render of the PR keeps it ([Decisions](#decisions)).

### The phases

| Phase | Waits for | What moves it | The status comment shows |
|---|---|---|---|
| `held` | the operator | nothing: two work orders of one planning PR whose pieces overlap (H-243(a)) | **Needs your decision**, with the overlap |
| `queued` | its repo's turn: no other work order of the repo running before its PR, none queued ahead of it | its worker starts at the merge, from the mirror; a cap that refuses it moves it to `cap-stopped` | queued |
| `cap-stopped` | the month or the day to turn, or the cap to rise | the worker starts once the caps allow (each tick tries) | the cap's text |
| `worker` | the worker run | succeeded and its gates pass: `verify` (or `review`, or `harvest`, when those phases are off); failed or timed out: `failed`; stopped: `failed`; its gates refuse it: `failed` | the run |
| `verify` | the verify run on the head (no model key; budget 0) | nothing failed: `review` (or `harvest` with review off); check, smoke or the acceptance tests failed, or no readable `verify.json`: `harvest` (a draft); stopped: `failed`, or `waiting` with a PR | the run |
| `review` | the review run of the head | before the PR, `needs-work` or a CLI finding at major or above, with fewer than `phases.fix_rounds_before_pr` fixes in this pass: `fix`; otherwise, and always once a PR exists: `harvest`; stopped: `failed`, or `waiting` with a PR | the run |
| `fix` | a fix run: before the PR, the automatic fix (its round the pass's next); with a PR, a maintainer's rework | succeeded and its gates pass: `verify`, round k; failed, timed out or refused by its gates: `harvest` with no PR (the worker's head, or the last that passed; the fix's reason goes on the PR), `waiting` with one; stopped: `failed`, or `waiting` with a PR | the run |
| `harvest` | nothing | the harvester's PR: `pr`; no PR (nothing it could push): `failed` | the verdict |
| `pr` | nothing | a draft (**Do not merge**): `waiting` (CodeRabbit doesn't review drafts); `pr-review` when `flags.coderabbit.enabled` (off centrally), fewer than `phases.fix_rounds_on_pr` rounds have run on the PR, no human has acted on it and no rework has run; otherwise `waiting` | the PR and its verdict |
| `pr-review` | CodeRabbit's review of the head the factory pushed | findings at major or above: `pr-fix`; nothing found: `waiting`; paused, skipped, rate-limited, or no review within six polls (`6 × runs.poll_interval_s`): `waiting` with **Needs your decision** and the reason, on the PR too | the PR |
| `pr-fix` | the automatic fix run on the PR's head, from CodeRabbit's findings | as `fix`, with the PR: `verify`, or `waiting` with `round <k>'s fix run ended <status>: <reason>; the PR is unchanged` or `round <k>'s fix run was refused by the host gates: <details>; the PR is unchanged` | the run |
| `waiting` | the operator: a merge, a close or a `hapi:rework` label | merged: `merged`; closed: `closed`; a maintainer's `hapi:rework`: `fix` (a rework), up to `runs.max_rework_rounds` | the PR, and why it waits |
| `failed` | the operator's `hapi retry` | nothing on its own (below) | the reason |
| `merged`, `closed` | nothing | settled; the work order's pin in the mirror is dropped | the PR |

**A `cap-stopped` work order heads its repo's queue.** The tick tries the oldest `cap-stopped` one before any `queued` one, so every queued work order of that repo waits behind it until its cap clears, at the month's or the day's turn, or when the cap is raised (H-243(d)).

**`failed`**, before any PR exists: a worker that failed, timed out or was stopped; host gates that refused its bundle; a harvest with nothing it could push; or any later run of it that was stopped. A `hapi run stop` that reaches a live run ends the work order's automatic work, even past the run's deadline (the stop outranks it): `failed` with no PR, `waiting` with one (`round <k>'s <kind> run ended stopped: …; the PR is unchanged`). Nothing more is pushed or started for it, but a maintainer's `hapi:rework` label on its PR still starts a rework. A stop that comes after the run has ended changes nothing ([runs.md](runs.md#hapi-run-stop)), and a run that ended `timed-out` is routed as one that failed. The poller never retries on its own: `hapi retry <owner>/<name> <id>` queues a failed work order with no PR again, at most `runs.max_retries` times (2), for a fresh pass from the worker at the same merge commit, whose run keys name the retry (`worker:0:retry1`, `review:0:retry1`, …), so it never reuses the failed pass's runs, and a worker that succeeded doesn't block it. Each pass's runs still count toward the repo's month. [A failed work order](#a-failed-work-order) says when and how to retry it, and [Troubleshooting](#troubleshooting) what to do with each reason.

**Rounds and stages.** The worker is round 0 and the pass's k-th fix is round k; a verify or review takes the round of the head it checks. Every run's parent is the pass's worker. A fix that started before the pass's first harvest is `before the PR`; after it, the newest ones up to the rework count are `rework` and the rest `on the PR`. The PR's "Review rounds" lists the current pass's only.

**What each run is given.** The worker starts on the merge commit from the mirror. Verify, review and fixes start from the harvester's scratch copy on the head: with no PR, the head of the pass's newest worker or fix whose gates passed; with a PR, the newest fix's own. A rework starts from the mirror on the PR's head. A verify gets no inputs (its source holds the bundle's commits). A review gets `diff.patch` (the diff from the merge, read with hardened git) and `verify.json` (the verify run's, copied); its base is `run.json`'s `base`. A fix gets `findings.md` alone: one IS-7 block per item (the review's findings and its criteria not met, the CLI's major and critical findings, CodeRabbit's PR comments, or for a rework the maintainers' comments since the last round), quoted as data, never instructions. An inputs copy over `runs.inputs_mb` (16 MiB) is refused, never truncated: the work order fails, or waits with a PR. Before a PR that failure is deterministic: the same work order gives the same inputs, so `hapi retry` can't get past it; plan the work again, smaller. A worker's budget is the order's, at most `budgets.run_usd`; a review's or fix's the order's, at most `phases.round_usd`; a verify's 0.

### The caps' texts

[The caps](#the-caps) has every cap in one table. Before every run it starts (a worker, a verify, a review, a fix, a rework, a retry's), the poller checks, in order:

1. **The repo's month**, `budgets.repo_monthly_usd` (an overlay may lower it): `this month's spend on <repo> ($<spent>) plus the run's budget ($<budget>) would pass budgets.repo_monthly_usd ($<cap>): no new run for it until <the 1st of next month>`.
2. **The day**, `budgets.daily_usd` (central only): `today's spend ($<spent>) plus the run's budget ($<budget>) would pass budgets.daily_usd ($<cap>): nothing new starts until <tomorrow> (UTC)`.
3. **The automatic rounds**, `runs.max_auto_rounds` (3), for a worker or an automatic fix: `<n> automatic runs since the last human action (runs.max_auto_rounds: <n>): waiting for the operator`.
4. **The rework rounds**, `runs.max_rework_rounds` (3, central only), before a rework: `<n> rework rounds on #<pr> (runs.max_rework_rounds: <n>): close the PR, or plan the work again under a new work order id`. The PR waits, **Needs your decision**, and its body says so (anti-goal 1).

The month and the day are UTC calendar ones, by each run's `startedAt`. The month sums every run the repo's work orders list, every pass's, its name compared in any case; the day sums every run record, hand runs too. Each run counts its reported spend, or its whole budget when that isn't known (a live run; a run that left no spend total at all, such as one the guard failed before any model call, or a verify run, whose budget is $0; or a ledger the run wrote that doesn't add up), and decision spend counts with the runs' (each work order's decision ledger, an unanswered call at `unknown_call_usd`). A run's record is kept until its month is over, because the monthly cap reads it ([runs.md, Retention](runs.md#retention)). With `budgets.enforcement.poller: hard` (the default) a cap refuses the run: a queued work order goes to `cap-stopped`, and a verify or review stays in its phase with the reason, starting once the cap clears; a refused fix leaves the work order where it was, to try again. With `soft` the run starts, its event carries the text, and its PR is flagged `hapi:flagged` (once there is one; the reason is kept until then). The round caps are always hard, whatever `budgets.enforcement.poller` says (ruling m38): an automatic fix the round cap refuses goes to the harvest before the PR (its reason on the PR), and to `waiting` on it. The count restarts at any human action (a comment, a label, a push, a review, a rework, a retry).

### The CodeRabbit round

**It ships off** (`flags.coderabbit.enabled: false` in `policy/flags.yaml`, central only). `hapi-factory[bot]` opens every factory PR, and under a paid plan CodeRabbit reviews a PR an App opened only when the App's bot holds a seat of its own, which its Team Management assigns by hand. Without one it answers `Review skipped: bot user not eligible for review`, and with the round on every factory PR waited at **Needs your decision** (`CodeRabbit did not review <h7>: …`; seen on the sandbox, 2026-11-11, H-312). CodeRabbit's review of a work order is then its CLI's, in the review run ([runs.md, The factory workflows](runs.md#the-factory-workflows); `runs.phases.coderabbit`), where a critical or major finding starts the fix round before the PR. To have the round on the PR as well, give the bot a seat and set the flag `true`.

The flag is the engine's whole reading of CodeRabbit on a PR. Off, the engine takes nothing from CodeRabbit there: it reads no `CodeRabbit` check run and none of its comments, a rework takes in none of its findings whatever `include_in_rework` says, and a comment on the PR, the operator's or anyone's, has no round to turn off and leaves the verdict as it was. Central policy is read at each tick, so a work order already in `pr-review` when the flag goes off moves to `waiting` at its next tick, with nothing read; a fix run the round had already started finishes.

The one automatic round on a PR (design §3.6) starts only from CodeRabbit's own review of the head commit the factory pushed:

- the head counts as reviewed only when CodeRabbit's check run (`CodeRabbit`, App 347564) on it is completed, `success` and titled `Finished…`; any other title (`Review paused`, `Review skipped`, `Rate limited`) is named (`CodeRabbit did not review <h7>: <title>`) and fails closed;
- a finding is a root review comment (never a reply) by CodeRabbit's bot user (id 136622811, never matched by login), on the head commit, in a review CodeRabbit submitted on that commit, starting with its generated-comment marker, whose severity is Critical or Major, in a thread no one else has replied in; its "Supported by static analysis" sections are stripped. The severity is the word of the comment's first bold span, with any HTML in the span left out: CodeRabbit writes `**Major** · **<category>**`, and since 2026-11 an icon before the word (`**<picture>…</picture> Major**`; H-309). Bold text further down, such as a note's `**IMPORTANT**`, is never the severity. With no finding at major or above, a comment whose first bold span names none of CodeRabbit's severities (Critical, Major, Minor, Trivial, Info) is not taken for a clean review: the work order waits with `CodeRabbit left <n> comments on <h7> whose severity hapi could not read: read them on the PR`;
- check runs are read with the `checks` token, reviews and comments with the `pr` token.

**What turns it off:** a draft PR; `flags.coderabbit.enabled: false`; `phases.fix_rounds_on_pr` used up; any human action on the PR or a rework so far; and a comment or review from anyone but the operator, hapi's Apps (`hapi-factory[bot]`, `hapi-planner[bot]`) and CodeRabbit (`<login> commented on #<n>, so the automatic CodeRabbit round is off: the PR is the operator's`, or `user <id> reviewed #<n>, …` for a review, which carries no login). The PR's round doesn't yet drop a finding the fix before the PR declined (H-277).

### Rework by label

A `hapi:rework` label on a factory PR in `waiting` starts a rework when a human added it: `type: User`, not through an App, no `[bot]` login, with at least triage permission on the repo, after the work order's newest worker or fix run started, and not taken off since. The rework is a fix run on the PR's head, from the mirror, with the unchanged work order and, as data, each issue comment since that run by a maintainer (triage or above) and each review comment by the operator; with `flags.coderabbit.enabled` and `flags.coderabbit.include_in_rework` both on, CodeRabbit's findings on the head too (`enabled` ships off, so as shipped a rework reads none of them: [the CodeRabbit round](#the-coderabbit-round)). It is the operator's: it counts no automatic round, restarts the count, and its harvest pushes on top of the PR (never over a branch that moved since). To ask for another rework after it, take the label off and add it again. **Post your comments first, then add the label:** the rework is given the comments there are when it starts, at the next tick, so a comment posted after that isn't in it (it is in the next rework's). At most `runs.max_rework_rounds` (3) reworks run on one PR; past it the label starts nothing, and the PR waits with the cap's text. A third rework crosses `flags.thresholds.review_rounds` (2), so its PR is flagged `hapi:flagged`. A label on a PR still in its automatic round stops the round first (`waiting`), and the rework starts on the next tick.

### The operator always wins

At the top of every step with a PR:

1. A merged PR settles the work order `merged`, a closed one `closed`.
2. The operator's actions since the last one the state recorded (comments and labels by the repo owner's login, as a User and not through an App; reviews by the user id those show; a head the factory didn't push) set `lastHumanAt` and restart the automatic-round count.
3. In an automatic chain (a PR and no rework yet), an action, a pending rework request or anyone else on the PR moves it to `waiting`, **Needs your decision**, with the reason: `the operator acted on #<n> (<what>): the automatic CodeRabbit round is off`, or, during the automatic fix round, `the operator acted during the automatic fix round (<what>): its result is not pushed`. That holds while the round's verify or review waits to start too (a cap or `runs.max_live` refused it): nothing more of the round starts, and the refusal gives way to the operator's reason. A live fix run is left to end under its own caps, and its result is never harvested (H-278). A harvest replayed after its push (a crash or a failed write lost the state) says `its result was pushed before the operator acted: nothing more is pushed` instead.
4. Only `waiting` takes the PR's head as the factory's, so a moved head is reported once.

**What counts as an operator action:** a comment or a label by the repo owner's login, as a User and not through an App (one whose time GitHub gives in a form that doesn't parse counts, timed now); a review by that user (by its user id); and a push to `factory/<id>` the factory didn't make. A `hapi:rework` label and a `hapi retry` are human actions too: each restarts the automatic-round count. A comment or review by anyone else (a maintainer included) isn't an operator action, but it turns the automatic CodeRabbit round off, since the PR is then the operator's.

**Your own commits on `factory/<id>` must carry the six trailers.** `ci / gates` checks every commit on a `factory/**` branch for them (H-113), yours included, and main-protect has no bypass: a commit without them, such as the merge commit GitHub's **Update branch** or **Resolve conflicts** makes, leaves the PR unmergeable. Commit a change of your own locally with them (`git commit --trailer "Work-Order: <id>" --trailer "Hapi-Run: <a run id>" --trailer "Hapi-Lane: factory" --trailer "Trace-Id: <id>" --trailer "Agent: <you>" --trailer "Model: none"`), resolve a conflict locally and add them to the merge commit (`git commit --amend --no-edit --trailer …`), or close the PR and land the change yourself. A gate rule for the operator's own commits is H-295 (Plan 05).

**The PR's body is re-rendered**, from the scratch and the ledger as the harvester builds it (the screens re-read from the ledger, so it asks, spends and pushes nothing), in two cases:

- the PR moves to `waiting` with a reason: the reason goes under Unresolved, and the verdict is **Needs your decision** at best;
- in `pr-review` or `waiting`, `ci / gates` completes on the head (**Ready to merge** shows only once it is green), or a reason of the state's isn't on the PR yet. This one touches only a body that still has the host's markers.

A re-render waits while a run of the work order is live (the host gates it re-runs write the scratch) and happens on a later tick in `pr-review` or `waiting`. It needs a verify or review run of the PR's head to find the run that made it (with both phases off, the newest worker or fix whose gates give that head); a head the factory didn't push (the operator's) isn't re-rendered.

### A failed work order

A work order becomes `failed` only before it has a PR ([the phases](#the-phases)): its worker failed, timed out or was stopped; the host gates refused its bundle; its harvest had nothing it could push; a review's or fix's inputs were over `runs.inputs_mb`; or a later run of it was stopped. The reason is in `hapi status` and on the status comment. The poller never retries one on its own. If the cause was outside the work order ([Troubleshooting](#troubleshooting) has the list), fix it, then queue a fresh pass from your own terminal, with the repo's name and the work order's id:

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && mise run hapi -- retry "$1" "$2" && \
  mise run hapi -- status "$1"' \
  hapi-retry "$OWNER/<name>" <work-order-id>
```

`hapi retry` reads hapi's local state and the central policy alone: no git, no token, no GitHub or Docker call. It refuses, naming why:

- a repo `policy/repos.yaml` doesn't register: `<repo> isn't registered in policy/repos.yaml`;
- a registered repo with no state for that work order: ``<repo> has no work order <id>: `hapi status <repo>` lists them``;
- a work order that isn't failed: `work order <id> is <phase>, not failed: only a failed work order is retried (docs/runbooks/engine.md, Troubleshooting)`;
- one with a PR: `work order <id> has PR #<n>: a PR is reworked with the hapi:rework label, not retried`;
- one already retried `runs.max_retries` times (2; central only, always hard, and 0 turns `hapi retry` off): `work order <id> has been retried <n> times, and runs.max_retries is <n>: plan the work again under a new work order id`;
- while a tick holds the poll lock: `…: run hapi retry again when the tick ends`.

**When it starts.** The retry puts the work order at the back of its repo's queue and says how many are ahead of it (`hapi retry: <repo> <id> is queued again (retry <n>), with <k> of the repo's work orders ahead of it: …`). A tick starts its worker at the same merge commit, from the mirror, once no work order of that repo is running before its PR, none is queued ahead of it, and the caps allow. A cap that trips makes it `cap-stopped`, which starts on its own when the cap clears, perhaps at the month's turn. A queued retry can't be withdrawn (H-243(e)). The new pass's runs have keys of their own (`worker:0:retry1`, `review:0:retry1`, …), so it reuses none of the failed pass's. `hapi status` shows `retry <n>` in the Rounds cell, and every later event of the work order carries `retry`. Every pass spends under the same caps, and its runs count toward the repo's month and the day: at most `runs.max_retries` passes after the first. The retry is a human action, so the automatic-round count restarts.

### When one work order stops its repo's tick

[The poller](#the-poller) says what a tick does, and [Troubleshooting](#troubleshooting) links here. The poller fails a repo's tick closed at the first error it can't keep to one work order: a forge or git error, a state or record file hapi didn't write, a harvest that throws. It writes nothing for that work order, and the next tick tries again. So a work order whose step throws the same way every tick (a poison pill) stops that repo's later work orders and its status comments, tick after tick, while the other repos go on. The tick's line in the journal names it: `<repo>: failed closed: <error>; the next tick retries` (`journalctl --user -u hapi-poll.service`, as hapi). A work order that can't be read, an overlay the central policy now refuses, and a held lock are kept to their work order: the first two are a "Can't run" problem, the last is `<id> waiting: <the lock's holder>`. Fix the cause the line names, and the next tick goes on from where the work order was.

## Acceptance tests and the verify container

- **The planner's acceptance tests.** The planner writes behaviour-level tests for each work order at `.factory/work/<id>/acceptance/`, in the planning PR, beside its `order.yaml` and `task.md`, and your merge of the planning PR approves them. `.factory/**` is protected from workers (`workers: deny`), so the host's protected-path gate refuses any change a run makes to them ([the host gates](#the-host-gates)): the worker can't weaken the tests it is judged by.
- **The verify container** (`factory-verify`; the verify profile in `src/run/kinds.ts`) holds no key of any kind and gets no inputs dir. Its source is the harvester's scratch copy of the mirror, which holds the bundle's commits, and its `/work` is a fresh volume, so it never reuses the worker's `node_modules`, which could fake a result. It joins `egress-archon` only so it can install from the bundle's `bun.lock` with `bun ci --frozen-lockfile --ignore-scripts` (the template's `setup`: no install script runs). Only the package registries on that allowlist matter: the zone's model APIs are no use without a key.
- **What it runs**, in order, each step's exit code kept: CI's mise-config scan, the install, `mise run check`, `mise run smoke` (when the work order's `verify.smoke` is true), and `bun test ./.factory/work/<id>/acceptance` with a junit report (when that directory exists).
- **`verify.json`**, written last, is `{ check: { exit, tail }, smoke: { exit, tail } | null, acceptance: { exit, tail } | null }`: `null` means not run, or no acceptance tests. A tail is the step's last 40 lines, untrusted text the harvester doesn't use. [What the harvester reads](#what-the-harvester-reads) has the exact rules, and [the four verdicts](#the-four-verdicts) the four signals that must agree before verify passes.
- **`runs.phases.require_acceptance`** is on by default, and an overlay may only switch it on: **Ready to merge** then needs the acceptance tests to exist and pass ([the verdicts](#the-verdicts)).

Two limits stand ([the threat model](../security/threat-model.md#plan-03-the-run-engine)): the change's own code runs in the verify container and could write its own results (H-251), so in-run verify is a pre-filter, and CI's `ci / gates` on the pushed head is the run the worker can't touch; and the acceptance tests are only as strong as the planner wrote them, with your merge of the planning PR their only review.

## The harvester

The harvester (`src/engine/harvest.ts`) is deterministic host code the poller runs once a work order's runs have ended: the latest worker or fix run whose gates pass, and the verify and review runs of its head. It reads every phase's outputs as data and never executes, sources or follows them. It runs no generative model. It mints no token: it uses the tick's, which the poller revokes. It moves no phase: the state machine does that with what it returns (the PR, its head, the verdict and the reasons).

### The host gates

Before anything is pushed, the harvester checks the run's `run.bundle` with the host's own git, hardened (no system or global config, no hooks, no fsmonitor, `env -i`), in a scratch copy of the mirror it owns, `<engineDir>/scratch/<owner>/<name>/<id>.git`. This is the boundary; the guard's rules in the run are only a signal for it. In order, each failure with its text:

**The host's git is the OS's package, not a pin** (2.43.0 when Plan 03 was built; gitleaks is pinned, git isn't). Every host read of the scratch sets its attribute source to git's empty tree, because git's own defaults change between versions: 2.43 reads a bare repository's `HEAD:.gitattributes`, 2.56 doesn't (PR #15's CI found it). After an OS update changes git's version, run `mise run test` in hapi's checkout before the next run: the suite runs the host gates on the host's git.

| Gate | Fails when | Its text |
|---|---|---|
| bundle | the bundle doesn't list exactly one head, `HEAD` | `run.bundle: <the problem>`, e.g. ``run.bundle: unexpected refs in run.bundle: `refs/heads/extra` `` |
| size | it is over `runs.output_limits_mb.bundle` | `run.bundle is <n> MiB, over runs.output_limits_mb.bundle (<cap> MiB)` |
| bundle | its prerequisites aren't in the mirror (`git bundle verify`) | `run.bundle does not apply to the mirror (git bundle verify exited <n>)` |
| bundle | its head doesn't descend from the run's base commit | `the run's head <h7> does not descend from <b7>` |
| bundle | a new commit is a merge; its author or committer isn't the run container's generated identity (`hapi-factory worker`, `src/generate/archon.ts`); its raw headers hold more than tree, parent, author and committer; or its trailers aren't exactly the six factory-task's commit node writes, each once, with the values the host knows (`Work-Order: <id>`, `Hapi-Run: <run id>`, `Hapi-Lane: factory`, `Trace-Id: <the work order's trace id>`, and an `Agent` and a `Model`), and no other (a `Co-authored-by` credits someone else) | `commit <h7> is a merge: …`, ``commit <h7>'s author is `<who>`, not the generated worker identity …``, ``commit <h7> has a header beyond tree, parent, author and committer: `<key>` ``, ``commit <h7> has a trailer beyond the commit node's six: `<key>` ``, `commit <h7> has the trailer <Key> <n> times: …` or `commit <h7> lacks the trailer <Key>: <value>` |
| no-diff | the run changed no file | `the run changed no file (<b7>..<h7> is empty)` |
| protected | a changed file's mode for workers isn't `allow` (`effectiveModes`, the central policy with the repo's overlay): `.factory/**` among them, so the planner's acceptance tests too | `` `<path>` is a protected path (workers: deny)`` |
| scope | a changed file matches no piece's `files` glob, matched case-sensitively as the run's own git pathspecs are (a scope grants, so ignoring case would let more through) | `` `<path>` is outside every piece's files`` |
| secret | the secret scan finds something (below) | e.g. `` `src/a.ts` holds ANTHROPIC_API_KEY's value``, `the header of commit <h7> holds …`, ``gitleaks: <rule> in `<path>` (commit <h7>)`` |

Paths, ref names and anything else a run chose are shown redacted, in a code span (never live Markdown: no link, no `#123` cross-reference), without terminal control characters, `@`, `<`, `>` or backticks, at most 120 characters; at most 20 problems per gate, then `… and <n> more`. The identity, header and trailer checks are the host's re-check of what the run committed: the commit node's own checks run where the worker's code ran, and the worker can write the clone's git config (a `committer.name`, a `trailer.<t>.command`), so the host reads the commits themselves. A commit that fails them is dropped from the scratch, as an unscanned one is.

**The secret scan** reads every new commit of the bundle, not just the final diff, since a value a later commit removes is still in what would be pushed:

- **gitleaks 8.30.1** (mise.toml's pin; any other version on `PATH` fails the scan), over `<base>..<head>` in the scratch, with its default rules and the gates workflow's hardening: every path read as text (no `.gitattributes` from the tree, `* diff` for every path), merges' own diffs, no rename detection, no `.mailmap`, no submodule config. A git that fails or writes to stderr when run as gitleaks runs it, an error or a warning in gitleaks's log (but its findings count), or 0 commits scanned fails the scan closed;
- **both zones' exact values** (the archon and review zones), raw and base64-encoded (at any alignment), in every patch (`git log -p --format=`, so its output holds no header or message), and in each commit whole, read from its object (`git rev-list` over the range, then one `git cat-file --batch` read by its byte lengths, never by searching for a marker): its raw header, every line before the first empty one (the committer, any extra header and every continuation line included), and its message;
- **every changed path's name**, in every new commit, trees included (`-t`, so an empty subtree's name is read), for the same values and for each `KEY_PATTERNS` format, and the headers and messages for `KEY_PATTERNS` too: a worker can read its own key and commit it, in a file's content, its name, a git config value the commit records, or an extra header.

A hit is a `secret` problem, so nothing is pushed. Encodings beyond base64 are a residual (the threat model).

**The added-line signals** are not gates. Each changed file's added lines, read from its own `git diff -U0 --text` (one per file of the `-z` list, so a name git quotes, or an added line that looks like a `+++ b/…` header, is never misread), are matched for what a string match finds: a skipped test (`.skip(`, `.todo(`, `.only(`), an always-true assertion (`expect(true)`), a `NODE_ENV` test against `"test"`, `process.exit`, `process.kill`, a `TODO` or `FIXME`, a write naming `verify.json`, `/out` or `/.archon`, a read of `/proc`, a module patched at load (`mock.module`, `Bun.plugin`), and a changed `bunfig.toml` (which can preload code into `bun test`). Each is a "check this yourself" line on the PR naming the file. None changes the verdict.

**The scratch is private while it holds what nobody has scanned.** Before the bundle's commits come in, the scratch is made 0700, so no other uid (a run container's) can read it. From that fetch on, every way out of the gates but a clean secret scan drops the run's commits again: its ref, the reflogs, and every object no ref reaches (`update-ref -d`, reflog expiry, `repack -a -d`, `prune`). That covers a secret found, and a run refused before its scan (a head that doesn't descend from the base, an empty diff whose commit message could still hold a key, a git failure), so nothing unscanned stays in the host's copy. After a clean scan the scratch is compacted too (reflog expiry, `repack -a -d`, `prune`), so an object a bundle carried that no ref reaches, which no scan reads, doesn't stay either. Only then (a clean scan and the compaction, or the drop) is the scratch made readable by all again (dirs `a+rx`, files `a+r`), as the mirror is, because a verify, review or fix run starts from it. No run of the work order is live during its harvest (one pipeline per repo), so the lock-out stops nothing. If a drop, the compaction or the reopening fails, the harvest fails closed with that step's error (the original one as its cause), and the scratch stays private. A crash between the fetch and the drop leaves that run's commits behind (H-276). A push GitHub refuses (`[remote rejected]`: its push protection may have found what the host's scan didn't) drops the run's commits too.

### The four verdicts

With the gates passed, the harvester reads the evidence and settles a verdict, in the design's order (§3.6):

| Verdict | When | What it lets you do |
|---|---|---|
| (no PR) | a host gate refused the bundle, or it had no diff | Nothing is pushed: a pushed branch on a public repo runs that branch's workflows. The status comment gives the reasons; retry the work order (`hapi retry`), or write a new one. |
| **Do not merge** (red), a draft PR | `check`, `smoke` or the acceptance tests failed in the verify container, or verify left no readable `verify.json` | See what was tried, then send it back with `hapi:rework` or close it. GitHub refuses to merge a draft. |
| **Needs your decision** (yellow) | the review says `needs-work` or `blocked`, an acceptance criterion is partly met or unmet, the review marked none, a major or critical CodeRabbit finding is open (severities read without regard to case), its CLI failed its gate with no such finding read, there is no review, the review or verify is off, the work order has no acceptance tests while `runs.phases.require_acceptance` is on, verify's signals disagree, the worker ended blocked, no-change, with no `RESULT:` line, on a question or with no final message, or a decision holds a file | Read the reasons first, at the top of the PR; merge, rework or close it. |
| **Ready to merge** (green) | everything passed, and `ci / gates` is green on the head | Merge it. Until `ci / gates` is green the PR shows **Waiting for `ci / gates`**. |

**Verify passes only when four signals agree:** Archon's status for the verify run is `completed`, its container's recorded exit code is 0, `verify.json` reads all passed, and the acceptance junit (`acceptance.junit.xml`) is complete: it counts tests, lists as many test cases as it counts, none failed or skipped, and has, for each planner test file at the merge, at least as many test cases as that file's static count (its `test(` and `it(` calls at a line's start, at least 1; a lower bound, since `test.each` and loops add more), so a planner test that silently didn't run shows. The change's own code runs in the verify container and could write its own results (H-251), so any disagreement is **Needs your decision** (`verify: <why>`), never a pass. A failure verify.json reports is a failure.

**The acceptance tests** are the planner's: `.factory/work/<id>/acceptance/`, written at planning and approved by the planning PR's merge. `.factory/**` is protected from workers, so the protected-path gate refuses any change to them. The verify container runs them (`bun test ./.factory/work/<id>/acceptance`). With `runs.phases.require_acceptance` on (the default; an overlay may only switch it on), a work order without them is at best **Needs your decision**. A failing one makes the PR a draft **Do not merge**, whether or not `require_acceptance` is on.

### The decision models

Before it settles the verdict of a head it will push, the harvester asks `decide()`'s advisory diff screen about each changed file (`policy/decisions/diff-screen.ts`), after the host gates and the secret scan, and only once the PR lookup has settled the push: never for a refused bundle, a closed PR, a moved branch, or a ready PR whose new head failed check. Each call is written to the work order's decision ledger before it is made, and each answer before it is used. An answer can only hold back **Ready to merge** (a reason under Unresolved) or add a note under "Check this yourself"; it never changes the push or the draft, and a file no classifier answered holds too. `gates.decisions.mode: off` turns the decision models off, and the PR, the status comment and the run records say so. [Decisions](#decisions) has what it asks, the knobs, the ledger and the spend, and [docs/policy.md, "Running without decision models"](../policy.md#running-without-decision-models) the recipe for running with none.

### The push and `harvestedAt`

- **Never forced.** The harvester pushes the head to `factory/<id>` with `git push` and no `+`, `--force` or `-f`, over https alone (`GIT_ALLOW_PROTOCOL=https`), the push token only in the git process's environment (never argv, a URL or a config file). A push git rejects as not a fast-forward (`[rejected] (non-fast-forward)` or `(fetch first)`) is never retried with force: the verdict is **Needs your decision** with `factory/<id> moved on GitHub (not a fast-forward): not overwritten; the run's head <h7> was not pushed`. GitHub's own refusal (`[remote rejected]`: push protection, a ruleset) is **Needs your decision** with `GitHub refused the push to factory/<id>: <its reason>`; any other failure fails the tick closed. Before it pushes, it also checks the PR's head is the one the factory pushed last: one moved since is `factory/<id> moved to <h7> since the factory pushed <h7>: not overwritten; the run's head <h7> was not pushed`, and nothing is pushed. A ready PR is never replaced by a head that is a draft's (`round <k>'s head <h7> failed check in the verify container, so it was not pushed over the ready PR`, or `… has no readable verify result (verify: <why>) …`).
- **When nothing was pushed,** the PR's body is the only write: nothing marks a draft ready, no label is added (`hapi:flagged` included), no PR is opened for a branch the factory didn't push, and the body keeps the PR's own head and its round (the round the PR's hidden block named for that head; none when it named none). The unpushed head appears only in the reasons (each of its own labelled `<h7> (not pushed): …`) and in its Evidence rows, marked `(not pushed)` (a decision asked before a refused or moved push says `asked; this head was not pushed`, or `unscreened; …` when nothing answered); its findings, signals, CodeRabbit line and account aren't shown, and there is no diff stat when the host's copy doesn't hold the PR's head.
- **A closed PR** for `factory/<id>` ends the harvest: no push, no write, the state carries the PR's number and `the PR was closed`, and the state machine settles the work order `closed`.
- **One PR, idempotent.** The harvester looks for the PR by its number, or by `factory/<id>`, before it opens one, so a crash between the push and the state's save finds the PR and updates its body on the next tick, never opening a second.
- **`harvestedAt`.** Once it has read a run's outputs, the harvester sets `harvestedAt` in each run record it read, under the run's lock, never overwriting it; retention removes a run's files only after it (H-206). With decision models off, the same write adds `decisions: "off"`. The review run's record also gets the review's verdict and its criteria's marks (`review: { verdict, marks }`, m20), never overwritten: what an eval compares.
- **Labels.** Every pushed PR gets `lane:factory`; `hapi:flagged` too when `flags.on_flag` has `label_pr` and the work order's runs together spent more than `flags.thresholds.run_usd`, or its rework rounds passed `flags.thresholds.review_rounds`. The harvester doesn't count `flags.thresholds.interventions` (H-273).

## The factory PR

The harvester writes the PR's description (`src/engine/pr.ts`) between two markers, `<!-- hapi:begin -->` and `<!-- hapi:end -->`, and re-renders only what is between them, so anything you write below `<!-- hapi:end -->` (or above the begin marker) survives every re-render. A body without the markers gets the host's part first, and yours after it. Its nine parts, top to bottom:

1. **Verdict:** **Ready to merge** (green), **Needs your decision** (yellow) or **Do not merge** (red); **Waiting for `ci / gates`** while a ready PR's CI hasn't passed on the head. Under it, an enforced decision's holds, coverage apart from findings: `held: <n> files not screened (<cause>)` (`call cap 24`, `no classifier answered`, …), and `held: text aimed at the reviewer in <paths>`.
2. **Unresolved**, then **Check this yourself**: the reasons; a major finding still open in a fix round's own change (design §3.5, at the top); CodeRabbit's CLI not reviewing the head and why; then the fixed reminders (the worker's account is a claim; CI's `ci / gates` is GitHub's own run), the added-line signals and the decisions' notes.
3. **Links:** the work order (k of n), `Part of #<planning PR>`, its sibling PRs (independent; merge in any order), the work order's trace, and each run with its kind and round, `(retry <n>)` for a later pass.
4. **Asked and built:** the goal (`task.md`'s first paragraph, quoted), the diff's size and the rollback note.
5. **Evidence:** a table of each gate with the head commit, its command and its result (the host gates, `mise run check`, `mise run smoke`, the acceptance tests, the independent review, CodeRabbit's CLI, each decision, `ci / gates`), then the review's findings and criteria and CodeRabbit's findings, quoted: each block at most 20,000 characters of whole items, then `… (truncated by the host: <n> more in the review run's outputs)`.
6. **Review rounds:** the fix rounds against their cap, each by stage.
7. **Cost and turns**, one line, ending with the decisions' spend.
8. **The worker's account**, fenced and labelled as the worker's own claim.
9. **A hidden state block**, `<!-- hapi:pr v1 {"workOrder":…,"status":…,"round":…,"head":…,"verdict":…} -->`; `round` only when the head's round is known (a head the factory didn't push may have none).

**The body stays under GitHub's limit** (65,536 characters): renderPr's last step keeps the host's part under 60,000, in fixed steps, so the same input always gives the same body: first the quoted blocks shrink (an item over a block's cap shows cut, ending `…`) and then go (`_The independent review's <n> findings and <n> criteria aren't shown here, …: they are in the review run's outputs._`), then the account (`… the whole account is in the worker run's transcript on the host`), and last the Unresolved and Check-this-yourself lists, with a line saying where the rest is. If even that is too long, the host's part is a fallback of a few lines: the verdict, at most five `held:` lines, ``_The full report is too long for this PR's body (GitHub's size limit): `hapi status` lists every reason, and the runs' outputs on the host hold the rest …_``, and the hidden block. What you wrote outside the markers counts toward the limit too: a re-render gives the host's part only what 65,536 leaves beside your text, less 512 characters. When even the fallback doesn't fit, the body isn't written: the work order's status row and `hapi status` say `the PR body has no room for the host's part: <n> characters of it are outside the hapi markers`, the repo's other work orders go on, and each tick tries again, so trimming your text is the fix. The body is read again just before each write, so what you wrote outside the markers while a harvest ran is kept.

**Host text and the run's text never mix.** Every line outside a fence is the host's: fixed words, numbers, run ids, paths it built, policy names. Whatever a run or a model wrote (the review's findings, CodeRabbit's, the goal, the account) is sanitized, its comment markers broken (`< !--`, `-- >`), and put in a fence one backtick longer than its longest run of backticks, so it can't close the fence, end the host's part, mention anyone or reach CodeRabbit as a command. The host's text has no task-list checkboxes, since your tick would be overwritten by the next render. **The account is a claim**: the worker wrote it; the host redacted it (both zones' values, raw and base64, and every key format) and capped it at 6,000 characters, but didn't check it.

### What the harvester reads

| Phase | File | What it reads |
|---|---|---|
| verify | `verify.json` | Exactly `{ "check": { "exit": <int>, "tail": <string> }, "smoke": <the same> \| null, "acceptance": <the same> \| null }`, no other key: `null` smoke is not run (an error when the work order's `verify.smoke` is true, unless check failed first), `null` acceptance is no acceptance tests (or not run, when check failed first); exit 0 passes. The tails are untrusted and unused. Also `result.json`'s `run.status`, `acceptance.junit.xml` and the record's `exitCode`: the four signals. |
| review | `result.json` and `transcript.jsonl` | The review node's structured output: the last `provider_event` row of step `review` whose event is the `StructuredOutput` tool call, at `event.rawInput` (result.json keeps only a 200-character preview, spike 09), read only when result.json shows the review node completed. Its shape is `factory-review.yaml`'s `output_format`: `{ verdict: ready \| needs-work \| blocked, findings: [{ severity: critical \| major \| minor, path, summary }], criteria: [{ criterion, mark: met \| partly \| unmet, evidence }] }`, no other key, strings at most 2,000 characters, at most 50 findings or criteria; anything else is "no review". |
| CodeRabbit's CLI | `coderabbit.ndjson` | Every line JSON; the last is hapi's own `{"type":"hapi","exit":<n>}` or `{"type":"hapi","skipped":"<why>"}`. A skip, an exit other than 0 or 2 (2 is `--gate major` tripping), a skipped, failed, reused or partial review, an unverified finding, an error line or no `complete` line is "not reviewed", named on the PR; its `critical` and `major` findings are the open ones. |
| worker or fix | `transcript.jsonl`, `decisions.jsonl` | The final message (the last attempt's text after its last tool call, in `implement`, `implement-retry` or `fix`), the guard's last `result` record, whether the message ends on a question (its last line, or the line before `RESULT:`), and its `## Account` section. |
| every run | `decisions.jsonl` | The guard's spend records: the cost line's spend (the higher of the guard's total and Archon's, unknown counted at the run's budget) and turns (the last spend record's `turns`). |

## The verdicts

Each factory PR opens with one verdict, and each maps to one of your three moves. [The four verdicts](#the-four-verdicts) has the full rules, in the harvester's order.

| Verdict | It means | Your move |
|---|---|---|
| **Ready to merge** (green) | everything passed: the host gates, verify (check, smoke, the acceptance tests), the review with every criterion met, no open major CodeRabbit finding, no decision holding a file, and `ci / gates` green on the head (until then **Waiting for `ci / gates`**) | merge it |
| **Needs your decision** (yellow) | something fell short of that, or wasn't checked: the reasons are at the top, under Unresolved | read the reasons, then merge (the verdict is advice), send it back with `hapi:rework`, or close it |
| **Do not merge** (red), a draft | check, smoke or the acceptance tests failed in the verify container, or verify left no readable result | send it back with `hapi:rework`, or close it. A draft can't be merged: GitHub refuses it |

With `runs.phases.require_acceptance` on (the default), **Ready to merge** needs the planner's acceptance tests to be present and passing. A work order with none is at best **Needs your decision** (`the work order has no acceptance tests (runs.phases.require_acceptance)`), and a failing one makes the PR a draft **Do not merge**. No verdict merges anything: only you merge, and with `main-review`'s Restrict updates every merge into `main` is your bypass, which GitHub logs as one (H-092).

## Decisions

The harvester asks one decision, `diff-screen` (`policy/decisions/diff-screen.ts`), before it settles a PR's verdict. [The decision models](#the-decision-models) is where it sits in the harvest; [docs/policy.md, "In the run engine"](../policy.md#in-the-run-engine) has the full rules.

- **What it asks**, of each changed file: does it hold text addressed to whoever reviews or checks the change (`reviewer_steer`)? Does it loosen a check (`loosened_check`)? Does code stand in for the real behaviour (`stand_in`)? Does it go beyond the work order's goal (`beyond_goal`)?
- **When:** only about a head it will push, after the host gates, the secret scan and the PR lookup: never for a refused bundle, a closed PR, or a branch that moved.
- **On what:** each file's diff from the merge commit (`diff -U3`, with no in-tree `.gitattributes` applied; a fix round's harvest screens the whole change), redacted first (both zones' values, raw and base64, and every key format), cut into windows of whole lines when it is long, with the work order's goal (`task.md`'s first paragraph). Jev is asked only for a public repo; Haiku otherwise.
- **What an answer can do:** a `hold` keeps the PR from **Ready to merge**, its reason under Unresolved after every other; a `note` adds a line under "Check this yourself". Only `reviewer_steer` at 0.7 or more holds, since the review reads the diff with no result screen, and so does a file no classifier screened (no key, a provider error, content the diff doesn't show, past the call cap, a re-render), through `on_unscreened: hold`. **What it never does:** change the push or the draft, move a phase, start or skip a run, add `hapi:flagged`, or close, dismiss or resolve anything. A pass never makes a verdict better, and no re-render drops a hold.
- **The knobs** are `policy/gates.yaml`'s `decisions` block, central and protected, so each change is a PR you merge: `decisions.mode` (`enforce`; `notes`: asked and recorded, but no answer holds a PR; `off`: nothing is asked); one decision moved to `shadow` (asked and recorded, with no effect but its Evidence row) or `off`; its `on_unscreened`, and `max_calls_per_head`; and adding a decision (a decision file, a registry line, a `by_name` entry and its schema line). Running with none at all: [docs/policy.md, "Running without decision models"](../policy.md#running-without-decision-models).
- **The ledger**, `~hapi/.local/state/hapi/engine/decisions/<owner>/<name>/<id>.jsonl` (0600, append-only, one per work order, kept with its state): an `asking` line before each call, and an `answer` line after it (or for a subject that wasn't asked). A line holds names and numbers: the decision and its version, the run, head, subject and part, the typed answers, the classifier, the verdict, its effect and the cost. It never holds the state's text or a key.

**Reading a repo's ledger**, as hapi. It needs `jq` on the host (nothing installs it); since each line is names and numbers only, `cat` of the file does too:

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  command -v jq > /dev/null || { echo "no jq on this host: cat the ledger files instead (each line is names and numbers)"; exit 1; }; \
  cd "$HOME/.local/state/hapi/engine/decisions/$1" && \
  jq -c "select(.kind == \"answer\") | {workOrder, retry, run: .run[0:12], head: .head[0:7], decision, version, subject, part, public, models, via, verdict, effect, cost_usd}" *.jsonl' \
  hapi-decisions "$OWNER/<name>"
```

**Replaying one decision** is Plan 06's calibration (H-262), and a real replay waits for it: `hapi decide` reads the classifier keys from its own environment alone (`HAPI_JEV_OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`), and hapi's shell holds neither, so as hapi it prints only the file's fallback (`via: default`). Its shape, for when it can: rebuild the line's state from the mirror by its `run`, `head`, `subject` and `part`, check it against the line's `key` ([`hapi decide`](../policy.md#hapi-decide-name---state-file-file---public---mock)), and save it as `~hapi/replay.json`; then, as hapi, with `--public` as the second argument only when the line's `public` is `true` (never for a private repo's line):

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- decide diff-screen --state-file "$HOME/$1" ${2:+"$2"}' \
  hapi-decide replay.json
```

For a public repo's line, end it `hapi-decide replay.json --public`.

- **Spend.** Each call is written to the ledger before it is made, and counts at its reported cost, or at `classifiers.jev.unknown_call_usd` ($0.001) when nothing answered, never $0. At most `decisions.max_calls_per_head` (24) calls are made for one pushed head, over every harvest of it. Decision spend counts toward the repo's month and the day ([the caps](#the-caps)), the status comment's row and the PR's "Cost and turns" line.
- **Time.** When the providers fail, a harvest's calls (made together) take up to about 2 minutes: Jev's 30 s, then Haiku's 30 s with its two retries. A re-render makes no call.

## The status comment, `hapi status` and `events.jsonl`

The host is the source of truth: the run records, the work orders' states and GitHub's PRs. The poller shows them three ways (`src/engine/status.ts`).

**The status comment** on each planning PR is written only by the poller, with the `hapi-factory` App's token (its Pull requests write covers issue comments). It is posted once, edited in place whenever its content changes, and starts with a hidden marker, `<!-- hapi:status v1 -->`. It holds:

- one row per work order of the plan: its id; its state (the phase, the verdict, and the first reason, with how many more); its last run; its PR; its rounds (`<n> automatic, <n> rework`, then `, retry <n>` once it has been retried); and its cost (every pass's runs and its decision ledger, with `(budget: spend unknown)` when a run's spend isn't known and counts at its budget);
- a **"Can't run"** table: each work-order file the poller can't run with, and why (fix each in a new planning PR);
- the plan's total, against the repo's monthly cap and the day's cap for all repos;
- the decision-models line, when `gates.decisions.mode` isn't `enforce`.

Once every work order of the plan has settled (`merged`, `closed` or `failed`) and no problem is open, the poller posts **one final comment** (`This plan has settled: <n> merged, <n> closed, <n> failed. Total: $<x>.`), and from then on leaves the plan's comments as they are. A `hapi retry` reopens the plan: its comment is edited again, and when the plan settles again, another final comment is posted. The earlier final comment stays as it was, with its own counts and total (H-311). Every cell is one line, and text a run, a planner or GitHub controls is in a code span, so nothing in it renders as a mention, a link or HTML. The poller remembers each comment by a mark, `~hapi/.local/state/hapi/engine/status/<owner>/<name>/<planning-pr>.json`; a mark lost in a crash is recovered from the PR (the newest comment by the factory's App that starts with the marker), never by posting a second comment.

**`hapi status [<owner>/<name>]`** prints the same table for each planning PR, every registered repo's with no argument, from hapi's local state alone: no GitHub, no Docker, no fetch, so no "Can't run" table (that comes from a tick's discovery). As hapi:

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- status "$@"' \
  hapi-status "$OWNER/<name>"
```

**`events.jsonl`**, `~hapi/.local/state/hapi/engine/events.jsonl` (0600): one JSON line per transition, `{ at, repo, workOrder, phase, run?, pr?, verdict?, reason?, usd?, retry? }`, appended only by the holder of the poll lock (a tick, after it writes the state; or `hapi retry`), so a line names a state already on disk. A retry is a `failed` line followed by a `queued` one, whose reason is `the operator retried it (retry <n>) after: <the failure's reason>`, and every later line of that work order carries `retry: <n>`. Plan 04's Hermes and any later board read it, and take `failed` as final only until a retry (H-245).

## The caps

Every cap is a fail-closed default in policy (anti-goal 1: no unbounded spend, no thrashing without a human), and each default is a starting point to tune by a reviewed change; the policy files are protected. The poller checks the spend caps before every run it starts; [the caps' texts](#the-caps-texts) has each refusal word for word.

| Cap | Policy key | Default | What tripping it does |
|---|---|---|---|
| A run's dollars | `budgets.run_usd`, and the work order's `budget.usd` under it; a review's or fix's `runs.phases.round_usd` | $3.00; $1.00 a round | hapi-guard fails the node (`budgets.enforcement.hapi_guard: hard`); a review stops at its node's own `maxBudgetUsd` (H-259) |
| A run's turns and time | the work order's `budget.turns` and `budget.minutes`; a fix's `runs.phases.round_turns` | the work order's; 40 | hapi-guard fails the node at the turn cap; the launcher ends the run at its deadline (`timed-out`) |
| A run's nodes | `factory-task`'s `max_work_units` | its node count | Archon refuses further nodes |
| The runs' disk | `runs.disk.gb` | 20 GiB, every run's volumes together | `hapi run start` refuses every run on a run disk that isn't at most the cap (`runs.disk.enforcement: hard`) |
| A repo's month | `budgets.repo_monthly_usd` (an overlay may lower it) | $25 ($15 on the sandbox) | no new run for the repo until the 1st (UTC): a queued work order goes `cap-stopped`, a verify or review waits in its phase; the status comment says so |
| The day, all repos | `budgets.daily_usd` (central only) | $10 | nothing new starts until the next UTC day |
| Live runs | `runs.max_live` | 1 | the launcher refuses the next; the poller waits for a free slot |
| Fix rounds before the PR | `runs.phases.fix_rounds_before_pr` | 1 | no further fix: the harvest, with what is left open on the PR |
| Fix rounds on the PR | `runs.phases.fix_rounds_on_pr` | 1 | no further automatic round: the PR waits for you |
| Automatic rounds | `runs.max_auto_rounds` (always hard) | 3 runs with no human action between them | the factory waits for you; the PR and the status comment say so |
| Rework rounds | `runs.max_rework_rounds` (central only, always hard); `flags.thresholds.review_rounds` | 3; flagged past 2 | a `hapi:rework` label starts nothing more, and the PR waits; past 2, `hapi:flagged` |
| Retries | `runs.max_retries` (central only, always hard) | 2 a work order | `hapi retry` refuses: plan the work again under a new work order id |
| Decision calls per pushed head | `gates.decisions.max_calls_per_head` | 24 | the rest are not asked, and their decision's `on_unscreened` applies (`hold`) |
| Inputs and work-order files | `runs.inputs_mb`; `runs.work_order_kb` (both central only) | 16 MiB; 1024 KiB | a review's or fix's inputs over it are refused, never truncated (the work order fails, or waits with a PR); a work-order file over it can't run |
| The provider's own limit | the `hapi-factory` Console workspace's monthly limit | $100 (about $25 while the sandbox runs) | Anthropic refuses every request: the stop no worker can get around |

`budgets.enforcement.poller` (`hard` by default) applies to the month and the day: `soft` starts the run anyway, puts the cap's text on its event, and flags its PR `hapi:flagged`. The round, rework and retry counts are always hard. Each run counts its reported spend, or its whole budget when that isn't known. **Decision spend counts with the runs'**: each work order's decision ledger, an unanswered call at `classifiers.jev.unknown_call_usd`. Reported spend is written inside the run's containers, so it catches an honest runaway, not a compromised worker (H-250): the provider's limit is the bound. CodeRabbit's CLI reviews per hour have no cap of hapi's (H-167): a review CodeRabbit refuses for its own rate limit is "not reviewed" on the PR.

## Stopping everything

- **[Kill switch 3](kill-switches.md#3-stop-the-stack)**, `mise run down`, stops the poller's timer and its service first, so no new tick starts a run, then removes every live run and stops the stack. `mise run up` brings it all back, the timer included.
- **The timer alone**, so no tick runs while the stack stays up, as hapi:

  ```bash
  sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
    export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" PATH="$HOME/.local/bin:$PATH"; \
    systemctl --user stop hapi-poll.timer'
  ```

  A tick already running finishes; none starts after it. A live run goes on to its end under its own caps, and its work order stays where it is until the timer runs again (`mise run up`, or `systemctl --user start hapi-poll.timer` in the same form). [`runtime.poller-timer`](../audit.md#runtimepoller-timer) fails while it is stopped.
- **The provider's limit:** the `hapi-factory` workspace's monthly limit in the Anthropic Console ([provider keys](provider-keys.md#anthropic-console-workspaces)), lowered, is the one stop no worker can get around: every model call of every run is refused from then on, whatever a run's reported spend says. [Kill switch 1](kill-switches.md#1-zero-or-revoke-the-provider-keys) does that for every provider.
- **One run:** `hapi run stop <id>` of a live run ([runs.md](runs.md#hapi-run-stop)) ends its work order's automatic work: `failed` with no PR (`hapi retry` can queue it again), `waiting` with one; and the repo's queue moves on at the next tick. A stop after the run has ended changes nothing.
- **Stopping the poller's service or its timer** (`systemctl --user stop hapi-poll.service`, or `hapi-poll.timer`) stops only the tick's own process, never a live run: each run's detached supervisor lives in the service's cgroup and survives by design (`KillMode=process`; moving runs out of the cgroup is H-280, Plan 04; [kill switch 3's note](kill-switches.md#3-stop-the-stack)). To end live runs and their spend, use `hapi run stop <id>` for each run, kill switch 3 (`mise run down`), or the provider's limit.
- **There is no per-repo halt:** stopping the timer pauses every repo.
- **Kill switch 3 also removes live runs**, which end `failed`, not `stopped`. So after `mise run up`, a pre-PR fix, verify or review removed that way goes on to the harvest and its PR: `hapi run stop` it first if its work order must not reach a PR.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The journal says `<repo>: failed closed: <error>; the next tick retries` | A 5xx, a rate limit (GitHub's secondary one is a 403 with retry-after), an expired token: the next tick retries, and nothing is written half-way. If one work order fails the same way every tick, it is [a poison pill](#when-one-work-order-stops-its-repos-tick): fix the cause the line names. |
| `<repo>: can't run <file and why>` in the journal, and a row in the status comment's "Can't run" table | The poller can't read that work order (a file that fails its check, or is over `runs.work_order_kb`, or an overlay the central policy now refuses). It waits. Fix a work-order file in a new planning PR; an overlay is read at the work order's own merge, which no later planning PR changes, so revert or narrow the central change, or close the work order's PR (H-296). |
| A work order is `held` | Two work orders of one merge whose pieces declare overlapping files. It stays held for good (H-243(a)): fix it with a new planning PR that makes them independent. |
| A work order is `cap-stopped` | The repo's month or the day, with the cap's text. It starts on its own when the cap clears (the 1st, or the next UTC day), or when the cap is raised by a reviewed change; until then it heads its repo's queue. |
| Stuck in `queued` | Another work order of the repo is active before its PR, a `cap-stopped` one is ahead of it, or `runs.max_live` is reached (another live run, a hand run included). `hapi status` and `hapi run list` show which. |
| `Needs your decision` with `the work order has no acceptance tests (runs.phases.require_acceptance)` | Its planning PR carried none under `.factory/work/<id>/acceptance/`. Check it yourself and merge, or plan it again with tests. |
| A verify run can't install (check's tail shows `bun ci` failing), and the PR is a draft | The bundle's `bun.lock` is out of date with its `package.json`, or a registry isn't on `egress-archon`'s allowlist (`policy/trusted_sources.yaml`). Send it back with `hapi:rework`, or add the host by a reviewed change. |
| A status comment someone deleted | It comes back the next time its content changes. To get it back now, remove its mark, as hapi, with the repo's `<owner>/<name>` and the planning PR's number: `sudo -u hapi -H -- sh -c 'rm -- "$HOME/.local/state/hapi/engine/status/$1/$2.json"' hapi-mark "$(gh api user --jq .login)/<name>" <planning-pr>`; on a settled plan, that posts the final comment again too. |
| No timer after a reboot (`runtime.poller-timer` fails, `list-timers` shows none) | The timer's links are runtime ones, which a reboot clears, and `mise run up` alone doesn't bring them back: hapi's rootless Docker doesn't restore `hapi_outbound` when it starts, so `up` fails at the proxies (H-305; it did at the deploy of 2026-11-08, and after the reboot of 2026-11-11 the stack came back with `down`, then `up`). Run `mise run down`, then `mise run up` with the flags you deploy with. [The stack runbook's entry](stack.md#troubleshooting) has the error's text and what to save before `down`. |
| A work order is `failed` | Read the reason in `hapi status`. If the cause was outside the work order (a rate limit, a timeout, a container `mise run down` removed, a flaky preflight, your own `hapi run stop`), fix it, then [`hapi retry`](#a-failed-work-order). A failure from the work order's own content, or `has been retried <n> times, and runs.max_retries is <n>`, needs a new id in a new planning PR; so does a closed `factory/<id>` PR, which shows as `closed`. A `hapi run start` by hand is never picked up by the poller. |
| `failed` with `a <kind> run's inputs (…) are <n> MiB, over runs.inputs_mb (16 MiB): refused, never truncated` | Before a PR the inputs are the same every pass, so `hapi retry` fails the same way: plan the work again, smaller. |
| Every PR says `not screened (no classifier answered: …)` | Check the archon zone's keys (`hapi secrets check`), the providers' caps (OpenRouter's daily limit answers 402; the Console limit), and hapi's own network from the host to `openrouter.ai` and `api.anthropic.com` (the harvester calls them on the host, not through a zone's proxy). That head stays held, since a re-render asks nothing: merge anyway (the verdict is advice), or send it back with `hapi:rework`. A missing key never turns decision models off. |
| A hold under Unresolved: is it the file, or the cover? | The reason says. A coverage hold reads `<path>: not screened (<why>) (gates.decisions.by_name.diff-screen.on_unscreened: hold)`, `<why>` being `not asked: over gates.decisions.max_calls_per_head (24)`, `no classifier answered: …`, `not asked: a re-render asks nothing` (a re-render gives a subject its harvest's own why, and this only to one never asked) or `content not shown in the diff`: it says nothing about the file, so check the file yourself. The verdict line counts them apart: `held: <n> files not screened (<cause>)` against `held: text aimed at the reviewer in <paths>`. A finding reads `<path>: it holds text addressed to whoever reviews or checks the change (decide diff-screen: …, via jev)` (or `via haiku`): read that file's diff first. |
| A hold you disagree with | Merge anyway, since the verdict is advice, and record it for calibration (H-262): a hold on a PR you then merged unchanged is a false alarm. |
| `not asked: over gates.decisions.max_calls_per_head (24)` | A large change, or a head asked about many times. Raise the knob by a protected change, or split the work order. |
| `content not shown in the diff` | A binary file or a gitlink. No `.gitattributes` in a tree applies to the host's reads, so a `-diff` attribute hides nothing. Check the file yourself, or set `on_unscreened: note` by a protected change. |
| `<file> line <n> is not a decision entry` | A damaged decision ledger. It fails that repo's ticks, and, since the day's cap reads every ledger, stops new runs everywhere. With [the timer stopped](#stopping-everything), move that one line into a dated `.bad` file beside the ledger, as hapi, with the file and line the message names: `sudo -u hapi -H -- sh -c 'umask 077; sed -n "$2p" "$1" >> "$1.$(date -u +%Y%m%d).bad" && sed -i "$2d" "$1"' hapi-ledger <file> <n>`, then start the timer again. A lost `answer` line only means its subject is asked again; a lost `asking` line under-counts at most one call ($0.001). |
| Every PR and the status comment say `Decision models are off` | `gates.decisions.mode` is `off`, the operator's setting ([Running without decision models](../policy.md#running-without-decision-models)); set it back to `enforce` by a protected change. A PR whose head was harvested while it was off then reads as held at its next re-render, since a re-render asks nothing: merge it anyway, or send it back with `hapi:rework`. |
| `waiting` with `work order <id>'s worker run of pass <n> has no record (runs.retention_days removed it once its month ended): no rework can start on #<pr>; …` | The PR waited past retention, which removed its pass's runs, so a rework has no worker run to be its parent. Close the PR, or plan the work again under a new work order id (H-244(c)). |
| `ci / gates` fails on a factory PR with `<sha> has no <Key> trailer` after you pushed to it, or used **Update branch** or **Resolve conflicts** | Every commit on `factory/**` needs the six trailers, yours too ([the operator always wins](#the-operator-always-wins)): commit or resolve locally with them, or close the PR and land the change yourself (H-295). |
| `Needs your decision` with `CodeRabbit's CLI failed its gate (exit 2: …), yet no major or critical finding was read from its output` | The CLI's own gate and the findings the host read disagree (a severity spelt in a way the host doesn't know, or a finding it couldn't read). Read CodeRabbit's findings in the review run's outputs yourself. |
| You added `hapi:rework`, and nothing started and no cap's text shows | The label counts only when it was added after the work order's newest worker or fix run started, and GitHub gives the label's time in whole seconds: one added in the same second as the run's start reads as before it. Take the label off and add it again. |
| A verify or review holds with `the host gates refuse <kind> run <id>'s bundle now: <details>` | The run's bundle passed the host gates once but fails them now, most likely after a policy change (a newly protected path, a tighter overlay). The work order holds in its phase, runs the gates again each tick, and holds its repo's queue. Undo or narrow the change the details name, and the next tick goes on. There is no command to fail it instead (H-243(h)). |
| `the PR body has no room for the host's part: <n> characters of it are outside the hapi markers` | Your own text outside the `<!-- hapi:begin -->` and `<!-- hapi:end -->` markers leaves less room than even the host's few-line fallback needs under GitHub's 65,536 characters, so the host didn't write the body (on a harvest the push still happened; a re-render pushes nothing). Trim your text: the next tick writes the body and drops the reason. |
| `hapi:rework` starts nothing, and the PR's body doesn't say why | Past `runs.max_rework_rounds` (3), the cap's text is in the status comment and `hapi status`. The PR's body shows it too, unless you pushed to `factory/<id>` after the factory's last push: a head the factory didn't push isn't re-rendered. Close the PR, or plan the work again under a new work order id. |

## End to end on the sandbox

This is Plan 03's live check (design §4, Task 16): two hand-written planning PRs on the sandbox, `hapi-sandbox-fortune` (a fortune-cookie MCP server over stdio, on Bun), go through the whole engine. Planning PR 1 holds one work order with two pieces; planning PR 2, written once PR 1's factory PR has merged, holds two independent work orders. On the way it exercises CodeRabbit's review (its CLI in the review run, [Step 3](#step-3-coderabbits-cli-key-or-none); its round on the PR ships off, H-312), one rework by label and the status comment. Each work order carries its acceptance tests under `.factory/work/<id>/acceptance/`: in-process MCP client tests, written by hand, that call the tools and check their outputs against the bakery's fixture fortunes. The total spend stays under $15 (the sandbox's overlay caps the month there), and the Console limit is lowered first.

> **As built (noted 2026-11-12, Task 16):** the run was live from 2026-11-06 to 2026-11-12. Steps 2 to 10 ran for work orders 0001 to 0003 with CodeRabbit's CLI off: planning PRs #2 and #4, factory PRs #3, #5 and #6, to 2026-11-11. hapi-factory PR #18 then turned the round on the PR off and gave the CLI `--deep`, and a third planning PR, #7 (`plan: 0004 get_fortune, with CodeRabbit's CLI on`), ran one more work order, `0004-get-fortune`, on 2026-11-12 with the CLI on: factory PR #8. This section has no block for PR #7's files, which are in that PR: `coderabbit: true` under `runs.phases` in `.factory/config.yaml`, a `get_fortune` line in `docs/design/fortune-mcp.md`, and `.factory/work/0004-get-fortune/`, one piece of two files with the same budget as the others. [The record](#the-record) covers all four work orders.

You run every step below, from your own terminal; nothing here runs on its own. After each step, paste back what it asks for. **Stop and report** means: do nothing more, paste what you saw, and wait for the controller's ruling before the next step. The controller records what you paste in [the record](#the-record) at the end, with `<owner>` for your login.

**To stop during this run.** Stopping the poller's timer or its service (`systemctl --user stop hapi-poll.timer`, or `hapi-poll.service`) stops only the ticks and leaves live runs going: each run's supervisor lives in the service's cgroup and survives by design (H-280). To end live runs and their spend, use `hapi run stop <id>` for each run ([runs.md](runs.md#hapi-run-stop)), kill switch 3 (`mise run down`), or the provider's limit ([stopping everything](#stopping-everything)).

Every as-hapi command is in [runs.md's form](runs.md#how-to-run-the-commands). Every command that names the sandbox starts from `OWNER="$(gh api user --jq .login)"`, so no login is written down. The read-outs below use `jq` as hapi: check it once with `sudo -u hapi -H -- sh -c 'command -v jq && jq --version'` (expected: a path and `jq-1.<n>`; with none, install it before you start).

### Before you start

In this order, each with its own runbook:

1. **The run disk** (Task 4 Steps 9 and 10): [making the run disk](runs.md#making-the-run-disk-the-operator-once-with-sudo), then [the live check](runs.md#the-live-check-as-hapi). Paste back what each asks for. If the live check's first `docker run` (the `chown`) fails with `no such file or directory`, follow runs.md's paragraph on it and paste back what it asks for; if that doesn't clear it, stop and report. On the build host it didn't arise: hapi's rootlesskit propagates the host's mounts (H-287, closed).
2. **The sandbox** (Task 5 Steps 12 to 15): [Plan 03's operator steps](new-repo.md#plan-03s-operator-steps-task-5-steps-1215), in your hapi-factory checkout on `plan/03-run-engine`. Step 15 makes the sandbox with `--clone`, so its clone is `../hapi-sandbox-fortune`, beside your checkout. Its registration in `policy/repos.yaml` is then committed on `plan/03-run-engine`, with your OK (a protected file), so Plan 03's PR carries it together with this section: the poller acts only on a registered repo.
3. **Steps 2, 3 and 4** below, in order. Step 4 merges Plan 03's PR and deploys it.

### Step 2: lower the spend limit

In the Anthropic Console, set the `hapi-factory` workspace's monthly limit to **$25** (it is $100 now; [provider keys](provider-keys.md#anthropic-console-workspaces)). It is the one stop no run can get around, above the sandbox's $15. Paste back the limit as the Console shows it.

### Step 3: CodeRabbit's CLI key, or none

`runs.phases.coderabbit` stays `false` centrally (H-167), and the sandbox's overlay may switch it on. CodeRabbit's review of a work order is its CLI's, in the review run: its round on the PR ships off, since CodeRabbit skips a PR the factory's App opens unless the App's bot holds a seat ([the CodeRabbit round](#the-coderabbit-round), H-312). The CLI needs an **Agentic** key of a CodeRabbit organization where you hold a seat, a paid plan's or a trial's while it lasts. Choose one:

- **The CLI off** (no seat, or you'd rather not): store nothing, leave the `coderabbit` line out of planning PR 1's `.factory/config.yaml`, and paste back "CodeRabbit CLI off". No CodeRabbit review of a work order runs then, and each factory PR's Evidence says so (`off (runs.phases.coderabbit)`).
- **The CLI on.** A stop-class secret step: the key never goes on a command line, into a file other than the store, or into a chat. Create and store it as [provider keys, "CodeRabbit (optional)"](provider-keys.md#coderabbit-optional) says: a dedicated Agentic key in CodeRabbit's API keys page, stored with `mise run secrets:edit` in your own checkout (its manifest names it) under `hapi-review-coderabbit-api-key`; then, from that checkout, give hapi the updated store:

  ```bash
  scripts/copy-secrets-to-hapi.sh
  ```

  Step 4 checks it once hapi's checkout has Plan 03's manifest, and its `mise run up` resolves it into `review.env`. Planning PR 1's `.factory/config.yaml` gets the `coderabbit: true` line ([below](#planning-pr-1s-files)). If the seat ends before a later planning PR merges, take that line out in that planning PR (a work order reads the overlay at its own merge), delete the key from the store and revoke it in CodeRabbit.

### Step 4: deploy, then audit

1. **Merge Plan 03's PR** on GitHub, with a merge commit. Paste back its number and merge SHA:

   ```bash
   OWNER="$(gh api user --jq .login)"
   gh pr list --repo "$OWNER/hapi-factory" --state all \
     --head plan/03-run-engine \
     --json number,mergeCommit --jq '.[0] | [.number, .mergeCommit.oid] | @tsv'
   ```
2. **Update hapi's checkout and bring the stack up** (Task 14 Step 9, with stack.md's "before the first tick": `mise install` puts gitleaks 8.30.1, which the harvester's secret scan runs, on the poller's `PATH` through `mise exec`; `mise run up` writes `build/roster` and installs the timer):

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" \
       PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && git pull --ff-only && mise install && \
     mise exec -- gitleaks version && mise run up && cat build/roster && \
     systemctl --user list-timers hapi-poll.timer --no-pager && \
     systemctl --user status hapi-poll.service --no-pager -n 5'
   ```

   Paste back gitleaks's version, `up`'s last line, the roster, the timer's row and the service's status. Expected: `8.30.1`; `the stack is up (Compose project hapi): egress-hermes, egress-archon, egress-research, egress-review, hermes (…)`; `anthropic` (`up`'s default roster, unless you passed `--roster`); `hapi-poll.timer` activating `hapi-poll.service`, with NEXT within 120 s. Once a tick has run (two minutes after `up`), the service's status shows `status=0/SUCCESS`: if it hadn't yet, check again with [the timer and the journal's command](#the-poller).

   **Only with the CLI on (Step 3):** check the key is in hapi's copy of the store:

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && mise run secrets:check' | grep CODERABBIT
   ```

   Paste back that one line. Expected: `found    review/CODERABBIT_API_KEY (hapi-review-coderabbit-api-key) (optional)`: the key found, never its value.
3. **Give the `hapi-factory` App Checks: Read-only** (Task 3 Step 9): steps 1 and 2 of [adding a permission to an existing App](github-apps.md#adding-a-permission-to-an-existing-app). Paste back the installation page's permissions line. Expected: "Read access to checks and metadata" and "Read and write access to code and pull requests". The strict audit below is that section's step 3.
4. **Your audit token, in hapi's home.** A fine-grained token of yours, with **Administration: read** and **Contents: read** on both `hapi-factory` and `hapi-sandbox-fortune` (a token for one repo leaves the other's `github.rulesets` and `github.repo-settings` to skip, which `--strict` fails), and a short expiry. Paste this command on its own, since its `read` takes the next line you paste as the token; then type or paste the token and press Enter (nothing is echoed):

   ```bash
   sudo -u hapi -H -- sh -c 'umask 077; f="$HOME/.config/hapi/audit-token"; \
     mkdir -p "${f%/*}" && rm -f "$f" && printf "token: " && stty -echo; \
     IFS= read -r t; stty echo; echo; \
     [ -n "$t" ] && printf "%s\n" "$t" > "$f" && echo "token file written"'
   ```

   Expected: `token file written`. The file is `0600` and hapi's; the audit below deletes it, so make it again before Step 10's.
5. **The strict audit**, as hapi, of both repos:

   ```bash
   OWNER="$(gh api user --jq .login)"
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && \
     mise run audit -- --strict --github-token-file "$HOME/.config/hapi/audit-token" \
       --repo "$1/hapi-factory" --repo "$1/hapi-sandbox-fortune"; \
     rm -f "$HOME/.config/hapi/audit-token"' \
     hapi-audit "$OWNER" \
     | grep -E -e '^(fail|skip) ' -e '^hapi audit:' \
       -e '^pass  (runtime\.(run-disk|poller-timer)|policy\.(repos|decision-models)) ' \
       -e '^pass  github\.app-perms '
   ```

   Paste back what it prints. Expected: two fails, both `--strict: skipped: …`: the `mcp.tool-hashes` line (H-101), and `github.repo-settings` for the sandbox, naming the seven merge settings that `aren't visible with the operator's token` and ending `the rest match` (H-306: GitHub shows them only to a token with Contents: write, which the audit token mustn't have; `new-repo`'s step 11 proved them with your `gh` login); a `pass` line for `runtime.run-disk`, `runtime.poller-timer` (its first live run), `policy.repos`, `policy.decision-models` (`decision models are on: the engine's decisions (gates.decisions.mode: enforce), the bash gate and the result screen`) and `github.app-perms` (once per repo; it now fails an App that lacks Checks: read, so its pass shows step 3 took); then `hapi audit: <n> pass, 2 fail, 0 skip` (25 pass on 2026-11-09). mise then prints `[audit] ERROR task failed`, since `--strict` exits 1 on a fail. Any other fail, or a `github.repo-settings` line that names a setting that differs: stop and report.
6. **hapi's host reaches both classifier endpoints.** The harvester asks its decisions from the host, not through a zone's proxy. No key is sent and no model is called:

   ```bash
   sudo -u hapi -H -- sh -c 'for u in https://openrouter.ai/api/alpha/decisions \
       https://api.anthropic.com/v1/messages; do \
       printf "%s " "$u"; curl -sS -o /dev/null -m 10 -X POST -w "%{http_code}\n" "$u"; \
     done'
   ```

   Paste back both lines. Expected: a 4xx code on each (401, 403, 404 or 405): the host reached the endpoint and was refused for want of a key. `000` means hapi's host can't reach it, so every decision would come back `not screened`: stop and report.

### Commands you run more than once

None prints a key or a run's raw output: what a run or a model wrote shows only where hapi already shows it, fenced in the PR's body.

**The watch:** the sandbox's work orders from hapi's local state, then every run:

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && mise run hapi -- status "$1" && \
  mise run hapi -- run list' \
  hapi-status "$OWNER/hapi-sandbox-fortune"
```

**The sandbox's runs, from their records:** one line per run, oldest first: its start, id, work order, kind, round, pass (`retry`), status, spend, and for a verify run its `verify.json`'s exit codes (`{"check":…,"smoke":…,"acceptance":…}`; `-` for every other kind). The run table and the acceptance criterion's evidence come from it:

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c 'cd "$HOME/.local/state/hapi/runs" && for d in */; do \
    [ -f "${d}record.json" ] || continue; \
    v=$(jq -c "{check: .check.exit, smoke: .smoke.exit, acceptance: .acceptance.exit}" \
      "${d}out/verify.json" 2>/dev/null || echo -); \
    jq -r --arg repo "$1" --arg v "$v" "select(.forgeRepo == (\$repo | ascii_downcase)) \
      | [.startedAt[0:19], .runId, .workOrder, .kind, .round, (.retry // 0), .status, \
      (.spendUsd // \"-\"), \$v] | @tsv" "${d}record.json"; \
  done | sort' \
  hapi-runs "$OWNER/hapi-sandbox-fortune"
```

**The decision ledger, by head:** the calls made for each head (its `asking` lines; `gates.decisions.max_calls_per_head` is 24), then the answers by classifier and verdict (`default` is a subject no classifier answered: no key, a provider error, the call cap, content the diff doesn't show). The full read, line by line, is [Decisions' command](#decisions):

```bash
OWNER="$(gh api user --jq .login)"
sudo -u hapi -H -- sh -c 'cd "$HOME/.local/state/hapi/engine/decisions/$1" && \
  echo "calls per head (asking lines):" && \
  jq -r "select(.kind == \"asking\") \
    | [.workOrder, .head[0:7]] | @tsv" *.jsonl | sort | uniq -c && \
  echo "answers per head, by via and verdict:" && \
  jq -r "select(.kind == \"answer\") \
    | [.workOrder, .head[0:7], .via, .verdict] | @tsv" *.jsonl \
    | sort | uniq -c' \
  hapi-decisions "$OWNER/hapi-sandbox-fortune"
```

**The status comment, and who wrote it.** Set `BRANCH` to the planning PR's branch (`plan/0002-search-and-fortune-of-the-day` for planning PR 2). It prints, for the status comment and the final one, a line with the author, its type and whether GitHub marks it as written through an App (H-293), then the comment:

```bash
OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
BRANCH=plan/0001-skeleton-and-crack-cookie
PLAN="$(gh pr list --repo "$R" --head "$BRANCH" --state all \
  --json number --jq '.[0].number')"
gh api --paginate "repos/$R/issues/$PLAN/comments" \
  --jq '.[] | select(.body | startswith("<!-- hapi:status")) |
    "\(.user.login) \(.user.type) " +
    "via-app:\(.performed_via_github_app != null) " +
    "\(.updated_at)", .body'
```

**A factory PR.** Set `WO` to the work order's id. It prints the PR's number and head, its commits (subject, author, committer, how many of the six factory trailers it has, and whether its message holds a `Co-authored-by`), the check runs on its head, CodeRabbit's root review comments by commit and severity (the word that ends its first bold span, close to what the engine reads; H-168, H-309), and the host's part of the body down to the worker's account:

```bash
OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
WO=0001-skeleton-and-crack-cookie
PR="$(gh pr list --repo "$R" --head "factory/$WO" --state all \
  --json number --jq '.[0].number')"
SHA="$(gh pr view "$PR" --repo "$R" --json headRefOid --jq .headRefOid)"
echo "factory PR #$PR at $(printf '%.7s' "$SHA")"
gh api --paginate "repos/$R/pulls/$PR/commits" --jq '.[] | [.sha[0:7],
  (.commit.message | split("\n")[0]), .commit.author.name, .commit.committer.name,
  ([.commit.message | split("\n")[]
    | select(test("^(Work-Order|Hapi-Run|Hapi-Lane|Trace-Id|Agent|Model): "))]
    | length),
  (.commit.message | ascii_downcase | contains("co-authored-by:"))] | @tsv'
gh api "repos/$R/commits/$SHA/check-runs" \
  --jq '.check_runs[] | [.name, .app.id, .status, .conclusion, .output.title] | @tsv'
gh api --paginate "repos/$R/pulls/$PR/comments" --jq '.[] |
  select(.user.id == 136622811 and .in_reply_to_id == null) |
  [.commit_id[0:7],
   ([.body | match("\\*\\*(?:<[^>]*>| )*([A-Za-z]+)\\*\\*")
     .captures[0].string][0] // "none")]
  | @tsv' | sort | uniq -c
gh pr view "$PR" --repo "$R" --json body --jq .body \
  | sed -n '/^<!-- hapi:begin -->/,/^## The worker.s account/p'
```

**The journal's problem lines:** the poller's last lines that failed closed, couldn't run a work order, or left one waiting on a lock:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; \
  journalctl --user -u hapi-poll.service -n 5000 --no-pager -o cat \
    | grep -E "failed closed|can.t run|waiting: " | tail -n 20'
```

### Planning PR 1's files

Write them in the sandbox clone's root (Step 5 goes there first). Each block writes one file; paste them in order. They are as Biome formats them, so `ci / check` (`mise run check`, which runs `biome ci .` over YAML and Markdown too) passes on the planning PR.

**`.factory/config.yaml`:** keep the file `new-repo` wrote (its schema line names your repo's gates commit) and add the sandbox's settings to its end. An overlay may not set `runs.disk`, `max_live`, `retention_days` or any output limit but `bundle`, which are central only, so this one doesn't:

```bash
cat >> .factory/config.yaml <<'EOF'

# The sandbox's own settings (hapi-factory docs/runbooks/engine.md, "End to end on the sandbox").
# A month's spend on this repo stops at $15, under the central $25.
budgets:
  repo_monthly_usd: 15
# The smoke test's stub service: the central bun-http sidecar serves smoke/bakery/ (its server.ts and
# fortunes.json), which the overlay makes a path workers may not write.
sidecar:
  name: bun-http
  data_dir: smoke/bakery
# Already the central default: Ready to merge needs the work order's acceptance tests to exist and pass.
runs:
  phases:
    require_acceptance: true
EOF
```

The data dir is `smoke/bakery`, not `smoke`: the overlay makes the data dir a path workers may not write, and the worker has to write `smoke/run.ts`. **Only with the CLI on (Step 3)**, add the `coderabbit` line, under `phases:`:

```bash
printf '    coderabbit: true\n' >> .factory/config.yaml
```

**`.factory/work/0001-skeleton-and-crack-cookie/order.yaml`:** two small pieces, and a fresh traceparent. `budget.usd` is $2.00, at least `runs.phases.round_usd` ($1.00): a work order below it has its review runs refused (H-259), since a review's cap is its node's own $1.00. The `skeleton` piece lists `bun.lock`, because the verify container installs from the bundle's lock (`bun ci --frozen-lockfile --ignore-scripts`), never from the worker's `node_modules`; the SDK and its dependencies come from `registry.npmjs.org`, which `egress-archon` allows (`policy/trusted_sources.yaml`).

```bash
mkdir -p .factory/work/0001-skeleton-and-crack-cookie/acceptance smoke/bakery docs/design
```

```bash
TP="$(printf '00-%s-%s-01\n' \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 8)")"
cat > .factory/work/0001-skeleton-and-crack-cookie/order.yaml <<EOF
# Work order 0001, written by hand for hapi-factory's end-to-end run (docs/runbooks/engine.md).
id: 0001-skeleton-and-crack-cookie
lane: factory
workflow: factory-task
risk: low
roles:
  implement: large
  review: medium
# budget.usd is at least runs.phases.round_usd (1.00), or the review run is refused (H-259).
budget:
  usd: 2.00
  turns: 40
  minutes: 30
pieces:
  - id: skeleton
    size: small
    files:
      - package.json
      - bun.lock
      - src/server.ts
      - src/bakery.ts
      - src/tools/health.ts
      - tests/health.test.ts
      - smoke/run.ts
  - id: crack-cookie
    size: small
    files:
      - src/tools/crack-cookie.ts
      - tests/crack-cookie.test.ts
verify:
  smoke: true
egress_extra: []
trace:
  traceparent: "$TP"
sources:
  - docs/design/fortune-mcp.md
EOF
```

**`.factory/work/0001-skeleton-and-crack-cookie/task.md`:** the PR's title is the id and the first `# ` heading, and its "Asked and built" quotes the Goal's paragraph. It names `zod` beside the SDK: the SDK lists it as a peer dependency for a tool's input schema, and the contract's `AGENTS.md` forbids a dependency the work order doesn't name.

```bash
cat > .factory/work/0001-skeleton-and-crack-cookie/task.md <<'EOF'
# The skeleton and crack_cookie

## Goal

A read-only MCP server over stdio, on Bun, with its data from the bakery at `BAKERY_URL` (default `http://hapi-sidecar:8080`): a `health` tool, then `crack_cookie`, which gives a fortune and three lucky numbers and takes a seed, so a test can repeat it.

## Constraints

- Add `@modelcontextprotocol/sdk` and `zod`, the SDK's peer dependency for a tool's input schema, with one `bun add`: `bunfig.toml` pins each to the exact newest version older than its release age. They are the only dependencies this task names.
- `src/server.ts` exports `createServer()`, which returns (or resolves to) the SDK's `McpServer`, not yet connected, and loads every module in `src/tools/` at start, so a later tool adds only its own files. Run as the main module (`bun src/server.ts`), it connects that server to stdio; imported, it connects nothing.
- stdout carries MCP messages only. Anything else goes to stderr.
- Every tool is read-only and says so: `annotations: { readOnlyHint: true }`.
- Each tool returns one text content item holding JSON. `health` gives `{"ok":true}` when the bakery answers `GET /health`. `crack_cookie({ seed })`, its `seed` an optional integer, gives `{ "id", "text", "lucky_numbers" }`: one fortune exactly as the bakery's `GET /fortunes` serves it, and three integers from 1 to 49.
- The unit tests in `tests/` don't need the bakery running.
- `smoke/run.ts` starts the server over stdio and calls `health` against the bakery.
- The acceptance tests in `.factory/work/0001-skeleton-and-crack-cookie/acceptance/` call the tools through the SDK's in-memory client against `createServer()`, with the bakery running.

## Acceptance criteria

1. `check` and `smoke` pass.
2. Every listed tool is read-only, and `health` and `crack_cookie` are among them.
3. `crack_cookie({ seed: 7 })` returns the same fortune and the same three lucky numbers from 1 to 49 on every call.
EOF
```

> **As built (noted 2026-11-12, Task 16, H-310):** the `task.md` merged on the sandbox has a fourth criterion, `4. One commit per piece.`, which is left out here: a fix or a rework adds a commit of its own to each piece it changes, so after 0001's rework the independent review read three commits for two pieces, marked the criterion unmet and said `needs-work` on a head whose `check`, `smoke` and `acceptance` had passed.

**`.factory/work/0001-skeleton-and-crack-cookie/acceptance/tools.test.ts`:** the planner's tests, written by hand. They use the SDK's in-memory client pair against `createServer()`, and read the fixture fortunes from `smoke/bakery/fortunes.json`, the file the verify container's sidecar serves. Each `test(` starts a line, so the harvester's junit check counts them:

```bash
cat > .factory/work/0001-skeleton-and-crack-cookie/acceptance/tools.test.ts <<'EOF'
// The planner's acceptance tests for work order 0001 (hapi-factory docs/runbooks/engine.md).
// The verify container runs them with the bakery up: bun test ./.factory/work/0001-skeleton-and-crack-cookie/acceptance
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../../src/server.ts";

type Fortune = { id: number; text: string };

const fixtures: Fortune[] = await Bun.file(new URL("../../../../smoke/bakery/fortunes.json", import.meta.url)).json();

async function connected(): Promise<Client> {
  const server = await createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "acceptance", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function callJson(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]?.text ?? "");
}

test("health and crack_cookie are listed, and every tool is read-only", async () => {
  const client = await connected();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("health");
    expect(names).toContain("crack_cookie");
    for (const tool of tools) expect([tool.name, tool.annotations?.readOnlyHint]).toEqual([tool.name, true]);
  } finally {
    await client.close();
  }
});

test("crack_cookie with a seed gives the same fixture fortune and three lucky numbers from 1 to 49", async () => {
  const client = await connected();
  try {
    const first = await callJson(client, "crack_cookie", { seed: 7 });
    const second = await callJson(client, "crack_cookie", { seed: 7 });
    expect(second).toEqual(first);
    expect(fixtures).toContainEqual({ id: first.id as number, text: first.text as string });
    const lucky = first.lucky_numbers as number[];
    expect(lucky).toHaveLength(3);
    for (const n of lucky) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(49);
    }
  } finally {
    await client.close();
  }
});
EOF
```

**`docs/design/fortune-mcp.md`:** the order's one source:

```bash
cat > docs/design/fortune-mcp.md <<'EOF'
# The fortune-cookie MCP server

A small read-only MCP server over stdio, on Bun: hapi-factory's sandbox for its run engine. Its data comes from the bakery, a stub HTTP service with a fixed list of made-up fortunes.

## The bakery

`smoke/bakery/server.ts` serves `smoke/bakery/fortunes.json` on port 8080. hapi-factory's `bun-http` sidecar runs it as `bun /data/server.ts` on a run's own network, where its name is `hapi-sidecar`.

- `GET /health`: `{"ok":true}`.
- `GET /fortunes`: every fortune, a JSON array of `{ "id": <number>, "text": <string> }`.
- Anything else: 404.

The server reads the bakery at `BAKERY_URL`, `http://hapi-sidecar:8080` by default. On your own machine, run `bun smoke/bakery/server.ts` and set `BAKERY_URL=http://localhost:8080`.

## The tools

Every tool is read-only (`readOnlyHint: true`) and returns one text content item holding JSON.

- `health`: `{"ok":true}` when the bakery answers.
- `crack_cookie({ seed })`: one fortune and three lucky numbers from 1 to 49, `{ "id", "text", "lucky_numbers" }`. The seed is optional; the same seed gives the same answer.
- `search_fortunes({ keyword })`, a later work order's: `{ "fortunes": [...] }`, every fortune whose text holds the keyword, in any case, at most 10.
- `fortune_of_the_day({ date })`, a later work order's: one fortune for a `YYYY-MM-DD` date, `{ "id", "text" }`, the same on every call.

`src/server.ts` exports `createServer()`, which loads every module in `src/tools/`, so a new tool adds only its own files. `bun src/server.ts` serves it over stdio, where stdout carries MCP messages only.
EOF
```

**`smoke/bakery/server.ts`:** the bakery, on Bun's default host (the sidecar's rule). It reads `fortunes.json` beside itself, by `import.meta.url`, whatever the working directory:

```bash
cat > smoke/bakery/server.ts <<'EOF'
// The bakery: the stub HTTP service the smoke test and the acceptance tests read.
// hapi-factory's bun-http sidecar runs it as `bun /data/server.ts`, with this directory at /data.
// It listens on Bun's default host, so a run reaches it by its name, hapi-sidecar.
const fortunes = Bun.file(new URL("./fortunes.json", import.meta.url));

Bun.serve({
  port: 8080,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return Response.json({ ok: true });
    if (request.method === "GET" && pathname === "/fortunes") {
      return new Response(fortunes, { headers: { "content-type": "application/json" } });
    }
    return new Response("not found\n", { status: 404 });
  },
});
EOF
```

**`smoke/bakery/fortunes.json`:** ten made-up fortunes. Three hold "tomorrow", which planning PR 2's acceptance test searches for:

```bash
cat > smoke/bakery/fortunes.json <<'EOF'
[
  { "id": 1, "text": "A fresh loaf of luck is rising in your oven." },
  { "id": 2, "text": "Tomorrow brings a quiet morning and a good cup of tea." },
  { "id": 3, "text": "The crumbs you leave today feed the birds of tomorrow." },
  { "id": 4, "text": "Your next idea will fit in a single commit." },
  { "id": 5, "text": "A small bug, fixed early, saves a long night." },
  { "id": 6, "text": "Someone will thank you tomorrow for the notes you write today." },
  { "id": 7, "text": "The oven is hot: bake the hard part first." },
  { "id": 8, "text": "A clean diff is a kind message to your future self." },
  { "id": 9, "text": "Patience and flour make the best bread." },
  { "id": 10, "text": "Good fortune follows those who read the error message." }
]
EOF
```

### Planning PR 2's files

After factory PR 1 has merged (Step 9). Two work orders, each with one piece and a fresh traceparent, every other field as in 0001. They share no file, so neither is `held`.

```bash
mkdir -p .factory/work/0002-search-fortunes/acceptance \
  .factory/work/0003-fortune-of-the-day/acceptance
```

**`0002-search-fortunes`:**

```bash
TP="$(printf '00-%s-%s-01\n' \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 8)")"
cat > .factory/work/0002-search-fortunes/order.yaml <<EOF
# Work order 0002, written by hand for hapi-factory's end-to-end run (docs/runbooks/engine.md).
id: 0002-search-fortunes
lane: factory
workflow: factory-task
risk: low
roles:
  implement: large
  review: medium
# budget.usd is at least runs.phases.round_usd (1.00), or the review run is refused (H-259).
budget:
  usd: 2.00
  turns: 40
  minutes: 30
pieces:
  - id: search-fortunes
    size: small
    files:
      - src/tools/search-fortunes.ts
      - tests/search-fortunes.test.ts
verify:
  smoke: true
egress_extra: []
trace:
  traceparent: "$TP"
sources:
  - docs/design/fortune-mcp.md
EOF
```

```bash
cat > .factory/work/0002-search-fortunes/task.md <<'EOF'
# search_fortunes

## Goal

Add `search_fortunes` to the fortune-cookie MCP server: every fortune from the bakery whose text holds a keyword.

## Constraints

- One new tool module, `src/tools/search-fortunes.ts`, and its unit test, `tests/search-fortunes.test.ts`: `src/server.ts` loads every module in `src/tools/`, so nothing else changes. No new dependency.
- The tool is read-only and says so: `annotations: { readOnlyHint: true }`.
- `search_fortunes({ keyword })`, its `keyword` a non-empty string, returns one text content item holding JSON: `{ "fortunes": [{ "id", "text" }, ...] }`, each fortune exactly as the bakery's `GET /fortunes` serves it.
- The unit test in `tests/` doesn't need the bakery running.
- The acceptance test in `.factory/work/0002-search-fortunes/acceptance/` calls the tool through the SDK's in-memory client against `createServer()`, with the bakery running.

## Acceptance criteria

1. `check` and `smoke` pass.
2. `search_fortunes({ keyword })` returns every fortune whose text contains the keyword, case-insensitive, up to 10.
EOF
```

```bash
cat > .factory/work/0002-search-fortunes/acceptance/search-fortunes.test.ts <<'EOF'
// The planner's acceptance tests for work order 0002 (hapi-factory docs/runbooks/engine.md).
// The verify container runs them with the bakery up: bun test ./.factory/work/0002-search-fortunes/acceptance
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../../src/server.ts";

type Fortune = { id: number; text: string };

const fixtures: Fortune[] = await Bun.file(new URL("../../../../smoke/bakery/fortunes.json", import.meta.url)).json();

async function connected(): Promise<Client> {
  const server = await createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "acceptance", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function search(client: Client, keyword: string): Promise<Fortune[]> {
  const result = await client.callTool({ name: "search_fortunes", arguments: { keyword } });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  return (JSON.parse(content[0]?.text ?? "") as { fortunes: Fortune[] }).fortunes;
}

const byId = (a: Fortune, b: Fortune) => a.id - b.id;

test("search_fortunes finds exactly the fixture fortunes holding a keyword in another case, at most 10", async () => {
  const keyword = "TOMORROW";
  const want = fixtures.filter((f) => f.text.toLowerCase().includes(keyword.toLowerCase()));
  expect(want.length).toBeGreaterThan(1);
  const client = await connected();
  try {
    const got = await search(client, keyword);
    expect(got.length).toBeLessThanOrEqual(10);
    expect([...got].sort(byId)).toEqual([...want].sort(byId).slice(0, 10));
  } finally {
    await client.close();
  }
});

test("search_fortunes finds none for a keyword no fixture holds", async () => {
  const keyword = "zeppelin";
  expect(fixtures.some((f) => f.text.toLowerCase().includes(keyword))).toBe(false);
  const client = await connected();
  try {
    expect(await search(client, keyword)).toEqual([]);
  } finally {
    await client.close();
  }
});
EOF
```

**`0003-fortune-of-the-day`:**

```bash
TP="$(printf '00-%s-%s-01\n' \
  "$(openssl rand -hex 16)" "$(openssl rand -hex 8)")"
cat > .factory/work/0003-fortune-of-the-day/order.yaml <<EOF
# Work order 0003, written by hand for hapi-factory's end-to-end run (docs/runbooks/engine.md).
id: 0003-fortune-of-the-day
lane: factory
workflow: factory-task
risk: low
roles:
  implement: large
  review: medium
# budget.usd is at least runs.phases.round_usd (1.00), or the review run is refused (H-259).
budget:
  usd: 2.00
  turns: 40
  minutes: 30
pieces:
  - id: fortune-of-the-day
    size: small
    files:
      - src/tools/fortune-of-the-day.ts
      - tests/fortune-of-the-day.test.ts
verify:
  smoke: true
egress_extra: []
trace:
  traceparent: "$TP"
sources:
  - docs/design/fortune-mcp.md
EOF
```

```bash
cat > .factory/work/0003-fortune-of-the-day/task.md <<'EOF'
# fortune_of_the_day

## Goal

Add `fortune_of_the_day` to the fortune-cookie MCP server: one fortune from the bakery for a date, the same every time it is asked.

## Constraints

- One new tool module, `src/tools/fortune-of-the-day.ts`, and its unit test, `tests/fortune-of-the-day.test.ts`: `src/server.ts` loads every module in `src/tools/`, so nothing else changes. No new dependency.
- The tool is read-only and says so: `annotations: { readOnlyHint: true }`.
- `fortune_of_the_day({ date })`, its `date` a `YYYY-MM-DD` string, returns one text content item holding JSON: `{ "id", "text" }`, one fortune exactly as the bakery's `GET /fortunes` serves it. It depends on the date alone, never on the clock.
- The unit test in `tests/` doesn't need the bakery running.
- The acceptance test in `.factory/work/0003-fortune-of-the-day/acceptance/` calls the tool through the SDK's in-memory client against `createServer()`, with the bakery running.

## Acceptance criteria

1. `check` and `smoke` pass.
2. `fortune_of_the_day({ date })` returns one fortune per `YYYY-MM-DD`, the same on every call.
EOF
```

```bash
cat > .factory/work/0003-fortune-of-the-day/acceptance/fortune-of-the-day.test.ts <<'EOF'
// The planner's acceptance test for work order 0003 (hapi-factory docs/runbooks/engine.md).
// The verify container runs it with the bakery up: bun test ./.factory/work/0003-fortune-of-the-day/acceptance
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../../src/server.ts";

type Fortune = { id: number; text: string };

const fixtures: Fortune[] = await Bun.file(new URL("../../../../smoke/bakery/fortunes.json", import.meta.url)).json();

async function connected(): Promise<Client> {
  const server = await createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "acceptance", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

async function ofTheDay(client: Client, date: string): Promise<Fortune> {
  const result = await client.callTool({ name: "fortune_of_the_day", arguments: { date } });
  expect(result.isError).not.toBe(true);
  const content = result.content as { type: string; text?: string }[];
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]?.text ?? "") as Fortune;
}

test("fortune_of_the_day gives the same fixture fortune for 2026-11-01 on every call", async () => {
  const client = await connected();
  try {
    const first = await ofTheDay(client, "2026-11-01");
    const second = await ofTheDay(client, "2026-11-01");
    expect(second).toEqual(first);
    expect(fixtures).toContainEqual({ id: first.id, text: first.text });
  } finally {
    await client.close();
  }
});
EOF
```

### Step 5: planning PR 1

From your hapi-factory checkout, in the sandbox clone:

```bash
cd ../hapi-sandbox-fortune
git switch main && git pull --ff-only
git switch -c plan/0001-skeleton-and-crack-cookie
```

Write [planning PR 1's files](#planning-pr-1s-files), then:

```bash
git add .factory/ docs/design/fortune-mcp.md smoke/bakery/
git commit -m "plan: 0001 skeleton and crack_cookie"
git push -u origin plan/0001-skeleton-and-crack-cookie
gh pr create --base main --label lane:planning \
  --title "plan: 0001 skeleton and crack_cookie" \
  --body "Planning PR 1 (hapi-factory docs/runbooks/engine.md)"
```

**Before you merge it: does CodeRabbit review the sandbox's PRs at all?** This is the sandbox's first PR, and one you opened, which CodeRabbit reviews on your own seat. CodeRabbit asks for a manual trigger on a public repo with fewer than 10 stars on some plans ([spike 09](../spikes/09-run-engine-offline.md), finding 22), and the factory never @-mentions it. Give it 15 minutes, then read the check runs on the PR's head:

```bash
OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
SHA="$(gh pr view plan/0001-skeleton-and-crack-cookie --repo "$R" \
  --json headRefOid --jq .headRefOid)"
gh api "repos/$R/commits/$SHA/check-runs" \
  --jq '.check_runs[] | [.name, .app.id, .status, .conclusion, .output.title] | @tsv'
```

Paste back the rows. Expected, among the rows: `ci / gates`, `ci / check` and `ci / scan` (app `15368`) completed `success`, and `CodeRabbit` (app `347564`) completed `success` with a title starting `Finished`. No `CodeRabbit` row, or a title such as `Review skipped` or `Review paused`, or a CodeRabbit comment asking for a manual review: paste it back and go on. Nothing in the run waits on it while the round on the PR is off; with `flags.coderabbit.enabled` on, stop and report instead, since the factory PR's round would never come.

Then, with `ci / gates` green, merge it on GitHub with a merge commit (your bypass of `main-review`, as for every merge into `main`), and paste back its number and merge SHA. Keep GitHub's merge title as it fills it in (`Merge pull request #<n> from <owner>/<branch>`): the poller finds a work order's planning PR from that subject alone, and an edited one leaves the work order with no planning PR, so no status comment.

```bash
OWNER="$(gh api user --jq .login)"
gh pr list --repo "$OWNER/hapi-sandbox-fortune" --state all \
  --head plan/0001-skeleton-and-crack-cookie \
  --json number,mergeCommit --jq '.[0] | [.number, .mergeCommit.oid] | @tsv'
```

### Step 6: watch it

Run [the watch](#commands-you-run-more-than-once) every few minutes until the factory PR opens, and paste back each output in which a phase changed. Expected:

- **The worker starts within 120 s of the merge** (the next tick), and the planning PR gets its status comment. Until that tick, the watch prints `hapi status: <owner>/hapi-sandbox-fortune has no work order with a state yet`. Paste it back with [the status comment command](#commands-you-run-more-than-once). **H-293:** its first line must read `hapi-factory[bot] Bot via-app:true …`: the poller adopts a lost status comment only when GitHub marks it as the App's. `via-app:false`: report it (a lost mark would then post a second comment).
- **The phases run `queued` → `worker` → `verify` → `review` → `harvest` → `pr`**, with at most one `fix` (and its `verify` and `review`) before `harvest`, then `waiting` on the next tick (with `flags.coderabbit.enabled` on, `pr-review` first, while CodeRabbit reviews the PR). Verify's `smoke` passing settles design §7 item 11 (the MCP SDK's stdio server under Bun).
- **The host gates pass on the worker's bundle** (I1's live check). The gates expect each commit's author and committer to be the generated worker identity (`hapi-factory worker`, `WORKER_IDENTITY` in `src/generate/archon.ts`). A row `failed` whose reason holds `not the generated worker identity` means Archon's executor sets its own git identity: paste it back and stop. Match on those words: the raw reason is ``commit <h7>'s committer is `<who>`, not the generated worker identity (src/generate/archon.ts)`` (or `author`), but the status comment and `hapi status` show it with every backtick, `@`, `<` and `>` taken out of the name and email. It fails closed: nothing is pushed, and a retry would fail the same way.
- **The worker's `bun add` works under the image's `BUN_OPTIONS=--no-install`** (Task 1's ruling). Once the factory PR is open, read its branch's `package.json` and `bun.lock`:

  ```bash
  OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
  B=factory/0001-skeleton-and-crack-cookie
  gh api "repos/$R/contents/package.json?ref=$B" \
    -H "Accept: application/vnd.github.raw+json" \
    | grep -n -e modelcontextprotocol -e '"zod"'
  gh api "repos/$R/contents/bun.lock?ref=$B" \
    -H "Accept: application/vnd.github.raw+json" | grep -c '"@modelcontextprotocol/sdk@'
  ```

  Expected: `"@modelcontextprotocol/sdk": "<x.y.z>"` (an exact version, no `^` or `~`; `zod` beside it), and a count of at least 1; the verify run's `check` passing shows `bun ci --frozen-lockfile` agreed with the lock. Then the command the worker ran, from its run's transcript, with the worker's run id (from [the runs](#commands-you-run-more-than-once)) in place of `0123456789ab`:

  ```bash
  sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
    export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
    cd "$HOME/hapi-factory" && mise run hapi -- run watch "$1" \
      | grep -o "bun add[^\"]\{0,100\}" | head -n 5' \
    hapi-watch 0123456789ab
  ```

  Paste back both. No SDK in `package.json` or `bun.lock`, or a transcript showing `bun add` failing: stop and report. A second read that prints nothing is no stop: the transcript then shows no `bun add` line, and the ruling rests on the first read's result and on verify's frozen install. That is what the run found (2026-11-10): no `bun add` line in worker run `1433bf348f72`'s transcript, with `"@modelcontextprotocol/sdk": "1.32.2"` and `"zod": "4.6.7"` in `package.json` at `cb7b218`, and the SDK named once in `bun.lock`.
- **The PR** ([a factory PR's command](#commands-you-run-more-than-once), with `WO=0001-skeleton-and-crack-cookie`):
  - the worker's two commits, `0001-skeleton-and-crack-cookie: skeleton` and `…: crack-cookie` (a fix before the PR adds its own, one per piece it changed), each with author and committer `hapi-factory worker`, `6` trailers and `false` for `Co-authored-by`. **H-300 is observe-only:** a `true` there means a worker wrote a `Co-authored-by` line outside git's trailer block, which the host's trailer check doesn't refuse; paste back the PR's commits page for it (does GitHub credit a co-author?). Never craft one;
  - §3.7's description: `## Verdict`, `## Unresolved` (with **Check this yourself**), `## Links`, `## Asked and built`, `## Evidence`, `## Review rounds`, `## Cost and turns`, in that order;
  - the Evidence's `acceptance` row from the verify container (`passed`), and the verdict **Ready to merge** only if it passed (until `ci / gates` is green on the head, **Waiting for `ci / gates`**);
  - a `decide: diff-screen v<version>` row whose files were answered `via jev` (the cell reads `<n> files screened (<n> asked, <n> reused; jev <n>)`: the sandbox is public, so Jev is asked);
  - any hold names its file under Unresolved, and is still there after `ci / gates` turns green;
  - if the body is the short fallback (`_The full report is too long for this PR's body (GitHub's size limit): …_`), paste back the watch too: `hapi status` lists every reason. A row reason `the PR body has no room for the host's part: <n> characters of it are outside the hapi markers` means text you wrote outside the markers leaves no room: trim it ([Troubleshooting](#troubleshooting)).
- **The decisions, for each harvest** ([the ledger by head](#commands-you-run-more-than-once)): paste it back after each harvest. Record, for each head, its calls (of 24) and its holds by cause, from the PR's verdict lines: coverage (`held: <n> files not screened (call cap 24)`, `… (no classifier answered)`) apart from findings (`held: text aimed at the reviewer in <paths>`). **Stop and report if any harvest's answers are all `via: default`**, or the Evidence row says `not screened` for every subject: the keys or hapi's egress are wrong. `gates.decisions.max_calls_per_head` stays 24 during the run (`policy/gates.yaml` is protected); if **Ready to merge** never shows because of coverage holds, that is the signal to propose raising it afterwards, not to change it now.
- **CodeRabbit on a PR the factory's App opened** (design §7 item 10; H-312 has what this run found): paste back the `CodeRabbit` row (app `347564`) among the factory PR's check runs on the head the harvest first pushed, and any comment CodeRabbit left. On a paid plan a skip is expected, `Review skipped: bot user not eligible for review`, unless the App's bot holds a seat; and with the round on the PR off, as shipped, the engine reads neither and nothing waits on them. With `flags.coderabbit.enabled` on, the row must be completed `success`, titled `Finished…`, and a skip is where you stop: paste the row and the PR's Unresolved back. It shows one of two ways: a completed row that isn't a `success` titled `Finished…` (such as one titled `Review skipped` or `Review paused`) puts the work order at `waiting` at once, with `CodeRabbit did not review <h7>: <title>`; no row, or one still running, ends the round `waiting` after six polls (12 minutes), with `CodeRabbit didn't review <h7>`.
- **The forge reads with the App's own tokens** (H-288, design §7 item 7): the CodeRabbit round reading its check run, and the verdict leaving **Waiting for `ci / gates`** once CI is green, show `GET …/commits/<sha>/check-runs` works with the factory App's Checks: read alone; [the journal's problem lines](#commands-you-run-more-than-once) show no `failed closed` naming a check-runs read. **Stop and report**, with the journal's problem lines and [a factory PR's command](#commands-you-run-more-than-once)'s output, if a `failed closed` line names `check-runs`, or if, with the row at `pr-review` or `waiting` and no live run of the work order in `hapi run list`, the verdict is still **Waiting for `ci / gates`** two ticks (four minutes) after `ci / gates` turned green on the head. While a `pr-fix` run is live the engine doesn't re-render the body, so a head whose CodeRabbit round started a fix before CI finished keeps **Waiting for `ci / gates`** until that fix's harvest renders the next head: that is expected, not a stop. Then, once, the label half of H-288, on the merged planning PR (whose labels the engine never reads): add a label it already has, and count its `labeled` events:

  ```bash
  OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
  PLAN="$(gh pr list --repo "$R" --head plan/0001-skeleton-and-crack-cookie \
    --state all --json number --jq '.[0].number')"
  gh api -X POST "repos/$R/issues/$PLAN/labels" -f 'labels[]=lane:planning' \
    --jq 'map(.name) | join(",")'
  gh api --paginate "repos/$R/issues/$PLAN/events" \
    --jq '.[] | select(.event == "labeled"
      and .label.name == "lane:planning") | .created_at'
  ```

  Paste back both. Expected: `lane:planning`, then one time only, from `gh pr create`: re-adding a label a PR already has records no `labeled` event, as the fake forge assumes. Two times, or an error from either call: stop and report.
- **With the CLI on (Step 3)**, after the first review run (its id from [the runs](#commands-you-run-more-than-once), in place of `0123456789ab`), its CodeRabbit output's closing lines and finding counts (design §7 item 5: what exit 0 means), then the review proxy's tunnels (H-298: which of the review zone's three CodeRabbit hosts the CLI uses):

  ```bash
  sudo -u hapi -H -- sh -c 'f="$HOME/.local/state/hapi/runs/$1/out/coderabbit.ndjson"; \
    jq -c "select(.type == \"complete\" or .type == \"error\" or .type == \"hapi\") \
      | {type, outcome, status, reused, unreviewedFileCount, \
        errorType, exit, skipped}" "$f"; \
    jq -r "select(.type == \"finding\") | .severity" "$f" | sort | uniq -c' \
    hapi-cr 0123456789ab
  sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
    export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
    docker logs hapi-egress-review-1 2>&1 | grep -Eo "CONNECT [^ ]+" | sort | uniq -c'
  ```

  Paste back both. Expected: a `complete` line whose `outcome` (or, with none, `status`) is `completed`, with `reused` not `true` and `unreviewedFileCount` `0` or `null`; then the `hapi` line with `exit` `0` or `2` (2 is `--gate major` tripping); and tunnels to `api.anthropic.com:443` and `cli.coderabbit.ai:443`. With any other `complete` line, the PR's Evidence row `CodeRabbit's CLI` reads `not reviewed: <why>`: paste that row back too. **Stop and report** if there is no `complete` line, an `error` line, a `hapi` line with `skipped`, or a `hapi` line whose `exit` is neither `0` nor `2`. A tunnel to `app.coderabbit.ai:443` or `ide.coderabbit.ai:443` is no stop: paste it back, since the one live run used neither, and H-298 drops them only after a second.

  > **As built (noted 2026-11-12, Task 16, H-298, H-312):** review run `407263f1fcbf` of `0004-get-fortune` was the CLI's first live run (2026-11-12). Its `out/coderabbit.ndjson` held four lines: a `review_context` line; a `status` line (`"status":"promo_credits_granted"`); `{"type":"complete","status":"review_completed","findings":0,"gate":{"threshold":"major","status":"passed","blockingFindings":0},"reviewedFiles":[…],"outcome":"completed","message":"Review completed"}`; and `{"type":"hapi","exit":0}`. So `outcome` is `completed` while `status` is `review_completed`, and the line carried no `reused` and no `unreviewedFileCount`, which this read prints as `null`. It has three fields the read leaves out and the harvest doesn't read: `findings` (a count), `gate` and `reviewedFiles`, whose two entries had the lengths of the diff's two paths, `src/tools/get-fortune.ts` and `tests/get-fortune.test.ts` (H-312(g)). The PR's Evidence read `reviewed: 0 findings, 0 major or critical`. The proxy's log since its start held `5 CONNECT api.anthropic.com:443` and `4 CONNECT cli.coderabbit.ai:443` and no other host: the earlier text here expected `app.coderabbit.ai` and `ide.coderabbit.ai` and took a missing `cli.coderabbit.ai` tunnel as leave to drop that host, and the run showed the opposite. All three stay on the review zone until a second run (H-298).
- **H-281, the poller unit's two hardening settings:** while a run is live (the worker's, say, in `hapi run list`), run [the live check of the stop](stack.md#4-mise-run-up-and-mise-run-down) (stack.md's block, as it stands), and paste back its five lines (expected there). Once the PR is `waiting`, the modes a run container's uid needs, in the mirror and the scratch:

  ```bash
  OWNER="$(gh api user --jq .login)"
  sudo -u hapi -H -- sh -c 'e="$HOME/.local/state/hapi/engine"; \
    for d in "$e/mirrors/$1.git" "$e/scratch/$1"; do \
      [ -d "$d" ] || { echo "${d#"$e"/}: not there"; continue; }; \
      n=$(find "$d" -mindepth 1 \
        \( -type d ! -perm -o=rx -o -type f ! -perm -o=r \) \
        | wc -l); \
      echo "${d#"$e"/}: $n entries other users can not read"; \
    done; cd "$e" && stat -c "%a %n" "mirrors/$1.git" "scratch/$1"/*.git' \
    hapi-modes "$OWNER/hapi-sandbox-fortune"
  ```

  Paste it back. Expected: `0` for both, and `755` (or `2755`) for each git dir: the harvester reopens the scratch to all once its scan is clean, and the mirror is `--shared=0644`. Step 10 checks the other half.

**If a row says `failed`:** paste back the watch, [the journal's problem lines](#commands-you-run-more-than-once) and the row's reason, then stop. The reason can be as little as `<kind> run <id> ended failed: the workflow failed (Archon status failed)`: the cause is then in the run's own files (its record, its `out/`, its transcript), and this runbook has no read of them yet (H-314), so the controller writes one for the occasion.

> **As built (noted 2026-11-12, Task 16, H-314):** 0001's first worker, `6323f1cf684f`, failed with exactly that reason on 2026-11-09. The controller's own read of the run found the cause in its transcript, at the `implement` node and before any model call: `hapi-guard: anthropic/claude-opus-5-5: cost differs from the pin; the node fails` (H-307, a defect of hapi-factory's, fixed by its PR #16). That read was a script in a temporary directory, which the reboot of 2026-11-11 cleared (H-313).

- **If the cause was outside the work order** (a rate limit, a timeout, `mise run down`, a flaky preflight, or a defect in hapi-factory once its fix is [deployed](#redeploying-during-the-run)), the controller says so, and you queue a fresh pass, from your own terminal:

  ```bash
  OWNER="$(gh api user --jq .login)"
  sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
    export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
    cd "$HOME/hapi-factory" && mise run hapi -- retry "$1" "$2" && \
    mise run hapi -- status "$1"' \
    hapi-retry "$OWNER/hapi-sandbox-fortune" 0001-skeleton-and-crack-cookie
  ```

  For planning PR 2, the last argument is `0002-search-fortunes` or `0003-fortune-of-the-day`. Paste back both outputs. Expected: `hapi retry: <owner>/hapi-sandbox-fortune 0001-skeleton-and-crack-cookie is queued again (retry 1), with <k> of the repo's work orders ahead of it: a poll tick starts its worker at <sha12> once none is ahead and the caps allow`; the row `queued`, with `retry 1` in Rounds. With `k` 0 (as for 0001), the watch shows `worker` within 120 s; with `k` 1 (planning PR 2, its sibling still before its PR), it starts once the sibling has opened its PR or settled. If a cap trips, the row says `cap-stopped` with the cap's text instead. Its refusals are in [a failed work order](#a-failed-work-order). Then keep watching.
- **If the work order itself is wrong**, stop and report it: it needs a new id in a new planning PR, and the old id stays `failed`.
- **If the month's cap trips**, the row is `cap-stopped` (or a verify or review waits in its phase) with `this month's spend on <owner>/hapi-sandbox-fortune ($<spent>) plus the run's budget ($<budget>) would pass budgets.repo_monthly_usd ($15.00): no new run for it until <date>`: paste it back and stop (design §4's point 9 records it).
- **If the day's cap trips**, the row is `cap-stopped` (or a verify or review waits in its phase) with `today's spend ($<spent>) plus the run's budget ($<budget>) would pass budgets.daily_usd ($10.00): nothing new starts until <date> (UTC)`: paste it back and stop (design §4's point 9 records it). It is the cap this run most likely meets. `budgets.daily_usd` is central only (all repos together, per UTC day), so the sandbox's overlay can't change it, and the poller checks each start's whole budget ($2.00 for a worker, $1.00 for a review or fix) on top of the day's spend so far. The work order goes on by itself once the next UTC day begins; the controller decides whether to wait for it.
- Each attempt spends against the overlay's $15.

#### Redeploying during the run

When the cause is a defect in hapi-factory, its fix merges into hapi-factory's `main` first, and hapi's checkout then takes it. `mise run down` removes a live run with its outputs, so first stop the poller's timer and wait out a tick that is already running, as hapi. Stopping the timer keeps later ticks from starting; a tick that is running goes on to its end, and may still start a run.

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; \
  systemctl --user stop hapi-poll.timer; \
  while [ "$(systemctl --user show -p MainPID --value \
    hapi-poll.service)" != 0 ]; do sleep 1; done; \
  echo "the timer is stopped, and no tick is running"'
```

Once it prints its line, no run can start before `down`. Then wait until no run is live (the watch's `hapi run list`; a work order at `failed` or `waiting` has none), and redeploy, as hapi (`up` starts the timer again):

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR \
    DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus" \
    PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && git pull --ff-only && \
  mise run down && mise run up && \
  systemctl --user list-timers hapi-poll.timer --no-pager'
```

Paste back the pull's range, `up`'s last line and the timer's row. Expected: a range ending at the fix's merge commit; `the stack is up (Compose project hapi): egress-hermes, egress-archon, egress-research, egress-review, hermes (…)`; `hapi-poll.timer` with NEXT within 120 s. If you deploy with flags, end `mise run up` with the same ones, `-- --roster <name>` for a roster other than the default and `--config <file>` for a secrets config of your own: `down` has already stopped the stack when an `up` without them fails. `down` comes first because `up` alone fails after a reboot (H-305, [Troubleshooting](#troubleshooting)). Then, for a work order the defect left `failed`, run the retry above once the controller has ruled the cause outside the work order. A work order at `waiting` stays there across the redeploy.

> **As built (noted 2026-11-12, Task 16):** the run redeployed three times. On 2026-11-10 the operator pulled hapi's checkout and ran `mise run up` after hapi-factory PR #16 merged (`c977f44`, H-307; the timer stopped at 08:48:54 CST and started at 08:49:21), then ran `hapi retry` for 0001; and again after PR #17 merged (`a448d6c`, H-308 and H-309; stopped at 09:54:15 CST, started at 09:54:19), with 0001 at `waiting`. On 2026-11-12 at about 20:52 CST, after PR #18 merged (`19ab0ff`) and with the host rebooted on 2026-11-11, it was `git pull --ff-only` (`a448d6c..19ab0ff`), `mise run down` (five containers and five networks removed, `hapi_outbound` among them) and `mise run up`; the poller's first ticks, at 20:54:19 and 20:56:24 CST, printed `nothing to do`.

### Step 7: CodeRabbit, then one rework

1. Wait until the status comment's row says `waiting`: the tick after the PR opens. With `flags.coderabbit.enabled` on, it gets there after CodeRabbit's round 0 and at most one automatic fix run (`pr-fix`, then its `verify`, `review` and harvest), or at once when CodeRabbit found nothing at major or above.
2. Post the comment first, then add the label (a rework is given the comments there are when it starts):

   ```bash
   OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
   PR="$(gh pr list --repo "$R" --head factory/0001-skeleton-and-crack-cookie \
     --state all --json number --jq '.[0].number')"
   gh pr comment "$PR" --repo "$R" \
     --body "Rework: make crack_cookie's lucky numbers distinct."
   gh pr edit "$PR" --repo "$R" --add-label hapi:rework
   ```

3. Watch, as in Step 6. Within two ticks (four minutes) the row moves to `fix`, and `hapi run list` shows a new fix run; then wait until the row says `waiting` again, with `1 rework` in Rounds. If it is still `waiting` with no new fix run after those two ticks, see [the end of this step](#the-rework-didnt-start).

Change a factory PR only this way. Never push to `factory/<id>` yourself, or use GitHub's **Update branch** or **Resolve conflicts** on it: a commit without the six trailers turns `ci / gates` red, and main-protect has no bypass (H-295; [the operator always wins](#the-operator-always-wins)).

Paste back the status outputs and the PR's "Review rounds" section:

```bash
OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
PR="$(gh pr list --repo "$R" --head factory/0001-skeleton-and-crack-cookie \
  --state all --json number --jq '.[0].number')"
gh pr view "$PR" --repo "$R" --json body --jq .body \
  | sed -n '/^## Review rounds/,/^## Cost and turns/p'
```

Expected: `Fix rounds: <n> of <cap>.` (the cap is `fix_rounds_before_pr + fix_rounds_on_pr`, 2, but the count includes the rework, so `3 of 2.` after a fix before the PR, one on the PR and the rework is expected: [H-301](../superpowers/plans/handoffs.md)), then one line per fix round, oldest first, as the raw body has them (with backticks): `` - Round <k>, before the PR: run `<id>` `` for a fix before the PR, if one ran; `` - Round <k>, on the PR: run `<id>` `` if CodeRabbit's round ran a fix; and `` - Round <k>, rework: run `<id>` `` last. The rework starting at all shows the poller read the label event's actor with the App's token (design §7 item 7).

#### The rework didn't start

If the row is still `waiting` two ticks after the label, with no new fix run and no cap's text, read [Troubleshooting](#troubleshooting)'s `hapi:rework` rows, then take the label off and add it once more:

```bash
OWNER="$(gh api user --jq .login)"; R="$OWNER/hapi-sandbox-fortune"
PR="$(gh pr list --repo "$R" --head factory/0001-skeleton-and-crack-cookie \
  --state all --json number --jq '.[0].number')"
gh pr edit "$PR" --repo "$R" --remove-label hapi:rework
gh pr edit "$PR" --repo "$R" --add-label hapi:rework
```

**Stop and report** if the rework still hasn't started two ticks (four minutes) after that, pasting back the watch and [the journal's problem lines](#commands-you-run-more-than-once): the poller may not be reading the label event's actor with the App's token (design §7 item 7). Re-label only that once.

### Step 8: merge factory PR 1

Review it. On the PR's **Files changed** tab, open every file GitHub collapsed (**Load diff**) and check the file count against the PR body's: GitHub collapses files it classes as generated with no `.gitattributes` at all (H-302). Before you merge, paste back [a factory PR's command](#commands-you-run-more-than-once)'s output, [the runs](#commands-you-run-more-than-once) and [the ledger by head](#commands-you-run-more-than-once), and say, for each hold and each note, whether you **agree** (it pointed at something you reworked, closed or commented on) or **disagree** (you merge it unchanged): Plan 06's first labelled data (H-262). A hold on a PR you then merge unchanged is a false alarm, and is recorded as one.

Then, with `ci / gates` green, merge it on GitHub with a merge commit, keeping GitHub's merge title as it fills it in, as for every merge in this run, and paste back the merge SHA and, a tick later, the final comment on the planning PR's status thread ([the status comment command](#commands-you-run-more-than-once)). Expected: `This plan has settled: 1 merged, 0 closed, 0 failed. Total: $<x>.`

```bash
OWNER="$(gh api user --jq .login)"
gh pr list --repo "$OWNER/hapi-sandbox-fortune" --state all \
  --head factory/0001-skeleton-and-crack-cookie \
  --json number,mergeCommit --jq '.[0] | [.number, .mergeCommit.oid] | @tsv'
```

### Step 9: planning PR 2

**When to start it.** The day's cap ($10.00, all repos, per UTC day) sums every run started since 00:00 UTC, and the poller adds each start's whole budget on top of that ([Step 6](#step-6-watch-it)'s day cap). Two work orders, each with its worker, reviews and fixes, can come near it on their own, so if planning PR 1's total (Step 8's final comment, `Total: $<x>`) is above about $4, start this step on a new UTC day, not the one 0001's runs ran in. `date -u` shows the UTC date and time.

1. Repeat Step 5 on the branch `plan/0002-search-and-fortune-of-the-day`, with [planning PR 2's files](#planning-pr-2s-files), and these `git` lines in place of Step 5's (add `.factory/config.yaml` too if you took the `coderabbit` line out):

   ```bash
   git add .factory/work/0002-search-fortunes .factory/work/0003-fortune-of-the-day
   git commit -m "plan: 0002 search_fortunes and 0003 fortune_of_the_day"
   git push -u origin plan/0002-search-and-fortune-of-the-day
   gh pr create --base main --label lane:planning \
     --title "plan: 0002 search_fortunes and 0003 fortune_of_the_day" \
     --body "Planning PR 2 (hapi-factory docs/runbooks/engine.md)"
   ```

   Nothing waits on CodeRabbit's check on it, but read it once more ([Step 5](#step-5-planning-pr-1)'s read of the head's check runs, with this branch in place of `plan/0001-skeleton-and-crack-cookie`): a change of plan or seat shows there first. On 2026-11-11 planning PR #4's first head got `Review skipped: manual review required for this OSS repository`, with the operator's trial over (H-312). Merge it with a merge commit once `ci / gates` is green, keeping GitHub's merge title as it fills it in (as in Step 5: the poller finds the planning PR from it), and paste back its number and merge SHA:

   ```bash
   OWNER="$(gh api user --jq .login)"
   gh pr list --repo "$OWNER/hapi-sandbox-fortune" --state all \
     --head plan/0002-search-and-fortune-of-the-day \
     --json number,mergeCommit --jq '.[0] | [.number, .mergeCommit.oid] | @tsv'
   ```
2. Repeat Step 6 until both factory PRs are open. Expected: one work order's worker starts at the next tick, and the other stays `queued` until the first has opened its PR (one pipeline per repo). The second PR's Links name the first as a sibling (`- Siblings: #<n> (independent; merge in any order)`). The first PR's Links name the second only if its body was harvested or re-rendered after the second opened, for example after a fix round on it: a sibling opening its PR doesn't re-render it. Record which PR's Links name which; a first PR without the line is not a failure. Paste back the status comment (with `BRANCH=plan/0002-search-and-fortune-of-the-day`) as both rows move, and, for each PR, a factory PR's command with its `WO` and the ledger by head after its harvest, as in Step 6.
3. Merge each of them with a merge commit, keeping GitHub's merge title, and giving your call on each hold and note as in Step 8. Paste back both numbers and merge SHAs, and the final comment (`This plan has settled: 2 merged, 0 closed, 0 failed. …`):

   ```bash
   OWNER="$(gh api user --jq .login)"
   for WO in 0002-search-fortunes 0003-fortune-of-the-day; do
     printf '%s\t' "$WO"
     gh pr list --repo "$OWNER/hapi-sandbox-fortune" --state all \
       --head "factory/$WO" \
       --json number,mergeCommit --jq '.[0] | [.number, .mergeCommit.oid] | @tsv'
   done
   ```

### Step 10: close out

1. Make the audit token again ([Step 4](#step-4-deploy-then-audit), item 4), run Step 4's strict audit again, and paste back what it prints. Expected: as in Step 4.
2. Read the totals from `hapi status` (the watch's first part: one `Total: $<x>` per planning PR, runs and decisions together) and the `hapi-factory` workspace's spend in the Console, in the Console's own words and with the period it names (on 2026-11-11 it read `$1.21 over last 30 days`: a 30-day figure, not a month-to-date one). Paste back both. Expected: `hapi status`'s totals add up to under $15: they are the figures held to $15. The Console's figure is a cross-check only: it covers the whole `hapi-factory` workspace, any other use of it in that period included, and leaves out the Jev decisions, which OpenRouter bills.
3. **H-281's other half:** whether `NoNewPrivileges=yes` and `UMask=0077` would break the docker CLI a tick runs, in a throwaway unit with the poller's environment (it changes no unit and starts no run):

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; \
     systemd-run --user --wait --pipe --quiet --collect \
       -p NoNewPrivileges=yes -p UMask=0077 \
       --setenv=PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
       --setenv=XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
       -- sh -c "umask; docker version \
         --format {{.Client.Version}}/{{.Server.Version}} && \
         docker run --rm --pull never --network none --entrypoint true \
           hapi-factory/archon:0.12.1 && echo a container started"'
   ```

   Paste it back. Expected: `0077`, the client's and the daemon's versions, and `a container started`: the docker CLI starts a container under both. Whether `UMask=0077` would leave a run container's uid unable to read what the launcher and the harvester write for it is the controller's call, from Step 6's modes and the code; the unit stays as it is until then.
4. Paste back [the runs](#commands-you-run-more-than-once) and the full decision ledger, line by line ([Decisions' read](#decisions), with the sandbox filled in), for the record:

   ```bash
   OWNER="$(gh api user --jq .login)"
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/.local/state/hapi/engine/decisions/$1" && \
     jq -c "select(.kind == \"answer\") | {workOrder, retry, run: .run[0:12], \
       head: .head[0:7], decision, version, subject, part, public, models, \
       via, verdict, effect, cost_usd}" *.jsonl' \
     hapi-decisions "$OWNER/hapi-sandbox-fortune"
   ```
5. Raise the Console limit again only if you choose to.

### The record

The controller fills these from what you pasted (Task 16 Step 11), with `<owner>` for your login, and records each retry, its cause and its spend in spike 09's "Live check" addendum. Each point that failed, and each cap that tripped without saying so, becomes a new register item.

> **As built (noted 2026-11-12, Task 16):** filled below for the run of 2026-11-06 to 2026-11-12 on `<owner>/hapi-sandbox-fortune`: planning PRs #2, #4 and #7; work orders `0001-skeleton-and-crack-cookie`, `0002-search-fortunes`, `0003-fortune-of-the-day` and `0004-get-fortune`; factory PRs #3, #5, #6 and #8, all merged. Clock times are the host's, CST (UTC−6), or UTC where they end in `Z`; a time after 18:00 CST is the next day in UTC. The sources are what the operator pasted, as the controller's ledger of the run holds it, and GitHub; where the two differ, both are given, and what neither holds is said to be not recorded.

**The runs.** Every pass's runs, in the order they ran; a later pass's carry `(retry <n>)` in Round. A pass's verdict and CodeRabbit's part stand on the row of its review run, the last before its harvest; its other rows have `-`:

| Work order | Run | Kind | Round | Status | Spend | Verdict | CodeRabbit |
|---|---|---|---|---|---|---|---|
| `0001-skeleton-and-crack-cookie` | `6323f1cf684f` | worker | 0 | failed | none: no model call, `spendUsd` null; counted at $2.00 | no PR; the status row: `worker run 6323f1cf684f ended failed: the workflow failed (Archon status failed)` | none: no head, no PR |
| `0001-skeleton-and-crack-cookie` | `1433bf348f72` | worker | 0 (retry 1) | succeeded | $0.331154246 | - | - |
| `0001-skeleton-and-crack-cookie` | `9abcf06679c8` | verify | 0 (retry 1) | succeeded | none (no model) | - | - |
| `0001-skeleton-and-crack-cookie` | `ac62df5d285d` | review | 0 (retry 1) | succeeded | $0.1153063 | PR #3 at `cb7b218`: `**Needs your decision** · risk: yellow`, with `held: 1 file not screened (skip_paths names it as a lockfile, but it doesn't parse as bun.lock)` | CLI: `off (runs.phases.coderabbit)`. On the PR, in the operator's trial: check `Finished`; `Actionable comments posted: 1` (a `Minor`) and `Nitpick comments: 1` (`Trivial`); no `pr-fix` run |
| `0001-skeleton-and-crack-cookie` | `f1c5b12d20db` | fix | 1 (retry 1) | succeeded | $0.09107846 | - | - |
| `0001-skeleton-and-crack-cookie` | `4cd58e2388e5` | verify | 1 (retry 1) | succeeded | none (no model) | - | - |
| `0001-skeleton-and-crack-cookie` | `50151ebbd187` | review | 1 (retry 1) | succeeded | $0.1212177 | PR #3 at `0669be0`: `**Needs your decision** · risk: yellow`, with `the independent review says needs-work` and `acceptance criterion 4 of 4 is unmet` | CLI: `off (runs.phases.coderabbit)`. On the PR: reviewed unprompted, check `Finished`; no new inline comment, `Nitpick comments: 1` (`Trivial`). The engine starts no round after a rework |
| `0002-search-fortunes` | `d747452f18c1` | worker | 0 | succeeded | $0.11849651 | - | - |
| `0002-search-fortunes` | `4e1a00b285d4` | verify | 0 | succeeded | none (no model) | - | - |
| `0002-search-fortunes` | `4e5fe006b7be` | review | 0 | succeeded | $0.0413172 | PR #5 at `7a2e5ca`: first ``**Waiting for `ci / gates`** · risk: green``, then `**Needs your decision** · risk: yellow`, with `CodeRabbit did not review 7a2e5ca: Review skipped: bot user not eligible for review` | CLI: `off (runs.phases.coderabbit)`. On the PR: check `skipped`, `Review skipped: bot user not eligible for review`; no review |
| `0003-fortune-of-the-day` | `8f4d24c1826a` | worker | 0 | succeeded | $0.1448228 | - | - |
| `0003-fortune-of-the-day` | `5a0606a00a65` | verify | 0 | succeeded | none (no model) | - | - |
| `0003-fortune-of-the-day` | `6ad91da7609b` | review | 0 | succeeded | $0.0466404 | PR #6 at `30dadf8`: first ``**Waiting for `ci / gates`** · risk: green``, then `**Needs your decision** · risk: yellow`, with `CodeRabbit did not review 30dadf8: Review skipped: bot user not eligible for review` | CLI: `off (runs.phases.coderabbit)`. On the PR: check `skipped`, `Review skipped: bot user not eligible for review`; no review |
| `0004-get-fortune` | `2151063a53a4` | worker | 0 | succeeded | $0.14 | - | - |
| `0004-get-fortune` | `efd9367b55be` | verify | 0 | succeeded | none (no model) | - | - |
| `0004-get-fortune` | `407263f1fcbf` | review | 0 | succeeded | $0.04 | PR #8 at `7f50c0d`: first ``**Waiting for `ci / gates`** · risk: green``, then, from 2026-11-13T03:11:03Z, `**Ready to merge** · risk: green`, with `Nothing unresolved.` | CLI, with `cr review --deep --agent --committed --gate major`: `reviewed: 0 findings, 0 major or critical`. On the PR: check `skipped`, `Review skipped: bot user not eligible for review`; with the round off the engine read neither the check nor the comment |

- **When.** 0001's first pass ran on 2026-11-09, from the tick of 21:31:36 CST to the tick of 21:33:40. Its retry ran on 2026-11-10 from 08:50:03 to `waiting` at 09:08:12 CST, and its rework from 10:00:44 to `waiting` at 10:11:04. 0002 and 0003 ran on 2026-11-11, from 17:42:16 to 0003's `waiting` at 18:05:18 CST. 0004 ran on 2026-11-12, from 20:58:31 to `waiting` at 21:08:57 CST.
- **Spend** is each run's own, from its record, for 0001 to 0003. For 0004 it is to the cent, from the status comment's totals as each run ended: its runs' records were not read. Turns, as each PR's Cost line has them: 12 on #3 (8 by the retry's worker, 4 by the rework's fix), 5 on #5, 5 on #6, 6 on #8.
- **Verify's exits**, from each run's `verify.json`: `{"check":0,"smoke":0,"acceptance":0}` for `9abcf06679c8` and `4cd58e2388e5`; the ledger writes `{0,0,0}` for `4e1a00b285d4` and `5a0606a00a65`; `efd9367b55be`'s file was not read, and its PR's Evidence rows read `passed`.
- **The merges.** The operator merged #3 on 2026-11-10T16:22:43Z in GitHub's UI (`336f2d7`), #5 and #6 on 2026-11-12T00:12:28Z and 00:12:32Z with `gh pr merge --merge --admin` (`36ac5a7`, `c7568d0`), and #8 on 2026-11-13T03:17:04Z (`183d747`). #3, #5 and #6 were merged at **Needs your decision**, #8 at **Ready to merge**. None of those three bodies was written again after its merge, so they still read **Needs your decision** (H-311).

**The retry.** One, of `0001-skeleton-and-crack-cookie` (retry 1). Its first worker, `6323f1cf684f`, failed about two minutes after it started, with `worker run 6323f1cf684f ended failed: the workflow failed (Archon status failed)`. The cause was outside the work order: hapi-guard refused the session before any model call, `hapi-guard: anthropic/claude-opus-5-5: cost differs from the pin; the node fails`, because Pi 1.3.0 gives a model with no price tiers a `tiers: undefined` that the guard's pin doesn't have (H-307, closed by hapi-factory PR #16, merged 2026-11-10T14:47:53Z as `c977f44`). After the [redeploy](#redeploying-during-the-run) the operator ran `hapi retry`, which printed `0001-skeleton-and-crack-cookie is queued again (retry 1), with 0 of the repo's work orders ahead of it: a poll tick starts its worker at 989eb85b2d24 …` (as the ledger quotes it, cut there), and the tick of 08:50:03 CST on 2026-11-10 started worker `1433bf348f72`: `0001-skeleton-and-crack-cookie queued -> worker; #2 edited; #2 reopened`. Its spend: the failed pass $0 real, counted at $2.00; the retried pass's round 0 $0.446460546 (worker and review), with decisions of $0.0004 (8 calls); the whole retried pass, the rework's round included, $0.658756706, with decisions of $0.0006 (10 calls), which is all of 0001's real spend. Two points where the ledger and GitHub differ. `#2 reopened` is the poller's word for its own status thread: GitHub's timeline of PR #2 has no reopen. And the ledger has the row after `hapi retry` as `queued`, `0 automatic, 0 rework, retry 1`, `$2.00 (budget: spend unknown)`: no version of the status comment on GitHub shows it (its history goes from the `failed` row at 2026-11-10T03:33:39Z to the retry's `worker` row at 14:50:02Z), since `hapi retry` edits no comment and the retry command prints `hapi status` after it.

**The rework.** One, on PR #3 (round 1), as [Step 7](#step-7-coderabbit-then-one-rework) asks. The operator commented on PR #3 at 2026-11-10T15:58:33Z, `Rework: make crack_cookie's lucky numbers distinct. Also reject a   malformed fortune from the bakery before returning it.` (as posted: Step 7's sentence, then CodeRabbit's `Minor` finding in the operator's words), and added `hapi:rework` at 15:58:34Z. The first tick after the label, 10:00:44 CST, moved the row `waiting -> fix` (run `f1c5b12d20db`), and the row was `waiting` again at 10:11:04, with `0 automatic, 1 rework, retry 1` and no CodeRabbit round. It pushed a third commit, `0669be0`, `0001-skeleton-and-crack-cookie: crack-cookie` (`src/tools/crack-cookie.ts` +19 −1, `tests/crack-cookie.test.ts` +24). The PR then read `Fix rounds: 1 of 2.` over `` - Round 1, rework: run `f1c5b12d20db` `` (H-301's first live case) and `$2.66 over 7 runs (3 with an unknown spend, counted at their budget), 12 turns, decisions $0.0006 (10 calls)`. Its spend: the fix $0.09107846 and its review $0.1212177, $0.21229616 together, with decisions of $0.0002 (2 calls). hapi-factory PR #17 (H-308, H-309) was merged and deployed between round 0 and the rework, and H-308's fix showed at the rework's harvest: `bun.lock` was taken as a lockfile, with no hold.

**The totals.** hapi's counted total, the figure held to $15, is each plan's final comment: `Total: $2.66.` on planning PR #2, `Total: $0.35.` on #4 (0002 $0.16, 0003 $0.19) and `Total: $0.18.` on #7. PR #2 has an earlier final comment too, from the failed first pass, `This plan has settled: 0 merged, 0 closed, 1 failed. Total: $2.00.`, which stayed after the retry (H-311). `hapi status` showed the first two at Step 10, $3.01 of the $15; with 0004's $0.18 that is $3.19, by addition, since `hapi status` was not read again after 0004. The real spend of 0001 to 0003's runs, from their records, is $1.0100 as the ledger adds it to four places ($1.010033616 unrounded): $0.66 for planning PR #2, against its counted $2.66, and $0.35 for #4. 0004's runs are known to the cent only, $0.14 and $0.04. The decisions cost $0.0008 for 0001 to 0003 and $0.0001 for 0004 by hapi's own count; what OpenRouter billed for them is not recorded. The Anthropic Console's figure for the `hapi-factory` workspace at Step 10 (2026-11-11) was `$1.21 over last 30 days`: a 30-day figure for the whole workspace, Plan 02's paid check and other use included, and so not the month-to-date spend the step asked for then. The record holds no Console figure from after 0004.

**The caps.** None tripped: no cap's text and no `cap-stopped` row is in any version of the three status comments. Against the sandbox's month ($15, the overlay's `repo_monthly_usd: 15`), $3.19 was counted. Against the day ($10, central, all repos, per UTC day), the engine's own sum was never pasted; by the ticks, 0001's runs all started on 2026-11-10 UTC ($2.66 at the end), 0002's and 0003's on 2026-11-11 UTC ($0.35), and 0004's on 2026-11-13 UTC ($0.18). Against the Console's monthly limit ($25, set at Step 2), the Console showed `$1.21 over last 30 days`. What was counted at a whole budget, not at a reported spend:

- **The failed worker `6323f1cf684f`**, at $2.00, its work order's `budget.usd`: it ended with no spend total, so its spend is unknown. It is the whole gap between planning PR #2's real $0.66 and its counted $2.66, and it counts against the day and the month (H-311).
- **A live run, until it ends:** $2.00 for a worker, $1.00 for a review or a fix, $0 for a verify. So the status comments showed more than a plan ever cost: at most `$4.00` on PR #2 (2026-11-10T14:50:02Z: the failed run's $2.00 and the live worker's), `$2.16` on PR #4 (2026-11-11T23:52:42Z) and `$2.00` on PR #7 (2026-11-13T02:58:31Z).
- **Every verify run**, at its budget of $0: it leaves no spend total, so each PR's Cost line counts it among the runs `with an unknown spend` (3 on #3, the failed worker and the two verify runs; 1 each on #5, #6 and #8), and every status row with a run reads `(budget: spend unknown)`, also where each model run reported its spend (H-311).

**The pass criteria:** design §4's nine points, then the acceptance tests'. Criterion 3 is recorded as failed for each work order that was retried, with the retry as its evidence; criterion 8 stays reachable under the same id:

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | `mise run new-repo` made the sandbox with the contract, rulesets, both Apps, labels and CodeRabbit | passed; the Apps were added at `new-repo`'s web step, not by its own call | `new-repo --clone` made `<owner>/hapi-sandbox-fortune` (repo id 1450772309, created 2026-11-09T00:10:59Z, public): 30 files, the settings, rulesets 26820049 to 26820052 read back (`main-protect`, `main-review`, `agent-branch-scope`, `tags-admin-only`) and the labels. Its step 8 added all three Apps by the web step, since `gh`'s login can't add a repo to an installation (design §7 item 2; H-304). Step 4's strict audit passed `policy.repos` and, for each repo, `github.app-perms`. CodeRabbit reviewed planning PR 1 unprompted (check `Finished` on `da04b38`); its Configure page after the sandbox was added is not recorded |
| 2 | The two planning PRs merged in turn | passed | #2 at `989eb85` (2026-11-10T03:31:01Z), then #4 at `9173e10` (2026-11-11T23:40:14Z), opened after factory PR #3 had merged. The third, #7, merged at `e57d844` (2026-11-13T02:57:16Z) |
| 3 | Within the poll interval, exactly one run started per work order, with nobody touching anything | failed for 0001, which was retried. One run each, untouched, for 0002, 0003 and 0004; inside the interval for 0004 alone: 0002's started on the first tick after its merge, a second over by GitHub's clocks, and 0003's waited its turn in the repo's queue, as designed | 0001: worker `6323f1cf684f` started 34 s after the merge and failed; the operator ran `hapi retry` (retry 1), and a second worker, `1433bf348f72`, ran. 0002: one worker, `d747452f18c1`, on the first tick after the merge, 121 s after it by GitHub's two times (the merge, and the status comment the tick made once it had started the run), against `runs.poll_interval_s` of 120. 0003: one worker, `8f4d24c1826a`, 12 min 28 s after the merge, on the first tick after 0002 had its PR: the poller moves one pipeline per repo, so the criterion's interval can't hold for a second work order of one planning PR, and its wording didn't allow for that. 0004: one worker, `2151063a53a4`, 75 s after the merge. The record shows no action by the operator between a merge and the PR for 0002, 0003 or 0004 |
| 4 | Each run passed `preflight` and built; verify passed `check`, `smoke` against the bakery and the acceptance tests; the host gates passed; the review gave its verdict and CodeRabbit's (or named why it was skipped); at most one fix round | passed on every pass that reached a PR; failed for 0001's first worker run | 16 runs: 15 succeeded and 1 failed, `6323f1cf684f`, at its `implement` node before any model call (H-307). No `preflight` result was pasted for any run: it is the worker workflow's first node, and the four other worker runs succeeded. Five verify runs (`9abcf06679c8`, `4cd58e2388e5`, `4e1a00b285d4`, `5a0606a00a65`, `efd9367b55be`): `check`, `smoke` and `acceptance` read `passed` on every head. The host gates passed at all five harvests (`passed (9 files)` at `cb7b218`, `passed (2 files)` at the others). The review: `ready: 1 findings, 5 of 5 criteria met` (`cb7b218`), `needs-work: 3 findings, 3 of 4 criteria met` (`0669be0`), `ready: 0 findings, 2 of 2 criteria met` (`7a2e5ca`, `30dadf8`), `ready: 0 findings, 3 of 3 criteria met` (`7f50c0d`). CodeRabbit's CLI: `off (runs.phases.coderabbit)` for 0001 to 0003; `reviewed: 0 findings, 0 major or critical` for 0004, the first with its verdict from the review container. Fix rounds: one in all, 0001's rework; none before a PR |
| 5 | One factory PR per work order, with §3.7's description and the trailers | passed | #3, #5, #6 and #8, each opened by `app/hapi-factory` with `lane:factory`; the sandbox's other PRs are #1 (Dependabot's, open), #2, #4 and #7. §3.7's seven sections stand in order on #3, #5 and #6; of #8 the record quotes its Verdict, Unresolved, Links, Evidence, Review rounds and Cost. All six commits (`1f8a946`, `cb7b218`, `0669be0`, `7a2e5ca`, `30dadf8`, `7f50c0d`) have author and committer `hapi-factory worker`, the six trailers and no `Co-authored-by` |
| 6 | A CodeRabbit finding started one automatic fix run (its PR review's as designed; its CLI's, before the PR, now that the round on the PR ships off: H-312), and the rework by label worked | the automatic fix run: not shown, since none started from a CodeRabbit finding, on a PR or before one; the rework by label: passed | The run's one fix run is the rework's, `f1c5b12d20db` on PR #3, started on the first tick after the label: `Fix rounds: 1 of 2.`, `` - Round 1, rework: run `f1c5b12d20db` ``. CodeRabbit's one inline finding on a factory PR was `Minor` (PR #3 at `cb7b218`; no `pr-fix` run), and until hapi-factory PR #17 the engine read no severity as Critical or Major (H-309). It skipped PRs #5 and #6. Its CLI was off for 0001 to 0003 and found nothing on 0004. Each PR's first body reads `Fix rounds: 0 of 2.` |
| 7 | Planning PR 2's status comment showed both work orders' states as their runs moved | passed | The status comment on PR #4 (`hapi-factory[bot]`, `via-app:true`) has 13 versions, 2026-11-11T23:42:15Z to 2026-11-12T00:13:29Z: 0002's row went `worker`, `verify`, `review`, `harvest`, `pr`, `pr-review`, `waiting`, `merged`, while 0003's stayed `queued` until 0002 had its PR and then went the same way. Then the final comment, `This plan has settled: 2 merged, 0 closed, 0 failed. Total: $0.35.` (2026-11-12T00:13:30Z) |
| 8 | The three factory PRs merged, and the strict audit still passes | passed; the audit's result is Step 4's again | #3 at `336f2d7` (2026-11-10T16:22:43Z), #5 at `36ac5a7` (2026-11-12T00:12:28Z), #6 at `c7568d0` (2026-11-12T00:12:32Z); the fourth, #8, at `183d747` (2026-11-13T03:17:04Z). Step 10's strict audit of both repos (2026-11-11, before 0004): `hapi audit: 25 pass, 2 fail, 0 skip`, the fails `mcp.tool-hashes` (H-101) and `github.repo-settings` (H-306), the two Step 4 expects; `--strict` exits 1 on them |
| 9 | Total spend under $15, and every cap that tripped stopped things and said so | passed for the total; the caps' half was not exercised, since none tripped | hapi's counted totals: $2.66 and $0.35 at Step 10, $3.01, and $0.18 for 0004: $3.19 of the $15, by addition. The real spend of 0001 to 0003's runs: $1.0100, with decisions of $0.0008. The Console (2026-11-11): `$1.21 over last 30 days`. No cap's text and no `cap-stopped` row was seen, for the repo's month ($15.00) or the day's `budgets.daily_usd` ($10.00, central) |
| 10 | Every factory PR marked **Ready to merge** had its acceptance tests pass in the verify container | passed | PR #8 is the one factory PR whose body read **Ready to merge** (`**Ready to merge** · risk: green`, from 2026-11-13T03:11:03Z, at `7f50c0d`). Its acceptance tests passed in verify run `efd9367b55be`: the Evidence row `acceptance` reads `passed`, and the review's evidence quotes the run's `verify.json`, `check exit 0 (26 tests pass, lint finished), smoke exit 0 (health ok), and acceptance exit 0 (2 pass)`; the file was not read by itself. No body of #3, #5 or #6 read it. #5's and #6's status rows did, as `pr: Ready to merge` and `pr-review: Ready to merge`, for one tick each, while the body read ``**Waiting for `ci / gates`** · risk: green`` (H-315); their verify runs, `4e1a00b285d4` and `5a0606a00a65`, exited 0 on `acceptance` |

**Decisions.** One row per harvest of a factory PR: the decision and its version; the subjects (files) screened; how many answers came `via` jev, haiku and default; the holds and notes, by file; each hold's cause (coverage: a subject no classifier answered, with why; or finding: what an answer found); the calls made for the head, of `max_calls_per_head` (24); the decisions' spend; and your call on each hold and each note, agreed or disagreed:

| Factory PR | Harvest (run, head) | Decision | Subjects | Via (jev, haiku, default) | Holds and notes | Each hold's cause | Calls (of 24) | Spend | Your call |
|---|---|---|---|---|---|---|---|---|---|
| #3 | worker `1433bf348f72`, verify `9abcf06679c8`, review `ac62df5d285d`; `cb7b218` | `diff-screen` `v1712cb02899c` | 9 files (8 asked, 0 reused) | 8 (7 pass, 1 note), 0, 1 (the hold) | hold: `bun.lock`; note: `tests/crack-cookie.test.ts` (`stand_in 0.50`, via jev) | coverage: `not screened (skip_paths names it as a lockfile, but it doesn't parse as bun.lock)`, so it was not asked. An engine bug: the lockfile check refused a range with a space after its operator (H-308, closed by hapi-factory PR #17) | 8 | $0.0004 | the hold: disagreed, a false alarm; the note: disagreed |
| #3 | fix `f1c5b12d20db`, verify `4cd58e2388e5`, review `50151ebbd187`; `0669be0` | `diff-screen` `v1712cb02899c` | 8 files (2 asked, 6 reused): `bun.lock` now skipped as a lockfile | 8 (2 new, both pass; 6 reused), 0, 0 | none; the earlier note is gone | no hold | 2 | $0.0002: the PR's `$0.0006 (10 calls)` less the first harvest's | nothing to call |
| #5 | worker `d747452f18c1`, verify `4e1a00b285d4`, review `4e5fe006b7be`; `7a2e5ca` | `diff-screen` `v1712cb02899c` | 2 files: `src/tools/search-fortunes.ts`, `tests/search-fortunes.test.ts` | 2 (both pass), 0, 0 | none | no hold | 2 | $0.0001 | nothing to call |
| #6 | worker `8f4d24c1826a`, verify `5a0606a00a65`, review `6ad91da7609b`; `30dadf8` | `diff-screen` `v1712cb02899c` | 2 files: `src/tools/fortune-of-the-day.ts`, `tests/fortune-of-the-day.test.ts` | 2 (both pass), 0, 0 | none | no hold | 2 | $0.0001 | nothing to call |
| #8 | worker `2151063a53a4`, verify `efd9367b55be`, review `407263f1fcbf`; `7f50c0d` | `diff-screen` `v1712cb02899c` | 2 files: `src/tools/get-fortune.ts`, `tests/get-fortune.test.ts` | 2 (`pass`), 0, 0 | none | no hold | 2 | $0.0001 | nothing to call |

- **The Harvest column** names each pass's runs, from the PR's Links. The run id a decision-ledger line carries is not recorded: for 0001 to 0003 the decision ledger was read by head (Step 6's read: its `asking` lines, and its answers by classifier and verdict), and the line-by-line read of Step 10 is not in the record. For PR #8 the decision ledger was not read, and its row is the PR's Evidence (`2 files screened (2 asked, 0 reused; jev 2)`, `pass`) and its Cost line (`decisions $0.0001 (2 calls)`).
- **In all:** 16 calls for five heads, 8 at most for one, against the cap of 24. 16 answers via jev (15 pass, 1 note), 1 via default (the hold), none via haiku; 6 answers reused. One hold, a coverage hold; no finding hold; one note. The decisions' spend is $0.0009, on Jev through OpenRouter.
- **For H-262**, which measures per PR: `diff-screen` held one of the four factory PRs, #3 on its first head, and the operator agreed with neither its one hold nor its one note. These calls are its first labelled data.

**The operator's calls**, on each hold, each note and each flag that held a PR. Those on PR #3 were given on 2026-11-10, after its merge:

- **PR #3, the hold on `bun.lock`** at `cb7b218` (`diff-screen`, coverage): disagreed. It is recorded as a false alarm, from an engine bug (H-308). The PR was not merged at that head, but the held file never changed (`bun.lock` is +194 −0 at both heads), and the hold went at the next harvest because hapi-factory was fixed.
- **PR #3, the note on `tests/crack-cookie.test.ts`** at `cb7b218` (`stand_in 0.50`, via jev): disagreed. In the operator's words "Jev did its job", but it can't take into account that the file is a test double.
- **PR #3, the independent review's `needs-work`** at `0669be0` (run `50151ebbd187`), which held the PR at **Needs your decision**. Its major finding, `[major] .git (commits cb7b218, 0669be0): The crack-cookie piece has two commits with the same message, so the history has three commits for two pieces. Criterion 4 asks for one commit per piece.`: disagreed. The criterion is "a little restrictive", and the operator worries it could steer workers towards less atomic commits (H-310). The operator merged the PR unchanged with it standing, so it is recorded as a false alarm too, the review's and not a decision's. Its two minor findings: agreed. `src/tools/crack-cookie.ts` rebuilding the fortune as `{id, text}` was merged as is, and `src/bakery.ts` casting the bakery's list unchecked had been reworked in part.
- **PRs #5 and #6, the flag `CodeRabbit did not review <h7>: Review skipped: bot user not eligible for review`**, which held both at **Needs your decision**: the operator merged both unchanged, on the operator's own review. No agreed or disagreed call on the flag is recorded; the ledger's word for it, the controller's, is "accurate". It was the engine's fail-closed reading of CodeRabbit's skip, not a decision's hold, and it is why the round on the PR now ships off (H-312).
- **PR #8:** nothing to call. It had no hold, no note, no review finding and no CodeRabbit finding, and the operator merged it on reading **Ready to merge**.

**H-168, per factory PR:** CodeRabbit's findings at major and above, and its minor ones, and how many were fixed, declined or raised again.

| Factory PR | What reviewed it | At major and above | Minor and below | Fixed | Declined | Merged as is | Raised again |
|---|---|---|---|---|---|---|---|
| #3 | CodeRabbit's PR review, of both heads (`cb7b218`, `0669be0`), in the operator's trial; its CLI was off | 0 | 1 `Minor` (`src/bakery.ts` line 22, `Reject malformed fortunes before returning them.`) and 2 `Trivial` nitpicks | the `Minor`, in part: the operator put it into the rework comment, and fix run `f1c5b12d20db` checks the one fortune the tool picks, in `src/tools/crack-cookie.ts`; `src/bakery.ts` was not changed | 0 | both nitpicks, and what was left of the `Minor`, its thread unresolved | 0 by CodeRabbit; the independent review's round 1 raised what was left once (`[minor] src/bakery.ts`) |
| #5 | nothing: `Review skipped: bot user not eligible for review`; the CLI was off | not reviewed | not reviewed | 0 | 0 | 0 | 0 |
| #6 | nothing: `Review skipped: bot user not eligible for review`; the CLI was off | not reviewed | not reviewed | 0 | 0 | 0 | 0 |
| #8 | CodeRabbit's CLI in the review run, with `--deep`: `reviewed: 0 findings, 0 major or critical`. Its PR review skipped the bot's PR, and the round is off | 0 | 0 | 0 | 0 | 0 | 0 |

- **No automatic fix run started from a CodeRabbit finding** anywhere in the run. Until hapi-factory PR #17 the engine read no CodeRabbit severity as Critical or Major (H-309, closed); after it, no reviewed factory PR had such a finding.
- **PR #3's findings, as the ledger and GitHub count them.** The ledger has one root comment, `Minor`, on `cb7b218`, and one again on `0669be0`. GitHub has one inline comment in all, made on `cb7b218` and carried to `0669be0`, and one `Trivial` nitpick in each review's body (`src/tools/crack-cookie.ts` lines 32 to 33; `tests/crack-cookie.test.ts` lines 80 to 93), which the ledger doesn't count. The second review raised no new inline finding.
- **CodeRabbit paused itself on PR #3** after its second reviewed head: its summary comment opens `Reviews paused` and names `0669be0` as the last reviewed commit. The contract's `.coderabbit.yaml` sets `auto_pause_after_reviewed_commits: 2`, so with the round on a third head would read `Review paused` and count as not reviewed (H-312(f)); PR #3 had two heads, so that was not seen on a factory PR.
- **The planning PRs**, which the operator opened. #2: two `Trivial` nitpicks on its acceptance test (`Enforce the one-item result contract.`, `Test seeded results across server instances.`), left by the controller's ruling that this section's test stays as it is. #4: skipped on its first head, `63ad64e` (`Review skipped: manual review required for this OSS repository`); reviewed on the operator's empty commit `851adff` after the operator subscribed to Essentials, with one `Trivial` nitpick (`Test clock independence across fresh server instances.`), merged as is. #7: check `Finished` on `64caa7e`; its findings are not recorded.
- **The plan's name.** By the ledger, the operator's Advanced trial ended on 2026-11-10 and Essentials began on 2026-11-11, so PRs #5 and #6 were skipped under Essentials. CodeRabbit's own skip comments on #5 and #6 name the plan `Advanced`, as its comment on `63ad64e` did, while its review of `851adff`, minutes before them, names `Essentials`. The sources don't say why.

**CodeRabbit's CLI, live** (work order 0004, 2026-11-12; design §7 item 5). The operator created an Agentic key on a paid Essentials seat, stored it under `hapi-review-coderabbit-api-key` and gave hapi its copy; `mise run secrets:check` printed `found    review/CODERABBIT_API_KEY (hapi-review-coderabbit-api-key) (optional)` in the operator's checkout and again as hapi. So a paid seat issues an Agentic key, and it works unattended on argv. Review run `407263f1fcbf` (the independent review's session, then the CLI) started at the tick of 21:02:41 CST and had ended by the tick of 21:04:45, on a diff of 94 added lines in two files. Its exit 0, with a `complete` line of `outcome: completed` and `gate.status: passed`, is a completed review with nothing at or above the gate; exit 2 was not seen. [Step 6's note](#step-6-watch-it) has the output's lines and the proxy's tunnels: `cli.coderabbit.ai` is the one CodeRabbit host the review used (H-298). The CLI's `status` line said `$25 in free promotional credits have been added to your account for additional reviews. These credits expire after 7 days. To purchase more, visit [billing](…).` Usage-based consumption is off in the operator's CodeRabbit organization, and hapi never passes `--use-credits`, which CodeRabbit's docs give as a headless review's consent to usage-based billing. No rate limit was met: three CodeRabbit reviews ran inside the hour on the operator's seat, and the Essentials CLI allowance per hour is still not known (H-167). Not exercised: a CLI finding at any severity; the fix round a critical or major one starts before the PR; the gate's exit 2; a CLI review that doesn't happen (H-312(e)); and the CLI's second review of a fixed head.

**The register.** What failed or surprised is in [the register](../superpowers/plans/handoffs.md): H-303 to H-309 as the run went (H-304, H-307, H-308 and H-309 closed by their fixes), H-312 with hapi-factory PR #18, and with this record:

- **H-310:** "One commit per piece" as an acceptance criterion, against fix rounds, and what the review prompt says of a fix round's commits.
- **H-311:** stale text in the planning PR's status thread and on a merged PR (a first final comment that stays after a retry; a `merged` row and a merged PR's body that keep the last verdict and reason), a run that failed before any model call counted at its whole budget, and `(budget: spend unknown)` on every row with a run.
- **H-313:** no test validates this section's hand-written planning files, and the controller's scripts for them were in a temporary directory that the reboot of 2026-11-11 cleared.
- **H-314:** a failed run's reason is only `the workflow failed (Archon status failed)`, and this runbook has no read for its cause.
- **H-315:** display defects seen live in the factory PR's body and the status row: the row reading `Ready to merge` while the body read ``Waiting for `ci / gates` `` (about four minutes each on PRs #5, #6 and #8); `5 of 5 criteria met` for a `task.md` with four criteria; `ready: 1 findings`; `1 automatic, 0 rework` for a work order with no fix round; and a first PR (#5) that never names its sibling.

No cap tripped, so none tripped without saying so.
