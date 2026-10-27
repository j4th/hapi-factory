/**
 * The secrets checks (spec §11.5), on the config at $HAPI_SECRETS_CONFIG or
 * `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml` of the user running the
 * audit (hapi's, in stage b). Neither prints a value.
 *
 * - secrets.provider (H-027): which provider the config selects and the files
 *   it uses (`describeSecretsConfig`). The env-file provider is an explicit,
 *   audited downgrade (plaintext on disk): a fail, or a skip with `--dev`.
 *   For sops, the store's recipients file and recovery.age beside it, as
 *   `hapi secrets check` reads them (`recipientReport`): drift, a
 *   post-quantum/classic mix, a recovery.age that doesn't match its recorded
 *   SHA-256, no recovery recipient or no recovery.age all fail.
 * - secrets.check (H-028): what `hapi secrets resolve` would find, through the
 *   provider contract (`checkSecrets`: names listed without values, then only
 *   those fetched): every manifest entry found, none missing, empty or invalid
 *   (a value resolve would refuse), and every MCP secret reference mapped. A
 *   provider that fails is a fail: the check never passes where resolve
 *   would fail.
 * No config at all is a skip for both.
 */
import { join } from "node:path";
import { loadPolicy } from "../../policy/load";
import { providerFor } from "../../secrets/cli";
import { recipientReport } from "../../secrets/lifecycle";
import { loadManifest, MANIFEST_FILE, mcpSecretGaps } from "../../secrets/manifest";
import { checkSecrets, configPath, describeSecretsConfig, entryLabel, loadSecretsConfig, SecretError, type SecretsConfig } from "../../secrets/provider";
import { recipientsPath, recoveryPath } from "../../secrets/recipients";
import { type AuditRun, type CheckResult, result } from "../types";

/** The secrets config, or a skip when there is none (memoized). Any other problem throws, so both checks fail. */
function secretsConfig(run: AuditRun): Promise<SecretsConfig | { skip: string }> {
  return run.once("secrets-config", async () => {
    const path = configPath({ env: run.ctx.env, cwd: run.ctx.root });
    try {
      return loadSecretsConfig(path, run.ctx.env);
    } catch (e) {
      if (e instanceof SecretError) return { skip: `${e.message} (as the user the stack runs as: run the audit as hapi)` };
      throw e;
    }
  });
}

/** secrets.provider */
export async function secretsProvider(run: AuditRun): Promise<CheckResult[]> {
  const id = "secrets.provider";
  const cfg = await secretsConfig(run);
  if ("skip" in cfg) return [result(id, "skip", cfg.skip)];
  const d = describeSecretsConfig(cfg);
  const files = cfg.provider === "sops" ? [...d.files, recipientsPath(cfg.sops.file), recoveryPath(cfg.sops.file)] : d.files;
  const problems: string[] = [];
  if (cfg.provider === "sops") {
    const report = await recipientReport(cfg.sops.file);
    problems.push(...report.errors, ...report.warnings);
  }
  const uses = `${d.provider}: ${files.join(", ")}`;
  if (problems.length > 0) return [result(id, "fail", `${uses}: ${problems.join("; ")}`)];
  if (d.downgrade) {
    const why = `the ${d.provider} provider is a downgrade: every secret sits in plaintext on disk (${d.files[1]}). sops + age is the default: \`mise run secrets:init\`, copy each value across with \`mise run secrets:edit\`, then shred the env file (docs/secrets.md)`;
    return [d.downgrade && run.ctx.dev ? result(id, "skip", `--dev: reported, not failed: ${why}`) : result(id, "fail", why)];
  }
  const extra = cfg.provider === "sops" ? "; the recipients file matches the store, and recovery.age matches its recorded SHA-256" : "";
  return [result(id, "pass", `${uses}${extra}`)];
}

/** secrets.check */
export async function secretsCheck(run: AuditRun): Promise<CheckResult[]> {
  const id = "secrets.check";
  const cfg = await secretsConfig(run);
  if ("skip" in cfg) return [result(id, "skip", cfg.skip)];
  const { ctx } = run;
  const manifest = loadManifest(join(ctx.root, MANIFEST_FILE));
  const gaps = mcpSecretGaps(loadPolicy(ctx.policyDir), manifest);
  const provider = providerFor(cfg, { ...ctx.secrets, env: ctx.env });
  const { entries, unknown } = await checkSecrets(manifest, provider);
  const problems = [
    ...entries.filter((e) => e.status !== "found").map((e) => `${entryLabel(e)} is ${e.status}${e.reason === undefined ? "" : ` (${e.reason})`}`),
    ...gaps.map((g) => `${g.zone}/${g.env} is not in ${MANIFEST_FILE}, but ${g.server} needs secret:${g.name}`),
  ];
  const extra = unknown.length > 0 ? `; the store also holds ${unknown.length} name${unknown.length === 1 ? "" : "s"} ${MANIFEST_FILE} doesn't list` : "";
  if (problems.length > 0) {
    return [result(id, "fail", `${problems.join("; ")}${extra}. \`hapi secrets resolve\` would refuse this, so the stack would not start: fix them in the ${provider.name} store (\`hapi secrets check\` lists them)`)];
  }
  return [result(id, "pass", `${entries.length} secrets found in the ${provider.name} store, none missing, empty or invalid, and every MCP secret reference mapped (values never read out)${extra}`)];
}
