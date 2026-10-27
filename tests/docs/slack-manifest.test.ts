/**
 * docs/runbooks/slack.md makes the Slack app before stage b, from a one-off
 * container of the stack's own pinned Hermes image (ruling R2 in Plan 01 Task
 * 5's fix pass). The command must name exactly the image stack/hermes/Dockerfile
 * builds from, and run it with no network, so the manifest needs no stack,
 * gateway or secret.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const runbook = readFileSync(join(REPO, "docs", "runbooks", "slack.md"), "utf8");
const from = /^FROM (\S+)$/m.exec(readFileSync(join(REPO, "stack", "hermes", "Dockerfile"), "utf8"))![1]!;

test("the manifest command runs the Dockerfile's pinned Hermes image, by tag and digest, with no network, as the image's user", () => {
  const block = /```bash\n\s*(docker run [\s\S]*?)```/.exec(runbook)?.[1];
  expect(block).toBeDefined();
  const words = block!.replaceAll("\\\n", " ").split(/\s+/).filter(Boolean);
  expect(words).toContain(from);
  expect(from).toMatch(/^nousresearch\/hermes-agent:v0\.22\.5@sha256:[0-9a-f]{64}$/);
  for (const flag of ["--rm", "--read-only", "--init"]) expect(words).toContain(flag);
  for (const [flag, value] of [["--network", "none"], ["--user", "10000:10000"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges:true"]] as const) {
    expect([flag, words[words.indexOf(flag) + 1]]).toEqual([flag, value]);
  }
  expect(words.slice(words.indexOf(from) + 1, words.indexOf(from) + 4)).toEqual(["slack", "manifest", "--agent-view"]);
  // No --write: the manifest goes to stdout, and the container's HERMES_HOME stays untouched.
  expect(words).not.toContain("--write");
});

test("the runbook says to make the app before stage b", () => {
  expect(runbook).toContain("**Do this before stage b of the stack**");
});
