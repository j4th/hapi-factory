/**
 * The `hapi` CLI: one entry point for policy, secrets, forge tokens and audit.
 *
 * Run it as `bun run src/cli.ts <command> [args...]`, or `mise run hapi -- <command> [args...]`.
 *
 * Commands are registered by name with `register(name, handler)`. A name may be
 * several words ("policy build"); `main` picks the longest registered name that
 * matches the leading words of argv and passes the rest to the handler.
 *
 * Exit codes (as in README.md): 0 success, 1 the command failed, 2 a usage error:
 * an unknown command, no command at all, or the wrong arguments for a command.
 */
import { auditCommand } from "./audit/index";
import { tokenMint } from "./forge/github/app-token";
import { policyBuild } from "./generate/index";
import { mcpPin, mcpVerify } from "./mcp/lock";
import {
  secretsAddMachine,
  secretsCheck,
  secretsDrill,
  secretsEdit,
  secretsInit,
  secretsJoin,
  secretsNewRecovery,
  secretsRecover,
  secretsResolve,
  secretsRevoke,
} from "./secrets/cli";
import { CancelledError } from "./secrets/recovery";
import { stackDown, stackUp } from "./stack/up";
import { HAPI_VERSION } from "./version";
import { workorderValidate } from "./workorder/validate";

/** A command handler. It gets the args after the command name and returns the exit code. */
export type Handler = (args: string[]) => number | Promise<number>;

interface Command {
  handler: Handler;
  summary: string;
}

const commands = new Map<string, Command>();

/**
 * Register a command. `name` is one or more space-separated words, e.g. "policy build";
 * no word may start with "-". `summary` is the one-line description shown by `hapi --help`.
 */
export function register(name: string, handler: Handler, summary = ""): void {
  const words = name.trim().split(/\s+/);
  if (words[0] === "" || words.some((w) => w.startsWith("-"))) {
    throw new Error(`invalid command name: '${name}'`);
  }
  const key = words.join(" ");
  if (commands.has(key)) throw new Error(`command already registered: ${key}`);
  commands.set(key, { handler, summary });
}

function usage(): string {
  const names = [...commands.keys()].sort();
  const width = Math.max(0, ...names.map((n) => n.length));
  const list = names.length
    ? names.map((n) => `  ${n.padEnd(width)}  ${commands.get(n)?.summary ?? ""}`.trimEnd()).join("\n")
    : "  (none yet)";
  return [
    `hapi ${HAPI_VERSION}: the hapi-factory CLI`,
    "",
    "Usage: hapi <command> [args...]",
    "       hapi --version | --help",
    "",
    "Commands:",
    list,
  ].join("\n");
}

/** The leading words of argv, up to the first flag: the candidate command name. */
function leadingWords(argv: string[]): string[] {
  const end = argv.findIndex((a) => a.startsWith("-"));
  return end === -1 ? argv : argv.slice(0, end);
}

/** Find the longest registered command matching the leading words of argv. */
function resolve(argv: string[]): { name: string; command: Command; rest: string[] } | undefined {
  for (let n = leadingWords(argv).length; n > 0; n--) {
    const name = argv.slice(0, n).join(" ");
    const command = commands.get(name);
    if (command) return { name, command, rest: argv.slice(n) };
  }
  return undefined;
}

/** Run the CLI with `argv` (the args after the program name). Resolves to the exit code. */
export async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  if (first === undefined) {
    console.error(usage());
    return 2;
  }
  if (first === "--version") {
    console.log(HAPI_VERSION);
    return 0;
  }
  if (first === "--help" || first === "-h") {
    console.log(usage());
    return 0;
  }

  const found = resolve(argv);
  if (!found) {
    const words = leadingWords(argv);
    const asked = words.length ? words.join(" ") : first;
    console.error(`hapi: unknown command '${asked}'. Run 'hapi --help' to list commands.`);
    return 2;
  }
  try {
    return await found.command.handler(found.rest);
  } catch (e) {
    console.error(`hapi ${found.name}: ${e instanceof Error ? e.message : String(e)}`);
    // A cancelled prompt exits 130, as a shell gives Ctrl-C.
    return e instanceof CancelledError ? e.exitCode : 1;
  }
}

// ---------------------------------------------------------------------------
// Commands. Each later task registers its command here, importing the handler
// from its own module, as below.
// ---------------------------------------------------------------------------

register("workorder validate", workorderValidate, "Validate a work order (order.yaml) against its schema");
register("policy build", policyBuild, "Compile policy/ into Hermes, Archon, Pi, egress and MCP configs under build/");
register("mcp verify", mcpVerify, "Check every MCP server's live tool surface against policy/mcp.lock.json");
register("mcp pin", mcpPin, "Record one MCP server's live tool surface in policy/mcp.lock.json");
register("secrets init", secretsInit, "Set up the default sops + age store: this machine's key, a recovery key wrapped with 10 words you keep, the encrypted store (every name empty) and the config");
register("secrets join", secretsJoin, "On a new machine or user: make its own age key and config for a copy of the store, and print the add-machine command");
register("secrets add-machine", secretsAddMachine, "Add a machine's public key to the store (sops rotate --add-age) and to its recipients file");
register("secrets recover", secretsRecover, "With the store, recovery.age, the recipients file and your 10 words: give this machine its own key to the store");
register("secrets drill", secretsDrill, "Prove your 10 words and recovery.age open the store, in an isolated temp dir; prints a count, never a value");
register("secrets revoke", secretsRevoke, "Remove a recipient from the store (sops rotate --rm-age) and its recipients file");
register("secrets new-recovery", secretsNewRecovery, "Replace the recovery key and its 10 words (lost or exposed words); needs a working machine key");
register("secrets edit", secretsEdit, "Edit the sops store with `sops edit` (sops provider only)");
register("secrets check", secretsCheck, "List every secret in stack/secrets.yaml as found, missing or empty in the configured store (never a value), and the store's recipients");
register("secrets resolve", secretsResolve, "Resolve stack/secrets.yaml from the configured provider into $XDG_RUNTIME_DIR/hapi/env/<zone>.env (--dry-run: check)");
register("stack up", stackUp, "Build policy, resolve secrets and start the stack as the hapi user (stack/compose.yaml); see docs/runbooks/stack.md");
register("stack down", stackDown, "Stop the stack and remove its containers and networks, keeping its volumes (kill switch 3)");
register("token mint", tokenMint, "Mint a 1-hour GitHub App token for one repo into a 0600 file under $XDG_RUNTIME_DIR/hapi/tokens/");
register("audit", (args) => auditCommand(args), "Check the deployed config, pins, running stack, secrets setup and each --repo's GitHub settings against policy (docs/audit.md)");

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
