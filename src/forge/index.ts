/**
 * The forge interface (spec §16): the one way the mirror, the harvester, the state machine and the
 * poller reach GitHub. `githubForge` is its REST adapter; tests use it over `fakeForge().fetch`.
 */
export type { Env } from "../stack/up";
export { githubForge } from "./github/forge";
export { authedGit } from "./github/git";
export { forgeToken } from "./github/token";

/**
 * The labels every factory repo has (design §3.2 step 7): `hapi new-repo` makes them, `github.labels` checks them by
 * name, and the poller reads the lanes and the operator's two signals from them.
 */
export const LABELS: readonly { name: string; color: string; description: string }[] = Object.freeze(
  [
    { name: "lane:planning", color: "1d76db", description: "A planning PR: work orders and their acceptance tests" },
    { name: "lane:factory", color: "0e8a16", description: "A factory PR, from the hapi-factory App" },
    { name: "lane:direct", color: "5319e7", description: "The maintainer's own hands-on change" },
    { name: "hapi:rework", color: "fbca04", description: "The maintainer asks the factory to rework this PR" },
    { name: "hapi:flagged", color: "d93f0b", description: "The factory flagged this PR for the maintainer's decision" },
  ].map((l) => Object.freeze(l)),
);

/**
 * The required check in a repo made from the contract (design §3.3, §7.3 [verify]): the caller's job `ci` in
 * .github/workflows/hapi-gates.yml calling hapi-factory's gates.yml, whose job is `gates`. hapi-factory's own CI
 * check stays `ci`.
 */
export const CONTRACT_CHECK = "ci / gates";

/**
 * The settings `hapi new-repo` gives a factory repo (design §3.2 step 5), as the request bodies it sends, and
 * `github.repo-settings` holds a registered repo to: merge commits only, with GitHub's classic merge message
 * ("Merge pull request #N from …", which the poller reads), so each piece's commit and trailers reach main as
 * reviewed; head branches deleted on merge; no auto-merge; secret scanning and push protection on; the Actions token
 * read-only and unable to approve PRs; only GitHub's own actions, mise-action and hapi-factory's gates, each pinned
 * to a SHA; fork runs approved first. Private vulnerability reporting is a bodiless PUT, so it isn't here.
 */
export function contractSettings(owner: string) {
  return {
    repo: {
      default_branch: "main",
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: false,
      allow_auto_merge: false,
      delete_branch_on_merge: true,
      merge_commit_title: "MERGE_MESSAGE",
      merge_commit_message: "PR_TITLE",
      security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } },
    },
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    actions: { enabled: true, allowed_actions: "selected", sha_pinning_required: true },
    selectedActions: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["jdx/mise-action@*", `${owner}/hapi-factory/.github/workflows/gates.yml@*`] },
    forkApproval: { approval_policy: "all_external_contributors" },
  };
}

export type Permission = "admin" | "maintain" | "write" | "triage" | "read" | "none";
export interface PrInfo { number: number; state: "open" | "closed"; merged: boolean; draft: boolean; headSha: string; headRef: string; baseRef: string; body: string; labels: string[] }
export interface LabelEvent { action: "labeled" | "unlabeled"; label: string; actor: { id: number; login: string; type: string }; viaApp: boolean; at: string }
export interface IssueComment { id: number; userId: number; userLogin: string; userType: string; viaApp: boolean; body: string; createdAt: string }
export interface Review { id: number; userId: number; commitId: string; state: string; submittedAt: string }
export interface ReviewComment { id: number; reviewId: number | null; inReplyTo: number | null; userId: number; commitId: string; path: string; body: string; createdAt: string }
export interface CheckRun { name: string; appId: number; headSha: string; status: string; conclusion: string | null; title: string | null; summary: string | null }
export interface Forge {
  repoInfo(): Promise<{ private: boolean; defaultBranch: string }>;
  findPr(headRef: string): Promise<PrInfo | undefined>;
  pr(n: number): Promise<PrInfo>;
  openPr(o: { head: string; base: string; title: string; body: string; draft: boolean }): Promise<PrInfo>;
  editPrBody(n: number, body: string): Promise<void>;
  markReady(n: number): Promise<void>;
  addLabels(n: number, labels: string[]): Promise<void>;
  createComment(n: number, body: string): Promise<number>;
  editComment(id: number, body: string): Promise<void>;
  issueComments(n: number): Promise<IssueComment[]>;
  labelEvents(n: number): Promise<LabelEvent[]>;
  permission(login: string): Promise<Permission>;
  reviews(n: number): Promise<Review[]>;
  reviewComments(n: number): Promise<ReviewComment[]>;
  checkRuns(sha: string): Promise<CheckRun[]>;
}
