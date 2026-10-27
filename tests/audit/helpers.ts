/**
 * A clean world for `runAudit`, made of fakes: a deployed build (a fresh
 * `buildAll` into a temp dir), the five containers `docker inspect` would
 * print for a stack `hapi stack up` started from it, Archon's and Hermes's
 * own validation output for it (shapes captured from the pinned images,
 * tests/audit/fixtures/), and a GitHub repo whose rulesets match
 * docs/runbooks/github-apps.md. Every command goes through a fake `exec` and
 * every request through a fake `fetch`, so no test needs Docker, the network,
 * a real secret or another repo. A test breaks one thing and checks the audit
 * names it.
 */
import { spyOn } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import type { AuditContext, ExecResult } from "../../src/audit/types";
import { buildAll } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { envFileText } from "../../src/secrets/files";
import { serviceEnvironment } from "../../src/stack/env";
import { buildDigest } from "../../src/stack/up";

export const REPO = resolve(import.meta.dir, "../..");
export const FIXTURES = join(import.meta.dir, "fixtures");
export const API = "https://api.github.com";
export const OWNER = "example-owner";
export const NAME = "hapi-factory";

const temps: string[] = [];
const restores: (() => void)[] = [];

/** Undo everything: call it from afterEach. */
export function cleanup(): void {
  for (const r of restores.splice(0)) r();
  for (const d of temps.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
}

/** A fresh temp directory (mode 0700), removed by `cleanup`. */
export function tempDir(prefix = "hapi-audit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  temps.push(dir);
  return dir;
}

/** Capture console.log and console.error until `cleanup`. */
export function capture(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  restores.push(() => log.mockRestore(), () => error.mockRestore());
  return { out, err };
}

export const readJson = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

/** Every file under `dir`, relative to it, sorted. */
export function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

/** Hermes's load_config: its defaults deep-merged with the user's config. */
export function hermesMerge(base: unknown, over: unknown): unknown {
  if (base === null || typeof base !== "object" || Array.isArray(base) || over === null || typeof over !== "object" || Array.isArray(over)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) out[k] = k in out ? hermesMerge(out[k], v) : v;
  return out;
}

export interface Container {
  Id: string;
  Name: string;
  State: { Running: boolean };
  Path: string;
  Args: string[];
  Config: { Labels: Record<string, string>; Env: string[]; Cmd: string[] | null; Entrypoint: string[] | null };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
}

export interface Reply {
  status: number;
  body?: unknown;
}
export interface FetchCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export interface World {
  ctx: AuditContext;
  /** The deployed build/ (a fresh anthropic-roster build). */
  build: string;
  /** Its digest, as `hapi stack up` labels the containers. */
  digest: string;
  containers: Container[];
  /** What the archon validation run prints: Archon's `validate workflows --json` output (an object or raw text). */
  archonValidate: { code: number; out: unknown };
  /** What the Hermes validation run prints (Hermes's defaults, effective config, issues). */
  hermes: { defaults: unknown; issues: { severity: string; message: string }[]; config_version: number; latest_config_version: number; effective?: unknown };
  /** Images `docker image inspect` finds. */
  images: Set<string>;
  /** Every command run, and every request made. */
  calls: string[][];
  requests: FetchCall[];
  /** GitHub routes: "METHOD url" -> reply. */
  routes: Record<string, Reply | ((c: FetchCall) => Reply)>;
  /** Fails `docker` itself (not installed, or no daemon). */
  dockerDown?: boolean;
}

/** The pinned images stack/compose.yaml builds the zone services as. */
export const ARCHON_IMAGE = "hapi-factory/archon:0.12.1";
export const HERMES_IMAGE = "hapi-factory/hermes:v0.22.5";

/** The rulesets of docs/runbooks/github-apps.md, as GitHub returns them, with ids. */
export function goodRulesets(): Record<string, unknown>[] {
  const main = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
  return [
    {
      id: 1,
      name: "main-protect",
      target: "branch",
      enforcement: "active",
      conditions: main,
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "ci", integration_id: 15368 }] } },
      ],
    },
    {
      id: 2,
      name: "main-review",
      target: "branch",
      enforcement: "active",
      conditions: main,
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
      rules: [
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: false, required_review_thread_resolution: false },
        },
        { type: "update" },
      ],
    },
    {
      id: 3,
      name: "agent-branch-scope",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH", "refs/heads/plan/**", "refs/heads/factory/**"] } },
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    },
    {
      id: 4,
      name: "tags-admin-only",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
      bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }],
    },
  ];
}

/** The rules GitHub reports for `main` given these rulesets: every rule of each active branch ruleset that targets the default branch. */
export function branchRules(rulesets: Record<string, any>[]): unknown[] {
  return rulesets
    .filter((r) => r.target === "branch" && r.enforcement === "active" && (r.conditions.ref_name.include as string[]).includes("~DEFAULT_BRANCH"))
    .flatMap((r) => (r.rules as Record<string, unknown>[]).map((rule) => ({ ...rule, ruleset_source_type: "Repository", ruleset_source: `${OWNER}/${NAME}`, ruleset_id: r.id })));
}

/** A throwaway RSA key for the fake Apps (made per run; no key is committed). */
export const APP_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
}).privateKey;

export const APP_IDS = { planner: 1001, factory: 1002 } as const;

/** Which App a request's JWT is for: the fake JWTs carry the App id in `iss`, readable without the key. */
export function appOf(c: FetchCall): "planner" | "factory" {
  const payload = JSON.parse(Buffer.from((c.headers.authorization ?? "").replace(/^Bearer /, "").split(".")[1] ?? "", "base64url").toString() || "{}");
  return payload.iss === APP_IDS.factory ? "factory" : "planner";
}

/** The token the fake GitHub mints for the audit (never to be printed). */
export const MINTED_TOKEN = "fake-installation-token-audit";

/** The routes of a GitHub repo set up as the runbook says, read with a token file or with an App. */
export function githubRoutes(o: { rulesets?: Record<string, any>[]; workflows?: Record<string, string>; appPermissions?: Record<string, Record<string, string>> } = {}): Record<string, Reply | ((c: FetchCall) => Reply)> {
  const rulesets = o.rulesets ?? goodRulesets();
  const repo = `${API}/repos/${OWNER}/${NAME}`;
  const routes: Record<string, Reply | ((c: FetchCall) => Reply)> = {
    [`GET ${repo}/rules/branches/main?per_page=100&page=1`]: { status: 200, body: branchRules(rulesets) },
    [`GET ${repo}/rulesets?per_page=100&page=1`]: { status: 200, body: rulesets.map(({ rules, conditions, bypass_actors, ...summary }) => summary) },
    [`GET ${repo}/contents/.github/workflows`]: {
      status: 200,
      body: Object.keys(o.workflows ?? {}).map((name) => ({ type: "file", name, path: `.github/workflows/${name}` })),
    },
    [`DELETE ${API}/installation/token`]: { status: 204 },
  };
  for (const r of rulesets) routes[`GET ${repo}/rulesets/${r.id}`] = { status: 200, body: r };
  for (const [name, text] of Object.entries(o.workflows ?? {})) {
    routes[`GET ${repo}/contents/.github/workflows/${name}`] = { status: 200, body: { type: "file", name, encoding: "base64", content: Buffer.from(text).toString("base64") } };
  }
  const perms = o.appPermissions ?? {
    planner: { contents: "write", pull_requests: "write", issues: "read", metadata: "read" },
    factory: { contents: "write", pull_requests: "write", metadata: "read" },
  };
  const app = appOf;
  routes[`GET ${API}/app`] = (c) => ({ status: 200, body: { id: APP_IDS[app(c)], slug: `hapi-${app(c)}`, permissions: perms[app(c)], events: [] } });
  routes[`GET ${repo}/installation`] = (c) => ({
    status: 200,
    body: { id: app(c) === "planner" ? 11 : 12, app_id: APP_IDS[app(c)], permissions: perms[app(c)], repository_selection: "selected", suspended_at: null },
  });
  for (const id of [11, 12]) {
    routes[`POST ${API}/app/installations/${id}/access_tokens`] = {
      status: 201,
      body: {
        token: MINTED_TOKEN,
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read", metadata: "read" },
        repository_selection: "selected",
        repositories: [{ name: NAME, full_name: `${OWNER}/${NAME}` }],
      },
    };
  }
  return routes;
}

/** Write a host.env with both Apps' ids and keys under a fresh XDG_RUNTIME_DIR, as `hapi secrets resolve` would. */
export function hostEnv(env: Record<string, string>): void {
  const dir = join(env.XDG_RUNTIME_DIR!, "hapi", "env");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(env.XDG_RUNTIME_DIR!, "hapi"), 0o700);
  writeFileSync(
    join(dir, "host.env"),
    envFileText("host", {
      HAPI_PLANNER_APP_ID: String(APP_IDS.planner),
      HAPI_PLANNER_APP_PRIVATE_KEY: APP_KEY,
      HAPI_FACTORY_APP_ID: String(APP_IDS.factory),
      HAPI_FACTORY_APP_PRIVATE_KEY: APP_KEY,
    }),
    { mode: 0o600 },
  );
}

/**
 * A clean world: everything as `hapi stack up` leaves it. `o.repos` adds the
 * repo above to `--repo`; `o.workflows` its workflow files.
 */
export async function cleanWorld(o: { repos?: boolean; workflows?: Record<string, string> } = {}): Promise<World> {
  const home = tempDir("hapi-audit-home-");
  const deployedRoot = tempDir("hapi-audit-deployed-");
  const build = join(deployedRoot, "build");
  const written = await buildAll(loadPolicy(join(REPO, "policy")), build, { roster: "anthropic" });
  const digest = buildDigest(
    written.map((p) => relative(deployedRoot, p)),
    deployedRoot,
  );
  const labels = (service: string) => ({
    "com.docker.compose.project": "hapi",
    "com.docker.compose.service": service,
    "org.hapi.stack": "hapi-factory",
    "org.hapi.started-by": "hapi",
    "org.hapi.dev-override": "0",
    "org.hapi.build-sha256": digest,
  });
  const envList = (e: Record<string, string>) => [...Object.entries(e).map(([k, v]) => `${k}=${v}`), "PATH=/usr/local/bin:/usr/bin:/bin"];
  const containers: Container[] = [
    ...["egress-hermes", "egress-archon", "egress-research"].map(
      (service): Container => ({
        Id: `id-${service}`,
        Name: `/hapi-${service}-1`,
        State: { Running: true },
        Path: "/usr/sbin/squid-gnutls",
        Args: ["-N", "-f", "/etc/squid/hapi.conf"],
        Config: { Labels: labels(service), Env: ["PATH=/usr/bin"], Cmd: ["-N", "-f", "/etc/squid/hapi.conf"], Entrypoint: ["/usr/sbin/squid-gnutls"] },
        Mounts: [{ Type: "bind", Source: join(build, "egress", `${service.slice(7)}.squid.conf`), Destination: "/etc/squid/hapi.conf", RW: false }],
      }),
    ),
    {
      Id: "id-hermes",
      Name: "/hapi-hermes-1",
      State: { Running: true },
      Path: "/opt/hermes/docker/entrypoint-dispatch.sh",
      Args: ["gateway", "run"],
      Config: { Labels: labels("hermes"), Env: envList(serviceEnvironment("hermes")), Cmd: ["gateway", "run"], Entrypoint: ["/opt/hermes/docker/entrypoint-dispatch.sh"] },
      Mounts: [
        { Type: "volume", Source: "/var/lib/docker/volumes/hapi_hermes-data/_data", Destination: "/opt/data", RW: true },
        { Type: "bind", Source: join(build, "hermes", "config.yaml"), Destination: "/opt/data/config.yaml", RW: false },
      ],
    },
    {
      Id: "id-archon",
      Name: "/hapi-archon-1",
      State: { Running: true },
      Path: "docker-entrypoint.sh",
      Args: [],
      Config: { Labels: labels("archon"), Env: envList(serviceEnvironment("archon")), Cmd: null, Entrypoint: ["docker-entrypoint.sh"] },
      Mounts: [
        { Type: "volume", Source: "/var/lib/docker/volumes/hapi_archon-data/_data", Destination: "/.archon", RW: true },
        { Type: "bind", Source: join(build, "archon", "config.yaml"), Destination: "/.archon/config.yaml", RW: false },
        { Type: "bind", Source: join(build, "pi"), Destination: "/opt/hapi/pi-agent", RW: false },
      ],
    },
  ];
  const ours = YAML.parse(readFileSync(join(build, "hermes", "config.yaml"), "utf8"));
  const defaults = readJson("hermes-v0.22.5-defaults.json");
  const env: Record<string, string> = { HOME: home, XDG_RUNTIME_DIR: tempDir("hapi-audit-xdg-"), PATH: "/usr/bin" };
  const world: World = {
    build,
    digest,
    containers,
    archonValidate: { code: 0, out: readJson("archon-validate-v0.12.1.json") },
    hermes: { defaults, issues: [], config_version: 0, latest_config_version: 51, effective: hermesMerge(defaults, ours) },
    images: new Set([ARCHON_IMAGE, HERMES_IMAGE]),
    calls: [],
    requests: [],
    routes: githubRoutes({ workflows: o.workflows ?? {} }),
    ctx: undefined as unknown as AuditContext,
  };
  world.ctx = {
    root: REPO,
    policyDir: join(REPO, "policy"),
    buildDir: build,
    repos: o.repos ? [{ owner: OWNER, name: NAME }] : [],
    strict: false,
    dev: false,
    env,
    user: "hapi",
    exec: async (cmd) => fakeExec(world, cmd),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const call: FetchCall = { method: init.method ?? "GET", url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()) };
      world.requests.push(call);
      const route = world.routes[`${call.method} ${call.url}`];
      if (route === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      const reply = typeof route === "function" ? route(call) : route;
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch,
    now: () => Date.UTC(2026, 9, 27),
  };
  return world;
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

/** Archon's `ai alias list --json` and `ai tier list --json` for a config: what Archon v0.12.1 prints when it reads every binding. */
function archonBindings(configFile: string): { aliases: unknown; tiers: unknown } {
  const cfg = YAML.parse(readFileSync(configFile, "utf8")) as { aliases?: Record<string, unknown>; tiers?: Record<string, unknown> };
  return {
    aliases: { aliases: Object.entries(cfg.aliases ?? {}).map(([name, b]) => ({ name, install: b, user: null, effective: b })) },
    tiers: { userDefaultAssistant: null, tiers: Object.entries(cfg.tiers ?? {}).map(([tier, b]) => ({ tier, configured: b, user: null, default: null, effective: b })) },
  };
}

function fakeExec(w: World, cmd: string[]): ExecResult {
  w.calls.push(cmd);
  if (cmd[0] === "getent") return ok("hapi:x:1001:1001::/home/hapi:/bin/bash\n");
  if (cmd[0] !== "docker") return { code: 127, stdout: "", stderr: `${cmd[0]}: not found` };
  if (w.dockerDown) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock. Is the docker daemon running?" };
  if (cmd[1] === "ps") return ok(w.containers.map((c) => c.Id).join("\n") + (w.containers.length ? "\n" : ""));
  if (cmd[1] === "inspect") {
    const ids = cmd.slice(2);
    return ok(JSON.stringify(w.containers.filter((c) => ids.includes(c.Id))));
  }
  if (cmd[1] === "image" && cmd[2] === "inspect") {
    const image = cmd.at(-1)!;
    return w.images.has(image) ? ok("sha256:0123\n") : { code: 1, stdout: "", stderr: `Error response from daemon: No such image: ${image}` };
  }
  if (cmd[1] === "run") {
    if (cmd.some((a) => a.includes("archon"))) {
      const mount = cmd.find((a) => a.endsWith(":/.archon/config.yaml:ro"))!;
      const b = archonBindings(mount.slice(0, -":/.archon/config.yaml:ro".length));
      const v = w.archonValidate;
      const text = typeof v.out === "string" ? v.out : JSON.stringify(v.out);
      return ok(`${text}\n@@hapi-audit ${v.code}@@\n${JSON.stringify(b.aliases)}\n@@hapi-audit 0@@\n${JSON.stringify(b.tiers)}\n@@hapi-audit 0@@\n`);
    }
    if (cmd.some((a) => a.includes("hermes"))) return ok(`${JSON.stringify(w.hermes)}\n`);
  }
  return { code: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
}

/** The result for `id` (exactly one). */
export function only<T extends { id: string }>(results: T[], id: string): T {
  const found = results.filter((r) => r.id === id);
  if (found.length !== 1) throw new Error(`expected one ${id} result, got ${found.length}: ${JSON.stringify(results.map((r) => r.id))}`);
  return found[0]!;
}

/** A copy of the checkout files pins.versions reads (mise.toml, stack/), to break one. */
export function rootCopy(): string {
  const root = tempDir("hapi-audit-root-");
  for (const f of ["mise.toml", "stack/compose.yaml", "stack/hermes/Dockerfile", "stack/archon/Dockerfile", "stack/secrets.yaml"]) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), readFileSync(join(REPO, f)));
  }
  return root;
}
