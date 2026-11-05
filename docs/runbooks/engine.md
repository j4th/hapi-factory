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
- [troubleshooting](#troubleshooting).

Every command below that runs as hapi is run on the host, from your own terminal, in [runs.md's form](runs.md#how-to-run-the-commands): one fixed script handed to hapi's `sh`, with your words as its arguments. hapi's engine state is under `~hapi/.local/state/hapi/engine/` (the engine dir).

## What the engine does

1. You merge a planning PR (`lane:planning`) whose `.factory/work/<id>/` holds one or more work orders.
2. The poller, a systemd user timer as hapi, fetches the repo's bare mirror and takes up each newly merged work order: `queued`, or `held` when two of one merge overlap.
3. One work order at a time per repo, a worker run (Pi, in a container of its own with the archon zone's keys and no forge route) implements it from the merge commit, one commit per piece.
4. The harvester, deterministic host code, checks the run's bundle on the host: protected paths, scope, sizes, trailers and a secret scan.
5. A verify container with no key installs from the lockfile and runs `check`, `smoke` and the planner's acceptance tests on the bundle's head.
6. A review container (its own keys, no repo code) runs the independent review, and CodeRabbit's CLI when it is on; findings at major or above get one fix run, then verify and review once more.
7. The harvester asks its advisory decisions about the diff, pushes `factory/<id>` (never forced) and opens one PR (`lane:factory`) with a verdict and the evidence.
8. CodeRabbit reviews the PR, at most one automatic fix round follows, and then it waits for you: merge, `hapi:rework` or close. Nothing merges on its own.
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
| `pr` | nothing | a draft (**Do not merge**): `waiting` (CodeRabbit doesn't review drafts); `pr-review` when `flags.coderabbit.enabled`, fewer than `phases.fix_rounds_on_pr` rounds have run on the PR, no human has acted on it and no rework has run; otherwise `waiting` | the PR and its verdict |
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

The month and the day are UTC calendar ones, by each run's `startedAt`. The month sums every run the repo's work orders list, every pass's, its name compared in any case; the day sums every run record, hand runs too. Each run counts its reported spend, or its whole budget when that isn't known (a live run, or a ledger the run wrote that doesn't add up), and decision spend counts with the runs' (each work order's decision ledger, an unanswered call at `unknown_call_usd`). A run's record is kept until its month is over, because the monthly cap reads it ([runs.md, Retention](runs.md#retention)). With `budgets.enforcement.poller: hard` (the default) a cap refuses the run: a queued work order goes to `cap-stopped`, and a verify or review stays in its phase with the reason, starting once the cap clears; a refused fix leaves the work order where it was, to try again. With `soft` the run starts, its event carries the text, and its PR is flagged `hapi:flagged` (once there is one; the reason is kept until then). The round caps are always hard, whatever `budgets.enforcement.poller` says (ruling m38): an automatic fix the round cap refuses goes to the harvest before the PR (its reason on the PR), and to `waiting` on it. The count restarts at any human action (a comment, a label, a push, a review, a rework, a retry).

### The CodeRabbit round

The one automatic round on a PR (design §3.6) starts only from CodeRabbit's own review of the head commit the factory pushed:

- the head counts as reviewed only when CodeRabbit's check run (`CodeRabbit`, App 347564) on it is completed, `success` and titled `Finished…`; any other title (`Review paused`, `Review skipped`, `Rate limited`) is named (`CodeRabbit did not review <h7>: <title>`) and fails closed;
- a finding is a root review comment (never a reply) by CodeRabbit's bot user (id 136622811, never matched by login), on the head commit, in a review CodeRabbit submitted on that commit, starting with its generated-comment marker, whose first `**<Severity>**` is Critical or Major, in a thread no one else has replied in; its "Supported by static analysis" sections are stripped;
- check runs are read with the `checks` token, reviews and comments with the `pr` token.

**What turns it off:** a draft PR; `flags.coderabbit.enabled: false`; `phases.fix_rounds_on_pr` used up; any human action on the PR or a rework so far; and a comment or review from anyone but the operator, hapi's Apps (`hapi-factory[bot]`, `hapi-planner[bot]`) and CodeRabbit (`<login> commented on #<n>, so the automatic CodeRabbit round is off: the PR is the operator's`, or `user <id> reviewed #<n>, …` for a review, which carries no login). The PR's round doesn't yet drop a finding the fix before the PR declined (H-277).

### Rework by label

A `hapi:rework` label on a factory PR in `waiting` starts a rework when a human added it: `type: User`, not through an App, no `[bot]` login, with at least triage permission on the repo, after the work order's newest worker or fix run started, and not taken off since. The rework is a fix run on the PR's head, from the mirror, with the unchanged work order and, as data, each issue comment since that run by a maintainer (triage or above) and each review comment by the operator; with `flags.coderabbit.include_in_rework`, CodeRabbit's findings on the head too. It is the operator's: it counts no automatic round, restarts the count, and its harvest pushes on top of the PR (never over a branch that moved since). To ask for another rework after it, take the label off and add it again. **Post your comments first, then add the label:** the rework is given the comments there are when it starts, at the next tick, so a comment posted after that isn't in it (it is in the next rework's). At most `runs.max_rework_rounds` (3) reworks run on one PR; past it the label starts nothing, and the PR waits with the cap's text. A third rework crosses `flags.thresholds.review_rounds` (2), so its PR is flagged `hapi:flagged`. A label on a PR still in its automatic round stops the round first (`waiting`), and the rework starts on the next tick.

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
- **On what:** each file's diff from the merge commit (`diff -U3`; a fix round's harvest screens the whole change), redacted first (both zones' values, raw and base64, and every key format), cut into windows of whole lines when it is long, with the work order's goal (`task.md`'s first paragraph). Jev is asked only for a public repo; Haiku otherwise.
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

Once every work order of the plan has settled (`merged`, `closed` or `failed`) and no problem is open, the poller posts **one final comment** (`This plan has settled: <n> merged, <n> closed, <n> failed. Total: $<x>.`), and from then on leaves the plan's comments as they are. A `hapi retry` reopens the plan: its comment is edited again, and when the plan settles again, another final comment is posted. Every cell is one line, and text a run, a planner or GitHub controls is in a code span, so nothing in it renders as a mention, a link or HTML. The poller remembers each comment by a mark, `~hapi/.local/state/hapi/engine/status/<owner>/<name>/<planning-pr>.json`; a mark lost in a crash is recovered from the PR (the newest comment by the factory's App that starts with the marker), never by posting a second comment.

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
| No timer after a reboot (`runtime.poller-timer` fails, `list-timers` shows none) | The timer's links are runtime ones, which a reboot clears: run `mise run up`. |
| A work order is `failed` | Read the reason in `hapi status`. If the cause was outside the work order (a rate limit, a timeout, a container `mise run down` removed, a flaky preflight, your own `hapi run stop`), fix it, then [`hapi retry`](#a-failed-work-order). A failure from the work order's own content, or `has been retried <n> times, and runs.max_retries is <n>`, needs a new id in a new planning PR; so does a closed `factory/<id>` PR, which shows as `closed`. A `hapi run start` by hand is never picked up by the poller. |
| `failed` with `a <kind> run's inputs (…) are <n> MiB, over runs.inputs_mb (16 MiB): refused, never truncated` | Before a PR the inputs are the same every pass, so `hapi retry` fails the same way: plan the work again, smaller. |
| Every PR says `not screened (no classifier answered: …)` | Check the archon zone's keys (`hapi secrets check`), the providers' caps (OpenRouter's daily limit answers 402; the Console limit), and hapi's own network from the host to `openrouter.ai` and `api.anthropic.com` (the harvester calls them on the host, not through a zone's proxy). That head stays held, since a re-render asks nothing: merge anyway (the verdict is advice), or send it back with `hapi:rework`. A missing key never turns decision models off. |
| A hold under Unresolved: is it the file, or the cover? | The reason says. A coverage hold reads `<path>: not screened (<why>) (gates.decisions.by_name.diff-screen.on_unscreened: hold)`, `<why>` being `not asked: over gates.decisions.max_calls_per_head (24)`, `no classifier answered: …`, `not asked: a re-render asks nothing` (a re-render gives a subject its harvest's own why, and this only to one never asked) or `content not shown in the diff`: it says nothing about the file, so check the file yourself. The verdict line counts them apart: `held: <n> files not screened (<cause>)` against `held: text aimed at the reviewer in <paths>`. A finding reads `<path>: it holds text addressed to whoever reviews or checks the change (decide diff-screen: …, via jev)` (or `via haiku`): read that file's diff first. |
| A hold you disagree with | Merge anyway, since the verdict is advice, and record it for calibration (H-262): a hold on a PR you then merged unchanged is a false alarm. |
| `not asked: over gates.decisions.max_calls_per_head (24)` | A large change, or a head asked about many times. Raise the knob by a protected change, or split the work order. |
| `content not shown in the diff` | A binary file, a gitlink, or a `-diff` attribute on `main`. Check the file yourself, or set `on_unscreened: note` by a protected change. |
| `<file> line <n> is not a decision entry` | A damaged decision ledger. It fails that repo's ticks, and, since the day's cap reads every ledger, stops new runs everywhere. With [the timer stopped](#stopping-everything), move that one line into a dated `.bad` file beside the ledger, as hapi, with the file and line the message names: `sudo -u hapi -H -- sh -c 'umask 077; sed -n "$2p" "$1" >> "$1.$(date -u +%Y%m%d).bad" && sed -i "$2d" "$1"' hapi-ledger <file> <n>`, then start the timer again. A lost `answer` line only means its subject is asked again; a lost `asking` line under-counts at most one call ($0.001). |
| Every PR and the status comment say `Decision models are off` | `gates.decisions.mode` is `off`, the operator's setting ([Running without decision models](../policy.md#running-without-decision-models)); set it back to `enforce` by a protected change. A PR whose head was harvested while it was off then reads as held at its next re-render, since a re-render asks nothing: merge it anyway, or send it back with `hapi:rework`. |
| `waiting` with `work order <id>'s worker run of pass <n> has no record (runs.retention_days removed it once its month ended): no rework can start on #<pr>; …` | The PR waited past retention, which removed its pass's runs, so a rework has no worker run to be its parent. Close the PR, or plan the work again under a new work order id (H-244(c)). |
| `ci / gates` fails on a factory PR with `<sha> has no <Key> trailer` after you pushed to it, or used **Update branch** or **Resolve conflicts** | Every commit on `factory/**` needs the six trailers, yours too ([the operator always wins](#the-operator-always-wins)): commit or resolve locally with them, or close the PR and land the change yourself (H-295). |
| `Needs your decision` with `CodeRabbit's CLI failed its gate (exit 2: …), yet no major or critical finding was read from its output` | The CLI's own gate and the findings the host read disagree (a severity spelt in a way the host doesn't know, or a finding it couldn't read). Read CodeRabbit's findings in the review run's outputs yourself. |
| You added `hapi:rework`, and nothing started and no cap's text shows | The label counts only when it was added after the work order's newest worker or fix run started, and GitHub gives the label's time in whole seconds: one added in the same second as the run's start reads as before it. Take the label off and add it again. |
| A verify or review holds with `the host gates refuse <kind> run <id>'s bundle now: <details>` | The run's bundle passed the host gates once but fails them now, most likely after a policy change (a newly protected path, a tighter overlay). The work order holds in its phase, runs the gates again each tick, and holds its repo's queue. Undo or narrow the change the details name, and the next tick goes on. There is no command to fail it instead (H-243(h)). |
| `the PR body has no room for the host's part: <n> characters of it are outside the hapi markers` | Your own text outside the `<!-- hapi:begin -->` and `<!-- hapi:end -->` markers leaves less room than even the host's few-line fallback needs under GitHub's 65,536 characters, so the host didn't write the body (on a harvest the push still happened; a re-render pushes nothing). Trim your text: the next tick writes the body and drops the reason. |
| `hapi:rework` starts nothing, and the PR's body doesn't say why | Past `runs.max_rework_rounds` (3), the cap's text is in the status comment and `hapi status`. The PR's body shows it too, unless you pushed to `factory/<id>` after the factory's last push: a head the factory didn't push isn't re-rendered. Close the PR, or plan the work again under a new work order id. |
