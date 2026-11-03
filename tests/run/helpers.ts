/**
 * Fakes for tests/run: a recording Docker that keeps a small world (containers,
 * networks, volumes, and the files in a run's output volume) and answers the
 * commands src/run makes as Docker would, plus a temp state dir, runtime dir,
 * build dir, source repo and work order. No Docker, git, sudo or network: the
 * git calls (the source's HEAD and commits, its `.factory/config.yaml`, the
 * bundle's heads) are answered too,
 * `docker logs --follow` streams `logs`, and `docker logs --tail` prints a
 * container's `world.logs`. The run disk is a temp dir (`deps.diskDir`) whose
 * filesystem facts come from `deps.probeFs`, never from a real mount; the
 * cleanup helper empties the host dirs it is given.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { envFileText } from "../../src/secrets/files";
import { COPY_SCRIPT, LIST_SCRIPT } from "../../src/run/copyout";
import { CLEAN_SCRIPT, type FsFacts, type FsProbe, GIB } from "../../src/run/disk";
import { EXIT_FORMAT, LOGS_SCRIPT } from "../../src/run/lifecycle";
import { recordDir, type RunRecord, writeRecord } from "../../src/run/records";
import type { RunDeps } from "../../src/run/spec";
import { tempDir } from "../secrets/helpers";
import { REPO } from "../stack/helpers";

export type Call = { cmd: string[]; env: Record<string, string>; bytes: boolean };

/** A file in a run's output volume, as the copy-out helper's tests see it. */
export type FakeFile = { kind: "file"; bytes: Uint8Array } | { kind: "symlink" } | { kind: "fifo" } | { kind: "dir" };

export const file = (text: string | Uint8Array): FakeFile => ({ kind: "file", bytes: typeof text === "string" ? new TextEncoder().encode(text) : text });

interface Container {
  name: string;
  labels: Record<string, string>;
  running: boolean;
  /** What `docker inspect --format EXIT_FORMAT` prints for its exit code: FakeOptions.exitCode, 0 by default. */
  exitCode?: number;
  /** Its `.State.Status`: `running` or `exited` from `running`, unless a test sets another (`created`). */
  state?: string;
}
interface Network {
  labels: Record<string, string>;
  internal: boolean;
  endpoints: Set<string>;
}
interface Volume {
  labels: Record<string, string>;
  owner: string;
  files: Map<string, FakeFile>;
}

export interface World {
  containers: Map<string, Container>;
  networks: Map<string, Network>;
  volumes: Map<string, Volume>;
  /** What a run writes into its out volume when its container starts. */
  outputs: Record<string, FakeFile>;
  /** The owners of the run's two volumes when its container started. */
  ownersAtRun?: string[];
  /** What `docker logs --tail` prints for a run container (stdout and stderr together), by container name. */
  logs: Map<string, string>;
}

export const SHA = "4bf92f3577b34da6a3ce929d0e0e47364bf92f35";
/** A second commit the fake source holds: a parent run seeded there has a base that isn't the run's own commit. */
export const SHA2 = "0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a";
/** The commits the fake source holds. `rev-parse <x>^{commit}` echoes one of them; any other name resolves to SHA, so a check that doesn't compare the answer with what it asked for takes it. */
const COMMITS = [SHA, SHA2];
/** The blob id the fake's `ls-tree` gives `.factory/config.yaml`. */
const OVERLAY_BLOB = "e".repeat(40);
/** The blob id the fake's `ls-tree -r` gives a file of `FakeOptions.tree`: the SHA-1 of its path. */
const blobOf = (path: string) => createHash("sha1").update(path).digest("hex");
/** What the fake `docker info --format {{.DockerRootDir}}` prints: Docker's data root, on a filesystem of its own (dev 3). */
export const DATA_ROOT = "/fake/docker-root";
export const NOW = new Date("2026-10-29T12:00:00.000Z");

/** The value of `flag` (the argv entry after it), or undefined. */
const after = (cmd: string[], flag: string) => {
  const i = cmd.indexOf(flag);
  return i === -1 ? undefined : cmd[i + 1];
};

/** Every `--label k=v` (or bare `--label k`) in `cmd`. */
function labelsOf(cmd: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  cmd.forEach((a, i) => {
    if (a !== "--label") return;
    const [k, ...v] = cmd[i + 1]!.split("=");
    out[k!] = v.join("=");
  });
  return out;
}

/** Whether `labels` pass every `--filter label=k[=v]` in `cmd`. */
function matches(cmd: string[], labels: Record<string, string>): boolean {
  return cmd.every((a, i) => {
    if (a !== "--filter") return true;
    const f = cmd[i + 1]!;
    if (!f.startsWith("label=")) throw new Error(`fake docker: unexpected filter ${f}`);
    const [k, ...v] = f.slice("label=".length).split("=");
    return Object.hasOwn(labels, k!) && (v.length === 0 || labels[k!] === v.join("="));
  });
}

/** The volume mounted at `dest` by a `-v vol:dest[:ro]` in `cmd`. */
function volumeAt(cmd: string[], dest: string): string | undefined {
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] !== "-v") continue;
    const [src, dst] = cmd[i + 1]!.split(":");
    if (dst === dest) return src;
  }
  return undefined;
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string, code = 1) => ({ code, stdout: "", stderr });

/** `cmd` without the host's `timeout -k <k> <s>` in front, which bounds every helper's `docker run`. */
export const unbounded = (cmd: string[]) => (cmd[0] === "timeout" && cmd[1] === "-k" ? cmd.slice(4) : cmd);

export interface FakeOptions {
  project?: string;
  user?: string;
  env?: Record<string, string>;
  /** Commands (prefixes of the joined argv) that exit 1. */
  failing?: string[];
  /**
   * Whether a helper run (its docker argv) never returns, as on a hung daemon. Under the host's
   * `timeout -k <k> <s>` the fake answers 137, as timeout does once its KILL has ended a docker CLI that passed
   * the TERM on and kept waiting; bare, the call never settles.
   */
  hangs?: (cmd: string[]) => boolean;
  /** The exit code of `timeout <s> docker wait <run>`: 0 (the run exited) or 124 (the deadline came first). */
  waitCode?: number;
  /** The run container's exit code, as `docker inspect --format EXIT_FORMAT` prints it (0 by default). */
  exitCode?: number;
  /** What `git bundle list-heads` prints. */
  heads?: string;
  /** The source's `.factory/config.yaml`, at every commit (`ls-tree` lists it, `cat-file blob` prints it); none by default. */
  overlay?: string;
  /**
   * The source's files at every commit, path to text, for the sidecar's data export: `ls-tree -r` lists the regular
   * files under the asked prefix, each as `100644 blob <sha1 of its path> <size>\t<path>\0`, and `cat-file blob <oid>`
   * prints one's bytes, through `runBytes`. None by default.
   */
  tree?: Record<string, string>;
  /** The run network's subnet and whether it is internal, as `docker network inspect` says. */
  subnet?: string;
  internal?: boolean;
  runs?: Partial<RunDeps["runs"]>;
  now?: Date;
  /** Called before each command is answered. */
  onCall?: (cmd: string[]) => void;
  /**
   * What `deps.probeFs` says of the run disk: "missing", or its facts (default: its own filesystem, dev 2, 19.5 GiB,
   * writable). `ownFs: false` puts it on its parent's filesystem (dev 1), `onDataRoot` on Docker's data root's (dev 3).
   */
  disk?: "missing" | (Partial<FsFacts> & { ownFs?: boolean; onDataRoot?: boolean });
}

/** A fake `RunDeps` and the world behind it. `deps.stateDir`, `xdg` and `buildDir` are fresh temp dirs. */
export function fakeRun(o: FakeOptions = {}) {
  const tmp = tempDir("hapi-run-");
  const xdg = join(tmp, "xdg");
  mkdirSync(xdg, { mode: 0o700 });
  const buildDir = join(tmp, "build");
  for (const [f, text] of Object.entries(BUILD_FILES)) {
    mkdirSync(join(buildDir, f, ".."), { recursive: true });
    writeFileSync(join(buildDir, f), text);
  }
  const world: World = { containers: new Map(), networks: new Map(), volumes: new Map(), outputs: {}, logs: new Map() };
  const calls: Call[] = [];
  const spawned: string[][] = [];
  const project = o.project ?? "hapi";
  const diskDir = join(tmp, "run-disk");
  mkdirSync(diskDir, { mode: 0o700 });
  const probeFs: FsProbe = (path) => {
    if (path === dirname(diskDir)) return { dev: 1, bytes: 500 * GIB, writable: true };
    if (path === DATA_ROOT) return { dev: 3, bytes: 500 * GIB, writable: true };
    if (path !== diskDir || o.disk === "missing") return undefined;
    const { ownFs, onDataRoot, ...facts } = o.disk ?? {};
    return { dev: ownFs === false ? 1 : onDataRoot ? 3 : 2, bytes: 19.5 * GIB, writable: true, ...facts };
  };

  const run: RunDeps["run"] = async (full, opts) => {
    calls.push({ cmd: full, env: opts.env, bytes: false });
    o.onCall?.(full);
    const cmd = unbounded(full);
    const joined = cmd.join(" ");
    if (o.hangs?.(cmd)) return cmd === full ? new Promise<never>(() => {}) : fail("", 137);
    if (o.failing?.some((f) => joined.startsWith(f))) return fail("boom");
    if (cmd[0] === "sudo") return ok();
    if (cmd[0] === "timeout" && cmd[2] === "docker" && cmd[3] === "wait") {
      const c = world.containers.get(cmd[4]!);
      if (c === undefined) return fail(`Error response from daemon: No such container: ${cmd[4]}`);
      const code = o.waitCode ?? 0;
      if (code === 0) c.running = false;
      return code === 0 ? ok("0\n") : fail("", code);
    }
    if (cmd[0] === "sh" && cmd[1] === "-c" && cmd[2] === LOGS_SCRIPT) {
      if (!world.containers.has(cmd[4]!)) return fail(`Error response from daemon: No such container: ${cmd[4]}`);
      return ok(world.logs.get(cmd[4]!) ?? "");
    }
    if (cmd[0] === "env" && cmd[1] === "-i") {
      if (cmd.includes("list-heads")) return ok(o.heads ?? `${SHA} HEAD\n`);
      if (cmd.includes("rev-parse")) {
        const asked = cmd.at(-1)!.replace(/\^\{commit\}$/, "");
        return ok(`${COMMITS.includes(asked) ? asked : SHA}\n`);
      }
      if (cmd.includes("ls-tree") && cmd.includes("-r")) {
        const prefix = cmd.at(-1)!;
        const rows = Object.entries(o.tree ?? {}).filter(([p]) => p.startsWith(prefix));
        return ok(rows.map(([p, text]) => `100644 blob ${blobOf(p)} ${String(Buffer.byteLength(text)).padStart(7)}\t${p}\0`).join(""));
      }
      if (cmd.includes("ls-tree")) return ok(o.overlay === undefined ? "" : `100644 blob ${OVERLAY_BLOB}\t${cmd.at(-1)}\0`);
      if (cmd.includes("cat-file") && cmd.at(-1) === OVERLAY_BLOB && o.overlay !== undefined) return ok(o.overlay);
      throw new Error(`fake: unexpected command ${joined}`);
    }
    if (cmd[0] !== "docker") throw new Error(`fake: unexpected command ${joined}`);
    const [, a, b] = cmd;
    if (a === "info" && after(cmd, "--format") === "{{.DockerRootDir}}") return ok(`${DATA_ROOT}\n`);
    if (a === "inspect" && after(cmd, "--format") === EXIT_FORMAT) {
      const c = world.containers.get(cmd.at(-1)!);
      return c === undefined ? fail(`Error: No such object: ${cmd.at(-1)}`) : ok(`${c.state ?? (c.running ? "running" : "exited")} ${c.exitCode ?? o.exitCode ?? 0}\n`);
    }
    if (a === "ps") {
      const all = cmd.includes("-aq") || cmd.includes("-a");
      const found = [...world.containers.values()].filter((c) => (all || c.running) && matches(cmd, c.labels));
      const format = after(cmd, "--format");
      const line = (c: Container) => (format?.includes('{{.Label "org.hapi.run"}}') ? `${c.labels["org.hapi.run"]}\t${c.name}` : c.name);
      return ok(found.map((c) => `${line(c)}\n`).join(""));
    }
    if (a === "rm") {
      for (const n of cmd.slice(3)) world.containers.delete(n);
      return ok();
    }
    if (a === "stop") {
      const c = world.containers.get(cmd.at(-1)!);
      if (c === undefined) return fail(`Error response from daemon: No such container: ${cmd.at(-1)}`);
      c.running = false;
      return ok();
    }
    if (a === "network") {
      if (b === "create") {
        world.networks.set(cmd.at(-1)!, { labels: labelsOf(cmd), internal: cmd.includes("--internal") && o.internal !== false, endpoints: new Set() });
        return ok(`${cmd.at(-1)}\n`);
      }
      if (b === "inspect") {
        const n = world.networks.get(cmd[3]!);
        if (n === undefined) return fail(`Error response from daemon: network ${cmd[3]} not found`);
        return ok(JSON.stringify([{ Name: cmd[3], Internal: n.internal, IPAM: { Config: [{ Subnet: o.subnet ?? "172.30.0.0/16" }] } }]));
      }
      if (b === "connect") {
        world.networks.get(cmd.at(-2)!)?.endpoints.add(cmd.at(-1)!);
        return ok();
      }
      if (b === "disconnect") {
        const n = world.networks.get(cmd.at(-2)!);
        if (n === undefined || !n.endpoints.delete(cmd.at(-1)!)) return fail("is not connected");
        return ok();
      }
      if (b === "ls") return ok([...world.networks].filter(([, n]) => matches(cmd, n.labels)).map(([name]) => `${name}\n`).join(""));
      if (b === "rm") {
        for (const name of cmd.slice(3)) {
          if ((world.networks.get(name)?.endpoints.size ?? 0) > 0) return fail(`Error response from daemon: error while removing network: network ${name} has active endpoints`);
          world.networks.delete(name);
        }
        return ok();
      }
    }
    if (a === "volume") {
      if (b === "create") {
        world.volumes.set(cmd.at(-1)!, { labels: labelsOf(cmd), owner: "0:0", files: new Map() });
        return ok(`${cmd.at(-1)}\n`);
      }
      if (b === "ls") return ok([...world.volumes].filter(([, v]) => matches(cmd, v.labels)).map(([name]) => `${name}\n`).join(""));
      if (b === "inspect") return world.volumes.has(cmd.at(-1)!) ? ok(`${cmd.at(-1)}\n`) : fail(`Error response from daemon: get ${cmd.at(-1)}: no such volume`);
      if (b === "rm") {
        for (const name of cmd.slice(3)) world.volumes.delete(name);
        return ok();
      }
    }
    if (a === "run") {
      if (cmd[2] === "-d") {
        const name = after(cmd, "--name")!;
        const work = volumeAt(cmd, "/work");
        const out = volumeAt(cmd, "/out");
        world.ownersAtRun = [work, out].map((v) => world.volumes.get(v ?? "")?.owner ?? "(none)");
        world.containers.set(name, { name, labels: labelsOf(cmd), running: true });
        const vol = world.volumes.get(out ?? "");
        for (const [f, x] of Object.entries(world.outputs)) vol?.files.set(f, x);
        return ok("0123456789abcdef\n");
      }
      if (cmd.at(-1) === CLEAN_SCRIPT) {
        // The run disk's cleanup helper: it empties each host dir bound at /w or /o.
        for (const dest of ["/w", "/o"]) {
          const dir = volumeAt(cmd, dest);
          if (dir !== undefined) for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
        }
        return ok();
      }
      if (after(cmd, "--entrypoint") === "chown") {
        for (const dest of ["/w", "/o"]) {
          const v = world.volumes.get(volumeAt(cmd, dest) ?? "");
          if (v === undefined) return fail("no such volume");
          v.owner = cmd.at(-3)!;
        }
        return ok();
      }
      if (cmd.includes(LIST_SCRIPT)) {
        const v = world.volumes.get(volumeAt(cmd, "/out") ?? "");
        if (v === undefined) return fail("Error response from daemon: no such volume");
        return ok([...v.files.keys()].map((n) => `${n}\0`).join(""));
      }
    }
    throw new Error(`fake: unexpected command ${joined}`);
  };

  const runBytes: RunDeps["runBytes"] = async (full, env) => {
    calls.push({ cmd: full, env, bytes: true });
    o.onCall?.(full);
    const cmd = unbounded(full);
    if (o.hangs?.(cmd)) return cmd === full ? new Promise<never>(() => {}) : { code: 137, stdout: new Uint8Array(), stderr: "" };
    if (cmd[0] === "env" && cmd[1] === "-i" && cmd.includes("cat-file")) {
      const found = Object.entries(o.tree ?? {}).find(([p]) => blobOf(p) === cmd.at(-1));
      return found === undefined ? { code: 128, stdout: new Uint8Array(), stderr: `fatal: Not a valid object name ${cmd.at(-1)}` } : { code: 0, stdout: new TextEncoder().encode(found[1]), stderr: "" };
    }
    if (!cmd.includes(COPY_SCRIPT)) throw new Error(`fake: unexpected byte command ${cmd.join(" ")}`);
    const v = world.volumes.get(volumeAt(cmd, "/out") ?? "");
    if (v === undefined) return { code: 125, stdout: new Uint8Array(), stderr: "no such volume" };
    const f = v.files.get(cmd.at(-2)!);
    if (f === undefined) return { code: 4, stdout: new Uint8Array(), stderr: "" };
    if (f.kind !== "file") return { code: 3, stdout: new Uint8Array(), stderr: "not a regular file" };
    return { code: 0, stdout: f.bytes.slice(0, Number(cmd.at(-1))), stderr: "" };
  };

  // What `docker logs --follow` streams, then `afterLogs` runs (as a supervisor finalizing the run would) before it exits 0.
  const live: { logs: string[]; afterLogs?: () => Promise<void> } = { logs: [] };
  const stream: RunDeps["stream"] = async (cmd, env, line) => {
    calls.push({ cmd, env, bytes: false });
    o.onCall?.(cmd);
    if (cmd[0] !== "docker" || cmd[1] !== "logs") throw new Error(`fake: unexpected streamed command ${cmd.join(" ")}`);
    for (const l of live.logs) line(l);
    await live.afterLogs?.();
    return 0;
  };

  const deps: RunDeps = {
    run,
    runBytes,
    stream,
    env: o.env ?? { HOME: tmp, PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_RUNTIME_DIR: xdg },
    user: o.user ?? "hapi",
    now: () => o.now ?? NOW,
    project,
    image: "hapi-factory/archon:0.12.1",
    egress: `${project}-egress-archon-1`,
    stateDir: join(tmp, "state"),
    diskDir,
    probeFs,
    root: REPO,
    buildDir,
    packDir: join(REPO, "archon", "workflows", "hapi"),
    runs: { max_live: 1, retention_days: 14, disk: { gb: 20, enforcement: "hard" }, poll_interval_s: 120, max_auto_rounds: 3, max_retries: 2, inputs_mb: 16, work_order_kb: 1024, phases: { verify: true, review: true, coderabbit: false, require_acceptance: true, fix_rounds_before_pr: 1, fix_rounds_on_pr: 1, round_turns: 40, round_usd: 1 }, ...o.runs, output_limits_mb: { bundle: 256, transcript: 64, decisions: 16, result: 4, ...o.runs?.output_limits_mb } },
    spawnDetached: async (argv) => void spawned.push(argv),
  };
  return {
    deps, calls, world, spawned, tmp, xdg,
    /** The lines `docker logs --follow` streams. */
    logs: live.logs,
    /** `live.afterLogs` runs once the streamed logs end, before `docker logs` exits. */
    live,
  };
}

/** The generated files a run binds (their contents don't matter here, only that they exist and hash). */
export const BUILD_FILES: Record<string, string> = {
  "pi/models.json": '{"providers":{}}\n',
  "pi/models-store.json": "{}\n",
  "pi/hapi-guard.json": '{"session":{}}\n',
  "pi/settings.json": "{}\n",
  "pi/extensions/hapi-guard.js": "// guard\n",
  "archon/config.yaml": "tiers: {}\n",
  "archon/run-config.yaml": "tiers: {}\n",
  "archon/gitconfig": "[user]\n",
  "archon/empty.env": "# empty\n",
  "archon/archon.env": "PI_OFFLINE=1\n",
  "claude/managed-settings.json": "{}\n",
  roster: "anthropic\n",
};

/**
 * A zone's env file, as `hapi secrets resolve` writes it, at `<xdg>/hapi/env/<zone>.env`. Values are built at run
 * time. The review zone's values here are its own, none of them the archon zone's, though the real zone reuses the
 * archon zone's Anthropic key (stack/secrets.yaml): so a test sees which zone's file a value came from.
 */
export function writeZoneEnv(xdg: string, zone: "archon" | "review", values: Record<string, string>): string {
  const dir = join(xdg, "hapi", "env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${zone}.env`);
  writeFileSync(path, envFileText(zone, values), { mode: 0o600 });
  return path;
}

/**
 * A workflow pack in a temp dir: hapi's own (archon/workflows/hapi/*.yaml), copied, plus a bash-only stand-in for
 * each of `names` the pack doesn't have yet (Task 11 writes factory-verify and factory-review).
 */
export function stubPack(names: string[]): string {
  const dir = tempDir("hapi-run-pack-");
  const pack = join(REPO, "archon", "workflows", "hapi");
  for (const f of readdirSync(pack).filter((n) => n.endsWith(".yaml"))) copyFileSync(join(pack, f), join(dir, f));
  for (const n of names) if (!existsSync(join(dir, `${n}.yaml`))) writeFileSync(join(dir, `${n}.yaml`), `name: ${n}\nnodes:\n  - id: noop\n    bash: "true"\n`);
  return dir;
}

/** A fake secret value, built at run time so no scanner sees a key in the source. */
export const fakeSecret = (name: string) => ["fake", "hapi", "run", name.toLowerCase(), "value", "0123456789"].join("-");

/** A source "repository": a directory with a .git dir that looks like a git dir (HEAD, objects/, refs/), so it is a source on its own too (the fake answers git). */
export function fakeRepo(tmp: string, name = "src"): string {
  const repo = join(tmp, name);
  for (const dir of ["objects", "refs"]) mkdirSync(join(repo, ".git", dir), { recursive: true });
  writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  return repo;
}

/** A valid work order (no egress_extra), with `over` merged in, written as YAML; returns its path. */
export function writeOrder(tmp: string, over: Record<string, unknown> = {}, name = "order.yaml"): string {
  const order = {
    id: "0003-check-run",
    lane: "direct",
    workflow: "hapi-check-run",
    risk: "low",
    roles: { implement: "small", review: "small" },
    budget: { usd: 3, turns: 10, minutes: 30 },
    pieces: [{ id: "check", files: ["README.md"], size: "small" }],
    verify: { smoke: false },
    egress_extra: [],
    trace: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    sources: [],
    ...over,
  };
  const path = join(tmp, name);
  writeFileSync(path, YAML.stringify(order));
  return path;
}

/** What a seeded run's volume dirs on the run disk hold, so the cleanup helper has something to empty. */
export const LEFT_BY_THE_RUN = "left-by-the-run";

/**
 * A run that already exists: its record, and (as asked) its container, network and volumes in the world, with their
 * dirs on the run disk, each holding LEFT_BY_THE_RUN.
 */
export async function seedRun(
  f: ReturnType<typeof fakeRun>,
  o: { id: string; repo?: string; key?: string; sha?: string; status?: RunRecord["status"]; running?: boolean; startedAt?: string; deadline?: string; outputs?: Record<string, FakeFile>; objects?: boolean } & Partial<RunRecord>,
): Promise<RunRecord> {
  const { deps, world } = f;
  const name = `${deps.project}-run-${o.id}`;
  const optional = ["kind", "parent", "round", "budgetUsd", "spendUsd", "roster", "policyHash", "retry", "turns", "model", "forgeRepo", "exitCode"] as const;
  const rec: RunRecord = {
    runId: o.id,
    key: o.key ?? "k".repeat(64),
    project: deps.project,
    repo: o.repo ?? "/srv/repo/.git",
    sha: o.sha ?? SHA,
    workOrder: o.workOrder ?? "0003-check-run",
    workflow: "hapi-check-run",
    container: name,
    network: name,
    volumes: { work: `${name}-work`, out: `${name}-out` },
    startedAt: o.startedAt ?? new Date(NOW.getTime() - 60_000).toISOString(),
    deadline: o.deadline ?? new Date(NOW.getTime() + 29 * 60_000).toISOString(),
    status: o.status ?? "live",
    ...(o.reason === undefined ? {} : { reason: o.reason }),
    ...(o.retryOf === undefined ? {} : { retryOf: o.retryOf }),
    ...(o.stopRequested === undefined ? {} : { stopRequested: o.stopRequested }),
    ...(o.harvestedAt === undefined ? {} : { harvestedAt: o.harvestedAt }),
    ...Object.fromEntries(optional.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])),
  };
  mkdirSync(recordDir(deps.stateDir, o.id), { recursive: true, mode: 0o700 });
  await writeRecord(deps.stateDir, rec);
  if (o.objects !== false) {
    const labels = { "org.hapi.run": o.id, "org.hapi.project": deps.project };
    world.containers.set(name, { name, labels, running: o.running ?? true });
    // The proxy its kind joined: egress-review for a review, the project's egress-archon for every other kind.
    const egress = o.kind === "review" ? `${deps.project}-egress-review-1` : deps.egress;
    world.networks.set(name, { labels, internal: true, endpoints: new Set([egress]) });
    world.volumes.set(`${name}-work`, { labels, owner: "1001:1001", files: new Map() });
    world.volumes.set(`${name}-out`, { labels, owner: "1001:1001", files: new Map(Object.entries(o.outputs ?? {})) });
    for (const v of [`${name}-work`, `${name}-out`]) {
      mkdirSync(join(deps.diskDir, v), { mode: 0o700 });
      writeFileSync(join(deps.diskDir, v, LEFT_BY_THE_RUN), "a run's file\n");
    }
  }
  return rec;
}

/** The outputs of a run that completed with no Pi node: result.json and a transcript. */
export function completedOutputs(status = "completed", transcript = '{"type":"workflow_start"}\n'): Record<string, FakeFile> {
  return {
    "result.json": file(JSON.stringify({ runs: { runs: [{ id: "f0e1d2c3-0000-4000-8000-000000000001" }] }, run: { status } })),
    "transcript.jsonl": file(transcript),
  };
}
