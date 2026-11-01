# Runbook: runs

This runbook covers `hapi run`, the launcher that Plan 02 built (design: [the worker's design](../superpowers/specs/2026-10-29-hapi-factory-02-worker-design.md), §3.1 and §3.2; spec §9.2, §9.3, §11.3):

- [what a run is](#what-a-run-is), [the run kinds](#run-kinds) and [the container's layout](#the-containers-layout);
- [how to run the commands](#how-to-run-the-commands);
- [`hapi run start`](#hapi-run-start), [`watch`](#hapi-run-watch), [`list`](#hapi-run-list) and [`stop`](#hapi-run-stop);
- [the outputs](#the-outputs), [retention](#retention) and [the public flag](#the-public-flag);
- [the mirror](#the-mirror) the poller keeps of each registered repo, and how it [discovers work orders](#discovery) there;
- [the run disk](#the-run-disk), which the operator makes once, and the lock it gives `mise run down` and finalize;
- [the rollout on hapi's checkout](#rollout-on-hapis-checkout), once this branch has landed, and [the paid check](#the-paid-check) after it;
- [the tests](#the-tests) and [troubleshooting](#troubleshooting).

## What a run is

A run is one work order, run once, in one container that exists only for that run.

- **One container, one network, two volumes.** `hapi run start` makes a hardened Archon container from the `archon` service of `stack/compose.yaml`, on a network of its own (`--internal`) that its kind's proxy joins (`egress-archon`, or `egress-review` for a review: [run kinds](#run-kinds)), and two volumes on [the run disk](#the-run-disk): `/work` (the clone) and `/out` (what may leave). It returns at once with a 12-digit hex run id.
- **No server.** The container runs one workflow with the Archon CLI in the foreground, then exits. No Archon API, web console or port exists for a worker to reach, so there is nothing to tunnel to ([threat model](../security/threat-model.md), AC-13).
- **Nothing outlives it but what is copied out.** The container's tmpfs mounts die with it. Its two volumes are read once, by a helper, and removed, with their dirs on the run disk. What reaches the host is its kind's named files, at most four ([the outputs](#the-outputs)). The one exception is a run whose container was removed around hapi before it was finalized: nothing could be copied out, so its volumes and their dirs are kept for you to read, until `mise run down` (H-209; [troubleshooting](#troubleshooting)).
- **A failed run starts over.** There is no resume. A run that fails, times out or is stopped is run again from a fresh clone with `--retry-of` ([the flags](#hapi-run-start)). Resume, reconsidered, is registered for the observability profile (H-213).
- **Its own settings.** Each run gets its own `hapi-guard.json` and Archon run config, generated when it starts from the central policy with the repo's overlay (`.factory/config.yaml` at the run's commit) applied, for the roster `build/roster` names (H-172). So a repo's protected paths bind its runs' guard.
- **Liveness is Docker's.** A run is live while a container named for it, with the labels `org.hapi.run` and `org.hapi.project=hapi`, is running. No pid is trusted.
- **Plan 02 runs no model unless a work order's workflow calls one.** The two check workflows it ships (`hapi-check-run`, `hapi-check-guard`, in `archon/workflows/hapi`) are bash only, except the guard check's Pi node.

Plan 03's poller calls the same launcher, from merged work orders: `startRun` (`src/run/lifecycle.ts`), with a parsed work order, the repo's mirror and the merge commit, and gets the run's record back or the refusal as an error. `hapi run start` is a thin wrapper of it for a run by hand. Both read the repo's overlay at the run's commit (design §3.5): the poller from discovery, a hand run from `--repo` at its `HEAD`.

### Run kinds

Each phase of a work order is a run of its own kind, with its own run id, record and container (design §3.5). One profile per kind (`kindProfile`, `src/run/kinds.ts`) decides the container's secrets, egress, binds, prelude, workflow and outputs:

| Kind | Its zone's keys | Proxy | Prelude | Workflow | Inputs dir | Outputs (their limit in `runs.output_limits_mb`) |
|---|---|---|---|---|---|---|
| `worker` | archon | `egress-archon` | `run.sh` | the work order's (its `factory-task`) | none | `result.json` (result), `transcript.jsonl` (transcript), `decisions.jsonl` (decisions), `run.bundle` (bundle) |
| `fix` | archon | `egress-archon` | `run.sh` | the work order's | `findings.md` | the worker's four |
| `verify` | none, of any zone | `egress-archon` | `verify.sh` | `factory-verify` | none | `result.json`, `transcript.jsonl`, `verify.json` (result) |
| `review` | review | `egress-review` | `review.sh` | `factory-review` | `diff.patch`, and `verify.json` unless the verify phase is off | `result.json`, `transcript.jsonl`, `decisions.jsonl` (a Pi-run review's), `coderabbit.ndjson` (decisions) |

- **No container that holds a key runs the worker's code** (design §3.5). The worker and a fix round hold the archon zone's keys and run the repo's code, as Plan 02's worker did.
  - **Verify** runs the repo's code (its checks and the acceptance tests) and holds **no key of any kind**: `start` reads no zone's env file for it, its argv names no secret (`runArgs` refuses one), and the audit fails a live verify container that holds any zone's key, naming the variable, never its value.
  - **Review** holds the review zone's keys and runs **none of the repo's code**: `review.sh` checks every committed symlink out again as a plain file holding its target's text (so the review's Read, Grep and Glob can't follow `notes.md -> /proc/1/environ` or `d -> /` out of the checkout), then makes the checkout read-only, `.git` aside, before Archon starts; nothing in it installs anything or runs a repo script; and `factory-review` (Task 11) runs a read-only review session and CodeRabbit's CLI. Its verdict and findings are the review node's structured output in its `result.json` and transcript (Tasks 11 and 12): no kind writes a `review.json`.
- **Verify's results are a pre-filter, not evidence against a hostile change** (H-251). Verify runs the change's own code as the same uid as Archon and `factory-verify`, so that code can forge every output it leaves (`verify.json`, `result.json`, the transcript, Archon's own state) and even the container's exit code. What bounds it: it holds no key and reaches only the archon zone's allowlist; the harvester's own gates on the bundle; the independent review; the PR's required `ci / gates`, on a fresh runner; and the operator's merge. Finalize records the container's exit code (`exitCode` in `record.json`, only for a container Docker says `exited`), and the prelude, as PID 1, kills whatever the workflow left running before the read-back, so that Task 12 can require Archon's status, the exit code, `verify.json` and the acceptance tests' report to agree, and treat any disagreement as needing attention.
- **Why verify joins `egress-archon` with no key** [call, design §3.5]: it installs from the bundle's own lockfile (`bun ci --frozen-lockfile --ignore-scripts`). It never reuses the worker's `node_modules`, which could fake a result: its `/work` is a fresh volume of its own. The package registries are all it needs from the proxy, since the archon zone's model APIs are no use without a key. Spike 09 ran that install with the archon service's whole environment and the run's tmpfs sizes, and it reached only `registry.npmjs.org` ([spike 09](../spikes/09-run-engine-offline.md), the ruling for Tasks 8 and 11).
- **The source contract.** No container fetches a bundle: every kind clones `StartOptions.repoGitDir`, which must hold the run's commit (`start` checks that).
  - A worker's source is the repo's [mirror](#the-mirror).
  - A verify, review or fix run's is the harvester's checked copy of the mirror, with the bundle's commits fetched into it (Task 12). It must be world-readable, as the mirror is (`umask 022`).
  - The one exception is a rework fix (Task 13), whose source is the mirror itself at the PR's head, since the mirror fetches `factory/<id>`.
  - One live run per repo counts a scratch copy against its GitHub repo: a run's record names its repo as `forgeRepo` (`owner/name`, lower-cased, since GitHub's names aren't case-sensitive), and a start that names one is refused while another run of that repo is live, whatever its git dir. A hand run (`hapi run start`) names none, so a live hand run blocks only runs from its own git dir, not an engine verify or review on a scratch copy of the same repo. That is moot while `runs.max_live` is 1, as it is by default: any live run blocks every other.
- **The inputs dir** (`RUN_INPUTS`, and each kind's `inputFiles`, `src/run/kinds.ts`). A review's or fix's `StartOptions.inputsDir` holds only regular files, its kind's inputs, which Task 13 writes and Task 11's prompts read: for a review, `diff.patch`, which it must hold, and `verify.json`, absent when the verify phase is off; for a fix, `findings.md`, which it must hold. `start` copies it into the run's dir as `inputs/` (0755, its files 0644) and binds that copy read-only at `/run/hapi/inputs`. It refuses an inputs dir for a worker or a verify, a review or fix without one, one without its required file, and any other name (another kind's input among them), symlink or directory in it: an inputs dir never holds a bundle. The work order and its task text aren't inputs: every kind reads `/run/hapi/order.json` and `/run/hapi/task.md`, from the one host copy. The base commit is `run.json`'s `base`.
- **The label.** The run container, and nothing else of the run, carries `org.hapi.kind=<kind>`. A Plan 02 run container has none, and is a worker's. [`runtime.run-container`](../audit.md#runtimerun-container) holds each live run container to its own kind's definition, its own network included.
- **The rest is the same for every kind:** the record, the supervisor, finalize, the reap, `stop`, `watch` and `list`. Finalize copies out its kind's outputs and disconnects only the proxy its kind joined; `mise run down` disconnects both proxies from every run network. `watch` redacts with the archon zone's values, and a review's lines with the review zone's too.
- **Why a verify's lines are redacted with the archon zone's values,** though it holds no key: the code it runs is the worker's change, and a worker holds the archon zone's keys, so it could have committed one of their values into the repo for its verify to print. So `watch`, and a verify's kept container log, read `archon.env` for a verify run as for a worker, and fail closed without it, though starting a verify run needs no env file at all.
- **What isn't here yet.** The review zone (its env file, `egress-review`) is Task 9's, and `factory-verify` and `factory-review` are Task 11's. Until then a verify or review run is refused at its workflow (it isn't in hapi's pack), and a review at its env file too.

### The container's layout

Everything below is made by the launcher (`src/run/spec.ts`), from the `archon` service's user (`1001:1001`), limits (2048 pids, 4 GB), hardening and environment. The root filesystem is read-only, with all capabilities dropped and `no-new-privileges`. The launcher refuses a service that lacks any of them (`read_only: true`, `cap_drop` with `ALL`, `security_opt` with `no-new-privileges:true`, `pids_limit`, `mem_limit`), naming the key, so a drifted `compose.yaml` never runs a run unhardened. The container's stop timeout is 30 seconds (`--stop-timeout`), the same as `hapi run stop`'s, so a daemon restart or a reboot gives the prelude the same grace. Every run is started with `--init=false`, so its prelude is the container's PID 1 whatever the daemon's default: a verify's and a review's kill of what its workflow left runs only as PID 1, and the audit fails a live run container with an init process.

| Path in the container | What it is | Writable |
|---|---|---|
| `/tmp` | tmpfs, 1 GB | yes, but `noexec` |
| `$HOME` (`/home/appuser`) | tmpfs, 256 MB. The generated `.gitconfig` is bound into it. | yes, but `noexec` |
| `/.archon` | tmpfs, 512 MB: Archon's run database, workspaces and logs. `config.yaml`, an empty `.env` and the workflow pack (`/.archon/workflows/hapi`) are bound into it. | yes, but `noexec`; the bound files are not |
| `/opt/hapi/pi-agent` | Pi's directory: tmpfs, 64 MB. Bound into it: `models.json`, `models-store.json` (`{}`), `settings.json` and `extensions/` from `build/pi/`, and the run's own `hapi-guard.json` from its run directory ([the outputs](#the-outputs)): generated for this run from the policy with the repo's overlay applied, for `build/roster`'s roster. | yes (Pi's cache and sessions); the bound files are not |
| `/work` | a bind-backed volume on [the run disk](#the-run-disk), fresh for every run: the clone, `/work/repo`, which a worker or a fix edits and a verify's checks run in. It holds the clone alone: Pi loads a `/work/AGENTS.md` ([spike 09](../spikes/09-run-engine-offline.md), T17). Capped, with every other run's volumes, by the run disk's size (`runs.disk.gb`). | yes; a review's clone is read-only but for its `.git` |
| `/out` | a bind-backed volume on the run disk: the run's kind's outputs ([run kinds](#run-kinds)), such as a worker's `run.bundle`, `result.json`, `transcript.jsonl`, `decisions.jsonl`. Capped as `/work` is. | yes |
| `/src/repo.git` | the source repository's git dir | no |
| `/run/hapi/run.json` | the run's input: its id, the work order's id, `traceparent`, the budget, the public flag, the workflow, and its kind, round, turn budget and base commit | no |
| `/run/hapi/order.json` | the work order, as the host validated it, as JSON. A run's nodes and prompts read it, never the clone's own `order.yaml`, which a worker could commit to | no |
| `/run/hapi/task.md` | the work order's task text (its `task.md`), empty when it has none | no |
| `/run/hapi/inputs` | a review's or a fix's inputs dir: the run's own copy of `RUN_INPUTS`' files, `diff.patch` and `verify.json` for a review, `findings.md` for a fix ([run kinds](#run-kinds)). A worker and a verify have none | no |
| `/opt/hapi/run.sh`, `verify.sh` or `review.sh` | the kind's fixed prelude (`stack/archon/`), which clones, runs the workflow and reads the results back: `run.sh` for a worker or a fix, `verify.sh` for a verify, `review.sh` for a review. Only the kind's own is bound | no |
| `/opt/hapi/run-config.yaml` | Archon's strict run layer: Pi extensions on, no auto-resume, the roster's tiers, and the aliases with the work order's tiers for `@implement` and `@review`. The run's own, generated as its `hapi-guard.json` is | no |

Docker mounts every tmpfs `noexec`, so a worker's tools can't run anything from `/tmp` or `$HOME`: a virtual environment's scripts under `~/.cache/uv`, for example, fail ([spike 07](../spikes/07-run-container.md), finding 18; H-208). The environment is `build/archon/archon.env`'s, set in `environment:` so no secret can override it, with a review's four proxy variables set to `http://egress-review:3128`; its kind's zone's secrets are passed by name, with their values in the docker CLI's own environment only, and a verify run is passed none.

The preludes' order:
- **`run.sh`** (a worker, a fix): clone sparse, without `.pi/`, `.agents/` and `.archon/` at the repo root (so a repo can't steer Archon or Pi); run the workflow from `/app`, never from inside the clone; then bundle the worker's commits, strip those three directories again, and read Archon's own record of the run into `/out`.
- **`verify.sh`**: the same, but its clone and its strip also leave out what would steer Claude Code (`.claude/`, `CLAUDE.md` and `CLAUDE.local.md` at any depth, and `.mcp.json` at the root; [spike 09](../spikes/09-run-engine-offline.md), T19), it makes no bundle (what it leaves is its results), and once the workflow has ended it kills whatever the workflow left running, before the strip and the read-back. That kill runs only when the shell is the container's PID 1 (`if [ "$$" = 1 ]; then kill -s KILL -- -1 2>/dev/null; fi`): anywhere else `kill -1` would signal every process of its user. The `--` matters: the image's `sh` is dash, which refuses a bare `-1` as an option. `tests/run/run.int.test.ts` runs the line, read from each prelude, as PID 1 in the image. `run.sh` gets the same line with the operator's OK (H-252).
- **`review.sh`**: `verify.sh`, with two steps right after the remote is removed, before Archon starts: every symlink in the checkout is checked out again as a plain file holding its target's text (`core.symlinks false`, the links removed, then, if there were any, `git checkout -- .`), and the prelude ends there unless `git status` is then clean; then the checkout is made read-only, `.git` aside.

`verify.sh` and `review.sh` share `run.sh`'s clone, its trap, its wait and its read-back, byte for byte, and `tests/run/prelude.test.ts` holds them to that: a change to one prelude's shared part is a change to all three.

## How to run the commands

`hapi run` runs as the `hapi` user, on hapi's rootless Docker. As any other user it re-execs itself as hapi, the way `up` does ([the stack runbook](stack.md#4-mise-run-up-and-mise-run-down)), but the paths it takes (`--repo`, `--work-order`) must be ones hapi can read, and hapi can't read your home. So run it in hapi's name from the start, and keep what it reads in hapi's home.

Every command below runs **on the host, from your own terminal, as yourself**, and hands one fixed script to hapi's `sh`. The script sets hapi's `PATH` and runtime directory, goes to hapi's checkout and runs `mise run hapi -- run <subcommand>`. For `list`, `watch` and `stop`, only the words after `hapi-run` change:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run list
```

It runs hapi's checkout's code, not yours: pull there first (`git -C ~/hapi-factory pull`, as hapi) after this branch lands.

## `hapi run start`

```text
hapi run start --repo <path> --work-order <file> [--public] [--budget-usd <n>] [--retry-of <run-id>]
```

Run it as hapi, with the repo and the work order in hapi's home (`$HOME` is hapi's inside the script):

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run start \
  --repo "$HOME/repos/example.git" --work-order "$HOME/orders/WO-0001.yaml"'
```

Expected: it prints the run id (twelve hex digits) and returns. The run is going; `watch` follows it.

- **`--repo`** is where the run's clone comes from. Pass a **bare clone**, not a working checkout. The launcher binds the source's git dir into the container read-only, and a working checkout's `.git/config` is then readable by the run: an `http.extraheader`, or a token in a remote URL, would be visible to a worker. A bare clone of the repo has none. Make one as hapi: `git clone --bare <url> "$HOME/repos/example.git"`, with a URL that needs no credential. The run starts from the source's `HEAD`, so that is the commit the work is cut from, and the repo's overlay, `.factory/config.yaml`, is read at that commit, as a blob, with host git and no config of its own: its protected paths and sidecar apply to the run, as they do to the poller's (design §3.5). A repo with none runs on the central policy. The poller's own runs start from the repo's mirror, which it keeps ([the mirror](#the-mirror)). A hand run still takes a bare clone of your own: the mirror's HEAD is main's tip, not a work order's merge commit, and the poller never picks up a hand run. The source must be world-readable (made under `umask 022`), because the container reads it as another uid.
- **`--work-order`** is a work order file (`order.yaml`), validated on the host before anything starts ([docs/policy.md](../policy.md#work-orders)). A run by hand is always a worker; the poller starts the other [kinds](#run-kinds). A work order with a non-empty `egress_extra` is refused: a per-run proxy for it doesn't exist yet (H-088, H-207). Its `workflow` must be one of hapi's pack (`archon/workflows/hapi/`): Archon also finds its own bundled workflows by name, which hapi doesn't review, so `start` refuses any other name, and refuses a pack with a node that sets `pi.enableExtensions: false`, which would drop hapi-guard. A run by hand is a worker, so its `roles.implement` must name a `pi` tier of the roster (implement runs on Pi): `small` or `large` on every roster. The poller's review runs are held to more: `roles.review` must name a `claude` tier (the review runs in Claude Code) whose model isn't implement's, so no review runs on the `portable` roster (no `claude` tier) or the `budget` one (Haiku on every tier) yet (H-249). Verify and fix runs aren't checked: a verify runs no model, and a fix runs implement's. A `task.md` beside the work order file is the run's task text (`/run/hapi/task.md`); with none it is empty.
- **`--budget-usd`** only lowers the work order's `budget.usd`. A value above it is a usage error.
- **`--public`** is [the public flag](#the-public-flag).
- **`--retry-of <run-id>`** names the last run of the same work order and commit, which ended without succeeding. A run is keyed by the work order's id and the source commit: a key with a live or a succeeded run is refused, and one whose last run ended another way is refused unless `--retry-of` names that run. So a re-fire is safe. A run by hand keeps that two-part key. The poller's runs add their kind, round and pass to theirs (`worker:0`, `fix:1`, `worker:0:retry1`), so the two never meet: the poller never takes a hand run as its own, and a hand run never blocks the poller by its key. A live hand run still holds the `runs.max_live` slot, as any run does.

**What it refuses**, in this order, with an error that names the fix: a work order that fails validation; a source that isn't a git repo or has no commit; an overlay at that commit that isn't a regular file or fails its schema; a work order or overlay that names `egress_extra`; a workflow that isn't in hapi's pack, or a pack with a node that drops hapi-guard; a run disk that fails its check ([the run disk](#the-run-disk): with `runs.disk.enforcement: soft` it is a warning instead, and the run starts); no env file for the run's kind's zone (the archon zone's; a review's is the review zone's, and a verify needs none: run `mise run up` first); no `build/roster` (run `mise run up`); an overlay that loosens the central policy; roles on the wrong provider for the roster; for the poller's runs, an inputs dir that its kind doesn't take, or that holds anything but `RUN_INPUTS`' files ([run kinds](#run-kinds)); a key already run; a second live run for the same repo, by its git dir or its GitHub repo (one per repo, H-090); more live runs than `max_live` in `policy/runs.yaml` (1 by default). A step that fails after that removes everything `start` made. A supervisor that starts and then dies is reaped by the next `hapi run start` or `hapi run stop`; `hapi run stop <id>` is the direct fix. `list` and `watch` never reap.

**The deadline** is the work order's `budget.minutes`, for every kind of run. A detached `hapi run supervise <id>` waits for the container to end or the deadline, stops it at the deadline, then finalizes the run: copy-out, checks, removal and the record. You never run `supervise` yourself.

## `hapi run watch`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run watch 0123456789ab
```

Replace `0123456789ab` with the run id. For a live run it follows `docker logs --follow` of the run container, the only live view: the transcript is in the run's own `/.archon` tmpfs, out of the host's reach until copy-out. When the container exits, it waits up to two minutes for the run to be finalized, then prints the stored transcript, a line per row, and how the run ended. For a run that has ended it prints the stored transcript and the ending at once.

It reads and never writes: it doesn't answer a pause, call Archon or publish a port. Everything a run wrote is untrusted text, so each line has its terminal escape and control sequences removed, and the bidi controls that could reorder what you see (U+202A–202E, U+2066–2069), then the archon zone's secret values (read from the env file `hapi secrets resolve` wrote; for a review run, the review zone's too) and key-shaped strings (a private key whole, body and all) replaced by `[hapi: <NAME> redacted]`. Where both zones hold a name with different values, the review zone's is `[hapi: <NAME> (review zone) redacted]`. A live run's log comes a line at a time, so after a line that opens a private key (a BEGIN line after its last END line), watch prints `[hapi: private-key redacted: lines hidden until its END line]` once and hides every line up to and including the next one that holds an END line. Redaction sees an exact value or a key format, never an encoded or split one: it keeps keys off the screen and is no boundary. Without the env file (or, for a review run, either one), `watch` fails and prints nothing of the run.

**Every line a run wrote starts with `| `**, live or stored, so a worker can't print a line that passes for hapi's own (H-220). hapi's own lines have no mark: the run's ending, `run <id>: <status>[: <reason>]`, always printed last; the hidden-key notice above; and `(no transcript.jsonl was copied out)`. The ending is `hapi run list`'s status too.

## `hapi run list`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run list
```

Expected: a table, newest first, of `RUN`, `STATUS` (`live`, `succeeded`, `failed`, `timed-out` or `stopped`), `REPO`, `WORK ORDER`, `STARTED` and `SPEND`. `SPEND` is the higher of the guard's ledger (the last total in the run's `decisions.jsonl`) and what Archon recorded in its `result.json`: Archon reports no cost for an attempt the guard failed, when the guard's ledger still has it (H-229), and the guard misses costs Archon sees. Both are files the run could write, so a ledger whose total ever falls, which an honest one never does, shows `-`, and so does a run with neither; a cap counts such a run at its whole budget. A live run shows `-`, as nothing is copied out until it ends. With no runs, `no runs in <state dir>`.

## `hapi run stop`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run stop 0123456789ab
```

It records that the run was stopped, runs `docker stop -t 30` on its container, copies the outputs out and removes the container, network and volumes, and the volumes' dirs on the run disk. The grace period is 30 seconds, not Docker's 10, because the prelude passes the stop on to Archon, which marks the run failed and exits, and then reads the run back with the Archon CLI (up to three more `bun` starts). A KILL inside that would leave a stopped run without its outputs. The run's status is `stopped`.

A stop outranks the run's deadline, so a run still live past its deadline that you stop is recorded `stopped`. A run that has already ended, or that another command is finalizing, can't be stopped: the command prints `run <id> has already ended: <status>` or says another command is using the run, and the run keeps how it ended. A run whose container doesn't exist yet is refused too ([troubleshooting](#troubleshooting)).

To stop every run at once, use `mise run down` ([the stack runbook](stack.md#4-mise-run-up-and-mise-run-down)) or [kill switch 3](kill-switches.md#3-stop-the-stack): both remove every container labelled `org.hapi.run`. A run removed that way is finalized as failed, with nothing copied out. `down` removes the runs' volumes too, unless it can't take the run disk's lock (a finalize is copying a run out, or there is no `XDG_RUNTIME_DIR`): then it leaves them, and their dirs on the run disk. The finalize that is copying its run out removes that run's own; every other run whose container `down` removed is finalized as gone, which leaves its volumes in place (H-209), and no reap removes a volume. So they stay until a `mise run down` that takes the lock: run it again once the copy-out has ended ([the lock](#the-run-disk)).

## The outputs

Each run has a directory on the host, owned by hapi: `${XDG_STATE_HOME:-~/.local/state}/hapi/runs/<run-id>/`, with hapi's home as `~`. It holds:

| File | What it is |
|---|---|
| `record.json` | What the launcher started and how it ended: the id, key, repo, commit, work order, workflow, container, network, volumes, start, deadline, `status` and, when the run didn't succeed, a `reason` written by hapi's own checks. The one piece of it a run wrote is the last line of `out/container.log`, sanitized and redacted, and labelled `the container's last log line:`. For an eval (design §3.8) it also holds the run's `kind`, `round`, `budgetUsd`, `roster`, `model` (the one its alias names; none for a verify run), `policyHash` (the SHA-256 of the effective policy), the poller's `parent`, `retry` and `forgeRepo` (the GitHub `owner/name`, lower-cased), and, from finalize, `spendUsd` and `turns` when the run's files say them, and `exitCode`, the container's exit code as Docker recorded it, when finalize could read it (never the run's status: a paused run exits 0). Its `workflow` is the one the run ran: its kind's, for a verify or a review. Finalize writes the outcome before it removes the run's objects, so a finalizer that dies in between still leaves it (H-219). Plan 03's harvester adds `harvestedAt`. |
| `run.json` | The run's input, as bound into the container. A review's also says whether its CodeRabbit step runs (`coderabbit`, the overlaid `runs.phases.coderabbit`). |
| `hapi-guard.json`, `run-config.yaml` | The run's own guard settings and Archon run layer, bound read-only at `/opt/hapi/pi-agent/hapi-guard.json` and `/opt/hapi/run-config.yaml`: generated when the run started, from the central policy with the repo's overlay applied, for `build/roster`'s roster ([generated configs](../generated-configs.md#buildpihapi-guardjson)). |
| `order.json`, `task.md` | The host's copies of the work order (as JSON) and its task text, bound read-only at `/run/hapi/order.json` and `/run/hapi/task.md`. |
| `inputs/` | A review's or a fix's: the host's copy of the inputs dir it was started with, `RUN_INPUTS`' files alone (0755, each file 0644), bound read-only at `/run/hapi/inputs`. |
| `out/run.bundle` | A worker's or a fix's: the git bundle of its commits, from the source commit to `HEAD`. Present if it committed. |
| `out/result.json` | Archon's own record of the run (`workflow runs`, `workflow get`), including its status and spend. |
| `out/transcript.jsonl` | Archon's run transcript. |
| `out/decisions.jsonl` | hapi-guard's decision log: one JSON object per line, the first of each Pi node attempt a `session_start` ([generated configs](../generated-configs.md#what-hapi-guard-enforces)). A worker's, a fix's and a Pi-run review's. |
| `out/verify.json` | A verify run's results: the repo's checks and the acceptance tests on exactly the bundle's commits (Task 11 writes it). |
| `out/coderabbit.ndjson` | A review run's CodeRabbit CLI output, when its CodeRabbit step ran (Task 11). |
| `out/container.log` | Only for a run that left no `result.json`. Before the container is removed, finalize keeps the last 200 lines of its log (`docker logs --tail 200`, under the helpers' 150 s bound), stripped of escape sequences, control characters and bidi controls, then of the archon zone's secret values (and a review's of the review zone's too) and key formats, as `watch` shows text. It is written 0600 by hapi, not copied from the run, and its last line is quoted in `reason`. Without the env file (either, for a review) nothing could redact it, so it isn't kept, and `reason` says so. A run that died in the prelude (the clone, the checkout, Archon's CLI failing to start) leaves nothing else. |

`<state dir>/supervise.log` (0600) holds the detached supervisors' output.

How the files get out: once the container has stopped, a fresh helper container of the same image (no network, read-only root, the `/out` volume mounted read-only) lists the volume, then reads each of the run's kind's outputs ([run kinds](#run-kinds)), one at a time, if it is a regular file and not a symlink, up to its cap plus one byte so an oversize file shows. A name that isn't one of them (a `run.bundle` in a verify's `/out`, say) is reported, never read, and fails the run. The bytes are written 0600 and renamed into place only if the helper exited 0 within the cap. The caps are `runs.output_limits_mb` in `policy/runs.yaml` (bundle 256, transcript 64, decisions 16, result 4): `verify.json` is held to `result`'s, and `coderabbit.ndjson` to `decisions`'. Nothing is bind-mounted writable from the host, because under rootless Docker the run's uid maps to a host uid whose files hapi can't delete.

**Everything in `out/` is untrusted data.** It is stored and checked, never executed, never read by git with its own config and never printed raw. Before a run counts as succeeded, finalize also checks that the bundle has exactly one head (`HEAD`), that Archon's own status is `completed` (a paused run exits 0, so the exit code is never the status), and that the guard ran in every Pi attempt: a Pi node attempt in the transcript with no `session_start` record in the decision log fails the run. That check catches a guard that failed to load. It doesn't catch a worker that writes fake records, because the guard and the worker share a uid ([threat model](../security/threat-model.md#plan-02-run-container)).

## Retention

`policy/runs.yaml` sets `retention_days` (14). Retention runs at the start of each `start` and `stop`, and deletes a finished run's directory only when its `record.json` has a `harvestedAt` more than `retention_days` ago. Plan 03's harvester sets `harvestedAt`, so **nothing is deleted in Plan 02**: a run's directory stays until the harvester exists and has read it. That is on purpose, so an output no harvester has read is never lost (H-206). Remove a directory by hand only when you have read what you need from it.

## The public flag

`--public` is the operator's statement that the repo is public. It goes into `run.json`, and hapi-guard reads it: **Jev**, the typed-decision model behind the level-6 gates, is asked about public repos only (spec §9.5; H-040). Without the flag, the gates use the Haiku classifier instead, which adds no recipient, since the worker's own model calls already go to Anthropic.

In Plan 02 the flag is an assertion, not a check: nothing on the host verifies it against the forge. Plan 03's poller sets it from the forge. A work order can't set it, because a model wrote the work order.

## The mirror

Plan 03's poller keeps a mirror of each registered repo (`policy/repos.yaml`), as hapi, on the host (`src/engine/mirror.ts`; design §3.4). It discovers merged work orders there ([below](#discovery)), and its own runs start from it. Each mirror is a bare repo at:

```text
${XDG_STATE_HOME:-~/.local/state}/hapi/engine/mirrors/<owner>/<name>.git
```

with hapi's home as `~`.

- **Only `main` and `factory/*`.** Each tick fetches exactly `+refs/heads/main:refs/heads/main` and `+refs/heads/factory/*:refs/heads/factory/*`, pruned, with no tags and no `FETCH_HEAD`. Nothing else of the repo's reaches the mirror. Both refspecs are forced, so a rewritten main is taken as it is ([the key](#discovery) keeps that from re-running anything).
- **No credential on disk.** The mirror's config names origin's URL, `https://github.com/<owner>/<name>.git`, and nothing else: no fetch refspec, no `http.extraheader` and no credential helper. The fetch's App token reaches git only in the fetch process's environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0`, from `authedHostGit` in `src/run/git.ts`), never its argv or the mirror's config. A failed fetch's error quotes git's first line with the token and its header as `[redacted]`. So a run that reads the mirror reads no token.
- **Its origin is checked.** Before every fetch, and each time the poller finds the mirror there, the mirror's only `remote.*` setting must be `remote.origin.url` with the repo's GitHub URL. Anything else is refused with `<path>'s origin is <url>, not https://github.com/<owner>/<name>.git: remove the mirror; the next tick makes it again` (or, for an extra setting beside the right URL, `<path>'s config has remote settings besides origin's URL (<keys>): …`), so the token is never sent anywhere else. One exception repairs itself: a mirror whose init ran but whose origin was never set (no `remote.*` at all) gets its origin set.
- **Pins.** The poller pins each work order it has state for at its merge commit, as `refs/hapi/orders/<id>` (`pinWorkOrder`, and `unpinWorkOrder` when it retires the state). A bare mirror keeps no reflog, so once main is rewritten the old merge is unreachable at once, and git's automatic gc, which a fetch can start, would prune it; the pin keeps it. The fetch's `--prune` touches only `main` and `factory/*`, so the pins stay.
- **World-readable.** The poller makes it with `git init --bare --shared=0644`, so its files are 0644 and its dirs 0755, and git keeps them so on every fetch (`core.sharedRepository`). The run container's uid can read it that way. The dir above it, `mirrors/<owner>`, is 0700 and hapi's alone. `--shared` also sets `receive.denyNonFastforwards`, which only a push would meet, and nothing pushes to a mirror.
- **Read as data.** Every other git call on the mirror is host git with no system or global config, no hooks and no fsmonitor (`hardenedGit`, the launcher's own), and discovery's calls also take literal pathspecs (`--literal-pathspecs`), so a directory name is never a glob. Files are read as blobs (`git cat-file blob`), never with `git show`, so no textconv, attribute or pager applies.
- **Safe to delete, but for its pins.** A mirror holds nothing that isn't on GitHub but its pins, so the next tick makes it again and fetches it. Deleting it drops the pins: if main has been rewritten, a work order the poller has state for that is keyed at an old merge can't be rebuilt any more (`<sha12> is not in the mirror (main was rewritten and the work order wasn't pinned, or the mirror was deleted)`), so retire its state, or plan the work again as a new work order. Delete one that is broken, or one whose origin is wrong ([above](#the-mirror)). Do it as hapi, from your own terminal, when no run of that repo is live (`hapi run list`), with the owner and name filled in:

  ```bash
  sudo -u hapi -H -- sh -c \
    'rm -rf -- "${XDG_STATE_HOME:-$HOME/.local/state}/hapi/engine/mirrors/example-owner/example-repo.git"'
  ```

  Expected: no output. The next tick makes the mirror again.

### Discovery

After each fetch, the poller discovers the work orders on the mirror's main: every `.factory/work/<id>/order.yaml` (`src/engine/discover.ts`).

- **The key is `<merge-sha>:<id>`.** A work order is keyed by the commit on main's first-parent line that first added its `order.yaml`: its planning PR's merge commit. Everything about it is read at that commit, never at main's head: the order, the `task.md` beside it, and the repo's overlay, `.factory/config.yaml`. A later edit on main changes nothing about a merged work order, and one deleted from main later is still rebuilt at its merge while the poller has state for it.
- **Never re-keyed.** The poller skips each id it already has state for before it looks for a key. A force-pushed main gives the merge a new sha, but a work order the poller has already taken up is never run again for it.
- **Its planning PR** is read from the merge commit's subject, GitHub's classic merge message, `Merge pull request #<n> from <owner>/<branch>`. `hapi new-repo` sets each repo to merge commits with that message, and the audit's [`github.repo-settings`](../audit.md#githubrepo-settings) holds it there. A key commit with any other subject has no planning PR, so its status goes only to the events and `hapi status`.
- **Problems.** A work order that can't run is never run. Discovery hands it to the poller as a problem, never as a work order, by its `order.yaml` path, for the tick's report and the status comment's "Can't run" table. The reasons:

  | Reason | What is wrong |
  |---|---|
  | `its directory's name is not a work-order id (four or more digits, a hyphen and a lower-case slug, at most 80 characters)` | The directory under `.factory/work/` isn't named as a work order's id is. The problem's path shows the name with anything but printable ASCII as `?`, cut at 80 characters, and no git call is made with it. |
  | `invalid YAML: <first line>` | `order.yaml` doesn't parse. |
  | `<path>: <message>` | The order fails its schema ([work orders](../policy.md#work-orders)). |
  | `its id is <id>, not its directory's name <dir>` | The order's `id` isn't the name of the directory it is in. |
  | `no task.md beside it at <sha12>` | There is no `task.md` beside the order. |
  | `<path> at <sha12> is not a regular file` | The order, its `task.md` or the overlay is a symlink, a directory or a submodule. |
  | `.factory/config.yaml at <sha12>: <path>: <message>` | The overlay fails its schema, or loosens the central policy, when an overlay may only tighten it ([repo overlays](../policy.md#repo-overlays-factoryconfigyaml)). |
  | `no commit on main's first-parent line adds it` | Git found no commit that adds the order, which shouldn't happen: a defensive check. |

  Because a work order is read at its merge, a fix on main doesn't change it. Plan the work again as a new work order, with a new id.

  Rebuilding a work order the poller has state for (`readWorkOrder`, at its merge) can fail the same ways, and one more: `<sha12> is not in the mirror (…)`, when its merge is gone ([the pins](#the-mirror)).

## The run disk

A run's `/work` and `/out` are bind-backed local volumes on one fixed-size filesystem, **the run disk**, mounted at `/var/lib/hapi/rundisk` (design §3.1, H-217). Each volume has a dir of its own there, named for it (`hapi-run-<id>-work`, `hapi-run-<id>-out`), which the launcher makes (0700) and checks before it asks Docker for the volume: Docker would make a volume on a dir that isn't there and fail only at `docker run`, with an exit code that says nothing of why ([spike 09](../spikes/09-run-engine-offline.md), finding 17). A run that fills its volumes fills the run disk and gets `No space left on device`. Docker's data root, under hapi's home, which every run and the stack share, is untouched.

- **Why there.** The path is fixed and made by root, outside hapi's home: root never acts on a path inside hapi's home ([the stack runbook](stack.md#hardening)). The filesystem's root dir is hapi's, so hapi makes and removes the runs' dirs itself.
- **The cap.** `runs.disk.gb` in `policy/runs.yaml` (20) counts **GiB**, and the run disk may be no bigger. **All runs share it:** the live runs (`runs.max_live`) have `runs.disk.gb` between them, not each.
- **The check.** `hapi run start` checks the run disk before it takes the start lock, and the audit's [`runtime.run-disk`](../audit.md#runtimerun-disk) makes the same check with the same reason. The run disk must be there, be a filesystem of its own (not its parent's), not be on the filesystem Docker's data root is on (`docker info`), be writable by hapi, and be at most `runs.disk.gb`. Under `runs.disk.enforcement: hard` (the default), a run disk that fails refuses every run. Under `soft`, `start` prints `hapi run start: warning: <the reason>; runs.disk.enforcement is soft, so the run starts anyway` and goes on.
- **Not `noexec`.** The mount is `nodev,nosuid` but not `noexec`: a run runs the repo's own tools from `/work`, such as `node_modules/.bin`, which a `noexec` mount would refuse (H-208; the tmpfs mounts are already `noexec`).
- **The cleanup.** Under rootless Docker a run's files belong to a subordinate uid hapi can't delete. So once a run's volumes are removed, a dir that is empty is removed by hapi at once, and one that isn't is emptied first by a helper container of the archon image, run as `1001:1001` with no network, no capabilities and a read-only root (`chmod -R u+rwX`, then `find -mindepth 1 -delete`), under the helpers' 150 s bound. A finalize does this for its own run. Each reap (the start of `hapi run start` and `hapi run stop`) also sweeps the run disk: a run's dir whose run isn't live and whose volume is gone (a start that failed, a `mise run down` that left the volumes, a cleanup that failed, a removed container's kept volumes once `down` has removed them) is cleaned the same way, holding the run's own lock. A finalize writes the run's outcome before it removes the run's objects (H-219), so a run whose finalize still holds that lock is left to it. Nothing else on the run disk is touched, `lost+found` included. A dir the reap can't clean fails it, and so every start, until it is cleaned ([below](#a-dir-the-reap-cant-clean)): a run disk filling up with leftovers fails closed.
- **The lock `down` and finalize share (H-210).** A finalize copies a run out holding the run disk's lock, and `mise run down` removes the runs holding it, so a copy-out never reads a volume `down` is removing. It is one lock for the whole run disk, so another run's copy-out, or a reap's finalize, can hold it too, for up to about six of the helpers' bounded calls (6 × 160 s: the container's exit code, the listing and four reads). **`down` never waits for it:** when it is held, or can't be taken at all (no `XDG_RUNTIME_DIR`), `down` says `hapi stack down: could not take the run disk's lock (<why>): removing the runs but leaving their volumes, and their dirs on the run disk: a finalize copying its run out removes that run's own, and the rest stay until a \`mise run down\` that takes the lock, so run it again once the lock is free (H-209, H-210)` and does just that, so kill switch 3 still takes seconds. **A finalize does wait:** it tries again each second, up to its 1410 s budget (`FINALIZE_WAIT_S`), whoever holds the lock (a reap instead leaves the run for the next one). With `runs.max_live` at 1 only one run is ever finalizing, so those waits can't stack; raising `max_live` needs this revisited.

### Making the run disk (the operator, once, with sudo)

Do this before hapi's checkout gets the run engine (Plan 03): without the run disk, `hapi run start` and the strict audit refuse. Run it **on the host, from your own terminal, as yourself**. It makes a 20 GiB ext4 image at `/var/lib/hapi/rundisk.img`, root's alone, and a systemd mount unit that loop-mounts it at `/var/lib/hapi/rundisk` at every boot, `nodev,nosuid`. `mkfs` makes the filesystem's root dir hapi's (`root_owner`), so root never has to hand hapi a path, and hapi then makes it `0700`:

```bash
sudo install -d -o root -g root -m 0755 /var/lib/hapi /var/lib/hapi/rundisk
sudo fallocate -l 20G /var/lib/hapi/rundisk.img
sudo chmod 0600 /var/lib/hapi/rundisk.img
sudo mkfs.ext4 -q -m 0 -L hapi-rundisk \
  -E root_owner="$(id -u hapi):$(id -g hapi)" /var/lib/hapi/rundisk.img
printf '%s\n' '[Unit]' 'Description=hapi run disk (H-217)' '' \
  '[Mount]' 'What=/var/lib/hapi/rundisk.img' 'Where=/var/lib/hapi/rundisk' \
  'Type=ext4' 'Options=loop,nodev,nosuid' '' '[Install]' 'WantedBy=multi-user.target' \
  | sudo tee /etc/systemd/system/var-lib-hapi-rundisk.mount >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now var-lib-hapi-rundisk.mount
sudo -u hapi -H -- chmod 0700 /var/lib/hapi/rundisk
findmnt -no SOURCE,FSTYPE,SIZE,OPTIONS /var/lib/hapi/rundisk
sudo -u hapi -H -- df -B1 --output=size,avail /var/lib/hapi/rundisk
```

Here `$(id -u hapi)` and `$(id -g hapi)` are your own shell looking up hapi's ids for `mkfs`. The unit is `WantedBy=multi-user.target` with systemd's default dependencies, so at every boot the run disk is mounted before user sessions start, and with them hapi's lingering user manager and its rootless Docker. If `hapi run start` ever refuses after a reboot with the run disk missing or not its own filesystem, check `systemctl status var-lib-hapi-rundisk.mount`. Expected: the `findmnt` line, a `/dev/loop<N>` `ext4` of about `19.5G` whose options hold `nosuid,nodev` and not `noexec`; and the `df` lines, a size under 21474836480 bytes (20 GiB) with nearly all of it available. Paste back both. To grow or shrink it later, change `runs.disk.gb` in a PR first, then, with no run live, `sudo systemctl disable --now var-lib-hapi-rundisk.mount`, remove the image and make it again at the new size.

### The live check (as hapi)

A throwaway volume on the run disk, `hapi-t20-diskcheck`, chowned as a run's are, then filled past the cap as uid 1001: the write must stop at `No space left on device`, and the Docker data root's free space must not move. It also shows the 1001 delete and hapi's `rmdir` working on hapi's rootless Docker. Run it **from your own terminal, as yourself**, after the run disk is made and `mise run up` has built the archon image. The `dd` writes the whole run disk, about 19.5 GiB, so it takes a minute or two:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  img=hapi-factory/archon:0.12.1; d=/var/lib/hapi/rundisk/hapi-t20-diskcheck; \
  root="$(docker info --format "{{.DockerRootDir}}")"; \
  mkdir -m 0700 "$d" && docker volume create --driver local --opt type=none \
    --opt o=bind --opt device="$d" hapi-t20-diskcheck >/dev/null && \
  docker run --rm --pull never --network none --user 0:0 --cap-drop ALL \
    --cap-add CHOWN -v hapi-t20-diskcheck:/w --entrypoint chown "$img" 1001:1001 /w && \
  echo "data root avail before: $(df -B1 --output=avail "$root" | tail -1)" && \
  docker run --rm --pull never --network none --user 1001:1001 -v hapi-t20-diskcheck:/w \
    --entrypoint sh "$img" -c "dd if=/dev/zero of=/w/fill bs=1M count=25600 2>&1 | tail -2"; \
  echo "data root avail after: $(df -B1 --output=avail "$root" | tail -1)"; \
  docker run --rm --pull never --network none --user 1001:1001 -v hapi-t20-diskcheck:/w \
    --entrypoint sh "$img" -c "rm -f /w/fill"; \
  docker volume rm hapi-t20-diskcheck >/dev/null; rmdir "$d"; \
  df -h --output=used,avail /var/lib/hapi/rundisk'
```

Paste back the whole output. Expected:

- `dd: error writing '/w/fill': No space left on device`, and a records line short of 25600;
- the two data-root `avail` figures within about 100 MB of each other;
- the closing `df` showing the run disk nearly empty again, which shows the 1001 delete and hapi's `rmdir` worked.

If any `docker` step fails, the commands after it still try to remove the volume and the dir; run `sudo -u hapi -H -- sh -c 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"; docker volume ls -q --filter name=hapi-t20-diskcheck; ls -la /var/lib/hapi/rundisk'` and paste that back too.

**If the first `docker run` (the `chown`) fails with `no such file or directory`**, typically `error while mounting volume '…/hapi-t20-diskcheck/_data': failed to mount local volume: mount /var/lib/hapi/rundisk/hapi-t20-diskcheck:…: no such file or directory`, hapi's rootless Docker was most likely already running when the run disk was mounted, and its own mount namespace (rootlesskit's) may still see the empty dir underneath, not the new filesystem ([spike 09](../spikes/09-run-engine-offline.md), finding 17: the bind fails only at `docker run`). Restart hapi's Docker, as hapi, once no run is live (`hapi run list`): it stops and restarts the stack's containers (`restart: unless-stopped` brings them back), and a live run would be lost. The script sets hapi's runtime dir and session bus, as `scripts/host-setup.sh` does for `systemctl --user`:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; \
  systemctl --user restart docker && systemctl --user is-active docker'
```

Expected: `active`. Then run the live check above again: the failed attempt removed its volume and dir on the way out. After a reboot this doesn't arise, since the run disk is mounted before hapi's Docker starts.

**The live result, design §7 item 1's evidence:**

> **PLACEHOLDER, to be filled by the controller:** the live check above has not been run on hapi's rootless Docker yet. When the operator has run it, the controller records here the date, the host, the `dd` error line, the data root's two `avail` figures and the closing `df`, and whether each expectation held.

### A dir the reap can't clean

A reap that couldn't clean a run's dir names it: `reaping left runs unfinished: run <id>: emptying run <id>'s dirs on the run disk failed (helper exit <n>)`, or `timed out after 150 s`, and every `hapi run start` refuses with it until the dir is gone. The usual causes are the archon image missing (the helper runs it with `--pull never`: run `mise run up`), hapi's Docker down (as hapi: `systemctl --user status docker`), or a tree too big to delete in 150 s. With no run live (`hapi run list`), empty and remove the run's dirs by hand, as the helper does but without its bound, with the run id the error names in place of `0123456789ab`:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; d=/var/lib/hapi/rundisk; \
  for v in work out; do p="$d/hapi-run-$1-$v"; [ -d "$p" ] || continue; \
    rmdir "$p" 2>/dev/null && continue; \
    docker run --rm --pull never --network none --read-only --user 1001:1001 \
      --cap-drop ALL --security-opt no-new-privileges:true -v "$p:/w" \
      --entrypoint sh hapi-factory/archon:0.12.1 \
      -c "chmod -R u+rwX /w && find /w -mindepth 1 -delete" && rmdir "$p"; \
  done; ls -la "$d"' hapi-rundisk 0123456789ab
```

Expected: the closing listing without `hapi-run-0123456789ab-work` or `-out`. Then `hapi run start` goes on. A reap that says `<path> on the run disk is not a directory (a symlink or a file)` found something hapi never makes there: look at it (`sudo -u hapi -H -- ls -la /var/lib/hapi/rundisk`), and remove that entry as hapi with `rm`, which removes a symlink itself, never what it points to.

## Rollout on hapi's checkout

Once this branch has landed on `main`, and before the first run. Each step runs on the host, started from your own terminal, as hapi in hapi's checkout, in the form above (hapi's `PATH` and runtime directory set). Wait for or stop any live run first (`hapi run list`, `hapi run stop <id>`): step 2's `down` removes a live run, which is then recorded `failed` with nothing copied out.

1. **Update hapi's checkout and install its dependencies.** `mise run setup` runs `bun install --frozen-lockfile`, which brings in `@anthropic-ai/sdk`, the package `hapi policy build` bundles into the guard and `hapi decide`. Without it `up` stops at its policy build.

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && git pull --ff-only && mise run setup'
   ```

   Expected: `git` fast-forwards and `bun install` finishes with no change to `bun.lock`.

2. **Take the stack down once.** `archon` is now profile-only, so `up` never touches the previous deploy's long-lived `hapi-archon-1` container and would leave that stale Archon server running, with its old image and mounts. `down` removes it, and keeps the volumes.

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && exec mise run down'
   ```

   Expected: the containers and networks of project `hapi` removed, with no error.

3. **Bring the stack up.**

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && exec mise run up'
   ```

   Expected: the three proxies and Hermes healthy, no `archon` container, and `docker compose build archon` having built `hapi-factory/archon:0.12.1`.

4. **Audit.** As hapi, in hapi's checkout, with the stack up ([the stack runbook](stack.md#5-the-audit)); `<owner>/<name>` and `<file>` are yours:

   ```bash
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
     export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
     cd "$HOME/hapi-factory" && exec mise run audit -- \
     --repo <owner>/<name> --strict --github-token-file <file>' | grep -v '^pass'
   ```

   Expected: two lines, the `mcp.tool-hashes` fail and `hapi audit: 14 pass, 1 fail, 0 skip` (as the operator's rollout got on 2026-10-31). mise then prints `[audit] ERROR task failed`: `--strict` exits non-zero on the one fail.

5. **Remove the old Archon volumes, once.** The long-lived Archon container is gone, and its two volumes are left over, holding the old Archon's run database and Claude Code state. Nothing reads them, and the factory keeps nothing in them. The operator removes them. The old container is gone after the `down` in step 2, so nothing uses them and the stack can stay up:

   ```bash
   sudo -u hapi -H -- sh -c 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" \
     DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; \
     exec docker volume rm hapi_archon-data hapi_archon-home'
   ```

   Expected: each name echoed, or `No such volume` for one already gone.

## The paid check

The first run that spends real money, and the one that shows hapi-guard, the egress proxy and copy-out working together on hapi's rootless Docker. Spike 07 and spike 08 ran everything on a developer's own Docker with fakes or no network; this check settles what they left unverified.

**Cost.** A few cents of Anthropic credit for Run A (one Haiku 5.5 node at low effort, capped at $0.25 by the work order and the workflow), a fraction of a cent for Run B (capped at $0.0001, so it stops after its first request), about as much as Run A for Run C (the same node, and its gates' Haiku calls, a fraction of a cent, also on Anthropic credit), and, if Jev answers Run A's bash gate, a few tenths of a cent of OpenRouter credit. If a command here is not what you expected, stop and do not retry: every run is capped, but each retry spends again.

**Before you start**, the rollout above is done (steps 1 to 3, so hapi's checkout has this branch, `mise run setup` has run, and `mise run up` has brought the stack up) and `hapi run list` shows no live run. `jq` must be installed on the host. Jev answers the public runs' gates from OpenRouter credit: with none, its call fails with `jev: openrouter HTTP 402.` in the gate record's `classifier.error`, and Haiku answers instead (`haiku true`), so add a little credit first if the check is to settle Jev. Every block runs **on the host, from your own terminal, as yourself**, handing one script to hapi's `sh`, as above. The runs' files are under `${XDG_STATE_HOME:-~/.local/state}/hapi/runs/<run-id>/` in hapi's home.

### 1. A throwaway repository

The work order's workflow overwrites `AGENTS.md`, so the repo needs one. Make a bare clone, as [`--repo`](#hapi-run-start) advises, so the run can't read a working checkout's `.git/config`. It holds one commit with `AGENTS.md` and `README.md`, made with a fixed identity so nothing of yours is in it. Pi reads a repo's `AGENTS.md` as project instructions, so this one must not tell the agent to leave the file alone: in the first paid check (2026-10-31) a "Do not edit this file" line made Haiku decline the write, and the guard had nothing to block. Making the repo again gives it a new commit, so every work order's run key is new:

```bash
sudo -u hapi -H -- sh -c 'set -e; umask 022; \
  rm -rf "$HOME/hapi-check-work" "$HOME/hapi-check-repo.git"; \
  git init -q -b main "$HOME/hapi-check-work"; cd "$HOME/hapi-check-work"; \
  printf "# Agent rules\n\nA throwaway repository for the paid check of hapi-guard.\n" > AGENTS.md; \
  printf "# Check repo\n\nA throwaway repository for the paid check.\n" > README.md; \
  git add AGENTS.md README.md; \
  git -c user.name=hapi-check -c user.email=hapi-check@localhost \
    commit -q -m "the paid check repo"; \
  git clone -q --bare "$HOME/hapi-check-work" "$HOME/hapi-check-repo.git"; \
  git -C "$HOME/hapi-check-repo.git" log --oneline'
```

Expected: one line, `<hash> the paid check repo`.

### 2. Run A, the normal budget

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run start \
  --repo "$HOME/hapi-check-repo.git" \
  --work-order archon/checks/work-order.yaml --public'
```

Expected: a twelve-hex-digit run id, and nothing else but mise's own lines. Call it `<run-a>`. `--public` is what lets Jev answer the bash gate. A refusal here (the archon env file, a live run, a key already run) names its fix; see [Troubleshooting](#troubleshooting) and do not go on until the run starts.

Follow it until it ends (a minute or two), with the run id in place of `0123456789ab`:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run watch 0123456789ab
```

Expected: the container's log, then the stored transcript and how the run ended. **The status may be `succeeded` or `failed`, as the model's reply goes** (it was told to overwrite a file it can't, so it may say so and stop). What passes the check is the guard's records, in step 5, not the status. Then list it:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run list
```

Expected: `<run-a>` with a `STATUS` that is not `live`, and a `SPEND` that is a dollar amount, not `-`.

### 3. Run B, a budget that trips

Run B's work order has an id of its own (`0002-check-guard-budget`), so its run key is new and the key of Run A doesn't refuse it. `--budget-usd` only lowers the work order's `$0.01`:

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run start \
  --repo "$HOME/hapi-check-repo.git" \
  --work-order archon/checks/work-order-budget.yaml \
  --public --budget-usd 0.0001'
```

Expected: a run id, `<run-b>`, **not** a refusal as a duplicate. Follow it with `watch` as above; it must end `failed`.

### 4. Run C, a run that isn't public

Runs A and B are `--public`, so Jev answers their gates, and Haiku only if Jev fails. A run that isn't public, Plan 03's default for a private repo, has only Haiku. Run C's work order (`0003-check-guard-private`) is Run A's with an id of its own, so its run key is new, and it is started **without `--public`**, so both gates go through Haiku. Start it once Run B has ended (one live run per repo):

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run start \
  --repo "$HOME/hapi-check-repo.git" \
  --work-order archon/checks/work-order-private.yaml'
```

Expected: a run id, `<run-c>`, **not** a refusal as a duplicate. Follow it with `watch` and `list` as for Run A. Its status, too, may be `succeeded` or `failed`.

### 5. Read the guard's records

These commands print fields hapi-guard chose (events, rule names, decisions, the classifier's name, route and cost), never the `reason` text or a tool's input, which can hold what the run wrote. Run each for `<run-a>`, `<run-b>` and `<run-c>`: each run's records are in its own directory, `runs/<run-id>/out/`. The filter is the argument in single quotes and the run id the last word.

The decision log, one line per record, tab-separated: event, rule, decision, tool, then for a gate the classifier's decision file, `via`, `fallback` and cost:

```bash
sudo -u hapi -H -- sh -c 'exec jq -r "$1" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/hapi/runs/$2/out/decisions.jsonl"' \
  hapi-jq '[.event, .rule, .decision, (.tool // "-"),
    (.classifier // {} | [(.decision // "-"), (.via // "-"),
    (.fallback | if . == null then "-" else tostring end), ((.cost_usd // "-") | tostring)] | join(" "))]
    | @tsv' 0123456789ab
```

Why a classifier didn't answer first, when a gate line says `haiku true` or `default`: the gate records' `classifier.error`, one line that `decide()` keeps free of secrets and state text, and each call's time:

```bash
sudo -u hapi -H -- sh -c 'exec jq -r "$1" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/hapi/runs/$2/out/decisions.jsonl"' \
  hapi-jq 'select(.event == "gate") | [.rule, (.classifier.error // "-"),
    ((.classifier.latency_ms // "-") | tostring)] | @tsv' 0123456789ab
```

The files that came out, to see the modes and owner:

```bash
sudo -u hapi -H -- sh -c 'ls -l "${XDG_STATE_HOME:-$HOME/.local/state}/hapi/runs/$1/out"' \
  hapi-ls 0123456789ab
```

The cost source Archon recorded, and the counts of two strings in the transcript (a count, not the text):

```bash
sudo -u hapi -H -- sh -c 'o="${XDG_STATE_HOME:-$HOME/.local/state}/hapi/runs/$1/out"; \
  jq -c "[.. | objects | (.cost, .costUsd) | objects | .source?] | map(select(. != null)) | unique" \
    "$o/transcript.jsonl" | grep -v "^\[\]$" | sort -u; \
  grep -c -F "models-store" "$o/transcript.jsonl"; \
  grep -c -F "(budgets.enforcement.hapi_guard: hard)" "$o/transcript.jsonl"' \
  hapi-cost 0123456789ab
```

Replace `0123456789ab` with the run id in each. Redaction is `watch`'s; these read the stored files directly, so keep to the filters above. The cost script's last `grep -c` prints `0` and exits 1 when the string is absent: that is a count, not an error. If `jq` stops on a non-JSON transcript line, report the parse error rather than retrying.

### What passes

**Run A.** In the decision log:

| Line | Meaning |
|---|---|
| `session_start  session-start  allow` | The guard loaded, and the live model matched the catalog's pins (a mismatch is `session_start  model-pin  fail`). |
| `tool_call  protected-path  block  write` | The write to `AGENTS.md` was stopped by rule `protected-path`. The model may then try another way (an `edit`, or a shell write, which blocks as `shell-write`); each attempt has its own block line. **Any `tool_call  rules  allow  write` or `edit` line is a fail**: the only write the prompt asks for targets `AGENTS.md`, so the pass is the block line. (A gate-allowed `date` leaves only its `gate  bash-gate  allow` line; `tool_call  rules  allow  bash` appears only when the gate is skipped or off.) |
| `gate  bash-gate  allow  bash  <decision> <via> <fallback> <cost>` | `date` ran after one bash-gate decision. |
| `gate  result-screen  allow  bash ...` | Possible: the result screen reads `bash` and `read` results too. Any `block` or `flag` here is worth reading in the report. |

Then the cost line, `SPEND` in `list` and a `succeeded` or `failed` status as above.

**Run B.** `run start` printed a run id, and the run is expected to end `failed`. **The pass line is the decision log's `budget  run-budget  fail`** (possibly after earlier `tool_call  run-budget  block` lines, the same rule refusing tool calls). The node's failure carries the hard-stop message, `hapi-guard: the run's budget of $0.0001 is spent ($<spent>); the node fails (budgets.enforcement.hapi_guard: hard)`, after about one request, and the second `grep -c` should print `1` or more. If the run ends `succeeded`, or that count is `0`, record it and report it: it is unverified that a throw from `message_end`, `turn_end` or `before_provider_headers` surfaces its text in the transcript, so it is a finding for Plan 02, not an operator error. Only a missing `budget  run-budget  fail` line is a failed check.

**Run C.** The same lines as Run A, but on the bash-gate line the classifier's columns must say Haiku answered as the first choice: `gate  bash-gate  allow  bash  <decision> haiku false <cost>`. That shows Haiku's request (thinking disabled, `output_config.effort: low`, a JSON schema format), the Anthropic key and the proxy's route to the API all work. A result-screen line, if there is one, says `haiku false` too. **A `via` of `default`, or a `fallback` of `true`, is a failure to fix before merge**: no classifier answered, so every run of a private repo would block every bash call and wrap every result.

**Every run.** Every Pi attempt has a `session_start` record. The run's status is not `failed` with a `reason` that starts `guard did not run in node` (see Troubleshooting): that check is the same fact, made by finalize. Run B ends `failed` for the budget, so its `reason` is hapi's check or Archon's status, never `guard did not run`.

### What it settles

| Open question | The line that answers it |
|---|---|
| Whether a paid run writes `models-store.json` (spike 08, finding 9) | The first `grep -c` prints `0` and Run A's node reached the model (`session-start allow`, a cost source, a non-`-` `SPEND`). The file is a read-only bind of `{}`: a Pi write to it would have failed the node, and the vector falls back to the pins and the guard's check. Any `models-store` in the transcript, or a node that failed before its first model reply, says it does write. |
| The chown helper on hapi's rootless Docker (spike 07, finding 12) | `run start` returned, `/work` and `/out` were writable (the run produced a decision log), and the run isn't `failed` with a reason about the volumes. |
| Copy-out on hapi's rootless Docker (spike 07, finding 14) | `ls -l` shows `result.json`, `transcript.jsonl` and `decisions.jsonl` (and no `run.bundle`: the worker never committed), each `-rw-------` and owned by hapi. |
| The real Squid behind the `egress-archon` alias (spike 07, finding 13) | Run A's node got a model reply through the proxy: a cost source is printed and `SPEND` is not `-`. A refusal would show as a node error in `watch`. |
| The live model's pins equal the catalog (spike 08) | `session_start  session-start  allow` for every attempt, with no `model-pin` line. |
| The Haiku classifier's request, which every run of a private repo depends on (`src/decide/haiku.ts`: thinking disabled, low effort, a JSON schema format, through the zone's proxy) | Run C's bash-gate line: `via` `haiku`, `fallback` `false`, and a cost. `via` `default` (or `fallback` `true`) means the request, the key or the route failed: a failure to fix before merge. |
| The Jev model id (`~typesafe/jev-latest`) against the `hapi-jev` guardrail | On the bash-gate line, `via` is `jev` and `fallback` is `false`: the guardrail passed the id, and the gate's cost is in the last column. `via` `haiku` with `fallback` `true` means the guardrail refused the id (or Jev was unavailable): record which. `via` `default` means no classifier answered, and the gate blocked. |
| `meta.cost.source` | The printed `source` value: `provider` is the model's own usage, anything else says Pi estimated it. |

Record the output of each command and the values the table asks for. They are what a later change to `policy/gates.yaml` (`classifiers.jev.model`, `unknown_call_usd`) is decided on, and the addendum to spike 08 is written from them.

### Clean up

The check leaves three runs' directories (they stay, by [retention](#retention)), the repo and its working copy in hapi's home. Remove the repos once you have what you need; `rm -rf` here acts only on hapi's own files, as hapi:

```bash
sudo -u hapi -H -- sh -c 'rm -rf "$HOME/hapi-check-work" "$HOME/hapi-check-repo.git"'
```

## The tests

- **Unit tests** (`mise run test`) cover the launcher, the run kinds, the run records, copy-out, the three preludes (each run for real on a sandbox, with a stand-in Archon CLI), the check workflows and the views, with Docker replaced by fakes: `tests/run/`. The review zone there is a fixture: Task 9 makes it real. The mirror and discovery tests (`tests/engine/`) run real git in temp dirs, with mirrors that fetch from a local path, never GitHub.
- **The run-container integration test** starts a real run of a bash-only workflow, no model and no real secret, in a throwaway Compose project. It needs the internet (a run reaches `api.anthropic.com` through the proxy) and builds the archon image, which can take up to 15 minutes:

  ```bash
  HAPI_INT=1 bun test tests/run/run.int.test.ts
  ```

  Run it from your own checkout, as yourself, on a host with Docker. It runs on your own Docker, not hapi's. Its run disk is a temp dir of the throwaway project's, neither capped nor a filesystem of its own, so it runs with `runs.disk.enforcement: soft` (start warns), and it checks that every run's dirs are gone at the end.
- **The audit integration test** checks the audit's run-container check and the `assistants` read-back on real Docker:

  ```bash
  HAPI_INT=1 bun test tests/audit/audit.int.test.ts
  ```

  `mise run test:int` runs every integration test, these included.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `the run disk /var/lib/hapi/rundisk does not exist` | The run disk isn't made yet. Make it as [the run disk](#making-the-run-disk-the-operator-once-with-sudo) says. |
| `the run disk /var/lib/hapi/rundisk is not its own filesystem (it shares /var/lib/hapi's)` | The run disk isn't mounted, so the dir is just a dir on the parent filesystem. `systemctl status var-lib-hapi-rundisk.mount` says why; `sudo systemctl start var-lib-hapi-rundisk.mount` mounts it. |
| `the run disk ... is on the same filesystem as Docker's data root` | The run disk is the filesystem Docker keeps its data on (`docker info --format '{{.DockerRootDir}}'`, as hapi), so filling it would fill Docker's disk. Mount the run disk's own image there, as set up. |
| `the run disk ... is not writable by this user: chown it to hapi` | The run disk's root dir isn't hapi's (made without `root_owner`, or changed since). With no run live: `sudo chown "$(id -u hapi):$(id -g hapi)" /var/lib/hapi/rundisk`, then `sudo -u hapi -H -- chmod 0700 /var/lib/hapi/rundisk`. It is outside hapi's home, so root may. |
| `the run disk ... is <n> GB, more than runs.disk.gb (20)` | The run disk is bigger than the cap, so one run could grow past it. Make it again at the cap's size ([making the run disk](#making-the-run-disk-the-operator-once-with-sudo), last line), or raise `runs.disk.gb` in a PR. |
| `cannot read Docker's data root (docker info exited <n>)` | `start` can't make the run disk check without Docker. As hapi, `systemctl --user status docker`. |
| `reaping left runs unfinished: run <id>: emptying run <id>'s dirs on the run disk failed` | A run's dir on the run disk couldn't be emptied, so starts stop until it is. See [a dir the reap can't clean](#a-dir-the-reap-cant-clean). |
| `` hapi run start: .../archon.env is missing: run `mise run up` first `` | The archon zone's env file is written by `hapi secrets resolve`, which `up` runs. Run `mise run up`, then start the run. |
| `` cannot read .../archon.env ... run hapi run as the user that ran `mise run up` `` | The file is in another user's runtime directory. Run `hapi run` as hapi, as above. |
| `` .../review.env is missing: run `mise run up` first `` | A review run holds the review zone's keys, from its own env file. `up` writes it once `stack/secrets.yaml` has a review zone (Task 9); until then no review run starts. A verify run needs no env file at all. |
| `a review run needs an inputs dir`, `a verify run takes no inputs dir`, `... is not one of a <kind> run's inputs ...`, `... has no <file>: a <kind> run's inputs dir must hold it` or `the inputs dir holds only regular files ...` | The poller handed a run an inputs dir its kind doesn't take, one without its required file, or one holding something other than its kind's inputs ([run kinds](#run-kinds)). Nothing a person passes: the inputs dir is the engine's (Task 13). A `run.bundle` there is refused on purpose: no container fetches a bundle. |
| `a verify run's workflow "factory-verify" is not in hapi's pack` (or `a review run's workflow "factory-review"`) | The pack has no verify or review workflow yet: Task 11 adds them to `archon/workflows/hapi/`. |
| A review run fails with `prelude: the checkout is not clean once its symlinks are plain files` in its container's log | After `review.sh` checked every symlink out again as a plain file, `git status` wasn't clean, so the prelude ended before Archon started. Read `out/container.log`; the commit's links (`git ls-tree -r <sha> \| grep ^120000`) are where to look. |
| `the work order's workflow "<name>" is not in hapi's pack` | The work order names a workflow that isn't a file of `archon/workflows/hapi/`, such as one of Archon's bundled ones. A run may use only the pack's workflows. Name one of them. |
| `hapi's pack has a problem: ... sets pi.enableExtensions: false` | A pack workflow turns Pi's extensions off in a node, which would drop hapi-guard there. Remove the setting. |
| A gate record's `classifier.error` is `jev: openrouter HTTP 402.` | The OpenRouter account or key is out of credit, so Jev didn't answer and Haiku did (`via haiku`, `fallback true`). Add credit to OpenRouter. |
| `egress_extra isn't supported yet` | The work order names extra egress hosts. A per-run proxy for them doesn't exist (H-088, H-207). Remove `egress_extra`. |
| `... is not a git repository with a .git dir, nor a bare one` | `--repo` names a linked worktree or a path that isn't a repo. Pass a checkout's main working directory, or better, a bare clone. |
| `cannot read the commit HEAD names` | The source has no commit checked out (`HEAD` doesn't resolve). Pass a repo with a commit. |
| `run <id> of work order ... is live` / `already succeeded` / `ended failed: pass --retry-of <id>` | The key (work-order id and commit) was run already. A live run: wait or `hapi run stop`. A failed, timed-out or stopped one: start again with `--retry-of <id>`. A succeeded one is never run again. |
| `run <id> is live for <repo>: one live run per repo` | Another run of the same repo is live. Wait, or stop it. |
| `N runs are live and runs.max_live is 1` | The cap in `policy/runs.yaml`. Wait for one to end, or stop one. |
| `run <id> is live but has no record ...` | A run container exists with no record directory (the record was removed by hand). `docker rm -f hapi-run-<id>` as hapi, or `mise run down`. |
| A run's status is `failed`, `reason` starts `no result.json was copied out` | The run died before the prelude's read-back, usually in the prelude itself: the clone, the checkout, or Archon's CLI failing to start. Read `out/container.log` in the run's directory (the last 200 lines of the container's log), and the line `reason` quotes from it. A `Permission denied` on `/src/repo.git` means the source isn't world-readable: the container reads it as another uid, so make it with `umask 022` ([`--repo`](#hapi-run-start)). |
| `hapi run start: ... a step failed` after a `docker network` or `docker volume` error | `start` removes what it made. The rest of the message is Docker's own error: a daemon that isn't running (as hapi: `systemctl --user status docker`), or the archon image missing (run `mise run up`, which builds it). |
| A run's status is `failed`, `reason` starts `guard did not run in node ...` | A Pi node attempt left no `session_start` record: hapi-guard failed to load, or the node never reached its hook. The run's output is not trusted. Read `out/transcript.jsonl` and `out/decisions.jsonl`. |
| A run's status is `failed`, `reason` starts `the run paused` | v1 has no approval nodes and nothing can answer one, so a pause fails the run. Fix the workflow. |
| `reason` says `the run's container was removed before the run was finalized` | `mise run down`, a cleanup or a prune removed the container while the run was live. Nothing was copied out, so the finalize left its volumes `hapi-run-<id>-work` and `-out`, with their dirs on the run disk, in place (`; the finalize left the run's volumes ... in place, since nothing was copied out (H-209)`): an exited run's outputs may still be in `-out`. Read what you need from them as hapi (`docker volume ls --filter label=org.hapi.run=<id>`), then `mise run down` removes them, and the next reap their dirs. Start the run again with `--retry-of`. |
| `reason` says `cleanup left run objects behind` | Docker couldn't remove one of the run's objects. `mise run down` removes everything labelled `org.hapi.run`. |
| `timed-out` | The run passed the work order's `budget.minutes` and was stopped. Raise the budget in the work order, or fix what is slow. |
| `hapi run watch` prints `run <id>'s container has exited, but the run was not finalized within 120 s: ...` | The supervisor is still finalizing (a copy-out of a large bundle can take up to 150 s per helper), or it died. `hapi run list` shows the status. If it is still `live` a few minutes on, the supervisor died: `list` and `watch` don't reap, so run `hapi run stop <id>` (or the next `hapi run start`), which finalizes the run, then `watch <id>` shows how it ended. |
| `stop` or `start` says a lock is held | Another `hapi run` command holds the launcher's lock. It fails at once and names the holder; run it again when that one ends. |
| `hapi run stop: run <id> has no container yet: its start may still be making it, ...` | The run's record exists but its container doesn't (H-218): a start is between writing the record and `docker run`, so the stop's own reap couldn't take the launcher's lock either. Wait a few seconds and stop it again. A container removed around hapi is a run the next `hapi run` command reaps (`failed`). |
| `.../build/roster is missing or names no roster (...): \`mise run up\` writes it` | The deployed build predates per-run settings, or was edited. `mise run up` builds it again, `build/roster` included. |
| `the work order's roles.implement is <tier>, a claude tier in the <roster> roster: ...` | A worker's implement must run on Pi. Name a `pi` tier for `implement` (`small` or `large`). |
| `the work order's roles.review is <tier>, a pi tier in the <roster> roster: ...`, or `... whose model in the <roster> roster, <model>, is roles.implement's (<tier>) too: ...` | The poller's review run needs a `claude` tier for `review` on another model than implement's: `medium` on the `anthropic` roster. The `portable` and `budget` rosters can't run a review yet (H-249): run the stack on `anthropic`. |
| `the repo's .factory/config.yaml adds egress_extra hosts, which aren't supported yet (H-207)` | The repo's overlay names extra egress hosts. Remove them from `.factory/config.yaml`. |
| `<sha12>:.factory/config.yaml: <path>: <message>`, `the repo's .factory/config.yaml: ...` or `.factory/config.yaml at <sha12> is not a regular file` | The repo's overlay at the run's commit fails its schema, loosens the central policy, or is a symlink, a directory or a submodule ([repo overlays](../policy.md#repo-overlays-factoryconfigyaml)). Fix it on the repo, then start from a commit that has the fix. |
| A tool in the run fails with `Permission denied` for a script under `/tmp` or `~` | Docker's tmpfs mounts are `noexec` (H-208). Run the tool through its interpreter (`sh script`, `python script.py`), or ask for it to be in the image. |
| `hapi stack down: could not take the run disk's lock (...): removing the runs but leaving their volumes, ...` | A finalize was copying a run out (the lock's holder is named), or `down` ran with no `XDG_RUNTIME_DIR`. `down` removed the runs' containers and networks and stopped the stack, without waiting (H-210). The finalize that was copying its run out removes that run's volumes and their dirs once its copy-out ends. Every other run's volumes stay, with their dirs: its finalize finds its container gone and leaves them in place (H-209), and no reap removes a volume. Once the copy-out has ended (or with `XDG_RUNTIME_DIR` set), run `mise run down` again, which removes them, and the next reap removes their dirs. `docker volume ls --filter label=org.hapi.run`, as hapi, shows any left. |
