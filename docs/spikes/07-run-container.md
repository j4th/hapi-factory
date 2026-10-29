# Spike 07: the run container

- **Plan 02 Task 1 (spike T15)**, for Tasks 4, 6, 7, 8 and 10. Run on 2026-10-29.
- **Where:** the operator's own Docker 29.9.2 (Compose 5.6.1), as spike T8 did, not hapi's rootless one. No network (`--network none`), no secrets, no model call. Every object was named `hapi-t15-*` and removed afterwards; `docker ps -a`, `docker network ls` and `docker volume ls` show none left.
- **Image:** `hapi-factory/archon:0.12.1` (Archon 0.12.1, Pi 1.3.0, git 2.47.3, Bun 1.4.2), as built locally.
- **Result: the one-shot container works as Tasks 6 and 7 describe it, with no change to the prelude.** The clone, the sparse strip, `--no-worktree`, the `--config` seal, the post-run read-backs and the copy-out all ran. The repo's decoys changed nothing. The git hardening held for Archon's own git, with the filter residual the plan expects. Each control showed that the threat is real when its guard is missing.
  - Without the strip, the repo's workflow file replaces the home one, and its config turns extensions off and adds env to the nodes.
  - With the CLI started inside the clone, the repo's `.archon/.env` overrides the container's `PI_OFFLINE`, and the repo's `bunfig.toml` preload runs inside Archon itself.
  - Without the env config, Archon's own `git status` runs a planted `core.fsmonitor`.
- **What changes later tasks:**
  - the check workflows may read `$NAME` directly (finding 2);
  - the live view comes from `docker logs`, since the transcript can't be reached while the run is live (finding 15);
  - the copy-out writes 0600 files and keeps only the reads that succeeded (finding 14);
  - the tmpfs mounts are `noexec` (finding 18);
  - two in-run residuals: the repo's bunfig preload (finding 9) and git filters (finding 10).

## Setup

- **The run container**, built by `spikes/scratch/15/go.sh` in the layout Task 7's `runArgs` gives:

  ```bash
  docker run -d --name hapi-t15-run-<tag> --network none --user 1001:1001 --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --pids-limit 2048 --memory 4g \
    --tmpfs /tmp:size=1g,uid=1001,gid=1001,mode=1777 --tmpfs /home/appuser:size=256m,uid=1001,gid=1001,mode=0700 \
    --tmpfs /.archon:size=512m,uid=1001,gid=1001,mode=0700 --tmpfs /opt/hapi/pi-agent:size=64m,uid=1001,gid=1001,mode=0700 \
    -v <models.json>:/opt/hapi/pi-agent/models.json:ro -v <settings.json>:/opt/hapi/pi-agent/settings.json:ro \
    -v <config.yaml>:/.archon/config.yaml:ro -v <empty.env>:/.archon/.env:ro -v <pack>:/.archon/workflows/hapi:ro \
    -v <run-config.yaml>:/opt/hapi/run-config.yaml:ro -v <gitconfig>:/home/appuser/.gitconfig:ro \
    -v <run.sh>:/opt/hapi/run.sh:ro -v <run.json>:/run/hapi/run.json:ro -v <source>/.git:/src/repo.git:ro \
    -v hapi-t15-work:/work -v hapi-t15-out:/out \
    -e <Task 6's ARCHON_ENV, all of it> -w /app --entrypoint sh hapi-factory/archon:0.12.1 \
    /opt/hapi/run.sh <workflow> <sha> wo-t15-0001 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
  ```

  - Both volumes were created fresh for each run and chowned to 1001 first, by finding 12's helper.
  - The environment was Task 6's `ARCHON_ENV` list in full: `ARCHON_DOCKER=true`, telemetry off, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_CODING_AGENT_DIR`, `BUN_OPTIONS=--no-install`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_COUNT=13` with the 13 pairs, the six git env variables and `CLAUDE_BIN_PATH`.
- **The prelude,** `spikes/scratch/15/run.sh`, is Task 6's `run.sh` word for word, plus a spike-only debug dump into `/out/debug.txt`. In order:
  1. `set -eu; mkdir -p /.archon/workspaces /.archon/worktrees`;
  2. `git clone --no-checkout --no-hardlinks /src/repo.git /work/repo`;
  3. `git -C /work/repo sparse-checkout set --no-cone '/*' '!/.pi/' '!/.agents/' '!/.archon/'`;
  4. `git -C /work/repo checkout --detach "$2"`, then `git -C /work/repo remote remove origin`;
  5. `cd /app`, then `bun --no-env-file /app/packages/cli/src/cli.ts workflow run "$1" --cwd /work/repo --no-worktree --config /opt/hapi/run-config.yaml --input work_order_id="$3" --input traceparent="$4" &`;
  6. `trap 'kill -TERM "$pid"' TERM INT`, `rc=0; wait "$pid" || rc=$?`, and the `while kill -0` loop;
  7. `set +e`; `/out/result.json` as `{"runs": <workflow runs --json>, "run": <workflow get <id> --json --verbose>}`; the transcript copied from `transcript_path` to `/out/transcript.jsonl`; and `git bundle create /out/run.bundle <sha>..HEAD` if HEAD moved;
  8. `exit "$rc"`.
- **The files bound in** (all under `spikes/scratch/15/`, gitignored):
  - `config.yaml`, a copy of the generated `build/archon/config.yaml` (tiers and aliases only);
  - `run-config.yaml`: `assistants.pi.enableExtensions: true`, `workflows.autoResumeOnQuotaReset: false`;
  - `gitconfig`, Task 4's file: `[safe]` `/src/repo.git` and the four `/.archon` grants, plus `[user]`;
  - `empty.env`, which holds one comment line;
  - the pack `wf/`: Task 6's `hapi-check-run` nodes, and `t15-fail`, `t15-approval`, `t15-sleep`, `t15-b`, `t15-c`, `t15-env` and `t15-dollar`.
- **The source repo,** `spikes/scratch/15/src/repo`, owned by the operator's uid (1000), not 1001. It has two commits:
  - **A, clean:** `README.md` and `AGENTS.md`;
  - **B, with the decoys:**
    - `.archon/config.yaml` (`assistants.pi.enableExtensions: false`, plus an `env:` marker);
    - `.archon/workflows/hapi-check-run.yaml` and `t15-b.yaml`, each a decoy with a home workflow's file name;
    - `.archon/.env` with `PI_OFFLINE=0` and a marker;
    - `.pi/extensions/evil.ts`, which writes `/tmp/pwned`;
    - `.agents/skills/x/SKILL.md`;
    - `bunfig.toml` with `preload = ["./preload.ts"]`, where `preload.ts` writes a marker.
- **Controls:**
  - `run-c1.sh`: no sparse strip and no `--config`;
  - `run-c2.sh`: no strip;
  - `run-c3.sh`: no strip, and the CLI started with the clone as its working directory;
  - `T15_NOGITCFG=1`: no `GIT_CONFIG_COUNT` pairs.
- **The host-side checks (Step 4)** used throwaway containers of the same image. The proxy stand-in was `python3 -m http.server 3128` in that image, since no Squid image is present here; the DNS question doesn't depend on what listens.

## Evidence

Raw output is in `spikes/scratch/15/evidence/<tag>/` (`stdout.txt`, `stderr.txt`, `exit.txt` and the copied `out/`).

| Run | What happened |
|---|---|
| `validate`, `validate2` | `validate workflows <name> --json` gave `valid: true` with no issues for `hapi-check-run` (the `printenv` form) and for `t15-dollar` (`$BUN_OPTIONS`, `$HOME`, `${HOME}`). It gave one error for `t15-unbound`: `Node 'inputs-nope' bash (bash line 1) reads environment variable 'INPUTS_NOPE', which is not provided by its bindings, declared inputs, or the engine.` In the same workflow, `$TRACEPARENT` and `$T15_NOT_SET_ANYWHERE` passed. `t15-approval` gave one warning: `'approval:' is deprecated`. |
| `ok`: `hapi-check-run` at A | **Exit 0, status `completed`**, in under 2 s from `docker run` to exit. Every node passed: `appuser` (uid 1001); `cwd=/work/repo: no .pi, .agents or .archon`; `error: Cannot find package 'left-pad' from '/tmp/x.ts'`; `command /dev/null` for `core.hooksPath` and five `global` `safe.directory` entries; HOME, `/.archon` and the Pi dir writable; `models.json: Read-only file system`; `CapEff: 0000000000000000`, `NoNewPrivs: 1`; archon 0.12.1, pi 1.3.0, node v24.22.1, uv 0.13.5, Python 3.14.9; curl `000` to both URLs (no network); one commit. Outputs: `result.json`, `transcript.jsonl` and `run.bundle`. `prelude: post-run steps took 0s`. |
| `nomkdir` | The prelude without `mkdir -p /.archon/...`: completed. Archon made `/.archon/workspaces` itself; `/.archon/worktrees` was never made (and isn't needed with `--no-worktree`). |
| `fail`: `t15-fail` | **Exit 1, status `failed`**, `stop_reason {reason: node_error}`. stderr: `[boom] Failed: Bash node 'boom' failed [exit 42]: about to exit 42`, `[after] Skipped (upstream failed: boom)`, `Error: Workflow failed: Workflow did not complete successfully`. `terminal_record.first_failed_node: boom`. |
| `approval`, `attention` | **Exit 0, status `paused`** for both. stdout ends `Workflow paused — waiting for approval.` The `wait: { attention: … }` run has `metadata.wait {kind: attention, nodeId: ask, …}`. |
| `stop`: `t15-sleep`, then `docker stop` | Container exit 1. stderr: `prelude: got TERM/INT, forwarding to 14`, `prelude: workflow run exited 1`, `post-run steps took 0s`. `docker stop` returned in 0.57 s, inside the 10 s grace. The run is `failed`, error `Process terminated (SIGTERM)`, `stop_reason {reason: process_terminated, signal: SIGTERM}`, and its `terminal_record` shows node `long` as `running`. The transcript's last row is `node_start long`: there is no `workflow_error` row. `result.json` and `transcript.jsonl` were still written. |
| `b`: `t15-b` at B, stripped | Exit 0, `completed`. `T15-HOME-WORKFLOW-RAN`, with no decoy marker. The node env has `PI_OFFLINE=1` and neither marker. `ls -A`: `.git AGENTS.md README.md bunfig.toml hello.ts preload.ts`. `status: []`, and `git ls-files -t` lists the six decoy files as `S` (skip-worktree). The plant: `/.archon/.env: Read-only file system`; `rm` and `mv` of it: `Device or resource busy`; `/.archon/workflows/hapi/planted.yaml: Read-only file system`; `mkdir /.archon/workflows/planted: Permission denied`. Read-back: `enableExtensions: true`. No `/tmp/pwned` and no `/tmp/t15-decoy-ran`. |
| `b2`: `hapi-check-run` at B | Exit 0. The home workflow ran (`strip` node passed, no `DECOY` in stdout). The bundle's commit adds only `t15.txt` (`git diff --stat` against B: `1 file changed`); the decoy files are still in its tree. |
| `c1`: no strip, no `--config` | `Discovery: … project=2`. The repo's `t15-b.yaml` ran (`T15-DECOY-WORKFLOW-RAN`). Read-back `enableExtensions: false`, `run_config: null`. In `c1-env`, a home workflow the repo doesn't shadow saw `T15_REPO_ENV_MARKER=the repo's .archon/config.yaml env: applied`. |
| `c2`: no strip, with `--config` | The decoy still ran. Read-back `enableExtensions: true`, with keys `["assistants.pi.enableExtensions","workflows.autoResumeOnQuotaReset"]`. |
| `c3-env`: no strip, CLI cwd the clone | The node saw **`PI_OFFLINE=0`** (the container set 1), `T15_REPO_DOTENV_MARKER=repo-archon-dotenv-loaded`, the `env:` marker, and `preload ran in /work/repo`, written before any node ran, so by the Archon CLI's own `bun`. The stripped run of the same workflow (`s-env`) saw `PI_OFFLINE=1`, no markers and no preload. |
| `c-hard`: plant, then observe | Node 1 set `core.fsmonitor`, `core.hooksPath` and `filter.x.clean` in `.git/config` (`local`), and wrote `.gitattributes` (`*.txt filter=x`) and `planted.txt`. Effective values: `command false`, `command /dev/null`, `local /opt/t15c/clean`. **At node 2's start, after Archon's own checkout observation, only `filter-clean` had fired.** The worker's own `git status` (inherited env) added nothing. `env -u GIT_CONFIG_COUNT git status` fired `fsmonitor` twice and `hook-post-index-change` once. At the end: 3 `filter-clean`, and no other markers besides the worker's own unhardened command's. |
| `c-soft`: the same, no env config | **Archon's own git fired `fsmonitor` 4 times before node 2 ran**, and 14 by the end, plus `hook-post-index-change`. |
| `c-hard` Bun node | `BUN_OPTIONS=--no-install`: `error: Cannot find package 'left-pad' from '/tmp/x.ts'`, rc=1, `registry hits so far: []`. Control, `env -u BUN_OPTIONS bun /tmp/ctl/x.ts`: `RESOLVED "  a"`, rc=0, hits `GET /left-pad;GET /left-pad/-/left-pad-1.0.0.tgz`. |
| 1(b): `safe.directory` (`evidence/1b-safe-directory.txt`) | Source owned by 1000, run as 1001. With no grant, or a global file without `[safe]`: `fatal: detected dubious ownership in repository at '/src/repo.git'`, clone rc=128. With `GIT_CONFIG_COUNT` `safe.directory=/src/repo.git` only: the clone fails the same way, but `git -C /src/repo.git rev-parse` passes. **With the generated `GIT_CONFIG_GLOBAL` holding `[safe] directory = /src/repo.git`: clone rc=0,** with `GIT_ALLOW_PROTOCOL=file` and `GIT_PROTOCOL_FROM_USER=0` set too. |
| 4(b0) (`evidence/b0.txt`) | A fresh volume at `/v`: `root:root 755`, and `touch: cannot touch '/v/x': Permission denied`. The helper `--user 0:0 --cap-drop ALL --cap-add CHOWN … --entrypoint chown … 1001:1001 /v`: rc=0, then `appuser:appuser 755` and the touch works. Without `--cap-add CHOWN`: `chown: changing ownership of '/v': Operation not permitted`. |
| 4(a) (`evidence/4a-network.txt`) | `hapi-t15-net`: `Internal=true`, subnet `172.22.0.0/16`. Before connecting, nothing resolves. `docker network connect` without `--alias`: `hapi-t15-proxy` resolves, `egress-archon` doesn't (curl rc=6), though the container has that alias on its own network. With `--alias egress-archon`: it resolves to 172.22.0.2, and `curl http://egress-archon:3128/` gives 200. `docker network rm` while attached: `network hapi-t15-net has active endpoints`, exit 1. `disconnect -f`, then `rm`: both rc=0. |
| 4(b) (`evidence/4b-copyout.txt`) | `result.json` (0600 in the volume, 23 B) and `run.bundle` (1 MiB random) copied, ok. `transcript.jsonl`, a symlink to `/etc/passwd`, and `decisions.jsonl`, a FIFO: `refused: … is not a regular file`, rc=3. `missing.json`: refused the same way. `big.json` (3000 B, cap 2048): read 2049, so oversize. sha256 the same on both sides (`038e8bc5…`). Host files `1000:1000 664`: the invoking user, mode from the umask. A refused name still leaves a 0-byte host file. `[ -f ]` is true for the symlink. An unguarded `head` of the FIFO blocks: `timeout` rc=124. |
| 4(c) (`evidence/4cd.txt`) | `docker logs --follow --timestamps` streamed stdout and stderr lines as they came, then returned rc=0 after 3.0 s, when the container exited (its own exit code was 7, from `docker wait`). |
| 4(d) (`evidence/4d-ps.txt`) | `T15_FAKE_SECRET=fake-… docker run … -e T15_FAKE_SECRET …`: `ps` shows only `-e T15_FAKE_SECRET`. The value isn't in the CLI's argv (0 lines). It is in the CLI's own `/proc/<pid>/environ` (1 line), and in `docker inspect` `Config.Env`. Inside the container `printenv` gives it. An `-e NAME` for an unset name isn't set in the container. `--env-file` with `T15_Q='fake quoted value'` gives `T15_Q=['fake quoted value']`: the quotes are kept. |
| 4(e) (`evidence/4e-compose.txt`) | A throwaway project, `hapi-t15-compose`, with `archon` (`profiles: ["run"]`, `build:`) and `other`. `up --no-start --build` built and created `other` only. `compose build` built `other` only. `compose build archon` built `archon`. `config --services` without a profile lists `other` only. |
| tmpfs flags | `/proc/self/mountinfo`: `/tmp`, `/home/appuser`, `/.archon` and `/opt/hapi/pi-agent` are `rw,nosuid,nodev,noexec`. The volumes `/work` and `/out` are `rw` only. A script in `/tmp` exits 126 (`Permission denied`) when run directly, and runs as `sh /tmp/x.sh`. |

## Findings

1. **The prelude works as written.** The clone from a read-only, foreign-owned git dir, the sparse strip, the detached checkout, the removed remote, the CLI started from `/app` with `--cwd /work/repo --no-worktree`, and both `--input`s ran, with no server. Archon registered the clone as `_local/repo` and created its workspace under `/.archon/workspaces/_local/repo/`.
   - The `mkdir -p /.archon/workspaces /.archon/worktrees` is not needed: Archon creates `workspaces/` itself, and `worktrees/` is unused with `--no-worktree`. It is harmless.
   - With no remote, every run logs a warning, `workflow.base_branch_auto_detect_failed` (`Set worktree.remote to select a git remote.`). `$BASE_BRANCH` is then empty. It is harmless.
   - The post-run reads and writes took under a second, including after a SIGTERM.
   - **Ruling for Plan 02:** matches the plan (Task 6 Step 3, `run.sh`). The `mkdir` may stay. Task 8's integration test must not treat that warning as a failure.
2. **Archon's validator rejects only an undeclared `INPUTS_*` name.** `$BUN_OPTIONS`, `$HOME`, `${HOME}`, `$TRACEPARENT` and an arbitrary unset name all pass `validate workflows`. Spike 03 finding 2 reads more broadly than this.
   - **Ruling for Plan 02:** Task 6 Step 3: `hapi-check-run` may read `$BUN_OPTIONS` and `$HOME` directly, and the `printenv` form isn't required. Task 6's `workflows.test.ts` doesn't need to forbid `$NAME`.
3. **The `safe.directory` grant must be in the `GIT_CONFIG_GLOBAL` file, naming the mounted git dir.** The source mount is the git dir itself (`/src/repo.git`), so the grant names that path, not `<src>/.git`. An env-config grant (`GIT_CONFIG_COUNT`) passes git's in-process check (`rev-parse`), but not the clone's `upload-pack`. Archon's own git, the worker's commit and the bundle all ran in `/work/repo`, which 1001 owns, so they needed no grant.
   - **Ruling for Plan 02:** matches the plan (Task 4's `gitconfig`: `/src/repo.git` plus the four `/.archon` entries, which `--no-worktree` doesn't use but which do no harm).
4. **Archon writes nothing into the clone, and the binds nested in `/.archon` break nothing.** After a run, the clone holds `.git` and the tracked files only, and `git status --porcelain --ignored` is empty.
   - Archon wrote `archon.db`, `credential-key`, `staged-source/` and `workspaces/_local/repo/{artifacts,logs,source,state,workflow-source,worktrees}` beside the read-only `config.yaml`, `.env` and pack.
   - Docker created `/.archon/workflows` root-owned (0755) to hold the pack's mount point. Archon never needed to write there, and the worker can't (`Permission denied`).
   - `/.archon` used 1.8 MB for a bash-only run.
   - The transcript is `/.archon/workspaces/_local/repo/logs/<run-id>.jsonl`.
   - **Ruling for Plan 02:** matches the plan (Task 7's argv). Tasks 7 and 8 take the transcript path from `workflow get`'s `transcript_path`, as `run.sh` does, not from a fixed path.
5. **Exit codes and statuses:**
   - success: 0, `completed`;
   - `exit 42`: 1, `failed`, `stop_reason.reason: node_error`;
   - `approval:` and `wait: { attention }`: **0**, `paused`;
   - `docker stop`: the trap forwards TERM, and bun marks the run `failed`, `stop_reason {reason: process_terminated, signal: SIGTERM}`, then exits 1. The outputs are still written, well inside the 10 s grace.

   A stopped run's transcript has no closing `workflow_error` row, and its `terminal_record` leaves the interrupted node `running`.
   - **Ruling for Plan 02:** matches the plan (Task 7: map `paused` to failed; `stop` finalizes as stopped). Task 8's `watch` must end on the container's exit, not on a closing transcript row.
6. **The read-backs exist, even for a bash-only run:**
   - `workflow runs --json` gives `{runs: [one run], total: 1, scopeFallback: false}`;
   - `workflow get <id> --json --verbose` gives `status`, `metadata.ai_configuration.assistants.pi.enableExtensions` (`true` from the run layer), `metadata.run_config.keys` (`["assistants.pi.enableExtensions","workflows.autoResumeOnQuotaReset"]`), `transcript_path`, `terminal_record` and `nodes[]`.

   Without `--config`, `run_config` is null and `ai_configuration` reflects the repo's or the global config (`false` in control c1). That makes it a real read-back.
   - **Ruling for Plan 02:** matches the plan (Task 9's H-152 read-back, Task 7's `result.json`).
7. **The `--config` seal works on the tmpfs.** Archon created `/.archon/credential-key` (0600, 65 bytes) and stored `run_config.ciphertext`. No `TOKEN_ENCRYPTION_KEY` is needed.
   - **Ruling for Plan 02:** matches the plan.
8. **None of the repo's decoys take effect, and each guard is load-bearing.** The stripped clone has no `.pi/`, `.agents/` or `.archon/`, and its status is clean. The decoys stay in the index as skip-worktree entries, so a commit records only the worker's change, never their deletion.
   - The home workflow ran, not the decoy of the same file name.
   - The read-back is `enableExtensions: true`.
   - Planting `/.archon/.env` fails with `Read-only file system` (EROFS).
   - The controls show each guard matters:
     - without the strip, the repo's workflow wins and its config sets `enableExtensions: false` and injects `env:`;
     - `--config` pins `enableExtensions` back, but not the workflow override or the env;
     - started inside the clone, the CLI loads the repo's `.archon/.env` with override (`PI_OFFLINE=0`), and Bun runs the repo's `bunfig.toml` preload in the Archon process itself.
   - **Ruling for Plan 02:** matches the plan (design §6a items 1 and 2; Task 6's prelude tests, `cd /work never appears`, and Task 8's `decoy repo content changes nothing`).
9. **A worker's own `bun` runs the repo's `bunfig.toml` preload.** `bun hello.ts` in the clone wrote `preload ran in /work/repo`, under `BUN_OPTIONS=--no-install`, which stops installs, not preloads. Started from another directory, it didn't. The prelude never starts bun in the clone, and Pi's child process starts in `/app` (spike 08), so only the worker's own `bun` runs it, as the same uid.
   - **Ruling for Plan 02:** a new in-run residual for Task 10's threat model, beside design §6a item 5: a repo's `bunfig.toml` is input the repo controls for any `bun` the worker starts in the worktree. It can't escalate. The boundary stays the host-side checks on the bundle.
10. **The git env config holds for Archon's own git, and filters stay a residual.** With the 13 pairs, Archon's checkout observation ran the planted `filter.x.clean` (the worktree's `.gitattributes`), but no `core.fsmonitor` and no hook. Without them (`c-soft`), it ran the planted fsmonitor and `post-index-change`.
    - The worker's own git inherits the env config. A worker that drops it (`env -u GIT_CONFIG_COUNT`) runs its own plants, as itself.
    - `sparse-checkout set` turns on `extensions.worktreeconfig` in the clone's `.git/config`. That doesn't matter: env config outranks `config.worktree` for single-valued keys.
    - **Ruling for Plan 02:** matches the plan (Task 6's `ARCHON_ENV` git list, unchanged). The filter residual is Task 10's (design §6a item 13).
11. **`BUN_OPTIONS=--no-install` stops runtime installs in a bash node, with no registry request.** The same script with `BUN_OPTIONS` unset installed from the loopback registry, so the test discriminates. That unset is the worker-side residual.
    - **Ruling for Plan 02:** matches the plan (Task 6, design §6a item 5).
12. **A fresh volume needs the chown helper.** Its root is `root:root 0755`, so uid 1001 gets EACCES. The one-shot helper needs `--cap-add CHOWN` and nothing else; without it, EPERM.
    - **Ruling for Plan 02:** matches the plan (Task 7 Step 1, `start` step 4).
13. **The proxy needs `--alias` on the run's network.** `docker network connect --alias egress-archon <net> <proxy>` makes `egress-archon` resolve on an `--internal` network. A connect without it gives only the container's name, and an alias from another network doesn't carry over. Docker refuses `network rm` while an endpoint is attached (`has active endpoints`, exit 1), so `disconnect -f` has to come first.
    - **Ruling for Plan 02:** matches the plan (Task 7 `start` step 3; Task 6 `removeRuns` steps 2 and 3).
14. **The copy-out helper's tests are right, and the host side needs two more rules.** `[ -f "$f" ] && [ ! -L "$f" ]` refuses a symlink, a FIFO and a missing name; `[ -f ]` alone follows the symlink. Reading `cap+1` bytes catches an oversize file. A binary file round-trips byte for byte through the docker CLI's stdout. The copy is owned by the invoking user, since the CLI writes it.
    - The two rules: the mode comes from the umask (664 here), and a refused or missing name still leaves an empty file wherever stdout was redirected.
    - An unguarded read of a FIFO blocks, so the helper's timeout matters even with the test.
    - This ran on the operator's Docker, not rootless, but the CLI writes the file there too.
    - **Ruling for Plan 02:** Task 7 Step 3, `copyOut`: write each file through a temp file created 0600, and keep it only when the helper exits 0 and the size is at most the cap. Otherwise delete it and report the problem. Keep the per-helper timeout.
15. **`docker logs --follow` is the only live view.** It streams the container's stdout and stderr and returns 0 when the container exits; the container's own exit code comes from `docker wait`. Archon's progress lines go to stderr (`[<node>] Started/Completed/Failed`, `[workflow] Transcript: …`). The transcript itself lives in the `/.archon` tmpfs, which the host can't read while the run is live.
    - **Ruling for Plan 02:** Task 8, `hapi run watch`: follow `docker logs --follow` of the run container while it runs (stripping control sequences), then print the copied `transcript.jsonl` and result after finalize. Design §3.2's "follows a run's transcript from the host" changes to this.
16. **`-e NAME` keeps a value out of argv, but not out of the daemon.** `ps` shows only the name. The value is in the docker CLI's own `/proc/<pid>/environ` (readable by the same uid) and in `docker inspect`'s `Config.Env` (readable by anyone who can reach that Docker daemon). That is no worse than today's `env_file`. `docker run --env-file` keeps the quotes of a `NAME='value'` line literally, so it can't read the secrets file.
    - **Ruling for Plan 02:** matches the plan (Task 7: `parseEnvFile`, then `-e NAME`). Task 10's threat model notes that the container's config holds the zone's key values, as it does today.
17. **A profile-only service is built only when named.** `up --no-start --build` and a bare `compose build` both skip it; `compose build archon` builds it.
    - **Ruling for Plan 02:** matches the plan (Task 6, `up builds archon explicitly before up --no-start`).
18. **Docker's `--tmpfs` mounts are `noexec,nosuid,nodev` by default.** That covers `/tmp`, `$HOME`, `/.archon` and Pi's directory. A file there can't be run directly (exit 126), though `sh file` works. The volumes `/work` and `/out` allow exec. It also stops a planted hook under `/tmp` from running directly.
    - **Ruling for Plan 02:** matches the plan (Task 7's argv adds no `exec`, and `compose.test.ts` forbids it). Task 8's posture node records the mount flags. A worker tool that has to run something from `/tmp` or `$HOME` (a venv's scripts under `~/.cache/uv`, say) would fail; that wasn't run, and is registered for Plan 03's worker.
19. **The bundle has one head, `HEAD`.** A detached checkout plus `<sha>..HEAD` gives exactly one head named `HEAD`, and `git bundle list-heads` reads it in an empty directory with hardened flags. `git bundle verify` refuses outside a repository (`need a repository to verify a bundle`), because it needs the base commit.
    - **Ruling for Plan 02:** matches the plan (Task 7's bundle check uses `list-heads`). Verifying or fetching needs a repository that holds the base commit: Plan 03's harvester's job.
20. **`ARCHON_NODE_EXECUTION` reaches bash nodes too,** not only AI nodes. Its JSON is `{runId, path, invocation: {id, startedAt, loopPath, checkoutStart}, attempt: {id, startedAt, checkoutStart}}`. `WORKFLOW_ID` is the run id.
    - **Ruling for Plan 02:** see spike 08 finding 10 (Task 5's log fields, Task 7's join).

## Decision

The run container ships as Tasks 6 and 7 describe it: the prelude, the env list, the binds and the volumes, unchanged. Three rulings change later tasks:
- Task 6's check workflows may read `$NAME` directly;
- Task 7's copy-out writes 0600 temp files and keeps only good reads;
- Task 8's live view is `docker logs --follow`.

Two residuals go to the threat model: the repo's `bunfig.toml` preload for the worker's own `bun`, and git filter drivers.

## Consequences

- **Task 6:** `hapi-check-run` may use `$BUN_OPTIONS`/`$HOME`. `run.sh` stays as written.
- **Task 7:**
  - `copyOut` writes through a 0600 temp file and keeps a file only on success within the cap;
  - the transcript path comes from `result.json`;
  - `start` connects with `--alias`, and `removeRuns` disconnects before removing.
- **Task 8:**
  - `watch` follows `docker logs`, then prints the copied transcript;
  - the integration test tolerates the `base_branch_auto_detect_failed` warning, and a stopped run's transcript with no closing row.
- **Task 10 (threat model):**
  - the repo `bunfig.toml` preload (finding 9);
  - git filter drivers (finding 10);
  - `docker inspect` holding the zone's key values (finding 16);
  - `noexec` tmpfs as a posture fact (finding 18).
- **Register:** finding 18's worker-tool question for Plan 03.
