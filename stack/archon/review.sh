#!/bin/sh
# The review container's prelude (Plan 03 Task 8; design §3.5). The launcher binds this file read-only at
# /opt/hapi/review.sh and runs it as `sh /opt/hapi/review.sh factory-review <sha> <work-order-id> <traceparent>`.
# Fixed text: nothing a run, a repo or a work order says is in it. The review container holds the review zone's
# keys, and its only proxy is egress-review, so it runs none of the repo's code: nothing here installs or runs a
# repo script, and the checkout is made read-only before Archon starts. It makes no bundle. It is verify.sh with
# that one step more, and its shared regions are run.sh's, byte for byte (tests/run/prelude.test.ts): change the
# three preludes together.
set -eu
mkdir -p /.archon/workspaces /.archon/worktrees

# The clone is sparse and stripped of what a repo could use to steer Archon, Pi or Claude Code: .archon/, .pi/ and
# .agents/ at its root, .claude/ and CLAUDE.md at any depth, and .mcp.json at its root (spike 09, T19). They stay in
# the index as skip-worktree entries, so nothing reads as deleted. /work holds the clone alone (spike 09, T17).
git clone --no-checkout --no-hardlinks /src/repo.git /work/repo
git -C /work/repo sparse-checkout set --no-cone '/*' '!/.pi/' '!/.agents/' '!/.archon/' '!.claude/' '!CLAUDE.md' '!/.mcp.json'
git -C /work/repo checkout --detach "$2"
git -C /work/repo remote remove origin

# The checkout holds no symlink: a committed one (`notes.md -> /proc/1/environ`, `d -> /`) would let the review's
# Read, Grep and Glob leave /work/repo. With core.symlinks off, git checks each one out again as a plain file that
# holds its target's text, so the review still reads what the change committed, and the status stays clean;
# anything else ends the prelude here, before Archon starts.
git -C /work/repo config core.symlinks false
find /work/repo -path /work/repo/.git -prune -o -type l -exec rm -f {} +
git -C /work/repo checkout -- .
st=$(git -C /work/repo status --porcelain)
if [ -n "$st" ]; then echo "prelude: the checkout is not clean once its symlinks are plain files" >&2; exit 1; fi

# The checkout is read-only, .git aside, which git still writes: the review reads the repo and never changes it.
# Archon writes nothing there (spike 09, T19 r6). No symlink is left, and none is followed: chmod would follow one
# to its target, out of the checkout (/out, say), and fail the prelude on a dangling one.
find /work/repo -path /work/repo/.git -prune -o ! -type l -exec chmod a-w {} +

# Archon starts from /app, never from inside the clone: started there it would load the repo's .archon/.env
# over the container's settings, and Bun would run the repo's bunfig.toml preload inside Archon itself.
cd /app
# `docker stop` sends TERM to this shell, which passes it on: Archon marks the run failed and exits. The trap is
# in place before bun starts. A TERM that arrives before then is a no-op (pid is still empty): Docker's stop
# timeout then ends the container, and the launcher records the run. `|| true`, because a trap body that fails
# under set -e ends the script (bun already gone), before the read-back below.
pid=
trap 'kill -TERM "$pid" 2>/dev/null || true' TERM INT
bun --no-env-file /app/packages/cli/src/cli.ts workflow run "$1" --cwd /work/repo --no-worktree --config /opt/hapi/run-config.yaml --input work_order_id="$3" --input traceparent="$4" &
pid=$!
# The workflow's exit code is data, so it is captured, never allowed to end the script. A trapped signal ends
# `wait` early (and with a code above 128), so wait again until the process is gone.
rc=0; wait "$pid" || rc=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid" || rc=$?; done

# From here on, nothing may abort: a failed, stopped or timed-out run still leaves what it can. Each failure
# is noted on stderr (the launcher's live view is `docker logs`).
set +e
# As PID 1, kill whatever the workflow left running (a background job the repo's checks started), so nothing the
# change ran still writes the clone or /out while the strip and the read-back below run. The guard matters: where
# this shell isn't PID 1 (a test's sandbox), `kill -1` would signal every process its user has.
if [ "$$" = 1 ]; then kill -s KILL -1 2>/dev/null; fi
# The strip again, before the CLI calls below read the repo's .archon (config, env): the checkout is read-only, so
# this is defence in depth. No bundle: what a review run leaves is its results.
rm -rf /work/repo/.archon /work/repo/.pi /work/repo/.agents /work/repo/.claude /work/repo/CLAUDE.md /work/repo/.mcp.json || echo "prelude: strip failed" >&2
CLI="bun --no-env-file /app/packages/cli/src/cli.ts"
runs=$($CLI workflow runs --json --cwd /work/repo) || echo "prelude: workflow runs failed" >&2
id=$(printf '%s' "$runs" | jq -r '.runs[0].id // empty') || echo "prelude: no run id" >&2
run=null
if printf '%s' "$id" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  run=$($CLI workflow get "$id" --json --verbose --cwd /work/repo) || echo "prelude: workflow get failed" >&2
else
  echo "prelude: run id is not a run id, no workflow get" >&2
fi
printf '{"runs":%s,"run":%s}\n' "${runs:-null}" "${run:-null}" > /out/result.json || echo "prelude: result.json failed" >&2
# The transcript is where `workflow get` says it is (its path depends on how the workflow was registered), but
# that path comes from state the worker could write, so it is copied only if it is this run's own log: a regular
# file, no link anywhere in its path, at /.archon/workspaces/<...>/logs/<run id>.jsonl.
tp=$(printf '%s' "$run" | jq -r '.transcript_path // empty') || echo "prelude: no transcript path" >&2
if [ -n "$tp" ]; then
  real=$(realpath "$tp" 2>/dev/null)
  case "$real" in
    /.archon/workspaces/*/logs/"$id".jsonl)
      if [ "$real" = "$tp" ] && [ -f "$real" ] && [ ! -L "$real" ]; then cp "$real" /out/transcript.jsonl || echo "prelude: transcript copy failed" >&2
      else echo "prelude: transcript path is not a plain file of this run, not copied" >&2; fi ;;
    *) echo "prelude: transcript path is outside this run's logs, not copied" >&2 ;;
  esac
fi
exit "$rc"
