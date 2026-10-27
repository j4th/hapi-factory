/**
 * The Bitwarden Secrets Manager provider (spec §11.5): optional.
 *
 * The local config binds each logical name to a bws secret id
 * (`bws: { ids: { <logical-name>: <uuid> } }`); the ids stay outside the
 * public repo. `fetch` reads each id once with
 * `bws secret get <id> --output json --color no`, into memory.
 *
 * bws reads its access token from BWS_ACCESS_TOKEN in the caller's
 * environment. hapi never passes it on a command line and never writes it.
 * bws keeps its own config at ~/.config/bws/config, and can keep a login
 * state file per access token under its state directory (`bws config
 * state-dir`; `bws config state-opt-out true` turns it off): see
 * docs/secrets.md.
 *
 * Errors name the logical name and why, never a value: nothing passes through
 * text that might hold one (bws's stdout, JSON.parse's own message), and the
 * access token is masked in bws's stderr.
 */
import { type SecretProvider, SecretError } from "../provider";
import { scrubToolError } from "./sops";

/** Runs `bws` with these args and resolves to its stdout; rejects if it fails. */
export type BwsRunner = (args: string[]) => Promise<string>;

/** A placeholder id: 00000000-0000-0000-0000-xxxxxxxxxxxx (as in docs). A real bws id is a random UUID. */
const PLACEHOLDER = /^00000000-0000-0000-0000-[0-9a-f]{12}$/i;
export const isPlaceholderId = (id: string): boolean => PLACEHOLDER.test(id);

/** What hapi passes to bws as an id: no leading "-" (it would read as a flag), no spaces. */
const BWS_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** One line of at most 300 characters, without ANSI colour codes or the bws access token. */
function oneLine(e: unknown): string {
  let s = (e instanceof Error ? e.message : String(e)).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const token = process.env.BWS_ACCESS_TOKEN;
  if (token) s = s.replaceAll(token, "[BWS_ACCESS_TOKEN]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 300 ? `${s.slice(0, 300)}...` : s;
}

/**
 * The default `BwsRunner`: spawns the `bws` on PATH with the caller's
 * environment, which carries BWS_ACCESS_TOKEN. stdout is returned and never
 * shown; a failure reports the exit status and bws's stderr. bws is not in
 * mise.toml: a bws user adds it in their own mise.local.toml (docs/secrets.md).
 */
export const runBws: BwsRunner = async (args) => {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["bws", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch {
    throw new Error("cannot run bws: is it on PATH? (add it in mise.local.toml, docs/secrets.md)");
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw bwsFailure(code, stderr);
  return stdout;
};

/**
 * The error for a bws run that failed: its exit status and the start of its
 * stderr, scrubbed as sops's is (`scrubToolError`: the first line up to its
 * first colon, plus any path; what follows a colon could hold a value), with
 * the access token masked. bws's errors end in a source location and backtrace
 * hints, which go too. Its full message is one manual bws run away.
 */
export function bwsFailure(code: number, stderr: string): Error {
  const why = oneLine(scrubToolError(stderr)).replace(/ Location: .*$/, "");
  return new Error(`bws exited with status ${code}${why ? `: ${why}` : ""} (run the same bws command yourself for its full message)`);
}

/** Read one secret's value with `bws secret get`. "" is returned as is: resolve calls it empty, check reports it. */
async function fetchValue(name: string, id: string, bws: BwsRunner): Promise<string> {
  let stdout: string;
  try {
    stdout = await bws(["secret", "get", id, "--output", "json", "--color", "no"]);
  } catch (e) {
    throw new SecretError(`${name}: bws secret get failed: ${oneLine(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON.parse's message: it can quote the text, which may hold the value.
    throw new SecretError(`${name}: bws printed something that is not JSON (not shown)`);
  }
  const value = typeof parsed === "object" && parsed !== null ? (parsed as { value?: unknown }).value : undefined;
  if (typeof value !== "string") throw new SecretError(`${name}: bws returned no string value`);
  return value;
}

/** The bws provider over the config's `bws.ids`. */
export function bwsProvider(o: { ids: Record<string, string>; run?: BwsRunner }): SecretProvider {
  const run = o.run ?? runBws;
  return {
    name: "bws",
    downgrade: false,
    async list() {
      return Object.keys(o.ids);
    },
    async fetch(names) {
      const missing = names.filter((n) => !Object.hasOwn(o.ids, n));
      if (missing.length > 0) throw new SecretError(`bws.ids in your secrets config has no id for ${missing.join(", ")}`, missing);
      for (const name of names) {
        const id = o.ids[name]!;
        if (typeof id !== "string" || !BWS_ID.test(id)) throw new SecretError(`${name}: not a bws secret id (not shown, in case it is a value)`);
        if (isPlaceholderId(id)) throw new SecretError(`${name}: still a placeholder bws id; put the secret's real id under bws.ids in your secrets config (docs/secrets.md)`);
      }
      const byId = new Map<string, string>();
      const out = new Map<string, string>();
      for (const name of names) {
        const id = o.ids[name]!;
        let value = byId.get(id);
        if (value === undefined) {
          value = await fetchValue(name, id, run);
          byId.set(id, value);
        }
        out.set(name, value);
      }
      return out;
    },
  };
}
