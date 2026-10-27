/**
 * Helpers for the stack's integration tests (HAPI_INT=1 only): a throwaway
 * Compose project of stack/compose.yaml under a unique name, the throwaway
 * curl clients that sit on its zone networks, and requests through (or
 * around) each zone's egress proxy.
 *
 * Everything a test creates carries the project's name: Compose's own
 * containers, networks and volumes, plus the label `org.hapi.int=<project>`
 * on every container started here with `docker run`. `Project.down` removes
 * exactly those, so other Docker workloads on the host are never touched.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";

export const REPO = resolve(import.meta.dir, "../..");
export const COMPOSE_FILE = join(REPO, "stack", "compose.yaml");

/** The throwaway client: curl 8.23.0 (with busybox nc), pinned by digest. */
export const CURL_IMAGE = "curlimages/curl:8.23.0@sha256:11e64e28c5f58c8d93ee95fcf22ac055f48b0bc440e0ce7d8013bbb5ad6aa8ac";

export type Zone = "hermes" | "archon" | "research";

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command; never throws on a non-zero exit. A command still running at `timeoutMs` is killed. */
export async function run(cmd: string[], o: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number } = {}): Promise<Result> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO,
    env: (o.env ?? process.env) as Record<string, string>,
    stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), o.timeoutMs ?? 120_000);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** Run, and throw with the command's stderr if it fails. */
export async function must(cmd: string[], o: Parameters<typeof run>[1] = {}): Promise<string> {
  const r = await run(cmd, o);
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/**
 * Whether this host reaches the internet: an HTTPS request to api.anthropic.com
 * gets any answer within 5 s. Tests that need it say so in their names.
 */
export async function online(): Promise<boolean> {
  try {
    await fetch("https://api.anthropic.com/", { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/** The stack's compose file, parsed (anchors merged). */
export function composeFile(): { name?: string; services: Record<string, Record<string, unknown>>; networks: Record<string, Record<string, unknown> | null>; volumes?: Record<string, unknown> } {
  return parse(readFileSync(COMPOSE_FILE, "utf8"), { merge: true });
}

/** A proxy's answer: the CONNECT reply's status for an https:// URL, or the HTTP status for an http:// one (0: none). */
export interface CurlResult {
  status: number;
  /** The origin's status, once a tunnel is up (0: none). */
  origin: number;
  exit: number;
  stderr: string;
}

/** A throwaway Compose project of stack/compose.yaml, with its own XDG_RUNTIME_DIR. */
export class Project {
  readonly name = `hapi-int-${crypto.randomUUID().slice(0, 8)}`;
  readonly root = mkdtempSync(join(tmpdir(), "hapi-stack-int-"));
  readonly xdg = join(this.root, "run");
  readonly overrideFile = join(this.root, "compose.override.yaml");
  private clients = new Map<string, string>();

  constructor(override: Record<string, unknown>) {
    mkdirSync(this.xdg, { mode: 0o700 });
    writeFileSync(this.overrideFile, stringify(override));
  }

  get env(): Record<string, string | undefined> {
    return { ...process.env, XDG_RUNTIME_DIR: this.xdg };
  }

  /** `docker compose` on this project: stack/compose.yaml plus the test's override. */
  compose(args: string[], timeoutMs = 300_000): Promise<Result> {
    return run(["docker", "compose", "-p", this.name, "-f", COMPOSE_FILE, "-f", this.overrideFile, ...args], { env: this.env, timeoutMs });
  }

  async mustCompose(args: string[], timeoutMs = 300_000): Promise<string> {
    const r = await this.compose(args, timeoutMs);
    if (r.code !== 0) throw new Error(`docker compose ${args.join(" ")} exited ${r.code}: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** The Docker network Compose made for `net` (e.g. "archon-net"). */
  network(net: string): string {
    return `${this.name}_${net}`;
  }

  /** `docker run -d` a labelled throwaway container; returns its name. */
  async start(suffix: string, args: string[]): Promise<string> {
    const name = `${this.name}-${suffix}`;
    await must(["docker", "run", "-d", "--name", name, "--label", `org.hapi.int=${this.name}`, ...args]);
    return name;
  }

  /** A long-lived curl container on `net` (a zone network, or "outbound"). */
  async client(net: string): Promise<string> {
    const found = this.clients.get(net);
    if (found) return found;
    const name = await this.start(`client-${net}`, ["--network", this.network(net), "--entrypoint", "sleep", CURL_IMAGE, "3600"]);
    this.clients.set(net, name);
    return name;
  }

  /** curl `url` from a client on `net`, through `proxy` (host:port), or directly when `proxy` is undefined. */
  async curl(net: string, url: string, proxy: string | undefined, extra: string[] = []): Promise<CurlResult> {
    const client = await this.client(net);
    const how = proxy === undefined ? ["--noproxy", "*"] : ["-x", `http://${proxy}`];
    const r = await run(["docker", "exec", client, "curl", "-g", "-sS", "-o", "/dev/null", "--max-time", "20", "-w", "%{http_connect} %{http_code}", ...how, ...extra, url], { timeoutMs: 40_000 });
    const [connect, code] = r.stdout.trim().split(" ").map(Number);
    const tunnel = url.startsWith("https://") && proxy !== undefined;
    return { status: tunnel ? connect! : code!, origin: tunnel ? code! : 0, exit: r.code, stderr: r.stderr.trim() };
  }

  /** curl through the zone's own proxy, from a client on the zone's network. */
  via(zone: Zone, url: string, extra: string[] = []): Promise<CurlResult> {
    return this.curl(`${zone}-net`, url, `egress-${zone}:3128`, extra);
  }

  /**
   * Send one request line to `proxy` exactly as written (curl would normalise
   * an IP literal first), and return the status code of the proxy's reply
   * (0: no reply within 10 s).
   */
  async raw(net: string, proxy: string, requestLine: string): Promise<number> {
    const client = await this.client(net);
    const [host, port] = proxy.split(":");
    const req = `${requestLine} HTTP/1.1\\r\\nHost: hapi-int\\r\\nConnection: close\\r\\n\\r\\n`;
    const r = await run(["docker", "exec", "-e", `REQ=${req}`, client, "sh", "-c", `printf '%b' "$REQ" | nc -w 10 ${host} ${port} | head -n 1`], { timeoutMs: 30_000 });
    return Number(/^HTTP\/1\.[01] (\d{3})/.exec(r.stdout)?.[1] ?? 0);
  }

  /** `docker compose exec -T` in a service; returns the result (never throws). */
  exec(service: string, cmd: string[]): Promise<Result> {
    return this.compose(["exec", "-T", service, ...cmd], 60_000);
  }

  /** Remove everything this project made: Compose's containers, networks and volumes, and the labelled containers. */
  async down(): Promise<void> {
    // The labelled containers first: Compose can't remove a network they are still attached to.
    const ids = (await run(["docker", "ps", "-aq", "--filter", `label=org.hapi.int=${this.name}`])).stdout.split("\n").filter(Boolean);
    if (ids.length > 0) await run(["docker", "rm", "-f", "-v", ...ids]);
    const r = await this.compose(["down", "-v", "--remove-orphans", "-t", "5"], 180_000);
    rmSync(this.root, { recursive: true, force: true });
    if (r.code !== 0) throw new Error(`docker compose -p ${this.name} down failed (exit ${r.code}): ${r.stderr.trim()}`);
  }

  /** What is left of this project in Docker: containers, networks and volumes named after it. */
  async leftovers(): Promise<string[]> {
    const list = async (kind: string[], field: string) =>
      (await run(["docker", ...kind, "--filter", `name=${this.name}`, "--format", `{{.${field}}}`])).stdout.split("\n").filter(Boolean);
    return [...(await list(["ps", "-a"], "Names")), ...(await list(["network", "ls"], "Name")), ...(await list(["volume", "ls"], "Name"))];
  }
}
