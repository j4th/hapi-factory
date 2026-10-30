/**
 * Copy-out (design §6a item 11; spike 07 finding 14): how a run's outputs
 * leave it. Under rootless Docker the run's uid maps to a host uid whose files
 * hapi can't delete, so nothing is bind-mounted writable from the host: the run
 * writes to its own `/out` volume, and once its container has stopped, a fresh
 * helper container of the same image (no network, read-only root, uid 1001,
 * the volume mounted read-only) reads each expected file out, one known name
 * at a time:
 * - the volume must exist (a `-v` of a missing one would make an unlabelled
 *   volume that `down` never finds);
 * - a listing first (`LIST_SCRIPT`), under a `timeout` inside the helper: any
 *   name that isn't one of `OUTPUT_FILES` is reported and never read;
 * - then each output (`COPY_SCRIPT`), only if it is a regular file and not a
 *   symlink (`[ -f ] && [ ! -L ]`: `-f` alone follows a link, and a FIFO
 *   would block the read), at most its cap plus one byte, so an oversize file
 *   shows, and under a `timeout` inside the helper;
 * - every helper's `docker run` under the host's `timeout` as well
 *   (`HELPER_HOST_TIMEOUT_S`), for a daemon that hangs;
 * - the bytes come back on the docker CLI's stdout through `runBytes`, never
 *   decoded (a bundle is binary), into a temp file made 0600 in the
 *   hapi-owned record dir, renamed into place only when the helper exited 0
 *   within the cap. Otherwise the temp file (and any earlier copy) is deleted
 *   and the problem reported.
 * Everything read is untrusted data: stored and checked, never executed or
 * printed raw. A name the run made is shown only if it is plain.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Runs } from "../policy/types";
import { definedEnv, PROJECT, PROJECT_LABEL, RUN_LABEL } from "../stack/up";
import { APP_USER, type RunDeps } from "./spec";

/** The files a run may leave, in the order they are copied; each has a cap in runs.output_limits_mb. */
export const OUTPUT_FILES = ["result.json", "transcript.jsonl", "decisions.jsonl", "run.bundle"] as const;
export type OutputFile = (typeof OUTPUT_FILES)[number];

const LIMIT_OF: Record<OutputFile, keyof Runs["output_limits_mb"]> = {
  "result.json": "result",
  "transcript.jsonl": "transcript",
  "decisions.jsonl": "decisions",
  "run.bundle": "bundle",
};

/** Seconds a helper may spend on its work inside its container: the listing, or reading one file. */
export const HELPER_TIMEOUT_S = 120;
/**
 * The host's bound on each helper's `docker run` (the listing's, each read's and the volume chown's), start to
 * exit: `timeout` sends the docker CLI TERM, which it passes on to the helper, then KILL HELPER_KILL_AFTER_S
 * later. It is for a daemon or CLI that hangs, which would otherwise hang finalize while it holds the run's lock
 * (and, inside a reap, the launcher's, refusing every start). Above HELPER_TIMEOUT_S, so slow work stops itself
 * first: the 30 s are the helper's start and removal.
 */
export const HELPER_HOST_TIMEOUT_S = HELPER_TIMEOUT_S + 30;
/** Seconds between the host's TERM and its KILL (`timeout -k`): a docker CLI stuck on a hung daemon ignores the TERM. */
export const HELPER_KILL_AFTER_S = 10;
/** At most this many names are listed: a run that made more has its excess counted, not read. */
const MAX_NAMES = 1000;

/** `cmd`, a helper's `docker run`, under the host's `timeout` (HELPER_HOST_TIMEOUT_S). */
export const bounded = (cmd: string[]): string[] => ["timeout", "-k", String(HELPER_KILL_AFTER_S), String(HELPER_HOST_TIMEOUT_S), ...cmd];

/**
 * Whether a bounded helper's exit code says a bound stopped it: 124 is `timeout`'s own (inside the helper or on
 * the host), 137 its KILL, which a docker CLI waiting on a hung daemon needs.
 */
export const timedOut = (code: number): boolean => code === 124 || code === 137;

const TIMED_OUT = `timed out (after ${HELPER_TIMEOUT_S} s in the helper, or ${HELPER_HOST_TIMEOUT_S} s in all)`;

/**
 * Prints every name in /out (dot names too), NUL-separated, up to MAX_NAMES, under a `timeout` inside the helper
 * as each read is. Fixed text; the loop holds no single quote, so it can be quoted whole for the inner `sh -c`.
 */
export const LIST_SCRIPT = `exec timeout ${HELPER_TIMEOUT_S} sh -c 'n=0; for f in /out/* /out/.[!.]* /out/..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "\${f#/out/}"; n=$((n+1)); [ "$n" -ge ${MAX_NAMES} ] && break; fi; done; exit 0'`;

/**
 * `sh -c COPY_SCRIPT hapi-copyout <name> <bytes>`: at most <bytes> of /out/<name>, if it is a regular file
 * and not a symlink; exit 3 if it is anything else, 4 if it isn't there. Fixed text: the name is an argument.
 */
export const COPY_SCRIPT = `f="/out/$1"; if [ ! -e "$f" ] && [ ! -L "$f" ]; then exit 4; fi; if [ -f "$f" ] && [ ! -L "$f" ]; then exec timeout ${HELPER_TIMEOUT_S} head -c "$2" "$f"; fi; echo "not a regular file" >&2; exit 3`;

const MB = 1024 * 1024;

/** A name the run made, if it is plain enough to show. */
const plain = (name: string) => /^[A-Za-z0-9._-]{1,64}$/.test(name);

/** The helper's argv up to its script: no network, read-only root, the image's appuser, the volume read-only. */
function helper(volume: string, d: Pick<RunDeps, "project" | "image">): string[] {
  return [
    "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--user", APP_USER, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    // The run labels, so `down` and the kill switches find a helper that outlives its CLI; no run's name, so it is never a live run.
    "--label", RUN_LABEL, "--label", `${PROJECT_LABEL}=${d.project}`, ...(d.project === PROJECT ? [] : ["--label", `org.hapi.int=${d.project}`]),
    "-v", `${volume}:/out:ro`, "--entrypoint", "sh", d.image, "-c",
  ];
}

/**
 * Copy the outputs of the run whose out volume is `volume` into `dest` (made 0700), each within its cap in
 * `limits`. Returns the names copied and every problem, in a run's order; a missing output is no problem (a
 * bash-only run writes no decisions, an unchanged one no bundle). Never throws for what the volume holds.
 */
export async function copyOut(volume: string, dest: string, limits: Runs["output_limits_mb"], deps: RunDeps): Promise<{ copied: string[]; problems: string[] }> {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const env = definedEnv(deps.env);
  // A helper's `-v` of a volume that isn't there would make an unlabelled one, which nothing would remove.
  const found = await deps.run(["docker", "volume", "inspect", "--format", "{{.Name}}", volume], { env, inherit: false });
  if (found.code !== 0) return { copied: [], problems: [`cannot find the run's output volume ${volume} (docker volume inspect exited ${found.code}): nothing was copied`] };
  const listing = await deps.run(bounded([...helper(volume, deps), LIST_SCRIPT]), { env, inherit: false });
  if (timedOut(listing.code)) return { copied: [], problems: [`listing the run's output volume ${TIMED_OUT}: nothing was copied`] };
  if (listing.code !== 0) return { copied: [], problems: [`listing the run's output volume failed (helper exit ${listing.code}): nothing was copied`] };
  const names = listing.stdout.split("\0").slice(0, -1);
  const known = new Set<string>(OUTPUT_FILES);
  const others = names.filter((n) => !known.has(n));
  const copied: string[] = [];
  const problems: string[] = [];
  for (const name of OUTPUT_FILES.filter((n) => names.includes(n))) {
    const cap = limits[LIMIT_OF[name]] * MB;
    const final = join(dest, name);
    const tmp = join(dest, `.${name}.${randomUUID()}.tmp`);
    const r = await deps.runBytes(bounded([...helper(volume, deps), COPY_SCRIPT, "hapi-copyout", name, String(cap + 1)]), env);
    let problem: string | undefined;
    if (r.code === 4) continue; // not there after all: nothing to copy
    if (r.code === 3) problem = `${name} in the run's output volume is not a regular file (a symlink, a FIFO or a directory): not copied`;
    else if (timedOut(r.code)) problem = `copying ${name} out ${TIMED_OUT}: not copied`;
    else if (r.code !== 0) problem = `copying ${name} out failed (helper exit ${r.code}): not copied`;
    else if (r.stdout.length > cap) problem = `${name} is over its ${limits[LIMIT_OF[name]]} MB limit (runs.output_limits_mb.${LIMIT_OF[name]}, policy/runs.yaml): not copied`;
    if (problem === undefined) {
      try {
        await writeFile(tmp, r.stdout, { mode: 0o600, flag: "wx" });
        await rename(tmp, final);
        copied.push(name);
        continue;
      } catch (e) {
        problem = `writing ${name} to ${dest} failed (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): not copied`;
      }
    }
    problems.push(problem);
    await rm(tmp, { force: true });
    await rm(final, { force: true });
  }
  if (others.length > 0) {
    const shown = others.filter(plain).slice(0, 5);
    const hidden = others.length - shown.length;
    const list = hidden === 0 ? shown.join(", ").replace(/, ([^,]*)$/, " and $1") : `${shown.join(", ")}${shown.length > 0 ? " and " : ""}${hidden} not shown`;
    problems.push(`the run's output volume holds ${others.length} names that are not run outputs (${list}): not copied`);
  }
  return { copied, problems };
}
