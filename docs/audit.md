# hapi audit

`mise run audit` (`hapi audit`) checks that what is deployed and running matches policy: the generated configs, the pins, the budget policy, the run container's definition, the running stack's settings, the secrets setup, and each repo's GitHub settings. It is spec §11.8's "worse controls" measure: Phase 0 is done when `mise run audit` passes (spec §15). The code is `src/audit/`; the tests are `tests/audit/`.

- [Running it](#running-it): as hapi, the flags, the output and exit codes.
- [pass, fail and skip](#pass-fail-and-skip), `--strict` and `--dev`.
- [The checks](#the-checks), one section each: what it verifies, why, its credential, how to fix a failure, what its skip means.
- [GitHub credentials](#github-credentials): which endpoint needs which permission, and which token the audit uses.
- [What the tool checks were checked against](#what-the-tool-checks-were-checked-against).
- [Not covered yet](#not-covered-yet).

## Running it

Run it **as hapi, in hapi's checkout**, where the stack runs: it reads hapi's deployed `build/`, hapi's rootless Docker, hapi's secrets config and hapi's `host.env`, none of which another user can read.

```bash
sudo -iu hapi
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/hapi-factory
mise run audit -- --strict --repo "$OWNER/hapi-factory" --github-token-file <file>
```

`<file>` holds the operator's own GitHub token, mode `0600`. A strict run needs it: GitHub shows a ruleset's bypass actors to the operator's token, but never to the Apps', which have no Administration permission, so without it the bypass parts of `github.rulesets` and `github.app-perms` skip, and `--strict` turns each skip into a fail ([GitHub credentials](#github-credentials)).

| Flag | What it does |
|---|---|
| `--repo owner/name` | A repo for the `github.*` and `repo.*` checks. Give it more than once for several repos. Without it, those checks skip. |
| `--strict` | Every skip becomes a fail, its detail starting `--strict: skipped:`. Use it for stage b and any scheduled audit, where a check that couldn't be made must not look fine. Until Plan 04 wires the live MCP fetch (H-101), `mcp.tool-hashes` is always a skip, so a strict run always has that one fail ([below](#mcptool-hashes); [stage b](runbooks/stack.md#5-the-audit)). |
| `--dev` | The dev-only downgrades (the dev bypass, the env-file secrets provider) are reported as a skip instead of a fail. For development only. |
| `--github-token-file path` | The operator's GitHub token, in a file only its owner can read (mode `0600`). It is read once and never printed, logged or put in a command line. Needed for the bypass-actor checks ([below](#github-credentials)). |
| `--build-dir dir` | Compare another deployed build/ instead of hapi's `~hapi/hapi-factory/build`. |
| `--policy dir` | The policy a fresh build is made from (default `policy/` of the checkout you run it in). |

It prints one line per check, then a summary:

```text
pass  generated.drift         /home/hapi/hapi-factory/build equals a fresh build of /home/hapi/hapi-factory/policy (roster anthropic, 18 files); 4 running containers were started from it (org.hapi.build-sha256)
skip  mcp.tool-hashes         the live tool surfaces can't be compared with the lock until Plan 04 wires the live fetch (`hapi mcp verify`, H-101); ...
skip  github.rulesets         no --repo given
...
hapi audit: 11 pass, 0 fail, 4 skip
```

**Exit codes:** `0` when no check fails, `1` when any check fails (after `--strict`), `2` on a usage error (an unknown flag, a missing value, a `--repo` that isn't `owner/name`, a flag given twice). A check that throws is a fail naming the error: the audit fails closed.

Every detail names files, keys, containers and env var names. None prints a secret, a token or a deployed value that differs from policy.

## pass, fail and skip

- **pass:** the check verified what it says.
- **fail:** it found a problem, or it hit an error.
- **skip:** it couldn't be made, and the detail says why: the stack isn't running, there is no `--repo`, there are no GitHub credentials, Docker isn't available, the image isn't built here. **A skip is never a pass.** `--strict` turns every skip into a fail.

Without the stack and without `--repo`, as on a development machine, most checks skip: run `mise run audit` there to see the pins checked, the MCP lock's offline checks made (`mcp.tool-hashes` still reports a skip, since the live comparison waits for H-101), and the rest skip with their reasons.

## The checks

| Check | Verifies | Spec | Needs |
|---|---|---|---|
| [`generated.drift`](#generateddrift) | The deployed build/ equals a fresh build of policy/, with no other file or directory in it, and every running container was started from it | §8.1, §11.8 | The deployed build/; Docker for the labels |
| [`runtime.run-container`](#runtimerun-container) | The run container's definition for each run kind (tmpfs, read-only binds, environment and proxy, label, prelude, no port), and each live run container against its own kind's, holding only its kind's zone's keys, on its own internal network with only its kind's proxy | §9.2, §9.3; design §3.5 | The checkout; Docker for live runs |
| [`runtime.run-disk`](#runtimerun-disk) | The run disk, where the runs' volumes live: there, a filesystem of its own, apart from Docker's data root, writable, and at most `runs.disk.gb` | design §3.1 (H-217) | Docker; the run disk |
| [`runtime.hermes-no-yolo`](#runtimehermes-no-yolo) | No yolo, approvals not off, and the Kanban dispatcher off, in Hermes's effective config | §9.1 | Docker, the stack up |
| [`runtime.dev-override`](#runtimedev-override) | The stack, and each live run, was started as hapi, without the dev bypass | §4.3, §11.3 | Docker, the stack up |
| [`runtime.poller-timer`](#runtimepoller-timer) | The poller's timer, `hapi-poll.timer`, is active in hapi's user manager | design §3.4 | hapi, the stack up |
| [`policy.budget-enforcement`](#policybudget-enforcement) | At least one enforcer of `run_usd` is hard | design §3.5 | policy/ |
| [`policy.repos`](#policyrepos) | Each repo `policy/repos.yaml` registers is covered by the hapi-planner and hapi-factory installations it records | design §3.2 step 9 | policy/; the App keys |
| [`policy.sidecars`](#policysidecars) | Every sidecar image `policy/sidecars.yaml` pins is in this Docker | design §3.3 | policy/; Docker |
| [`policy.decision-models`](#policydecision-models) | Never fails: a note says which decision models are off, or that the engine's decisions give notes only | design §3.6 | policy/ |
| [`pins.versions`](#pinsversions) | Every tool, image and installed package pinned exactly | §11.6 | The checkout |
| [`tools.archon-validate`](#toolsarchon-validate) | Archon's own validation of the deployed config and the workflow pack: no errors, no parse warnings, every alias and tier read as generated, `assistants.pi.enableExtensions` true | §9.2 | Docker, the Archon image |
| [`tools.hermes-validate`](#toolshermes-validate) | Hermes's own reading of the deployed config: every key known, every value read as written | §9.1 | Docker, the Hermes image |
| [`mcp.tool-hashes`](#mcptool-hashes) | The MCP lock, its read-only tools, and the servers the stack runs | §10.1 | policy/ |
| [`secrets.provider`](#secretsprovider) | The secrets provider (not the env-file downgrade), and for sops the recipients file and `recovery.age` | §11.5 | The secrets config |
| [`secrets.check`](#secretscheck) | Every secret `resolve` needs is found, none empty or invalid | §11.5 | The secrets config and store |
| [`github.rulesets`](#githubrulesets) | The four rulesets, per `--repo` | §5.1, §11.5 | `--repo`; a token ([below](#github-credentials)) |
| [`github.app-perms`](#githubapp-perms) | Neither App has administration, workflows or a bypass, per `--repo` | §11.5 | `--repo`; the App keys |
| [`github.repo-settings`](#githubrepo-settings) | A registered repo has the settings `hapi new-repo` gives it, per `--repo` | design §3.2 | `--repo`; the operator's token |
| [`github.labels`](#githublabels) | A registered repo has the five labels the factory reads, per `--repo` | design §3.2 | `--repo`; a token |
| [`repo.ai-workflows`](#repoai-workflows) | No workflow runs an AI agent with secrets on comment, issue or review triggers, per `--repo` | §7, §11.7 | `--repo`; a token |
| [`repo.private-untracked`](#repoprivate-untracked) | The checkout tracks nothing under `private/`, and its root `.gitignore` ignores `private/` | §11.5 (H-058) | The checkout (git) |

### generated.drift

**Verifies.** The deployed build/ (the one `hapi stack up` writes and the containers bind-mount: hapi's `~hapi/hapi-factory/build`, found from hapi's passwd entry; this checkout's `build/` when this shell sets `HAPI_ALLOW_CURRENT_USER=1`; or `--build-dir`) is exactly a fresh `buildAll` of `--policy`, for one of the three rosters (`up --roster` picks one; the detail names it): every generated file byte for byte, as a regular file (a symlink is a fail, and is never followed), and **no other path**, file or directory, anywhere under it. A run binds `build/pi`'s generated files and its whole `extensions/` directory, read-only, into Pi's agent dir (a tmpfs, `PI_CODING_AGENT_DIR`), so a planted extension there would be loaded by Pi even though every generated file matches, and a stray `auth.json` or other file beside them is one bind from being read. The audit lists the deployed build recursively and names each such path (a directory once, with a trailing `/`), never reading it. The fresh builds go into temp dirs the audit removes; the deployed build/ is never written. Then each running container's `org.hapi.build-sha256` label must be that build's digest (`buildDigest`, `src/stack/up.ts`), the label `up` sets and the launcher sets on a run container too: the stack's containers (Compose project `hapi`) and the run containers (labelled `org.hapi.run` and `org.hapi.project=hapi`) are both read. A run's smoke sidecar (as `runtime.run-container` tells one: named `<run>-sidecar`, labelled `org.hapi.kind=sidecar`) mounts nothing of build/ and carries no build label, so it is left to `runtime.run-container`, which holds it to `policy/sidecars.yaml`.

**Why.** The generators are deterministic ([docs/generated-configs.md](generated-configs.md)), so a difference is a hand edit, a stale build, or a policy change not yet deployed (spec §8.1; Review Focus 4: `approvals.mode: off` or `PI_OFFLINE=0` in a deployed file). Compose recreates a container whose config changed, not one whose bind-mounted file changed, so a container with another build's label may still run an older config.

**Credential.** None: local files, and `docker inspect` for the labels.

**Fix.** Never edit build/ by hand. Change policy/ in a PR, then `mise run up` rebuilds build/ and restarts what changed. The detail names each differing file and key (YAML, JSON, `archon.env`) or line (`squid.conf`), never the deployed value; "missing" means a generated file is gone. "not in a fresh build" is a path nothing generates: a planted file, or one a policy change left behind. `mise run up` never deletes a file (`buildAll` only writes, H-156), so remove each such path by hand, as hapi, then run the audit again. "not a regular file" or "not a directory" is a symlink (or other special file) where a generated file or directory belongs: remove it and `mise run up`.

**Skip.** No hapi user on this host (pass `--build-dir`), no deployed build yet (`mise run up` writes it), or a build/ you can't read (run the audit as hapi). With the stack down it still compares the files and says the labels weren't checked.

### runtime.run-container

**Verifies.** There is no long-lived archon container: a run is a fresh container the launcher makes from `stack/compose.yaml`'s profile-only `archon` service (`runArgs`, `src/run/spec.ts`), for its kind's profile (`kindProfile`, `src/run/kinds.ts`: a worker, a verify, a review or a fix; design §3.5, and [run kinds](runbooks/runs.md#run-kinds)). So the check has two parts.
- **The run definition of each kind, always, with no Docker.** `runArgs` for a sample run of each of the four kinds must:
  - give `/opt/hapi/pi-agent` a tmpfs with `size=64m,uid=1001,gid=1001,mode=0700`;
  - bind every host file its kind has read-only (`:ro`): Pi's `models.json`, `models-store.json`, `hapi-guard.json`, `settings.json` and `extensions/`, `/.archon/config.yaml`, `/.archon/.env` (empty: Archon loads it over the process environment at every start), the workflow pack at `/.archon/workflows/hapi` from the default pack dir (`archon/workflows/hapi`), `/opt/hapi/run-config.yaml`, the appuser's `.gitconfig`, its kind's prelude (`/opt/hapi/run.sh` for a worker or a fix, `verify.sh` for a verify, `review.sh` for a review), the run file at `/run/hapi/run.json`, the work order and its task text at `/run/hapi/order.json` and `/run/hapi/task.md`, the source repo at `/src/repo.git`, and, for a review or a fix, the inputs dir at `/run/hapi/inputs`: 15 files, or 16 for a review or a fix, plus any extra bind its kind's profile has. The live check holds a container to `runArgs`' own output, so this list is what catches a bind `runArgs` drops;
  - carry every value of `serviceEnvironment("archon")` (`src/stack/env.ts`: `ARCHON_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `PI_OFFLINE=1`, `PI_TELEMETRY=0`, `PI_CODING_AGENT_DIR=/opt/hapi/pi-agent`, `BUN_OPTIONS`, the git settings, `ARCHON_DOCKER=true` and the proxy variables), with a review's four proxy variables at `http://egress-review:3128`, the review zone's proxy, and every other kind's at `egress-archon`'s;
  - start with `--init=false`, so the prelude is PID 1 whatever the daemon's default;
  - label its container `org.hapi.kind=<kind>`, and run `sh` with its kind's prelude and, for a verify or a review, its kind's workflow (`factory-verify`, `factory-review`);
  - pass no secret to a verify, which holds no key; and the check gives `runArgs` the archon zone's names for a verify too, which it must refuse (`a verify run holds no key`), never bind;
  - publish no port; and carry the hardening flags: `--cap-drop ALL`, `--read-only`, `--security-opt no-new-privileges:true`, `--user 1001:1001`, a `--pids-limit` and a `--memory` limit, and `--stop-timeout 30`.

  A `runArgs` that throws is a fail with its reason: the service holds a key it doesn't translate, or lacks one of the hardening keys (`read_only: true`, `cap_drop` with `ALL`, `security_opt` with `no-new-privileges:true`, `pids_limit`, `mem_limit`). A failing definition is named by its kind (`review: nothing is bound at /run/hapi/inputs`).
- **Each live run container.** Any container labelled `org.hapi.run` and `org.hapi.project=hapi` that is running (found by those labels, never Compose's: the launcher blanks the three `com.docker.compose.*` labels the image carries) is read with `docker inspect` and held to **its own kind's** definition: the kind its `org.hapi.kind` label names, a worker's when it has none (a Plan 02 container), and a fail when the label names no run kind (`carries org.hapi.kind=<v>, which is no run kind`; a value that isn't plain is not shown). Against that definition (`liveProblems`, then `kindProblems`):
  - every tmpfs, with its options (Docker lists a `--tmpfs` only in `HostConfig.Tmpfs`), and no tmpfs the definition lacks;
  - every bind and volume: none missing, none unexpected, each bind read-only, and the pack mounted from the default pack dir. So a worker's container labelled `verify` fails (`/opt/hapi/run.sh` is mounted, `/opt/hapi/verify.sh` isn't), and so does a review's with no label (its inputs dir, and its proxy, aren't a worker's);
  - every value of its definition's environment, its proxy among them: a verify container whose proxy isn't `egress-archon`'s fails as `HTTPS_PROXY is not http://egress-archon:3128`; and no published port;
  - its command: `sh` with its kind's prelude, and a verify's or a review's workflow;
  - **its network** (`runNetworkProblems`): it is on exactly one network, its own, named as the container is (`HostConfig.NetworkMode`, `NetworkSettings.Networks`), and that network, read with `docker network inspect`, is internal, on a private subnet (`hapi run start`'s own `networkProblem`), and holds exactly its endpoints: the container (under its own id and name), its kind's proxy (`hapi-egress-archon-1`, or `hapi-egress-review-1` for a review), and its smoke sidecar (`hapi-run-<v>-sidecar`) when the run says it has one (`org.hapi.sidecar=<name>`, which the launcher sets on a run that starts one), matched by its name and, by its endpoint's id, a container of the run labelled `org.hapi.kind=sidecar`. A stopped sidecar has no endpoint, so none is expected for one. Another network, Docker's default bridge, an extra endpoint, the other zone's proxy, a sidecar the run doesn't say it has, a declared sidecar missing or not its sidecar, a network that isn't internal, or one Docker can't find, each fail. So does `org.hapi.sidecar` on a review, which has no sidecar, or naming a sidecar `policy/sidecars.yaml` doesn't list;
  - **the key rule**: any env name that some zone of `stack/secrets.yaml` holds is a key, and a container holds only its own kind's zone's (a worker's and a fix's the archon zone's, a review's the review zone's: the `hapi-factory` key under both its names, and CodeRabbit's). A verify holds none: `<NAME> is set: a verify container holds no key`; any other kind's stray key is `<NAME> is set: a <kind> container holds only its zone's keys`, so a worker holding `CODERABBIT_API_KEY` fails. The check names the variable, never its value. A name no zone holds isn't a key: the service's own environment (git's `GIT_CONFIG_KEY_<n>` pairs among it), `PATH`;
  - the hardening flags: the capabilities dropped, a read-only root filesystem, no-new-privileges, user `1001:1001`, the pids and memory limits;
  - the stop timeout of 30 s (`Config.StopTimeout`), and no init process at PID 1 (`HostConfig.Init` false, as `--init=false` sets it; unset would take the daemon's default, which may be `"init": true`): the prelude must be PID 1, since a verify's and a review's kill of what its workflow left runs only there.

  The detail names the container and each difference.
- **What each running container the run labels select is** (`classify`). With v its `org.hapi.run`:
  - **a run container** has a non-empty v and its run's name (`hapi-run-<v>`), and gets every check above, whatever other label it carries;
  - **a helper** carries `org.hapi.helper` set to `copyout`, `chown` or `clean`, the label the launcher's three one-shot helpers carry (the copy-out, `src/run/copyout.ts`, with a bare `org.hapi.run`; the volume chown, `src/run/lifecycle.ts`, and the run disk's cleanup, `src/run/disk.ts`, with their run's id). A helper caught mid-flight isn't held to a kind's definition, but to the helpers' invariants (`helperProblems`): `--network none` and no other network; no env name that any zone holds; `--rm` (`HostConfig.AutoRemove`); a read-only root; every capability dropped; and no capability added but `CHOWN`, which only the chown helper adds (Docker keeps it as `CAP_CHOWN`). It isn't counted as a run;
  - **a smoke sidecar** has a non-empty v, its run's sidecar's name (`hapi-run-<v>-sidecar`) and `org.hapi.kind=sidecar` (design §3.3, [the sidecar](runbooks/runs.md#the-smoke-sidecar)). It is held to its policy sidecar's definition (`sidecarProblems`). That sidecar is the one its run names (`org.hapi.sidecar` on its run's container, which must exist, running or not, and name one `policy/sidecars.yaml` lists), never one picked by its image, which two sidecars may share. Its image (`Config.Image`, as `docker run` was given it) must be that sidecar's pin, by digest (`runs <image>, which policy/sidecars.yaml doesn't list` for an image no sidecar pins; `runs <image>, not policy's <name> image <pin>` for another sidecar's), and it is held to `sidecarArgs` (`src/run/sidecar.ts`) for that sidecar, as a run container is to `runArgs`: its `/tmp` tmpfs, `/data` its one mount and read-only, `HOME` and `PORT`, no published port, a read-only root, every capability dropped and none added, not privileged, no-new-privileges, user `1001:1001`, and policy's pids and memory limits. It also runs policy's command in `/data`, holds no env name any zone holds (`<NAME> is set: a sidecar holds no key`), carries no non-blank Compose label and no helper label, and is on its run's network alone as `hapi-sidecar`. A sidecar isn't counted as a run;
  - **anything else** fails: `<name>: carries org.hapi.run=<v> but is neither its run's container (hapi-run-<v>), its run's sidecar (hapi-run-<v>-sidecar) nor a hapi helper`. So a labelled container under another name, on the default bridge, holding a key, can't pass by its name, and nor can one that only says it is a sidecar.
- **Each policy sidecar's definition, always, with no Docker.** `sidecarArgs` for each of `policy/sidecars.yaml`'s sidecars must run it read-only as `1001:1001` with every capability dropped and no-new-privileges, with policy's pids and memory limits, labelled `org.hapi.kind=sidecar`, its data its one bind and read-only at `/data`, policy's command, and no key, volume or published port. A failing one is named by the sidecar.

**Why.** These are the Global Constraints' Archon and Pi settings (spec §9.3: `PI_OFFLINE=1` is critical, and a worker must not rewrite its own model pins; design §6a items 2 and 3: a writable `/.archon/.env` would override the environment). Archon's server no longer runs in the stack, so nothing listens (H-197). And no container that holds a key runs the worker's code (design §3.5): the verify container, which runs the repo's checks, must hold no key, and the review container, which holds the review zone's, must run its read-only prelude and nothing of the repo's. A sidecar is on a run's network, so it must be the pinned image policy names, holding nothing a run could take from it.

**Credential.** None: the checkout, and `docker inspect`.

**Fix.** The run container is `stack/compose.yaml`'s `archon` service as `src/run/spec.ts` translates it for each kind's profile (`src/run/kinds.ts`): restore them, then `mise run up` builds the image. A live run that differs, or holds a key its kind's zone doesn't, was not made by the launcher as committed: `hapi run stop <id>`, then fix the cause.

**Skip.** Never: the definition needs only the checkout. With Docker unavailable, or no run live, the detail says no live run container was checked.

### runtime.run-disk

**Verifies.** The run disk at `/var/lib/hapi/rundisk`, where each run's `/work` and `/out` volumes have their dirs ([the runs runbook](runbooks/runs.md#the-run-disk)), as `hapi run start` checks it against `runs.disk` in `policy/runs.yaml`, with the same function (`diskProblem`, `src/run/disk.ts`), so a fail's detail is the launcher's own reason:
- it is there;
- it is a filesystem of its own: its device is not its parent's, `/var/lib/hapi`;
- it is not on the filesystem of Docker's data root, as `docker info --format '{{.DockerRootDir}}'` names it;
- the user running the audit can write it;
- it is at most `runs.disk.gb` GiB.

The pass detail gives its size against the cap, and the data root. A fail's detail ends with what that means for runs: under `runs.disk.enforcement: hard`, `hapi run start` refuses every run; under `soft`, it warns and starts every run anyway, without the cap. Either way the check fails.

**Why.** Without it a run's volumes have no size cap, and one run could fill hapi's Docker data root, which every run and the stack share (H-217, design §3.1). The operator ruled (2026-10-30) that Plan 03's poller starts no unattended run until the cap is in place.

**Credential.** None: `docker info`, and `stat` and `statfs` of the paths.

**Fix.** Make the run disk once, with sudo, as [the runs runbook](runbooks/runs.md#making-the-run-disk-the-operator-once-with-sudo) says. Its [troubleshooting](runbooks/runs.md#troubleshooting) gives the fix for each reason: not mounted, on Docker's disk, not hapi's, bigger than the cap. Run the audit as hapi, as documented: the data root and the write check are hapi's.

**Skip.** Docker isn't available: `docker info` fails or can't run, so the data root can't be read and the check can't be made.

### runtime.hermes-no-yolo

**Verifies.** Hermes's effective approval settings, from the running `hermes` container: no `--yolo` in its command line; no `HERMES_YOLO_MODE`, `HERMES_YOLO` or `HERMES_KANBAN_DISPATCH_IN_GATEWAY` set (to anything but empty, `0`, `false`, `no` or `off`) in its env; `HERMES_HOME` is `/opt/data`; and the config mounted read-only at `$HERMES_HOME/config.yaml` has `approvals.mode` not off, and no `cron_mode`, `unattended_mode` or `single_query_mode` that approves; and its `kanban` block has `dispatch_in_gateway: false`, `dispatch_profiles: []`, `auto_decompose: false` and `review_dispatch: false`, since Hermes's default dispatcher spawns a worker with full terminal access and no approval step for each ready card. The config is read as YAML 1.1, as Hermes reads it, where a bare `off` or `no` is `false`, which Hermes treats as `mode: off`.

**Why.** Spec §9.1: yolo and `approvals.mode: off` are forbidden by policy, and an audit check enforces it. The Kanban dispatcher would start workers no approval gates.

**Credential.** None: `docker inspect`, and the mounted config's file on the host.

**Fix.** Remove the flag or variable, and restore build/ with `mise run up`. It can come from a changed `stack/compose.yaml` (no secret may use a `HERMES_` name), but this check reads only the container's command line, its environment and the mounted `config.yaml`, never `$HERMES_HOME/.env` (`/opt/data/.env`, on the writable `hermes-data` volume), which Hermes v0.22.5 loads at startup over its environment. A `HERMES_YOLO_MODE` or `HERMES_KANBAN_DISPATCH_IN_GATEWAY` planted there passes this check (H-190), so if you suspect one, read that file's variable names too, never its values: it may hold `API_SERVER_KEY`, which the image's boot hook writes there.

**Skip.** The stack or hermes isn't running, Docker isn't available, or the mounted config can't be read (run the audit as hapi).

### runtime.dev-override

**Verifies.** The labels `hapi stack up` puts on every container, and the launcher on every run container and its smoke sidecar: `org.hapi.dev-override=0` and `org.hapi.started-by=hapi` on every running one, the stack's and each live run's and sidecar's (labelled `org.hapi.run` and `org.hapi.project=hapi`). A helper caught mid-flight (`org.hapi.helper`, as `runtime.run-container` tells one) carries neither label, and is that check's, so this one skips it; any other container labelled `org.hapi.run` is checked here too. `1` is the dev bypass (`HAPI_ALLOW_CURRENT_USER=1`); `unknown` or an empty value means a stack not started through `hapi stack up` (a raw `docker compose up`), never "no bypass". It also fails when this shell itself sets the bypass as a user other than hapi (`currentUserOverride`, `src/stack/up.ts`), since `mise run up` from it would run the stack as that user. It reads only the Docker of the user running the audit (`docker ps` on whatever daemon that user's CLI reaches). Run as hapi, as documented, it never sees a bypass stack on the operator's own Docker: it catches one only when it runs as the user who started it (H-193).

**Why.** The bypass is a dev-only downgrade: no dedicated user and no rootless Docker (spec §4.3, §11.3). It must never pass a normal audit.

**Credential.** None: `docker inspect`.

**Fix.** Stop the stack (`mise run down`) and start it with `mise run up` as hapi, without `HAPI_ALLOW_CURRENT_USER` ([the dev bypass](runbooks/stack.md#the-dev-bypass-hapi_allow_current_user1)).

**Skip.** The stack isn't running or Docker isn't available, and this shell sets no bypass. With `--dev`, a bypass is a skip saying what was found.

### runtime.poller-timer

**Verifies.** `systemctl --user show hapi-poll.timer --property=ActiveState`, in hapi's user manager, says `active`. It asks through `env` with `XDG_RUNTIME_DIR` (hapi's `/run/user/<uid>` when unset) and `DBUS_SESSION_BUS_ADDRESS` (its `bus` socket when unset), as `hapi stack up` does (`systemctlEnv`, `src/stack/up.ts`; spike 09, T20). Any other state (`inactive`, `failed`, …) fails, and so does an answer with no `ActiveState`. It checks, in order: the dev bypass, that the audit runs as hapi, that the stack is up, then the timer.

**Why.** Design §3.4: the poller is what starts a merged work order's runs, on its timer. With the stack up and the timer stopped, nothing fails and nothing runs: a merged work order waits with no word.

**Credential.** None: hapi's own user manager.

**Fix.** `mise run up`, as hapi: it links and starts the timer ([the stack runbook](runbooks/stack.md)). If it stops again, `journalctl --user -u hapi-poll.service -n 50` as hapi says why ([the engine runbook](runbooks/engine.md#the-poller)).

**Skip.** The audit runs under the dev bypass (`HAPI_ALLOW_CURRENT_USER=1`: `mise run up` installs no timer then), or as a user other than hapi (the timer is in hapi's user manager); the stack isn't running or Docker isn't available; or systemctl can't answer (the detail starts `cannot ask hapi's user manager:`, with its exit code and first line of error).

### policy.budget-enforcement

**Verifies.** In `policy/budgets.yaml`, `enforcement.hapi_guard` and `enforcement.archon` are not both `soft`: at least one enforcer of `run_usd` is `hard`, so something stops a run at its target instead of flagging it and letting it finish.

**Why.** Design §3.5: `run_usd` is a target, and a soft enforcer only reports. With both soft, a run can spend without limit. A repo overlay may harden a mode, never soften it, so only central policy can fail this. Archon bounds a run's nodes (`max_work_units`), never its dollars, so with `hapi_guard: soft` nothing stops a Pi run at `run_usd`, and the detail says so; whether that should fail is H-257.

**Credential.** None: policy/.

**Fix.** Set one of the two to `hard` in `policy/budgets.yaml`, in a PR; then `mise run up`.

**Skip.** Never.

### policy.repos

**Verifies**, for each repo `policy/repos.yaml` registers, with each App's own JWT: `GET /repos/{owner}/{repo}/installation` gives hapi-planner the installation id `installations.planner` records, and hapi-factory the one `installations.factory` records. A different id fails, naming the repo, the App and both ids; so does an App that isn't installed there (GitHub's 404), a suspended installation, or any other error GitHub gives. A registry with no repo passes, saying the poller acts on none. CodeRabbit's installation (`installations.coderabbit`) isn't checked: hapi holds no key for CodeRabbit's App.

**Why.** Design §3.2 step 9: the poller acts only on a registered repo, and the run engine's tokens (`forgeToken`, `src/forge/github/token.ts`) refuse to mint when hapi-factory's installation on the repo isn't the one the registry records. A wrong id means every tick of that repo fails closed; this finds it before a merge waits on it. It runs without `--repo`: the registry, not the command line, names the repos.

**Credential.** The App ids and keys from `$XDG_RUNTIME_DIR/hapi/env/host.env`, read as `hapi token mint` reads them; a JWT needs no permission, and nothing is minted.

**Fix.** Find each App's installation id (Settings → Applications → Installed GitHub Apps → Configure; the page's URL ends in `/settings/installations/<id>`) and correct `installations` in `policy/repos.yaml`, in a PR ([the GitHub Apps runbook](runbooks/github-apps.md)); or install the App on the repo, for selected repositories only.

**Skip.** A registered repo but no App key (`hapi secrets resolve` writes `host.env`). With one App's key missing and the other's installation matching, it skips, naming the App it couldn't ask.

### policy.sidecars

**Verifies.** For each sidecar `policy/sidecars.yaml` lists, `docker image inspect` finds its pinned image (`image`, a tag and a digest) in the Docker of the user running the audit. A missing image fails, naming the sidecar and the image; only Docker's own "No such image" counts as missing.

**Why.** Design §3.3: a run starts its smoke sidecar from the pinned image with `--pull never`, so a missing image refuses the run instead of fetching anything at run time. `mise run up` pulls each one (by digest), so a missing image means `up` hasn't run since the image was pinned.

**Credential.** None: `docker image inspect`.

**Fix.** `mise run up`, as hapi; it pulls every sidecar image, and fails if one can't be pulled.

**Skip.** Docker isn't available, or `docker image inspect` fails for another reason (the detail starts `cannot ask Docker:`).

### policy.decision-models

**Verifies.** Nothing that can fail. It reads `policy/gates.yaml` and `policy/flags.yaml` and passes with a detail that says which decision models are on or off: `decision models are on: …` when the engine's decisions (`gates.decisions.mode: enforce`), the bash gate and the result screen are all on, or a `note:` naming, in order, what is off (`gates.decisions.mode: off`, else each decision whose `by_name.<name>.mode` is `off`; then `bash_gate.enabled: false` and `result_screen.enabled: false`) and whether the engine's decisions give notes only (`gates.decisions.mode: notes`).

**Why.** Design §3.6 ("Decisions"): running without decision models is the operator's explicit choice ([Running without decision models](policy.md#running-without-decision-models)), never a fallthrough, and `loadPolicy` already refuses a gate or an engine decision that is on with no classifier. So there is nothing to fail; the note is there so a policy without decision models is never silent, in the audit beside the PR, the status comment and the run records.

**Credential.** None: policy/.

**Fix.** It never fails. To turn decision models back on, revert the change that turned them off ([the recipe](policy.md#running-without-decision-models)).

**Skip.** Never.

### pins.versions

**Verifies.** From the checkout's own files: every `[tools]` entry of `mise.toml` is an exact version (`MAJOR.MINOR.PATCH`, optionally with a suffix), never `latest`, a range or a prefix such as `3.14` (which mise reads as "the newest 3.14.x"); the checkout has no mise file besides the root `mise.toml` and the root `mise.lock` that locks it, tracked or not, each one named (`.mise.toml`, `mise.local.toml`, `.mise.local.toml`, `mise.<env>.toml`, `mise.<env>.local.toml`, `mise/`, `.mise/`, `mise-tasks/`, `.mise-tasks/`, `.config/mise.toml`, `.config/mise.local.toml`, `.config/mise/` with its `conf.d/` and tasks, `.tool-versions`, and the other lockfiles, `mise.local.lock` and `mise.<env>.lock`, which name the URL and checksum each tool is installed from), since mise loads each over `mise.toml` and this check reads only `mise.toml`: failing closed, any entry at the root or in `.config/` whose name starts with `mise` or `.mise` counts; every `stack/compose.yaml` service's `image:` is pinned by digest, except a service built here, which must have `pull_policy: build`; every Dockerfile `FROM` and `COPY --from=` image is pinned by digest (an earlier stage's name is fine); every package a Dockerfile `RUN` installs by name (`apt-get`, `apt`, `apk`, `pip`, `uv pip`, `uv tool`, `uv python`, `npm`, `bun`, `pnpm`, `yarn`, `go install`, and `mise install`, `mise use`, or `mise exec` and `mise x` with their tools before `--`, as `<tool>@<x.y.z>`; the command after `--` is read as a command of its own) names an exact version; every `ADD` of a URL or a git remote carries its SHA-256 (`--checksum=sha256:<64 hex digits>`), so the download built in is the one reviewed; and no `RUN` pipes a download into a shell (`curl … | sh`, `wget -qO- … | sudo bash` or `| sudo -u root bash`, through any stages such as `| gunzip |`; or `sh -c "$(curl …)"`, `bash <(curl …)`, `eval "$(wget …)"`), which installs whatever the URL serves that day. A `curl … | sh -c '…'` doesn't count (`-c` reads stdin as data), nor does a download piped into something other than a shell (an interpreter reading code on stdin, such as `| python3`, isn't counted yet: see [Not covered yet](#not-covered-yet)). The Dockerfile is read as Docker reads it: comment lines are dropped before `\` continuations are joined, and a `\` followed only by spaces or tabs still continues the line, so a `#` line inside a multi-line `RUN` is neither taken for package names nor ends the `RUN`.

How a `RUN` is read: BuildKit's leading flags (`--mount=…`, `--network=…`, `--security=…`) are stripped, and an exec form (`["sh", "-c", "…"]`) after them is read too. The command splits into segments at `&&`, `||`, `;`, `&`, `|`, `(`, `)`, backticks and newlines, and each segment is read from its first installer word followed by its install subcommand, wherever that stands. So no wrapper or keyword in front hides an install: `env` and its options, `sudo -E`, `nice -n 10`, `command`, `exec`, `nohup`, `time`, `then`, `else`, `do`, `!` and `{`. Nor do the installer's own options before its subcommand, a value as its own word included (`apt-get -o Acquire::Retries=3 install`, `pip --index-url URL install`, `npm --registry URL install`): the subcommand is the first word after the installer, not starting with `-`, that is one. Failing closed, an installer named as another command's argument (`echo apt-get install x`) counts as an install too. A quoted word with a space in it, such as the script of `sh -c '…'`, is read as commands as well.

**Why.** Spec §11.6 and the Global Constraints: pin every tool, image and plugin; never track `main` or `latest`.

**Credential.** None.

**Fix.** Remove a mise file other than `mise.toml`, moving what it needs into `mise.toml` (a personal tool, such as bws, goes in your global mise config: [docs/secrets.md](secrets.md#optional-bitwarden-secrets-manager-bws)). Pin it: an exact version in `mise.toml` (README, "Toolchain and pinning"), a tag and digest for an image ([docs/runbooks/stack.md](runbooks/stack.md#pinned-images)), `name=version` / `name==version` / `name@version` for a package. For a piped installer, download it to a file, check its SHA-256 (`echo "<sha256>  /tmp/x.sh" | sha256sum -c`), then run it; or install a pinned package, or `COPY --from=` a pinned image instead.

**Skip.** Never: it needs only the checkout.

### tools.archon-validate

**Verifies.** Archon's own reading of the deployed `archon/config.yaml` and Pi dir, and of the shipped workflow pack, in the image the stack runs:
- `archon validate workflows --json` reports no error and **no parse warning**. Archon only warns about a key it doesn't know (an `unknown key ... will be ignored` parse warning) and drops it, and exits 0, so the audit treats a parse warning as a failure. Its other warnings are listed in the detail. **One error is accepted:** Archon 0.12.1 calls a custom alias in a home-scoped workflow "not portable for global workflows", though its runs resolve one from the run config like any other alias (Plan 03 Task 11's check, 2026-11-01). hapi's pack is home-scoped by design, and its factory nodes name `@implement` and `@review` so that each run's own config picks their model. So that error passes when validate's structured issue has `level: error`, `field: model`, the `nodeId` of a pack node whose `model` is that alias, and exactly Archon's message for that node and alias, and the alias is one the generated config defines; and the accepted issues must be the pack's alias nodes one to one, so an Archon that stops reporting the lint fails too (re-check H-261 at every Archon upgrade). The detail counts them (`accepted: 3 custom-alias lints`). validate then exits 1, which passes only when every error it reported was accepted.
- `archon ai alias list --json` and `ai tier list --json` show every generated alias and tier with its `effective` binding equal to the generated one: the `@<role>-retry` names, the bare claude-provider model ids and the `{provider, model, effort}` syntax are read as generated (H-030). A binding Archon refuses fails the whole run with Archon's error.
- **The `assistants` read-back (H-152).** Archon's own `loadConfig` (`/app/packages/core/src/config/config-loader.ts`), run with `bun -e` over the mounted config, prints `assistants.pi.enableExtensions`, and it must be `true`. hapi-guard is a Pi extension, and Archon 0.12.1 only defaults the setting on, so a config it didn't read as written (or one that dropped the key) would leave a run unguarded. A read-back of `false`, `undefined` or nothing fails.
- **The pack.** The shipped workflow pack (`archon/workflows/hapi`) is bound read-only at `/.archon/workflows/hapi`, where a run finds it, so `validate workflows` covers it. Each of its workflows must be named in the results (`results[].workflowName`): an image that stopped reading `/.archon/workflows/hapi` would validate none of it and still print no error, so a workflow it doesn't name is a fail. The audit also fails on any node of the pack with `pi.enableExtensions: false`, which would drop hapi-guard from that step. A missing pack is a fail.
- Each of the four commands (the three above and the read-back) exits 0, but for validate's 1 above. One that exits non-zero otherwise fails, named (`archon validate workflows --json exited 1`), even if what it printed reads as clean.

It runs `docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true` as the image's user, with only the deployed config, Pi dir and the pack mounted read-only, the archon settings of `serviceEnvironment` and no secret, in a scratch git repo inside the container (Archon needs one). The image is the one `mise run up` built (`hapi-factory/archon:0.12.1`), or else `stack/archon/Dockerfile`'s pinned `FROM` if that is here. It never pulls, and never touches the running stack.

**Why.** Spec §9.2: fail on parse warnings, since unknown keys are otherwise dropped silently. Review Focus 5: an upstream that ignores a generated key after an upgrade. Design §3.6 (H-152): the guard loads only if `enableExtensions` is on, in the config and in every node.

**Credential.** None: no network, no secret.

**Fix.** Fix the generator (`src/generate/archon.ts`) or the workflow, against the pinned Archon, then `mise run up`.

**Skip.** No deployed build, Docker isn't available, or neither image is here (`mise run up` builds it).

### tools.hermes-validate

**Verifies.** Hermes's own reading of the deployed `hermes/config.yaml`, with its own Python in the image the stack runs (`hapi-factory/hermes:v0.22.5`, or the Dockerfile's pinned `FROM`), offline and read-only like `tools.archon-validate`:
- every key of the deployed config is one Hermes knows: a key of its `DEFAULT_CONFIG`, or a reviewed key it reads outside it (`HERMES_KEYS_OUTSIDE_DEFAULTS` in `src/audit/checks/tools.ts`: today only `agent.reasoning_effort`, which `hermes_cli/cli_commands_mixin.py`, `hermes_cli/setup.py` and `tools/delegate_tool_config.py` read). An `mcp_servers` entry is held to the keys Hermes reads for a server (`HERMES_MCP_SERVER_KEYS`). Under a generated mapping whose Hermes default isn't a non-empty mapping, `DEFAULT_CONFIG` can't say which keys Hermes reads, so a reviewed list does (`HERMES_REVIEWED_BLOCKS`): `DEFAULT_CONFIG.model` is `""`, so under `model` only `model.default` and `model.provider` are allowed, read as `model_cfg.get("default")` and `.get("provider")` in the pinned source. Any other such mapping, with no reviewed list, fails with every key under it named;
- every value reads back through Hermes's `load_config` as the file says. That catches a YAML 1.1 reading (a bare `off` as `false`) and a value Hermes renames or normalizes. `load_config` deep-merges a partial block, such as an `auxiliary` slot that sets only `provider` and `model`, with Hermes's defaults;
- Hermes's `validate_config_structure` reports nothing.
The detail also gives the config's `_config_version` stamp: the generated config has none, which Hermes reads as 0 ("a never-stamped current-schema file", in its own words), and only `hermes update` or `hermes doctor --fix` would migrate it.

**Why.** Hermes never warns about a key it doesn't know, so a renamed or ignored safety key would read as enforced (spec §9.1; H-029; Review Focus 5).

**Credential.** None: no network, no secret.

**Fix.** Fix the generator (`src/generate/hermes.ts`) against the pinned tag. If Hermes reads a key the audit doesn't know, check the source at the tag and add it to the reviewed list with where it is read.

**Skip.** No deployed build, Docker isn't available, or neither image is here.

### mcp.tool-hashes

**Verifies.** From policy/ (`loadPolicy`, so a server listing the archon zone is refused first):
- the lock `policy/mcp.lock.json` loads: its schema, and every hash matches its stored surface, so a hand edit shows;
- no lock entry is orphaned;
- for each server pinned at its current pin, every allowlisted tool (`tools.include`) is in the locked surface with `readOnlyHint: true` (H-035);
- every server the stack runs (the zone services' enabled servers) has a lock entry for its pin.

Any of these failing is a fail. What it can't do yet is the comparison the check exists for: the live tool surfaces of the servers that run against the lock. That needs the live fetch Plan 04 wires (H-101), so until then, once the offline checks pass, the check is a **skip** that says so (H-026), whether or not a server runs. The audit reads which servers run from policy, not from the running stack; today policy runs none (the hermes zone enables Phoenix only with o11y on, archon never loads one, and the research container arrives in Plan 04), and the detail says that too.

Under `--strict` that skip is a fail, like any other. So until H-101 closes, a strict audit (stage b's last step) always has exactly this one fail, its detail starting `--strict: skipped: the live tool surfaces can't be compared with the lock until Plan 04`: [the stack runbook](runbooks/stack.md#5-the-audit) says how to read it. Any other `mcp.tool-hashes` fail is a real one.

**Why.** Spec §10.1, the rug-pull defense: `hapi audit` (`mcp.tool-hashes`) fails closed on drift.

**Credential.** None.

**Fix.** Remove an orphaned entry in the PR that removed its server; re-pin a server whose surface changed, through a planning PR (`new_skill_or_mcp`); never allowlist a tool that isn't read-only.

**Skip.** Always, once the offline checks pass, until Plan 04 wires the live fetch (H-101): the live surfaces can't be compared yet. The detail names the servers that run by policy (Phoenix, with o11y on), or says none does.

### secrets.provider

**Verifies.** The secrets config (`$HAPI_SECRETS_CONFIG` or `~/.config/hapi/secrets.yaml` of the user running the audit) and its files (`describeSecretsConfig`). The env-file provider is a downgrade (plaintext on disk) and fails. For sops, the store's recipients file and `recovery.age` beside it, as `hapi secrets check` reads them: drift between the recipients file and the store, a post-quantum/classic mix, a `recovery.age` that doesn't match its recorded SHA-256, no recovery recipient, or no `recovery.age` all fail.

**Why.** Spec §11.5: the env-file downgrade is explicit and audited (H-027); a store you can't recover, or one a key outside the recipients file can open, is a weaker control.

**Credential.** None: it reads files, never a value.

**Fix.** Move to sops + age ([docs/secrets.md](secrets.md#the-env-file-downgrade)); for a recipients problem, follow what `mise run secrets:check` says ([docs/secrets.md](secrets.md#keys-and-recovery)).

**Skip.** There is no secrets config (run the audit as the user the stack runs as). With `--dev`, the env-file downgrade is a skip.

### secrets.check

**Verifies.** What `hapi secrets resolve` would find, through the provider contract (`checkSecrets`): every env var of `stack/secrets.yaml` found in the store, none missing, empty or invalid (a value `resolve` would refuse), and every MCP secret reference mapped in the manifest (H-028). An entry whose name is on the manifest's `optional` list (CodeRabbit's key, H-167) that is missing or empty doesn't fail it: `resolve` leaves it out, and the detail names it (`1 optional one absent or empty (review/CODERABBIT_API_KEY), which resolve leaves out`); one that is invalid fails, as `resolve` refuses it. A provider that fails (sops can't decrypt, say) is a fail: the check never passes where `resolve` would fail. Values are read only to classify them, never printed.

**Why.** Spec §11.5: fail closed; nothing starts with a missing or empty secret.

**Credential.** The user's own secrets provider (for sops, this machine's age key), as `hapi secrets check` uses it.

**Fix.** Fill them in (`mise run secrets:edit`); `mise run secrets:check` lists each.

**Skip.** There is no secrets config.

### github.rulesets

**Verifies**, per `--repo`, from the repo (`GET /repos/{owner}/{repo}`), the effective rules on `main` (`GET .../rules/branches/main`) and every ruleset (`GET .../rulesets`, then each by id), held to [docs/runbooks/github-apps.md](runbooks/github-apps.md) as `tests/docs/rulesets.test.ts` holds the README's JSON (H-023):
- `main` is the default branch. `main-protect` and `main-review` follow the default branch (`~DEFAULT_BRANCH`) and `agent-branch-scope` exempts it, so `main`'s rules say what guards the default branch only while `main` is the default. A repo whose answer has no `default_branch` fails;
- `main` has a `pull_request` rule with `required_approving_review_count` ≥ 1, a `required_status_checks` rule with exactly one gate check from GitHub Actions (`integration_id` 15368), and no other required check, and `deletion` and `non_fast_forward` rules. The gate check is `ci / gates` (`CONTRACT_CHECK`: the aggregator job of a repo made from the contract, whose `hapi-gates.yml` job `ci` calls the gates) for a repo `policy/repos.yaml` registers, and `ci` for any other, hapi-factory's own included; the other one, or both, fails. A third-party reviewer's check, such as CodeRabbit's, is never required (spec §9.6): it would let an advisory reviewer block a merge, or stand in for a gate once green;
- `main-review` applies to `main`, with the `update` rule (Restrict updates), a `pull_request` rule with `require_code_owner_review: true` and `required_approving_review_count` ≥ 1 (a missing or non-numeric count fails: "is missing or below 1"), and exactly the Admin role's PR-only bypass (`actor_id` 5, `bypass_mode: pull_request`);
- `agent-branch-scope` and `tags-admin-only` exist and are `active`, with the runbook's target (`branch`, `tag`), refs and rules: `include` only `~ALL`; `agent-branch-scope` excludes `~DEFAULT_BRANCH`, `refs/heads/plan/**` and `refs/heads/factory/**`, plus `refs/heads/dependabot/**/*` if you added it for Dependabot, and nothing else, while `tags-admin-only` excludes nothing; the `creation`, `update` and `deletion` rules; and exactly the Admin role's bypass, always (`actor_id` 5, `bypass_mode: always`). Neither applies to `main`, so they are read by name (H-174);
- no ruleset holding `required_status_checks` has a bypass actor; no ruleset without bypass actors has `update`; no ruleset has an `Integration` (GitHub App) bypass actor, ours or a third party's such as CodeRabbit.

Rules in a ruleset in `evaluate` or `disabled` mode don't apply to `main`, so they don't count.

**Why.** Spec §5.1 and §11.5: every lane gets the same CI gates, and no App can merge or bypass. `main` is guarded by two rulesets, because one ruleset's owner bypass would also bypass `ci`. The other two keep the Apps to `plan/**` and `factory/**` and off tags (AC-8): an exclusion added to either would widen what the Apps may push. The Dependabot exclusion this check allows does too: with it, the Apps can push `dependabot/**` branches (H-174).

**Credential.** The operator's token (`--github-token-file`), or else a read-only App installation token ([below](#github-credentials)). GitHub returns `bypass_actors` to the operator's token, but not to an App's, which has no Administration permission, so with an App token the bypass checks can't be made.

**Fix.** Set the rulesets as the runbook does ([GitHub Apps runbook](runbooks/github-apps.md#the-rulesets)).

**Skip.** No `--repo`; no credentials; or the rules pass but GitHub returned no `bypass_actors` (pass `--github-token-file`).

### github.app-perms

**Verifies**, per `--repo`, with each App's own JWT: `GET /app` and `GET /repos/{owner}/{repo}/installation` list no `administration` or `workflows`, and no permission beyond the runbook's table ([the two Apps](runbooks/github-apps.md#the-two-apps)); the installation covers selected repositories only; and neither App (by its App id) is a bypass actor on any ruleset. A response with no `permissions` object (missing, or not an object), or a `GET /app` with no App id, fails: an App is never cleared on what GitHub didn't say.

**Why.** Spec §11.5: neither App can merge or bypass rulesets; no App ever gets Administration.

**Credential.** The App ids and keys from `$XDG_RUNTIME_DIR/hapi/env/host.env`, read as `hapi token mint` reads them; a JWT needs no permission. The bypass part needs the ruleset data `github.rulesets` reads.

**Fix.** Set each App's permissions exactly as the runbook says (then accept the new permissions on the installation), and remove the App from any ruleset's bypass list.

**Skip.** No `--repo`; no App keys (`hapi secrets resolve` writes `host.env`); or the permissions pass but no ruleset's `bypass_actors` could be read because no credential can see them. A read of the rulesets that fails (an HTTP error, not a missing credential) is a fail, as in `github.rulesets`.

### github.repo-settings

**Verifies**, per `--repo` that `policy/repos.yaml` registers (matched ignoring case, as GitHub names are), the settings `hapi new-repo` gives it (`contractSettings`, src/forge/index.ts; [the runbook](runbooks/new-repo.md#the-eleven-steps), step 5), each read with a GET:
- the repo (`GET /repos/{owner}/{repo}`): `main` the default branch; merge commits allowed and squash, rebase and auto-merge not; head branches deleted on merge; `merge_commit_title: MERGE_MESSAGE` and `merge_commit_message: PR_TITLE`, GitHub's classic "Merge pull request #N from …" message, which the poller reads; `security_and_analysis`'s secret scanning and push protection `enabled`;
- `.../actions/permissions/workflow`: `default_workflow_permissions: read`, `can_approve_pull_request_reviews: false`;
- `.../actions/permissions`: Actions enabled, `allowed_actions: selected`, `sha_pinning_required: true`;
- `.../actions/permissions/selected-actions`: GitHub's own actions, no "verified creator" actions, and exactly the patterns `jdx/mise-action@*` and `<owner>/hapi-factory/.github/workflows/gates.yml@*`, in any order;
- `.../actions/permissions/fork-pr-contributor-approval`: `approval_policy: all_external_contributors`;
- `.../private-vulnerability-reporting`: `enabled: true`.

The detail names each setting that differs and its value. A repo that isn't registered passes: `<repo>: not registered in policy/repos.yaml, so the contract's settings don't apply` (hapi-factory's own settings are the README's, not the contract's).

**Why.** Design §3.2 step 5: merge commits keep each piece's commit and trailers on `main` as reviewed (spec §5.3, §13.2); a read-only token that can't approve, and only pinned, chosen actions, keep a PR's workflow from reaching beyond its job; push protection and private reporting keep secrets and vulnerability reports out of public view.

**Credential.** The operator's token, or new-repo's in-memory `gh` login ([below](#github-credentials)). GitHub returns `security_and_analysis` and the Actions settings only to a user who administers the repo, so an App token sees few of them.

**Fix.** Set them as `hapi new-repo` does ([the runbook](runbooks/new-repo.md#the-eleven-steps)), in the repo's Settings or with the same API calls.

**Skip.** No `--repo`; no credentials; or a setting GitHub didn't return to the credential, or a read it refused (403 or 404): `<repo>: <field> isn't visible with <credential>`. A setting that differs is a fail even when others are hidden.

### github.labels

**Verifies**, per `--repo` that `policy/repos.yaml` registers, that the repo has `lane:planning`, `lane:factory`, `lane:direct`, `hapi:rework` and `hapi:flagged` (`LABELS`, src/forge/index.ts), by name, ignoring case (`GET /repos/{owner}/{repo}/labels`). Colours and descriptions aren't checked. An unregistered repo passes, as in `github.repo-settings`.

**Why.** The poller reads the lanes and the operator's two signals from these labels; a label GitHub doesn't know can't be added.

**Credential.** The operator's token, new-repo's `gh` login, or an App token that can read labels.

**Fix.** Make the missing label (`gh label create <name> --repo <owner>/<name>`), or as `hapi new-repo` does.

**Skip.** No `--repo`; no credentials; or GitHub refused the list to the credential (403 or 404).

### repo.ai-workflows

**Verifies**, per `--repo`: no `.github/workflows/*.yml` or `*.yaml` runs an AI agent with a credential on `issue_comment`, `issues`, `discussion`, `discussion_comment`, `pull_request_review`, `pull_request_review_comment` or `pull_request_target`. An AI agent is a known AI action (`anthropics/claude-code-action`, `anthropics/claude-code-base-action`, `openai/codex-action`, `google-github-actions/run-gemini-cli`, `google-gemini/gemini-cli-action`, `actions/ai-inference`) or an AI CLI in a `run:` step (`claude`, `@anthropic-ai/claude-code`, `codex`, `gemini`, `aider`, `opencode`). A credential, in the agent's job, is any of:
- **an expression that reads a secret or the job's token**, anywhere in the job (any field of any step, so a secret written inline in a `run:` line, such as `run: ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }} claude -p "$BODY"`, counts; the job's `env` and other fields) or in the workflow's `env`. That is any `${{ … }}` expression that names `secrets.NAME` or `secrets['NAME']` (also inside a larger expression, as in `${{ secrets.ANTHROPIC_API_KEY || '' }}`), `secrets` by a computed name, or `secrets` as a whole (as in `${{ toJSON(secrets) }}`, every secret); or `github.token`, `github['token']`, or the `github` context as a whole (`${{ toJSON(github) }}` holds the token). Names are matched without regard to case, as GitHub reads them; a word inside a quoted string (`contains(github.event.comment.body, 'secrets')`) or another context's field (`steps.secrets.outputs.x`) is only text.
- **a write grant in the job's GITHUB_TOKEN permissions:** `permissions: write-all` (which includes `id-token: write`, so every step of the job can mint an OIDC token, as an OIDC-authenticated AI action does), or any scope at `write`, `id-token: write` included. The job's own `permissions` replace the workflow's, as GitHub applies them; `read-all`, `{}` and read scopes grant none.
- **an `actions/checkout` step without `persist-credentials: false`:** by default it writes the job's GITHUB_TOKEN into `.git/config`, where the agent can read it, with no expression in sight.

The whole job counts, not just the agent's step, because a job's steps share one runner: an earlier step can export a secret to `$GITHUB_ENV` for the agent, and the agent can rewrite what a later step runs with its secret. The detail names the action or the CLI and each credential, never the rest of a `run:` line. A workflow that doesn't parse fails, since it can't be cleared. The tests use a copy of the mtg repo's comment-triggered `claude.yml` (H-036); no test reads another repo.

**Why.** Spec §7 and §11.7: the onboarding PR removes or hardens any workflow that runs an AI agent with secrets on PR, issue or comment triggers (the "Comment and Control" class), and `mise run audit` fails until that's done. Anyone who can comment can steer such an agent.

**Credential.** The operator's token, or a read-only App installation token (Contents read).

**Fix.** Remove the workflow, or move the agent to a trigger that gets no secrets (`pull_request`, where a fork's PR runs without them). If it must stay on its trigger, give its job nothing: no secret, `permissions:` with read scopes only (or `{}`), and `persist-credentials: false` on any checkout.

**Skip.** No `--repo` or no credentials.

### repo.private-untracked

**Verifies** the checkout the audit runs in, not a `--repo`:
- nothing under `private/` is tracked, in any case (`git ls-files -- ':(icase)private'`), so a `Private/` counts too, and so does a nested repo added as a gitlink;
- nothing under it is a file `git add -A` would stage (`git ls-files --others --exclude-per-directory=.gitignore`, so only the `.gitignore` files a clone gets count). This catches a partial ignore, such as `private/*` then `!private/keep`, and `private/` itself as an embedded repo when it isn't ignored. A negation that matches no file yet passes until such a file exists;
- the checkout's own root `.gitignore` ignores `private/`: `git check-ignore --no-index -q` says it is ignored, and `-v` names the line that does it, which must be a non-negated line of the root `.gitignore`. A `.git/info/exclude` or a global excludes file doesn't count, since a clone doesn't get it.

git runs on the audit's root with `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and `GIT_COMMON_DIR` unset, so your shell can't point it at another repo, and with fsmonitor off. The root must be the checkout's top level (`mise run audit` runs there).

**Why.** `private/` is your own repo: the research, the secrets store and personal notes ([README, Publishing](../README.md#publishing-after-task-7b-the-remotes-the-rulesets-and-the-apps)). hapi-factory is public, so one `git add -A` that picked it up would publish it (H-058). The store is encrypted; the research and notes aren't.

**Credential.** None: local git only.

**Fix.** `git rm -r --cached private` and commit. If that commit was pushed, removing the files isn't enough: they stay in the history until it is rewritten (the method of Task 7b Step 7). Add a `private/` line to the root `.gitignore` if it is missing.

**Skip.** Never. No checkout, or git failing, is a fail.

## GitHub credentials

Every GitHub check reads repo state with GET requests only. The audit's own App token is the one exception: it is minted (one POST, for one repo, `contents: read` and `metadata: read` only) and revoked when the audit ends (one DELETE). **Ruling (R2, the controller, Task 6 security fix pass):** that POST and that DELETE are accepted under amendment set 2's ruling 5 (GitHub auth: least privilege, read only); every read of the repo's rules, rulesets, App settings and workflow files stays a GET.

| Endpoint | Permission it needs | Source |
|---|---|---|
| `GET /repos/{owner}/{repo}/rules/branches/main` | Metadata: read | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps), "Repository permissions for Metadata" (checked 2026-10-27) |
| `GET /repos/{owner}/{repo}/rulesets`, `.../rulesets/{id}` | Metadata: read; but `bypass_actors` "is only returned if the user making the API request has write access to the ruleset". A fine-grained token with Administration read-only, its user the repo's admin, got them (stage b, 2026-10-28, H-150) | The same page; [Get a repository ruleset](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset) |
| `GET /repos/{owner}/{repo}/contents/{path}` | Contents: read | Permissions required for GitHub Apps, "Repository permissions for Contents" |
| `GET /app`, `GET /repos/{owner}/{repo}/installation` | None: "You must use a JWT to access this endpoint"; each response holds the App's or installation's `permissions` | [REST API endpoints for GitHub Apps](https://docs.github.com/en/rest/apps/apps) (checked 2026-10-27) |
| `GET /repos/{owner}/{repo}/actions/permissions`, `.../workflow`, `.../selected-actions`, `.../fork-pr-contributor-approval` | The `repo` scope for an OAuth or classic token; the repo's administration for anyone else | [GitHub Actions permissions](https://docs.github.com/en/rest/actions/permissions) (checked 2026-11-01) |
| `GET /repos/{owner}/{repo}/private-vulnerability-reporting` | The repo's administration | [Repositories](https://docs.github.com/en/rest/repos/repos#check-if-private-vulnerability-reporting-is-enabled-for-a-repository) (checked 2026-11-01) |
| `GET /repos/{owner}/{repo}/labels` | Issues or pull requests: read | [Labels](https://docs.github.com/en/rest/issues/labels) |

Which credential each check uses:

- **`--github-token-file`, the operator's token,** for `github.rulesets` and `repo.ai-workflows`. Write access to a ruleset is repository Administration, which the Apps never get (spec §11.5; [the runbook](runbooks/github-apps.md#the-two-apps)), so this is the only way the bypass checks run. A fine-grained token scoped to the one repo, with Administration and Contents read-only (GitHub adds Metadata read-only), is enough. GitHub's docs say "write access to the ruleset", but in stage b (2026-10-28) GitHub returned `bypass_actors` to such a token, whose user is the repo's admin, and `github.rulesets` passed (H-150). So a token with Administration write isn't needed. Give it a short expiry, put it in the file without echoing it or putting it in argv (as hapi, in bash: `(umask 077; rm -f ~/.config/hapi/audit-token; IFS= read -rsp 'token: ' t && printf '%s\n' "$t" > ~/.config/hapi/audit-token)`, then paste it and press Enter; the `rm` makes the token go into a new file, which umask 077 makes 0600, since a `>` into a file that already exists keeps that file's mode), and delete the token and the file when the audit is done. The file must be a regular file only its owner can read (`chmod 600`); the token is never printed, logged or put in argv.
- **Else an App installation token,** minted for the one repo with `contents: read` and `metadata: read` only, from the App keys in `host.env`, the way `hapi token mint` gets them, and checked by `mintInstallationToken` (a broader token is refused and revoked). Metadata read covers the rules and rulesets endpoints and Contents read the workflow files, but not `bypass_actors`, so `github.rulesets` and `github.app-perms` skip their bypass part. The token stays in memory and is revoked when the audit ends.
  - **Which App.** `hapi-planner` first, then `hapi-factory`. An App whose keys aren't in `host.env` is passed over, and so is one whose keys load but which can't mint for this repo (it isn't installed there, its installation is suspended, GitHub refuses the request); its reason is kept. If neither mints, the GitHub checks fail with each App's reason (they skip, "no GitHub credentials", only when neither App's keys are there). A token GitHub returns broader than requested is a fail at once, naming the App: the audit never tries the other App after it. No reason holds a token.
  - **The revoke.** GitHub confirms a revoke with `204`. Any other answer, or a request that fails, prints one warning line on stderr naming the App, the repo and the HTTP status (or the error), never the token: `hapi audit: warning: GitHub didn't confirm revoking the read-only hapi-planner installation token the audit minted for $OWNER/hapi-factory (DELETE /installation/token: HTTP 500); it stays valid until <expires_at> ...`. The token then lasts until it expires, at most an hour (suspend the App's installation to end it sooner, [the runbook](runbooks/github-apps.md)). The warning doesn't change the results or the exit code.
- **`github.app-perms` always uses each App's JWT,** which needs no permission.
- **`hapi new-repo`'s verify step** passes the operator's `gh` login in memory (`githubToken` in the audit's context, which no flag sets), with only `github.rulesets`, `github.repo-settings`, `github.labels` and `repo.ai-workflows`. It wins over `--github-token-file` and is never printed. The login made the repo, so GitHub shows it every field ([the runbook](runbooks/new-repo.md#verify)).
- With neither, each GitHub check skips: "no GitHub credentials".

## What the tool checks were checked against

On 2026-10-27, against the pinned images (`ghcr.io/coleam00/archon:0.12.1@sha256:eea19d4d…`, `nousresearch/hermes-agent:v0.22.5@sha256:9c556157…`), run offline (`--network none`) on a fresh build:

- **Archon 0.12.1** validates its 24 bundled workflows with no issue, and reads every generated alias (`@implement-retry` and `@planner-retry` included, the claude-provider ones with bare model ids) and tier with its `effective` binding equal to the generated one (H-030). Its `tiers` and `aliases` are schema-checked strictly: an invalid `effort` fails every command with `Invalid model binding config`. An unknown key in a workflow is a parse warning (`Node 'a': unknown key 'bogus_node_key' will be ignored.`), and `validate` still exits 0. An unknown top-level key in `config.yaml` produces nothing at all (see [not covered yet](#not-covered-yet)).
- **Hermes v0.22.5** knows every generated key but `agent.reasoning_effort`, which it reads outside `DEFAULT_CONFIG`, and `model.default` and `model.provider`, held to a reviewed list since `DEFAULT_CONFIG.model` is a bare string (read in the pinned source on 2026-10-28); reads each value back as generated; deep-merges each partial `auxiliary` slot with its defaults; and reports no structure issue (H-029). Its source reads every `mcp_servers` key the generator writes: `trust` (`tools/mcp_tool_registration.py`), `elicitation.enabled` and `sampling.enabled` (`tools/mcp_tool_server_run.py`), `tools.include`, `tools.prompts` and `tools.resources` (`tools/mcp_tool_registration.py`). A YAML `mode: off` reaches Hermes as `false`, which it treats as `off`.

`tests/audit/fixtures/` holds the outputs the unit tests replay: Archon's `validate workflows --json` (clean, and with parse warnings) and Hermes's `DEFAULT_CONFIG`. After an upgrade, capture them again from the new images.

## Not covered yet

- **Spend limits** (spec §11.8 lists them with the audit): provider-side caps aren't read by any check (H-151).
- **Live MCP surfaces:** `mcp.tool-hashes` compares the lock with a running server's surface once Plan 04 wires the fetch (H-101).
- **Unknown top-level keys in Archon's config.yaml:** Archon 0.12.1 ignores them without a word, so `tools.archon-validate` can't see them; today the generated file holds `assistants`, `tiers` and `aliases`, of which Archon checks the last two strictly and the audit reads `assistants.pi.enableExtensions` back (H-152).
- **The audit in CI** (spec §11.8: "It runs in CI on hapi-factory"): `.github/workflows/ci.yml` is a protected path (H-154).
- **Reusable workflows and other triggers:** `repo.ai-workflows` doesn't follow a job that calls a reusable workflow, or flag `workflow_run` (H-155).
- **A job's default token:** a job with no `permissions` block, in a workflow with none, gets the repository's default GITHUB_TOKEN permissions (read and write under the permissive setting), which `repo.ai-workflows` doesn't read; such a job counts only through its expressions and its checkout. A read-only token (`read-all`, read scopes) doesn't count either, and neither does an action whose own `action.yml` defaults an input to `${{ github.token }}`, since the audit doesn't fetch the action (H-155).
- **`pins.versions` and the `RUN`s it can't read:** the body of a heredoc `RUN <<EOF`, which isn't read as the `RUN`'s command, so a package it installs isn't checked; and an installer that is downloaded to a file and run without a checksum (`curl -o i.sh … && sh i.sh`), which isn't a pipe into a shell; and a download piped into an interpreter that runs code from stdin (`| python3`, `| python3 -`, `| node`, `| perl`, `| ruby`), which isn't a shell (H-157).
- **Hermes's `.env`:** `runtime.hermes-no-yolo` doesn't read `$HERMES_HOME/.env`, which Hermes loads at startup, so a yolo variable planted there passes; Plan 04 mounts an empty read-only file over it and has the check require that mount (H-190).
- **A dev-bypass stack on another user's Docker:** `runtime.dev-override` reads only the auditing user's Docker, so the audit as hapi never sees a bypass stack on the operator's own Docker (H-193).
- **Active skill forks:** Plan 04 (H-109).
- **Template drift:** `hapi new-repo` writes `.factory/template.lock` (the hapi-factory commit and a sha256 per contract file), but no check reads it yet, so a repo whose contract files drifted from the lock isn't reported (H-238).
