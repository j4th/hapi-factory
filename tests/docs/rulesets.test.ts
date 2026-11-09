/**
 * The GitHub rulesets are files, policy/github/rulesets/<name>.json, which the README and the runbook
 * apply with `gh api --input` and `hapi new-repo` posts. Until Task 6's audit reads the live ones, those
 * files are the only copy of them in the repo. These tests hold them to the rules they must keep (spec §5.1, §11.5):
 * - no App is ever a bypass actor;
 * - a ruleset with the required `ci` check has no bypass actors at all;
 * - `main-review` restricts updates, so only its bypass actor (the Admin role, PR-only) can
 *   update `main`. A merge is an update, so neither App can merge, even after an approval.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

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

const DIR = "policy/github/rulesets";
const FILES = readdirSync(DIR).sort();

const all = FILES.map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as Ruleset);
const byName = (name: string): Ruleset => {
  const found = all.filter((r) => r.name === name);
  expect(found.length).toBe(1);
  return found[0]!;
};
const rule = (r: Ruleset, type: string) => r.rules.find((x) => x.type === type);

describe("the documented rulesets", () => {
  test("one file per ruleset, named for it", () => {
    expect(FILES).toEqual(["agent-branch-scope.json", "main-protect.json", "main-review.json", "tags-admin-only.json"]);
    FILES.forEach((f, i) => expect(all[i]!.name).toBe(f.replace(/\.json$/, "")));
  });

  test("the README and the runbook apply each file with --input and paste no JSON of their own", () => {
    const readme = readFileSync("README.md", "utf8");
    const runbook = readFileSync("docs/runbooks/github-apps.md", "utf8");
    for (const [text, names] of [
      [readme, ["main-protect", "main-review"]],
      [runbook, ["agent-branch-scope", "tags-admin-only"]],
    ] as const) {
      for (const n of names) {
        expect(text).toContain(`gh api -X POST "repos/$OWNER/hapi-factory/rulesets" --input policy/github/rulesets/${n}.json`);
      }
    }
    expect(readme).not.toMatch(/--input - <<'EOF'/);
    expect(runbook).not.toMatch(/--input - <<'EOF'/);
  });

  test("main-review requires the last push's approval (design §3.2 step 5)", () => {
    expect(rule(byName("main-review"), "pull_request")!.parameters!.require_last_push_approval).toBe(true);
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
