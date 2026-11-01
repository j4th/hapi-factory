/**
 * The run disk's place and its lock (design §3.1; H-210, H-217).
 *
 * The run disk is where every run's `/work` and `/out` live (./disk.ts): a
 * fixed, root-made path outside hapi's home, since root never acts on a path
 * inside it (docs/runbooks/stack.md, "Hardening").
 *
 * Its lock is the one `hapi stack down` and a finalize's copy-out share: the
 * secrets commands' lock (`withStoreLock`, on the user's tmpfs), keyed by the
 * run disk's path. `down` holds it while it removes the runs, so a copy-out
 * never reads a volume `down` is removing (its helper's `-v` would make an
 * unlabelled volume, or meet `volume is in use`); a finalize holds it while it
 * copies a run out. A held lock fails at once, naming its holder: neither
 * waits on the other, so kill switch 3 still takes seconds.
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
  return withStoreLock(d.diskDir, what, fn, { env: d.env });
}

/** Whether `e` is `withStoreLock` refusing a lock another live process holds. */
export const lockHeld = (e: unknown): boolean => e instanceof SecretError && e.message.includes("hapi never takes the lock");
