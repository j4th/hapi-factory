# Runbook: kill switches

These are spec §11.8's four kill switches, **fastest first**. The operator runs them by hand; no agent ever does. Use them when a key or token may have leaked, a run is spending or acting outside policy, or you suspect any part of the stack. They are independent: use as many as the situation needs. If nothing is sending data out, go in this order. If data may be leaving, do 3 (or 4, if 3 can't run or hangs) at once, alongside 1 and 2: switches 1 and 2 don't stop data leaving through allowed hosts. Afterwards, follow [after a kill switch](#after-a-kill-switch).

| # | Switch | Stops | Doesn't stop | Takes effect |
|---|---|---|---|---|
| [1](#1-zero-or-revoke-the-provider-keys) | Disable or revoke the provider keys | Every model and search call on those keys, from running containers too | The containers, local edits, GitHub tokens, a key already copied out | When the provider applies it |
| [2](#2-suspend-the-github-app-installations) | Suspend both GitHub App installations | New App tokens, and the Apps' access to your repos | A token minted before it, up to its hour (revoke it) | At once for new tokens |
| [3](#3-stop-the-stack) | Stop the stack | Every container: the agents and their proxies | Keys or tokens already out; what is already on GitHub | Seconds |
| [4](#4-firewall-drop-the-hapi-user) | Firewall-drop the `hapi` user | Every packet hapi's processes send, the containers' included | The containers' local work; a dev-bypass stack | The next packet |

Two marks on this page:
- **[verify]**: a provider's UI path that its docs didn't confirm on 2026-10-27. Check it the first time you open that dashboard (H-160), and fix this page.
- **[verify in stage b]**: a command never run on the real host. H-160 runs each once on the real host and removes the mark. Switch 4's ran in stage b, on 2026-10-28 (H-146(b)), and its marks are gone.

Where a command runs as the `hapi` user, it is `sudo -u hapi -H -- sh -c '<script>'` with the whole script in single quotes: your shell expands nothing in it, and hapi's own `sh` runs it. The runbooks use `sudo -iu hapi` only for fixed commands (`sudo -iu hapi docker info ...`), because a login shell (`-i`) re-parses the command's words and expands a `$` in them (sudo(8); H-148). So nothing from you, a variable or a path, ever goes through `sudo -i`.

## 1. Zero or revoke the provider keys

The fastest switch: one browser tab per provider. Each key, its cap and its logical name are in [provider keys](provider-keys.md).

| Provider | Keys | What to do |
|---|---|---|
| Anthropic | the `hapi-hermes` and `hapi-factory` workspace keys (and `hapi-evals` once it exists) | **Disable each key**, the fastest and reversible: Claude Console → [API keys](https://platform.claude.com/settings/keys) → the key's menu (**⋯**) → **Disable**. **Delete**, in the same menu, is permanent. Or cap the workspace: [Workspaces](https://platform.claude.com/settings/workspaces) → select the workspace → **Spend limits**, set as low as it goes; whether it accepts $0 isn't documented **[verify]**. Both paths are from Anthropic's docs ("Authentication", "Workspaces", read 2026-10-27). [Provider keys](provider-keys.md#anthropic-console-workspaces). |
| OpenCode Go | `hapi-archon-opencode-api-key` | Revoke the API key in the hapi OpenCode Go workspace's settings **[verify]**. [Provider keys](provider-keys.md#opencode-go). |
| OpenRouter | `hapi-jev` | In OpenRouter's API keys settings, disable or delete the `hapi-jev` key **[verify]**. OpenRouter's API can disable a key too (`disabled: true` on the key), but only with a management key, which hapi doesn't hold. [Provider keys](provider-keys.md#hapi-jev-2month). |
| Brave, Exa, Context7 | the three research-zone keys | Revoke each in its vendor's dashboard **[verify]**. [Provider keys](provider-keys.md#search-keys-brave-exa-context7). |

- **Stops:** every model and search call billed to a disabled key, including calls from containers already running: the provider refuses them. A workspace at its spend limit answers 429 `enforced_spend_limit_reached` ([provider keys](provider-keys.md#anthropic-console-workspaces)).
- **Doesn't stop:** the containers, or what an agent does locally (a Pi edit in a worktree, Hermes's terminal); GitHub pushes with an App token (switch 2); anyone who already copied a key. The key also stays in hapi's env files and the containers' environment until you rotate it.
- **Confirm:** the key shows as disabled on the provider's key page. As hapi, the next model call in `docker compose -p hapi logs hermes` (or `archon`) fails with an authentication error. Never test a key by putting it on a command line.
- **Undo:** Anthropic: **Re-enable** in the same menu (a deleted key can't come back). Otherwise create a new key with its cap, put it in your store and restart: `mise run secrets:edit`, `scripts/copy-secrets-to-hapi.sh`, `mise run up` ([rotating a secret](../secrets.md#rotating-a-secret)). If the key may have leaked, don't re-enable it: rotate.
- **Takes effect:** as soon as the provider applies it; none of them documents a delay **[verify]**.

## 2. Suspend the GitHub App installations

Do it for **both** Apps, `hapi-planner` and `hapi-factory`, on github.com: your profile picture → **Settings** → under **Integrations**, **Applications** → **Installed GitHub Apps** → **Configure** next to the App → **Suspend**. (GitHub's "Reviewing and modifying installed GitHub Apps", read 2026-10-27; the [GitHub Apps runbook](github-apps.md#kill-switch-suspend-an-installation) uses the same path.)

If you hold App tokens, revoke them **before** you suspend: while the installation is active, GitHub accepts the token, so its own revoke call works; after the suspension that call may be refused **[verify in stage b]** (H-160(b)), leaving the token live up to its hour. Each is a file in `$XDG_RUNTIME_DIR/hapi/tokens/` of the user that minted it (hapi, or you). As that user:

```bash
for f in "$XDG_RUNTIME_DIR"/hapi/tokens/*.token; do [ -s "$f" ] || continue; GH_TOKEN="$(cat "$f")" gh api -X DELETE /installation/token && rm "$f"; done
```

The `[ -s … ]` guard skips a missing or empty file: with an empty `GH_TOKEN`, `gh` would fall back to your own stored credentials.

- **Stops:** new tokens: `hapi token mint`, and the audit's own read-only token, fail, naming the suspended installation. GitHub "temporarily block[s] it from accessing resources owned by your account" (its docs).
- **Doesn't stop:** a token minted before the suspension may keep working until it expires, one hour after it was minted. GitHub's docs say a suspended App is blocked from your resources, but not in so many words that its unexpired tokens are refused **[verify in stage b]** (H-160): revoke the ones you hold, as above. Nor does it undo what is already on GitHub (a pushed `plan/**` or `factory/**` branch, an opened PR: close and delete them yourself; only you can merge), or stop the containers or your own credentials.
- **Confirm:** the App's **Configure** page shows **Unsuspend**. As hapi, `hapi token mint --app planner --repo "$OWNER/hapi-factory"` fails, saying the installation is suspended.
- **Undo:** the same page → **Unsuspend**.
- **Takes effect:** at once for new tokens; up to an hour for a token minted before it, unless you revoked it.

**CodeRabbit too,** when it's installed: the same page, **Configure** next to CodeRabbit → **Suspend**, or uninstall it there. It holds write access to the repo's contents and workflows, so suspend it with the Apps when you suspect anything that touches the repo. It stops its reviews, chat and every write it can make; it doesn't touch the factory's own Apps or tokens.

## 3. Stop the stack

Three ways, gentlest first. `compose down` removes the containers and their logs with them: if there is time, save the logs first, as hapi (`docker compose -p hapi logs --no-color > ~/hapi-incident.log`). 3c keeps the containers, and so their logs.

### 3a. `mise run down`, from your own checkout

```bash
mise run down
```

As anyone but hapi, `hapi stack down` re-execs `mise run down` as hapi with `sudo -u hapi -H -- sh -c '<fixed script>' hapi-stack`, the same fixed script as `up` (`reexecScript` in `src/stack/up.ts`): no login shell, and none of your words in the script. In hapi's checkout, hapi's mise runs `docker compose -p hapi down` on hapi's rootless Docker. It goes by project name, so it needs no compose file, `build/` or env file, but it does need a working checkout and mise on both sides (yours to start it, hapi's to run it). Spec §11.8 says "`mise run down` as host admin": that is still where you run it, but it now re-execs as hapi (H-083).

### 3b. Without a checkout or mise

When either checkout or either mise is broken, run Compose as hapi directly, with the rootless socket's environment set explicitly **[verify in stage b]**:

```bash
sudo -u hapi -H -- sh -c 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; exec docker compose -p hapi down'
```

The script is fixed text: hapi's `sh` evaluates `$(id -u)` as hapi, and nothing of yours is in it. sudo clears `XDG_RUNTIME_DIR` (lingering keeps the directory), so the script sets it, and `DOCKER_HOST` points the CLI at hapi's rootless daemon whatever Docker context hapi has.

### 3c. Hard stop: hapi's Docker daemon, or everything hapi runs

If `compose down` hangs, or the containers keep coming back **[verify in stage b]**:

```bash
sudo systemctl --user -M hapi@ stop docker.service       # hapi's rootless Docker daemon, through hapi's user manager
```

And if that isn't enough, stop hapi's whole user manager, which runs rootless Docker, its containers (their processes sit in its cgroup, whatever subordinate uid they run as) and every other user service of hapi's:

```bash
sudo loginctl disable-linger hapi                        # so nothing starts hapi's user manager again at boot
sudo systemctl stop "user@$(id -u hapi).service"         # hapi's user manager and every process under it
```

Here `$(id -u hapi)` is your own shell looking up hapi's uid for root's `systemctl`: nothing runs in a shell of hapi's.

What to check the first time you run it (H-160(c)): after the first command, as root, `ps -eo user,pid,cmd | grep -E 'rootlesskit|dockerd|containerd|slirp4netns|pasta'` shows nothing of hapi's (container processes run as hapi's subordinate uids, so don't look for them by user); after the second, `systemctl status "user@$(id -u hapi).service"` says inactive and the same `ps` is empty. Also check what comes back on the undo (below).

- **Stops:** every container: Hermes, Archon with Pi, and the three proxies, so every agent action and all egress from the zones. 3c also stops hapi's other user services: later, the poller and harvester timers (Plan 03).
- **Doesn't stop:** keys or tokens already copied out (switches 1 and 2), anything already on GitHub, or your own processes. The volumes (`hermes-data`, `archon-data`, `archon-home`) are kept, so the state is there to inspect, and `mise run up` starts from it. A dev-bypass stack (`HAPI_ALLOW_CURRENT_USER=1`) runs on your own Docker, not hapi's: stop it with `HAPI_ALLOW_CURRENT_USER=1 mise run down`; 3b and 3c don't touch it.
- **Confirm:** after 3a or 3b, this prints only the header line:

  ```bash
  sudo -u hapi -H -- sh -c 'export XDG_RUNTIME_DIR="/run/user/$(id -u)" DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"; exec docker compose -p hapi ps --all'
  ```

  After 3c, see what to check, above.
- **Undo:** `mise run up`. After the first 3c command only (linger is still on, so hapi's user manager is up), first `sudo systemctl --user -M hapi@ start docker.service`. After the full 3c stop, first `sudo loginctl enable-linger hapi`, which starts hapi's user manager, and with it hapi's Docker, again. Either way Docker then restarts each container that was running when it stopped (`restart: unless-stopped`, in `stack/compose.yaml`), so run 3b at once if you don't want them back yet **[verify in stage b]**.
- **Takes effect:** seconds. Compose stops each container with SIGTERM, then SIGKILL after its stop timeout (10 seconds by default). 3c waits for systemd's stop timeout for each unit.

## 4. Firewall-drop the hapi user

Under rootless Docker, the containers' traffic leaves the host from hapi's own network helper, which runs as hapi, so a rule that matches hapi's uid catches all of it, the proxies' included. On the stage b host the helper was rootlesskit's own `gvisor-tap-vsock` (Docker 29.9.2, with neither slirp4netns nor pasta installed); another host may use one of those, and they run as hapi too. Put the rule in a table of its own, so the undo is one command:

```bash
sudo nft add table inet hapi_kill
sudo nft add chain inet hapi_kill output '{ type filter hook output priority 0; policy accept; }'
sudo nft add rule inet hapi_kill output meta skuid hapi counter reject
```

- The `inet` family covers IPv4 and IPv6 in one rule. nft resolves `hapi` to its uid when it adds the rule.
- `reject` makes a connection fail at once rather than hang. The rule matches every packet hapi's sockets send, an open connection's included.
- nftables runs every base chain on the output hook, and a reject in one is final whatever another chain accepts, so ufw's own rules can't let hapi's traffic past it.

**With iptables instead** (on Ubuntu, iptables-nft; the rules go first in its `filter` table's `OUTPUT` chain):

```bash
sudo iptables  -I OUTPUT -m owner --uid-owner hapi -j REJECT
sudo ip6tables -I OUTPUT -m owner --uid-owner hapi -j REJECT
# undo: the same two lines with -D instead of -I
```

**Not with `ufw` alone.** ufw's rules (`ufw deny out ...`) match addresses, ports, protocols, interfaces and application profiles, never a user, so no ufw command does this. A raw `-m owner` rule in ufw's `before.rules` plus `ufw reload` would, but it is slower and edits a file: use nft.

- **Stops:** every packet hapi's processes send: the containers' egress through the proxies, and hapi's own `git`, `mise`, `curl` and image pulls (so `mise run up` and `mise install` as hapi fail while it is on). Loopback too; no stack service needs it, since none publishes a port.
- **Doesn't stop:** the containers or the agents' local work (switch 3 does); keys or tokens already out; a stack on rootful Docker. Under the dev bypass the containers run on your own Docker, their traffic is forwarded rather than sent by a user, and no owner match sees it: use switch 3.
- **Confirm:** `sudo nft list table inet hapi_kill` shows the rule, its counter rising while anything of hapi's tries to reach out. `sudo -u hapi -H -- curl -sS -m 5 -o /dev/null https://example.com` fails at once. For the containers: as hapi, `docker compose -p hapi logs egress-archon` shows the proxy's connections failing, and the counter rises as they do. In stage b (H-146(b)), `docker exec hapi-archon-1 curl -sS -m 10 -o /dev/null https://api.anthropic.com/` got `CONNECT tunnel failed, response 503`, the proxy logged `TCP_TUNNEL/503 0 CONNECT api.anthropic.com:443 - HIER_NONE/- -` (it took the request but couldn't reach out), and `nft list` afterwards showed 69 packets rejected.
- **Undo:** `sudo nft delete table inet hapi_kill` (or the iptables lines with `-D`). In stage b, hapi's curl got its `200` again at once, and Hermes answered a DM, with no restart.
- **Takes effect:** at once, from the next packet. The table isn't saved, so a reboot clears it; to make it survive one, add it to the host's nftables config as well.

## After a kill switch

1. **Keep it stopped until you know what happened.** The volumes survive `compose down`. Read what you saved of the logs, and GitHub's side: branches pushed, PRs opened and comments made by either App.
2. **Rotate whatever may have leaked:** the provider keys ([rotating a secret](../secrets.md#rotating-a-secret)); Hermes's Slack bot and app-level tokens, which none of the four switches revokes ([Slack kill switch](slack.md#kill-switch)); an App's private key ([GitHub Apps](github-apps.md#rotating-a-private-key)); and if the store, a machine's age key or the 10 words may be exposed, the store's keys and every credential inside it ([lost or compromised keys](../secrets.md#a-lost-key-a-compromised-key-lost-or-exposed-words)).
3. **Bring it back in reverse order:** delete the firewall table (4), start the stack (3), unsuspend the Apps (2), re-enable or replace the keys (1). Then, as hapi, `mise run audit -- --strict --repo "$OWNER/hapi-factory" --github-token-file <file>` ([the audit](stack.md#5-the-audit)).
4. **Record it.** If a control failed or a switch didn't do what this page says, fix this page and the threat model ([docs/security/threat-model.md](../security/threat-model.md)), with an H number for any follow-up.
