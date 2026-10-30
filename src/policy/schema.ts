/**
 * JSON Schema validation for policy files, repo overlays, work orders, the
 * MCP lock (policy/mcp.lock.json), the secrets manifest (stack/secrets.yaml),
 * the local secrets config and a sops store's recipients file (docs/secrets.md).
 *
 * Every schema in policy/schemas/ is compiled once into one Ajv instance
 * (draft 2020-12, allErrors, strict mode). `check` returns the problems as
 * `{path, message}` issues, where `path` is a JSON Pointer (RFC 6901) into the
 * checked data: "/budgets/run_usd", or "" for the root. A key containing "/"
 * appears escaped, so ".pi/**" becomes ".pi~1**".
 */
import { readFileSync } from "node:fs";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020";
import { parse } from "yaml";
import defs from "../../policy/schemas/policy-defs.schema.json";
import protectedPaths from "../../policy/schemas/policy-protected-paths.schema.json";
import commands from "../../policy/schemas/policy-commands.schema.json";
import trustedSources from "../../policy/schemas/policy-trusted-sources.schema.json";
import budgets from "../../policy/schemas/policy-budgets.schema.json";
import runs from "../../policy/schemas/policy-runs.schema.json";
import gates from "../../policy/schemas/policy-gates.schema.json";
import approvals from "../../policy/schemas/policy-approvals.schema.json";
import roles from "../../policy/schemas/policy-roles.schema.json";
import roster from "../../policy/schemas/policy-roster.schema.json";
import flags from "../../policy/schemas/policy-flags.schema.json";
import mcp from "../../policy/schemas/policy-mcp.schema.json";
import mcpLock from "../../policy/schemas/mcp-lock.schema.json";
import workOrder from "../../policy/schemas/work-order.schema.json";
import repoOverlay from "../../policy/schemas/repo-overlay.schema.json";
import secretsManifest from "../../policy/schemas/secrets-manifest.schema.json";
import secretsConfig from "../../policy/schemas/secrets-config.schema.json";
import secretsRecipients from "../../policy/schemas/secrets-recipients.schema.json";
import { forgeDomain, forgeHostMessage } from "./hosts";

/** One problem found in a file: where (a JSON Pointer) and what. */
export interface Issue {
  path: string;
  message: string;
}

/** The schemas by name; each name is its file name without `.schema.json`. */
const schemas = {
  "policy-protected-paths": protectedPaths,
  "policy-commands": commands,
  "policy-trusted-sources": trustedSources,
  "policy-budgets": budgets,
  "policy-runs": runs,
  "policy-gates": gates,
  "policy-approvals": approvals,
  "policy-roles": roles,
  "policy-roster": roster,
  "policy-flags": flags,
  "policy-mcp": mcp,
  "mcp-lock": mcpLock,
  "work-order": workOrder,
  "repo-overlay": repoOverlay,
  "secrets-manifest": secretsManifest,
  "secrets-config": secretsConfig,
  "secrets-recipients": secretsRecipients,
};
export type SchemaName = keyof typeof schemas;

const UNKNOWN_KEY = "unknown key";

// verbose: errors carry their (sub)schema and data, so a `not` error can say what it rejected.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, verbose: true });
ajv.addSchema(defs);
const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<SchemaName, ReturnType<typeof ajv.compile>>;

/** Check `data` against a schema. Returns [] when it is valid. */
export function check(name: SchemaName, data: unknown): Issue[] {
  const validate = validators[name];
  if (validate(data)) return [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const e of validate.errors ?? []) {
    const issue = toIssue(e);
    if (!issue) continue;
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
  }
  // Fail closed: invalid data always yields at least one issue, even if every error was filtered out.
  if (issues.length === 0) issues.push({ path: "", message: "does not match the schema" });
  // An unknown key is usually a typo, and so the cause of a "missing required key"
  // next to it: report unknown keys first (the sort is stable otherwise).
  return issues.sort((a, b) => Number(b.message === UNKNOWN_KEY) - Number(a.message === UNKNOWN_KEY));
}

/** Escape one JSON Pointer segment (RFC 6901). */
export function pointerSegment(key: string | number): string {
  return String(key).replaceAll("~", "~0").replaceAll("/", "~1");
}

function toIssue(e: ErrorObject): Issue | undefined {
  const at = (key: string | number) => `${e.instancePath}/${pointerSegment(key)}`;
  const p = e.params as Record<string, unknown>;
  switch (e.keyword) {
    case "if": // "must match then schema": the failing `then` keyword is reported on its own
      return undefined;
    case "additionalProperties":
      return { path: at(String(p.additionalProperty)), message: UNKNOWN_KEY };
    case "required":
      return { path: at(String(p.missingProperty)), message: "missing required key" };
    case "propertyNames":
      return { path: at(String(p.propertyName)), message: "invalid key" };
    case "enum":
      return { path: e.instancePath, message: `must be one of: ${(p.allowedValues as unknown[]).join(", ")}` };
    case "uniqueItems":
      return { path: at(Number(p.i)), message: `duplicate of item ${String(p.j)}` };
    case "false schema": // a key a `properties: {key: false}` forbids where it is
      return { path: e.instancePath, message: "not allowed here" };
    case "not": {
      if (e.propertyName !== undefined) return undefined; // about a key, reported as "invalid key"
      // The schemas' only `not` is nonForgeHost's `not: {$ref: forgeHost}`; say which forge.
      const forge = typeof e.data === "string" ? forgeDomain(e.data) : undefined;
      const message = forge !== undefined ? forgeHostMessage(e.data as string, forge) : (e.message ?? "must not match");
      return { path: e.instancePath, message };
    }
    default:
      // The errors inside `propertyNames` describe the key, already reported above.
      if (e.propertyName !== undefined) return undefined;
      return { path: e.instancePath, message: e.message ?? e.keyword };
  }
}

/** One issue as a line: `path: message`, with "(root)" for the empty path. */
export function formatIssue(i: Issue): string {
  return `${i.path || "(root)"}: ${i.message}`;
}

/**
 * Read and parse a YAML file. Throws an Error whose message says what went wrong
 * ("cannot read ..." or "invalid YAML ..."). Duplicate keys are a parse error.
 */
export function readYaml(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`cannot read file${code ? ` (${code})` : ""}`);
  }
  try {
    return parse(text);
  } catch (e) {
    throw new Error(`invalid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
}
