# Runbook: the stack

This runbook covers running the hapi-factory stack (spec §4.3, §9, §10, §11.3–11.5, §11.8):

- [what runs](#what-runs);
- [1. host setup](#1-host-setup), done once by the host admin with `sudo`;
- [2. the `hapi` user's toolchain](#2-the-hapi-users-toolchain);
- [3. the `hapi` user's secrets](#3-the-hapi-users-secrets), and [re-syncing after an edit](#re-syncing-after-you-edit-the-store);
- [4. `mise run up` and `mise run down`](#4-mise-run-up-and-mise-run-down), and [the dev bypass](#the-dev-bypass-hapi_allow_current_user1);
- [the kill switches](#kill-switches);
- [the pinned images](#pinned-images) and [the hardening](#hardening);
- [troubleshooting](#troubleshooting);
- [what the tests prove](#what-the-tests-prove).

It runs in two stages:

- **Stage a (done in Plan 01 Task 5):** the files below were written, and the integration tests ran on the build host's rootful Docker as an ordinary user. That run covered the egress proxies and networks, plus Hermes and Archon started with fake secrets. No real secret was used, and `scripts/host-setup.sh` was not run.
- **Stage b (the operator, later):** sections 1–4 on the real host, as the `hapi` user on rootless Docker, then `mise run test:int` there. It may run while the stack is up, because it never touches the running stack or the checkout's `build/` ([what the tests prove](#what-the-tests-prove)).

Every command marked *as hapi* runs in a shell of the `hapi` user (`sudo -iu hapi`). The other commands run as the operator, from the operator's own checkout.

## What runs

`stack/compose.yaml` holds five services in the Compose project `hapi`:

| Service | Zone | Network | Way out | What it is |
|---|---|---|---|---|
| `egress-hermes` | hermes | `hermes-net`, `outbound` | itself | Squid, on `build/egress/hermes.squid.conf`: HTTPS to the hermes allowlist only |
| `egress-archon` | archon | `archon-net`, `outbound` | itself | Squid, on `build/egress/archon.squid.conf`: HTTPS to the archon allowlist only, with no forge route |
| `egress-research` | research | `research-net`, `outbound` | itself | Squid, on `build/egress/research.squid.conf`: the open web, minus private ranges |
| `hermes` | hermes | `hermes-net` | `egress-hermes` | Hermes v0.22.5, the coordinator, running `gateway run` with `build/hermes/config.yaml` |
| `archon` | archon | `archon-net` | `egress-archon` | Archon 0.12.1, with Pi 1.3.0 in-process, `build/archon/*` and `build/pi` (read-only) |

The research zone's own container, hapi-research, arrives in Plan 04. Task 5 ships its network, its proxy and its tests.

- **The zone networks are `internal`.** A container on one has no route out and no external DNS. Its only way out is its zone's proxy, through `HTTP_PROXY` and `HTTPS_PROXY` (in both cases) set to `http://egress-<zone>:3128`. Loopback goes direct (`NO_PROXY=localhost,127.0.0.1,::1`).
- **Only the proxies join `outbound`**, and they can't reach each other on it (`enable_icc=false`).
- **No service publishes a port.**
  - Archon's server listens on `127.0.0.1:3090` inside its container (`HOST` in `archon.env`). It has no auth in SQLite mode.
  - The Hermes gateway uses Slack Socket Mode, so it has no inbound endpoint. Its API listens on `127.0.0.1:8642` inside its container.
  - To reach either one, `docker compose -p hapi exec` into the container.
- **Secrets.** Each zone service reads only its own zone's env file, `$XDG_RUNTIME_DIR/hapi/env/<zone>.env` ([docs/secrets.md](../secrets.md#the-env-files)). `host.env` holds the GitHub App keys and goes to no container.
- **State** lives in three named volumes:
  - `hermes-data`: Hermes's home (sessions, memories, skills);
  - `archon-data`: `/.archon` (the run DB, workspaces, worktrees);
  - `archon-home`: `/home/appuser` (Claude Code and Pi session state).

  `mise run down` keeps them.

## 1. Host setup

The host admin does this once, with `sudo`. No agent ever runs it.

```bash
sudo scripts/host-setup.sh [source]
```

`source` is where the `hapi` user's checkout is cloned from. It defaults to your checkout's `origin` remote. Until hapi-factory is pushed (Plan 01 Task 7b), there is no remote, so pass your checkout's path: `sudo scripts/host-setup.sh "$PWD"`. A local path is copied, never hardlinked. Once the GitHub remote exists, point hapi's checkout at it, as hapi: `git -C ~/hapi-factory remote set-url origin <url>`.

The script runs with `set -euo pipefail` and refuses to run without root. Each step is skipped when it is already done, so a second run changes nothing. The steps:

1. **Creates the user `hapi`.** It gets 1,048,576 subordinate UIDs and GIDs. Canonical's Squid rock owns files with uid 584792, which is beyond useradd's default 65,536, and rootless Docker can't unpack an image with an ID it can't map. The script refuses to go on if `hapi` is in the `docker` group, which is root on a rootful host.
2. **Installs the rootless Docker prerequisites** if they are missing, with apt: `uidmap`, `docker-ce-rootless-extras` and `dbus-user-session`.
3. **Turns on lingering** (`loginctl enable-linger hapi`). hapi's systemd user manager, its `/run/user/<uid>` (its `XDG_RUNTIME_DIR`) and its Docker then keep running without a login, and across reboots.
4. **Sets up rootless Docker for hapi** (`dockerd-rootless-setuptool.sh install`) as a user service, and checks that `docker info` says `rootless`.
5. **Installs mise for hapi.** It downloads the release that `mise.toml`'s `min_version` names and checks it against a SHA-256 pinned in the script. Nothing is piped to a shell.
6. **Clones hapi-factory** into `/home/hapi/hapi-factory`, owned by hapi.
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

1. **Give hapi a copy of the store**, as the operator, from your checkout. The store, its recipients file and `recovery.age` live in your `private/`:

   ```bash
   sudo install -d -o hapi -g hapi -m 0700 /home/hapi/.config /home/hapi/.config/hapi
   sudo install -o hapi -g hapi -m 0600 private/secrets.enc.yaml private/secrets.recipients.yaml private/recovery.age /home/hapi/.config/hapi/
   ```

2. **Make hapi's key**, as hapi (with `XDG_RUNTIME_DIR` exported):

   ```bash
   cd ~/hapi-factory
   mise run secrets:join -- --store ~/.config/hapi/secrets.enc.yaml --name hapi
   ```

   It writes hapi's own age key and its config, `~/.config/hapi/secrets.yaml`. Then it prints the `add-machine` command to run.

3. **Add hapi's key to the store**, as the operator: run the printed command (`mise run secrets:add-machine -- --name hapi --recipient age1pq1...`). It re-keys the store and updates its recipients file, so commit and push `private/` as usual.

4. **Copy the updated store to hapi again** (the same `install` line as step 1). Then, as hapi:

   ```bash
   mise run secrets:check     # every secret found, hapi among the recipients
   ```

### Re-syncing after you edit the store

You keep editing your own copy (`mise run secrets:edit` in `private/`). hapi's copy doesn't change on its own. After each edit, rotation or recipient change, copy all three files again, then restart the stack so it resolves the new values:

```bash
sudo install -o hapi -g hapi -m 0600 private/secrets.enc.yaml private/secrets.recipients.yaml private/recovery.age /home/hapi/.config/hapi/
mise run up        # re-resolves, and recreates any container whose env file changed
```

Copy the three files together. `secrets:check` refuses a recipients file that disagrees with the store, or a `recovery.age` other than the one it records.

## 4. mise run up and mise run down

```bash
mise run up                          # from any account: it runs as hapi
mise run up -- --roster budget       # Haiku 5.5 on every Archon tier (spec §12)
mise run up -- --config <file>       # a secrets config other than ~/.config/hapi/secrets.yaml
mise run down
```

**`mise run up`** is `hapi stack up [--roster budget|anthropic|portable] [--config file]`. It aborts at the first failure, and nothing starts unless the steps before Compose all pass:

1. **The user.** As any user but hapi, it re-execs `mise run up` as hapi, with your flags, in hapi's checkout:

   ```text
   sudo -iu hapi -- sh -c ': "${XDG_RUNTIME_DIR:=/run/user/$(id -u)}"; export XDG_RUNTIME_DIR; cd "$HOME/hapi-factory" && exec mise run up -- ...'
   ```

   So it builds hapi's checkout's policy, not yours: pull there first (`git -C ~/hapi-factory pull`, as hapi). The user is the one the process runs as; `$USER` is not trusted.
2. **Policy build:** `buildAll` writes `build/` ([docs/generated-configs.md](../generated-configs.md)). A digest of `build/` becomes a label on every container (`org.hapi.build-sha256`). Compose recreates a container whose config changed, but not one whose bind-mounted file changed. With the label, a policy change still reaches the running proxies, Hermes and Archon.
3. **Secrets:** exactly `hapi secrets resolve`. It loads the local config, builds its provider, resolves every name into memory, then writes the zone env files as one set ([docs/secrets.md](../secrets.md#hapi-secrets-resolve)). A missing or empty secret, a provider failure or a missing pinned age stops it here, naming the secret or the fix.
4. **`docker compose up --no-start --build`:** builds the two images, and creates the networks and containers without starting any.
5. **The network check:** each zone network must be internal, with every subnet inside the proxies' `zone_clients` ranges (10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10). Otherwise it removes what step 4 made and stops.
6. **`docker compose up -d --wait`:** starts the stack, and waits up to 5 minutes for every health check to pass. If one fails, `up` fails and says where to look; the containers are left for you to inspect.

**`mise run down`** is `hapi stack down`, which runs `docker compose -p hapi down`. It goes by project name, so it needs no compose file, `build/` or `XDG_RUNTIME_DIR`, and it works whatever state the checkout is in. It keeps the volumes. As any other user, it re-execs as hapi, as `up` does.

To see the stack, as hapi: `docker compose -p hapi ps`, `docker compose -p hapi logs <service>`. To change the proxies' rules, change `policy/trusted_sources.yaml` and run `mise run up`. The configs set `pid_filename none`, so a reload is a restart, and the build label makes `up` restart them.

### The dev bypass: HAPI_ALLOW_CURRENT_USER=1

```bash
HAPI_ALLOW_CURRENT_USER=1 mise run up
```

With this set, `up` and `down` skip the re-exec and run the stack as **you**, on your own Docker. This is a **dev-only downgrade**: there is no dedicated user, and on a rootful host there is no rootless Docker. It exists for development and for the stage-a tests.

- `up` prints a warning.
- Every container is labelled `org.hapi.dev-override=1` and `org.hapi.started-by=<you>`.
- `hapi audit` (Plan 01 Task 6) reports it, through `currentUserOverride(env)` in `src/stack/up.ts`.
- Only exactly `1` turns it on. It means nothing for the hapi user itself.

Never use it for the real stack.

## Kill switches

These are spec §11.8's kill switches, fastest first.

1. **Zero or revoke the provider keys.** Use the Anthropic Console workspaces, OpenRouter and OpenCode ([provider keys](provider-keys.md)). Calls fail at the provider, even from a running container.
2. **Suspend the GitHub App installations:** GitHub, **Settings → Integrations → Applications → Configure → Suspend** ([GitHub Apps](github-apps.md)). Token minting fails (`hapi token mint` checks for a suspended installation), and existing tokens expire within an hour.
3. **`mise run down`, as the host admin.** It re-execs as hapi and removes every container. As root, use `sudo -iu hapi docker compose -p hapi down`. That still works with a broken checkout, since down needs no file.
4. **Firewall-drop the `hapi` user.** Under rootless Docker, the containers' traffic leaves the host from hapi's own network processes (slirp4netns or pasta), so an owner match catches all of it. **[verify in stage b]**

   ```bash
   sudo iptables  -I OUTPUT -m owner --uid-owner hapi -j REJECT
   sudo ip6tables -I OUTPUT -m owner --uid-owner hapi -j REJECT
   # undo: the same lines with -D instead of -I
   ```

   Under the dev bypass, the containers run on rootful Docker. Their traffic is forwarded, not sent by a user, so this switch doesn't apply; use 3.

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
- a health check;
- `restart: unless-stopped`;
- size-capped json-file logs;
- no published ports.

Writable paths are size-capped tmpfs or named volumes.

| Service | User | Writable | Limits | Health check |
|---|---|---|---|---|
| `egress-*` | `584792` (the rock's `_daemon_`) | tmpfs `/var/spool/squid`, `/var/log/squid`, `/tmp` (16 MB each; Squid writes nothing to them: no cache dir, logs on stdout, no pid file) | 64 pids, 256 MB | Port 3128 accepts a connection (perl; the rock has no curl or bash) |
| `hermes` | `10000:10000` (the image's `hermes`) | volume `hermes-data` (`/opt/data`); tmpfs `/run`, `/tmp` | 1024 pids, 4 GB | `hermes gateway status` says `Gateway is running` (it exits 0 either way, so the output is read) |
| `archon` | `1001:1001` (the image's `appuser`) | volumes `archon-data` (`/.archon`), `archon-home` (`/home/appuser`); tmpfs `/tmp` | 2048 pids, 4 GB | `curl http://127.0.0.1:3090/api/health` |

**Exceptions:**

- **Hermes's `/run` tmpfs allows exec.** s6-overlay, the image's init, runs its programs from `/run`. Every other tmpfs is `noexec`, Docker's default.
- **Hermes starts as its own user, not as root.** Its s6-overlay accepts that UID and skips its root-only bootstrap (the UID remap and the volume chown). It logs two warnings and continues: `docker_config_migrate.py failed` and `dependency refresh failed`. Both steps are optional.
- **Archon logs a warning that gh is not authenticated.** That is by design: the archon zone has no forge credential (spec §4.3).

Spike T12 re-checks these settings under rootless Docker. If it relaxes one, it changes `stack/compose.yaml` with a comment naming the spike.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `required variable XDG_RUNTIME_DIR is missing a value` | You ran `docker compose` (not `mise run up`) in a shell without `XDG_RUNTIME_DIR`. Run `export XDG_RUNTIME_DIR=/run/user/$(id -u)`. |
| `XDG_RUNTIME_DIR is not set` or `... does not exist` from `secrets:*` or `up` | The same, or lingering is off: run `loginctl show-user hapi -p Linger` (should say `yes`), then re-run `scripts/host-setup.sh`. |
| `` `mise where age` failed ... run `mise install` in the hapi-factory checkout `` | hapi's checkout isn't trusted or installed. As hapi: `cd ~/hapi-factory && mise trust && mise install`. |
| `hermes/SLACK_BOT_TOKEN (...) is empty` | Every secret in `stack/secrets.yaml` must have a value before anything starts, the three Slack values included. They come from the Slack app, which Plan 01 Task 13 creates. Until then the stack can't start (see [the open item](#open-items)). |
| `zone network hapi_<zone>-net has subnet ..., outside the proxies' zone_clients ranges` | This host's Docker `default-address-pools` hands out non-private ranges. Set the pools to private ranges (hapi's `~/.config/docker/daemon.json` under rootless Docker), restart its Docker, then run `mise run up`. |
| `zone network ... is not internal` | Someone edited `stack/compose.yaml`. Restore `internal: true`; `tests/stack/compose.test.ts` fails on this too. |
| Pulling `ubuntu/squid` fails with `lchown ...: invalid argument` (rootless) | hapi's subordinate ID range is narrower than uid 584792. Check `grep hapi /etc/subuid /etc/subgid` (each should be 1048576 wide), re-run `scripts/host-setup.sh`, then restart hapi's Docker. |
| `the stack did not come up healthy` | As hapi, run `docker compose -p hapi ps` and `docker compose -p hapi logs <service>`. A proxy that fails to start usually has a config error: run `mise run policy:build`, then check `build/egress/<zone>.squid.conf`. |
| A zone container can't reach a host | It isn't on the zone's allowlist ([docs/generated-configs.md](../generated-configs.md#buildegresssquidconf)). Look for `TCP_DENIED/403` in `docker compose -p hapi logs egress-<zone>`. Allowlists change by a policy PR; nothing bypasses the proxy. |
| A proxy is stopped or unhealthy | Its zone has no way out at all: requests fail, never bypass. Run `mise run up` to start it again. |

### Open items

- **The Slack values before Task 13.** `resolve` refuses an empty secret, and the Slack app (its tokens) is made in spike T13 from the running Hermes container. So stage b needs the order settled first: make the Slack app before stage b (its manifest from a one-off `docker run` of the pinned Hermes image), or another ruling.
- **Not yet run on the real host:** host setup, rootless Docker, the subordinate ID range, lingering, kill switch 4 and the whole stack under hapi. That is stage b, and spike T12 runs alongside it.

## What the tests prove

`mise run test` runs the unit tests. They need no Docker, network or secrets.

| Test | What it proves |
|---|---|
| `tests/stack/compose.test.ts` | It reads `stack/compose.yaml` and the Dockerfiles. There are exactly five services. The zone networks are internal, and only the proxies join `outbound`. No ports are published. Every service has the full hardening set (no capabilities, no new privileges, non-root, limits, read-only, health checks, the labels). Every image, `FROM` and `COPY --from` is pinned by tag and digest, at Hermes v0.22.5 and Archon 0.12.1. Each zone service gets only its own zone's env file, never `host.env`. Each gets proxy variables for its own proxy, and starts after that proxy is healthy. Archon mounts `build/pi` read-only at exactly `PI_AGENT_DIR`. |
| `tests/stack/up.test.ts` | The order of `up`: build, secrets, create, the network check, start. A failed secret, policy build or pinned-age lookup starts nothing (the last through the real `resolve` path). A non-internal or non-private zone network removes what was created. The re-exec as hapi uses exact quoting and passes on the exit code. The dev bypass warns and labels. `currentUserOverride` turns on only with exactly `1`. The build digest covers each generated file. `down` works by project name. Usage errors exit 2. |
| `tests/stack/cidr.test.ts` | The CIDR maths behind the network check and the `to_localnet` overlap check. |
| `tests/scripts/host-setup.test.ts` | It never runs the script. `bash -n` parses it, and shellcheck lints it when on PATH. It is in strict mode, and every step runs after the root check. Each step checks before it acts. The subordinate ID range covers uid 584792. Docker is rootless and lingering is on. mise is pinned to `min_version`, checked by SHA-256, and never piped to a shell. The checkout goes where `up` re-execs. The next steps are printed. |
| `tests/generate/egress.test.ts` | The proxies' new `to_localnet` ranges (`::/96`, `2002::/16`, `2001::/32`, `100::/64`, `fec0::/10`). No range covers another, so `squid -k parse` stays clean. `pinger_enable off` is set, and the NAT64 trade-off is noted. |

`mise run test:int` (`HAPI_INT=1`) runs every `*.int.test.ts`. It needs Docker, and the internet for the tests marked so; offline, those are skipped with a warning. Each run builds its own Compose project, `hapi-int-<random>`, from a byte-for-byte copy of `stack/` in a temp dir. It uses fake secrets written by hapi's own resolver, plus a test override that only plants `/etc/hosts` names on the proxies, blanks Hermes's Slack tokens and gives the images it builds project-named tags. Afterwards it removes every container, network, volume and image it made, and checks that none is left.

It never touches a running stack, so you can run it while the `hapi` project is up:

- It generates the configs into its own temp build dir, and its copy of `stack/compose.yaml` mounts that dir (the compose file's `../build/...` paths resolve next to the copy).
- The checkout's `build/`, which the running stack bind-mounts, is never written. The test checks this at the end: every file there must keep its inode, size, mtime and hash.
- It never builds or retags the real stack's `hapi-factory/hermes` and `hapi-factory/archon` images.

It does start a second Hermes and Archon, with fake keys, so allow for their memory (up to 4 GB each).

| Test (`tests/stack/egress.int.test.ts`) | What it proves |
|---|---|
| the networks | The zone networks Docker makes are internal and inside `zone_clients`, and only the three proxies are on `outbound`. Each proxy runs non-root, with no capabilities. Its root and its config are read-only, and so are its mounts; see [how the read-only checks work](#how-the-read-only-checks-work). |
| `egress: allowed host via proxy succeeds` (archon and hermes; internet) | `api.anthropic.com` tunnels through its zone's proxy, `API.Anthropic.COM` too. |
| `egress: disallowed host via proxy is denied` | A host off the allowlist gets `403`: `github.com` for archon, `example.com` for hermes. |
| every IP-literal destination is refused | `203.0.113.7`, `1.2.3.4`, `[2001:db8::1]`, `[::ffff:1.2.3.4]`, `[::ffff:203.0.113.7]`, `[::]`, `[::1]`, `[64:ff9b::1.2.3.4]` and `2130706433` all get `403` in both allowlisted zones. They are sent raw, so curl normalises nothing. |
| an allowed name resolving inside | `pypi.org` → `10.9.9.9`, `registry.npmjs.org` → NAT64, `files.pythonhosted.org` → `::1` and `openrouter.ai` → 6to4 are all refused by `to_localnet`. |
| plain http and other ports | `http://` and `:8443` are refused, for an allowed host too. |
| the forge (internet) | hermes reaches `github.com`; archon gets `403` for `github.com` and `api.github.com`. |
| PTR bypass | Two throwaway proxies on archon-net, each with `203.0.113.7` → `api.anthropic.com` planted (which Squid also uses for reverse lookups). The control proxy, without `-n` and `ip_literal`, tunnels `CONNECT 203.0.113.7:443`. The real config refuses it with `403` before any connection. |
| research: public hosts (internet) | HTTPS and `GET http://example.com/` work. |
| research: private literals | `169.254.169.254`, `10.0.0.1`, `127.0.0.1`, `[::]`, `[::1]`, `[::ffff:10.0.0.1]`, `[64:ff9b::a00:1]` and the new ranges' `[::10.9.9.9]`, `[2002:a09:909::1]`, `[2001::a09:909]`, `[100::1]`, `[fec0::1]` are all refused. |
| DNS rebinding (static) | Names planted on the research proxy that resolve to `10.9.9.9`, `::`, `::ffff:10.9.9.9`, NAT64, 6to4, Teredo and IPv4-compatible addresses are refused by `to_localnet`, for both CONNECT and GET. A rebinding test with a live 0-TTL resolver is the next level, in the threat model (H-045). |
| research: the control | A public IPv6 address the ranges don't cover is not refused, so it is the ranges that refuse. |
| research: schemes and ports | `GET ftp://example.com:80/`, `GET https://example.com:80/`, port 8080 and `CONNECT :8443` are refused. |
| no way around the proxy | From every zone network, a direct connection fails, by name (no DNS) and by address (no route). The control (internet) is that the same address answers from `outbound`. |
| `egress: direct connection is blocked even when proxy is stopped` | With `egress-archon` stopped, the proxy route fails, and so do direct connections over IPv4 and IPv6. They fail closed, never bypass. |
| `archon listens on loopback only` (internet: the image build) | `127.0.0.1:3090/api/health` answers inside the container. From archon-net, `archon:3090` and `:3000` refuse the connection. |
| hermes listens on loopback only | Every listening socket in the Hermes container is on a loopback address. |
| the zone services' hardening | Archon runs as 1001 and Hermes as 10000, with no capabilities and `NoNewPrivs`. The root and the config files (`/.archon/config.yaml`, `/opt/data/config.yaml`) are mounted read-only, and a write to `/` fails with `Read-only file system`. The controls: the tmpfs and volume paths are mounted read-write. |
| zone separation | Each container sees its own zone's values and its own proxy. Neither sees the other zone's values, the research values or any `host.env` value (the App keys). |
| archon's generated config | `archon.env`'s settings are in its environment. The test's `build/pi` is at `PI_CODING_AGENT_DIR`, the same bytes. That mount is read-only, and a write to `models.json` fails with `Read-only file system`. The test's `build/archon/config.yaml` is Archon's config. |
| the env_file round trip (H-019) | A value holding a newline, `$`, `${...}`, `#`, spaces, a backslash, a double quote and a tab reaches the container byte for byte, through hapi's writer and Compose's `env_file`. |
| the pins at run time | Hermes reports v0.22.5. Archon reports 0.12.1, with Pi 1.3.0, Node 24.22.1, uv 0.13.5 and Python 3.14.9. |
| from inside archon (internet) | Its proxy variables reach `api.anthropic.com` and get `403` for `github.com`. |

| Other integration tests | What they prove |
|---|---|
| `tests/secrets/sops.int.test.ts` | The whole key lifecycle on the real sops and age, and now also these: <br>- the store stays mode `0600` after each real `sops rotate` (add-machine, revoke, recover); <br>- decoy gpg-agent sockets in each machine's `HOME` and `XDG_RUNTIME_DIR` are never dialled; <br>- sops 3.13.3 reads its default key file as well as `SOPS_AGE_KEY_FILE` (the control: it fails without it), which is why `checkSopsKeys` checks that file; <br>- sops leaves `""` unencrypted, which `sopsFileProblem` allows. |
| `tests/generate/policy-build.int.test.ts` | `mise run policy:build -- --roster budget --out <dir>` passes its flags through mise: it writes the ten files with the budget roster. An unknown roster exits non-zero and writes nothing. |

#### How the read-only checks work

Each read-only check reads two things, so dropping `read_only: true` or a `:ro` makes it fail:

- **The mount flag.** The test reads the kernel's mount table as the container sees it (`/proc/self/mountinfo`). Each read-only path must be mounted `ro`, and each writable path `rw`.
- **The error.** A write must fail with `Read-only file system` (EROFS).

Neither "the write failed" nor its exit code proves anything. Each service writes as its non-root user. A file it doesn't own, or a root-owned `/`, refuses that write with `Permission denied` whether or not the mount is read-only. Stage a checked this by removing `read_only: true` and the `:ro` on `build/pi`: the old checks still passed, and the new ones failed.

Stage a ran all of these on the build host's rootful Docker, as an ordinary user. Stage b runs them again as hapi on rootless Docker.
