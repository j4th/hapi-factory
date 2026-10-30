/**
 * Fakes for tests/run: a recording Docker that keeps a small world (containers,
 * networks, volumes, and the files in a run's output volume) and answers the
 * commands src/run makes as Docker would, plus a temp state dir, runtime dir,
 * build dir, source repo and work order. No Docker, git, sudo or network: the
 * git calls (the source's HEAD, the bundle's heads) are answered too.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { envFileText } from "../../src/secrets/files";
import { COPY_SCRIPT, LIST_SCRIPT } from "../../src/run/copyout";
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
}

export const SHA = "4bf92f3577b34da6a3ce929d0e0e47364bf92f35";
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

export interface FakeOptions {
  project?: string;
  user?: string;
  env?: Record<string, string>;
  /** Commands (prefixes of the joined argv) that exit 1. */
  failing?: string[];
  /** The exit code of `timeout <s> docker wait <run>`: 0 (the run exited) or 124 (the deadline came first). */
  waitCode?: number;
  /** What `git bundle list-heads` prints. */
  heads?: string;
  /** The run network's subnet and whether it is internal, as `docker network inspect` says. */
  subnet?: string;
  internal?: boolean;
  runs?: Partial<RunDeps["runs"]>;
  now?: Date;
  /** Called before each command is answered. */
  onCall?: (cmd: string[]) => void;
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
  const world: World = { containers: new Map(), networks: new Map(), volumes: new Map(), outputs: {} };
  const calls: Call[] = [];
  const spawned: string[][] = [];
  const project = o.project ?? "hapi";

  const run: RunDeps["run"] = async (cmd, opts) => {
    calls.push({ cmd, env: opts.env, bytes: false });
    o.onCall?.(cmd);
    const joined = cmd.join(" ");
    if (o.failing?.some((f) => joined.startsWith(f))) return fail("boom");
    if (cmd[0] === "sudo") return ok();
    if (cmd[0] === "timeout" && cmd[2] === "docker" && cmd[3] === "wait") {
      const c = world.containers.get(cmd[4]!);
      if (c === undefined) return fail(`Error response from daemon: No such container: ${cmd[4]}`);
      const code = o.waitCode ?? 0;
      if (code === 0) c.running = false;
      return code === 0 ? ok("0\n") : fail("", code);
    }
    if (cmd[0] === "env" && cmd[1] === "-i") {
      if (cmd.includes("list-heads")) return ok(o.heads ?? `${SHA} HEAD\n`);
      if (cmd.includes("rev-parse")) return ok(`${SHA}\n`);
      throw new Error(`fake: unexpected command ${joined}`);
    }
    if (cmd[0] !== "docker") throw new Error(`fake: unexpected command ${joined}`);
    const [, a, b] = cmd;
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

  const runBytes: RunDeps["runBytes"] = async (cmd, env) => {
    calls.push({ cmd, env, bytes: true });
    o.onCall?.(cmd);
    if (!cmd.includes(COPY_SCRIPT)) throw new Error(`fake: unexpected byte command ${cmd.join(" ")}`);
    const v = world.volumes.get(volumeAt(cmd, "/out") ?? "");
    if (v === undefined) return { code: 125, stdout: new Uint8Array(), stderr: "no such volume" };
    const f = v.files.get(cmd.at(-2)!);
    if (f === undefined) return { code: 4, stdout: new Uint8Array(), stderr: "" };
    if (f.kind !== "file") return { code: 3, stdout: new Uint8Array(), stderr: "not a regular file" };
    return { code: 0, stdout: f.bytes.slice(0, Number(cmd.at(-1))), stderr: "" };
  };

  const deps: RunDeps = {
    run,
    runBytes,
    env: o.env ?? { HOME: tmp, PATH: process.env.PATH ?? "/usr/bin:/bin", XDG_RUNTIME_DIR: xdg },
    user: o.user ?? "hapi",
    now: () => o.now ?? NOW,
    project,
    image: "hapi-factory/archon:0.12.1",
    egress: `${project}-egress-archon-1`,
    stateDir: join(tmp, "state"),
    root: REPO,
    buildDir,
    packDir: join(REPO, "archon", "workflows", "hapi"),
    runs: { max_live: 1, retention_days: 14, ...o.runs, output_limits_mb: { bundle: 256, transcript: 64, decisions: 16, result: 4, ...o.runs?.output_limits_mb } },
    spawnDetached: (argv) => void spawned.push(argv),
  };
  return { deps, calls, world, spawned, tmp, xdg };
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
};

/** The archon zone's env file, as `hapi secrets resolve` writes it, at `<xdg>/hapi/env/archon.env`. Values are built at run time. */
export function writeArchonEnv(xdg: string, values: Record<string, string>): string {
  const dir = join(xdg, "hapi", "env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "archon.env");
  writeFileSync(path, envFileText("archon", values), { mode: 0o600 });
  return path;
}

/** A fake secret value, built at run time so no scanner sees a key in the source. */
export const fakeSecret = (name: string) => ["fake", "hapi", "run", name.toLowerCase(), "value", "0123456789"].join("-");

/** A source "repository": a directory with a .git dir (the fake answers git). */
export function fakeRepo(tmp: string, name = "src"): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
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

/** A run that already exists: its record, and (as asked) its container, network and volumes in the world. */
export async function seedRun(
  f: ReturnType<typeof fakeRun>,
  o: { id: string; repo?: string; key?: string; status?: RunRecord["status"]; running?: boolean; startedAt?: string; deadline?: string; outputs?: Record<string, FakeFile>; objects?: boolean } & Partial<RunRecord>,
): Promise<RunRecord> {
  const { deps, world } = f;
  const name = `${deps.project}-run-${o.id}`;
  const rec: RunRecord = {
    runId: o.id,
    key: o.key ?? "k".repeat(64),
    project: deps.project,
    repo: o.repo ?? "/srv/repo/.git",
    sha: SHA,
    workOrder: "0003-check-run",
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
  };
  mkdirSync(recordDir(deps.stateDir, o.id), { recursive: true, mode: 0o700 });
  await writeRecord(deps.stateDir, rec);
  if (o.objects !== false) {
    const labels = { "org.hapi.run": o.id, "org.hapi.project": deps.project };
    world.containers.set(name, { name, labels, running: o.running ?? true });
    world.networks.set(name, { labels, internal: true, endpoints: new Set([deps.egress]) });
    world.volumes.set(`${name}-work`, { labels, owner: "1001:1001", files: new Map() });
    world.volumes.set(`${name}-out`, { labels, owner: "1001:1001", files: new Map(Object.entries(o.outputs ?? {})) });
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
