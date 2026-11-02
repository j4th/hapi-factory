/**
 * A run's smoke sidecar (design §3.3, H-192): a service a worker, fix or verify run's smoke test talks to, started
 * from an image central policy pins (policy/sidecars.yaml), never one a repo brings. A repo's overlay may only name
 * one of policy's sidecars and a data dir (`RepoSettings.sidecar`), which workers may not write (the overlay protects
 * `<data_dir>/**` from them, src/policy/overlay.ts).
 *
 * Where it runs: on the run's own internal network, named `<run>-sidecar` and reachable there as `SIDECAR_ALIAS`
 * (`hapi-sidecar`), started after the volume chown and before the run container (./lifecycle.ts
 * `createRunObjects`), for a run whose kind may have one (./kinds.ts `sidecar`: every kind but review) and whose work
 * order smokes. The run reaches it directly: `hapi-sidecar` is in the archon zone's static `NO_PROXY`
 * (src/stack/env.ts), so the proxies' refusal of private addresses (`to_localnet`) is never loosened. It is removed
 * with the run, by the run's labels (src/stack/up.ts `removeRuns`).
 *
 * Its container (`sidecarArgs`): the run's labels with `org.hapi.kind=sidecar`, and the stack's started-by and
 * dev-override labels as the launcher computes them for the run (m24), so the audit holds it like any container;
 * the image's Compose labels blanked, as a run's are; `--pull never` (`hapi stack up` pulls every sidecar image by
 * digest); a read-only root as 1001 with every capability dropped and no new privileges; the pid and memory limits
 * policy gives it (`Sidecar.limits`); logs capped as the stack's are; a small `/tmp` tmpfs and HOME there; its data
 * read-only at /data, its working dir; PORT, so Bun's default port is policy's; policy's command. No secret, no
 * published port, and no other network.
 *
 * Its data (`exportSidecarData`): the data dir as it is in the run's commit, read from the run's source by host git
 * with no config of its own (`hardenedGit`) and exported blob by blob, never with `git archive`, whose symlink
 * members could redirect a later member's write on the host. Only regular files (mode 100644 or 100755) are
 * exported, each as 0644 in 0755 dirs; a symlink or a submodule in the data dir refuses the run, and so does a data
 * dir with no file, or one over policy's caps (`data_files`, `data_mb`). Everything is read and checked before
 * anything is written, so a refused export writes nothing. It goes in the run's record dir (`SIDECAR_DATA`), bound
 * read-only at /data.
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mountable } from "../audit/checks/tools";
import type { Sidecar } from "../policy/types";
import { SIDECAR_ALIAS } from "../stack/env";
import { currentUserOverride, definedEnv } from "../stack/up";
import { hardenedGit } from "./git";
import { KIND_LABEL } from "./kinds";
import type { RunRecord } from "./records";
import { APP_USER, NO_NEW_PRIVILEGES, type RunDeps, runLabels } from "./spec";

/** The subdir of a run's record dir that holds its sidecar's data, bound read-only at `/data`. */
export const SIDECAR_DATA = "sidecar";

/** `org.hapi.kind`'s value on a sidecar's container. */
export const SIDECAR_KIND = "sidecar";

/** The sidecar's container name for the run container `container`: `<run>-sidecar`. */
export const sidecarName = (container: string): string => `${container}-sidecar`;

/** Where the data is, and the sidecar's working dir. */
const DATA = "/data";

/** Its one writable path, as small as the egress proxies' and the appuser's alone. */
const TMPFS = "/tmp:size=64m,uid=1001,gid=1001,mode=0700";

/** The Compose labels an image built by Compose carries, blanked as `runArgs` blanks a run's (./spec.ts). */
const COMPOSE_LABELS = ["com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.version"];

/** The whole `docker run` argv of the sidecar `s` for run `rec`, its data at `dataDir` (see the module comment). Pure. */
export function sidecarArgs(d: Pick<RunDeps, "project" | "user" | "env">, rec: Pick<RunRecord, "runId" | "container" | "network">, s: Sidecar, dataDir: string): string[] {
  const who = currentUserOverride(d.env, d.user);
  const [entrypoint, ...args] = s.command;
  return [
    "docker", "run", "-d", "--pull", "never", "--name", sidecarName(rec.container),
    ...runLabels(d.project, rec.runId),
    "--label", `${KIND_LABEL}=${SIDECAR_KIND}`,
    "--label", `org.hapi.started-by=${who.user}`, "--label", `org.hapi.dev-override=${who.override ? "1" : "0"}`,
    ...COMPOSE_LABELS.flatMap((k) => ["--label", `${k}=`]),
    "--network", rec.network, "--network-alias", SIDECAR_ALIAS,
    "--read-only", "--user", APP_USER, "--cap-drop", "ALL", "--security-opt", NO_NEW_PRIVILEGES,
    "--pids-limit", String(s.limits.pids), "--memory", `${s.limits.memory_mb}m`,
    "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=3",
    "--tmpfs", TMPFS, "-v", `${mountable(dataDir, "the sidecar")}:${DATA}:ro`, "-w", DATA, "-e", "HOME=/tmp", "-e", `PORT=${s.port}`,
    "--entrypoint", entrypoint!, s.image, ...args,
  ];
}

/** Start the sidecar `s` for run `rec` (`sidecarArgs`). Its docker CLI gets the host's env, never a zone's secrets. Throws when `docker run` fails. */
export async function startSidecar(d: RunDeps, rec: RunRecord, s: Sidecar, dataDir: string): Promise<void> {
  const r = await d.run(sidecarArgs(d, rec, s, dataDir), { env: definedEnv(d.env), inherit: false });
  if (r.code !== 0) throw new Error(`docker run ${sidecarName(rec.container)} failed (exit ${r.code}): ${(r.stderr ?? "").trim().split("\n")[0]?.slice(0, 300) || "(no error output)"}`);
}

/** A path from the run's tree as a message may show it: printable ASCII, short. */
const shown = (p: string) => p.replace(/[^\x20-\x7e]/g, "?").slice(0, 200);

const MIB = 1024 * 1024;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Export `dataDir` (a repo path, as the overlay names it) at commit `sha` of the git dir `gitDir` into `dest`, which
 * must not exist: see the module comment. Throws the refusal, having written nothing.
 */
export async function exportSidecarData(
  d: Pick<RunDeps, "run" | "runBytes" | "env">,
  gitDir: string,
  sha: string,
  dataDir: string,
  dest: string,
  limits: Pick<Sidecar["limits"], "data_files" | "data_mb">,
): Promise<void> {
  // --literal-pathspecs: the data dir is a path, never a pattern (git's pathspec magic or a glob).
  const git = hardenedGit(d, { git: ["--literal-pathspecs"] });
  const at = [...git.cmd, "-c", `safe.directory=${gitDir}`, "--git-dir", gitDir];
  const prefix = `${dataDir}/`;
  const over = `${dataDir} holds more than ${limits.data_files} files or ${limits.data_mb} MiB: the sidecar's data is at most that`;
  // -l: each blob's size, so the caps are checked before any blob is read.
  const tree = await d.run([...at, "ls-tree", "-r", "-z", "-l", "--full-tree", sha, "--", prefix], { env: git.env, inherit: false });
  if (tree.code !== 0) throw new Error(`cannot list ${dataDir} at ${sha} in ${gitDir} (git ls-tree exited ${tree.code}): ${(tree.stderr ?? "").trim().split("\n")[0] || "(no error output)"}`);
  const entries: { path: string; oid: string; size: number }[] = [];
  for (const row of tree.stdout.split("\0").filter((r) => r !== "")) {
    const tab = row.indexOf("\t");
    const path = row.slice(tab + 1);
    const [mode, type, oid, size] = row.slice(0, Math.max(0, tab)).trim().split(/\s+/);
    if (tab < 0 || !path.startsWith(prefix)) throw new Error(`git ls-tree printed an entry outside ${dataDir} (${shown(path)}): nothing was exported`);
    if (mode === "120000") throw new Error(`${shown(path)}: a symlink in the sidecar's data dir; only regular files are exported`);
    if (mode === "160000") throw new Error(`${shown(path)}: a submodule in the sidecar's data dir; only regular files are exported`);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || !OID.test(oid ?? "") || !/^\d+$/.test(size ?? "")) {
      throw new Error(`${shown(path)}: not a regular file in the sidecar's data dir; only regular files are exported`);
    }
    // A name a file in /data couldn't have as git wrote it: a control character, text that isn't UTF-8, or a . or .. part.
    const rel = path.slice(prefix.length);
    if (/[\u0000-\u001f\u007f�]/.test(rel) || rel.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`${shown(path)}: a name the sidecar's data dir can't hold; only plain file names are exported`);
    }
    entries.push({ path, oid: oid!, size: Number(size) });
  }
  if (entries.length === 0) throw new Error(`${dataDir} holds no file at ${sha}`);
  if (entries.length > limits.data_files || entries.reduce((n, e) => n + e.size, 0) > limits.data_mb * MIB) throw new Error(over);

  // Every blob read and checked before anything is written.
  const blobs: { rel: string; bytes: Uint8Array }[] = [];
  for (const e of entries) {
    const r = await d.runBytes([...at, "cat-file", "blob", e.oid], git.env);
    if (r.code !== 0) throw new Error(`cannot read ${shown(e.path)} at ${sha} in ${gitDir} (git cat-file exited ${r.code}): nothing was exported`);
    if (r.stdout.length !== e.size) throw new Error(`${shown(e.path)} at ${sha} read back ${r.stdout.length} bytes, not the ${e.size} git listed: nothing was exported`);
    blobs.push({ rel: e.path.slice(prefix.length), bytes: r.stdout });
  }
  // A fresh dir of hapi's: nothing in it is a link, so a write lands where its path says.
  await mkdir(dest, { mode: 0o755 });
  try {
    await chmod(dest, 0o755);
    for (const b of blobs) {
      const file = join(dest, b.rel);
      await mkdir(dirname(file), { recursive: true, mode: 0o755 });
      await writeFile(file, b.bytes, { mode: 0o644, flag: "wx" });
      await chmod(file, 0o644);
    }
    // Each dir 0755 whatever the umask, after its files are in.
    const dirs = new Set(blobs.flatMap((b) => b.rel.split("/").slice(0, -1).map((_, i, parts) => join(dest, ...parts.slice(0, i + 1)))));
    for (const dir of dirs) await chmod(dir, 0o755);
  } catch (e) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(`the sidecar's data could not be written to ${dest} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}): nothing was exported`);
  }
}
