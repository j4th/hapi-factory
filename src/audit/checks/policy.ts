/**
 * policy.budget-enforcement (design §3.5): `run_usd` is a per-run target, and
 * something has to stop a run at it. policy/budgets.yaml gives each enforcer a
 * mode, hard (stops the run) or soft (flags it, lets it finish), and this
 * fails when both are soft. Read from policy/, so it needs nothing running.
 */
import { loadPolicy } from "../../policy/load";
import { type AuditRun, type CheckResult, result } from "../types";

/** policy.budget-enforcement */
export async function budgetEnforcement(run: AuditRun): Promise<CheckResult[]> {
  const id = "policy.budget-enforcement";
  const { hapi_guard: guard, archon } = loadPolicy(run.ctx.policyDir).budgets.enforcement;
  if (guard === "soft" && archon === "soft") {
    return [result(id, "fail", "budgets.enforcement: hapi_guard and archon are both soft: no enforcer stops a run at run_usd (design §3.5). Set one to hard in policy/budgets.yaml, in a PR")];
  }
  // Archon bounds a run's nodes (max_work_units), never its dollars, so only hapi-guard stops a run at run_usd (H-257).
  const how = guard === "hard" ? "hapi-guard stops a Pi run at run_usd" : "Archon bounds the run's nodes (max_work_units), not its dollars, so nothing stops a Pi run at run_usd (H-257)";
  return [result(id, "pass", `budgets.enforcement: hapi_guard ${guard}, archon ${archon}: ${how}`)];
}
