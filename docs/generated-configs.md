# Generated configs (`build/`)

`policy/` is the single source of truth (spec §8.1). `hapi policy build` compiles it into each tool's native config under `build/`. This page covers:

- [how to regenerate the files](#regenerating);
- [what each file is](#the-files), which policy files feed it and where it goes;
- [what each hardening setting does and why](#buildhermesconfigyaml), with the spec section it comes from;
- [how protected paths stay strictest-wins](#protected-paths-stay-strictest-wins) in every output;
- [the MCP servers](#mcp-servers-mcp_servers) in Hermes's config and [the per-zone `mcp.json` files](#buildmcpmcpjson) for the CI scanners.

`build/` is generated and gitignored. **Never edit a file in it by hand**: change `policy/` and rebuild. Every file starts with a notice that names its policy sources and says not to edit it. The YAML, env and Squid files carry it as `#` comments. JSON has no comments, so `models.json`, `hapi-guard.json` and the `mcp.json` files carry it as a `$comment` string, their first key.

## Regenerating

```bash
mise run policy:build                       # anthropic roster, writes build/
mise run policy:build -- --roster budget    # Haiku 5.5 on every tier, for the first end-to-end runs
mise run hapi -- policy build --policy policy --out build --roster portable
```

`hapi policy build [--policy dir] [--out dir] [--roster name]`:

| Flag | Default | Meaning |
|---|---|---|
| `--policy` | `policy` | The policy directory to load. It is schema-checked first, as `loadPolicy` does. |
| `--out` | `build` | Where to write. The five subdirectories are created as needed. |
| `--roster` | `anthropic` | `budget`, `anthropic` or `portable` (spec §12). It selects **Archon's tiers and Pi's models only**. Hermes always uses the `anthropic` roster, because it runs on the Anthropic provider with a Console key. |

It prints each path it wrote, one per line, and exits 0. A usage error (an unknown flag or roster, or a missing value) exits 2. A policy file that fails to load exits 1 with `hapi policy build: <file>: <problem>`.

**Builds are deterministic.** Keys come out in a fixed order, lists are sorted, and nothing holds a timestamp, so building twice from the same policy gives byte-identical files. That is how `mise run audit` detects a hand edit to a deployed file: `generated.drift` compares the deployed build/ with a fresh build, and fails on any path under it that a fresh build doesn't have ([docs/audit.md](audit.md#generateddrift)). Every emitter runs before anything is written, so a policy that an emitter refuses leaves the existing files untouched. `buildAll` only writes files; it never deletes any, so a file policy stops generating stays in build/ until you remove it, and `generated.drift` names it until then (H-156).

**From code**, `buildAll(policy, outDir, { roster, o11y })` in `src/generate/index.ts` writes the files and returns their paths. `o11y` says whether the observability profile runs, which turns on the o11y-gated MCP servers in Hermes's config. It defaults to the policy's `flags.otel.enabled` (off), so to build with Phoenix MCP set that flag, or pass `o11y: true` from code. The emitters are pure functions that return `{ filename: contents }`: `emitHermes(p, { o11y })`, `emitArchon(p, roster)`, `emitPi(p, roster)`, `emitEgress(p)` and `emitMcp(p)`, in `src/generate/{hermes,archon,pi,egress,mcp}.ts`. `src/generate/mcp.ts` also has `hermesMcpServers(p, zone, { o11y })`, a zone's Hermes `mcp_servers`, which Plan 04's hapi-research profile uses for the research zone. Apply a repo overlay first (`applyOverlay`, [docs/policy.md](policy.md#repo-overlays-factoryconfigyaml)) to build for that repo.

## The files

| File | What it is | From | Used by (`stack/compose.yaml`) |
|---|---|---|---|
| `build/hermes/config.yaml` | Hermes's `config.yaml` (Hermes v0.22.5 keys) | `budgets.yaml`, `flags.yaml`, `mcp.yaml`, `protected_paths.yaml`, `roles.yaml`, `rosters/anthropic.yaml` | Mounted read-only at `/opt/data/config.yaml` (`$HERMES_HOME`) in the `hermes` container |
| `build/archon/config.yaml` | Archon's global config, `~/.archon/config.yaml` (Archon v0.12.1): model tiers and aliases | `roles.yaml`, `rosters/<roster>.yaml` | Mounted read-only at `/.archon/config.yaml` (Archon's home in its container) in `archon` |
| `build/archon/archon.env` | The Archon container's environment | Spec §9.2 and §9.3 (no policy file) | The record of the six settings the `archon` service's `environment:` sets, and what the audit's `runtime.archon-env` holds the running container to. Compose doesn't read the file ([below](#buildarchonarchonenv)) |
| `build/pi/models.json` | Pi 1.3.0's model registry: `maxTokens` caps | `rosters/<roster>.yaml` | Mounted read-only at `PI_CODING_AGENT_DIR` |
| `build/pi/hapi-guard.json` | Settings for Plan 02's hapi-guard Pi extension | `protected_paths.yaml`, `budgets.yaml` | Mounted read-only at `PI_CODING_AGENT_DIR` |
| `build/egress/hermes.squid.conf` | Squid config for the `hermes` zone's egress proxy | `trusted_sources.yaml` | The `egress-hermes` container, read-only |
| `build/egress/archon.squid.conf` | Squid config for the `archon` zone's egress proxy | `trusted_sources.yaml` | The `egress-archon` container, read-only |
| `build/egress/research.squid.conf` | Squid config for the `research` zone's egress proxy | `trusted_sources.yaml` | The `egress-research` container, read-only (the research zone's own service arrives in Plan 04) |
| `build/mcp/hermes.mcp.json` | A standard `mcp.json` with the `hermes` zone's whole MCP catalog | `mcp.yaml` | The CI scanners (Plan 05) |
| `build/mcp/research.mcp.json` | A standard `mcp.json` with the `research` zone's whole MCP catalog | `mcp.yaml` | The CI scanners (Plan 05) |

Not compiled yet: `commands.yaml` (the Hermes `hapi-cmd-allow` hook arrives in Plan 04; Archon `allowed_tools` sit on workflow nodes, Plan 03), `approvals.yaml`, and `flags.yaml` apart from `otel.enabled`, which gates the o11y MCP servers (later plans). `mcp.lock.json` isn't compiled: `hapi mcp verify` reads it ([docs/policy.md](policy.md#mcplockjson)).

## `build/hermes/config.yaml`

Hermes runs as the coordinator (spec §9.1). These are the "defaults to flip on day one".

**Key names follow the pinned tag v0.22.5** (`hermes_cli/config_defaults.py` and `cli-config.yaml.example` there), not the spec's shorthand. Three differ:
- the spec's `cache_ttl` is **`prompt_caching.cache_ttl`**;
- `container_persistent` is **`terminal.container_persistent`**;
- `security.protected_instruction_files` is an on/off switch, and the file patterns go in **`security.protected_instruction_extra_patterns`**.

| Key | Value | What it does, and why |
|---|---|---|
| `model.provider`, `model.default` | `anthropic`, `claude-opus-5-5` | The main model: `roles.yaml`'s `hermes_main` tier in the anthropic roster (spec §12). An Anthropic Console key, never subscription OAuth (Global Constraints). |
| `agent.reasoning_effort` | `low` | That tier's effort (spec §12: Opus 5.5 at low–medium effort). |
| `agent.max_turns` | `60` | `budgets.yaml`'s `hermes_max_turns`. The default is unlimited (spec §9.1: 30–100). |
| `approvals.mode` | `manual` | Every dangerous command waits for the operator. Yolo and `mode: off` are forbidden by policy (spec §9.1); the audit's `runtime.hermes-no-yolo` checks it. |
| `approvals.cron_mode`, `unattended_mode`, `single_query_mode` | `deny` | Cron, webhook/API and `-q` runs have nobody to ask, so a dangerous command is refused at once (spec §9.1). These are Hermes's defaults; pinning them here lets the audit catch a change. |
| `skills.write_approval` | `true` | Every `skill_manage` write is staged for review (`/skills pending`). Without it, a prompt-injected session could persist instructions into future sessions (spec §9.1). |
| `skills.guard_agent_created` | `true` | Scans skills the agent writes. A scanner, not a boundary (spec §9.1). |
| `memory.write_approval` | `true` | Memory writes need approval: the same persistence risk as skills (spec §9.1). |
| `security.protected_instruction_files` | `true` | Writes to instruction files (AGENTS.md, CLAUDE.md, SOUL.md and more) ask for approval, even under yolo, and are refused when nobody can answer (spec §8.2, §9.1). |
| `security.protected_instruction_extra_patterns` | The protected file names, each with its letters as `[xX]` classes so case doesn't matter (`AGENTS.md` is `[aA][gG][eE][nN][tT][sS].[mM][dD]`): the agent instruction files, `mise.toml` and `.coderabbit.*` | The protected-path globs Hermes's gate can express. See [protected paths](#protected-paths-stay-strictest-wins). |
| `security.allow_lazy_installs` | `false` | No installing packages from PyPI at runtime when a backend is first used (spec §9.1, §11.6). |
| `plugins.isolation` | `host` | Third-party plugins run in a separate host process that reaches Hermes only through its plugin API (spec §9.1). |
| `auth.adopt_external_logins` | `false` | Hermes never borrows Claude Code or Codex CLI logins (spec §9.1). |
| `web.keyless_fallback`, `web.keyless_rescue` | `false` | No silent fallback to anonymous free-tier search backends (spec §9.1). |
| `prompt_caching.cache_ttl` | `auto` | Prompt caching with a 1-hour cache for human-paced sessions and 5 minutes for subagents and cron (spec §9.1, §12: caching on everywhere). |
| `terminal.container_persistent` | `false` | A container terminal backend starts fresh each session (spec §9.1, §11.3). Task 5 runs the `local` backend inside the Hermes container, which ignores this key; the container itself is the boundary. It is set so a switch to a container backend stays non-persistent. |
| `auxiliary.<slot>` (all 19 slots) | `anthropic` / `claude-haiku-5-5` | Every side task (compression, approval classifier, background review, curator, titles, vision, `/review` and the rest) runs on Haiku 5.5: `roles.yaml`'s `hermes_auxiliary` tier. An unset slot would run on the main model, Opus (spec §9.1, §12). |
| `delegation.provider`, `delegation.model` | `anthropic`, `claude-haiku-5-5` | Subagents run on Haiku 5.5 (spec §9.1). |
| `delegation.subagent_auto_approve` | `false` | A subagent's dangerous command is denied, never auto-approved (a child could otherwise write AGENTS.md with no human; `hermes_plugins.md`, issue #120000). Hermes's default, pinned. |
| `cron.model_provider`, `cron.model` | `anthropic`, `claude-haiku-5-5` | Cron jobs run on Haiku 5.5 (spec §9.1). |
| `hooks_auto_accept` | `false` | A new shell hook needs a one-time consent prompt; nothing registers silently (spec §9.1). |

### MCP servers (`mcp_servers`)

From `policy/mcp.yaml` (spec §10.1; [docs/mcp.md](mcp.md)): the hermes zone's **enabled** servers, sorted by name. In v1 that is **none**, so the key is left out, unless the observability profile runs (`flags.otel.enabled`, or `o11y: true` from code). Then it holds Phoenix MCP. Context7 is research-zone only and never appears here.

```yaml
mcp_servers:
  phoenix:
    command: npx
    args: [--yes, "@arizeai/phoenix-mcp@4.3.16"]
    env:
      PHOENIX_API_KEY: ${HAPI_MCP_PHOENIX_VIEWER_KEY}
      PHOENIX_DISCOVER_CONFIG: "false"
      PHOENIX_ENDPOINT: http://phoenix.hapi.internal:6006
    tools:
      include: [list-projects, get-project, ...]   # the 23 read-only tools
      prompts: false
      resources: false
    trust: untrusted
    elicitation: { enabled: false }
    sampling: { enabled: false }
```

| Key | Value | What it does, and why |
|---|---|---|
| `command`, `args` | `npx --yes <package>@<version>` | Runs the exact pinned version. It doesn't pin the dependency tree, and nothing checks the catalog's `package.integrity` at launch; the per-server image (`image` in the catalog, built in Plan 04) will replace it ([docs/mcp.md](mcp.md#open-items)). Until then the emitter refuses an entry that sets `image`, because this command would ignore it. |
| `env` | The catalog's `env`, keys sorted | Hermes passes a stdio server **only** these, plus a safe baseline (`PATH`, `HOME`, `LANG` and the like), so the server sees no other secret. A `secret:<name>` reference becomes `${HAPI_MCP_<NAME>}`, which Hermes resolves from its env at load time (the zone's env file, from `hapi secrets resolve`); no secret is in the file. Literals pass through; the [env allowlist](policy.md#the-env-allowlist) allows a literal only as a flag value or an endpoint, never a secret, and no entry may override the baseline (`PATH`, `HOME`) or set a launch-hijack variable. |
| `tools.include` | The catalog's `tools.include` | Only these tools are registered. They are exact names, never fnmatch patterns. |
| `tools.prompts`, `tools.resources` | `false` | The server's prompts and resources aren't offered to the model either. No catalog server needs them. |
| `trust` | `untrusted` | A call to a tool not marked read-only needs approval, and fails closed when unattended (spec §10.1). |
| `elicitation.enabled` | `false` | The server can't ask the user for input. Context7's backend can send an anonymous caller an elicitation that asks them to run a setup command (spec §10.1). |
| `sampling.enabled` | `false` | The server can't run completions on Hermes's model key. No catalog server needs it. |

The emitter checks the catalog again before it writes anything (the schema and `mcpIssues`), so a policy built in code can't emit a server the loader would refuse, such as one in the archon zone, a denied tool, a literal secret, an env name off its package's allowlist, or a `url` or env literal holding `${...}`. Then it checks each entry it built (`checkOwnRefs`): the only `$` allowed is the server's own `${HAPI_MCP_...}` references, as env values. Hermes v0.22.5 expands `${VAR}` and `${env:VAR}` in a server's `url`, `headers`, `args` and `env`, so any other `$` could hand the server Hermes's provider key or another server's key. That output check also covers any field the entries gain later, such as `headers`.

**No hooks yet.** Plan 01 emits no `hooks:` section. The `hapi-cmd-allow` hook script arrives in Plan 04, and a `fail_closed` hook pointing at a missing script would block every tool call.

**Not set yet:** a pinned web search backend (spec §9.1: "pin one search backend"), which comes with the search plugin choice in a later plan, and the Slack gateway settings (Plan 04, spiked in Plan 01 Task 13).

## `build/archon/config.yaml`

Archon is the run engine (spec §9.2). The file holds `tiers` and `aliases` only; workflows (Plan 03) carry budgets and tool lists on their nodes.

```yaml
tiers:            # the selected roster, verbatim
  small:  { provider: pi, model: anthropic/claude-haiku-5-5, effort: low }
  medium: { provider: claude, model: claude-sonnet-5-5, effort: medium }
  large:  { provider: pi, model: anthropic/claude-opus-5-5, effort: low }
aliases:          # one per Archon role, at its roles.yaml tier
  "@implement":       { provider: pi, model: anthropic/claude-opus-5-5, effort: low }
  "@implement-retry": { provider: pi, model: anthropic/claude-opus-5-5, effort: high }
  "@review":          { provider: claude, model: claude-sonnet-5-5, effort: medium }
  # ... and @planner, @planner-retry, @scout, @router, @eval-judge
```

- **Tiers** are the roster's `small`/`medium`/`large`, as `{provider, model, effort}` (Archon's `docs/reference/configuration.md`). A `pi` tier's model is a Pi ref `<vendor>/<model-id>`; a `claude` tier's is an Anthropic model id. Both pass through unchanged.
- **Aliases** name each role that runs in Archon: `@planner`, `@implement`, `@review`, `@scout`, `@router` and `@eval-judge` (`roles.yaml`, with `_` written as `-`). The list is every role in `ROLES` (`src/policy/types.ts`, where the `Role` type comes from) except `hermes_*`, so a role added there gets an alias without a second edit. A workflow says `@implement` or `large`, never a model id (spec §8.1, §12). Moving a role to another tier in `roles.yaml` moves its alias.
- **`-retry` aliases** exist for each role whose tier has a `retry_effort`: the same model at that effort. They encode "on failure, one retry at high effort before any change of model" (spec §9.2, §12).
- `hermes_main` and `hermes_auxiliary` run in Hermes, so they get no Archon alias.

## `build/archon/archon.env`

| Variable | Value | Why |
|---|---|---|
| `HOST` | `127.0.0.1` | Archon's server binds `0.0.0.0` by default and has no auth in SQLite mode, so it listens on loopback only (spec §9.2). |
| `ARCHON_TELEMETRY_DISABLED` | `1` | No Archon telemetry (spec §9.2). |
| `DO_NOT_TRACK` | `1` | The cross-tool telemetry opt-out, which Archon also honours (spec §9.2). |
| `PI_OFFLINE` | `1` | Pi makes no network calls of its own. **Critical:** without it, Pi installs the packages a repo's `.pi/settings.json` lists, even with extensions off (spec §9.3). It also stops catalog refreshes and update checks. |
| `PI_TELEMETRY` | `0` | No Pi install telemetry (spec §9.3). |
| `PI_CODING_AGENT_DIR` | `/opt/hapi/pi-agent` | Pi's agent directory. Task 5 mounts `build/pi` there **read-only**, so Pi reads this `models.json` and nothing in the container can change it (spec §9.3). The path is `PI_AGENT_DIR` in `src/generate/archon.ts`. |

These are the Global Constraints' Archon and Pi values; the audit's `runtime.archon-env` checks the running container's environment against them ([docs/audit.md](audit.md#runtimearchon-env)).

**They reach the container through `stack/compose.yaml`'s `environment:`, not this file.** Compose puts `environment:` above `env_file`, and the archon service's only `env_file` is the archon zone's secrets, so a secret named `HOST` or `PI_OFFLINE` could never override one; the secrets manifest refuses those names anyway ([docs/secrets.md](secrets.md#the-manifest-stacksecretsyaml)). The list lives in `ARCHON_ENV` (`src/generate/archon.ts`), which writes this file and which `serviceEnvironment` in `src/stack/env.ts` puts in the service's environment; `tests/stack/compose.test.ts` fails if the compose file and this file disagree on a single name or value. (Until Plan 01 Task 5's security fix pass, this file was the service's first `env_file`, where the zone's secrets file, read after it, could override it.)

## `build/pi/models.json`

```json
{
  "$comment": "Pi models.json: the output-token cap for each Pi model. Generated by `hapi policy build` from policy/rosters/anthropic.yaml. Do not edit it by hand: ...",
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-haiku-5-5": { "maxTokens": 64000 },
        "claude-opus-5-5": { "maxTokens": 64000 }
      }
    }
  }
}
```

- Every **Pi** model in the selected roster gets `maxTokens: 64000`, the output-token cap (spec §9.3: "maxTokens around 64K"; §12). Models are grouped by the vendor part of their Pi ref and sorted.
- It uses **`modelOverrides`** (Pi 1.3.0's `models.schema.json`): an override changes one field of a built-in model and keeps the rest of its catalog entry. A `models` entry would replace the model. Pi ignores an override whose id it doesn't know.
- `claude`-provider tiers run on Claude Code through the Agent SDK, not Pi, so they don't appear.
- **The `$comment` notice is safe for Pi 1.3.0.** Its loader (`ModelConfig.load` in `packages/coding-agent/src/core/model-config.ts` at the tag) checks the file against `ModelsConfigSchema`, a TypeBox object that doesn't forbid other keys, and then reads only `providers`. The published `models.schema.json` has no `additionalProperties: false` either.
- **[verify]** For a model whose provider allows fewer than 64000 output tokens, an override may raise Pi's request above that limit. The anthropic and budget rosters' Haiku 5.5 and Opus 5.5 aren't affected. Check the portable roster's GLM and Kimi output limits before the first portable run.

## `build/pi/hapi-guard.json`

The settings Plan 02's hapi-guard extension enforces inside every Pi worker (spec §9.3):

```json
{
  "$comment": "...",
  "session": "workers",
  "combine": "strictest",
  "protected_paths": { ".agents/**": "deny", ".archon/**": "deny", ".coderabbit.config.ts": "deny", ".coderabbit.yaml": "deny", ".coderabbit.yml": "deny", ".factory/**": "deny", ".github/**": "deny", ".pi/**": "deny", "AGENTS.md": "deny", "mise.toml": "deny" },
  "budgets": { "run_usd": 3 },
  "max_tokens": 64000
}
```

| Field | Meaning |
|---|---|
| `session` | The session kind these rules are for: `workers` (Pi inside Archon). |
| `combine` | `strictest`: a file is blocked if **any** glob matches it. See below. |
| `protected_paths` | Glob → `deny`, in the [glob syntax](policy.md#glob-syntax) of `src/policy/paths.ts`, sorted by glob. |
| `budgets.run_usd` | `budgets.yaml`'s per-run target (spec §3: ≤ $3). A repo overlay may lower it. |
| `max_tokens` | The same cap as `models.json`, for the guard's `before_provider_request` clamp (spec §9.3). |

## `build/egress/*.squid.conf`

One Squid config per egress zone (spec §10, §11.4). Each zone's containers sit on an internal-only network whose one way out is this proxy (`stack/compose.yaml`, [docs/runbooks/stack.md](runbooks/stack.md)), so **the proxy is the real network boundary**; the agents' own settings are a second layer.

**Every zone's proxy:**
- listens on port `3128`;
- serves only clients on the private container networks (`zone_clients`);
- refuses private, loopback, link-local, carrier-grade NAT, multicast and reserved addresses (`to_localnet`). Squid checks what a name **resolves to**, so a public name that points inside the network is refused too. The list includes:
  - `::/96`: the IPv6 unspecified address `::` (on Linux, connecting to it reaches the local host), the loopback `::1`, and the deprecated IPv4-compatible addresses `::a.b.c.d`. It stands for all three because no entry may cover another: Squid ignores a covered entry with a warning (`Ignoring ::1 because it is already covered by ::/96`), and a test keeps the list free of overlaps;
  - the NAT64 prefixes `64:ff9b::/96` and `64:ff9b:1::/48`, which a translator maps onto IPv4 addresses, private ones included. **The trade-off:** DNS64 synthesises addresses in `64:ff9b::/96` for IPv4-only sites, so on an IPv6-only host behind DNS64, every IPv4-only site is unreachable through every zone's proxy. Today's Docker networks are IPv4, so it has no effect here; the generated file says so too;
  - `2002::/16` (6to4: a relay reaches the IPv4 address embedded in it), `2001::/32` (Teredo, which embeds an IPv4 server and client), `100::/64` (discard-only) and `fec0::/10` (site-local, deprecated). See [the decision](#ranges-added-in-plan-01-task-5) below;
  - no `::ffff:0:0/96` entry for IPv4-mapped addresses. Squid holds every IPv4 address in its IPv4-mapped form, so the IPv4 ranges already cover `::ffff:10.0.0.1` and the rest. An `::ffff:0:0/96` entry would match **every** IPv4 address and refuse all IPv4 egress, as Squid 7.6 does when given one;
- **refuses a destination written as an IP address**, in any form (`ip_literal`, before any allow). A host is reached by name only, so the checks above always apply to what a name resolves to, and the allowlist (below) can't be matched through an address's reverse DNS. Its two patterns cover every form:
  - `^[0-9.]+$`: IPv4. Squid rewrites `0x7f.1`, `2130706433`, `127.1` and the IPv4-mapped `[::ffff:1.2.3.4]` to dotted form before it checks.
  - `:`: IPv6. Every IPv6 form, bracketed or mixed with IPv4, has a colon.

  A host name never matches: it has no colon, and its last label is never all digits. A pattern such as `^\[?[0-9a-f:.]+\]?$` would also refuse real names spelled only with hex digits, such as `cafe.de` or `bad.cafe`. The research zone has refused IP literals too since Plan 01 Task 5's security fix pass (ruling R1: Task 5's brief, amendment 4, says every zone);
- tunnels (`CONNECT`) only to port 443;
- caches nothing (`cache deny all`) and logs to stdout;
- runs no ICMP pinger (`pinger_enable off`): it needs raw sockets (`CAP_NET_RAW`), which the container drops, and it only measures network distances for cache peers;
- strips `X-Forwarded-For` and hides its version;
- ends with `http_access deny all`.

**Allowlisted zones (`hermes`, `archon`)** allow **only HTTPS tunnels** to the zone's allowlist, which is `zoneHosts` (`src/policy/zones.ts`): the zone's own hosts plus its tiers' hosts.
- Each host becomes a Squid `dstdomain` with a leading dot, so `slack.com` also covers `wss-primary.slack.com`.
- **The allowlist matches by name only** (`dstdomain -n`). Without `-n`, Squid matches a destination given as an IP address by the address's reverse DNS (PTR) name, and the address's owner controls that name. So anyone could point a PTR record at `api.anthropic.com` and get their address through. With neither `-n` nor the next rule, Squid 7.6 tunnels `CONNECT 203.0.113.7:443` once that address's reverse name is `api.anthropic.com`.
- **IP-address destinations are refused outright** (`ip_literal`, above), before the allow.
- A host under another listed host is folded into it (`api.github.com` into `.github.com`). The allowed names are the same, and Squid would otherwise warn.
- Plain HTTP is refused.

**Every host is checked before it is written**, because hosts are pasted into `squid.conf` and the proxy is the boundary. The generator checks again what the schema enforces, so a policy built in code that skipped the schema can't get past it:
- Each host is lowercased, as Squid matches domains case-insensitively, and must then be a plain domain name (`isHostname`, `src/policy/hosts.ts`). Anything else throws, such as a host holding a space or a newline, which could otherwise add a directive like `http_access allow all`.
- Each zone's tiers must be source tiers (`T0` to `T3`), because their names go into a comment.
- A forge host in the `archon` zone throws, in any case (`forgeDomain`, so `GitHub.com` counts): the Archon zone has no forge route (spec §4.3).
- `openWeb` on any zone but `research` throws.

**The research zone** (`openWeb: true`) allows any public host, by name: HTTPS tunnels to port 443, and plain HTTP: `http://` requests to port 80 (`http_proto port_80`). A destination written as an IP address is refused, public or private (`ip_literal`). Another scheme on port 80, such as `ftp://host:80/` or `https://host:80/`, is refused. Only hapi-research uses it (spec §10).

| Zone | Allowlist today |
|---|---|
| `archon` | `api.anthropic.com`, `files.pythonhosted.org`, `opencode.ai`, `openrouter.ai`, `pypi.org`, `registry.npmjs.org` |
| `hermes` | `api.anthropic.com`, `files.pythonhosted.org`, `github.com` (covers `api.github.com`), `openrouter.ai`, `pypi.org`, `registry.npmjs.org`, `slack.com`. No T2 hosts (`context7.com`, `deepwiki.com`): spec §10.1 made them research-only. |
| `research` | Open web, by name, minus the private ranges |

**Running it.** `stack/compose.yaml` starts Squid **as a non-root user** (`user: "584792:584792"`, the Ubuntu rock's own `_daemon_`) in the foreground (`/usr/sbin/squid-gnutls -N -f /etc/squid/hapi.conf`), with this file mounted read-only at `/etc/squid/hapi.conf`, on a read-only root with no capabilities. The config sets `pid_filename none`, because the container supervises the process, so a reload is a container restart (`mise run up` restarts the proxies when `build/` changes). Started as root, Squid drops privileges and then can't open `/dev/stdout` for its access log, and exits.

#### Ranges added in Plan 01 Task 5

The decision (H-009): **add** `::/96`, `2002::/16`, `2001::/32`, `100::/64` and `fec0::/10` to `to_localnet`. None of them reaches a public host a zone needs. Each can carry a request to an address the IPv4 ranges refuse, or is internal or unrouted: IPv4-compatible and 6to4 addresses embed an IPv4 address, Teredo embeds two, and site-local is internal. `2001::/32` is Teredo only: the documentation prefix `2001:db8::/32` and the rest of `2001:` are outside it. The documentation ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) were considered and left out. They reach nothing inside the host, and the allowlisted zones refuse every IP literal anyway. The integration tests check every new range in a real Squid, by a name planted to resolve into it, in the research zone, where only `to_localnet` can refuse it: since the research zone refuses IP literals too (R1), a literal no longer shows which rule refused it. Names planted to resolve to public addresses outside the ranges are not refused, the control.

**Kept out on purpose** (Task 3's evidence, so a later change doesn't undo them):
- **`::ffff:0:0/96`** (IPv4-mapped). Squid holds every IPv4 address in that form, so this entry matched every IPv4 address and refused all IPv4 egress in Squid 7.6. The IPv4 ranges already cover the mapped forms.
- **The `ip_literal` regex `^\[?[0-9a-f:.]+\]?$`**. It refuses real host names spelled only with hex digits and dots, such as `cafe.de` or `bad.cafe`. The two patterns in use (`^[0-9.]+$` and `:`) cover every IP literal without that.
- **`acl ... dst -n ::/0`**, as an "any IPv6" entry. Squid parses `::/0` as `::/128`, so it would match one address, not all of IPv6.

**Checked against a real Squid** (7.6, Alpine, 2026-10-26). `squid -k parse` is clean for all three files. Running each as a non-root user:
- `archon`: tunnels to `api.anthropic.com` (also written `API.Anthropic.COM`) and `registry.npmjs.org` worked. These were refused: `github.com`, `api.github.com`, plain `http://`, port 8443, and `pypi.org` when it resolved to `10.9.9.9`.
- `hermes`: `github.com`, `api.github.com`, `slack.com` and `wss-primary.slack.com` worked. `example.com` was refused. (The hermes zone still listed T2 then, and `context7.com` worked too; Task 3b removed it.)
- In **both**, with a reverse name planted so that `203.0.113.7` → `api.anthropic.com`, these were refused: `203.0.113.7`, `1.2.3.4`, `[2001:db8::1]`, `[::ffff:1.2.3.4]`, `[::ffff:203.0.113.7]`, `[::]`, `[64:ff9b::1.2.3.4]` and `2130706433`.
- `research` (before it refused IP literals): public HTTPS and HTTP worked. These were refused: `169.254.169.254`, a name resolving to `10.9.9.9`, `[::ffff:10.0.0.1]`, a name resolving to `::ffff:10.9.9.9`, `[::]` and a name resolving to `::`, `[64:ff9b::a00:1]` and a name resolving into `64:ff9b::/96`, `ftp://example.com:80/`, `https://example.com:80/`, and port 8080.

**On the stack, every run** (Plan 01 Task 5): `tests/stack/egress.int.test.ts` repeats these checks on the pinned image (Squid 7.7), on the real zone networks, with the names planted through the proxies' `/etc/hosts`. It also checks the PTR bypass against a control proxy with both defences removed. [What each test proves](runbooks/stack.md#what-the-tests-prove).

## `build/mcp/*.mcp.json`

One standard `mcp.json` per MCP zone (`hermes`, `research`), from `policy/mcp.yaml`, for the CI scanners (Plan 05; [docs/mcp.md](mcp.md#the-ci-scanners)). The archon zone gets no MCP servers, so it has no file.

```json
{
  "$comment": "mcp.json for the research zone's MCP servers, for the CI scanners. Generated by ...",
  "mcpServers": {
    "context7": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "@upstash/context7-mcp@4.3.0"],
      "env": { "CONTEXT7_API_KEY": "${HAPI_MCP_CONTEXT7_API_KEY}", "OTEL_SDK_DISABLED": "true" }
    }
  }
}
```

- **The whole catalog for the zone**, `enabled_when: o11y` servers included, whatever `o11y` is: the scanners vet what may run, not what runs today. So `hermes.mcp.json` always holds Phoenix.
- A stdio server is `{type: "stdio", command, args, env}`, the same command and env as Hermes gets. An http server is `{type: "http", url}`.
- **Secrets appear only as `${HAPI_MCP_...}` references**, never values.
- The `mcpServers` shape is the common one (Claude Code's `.mcp.json` uses it, and Snyk Agent Scan reads it). The scanners themselves arrive in Plan 05, which must confirm that they accept the top-level `$comment`.

## Protected paths stay strictest-wins

The binding rule ([docs/policy.md](policy.md#how-globs-combine)): a file's mode, per session kind, is the **strictest** across every glob that matches it, and `allow` in an entry means "this glob adds no rule". Every output keeps it.

- **No output holds an `allow` rule**, so no tool, whatever its own combining rule, can let one glob loosen a file another glob protects.
- **`hapi-guard.json`** holds `deny` rules only.
  - A glob whose `workers` mode is `allow` is left out.
  - `ask` becomes `deny`, because nobody answers a worker and nothing inside the Archon container is a human-approval boundary (spec §4.3).
  - Since every rule is `deny`, first-match, last-match and strictest-wins all give the same result. `combine: "strictest"` says so explicitly for Plan 02's enforcer.
- **Hermes's `protected_instruction_extra_patterns`** are basename `fnmatch` patterns, matched in every directory, so Hermes can't express our anchored globs. It gets a **superset**:
  - For each glob that adds a rule for a Hermes session (`interactive` or `unattended` isn't `allow`), it gets the glob's last segment.
  - The last segment means the same thing in `fnmatch`, because the glob syntax forbids `[`, `]` and `!`. Matching it everywhere covers at least every file the glob matches. `mise.toml` protects every `mise.toml`, and `docs/*.md` would become `*.md`.
  - Our globs ignore case and `fnmatch` on Linux doesn't, so each letter becomes a bracket class: `mise.toml` is emitted as `[mM][iI][sS][eE].[tT][oO][mM][lL]`. The brackets can only come from this folding, since the glob syntax forbids them.
  - **Directory globs can't be expressed** (`.agents/**`, `.archon/**`, `.factory/**`, `.github/**`, `.pi/**`). The generated file names them in a comment. **Plan 04's hapi-path-guard plugin** enforces them.
  - Hermes's gate **asks** in interactive sessions even where policy says `deny`. hapi-path-guard enforces `deny` there too.
- Tests in `tests/generate/` cover an overlapping pair (`.github/**: ask` with `.github/workflows/**: deny`) in both key orders, and check that the output is identical and still denies. For `hapi-guard.json` that includes a pair where the broader glob's `workers` mode is `ask`.

## When an upstream key changes

Emitters follow the **pinned** versions: Hermes v0.22.5, Archon v0.12.1, Pi 1.3.0 (spec §3). After an upgrade:
1. Re-check each key against the new tag.
2. Update the emitter and its test.
3. Note the change in the commit message.

A tool may ignore a renamed key or only warn about it (Archon reports unknown workflow keys as parse warnings, for example, and Hermes says nothing at all), so the audit also checks each tool's own reading of the deployed files, not only our files: `tools.archon-validate` and `tools.hermes-validate` ([docs/audit.md](audit.md#what-the-tool-checks-were-checked-against), which records what the pinned images said on 2026-10-27). Re-run them, and re-capture `tests/audit/fixtures/`, after an upgrade.
