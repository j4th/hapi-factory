/**
 * The repo contract template (design §3.3): `templates/repo-contract/`, rendered into the files of a new repo's
 * first commit, and the checks `hapi new-repo` makes on that render before anything is pushed (design §3.2 step 2).
 *
 * Every template file ends in `.tmpl`, which rendering strips, so hapi-factory's own protected-path globs, its CI's
 * mise-file scan and `bun test` never see a template file as a live one. A file holds `{{name}}`, `{{owner}}`,
 * `{{gates_sha}}` and `{{year}}`; any other `{{...}}` is refused, so a GitHub Actions expression can't be written in
 * a template (none is: the contract's one workflow only calls hapi-factory's gates).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { aiWorkflowProblems } from "../audit/checks/github";
import { applyOverlay, overlayFromText } from "../policy/overlay";
import type { Policy } from "../policy/types";

/** The template, relative to hapi-factory's checkout. */
export const TEMPLATE_DIR = "templates/repo-contract";
/** The file the render adds: the template, the hapi-factory commit it came from, and a hash per file (design §3.3). */
export const TEMPLATE_LOCK = ".factory/template.lock";

export interface TemplateVars {
  name: string;
  owner: string;
  gates_sha: string;
  year: string;
}

const VARIABLE = /\{\{([^{}]*)\}\}/g;

/** Every file under `dir`, relative to it with `/` separators, sorted. A symlink, a socket or anything else that isn't a regular file or a directory is refused. */
function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const st = lstatSync(join(dir, path));
    if (st.isDirectory()) out.push(...walk(dir, path));
    else if (st.isFile()) out.push(path);
    else throw new Error(`${path}: not a regular file`);
  }
  return out;
}

const sha256 = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

/** JSON with every object's keys sorted, a 2-space indent and a final newline. */
function sortedJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x !== null && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, y]) => [k, sort(y)])) : x;
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

/**
 * Render the template in `dir`: path (without `.tmpl`) to text, sorted by path, with `.factory/template.lock` added
 * (the template's name, `vars.gates_sha` and the sha256 of every other file). Throws on a file without `.tmpl`
 * (`<path>: not a .tmpl file`), anything but a regular file (`<path>: not a regular file`) and an unknown variable
 * (`<path>: unknown template variable {{x}}`), naming the template's own path.
 */
export function renderTemplate(dir: string, vars: TemplateVars): Map<string, string> {
  const rendered = new Map<string, string>();
  for (const path of walk(dir)) {
    if (!path.endsWith(".tmpl")) throw new Error(`${path}: not a .tmpl file`);
    const text = readFileSync(join(dir, path), "utf8").replace(VARIABLE, (_, key: string) => {
      if (!Object.hasOwn(vars, key)) throw new Error(`${path}: unknown template variable {{${key}}}`);
      return vars[key as keyof TemplateVars];
    });
    const out = path.slice(0, -".tmpl".length);
    if (out === "" || out.endsWith("/") || out === TEMPLATE_LOCK) throw new Error(`${path}: renders to ${out === TEMPLATE_LOCK ? "the lock the render writes" : "no file name"}`);
    rendered.set(out, text);
  }
  const files = Object.fromEntries([...rendered].map(([path, text]) => [path, sha256(text)]));
  rendered.set(TEMPLATE_LOCK, sortedJson({ template: basename(dir), commit: vars.gates_sha, files }));
  return new Map([...rendered].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Names mise reads config, tasks or locked tools from: hapi-factory's ci.yml's `find` names, compared ignoring case. */
const MISE_NAMES = [/^mise\.toml$/i, /^\.mise\.toml$/i, /^mise\..*\.toml$/i, /^\.mise\..*\.toml$/i, /^mise\.lock$/i, /^mise\..*\.lock$/i, /^mise$/i, /^\.mise$/i, /^mise-tasks$/i, /^\.mise-tasks$/i, /^\.tool-versions$/i];

/**
 * Every path that is a mise file besides the root's exact `mise.toml` and `mise.lock` (H-194), in input order: any
 * segment, at any depth and in any case, named as ci.yml's mise-file scan names them (`mise.toml`, `.mise.toml`,
 * `mise.<x>.toml`, `.mise.<x>.toml`, `mise.lock`, `mise.<x>.lock`, `mise/`, `.mise/`, `mise-tasks/`, `.mise-tasks/`,
 * `.tool-versions`). A directory's name counts too, as `find` sees it.
 */
export function miseFileProblems(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    if (path === "mise.toml" || path === "mise.lock") continue;
    if (path.split("/").some((seg) => MISE_NAMES.some((re) => re.test(seg)))) out.push(`${path}: a mise file besides the root mise.toml and mise.lock (H-194)`);
  }
  return out;
}

const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;

/** Every pin that isn't an exact version: mise.toml's tools (1 to 4 numbers) and package.json's dependency maps (major.minor.patch). */
export function exactVersionProblems(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  const mise = files.get("mise.toml");
  if (mise === undefined) out.push("mise.toml: not in the render");
  else {
    let tools: Record<string, unknown> = {};
    try {
      const parsed = Bun.TOML.parse(mise) as { tools?: unknown };
      if (parsed.tools !== undefined && (typeof parsed.tools !== "object" || parsed.tools === null)) out.push("mise.toml: [tools] is not a table");
      else tools = (parsed.tools ?? {}) as Record<string, unknown>;
    } catch (e) {
      out.push(`mise.toml: does not parse as TOML (${e instanceof Error ? e.message : String(e)})`);
    }
    for (const [tool, v] of Object.entries(tools)) {
      if (typeof v !== "string" || !/^\d+(\.\d+){1,3}$/.test(v)) out.push(`mise.toml: ${tool} = ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)} is not an exact version`);
    }
  }
  const pkg = files.get("package.json");
  if (pkg === undefined) out.push("package.json: not in the render");
  else {
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(pkg) as Record<string, unknown>;
    } catch {
      out.push("package.json: does not parse as JSON");
    }
    for (const key of DEPENDENCY_MAPS) {
      const deps = json[key];
      if (deps === undefined) continue;
      if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
        out.push(`package.json: ${key} is not a map`);
        continue;
      }
      for (const [name, v] of Object.entries(deps)) if (typeof v !== "string" || !/^\d+\.\d+\.\d+$/.test(v)) out.push(`package.json: ${name}@${String(v)} is not an exact version`);
    }
  }
  return out;
}

interface LockEntry {
  version?: unknown;
  [platform: string]: unknown;
}
/** The platforms the contract's mise.lock covers: CI's runners and the maintainer's Mac. */
export const LOCK_PLATFORMS = ["linux-x64", "macos-arm64"] as const;

/** What mise.lock doesn't lock: each mise.toml tool at its pinned version, with a sha256 and an https URL per platform. */
export function miseLockProblems(files: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  let tools: Record<string, unknown>;
  let locked: Record<string, LockEntry[]>;
  try {
    tools = ((Bun.TOML.parse(files.get("mise.toml") ?? "") as { tools?: Record<string, unknown> }).tools ?? {}) as Record<string, unknown>;
    locked = ((Bun.TOML.parse(files.get("mise.lock") ?? "") as { tools?: Record<string, LockEntry[]> }).tools ?? {}) as Record<string, LockEntry[]>;
  } catch (e) {
    return [`mise.toml or mise.lock does not parse as TOML (${e instanceof Error ? e.message : String(e)})`];
  }
  for (const [tool, version] of Object.entries(tools)) {
    const entry = (Array.isArray(locked[tool]) ? locked[tool] : []).find((e) => e.version === version);
    if (entry === undefined) {
      out.push(`mise.lock: no ${tool} ${String(version)}`);
      continue;
    }
    for (const p of LOCK_PLATFORMS) {
      const plat = entry[`platforms.${p}`] as { checksum?: unknown; url?: unknown } | undefined;
      if (typeof plat?.checksum !== "string" || !/^sha256:[0-9a-f]{64}$/.test(plat.checksum) || typeof plat.url !== "string" || !plat.url.startsWith("https://")) {
        out.push(`mise.lock: ${tool} ${String(version)} has no sha256 and https URL for ${p}`);
      }
    }
  }
  for (const tool of Object.keys(locked)) if (!Object.hasOwn(tools, tool)) out.push(`mise.lock: locks ${tool}, which mise.toml doesn't pin`);
  return out;
}

/**
 * Everything `hapi new-repo` checks in a render before it creates or pushes anything (design §3.2 step 2): the only
 * mise files are the root two (H-194); every version is exact, and mise.lock locks each tool for both platforms; no
 * workflow runs an AI agent with a credential on a forbidden trigger (repo.ai-workflows); the overlay applies to
 * `policy`, so it only tightens it; no `{{` is left; and no file runs Bun's package runner as `bunx`.
 */
export function contractProblems(files: ReadonlyMap<string, string>, policy: Policy): string[] {
  const out = [...miseFileProblems(files.keys()), ...exactVersionProblems(files), ...miseLockProblems(files)];
  for (const [path, text] of files) {
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) out.push(...aiWorkflowProblems(path, text));
    if (text.includes("{{")) out.push(`${path}: holds a "{{" the render didn't fill`);
    if (/\bbunx\b/.test(text)) out.push(`${path}: names bunx, which downloads from npm when a binary is missing; run tools from node_modules/.bin`);
  }
  const overlay = files.get(".factory/config.yaml");
  if (overlay === undefined) out.push(".factory/config.yaml: not in the render");
  else {
    try {
      applyOverlay(policy, overlayFromText(overlay, ".factory/config.yaml"));
    } catch (e) {
      out.push(`.factory/config.yaml: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}
