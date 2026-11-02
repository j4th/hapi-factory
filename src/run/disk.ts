/**
 * The run disk (design §3.1; H-217): where a run's `/work` and `/out` live.
 * Each is a bind-backed local volume (`docker volume create --driver local
 * --opt type=none --opt o=bind --opt device=<dir>`, spike 09 finding 16) on a
 * dir of its own, `volumeDir`, in the root of one fixed-size filesystem that
 * the operator makes once (`RUN_DISK`, docs/runbooks/runs.md#the-run-disk). A
 * run that fills its volumes fills that filesystem and gets ENOSPC; Docker's
 * data root, which every run and the stack share, is untouched. All runs
 * share the run disk, and `runs.disk.gb` counts GiB.
 *
 * - `diskProblem`: why a run disk fails `runs.disk`, or undefined. `hapi run
 *   start` checks it before the start lock, and refuses under `hard`; the
 *   audit's `runtime.run-disk` gives the same reason.
 * - `probeFs`: what a path's filesystem is (its device, its size, whether
 *   this user can write it), the one place the real filesystem is read.
 * - `dataRootOf` and `dockerDataRoot`: Docker's data root, from `docker
 *   info`, read once here for the launcher and the audit.
 * - `removeVolumeDirs`: a run's dirs, emptied and removed once their volumes
 *   are gone. Rootless Docker maps uid 1001's files to a subuid hapi can't
 *   delete, so a helper container empties a dir as 1001:1001 (`CLEAN_SCRIPT`),
 *   and hapi then removes the empty dir, which needs only its own write access
 *   to the run disk (spike 09 finding 16).
 */
import { accessSync, constants, lstatSync, statfsSync, statSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { mountable } from "../audit/checks/tools";
import type { Runs } from "../policy/types";
import { definedEnv } from "../stack/up";
import { bounded, HELPER_HOST_TIMEOUT_S, timedOut } from "./copyout";
import { APP_USER, helperLabels, type RunDeps, runLabels, runName } from "./spec";

/** Bytes in a GiB: runs.disk.gb counts GiB, and the messages show GiB to one decimal, labelled "GB". */
export const GIB = 2 ** 30;

/** What `probeFs` says of a directory. */
export interface FsFacts {
  /** Its filesystem's device (`stat`'s `st_dev`): two paths on one filesystem share it. */
  dev: number;
  /** Its filesystem's size (`statfs`: blocks times block size). */
  bytes: number;
  /** Whether this user may make and remove entries in it (`access` W_OK and X_OK). */
  writable: boolean;
}

/** What is at `path`: undefined if nothing is there, or it is not a directory. Throws on any other failure to look. */
export type FsProbe = (path: string) => FsFacts | undefined;

/** The real probe: `statSync`, `statfsSync` and `accessSync`. */
export const probeFs: FsProbe = (path) => {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
  if (!st.isDirectory()) return undefined;
  const fs = statfsSync(path);
  let writable = true;
  try {
    accessSync(path, constants.W_OK | constants.X_OK);
  } catch {
    writable = false;
  }
  return { dev: st.dev, bytes: fs.blocks * fs.bsize, writable };
};

const SETUP = "docs/runbooks/runs.md#the-run-disk";
const inGB = (bytes: number) => (bytes / GIB).toFixed(1);

/**
 * Why `dir` is not a run disk `limits` allows, or undefined. In order: it must be there; be a filesystem of its own
 * (its device is not its parent's); not be Docker's data root's filesystem (`dataRoot`), which a full run disk would
 * then fill; be writable by this user; and be at most `limits.gb` GiB, so no run can grow past the cap.
 */
export function diskProblem(dir: string, limits: Runs["disk"], dataRoot: string, probe: FsProbe = probeFs): string | undefined {
  const disk = probe(dir);
  if (disk === undefined) return `the run disk ${dir} does not exist: set it up as ${SETUP} says (H-217)`;
  const parent = dirname(dir);
  const above = probe(parent);
  if (above === undefined || above.dev === disk.dev) return `the run disk ${dir} is not its own filesystem (it shares ${parent}'s): mount the run disk there (${SETUP})`;
  const root = probe(dataRoot);
  if (root === undefined) return `the run disk ${dir} can't be checked against Docker's data root (${dataRoot}), which this user can't see: run it as hapi`;
  if (root.dev === disk.dev) return `the run disk ${dir} is on the same filesystem as Docker's data root (${dataRoot}): a run that filled it would fill Docker's disk`;
  if (!disk.writable) return `the run disk ${dir} is not writable by this user: chown it to hapi (${SETUP})`;
  if (disk.bytes > limits.gb * GIB) return `the run disk ${dir} is ${inGB(disk.bytes)} GB, more than runs.disk.gb (${limits.gb}): it would let a run grow past its cap`;
  return undefined;
}

/**
 * Docker's data root from what `docker info --format {{.DockerRootDir}}` exited with and printed: one absolute path.
 * A non-zero exit, or any other answer, throws, quoting the first line of its error output (or of the answer).
 */
export function dataRootOf(code: number, stdout: string, stderr = ""): string {
  const root = stdout.trim();
  if (code === 0 && isAbsolute(root) && !root.includes("\n")) return root;
  const said = (code === 0 ? stdout : stderr || stdout).trim().split("\n")[0]?.slice(0, 300) || "(no output)";
  throw new Error(`cannot read Docker's data root (docker info exited ${code}): ${said}`);
}

/** Docker's data root, as this user's docker CLI reaches it (`dataRootOf`). */
export async function dockerDataRoot(d: Pick<RunDeps, "run" | "env">): Promise<string> {
  const r = await d.run(["docker", "info", "--format", "{{.DockerRootDir}}"], { env: definedEnv(d.env), inherit: false });
  return dataRootOf(r.code, r.stdout, r.stderr);
}

/** The host dir that backs `volume`, a run's volume: the volume's name in the run disk. Throws on a path a bind can't hold. */
export const volumeDir = (diskDir: string, volume: string): string => mountable(join(diskDir, volume), "a run volume");

/**
 * `sh -c CLEAN_SCRIPT`, as 1001:1001, with a run's dirs bound at `/w` and `/o`: each that is mounted is made
 * deletable by its owner, then emptied. Fixed text.
 */
export const CLEAN_SCRIPT = 'for d in /w /o; do [ -d "$d" ] || continue; chmod -R u+rwX "$d" && find "$d" -mindepth 1 -delete || exit 1; done';

/** Whether a run's dir is on the run disk: a real directory, never a symlink to follow or a file to bind. */
function present(path: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`${path} on the run disk is not a directory (a symlink or a file): hapi makes each run's dirs itself, so remove it by hand (${SETUP})`);
  return true;
}

/** `rmdir(path)`: true once it is gone (already gone counts: that is the goal), false if it isn't empty. Any other failure throws. */
async function removedIfEmpty(path: string): Promise<boolean> {
  try {
    await rmdir(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw new Error(`removing ${path} from the run disk failed (${code ?? (e as Error).message})`);
  }
}

/**
 * Empty and remove run `runId`'s dirs on the run disk, `<runName>-work` and `-out`: call it only once their volumes
 * are gone, since nothing may be using them. A dir that isn't there is skipped. An empty one is removed at once,
 * whoever owns it: a dir the volume chown never reached (a start that failed at `volume create`) is hapi's, and the
 * helper, as 1001, couldn't even chmod it. Only uid 1001 can have written into a dir, so the rest are emptied by
 * one helper run as 1001:1001 (no network, read-only root, no capabilities, the run's labels so `down` finds it,
 * under the host's bound), then removed. A helper that fails or times out throws, and those dirs are kept.
 */
export async function removeVolumeDirs(d: Pick<RunDeps, "run" | "env" | "project" | "image" | "diskDir">, runId: string): Promise<void> {
  const name = runName(d.project, runId);
  const dirs = ([["work", "/w"], ["out", "/o"]] as const).map(([v, at]) => ({ path: volumeDir(d.diskDir, `${name}-${v}`), at })).filter(({ path }) => present(path));
  const full: typeof dirs = [];
  for (const dir of dirs) if (!(await removedIfEmpty(dir.path))) full.push(dir);
  if (full.length === 0) return;
  const r = await d.run(
    bounded([
      "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", APP_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      ...runLabels(d.project, runId), ...helperLabels("clean"), ...full.flatMap(({ path, at }) => ["-v", `${path}:${at}`]), "--entrypoint", "sh", d.image, "-c", CLEAN_SCRIPT,
    ]),
    { env: definedEnv(d.env), inherit: false },
  );
  if (r.code !== 0) throw new Error(`emptying run ${runId}'s dirs on the run disk ${timedOut(r.code) ? `timed out after ${HELPER_HOST_TIMEOUT_S} s` : "failed"} (helper exit ${r.code})`);
  for (const { path } of full) {
    if (!(await removedIfEmpty(path))) throw new Error(`${path} on the run disk is not empty after the cleanup helper ran`);
  }
}
