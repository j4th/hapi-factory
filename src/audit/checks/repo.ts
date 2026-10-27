/**
 * repo.private-untracked (H-058): the checkout the audit runs in tracks
 * nothing under private/, and its own root .gitignore ignores private/.
 * private/ is the operator's own repo (the research, the secrets store,
 * personal notes) and hapi-factory is public, so one `git add -A` that picked
 * it up would publish it.
 *
 * It reads `ctx.root` with git, never a forge:
 * - `git rev-parse --show-prefix` is empty: the root is the checkout's top
 *   level, so `private` below means the checkout's private/;
 * - `git ls-files -z -- ':(icase)private'` lists nothing. Any case, so a
 *   `Private/` that is private/ on a case-insensitive filesystem counts too; a
 *   nested repo added as a gitlink shows as `private` itself;
 * - `git check-ignore --no-index -v -- private/` names the root `.gitignore`.
 *   A local `.git/info/exclude` or a global excludes file isn't shared with a
 *   clone, so it doesn't count.
 * git runs with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE and GIT_COMMON_DIR
 * unset, so the caller's shell can't point it at another repo or index, and
 * with fsmonitor off. No checkout, or git failing, is a fail: the audit fails
 * closed.
 */
import { type AuditRun, type CheckResult, type ExecResult, result } from "../types";

const UNSET = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].flatMap((v) => ["-u", v]);

/** The first non-empty line of git's stderr, at most 300 characters. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line === undefined ? "" : line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

/** repo.private-untracked */
export async function repoPrivateUntracked(run: AuditRun): Promise<CheckResult[]> {
  const id = "repo.private-untracked";
  const { root, exec } = run.ctx;
  const git = (...args: string[]) => exec(["env", ...UNSET, "git", "-C", root, "-c", "core.fsmonitor=false", ...args]);
  const failed = (what: string, r: ExecResult) => {
    const said = firstLine(r.stderr);
    return [result(id, "fail", `\`git ${what}\` in ${root} failed (exit ${r.code})${said ? `: ${said}` : ""}, so what the checkout tracks can't be checked`)];
  };

  const prefix = await git("rev-parse", "--show-prefix");
  if (prefix.code !== 0) return failed("rev-parse --show-prefix", prefix);
  const sub = prefix.stdout.trim();
  if (sub !== "") return [result(id, "fail", `${root} is ${JSON.stringify(sub)} inside its checkout, not its top level: run the audit from the checkout's root`)];

  const ls = await git("ls-files", "-z", "--", ":(icase)private");
  if (ls.code !== 0) return failed("ls-files", ls);
  const tracked = ls.stdout.split("\0").filter((f) => f !== "");
  const problems: string[] = [];
  if (tracked.length > 0) {
    const shown = tracked.slice(0, 3).map((f) => JSON.stringify(f));
    const more = tracked.length > 3 ? ` and ${tracked.length - 3} more` : "";
    problems.push(`it tracks ${tracked.length} path${tracked.length === 1 ? "" : "s"} under private/ (${shown.join(", ")}${more}): \`git rm -r --cached private\` and commit, then make sure no pushed commit holds them`);
  }

  const ignored = await git("check-ignore", "--no-index", "-v", "--", "private/");
  if (ignored.code === 0) {
    if (!ignored.stdout.startsWith(".gitignore:")) {
      const source = ignored.stdout.split("\t")[0]!.replace(/:\d+:.*$/, "");
      problems.push(`private/ is ignored only by ${JSON.stringify(source)}, which a clone doesn't get: add a \`private/\` line to the root .gitignore`);
    }
  } else if (ignored.code === 1) problems.push("its root .gitignore doesn't ignore private/: add a `private/` line");
  else return failed("check-ignore", ignored);

  if (problems.length > 0) return [result(id, "fail", `${root}: ${problems.join("; ")}`)];
  return [result(id, "pass", `${root} tracks nothing under private/, and its root .gitignore ignores private/`)];
}
