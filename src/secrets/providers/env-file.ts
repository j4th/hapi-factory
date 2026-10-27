/**
 * The env-file provider (spec §11.5): an explicit, audited downgrade.
 *
 * The store is one plaintext file of `NAME='value'` lines (the format
 * `parseEnvFile` reads), NAME being `secretEnvName(logical name)`: so
 * hapi-hermes-anthropic-api-key is HAPI_HERMES_ANTHROPIC_API_KEY. It must be
 * mode 0600, ours, and outside the hapi-factory checkout, private/ included:
 * plaintext there could be committed, or pushed to the private remote.
 *
 * `downgrade` is true: `hapi secrets resolve` and `check` warn on every run,
 * and `hapi audit` (Plan 01 Task 6) reports it. Use sops + age instead.
 */
import { readFile } from "node:fs/promises";
import { secretEnvName } from "../../policy/mcp";
import { defaultRepoRoot, parseEnvFile, privateFileProblem } from "../files";
import { LOGICAL_NAME } from "../manifest";
import { SecretError, type SecretProvider } from "../provider";

/** The logical name an env-form name stands for, if there is one: lower-case, "_" as "-". */
function logicalName(envName: string): string | undefined {
  const name = envName.toLowerCase().replaceAll("_", "-");
  return LOGICAL_NAME.test(name) && secretEnvName(name) === envName ? name : undefined;
}

/** The env-file provider over one plaintext file. */
export function envFileProvider(o: { file: string; repoRoot?: () => Promise<string>; uid?: number }): SecretProvider {
  const read = async (): Promise<Record<string, string>> => {
    const problem = await privateFileProblem(o.file, {
      repoRoot: await (o.repoRoot ?? defaultRepoRoot)(),
      mode: "0600",
      ...(o.uid === undefined ? {} : { uid: o.uid }),
    });
    if (problem !== undefined) throw new SecretError(`env file ${o.file} ${problem}`);
    let text: string;
    try {
      text = await readFile(o.file, "utf8");
    } catch (e) {
      throw new SecretError(`cannot read ${o.file}${(e as NodeJS.ErrnoException).code ? ` (${(e as NodeJS.ErrnoException).code})` : ""}`);
    }
    try {
      return parseEnvFile(text);
    } catch (e) {
      // parseEnvFile names the line, never the text.
      throw new SecretError(`${o.file}: ${(e as Error).message}`);
    }
  };
  return {
    name: "env-file",
    downgrade: true,
    async list() {
      return Object.keys(await read()).map((k) => logicalName(k) ?? k);
    },
    async fetch(names) {
      const values = await read();
      const missing = names.filter((n) => !Object.hasOwn(values, secretEnvName(n)));
      if (missing.length > 0) throw new SecretError(`${o.file} has no ${missing.map((n) => `${secretEnvName(n)} (${n})`).join(", ")}`, missing);
      return new Map(names.map((n) => [n, values[secretEnvName(n)]!]));
    },
  };
}
