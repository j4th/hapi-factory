/**
 * Discovery: the merged work orders on a repo's mirror (./mirror.ts), read with host git alone (design §3.4,
 * §6a item 1; H-183(c)).
 *
 * - **The key.** A work order is `.factory/work/<id>/order.yaml` on main, keyed by the commit that first added it
 *   on main's first-parent line: the planning PR's merge commit. Everything about it is read at that commit, never
 *   at main's head: the order, its `task.md` and the repo's overlay (`.factory/config.yaml`). So a later edit on
 *   main changes nothing about a merged work order, and one deleted from main later can still be rebuilt at its
 *   merge (`readWorkOrder`), which is how the poller rebuilds each work order it already has state for.
 * - **Never re-keyed.** The poller passes the ids it has state for (`known`), and discovery skips them before it
 *   looks for a key, so a force-pushed main, which gives a merge a new sha, never makes a run a second time.
 * - **Pinned.** The poller pins each work order it has state for at its merge (`pinWorkOrder`, `refs/hapi/orders/
 *   <id>`), because a bare mirror keeps no reflog: after a rewrite of main the old merge is unreachable at once, and
 *   gc would prune it. A merge the mirror no longer holds is `readWorkOrder`'s "<sha12> is not in the mirror".
 * - **Problems, not work orders.** A bad one (a directory name that isn't a work-order id, YAML that doesn't parse,
 *   an order that fails validation, an id unlike its directory's name, no task.md, a file that isn't a regular
 *   file, a file over `runs.work_order_kb`, an overlay that fails its schema or loosens the central policy) is
 *   pushed onto the caller's `problems`, for the tick report and the status comment's "Can't run" table, and is
 *   never returned.
 * - **Capped before it is read.** Each of the three files' size comes from `ls-tree -l`, and one over
 *   `runs.work_order_kb` (central only) is refused, never truncated, before its blob is read (H-247).
 * - **Read as data.** Files are read with `cat-file blob`, never `git show`, so no textconv, attribute or pager
 *   applies; pathspecs are literal (`--literal-pathspecs`), so a directory name is never a glob; and a work-order
 *   id and a commit id are checked before either reaches git, so nothing is ever read as an option.
 *
 * `planningPrOf` reads a merge's PR number from GitHub's classic merge message, the only source there is: Task
 * 3's Forge has no commit-to-PR route, and `new-repo` repos allow merge commits only, with that message, which
 * the audit's `github.repo-settings` holds them to. `overlapProblem` is the plain overlap check (§3.4).
 */
import { applyOverlay, overlayFromText, PolicyLoosenError } from "../policy/overlay";
import { PolicyError } from "../policy/load";
import { parseYaml } from "../policy/schema";
import type { Policy, RepoOverlay } from "../policy/types";
import { hardenedGit } from "../run/git";
import { isWorkOrderId, validateWorkOrder, WORK_ORDER_ID_MAX, type WorkOrder } from "../workorder/validate";
import { type MirrorDeps, mirrorPath } from "./mirror";

export interface Discovered {
  repo: string;
  id: string;
  /** The commit on main's first-parent line that first added the order: the planning PR's merge. */
  mergeSha: string;
  workOrder: WorkOrder;
  taskMd: string;
  /** `.factory/config.yaml` at `mergeSha`, or undefined when there is none. */
  overlay: RepoOverlay | undefined;
}

/** A work order that can't run: `path` is its order.yaml, `reason` says why. */
export interface DiscoverProblem {
  path: string;
  reason: string;
}

/** What discovery needs besides the mirror: the central policy each overlay is applied to (`applyOverlay`). */
export interface DiscoverDeps extends MirrorDeps {
  central: Policy;
}

const ORDER = /^\.factory\/work\/([^/]+)\/order\.yaml$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const OVERLAY = ".factory/config.yaml";
const PLANNING_MERGE = /^Merge pull request #([1-9][0-9]*) from \S+$/;
const firstLine = (s: string | undefined) => (s ?? "").trim().split("\n")[0]?.trim().slice(0, 300) || "(no error output)";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** git on `repo`'s mirror: hardened, with literal pathspecs. */
function onMirror(d: MirrorDeps, repo: string, args: string[]) {
  const g = hardenedGit(d, { git: ["--literal-pathspecs", "--git-dir", mirrorPath(d.engineDir, repo)] });
  return d.run([...g.cmd, ...args], { env: g.env, inherit: false });
}

/** `onMirror`'s stdout; a non-zero exit throws, saying what couldn't be done. */
async function git(d: MirrorDeps, repo: string, args: string[], what: string): Promise<string> {
  const r = await onMirror(d, repo, args);
  if (r.code !== 0) throw new Error(`cannot ${what} in ${repo}'s mirror (git ${args[0]} exited ${r.code}): ${firstLine(r.stderr)}`);
  return r.stdout;
}

/** Printable ASCII only, and at most 80 characters: for a name from the git tree, or from a caller, in a message. */
function shown(s: string): string {
  const safe = s.replace(/[^\x21-\x7e]/g, "?");
  return safe.length > 80 ? `${safe.slice(0, 80)}...` : safe;
}

function commitId(sha: string): string {
  if (!COMMIT.test(sha)) throw new Error(`not a commit id: ${shown(sha)}`);
  return sha;
}

function workOrderId(id: string): string {
  if (!isWorkOrderId(id)) throw new Error(`not a work-order id: ${shown(id)}`);
  return id;
}

/** Throws unless `sha` is a commit the mirror holds. */
async function commitIn(d: MirrorDeps, repo: string, sha: string): Promise<void> {
  const at = sha.slice(0, 12);
  const r = await onMirror(d, repo, ["cat-file", "-t", sha]);
  if (r.code !== 0) throw new Error(`${at} is not in the mirror (main was rewritten and the work order wasn't pinned, or the mirror was deleted)`);
  if (r.stdout.trim() !== "commit") throw new Error(`${at} is not a commit`);
}

/** The reason a directory under .factory/work whose name isn't a work-order id gives; the name itself is in `path`, shown safe. */
const NOT_AN_ID = `its directory's name is not a work-order id (four or more digits, a hyphen and a lower-case slug, at most ${WORK_ORDER_ID_MAX} characters)`;

/**
 * The work orders on the mirror's main, by id, that aren't in `known`: each keyed by the merge that first added
 * it and read there (`readWorkOrder`). One that can't be read is pushed onto `problems` instead. Throws when the
 * mirror has no main, or git fails.
 */
export async function discoverWorkOrders(d: DiscoverDeps, repo: string, known: ReadonlySet<string>, problems: DiscoverProblem[]): Promise<Discovered[]> {
  const main = await onMirror(d, repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"]);
  if (main.code !== 0) throw new Error(`${repo}'s mirror has no main: fetch it first`);
  const listed = await git(d, repo, ["ls-tree", "-r", "-z", "--name-only", "refs/heads/main", "--", ".factory/work"], "list .factory/work on main");
  const orders = listed
    .split("\0")
    .map((path) => ({ path, id: ORDER.exec(path)?.[1] }))
    .filter((o): o is { path: string; id: string } => o.id !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const found: Discovered[] = [];
  for (const { path, id } of orders) {
    if (!isWorkOrderId(id)) {
      problems.push({ path: `.factory/work/${shown(id)}/order.yaml`, reason: NOT_AN_ID });
      continue;
    }
    if (known.has(id)) continue; // never re-keyed, never reported: the poller already has its state
    const mergeSha = await firstAddedBy(d, repo, path);
    if (mergeSha === undefined) {
      problems.push({ path, reason: "no commit on main's first-parent line adds it" });
      continue;
    }
    try {
      found.push(await readWorkOrder(d, repo, id, mergeSha));
    } catch (e) {
      problems.push({ path, reason: message(e) });
    }
  }
  return found;
}

/**
 * The commit on the mirror's main, along its first-parent line, that first added `path` (a planning PR's merge, for
 * a work order's order.yaml), or undefined when none does: the key discovery gives a work order, and how the poller
 * finds the planning PR of a work order that can't run (Task 14's `problemPr`). Throws when git fails.
 */
export async function firstAddedBy(d: MirrorDeps, repo: string, path: string): Promise<string | undefined> {
  const log = await git(
    d,
    repo,
    ["log", "--first-parent", "--diff-merges=first-parent", "--diff-filter=A", "--format=%H", "--no-patch", "--reverse", "refs/heads/main", "--", path],
    `find the commit that added ${shown(path)}`,
  );
  const sha = log.split("\n")[0]?.trim() ?? "";
  return COMMIT.test(sha) ? sha : undefined;
}

/**
 * Work order `id` as it was at `mergeSha`: its order, task.md and the repo's overlay, all read there. Throws the
 * reason it can't run (the `reason` of a `DiscoverProblem`).
 */
export async function readWorkOrder(d: DiscoverDeps, repo: string, id: string, mergeSha: string): Promise<Discovered> {
  workOrderId(id);
  const sha = commitId(mergeSha);
  const at = sha.slice(0, 12);
  await commitIn(d, repo, sha);
  const orderPath = `.factory/work/${id}/order.yaml`;
  const taskPath = `.factory/work/${id}/task.md`;
  const wanted = [orderPath, taskPath, OVERLAY];
  // -l gives each blob's size, so a file over runs.work_order_kb is refused before it is read (H-247).
  const listed = await git(d, repo, ["ls-tree", "-r", "-z", "-l", sha, "--", ...wanted], `list ${orderPath} at ${at}`);
  const entries = listed
    .split("\0")
    .filter((e) => e !== "")
    .map((e) => {
      const tab = e.indexOf("\t");
      const [mode, type, oid, size] = e.slice(0, tab).split(/ +/);
      return { mode, type, oid, size: Number(size), path: e.slice(tab + 1) };
    });
  const capKb = d.central.runs.work_order_kb;
  const blobs = new Map<string, string>();
  for (const path of wanted) {
    const entry = entries.find((e) => e.path === path);
    // With -r, a directory at `path` shows as what is under it, never as itself.
    const nested = entries.some((e) => e.path.startsWith(`${path}/`));
    if (entry === undefined && !nested) continue;
    if (entry === undefined || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || !/^[0-9a-f]{40,64}$/.test(entry.oid ?? "")) {
      throw new Error(`${path} at ${at} is not a regular file`);
    }
    // Refused, never truncated: a size git didn't give is refused too.
    if (!Number.isSafeInteger(entry.size) || entry.size > capKb * 1024) {
      const shownSize = Number.isSafeInteger(entry.size) ? `${(entry.size / 1024).toFixed(1)} KiB` : "of a size git didn't give";
      throw new Error(`${path} at ${at} is ${shownSize}, over runs.work_order_kb (${capKb} KiB): discovery reads no larger work-order file`);
    }
    blobs.set(path, entry.oid!);
  }
  const read = async (path: string) => {
    const oid = blobs.get(path);
    return oid === undefined ? undefined : git(d, repo, ["cat-file", "blob", oid], `read ${path} at ${at}`);
  };

  const orderText = await read(orderPath);
  if (orderText === undefined) throw new Error(`no order.yaml at ${at}`);
  const workOrder = validateWorkOrder(parseYaml(orderText));
  if (workOrder.id !== id) throw new Error(`its id is ${workOrder.id}, not its directory's name ${id}`);
  const taskMd = await read(taskPath);
  if (taskMd === undefined) throw new Error(`no task.md beside it at ${at}`);
  const overlayText = await read(OVERLAY);
  const label = `${OVERLAY} at ${at}`;
  const overlay = overlayText === undefined ? undefined : overlayFromText(overlayText, label);
  if (overlay !== undefined) {
    // Schema-valid isn't enough: an overlay that loosens the central policy would fail every later use of it.
    try {
      applyOverlay(d.central, overlay);
    } catch (e) {
      if (e instanceof PolicyError) throw new PolicyError(label, e.issues);
      if (e instanceof PolicyLoosenError) throw new Error(`${label}: ${e.message}`);
      throw e;
    }
  }
  return { repo, id, mergeSha: sha, workOrder, taskMd, overlay };
}

/**
 * The planning PR whose merge `mergeSha` is, from GitHub's classic merge message, or undefined for any other
 * commit: one without exactly two parents, whatever its subject says, or one whose subject isn't the message.
 */
export async function planningPrOf(d: MirrorDeps, repo: string, mergeSha: string): Promise<number | undefined> {
  const sha = commitId(mergeSha);
  const out = await git(d, repo, ["log", "-1", "--format=%P%x00%s", sha], `read ${sha.slice(0, 12)}'s parents and subject`);
  const nul = out.indexOf("\0");
  if (nul === -1) return undefined;
  if (out.slice(0, nul).split(" ").filter((p) => p !== "").length !== 2) return undefined;
  const pr = PLANNING_MERGE.exec(out.slice(nul + 1).replace(/\n$/, ""))?.[1];
  if (pr === undefined) return undefined;
  const n = Number(pr);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The ref that pins work order `id` at its merge in the mirror. */
const pinRef = (id: string) => `refs/hapi/orders/${workOrderId(id)}`;

/**
 * Pin work order `id` at `mergeSha` in `repo`'s mirror, as `refs/hapi/orders/<id>`, so its merge stays reachable,
 * and so through gc, after a rewrite of main. The fetch never touches it. The poller pins a work order when it
 * makes its state, and unpins it when it retires it.
 */
export async function pinWorkOrder(d: MirrorDeps, repo: string, id: string, mergeSha: string): Promise<void> {
  const ref = pinRef(id);
  const sha = commitId(mergeSha);
  await commitIn(d, repo, sha);
  await git(d, repo, ["update-ref", ref, sha], `pin ${id} at ${sha.slice(0, 12)}`);
}

/** Drop work order `id`'s pin from `repo`'s mirror; a pin that isn't there is no error. */
export async function unpinWorkOrder(d: MirrorDeps, repo: string, id: string): Promise<void> {
  await git(d, repo, ["update-ref", "-d", pinRef(id)], `unpin ${id}`);
}

/**
 * A glob's literal prefix: with its `.` and empty segments dropped (the schema accepts `./a`, `a//b` and `a/./b`,
 * which name `a` and `a/b`), the text before its first `*`, `?`, `[`, `{` or `!`, lower-cased (matching ignores
 * case).
 */
function prefixOf(glob: string): string {
  const path = glob
    .split("/")
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
  const wild = path.search(/[*?[{!]/);
  return (wild === -1 ? path : path.slice(0, wild)).toLowerCase();
}

/**
 * The work orders among `orders` to hold because a piece of each declares files a piece of another does (§3.4):
 * work-order id → reason. Two globs overlap when one's literal prefix starts with the other's, so a leading
 * wildcard overlaps everything. Orders are compared in pairs, in id order; the first overlap of a pair gives both
 * their reason, and an order that already has one keeps it. Pieces of one work order never count.
 */
export function overlapProblem(orders: Discovered[]): Map<string, string> {
  const sorted = [...orders].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const globs = sorted.map((o) => o.workOrder.pieces.flatMap((p) => p.files));
  const held = new Map<string, string>();
  const reason = (other: string, mine: string, theirs: string) => `overlaps work order ${other} (${mine} and ${theirs}): merge them into one work order, or plan one after the other merges`;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      let hit: [string, string] | undefined;
      for (const ga of globs[i]!) {
        const pa = prefixOf(ga);
        const gb = globs[j]!.find((g) => {
          const pb = prefixOf(g);
          return pa.startsWith(pb) || pb.startsWith(pa);
        });
        if (gb !== undefined) {
          hit = [ga, gb];
          break;
        }
      }
      if (hit === undefined) continue;
      if (!held.has(a.id)) held.set(a.id, reason(b.id, hit[0], hit[1]));
      if (!held.has(b.id)) held.set(b.id, reason(a.id, hit[1], hit[0]));
    }
  }
  return held;
}
