/**
 * `hapi policy build`: compile policy/ into each tool's native config under
 * build/ (spec §8.1). docs/generated-configs.md describes every file.
 *
 *   build/hermes/config.yaml
 *   build/archon/config.yaml, run-config.yaml, archon.env, empty.env, gitconfig
 *   build/pi/models.json, models-store.json, settings.json, hapi-guard.json
 *   build/pi/extensions/hapi-guard.js   (bundled from src/guard/index.ts)
 *   build/decide/hapi-decide.js         (bundled from src/decide/cli.ts)
 *   build/egress/{hermes,archon,research}.squid.conf
 *   build/mcp/{hermes,research}.mcp.json
 *
 * The emitters are pure and deterministic (stable key order, no timestamps),
 * so a fresh build is byte-identical to the deployed files unless someone
 * edited them, which is how Task 6's audit detects drift.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadPolicy } from "../policy/load";
import { o11yEnabled } from "../policy/mcp";
import type { Policy, RosterName } from "../policy/types";
import { emitArchon } from "./archon";
import { emitEgress } from "./egress";
import { notice, REPO_ROOT, slashComment } from "./header";
import { emitHermes } from "./hermes";
import { emitMcp } from "./mcp";
import { emitPi } from "./pi";

export { REPO_ROOT };

/** The entries bundled into build/: hapi-guard (a Pi extension) and `hapi decide` (Hermes's and the guard's classifier CLI). */
export const GUARD_ENTRY = "src/guard/index.ts";
export const DECIDE_ENTRY = "src/decide/cli.ts";

/**
 * Bundle `entry` (a path under `root`) into one ESM file that imports nothing but
 * `node:*`, so it runs under a bare Bun with no install (`--no-install`). The
 * notice is its first lines. `target: "node"` keeps `node:` specifiers and puts
 * the banner first; `"bun"` would rewrite them to bare names and put `// @bun`
 * first. A fixed `root` keeps Bun's `// <path>` comments, and so the bytes, the same
 * from one checkout to the next.
 */
export async function bundleEntry(entry: string, root: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, entry)],
    root,
    target: "node",
    format: "esm",
    minify: false,
    banner: `${slashComment(notice(`Bundle of ${entry}`, [entry]))}\n`,
  });
  if (!result.success) throw new Error(`bundling ${entry}: ${result.logs.join("; ")}`);
  const text = await result.outputs[0]!.text();
  const kept = [...text.matchAll(/^(?:import|export)\b[^;\n]*?["']([^"']+)["']/gm)].map((m) => m[1]!).filter((spec) => !spec.startsWith("node:"));
  if (kept.length > 0) throw new Error(`bundling ${entry}: the bundle imports ${[...new Set(kept)].join(", ")}, not only node:*`);
  return text;
}

const bundles = new Map<string, Promise<string>>();

/**
 * `bundleEntry`, worked out once per process for each (entry, root): the bundles don't depend on the roster, and
 * the audit builds every roster. A bundle that fails is not kept, so the next build tries again.
 */
function bundleOnce(entry: string, root: string): Promise<string> {
  const key = `${root}\0${entry}`;
  let bundle = bundles.get(key);
  if (bundle === undefined) {
    bundle = bundleEntry(entry, root);
    bundles.set(key, bundle);
    bundle.catch(() => bundles.delete(key));
  }
  return bundle;
}

/** `files` plus the bundle of `entry` at `name`. */
async function withBundle(files: Record<string, string>, name: string, entry: string): Promise<Record<string, string>> {
  return { ...files, [name]: await bundleOnce(entry, REPO_ROOT) };
}

export const ROSTERS: readonly RosterName[] = ["budget", "anthropic", "portable"];

export interface BuildOptions {
  /** The roster for Archon's tiers and Pi's models. Hermes always uses `anthropic`. Default `anthropic`. */
  roster?: RosterName;
  /**
   * Whether the observability profile runs, which turns on the o11y-gated MCP
   * servers in Hermes's config. Default: the policy's flags.otel.enabled.
   */
  o11y?: boolean;
}

/**
 * Write every generated file under `outDir` (normally `build`) and return the
 * paths written. Every emitter runs before anything is written, so a policy an
 * emitter refuses leaves the existing files alone. Files are only written and
 * never deleted.
 */
export async function buildAll(p: Policy, outDir: string, opts: BuildOptions = {}): Promise<string[]> {
  const roster = opts.roster ?? "anthropic";
  if (!ROSTERS.includes(roster)) throw new Error(`unknown roster '${roster}'`);
  const o11y = o11yEnabled(p, opts);
  // A group's emitter may be async (the bundles). Every one is awaited before anything is written,
  // so a refusing emitter leaves the existing files alone.
  const groups: [dir: string, files: Record<string, string> | Promise<Record<string, string>>][] = [
    ["hermes", emitHermes(p, { o11y })],
    ["archon", emitArchon(p, roster)],
    ["pi", withBundle(emitPi(p, roster), "extensions/hapi-guard.js", GUARD_ENTRY)],
    ["egress", emitEgress(p)],
    ["mcp", emitMcp(p)],
    ["decide", withBundle({}, "hapi-decide.js", DECIDE_ENTRY)],
  ];
  const built = await Promise.all(groups.map(async ([dir, files]) => [dir, await files] as const));
  const written: string[] = [];
  for (const [dir, files] of built) {
    for (const [name, text] of Object.entries(files)) {
      const path = join(outDir, dir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      written.push(path);
    }
  }
  return written;
}

const USAGE = "usage: hapi policy build [--policy dir] [--out dir] [--roster budget|anthropic|portable]";

/**
 * `hapi policy build [--policy dir] [--out dir] [--roster name]`: load and check
 * policy/ (default `policy`), write the generated files under `build` (default)
 * and print each path. A usage error exits 2; a policy file that fails to load
 * throws, which the CLI reports as `hapi policy build: <file>: <problem>`, exit 1.
 */
export async function policyBuild(args: string[]): Promise<number> {
  const opts: Record<"--policy" | "--out" | "--roster", string> = { "--policy": "policy", "--out": "build", "--roster": "anthropic" };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (!Object.hasOwn(opts, flag) || value === undefined || value.startsWith("-")) {
      console.error(USAGE);
      return 2;
    }
    opts[flag as keyof typeof opts] = value;
  }
  const roster = opts["--roster"];
  if (!(ROSTERS as readonly string[]).includes(roster)) {
    console.error(`hapi policy build: unknown roster '${roster}'`);
    console.error(USAGE);
    return 2;
  }
  const paths = await buildAll(loadPolicy(opts["--policy"]), opts["--out"], { roster: roster as RosterName });
  for (const path of paths) console.log(path);
  return 0;
}
