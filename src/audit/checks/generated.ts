/**
 * generated.drift (spec §8.1, §11.8; Review Focus 4): the deployed build/ is
 * exactly what policy/ builds, and every running container was started from
 * that build.
 *
 * - The deployed build is the one `hapi stack up` writes and the containers
 *   bind-mount: `--build-dir`, else the checkout `up` runs from, hapi's
 *   `~hapi/hapi-factory/build` (or, under the dev bypass, this checkout's
 *   build/). It is only ever read.
 * - The fresh build is `buildAll` into a temp dir, once per roster (`up
 *   --roster` picks one), and the deployed build must equal one of them byte
 *   for byte. The emitters are deterministic, so any difference is a hand
 *   edit, a stale build or a policy change not yet deployed. A difference is
 *   named by file and key (YAML, JSON, env) or line (squid.conf), never by
 *   the deployed value.
 * - Each running container's `org.hapi.build-sha256` label must be that
 *   build's digest (`buildDigest`, src/stack/up.ts; H-147): Compose recreates
 *   a container whose config changed, not one whose bind-mounted file did, so
 *   a container with an older label may still run an older config.
 */
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { buildAll, ROSTERS } from "../../generate/index";
import { loadPolicy } from "../../policy/load";
import type { RosterName } from "../../policy/types";
import { buildDigest, currentUserOverride, HAPI_CHECKOUT, HAPI_USER } from "../../stack/up";
import { type AuditRun, type CheckResult, result } from "../types";
import { containerName, isRunning, stackContainers } from "./runtime";

export type Deployed = { dir: string } | { skip: string };

/** Where the deployed build/ is, and whether it can be read (memoized per audit). */
export function deployedBuild(run: AuditRun): Promise<Deployed> {
  return run.once("deployed", async (): Promise<Deployed> => {
    const { ctx } = run;
    let dir: string;
    if (ctx.buildDir !== undefined) dir = resolve(ctx.root, ctx.buildDir);
    else if (currentUserOverride(ctx.env, ctx.user).override) dir = join(ctx.root, "build");
    else {
      const noUser = `there is no ${HAPI_USER} user on this host (scripts/host-setup.sh makes it), so there is no deployed build to compare; pass --build-dir to compare another`;
      let r;
      try {
        r = await ctx.exec(["getent", "passwd", HAPI_USER]);
      } catch {
        return { skip: noUser };
      }
      const home = r.code === 0 ? r.stdout.trim().split(":")[5] : undefined;
      if (home === undefined || home === "") return { skip: noUser };
      dir = join(home, HAPI_CHECKOUT, "build");
    }
    try {
      if (!(await stat(dir)).isDirectory()) return { skip: `${dir} is not a directory` };
      await readdir(dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { skip: `no deployed build at ${dir}: \`mise run up\` writes it` };
      return { skip: `cannot read the deployed build at ${dir} (${code ?? "error"}): run the audit as ${HAPI_USER}, in its checkout` };
    }
    return { dir };
  });
}

export interface FreshBuild {
  roster: RosterName;
  /** The temp dir holding build/. */
  root: string;
  /** The files written, relative to `root` (build/<dir>/<file>), as `up` names them. */
  files: string[];
  /** `buildDigest` of them: the label `up` would put on the containers. */
  digest: string;
}

/** A fresh build of ctx.policyDir per roster, in temp dirs the audit removes (memoized per audit). Throws if policy/ doesn't load. */
export function freshBuilds(run: AuditRun): Promise<FreshBuild[]> {
  return run.once("fresh", async () => {
    const p = loadPolicy(run.ctx.policyDir);
    const builds: FreshBuild[] = [];
    for (const roster of ROSTERS) {
      const root = await mkdtemp(join(tmpdir(), "hapi-audit-build-"));
      run.temps.push(root);
      const written = await buildAll(p, join(root, "build"), { roster });
      const files = written.map((f) => relative(root, f));
      builds.push({ roster, root, files, digest: buildDigest(files, root) });
    }
    return builds;
  });
}

/** Leaves of a parsed YAML/JSON document, path -> canonical JSON. Arrays are leaves. */
function leaves(v: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0 && prefix !== "") out.set(prefix, "{}");
    for (const [k, x] of entries) leaves(x, prefix === "" ? k : `${prefix}.${k}`, out);
  } else out.set(prefix, JSON.stringify(v) ?? "undefined");
  return out;
}

/** The keys whose leaves differ, were added or were removed. */
function keyDiff(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
}

/** archon.env's `NAME=value` lines (comments and blank lines skipped); anything else throws. */
function dotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error("not NAME=value");
    out[m[1]!] = m[2]!;
  }
  return out;
}

const listed = (items: string[], max = 6) => (items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`);

/** How `deployed` differs from `fresh`, for the file at `name` (e.g. hermes/config.yaml), naming keys or lines, never values; `size` counts them. */
function describe(name: string, deployed: string, fresh: string): { text: string; size: number } {
  const parse = name.endsWith(".yaml") ? (t: string) => YAML.parse(t) : name.endsWith(".json") ? (t: string) => JSON.parse(t) : name.endsWith(".env") ? dotenv : undefined;
  if (parse !== undefined) {
    let d: unknown;
    try {
      d = parse(deployed);
    } catch {
      return { text: `${name}: does not parse`, size: 1000 };
    }
    const keys = keyDiff(leaves(d), leaves(parse(fresh)));
    return keys.length === 0 ? { text: `${name}: differs in comments or layout only`, size: 1 } : { text: `${name}: ${listed(keys)}`, size: keys.length };
  }
  const a = deployed.split("\n");
  const b = fresh.split("\n");
  const lines: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) lines.push(i + 1);
  return { text: `${name}: ${lines.length === 1 ? "line" : "lines"} ${listed(lines.map(String), 4)} ${lines.length === 1 ? "differs" : "differ"}`, size: lines.length };
}

/** Every difference between the deployed build and `fresh`, one per file, with how many keys or lines each is. */
async function compare(dir: string, fresh: FreshBuild): Promise<{ text: string; size: number }[]> {
  const problems: { text: string; size: number }[] = [];
  for (const file of fresh.files) {
    const name = relative("build", file);
    const want = await readFile(join(fresh.root, file), "utf8");
    let got: string;
    try {
      got = await readFile(join(dir, name), "utf8");
    } catch (e) {
      problems.push({ text: `${name}: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `cannot be read (${(e as NodeJS.ErrnoException).code})`}`, size: 1000 });
      continue;
    }
    if (got !== want) problems.push(describe(name, got, want));
  }
  return problems;
}

/** generated.drift */
export async function generatedDrift(run: AuditRun): Promise<CheckResult[]> {
  const id = "generated.drift";
  const deployed = await deployedBuild(run);
  if ("skip" in deployed) return [result(id, "skip", deployed.skip)];
  const builds = await freshBuilds(run);
  const diffs = await Promise.all(builds.map(async (b) => ({ build: b, problems: await compare(deployed.dir, b) })));
  // The closest roster: the fewest differing keys and lines (an edit to one file still leaves its roster closest).
  const weight = (d: (typeof diffs)[number]) => d.problems.reduce((n, p) => n + p.size, 0);
  const best = diffs.reduce((x, y) => (weight(y) < weight(x) ? y : x));
  // A container must have been started from the build that matches; with drift, from some fresh build at least.
  const expected = new Set(best.problems.length === 0 ? [best.build.digest] : builds.map((b) => b.digest));

  const stack = await stackContainers(run);
  const labelProblems: string[] = [];
  let labels: string;
  if ("unavailable" in stack) labels = `${stack.unavailable}, so no container's build label was checked`;
  else {
    const up = stack.containers.filter(isRunning);
    for (const c of up) {
      const digest = c.Config?.Labels?.["org.hapi.build-sha256"] ?? "";
      if (digest === "") labelProblems.push(`${containerName(c)} has no org.hapi.build-sha256 label (not started through \`hapi stack up\`)`);
      else if (!expected.has(digest)) labelProblems.push(`${containerName(c)} was started from another build than this one, so it may run an older config`);
    }
    labels = up.length === 0 ? "the stack is not running, so no container's build label was checked" : `${up.length} running containers were started from it (org.hapi.build-sha256)`;
  }

  if (best.problems.length > 0 || labelProblems.length > 0) {
    const files = best.problems.length > 0 ? `${deployed.dir} differs from a fresh build of ${run.ctx.policyDir} (closest: roster ${best.build.roster}): ${best.problems.map((p) => p.text).join("; ")}` : "";
    return [
      result(
        id,
        "fail",
        `${[files, ...labelProblems].filter((s) => s !== "").join("; ")}. build/ is generated: never edit it by hand. Change policy/ in a PR, then \`mise run up\` rebuilds it and restarts what changed`,
      ),
    ];
  }
  return [result(id, "pass", `${deployed.dir} equals a fresh build of ${run.ctx.policyDir} (roster ${best.build.roster}, ${best.build.files.length} files); ${labels}`)];
}
