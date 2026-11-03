/**
 * The policy.* checks:
 *
 * - policy.budget-enforcement (design §3.5): `run_usd` is a per-run target, and something has to stop a run at it.
 *   policy/budgets.yaml gives each enforcer a mode, hard (stops the run) or soft (flags it, lets it finish), and this
 *   fails when both are soft. Read from policy/, so it needs nothing running.
 * - policy.repos (Plan 03 design §3.2 step 9): each repo policy/repos.yaml registers is covered by the hapi-planner
 *   and hapi-factory installations it records (`installations.planner`, `installations.factory`), asked of GitHub
 *   (`GET /repos/{owner}/{repo}/installation`) with each App's own JWT, as the run engine's `forgeToken` asks before
 *   it mints. A different id, an App not installed there, or any other error GitHub gives is a fail; no App key in
 *   host.env is a skip. CodeRabbit's installation isn't checked: hapi holds no key for its App.
 * - policy.sidecars (design §3.3): each sidecar in policy/sidecars.yaml has its pinned image in this Docker
 *   (`docker image inspect`), since a run starts its sidecar with `--pull never`; `mise run up` pulls them.
 * - policy.decision-models (design §3.6, "Decisions"): always a pass. Running without decision models is the
 *   operator's explicit choice, and `loadPolicy` already refuses a gate or an engine decision that is on with no
 *   classifier, so this only says, in a note, what is off (`gates.decisions.mode: off`, else each decision that is
 *   off; then each of the guard's gates that is off), whether the engine's decisions give notes only, and each
 *   decision in shadow or with `on_unscreened: note` (M12), so a policy that holds less is never silent. Read from
 *   policy/, so it needs nothing running.
 */
import { APPS, appCredentials, findInstallationId, parseOwnerRepo } from "../../forge/github/app-token";
import { loadPolicy } from "../../policy/load";
import { type AuditRun, type CheckResult, result } from "../types";
import { firstLine } from "./util";

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

/** policy.repos */
export async function policyRepos(run: AuditRun): Promise<CheckResult[]> {
  const id = "policy.repos";
  const { ctx } = run;
  const registry = loadPolicy(ctx.policyDir).repos;
  const names = Object.keys(registry.repos);
  if (names.length === 0) return [result(id, "pass", "policy/repos.yaml registers no repo: the poller acts on none")];
  // Each App's credentials once: host.env is the same for every repo.
  const creds: { app: "planner" | "factory"; appId: string; privateKeyPem: string }[] = [];
  const gaps: string[] = [];
  for (const app of ["planner", "factory"] as const) {
    try {
      creds.push({ app, ...(await appCredentials(app, ctx.env)) });
    } catch (e) {
      gaps.push(`${APPS[app].name}: ${(e as Error).message}`);
    }
  }
  if (creds.length === 0) return [result(id, "skip", `${names.join(", ")}: no GitHub credentials for either App: ${gaps.join("; ")}`)];
  const problems: string[] = [];
  for (const name of names) {
    const repo = parseOwnerRepo(name);
    if (repo === undefined) {
      problems.push(`${name}: not an owner/name repository`);
      continue;
    }
    for (const c of creds) {
      const appName = APPS[c.app].name;
      const recorded = registry.installations[c.app];
      try {
        const found = await findInstallationId({ appId: c.appId, privateKeyPem: c.privateKeyPem, owner: repo.owner, repo: repo.name, fetch: ctx.fetch, now: ctx.now });
        if (found !== recorded) problems.push(`${name}: ${appName}'s installation is ${found}, not ${recorded} as recorded in installations.${c.app}: correct it in a PR (docs/runbooks/github-apps.md)`);
      } catch (e) {
        problems.push(`${name}: ${appName}: ${(e as Error).message}`);
      }
    }
  }
  if (problems.length > 0) return [result(id, "fail", `policy/repos.yaml: ${problems.join("; ")}`)];
  if (gaps.length > 0) return [result(id, "skip", `${names.join(", ")}: ${creds.map((c) => APPS[c.app].name).join(" and ")}'s installations match, but no GitHub credentials for ${gaps.join("; ")}`)];
  const n = names.length;
  return [result(id, "pass", `policy/repos.yaml: ${n} repo${n === 1 ? "" : "s"}, each covered by the recorded hapi-planner and hapi-factory installations (CodeRabbit's isn't checked: hapi holds no key for it)`)];
}

/** policy.sidecars */
export async function policySidecars(run: AuditRun): Promise<CheckResult[]> {
  const id = "policy.sidecars";
  const sidecars = Object.entries(loadPolicy(run.ctx.policyDir).sidecars);
  if (sidecars.length === 0) return [result(id, "pass", "policy/sidecars.yaml lists no sidecar")];
  const missing: string[] = [];
  for (const [name, s] of sidecars) {
    let r;
    try {
      r = await run.ctx.exec(["docker", "image", "inspect", "--format", "{{.Id}}", s.image]);
    } catch (e) {
      return [result(id, "skip", `cannot ask Docker: ${(e as Error).message}`)];
    }
    if (r.code === 0) continue;
    // Only Docker's own "No such image" means missing; any other error (no daemon) is Docker that can't say.
    if (!/no such image/i.test(r.stderr)) return [result(id, "skip", `cannot ask Docker: docker image inspect exited ${r.code}: ${firstLine(r.stderr) || "no error output"}`)];
    missing.push(`${name}: ${s.image} is not in this Docker`);
  }
  if (missing.length > 0) return [result(id, "fail", `policy/sidecars.yaml: ${missing.join("; ")}: \`mise run up\` pulls ${missing.length === 1 ? "it" : "them"}, and a run's \`--pull never\` refuses a missing image`)];
  return [result(id, "pass", `policy/sidecars.yaml: every sidecar image is in this Docker by digest (${sidecars.map(([n]) => n).join(", ")})`)];
}

const RECIPE = '(docs/policy.md, "Running without decision models")';

/** policy.decision-models */
export async function policyDecisionModels(run: AuditRun): Promise<CheckResult[]> {
  const id = "policy.decision-models";
  const p = loadPolicy(run.ctx.policyDir);
  const off: string[] = [];
  if (p.decisions.mode === "off") off.push("the engine's decisions (gates.decisions.mode: off)");
  else for (const [name, d] of Object.entries(p.decisions.by_name)) if (d.mode === "off") off.push(`the engine's ${name} (gates.decisions.by_name.${name}.mode: off)`);
  if (!p.gates.bash_gate.enabled) off.push("the bash gate (gates.bash_gate.enabled: false)");
  if (!p.gates.result_screen.enabled) off.push("the result screen (gates.result_screen.enabled: false)");
  const notes = p.decisions.mode === "notes";
  // M12: a decision that is on but holds less than enforce does: in shadow it holds nothing; with on_unscreened:
  // note, a subject no classifier answered never holds.
  const softer: string[] = [];
  if (p.decisions.mode !== "off") {
    for (const [name, d] of Object.entries(p.decisions.by_name)) {
      if (d.mode === "shadow") softer.push(`the engine's ${name} is in shadow (gates.decisions.by_name.${name}.mode: shadow): asked and recorded, it holds nothing`);
      else if (d.mode === "enforce" && d.on_unscreened === "note") softer.push(`the engine's ${name} gives a note, not a hold, for a subject no classifier answered (gates.decisions.by_name.${name}.on_unscreened: note)`);
    }
  }
  if (off.length === 0 && !notes && softer.length === 0) {
    return [result(id, "pass", `decision models are on: the engine's decisions (gates.decisions.mode: ${p.decisions.mode}), the bash gate and the result screen`)];
  }
  const parts: string[] = [];
  if (off.length > 0) {
    const list = off.length === 1 ? off[0]! : `${off.slice(0, -1).join(", ")} and ${off.at(-1)}`;
    const them = off.length > 1 || p.decisions.mode === "off" ? "them" : "it";
    parts.push(`decision models are off for ${list}: nothing screens ${them} with a classifier, by the operator's choice`);
  }
  if (notes) parts.push("the engine's decisions give notes only (gates.decisions.mode: notes): none holds a PR");
  parts.push(...softer);
  return [result(id, "pass", `note: ${parts.join("; ")} ${RECIPE}`)];
}
