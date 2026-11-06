/**
 * The poller's systemd user units (Plan 03 Task 14, src/generate/systemd.ts): `build/systemd/hapi-poll.service`, one
 * tick as hapi through the checkout's `mise run hapi`, and `hapi-poll.timer`, every `runs.poll_interval_s` from the
 * first tick on (T20's rulings: `OnActiveSec`, or the timer never fires).
 */
import { describe, expect, test } from "bun:test";
import { emitSystemd } from "../../src/generate/systemd";
import { loadPolicy } from "../../src/policy/load";
import { FINALIZE_WAIT_S } from "../../src/run/lifecycle";
import { HAPI_CHECKOUT, HAPI_MISE } from "../../src/stack/up";

const p = loadPolicy("policy");

/** A unit's lines after its notice, with every `#` comment line dropped. */
const body = (text: string) => text.split("\n").filter((l) => !l.startsWith("#"));

const SERVICE = [
  "[Unit]",
  "Description=hapi-factory poller: one tick (hapi poll --once)",
  "Documentation=file:%h/hapi-factory/docs/runbooks/stack.md",
  "",
  "[Service]",
  "Type=oneshot",
  "WorkingDirectory=%h/hapi-factory",
  "Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin",
  "Environment=XDG_RUNTIME_DIR=%t",
  "ExecStart=%h/.local/bin/mise exec -- bun run src/cli.ts poll --once",
  "TimeoutStartSec=1800",
  "TimeoutStopSec=15",
  "KillMode=process",
  "",
];
const TIMER = (s: number) => [
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
];

describe("emitSystemd", () => {
  test("after the notice, the service and the timer are exactly the units T20's rulings give", () => {
    const units = emitSystemd(p);
    expect(Object.keys(units).sort()).toEqual(["hapi-poll.service", "hapi-poll.timer"]);
    expect(body(units["hapi-poll.service"]!)).toEqual(SERVICE);
    expect(body(units["hapi-poll.timer"]!)).toEqual(TIMER(120));
    for (const text of Object.values(units)) {
      // The notice first: # comments naming policy/runs.yaml, and not to edit the file by hand.
      expect(text.startsWith("# ")).toBe(true);
      expect(text).toContain("policy/runs.yaml");
      expect(text).toContain("Do not edit it by hand: change policy/ and run `mise run policy:build`.");
      expect(text.endsWith("\n")).toBe(true);
    }
  });

  test("KillMode=process says why, just above it: the detached supervisors live in the service's cgroup, and bun is the main PID", () => {
    const lines = emitSystemd(p)["hapi-poll.service"]!.split("\n");
    const at = lines.indexOf("KillMode=process");
    const comment = lines.slice(0, at).reverse();
    const why = comment.slice(0, comment.findIndex((l) => !l.startsWith("#"))).reverse();
    expect(why).toEqual([
      "# startRun's detached `hapi run supervise` processes live in this cgroup: control-group would kill them when the",
      "# oneshot exits, and mixed would SIGKILL them at a stop's timeout. process signals the tick (bun, the main PID) alone.",
    ]);
  });

  test("the tick is the main process: mise exec runs bun in its place, never mise run's task shell, and a stop waits 15 s at most", () => {
    const service = emitSystemd(p)["hapi-poll.service"]!;
    expect(service).toContain("ExecStart=%h/.local/bin/mise exec -- bun run src/cli.ts poll --once\n");
    expect(body(service).some((l) => l.includes("mise run"))).toBe(false);
    expect(service).toContain("TimeoutStopSec=15\n");
    // %t is the user manager's runtime dir: the locks and the zone env files are under it.
    expect(service).toContain("Environment=XDG_RUNTIME_DIR=%t\n");
  });

  test("poll_interval_s: 300 gives 300 in all three places", () => {
    const q = structuredClone(p);
    q.runs.poll_interval_s = 300;
    const timer = emitSystemd(q)["hapi-poll.timer"]!;
    expect(body(timer)).toEqual(TIMER(300));
    expect(timer.match(/\b300\b/g)).toHaveLength(3);
  });

  test("the paths are up.ts's: hapi's checkout and its mise, under %h", () => {
    const service = emitSystemd(p)["hapi-poll.service"]!;
    expect(service).toContain(`WorkingDirectory=%h/${HAPI_CHECKOUT}\n`);
    expect(service).toContain(`ExecStart=%h/${HAPI_MISE} exec -- bun run src/cli.ts poll --once\n`);
    expect(service).toContain(`Documentation=file:%h/${HAPI_CHECKOUT}/docs/runbooks/stack.md\n`);
  });

  test("the tick's timeout outlasts a finalize's wait and a harvest", () => {
    const timeout = Number(/^TimeoutStartSec=(\d+)$/m.exec(emitSystemd(p)["hapi-poll.service"]!)![1]);
    expect(timeout).toBe(1800);
    expect(timeout > FINALIZE_WAIT_S + 300).toBe(true);
  });
});
