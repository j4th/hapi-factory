# Spike 05: the images under rootless Docker

- **Plan 01 Task 12**, for Task 5's hardening and Plans 03/04. Run on 2026-10-28, during stage b (H-080).
- **Where:** the real host, as the `hapi` user, on its rootless Docker 29.9.2 (`docker-ce-rootless-extras` 29.9.2, Compose 5.6.1). Its network is rootlesskit's own `gvisor-tap-vsock`, run as hapi with `--disable-host-loopback`; neither slirp4netns nor pasta is installed.
- **Images:** the stack's pinned ones: `hapi-factory/hermes:v0.22.5`, `hapi-factory/archon:0.12.1` (Archon 0.12.1, Pi 1.3.0 in-process) and `ubuntu/squid:7.2-26.04_edge` by digest.
- **Result: nothing relaxed.** All five services run healthy under the full hardening set: no capabilities, no new privileges, a read-only root, a non-root user, and pid, memory and tmpfs size limits that rootless Docker applies. No capability had to come back, and nothing the services need to start, stay healthy and pass the integration tests needed a writable mount `stack/compose.yaml` doesn't already give (Pi's agent dir is spike T8's, finding 4). So `stack/compose.yaml` doesn't change.

## Setup

- **The stack as it ships:** `mise run up` from the operator's account, which re-execs as hapi, Compose project `hapi`. There was no spike project and no override.
- **The evidence** came from short scripts the operator ran in a `sudo -iu hapi` terminal, pasting the output back. They read Docker's view of each container (`docker inspect`), the capabilities of PID 1 inside it, and Hermes's and Archon's logs. The limits were read from the host, without sudo: each container process's cgroup (`/proc/<pid>/cgroup`, then its `pids.max` and `memory.max` under `/sys/fs/cgroup`) and its mounts (`/proc/<pid>/mountinfo`).
- **Two lines in Hermes's log** were then traced in the operator's own Docker. The same image was booted with the same flags and a harmless command, `version`:

  ```bash
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 10000:10000 \
    --tmpfs /run:exec,size=64m,uid=10000,gid=10000,mode=0755 --tmpfs /tmp:size=64m,mode=1777 \
    --tmpfs /opt/data:uid=10000,gid=10000 hapi-factory/hermes:v0.22.5 version
  ```

## Evidence

1. **What Docker applied** (`docker inspect`):

   | Container | Read-only root | `CapDrop` | `CapAdd` | `SecurityOpt` | User |
   |---|---|---|---|---|---|
   | `hapi-hermes-1` | true | `[ALL]` | none | `no-new-privileges:true` | `10000:10000` |
   | `hapi-archon-1` | true | `[ALL]` | none | `no-new-privileges:true` | `1001:1001` |
   | `hapi-egress-archon-1` | true | `[ALL]` | none | `no-new-privileges:true` | `584792:584792` |

2. **No capabilities at run time.** `CapEff` in `/proc/1/status` is `0000000000000000` in `hapi-hermes-1` and in `hapi-archon-1`.
3. **All five healthy.** `mise run up` (Compose's `--wait`) reported each container `Healthy`, and `docker compose -p hapi ps` showed `egress-hermes`, `egress-archon`, `egress-research`, `hermes` and `archon` all `Up (healthy)`. `mise run test:int` as hapi passed 38 of 38, with none skipped. Those tests include the hardening tests in `tests/stack/egress.int.test.ts`, which read each mount's `ro` flag in `/proc/self/mountinfo` and check that a write to the read-only root fails with EROFS (H-146(c)).
4. **The Squid rock runs as its own user.** Its files are owned by uid 584792, and the first `up` pulled and unpacked it under hapi's 1,048,576-wide subordinate range (H-146(a)).
5. **The limits hold under rootless Docker.** hapi's user manager delegates the `cpu`, `memory` and `pids` controllers (`cgroup.subtree_control` of `user@1001.service`), and each container's cgroup and mounts carry what `stack/compose.yaml` sets:

   | Container | `pids.max` | `memory.max` | tmpfs (size; all `noexec` but Hermes's `/run`) | Root |
   |---|---|---|---|---|
   | each proxy | 64 | 256 MiB | `/tmp`, `/var/log/squid`, `/var/spool/squid`: 16 MiB each | `ro` |
   | `archon` | 2048 | 4 GiB | `/tmp`: 1 GiB | `ro` |
   | `hermes` | 1024 | 4 GiB | `/run`: 64 MiB, exec; `/tmp`: 512 MiB | `ro` |

   The processes run as hapi's subordinate uids: 750327 for the proxies' 584792, 166536 for Archon's 1001 and 175535 for Hermes's 10000.
6. **The writable paths**, all already in `stack/compose.yaml`:

   | Service | tmpfs | Named volume | Read-only binds |
   |---|---|---|---|
   | `hermes` | `/run` (exec, for s6-overlay), `/tmp` | `hermes-data` at `/opt/data` | `build/hermes/config.yaml` |
   | `archon` | `/tmp` | `archon-data` at `/.archon`, `archon-home` at `/home/appuser` | `build/archon/config.yaml`, `build/pi` |
   | the three proxies | `/var/spool/squid`, `/var/log/squid`, `/tmp` | none | the zone's `build/egress/<zone>.squid.conf` |

7. **The logs.** A search of Hermes's and Archon's logs for `read-only file system`, `EROFS`, `permission denied` and `operation not permitted` found two lines, both Hermes's, and the same line both times:

   ```text
   hermes-1  | s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted
   ```

   The local boot shows where they come from. The image's boot hook, `/opt/hermes/docker/stage2-hook.sh` (run by `/etc/cont-init.d/01-hermes-setup`), runs two optional steps through `s6-setuidgid hermes`. That calls `setgroups` even when the process already is the hermes user, and without `CAP_SETGID` the call fails:

   ```text
   cont-init: info: running /etc/cont-init.d/01-hermes-setup
   [stage2] Generated API_SERVER_KEY for the loopback gateway api_server
   s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted
   [stage2] Warning: docker_config_migrate.py failed; continuing
   s6-applyuidgid: fatal: unable to set supplementary group list: Operation not permitted
   [stage2] Warning: dependency refresh failed; continuing
   ```

   Hermes then boots as usual. These are the "two optional steps" the hermes service's comment in `stack/compose.yaml` expects. Archon's log had no such line.

## Findings

1. **No capability comes back.** Each image copes with being started as its own user:
   - Hermes's s6-overlay init accepts uid 10000 and skips its root-only bootstrap. Its other user switches (`02-reconcile-profiles`, the dashboard service) skip the drop when already non-root.
   - Archon's entrypoint skips its chown and `gosu` as uid 1001.
   - Squid runs as the rock's `_daemon_` user.
2. **Two of Hermes's boot steps fail, and both may:**
   - **The config-schema migration** (`docker_config_migrate.py`) would rewrite `$HERMES_HOME/config.yaml`. That is hapi's generated config, mounted read-only, so it must never run. Today only the missing capability stops it, and the read-only mount would refuse the write anyway. Hermes has a switch for it, `HERMES_SKIP_CONFIG_MIGRATION=1`, which makes the skip deliberate (H-179(g)).
   - **The dependency refresh** re-resolves opt-in extras recorded on the volume. When it fails, Hermes keeps the image's own environment, the hook's comment says. hapi installs no extras, so nothing is lost.
3. **Kill switch 4 works on this network too.** The containers' traffic leaves through rootlesskit's `gvisor-tap-vsock`, which runs as hapi, so kill switch 4's uid rule caught it (H-146(b), [the runbook](../runbooks/kill-switches.md#4-firewall-drop-the-hapi-user)). rootlesskit runs with `--disable-host-loopback`, which is meant to keep the containers off the host's loopback; this spike didn't test it.
4. **One path does need to be writable,** but it is spike T8's finding, not this spike's. Pi writes `models-store.json` into `PI_CODING_AGENT_DIR`, which the stack mounts read-only, so every Pi node fails ([spike 01](01-pi-under-archon.md); Plan 02, H-181). This spike ran no Pi node: it checked that the services start, stay healthy and pass the integration tests.

## Decision

The hardening set stands as `stack/compose.yaml` has it, under rootless Docker too: no capabilities, no new privileges, read-only roots, non-root users, and the pid, memory and tmpfs limits. Nothing was relaxed, so this spike changes no setting.

## Consequences

- **Plan 02:** gives Pi its writable agent dir (H-181, already in the register).
- **Plan 04:**
  - Sets `HERMES_SKIP_CONFIG_MIGRATION=1` in the hermes service's environment (`src/stack/env.ts` and `stack/compose.yaml`, a protected path).
  - Updates the audit's `tools.hermes-validate` detail. It says only `hermes update` or `doctor --fix` would migrate the unstamped config; it should name the boot hook too.
  - Makes `stack/compose.yaml`'s header say that T12 ran.
  - All are H-179(g). With H-179(c)'s `_config_version` stamp, the hook would find nothing to migrate anyway.
- **Plans 03 and 04 (new images):** an image added later, such as the research container or the per-server MCP images, gets the same set. If its entrypoint drops privileges with `s6-setuidgid` or `gosu`, start it as its target user, as Hermes and Archon are, rather than giving it `CAP_SETUID` or `CAP_SETGID`.
- **The threat model:** DS-6 is enforced as hapi on rootless Docker, by stage b and this spike.
