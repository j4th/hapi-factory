/**
 * `hapi policy build`: compile policy/ into each tool's native config under
 * build/ (spec §8.1). docs/generated-configs.md describes every file.
 *
 *   build/hermes/config.yaml
 *   build/archon/config.yaml, build/archon/archon.env
 *   build/pi/models.json, build/pi/hapi-guard.json
 *   build/egress/{hermes,archon,research}.squid.conf
 *
 * The emitters are pure and deterministic (stable key order, no timestamps),
 * so a fresh build is byte-identical to the deployed files unless someone
 * edited them, which is how Task 6's audit detects drift.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPolicy } from "../policy/load";
import type { Policy, RosterName } from "../policy/types";
import { emitArchon } from "./archon";
import { emitEgress } from "./egress";
import { emitHermes } from "./hermes";
import { emitPi } from "./pi";

export const ROSTERS: readonly RosterName[] = ["budget", "anthropic", "portable"];

export interface BuildOptions {
  /** The roster for Archon's tiers and Pi's models. Hermes always uses `anthropic`. Default `anthropic`. */
  roster?: RosterName;
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
  const groups: [dir: string, files: Record<string, string>][] = [
    ["hermes", emitHermes(p)],
    ["archon", emitArchon(p, roster)],
    ["pi", emitPi(p, roster)],
    ["egress", emitEgress(p)],
  ];
  const written: string[] = [];
  for (const [dir, files] of groups) {
    await mkdir(join(outDir, dir), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const path = join(outDir, dir, name);
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
