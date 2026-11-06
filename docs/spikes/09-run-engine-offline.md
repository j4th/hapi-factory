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
