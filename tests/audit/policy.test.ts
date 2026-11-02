/**
 * policy.budget-enforcement (design §3.5): run_usd needs an enforcer that stops
 * a run. Read from policy/budgets.yaml, so it needs nothing running.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { cleanup, cleanWorld, only, REPO, tempDir } from "./helpers";

afterEach(cleanup);

/** The audit's result for a policy/ whose budgets.yaml enforcement is `modes`. */
async function enforcement(modes: { hapi_guard: string; archon: string }) {
  const w = await cleanWorld();
  const policy = tempDir("hapi-audit-policy-");
  cpSync(join(REPO, "policy"), policy, { recursive: true });
  const file = join(policy, "budgets.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/hapi_guard: \w+/, `hapi_guard: ${modes.hapi_guard}`).replace(/archon: \w+/, `archon: ${modes.archon}`));
  w.ctx.policyDir = policy;
  return only(await runAudit(w.ctx), "policy.budget-enforcement");
}

describe("policy.budget-enforcement", () => {
  test("the shipped policy, with both enforcers hard, passes", async () => {
    const r = only(await runAudit((await cleanWorld()).ctx), "policy.budget-enforcement");
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("hapi_guard hard");
  });

  test("both soft fails: no enforcer stops a run at run_usd", async () => {
    const r = await enforcement({ hapi_guard: "soft", archon: "soft" });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("budgets.enforcement: hapi_guard and archon are both soft: no enforcer stops a run at run_usd (design §3.5)");
  });

  test("either one hard passes, and the detail says which stops a Pi run: Archon bounds nodes, never dollars (H-257)", async () => {
    for (const [modes, says] of [
      [{ hapi_guard: "hard", archon: "soft" }, "hapi-guard stops a Pi run at run_usd"],
      [{ hapi_guard: "soft", archon: "hard" }, "Archon bounds the run's nodes (max_work_units), not its dollars, so nothing stops a Pi run at run_usd (H-257)"],
    ] as const) {
      const r = await enforcement(modes);
      expect([modes, r.status, r.detail]).toEqual([modes, "pass", expect.stringContaining(says)]);
      expect(r.detail).not.toContain("Archon stops");
    }
  });
});
