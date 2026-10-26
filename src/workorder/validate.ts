/**
 * Work orders (spec §6): `.factory/work/<id>/order.yaml`, the machine-readable
 * contract for one factory run. `validateWorkOrder` checks one against
 * policy/schemas/work-order.schema.json, plus the rules a schema can't say
 * (piece ids are unique). The same check runs in Hermes before a planning PR,
 * in CI and in Archon's prepare step.
 */
import { check, formatIssue, type Issue, readYaml } from "../policy/schema";
import type { Tier } from "../policy/types";

export interface WorkOrder {
  /** e.g. "0002-search-partners-tool": names the work-order directory and the factory/<id> branch. */
  id: string;
  lane: "planning" | "factory" | "direct";
  /** Archon workflow name. */
  workflow: string;
  risk: "low" | "medium" | "high";
  /** Abstract tiers, never model ids. */
  roles: { implement: Tier; review: Tier };
  budget: { usd: number; turns: number; minutes: number };
  /** Each piece's declared file scope, relative to the repo root. */
  pieces: { id: string; files: string[]; size: Tier }[];
  verify: { smoke: boolean };
  egress_extra: string[];
  trace: { traceparent: string };
  sources: string[];
}

/** A work order is invalid. `path` is a JSON Pointer into it ("" = the whole order). */
export class WorkOrderError extends Error {
  override name = "WorkOrderError";
  readonly path: string;
  /** Every problem found; `path` is the first one's. */
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map(formatIssue).join("; "));
    this.issues = issues;
    this.path = issues[0]?.path ?? "";
  }
}

/** Validate a parsed work order. Returns it typed, or throws WorkOrderError. */
export function validateWorkOrder(obj: unknown): WorkOrder {
  const issues = check("work-order", obj);
  if (issues.length > 0) throw new WorkOrderError(issues);
  const order = obj as WorkOrder;
  const seen = new Set<string>();
  order.pieces.forEach((piece, i) => {
    if (seen.has(piece.id)) issues.push({ path: `/pieces/${i}/id`, message: `duplicate piece id "${piece.id}"` });
    seen.add(piece.id);
  });
  if (issues.length > 0) throw new WorkOrderError(issues);
  return order;
}

/** Read a work-order YAML file and validate it. A file that can't be read or parsed fails at path "". */
export function loadWorkOrder(file: string): WorkOrder {
  let data: unknown;
  try {
    data = readYaml(file);
  } catch (e) {
    throw new WorkOrderError([{ path: "", message: `${file}: ${(e as Error).message}` }]);
  }
  return validateWorkOrder(data);
}

/**
 * `hapi workorder validate <path>`: prints the work order's id and exits 0, or
 * prints one `path: message` line per problem to stderr and exits 1.
 */
export function workorderValidate(args: string[]): number {
  const [file, ...extra] = args;
  if (file === undefined || extra.length > 0 || file.startsWith("-")) {
    console.error("usage: hapi workorder validate <path>");
    return 2;
  }
  try {
    console.log(loadWorkOrder(file).id);
    return 0;
  } catch (e) {
    if (!(e instanceof WorkOrderError)) throw e;
    for (const issue of e.issues) console.error(formatIssue(issue));
    return 1;
  }
}
