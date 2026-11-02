#!/bin/sh
# The factory workflows' mise-config scan (Plan 03 Task 11; H-194), run from the checkout's root by factory-task's
# preflight and gates and by factory-verify, as `sh /.archon/workflows/hapi/mise-config-scan.sh`: one copy, here in
# the pack, which a run binds read-only. Fixed text, and quiet when the checkout is clean; each hit goes to stderr,
# and the scan exits 1.
#
# First CI's scan, verbatim (.github/workflows/ci.yml, the step "Only the root mise.toml configures mise";
# tests/run/workflows.test.ts holds the two equal): a plain find, before mise runs at all, for every mise config, task
# dir, lockfile or .tool-versions besides the root mise.toml and the root mise.lock that locks it, at any depth and
# in any case. mise would install what such a file names, export the env it sets and run the tasks it defines, so a
# file a worker or a change adds could redefine the check the gates run. Then CI's second net, for a file the scan
# doesn't know by name (a newer mise's), stricter here than CI's: any config or task file mise says it loaded but the
# checkout's root mise.toml, wherever it is. The image points mise's global config at an empty read-only dir
# (stack/archon/Dockerfile), so a config the worker writes under $HOME doesn't load; this catches one that would.
extra="$(find . -path ./.git -prune -o \( -iname mise.toml -o -iname .mise.toml -o -iname 'mise.*.toml' -o -iname '.mise.*.toml' \
  -o -iname mise.lock -o -iname 'mise.*.lock' -o -iname mise -o -iname .mise -o -iname mise-tasks -o -iname .mise-tasks \
  -o -iname .tool-versions \) ! -path ./mise.toml ! -path ./mise.lock -print -prune)"
if [ -n "$extra" ]; then
  echo "mise files besides the root mise.toml and mise.lock. Move what is needed into mise.toml and remove:" >&2
  printf '%s\n' "$extra" >&2
  exit 1
fi

configs="$(mise config ls --json)" || { echo "mise config ls failed: mise can't read the checkout's mise.toml" >&2; exit 1; }
tasks="$(mise tasks ls --json --hidden)" || { echo "mise tasks ls failed: mise can't read the checkout's tasks" >&2; exit 1; }
extra="$(jq -rn --arg root "$PWD/" --argjson configs "$configs" --argjson tasks "$tasks" \
  '[$configs[].path, $tasks[].source] | unique[] | select(type != "string" or . != $root + "mise.toml")')" || { echo "what mise loaded can't be read" >&2; exit 1; }
if [ -n "$extra" ]; then
  echo "mise config or tasks besides the root mise.toml. Move what is needed into mise.toml and remove:" >&2
  printf '%s\n' "$extra" >&2
  exit 1
fi
