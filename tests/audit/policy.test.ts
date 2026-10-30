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

  test("either one hard passes", async () => {
    for (const modes of [{ hapi_guard: "hard", archon: "soft" }, { hapi_guard: "soft", archon: "hard" }]) {
      const r = await enforcement(modes);
      expect([modes, r.status]).toEqual([modes, "pass"]);
    }
  });
});
