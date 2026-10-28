# Spike 01: Pi under Archon

- **Plan 01 Task 8**, for Plans 02 and 03 (the worker and the run engine). Run on 2026-10-28.
- **Archon:** v0.12.1, the stack's pinned image (`stack/archon/Dockerfile`), with the Pi SDK 1.3.0 it embeds.
- **Result: the guard works; the stack's Pi directory doesn't.** With the repo's `.pi/` and `.agents/` stripped, no repo extension ran and nothing was installed. A user-level extension loaded, blocked a write to `AGENTS.md`, and failed its node when it threw. But:
  - **No Pi node can run in the stack as built.** Pi must write into `PI_CODING_AGENT_DIR`, which the stack mounts read-only.
  - **The strip is the only thing that stops a repo's own code.** Archon trusts the repo's `.pi/` outright. Without the strip, its extension ran in the Pi worker.

## Setup

- **Where:** the operator's own Docker, as its own Compose project, `hapi-t8`. `down -v` removed its volumes and networks afterwards.
- **What:** the stack's own `archon` and `egress-archon` services from `stack/compose.yaml`, with the archon zone's secrets from `hapi secrets resolve` and the generated `build/archon/config.yaml` (roster `anthropic`). A gitignored override under `spikes/scratch/8/` mounted the spike's workflows at `/.archon/workflows` and replaced the Pi directory (finding 1).
- **The test extension**, `t8-guard.ts`, in `PI_CODING_AGENT_DIR/extensions/`:
  - its `tool_call` handler returns `{ block: true, reason }` for `write` or `edit` on `AGENTS.md`;
  - its `before_provider_request` handler throws when `FAIL_ME=1`;
  - it logs to `/tmp/t8-guard.log`.
- **The target repo,** in `/tmp/target`, held committed decoys:
  - `.pi/extensions/evil.ts`, which writes `/tmp/pwned` when loaded;
  - `.pi/settings.json`, listing `npm:@hapi-t8/does-not-exist`;
  - a repo skill in `.agents/skills/`;
  - `AGENTS.md`.
- **The workflows,** run with `bun packages/cli/src/cli.ts workflow run <name> --cwd /tmp/target --no-worktree` (finding 8). All three passed `validate workflows` with no issues.
  - **`t8-strip`:** a bash node runs `rm -rf .pi .agents`. Then a Pi node (`anthropic/claude-haiku-5-5`, `pi: { enableExtensions: true }`, `allowed_tools: [read, write, edit, ls]`) is asked to add a line to `AGENTS.md`.
  - **`t8-nostrip`:** the same Pi node with the repo's `.pi/` in place, the control the plan didn't have. With the strip, `.pi/settings.json` is gone before Pi starts, so "no install" would pass whether or not `PI_OFFLINE` works.
  - **`t8-claude`:** one Claude-provider node (`claude-haiku-5-5`), for H-063.

## Evidence

| Run | What happened |
|---|---|
| A, `t8-strip` | **Passes.** The strip ran, then the Pi node: `[work] Started (pi/anthropic/claude-haiku-5-5)`, and it replied `BLOCKED`. The extension's log: `loaded`, `tool_call read path=/tmp/target/AGENTS.md`, `tool_call write path=/tmp/target/AGENTS.md keys=path,content`, `blocked write /tmp/target/AGENTS.md`. No `/tmp/pwned`; `AGENTS.md` unchanged; one tunnel, to `api.anthropic.com`. |
| C, `t8-strip` with `FAIL_ME=1` | **Passes.** `Node 'work' failed: provider reported unknown: Pi extension '/opt/hapi/pi-agent/extensions/t8-guard.ts' failed during 'before_provider_request': T8 spike: FAIL_ME=1`, with the stack trace, then `Workflow failed`, exit 1. No tunnel at all: it failed before the request. |
| B, `t8-nostrip` (control) | **The repo's extension ran:** `/tmp/pwned` reads "the repo's .pi/extensions/evil.ts ran, pid 1200", the same process as the guard. The guard still blocked the write. **No install:** no `registry.npmjs.org` tunnel for the listed package, which Pi skipped silently; one tunnel, to `api.anthropic.com`. |
| D, `t8-claude` | **Passes:** `[hello] Started (claude/claude-haiku-5-5)`, `OK`. With `ANTHROPIC_API_KEY` blanked (`-e ANTHROPIC_API_KEY=`, length 0), it still answered `OK`: the provider read `CLAUDE_API_KEY` and mirrored it into `ANTHROPIC_API_KEY` (`packages/providers/src/claude/provider.ts`). `CLAUDE_CODE_OAUTH_TOKEN` isn't set in the archon zone. |

The register items:
- **H-061.** With the directory writable, the model ref resolved offline from Pi's built-in catalog, with no baked `models-store.json`. Pi then wrote `models-store.json`, an empty `auth.json` and `sessions/` into `PI_CODING_AGENT_DIR`, so Pi's session directory lands there.
- **H-062.** No warning about `models.json`'s `$comment` in any run's log.
- **H-063.** Settled by run D.

## Findings

1. **A read-only `PI_CODING_AGENT_DIR` fails every Pi node.** The first run A failed at Archon's credential preflight: `Credential setRuntimeApiKey committed for anthropic, but local synchronization failed`. On the pinned Pi 1.3.0, the cause is `EROFS: read-only file system, open '/opt/hapi/pi-agent/models-store.json'`. Pi's `ModelRuntime` keeps a file-backed models store next to `models.json`, and the credential sync writes it every time. Archon calls `ModelRuntime.create()` with no store path, so nothing moves it.
   - **Tested fix:** a tmpfs at `PI_CODING_AGENT_DIR` (`size=64m,uid=1001,gid=1001,mode=0700`), with `models.json`, `hapi-guard.json`, `extensions/` and an empty `settings.json` (`{}`) bound read-only into it. Pi writes only its cache and sessions, which are gone at the next start. Nothing in the container can change hapi's files, or create a `settings.json` that adds packages. Runs A to D ran this way.
   - **The cost:** Pi's sessions don't outlive the container, so Archon's session resume across a restart is lost. The operator accepted that on 2026-10-28: a Pi node is an idempotent unit of work, as a worker is in a data pipeline. So a restarted run starts over from a fresh worktree cut from the same merge commit, never on the partial edits of the old one (H-161).
2. **Archon trusts the repo's `.pi/`, so the strip is the only prevention.** Pi 1.3.0's settings manager starts with `projectTrusted = true`. Pi resolves trust only when its loader is given a `resolveProjectTrust` callback, and Archon's resource loader calls `reload()` without one. So Pi's headless default, which skips an untrusted project's resources, never applies under Archon. A `project_trust` handler in hapi-guard would never fire.
   - **In practice:** in run B, the repo's `evil.ts` ran in the Pi worker process, with the archon zone's environment (its model keys) and the zone's egress, which includes `registry.npmjs.org`.
   - **So:** stripping `.pi/` and `.agents/` before every Pi node is the only thing that keeps a repo's code out of the worker.
   - **A backstop, not a stop:** hapi-guard can fail the node when it finds `.pi/` or `.agents/` in its working directory. That can't stop a repo extension's import-time code, which runs in the same loading pass.
3. **Extensions are on unless a node says otherwise.** Archon 0.12.1 resolves `enableExtensions` as the node's `pi:` value, else `assistants.pi.nodes.<id>`, else `assistants.pi.enableExtensions !== false`. hapi's generated config sets none of these, so every Pi node loads extensions. hapi-guard needs them on, but the setting should be explicit, so the audit can hold it.
4. **`PI_OFFLINE=1` holds by itself.** With a repo `.pi/settings.json` listing a package, and `registry.npmjs.org` on the zone's list, Pi made no request for it and skipped the package silently.
5. **A hook that throws fails its node.** Pi's docs say it "reports handler errors and continues where possible", but Archon's extension-error broker turns the error into a node failure, with the extension's path and stack. So an extension is a real guard.
6. **The guard's inputs.** Pi's `write` tool call carries `input.path` and `input.content`, with an absolute path (`/tmp/target/AGENTS.md`). `{ block: true, reason }` from `tool_call` stops the call, and the model sees it as blocked.
7. **Bun auto-installs from npm in the Archon container.** A `bun` script whose imports don't resolve from a nearby `node_modules` installs them on the fly. The spike's own diagnostic script, run from `/tmp`, pulled `@earendil-works/pi-coding-agent` 1.4.0, the latest release, not the pinned 1.3.0, plus its dependencies: 56 tunnels to `registry.npmjs.org`. They went into `~/.bun/install/cache`, which in the stack is the persistent `archon-home` volume. Run from `/app`, the same imports resolve to the pinned 1.3.0 with no traffic. A worker that runs `bun` on a script in a repo gets the same unpinned install. Bun's own switches: `--no-install` per command; `install.auto = "disable"` in a `bunfig.toml`, which counts only in the directory `bun` starts in; and a security scanner configured in the global `.bunfig.toml`, which turns auto-install off everywhere.
8. **Worktree isolation needs a git remote.** `--branch` refused a repo with no remote: `Cannot determine git remote … use --no-worktree`. The spike ran in the live checkout, which doesn't change where Pi loads `.pi/` from, its working directory. Plan 03 registers codebases with a remote (`worktree.remote`). The archon zone has no route to GitHub, so Plan 03 also checks that cutting a worktree never fetches.
9. **Not covered:** H-119's portable-roster output limits, since only the `anthropic` roster ran.

## Decision

Pi stays in-process with Archon (spec §9.3). The worker posture becomes:
- the Pi directory on a tmpfs, with hapi's files bound read-only into it;
- `enableExtensions` set explicitly, so hapi-guard loads;
- a strip before every Pi node, as the only stop for a repo's `.pi/` and `.agents/`;
- `PI_OFFLINE=1`;
- Bun's auto-install turned off for anything Archon runs.

## Consequences

- **Plan 02 (H-181):** the Pi directory's layout, in `stack/compose.yaml` and its tests; `assistants.pi.enableExtensions` in the generated config; Bun's auto-install; and hapi-guard's backstop check for `.pi/` and `.agents/`. H-087 gets the guard's inputs (findings 5 and 6).
- **Plan 03 (H-161):** the strip node before every Pi node; codebases registered with a remote, never fetched from; and a restarted run starting over from a fresh worktree, since sessions are on tmpfs.
- **The threat model:** DS-11's read-only directory is replaced by the layout in finding 1. DS-15's strip is the only prevention (finding 2).
- **Closed:** H-061, H-062 and H-063.
