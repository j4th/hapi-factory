# Runbook: runs

This runbook covers `hapi run`, the launcher that Plan 02 built (design: [the worker's design](../superpowers/specs/2026-10-29-hapi-factory-02-worker-design.md), §3.1 and §3.2; spec §9.2, §9.3, §11.3):

- [what a run is](#what-a-run-is), and [the container's layout](#the-containers-layout);
- [how to run the commands](#how-to-run-the-commands);
- [`hapi run start`](#hapi-run-start), [`watch`](#hapi-run-watch), [`list`](#hapi-run-list) and [`stop`](#hapi-run-stop);
- [the outputs](#the-outputs), [retention](#retention) and [the public flag](#the-public-flag);
- [the rollout on hapi's checkout](#rollout-on-hapis-checkout), once this branch has landed;
- [the tests](#the-tests) and [troubleshooting](#troubleshooting).

## What a run is

A run is one work order, run once, in one container that exists only for that run.

- **One container, one network, two volumes.** `hapi run start` makes a hardened Archon container from the `archon` service of `stack/compose.yaml`, on a network of its own (`--internal`) that `egress-archon` joins, and two volumes: `/work` (the clone) and `/out` (what may leave). It returns at once with a 12-digit hex run id.
- **No server.** The container runs one workflow with the Archon CLI in the foreground, then exits. No Archon API, web console or port exists for a worker to reach, so there is nothing to tunnel to ([threat model](../security/threat-model.md), AC-13).
- **Nothing outlives it but what is copied out.** The container's tmpfs mounts die with it. Its two volumes are read once, by a helper, and removed. What reaches the host is four named files ([the outputs](#the-outputs)).
- **A failed run starts over.** There is no resume. A run that fails, times out or is stopped is run again from a fresh clone with `--retry-of` ([the flags](#hapi-run-start)). Resume, reconsidered, is registered for the observability profile (H-213).
- **Liveness is Docker's.** A run is live while a container named for it, with the labels `org.hapi.run` and `org.hapi.project=hapi`, is running. No pid is trusted.
- **Plan 02 runs no model unless a work order's workflow calls one.** The two check workflows it ships (`hapi-check-run`, `hapi-check-guard`, in `archon/workflows/hapi`) are bash only, except the guard check's Pi node.

Plan 03's poller calls the same launcher, from merged work orders. Until then the operator starts runs by hand.

### The container's layout

Everything below is made by the launcher (`src/run/spec.ts`), from the `archon` service's user (`1001:1001`), limits (2048 pids, 4 GB), hardening and environment. The root filesystem is read-only, with all capabilities dropped and `no-new-privileges`.

| Path in the container | What it is | Writable |
|---|---|---|
| `/tmp` | tmpfs, 1 GB | yes, but `noexec` |
| `$HOME` (`/home/appuser`) | tmpfs, 256 MB. The generated `.gitconfig` is bound into it. | yes, but `noexec` |
| `/.archon` | tmpfs, 512 MB: Archon's run database, workspaces and logs. `config.yaml`, an empty `.env` and the workflow pack (`/.archon/workflows/hapi`) are bound into it. | yes, but `noexec`; the bound files are not |
| `/opt/hapi/pi-agent` | Pi's directory: tmpfs, 64 MB. Bound into it: `models.json`, `models-store.json` (`{}`), `hapi-guard.json`, `settings.json` and `extensions/`. | yes (Pi's cache and sessions); the bound files are not |
| `/work` | volume: the clone, `/work/repo`, which a worker edits | yes |
| `/out` | volume: `run.bundle`, `result.json`, `transcript.jsonl`, `decisions.jsonl` | yes |
| `/src/repo.git` | the source repository's git dir | no |
| `/run/hapi/run.json` | the run's input: its id, the work order's id, `traceparent`, the budget, the public flag, the workflow | no |
| `/opt/hapi/run.sh` | the fixed prelude that clones, runs the workflow and reads the results back | no |
| `/opt/hapi/run-config.yaml` | Archon's strict run layer: Pi extensions on, no auto-resume | no |

Docker mounts every tmpfs `noexec`, so a worker's tools can't run anything from `/tmp` or `$HOME`: a virtual environment's scripts under `~/.cache/uv`, for example, fail ([spike 07](../spikes/07-run-container.md), finding 18; H-208). The environment is `build/archon/archon.env`'s, set in `environment:` so no secret can override it; the archon zone's secrets are passed by name, with their values in the docker CLI's own environment only.

The prelude's order: clone sparse, without `.pi/`, `.agents/` and `.archon/` at the repo root (so a repo can't steer Archon or Pi); run the workflow from `/app`, never from inside the clone; then bundle the worker's commits, strip those three directories again, and read Archon's own record of the run into `/out`.

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

- **`--repo`** is where the run's clone comes from. Pass a **bare clone**, not a working checkout. The launcher binds the source's git dir into the container read-only, and a working checkout's `.git/config` is then readable by the run: an `http.extraheader`, or a token in a remote URL, would be visible to a worker. A bare clone of the repo has none. Make one as hapi: `git clone --bare <url> "$HOME/repos/example.git"`, with a URL that needs no credential. The run starts from the source's `HEAD`, so that is the commit the work is cut from (H-211 tracks the mirror that replaces this in Plan 03).
- **`--work-order`** is a work order file (`order.yaml`), validated on the host before anything starts ([docs/policy.md](../policy.md#work-orders)). A work order with a non-empty `egress_extra` is refused: a per-run proxy for it doesn't exist yet (H-088, H-207).
- **`--budget-usd`** only lowers the work order's `budget.usd`. A value above it is a usage error.
- **`--public`** is [the public flag](#the-public-flag).
- **`--retry-of <run-id>`** names the last run of the same work order and commit, which ended without succeeding. A run is keyed by the work order's id and the source commit: a key with a live or a succeeded run is refused, and one whose last run ended another way is refused unless `--retry-of` names that run. So a re-fire is safe.

**What it refuses**, in this order, with an error that names the fix: a work order that fails validation or names `egress_extra`; no archon env file (run `mise run up` first); a source that isn't a git repo or has no commit; a key already run; a second live run for the same repo (one per repo, H-090); more live runs than `max_live` in `policy/runs.yaml` (1 by default). A step that fails after that removes everything `start` made. A supervisor that starts and then dies is reaped by the next `hapi run start` or `hapi run stop`; `hapi run stop <id>` is the direct fix. `list` and `watch` never reap.

**The deadline** is the work order's `budget.minutes`. A detached `hapi run supervise <id>` waits for the container to end or the deadline, stops it at the deadline, then finalizes the run: copy-out, checks, removal and the record. You never run `supervise` yourself.

## `hapi run watch`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run watch 0123456789ab
```

Replace `0123456789ab` with the run id. For a live run it follows `docker logs --follow` of the run container, the only live view: the transcript is in the run's own `/.archon` tmpfs, out of the host's reach until copy-out. When the container exits, it waits up to two minutes for the run to be finalized, then prints the stored transcript, a line per row, and how the run ended. For a run that has ended it prints the stored transcript and the ending at once.

It reads and never writes: it doesn't answer a pause, call Archon or publish a port. Everything a run wrote is untrusted text, so each line has its terminal escape and control sequences removed, then the archon zone's secret values (read from the env file `hapi secrets resolve` wrote) and key-shaped strings replaced by `[hapi: <NAME> redacted]`. Redaction sees an exact value or a key format, never an encoded or split one: it keeps keys off the screen and is no boundary. Without the env file, `watch` fails and prints nothing of the run.

## `hapi run list`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run list
```

Expected: a table, newest first, of `RUN`, `STATUS` (`live`, `succeeded`, `failed`, `timed-out` or `stopped`), `REPO`, `WORK ORDER`, `STARTED` and `SPEND` (what Archon recorded in the run's `result.json`, or `-`). With none, `no runs in <state dir>`.

## `hapi run stop`

```bash
sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; \
  export XDG_RUNTIME_DIR PATH="$HOME/.local/bin:$PATH"; \
  cd "$HOME/hapi-factory" && exec mise run hapi -- run "$@"' \
  hapi-run stop 0123456789ab
```

It records that the run was stopped, runs `docker stop -t 30` on its container, copies the outputs out and removes the container, network and volumes. The grace period is 30 seconds, not Docker's 10, because the prelude passes the stop on to Archon, which marks the run failed and exits, and then reads the run back with the Archon CLI (up to three more `bun` starts). A KILL inside that would leave a stopped run without its outputs. The run's status is `stopped`.

To stop every run at once, use `mise run down` ([the stack runbook](stack.md#4-mise-run-up-and-mise-run-down)) or [kill switch 3](kill-switches.md#3-stop-the-stack): both remove every container labelled `org.hapi.run`. A run removed that way is finalized as failed, with nothing copied out.

## The outputs

Each run has a directory on the host, owned by hapi: `${XDG_STATE_HOME:-~/.local/state}/hapi/runs/<run-id>/`, with hapi's home as `~`. It holds:

| File | What it is |
|---|---|
| `record.json` | What the launcher started and how it ended: the id, key, repo, commit, work order, workflow, container, network, volumes, start, deadline, `status` and, when the run didn't succeed, a `reason` written by hapi's own checks (never text the run wrote). Plan 03's harvester adds `harvestedAt`. |
| `run.json` | The run's input, as bound into the container. |
| `out/run.bundle` | The git bundle of the worker's commits, from the source commit to `HEAD`. Present if the worker committed. |
| `out/result.json` | Archon's own record of the run (`workflow runs`, `workflow get`), including its status and spend. |
| `out/transcript.jsonl` | Archon's run transcript. |
| `out/decisions.jsonl` | hapi-guard's decision log: one JSON object per line, the first of each Pi node attempt a `session_start` ([generated configs](../generated-configs.md#what-hapi-guard-enforces)). |

`<state dir>/supervise.log` (0600) holds the detached supervisors' output.

How the files get out: once the container has stopped, a fresh helper container of the same image (no network, read-only root, the `/out` volume mounted read-only) lists the volume, then reads each of the four known names, one at a time, if it is a regular file and not a symlink, up to its cap plus one byte so an oversize file shows. A name that isn't one of the four is reported and never read. The bytes are written 0600 and renamed into place only if the helper exited 0 within the cap. The caps are `runs.output_limits_mb` in `policy/runs.yaml` (bundle 256, transcript 64, decisions 16, result 4). Nothing is bind-mounted writable from the host, because under rootless Docker the run's uid maps to a host uid whose files hapi can't delete.

**Everything in `out/` is untrusted data.** It is stored and checked, never executed, never read by git with its own config and never printed raw. Before a run counts as succeeded, finalize also checks that the bundle has exactly one head (`HEAD`), that Archon's own status is `completed` (a paused run exits 0, so the exit code is never the status), and that the guard ran in every Pi attempt: a Pi node attempt in the transcript with no `session_start` record in the decision log fails the run. That check catches a guard that failed to load. It doesn't catch a worker that writes fake records, because the guard and the worker share a uid ([threat model](../security/threat-model.md#plan-02-run-container)).

## Retention

`policy/runs.yaml` sets `retention_days` (14). Retention runs at the start of each `start` and `stop`, and deletes a finished run's directory only when its `record.json` has a `harvestedAt` more than `retention_days` ago. Plan 03's harvester sets `harvestedAt`, so **nothing is deleted in Plan 02**: a run's directory stays until the harvester exists and has read it. That is on purpose, so an output no harvester has read is never lost (H-206). Remove a directory by hand only when you have read what you need from it.

## The public flag

`--public` is the operator's statement that the repo is public. It goes into `run.json`, and hapi-guard reads it: **Jev**, the typed-decision model behind the level-6 gates, is asked about public repos only (spec §9.5; H-040). Without the flag, the gates use the Haiku classifier instead, which adds no recipient, since the worker's own model calls already go to Anthropic.

In Plan 02 the flag is an assertion, not a check: nothing on the host verifies it against the forge. Plan 03's poller sets it from the forge. A work order can't set it, because a model wrote the work order.

## Rollout on hapi's checkout

Once this branch has landed on `main`, and before the first run. Each step runs on the host, started from your own terminal, as hapi in hapi's checkout, in the form above (hapi's `PATH` and runtime directory set). Stop first if a run is live (`hapi run list`): `up` refuses while one is.

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

   Expected: two lines, the `mcp.tool-hashes` fail and `hapi audit: 14 pass, 1 fail, 0 skip` (not yet run live on the real host).

5. **Remove the old Archon volumes, once.** The long-lived Archon container is gone, and its two volumes are left over, holding the old Archon's run database and Claude Code state. Nothing reads them, and the factory keeps nothing in them. The operator removes them. The old container is gone after the `down` in step 2, so nothing uses them and the stack can stay up:

   ```bash
   sudo -u hapi -H -- sh -c 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" \
     DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; \
     exec docker volume rm hapi_archon-data hapi_archon-home'
   ```

   Expected: each name echoed, or `No such volume` for one already gone.

## The tests

- **Unit tests** (`mise run test`) cover the launcher, the run records, copy-out, the prelude, the check workflows and the views, with Docker replaced by fakes: `tests/run/`.
- **The run-container integration test** starts a real run of a bash-only workflow, no model and no real secret, in a throwaway Compose project. It needs the internet (a run reaches `api.anthropic.com` through the proxy) and builds the archon image, which can take up to 15 minutes:

  ```bash
  HAPI_INT=1 bun test tests/run/run.int.test.ts
  ```

  Run it from your own checkout, as yourself, on a host with Docker. It runs on your own Docker, not hapi's.
- **The audit integration test** checks the audit's run-container check and the `assistants` read-back on real Docker:

  ```bash
  HAPI_INT=1 bun test tests/audit/audit.int.test.ts
  ```

  `mise run test:int` runs every integration test, these included.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `hapi run start: .../archon.env is missing: run `mise run up` first` | The archon zone's env file is written by `hapi secrets resolve`, which `up` runs. Run `mise run up`, then start the run. |
| `cannot read .../archon.env ... run hapi run as the user that ran `mise run up``  | The file is in another user's runtime directory. Run `hapi run` as hapi, as above. |
| `egress_extra isn't supported yet` | The work order names extra egress hosts. A per-run proxy for them doesn't exist (H-088, H-207). Remove `egress_extra`. |
| `... is not a git repository with a .git dir, nor a bare one` | `--repo` names a linked worktree or a path that isn't a repo. Pass a checkout's main working directory, or better, a bare clone. |
| `cannot read the commit HEAD names` | The source has no commit checked out (`HEAD` doesn't resolve). Pass a repo with a commit. |
| `run <id> of work order ... is live` / `already succeeded` / `ended failed: pass --retry-of <id>` | The key (work-order id and commit) was run already. A live run: wait or `hapi run stop`. A failed, timed-out or stopped one: start again with `--retry-of <id>`. A succeeded one is never run again. |
| `run <id> is live for <repo>: one live run per repo` | Another run of the same repo is live. Wait, or stop it. |
| `N runs are live and runs.max_live is 1` | The cap in `policy/runs.yaml`. Wait for one to end, or stop one. |
| `run <id> is live but has no record ...` | A run container exists with no record directory (the record was removed by hand). `docker rm -f hapi-run-<id>` as hapi, or `mise run down`. |
| `hapi run start: ... a step failed` after a `docker network` or `docker volume` error | `start` removes what it made. The rest of the message is Docker's own error: a daemon that isn't running (as hapi: `systemctl --user status docker`), or the archon image missing (run `mise run up`, which builds it). |
| A run's status is `failed`, `reason` starts `guard did not run in node ...` | A Pi node attempt left no `session_start` record: hapi-guard failed to load, or the node never reached its hook. The run's output is not trusted. Read `out/transcript.jsonl` and `out/decisions.jsonl`. |
| A run's status is `failed`, `reason` starts `the run paused` | v1 has no approval nodes and nothing can answer one, so a pause fails the run. Fix the workflow. |
| `reason` says `the run's container was removed before the run was finalized` | `mise run down` or a cleanup removed the container while the run was live. Nothing was copied out. Start the run again with `--retry-of`. |
| `reason` says `cleanup left run objects behind` | Docker couldn't remove one of the run's objects. `mise run down` removes everything labelled `org.hapi.run`. |
| `timed-out` | The run passed the work order's `budget.minutes` and was stopped. Raise the budget in the work order, or fix what is slow. |
| `hapi run watch` prints `run <id>'s container has exited, but the run was not finalized within 120 s: ...` | The supervisor died. `list` and `watch` don't reap: run `hapi run stop <id>` (or the next `hapi run start`), which finalizes the run, then `watch <id>` shows how it ended. |
| `stop` or `start` says a lock is held | Another `hapi run` command holds the launcher's lock. It fails at once and names the holder; run it again when that one ends. |
| A tool in the run fails with `Permission denied` for a script under `/tmp` or `~` | Docker's tmpfs mounts are `noexec` (H-208). Run the tool through its interpreter (`sh script`, `python script.py`), or ask for it to be in the image. |
| `docker: Error response from daemon: ... volume is in use` during `mise run down` while a run is finalizing | The copy-out helper and `down` raced for the run's volume. Run `mise run down` again once `hapi run list` shows no `live` run (H-210). |
