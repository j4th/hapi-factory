/**
 * The forge interface (spec §16): the one way the mirror, the harvester, the state machine and the
 * poller reach GitHub. `githubForge` is its REST adapter; tests use it over `fakeForge().fetch`.
 */
export type { Env } from "../stack/up";
export { githubForge } from "./github/forge";
export { authedGit } from "./github/git";
export { forgeToken } from "./github/token";

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
