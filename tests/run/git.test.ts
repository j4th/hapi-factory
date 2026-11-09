/**
 * hapi's host git (src/run/git.ts): `hardenedGit`, moved unchanged from the launcher, and `authedHostGit`, its
 * authenticated sibling, whose token is only ever in the spawned process's environment, never argv.
 */
import { expect, test } from "bun:test";
import { authedHostGit, hardenedGit } from "../../src/run/git";

test("hardenedGit moves unchanged", () => {
  expect(hardenedGit({ env: { PATH: "/p", HOME: "/h" } }, { env: ["A=1"], git: ["-C", "/x"] })).toEqual({
    cmd: ["env", "-i", "PATH=/p", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "A=1", "git", "-C", "/x", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    env: { PATH: "/p" },
  });
});

test("authedHostGit puts the token in the environment and never in argv", () => {
  const token = "fake-mirror-token";
  const header = btoa(`x-access-token:${token}`);
  const g = authedHostGit({ env: { PATH: "/p" } }, token, { git: ["--git-dir", "/m"] });
  // No `env -i`: the Runner's env is the process's whole environment.
  expect(g.cmd).toEqual(["git", "--git-dir", "/m", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);
  expect(g.env).toEqual({
    PATH: "/p",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${header}`,
  });
  const argv = g.cmd.join(" ");
  expect(argv).not.toContain(token);
  expect(argv).not.toContain(header);
});
