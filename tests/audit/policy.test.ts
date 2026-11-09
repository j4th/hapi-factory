/**
 * The policy.* checks:
 * - policy.budget-enforcement (design §3.5): run_usd needs an enforcer that stops a run. Read from
 *   policy/budgets.yaml, so it needs nothing running.
 * - policy.repos (design §3.2 step 9): each repo policy/repos.yaml registers is covered by the hapi-planner and
 *   hapi-factory installations it records, asked of GitHub with each App's own key.
 * - policy.sidecars (design §3.3): every policy sidecar's pinned image is in this Docker.
 * - policy.decision-models (design §3.6, "Decisions"): always a pass, with a note when decision models are off or give
 *   notes only. Read from policy/, so it needs nothing running.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "../../src/audit/index";
import { envFileText } from "../../src/secrets/files";
import { APP_IDS, APP_KEY, appOf, cleanup, cleanWorld, hostEnv, NAME, only, OWNER, REPO, registeredPolicy, SIDECAR_IMAGE, tempDir } from "./helpers";

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

describe("policy.repos", () => {
  /** A world whose policy/ registers OWNER/NAME with the installations planner 11 and factory 12, as the fake GitHub has them. */
  async function registered(o: { keys?: boolean } = {}) {
    const w = await cleanWorld();
    w.ctx.policyDir = registeredPolicy();
    if (o.keys !== false) hostEnv(w.ctx.env as Record<string, string>);
    return w;
  }
  const setRepos = (w: Awaited<ReturnType<typeof cleanWorld>>, text: string) => writeFileSync(join(w.ctx.policyDir, "repos.yaml"), text);

  test("passes when each registered repo is covered by the installations repos.yaml records, asked with each App's key", async () => {
    const w = await registered();
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect([r.status, r.detail]).toEqual(["pass", "policy/repos.yaml: 1 repo, each covered by the recorded hapi-planner and hapi-factory installations (CodeRabbit's isn't checked: hapi holds no key for it)"]);
    // Exactly one GET of the repo's installation per App, each with that App's own JWT, and nothing else: no mint.
    expect(w.requests.map((c) => [c.method, c.url, appOf(c)])).toEqual([
      ["GET", `https://api.github.com/repos/${OWNER}/${NAME}/installation`, "planner"],
      ["GET", `https://api.github.com/repos/${OWNER}/${NAME}/installation`, "factory"],
    ]);
  });

  test("a recorded installation GitHub doesn't have fails, naming the repo, the App and both ids", async () => {
    const w = await registered();
    setRepos(w, `installations: { planner: 11, factory: 99 }\nrepos:\n  ${OWNER}/${NAME}: { registered: "2026-10-31" }\n`);
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect([r.status, r.detail]).toEqual([
      "fail",
      `policy/repos.yaml: ${OWNER}/${NAME}: hapi-factory's installation is 12, not 99 as recorded in installations.factory: correct it in a PR (docs/runbooks/github-apps.md)`,
    ]);
  });

  test("an App that isn't installed on a registered repo fails, with GitHub's 404", async () => {
    const w = await registered();
    w.routes[`GET https://api.github.com/repos/${OWNER}/${NAME}/installation`] = { status: 404, body: { message: "Not Found" } };
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(`${OWNER}/${NAME}: hapi-planner: the App is not installed on ${OWNER}/${NAME} (GitHub 404)`);
    expect(r.detail).toContain(`${OWNER}/${NAME}: hapi-factory: the App is not installed`);
  });

  test("with one App's key missing and the other's installation matching, it skips, naming the App it couldn't ask", async () => {
    const w = await registered({ keys: false });
    const dir = join(w.ctx.env.XDG_RUNTIME_DIR!, "hapi", "env");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(join(w.ctx.env.XDG_RUNTIME_DIR!, "hapi"), 0o700);
    writeFileSync(join(dir, "host.env"), envFileText("host", { HAPI_PLANNER_APP_ID: String(APP_IDS.planner), HAPI_PLANNER_APP_PRIVATE_KEY: APP_KEY }), { mode: 0o600 });
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect(r.status).toBe("skip");
    expect(r.detail).toStartWith(`${OWNER}/${NAME}: hapi-planner's installations match, but no GitHub credentials for hapi-factory: `);
    expect(r.detail).toContain("has no HAPI_FACTORY_APP_ID");
    expect(w.requests.map((c) => appOf(c))).toEqual(["planner"]);
  });

  test("with no host.env (no App keys) it skips, naming the repo", async () => {
    const w = await registered({ keys: false });
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect(r.status).toBe("skip");
    expect(r.detail).toStartWith(`${OWNER}/${NAME}: no GitHub credentials for either App:`);
    expect(w.requests).toEqual([]);
  });

  test("a registry with no repo passes, saying the poller acts on none", async () => {
    const w = await registered();
    setRepos(w, "installations: { planner: 11, factory: 12 }\nrepos: {}\n");
    const r = only(await runAudit(w.ctx), "policy.repos");
    expect([r.status, r.detail]).toEqual(["pass", "policy/repos.yaml registers no repo: the poller acts on none"]);
  });
});

describe("policy.sidecars", () => {
  test("passes when every policy sidecar's pinned image is in this Docker", async () => {
    const w = await cleanWorld();
    const r = only(await runAudit(w.ctx), "policy.sidecars");
    expect([r.status, r.detail]).toEqual(["pass", "policy/sidecars.yaml: every sidecar image is in this Docker by digest (bun-http)"]);
    expect(w.calls).toContainEqual(["docker", "image", "inspect", "--format", "{{.Id}}", SIDECAR_IMAGE]);
  });

  test("a sidecar image that isn't here fails: a run never pulls one", async () => {
    const w = await cleanWorld();
    w.images.delete(SIDECAR_IMAGE);
    const r = only(await runAudit(w.ctx), "policy.sidecars");
    expect([r.status, r.detail]).toEqual(["fail", `policy/sidecars.yaml: bun-http: ${SIDECAR_IMAGE} is not in this Docker: \`mise run up\` pulls it, and a run's \`--pull never\` refuses a missing image`]);
  });

  test("with no Docker it skips, saying it can't ask", async () => {
    const w = await cleanWorld();
    w.dockerDown = true;
    const r = only(await runAudit(w.ctx), "policy.sidecars");
    expect(r.status).toBe("skip");
    expect(r.detail).toStartWith("cannot ask Docker:");
    const t = await cleanWorld();
    t.ctx.exec = async () => {
      throw new Error("cannot run docker: is it installed and on PATH?");
    };
    const e = only(await runAudit(t.ctx), "policy.sidecars");
    expect([e.status, e.detail]).toEqual(["skip", "cannot ask Docker: cannot run docker: is it installed and on PATH?"]);
  });
});

describe("policy.decision-models", () => {
  /** The check's result for a copy of policy/ with gates.yaml and flags.yaml edited by `edit`. */
  async function models(edit: (f: { gates: string; flags: string }) => { gates: string; flags: string }) {
    const w = await cleanWorld();
    const policy = tempDir("hapi-audit-policy-");
    cpSync(join(REPO, "policy"), policy, { recursive: true });
    const read = (f: string) => readFileSync(join(policy, f), "utf8");
    const out = edit({ gates: read("gates.yaml"), flags: read("flags.yaml") });
    writeFileSync(join(policy, "gates.yaml"), out.gates);
    writeFileSync(join(policy, "flags.yaml"), out.flags);
    w.ctx.policyDir = policy;
    return only(await runAudit(w.ctx), "policy.decision-models");
  }
  const once = (text: string, from: RegExp, to: string) => {
    expect([String(from), from.test(text)]).toEqual([String(from), true]);
    return text.replace(from, to);
  };

  test("the shipped policy passes, saying decision models are on", async () => {
    const r = only(await runAudit((await cleanWorld()).ctx), "policy.decision-models");
    expect([r.status, r.detail]).toEqual(["pass", "decision models are on: the engine's decisions (gates.decisions.mode: enforce), the bash gate and the result screen"]);
  });

  test("docs/policy.md's recipe passes, with a note naming each part that is off", async () => {
    const r = await models(({ gates, flags }) => ({
      gates: once(once(once(gates, /^( {2}mode:) enforce/m, "$1 off"), /^(bash_gate:\n {2}enabled:) true/m, "$1 false"), /^(result_screen:\n {2}enabled:) true/m, "$1 false"),
      flags: once(flags, /^jev: .*$/m, "jev:          { enabled: false, fallback: none, via: openrouter }"),
    }));
    expect([r.status, r.detail]).toEqual([
      "pass",
      'note: decision models are off for the engine\'s decisions (gates.decisions.mode: off), the bash gate (gates.bash_gate.enabled: false) and the result screen (gates.result_screen.enabled: false): nothing screens them with a classifier, by the operator\'s choice (docs/policy.md, "Running without decision models")',
    ]);
  });

  test("one decision off passes, with a note naming it", async () => {
    const r = await models(({ gates, flags }) => ({ gates: once(gates, /^( {6}mode:) enforce/m, "$1 off"), flags }));
    expect(r.status).toBe("pass");
    expect(r.detail).toStartWith("note: decision models are off for the engine's diff-screen (gates.decisions.by_name.diff-screen.mode: off)");
  });

  test("decisions.mode: notes passes, with a note that no answer holds a PR", async () => {
    const r = await models(({ gates, flags }) => ({ gates: once(gates, /^( {2}mode:) enforce/m, "$1 notes"), flags }));
    expect([r.status, r.detail]).toEqual(["pass", 'note: the engine\'s decisions give notes only (gates.decisions.mode: notes): none holds a PR (docs/policy.md, "Running without decision models")']);
  });

  test("M12: a decision in shadow passes, with a note that it holds nothing", async () => {
    const r = await models(({ gates, flags }) => ({ gates: once(gates, /^( {6}mode:) enforce/m, "$1 shadow"), flags }));
    expect([r.status, r.detail]).toEqual([
      "pass",
      'note: the engine\'s diff-screen is in shadow (gates.decisions.by_name.diff-screen.mode: shadow): asked and recorded, it holds nothing (docs/policy.md, "Running without decision models")',
    ]);
  });

  test("M12: a decision with on_unscreened: note passes, with a note that an unanswered subject never holds", async () => {
    const r = await models(({ gates, flags }) => ({ gates: once(gates, /^( {6}on_unscreened:) hold/m, "$1 note"), flags }));
    expect([r.status, r.detail]).toEqual([
      "pass",
      'note: the engine\'s diff-screen gives a note, not a hold, for a subject no classifier answered (gates.decisions.by_name.diff-screen.on_unscreened: note) (docs/policy.md, "Running without decision models")',
    ]);
  });

  test("both at once: one gate off and notes only, in one note", async () => {
    const r = await models(({ gates, flags }) => ({ gates: once(once(gates, /^( {2}mode:) enforce/m, "$1 notes"), /^(bash_gate:\n {2}enabled:) true/m, "$1 false"), flags }));
    expect([r.status, r.detail]).toEqual([
      "pass",
      'note: decision models are off for the bash gate (gates.bash_gate.enabled: false): nothing screens it with a classifier, by the operator\'s choice; the engine\'s decisions give notes only (gates.decisions.mode: notes): none holds a PR (docs/policy.md, "Running without decision models")',
    ]);
  });
});
