/**
 * The run disk's place and its lock (design §3.1; H-210, H-217).
 *
 * The run disk is where every run's `/work` and `/out` live (./disk.ts): a
 * fixed, root-made path outside hapi's home, since root never acts on a path
 * inside it (docs/runbooks/stack.md, "Hardening").
 *
 * Its lock is the one `hapi stack down` and a finalize's copy-out share: the
 * secrets commands' lock (`withStoreLock`, on the user's tmpfs), keyed by the
 * run disk's path, so one lock for every run. `down` holds it while it removes
 * the runs, so a copy-out never reads a volume `down` is removing (its
 * helper's `-v` would make an unlabelled volume, or meet `volume is in use`);
 * a finalize holds it while it copies its run out, up to about six bounded
 * helper calls (6 x 160 s: the container's exit code, the listing and four
 * reads). A held lock fails at once, naming its holder.
 * `down` never waits for it, so kill switch 3 still takes seconds. A finalize
 * does wait: `finalizeRun` tries again each second, up to FINALIZE_WAIT_S,
 * whether `down` holds it or another run's copy-out (or a reap's finalize)
 * does. With `runs.max_live` at 1 only one run is ever finalizing, so those
 * waits can't stack; raising `max_live` needs this revisited.
 *
 * It imports nothing from src/run or src/stack, so src/stack/up.ts and
 * ./records.ts can both import it without a cycle.
 */
import { SecretError } from "../secrets/provider";
import { withStoreLock } from "../secrets/store-files";

/** The run disk's mount point (docs/runbooks/runs.md#the-run-disk). */
export const RUN_DISK = "/var/lib/hapi/rundisk";

/** Run `fn` holding the run disk's lock (see the module comment). It fails at once if another live process holds it. */
export function withStackLock<T>(d: { diskDir: string; env: Record<string, string | undefined> }, what: "stack-down" | "run-copyout", fn: () => Promise<T>): Promise<T> {
  return withStoreLock(d.diskDir, what, fn, { env: d.env, label: what === "stack-down" ? "hapi stack down" : "hapi run" });
}

/** Whether `e` is `withStoreLock` refusing a lock another live process holds. */
export const lockHeld = (e: unknown): boolean => e instanceof SecretError && e.message.includes("hapi never takes the lock");
