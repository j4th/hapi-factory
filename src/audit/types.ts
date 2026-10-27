/**
 * The audit's types: a check's result, what every check is given (the
 * context), and the run each check shares (`AuditRun`), which computes the
 * expensive inputs (a fresh build, the stack's containers, a repo's GitHub
 * data) once per audit.
 *
 * Every command goes through `ctx.exec` and every HTTP request through
 * `ctx.fetch`, so the unit tests run the whole audit with fakes: no Docker,
 * network or secret.
 */
import type { SecretsDeps } from "../secrets/cli";

export type Env = Record<string, string | undefined>;

/**
 * pass: the check verified what it says. fail: it found a problem, or hit an
 * error (an audit fails closed). skip: it could not be made, and `detail`
 * says why (no stack running, no --repo, no credentials). A skip is never a
 * pass: `--strict` turns it into a fail.
 */
export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: string;
  status: CheckStatus;
  /** One line: what was checked, or what is wrong and how to fix it. Names keys, files and containers, never a secret. */
  detail: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command (argv, no shell) and captures its output. It never throws on a non-zero exit; it throws when the program can't be started. */
export type Exec = (cmd: string[], o?: { timeoutMs?: number }) => Promise<ExecResult>;

/** A GitHub repository, `owner/name`. */
export interface RepoRef {
  owner: string;
  name: string;
}

export interface AuditContext {
  /** The checkout the audit reads: mise.toml, stack/, and the default policy dir. */
  root: string;
  /** The policy a fresh build is made from (`--policy`, default `<root>/policy`). */
  policyDir: string;
  /** The deployed build/ to compare (`--build-dir`); default: the one `hapi stack up` writes (`deployedBuild`). */
  buildDir?: string;
  /** The repos the github.* and repo.* checks read (`--repo`). */
  repos: RepoRef[];
  /** `--strict`: every skip is a fail. */
  strict: boolean;
  /** `--dev`: the dev-only downgrades (the dev bypass, the env-file provider) are a skip, not a fail. */
  dev: boolean;
  /** `--github-token-file`: an operator token for the GitHub reads (never printed). */
  githubTokenFile?: string;
  env: Env;
  /** Who runs the audit (the process's user, not $USER). */
  user: string;
  exec: Exec;
  fetch: typeof fetch;
  /** Milliseconds, like Date.now. */
  now: () => number;
  /** Passed to the secret provider (tests inject fakes for sops and the checkout boundary). */
  secrets?: SecretsDeps;
}

/** One audit: its context, and what its checks share, each computed at most once. */
export interface AuditRun {
  ctx: AuditContext;
  /** The value of `key`, computing it with `make` the first time it is asked for. */
  once<T>(key: string, make: () => Promise<T>): Promise<T>;
  /** Temp dirs to remove when the audit ends. */
  temps: string[];
  /** What to undo when the audit ends (revoking the audit's own GitHub token). */
  cleanups: (() => Promise<void>)[];
}

export type Check = (run: AuditRun) => Promise<CheckResult[]>;

/** A result for `id`. */
export const result = (id: string, status: CheckStatus, detail: string): CheckResult => ({ id, status, detail });

/** A new run for `ctx`. */
export function newRun(ctx: AuditContext): AuditRun {
  const cache = new Map<string, Promise<unknown>>();
  return {
    ctx,
    temps: [],
    cleanups: [],
    once<T>(key: string, make: () => Promise<T>): Promise<T> {
      if (!cache.has(key)) cache.set(key, make());
      return cache.get(key) as Promise<T>;
    },
  };
}
