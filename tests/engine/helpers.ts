/**
 * Test helpers for tests/engine: a real git work repo in a temp dir, work orders added to it, planning merges in
 * GitHub's classic message, and a way to update a mirror from it. Git here runs with no system or global config
 * (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`) and HOME set to the work dir, so nothing reads the real
 * ~/.gitconfig or ~/.config, and nothing touches the network: a mirror fetches from the work dir's path.
 */
import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeOrder } from "../run/helpers";

/** git in one work dir, which returns stdout, trimmed; `dir` is that work dir. A non-zero exit fails the test, naming the command. */
export type Git = ((...args: string[]) => string) & { dir: string };

/** A fresh work repo at `dir` (which must exist), on `main`, with one empty commit. */
export function workRepo(dir: string): Git {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });
    expect([args.join(" "), r.exitCode, r.stderr.toString()]).toEqual([args.join(" "), 0, expect.any(String)]);
    return r.stdout.toString().trim();
  };
  const g = Object.assign(git, { dir });
  g("init", "-q", "-b", "main");
  g("commit", "-q", "--allow-empty", "-m", "base");
  return g;
}

/**
 * Write `.factory/work/<id>/order.yaml` (`writeOrder`'s YAML with `id`, then `over`, applied) and
 * `.factory/work/<id>/task.md` (`# <id>\n`), and stage both. Returns the order's path in the work dir.
 */
export function addOrder(git: Git, id: string, over: Record<string, unknown> = {}): string {
  const dir = join(git.dir, ".factory", "work", id);
  mkdirSync(dir, { recursive: true });
  const order = writeOrder(dir, { id, ...over }, "order.yaml");
  writeFileSync(join(dir, "task.md"), `# ${id}\n`);
  git("add", "--", join(".factory", "work", id, "order.yaml"), join(".factory", "work", id, "task.md"));
  return order;
}

/** Merge `branch` into main as GitHub's merge button does, with its classic message; returns the merge's sha. */
export function mergePlanning(git: Git, branch: string, pr: number): string {
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", `Merge pull request #${pr} from example-owner/${branch}`, branch);
  return git("rev-parse", "HEAD");
}

/**
 * Update `mirror`'s main from the work dir's. A fetch into the mirror, not a push: `--shared` sets
 * `receive.denyNonFastforwards`, which refuses even a forced push. `force` lets main move other than forward,
 * as the poller's own fetch (`+refs/heads/main:refs/heads/main`) does.
 */
export function toMirror(git: Git, mirror: string, force = false): void {
  git("--git-dir", mirror, "fetch", "--quiet", git.dir, `${force ? "+" : ""}refs/heads/main:refs/heads/main`);
}
