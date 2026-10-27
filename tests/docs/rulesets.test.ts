/**
 * The GitHub rulesets are a manual step (README, "Plan 01 Task 1"; docs/runbooks/github-apps.md),
 * so the JSON the operator pastes is the only copy of them in the repo until Task 6's audit reads the
 * live ones. These tests hold that JSON to the rules it must keep (spec §5.1, §11.5):
 * - no App is ever a bypass actor;
 * - a ruleset with the required `ci` check has no bypass actors at all;
 * - `main-review` restricts updates, so only its bypass actor (the Admin role, PR-only) can
 *   update `main`. A merge is an update, so neither App can merge, even after an approval.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}
interface Ruleset {
  name: string;
  target: string;
  bypass_actors: { actor_id: number; actor_type: string; bypass_mode: string }[];
  rules: Rule[];
}

const DOCS = ["README.md", "docs/runbooks/github-apps.md"];

/** Every `gh api ... /rulesets --input - <<'EOF' ... EOF` body in a doc. */
function rulesetsIn(file: string): Ruleset[] {
  const text = readFileSync(file, "utf8");
  const bodies = [...text.matchAll(/gh api -X (?:POST|PUT) "?repos\/\S+\/rulesets\S*"? --input - <<'EOF'\n([\s\S]*?)\n\s*EOF/g)];
  return bodies.map((m) => JSON.parse(m[1]!) as Ruleset);
}

const all = DOCS.flatMap(rulesetsIn);
const byName = (name: string): Ruleset => {
  const found = all.filter((r) => r.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
};
const rule = (r: Ruleset, type: string) => r.rules.find((x) => x.type === type);

describe("the documented rulesets", () => {
  test("are the four rulesets the runbook names, each defined once", () => {
    expect(all.map((r) => r.name).sort()).toEqual(["agent-branch-scope", "main-protect", "main-review", "tags-admin-only"]);
  });

  test("never make an App (Integration) a bypass actor", () => {
    for (const r of all) expect(r.bypass_actors.filter((a) => a.actor_type === "Integration")).toEqual([]);
  });

  test("put the required ci check only in rulesets with no bypass actors", () => {
    const withCi = all.filter((r) => rule(r, "required_status_checks"));
    expect(withCi.map((r) => r.name)).toEqual(["main-protect"]);
    for (const r of withCi) expect(r.bypass_actors).toEqual([]);
    expect(rule(byName("main-protect"), "required_status_checks")!.parameters!.required_status_checks).toEqual([
      { context: "ci", integration_id: 15368 },
    ]);
  });

  test("main-review restricts updates, so only you (Admin, PR-only) can merge into main and no App can", () => {
    const review = byName("main-review");
    expect(rule(review, "update")).toBeDefined();
    expect(review.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    const pr = rule(review, "pull_request")!.parameters!;
    expect(pr.required_approving_review_count).toBe(1);
    expect(pr.require_code_owner_review).toBe(true); // second layer: an App's approval never counts
  });

  test("main-protect has no update restriction: with no bypass actors it would stop every merge", () => {
    expect(rule(byName("main-protect"), "update")).toBeUndefined();
    for (const r of all.filter((x) => x.bypass_actors.length === 0)) expect(rule(r, "update")).toBeUndefined();
  });
});

describe("the GitHub Apps runbook", () => {
  const text = readFileSync("docs/runbooks/github-apps.md", "utf8");

  test("names no GitHub login: API paths use $OWNER, CODEOWNERS a placeholder", () => {
    const paths = [...text.matchAll(/repos\/([^/\s"]+)\/hapi-factory/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((owner) => owner !== "$OWNER")).toEqual([]);
    expect(text).toContain("* @<your-github-login>");
    expect(text).not.toMatch(/^\s*\* @(?!<your-github-login>)\S+/m);
  });

  test("tells you to check that an App's merge call is refused", () => {
    expect(text).toMatch(/gh api -X PUT "repos\/\$OWNER\/hapi-factory\/pulls\/\$pr\/merge"/);
  });
});
