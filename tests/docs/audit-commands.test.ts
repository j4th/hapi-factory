/**
 * The strict audit commands the docs tell the operator to run. A strict run
 * without `--github-token-file` always fails: GitHub shows a ruleset's
 * `bypass_actors` only to a token with write access to it, which the Apps
 * never get, so the bypass parts of github.rulesets and github.app-perms
 * skip, and `--strict` makes each skip a fail (docs/audit.md). So every
 * `mise run audit -- --strict ...` the docs show passes the operator's token
 * file. The plans and specs under docs/superpowers/ are history, not
 * instructions, and aren't held to it.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

function markdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return relative(REPO, path) === join("docs", "superpowers") ? [] : markdown(path);
    return e.name.endsWith(".md") ? [path] : [];
  });
}

test("every strict audit command in the docs passes --github-token-file", () => {
  const commands: string[] = [];
  for (const file of [join(REPO, "README.md"), ...markdown(join(REPO, "docs"))]) {
    for (const m of readFileSync(file, "utf8").matchAll(/mise run audit -- [^`\n]*--strict[^`\n]*/g)) commands.push(`${relative(REPO, file)}: ${m[0]}`);
  }
  expect(commands.length).toBeGreaterThan(0);
  for (const c of commands) expect([c, c.includes("--github-token-file ")]).toEqual([c, true]);
});
