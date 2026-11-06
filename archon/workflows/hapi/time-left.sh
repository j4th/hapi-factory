#!/bin/sh
# The seconds left before the run's deadline (Plan 03 Task 11; ruling b2(7)), as the supervisor counts it: run.json's
# started_at plus the work order's budget.minutes (src/run/lifecycle.ts `startRun`). factory-task's sidecar probe and
# factory-review's CodeRabbit step bound their timeouts by it, so neither outlives the run; the supervisor stops the
# run at the deadline whatever runs. Prints a whole number, negative once the deadline has passed; fails on a run
# file or work order it can't read. Run as `sh /.archon/workflows/hapi/time-left.sh`; both files are the host's,
# bound read-only.
jq -rn --slurpfile run /run/hapi/run.json --slurpfile order /run/hapi/order.json \
  '($run[0].started_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) + ($order[0].budget.minutes * 60) - now | floor'
