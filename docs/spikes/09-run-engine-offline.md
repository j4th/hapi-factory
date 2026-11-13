# Spike 09: the run engine, offline

- **Plan 03 Task 1 (spikes T17–T20)**, for Tasks 2, 3, 4, 8, 9, 10, 11, 12, 13, 14 and 16, plus the operator's CodeRabbit account check (H-167) and design §7 items 5, 7 and 10 (pre-flight ruling m5). Run on 2026-10-31.
- **Where:** the operator's own Docker 29.9.2 (rootful: `SecurityOptions` has apparmor, seccomp and cgroupns, no rootless) and the operator's own systemd user manager (systemd 255), not hapi's. No secret, no model call: the keys were fake (`fake-not-a-key-…`), every run container but T18's install check (on a throwaway copy of egress-archon) had `--network none`, and the only "providers" were loopback fakes inside them. The network was used only to read two registry digests, pull the Bun sidecar image, build T18's image (BuildKit fetched the mise stage and mise downloaded Bun 1.4.2), make T18's lockfiles on the host (`bun install` from npm, `mise lock` from GitHub's release metadata), and let T18's keyless `bun ci` reach `registry.npmjs.org` through a throwaway copy of `egress-archon`'s Squid. Every Docker object was named `hapi-t17-*` to `hapi-t20-*` and labelled `org.hapi.t<n>=1`, every unit `hapi-t20-*`, and all were removed afterwards (the check is in Consequences).
- **Versions:** image `hapi-factory/archon:0.12.1` (`sha256:d2b20d06a4ef…`; Archon 0.12.1, Pi SDK 1.3.0, Bun 1.4.2, Claude Code 2.1.302 from `@anthropic-ai/claude-agent-sdk` 0.3.302); the host's mise 2026.10.9 and Bun 1.4.4; the Squid image `stack/compose.yaml:64` pins was already on this Docker.
- **Result: every spike ran, and each one changes a later task.**
  - **T17: Pi 1.3.0 has `before_agent_start`, and it moves `AGENTS.md` cleanly.** The hook, a variant that overrides the whole system prompt, and a `before_provider_request` rewrite all left no marker and none of Pi's template text in `system`, put the conventions after the work order, and sent the same bytes on all four sends. Pi also loads `/work/AGENTS.md` (it walks up to `/`) and `$PI_CODING_AGENT_DIR/AGENTS.md` (a writable tmpfs in the run container), and it tries five file names, not two (findings 1–4).
  - **T18: mise and Bun work offline in the run image, but not quite as written.** `mise install --locked` exits 1 because mise can't rewrite its shims in the read-only data dir, and switching the auto-installs off makes `mise run` quietly use the image's own Bun. The install through the proxy works, with `BUN_OPTIONS=--no-install` too, and reaches `registry.npmjs.org:443` and nothing else. The pins audit doesn't recognise `mise install` (findings 5–9).
  - **T19: as Task 11 pins them, emitClaude's managed settings stop the review reading its inputs.** With bypass mode disabled, Claude Code refuses to Read `/run/hapi/inputs/diff.patch`. A managed allow rule (or `additionalDirectories`) fixes it. Without the managed file, the repo's `.claude/settings.json` hook runs and `CLAUDE.md` reaches the model. And `result.json` holds only a 200-character preview of the review's output, so `REVIEW_OUTPUT_AT` can't be a path in it (findings 10–15).
  - **T20: the volume and timer work, with three corrections for Tasks 4 and 14.** A bind-backed volume on a missing directory fails at `docker run`, not at create. A timer needs `OnActiveSec` to tick at all. `disable --runtime` deletes a linked unit, so the next enable has to link it again (findings 16–19).
  - **CodeRabbit:** the operator's account is on an Advanced trial that ends 2026-11-10, with an "Agentic" key type. CodeRabbit's docs say the CLI has no API-key environment variable, so the key goes on argv (finding 20). `phases.coderabbit` stays off centrally.

## Setup

- **The harness:** spike 07's `go.sh`, `fin.sh` and `archon/`, and spike 08's `run16`, `run16.sh`, `build.ts`, `fake/`, `ext/`, `pi-fake/` and `wf/`, copied into `spikes/scratch/17/` and `spikes/scratch/19/` and never edited in place.
  - In each copy, `run16` became `run17` (or `run19`), pointed at its own `go.sh`, `fin.sh` and `src/sha-clean`.
  - Every `hapi-t15-*` object became `hapi-t17-*` (or `hapi-t19-*`), and the label `org.hapi.t15=1` became `org.hapi.t17=1` (or `org.hapi.t19=1`). The volumes and the chown helper got the label too.
  - Every `docker run` in the copies gained `--pull never` (ruling m35), and so did the two read containers.
  - `grep -rn 'hapi-t1[56]' spikes/scratch/17 spikes/scratch/19` printed nothing (`17/harness-check.txt`).
  - The run container is spike 07's: `--network none`, `--read-only`, `--user 1001:1001`, `--cap-drop ALL`, `no-new-privileges`, the four tmpfs mounts, and Archon's whole env (`ARCHON_ENV`, the git hardening, `BUN_OPTIONS=--no-install`, `PI_OFFLINE=1`).
- **T17:**
  - **The source repo** (`17/src/repo`, `9fbcbe70`): `AGENTS.md` holds `T17-AGENTS-MARKER: ask the user before every edit.`, and `sub/AGENTS.md` holds `T17-SUB-MARKER`.
  - **The workflows:** `t17-pi` is spike 16's `t16-pi` plus a first bash node that writes `T17-PARENT-MARKER` to `/work/AGENTS.md`. The Pi node (`anthropic/claude-haiku-5-5`, `allowed_tools: []`) depends on it and prompts `T17-WORK-ORDER-MARKER: reply with the single word OK.`. `t17-tool` is the same with `allowed_tools: [bash]`, and `t17-global` writes `T17-GLOBAL-MARKER` to `/opt/hapi/pi-agent/AGENTS.md` instead.
  - **The extension:** `ext/t17.ts`, built by the copied `build.ts` with `target: "node"` (`node:fs` and `node:path` only), switched by `T17_MODE`:
    - `none`: no handler that touches the prompt;
    - `hook`: a `before_agent_start` handler that drops every context file ending in `AGENTS.md` from `event.systemPromptOptions.contextFiles` and returns it as `message: { customType: "hapi-conventions", content: <repo-conventions source="AGENTS.md">…</repo-conventions>, display: false }`;
    - `hook-force`: the same message, plus `systemPrompt`: the rendered prompt with Pi's exact rendering of those files cut out;
    - `rewrite`: in `before_provider_request`, the same cut on `payload.system`, with the block appended to the first user message;
    - `hook-throw`: a `before_agent_start` handler that throws.
  - **The fakes:** `fake/server.py` (from spike 16's) answers every request with an error, `529 overloaded_error` here so that Pi retries (a 400 isn't retried, spike 08). For each request it logs where each marker sits (`system`, or a message index), which of Pi's template strings `system` still holds, whether the work-order marker comes before the wrapped block, the shapes of `system` and `messages` (types and lengths, no text), and the `sha256` of `json.dumps([system, messages])`. `fake/script.py` (from spike 16's) answers one `bash` tool call (`true`), then `OK`.
- **T18:** `spikes/scratch/18/`.
  - **The image** `hapi-t18-image` is the brief's Dockerfile with the digest filled in (Decision, Task 11). `hapi-t18-image2` adds `MISE_LOCKED=1`, `MISE_SHIMS_DIR=/tmp/mise-shims` and the three auto-installs set to `0`.
  - **The repo** `repo/`: `package.json` (`typescript` `7.0.2`), the `bun.lock` that `mise exec bun@1.4.2 -- bun install` made on the host, `check.ts`, a `mise.toml` with `bun = "1.4.2"` and `[tasks.check]`, and the `mise.lock` from `mise lock --platform linux-x64`, which locks four linux-x64 variants. `repo143/` is the same at `bun = "1.4.3"` with its lock. Both were made outside the checkout and copied in.
  - **The volumes:** `hapi-t18-work`, chowned with the chown helper's argv (`src/run/lifecycle.ts:225-228`), then filled by a `--user 1001:1001` helper running `tar -x -C /work`. Also `hapi-t18-work143` and a fresh `hapi-t18-work-full`.
  - **The proxy:** a copy of `build/egress/archon.squid.conf` (`mise run policy:build`, mode 0644), run as the brief's `hapi-t18-proxy` on `hapi-t18-out`, and connected to the internal `hapi-t18-net` with the alias `egress-archon`.
- **T19:** `spikes/scratch/19/`.
  - **The source repo** (`19/src/repo`, `9ed13570`) has these plants:
    - `CLAUDE.md` (`T19-CLAUDEMD-MARKER`);
    - `.claude/settings.json`, whose `SessionStart`, `UserPromptSubmit` and `PreToolUse` hooks run `touch /work/markers/hook`;
    - `.mcp.json`, a stdio server running `sh -c 'touch /work/markers/mcp; …'`;
    - `.claude/commands/x.md` (`T19-COMMAND-MARKER`).

    The prelude makes `/work/markers` before Archon starts.
  - **The workflows** have one node each: `provider: claude`, `model: claude-sonnet-5-5`, `mutates_checkout: false`, `maxBudgetUsd: 1.0`, and the `output_format` Task 11 Step 2 pins (`{verdict, findings, criteria}`). `t19-review` has `allowed_tools: [Read, Grep, Glob]`, and `t19-review-open` has no `allowed_tools`. `t19-review-nosrc` is `t19-review` plus `settingSources: []`.
  - **The env:** `ANTHROPIC_BASE_URL=http://127.0.0.1:18080`, `ANTHROPIC_API_KEY=fake-not-a-key-anthropic` (24 bytes) and `CLAUDE_API_KEY=fake-not-a-key-claude-0123456789` (32 bytes).
  - **The fake** `fake/anthropic.py`, from spike 16's `script.py`, streams answers with usage 1000 in and 2000 out:
    - first, a `tool_use`: `Bash` running `touch /work/markers/bash` (or, with `T19_FAKE_FIRST=read`, `Read` of `/run/hapi/inputs/diff.patch`);
    - then the schema's answer, as the `StructuredOutput` tool when the request lists it.

    A request with no tools gets a short text. It logs the path, the header names, each auth header's length, `model`, `tools[].name`, the markers seen in `system` and in the messages, and each tool result's error flag (its first 160 characters only when it is an error), never a key or the prompt's text.
  - **The managed settings for r4**, `settings/managed-settings.json`, are a spike fixture written by hand: `emitClaude` doesn't exist yet (Task 11 writes it). They are the object Task 11 Step 2's `claude.test.ts` pins, as `JSON.stringify(obj, null, 2) + "\n"`: `disableAllHooks`, `allowManagedHooksOnly`, `allowManagedPermissionRulesOnly`, `enableAllProjectMcpServers: false`, `enabledPlugins: {}`, `strictKnownMarketplaces: []`, `permissions: { deny: [Bash, Edit, MultiEdit, NotebookEdit, Task, WebFetch, WebSearch, Write], disableBypassPermissionsMode: "disable" }` and its `env`. `inputs/diff.patch` holds `T19-DIFF-MARKER`.
- **T20:** `spikes/scratch/20/`: the brief's volume commands, with the bind directory under `disk/`, and `units/` with `tick.sh`, `hapi-t20-poll.service` and `hapi-t20-poll.timer`.

## Evidence

Raw output is in `spikes/scratch/<n>/evidence/<run>/` (for T17 and T19, `stderr.txt`, `exit.txt`, and `out/` with `result.json`, `transcript.jsonl`, the fake's log and `debug.txt`). The reads are in `spikes/scratch/<n>/read*.txt`, and the versions in `spikes/scratch/17/baseline.txt`.

| Run | What happened |
|---|---|
| T17 read (`17/read*.txt`) | Pi `1.3.0`. `before_agent_start`'s event and result types are in `types.d.ts`, `AssistantMessage` in pi-ai's `types.d.ts`, and the loader and the rendering in `resource-loader.js` and `system-prompt.js` (findings 1–3). Archon's Pi provider passes neither `noContextFiles` nor `agentsFilesOverride` (`packages/providers/src/community/pi/resource-loader.ts:87-106`; its comment at :70-73 says it "leaves context-file discovery to Pi"). |
| T17 `none` (`17/evidence/t17-none/`) | Four sends (Pi's three retries of a 529), one hash (`2b309328…`). `T17-AGENTS-MARKER` and `T17-PARENT-MARKER` are in `system`; `T17-SUB-MARKER` is nowhere; the work order is `messages[0]`. All five template strings are in `system`. `system` is one text block (1922 characters, `cache_control: ephemeral`). |
| T17 `hook` | `before_agent_start` saw `context_files: ["/work/AGENTS.md", "/work/repo/AGENTS.md"]` and moved both. The rendered prompt went from 1922 to 1620 characters, with no marker and no template text. Four sends, one hash (`05239038…`): no marker in `system`, both markers in `messages[1]` (the hook's message, a user message), the work order in `messages[0]` before it. The node then failed on the fake's 529, as every run against `server.py` did. |
| T17 `hook-force` | The same as `hook`, byte for byte: the same hash, `05239038…`. |
| T17 `rewrite` | `before_provider_request` found the exact rendering in the one system block on every send (`hit: true`) and appended the block to `messages[0]`. Four sends, one hash (`cb65c54f…`): no marker or template text in `system`, and the work order before the block in `messages[0]`. |
| T17 `hook-tool` (`script.py`) | **Completed.** Two requests, a bash turn then `OK`. `system` had the same hash on both (`54e517cb…`), with no marker and no template text. `turn_end`: `stopReason` `toolUse` with content `[toolCall]`, then `stop` with `[text]`. |
| T17 `global` | A bash node wrote `/opt/hapi/pi-agent/AGENTS.md`. **`T17-GLOBAL-MARKER` is in `system`**, beside `T17-AGENTS-MARKER`. |
| T17 `hook-throw` | `Node 'work' failed: provider reported unknown: Pi extension '/opt/hapi/pi-agent/extensions/t17.js' failed during 'before_agent_start': T17: hook-throw`. The fake got no request. |
| T18 digests (`18/evidence/digests.txt`) | `jdxcode/mise:2026.10.9` resolves: index `sha256:07fc362c08135a926cbb1466470d9af10e89c9aa92859831c0ded2f2249bae7d`. `oven/bun:1.4.4-slim` index: `sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`. |
| T18 settings (`settings-all.txt`, `settings-doctor.txt`) | `mise settings ls --all` lists `offline`, `trusted_config_paths`, `locked`, `exec_auto_install`, `task.run_auto_install` and `not_found_auto_install`. The dirs aren't settings: `mise doctor` shows `data: /opt/hapi/mise`, `cache: /opt/hapi/mise-cache`, `shims: /opt/hapi/mise/shims`. |
| T18 offline 1.4.2 (`offline/out.txt`) | `2026.10.9 linux-x64 (2026-10-13)`. **`install 1`**: `bun@1.4.2 … already installed`, then `failed to rebuild user shims … Read-only file system (os error 30) at path "/opt/hapi/mise/shims/.mise-shims-stage-…"`. `1.4.2`, `check ok`, `check 0`. Wrote `$HOME/.local/state/mise/incomplete-installs/.migrated`. 0.26 s in all. |
| T18 shim probe (`offline/probe-shims.txt`) | With `MISE_SHIMS_DIR=/tmp/mise-shims`: `install 0`, with shims `bun` and `bunx` in `/tmp`. `mise install --locked --dry-run-code` exits 0, `mise ls --missing` exits 0 and prints nothing, and `mise exec -- bun --version` prints `1.4.2`. |
| T18 offline 1.4.3 (`offline-143/out.txt`) | `install 1` in 23 ms, `check 1` in 26 ms and `exec 1` in 26 ms, each with `Failed to install core:bun@1.4.3: Read-only file system (os error 30)`. `--dry-run-code` exits 1 in 17 ms (`bun@1.4.3 ⇢ would install`). **`mise ls --missing` exits 0** while it prints `bun 1.4.3 (missing)`. No hang. |
| T18 auto-install off (`offline-v2/out.txt`, `hapi-t18-image2`) | 1.4.2: `install 0`, `check 0`. **1.4.3: `dry-run-code 1` and `install 1`, but `mise run check` printed `1.4.2`, `check ok`, `check 0`**: it ran the image's `/usr/local/bin/bun`. |
| T18 the settings Task 11 gets (`offline-v3/out.txt`) | The brief's image plus `MISE_SHIMS_DIR` and `MISE_LOCKED=1` (as `-e`, standing in for two more `ENV` lines). 1.4.2: `dry-run-code 0`, `install 0`, `check 0`, `exec 0`. 1.4.3: `dry-run-code 1`, `install 1`, `check 1`, `exec 1`, each within 30 ms. |
| T18 `ci`, the brief's six `-e` (`ci/out.txt`, `ci/proxy.log`) | `names 1`, `bun install v1.4.2`, `+ typescript@7.0.2`, `ci 0`, `tsc 0`. The proxy logged two `TCP_TUNNEL/200 CONNECT registry.npmjs.org:443` and nothing else (its other line is the readiness probe from 127.0.0.1). Files under `$HOME/.bun/install/cache/`. |
| T18 `ci-full`, all of `serviceEnvironment("archon")` and runArgs' tmpfs sizes (`ci-full/`) | The env had `BUN_OPTIONS=--no-install GIT_CONFIG_COUNT=13 PI_OFFLINE=1`. **`ci 0`, `tsc 0`.** `names 0`: the only key-shaped names were `GIT_CONFIG_KEY_0` to `_12`. 531 files (31 MB) in `$HOME/.bun`, and `/tmp/.<hex>-0.hm`. Two more CONNECTs, both to `registry.npmjs.org:443`. |
| T18 pins audit (`pins-audit.txt`) | `dockerfileImages` lists the `jdxcode/mise:2026.10.9@sha256:07fc…` FROM with no stages, the archon FROM with stages `[mise]`, and `COPY --from=mise`. **`installs("mise install bun@1.4.2")` returns `[]`**, and so do `mise install bun`, `mise install bun@latest` and `mise install --locked`. |
| T18 sidecar (`sidecar/out.txt`) | `docker pull oven/bun:1.4.4-slim@sha256:1846adf2…`, then the hardened run with `server.ts` on Bun's default host: `ok`, `exit 0`, no `EROFS`. The image's `bun --version` prints `1.4.4`, its entrypoint is `/usr/local/bin/docker-entrypoint.sh`, and its config sets no user. |
| T19 read (`19/read*.txt`) | The node schema, the Claude provider's options, Claude Code's managed-settings path, and where the output lands (findings 10–15). `find /app … -name configuration.md` found nothing. The brief's `/etc/claude-code/[A-Za-z_.-]+` grep found nothing, because the binary builds the path from `"/etc/claude-code"` (`read3.txt`). |
| T19 r1: `allowed_tools: [Read, Grep, Glob]` (`19/evidence/t19-r1/`) | **Completed.** `tools: [Glob, Grep, Read, StructuredOutput]`, and `x-api-key` was 24 bytes (`ANTHROPIC_API_KEY`). The Bash `tool_use` came back `No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.` `T19-CLAUDEMD-MARKER` was in a message, not in `system`. **`/work/markers/hook` exists**, and there was no `bash` or `mcp` marker. The output was the schema's answer. `total_cost_usd` 0.066 (three requests, one an auxiliary call with no tools). |
| T19 r2: no `allowed_tools`, the deny bound at `$HOME/.claude/settings.json` | Completed. 21 tools: `Agent, CronCreate, CronDelete, CronList, DesignSync, EnterWorktree, ExitWorktree, Glob, Grep, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, StructuredOutput, TaskStop, WebFetch, WebSearch, Workflow`. No Bash, Write or Edit; `NotebookEdit` and `WebFetch` are there. The CLAUDE.md marker came through, the `hook` marker exists, and there was no `bash` or `mcp` marker. 0.066. |
| T19 r3: the same deny as managed settings | The same as r2, tool for tool. |
| T19 r4: emitClaude's file at `/etc/claude-code/managed-settings.json`, Read of the diff | Completed. `tools: [Glob, Grep, Read, StructuredOutput]`. No auxiliary request. **No `hook` marker**, and no marker of any kind. **The Read came back an error: `Claude requested permissions to read from /run/hapi/inputs/diff.patch, but you haven't granted it yet.`** The CLAUDE.md marker came through. 0.044. |
| T19 r4a: plus `permissions.additionalDirectories: ["/run/hapi/inputs"]` | The Read returned the diff (`has_diff_marker: true`, no error). No marker. |
| T19 r4b: plus `permissions.allow: ["Read(//run/hapi/inputs/**)"]` | The same as r4a. |
| T19 r5: r4b's file, and `settingSources: []` on the node | **No CLAUDE.md marker** in any request. The Read returned the diff, and there was no marker. 0.044. |
| T19 r6: r4b's file, default sources, Task 8's `review.sh` strip and `chmod a-w` | The clone checked out without `.claude/`, `CLAUDE.md` or `.mcp.json`, read-only (`dr-xr-xr-x`, files `-r--r--r--`). Completed. No CLAUDE.md marker and no marker; the Read worked. |
| T19 big: r5 with a 62,149-byte answer | `result.json`'s `outputPreview` is 203 characters (200, then `...`). The transcript's `StructuredOutput` `rawInput` is 62,150 bytes as JSON, with the fake's sha256 (`1d101b71…`). Archon's `remote_agent_workflow_events` `node_completed` row holds `node_output` at 62,149 characters, the same sha256, not truncated. |
| T19 validate (`t19-validate/out/validate.txt`) | `validate workflows <w> --json` for all three: `valid: true`, `issues: []`, no warnings. |
| T19 hosts | No run's stdout or stderr names a host. The fake saw only `POST /v1/messages?beta=true`. |
| T20 volume (`20/evidence/volume/part1.txt`, `part2.txt`) | `volume create` exited 0, the chown helper 0. The write's sum and the read-only read-back's sum are both `41df0be7…`. The host's `ls` gives `Permission denied`; the host `rm` gives `cannot remove '…/hapi-t20-work/repo': Permission denied`, `host rm 1`. The helper's `find /w -mindepth 1 -delete` exited 0 and left only `/w`. `volume rm`, then `rmdir 0`. |
| T20 missing device (`volume/missing.txt`) | `volume create` exited 0. `docker run` exited 127: `Error response from daemon: error while mounting volume '/var/lib/docker/volumes/hapi-t20-missing/_data': failed to mount local volume: mount <dir>/disk/missing:/var/lib/docker/volumes/hapi-t20-missing/_data, flags: 0x1000: no such file or directory`. No container was left. |
| T20 timer (`20/evidence/timer/`) | `link --runtime`, then `enable --runtime --now`: `NEXT -`, and **0 ticks in 70 s**. `disable --runtime --now` **removed the linked timer itself**, so after adding `OnActiveSec=5s` and `daemon-reload`, `enable` failed: `Unit file hapi-t20-poll.timer does not exist.` After a second `link --runtime`, **3 ticks in 70 s**, at +5, +36 and +67 s. |
| T20 env (`timer/env-checks.txt`) | Both variables: `active`, 0. Only `XDG_RUNTIME_DIR`: `active`, 0. Only `DBUS_SESSION_BUS_ADDRESS`: `active`, 0. Neither: `Failed to connect to bus: No medium found`, 1. `stop hapi-t20-never.timer`: `Failed to stop hapi-t20-never.timer: Unit hapi-t20-never.timer not loaded.`, **5**, with the full env and with only `XDG_RUNTIME_DIR`. `is-active` on it: `inactive`, 4. The shell sets both variables. |
| T20 teardown (`timer/teardown.txt`) | The second `disable --runtime --now` logged no "Stopped" line. After the service's link was removed and the daemon reloaded, the timer failed (`Unit to trigger vanished`, result `resources`). `reset-failed` cleared it. After that, `list-unit-files` and `list-units --all` show nothing. |

## Findings

1. **Pi 1.3.0 has `before_agent_start`.** VERIFIED (T17 read, `hook`, `hook-tool`, `hook-throw`).
   - **The event** (`pi-coding-agent/dist/core/extensions/types.d.ts:720-742`):
     - `type: "before_agent_start"`;
     - `readonly systemPrompt: string`, "rendered from systemPromptOptions and earlier handler changes";
     - `systemPromptOptions: NormalizedBuildSystemPromptOptions`, "Mutable prompt sections. Later handlers observe mutations made by earlier handlers";
     - then either `messageType: "user"` with `prompt: string` and `images?: ImageContent[]` (:728-734), or `messageType: "custom"` with `message: CustomMessage` (:736-740).

     The live event's keys were `images, messageType, prompt, systemPrompt, systemPromptOptions, type`. `NormalizedBuildSystemPromptOptions` (`core/system-prompt.d.ts:37-50`) holds, among others, `contextFiles: Array<{ path: string; content: string }>`, `appendSystemPrompt`, `sections`, `forceSystemPrompt` and `cwd`.
   - **The result** (`types.d.ts:1125-1129`): `{ message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">; systemPrompt?: string }`, where `systemPrompt` replaces "the complete system prompt for this turn". The registration is `on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>)` (:1207).
   - **What Pi does with it** (`core/extensions/runner.js:1121-1164`, `core/agent-session.js:1449-1499`):
     - it runs the handlers on a copy of the base options, and uses the copy, with any mutation, for the run;
     - a returned `systemPrompt` becomes `forceSystemPrompt`;
     - each returned `message` is pushed after the user's prompt, as a `custom` message, which `convertToLlm` sends as a user message (`core/messages.js:89-96`).

     It fires once per prompt. The stripped prompt held for every retry (four sends, one hash) and through a tool turn (`hook-tool`).
   - **A throw fails the node**, with no request sent: `Pi extension '<path>' failed during 'before_agent_start': <message>` (`hook-throw`). The runner catches the throw and emits it as an extension error (`runner.js:1151-1160`), and Archon turns that into the node's failure.
2. **Which context files Pi loads, and in what order.** VERIFIED (T17 read; `none`; `global`).
   - **In each directory, the first of `["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` that is a regular file** (`core/resource-loader.js:115-135`; the list is :116). A directory or an unreadable file is skipped, and the next name is tried.
   - **The agent dir first:** `loadContextFileFromDir(agentDir)`, where `agentDir` is `$PI_CODING_AGENT_DIR` (`resource-loader.js:165-174`; `config.js:491-497`). So `/opt/hapi/pi-agent/AGENTS.md` is read, and a bash node planted one there (`global`).
   - **Then it walks up from cwd to `/`**: `while (true) … if (parentDir === currentDir) break` (:177-193). Each directory's file goes in root first (`unshift`, :186), skipping a linked worktree's shadowed copy (:145-164). So `/work/AGENTS.md` loads, before `/work/repo/AGENTS.md` (`none`). A subdirectory's file (`sub/AGENTS.md`) isn't loaded.
   - **The order is the agent dir's file, then `/`'s, …, `/work`'s, `/work/repo`'s.**
   - `noContextFiles` and `agentsFilesOverride` exist (:465-474), but Archon's Pi provider sets neither (`community/pi/resource-loader.ts:87-106`).
3. **The exact rendering.** VERIFIED (T17 read; `hook` and `rewrite` removed exactly this, leaving no template text).
   - `core/system-prompt.js:25-30`:

     ```js
     function renderProjectContext(contextFiles) {
         return [
             "Project-specific instructions and guidelines:",
             ...contextFiles.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`),
         ].join("\n\n");
     }
     ```

   - `:99-100` adds it as the section `project_context` only when `contextFiles` isn't empty. `:115-119` wraps every section but the preamble as `<${name}>\n${content}\n</${name}>`, and pi-ai's `getSystemMessageText` (`dist/utils/text.js:11-18`) joins the non-empty parts with `"\n\n"`. The sections come in this order: `preamble`, `tools`, `rules`, `docs`, `addendum`, `project_context`, `skills`, `cwd`, then custom ones.
   - **So one context file at `P` with text `C` puts exactly this in the system prompt**, right after the `docs` (or `addendum`) section and before `\n\n<cwd>\n…\n</cwd>`:

     ```text
     \n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="P">\nC\n</project_instructions>\n</project_context>
     ```

     `C` is the file as read, BOM stripped, so its own trailing newline stays before the template's `\n`. Several files are joined inside with `\n\n`, in load order. On the Anthropic wire, `system` was one text block with `cache_control: ephemeral`.
4. **The types `turn_end` reads.** VERIFIED (T17 read; `hook-tool`'s `turn_end`).
   - `pi-ai/dist/types.d.ts:362-393`, `AssistantMessage`: `content: (TextContent | ThinkingContent | ToolCall)[]` (:364) and `stopReason: StopReason` (:376). There is also `errorMessage?: string` (:378).
   - `:301`: `export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";`. That's **seven** values, not the five the plan quotes from pi-mono.
   - `TextContent` is `{ type: "text"; text: string; textSignature?: string }` (:246-250). `ThinkingContent` is `{ type: "thinking"; thinking: string; … }` (:251-259). `ToolCall` is `{ type: "toolCall"; id; name; arguments; … }` (:265-278).
   - `types.d.ts` imports these from pi-ai (`core/extensions/types.d.ts:11`).
5. **mise runs offline in the image, with two fixes.** VERIFIED (T18 offline runs).
   - `mise --version` prints `2026.10.9 linux-x64 (2026-10-13)`, and `mise run check` runs Bun 1.4.2 from the image (`check ok`, `check 0`).
   - **But `mise install --locked` exits 1** when everything is installed: mise rebuilds its shims under the data dir after every install, and the data dir is read-only. With `MISE_SHIMS_DIR` on a writable path it exits 0. `mise install --locked --dry-run-code` writes nothing, and exits 0 when the pins are in the image and 1 when one isn't.
   - **A pin the image lacks fails fast and fails closed** with the default auto-installs: `install`, `run` and `exec` all exit 1 within 30 ms, naming `core:bun@1.4.3`. The message is the read-only data dir's (`Read-only file system (os error 30)`), not "offline": mise tries to write before it would download.
   - **Turning the auto-installs off fails open.** With `MISE_TASK_RUN_AUTO_INSTALL=0` (and the exec and not-found ones), `mise run check` on the 1.4.3 pin quietly ran the image's own `/usr/local/bin/bun` 1.4.2 and passed. `mise ls --missing` exits 0 even when it lists a missing tool, so its exit code is no gate either.
   - **(d) What mise writes:** `$HOME/.local/state/mise/` (`incomplete-installs/.migrated`, `tracked-configs/<hash>`), and the shims in `MISE_SHIMS_DIR` when it is set. Nothing it writes on a tmpfs is executed: Bun runs from `/opt/hapi/mise/installs` in the image, and `tsc` from `/work`. So the `noexec` tmpfs is no obstacle (H-208).
6. **The keyless install through the proxy works**, with the archon service's whole env. VERIFIED (T18 `ci`, `ci-full`).
   - `mise exec -- bun ci --frozen-lockfile --ignore-scripts` exited 0 and installed `tsc`, both with only `proxyEnv("archon")` and with every `-e` of `serviceEnvironment("archon")` plus runArgs' tmpfs sizes (ruling m3).
   - **`BUN_OPTIONS=--no-install` doesn't break `bun ci`**, so nothing needs to clear it.
   - **(g)** The proxy saw `CONNECT registry.npmjs.org:443` and nothing else. Bun needed no setting: its cache went to `$HOME/.bun/install/cache` (31 MB for TypeScript, inside the 256 MB `$HOME` tmpfs).
   - The env holds no key. But the brief's check, `grep -i -E "key|token|secret"` over the names, matches `GIT_CONFIG_KEY_0` to `_12` (`names 0`).
7. **The digests.** VERIFIED (T18 digests). Both tags resolve, so the release-binary fallback wasn't needed:
   - `jdxcode/mise:2026.10.9@sha256:07fc362c08135a926cbb1466470d9af10e89c9aa92859831c0ded2f2249bae7d`;
   - `oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`. Hardened, it served and fetched `ok` and exited 0, with no `EROFS` (f).
8. **The pins audit doesn't know mise.** VERIFIED (T18 pins audit).
   - `dockerfileImages` sees the mise stage with its digest, and `COPY --from=mise` as a stage reference.
   - But `installs()` (`src/audit/checks/pins.ts:89-139`) has no `mise` installer, so `mise install bun@1.4.2`, and unpinned `mise install bun` or `bun@latest` too, return `[]`: neither pinned nor flagged. The brief's expectation ("`installs` says it is pinned") doesn't hold.
9. **Squid as `egress-archon`.** VERIFIED (T18 proxy). The brief's throwaway, on the archon zone's generated config, allowed the npm CONNECT and logged nothing else. Its refusals weren't exercised.
10. **The keys a Claude node takes.** VERIFIED (T19 read; r1–r6; validate).
    - **The node's keys** (`packages/workflows/src/schemas/dag-node.ts:209-296`):
      - `output_format` (:221);
      - `allowed_tools` and `denied_tools` (:222-223);
      - `maxBudgetUsd: z.number().positive()` (:256);
      - `systemPrompt` (:259);
      - `settingSources: z.array(z.enum(["project", "user"]))` (:266; `SETTING_SOURCES`, `packages/paths/src/skills.ts:127`);
      - `mutates_checkout` (:282), "a post-run tree-integrity assertion … fails the node … if the snapshot changed": a check after the node, not a write block;
      - `hooks`, `mcp`, `skills`, `plugins`, `effort`, `fallbackModel`, `betas` and `sandbox`.
    - **`assistants.claude`'s keys** (`packages/providers/src/claude/config.ts:10-34`, `z.strictObject`): `model`, `settingSources` and `claudeBinaryPath`. There is no budget key.
    - **How the provider maps them** (`packages/providers/src/claude/provider.ts`):
      - `allowed_tools` becomes the SDK's `tools`, the whole toolset (:718-722), so r1's model saw only `Glob, Grep, Read, StructuredOutput`;
      - `denied_tools` becomes `disallowedTools` (:725-727);
      - `output_format` becomes `outputFormat: { type: "json_schema", schema }` (:829-834), and Claude Code offers it as the tool `StructuredOutput`;
      - `maxBudgetUsd` passes through (:837-839);
      - every session gets `permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true` (:969-970).

      All three workflows validate with no warning.
11. **The review's env and key.** VERIFIED (T19 r1–r6).
    - With both keys set, the wire's `x-api-key` was 24 bytes, `ANTHROPIC_API_KEY`'s length, in every run.
    - `CLAUDE_API_KEY` is copied to `ANTHROPIC_API_KEY` only when the latter is unset (`provider.ts:245-247`).
    - Claude Code's base URL comes from `ANTHROPIC_BASE_URL`, and `CLAUDE_BIN_PATH` (already in `ARCHON_ENV`) names its binary.
    - Claude Code writes `$HOME/.claude.json` and `$HOME/.claude/{projects,session-env,sessions,backups}`, and nothing in `/work/repo`: `git status --porcelain --ignored` was empty after every run.
12. **What the repo's files do to the review.** VERIFIED (T19 r1–r6).
    - **With Archon's default sources** (`['project', 'user']`, `dag-node.ts:261-266`):
      - the repo's `.claude/settings.json` hooks **ran** (`/work/markers/hook`; r1, r2 and r3);
      - `CLAUDE.md` reached the model as part of a message (r1–r4).
    - **`.mcp.json`'s server never started** (no `mcp` marker in any run), and the command file's marker never reached a request.
    - The managed file stops the hooks (r4: `disableAllHooks`). `settingSources: []` on the node stops `CLAUDE.md` (r5). Task 8's strip alone stops both, with default sources, and Archon completes on a read-only checkout (r6).
    - Not run: `CLAUDE.local.md` and a nested `sub/CLAUDE.md`. The strip's `!CLAUDE.md` (no slash) matches at any depth.
13. **Claude Code's settings paths.** VERIFIED (T19 read; r3, r4).
    - **On Linux the managed settings are `/etc/claude-code/managed-settings.json`**: the binary's directory is `/etc/claude-code`, its `default:` case (beside macOS's `/Library/Application Support/ClaudeCode` and Windows' `C:\Program Files\ClaudeCode`). It also knows `managed-settings.d`.
    - Bound read-only there, the file took effect: r4 had no hook marker, and no auxiliary request (its `env` removed it; which of the three variables did wasn't isolated).
    - The user file `$HOME/.claude/settings.json`, bound read-only, took effect too (r2).
    - Every key of emitClaude's object appears in Claude Code 2.1.302's binary (`read2.txt`): `disableAllHooks` 36 times, `allowManagedHooksOnly` 29, `allowManagedPermissionRulesOnly` 17, `enableAllProjectMcpServers` 10, `enabledPlugins` 59, `strictKnownMarketplaces` 22, `disableBypassPermissionsMode` 12, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 30, `DISABLE_AUTOUPDATER` 9, `DISABLE_TELEMETRY` 12, `CLAUDE_CODE_ENABLE_TELEMETRY` 12. None is unknown, so none is dropped.
14. **Task 11's managed file blocks the review's inputs (m4).** VERIFIED (T19 r4, r4a, r4b, r5, r6).
    - With `disableBypassPermissionsMode: "disable"`, Archon's `bypassPermissions` falls back, without an error, to the default mode. There a Read outside the working directory needs a grant, and an unattended session can't give one: `Claude requested permissions to read from /run/hapi/inputs/diff.patch, but you haven't granted it yet.`
    - `allowManagedPermissionRulesOnly` doesn't drop `allowed_tools`, since that is the toolset (`tools`), not a permission rule.
    - A managed `permissions.allow: ["Read(//run/hapi/inputs/**)"]` (r4b) or `permissions.additionalDirectories: ["/run/hapi/inputs"]` (r4a) lets the Read through, and the rest of the file still holds (no hook, no marker).
15. **`result.json` holds only a preview of the review.** VERIFIED (T19 r1, big).
    - The only copy is `run.nodes[<i>].outputPreview`, for the node whose `nodeId` is `review`. It is the output's JSON text, cut at 200 characters with `...` added (`packages/cli/src/commands/workflow.ts:3998-4001`, `outputPreviewOf`). r1's 185-character answer fit; the 62 KB one didn't.
    - **The whole output is in the transcript**, which Task 8 already copies out for review runs. It is the last `transcript.jsonl` row with `type: "provider_event"`, `step: "review"`, `event.type: "tool_call"` and `event.name: "StructuredOutput"`, as `event.rawInput`: a JSON object, not a string. At 62,149 bytes it was intact, with the fake's sha256.
    - It is also, intact, in Archon's `archon.db` (`remote_agent_workflow_events`, the `node_completed` row's `data.node_output`, a string). The 32 KiB cap (`dag-executor.ts:3295`) applies to bash and script output only.
    - Not run: a schema re-ask (`dag.structured_output_reask`), which would leave more than one `StructuredOutput` row.
16. **A bind-backed run volume, end to end.** VERIFIED (T20 volume).
    - The argv is `docker volume create --opt type=none --opt o=bind --opt device=<dir>/<volume> --label … <volume>`, options before the name.
    - The host directory is made `0700` by the host user. The chown helper (`src/run/lifecycle.ts:225-228`'s argv, on `/w`) then makes it uid 1001.
    - A write as 1001 and a read through a read-only mount (the copy-out helper's shape, `src/run/copyout.ts:89-96`) gave the same sha256.
    - The host user can neither list nor remove what's inside. The helper's `find /w -mindepth 1 -delete`, as 1001, empties it. Then `docker volume rm`, and `rmdir` of the empty directory works.
    - On this rootful daemon uid 1001 is the host's `hapi` account, so the files were briefly hapi's. On hapi's rootless daemon it is a subuid (design §3.1); not run here.
17. **A missing bind directory fails at `docker run`, not at create.** VERIFIED (T20 missing device). `volume create` succeeds. The run fails with exit 127, `error while mounting volume '<data root>/volumes/<volume>/_data': failed to mount local volume: mount <dir>:<data root>/volumes/<volume>/_data, flags: 0x1000: no such file or directory`, before any container starts.
18. **The timer.** VERIFIED (T20 timer).
    - `OnUnitActiveSec` alone never fires: the service has never been active, so 0 ticks in 70 s. With `OnActiveSec=5s` too, the first tick came at +5 s, then every ~31 s.
    - **`systemctl --user disable --runtime` deletes a unit that `link --runtime` made** (`Removed "/run/user/<uid>/systemd/user/hapi-t20-poll.timer"`). So the next `enable` fails until the unit is linked again.
    - **`disable --runtime --now` didn't reliably stop the timer:** the second time, no "Stopped" was logged. Removing the service's link then failed the timer (`Unit to trigger vanished`, result `resources`), and only `reset-failed` cleared it from `list-units --all`. `list-unit-files` was already empty.
    - The service ran with the user manager's whole environment, not a clean one: its `PATH` was the manager's, the user's own bin dirs first, and its names included `SSH_AUTH_SOCK`, `DISPLAY`, `WAYLAND_DISPLAY` and `DBUS_SESSION_BUS_ADDRESS` (`timer/service-env-names.txt`). Under hapi, with no desktop session, the manager's env differs; not run.
19. **The env `systemctl --user` needs, and a never-loaded stop.** VERIFIED (T20 env).
    - Either `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` is enough. With neither: `Failed to connect to bus: No medium found`, exit 1.
    - **`systemctl --user stop` on a never-loaded unit exits 5**, `Failed to stop <unit>: Unit <unit> not loaded.`, so `SYSTEMCTL_NOT_LOADED = 5` holds. `is-active` on it prints `inactive` and exits 4.
20. **CodeRabbit's CLI, from its docs (design §7 item 5).** Doc reads, CLI 0.9.1; no CLI was run.
    - **The key:** VERIFIED, and it conflicts with the plan. The CLI reference, "generated from the help output of CodeRabbit CLI 0.9.1", lists ten env vars and says: "API keys use `--api-key <key>` with review or auth login; there is no API-key environment variable."
      - So the key reaches the CLI only on argv: `cr review --api-key …`, or `cr auth login --api-key …`, which "stores an API key for CLI reviews", where it doesn't say.
      - Task 9's `CODERABBIT_API_KEY` can be the review zone's name for the secret, but the CLI can't read it from the env. Putting it on argv breaks the Secrets rule (never in argv), even though the review container runs no repo code.
    - **The hosts:** VERIFIED from "CLI network requirements". In the US region they are `cli.coderabbit.ai` (installation, downloads, update checks), `app.coderabbit.ai` (authentication and CLI service requests) and `ide.coderabbit.ai` (WSS, "every hosted review"); the EU has `app.eu.` and `ide.eu.`. All are TCP 443. CLI 0.9.1 "route[s] through standard proxy variables such as `HTTPS_PROXY`" (changelog, 2026-10-21).
      - The env vars to set: `CR_CLI_TELEMETRY_DISABLED` and `CODERABBIT_CLI_DISABLE_AUTO_UPDATE`.
    - **The exit codes:** VERIFIED in part. "A review that fails or doesn't cover every file exits with code 1, even after printing findings." `--gate <severity>`: "Exit 2 for findings at or above this severity". **What 0 means isn't stated**, so "0 = passed" is UNVERIFIED.
      - The `--agent` NDJSON event types are `finding` (`severity`: critical, major, minor, trivial, info or none), `review_context`, `status`, `heartbeat`, `complete` (`reused`, `status`, `findings`, `message`) and `error` (`errorType`, e.g. `interrupted`).
      - A scope with no changes ends `complete` with `status: "review_skipped"`. The docs say to allow at least 15 minutes.
    - **The limits:** CLI reviews per developer per hour are 3 on Free and Open source and 10 on Advanced, and "trial limits match the selected plan".
21. **GitHub's permissions for the label actor and the check run (design §7 item 7).** The docs' part is VERIFIED; the live call with the App's token is UNVERIFIED, since no token may be used here.
    - From "Permissions required for GitHub Apps" (API version `2026-03-10`):
      - `GET /repos/{owner}/{repo}/issues/{issue_number}/events`, `…/timeline` and `GET /repos/{owner}/{repo}/issues/events/{event_id}` each need **Issues: read**, or **Pull requests: read**, for installation tokens;
      - `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` and `GET /repos/{owner}/{repo}/check-runs/{check_run_id}` need **Checks: read**;
      - `GET /repos/{owner}/{repo}/collaborators/{username}/permission` needs **Metadata: read**.
    - A `labeled` event carries `actor` (a simple user), `performed_via_github_app` (null, or the App) and `label`.
22. **CodeRabbit and bot-authored PRs, and who may start a review (design §7 item 10).** UNVERIFIED: the docs don't say.
    - "Configure automatic reviews", "Commands" and "Plans" say nothing of a "bot user detected" skip. The only author control they give is `reviews.auto_review.ignore_usernames`, which skips listed authors silently.
    - They don't say who may use `@coderabbitai review` or chat.
    - **One more limit, found while reading:** "For public repositories with less than 10 stars, CodeRabbit requires reviews to be triggered manually." The page doesn't say which plans this applies to. A new sandbox repo has no stars, and the factory never @-mentions CodeRabbit, so on such a plan round 0 may never come.

## Decision

- **Ruling for Task 10:** **branch A, the `before_agent_start` hook**, with finding 1's event and result fields.
  - The hook removes from `event.systemPromptOptions.contextFiles` every entry it moves, so Pi itself renders no `project_context`. It returns `{ message: { customType: "hapi-conventions", content: conventionsBlock(name, text), display: false } }`, which Pi sends as a user message right after the work order. Returning `systemPrompt` with the rendering cut out gives the same bytes (`hook-force`, same hash), so either shape passes. The mutation needs no string surgery and keeps Pi's prompt sections.
  - It fails closed by throwing, which fails the node with no request sent.
  - **The rendering to strip** (branch A's tests, and any check that it's gone) is finding 3's, from `core/system-prompt.js:25-30`, `:99-100` and `:115-119` and `pi-ai/dist/utils/text.js:11-18`: `\n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="<path>">\n<content>\n</project_instructions>\n</project_context>`, with several files joined by `\n\n` inside.
  - **`CONTEXT_FILES` is `["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]`**, the first regular file per directory (`resource-loader.js:116`), not pi-mono's two names. Pi loads the agent dir's file first, then cwd's ancestors from `/` down to cwd.
  - So the hook moves every entry, of any of the five names, and fails the node on any entry whose path isn't `<cwd>/<name>`. `contextAboveProblem` also checks the agent dir, `$PI_CODING_AGENT_DIR`, for all five names: it is a writable tmpfs, and Pi reads it first (finding 2).
  - **The types** (pi-ai `dist/types.d.ts`): `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]` (:364), and `stopReason: StopReason` (:376), with `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"` (:301). The result record's "a string `stopReason` other than `toolUse`" admits `pending` and `deferred` too, so Task 10 should decide what those mean.
- **Ruling for Task 8:** the conditional ruling fired: `/work/AGENTS.md` reached Pi (`none`), so **every prelude keeps `/work` holding only `repo/`**.
  - **The review container's env:** `ANTHROPIC_API_KEY` is the key Claude Code sends. `CLAUDE_API_KEY` only stands in when `ANTHROPIC_API_KEY` is unset. No other key, and no `ANTHROPIC_BASE_URL` outside a test.
  - **The strip list:** `.claude/`, `CLAUDE.md` and `/.mcp.json`, beside `.pi/`, `.agents/` and `.archon/`, as Task 8's `prelude.test.ts` pins `review.sh`'s sparse patterns (`'!.claude/' '!CLAUDE.md' '!/.mcp.json'`). r6 ran them with `chmod a-w` and the run completed. Archon writes nothing into the checkout, so `chmod a-w` stands.
  - `CLAUDE.local.md` is a cheap addition (not run). The strip is defence in depth behind Task 11's `settingSources: []`.
- **Ruling for Task 11:**
  - **The Dockerfile lines:** a stage beside the `uv` and `node` ones, `FROM jdxcode/mise:2026.10.9@sha256:07fc362c08135a926cbb1466470d9af10e89c9aa92859831c0ded2f2249bae7d AS mise`. In the archon stage, as root: `COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise`, then `ENV MISE_DATA_DIR=/opt/hapi/mise MISE_CACHE_DIR=/opt/hapi/mise-cache`, then `RUN mise install <name>@<version> … && chmod -R a+rX /opt/hapi/mise`. After the install: `ENV MISE_TRUSTED_CONFIG_PATHS=/work/repo MISE_OFFLINE=1 MISE_LOCKED=1 MISE_SHIMS_DIR=/tmp/mise-shims`.
    - These are image-level `ENV` lines, and `ARCHON_ENV` doesn't change.
    - **Never set `MISE_EXEC_AUTO_INSTALL`, `MISE_TASK_RUN_AUTO_INSTALL` or `MISE_NOT_FOUND_AUTO_INSTALL` to 0**: that makes `mise run` fall back to the image's own Bun without a word (finding 5).
    - Bun needs no setting.
  - **Preflight's toolchain check is `mise install --locked --dry-run-code`**: it exits 1 when a pin isn't in the image, with no write. Plain `mise install --locked` exits 1 even when everything is installed, unless `MISE_SHIMS_DIR` points somewhere writable. The posture's `mise --version` is `2026.10.9 linux-x64 (2026-10-13)`.
  - **The pins audit:** `installs()` in `src/audit/checks/pins.ts` learns `mise install <tool>@<exact version>` (pinned) and flags a bare or `@latest` tool. Otherwise the pins check can't see the image's mise line (finding 8). Task 11 or Task 15, whichever owns `pins.ts`; this task doesn't.
  - **The review node:**
    - `provider: claude` and `model: "@review"`;
    - `allowed_tools: [Read, Grep, Glob]` (the whole toolset, plus `StructuredOutput`);
    - `mutates_checkout: false`;
    - **`maxBudgetUsd` on the node** (`= p.runs.phases.round_usd`), since `assistants.claude` has no budget key;
    - the `output_format` as pinned;
    - **`settingSources: []` on the node.**

    `assistants.claude` gets nothing new: its only keys are `model`, `settingSources` and `claudeBinaryPath`, so Task 11's assistants test stays as it is.
  - **Claude Code's generated settings go to `/etc/claude-code/managed-settings.json`**, bound read-only. That is the managed path, not `$HOME` (H-205).
  - **emitClaude's object gains `permissions.allow: ["Read(//run/hapi/inputs/**)"]`** (r4b), or `permissions.additionalDirectories: ["/run/hapi/inputs"]` (r4a). Without it the review can't Read its inputs. Every other key stays: Claude Code 2.1.302 knows them all.
  - **The verify node:** `bun ci --frozen-lockfile --ignore-scripts` works with `BUN_OPTIONS=--no-install`, so nothing clears it.
- **Ruling for Tasks 8 and 11:** the verify container holds no key of any kind, joins `egress-archon` with `proxyEnv("archon")`, and installs from the bundle's own lockfile with `bun ci --frozen-lockfile --ignore-scripts`. It never reuses the worker's `node_modules`. That held with the archon service's whole env and the run's tmpfs sizes, and reached only `registry.npmjs.org:443`. A key-name check over its env must not match `GIT_CONFIG_KEY_<n>`.
- **Ruling for Tasks 11 and 12 (REVIEW_OUTPUT_AT):** `result.json` can't hold the review. Its only copy, `run.nodes[nodeId=review].outputPreview`, is cut at 200 characters.
  - The review's JSON is **the last `transcript.jsonl` row with `type == "provider_event"`, `step == "review"`, `event.type == "tool_call"` and `event.name == "StructuredOutput"`**, at `event.rawInput`, an object, so nothing is parsed twice. Read it only when `result.json`'s review node has `state: "completed"`.
  - So Task 12's `REVIEW_OUTPUT_AT` is that row selector, and `writeReview` writes the transcript row, plus `result.json` with the node completed.
  - If the controller prefers a file, `review.sh` can copy `node_completed.data.node_output` out of `/.archon/archon.db` with `bun:sqlite` after the run: Archon's text, never through a shell.
- **Ruling for Tasks 2, 9 and 11:** `bun-http`'s image is **`oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4`**, which runs `bun /data/server.ts` hardened. `server.ts` must use Bun's default host (it binds every interface), so the run can reach it by its alias.
- **Ruling for Task 4:**
  - **The argv:** `docker volume create --opt type=none --opt o=bind --opt device=<dir>/<volume> <labels…> <volume>`, options and labels before the name.
  - **The host directory:** made `0700` by hapi, then chowned by the existing helper.
  - **Copy-out** works unchanged, through a read-only mount.
  - **Removal needs the helper**: `find /w -mindepth 1 -delete` as `1001:1001`, then `docker volume rm`, then `rmdir` on the host.
  - **Check that the directory exists before `docker run`.** A missing one passes `volume create` and then fails the run with exit 127 (`error while mounting volume … no such file or directory`).
  - The size-limited filesystem and `ENOSPC` stay Task 4's live check, as hapi.
- **Ruling for Task 14:**
  - **The service:** `Type=oneshot` and `ExecStart=` an absolute path.
  - **The timer:** `[Timer] OnActiveSec=<s>`, `OnUnitActiveSec=<runs.poll_interval_s>s` and `AccuracySec=1s`, and `[Install] WantedBy=timers.target`. **`OnActiveSec` is needed: without it the timer never fires.**
  - **Install:** `systemctl --user link --runtime <service> <timer>`, then `enable --runtime --now <timer>`. Link again before every enable, because `disable --runtime` deletes a linked unit.
  - **Stop and teardown, in this order:** `stop <timer> <service>`, then `disable --runtime <timer>`, then remove any link left in `$XDG_RUNTIME_DIR/systemd/user/`, then `daemon-reload`, then `reset-failed <timer> <service>`. Check with `list-units --all` as well as `list-unit-files`.
  - **The env for `systemctl`:** one of `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS` is enough, so ruling m11's default of `XDG_RUNTIME_DIR=/run/user/<uid>` (and DBUS from it) works.
  - **`SYSTEMCTL_NOT_LOADED` is 5.**
  - **The service sets its own env**, `Environment=PATH=…` plus what the poller needs, and doesn't depend on the user manager's. That env carried `SSH_AUTH_SOCK` and the desktop session's variables here.
- **Ruling for Task 9 (and Tasks 11 and 12, CodeRabbit's CLI):**
  - The key can't arrive by env (finding 20), so as planned, `cr review --agent` would put it on argv, against the Secrets rule. Keep `phases.coderabbit` false until the controller rules on that.
  - The review zone's egress for the CLI is `app.coderabbit.ai:443` and `ide.coderabbit.ai:443` (WebSocket). `cli.coderabbit.ai` serves only installs and updates, which the image does at build time, so a run needs it only if auto-update is on. Set `CODERABBIT_CLI_DISABLE_AUTO_UPDATE=true` and `CR_CLI_TELEMETRY_DISABLED=true`.
  - Task 12: exit 2 means the gate tripped, and 1 means it failed or didn't cover every file. 0 isn't documented, so read the closing `complete` event, not the exit alone.
- **Ruling for Task 3 (and Tasks 13 and 14):** reading a label event's actor needs Issues: read or Pull requests: read (the PR token's Pull requests write covers it). A check run needs Checks: read, and a collaborator's permission Metadata: read. Task 16 Step 1 checks it live with the App's token.
- **Ruling for Tasks 13 and 16:**
  - Whether CodeRabbit reviews a PR the `hapi-factory` App opened, and who may start one, is UNVERIFIED. Task 16 Step 1 records it as a stop-and-report check on the sandbox's first factory PR.
  - Task 13's bounded wait in `pr-review` (ruling m13) is what keeps a skipped round 0 from hanging, so it also covers CodeRabbit's "fewer than 10 stars: triggered manually" rule.
- **Ruling for Task 16 and `phases.coderabbit`:** Step 8's account check (below) is the answer.

**Not verified:**
- Anything on hapi's rootless Docker or hapi's user manager. The volume's subuid mapping, the timer's env under linger, and `ENOSPC` are Tasks 4, 14 and 16's live checks.
- The real `egress-archon`'s refusals, and the review zone's proxy.
- Whether Claude Code tried any host besides the fake. Under `--network none` a failed attempt left no trace in stderr. The managed `env` removed the one extra API request it made.
- Pi's compaction requests under the branch A hook. They skip `before_provider_request`, but branch A changes the prompt itself, so they should see the stripped one.
- A live provider of either kind.

## Consequences

- **Task 4:** the volume argv and removal path above; an existence check on the bind directory before the run; the size cap stays its live check.
- **Task 8:** `/work` holds only `repo/` in every kind's prelude; the review env is `ANTHROPIC_API_KEY` (plus `CLAUDE_API_KEY` mapped to the same secret); the strip list as planned, verified with `chmod a-w`.
- **Task 9:** CodeRabbit's key has no env var to land in; keep it unstored until the controller rules (finding 20). The hosts as above.
- **Task 10:** branch A; the five context-file names; the agent dir in the above-the-worktree check; `StopReason`'s seven values.
- **Task 11:** the mise lines with `MISE_LOCKED=1` and `MISE_SHIMS_DIR`; `--dry-run-code` in preflight; the review node with `settingSources: []` and a node-level `maxBudgetUsd`; the managed path `/etc/claude-code/managed-settings.json`; emitClaude's object gains the read grant for `/run/hapi/inputs`; the audit's `installs()` learns mise.
- **Task 12:** the review comes from the transcript's `StructuredOutput` tool call, not `result.json`; CodeRabbit's exit codes as above.
- **Task 13:** no change beyond m13's bounded wait.
- **Task 14:** `OnActiveSec`; link before every enable; the teardown order with `reset-failed`; the unit's own env; `SYSTEMCTL_NOT_LOADED = 5`.
- **Task 16:** check CodeRabbit's behaviour on the first factory PR (item 10), and the label and check-run reads live (item 7).
- **The cleanup check** (Step 10), run after everything:

  ```text
  { docker ps -a; docker volume ls; docker network ls; docker image ls } | grep -E '^hapi-t(17|18|19|20)-'   → nothing (exit 1)
  systemctl --user list-unit-files 'hapi-t20-*' --no-legend                                                   → nothing (exit 1)
  systemctl --user list-units --all 'hapi-t20-*' --no-legend                                                  → nothing
  containers, volumes, networks and images labelled org.hapi.t17=1 … t20=1                                    → 0 each
  ```

  `hapi-t18-image`, `hapi-t18-image2` and the pulled `oven/bun` (by digest) were removed. The `jdxcode/mise` image never entered the image store (BuildKit fetched it into its build cache), and the Squid image was on this Docker before Step 4, so it stays.

## The CodeRabbit key

Step 8, the operator's account check (H-167), on 2026-10-31:
1. **The plan:** Advanced, a trial that ends 2026-11-10.
2. **The key:** the API keys page's dropdown offers an "Agentic" key type. The operator created none, and didn't report whether it needs a paid seat after the trial. CodeRabbit's docs say unattended use needs "an Agentic API key from an organization where the user has an assigned seat".
3. **The CLI limit:** none shown. CodeRabbit's plan table gives Advanced 10 CLI reviews per developer per hour, and a trial gets its plan's limits.

What it means for `phases.coderabbit`:
- **It stays `false` centrally.** The key's life past the trial is unconfirmed, and off is the fail-closed default.
- **The sandbox's overlay may switch it on** if Task 16 runs before 2026-11-10, with a trial Agentic key in the review zone. The operator creates the key then, a stop-class secret step.
- **Finding 20 comes first:** the CLI takes the key only on argv. Switching it on needs the controller's ruling on how the key reaches the CLI.
- After the trial it stays off unless the operator buys a seat (H-167, with H-168's data). CodeRabbit's PR review carries its part either way.

## Live check (2026-11-06 to 2026-11-12)

Plan 03 Task 16, the live check of [docs/runbooks/engine.md](../runbooks/engine.md#end-to-end-on-the-sandbox), run by the operator as hapi on hapi's rootless Docker, with the poller on hapi's systemd user timer, the stack's own proxies and live providers: Pi 1.3.0 on `anthropic/claude-opus-5-5` for the worker and fix runs (the trailers on `cb7b218` and `7f50c0d` read `Agent: pi@1.3.0` and `Model: anthropic/claude-opus-5-5`), the Claude provider for the review, and Jev through OpenRouter for the decisions. The repo is the sandbox, `<owner>/hapi-sandbox-fortune`, which `mise run new-repo` made for this check. Dates and clock times are the host's, CST (UTC-6); a time ending in `Z` is GitHub's, in UTC.

Four work orders went from a merged planning PR to a merged factory PR, every run started by a poll tick: `0001-skeleton-and-crack-cookie` (planning PR #2, factory PR #3), `0002-search-fortunes` and `0003-fortune-of-the-day` (planning PR #4, factory PRs #5 and #6), and `0004-get-fortune` (planning PR #7, factory PR #8). That is 16 runs (5 worker, 5 verify, 5 review, 1 fix), 15 succeeded and 1 failed, with one retry and one rework, both on 0001. Each work order's budget was $2.00, 40 turns and 30 minutes.

Two things changed under the run:
- **hapi-factory.** hapi's checkout was deployed after PR #15 merged (`8b67c17`), and again after each of the three PRs the run itself caused: #16 (`c977f44`), #17 (`a448d6c`) and #18 (`19ab0ff`).
- **CodeRabbit.** 0001 ran in the operator's Advanced trial. On 2026-11-11 CodeRabbit skipped the operator's planning PR #4, the operator subscribed to Essentials, and 0002 and 0003 ran on that plan. CodeRabbit's CLI was off for 0001 to 0003 (Step 3: no key) and on for 0004, after PR #18 gave it `--deep` and switched CodeRabbit's round on an open PR off (H-312).

The run table, the pass criteria, the Decisions table and H-168's line are in engine.md's [record](../runbooks/engine.md#the-record). This addendum tells the run in order and holds it against this spike. Where the controller's notes of the session and GitHub differ, it gives both.

The timeline, by the runbook's steps:

| Step | When (CST) | What happened |
|---|---|---|
| Before Step 2 | from 2026-11-06 | The walkthrough began with the run disk and its live check, then `mise run new-repo`, which made the sandbox (created 2026-11-09T00:10:59Z). |
| 3 | 2026-11-08 | The operator chose "CLI off": no key for CodeRabbit's CLI, and planning PR 1 leaves the `coderabbit` line out. |
| 4 and 2 | 2026-11-08 | hapi-factory PR #15 merged at 18:44:56 (`8b67c17`). The Console's monthly limit for the `hapi-factory` workspace was set to $25. The deploy as hapi failed first (`hapi_outbound`, H-305); `mise run down`, then `mise run up`, brought all five services up healthy. The poller's first tick, 19:29:11 to 19:29:13: `<owner>/hapi-sandbox-fortune: nothing to do`. |
| 4 | 2026-11-09 | The factory App's Checks read permission was accepted (by 20:49). Then the strict audit of both repos, 25 pass, 2 fail, 0 skip (`mcp.tool-hashes`, expected, and `github.repo-settings`, H-306), and both classifier endpoints answered 401, so both were reached. |
| 5 | 2026-11-09, 21:01:49 to 21:31:01 | Planning PR 1 opened as sandbox PR #2 (head `da04b38`); CodeRabbit reviewed it unprompted (21:07:24); it merged as `989eb85`. |
| 6 | 2026-11-09, 21:31:36 to about 22:10 | 0001's first worker, `6323f1cf684f`, started at the 21:31:36 tick, 34 s after the merge, and had failed by the 21:33:40 tick (H-307). hapi-factory PR #16 opened at 22:06:16 with the fix, and the run paused at the operator's request. |
| 6 | 2026-11-10, 08:47:53 to 09:08:12 | PR #16 merged (`c977f44`) and was deployed (the timer stopped at 08:48:54 and started at 08:49:21); `hapi retry`; the retry's worker, `1433bf348f72`, at the 08:50:03 tick; the stop's live check (H-281) while it ran; factory PR #3 opened at 08:59:50 (head `cb7b218`); CodeRabbit reviewed it at 09:06:45; `pr-review -> waiting` at the 09:08:12 tick. |
| Between 6 and 7 | 2026-11-10, 09:53:48 | hapi-factory PR #17 merged (`a448d6c`) and was deployed (the timer stopped at 09:54:15 and started at 09:54:19). |
| 7 | 2026-11-10, 09:58:33 to 10:11:04 | The operator's rework comment and the `hapi:rework` label on PR #3; the fix run at the 10:00:44 tick; the new head `0669be0` at the 10:09:05 tick; `pr -> waiting` at 10:11:04. `ci / gates` ran late on that head (below) and passed. |
| 8 | 2026-11-10, 10:22:43 | The operator merged PR #3 in GitHub's UI (`336f2d7`). The 10:23:34 tick: `0001-skeleton-and-crack-cookie waiting -> merged; #2 edited; #2 final`. The operator's calls on its hold, its note and the review's findings came after the merge. |
| 9 | 2026-11-11, 17:21:25 to 17:40:14 | Planning PR 2 opened as sandbox PR #4 (head `63ad64e`; the controller's notes have 17:22, written with the PR already open). CodeRabbit skipped it; the operator subscribed to Essentials and pushed an empty commit (`851adff`, 17:35:56), which CodeRabbit reviewed (17:38:36); PR #4 merged as `9173e10`. |
| 9 | 2026-11-11, 17:42:16 to 18:13:31 | 0002's worker, `d747452f18c1`, at the 17:42:16 tick, 121 s after the merge; factory PR #5 at 17:50:38 (head `7a2e5ca`). 0003's worker, `8f4d24c1826a`, at the 17:52:43 tick, the first after 0002 had its PR (one pipeline per repo); factory PR #6 at 18:01:06 (head `30dadf8`). The operator merged both with `gh pr merge --merge --admin`, at 18:12:28 (`36ac5a7`) and 18:12:32 (`c7568d0`). The 18:13:31 tick settled the plan. |
| 10 | 2026-11-11, about 18:45 | Close-out: the strict audit again, `hapi audit: 25 pass, 2 fail, 0 skip`; `hapi status`'s totals, $2.66 and $0.35; `hapi run list`, 13 sandbox runs (12 succeeded, 1 failed) beside Plan 02's 4 check runs; the Console's `$1.21 over last 30 days`; the hardening check of the poller's unit (H-281). |
| After 10 | 2026-11-11, 18:56 and 19:50:33 | The host rebooted (power) with nothing running. hapi-factory PR #18 opened. |
| Planning PR 3 (0004) | 2026-11-12, 20:43:44 to 21:17:17 | PR #18 merged (`19ab0ff`); the deploy as hapi at about 20:52 (`git pull --ff-only`, `mise run down`, `mise run up`). Planning PR 3, sandbox PR #7 (head `64caa7e`), merged at 20:57:16 (`e57d844`). 0004's worker, `2151063a53a4`, at the 20:58:31 tick, 75 s after the merge; factory PR #8 at 21:06:52 (head `7f50c0d`); its body read `**Ready to merge**` from 21:11:03; the operator merged it at 21:17:04 (`183d747`). The 21:17:17 tick: `0004-get-fortune waiting -> merged; #7 edited; #7 final`. |

The passes. A verify run calls no model, so it has no spend; its exits are given where the controller's notes quote them in full:

| Pass | Runs: kind, id, spend | Phases, at the poller's ticks | Head | The PR's verdict | CodeRabbit |
|---|---|---|---|---|---|
| A: 0001, first pass (retry 0) | worker `6323f1cf684f`, failed: no model call, no spend reported, counted at $2.00 | `queued -> worker -> failed`, 2026-11-09, 21:31:36 to 21:33:40 | none | No PR. The status row: ``failed (`worker run 6323f1cf684f ended failed: the workflow failed (Archon status failed)`)`` | none |
| B: 0001, retry 1, round 0 | worker `1433bf348f72`, $0.331154246, 8 turns; verify `9abcf06679c8`, exits `{"check":0,"smoke":0,"acceptance":0}`; review `ac62df5d285d`, $0.1153063 | `queued -> worker -> verify -> review -> harvest -> pr -> pr-review -> waiting`, 2026-11-10, 08:50:03 to 09:08:12 | `cb7b218`, opening factory PR #3 | `**Needs your decision** · risk: yellow`, for `held: 1 file not screened (skip_paths names it as a lockfile, but it doesn't parse as bun.lock)`. The review: `ready: 1 findings, 5 of 5 criteria met` | The CLI: `off (runs.phases.coderabbit)`. On the PR, in the trial: reviewed (`Finished`), `Actionable comments posted: 1` (`Minor`, `src/bakery.ts` line 22) and one `Trivial` nitpick. The engine started no fix run |
| C: 0001, retry 1, round 1 (the rework) | fix `f1c5b12d20db`, $0.09107846, 4 turns; verify `4cd58e2388e5`, exits `{"check":0,"smoke":0,"acceptance":0}`; review `50151ebbd187`, $0.1212177 | `waiting -> fix -> verify -> review -> harvest -> pr -> waiting`, 2026-11-10, 10:00:44 to 10:11:04; `waiting -> merged` at 10:23:34 | `0669be0` | `**Needs your decision** · risk: yellow`, for `the independent review says needs-work` and `acceptance criterion 4 of 4 is unmet`. The review: `needs-work: 3 findings, 3 of 4 criteria met` | The CLI: off. On the PR: reviewed again, unprompted (`Finished`), with no new inline comment and one `Trivial` nitpick; then `Reviews paused`. The engine starts no CodeRabbit round after a rework |
| D: 0002, round 0 | worker `d747452f18c1`, $0.11849651, 5 turns; verify `4e1a00b285d4`; review `4e5fe006b7be`, $0.0413172 | `queued -> worker -> verify -> review -> harvest -> pr -> pr-review -> waiting`, 2026-11-11, 17:42:16 to 17:54:52; `waiting -> merged` at 18:13:31 | `7a2e5ca`, opening factory PR #5 | First ``**Waiting for `ci / gates`** · risk: green``, then `**Needs your decision** · risk: yellow`, for `CodeRabbit did not review 7a2e5ca: Review skipped: bot user not eligible for review`. The review: `ready: 0 findings, 2 of 2 criteria met` | The CLI: off. On the PR, on the paid plan: the check completed `skipped`, `Review skipped: bot user not eligible for review`; its comment reads `Bot user detected.` |
| E: 0003, round 0 | worker `8f4d24c1826a`, $0.1448228, 5 turns; verify `5a0606a00a65`; review `6ad91da7609b`, $0.0466404 | The same phases, 2026-11-11, 17:52:43 to 18:05:18; `waiting -> merged` at 18:13:31 | `30dadf8`, opening factory PR #6 | As D, for `30dadf8`. The review: `ready: 0 findings, 2 of 2 criteria met` | As D |
| F: 0004, round 0 | worker `2151063a53a4`, $0.14; verify `efd9367b55be`; review `407263f1fcbf`, $0.04 (both to the cent, from the status comment's totals) | `queued -> worker -> verify -> review -> harvest -> pr -> waiting`, 2026-11-12, 20:58:31 to 21:08:57; `waiting -> merged` at 21:17:17 | `7f50c0d`, opening factory PR #8 | First ``**Waiting for `ci / gates`** · risk: green``, from 21:11:03 `**Ready to merge** · risk: green`, with `Nothing unresolved.` The review: `ready: 0 findings, 3 of 3 criteria met` | The CLI, in the review run: `cr review --deep --agent --committed --gate major`, `reviewed: 0 findings, 0 major or critical`. On the PR: the check completed `skipped`, `Review skipped: bot user not eligible for review`; with the round off the engine read neither it nor the comment, and waited on nothing |

What the passes add up to:
- **Verify and the host gates passed every time.** All five verify runs passed `check`, `smoke` and `acceptance`, the host gates passed at all five harvests, and `ci / gates` ended `passed` on every head.
- **One PR read Ready to merge.** PR #8 is the only factory PR whose body ever had it as its verdict line; its acceptance tests passed in verify run `efd9367b55be`. PRs #3, #5 and #6 were merged from Needs your decision.
- **One verdict, named two ways for about four minutes (H-315).** On PRs #5, #6 and #8 the planning PR's status row read `pr: Ready to merge` while the factory PR's body read ``**Waiting for `ci / gates`**``, though `ci / gates` had passed within a minute of the PR's opening: the body was next rendered about four minutes after it opened. On #5 and #6 that next rendering was Needs your decision (the row had gone on to `pr-review: Ready to merge`); the controller's notes hold only the body's line for those ticks. On #8 the row went on to `waiting: Ready to merge`, the body followed at 21:11:03, and the tick that rendered it logged `nothing to do`.
- **The real spend, from the runs' records:** $0.658756706 for 0001, $0.15981371 for 0002 and $0.1914632 for 0003, which is $1.010033616, plus $0.0008 of decisions. 0004 added $0.18, to the cent (`$0.18 over 3 runs (1 with an unknown spend, counted at its budget), 6 turns, decisions $0.0001 (2 calls)`); its runs' own records were not read.
- **hapi's counted total:** $2.66 and $0.35 in Step 10's `hapi status`, and $0.18 in planning PR #7's final comment: $3.19 of the sandbox's $15 month, by addition (`hapi status` was not read again). The $2.00 between counted and real is the failed run `6323f1cf684f`: its record's `spendUsd` is null, and a run that left no spend total counts at its whole budget (H-311).
- **A live run counts at its budget until it ends:** $2.00 for a worker, $1.00 for a review or a fix, $0 for a verify. The highest total a status comment showed was $4.00 on planning PR #2 (the failed run's $2.00 and the retry's live worker), $2.16 on #4 and $2.00 on #7.
- **The cross-check:** the Console's `hapi-factory` workspace read `$1.21 over last 30 days` at Step 10, a figure that includes Plan 02's paid check and other use.
- **No cap tripped:** not the sandbox's month ($15), not the day ($10, all repos), not the Console's limit ($25). So no cap's text was seen.

The retry and the rework, both on 0001:
- **The retry (retry 1).**
  - **Cause:** the first worker, `6323f1cf684f`, failed about 2 minutes after it started, before any model call. The engine's reason was only `worker run 6323f1cf684f ended failed: the workflow failed (Archon status failed)` (H-314). The run's transcript held the cause: `hapi-guard: anthropic/claude-opus-5-5: cost differs from the pin; the node fails`. Pi 1.3.0's override merge gives a model with no price tiers `tiers: undefined`, the guard's pin has no `tiers` key, and the guard's strict compare took that for a difference (H-307). Haiku 5.5 has tiers, so spike 08 and Plan 02's paid check had passed. The fault was hapi-factory's, not the work order's.
  - **What it left:** the plan settled as `This plan has settled: 0 merged, 0 closed, 1 failed. Total: $2.00.`, and that comment stayed on planning PR #2 after the retry, beside the second one (`This plan has settled: 1 merged, 0 closed, 0 failed. Total: $2.66.`) (H-311).
  - **The fix and the retry:** hapi-factory PR #16 (`6e2e685`) merged on 2026-11-10 at 08:47:53. The operator pulled hapi's checkout, ran `mise run up`, then `hapi retry <owner>/hapi-sandbox-fortune 0001-skeleton-and-crack-cookie`, which answered `0001-skeleton-and-crack-cookie is queued again (retry 1), with 0 of the repo's work orders ahead of it: a poll tick starts its worker at 989eb85b2d24 …` (the rest of the line was not kept). The 08:50:03 tick, about 40 s after the timer's restart: `0001-skeleton-and-crack-cookie queued -> worker; #2 edited; #2 reopened`. The retry's worker passed the guard's session start on Opus 5.5.
  - **Its runs:** round 0, worker `1433bf348f72`, verify `9abcf06679c8` and review `ac62df5d285d`; then the rework's three, still retry 1.
  - **Its spend:** the failed pass, $0 real and $2.00 counted. The retry's round 0, $0.446460546 (0.331154246 + 0.1153063) and `decisions $0.0004 (8 calls)`; PR #3's cost line then read `$2.45 over 4 runs (2 with an unknown spend, counted at their budget), 8 turns, decisions $0.0004 (8 calls)`. The whole retried pass, both rounds, $0.658756706 and `decisions $0.0006 (10 calls)`: all of 0001's real spend.
  - **For the record's criterion 3:** failed for 0001, by the plan's rule, with this retry as its evidence. 0002, 0003 and 0004 had one worker run each, with nobody touching anything.
  - **The controller's notes against GitHub, twice:** `#2 reopened` is the poller's word for its status thread: PR #2's timeline has no `reopened` event, and the PR stayed merged. And the notes hold a status row read after `hapi retry` (queued, run `6323f1cf684f`, `0 automatic, 0 rework, retry 1`, $2.00) that is not among the 16 renderings of the status comment GitHub keeps: `hapi retry` edits no comment, and the runbook's retry command prints `hapi status` after it.
- **The rework (round 1), by label.**
  - **Cause:** Step 7 asks for one rework by label. On 2026-11-10 at 09:58:33 the operator commented on factory PR #3, `Rework: make crack_cookie's lucky numbers distinct. Also reject a   malformed fortune from the bakery before returning it.` (as posted: the runbook's sentence, then CodeRabbit's `Minor` finding in the operator's words), and a second later added the label `hapi:rework`.
  - **Its runs:** the 10:00:44 tick, the first after the label, `0001-skeleton-and-crack-cookie waiting -> fix; #2 edited`: fix `f1c5b12d20db` (round 1, retry 1, 4 turns), verify `4cd58e2388e5`, review `50151ebbd187`.
  - **Its spend:** $0.21229616 (0.09107846 + 0.1212177); the decisions went from `$0.0004 (8 calls)` to `$0.0006 (10 calls)`. PR #3's cost line after it: `$2.66 over 7 runs (3 with an unknown spend, counted at their budget), 12 turns, decisions $0.0006 (10 calls)`.
  - **What it pushed:** a third commit, `0669be0`, `0001-skeleton-and-crack-cookie: crack-cookie`, on `src/tools/crack-cookie.ts` (+19 −1) and `tests/crack-cookie.test.ts` (+24). The first ask was done (the review's evidence: "the numbers are drawn without replacement from 1..49"). The second was done in part: a new `isFortune` check in the tool, on the one fortune it picks, with `src/bakery.ts` unchanged.
  - **What the PR said after it:** `Fix rounds: 1 of 2.` over `` - Round 1, rework: run `f1c5b12d20db` `` (a rework shows against the automatic cap, H-301). The verdict stayed `**Needs your decision** · risk: yellow`, now for the review's needs-work (H-310, below). No CodeRabbit round starts after a rework: the row went `pr -> waiting`.
  - **Deployed just before it:** hapi-factory PR #17 (`7cf9d3a`). Its fix for H-308 showed at this harvest: `8 files screened (2 asked, 6 reused; jev 8)`, `pass`, with `bun.lock` taken as a lockfile.
- **No other retry, rework or fix round.** 0002, 0003 and 0004 each read `Fix rounds: 0 of 2.`, and no automatic fix round ran on any work order.

What this spike predicted, and what the run showed. Each finding or ruling the run met is marked held, did not hold or not exercised; a question the spike left open is marked with its answer:
- **Findings 1 to 4 and the ruling for Task 10 (the `before_agent_start` hook, Pi's context files, the rendering, `turn_end`'s types): not exercised as a named check.** Five worker and fix runs completed on Pi 1.3.0. Nothing read where a repo's `AGENTS.md` landed in a request (design §7 item 9).
- **Finding 5 and Task 11's mise lines (mise in the run image): held, by its result only.** `check` and `smoke` are mise tasks (`mise run check`, `mise run smoke`), and both passed in all five verify runs. No read quotes `preflight`'s `mise install --locked --dry-run-code` for any run, and no pin the image lacks was tried (design §7 item 4).
- **Finding 6 and the ruling for Tasks 8 and 11 (the keyless frozen install): held, by its result only.** Verify's frozen install agreed with the worker's `package.json` and `bun.lock` on `cb7b218`, a lock of 131 packages with the MCP SDK's tree in it, and every later verify run passed. What `egress-archon` logged for a verify run, and the verify container's env, were not read: "reached only `registry.npmjs.org:443`" and "holds no key" stand on the spike alone.
- **The ruling for Tasks 2, 9 and 11 (the `bun-http` sidecar): held.** The sandbox's smoke reaches its bakery on that sidecar, and it passed in all five verify runs (the first printed `smoke: health ok`).
- **Findings 10, 11 and 14 and Task 11's review node (a Claude node as the review, its key, its read grant): held.** Five review runs returned the schema's answer, `ready` four times and `needs-work` once. The dearest cost $0.1212177, under the node's $1.00 (`runs.phases.round_usd`, which is what a live review counted at). The reviews read their inputs: 0004's cites `verify.json: check exit 0 (26 tests pass, lint finished), smoke exit 0 (health ok), and acceptance exit 0 (2 pass).` The review's tool set, its managed settings and its env were not checked on their own (design §7 item 6).
- **Finding 15 and the ruling for `REVIEW_OUTPUT_AT` (the review's whole answer is in the transcript): held.** Each PR prints its review's findings and criteria as the review wrote them. On `0669be0` that is three findings and four criteria with their evidence, well past `result.json`'s 200-character preview.
- **Findings 16 and 17 and the ruling for Task 4 (the run volume, and `ENOSPC` as hapi): held, on the second try.** The run disk's live check first failed its 100 MB expectation: `mkfs.ext4`'s default discard had punched out the image's extents, so `dd` took 20.9 GB from Docker's data root. Remade with `-E nodiscard,lazy_itable_init=0`, the disk met all three expectations: the `ENOSPC` line shown, 19971 records in and 19970 out, and the data root's free space moved by 0.6 MB. The stale mount namespace that runs.md had inferred (H-287) didn't arise: rootlesskit runs with `--propagation=rslave`. All 16 runs then ran on that disk under hapi's rootless Docker, and the audit's `runtime.run-disk` passed. No run met `ENOSPC`, and no bind directory went missing (finding 17).
- **Finding 18 and the ruling for Task 14 (the timer and its stop): held under hapi.** The first tick came on 2026-11-08 at 19:29:11, two seconds after the timer's `NEXT` of 19:29:09; the service finished with success; the audit's `runtime.poller-timer` passed; no tick failed across the run's pauses. The stop's live check, with a worker live: the main process is bun, the stop took 0 s, no tick was left, and one supervisor before was one after. Two lines the runbook's expected text lacks: systemd's `Stopping 'hapi-poll.service', but its triggering units are still active: hapi-poll.timer`, and the journal's `hapi-poll.service: Failed with result 'signal'` for the tick started by hand (cosmetic). One consequence the spike didn't draw: units linked with `--runtime` are gone after a reboot. After the reboot of 2026-11-11 hapi's Docker was back and the poller's timer was not, until the next `mise run up` (H-305).
- **Finding 20, the key on argv: held.** In review run `407263f1fcbf` the key reached the CLI by `--api-key`, unattended, and the review completed. The CLI went through the review zone's proxy, as its changelog said it would.
- **Finding 20's hosts and the ruling for Task 9's egress: did not hold.** The spike read CodeRabbit's docs as: a review talks to `app.coderabbit.ai` and `ide.coderabbit.ai`, and `cli.coderabbit.ai` serves installs and updates, so a run needs it only with auto-update on. Live, with auto-update off (`CODERABBIT_CLI_DISABLE_AUTO_UPDATE=1`), the review proxy's log from its start at 20:52 on 2026-11-12, which takes in the one review run with the CLI on, holds `5 CONNECT api.anthropic.com:443` and `4 CONNECT cli.coderabbit.ai:443` and nothing else, allowed or refused. So `cli.coderabbit.ai` is the one CodeRabbit host the review used, and `app.` and `ide.` were never asked for. This corrects the Decision's ruling for Task 9 above. The controller's ruling (2026-11-12): all three hosts stay on the review zone for now, since one clean review with no finding doesn't show every path (a review with findings, an expired key); `app.` and `ide.` are candidates to drop after a second run, and `cli.` stays (H-298, reworded). CodeRabbit's own finding on hapi-factory PR #15, `Limit review-zone egress to the required hosts.`, had been raised on the `cli.coderabbit.ai` line.
- **Finding 20's exit codes and events, and the ruling for Task 12: held for exit 0, which the docs left open.**
  - **The CLI's whole output** for review run `407263f1fcbf` is four lines: a `review_context` line; a `status` line with `"phase":"analyzing","status":"promo_credits_granted"`; `{"type":"complete","status":"review_completed","findings":0,"gate":{"threshold":"major","status":"passed","blockingFindings":0},"reviewedFiles":[…],"outcome":"completed","message":"Review completed"}`; and hapi's own `{"type":"hapi","exit":0}`.
  - **What 0 means:** exit 0 with `outcome: completed` and `gate.status: passed` is a completed review with nothing at or above the gate. The harvest read the closing event, as ruled, and printed `reviewed: 0 findings, 0 major or critical`.
  - **Against the docs' event list:** the `complete` line has `outcome`, `gate` and `reviewedFiles`, which the list lacks; it had no `reused` and no `unreviewedFileCount`; its `status` is `review_completed`. The harvest reads `outcome` (and `status` only when there is none), not `findings`, `gate` or `reviewedFiles`. `reviewedFiles` had two entries, of the lengths of the diff's two paths (the read prints a long string by its length): held against the diff's files, it would show a partial review, which this line's missing `unreviewedFileCount` can't (H-312(g)).
  - **Exits 2 and 1:** 2 was not seen. 1 was seen offline only: with `--network none` the pinned CLI printed `{"type":"error","errorType":"review","message":"Review failed: con_err: webSocket connection failed",…}`.
- **Finding 20's time and limits: the time held, and the limits were not exercised.** The docs say to allow at least 15 minutes. The review run (the review's session, then the CLI) fitted between the 21:02:41 and 21:04:45 ticks, on a diff of 94 added lines in two files. No rate limit was met: three CodeRabbit reviews ran inside the hour on the operator's seat. The Essentials CLI allowance per hour is still not known. For its PR reviews CodeRabbit printed `Your plan provides up to 10 included reviews per hour` in the trial and, on Essentials, `Your included PR review attempts over the past 7 days set your current allowance at 5 reviews per hour.`
- **New beside finding 20: the `status` line and usage-based reviews.** The line's message: `$25 in free promotional credits have been added to your account for additional reviews. These credits expire after 7 days. To purchase more, visit [billing](…).` (the link is left out). CodeRabbit's docs describe a usage-based add-on: once the included reviews are used up, the organization's setting "After included review limits" is Automatic (reviews go on and the overage is billed, with no flag), On demand (a headless review returns `action_required` with `status: "awaiting_confirmation"` unless `--use-credits` is passed) or Off (reviews stop). hapi never passes `--use-credits`. At the operator's organization usage-based consumption is off; the one usage item that was on before the run was Deep Scan, a separate security product, which the operator has since capped at its minimum ($1).
- **Finding 21 and the ruling for Task 3 (the App's token reads a label event's actor and a check run): held.** The rework started on the first tick after the label. The engine re-rendered PR #3 with `ci / gates` `passed` on `0669be0`, ended CodeRabbit's round on PR #3 from its finished check, and quoted the check's title on PRs #5 and #6. The App's installation page read `Read access to checks and metadata` first (Step 4). Re-adding `lane:planning` to PR #2 left it with one `labeled` event (H-288).
- **Finding 22 and the ruling for Tasks 13 and 16 (CodeRabbit and a PR the App opened): settled, and the answer depends on the plan.**
  - **In the trial** (2026-11-09 and 2026-11-10) it reviewed the operator's planning PR #2 unprompted, and the App's PR #3 on both heads (`Finished`).
  - **On 2026-11-11, before the operator subscribed,** it skipped the operator's own planning PR #4 at `63ad64e`: `Review skipped: manual review required for this OSS repository`, with the comment `This repository does not receive automatic reviews because it has fewer than 10 stars.` That is the limit this finding had read in the docs.
  - **On Essentials** it reviews the operator's PRs (PR #4 at `851adff`, PR #7 at `64caa7e`) and skips the App's (#5, #6 and #8): `Review skipped: bot user not eligible for review`, with the comment `Bot user detected.` Its docs say a bot never gets a paid seat automatically and can be given one by hand; that was not tried.
  - **The plan's name differs between the controller's notes and GitHub.** The notes have the trial ending on 2026-11-10 and Essentials from the subscription on 2026-11-11. CodeRabbit's review of PR #4 at `851adff` prints `Plan: Essentials`, but its skip comments on `63ad64e`, #5 and #6 print `Plan: Advanced`. Nothing in the sources explains it, and no source quotes CodeRabbit saying the trial had ended.
  - **A skip didn't hang the round.** CodeRabbit's check completed as `skipped`, and the engine ended the round on the next tick with `CodeRabbit did not review <h7>: <title>` and Needs your decision. The bounded wait itself (ruling m13) was not exercised. With the round on, then, no factory PR on a paid plan could read Ready to merge, which is why PR #18 switched it off (H-312).
  - **Who may start a review or chat:** not tried.
- **"The CodeRabbit key", point by point:**
  - **The plan (a trial that ends 2026-11-10): held, by the controller's reading** of what CodeRabbit did on 2026-11-11: it skipped the operator's own PR until the operator subscribed. No source quotes CodeRabbit saying the trial had ended (above).
  - **The key (does an Agentic key need a paid seat after the trial?): answered for a paid seat.** On 2026-11-12 the operator created an Agentic API key on the Essentials seat, stored it under `hapi-review-coderabbit-api-key` and gave hapi its copy; `mise run secrets:check` printed `found    review/CODERABBIT_API_KEY (hapi-review-coderabbit-api-key) (optional)` in the operator's checkout and again as hapi. It worked unattended. No key was made during the trial. Still open under H-167: the written confirmations, the CLI's hourly allowance and the private-repo questions.
  - **"It stays `false` centrally": held.** The sandbox's overlay switched it on, in planning PR #7 (`coderabbit: true` under `runs.phases`, with a `Protected-path change` section in the PR's description).
  - **"The sandbox's overlay may switch it on" before 2026-11-10, on a trial key: not taken.** Step 3's answer was "CLI off".
  - **"CodeRabbit's PR review carries its part either way": did not hold.** On a paid plan the PR review skips the App's PRs. With the CLI off, 0002 and 0003 got no CodeRabbit review at all, and each PR waited at Needs your decision for one. Since PR #18 the CLI in the review run is CodeRabbit's review of a work order.
- **The Decision's "Not verified" list:**
  - **hapi's rootless Docker and user manager:** exercised, as above (the runs, the timer, `ENOSPC` at the run disk's check). A run volume's subuid mapping was not read on its own.
  - **The review zone's proxy:** seen on its allowed path. `egress-archon`'s refusals were not read.
  - **Whether Claude Code tries another host:** in 0004's review run the proxy logged no `CONNECT` but those to `api.anthropic.com:443` and `cli.coderabbit.ai:443`.
  - **Pi's compaction requests under the hook:** nothing in the run observes them.
  - **A live provider of either kind:** both ran.
- **Not tested by the run:** findings 7 and 8 (the digests, the pins audit), 9 (`egress-archon`'s Squid: its log was not read), 12 and 13 (what a repo's files do to the review, Claude Code's settings paths), 19 (the env `systemctl --user` needs, and a never-loaded stop's exit 5) and the ruling for Task 8's strip list.

The design's "Verify early" list (design §7), item by item:

| # | Item | What the run found | Settled live? |
|---|---|---|---|
| 1 | Bind-backed volumes on a fixed-size filesystem under hapi's rootless Docker; `ENOSPC` fails the run without touching the data root | The run disk's live check, on its second run (findings 16 and 17 above). No sandbox run itself met `ENOSPC`. | Yes, by the run disk's check; H-303 came of it |
| 2 | `gh`'s login adding a repo to an App installation | It can't. `gh api /user/installations` answered the operator's login 403, `must authenticate with an access token authorized to a GitHub App`, and so does the read of an installation's repositories. All three Apps were added at `new-repo`'s web step, and `new-repo` now reads no installation (H-304). | Yes: the answer is no |
| 3 | The required check's name with a reusable-workflow wrapper | `ci / gates` (app 15368), the same on every PR head of the run. | Yes |
| 4 | mise in the run container with no download route | No check of its own. `mise run check` and `mise run smoke` exited 0 in all five verify runs. | Not as a named check |
| 5 | CodeRabbit's CLI in the review container: its key, its egress hosts, `--agent`'s exit codes; whether a free or open-source plan issues an unattended key | Off for 0001 to 0003. On for 0004, and it works: a paid Essentials seat issues an Agentic key, which works unattended on argv; the one CodeRabbit host is `cli.coderabbit.ai`; exit 0 with a `complete` line of `outcome: completed` and `gate.status: passed` is a completed review with nothing at or above the gate; exit 2 was not seen. A free or open-source plan's key was not tried. | Yes, for a paid seat |
| 6 | The Claude provider as the review, with read-only tools, no shell and its generated settings; the verify container on exactly the bundle's commits with no key | Five review runs gave verdicts, and five verify runs passed `check`, `smoke` and `acceptance`. The review's tool set and settings, and the verify container's environment and checkout, were not checked on their own. | Exercised; its named properties were not checked |
| 7 | The poller reading a label event's actor, and CodeRabbit's check run, with the `hapi-factory` App's token | Both work (finding 21 above). | Yes |
| 8 | A systemd user timer under hapi with the stack's environment | It runs, and the stop's live check passed (finding 18 above). Twice the stack was found down after a boot: unnoticed from the 2026-11-07 boot until the deploy, and after the reboot of 2026-11-11 (H-305). | Yes, with H-305 |
| 9 | Pi 1.3.0's context-file hooks | Nothing in the run observes them. | Not exercised |
| 10 | Whether CodeRabbit lets anyone but collaborators start a review or chat on a public repo; whether a factory PR is skipped as "bot user detected" | The second half, by plan (finding 22 above): reviewed in the trial, `Bot user detected.` on a paid plan. The first half was not tried. | The second half: yes. The first: not exercised |
| 11 | The MCP SDK's `serveStdio` under Bun | The sandbox's smoke exited 0 in every verify run; the first printed `smoke: health ok`. | Yes |

What it found in hapi-factory, and what fixed it:
- **The run disk's image was sparse (H-303, open).** Found by the run disk's live check, above. runs.md now makes the disk fully allocated and checks it with `du` (`cf9d146`, in PR #15). hapi's own check of the disk still can't see an image's allocation, which is what H-303 holds.
- **`new-repo` could never pass its own preflight (H-304, closed).** GitHub answers the operator's `gh` login 403 on an App's installations. `new-repo` now reads none and takes the ids from `policy/repos.yaml`; the strict audit as hapi proves the planner's and the factory's (`012bed8`, in PR #15). No check covers CodeRabbit's installation.
- **`hapi_outbound` isn't restored when hapi's Docker starts (H-305, open).** At the deploy `compose up -d --wait` failed with `failed to create endpoint hapi-egress-research-1 on network hapi_outbound: network 4ae6ccb86ecd... does not exist`: the stack had been down, unnoticed, since the 2026-11-07 boot. The recovery is `mise run down`, then `mise run up`; PR #16 put it in stack.md's Troubleshooting (`6e2e685`, corrected in `5c0347c` and `add3097` after CodeRabbit's two `Major` findings on the entry). It came back with the reboot of 2026-11-11, and 0004's deploy began with the same `down` (five containers and five networks removed, `hapi_outbound` among them). `up` still doesn't heal it, and nothing says the stack is down.
- **The strict audit can't see a contract repo's seven merge settings with its read-only token (H-306, open).** `github.repo-settings` fails for the sandbox, so the strict audit of both repos read 25 pass, 2 fail, 0 skip at Step 4 and again at Step 10 (the other fail is `mcp.tool-hashes`, H-101). The settings themselves are right: `new-repo`'s step 11 and a GraphQL read on 2026-11-09 showed them. PR #16 corrected engine.md's expected result (`6e2e685`); the read by GraphQL is still to build.
- **The guard failed every session of a model with no price tiers (H-307, closed).** The retry's cause, above. Fixed in PR #16 (`6e2e685`) and seen live in the retry's worker.
- **The lockfile screen held a sound `bun.lock` (H-308, closed).** `isBunLock`'s range check refused a space after an operator (`>= 4.11`, `>= 2.1.2 < 3.0.0`), which two of the lock's 131 packages use, both in the MCP SDK's tree. So factory PR #3 opened at Needs your decision. Fixed in PR #17 (`7cf9d3a`) and seen live at the rework's harvest.
- **The engine could read no CodeRabbit severity (H-309, closed).** `severityOf` took the first `**<Word>**` of a comment, and CodeRabbit now writes an icon inside the severity's bold span: PR #16's two `Major` comments read as "IMPORTANT" and as nothing. No finding could count as Critical or Major, so the automatic fix round could never have started. Fixed in PR #17 (`7cf9d3a`) and checked on the real comments: PR #16's read Major and Major, PR #3's Minor. No finding at major or above reached the engine afterwards, so the fix was not exercised live.
- **With CodeRabbit's round on, no factory PR on a paid plan could read Ready to merge (H-312, open).** The operator's ruling of 2026-11-11 became PR #18 (`a54329b`, `59f2117`, `d279edf`, `37b1ccf`): the round on the PR ships off, and the CLI in the review run takes `--deep`.
  - **What `--deep` is:** CodeRabbit's docs say it "uses the same review capability policy as GitHub Pull Request Reviews and keeps your existing CLI limits and billing", and that it "does not attach your changes to an existing pull request or fetch its description and discussions, so findings can differ".
  - **Two bugs found on the way:** the branch's own review found that, with the flag off, a comment in the one tick before `waiting` demoted Ready to merge (fixed in `d279edf`). CodeRabbit's review of PR #18 found that a work order already in `pr-review` when the flag goes off still polled CodeRabbit (`Minor`, valid, fixed in `37b1ccf`).
  - **Seen live on 0004:** PR #8 went from `pr` to `waiting` in one tick, CodeRabbit's skip of it held nothing, and the verdict was Ready to merge. The CLI's first live run, H-312's point (a), is done.
- **Still open from the run** (the register, [handoffs.md](../superpowers/plans/handoffs.md), has each item):
  - **H-310:** "One commit per piece" as an acceptance criterion is unmet after any fix round, and the review prompt says nothing of rounds or commits.
  - **H-311:** warts of the planning PR's status thread and of what stays on a merged PR. The first final comment stays after a retry. A merged row and a merged PR's body keep the last verdict and its reason. A run that failed before any model call counts at its whole budget. Every row with a run reads `(budget: spend unknown)`, since a verify run leaves no spend total.
  - **H-312, points (b) to (g).** Among them (f): the contract's `auto_pause_after_reviewed_commits: 2` paused CodeRabbit after PR #3's second reviewed head (`Reviews paused`, last reviewed commit `0669be0`), so with the round on a third head would read `Review paused`, as hapi-factory's own PR #15 did. That was not seen on a factory PR: PR #3 had two heads. And (g), the `complete` line's fields that the harvest doesn't read, above.
  - **H-313:** no test validates the runbook's hand-written planning files. The controller turned them into a script each time and checked it in a scratch clone, and those scripts lived in a temp directory that the reboot cleared.
  - **H-314:** a failed run's reason is only `the workflow failed (Archon status failed)`, and the runbook has no read for its cause.
  - **H-315:** display defects seen live. The one verdict named two ways, above. The review's first pass on 0001 returned five criteria for a `task.md` that lists four, and the Evidence cell counted them (`5 of 5 criteria met`). The cell's grammar, `1 findings`. The status row's Rounds cell reads `1 automatic, 0 rework` for a work order with no fix round: it counts the worker run. PR #5 never names its sibling, PR #6.
  - **H-298:** the review zone's three CodeRabbit hosts, above.
  - **H-167:** what is left after the key, above.
  - **H-281:** all three live checks are done (the stop; the modes, mirror `2755` and scratch `755` with nothing unreadable; a throwaway unit with both settings, which printed `0077`, `29.9.3/29.9.3` and `a container started`). The unit still has neither setting: the decision is open.

The decisions and the operator's calls, Plan 06's first labelled data (H-262):
- **Five harvests, one decision each:** `decide: diff-screen v1712cb02899c`, on `cb7b218`, `0669be0`, `7a2e5ca`, `30dadf8` and `7f50c0d`. The calls for each head were 8, 2, 2, 2 and 2, of `max_calls_per_head` (24). Every answer came via jev except one via default (the hold), and six were reused on `0669be0`; none came via haiku. The spend: `decisions $0.0006 (10 calls)` on PR #3 and `decisions $0.0001 (2 calls)` on each of PRs #5, #6 and #8.
- **One hold, and it was a false alarm.** On `cb7b218`: `9 files screened (8 asked, 0 reused; jev 8, default 1)`, `1 hold, 1 note`. The hold: `` `bun.lock`: not screened (skip_paths names it as a lockfile, but it doesn't parse as bun.lock) (gates.decisions.by_name.diff-screen.on_unscreened: hold) ``. It is a coverage hold (a subject no classifier answered), not a finding hold, and its cause was the engine bug H-308. The operator's call: disagreed, "we fixed a bug". PR #3 was not merged at that head, but the held file never changed: `bun.lock` is +194 −0 at both heads, and the hold went away at the next harvest because hapi-factory was fixed.
- **One note, disagreed.** On the same head, `tests/crack-cookie.test.ts`: `decide diff-screen: reviewer_steer 0.03, loosened_check 0.02, stand_in 0.50, beyond_goal 0.10, via jev`. The operator's call: "Jev did its job", but it can't take the context that the file is a test double, and "it would be silly to react to that". The note was gone on `0669be0`.
- **The other four harvests passed,** with no hold and no note: nothing to call.
- **The rates so far:** `diff-screen` held 1 of the 4 factory PRs, and the operator agreed with 0 of its 1 holds and 0 of its 1 notes. H-262 kills or demotes a question when "the operator agrees with under half of its holds" or "it falsely holds more than 1 in 10 clean PRs", on at least 20 real PRs and a planted suite; the sandbox is "a first sample, not a verdict".
- **Two more flags held a PR that the operator merged unchanged.** Neither is a decision's hold; both are kept here so that they aren't dropped.
  - **The review's needs-work on `0669be0`,** for its major finding: `[major] .git (commits cb7b218, 0669be0): The crack-cookie piece has two commits with the same message, so the history has three commits for two pieces. Criterion 4 asks for one commit per piece.` The operator disagreed (the criterion is "a little restrictive", and could steer workers towards less atomic commits) and merged PR #3 with it standing: a false alarm (H-310). The review's two minor findings on that head: agreed, one merged as is and one partly reworked.
  - **`CodeRabbit did not review <h7>: Review skipped: bot user not eligible for review` on PRs #5 and #6.** Both were merged unchanged, on the operator's review. The controller's notes call the flag accurate; no agreed or disagreed call of the operator's is recorded for it.
- **PR #8 had nothing to call:** no hold, no note, no review finding and no CodeRabbit finding. The operator merged it on reading it Ready to merge.
- **Not read:** the decision ledger's own lines. The operator's reads were summed by head (for `cb7b218`: 8 `asking` lines; jev pass 7, jev note 1, default hold 1), Step 11's `jq` read was not pasted, and for 0004 the decision ledger was not read at all.

CodeRabbit's findings (H-168):
- **Factory PR #3,** reviewed twice on the PR, in the trial: none at major or above; one `Minor` (`src/bakery.ts` line 22, `Reject malformed fortunes before returning them.`) and two `Trivial` nitpicks. The `Minor` was fixed in part, by the rework and not by an automatic round. Nothing was declined. Both nitpicks and the rest of the `Minor` were merged as is. CodeRabbit raised nothing again; the independent review raised the `Minor`'s remainder once.
- **Factory PRs #5 and #6:** not reviewed (the skip).
- **Factory PR #8:** by the CLI, in the review run, 0 findings at any severity. On the PR: skipped, and not read.
- **No automatic fix run started from a CodeRabbit finding,** on a PR or before one, anywhere in the run.
- **hapi-factory's own PRs in the same days:** PR #15, 5 findings (2 `Major`, 2 `Minor` and 1 with no severity word, `Detected with Advanced Tier`): 3 fixed as raised, 1 real and fixed another way, and 1 already in the register (H-298). PR #16, 2 `Major`, both valid and fixed. PR #17, skipped by its title (`Review skipped: ignored keyword in the PR title`). PR #18, 1 `Minor`, valid and fixed.
- **The controller's notes against GitHub:** the notes count root inline comments, one on PR #3 at `cb7b218` and "1 root comment" again at `0669be0`. On GitHub that is one comment, the first review's, carried to the new head; and each of the two reviews also holds one `Trivial` nitpick in its body.

Small things seen, with no register item:
- **No `bun add` line in the worker's transcript** (run `1433bf348f72`). Task 1's ruling, that `bun add` works under `BUN_OPTIONS=--no-install`, is shown by the result and not by the command: `@modelcontextprotocol/sdk` `1.32.2` and `zod` `4.6.7`, exact, in `package.json` at `cb7b218`, the SDK in `bun.lock`, and verify's frozen install agreeing.
- **CodeRabbit's nitpicks on the planning PRs' acceptance tests,** all `Trivial`. On PR #2: `Enforce the one-item result contract.` and `Test seeded results across server instances.` On PR #4: `Test clock independence across fresh server instances.` The ruling on the first two: leave the runbook's test as is. The third was merged as is.
- **`ci / gates` started about four minutes late on `0669be0`.** The push was at 16:09:01Z and the workflow's run was created at 16:13:21Z, during GitHub's "Incident with Actions and Pull Requests". Not the factory's; the verdict waited meanwhile.
- **The operator's mise updated itself** to 2026.11.4 during a `mise run`. The run image has mise 2026.10.9. No follow-up.
- **Sandbox PR #1,** Dependabot's (`@types/bun` 1.4.2 to 1.4.4), was left unmerged for the run and was still open on 2026-11-11.
- **Port 8080 on the build host is taken** by another service, so the bakery can't bind there outside a run's network, which is where the sandbox's design doc tells a reader to run it. It doesn't matter to a run.

Not shown by this run:
- **An automatic fix round,** before a PR or on one. No round-0 review said needs-work, and CodeRabbit raised nothing at major or above, on a reviewed factory PR or from the CLI. The run's one fix run is the rework's.
- **CodeRabbit's CLI with something to say:** a finding at any severity; the fix round a critical or major one starts before the PR (`fix_rounds_before_pr`); the gate's exit 2; a review that doesn't happen (H-312(e)); a second review of a fixed head; a rate limit, and the Essentials CLI allowance per hour.
- **CodeRabbit on a factory PR with a seat for the bot,** and a third reviewed head with the round on (H-312(f)).
- **A cap tripping.** None did, so "every cap that tripped stopped things and said so" has nothing under it.
- **Design §7 items 4 and 9** as named checks, item 6's named properties, item 10's first half, and item 5 for a free or open-source plan.
- **`preflight`'s own result:** no read quotes it for any run.
- **`egress-archon`'s log:** its refusals, and what a verify run's install reached.
- **The planner App:** all three planning PRs were the operator's own.
- **A `Co-authored-by` in a worker's commit** (H-300): no worker wrote one.
- **The decision ledger's own lines,** and the offline replays of `diff-screen` (H-262) and `finding-triage` (H-263).
- **The raw output behind some figures:** `hapi status` and `hapi run list` at Step 10 (their totals and counts only), `hapi status` after 0004, the stop check's five lines, the audit's fail lines, and the whole of `hapi retry`'s line.
- **Times and turns:** each run's own start and finish (the ticks are about two minutes apart), the turns of the review and verify runs and of the failed run, and the records of 0004's runs.
- **The Console's month-to-date spend** (the figure read was a 30-day one for the whole workspace), what OpenRouter billed for the decisions, the engine's own sum per UTC day against the day's $10, and whether the Console's limit was raised again.
- **H-281's decision,** and whether GitHub collapsed any file in a factory PR's Files changed tab (H-302).
- **The operator's call** on `CodeRabbit did not review …` (PRs #5 and #6) and on CodeRabbit's nitpicks.
