/**
 * `hapi new-repo`'s argument parsing and its credential: the operator's `gh auth token`, read from gh's stdout,
 * held in memory only, never in argv or a file. No network: GitHub is a fake that refuses the login.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { NEW_REPO_USAGE, newRepoCommand, parseNewRepo } from "../../src/newrepo/cli";
import type { Runner } from "../../src/stack/up";
import { fakeFetch } from "../forge/helpers";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const r of restores.splice(0)) r();
});
function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restores.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}

test("parseNewRepo accepts the flags in any order, each at most once", () => {
  expect(parseNewRepo(["sandbox"])).toEqual({ name: "sandbox", clone: false, collaboratorsOnly: false, dryRun: false });
  expect(parseNewRepo(["--dry-run", "sandbox", "--clone"])).toEqual({ name: "sandbox", clone: true, collaboratorsOnly: false, dryRun: true });
  expect(parseNewRepo(["--collaborators-only", "--clone", "--dry-run", "sandbox"])).toEqual({ name: "sandbox", clone: true, collaboratorsOnly: true, dryRun: true });
  for (const bad of [[], ["--clone"], ["a", "b"], ["a", "--clone", "--clone"], ["a", "--force"], ["-x"], ["--", "a"], ["a", "--dry-run=1"]]) {
    expect([bad, parseNewRepo(bad)]).toEqual([bad, undefined]);
  }
});

test("a usage error exits 2 and prints the usage", async () => {
  const { err } = capture();
  expect(await newRepoCommand(["a", "--nope"], { run: async () => ({ code: 0, stdout: "x" }) })).toBe(2);
  expect(err).toEqual([NEW_REPO_USAGE]);
  expect(NEW_REPO_USAGE).toBe("usage: hapi new-repo <name> [--clone] [--collaborators-only] [--dry-run]");
});

test("newRepoCommand takes the token from gh auth token and refuses an empty one", async () => {
  const { err } = capture();
  const gh = (reply: { code: number; stdout: string }) => {
    const seen: { cmd: string[]; env: Record<string, string> }[] = [];
    const run: Runner = async (cmd, o) => {
      seen.push({ cmd, env: o.env });
      return { ...reply, stderr: "" };
    };
    return { run, seen };
  };
  const lines: string[] = [];
  // A login GitHub refuses: preflight fails on its first request, which shows the token gh printed was the one sent.
  const github = fakeFetch({ "GET https://api.github.com/user": { status: 401, body: { message: "Bad credentials" } } });
  let r = gh({ code: 0, stdout: "fake-gh-token\n" });
  expect(await newRepoCommand(["sandbox"], { run: r.run, fetch: github.fetch, env: { PATH: "/usr/bin" }, out: (l) => void lines.push(l) })).toBe(1);
  expect(r.seen.map((s) => s.cmd)).toEqual([["gh", "auth", "token"]]);
  expect(github.calls[0]!.headers.authorization).toBe("Bearer fake-gh-token");
  expect(lines.some((l) => l === "step 1 (preflight) failed: GET /user: HTTP 401: Bad credentials")).toBe(true);
  for (const l of [...lines, ...err]) expect(l).not.toContain("fake-gh-token");

  for (const reply of [{ code: 0, stdout: "\n" }, { code: 1, stdout: "" }, { code: 4, stdout: "fake-gh-token\n" }]) {
    const calls = fakeFetch({});
    err.length = 0;
    r = gh(reply);
    expect(await newRepoCommand(["sandbox"], { run: r.run, fetch: calls.fetch, env: { PATH: "/usr/bin" }, out: () => {} })).toBe(1);
    expect(err).toEqual(["hapi new-repo: no gh login: run gh auth login, then gh auth refresh -s workflow"]);
    expect(calls.calls).toEqual([]);
  }
});
