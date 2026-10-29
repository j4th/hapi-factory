/**
 * Each tool's own reading of the deployed config (spec §9.2; Review Focus 5:
 * an upstream that silently ignores a generated key, after an upgrade or a
 * rename). Both checks run the image the stack runs, with no network, no
 * secret, a read-only root and only the deployed config mounted read-only,
 * and never pull: the image is the one `mise run up` built (or else the
 * Dockerfile's pinned FROM, if it is here). Neither touches the running
 * stack.
 *
 * - tools.archon-validate: `archon validate workflows --json`, which fails on
 *   an error and, since Archon only warns about unknown keys and drops them,
 *   on any parse warning. It also reads `archon ai alias list --json` and
 *   `ai tier list --json`, so it shows whether Archon read every generated
 *   alias (the `@<role>-retry` names, bare claude-provider model ids) and
 *   tier as generated (H-030). Each of the three commands must exit 0: one
 *   that exits non-zero fails, named, whatever it printed.
 * - tools.hermes-validate: Hermes's own config code, in its image: every key
 *   of the deployed config must be one Hermes knows (its DEFAULT_CONFIG, or a
 *   reviewed key it reads outside it or under a key whose default is no
 *   mapping, such as `model`), every value must read back as the
 *   deployed file says through its `load_config` (YAML 1.1, and it deep-merges partial blocks,
 *   such as an `auxiliary` slot, with its defaults), and its
 *   `validate_config_structure` must report nothing (H-029). Hermes itself
 *   never warns about an unknown key.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { PI_AGENT_DIR } from "../../generate/archon";
import { canonicalJson as canonical } from "../../mcp/lock";
import { HERMES_HOME, proxyEnv, serviceEnvironment } from "../../stack/env";
import { type AuditRun, type CheckResult, result } from "../types";
import { deployedBuild } from "./generated";
import { composeServices, dockerfileImages, dockerfileOf } from "./pins";

const firstLine = (s: string) => (s.trim().split("\n")[0] ?? "").slice(0, 300);

/** The image to run for `service`: the one Compose built, else its Dockerfile's last FROM, if either is here. Never pulled. */
async function localImage(run: AuditRun, service: string): Promise<{ image: string; user?: string } | { skip: string }> {
  const s = (await composeServices(run.ctx.root))[service];
  if (s === undefined) throw new Error(`stack/compose.yaml has no ${service} service`);
  const candidates = [s.image];
  const file = dockerfileOf(s);
  if (file !== undefined) {
    const froms = dockerfileImages(await readFile(join(run.ctx.root, file), "utf8")).filter((x) => x.kind === "FROM");
    candidates.push(froms.at(-1)?.image);
  }
  const images = candidates.filter((x): x is string => x !== undefined && x !== "");
  for (const image of images) {
    let r;
    try {
      r = await run.ctx.exec(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
    } catch (e) {
      return { skip: `docker is not available (${(e as Error).message})` };
    }
    if (r.code === 0) return { image, ...(s.user === undefined ? {} : { user: s.user }) };
    if (!/no such image/i.test(r.stderr)) return { skip: `docker image inspect failed (exit ${r.code}): ${firstLine(r.stderr) || "no error output"}` };
  }
  return { skip: `neither ${images.join(" nor ")} is here: \`mise run up\` builds ${images[0]}, and the audit never pulls an image` };
}

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/** A path a `-v src:dst` mount can hold. */
function mountable(path: string): string {
  if (path.includes(":") || path.includes(",")) throw new Error(`cannot mount ${path} into the validation container: its path holds ":" or ","`);
  return path;
}

/** The three read-only Archon commands the validation run makes, in order. */
const ARCHON_COMMANDS = ["validate workflows --json", "ai alias list --json", "ai tier list --json"] as const;

/** Runs in the Archon image: a scratch git repo (Archon needs one), then the three read-only commands, each followed by its exit code. Fixed text. */
const ARCHON_SCRIPT =
  'd=$(mktemp -d) || exit 1; cd "$d" && git init -q . && git -c user.name=hapi-audit -c user.email=audit@hapi.invalid commit -q --allow-empty -m audit || exit 1; ' +
  `for c in ${ARCHON_COMMANDS.map((c) => `"${c}"`).join(" ")}; do bun /app/packages/cli/src/cli.ts $c; printf "\\n@@hapi-audit %s@@\\n" "$?"; done`;

const asRecord = (v: unknown) => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown) => (typeof v === "string" ? v : typeof asRecord(v)?.message === "string" ? (asRecord(v)!.message as string) : JSON.stringify(v));

/** Errors and parse warnings from `archon validate workflows --json`, in v0.12.1's shape ({results[].issues}) or the plain {errors, parseWarnings}. */
export function readValidate(out: string): { errors: string[]; warnings: string[]; notes: string[]; workflows: number } | { unreadable: string } {
  let doc: Record<string, unknown> | undefined;
  try {
    doc = asRecord(JSON.parse(out));
  } catch {
    doc = undefined;
  }
  if (doc === undefined) return { unreadable: "could not read the output of archon validate workflows --json (not a JSON object)" };
  if (doc.ok === false && doc.error !== undefined) return { errors: [firstLine(text(doc.error))], warnings: [], notes: [], workflows: 0 };
  const errors: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  let known = false;
  if (Array.isArray(doc.errors)) ((known = true), errors.push(...doc.errors.map(text)));
  if (Array.isArray(doc.parseWarnings)) ((known = true), warnings.push(...doc.parseWarnings.map(text)));
  const results = Array.isArray(doc.results) ? doc.results.map(asRecord) : undefined;
  if (results !== undefined) {
    known = true;
    for (const r of results) {
      const name = typeof r?.workflowName === "string" ? r.workflowName : "(unnamed)";
      const issues = Array.isArray(r?.issues) ? r.issues.map(asRecord) : [];
      for (const i of issues) {
        const message = `${name}: ${text(i?.message)}`;
        if (i?.level === "error") errors.push(message);
        else if (i?.field === "parse_warning") warnings.push(message);
        else notes.push(message);
      }
      if (Array.isArray(r?.parseWarnings)) warnings.push(...r.parseWarnings.map((w) => `${name}: ${text(w)}`));
      if (r?.valid === false && !issues.some((i) => i?.level === "error")) errors.push(`${name}: invalid`);
    }
  }
  if (!known) return { unreadable: "could not read the output of archon validate workflows --json (no results, errors or parseWarnings)" };
  return { errors, warnings, notes, workflows: results?.length ?? 0 };
}

/** Whether Archon read every generated binding as generated: the `effective` entries of `ai alias list` / `ai tier list`. */
function bindingProblems(kind: "alias" | "tier", generated: Record<string, unknown>, listed: unknown): string[] {
  const doc = asRecord(listed);
  const entries = (Array.isArray(doc?.[kind === "alias" ? "aliases" : "tiers"]) ? (doc![kind === "alias" ? "aliases" : "tiers"] as unknown[]) : undefined)?.map(asRecord);
  if (entries === undefined) return [`could not read archon ai ${kind} list --json`];
  const problems: string[] = [];
  for (const [name, binding] of Object.entries(generated)) {
    const e = entries.find((x) => x?.[kind === "alias" ? "name" : "tier"] === name);
    if (e === undefined) problems.push(`Archon doesn't list the ${kind} ${name}`);
    else if (canonical(e.effective) !== canonical(binding)) problems.push(`Archon reads the ${kind} ${name} as something other than the generated binding`);
  }
  return problems;
}

/** tools.archon-validate */
export async function archonValidate(run: AuditRun): Promise<CheckResult[]> {
  const id = "tools.archon-validate";
  const deployed = await deployedBuild(run);
  if ("skip" in deployed) return [result(id, "skip", deployed.skip)];
  const config = join(deployed.dir, "archon", "config.yaml");
  const pi = join(deployed.dir, "pi");
  if (!(await exists(config)) || !(await exists(pi))) return [result(id, "skip", `no deployed Archon config at ${config} (and Pi dir ${pi}): \`mise run up\` writes them`)];
  const img = await localImage(run, "archon");
  if ("skip" in img) return [result(id, "skip", img.skip)];
  const [uid, gid] = (img.user ?? "1001:1001").split(":");
  const proxies = new Set(Object.keys(proxyEnv("archon")));
  const env = Object.entries(serviceEnvironment("archon")).filter(([k]) => !proxies.has(k)).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const cmd = [
    "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
    "--user", `${uid}:${gid ?? uid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp", "--tmpfs", `/.archon:uid=${uid},gid=${gid ?? uid}`, "--tmpfs", `/home/appuser:uid=${uid},gid=${gid ?? uid}`,
    "-v", `${mountable(config)}:/.archon/config.yaml:ro`, "-v", `${mountable(pi)}:${PI_AGENT_DIR}:ro`,
    ...env, "--entrypoint", "sh", img.image, "-c", ARCHON_SCRIPT,
  ];
  const r = await run.ctx.exec(cmd, { timeoutMs: 300_000 });
  if (r.code !== 0) return [result(id, "fail", `the Archon validation run (${img.image}) exited ${r.code}: ${firstLine(r.stderr) || "no error output"}`)];
  const parts = r.stdout.split(/\n?@@hapi-audit (\d+)@@\n?/);
  if (parts.length < 7) return [result(id, "fail", `could not read the Archon validation run's output (${img.image})`)];
  // parts: [validate's output, its exit code, alias list's output, its exit code, tier list's output, its exit code, ...].
  // A command that exits non-zero fails whatever it printed: its output can't be taken as its verdict.
  const exits = ARCHON_COMMANDS.map((command, i) => ({ command, code: parts[2 * i + 1]! })).filter((x) => x.code !== "0");
  const v = readValidate(parts[0]!);
  const generated = (YAML.parse(await readFile(config, "utf8")) ?? {}) as { aliases?: Record<string, unknown>; tiers?: Record<string, unknown> };
  const json = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const problems = [
    ...exits.map((x) => `archon ${x.command} exited ${x.code}`),
    ...("unreadable" in v ? [v.unreadable] : [...v.errors.map((e) => `error: ${e}`), ...v.warnings.map((w) => `parse warning: ${w}`)]),
    ...bindingProblems("alias", generated.aliases ?? {}, json(parts[2]!)),
    ...bindingProblems("tier", generated.tiers ?? {}, json(parts[4]!)),
  ];
  const notes = !("unreadable" in v) && v.notes.length > 0 ? `; other warnings: ${v.notes.join("; ")}` : "";
  // Unreadable output is always a problem; the second test only narrows v for the pass below.
  if (problems.length > 0 || "unreadable" in v) {
    return [result(id, "fail", `${problems.join("; ")}${notes}. Archon drops a key it doesn't know and only warns: fix the generator (src/generate/archon.ts) or the workflow, then \`mise run up\``)];
  }
  const aliases = Object.keys(generated.aliases ?? {}).length;
  const tiers = Object.keys(generated.tiers ?? {}).length;
  return [
    result(
      id,
      "pass",
      `archon validate workflows (${img.image}): ${v.workflows} workflows, no errors, no parse warnings; Archon reads all ${aliases} aliases and ${tiers} tiers as generated (ai alias list, ai tier list)${notes}`,
    ),
  ];
}

/**
 * Keys of the generated Hermes config that Hermes v0.22.5 reads although its DEFAULT_CONFIG doesn't list them,
 * each checked in the pinned image's source (2026-10-27).
 */
export const HERMES_KEYS_OUTSIDE_DEFAULTS: Readonly<Record<string, string>> = {
  "agent.reasoning_effort": "read by hermes_cli/cli_commands_mixin.py, hermes_cli/setup.py and tools/delegate_tool_config.py",
};

/**
 * The keys Hermes v0.22.5 reads in an `mcp_servers` entry (tools/mcp_tool_*.py in the pinned image, checked
 * 2026-10-27), and the keys of its nested blocks. DEFAULT_CONFIG has no mcp_servers.
 */
export const HERMES_MCP_SERVER_KEYS: Readonly<Record<string, readonly string[] | null>> = {
  command: null,
  args: null,
  env: null,
  url: null,
  headers: null,
  timeout: null,
  connect_timeout: null,
  enabled: null,
  trust: null,
  tools: ["include", "exclude", "prompts", "resources"],
  elicitation: ["enabled"],
  sampling: ["enabled"],
};

/**
 * The keys hapi deploys under a generated mapping whose Hermes default isn't a non-empty mapping, so DEFAULT_CONFIG
 * can't say which keys Hermes reads there; each was read in the pinned image's source (2026-10-28). Any other key
 * under one of these fails, and so does every key under a generated mapping that has neither a non-empty default
 * mapping nor a list here.
 */
export const HERMES_REVIEWED_BLOCKS: Readonly<Record<string, { keys: readonly string[]; why: string }>> = {
  // DEFAULT_CONFIG.model is "" (a bare model name).
  model: { keys: ["default", "provider"], why: 'read as model_cfg.get("default") and .get("provider") across hermes_cli/ and agent/' },
};

/** Runs in the Hermes image with its own Python: its defaults, the effective config, its structure check and the version stamp. Fixed text. */
const HERMES_SCRIPT = [
  "import json",
  "from hermes_cli.config import DEFAULT_CONFIG, check_config_version, load_config, validate_config_structure",
  "effective = load_config()",
  "current, latest = check_config_version()",
  'issues = [{"severity": i.severity, "message": i.message} for i in validate_config_structure(effective)]',
  'print(json.dumps({"defaults": DEFAULT_CONFIG, "effective": effective, "issues": issues, "config_version": current, "latest_config_version": latest}, default=str))',
].join("\n");

/** The generated keys Hermes doesn't know, as dotted paths. */
function unknownHermesKeys(ours: Record<string, unknown>, defaults: unknown): string[] {
  const unknown: string[] = [];
  const walk = (o: Record<string, unknown>, d: unknown, path: string[]) => {
    for (const [k, v] of Object.entries(o)) {
      const p = [...path, k];
      const dotted = p.join(".");
      if (dotted === "mcp_servers") continue;
      const dk = asRecord(d);
      if (dk === undefined || !Object.hasOwn(dk, k)) {
        if (!Object.hasOwn(HERMES_KEYS_OUTSIDE_DEFAULTS, dotted)) unknown.push(dotted);
        continue;
      }
      const ourBlock = asRecord(v);
      if (ourBlock === undefined) continue;
      const child = asRecord(dk[k]);
      if (child !== undefined && Object.keys(child).length > 0) walk(ourBlock, child, p);
      else {
        // Hermes's default can't say which keys it reads here: only a reviewed list can, and without one every key fails.
        const reviewed = Object.hasOwn(HERMES_REVIEWED_BLOCKS, dotted) ? HERMES_REVIEWED_BLOCKS[dotted]!.keys : [];
        for (const n of Object.keys(ourBlock)) if (!reviewed.includes(n)) unknown.push(`${dotted}.${n}`);
      }
    }
  };
  walk(ours, defaults, []);
  for (const [server, entry] of Object.entries(asRecord(ours.mcp_servers) ?? {})) {
    for (const [k, v] of Object.entries(asRecord(entry) ?? {})) {
      const nested = Object.hasOwn(HERMES_MCP_SERVER_KEYS, k) ? HERMES_MCP_SERVER_KEYS[k] : undefined;
      if (nested === undefined) unknown.push(`mcp_servers.${server}.${k}`);
      else if (nested !== null) for (const n of Object.keys(asRecord(v) ?? {})) if (!nested.includes(n)) unknown.push(`mcp_servers.${server}.${k}.${n}`);
    }
  }
  return unknown;
}

/** The generated leaves (outside mcp_servers, whose env refs Hermes expands) that Hermes's effective config holds otherwise. */
function misread(ours: Record<string, unknown>, effective: unknown): string[] {
  const out: string[] = [];
  const walk = (o: unknown, e: unknown, path: string[]) => {
    const r = asRecord(o);
    if (r !== undefined && Object.keys(r).length > 0) {
      for (const [k, v] of Object.entries(r)) if (!(path.length === 0 && k === "mcp_servers")) walk(v, asRecord(e)?.[k], [...path, k]);
      return;
    }
    if (canonical(o) !== canonical(e)) out.push(path.join("."));
  };
  walk(ours, effective, []);
  return out;
}

/** tools.hermes-validate */
export async function hermesValidate(run: AuditRun): Promise<CheckResult[]> {
  const id = "tools.hermes-validate";
  const deployed = await deployedBuild(run);
  if ("skip" in deployed) return [result(id, "skip", deployed.skip)];
  const config = join(deployed.dir, "hermes", "config.yaml");
  if (!(await exists(config))) return [result(id, "skip", `no deployed Hermes config at ${config}: \`mise run up\` writes it`)];
  const img = await localImage(run, "hermes");
  if ("skip" in img) return [result(id, "skip", img.skip)];
  const [uid, gid] = (img.user ?? "10000:10000").split(":");
  const cmd = [
    "docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
    "--user", `${uid}:${gid ?? uid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--tmpfs", "/tmp", "--tmpfs", `${HERMES_HOME}:uid=${uid},gid=${gid ?? uid}`, "-e", `HERMES_HOME=${HERMES_HOME}`,
    "-v", `${mountable(config)}:${HERMES_HOME}/config.yaml:ro`,
    "--entrypoint", "/opt/hermes/.venv/bin/python", img.image, "-c", HERMES_SCRIPT,
  ];
  const r = await run.ctx.exec(cmd, { timeoutMs: 300_000 });
  if (r.code !== 0) return [result(id, "fail", `the Hermes validation run (${img.image}) exited ${r.code}: ${firstLine(r.stderr) || "no error output"}`)];
  let out: Record<string, unknown> | undefined;
  try {
    out = asRecord(JSON.parse(r.stdout));
  } catch {
    out = undefined;
  }
  if (out === undefined || asRecord(out.defaults) === undefined || asRecord(out.effective) === undefined) {
    return [result(id, "fail", `could not read the Hermes validation run's output (${img.image})`)];
  }
  const ours = (YAML.parse(await readFile(config, "utf8")) ?? {}) as Record<string, unknown>;
  const problems = [
    ...unknownHermesKeys(ours, out.defaults).map((k) => `${k} is not a key Hermes knows`),
    ...misread(ours, out.effective).map((k) => `Hermes reads ${k} differently from the deployed file (a YAML 1.1 reading such as a bare off as false, or a value it renames or normalizes)`),
    ...(Array.isArray(out.issues) ? out.issues.map((i) => `Hermes's validate_config_structure: ${String(asRecord(i)?.severity ?? "issue")}: ${String(asRecord(i)?.message ?? JSON.stringify(i))}`) : []),
  ];
  if (problems.length > 0) {
    return [result(id, "fail", `${problems.join("; ")}. Hermes never warns about a key it doesn't know: fix the generator (src/generate/hermes.ts) against the pinned tag, then \`mise run up\``)];
  }
  const stamp = Object.hasOwn(ours, "_config_version")
    ? `_config_version ${String(ours._config_version)} (latest ${String(out.latest_config_version)})`
    : `no _config_version (Hermes reads it as ${String(out.config_version)}, latest ${String(out.latest_config_version)}: a never-stamped current-schema file, which only \`hermes update\` or \`doctor --fix\` would migrate)`;
  const reviewed = Object.entries(HERMES_KEYS_OUTSIDE_DEFAULTS).map(([k, why]) => `${k}, ${why}`).join("; ");
  const blocks = Object.entries(HERMES_REVIEWED_BLOCKS).map(([block, { keys, why }]) => `${keys.map((n) => `${block}.${n}`).join(" and ")}, ${why}`).join("; ");
  return [
    result(
      id,
      "pass",
      `Hermes (${img.image}) knows every deployed key (reviewed outside its DEFAULT_CONFIG: ${reviewed}; reviewed under a key whose default is no mapping: ${blocks}), reads each as the file says, and validate_config_structure reports nothing; the config has ${stamp}`,
    ),
  ];
}
