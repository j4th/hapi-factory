/**
 * `hapi new-repo <name> [--clone] [--collaborators-only] [--dry-run]` (`mise run new-repo -- <name> ...`): the
 * command around `newRepo` (./steps.ts). The credential is the operator's own `gh` login: `gh auth token`'s stdout,
 * held in memory only, never in argv, a file or the environment of anything but the first push
 * (docs/runbooks/new-repo.md).
 */
import { runAudit } from "../audit/index";
import { REPO_ROOT } from "../generate/header";
import { openTerminal } from "../secrets/recovery";
import { definedEnv, runCommand } from "../stack/up";
import { type NewRepoDeps, type NewRepoOptions, newRepo } from "./steps";

export const NEW_REPO_USAGE = "usage: hapi new-repo <name> [--clone] [--collaborators-only] [--dry-run]";
const FLAGS = ["--clone", "--collaborators-only", "--dry-run"] as const;

/** The options, or undefined on a usage error: no name or a second one, an unknown flag, a flag given twice, a name starting with `-`. */
export function parseNewRepo(args: string[]): NewRepoOptions | undefined {
  let name: string | undefined;
  const seen = new Set<string>();
  for (const a of args) {
    if (a.startsWith("-")) {
      if (!(FLAGS as readonly string[]).includes(a) || seen.has(a)) return undefined;
      seen.add(a);
    } else if (name === undefined) name = a;
    else return undefined;
  }
  if (name === undefined) return undefined;
  return { name, clone: seen.has("--clone"), collaboratorsOnly: seen.has("--collaborators-only"), dryRun: seen.has("--dry-run") };
}

/** A web step: show the prompt on the terminal and wait for Enter. No terminal (a pipe, CI) is an error: the step fails rather than going on unconfirmed. */
async function confirmOnTerminal(prompt: string): Promise<void> {
  const tty = openTerminal();
  if (tty === undefined) throw new Error(`no terminal to wait on for a web step: ${prompt}`);
  await tty.read(`${prompt} `);
}

/** `hapi new-repo`: see the module comment. `deps` replaces parts of the real world (tests pass fakes). */
export async function newRepoCommand(args: string[], deps: Partial<NewRepoDeps> = {}): Promise<number> {
  const o = parseNewRepo(args);
  if (o === undefined) {
    console.error(NEW_REPO_USAGE);
    return 2;
  }
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCommand;
  let token = "";
  try {
    const r = await run(["gh", "auth", "token"], { env: definedEnv(env), inherit: false });
    if (r.code === 0) token = r.stdout.trim();
  } catch {
    token = "";
  }
  if (token === "" || /\s/.test(token)) {
    console.error("hapi new-repo: no gh login: run gh auth login, then gh auth refresh -s workflow");
    return 1;
  }
  const d: NewRepoDeps = {
    fetch: deps.fetch ?? fetch,
    run,
    env,
    root: deps.root ?? REPO_ROOT,
    now: deps.now ?? (() => new Date()),
    out: deps.out ?? ((line) => console.log(line)),
    confirm: deps.confirm ?? confirmOnTerminal,
    audit: deps.audit ?? runAudit,
  };
  return newRepo(d, token, o);
}
