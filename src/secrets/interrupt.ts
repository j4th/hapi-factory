/**
 * What a `hapi secrets` command undoes when it is interrupted: SIGINT
 * (Ctrl-C), SIGTERM or SIGHUP (the terminal closed).
 *
 * Bun's default for these signals is to exit at once, without running a
 * `finally`. So a command that holds the store's lock (./store-files.ts), or
 * has the terminal's echo off while it reads the recovery words
 * (./recovery.ts), registers what to undo with `onInterrupt`. While anything
 * is registered, hapi handles the three signals itself: it runs each undo
 * (synchronously, newest first), prints one line on stderr (`hapi secrets
 * drill: cancelled (SIGINT)`) and exits 128 + the signal's number, 130 for
 * Ctrl-C. Once nothing is registered, the default comes back.
 *
 * `shielded` runs a step that must not be cut in half: the renames that put
 * a changed store, recovery.age and recipients file in place. A signal during
 * it waits until the step has finished (or rolled itself back). With
 * `ignoreInterrupt` (an interactive `sops edit`), SIGINT is left to the child
 * in the foreground, as system(3) does, and the others wait for it.
 *
 * It imports nothing of hapi's, so every module can use it without a cycle.
 */
import { writeSync } from "node:fs";

export type Signal = "SIGINT" | "SIGTERM" | "SIGHUP";

const SIGNALS: readonly Signal[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const NUMBER: Record<Signal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** One thing to undo: synchronous, so it can run from a signal handler; it may return a note for the message. */
interface Undo {
  run: () => string | void;
  label?: string | undefined;
}

const undos: Undo[] = [];
let deferring = 0;
let ignoringInt = 0;
let pending: Signal | undefined;
let installed = false;

/** One listener per signal, each knowing its own signal (not trusting the listener's argument). */
const LISTENERS = Object.fromEntries(SIGNALS.map((s) => [s, () => onSignal(s)])) as Record<Signal, () => void>;

function install(): void {
  if (installed) return;
  installed = true;
  for (const s of SIGNALS) process.on(s, LISTENERS[s]);
}

function uninstallIfIdle(): void {
  if (!installed || undos.length > 0 || deferring > 0 || ignoringInt > 0) return;
  installed = false;
  for (const s of SIGNALS) process.off(s, LISTENERS[s]);
}

function onSignal(sig: Signal): void {
  if (sig === "SIGINT" && ignoringInt > 0) return;
  if (deferring > 0) {
    pending ??= sig;
    return;
  }
  stop(sig, "cancelled");
}

/** Run every undo, newest first, print one line, and exit 128 + the signal's number. */
function stop(sig: Signal, how: string): never {
  const label = undos.find((u) => u.label !== undefined)?.label ?? "hapi";
  const notes: string[] = [];
  for (const u of undos.splice(0).reverse()) {
    try {
      const note = u.run();
      if (note) notes.push(note);
    } catch {
      // An undo that fails must not stop the others.
    }
  }
  try {
    writeSync(2, `${label}: ${how} (${sig})${notes.length > 0 ? `; ${notes.join("; ")}` : ""}\n`);
  } catch {}
  process.exit(128 + NUMBER[sig]);
}

/**
 * Register `run`, to be called if SIGINT, SIGTERM or SIGHUP arrives before the
 * returned function is called. `label` names the command in the message
 * (`hapi secrets drill`); the oldest label registered wins.
 */
export function onInterrupt(run: () => string | void, label?: string): () => void {
  const undo: Undo = { run, label };
  undos.push(undo);
  install();
  return () => {
    const i = undos.indexOf(undo);
    if (i !== -1) undos.splice(i, 1);
    uninstallIfIdle();
  };
}

/**
 * Run `fn` with SIGINT, SIGTERM and SIGHUP held back until it settles. One
 * that arrived meanwhile then stops the command: "cancelled" if `fn` failed
 * (it undid itself), or `done` if it succeeded. With `ignoreInterrupt`,
 * SIGINT is ignored meanwhile instead (the foreground child gets it too).
 */
export async function shielded<T>(fn: () => Promise<T>, o: { done: string; ignoreInterrupt?: boolean }): Promise<T> {
  install();
  deferring++;
  if (o.ignoreInterrupt) ignoringInt++;
  let ok = false;
  try {
    const value = await fn();
    ok = true;
    return value;
  } finally {
    deferring--;
    if (o.ignoreInterrupt) ignoringInt--;
    if (deferring === 0 && pending !== undefined) {
      const sig = pending;
      pending = undefined;
      stop(sig, ok ? o.done : "cancelled");
    }
    uninstallIfIdle();
  }
}
