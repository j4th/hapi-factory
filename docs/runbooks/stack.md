# Runbook: the stack

This runbook covers running the hapi-factory stack (spec §4.3, §9, §10, §11.3–11.5, §11.8):

- [what runs](#what-runs);
- [1. host setup](#1-host-setup), done once by the host admin with `sudo`;
- [2. the `hapi` user's toolchain](#2-the-hapi-users-toolchain);
- [3. the `hapi` user's secrets](#3-the-hapi-users-secrets), and [re-syncing after an edit](#re-syncing-after-you-edit-the-store);
- [4. `mise run up` and `mise run down`](#4-mise-run-up-and-mise-run-down), and [the dev bypass](#the-dev-bypass-hapi_allow_current_user1);
- [5. the audit](#5-the-audit), the last step of stage b;
- [the kill switches](#kill-switches);
- [the pinned images](#pinned-images) and [the hardening](#hardening);
- [troubleshooting](#troubleshooting);
- [what the tests prove](#what-the-tests-prove).

It runs in two stages:

- **Stage a (done in Plan 01 Task 5):** the files below were written, and the integration tests ran on the build host's rootful Docker as an ordinary user. That run covered the egress proxies and networks, plus Hermes and Archon started with fake secrets. No real secret was used, and `scripts/host-setup.sh` was not run.
- **Stage b (the operator; run on 2026-10-28, and again on any new host):** first the Slack app ([docs/runbooks/slack.md](slack.md)), with its three values in your store, and the GitHub Apps ([docs/runbooks/github-apps.md](github-apps.md)), with their four: `mise run up` refuses an empty secret. The Slack app's manifest needs no stack (a one-off `docker run` of the pinned Hermes image with no network); the Apps need the repo public with its rulesets. Then sections 1–4 on the real host, as the `hapi` user on rootless Docker, then `mise run test:int` there. It may run while the stack is up, because it never touches the running stack or the checkout's `build/` ([what the tests prove](#what-the-tests-prove)). Stage b ends with [the audit](#5-the-audit), as hapi, with the stack up: `mise run audit -- --strict --repo <owner>/<name> --github-token-file <file>` (until Plan 04, its one expected fail is `mcp.tool-hashes`: [how to read it](#5-the-audit)).

Every command marked *as hapi* runs in a shell of the `hapi` user (`sudo -iu hapi`). The other commands run as the operator, from the operator's own checkout.

## What runs

`stack/compose.yaml` holds five services in the Compose project `hapi`:

| Service | Zone | Network | Way out | What it is |
|---|---|---|---|---|
| `egress-hermes` | hermes | `hermes-net`, `outbound` | itself | Squid, on `build/egress/hermes.squid.conf`: HTTPS to the hermes allowlist only |
| `egress-archon` | archon | `archon-net`, `outbound` | itself | Squid, on `build/egress/archon.squid.conf`: HTTPS to the archon allowlist only, with no forge route |
| `egress-research` | research | `research-net`, `outbound` | itself | Squid, on `build/egress/research.squid.conf`: the open web, minus private ranges |
| `hermes` | hermes | `hermes-net` | `egress-hermes` | Hermes v0.22.5, the coordinator, running `gateway run` with `build/hermes/config.yaml` |
| `archon` | archon | none (each run gets a network of its own) | `egress-archon`, joined to the run's network | The run template, profile `run`: Archon 0.12.1, with Pi 1.3.0 in-process. `hapi stack up` builds its image and nothing starts it; `hapi run` (Plan 02 Task 7) makes a fresh container of it per run, with `build/archon/*` and `build/pi` bound in, and removes it after |

The research zone's own container, hapi-research, arrives in Plan 04. Task 5 ships its network, its proxy and its tests.

**`archon` is not a running service.** It is `profiles: ["run"]` and `restart: "no"`, with no volumes, no network, no `depends_on` and no health check. A run is one container of that definition: the launcher builds its `docker run` arguments from the service (its user, limits, `env_file` and `environment:`), adds the run's mounts and tmpfs, and puts it on a network of its own that it joins `egress-archon` to. Every object a run makes (the container, the network, the volumes) carries two labels, `org.hapi.run` and `org.hapi.project=<project>`. They are how `up` sees a live run and how `down` finds what to remove. `docker ps --filter label=org.hapi.run` lists the live runs.

- **The zone networks are `internal`.** A container on one has no route out and no external DNS: Docker's embedded resolver answers the stack's own names there, and `SERVFAIL` for every other, even one the host's own resolver answers locally (checked on Docker 29.9.2; the integration test checks it each run). Its only way out is its zone's proxy, through `HTTP_PROXY` and `HTTPS_PROXY` (in both cases) set to `http://egress-<zone>:3128`. Loopback goes direct (`NO_PROXY=localhost,127.0.0.1,::1`).
- **Only the proxies join `outbound`**, and they can't reach each other on it (`enable_icc=false`).
- **No service publishes a port.**
  - Archon has no server: a run's container runs one workflow with the Archon CLI and exits.
  - The Hermes gateway uses Slack Socket Mode, so it has no inbound endpoint. Its API listens on `127.0.0.1:8642` inside its container.
  - To reach Hermes, `docker compose -p hapi exec` into its container.
- **Secrets.** Each zone service's only `env_file` is its own zone's, `$XDG_RUNTIME_DIR/hapi/env/<zone>.env` ([docs/secrets.md](../secrets.md#the-env-files)). `host.env` holds the GitHub App keys and goes to no container.
- **hapi's own settings are in `environment:`**, which Compose puts above `env_file`: the proxy variables, Hermes's `HERMES_HOME`, and for Archon every setting of `build/archon/archon.env` (`ARCHON_ENV` in `src/generate/archon.ts`: telemetry off, Pi offline and its agent dir, Bun's `--no-install`, the git hardening, the Claude binary and `ARCHON_DOCKER`; [docs/generated-configs.md](../generated-configs.md#buildarchonarchonenv)). So no secret can override one, and the secrets manifest may not name one at all ([docs/secrets.md](../secrets.md#the-manifest-stacksecretsyaml)). `src/stack/env.ts` is the list; a unit test checks `stack/compose.yaml` against it.
- **State** lives in one named volume, `hermes-data`: Hermes's home (sessions, memories, skills). `mise run down` keeps it. A run's state (its clone, its output, Archon's home, Pi's sessions) lives in the run's own tmpfs and labelled volumes, which `hapi run` removes when it is done and `down` removes if it wasn't.

  **Once, when you first start the stack with Plan 02** (as hapi, after `mise run down`): the long-lived Archon's two volumes are left over, and nothing reads them. Remove them:

  ```bash
  # in a shell of the hapi user (sudo -iu hapi), with the stack down
  docker volume rm \
    hapi_archon-data \
    hapi_archon-home
  ```

  They hold the old Archon's run DB and Claude Code state, nothing the factory keeps. `docker volume rm` removes the ones it can and says `No such volume` for any that is already gone.

## 1. Host setup

The host admin does this once, with `sudo`. No agent ever runs it.

```bash
sudo scripts/host-setup.sh [source]
```

`source` is where the `hapi` user's checkout is cloned from. It defaults to your checkout's `origin` remote. Until hapi-factory is pushed (Plan 01 Task 7b), there is no remote, so pass your checkout's path: `sudo scripts/host-setup.sh "$PWD"`. A local path is copied, never hardlinked. Once the GitHub remote exists, point hapi's checkout at it, as hapi: `git -C ~/hapi-factory remote set-url origin <url>`. A URL is cloned by hapi itself, so with hapi's credentials, not yours or root's: if your `origin` is an SSH URL, pass the HTTPS one (`sudo scripts/host-setup.sh https://github.com/<owner>/hapi-factory.git`).

The script runs with `set -euo pipefail` and refuses to run without root. Each step is skipped when it is already done, so a second run changes nothing. The steps:

1. **Creates the user `hapi`.** It gets 1,048,576 subordinate UIDs and GIDs. Canonical's Squid rock owns files with uid 584792, which is beyond useradd's default 65,536, and rootless Docker can't unpack an image with an ID it can't map. On every run, and for a `hapi` an earlier run or you made, the script then stops if `hapi` can become root: if it is in `docker` (root on a rootful host), `sudo`, `admin` or `wheel` (sudo's usual groups), `lxd` or `incus-admin` (their daemons run privileged containers), `libvirt` (it starts VMs with any host disk) or `disk` (raw block devices), naming each group and the `gpasswd -d` that removes it; or if `sudo -n -l -U hapi` lists any rule for it. If it can't read sudo's answer (it matches classic sudo's English wording, with `LC_ALL=C`), it stops too and asks you to check by hand. hapi runs the agents, so it is less trusted than root: a container escape lands as hapi.
2. **Installs the rootless Docker prerequisites** if they are missing, with apt: `uidmap`, `docker-ce-rootless-extras` and `dbus-user-session`.
3. **Turns on lingering** (`loginctl enable-linger hapi`). hapi's systemd user manager, its `/run/user/<uid>` (its `XDG_RUNTIME_DIR`) and its Docker then keep running without a login, and across reboots.
4. **Sets up rootless Docker for hapi** (`dockerd-rootless-setuptool.sh install`) as a user service, and checks that `docker info` says `rootless`.
5. **Installs mise for hapi.** It downloads the release that `mise.toml`'s `min_version` names into root's own temp file and checks it against a SHA-256 pinned in the script. Nothing is piped to a shell. Then hapi installs it: a process running as hapi reads it on stdin into `~/.local/bin` under a temp name, makes it executable, renames it into place, checks its version, and adds mise's activate line to its own `~/.bashrc`.
6. **Makes hapi's checkout,** `~hapi/hapi-factory`, in a directory hapi creates itself, so a path that already exists (a dangling symlink included) stops the script. A URL is cloned by hapi. A local path is cloned by root, `--no-local`, into root's own temp dir, then streamed to a `tar` running as hapi, which unpacks it; the temp dir is removed however the script ends.
7. **Prints the next steps**, which are sections 2 and 3 below.

**Check it.** The output must contain `rootless`:

```bash
sudo -iu hapi docker info --format '{{.SecurityOptions}}'
```

## 2. The hapi user's toolchain

As hapi, trust and install its checkout's toolchain. The secrets commands use the age that mise pins (at least 1.3.2: `mise where age`, from the checkout). Without it, `resolve` refuses to run, and `up` stops before anything starts.

```bash
sudo -iu hapi
export XDG_RUNTIME_DIR=/run/user/$(id -u)     # sudo clears it; lingering keeps the directory
cd ~/hapi-factory && mise trust && mise install && mise run setup
```

**Export `XDG_RUNTIME_DIR` in every hapi shell** before any `secrets:*` command. Secrets are written only under `$XDG_RUNTIME_DIR/hapi/`, and the store's lock lives in `$XDG_RUNTIME_DIR/hapi/locks/`. Each secrets command refuses to run without a `0700` runtime dir of its own. (`mise run up` sets it for itself when it re-execs.)

## 3. The hapi user's secrets

The `hapi` user is another user, so it gets its **own** age key to the store, never a copy of yours ([docs/secrets.md](../secrets.md#keys-and-recovery)).

1. **Give hapi a copy of the store**, as yourself (not root), from your checkout. The store, its recipients file and `recovery.age` live in your `private/`:

   ```bash
   scripts/copy-secrets-to-hapi.sh
   ```

   It packs the three files with `tar` and pipes them to a `tar` running as hapi (`sudo -u hapi -H`, the one thing it asks sudo for), which makes `~/.config/hapi` (mode `0700`) and writes them there (mode `0600`). Root never writes into hapi's home ([why](#hardening)), so there is no `sudo install` step.

2. **Make hapi's key**, as hapi (with `XDG_RUNTIME_DIR` exported):

   ```bash
   cd ~/hapi-factory
   mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name hapi
   ```

   It writes hapi's own age key and its config, `~/.config/hapi/secrets.yaml`. Then it prints the `add-machine` command to run.

3. **Add hapi's key to the store**, as the operator: run the printed command (`mise run secrets:add-machine -- --name hapi --recipient age1pq1...`). It re-keys the store and updates its recipients file, so commit and push `private/` as usual.

4. **Copy the updated store to hapi again** (`scripts/copy-secrets-to-hapi.sh`, as in step 1). Then, as hapi:

   ```bash
   mise run secrets:check     # every secret found, hapi among the recipients
   ```

### Re-syncing after you edit the store

You keep editing your own copy (`mise run secrets:edit` in `private/`). hapi's copy doesn't change on its own. After each edit, rotation or recipient change, copy all three files again, then restart the stack so it resolves the new values:

```bash
scripts/copy-secrets-to-hapi.sh
mise run up        # re-resolves, and recreates any container whose env file changed
```

The helper always copies the three files together. `secrets:check` refuses a recipients file that disagrees with the store, or a `recovery.age` other than the one it records.

## 4. mise run up and mise run down

```bash
mise run up                          # from any account: it runs as hapi
mise run up -- --roster budget       # Haiku 5.5 on every Archon tier (spec §12)
mise run up -- --config <file>       # a secrets config other than ~/.config/hapi/secrets.yaml
mise run down
```

**`mise run up`** is `hapi stack up [--roster budget|anthropic|portable] [--config file]`. It aborts at the first failure, and nothing starts unless the steps before Compose all pass. As hapi, it first refuses if any run is live (`docker ps --filter label=org.hapi.run`): recreating `egress-archon` would cut the run's egress. Stop them with `hapi run stop <id>`, or wait. Then:

1. **The user.** As any user but hapi, it re-execs `mise run up` as hapi, with your flags, in hapi's checkout:

   ```text
   sudo -u hapi -H -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; export PATH="$HOME/.local/bin:$PATH"; cd "$HOME/hapi-factory" && exec "$HOME/.local/bin/mise" run up -- "$@"' hapi-stack <your flags>
   ```

   The script is fixed text, and your flags follow it as arguments of their own (`"$@"`), so no shell parses them on the way to mise: a `$`, a backtick, a quote or a space in a `--config` path arrives as you typed it. mise then quotes them into its task's command line for its own shell; stage b checked that end to end (H-146(e), 2026-10-28). It is not `sudo -i`, whose login shell re-parses the command's words and expands a `$` (sudo(8)). The script sets what that shell used to give: `XDG_RUNTIME_DIR` when sudo has cleared it, hapi's `~/.local/bin` first on `PATH` (the secrets step runs `mise where age`), the checkout as the working directory, and mise by the path `scripts/host-setup.sh` installs it at.

   So it builds hapi's checkout's policy, not yours: pull there first (`git -C ~/hapi-factory pull`, as hapi). The user is the one the process runs as; `$USER` is not trusted.
2. **Policy build:** `buildAll` writes `build/` ([docs/generated-configs.md](../generated-configs.md)). A digest of `build/` becomes a label on every container (`org.hapi.build-sha256`). Compose recreates a container whose config changed, but not one whose bind-mounted file changed. With the label, a policy change still reaches the running proxies, Hermes and Archon.
3. **Secrets:** exactly `hapi secrets resolve`. It loads the local config, builds its provider, resolves every name into memory, then writes the zone env files as one set ([docs/secrets.md](../secrets.md#hapi-secrets-resolve)). A missing or empty secret, a provider failure or a missing pinned age stops it here, naming the secret or the fix.
4. **`docker compose build archon`, then `docker compose up --no-start --build`:** the first builds the run image by name, because Compose builds a profile-only service only when it is named (spike 07, finding 17). The second builds Hermes's image, and creates the networks and containers (not `archon`) without starting any.
5. **The network check:** each zone network must be internal, with every subnet inside the proxies' `zone_clients` ranges (10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10). If a check fails, or can't be made (`docker network inspect` exits non-zero, which the error reports with its exit code and stderr, or prints something unreadable), it removes what step 4 made (`docker compose -p hapi down`) and stops. Nothing is left started or created.
6. **`docker compose up -d --wait`:** starts the stack (the three proxies and Hermes), and waits up to 5 minutes for every health check to pass. If one fails, `up` fails and says where to look; the containers are left for you to inspect.

**`mise run down`** is `hapi stack down`. It removes the runs first (the run containers with `docker rm -f`, then `egress-archon`'s attachment to each run network, since Docker refuses to remove a network with an endpoint attached, then the run networks and volumes: only objects labelled `org.hapi.run` and `org.hapi.project=hapi`), then runs `docker compose -p hapi down`. If removing the runs fails, `compose down` still runs, and `down` then exits non-zero naming what is left. It goes by project name, so it needs no compose file, `build/` or `XDG_RUNTIME_DIR`. It does load the whole CLI (`bun run src/cli.ts`), so it needs a checkout that loads (`src/` parses, `node_modules` installed) and a working mise, yours and hapi's: a merge conflict in `src/`, or a pull that brought a new dependency without `mise run setup`, stops it before Compose runs. Then use [kill switch 3b](kill-switches.md#3b-without-a-checkout-or-mise), which needs neither. It keeps the volumes. As any other user, it re-execs as hapi, as `up` does.

To see the stack, as hapi: `docker compose -p hapi ps`, `docker compose -p hapi logs <service>`. To change the proxies' rules, change `policy/trusted_sources.yaml` and run `mise run up`. The configs set `pid_filename none`, so a reload is a restart, and the build label makes `up` restart them.

### The dev bypass: HAPI_ALLOW_CURRENT_USER=1

```bash
HAPI_ALLOW_CURRENT_USER=1 mise run up
```

With this set, `up` and `down` skip the re-exec and run the stack as **you**, on your own Docker. This is a **dev-only downgrade**: there is no dedicated user, and on a rootful host there is no rootless Docker. It exists for development and for the stage-a tests.

- `up` prints a warning. So does `down`: `hapi stack down: warning: HAPI_ALLOW_CURRENT_USER=1: stopping the dev-bypass stack (Compose project hapi) on the Docker daemon this shell's docker CLI reaches, through its DOCKER_HOST, DOCKER_CONTEXT or current context: normally <you>'s own, not hapi's. ...`. It stops whatever project `hapi` that daemon has, so it doesn't say for certain which stack that was. A shell that exported the bypass would otherwise stop nothing of hapi's, in silence, on the kill-switch path: stop hapi's stack with `mise run down` in a shell without `HAPI_ALLOW_CURRENT_USER`, or with [kill switch 3b](kill-switches.md#3b-without-a-checkout-or-mise).
- Every container is labelled `org.hapi.dev-override=1` and `org.hapi.started-by=<you>`. (`up` as hapi sets `0` and `hapi`; a stack started some other way, such as a raw `docker compose up`, says `unknown` for both.)
- `hapi audit` fails on it (`runtime.dev-override`): it reads those labels, and this shell's own setting through `currentUserOverride(env)` in `src/stack/up.ts`. `--dev` makes it a skip ([docs/audit.md](../audit.md#runtimedev-override)). But it reads only the Docker of the user who runs it: the documented audit runs as hapi, so it never sees a bypass stack on your own Docker. It catches one only when it runs as the user who started it (H-193). Stop a bypass stack when you're done with it.
- Only exactly `1` turns it on. It means nothing for the hapi user itself.

Never use it for the real stack.

## 5. The audit

The last step of stage b, and whenever you want to know the stack still matches policy: as hapi, in hapi's checkout, with the stack up and `XDG_RUNTIME_DIR` exported (so the GitHub checks can read the App keys from `host.env`):

```bash
mise run audit -- --strict --repo <owner>/<name> --github-token-file <file>
```

It checks that the deployed `build/` is what policy builds and that the containers were started from it, the budget policy, the run container's definition (and any live run's mounts and environment) and Hermes's approval settings in the running containers, that the stack was started by `hapi stack up` without the dev bypass, the pins, Archon's and Hermes's own reading of the deployed configs (offline, in the stack's own images), the MCP lock, the secrets setup, and the repo's rulesets, App permissions and AI workflows. `--strict` makes every check that couldn't be made fail. `--github-token-file <file>` is the operator's token, mode `0600`, and a strict run needs it: GitHub shows a ruleset's bypass actors to your token, but never to the Apps', which have no Administration permission, so without it the bypass parts of `github.rulesets` and `github.app-perms` skip, and `--strict` fails them. A fine-grained token for the one repo with Administration and Contents read-only is enough (stage b, H-150): put it in the file without echoing it, and delete the token and the file when you are done ([docs/audit.md](../audit.md#github-credentials)). Every check, its credential, its fix and its skip: [docs/audit.md](../audit.md).

**What stage b expects, until Plan 04.** `mcp.tool-hashes` checks the MCP lock offline, but comparing a running server's tool surface with the lock needs the live fetch Plan 04 wires (H-101). Until then it can only skip (H-026), so a strict run always has that one fail and exits 1. Stage b passes when that is the only fail and every other check passed. Show only what didn't pass:

```bash
mise run audit -- --strict --repo <owner>/<name> --github-token-file <file> | grep -v '^pass'
```

For one `--repo` it must print exactly two lines: the `mcp.tool-hashes` fail, its detail starting `--strict: skipped: the live tool surfaces can't be compared with the lock until Plan 04`, and the summary `hapi audit: 14 pass, 1 fail, 0 skip`. Any other line is a real failure: fix it and run the audit again. So is an `mcp.tool-hashes` fail whose detail doesn't start `--strict: skipped:` (a lock problem). When H-101 closes, the exception goes: stage b, and any scheduled strict audit, then expect exit 0 and `0 fail`.

## Kill switches

Spec §11.8's four kill switches, fastest first: disable or revoke the provider keys, suspend the GitHub App installations, stop the stack, and firewall-drop the `hapi` user. Each one's exact commands or UI path, what it stops and what it doesn't, how to confirm and undo it, and how fast it works, are in **[the kill-switch runbook](kill-switches.md)**. `mise run down` ([section 4](#4-mise-run-up-and-mise-run-down)) is switch 3; the runbook adds a fallback that needs no checkout or mise, and a hard stop of hapi's Docker.

## Pinned images

Every image is pinned by tag and digest (spec §11.6). The digests were read with `docker buildx imagetools inspect` on 2026-10-26.

| Image | Where | Tag | Digest | Image built |
|---|---|---|---|---|
| Squid (Canonical's rock; Squid 7.7 on Ubuntu 26.04 LTS) | `stack/compose.yaml`, the three proxies | `ubuntu/squid:7.2-26.04_edge` | `sha256:d11db6479501aa4618b3253f95a88b2547229e2d081726b6fb20dc75a98cc61b` | tag updated 2026-10-23 |
| Hermes Agent | `stack/hermes/Dockerfile` | `nousresearch/hermes-agent:v0.22.5` | `sha256:9c5561579f3ffdf333401797094ac3a743738d6c25d40f4331c7bf77b694238d` | 2026-10-23 |
| Archon | `stack/archon/Dockerfile` | `ghcr.io/coleam00/archon:0.12.1` | `sha256:eea19d4d79420de36ecd68695e6839d4d65cc7b4f7b25a55311bcf07027cf409` | 2026-10-17 |
| uv (copied into the Archon image) | `stack/archon/Dockerfile` | `ghcr.io/astral-sh/uv:0.13.5` | `sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff` | 2026-10-22 |
| Node (copied into the Archon image) | `stack/archon/Dockerfile` | `node:24.22.1-trixie-slim` | `sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea` | 2026-10-21 |
| curl (the integration tests' throwaway client) | `tests/stack/helpers.ts` | `curlimages/curl:8.23.0` | `sha256:11e64e28c5f58c8d93ee95fcf22ac055f48b0bc440e0ce7d8013bbb5ad6aa8ac` | 2026-10-20 |

A few notes on these images:

- **The Squid tag names the Ubuntu package line (7.2), but the binary reports Squid 7.7.** The `_edge` tags are the only ones Canonical publishes for 26.04.
- **The Archon image needs no `archon provider add pi`.** It runs Archon from source, where Pi is an in-process provider on the SDK Archon embeds. The build checks that this SDK is 1.3.0 (spec §9.3). The release binaries are the ones that need `provider add`.
- **The Archon image bakes in Node 24.22.1, uv 0.13.5 and Python 3.14.9,** the versions `mise.toml` pins, so a run needs no GitHub egress. uv installs Python and checks it against the checksum uv embeds. At run time, `UV_PYTHON_DOWNLOADS=never`.

**To upgrade an image:**

1. Read the new digest: `docker buildx imagetools inspect <name>:<tag>`.
2. Update the tag and the digest together, and update this table.
3. Check that the image was published at least 3 days ago (the release-age cooldown, spec §11.6).
4. Run `mise run test && mise run test:int`.

For Hermes and Archon, follow the version pins in the plan's Global Constraints, and re-check the generated keys ([docs/generated-configs.md](../generated-configs.md#when-an-upstream-key-changes)).

## Hardening

Every service has these settings (`x-hardening` in `stack/compose.yaml`):

- `cap_drop: [ALL]` and `no-new-privileges:true`;
- a non-root `user`;
- `pids_limit` and `mem_limit`;
- `read_only: true`;
- a health check and `restart: unless-stopped` (except the `archon` run template, which has neither: it is `restart: "no"`);
- size-capped json-file logs;
- no published ports.

Writable paths are size-capped tmpfs or named volumes.

Three more rules hold for the whole stack:

- **Root never acts on a path inside hapi's home.** hapi runs the agent stack, so it is less trusted than root, and it may have planted a symlink anywhere in its home (`~/.bashrc` pointing at `/etc/sudoers`, `~/.local/bin` at `/usr/local/bin`). Root writing, creating, chowning or chmodding a path there would follow it, and `scripts/host-setup.sh` is meant to be run again. So root never does: it hands bytes to a process running as hapi, `sudo -u hapi -H -- sh -c '<script>'` reading stdin, and the kernel checks hapi's own permissions, and a planted symlink reaches only what hapi could already write. `scripts/host-setup.sh` installs mise and makes the checkout that way. `scripts/copy-secrets-to-hapi.sh` hands over the secrets store the same way: it pipes a `tar` of the three files into `sudo -u hapi -H -- sh -c 'umask 077; cd ~ || exit 1; mkdir -p .config/hapi && chmod 0700 .config/hapi || exit 1; tar -C .config/hapi --no-same-owner --no-same-permissions -xf -'`. No doc tells you to `sudo install` or `chown` anything there. `tests/scripts/hapi-home.test.ts` checks the scripts and the docs for it.
- **A secret can't change a hardening setting.** Each zone service's settings are in its `environment:`, above its only `env_file` (the zone's secrets), and the manifest may not use their names ([what runs](#what-runs)). Nor may it use a name that changes how a process runs, loads code or trusts TLS (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, `SSL_CERT_FILE`, ...), which `environment:` doesn't set ([docs/secrets.md](../secrets.md#the-manifest-stacksecretsyaml)).
- **Hermes and Archon are only ever built, never pulled** (`pull_policy: build`), so even a raw `docker compose up` or `pull` never asks a registry for an image named `hapi-factory/*`.

| Service | User | Writable | Limits | Health check |
|---|---|---|---|---|
| `egress-*` | `584792` (the rock's `_daemon_`) | tmpfs `/var/spool/squid`, `/var/log/squid`, `/tmp` (16 MB each; Squid writes nothing to them: no cache dir, logs on stdout, no pid file) | 64 pids, 256 MB | Port 3128 accepts a connection (perl; the rock has no curl or bash) |
| `hermes` | `10000:10000` (the image's `hermes`) | volume `hermes-data` (`/opt/data`); tmpfs `/run`, `/tmp` | 1024 pids, 4 GB | `hermes gateway status` says `Gateway is running` (it exits 0 either way, so the output is read) |
| `archon` (a run container) | `1001:1001` (the image's `appuser`) | tmpfs `/tmp` in the compose service, and the launcher's per-run tmpfs and volumes (Plan 02 Task 7) | 2048 pids, 4 GB | none: a run is one process that exits (`restart: "no"`) |

**Exceptions:**

- **Hermes's `/run` tmpfs allows exec.** s6-overlay, the image's init, runs its programs from `/run`. Every other tmpfs is `noexec`, Docker's default.
- **Hermes starts as its own user, not as root.** Its s6-overlay accepts that UID and skips its root-only bootstrap (the UID remap and the volume chown). Two later boot steps, the config-schema migration and the dependency refresh, run through `s6-setuidgid`, which can't set groups without `CAP_SETGID`: each logs `s6-applyuidgid: fatal: unable to set supplementary group list`, then `docker_config_migrate.py failed` or `dependency refresh failed`, and Hermes continues. Neither step is needed, and the migration must never run on the generated config; H-179(g) skips it on purpose ([spike 05](../spikes/05-rootless-images.md)).
- **The `archon` service has no health check and does not restart.** It is the template of a run, not a service. Its tmpfs mounts are `noexec` like the others (Docker's default), so a script a worker puts in `/tmp` or `$HOME` can't be run directly (spike 07, finding 18).
- **Archon logs a warning that gh is not authenticated.** That is by design: the archon zone has no forge credential (spec §4.3).

Spike T12 re-checked these settings under rootless Docker on 2026-10-28 and relaxed none ([spike 05](../spikes/05-rootless-images.md)).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `required variable XDG_RUNTIME_DIR is missing a value` | You ran `docker compose` (not `mise run up`) in a shell without `XDG_RUNTIME_DIR`. Run `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. |
| `XDG_RUNTIME_DIR is not set` or `... does not exist` from `secrets:*` or `up` | The same, or lingering is off: run `loginctl show-user hapi -p Linger` (should say `yes`), then re-run `scripts/host-setup.sh`. |
| `` `mise where age` failed ... run `mise install` in the hapi-factory checkout `` | hapi's checkout isn't trusted or installed. As hapi: `cd ~/hapi-factory && mise trust && mise install`. |
| `cannot run mise (not on PATH, nor at ~/.local/bin/mise), which pins the age hapi uses` | `secrets:*` and `audit` look for `mise` on `PATH`, then at `$HOME/.local/bin/mise`, where `scripts/host-setup.sh` installs it for hapi (H-196). Neither has it: you are in a shell whose `HOME` isn't hapi's and `mise` isn't on `PATH`, or hapi's install is gone. As hapi, `~/.local/bin/mise --version`; if it is missing, install mise ([README.md](../../README.md)) and run `mise install` in the checkout. |
| `hermes/SLACK_BOT_TOKEN (...) is empty` | Every secret in `stack/secrets.yaml` must have a value before anything starts, the three Slack values included. Make the Slack app first ([docs/runbooks/slack.md](slack.md): its manifest comes from a one-off `docker run` of the pinned Hermes image), add its three values to your store, run `scripts/copy-secrets-to-hapi.sh`, then `mise run up`. |
| `host/HAPI_PLANNER_APP_ID (...) is empty` | The same rule: `up` resolves the `host` zone too, so the GitHub App values must be in your store, though no container gets them. Make the Apps first ([docs/runbooks/github-apps.md](github-apps.md): they need the repo public with its rulesets), add their four values, run `scripts/copy-secrets-to-hapi.sh`, then `mise run up`. |
| `docker network inspect hapi_hermes-net ... exited 1: ...` | `up` couldn't read the zone networks, so it removed what it had created. The rest of the message is Docker's own error: a daemon that isn't running (as hapi: `systemctl --user status docker`), or a network Compose didn't make. |
| `stack/secrets.yaml: /<zone>/<NAME>: <NAME> is reserved` | The manifest names an env var hapi sets in the containers itself (`HTTPS_PROXY`, `PI_OFFLINE`, `GIT_CONFIG_COUNT`, ...), or one that changes how a process runs, loads code or trusts TLS, by exact name (`PATH`, `SSL_CERT_FILE`, `GIT_SSH_COMMAND`, ...) or by prefix (`LD_`, `NODE_`, `PYTHON`, ...); the rest of the message names which rule. Give the secret another env name ([docs/secrets.md](../secrets.md#the-manifest-stacksecretsyaml)). |
| `host-setup: error: hapi could not clone <url>` | hapi clones a URL source with its own credentials. Pass the HTTPS URL, not an SSH one. |
| `host-setup: error: hapi's ~/hapi-factory exists but is not a git checkout` | Something is at that path already (a file, a directory, or a symlink, even a dangling one). As hapi, move it away, then run the script again. |
| `zone network hapi_<zone>-net has subnet ..., outside the proxies' zone_clients ranges` | This host's Docker `default-address-pools` hands out non-private ranges. Set the pools to private ranges (hapi's `~/.config/docker/daemon.json` under rootless Docker), restart its Docker, then run `mise run up`. |
| `zone network ... is not internal` | Someone edited `stack/compose.yaml`. Restore `internal: true`; `tests/stack/compose.test.ts` fails on this too. |
| Pulling `ubuntu/squid` fails with `lchown ...: invalid argument` (rootless) | hapi's subordinate ID range is narrower than uid 584792. Check `grep hapi /etc/subuid /etc/subgid` (each should be 1048576 wide), re-run `scripts/host-setup.sh`, then restart hapi's Docker. |
| `the stack did not come up healthy` | As hapi, run `docker compose -p hapi ps` and `docker compose -p hapi logs <service>`. A proxy that fails to start usually has a config error: run `mise run policy:build`, then check `build/egress/<zone>.squid.conf`. |
| A zone container can't reach a host | It isn't on the zone's allowlist ([docs/generated-configs.md](../generated-configs.md#buildegresssquidconf)). Look for `TCP_DENIED/403` in `docker compose -p hapi logs egress-<zone>`. Allowlists change by a policy PR; nothing bypasses the proxy. |
| A proxy is stopped or unhealthy | Its zone has no way out at all: requests fail, never bypass. Run `mise run up` to start it again. |

### Open items

- **Run on the real host in stage b (2026-10-28):** host setup and a re-run of it, rootless Docker 29.9.2, the subordinate ID range, lingering, the store handed to hapi, `up`'s re-exec through the host's real sudo, the whole stack under hapi, `mise run test:int` as hapi, kill switch 4, and the strict audit against the real GitHub repo. Spike T12 ran alongside it ([spike 05](../spikes/05-rootless-images.md)).
- **Not yet run there:** the kill switches' other stage-b marks (H-160, [the runbook](kill-switches.md)), and host setup for a `hapi` user that existed before it, whose added subordinate range rootlesskit may not map (H-188).

## What the tests prove

`mise run test` runs the unit tests. They need no Docker, network or secrets.

| Test | What it proves |
|---|---|
| `tests/stack/compose.test.ts` | It reads `stack/compose.yaml` and the Dockerfiles. There are exactly five services. The zone networks are internal, and only the proxies join `outbound`. No ports are published. Every service has the full hardening set (no capabilities, no new privileges, non-root, limits, read-only, the labels, which default to `unknown`), and health checks and `restart: unless-stopped`, except `archon`, which is `profiles: ["run"]`, `restart: "no"` and has no health check. Every image, `FROM` and `COPY --from` is pinned by tag and digest, at Hermes v0.22.5 and Archon 0.12.1, and the two built images have `pull_policy: build`. Each zone service's only env file is its own zone's, never `host.env`. Its `environment:` is exactly `serviceEnvironment` (`src/stack/env.ts`), every name in it reserved, archon's holding every setting of the generated `archon.env`. Each gets proxy variables for its own proxy, and Hermes starts after its proxy is healthy. `archon` has no volumes, networks, ports, health check or `depends_on`, and the only named volume is `hermes-data`. |
| `tests/stack/up.test.ts` | The order of `up`: the live-run check, build, secrets, `compose build archon`, create, the network check, start. `up` refuses while a run is live, builds nothing then, and stops if it can't tell. `down` removes the run containers, disconnects `egress-archon` from each run network, removes the networks and volumes (only objects labelled with its project), then runs `compose down`, which still runs when a removal failed. The `hapi` re-exec runs `mise run hapi` with the same script. A failed secret, policy build or pinned-age lookup starts nothing (the last through the real `resolve` path). A non-internal or non-private zone network removes what was created, and so does a check that can't be made: a failed `docker network inspect` (its exit code and stderr in the error, never "does not exist"), output that isn't a JSON array, or a subnet the CIDR parser rejects. When that removal fails too, the error says so. The re-exec as hapi is `sudo -u hapi -H`, never `-i`. Its script is fixed text that holds none of the arguments. Run by `sh` (sudo left out), it hands `$b`, `$(touch x)`, backticks, quotes, spaces and a newline to a stand-in mise verbatim, one argv entry each, in hapi's checkout, with `XDG_RUNTIME_DIR` defaulted (or kept) and hapi's `~/.local/bin` first on `PATH`, and it runs nothing without the checkout. The exit code is passed on. The dev bypass warns and labels, and `down` under it warns that hapi's stack is untouched. `currentUserOverride` turns on only with exactly `1`. The build digest covers each generated file. `down` works by project name. Usage errors exit 2. |
| `tests/stack/cidr.test.ts` | The CIDR maths behind the network check and the `to_localnet` overlap check. |
| `tests/scripts/host-setup.test.ts` | It never runs the whole script. `bash -n` parses it, and shellcheck lints it when on PATH. It is in strict mode, and every step runs after the root check. Each step checks before it acts. The subordinate ID range covers uid 584792. The root-equivalence check, run on its own with a stub `id` and `sudo`, refuses each root-equivalent group and any sudo rule, naming them, passes a `hapi` with neither, and stops on a sudo answer it can't read. Docker is rootless and lingering is on. mise is pinned to `min_version`, checked by SHA-256, never piped to a shell, and reaches hapi on stdin, at `~/.local/bin/mise`, where `up`'s re-exec runs it. The checkout goes where `up` re-execs, made by hapi. The next steps are printed, with the secrets helper. |
| `tests/scripts/hapi-home.test.ts` | [Root never acts on hapi's home](#hardening). The root-side code of `host-setup.sh` and `copy-secrets-to-hapi.sh` (everything but the snippets they hand to hapi's `sh`) names no path in hapi's home and runs no `install`, `chown`, `chmod`, `mkdir`, `>>` or the like; every sudo runs as hapi, but one: root listing hapi's sudo rules (`sudo -n -l -U`); nothing given to `sudo -i` holds a `$`. No doc (README, `docs/secrets.md`, the runbooks) has a root `sudo` on a hapi-home path, or an `install` or `chown` that hands a file to hapi. The controls: the old lines are caught. Then the snippets hapi runs are run as this user in a temp `HOME`: the checkout refuses a dangling symlink and follows nothing; a failed clone leaves nothing; mise is renamed into place at `0755`; the activate line is added once; the helper, with `sudo` and `id` stood in, writes the three files at `0600` in a `0700` dir. |
| `tests/audit/*.test.ts` | Every audit check over a world of fakes (no Docker, network or secret): a hand edit to the deployed build (`approvals.mode: off`, `PI_OFFLINE=0`), a file or directory a fresh build doesn't have (a `settings.json` or `extensions/` planted in build/pi), a symlink where a generated file belongs, and a container started from another build fail `generated.drift`; the running containers' env, yolo flags and dev-bypass labels; the pins (a `#` line inside a continued `RUN`, a download piped into a shell, an install behind BuildKit flags, a wrapper or a shell keyword, a mise file besides `mise.toml`); Archon's parse warnings (in the shape the pinned image prints), a validation command's non-zero exit, and Hermes's unknown keys; the MCP lock (a skip until H-101 once its offline checks pass); the secrets provider and store; the rulesets, App permissions (a response with no `permissions` object fails) and a comment-triggered AI workflow on a fake GitHub, with its secret in the action's inputs, inline in a `run:` line, in any expression that reads it (`secrets['NAME']`, `toJSON(secrets)`), or anywhere else in the agent's job, or holding `permissions: write-all` or a checkout's kept token; and the audit's own App token (hapi-planner then hapi-factory, a revoke GitHub doesn't confirm warned about on stderr). See [docs/audit.md](../audit.md). |
| `tests/docs/slack-manifest.test.ts` | The Slack runbook's manifest command runs exactly `stack/hermes/Dockerfile`'s pinned image, with `--network none`, as its user, read-only, and prints to stdout. |
| `tests/secrets/manifest.test.ts` (the reserved names) | A manifest env name hapi sets itself (`HTTPS_PROXY`, `PI_OFFLINE`, `GIT_CONFIG_COUNT`, `ALL_PROXY`, ...) is refused in any zone, naming each, by `loadManifest` and for a manifest built in code, before resolve fetches anything. So is a process-control or trust-store name, exact (`PATH`, `SSL_CERT_FILE`, `GIT_SSH_COMMAND`, every name of `CONTROL_ENV_NAMES`) by prefix (`LD_PRELOAD`, `NODE_OPTIONS`, every prefix of `CONTROL_ENV_PREFIXES`) or an endpoint override by suffix (`ANTHROPIC_BASE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, every suffix of `CONTROL_ENV_SUFFIXES`), with the rule in the message. Lookalikes (`LDAP_PASSWORD`, `NODEPING_API_KEY`, `PIPELINE_KEY`, `SLACK_WEBHOOK_URL`) pass. `RESERVED_ENV_NAMES` and the prefixes are pinned, and the committed manifest uses none of them. |
| `tests/generate/egress.test.ts` | The proxies' new `to_localnet` ranges (`::/96`, `2002::/16`, `2001::/32`, `100::/64`, `fec0::/10`). No range covers another, so `squid -k parse` stays clean. `pinger_enable off` is set, and the NAT64 trade-off is noted. Every zone, the research zone included, refuses IP literals (`ip_literal`) before any allow. |

`mise run test:int` (`HAPI_INT=1`) runs every `*.int.test.ts`. It needs Docker, and the internet for the tests marked so; offline, those are skipped with a warning. Each run builds its own Compose project, `hapi-int-<random>`, from a byte-for-byte copy of `stack/` in a temp dir. It uses fake secrets written by hapi's own resolver, then appends lines to those env files that try to override hapi's own settings, plus a test override that only plants `/etc/hosts` names on the proxies, blanks Hermes's Slack tokens and gives the images it builds project-named tags. Afterwards it removes every container, network, volume and image it made, and checks that none is left.

It never touches a running stack, so you can run it while the `hapi` project is up:

- It generates the configs into its own temp build dir, and its copy of `stack/compose.yaml` mounts that dir (the compose file's `../build/...` paths resolve next to the copy).
- The checkout's `build/`, which the running stack bind-mounts, is never written. The test checks this at the end: every file there must keep its inode, size, mtime and hash.
- It never builds or retags the real stack's `hapi-factory/hermes` and `hapi-factory/archon` images.

It does start a second Hermes, with fake keys, so allow for its memory (up to 4 GB). Archon is a run template, not a service: its run containers are checked by the run integration test (Plan 02 Task 8).

| Test (`tests/stack/egress.int.test.ts`) | What it proves |
|---|---|
| the networks | The zone networks Docker makes are internal and inside `zone_clients`, and only the three proxies are on `outbound` (checked again once Hermes is up, below). Each proxy runs non-root, with no capabilities. Its root filesystem and its config bind mount are read-only; its tmpfs mounts (`/tmp`, `/var/spool/squid`, `/var/log/squid`) are read-write, the control. See [how the read-only checks work](#how-the-read-only-checks-work). |
| `egress: allowed host via proxy succeeds` (archon and hermes; internet) | `api.anthropic.com` tunnels through its zone's proxy, `API.Anthropic.COM` too. |
| `egress: disallowed host via proxy is denied` | A host off the allowlist gets `403`: `github.com` for archon, `example.com` for hermes. |
| every IP-literal destination is refused | `203.0.113.7`, `1.2.3.4`, `[2001:db8::1]`, `[::ffff:1.2.3.4]`, `[::ffff:203.0.113.7]`, `[::]`, `[::1]`, `[64:ff9b::1.2.3.4]` and `2130706433` all get `403` in both allowlisted zones. They are sent raw, so curl normalises nothing. |
| an allowed name resolving inside | `pypi.org` → `10.9.9.9`, `registry.npmjs.org` → NAT64, `files.pythonhosted.org` → `::1` and `openrouter.ai` → 6to4 are all refused by `to_localnet`. |
| plain http and other ports | `http://` and `:8443` are refused, for an allowed host too. |
| the forge (internet) | hermes reaches `github.com`; archon gets `403` for `github.com` and `api.github.com`. |
| PTR bypass | Two throwaway proxies on archon-net, each with `203.0.113.7` → `api.anthropic.com` planted (which Squid also uses for reverse lookups). The control proxy, without `-n` and `ip_literal`, tunnels `CONNECT 203.0.113.7:443`. The real config refuses it with `403` before any connection. |
| research: public hosts (internet) | HTTPS and `GET http://example.com/` work. |
| research: IP literals | Every IP-literal destination is refused here too, as in the allowlisted zones: public ones (`1.1.1.1`, `203.0.113.7`, `2130706433`, `[2606:4700::1111]`, `[::ffff:1.1.1.1]`) and private ones (`169.254.169.254`, `10.0.0.1`, `127.0.0.1`, `[::]`, `[::1]`, `[::ffff:10.0.0.1]`, `[64:ff9b::a00:1]`, `[::10.9.9.9]`, `[2002:a09:909::1]`, `[2001::a09:909]`, `[100::1]`, `[fec0::1]`), for CONNECT and GET. |
| DNS rebinding (static) | Names planted on the research proxy that resolve to `10.9.9.9`, `::`, `::ffff:10.9.9.9`, NAT64, 6to4, Teredo, IPv4-compatible, `169.254.169.254`, `127.0.0.1`, `100::1` and `fec0::1` are refused by `to_localnet`, for both CONNECT and GET: each range in a real Squid, by name. A rebinding test with a live 0-TTL resolver is the next level, in the threat model (H-045). |
| research: the control | Names planted to resolve to public addresses no range covers (`1.1.1.1`, `2606:4700::1111`) are not refused, so it is the ranges and `ip_literal` that refuse, nothing else. |
| research: schemes and ports | `GET ftp://example.com:80/`, `GET https://example.com:80/`, port 8080 and `CONNECT :8443` are refused. |
| no way around the proxy | From every zone network, a direct connection fails, by name with curl's exit 6 (could not resolve: no DNS) and by address with exit 7 (no route). The control (internet) is that the same address answers from `outbound`. |
| no DNS out | On every zone network, Docker's resolver answers the zone's proxy name and refuses every outside name (`SERVFAIL`), so DNS is no channel out. The control (internet): the same names resolve from `outbound`. |
| `egress: direct connection is blocked even when proxy is stopped` | With `egress-archon` stopped, the proxy route fails, and so do direct connections: by name (exit 6), over IPv4 and over IPv6 (exit 7). They fail closed, never bypass. |
| the networks, with Hermes up | Still only the three proxies on `outbound`; `hermes` only on `hermes-net`, beside its proxy, by the networks' member lists and by its own network settings. `archon-net` holds only its proxy: no archon container exists until a run. |
| hapi's settings beat the env file | The zone env files hold lines that try to override hapi's own settings (`HTTPS_PROXY=...`, `NO_PROXY='*'`, `HERMES_HOME=...`), and Hermes still has exactly `serviceEnvironment`'s values. |
| hermes listens on loopback only | Every listening socket in the Hermes container is on a loopback address. |
| Hermes's hardening | Hermes runs as 10000, with no capabilities and `NoNewPrivs`. The root and its config file (`/opt/data/config.yaml`) are mounted read-only, and a write to `/` fails with `Read-only file system`. The controls: the tmpfs and volume paths are mounted read-write. |
| zone separation | Hermes sees its own zone's values and its own proxy, and none of the archon zone's, the research values or any `host.env` value (the App keys). |
| the env_file round trip (H-019) | A value holding a newline, `$`, `${...}`, `#`, spaces, a backslash, a double quote and a tab reaches the container byte for byte, through hapi's writer and Compose's `env_file`. |
| the pin at run time | Hermes reports v0.22.5. (Archon's pins, with Pi 1.3.0, Node 24.22.1, uv 0.13.5 and Python 3.14.9, are read from a run container by the run integration test, Plan 02 Task 8.) |

| Other integration tests | What they prove |
|---|---|
| `tests/secrets/sops.int.test.ts` | The whole key lifecycle on the real sops and age, and now also these: <br>- the store stays mode `0600` after each real `sops rotate` (add-machine, revoke, recover); <br>- decoy gpg-agent sockets in each machine's `HOME` and `XDG_RUNTIME_DIR` are never dialled; <br>- sops 3.13.3 reads its default key file as well as `SOPS_AGE_KEY_FILE` (the control: it fails without it), which is why `checkSopsKeys` checks that file; <br>- sops leaves `""` unencrypted, which `sopsFileProblem` allows. |
| `tests/generate/policy-build.int.test.ts` | `mise run policy:build -- --roster budget --out <dir>` passes its flags through mise: it writes the ten files with the budget roster. An unknown roster exits non-zero and writes nothing. |

#### How the read-only checks work

Each read-only check reads two things, so dropping `read_only: true` or a `:ro` makes it fail:

- **The mount flag.** The test reads the kernel's mount table as the container sees it (`/proc/self/mountinfo`). Each read-only path must be mounted `ro`, and each writable path `rw`.
- **The error.** A write must fail with `Read-only file system` (EROFS).

Neither "the write failed" nor its exit code proves anything. Each service writes as its non-root user. A file it doesn't own, or a root-owned `/`, refuses that write with `Permission denied` whether or not the mount is read-only. Stage a checked this by removing `read_only: true` and the `:ro` on `build/pi`: the old checks still passed, and the new ones failed.

Stage a ran all of these on the build host's rootful Docker, as an ordinary user. Stage b ran them again as hapi on rootless Docker on 2026-10-28: 38 of 38 passed.
