/**
 * hapi's host git: one place for the flags every git command hapi runs on the host starts with.
 *
 * - `hardenedGit` is the launcher's (and the engine's) unauthenticated git: an empty environment but PATH,
 *   through `env -i`, so nothing the caller's environment holds configures it.
 * - `authedHostGit` is its authenticated sibling, for the one git call that talks to GitHub with a token (the
 *   engine's mirror fetch, new-repo's first push). The token reaches git only through the spawned process's
 *   environment, as config (`authedGit`, design §3.4), never argv, a URL, a credential helper or a file. There is
 *   no `env -i` here, because `env -i` would need the token on its own argv: the Runner's `env` is the process's
 *   whole environment instead (`Bun.spawn` replaces it), so nothing else of the caller's reaches git either.
 */
import { authedGit } from "../forge/github/git";
import type { RunDeps } from "./spec";

/**
 * Host git with an empty environment but PATH (and `o.env`), no system or global config, no hooks and no
 * fsmonitor: the start of every git command the launcher runs. `o.git` goes before the `-c` options.
 */
export function hardenedGit(d: Pick<RunDeps, "env">, o: { env?: string[]; git?: string[] } = {}): { cmd: string[]; env: Record<string, string> } {
  const PATH = d.env.PATH ?? "/usr/bin:/bin";
  return {
    cmd: ["env", "-i", `PATH=${PATH}`, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", ...(o.env ?? []), "git", ...(o.git ?? []), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    env: { PATH },
  };
}

/**
 * Host git that carries `token` for https://github.com/: no system or global config, no hooks, no fsmonitor, no
 * prompt and https only, with the token in `env` alone (`authedGit`, spread last). `o.git` goes before the `-c`
 * options. Run it with exactly `env`, never merged into the caller's environment.
 */
export function authedHostGit(d: Pick<RunDeps, "env">, token: string, o: { git?: string[] } = {}): { cmd: string[]; env: Record<string, string> } {
  return {
    cmd: ["git", ...(o.git ?? []), "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"],
    env: {
      PATH: d.env.PATH ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "https",
      ...authedGit(token),
    },
  };
}
