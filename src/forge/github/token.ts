/**
 * Per-purpose installation tokens for the run engine (H-091's engine half). `forgeToken` mints in
 * memory: one repository, only the permissions its purpose needs, never a token file. It refuses a
 * repository `policy/repos.yaml` does not register, and an installation it does not record.
 */
import { join } from "node:path";
import { loadPolicy } from "../../policy/load";
import type { RepoRegistry } from "../../policy/types";
import { REPO_ROOT } from "../../generate/header";
import type { Env } from "../../stack/up";
import { appCredentials, findInstallationId, mintInstallationToken, parseOwnerRepo, revoke, type Permissions } from "./app-token";

/** What a token is for: the mirror's fetch, the harvester's push, PR writes and reads, CodeRabbit's check run. */
export type TokenPurpose = "mirror" | "push" | "pr" | "checks";

/**
 * The permissions each purpose asks for. CodeRabbit's round needs two: its reviews and review comments
 * through a "pr" forge, its check run through a "checks" forge.
 */
export const PURPOSE_PERMISSIONS: Record<TokenPurpose, Permissions> = {
  mirror: { contents: "read" },
  push: { contents: "write" },
  pr: { pull_requests: "write" },
  checks: { checks: "read" },
};

export async function forgeToken(
  env: Env,
  repo: string,
  purpose: TokenPurpose,
  o: { registry?: RepoRegistry; fetch?: typeof fetch; now?: () => number } = {},
): Promise<{ token: string; revoke(): Promise<void> }> {
  const target = parseOwnerRepo(repo);
  if (target === undefined) throw new Error(`not an owner/name repository: ${JSON.stringify(repo)}`);
  const registry = o.registry ?? loadPolicy(join(REPO_ROOT, "policy")).repos;
  if (!Object.hasOwn(registry.repos, repo)) {
    throw new Error(`${repo} is not registered in policy/repos.yaml: the factory acts only on registered repos`);
  }
  const f = o.fetch ?? fetch;
  const net = { ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.now ? { now: o.now } : {}) };
  const creds = await appCredentials("factory", env);
  const installationId = await findInstallationId({ ...creds, owner: target.owner, repo: target.name, ...net });
  if (installationId !== registry.installations.factory) {
    throw new Error(
      `the hapi-factory App's installation on ${repo} is ${installationId}, but policy/repos.yaml records ${registry.installations.factory}: fix one of them before the factory acts on the repo`,
    );
  }
  const { token, expiresAt } = await mintInstallationToken({ ...creds, installationId, repositories: [target.name], permissions: PURPOSE_PERMISSIONS[purpose], ...net });
  let done = false;
  return {
    token,
    async revoke() {
      if (done) return;
      done = true;
      if (!(await revoke(f, token))) console.error(`hapi: could not revoke a ${purpose} token for ${repo}; it expires at ${expiresAt}`);
    },
  };
}
