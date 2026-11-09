/**
 * The poller's systemd user units (design §3.4; Plan 03 Task 14; spike 09's T20 rulings), into `build/systemd/`:
 *
 * - `hapi-poll.service`: one tick, `mise exec -- bun run src/cli.ts poll --once` in hapi's checkout, `Type=oneshot`,
 *   with its own `PATH` and `XDG_RUNTIME_DIR` (the user manager's env carries whatever the session had; T20). `mise
 *   exec` puts the checkout's pinned tools on PATH, gitleaks among them, which the harvester's secret scan needs at
 *   mise.toml's version, then execs bun, so the tick is the unit's main process: a stop's SIGTERM reaches the tick
 *   itself, and `TimeoutStopSec` bounds it (kill switch 3; Task 14 fix round 1).
 * - `hapi-poll.timer`: the first tick `runs.poll_interval_s` after the timer starts (`OnActiveSec`: without it the
 *   timer never fires, T20), then one `runs.poll_interval_s` after each tick started (`OnUnitActiveSec`).
 *
 * `hapi stack up` links them from build/ into the user manager (`systemctl --user link --runtime`, which a reboot
 * clears), reloads it and enables the timer (`enable --runtime --now`); `down` and kill switch 3 stop them first.
 */
import type { Policy } from "../policy/types";
import { hashComment, notice } from "./header";

/**
 * hapi's checkout and its mise, relative to its home: src/stack/up.ts's `HAPI_CHECKOUT` and `HAPI_MISE`, which a test
 * holds equal. Importing them here would make a cycle (up.ts imports ./index.ts, which imports this module).
 */
const CHECKOUT = "hapi-factory";
const MISE = ".local/bin/mise";
/** A tick's bound: past FINALIZE_WAIT_S (a reap's finalize) and a harvest, so systemd never kills a tick mid-write. */
const TICK_TIMEOUT_S = 1800;
/** How long a stop waits for the tick after its SIGTERM before the SIGKILL: what kill switch 3 waits for at worst. */
const STOP_TIMEOUT_S = 15;

/** `{ "hapi-poll.service", "hapi-poll.timer" }`, each with the generated-file notice first. */
export function emitSystemd(p: Policy): Record<string, string> {
  const s = p.runs.poll_interval_s;
  const head = (what: string) => `${hashComment(notice(what, ["policy/runs.yaml"]))}\n`;
  const service = [
    "[Unit]",
    "Description=hapi-factory poller: one tick (hapi poll --once)",
    `Documentation=file:%h/${CHECKOUT}/docs/runbooks/stack.md`,
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=%h/${CHECKOUT}`,
    "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
    "Environment=XDG_RUNTIME_DIR=%t",
    `ExecStart=%h/${MISE} exec -- bun run src/cli.ts poll --once`,
    `TimeoutStartSec=${TICK_TIMEOUT_S}`,
    `TimeoutStopSec=${STOP_TIMEOUT_S}`,
    "# startRun's detached `hapi run supervise` processes live in this cgroup: control-group would kill them when the",
    "# oneshot exits, and mixed would SIGKILL them at a stop's timeout. process signals the tick (bun, the main PID) alone.",
    "KillMode=process",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    `Description=hapi-factory poller, every ${s} s (runs.poll_interval_s)`,
    "",
    "[Timer]",
    `OnActiveSec=${s}`,
    `OnUnitActiveSec=${s}`,
    "AccuracySec=5s",
    "Unit=hapi-poll.service",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return {
    "hapi-poll.service": `${head("The poller's systemd user service: one tick as hapi (hapi-poll.service)")}${service}`,
    "hapi-poll.timer": `${head(`The poller's systemd user timer: a tick every runs.poll_interval_s (hapi-poll.timer)`)}${timer}`,
  };
}
