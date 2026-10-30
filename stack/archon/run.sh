#!/bin/sh
# The run container's prelude (Plan 02 Task 6; design §3.1, §6a; spike 07). The launcher binds this file
# read-only at /opt/hapi/run.sh and runs it as `sh /opt/hapi/run.sh <workflow> <sha> <work-order-id> <traceparent>`
# (a tmpfs is noexec, and sh needs no mode bit). Fixed text: nothing a run, a repo or a work order says is in it.
set -eu
mkdir -p /.archon/workspaces /.archon/worktrees

# The clone is sparse and stripped of the three directories a repo could use to steer Archon or Pi (its own
# workflows, config and env; Pi's extensions and settings; the agent skills). They stay in the index as
# skip-worktree entries, so the worker's commit records its own change and never their deletion.
git clone --no-checkout --no-hardlinks /src/repo.git /work/repo
git -C /work/repo sparse-checkout set --no-cone '/*' '!/.pi/' '!/.agents/' '!/.archon/'
git -C /work/repo checkout --detach "$2"
git -C /work/repo remote remove origin

# Archon starts from /app, never from inside the clone: started there it would load the repo's .archon/.env
# over the container's settings, and Bun would run the repo's bunfig.toml preload inside Archon itself.
cd /app
bun --no-env-file /app/packages/cli/src/cli.ts workflow run "$1" --cwd /work/repo --no-worktree --config /opt/hapi/run-config.yaml --input work_order_id="$3" --input traceparent="$4" &
pid=$!
# `docker stop` sends TERM to this shell, which passes it on: Archon marks the run failed and exits.
trap 'kill -TERM "$pid" 2>/dev/null' TERM INT
# The workflow's exit code is data, so it is captured, never allowed to end the script. A trapped signal ends
# `wait` early (and with a code above 128), so wait again until the process is gone.
rc=0; wait "$pid" || rc=$?
while kill -0 "$pid" 2>/dev/null; do wait "$pid" || rc=$?; done

# From here on, nothing may abort: a failed, stopped or timed-out run still leaves what it can. Each failure
# is noted on stderr (the launcher's live view is `docker logs`).
set +e
# The bundle first, so what the worker committed is exactly what it is. Then the strip: the worker could write
# the clone, and the CLI calls below read the repo's .archon (config, env) from it, so the three steering
# directories go before any Archon call. A commit that holds them is in the bundle, where the host's diff gate sees it.
head=$(git -C /work/repo rev-parse HEAD) || echo "prelude: no HEAD" >&2
if [ "$head" != "$2" ]; then git -C /work/repo bundle create /out/run.bundle "$2..HEAD" || echo "prelude: bundle failed" >&2; fi
rm -rf /work/repo/.archon /work/repo/.pi /work/repo/.agents || echo "prelude: strip failed" >&2
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
