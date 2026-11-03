# Runbook: the run engine

This runbook covers the run engine that Plan 03 builds (design: [the run engine's design](../superpowers/specs/2026-10-31-hapi-factory-03-run-engine-design.md), §3.4 to §3.8): the poller that reads each registered repo, the pipeline each merged work order goes through, and the factory PR it ends in. Plan 03 writes it in parts; this part is Task 12's:

- [the harvester](#the-harvester): the host gates on a run's bundle, the four verdicts, the acceptance tests, the decision models, the never-forced push and `harvestedAt`;
- [the factory PR](#the-factory-pr): its nine parts, its markers, and what the harvester reads to write it.

## The harvester

The harvester (`src/engine/harvest.ts`) is deterministic host code the poller runs once a work order's runs have ended: the latest worker or fix run whose gates pass, and the verify and review runs of its head. It reads every phase's outputs as data and never executes, sources or follows them. It runs no generative model. It mints no token: it uses the tick's, which the poller revokes. It moves no phase: the state machine does that with what it returns (the PR, its head, the verdict and the reasons).

### The host gates

Before anything is pushed, the harvester checks the run's `run.bundle` with the host's own git, hardened (no system or global config, no hooks, no fsmonitor, `env -i`), in a scratch copy of the mirror it owns, `<engineDir>/scratch/<owner>/<name>/<id>.git`. This is the boundary; the guard's rules in the run are only a signal for it. In order, each failure with its text:

| Gate | Fails when | Its text |
|---|---|---|
| bundle | the bundle doesn't list exactly one head, `HEAD` | `run.bundle: <the problem>`, e.g. `run.bundle: unexpected refs in run.bundle: refs/heads/extra` |
| size | it is over `runs.output_limits_mb.bundle` | `run.bundle is <n> MiB, over runs.output_limits_mb.bundle (<cap> MiB)` |
| bundle | its prerequisites aren't in the mirror (`git bundle verify`) | `run.bundle does not apply to the mirror (git bundle verify exited <n>)` |
| bundle | its head doesn't descend from the run's base commit | `the run's head <h7> does not descend from <b7>` |
| bundle | a new commit is a merge, or lacks the trailers factory-task's commit node writes, with the values the host knows (`Work-Order: <id>`, `Hapi-Run: <run id>`, `Hapi-Lane: factory`, `Trace-Id: <the work order's trace id>`, and an `Agent` and a `Model`) | `commit <h7> is a merge: …` or `commit <h7> lacks the trailer <Key>: <value>` |
| no-diff | the run changed no file | `the run changed no file (<b7>..<h7> is empty)` |
| protected | a changed file's mode for workers isn't `allow` (`effectiveModes`, the central policy with the repo's overlay): `.factory/**` among them, so the planner's acceptance tests too | `<path> is a protected path (workers: deny)` |
| scope | a changed file matches no piece's `files` glob, matched case-sensitively as the run's own git pathspecs are (a scope grants, so ignoring case would let more through) | `<path> is outside every piece's files` |
| secret | the secret scan finds something (below) | e.g. `src/a.ts holds ANTHROPIC_API_KEY's value`, `gitleaks: <rule> in <path> (commit <h7>)` |

Paths are shown redacted, without terminal control characters, `@`, `<`, `>` or backticks, at most 120 characters; at most 20 problems per gate, then `… and <n> more`. The trailer check is the host's re-check of what the run committed: the commit node's own checks run where the worker's code ran, and the worker can write the clone's git config, so the host reads the commits themselves.

**The secret scan** reads every new commit of the bundle, not just the final diff, since a value a later commit removes is still in what would be pushed:

- **gitleaks 8.30.1** (mise.toml's pin; any other version on `PATH` fails the scan), over `<base>..<head>` in the scratch, with its default rules and the gates workflow's hardening: every path read as text (no `.gitattributes` from the tree, `* diff` for every path), merges' own diffs, no rename detection, no `.mailmap`, no submodule config. A git that fails or writes to stderr when run as gitleaks runs it, an error or a warning in gitleaks's log (but its findings count), or 0 commits scanned fails the scan closed;
- **both zones' exact values** (the archon and review zones), raw and base64-encoded (at any alignment), in every patch and every commit message;
- **every changed path's name**, in every new commit, for the same values and for each `KEY_PATTERNS` format, and the messages for `KEY_PATTERNS` too: a worker can read its own key and commit it, in a file's content or in its name.

A hit is a `secret` problem, so nothing is pushed. Encodings beyond base64 are a residual (the threat model).

**The added-line signals** are not gates. The final diff's added lines are matched for what a string match finds: a skipped test (`.skip(`, `.todo(`, `.only(`), an always-true assertion (`expect(true)`), a `NODE_ENV` test against `"test"`, `process.exit`, `process.kill`, a `TODO` or `FIXME`, a write naming `verify.json`, `/out` or `/.archon`, a read of `/proc`, a module patched at load (`mock.module`, `Bun.plugin`), and a changed `bunfig.toml` (which can preload code into `bun test`). Each is a "check this yourself" line on the PR naming the file. None changes the verdict.

Last, the scratch is made readable by all (dirs `a+rx`, files `a+r`), as the mirror is, because a run container's uid reads it: a verify, review or fix run starts from it.

### The four verdicts

With the gates passed, the harvester reads the evidence and settles a verdict, in the design's order (§3.6):

| Verdict | When | What it lets you do |
|---|---|---|
| (no PR) | a host gate refused the bundle, or it had no diff | Nothing is pushed: a pushed branch on a public repo runs that branch's workflows. The status comment gives the reasons; retry the work order (`hapi retry`), or write a new one. |
| **Do not merge** (red), a draft PR | `check`, `smoke` or the acceptance tests failed in the verify container, or verify left no readable `verify.json` | See what was tried, then send it back with `hapi:rework` or close it. GitHub refuses to merge a draft. |
| **Needs your decision** (yellow) | the review says `needs-work` or `blocked`, an acceptance criterion is partly met or unmet, the review marked none, a major or critical CodeRabbit finding is open, there is no review, the review or verify is off, the work order has no acceptance tests while `runs.phases.require_acceptance` is on, verify's signals disagree, the worker ended blocked, no-change, with no `RESULT:` line, on a question or with no final message, or a decision holds a file | Read the reasons first, at the top of the PR; merge, rework or close it. |
| **Ready to merge** (green) | everything passed, and `ci / gates` is green on the head | Merge it. Until `ci / gates` is green the PR shows **Waiting for `ci / gates`**. |

**Verify passes only when four signals agree:** Archon's status for the verify run is `completed`, its container's recorded exit code is 0, `verify.json` reads all passed, and the acceptance junit (`acceptance.junit.xml`) is complete, with results for every planner test file at the merge and none failed or skipped. The change's own code runs in the verify container and could write its own results (H-251), so any disagreement is **Needs your decision** (`verify: <why>`), never a pass. A failure verify.json reports is a failure.

**The acceptance tests** are the planner's: `.factory/work/<id>/acceptance/`, written at planning and approved by the planning PR's merge. `.factory/**` is protected from workers, so the protected-path gate refuses any change to them. The verify container runs them (`bun test ./.factory/work/<id>/acceptance`). With `runs.phases.require_acceptance` on (the default; an overlay may only switch it on), a work order without them is at best **Needs your decision**. A failing one makes the PR a draft **Do not merge**, whether or not `require_acceptance` is on.

### The decision models

Before it settles the verdict of a head it will push, the harvester asks `decide()`'s advisory diff screen about each changed file (`policy/decisions/diff-screen.ts`), after the host gates and the secret scan, and only once the PR lookup has settled the push: never for a refused bundle, a closed PR, a moved branch, or a ready PR whose new head failed check. Each call is written to the work order's decision ledger before it is made, and each answer before it is used. An answer can only hold back **Ready to merge** (a reason under Unresolved) or add a note under "Check this yourself"; it never changes the push or the draft, and a file no classifier answered holds too. `gates.decisions.mode: off` turns the decision models off, and the PR, the status comment and the run records say so. [docs/policy.md, "In the run engine"](../policy.md#in-the-run-engine) has the knobs, the ledger and the spend; Task 15 adds this runbook's "Decisions" section and the recipe for running without decision models.

### The push and `harvestedAt`

- **Never forced.** The harvester pushes the head to `factory/<id>` with `git push` and no `+`, `--force` or `-f`, the push token only in the git process's environment (never argv, a URL or a config file). A push GitHub rejects because the branch moved (not a fast-forward) is never retried with force: the verdict is **Needs your decision** with `factory/<id> moved on GitHub (not a fast-forward): not overwritten`. Before it pushes, it also checks the PR's head is the one the factory pushed last: one moved since is `factory/<id> moved to <h7> since the factory pushed <h7>: not overwritten`, and nothing is pushed. A ready PR is never replaced by a head that failed check, smoke or the acceptance tests (`round <k>'s head failed …, so it was not pushed over the ready PR`).
- **A closed PR** for `factory/<id>` ends the harvest: no push, no write, the state carries the PR's number and `the PR was closed`, and the state machine settles the work order `closed`.
- **One PR, idempotent.** The harvester looks for the PR by its number, or by `factory/<id>`, before it opens one, so a crash between the push and the state's save finds the PR and updates its body on the next tick, never opening a second.
- **`harvestedAt`.** Once it has read a run's outputs, the harvester sets `harvestedAt` in each run record it read, under the run's lock, never overwriting it; retention removes a run's files only after it (H-206). With decision models off, the same write adds `decisions: "off"`.
- **Labels.** Every PR gets `lane:factory`; `hapi:flagged` too when `flags.on_flag` has `label_pr` and the work order's runs together spent more than `flags.thresholds.run_usd`, or its rework rounds passed `flags.thresholds.review_rounds`. The harvester doesn't count `flags.thresholds.interventions` (H-273).

## The factory PR

The harvester writes the PR's description (`src/engine/pr.ts`) between two markers, `<!-- hapi:begin -->` and `<!-- hapi:end -->`, and re-renders only what is between them, so anything you write below `<!-- hapi:end -->` (or above the begin marker) survives every re-render. A body without the markers gets the host's part first, and yours after it. Its nine parts, top to bottom:

1. **Verdict:** **Ready to merge** (green), **Needs your decision** (yellow) or **Do not merge** (red); **Waiting for `ci / gates`** while a ready PR's CI hasn't passed on the head.
2. **Unresolved**, then **Check this yourself**: the reasons; a major finding still open in a fix round's own change (design §3.5, at the top); CodeRabbit's CLI not reviewing the head and why; then the fixed reminders (the worker's account is a claim; CI's `ci / gates` is GitHub's own run), the added-line signals and the decisions' notes.
3. **Links:** the work order (k of n), `Part of #<planning PR>`, its sibling PRs (independent; merge in any order), the work order's trace, and each run with its kind and round, `(retry <n>)` for a later pass.
4. **Asked and built:** the goal (`task.md`'s first paragraph, quoted), the diff's size and the rollback note.
5. **Evidence:** a table of each gate with the head commit, its command and its result (the host gates, `mise run check`, `mise run smoke`, the acceptance tests, the independent review, CodeRabbit's CLI, each decision, `ci / gates`), then the review's findings and criteria and CodeRabbit's findings, quoted.
6. **Review rounds:** the fix rounds against their cap, each by stage.
7. **Cost and turns**, one line, ending with the decisions' spend.
8. **The worker's account**, fenced and labelled as the worker's own claim.
9. **A hidden state block**, `<!-- hapi:pr v1 {"workOrder":…,"status":…,"round":…,"head":…,"verdict":…} -->`.

**Host text and the run's text never mix.** Every line outside a fence is the host's: fixed words, numbers, run ids, paths it built, policy names. Whatever a run or a model wrote (the review's findings, CodeRabbit's, the goal, the account) is sanitized, its comment markers broken (`< !--`, `-- >`), and put in a fence one backtick longer than its longest run of backticks, so it can't close the fence, end the host's part, mention anyone or reach CodeRabbit as a command. The host's text has no task-list checkboxes, since your tick would be overwritten by the next render. **The account is a claim**: the worker wrote it; the host redacted it (both zones' values, raw and base64, and every key format) and capped it at 6,000 characters, but didn't check it.

### What the harvester reads

| Phase | File | What it reads |
|---|---|---|
| verify | `verify.json` | Exactly `{ "check": { "exit": <int>, "tail": <string> }, "smoke": <the same> \| null, "acceptance": <the same> \| null }`, no other key: `null` smoke is not run (an error when the work order's `verify.smoke` is true, unless check failed first), `null` acceptance is no acceptance tests (or not run, when check failed first); exit 0 passes. The tails are untrusted and unused. Also `result.json`'s `run.status`, `acceptance.junit.xml` and the record's `exitCode`: the four signals. |
| review | `result.json` and `transcript.jsonl` | The review node's structured output: the last `provider_event` row of step `review` whose event is the `StructuredOutput` tool call, at `event.rawInput` (result.json keeps only a 200-character preview, spike 09), read only when result.json shows the review node completed. Its shape is `factory-review.yaml`'s `output_format`: `{ verdict: ready \| needs-work \| blocked, findings: [{ severity: critical \| major \| minor, path, summary }], criteria: [{ criterion, mark: met \| partly \| unmet, evidence }] }`, no other key, strings at most 2,000 characters, at most 50 findings or criteria; anything else is "no review". |
| CodeRabbit's CLI | `coderabbit.ndjson` | Every line JSON; the last is hapi's own `{"type":"hapi","exit":<n>}` or `{"type":"hapi","skipped":"<why>"}`. A skip, an exit other than 0 or 2 (2 is `--gate major` tripping), a skipped, failed, reused or partial review, an unverified finding, an error line or no `complete` line is "not reviewed", named on the PR; its `critical` and `major` findings are the open ones. |
| worker or fix | `transcript.jsonl`, `decisions.jsonl` | The final message (the last attempt's text after its last tool call, in `implement`, `implement-retry` or `fix`), the guard's last `result` record, whether the message ends on a question (its last line, or the line before `RESULT:`), and its `## Account` section. |
| every run | `decisions.jsonl` | The guard's spend records: the cost line's spend (the higher of the guard's total and Archon's, unknown counted at the run's budget) and turns (the last spend record's `turns`). |
