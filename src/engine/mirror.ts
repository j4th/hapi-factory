/**
 * The engine's mirrors (design §3.4): one credential-free bare repo per registered repo, at
 * `<engineDir>/mirrors/<owner>/<name>.git`, which the poller fetches each tick and reads with host git
 * (./discover.ts), and which a run binds read-only as its source (Task 7, H-211).
 *
 * - **No credential on disk.** The mirror's config names origin's URL and nothing else: no fetch refspec, no
 *   `http.extraheader`, no credential helper. The fetch carries the token in its own process's environment only
 *   (`authedHostGit`), so a run that reads the mirror reads no token.
 * - **Only main and factory/*.** The fetch names its two refspecs on the command line, prunes, and takes no tags
 *   and no FETCH_HEAD; nothing else of the repo's reaches the mirror.
 * - **World-readable.** `git init --shared=0644` makes its files 0644 and its dirs 0755, and keeps them so on
 *   every fetch (`core.sharedRepository`), so the run container's uid can read it. The dir above it,
 *   `mirrors/<owner>`, is 0700: only hapi (and so hapi's rootless Docker, which makes the bind mount) gets to it.
 *   `--shared` also sets `receive.denyNonFastforwards`, which only a push would meet; the poller only fetches.
 * - **Disposable.** A mirror holds nothing that isn't on GitHub: delete it and the next tick makes it again.
 *
 * Every git call is `hardenedGit`, but the fetch, which is `authedHostGit`.
 */
import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseOwnerRepo } from "../forge/github/app-token";
import { stateDirOf } from "../run/cli";
import { authedHostGit, hardenedGit } from "../run/git";
import type { Env, Runner } from "../stack/up";

export interface MirrorDeps {
  run: Runner;
  env: Env;
  /** ${XDG_STATE_HOME:-~/.local/state}/hapi/engine (`engineDirOf`), or a temp dir in tests. */
  engineDir: string;
}

/** The engine's state dir, beside the launcher's runs dir: the one definition (Task 14's poller imports it). */
export function engineDirOf(env: Env): string {
  return join(dirname(stateDirOf(env)), "engine");
}

/** `<engineDir>/mirrors/<owner>/<name>.git`. Throws for anything that isn't an owner/name. */
export function mirrorPath(engineDir: string, repo: string): string {
  const r = parseOwnerRepo(repo);
  if (r === undefined) throw new Error(`not an owner/name: ${repo}`);
  return join(engineDir, "mirrors", r.owner, `${r.name}.git`);
}

const originOf = (repo: string) => `https://github.com/${repo}.git`;
const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.trim().slice(0, 300) || "(no error output)";
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** Run git on mirror `m` (or, with `m` undefined, outside any repo); returns the result as is. */
function mirrorGit(d: MirrorDeps, m: string | undefined, args: string[]) {
  const g = m === undefined ? hardenedGit(d) : hardenedGit(d, { git: ["--git-dir", m] });
  return d.run([...g.cmd, ...args], { env: g.env, inherit: false });
}

/**
 * Make `repo`'s mirror if it isn't there, and check the one that is: its origin must be the repo's GitHub URL.
 * Returns its path. Never adds a fetch refspec or anything else to its config.
 */
export async function ensureMirror(d: MirrorDeps, repo: string): Promise<string> {
  const m = mirrorPath(d.engineDir, repo);
  const origin = originOf(repo);
  if (!(await exists(join(m, "HEAD")))) {
    await mkdir(dirname(m), { recursive: true, mode: 0o700 });
    const init = await mirrorGit(d, undefined, ["init", "--bare", "--quiet", "--shared=0644", "--initial-branch=main", m]);
    if (init.code !== 0) throw new Error(`cannot make ${repo}'s mirror at ${m} (git init exited ${init.code}): ${firstLine(init.stderr)}`);
    const set = await mirrorGit(d, m, ["config", "remote.origin.url", origin]);
    if (set.code !== 0) throw new Error(`cannot set ${repo}'s mirror's origin (git config exited ${set.code}): ${firstLine(set.stderr)}`);
    return m;
  }
  const got = await mirrorGit(d, m, ["config", "--get", "remote.origin.url"]);
  const url = got.code === 0 ? got.stdout.trim() : "";
  if (url !== origin) throw new Error(`${m}'s origin is ${url === "" ? "unset" : url}, not ${origin}: remove the mirror; the next tick makes it again`);
  return m;
}

/**
 * Fetch `repo`'s main and factory/* into its mirror (made by `ensureMirror`), forced and pruned, with `token` in
 * the fetch's environment only. A failure throws with git's first stderr line, the token and its header redacted.
 */
export async function fetchMirror(d: MirrorDeps, repo: string, token: string): Promise<void> {
  const m = mirrorPath(d.engineDir, repo);
  if (!(await exists(join(m, "HEAD")))) throw new Error(`no mirror at ${m}: ensureMirror first`);
  const g = authedHostGit(d, token, { git: ["--git-dir", m] });
  const r = await d.run(
    [...g.cmd, "fetch", "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/main:refs/heads/main", "+refs/heads/factory/*:refs/heads/factory/*"],
    { env: g.env, inherit: false },
  );
  if (r.code === 0) return;
  // The header's base64 first: it is the longer, and redacting the whole stderr before taking its first line
  // means a cut can never leave part of either behind.
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  const stderr = (r.stderr ?? "").split(header).join("[redacted]").split(token).join("[redacted]");
  throw new Error(`cannot fetch ${repo} into its mirror (git fetch exited ${r.code}): ${firstLine(stderr)}`);
}
