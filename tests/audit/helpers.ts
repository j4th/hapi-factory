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
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import type { AuditContext, ExecResult } from "../../src/audit/types";
import { buildAll } from "../../src/generate/index";
import { loadPolicy } from "../../src/policy/load";
import { type FsProbe, GIB } from "../../src/run/disk";
import { RUN_DISK } from "../../src/run/locks";
import { envFileText } from "../../src/secrets/files";
import { loadManifest, MANIFEST_FILE } from "../../src/secrets/manifest";
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
  Config: { Labels: Record<string, string>; Env: string[]; Cmd: string[] | null; Entrypoint: string[] | null; User?: string; StopTimeout?: number };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
  NetworkSettings?: { Networks: Record<string, unknown> };
  HostConfig?: { NetworkMode?: string; Init?: boolean; PortBindings: Record<string, unknown>; Tmpfs?: Record<string, string>; CapDrop?: string[]; ReadonlyRootfs?: boolean; SecurityOpt?: string[]; PidsLimit?: number; Memory?: number };
}

/** A network as `docker network inspect` prints one (the fields the audit reads). */
export interface Network {
  Name: string;
  Internal: boolean;
  IPAM: { Config: { Subnet: string }[] };
  /** By container id: each endpoint's container name. */
  Containers: Record<string, { Name: string }>;
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
  /** The networks `docker network inspect` finds, by name: each run container's own (`runContainer` adds it). */
  networks: Map<string, Network>;
  /** What the archon validation run prints: Archon's `validate workflows --json` output (an object or raw text). */
  archonValidate: { code: number; out: unknown };
  /** What the `assistants.pi.enableExtensions` read-back prints (and its exit code). */
  enableExtensions: { code: number; out: string };
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
  /**
   * What git says about the checkout: `rev-parse --show-prefix` (exit 0), `ls-files` (the tracked paths under
   * private/), `ls-files --others` (the untracked ones `git add -A` would stage) and `check-ignore` (exit 0, with
   * this source line for `-v`, or exit 1 when it is undefined).
   */
  git: { prefix: string; tracked: string[]; untracked: string[]; ignoredBy: string | undefined; fail?: { code: number; stderr: string } };
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
          parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: true, required_review_thread_resolution: false },
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

/** Docker's data root as `docker info --format {{.DockerRootDir}}` prints it for hapi's rootless Docker. */
export const DOCKER_ROOT = "/home/hapi/.local/share/docker";

/** The filesystems a clean world's run disk check sees: the run disk on its own (dev 2), its parent (dev 1) and Docker's data root (dev 3). */
export const goodDisks: FsProbe = (path) => {
  if (path === RUN_DISK) return { dev: 2, bytes: 19.5 * GIB, writable: true };
  if (path === dirname(RUN_DISK)) return { dev: 1, bytes: 500 * GIB, writable: true };
  if (path === DOCKER_ROOT) return { dev: 3, bytes: 500 * GIB, writable: true };
  return undefined;
};

/** The settings `hapi new-repo` sets (src/newrepo/steps.ts, step 5), as GitHub's GETs return them to the repo's admin. */
export function goodSettings() {
  return {
    repo: {
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: false,
      allow_auto_merge: false,
      delete_branch_on_merge: true,
      merge_commit_title: "MERGE_MESSAGE",
      merge_commit_message: "PR_TITLE",
      security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" }, dependabot_security_updates: { status: "disabled" } },
    } as Record<string, unknown>,
    workflow: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false } as Record<string, unknown>,
    actions: { enabled: true, allowed_actions: "selected", sha_pinning_required: true, selected_actions_url: `${API}/repos/${OWNER}/${NAME}/actions/permissions/selected-actions` } as Record<string, unknown>,
    selected: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["jdx/mise-action@*", `${OWNER}/hapi-factory/.github/workflows/gates.yml@*`] } as Record<string, unknown>,
    fork: { approval_policy: "all_external_contributors" } as Record<string, unknown>,
    pvr: { enabled: true } as Record<string, unknown>,
  };
}
export type Settings = ReturnType<typeof goodSettings>;

/** The five labels `hapi new-repo` makes, by name. */
export const LABEL_NAMES = ["lane:planning", "lane:factory", "lane:direct", "hapi:rework", "hapi:flagged"];

/**
 * A copy of policy/ whose repos.yaml registers `OWNER/NAME`, so the contract's checks (github.repo-settings,
 * github.labels) apply to it. Removed by `cleanup`.
 */
export function registeredPolicy(): string {
  const dir = join(tempDir("hapi-audit-policy-"), "policy");
  cpSync(join(REPO, "policy"), dir, { recursive: true });
  writeFileSync(join(dir, "repos.yaml"), `installations: { planner: 11, factory: 12 }\nrepos:\n  ${OWNER}/${NAME}: { registered: "2026-10-31" }\n`);
  return dir;
}

/** The routes of a GitHub repo set up as the runbook says, read with a token file or with an App. */
export function githubRoutes(
  o: {
    rulesets?: Record<string, any>[];
    workflows?: Record<string, string>;
    appPermissions?: Record<string, Record<string, string>>;
    defaultBranch?: string | null;
    settings?: Settings;
    labels?: string[];
  } = {},
): Record<string, Reply | ((c: FetchCall) => Reply)> {
  const rulesets = o.rulesets ?? goodRulesets();
  const repo = `${API}/repos/${OWNER}/${NAME}`;
  const defaultBranch = o.defaultBranch === undefined ? "main" : o.defaultBranch;
  const settings = o.settings ?? goodSettings();
  const routes: Record<string, Reply | ((c: FetchCall) => Reply)> = {
    // null: GitHub's answer without default_branch.
    [`GET ${repo}`]: { status: 200, body: { full_name: `${OWNER}/${NAME}`, ...(defaultBranch === null ? {} : { default_branch: defaultBranch }), ...settings.repo } },
    [`GET ${repo}/actions/permissions/workflow`]: { status: 200, body: settings.workflow },
    [`GET ${repo}/actions/permissions`]: { status: 200, body: settings.actions },
    [`GET ${repo}/actions/permissions/selected-actions`]: { status: 200, body: settings.selected },
    [`GET ${repo}/actions/permissions/fork-pr-contributor-approval`]: { status: 200, body: settings.fork },
    [`GET ${repo}/private-vulnerability-reporting`]: { status: 200, body: settings.pvr },
    [`GET ${repo}/labels?per_page=100&page=1`]: { status: 200, body: (o.labels ?? LABEL_NAMES).map((name, i) => ({ id: i + 1, name, color: "ededed", description: "" })) },
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
    factory: { contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
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
 * The review zone's env names, a fixture: Task 9 adds the zone to stack/secrets.yaml, so nothing here needs it. Its
 * Claude Code keys (`ANTHROPIC_API_KEY`, which Claude Code sends, and `CLAUDE_API_KEY`, Archon's name for it) and
 * CodeRabbit's.
 */
export const REVIEW_ZONE_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CODERABBIT_API_KEY"];

/** Each zone's env names, as the clean world gives the audit: stack/secrets.yaml's zones, plus the fixture review zone. */
export function zoneKeys(): Record<string, string[]> {
  const manifest = loadManifest(join(REPO, MANIFEST_FILE));
  return { ...Object.fromEntries(Object.entries(manifest).map(([zone, names]) => [zone, Object.keys(names ?? {})])), review: REVIEW_ZONE_KEYS };
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
  ];
  const ours = YAML.parse(readFileSync(join(build, "hermes", "config.yaml"), "utf8"));
  const defaults = readJson("hermes-v0.22.5-defaults.json");
  const env: Record<string, string> = { HOME: home, XDG_RUNTIME_DIR: tempDir("hapi-audit-xdg-"), PATH: "/usr/bin" };
  const world: World = {
    build,
    digest,
    containers,
    networks: new Map(),
    archonValidate: { code: 0, out: readJson("archon-validate-v0.12.1.json") },
    enableExtensions: { code: 0, out: "true" },
    hermes: { defaults, issues: [], config_version: 0, latest_config_version: 51, effective: hermesMerge(defaults, ours) },
    images: new Set([ARCHON_IMAGE, HERMES_IMAGE]),
    calls: [],
    requests: [],
    routes: githubRoutes({ workflows: o.workflows ?? {} }),
    git: { prefix: "", tracked: [], untracked: [], ignoredBy: ".gitignore:11:private/" },
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
    probeFs: goodDisks,
    zoneKeys: zoneKeys(),
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

/** The run kinds, as the audit's fixtures name them. */
export type Kind = "worker" | "verify" | "review" | "fix";

/**
 * A live run container as `docker inspect` prints one: the labels and mounts a launcher-made container of `over.kind`
 * has (src/run/spec.ts; the Compose labels blank), Archon's whole environment with its kind's proxy, its prelude's
 * command, and no published port. With no kind it has no `org.hapi.kind` label, as a Plan 02 worker had. Written out
 * here, not read from `runArgs` or `kindProfile`, so the check's expectation is checked against an independent list:
 * - worker and fix: run.sh, the work order's workflow, egress-archon; a fix's inputs dir too;
 * - verify: verify.sh, factory-verify, egress-archon, no inputs;
 * - review: review.sh, factory-review, egress-review, its inputs dir.
 * It is on its own network, named as it is, which this adds to `w.networks`: internal, on a private subnet, and
 * holding the container and its kind's proxy (`hapi-egress-archon-1`, or `hapi-egress-review-1` for a review).
 */
export function runContainer(w: World, id = "ab12cd34ef56", over: { labels?: Record<string, string>; kind?: Kind } = {}): Container {
  const name = `hapi-run-${id}`;
  const kind = over.kind ?? "worker";
  const egress = kind === "review" ? "hapi-egress-review-1" : "hapi-egress-archon-1";
  w.networks.set(name, { Name: name, Internal: true, IPAM: { Config: [{ Subnet: "172.30.0.0/16" }] }, Containers: { [`id-run-${id}`]: { Name: name }, [`id-${egress}`]: { Name: egress } } });
  const prelude = { worker: "run.sh", fix: "run.sh", verify: "verify.sh", review: "review.sh" }[kind];
  const workflow = { worker: "hapi-check-run", fix: "hapi-check-run", verify: "factory-verify", review: "factory-review" }[kind];
  const env = { ...serviceEnvironment("archon") };
  if (kind === "review") for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[k] = "http://egress-review:3128";
  const bind = (Source: string, Destination: string) => ({ Type: "bind", Source, Destination, RW: false });
  return {
    Id: `id-run-${id}`,
    Name: `/${name}`,
    State: { Running: true },
    Path: "sh",
    Args: [`/opt/hapi/${prelude}`, workflow],
    Config: {
      Labels: {
        "com.docker.compose.project": "",
        "com.docker.compose.service": "",
        "com.docker.compose.version": "",
        "org.hapi.run": id,
        "org.hapi.project": "hapi",
        ...(over.kind === undefined ? {} : { "org.hapi.kind": over.kind }),
        "org.hapi.stack": "hapi-factory",
        "org.hapi.started-by": "hapi",
        "org.hapi.dev-override": "0",
        "org.hapi.build-sha256": w.digest,
        ...over.labels,
      },
      Env: [...Object.entries(env).map(([k, v]) => `${k}=${v}`), "PATH=/usr/local/bin:/usr/bin:/bin"],
      Cmd: null,
      Entrypoint: ["sh"],
      User: "1001:1001",
      // `--stop-timeout` is in Config, not HostConfig (Docker 29.9.2).
      StopTimeout: 30,
    },
    Mounts: [
      // Docker 29.9.2 lists a --tmpfs only in HostConfig.Tmpfs, never here (probed by the task 9 review).
      ...["models.json", "models-store.json", "hapi-guard.json", "settings.json", "extensions"].map((f) => bind(join(w.build, "pi", f), `/opt/hapi/pi-agent/${f}`)),
      bind(join(w.build, "archon", "config.yaml"), "/.archon/config.yaml"),
      bind(join(w.build, "archon", "empty.env"), "/.archon/.env"),
      bind(join(REPO, "archon", "workflows", "hapi"), "/.archon/workflows/hapi"),
      bind(join(w.build, "archon", "run-config.yaml"), "/opt/hapi/run-config.yaml"),
      bind(join(w.build, "archon", "gitconfig"), "/home/appuser/.gitconfig"),
      bind(join(REPO, "stack", "archon", prelude), `/opt/hapi/${prelude}`),
      bind("/state/runs/run.json", "/run/hapi/run.json"),
      bind("/state/runs/order.json", "/run/hapi/order.json"),
      bind("/state/runs/task.md", "/run/hapi/task.md"),
      bind("/srv/src/.git", "/src/repo.git"),
      ...(kind === "review" || kind === "fix" ? [bind("/state/runs/inputs", "/run/hapi/inputs")] : []),
      { Type: "volume", Source: `/var/lib/docker/volumes/${name}-work/_data`, Destination: "/work", RW: true },
      { Type: "volume", Source: `/var/lib/docker/volumes/${name}-out/_data`, Destination: "/out", RW: true },
    ],
    NetworkSettings: { Networks: { [name]: { NetworkID: `net-${id}` } } },
    HostConfig: {
      NetworkMode: name,
      Init: false,
      PortBindings: {},
      Tmpfs: {
        "/tmp": "size=1g,uid=1001,gid=1001,mode=1777",
        "/home/appuser": "size=256m,uid=1001,gid=1001,mode=0700",
        "/.archon": "size=512m,uid=1001,gid=1001,mode=0700",
        "/opt/hapi/pi-agent": "size=64m,uid=1001,gid=1001,mode=0700",
      },
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 2048,
      Memory: 4 * 1024 ** 3,
    },
  };
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
  if (cmd[0] === "env" && cmd.includes("git")) return fakeGit(w, cmd.slice(cmd.indexOf("git") + 1));
  if (cmd[0] !== "docker") return { code: 127, stdout: "", stderr: `${cmd[0]}: not found` };
  if (w.dockerDown) return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon at unix:///run/user/1001/docker.sock. Is the docker daemon running?" };
  if (cmd[1] === "info" && cmd[2] === "--format" && cmd[3] === "{{.DockerRootDir}}") return ok(`${DOCKER_ROOT}\n`);
  if (cmd[1] === "ps") {
    // `--filter label=k` or `label=k=v`, all of which must match.
    const wanted = cmd.flatMap((a, i) => (cmd[i - 1] === "--filter" && a.startsWith("label=") ? [a.slice(6)] : []));
    const hit = w.containers.filter((c) =>
      wanted.every((f) => {
        const eq = f.indexOf("=");
        const have = c.Config.Labels[eq < 0 ? f : f.slice(0, eq)];
        return have !== undefined && (eq < 0 || have === f.slice(eq + 1));
      }),
    );
    return ok(hit.map((c) => c.Id).join("\n") + (hit.length ? "\n" : ""));
  }
  if (cmd[1] === "inspect") {
    const ids = cmd.slice(2);
    return ok(JSON.stringify(w.containers.filter((c) => ids.includes(c.Id))));
  }
  if (cmd[1] === "network" && cmd[2] === "inspect") {
    const nets = cmd.slice(3).map((n) => w.networks.get(n));
    if (nets.some((n) => n === undefined)) return { code: 1, stdout: "[]", stderr: `Error response from daemon: network ${cmd[3]} not found` };
    return ok(JSON.stringify(nets));
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
      return ok(`${text}\n@@hapi-audit ${v.code}@@\n${JSON.stringify(b.aliases)}\n@@hapi-audit 0@@\n${JSON.stringify(b.tiers)}\n@@hapi-audit 0@@\n${w.enableExtensions.out}\n@@hapi-audit ${w.enableExtensions.code}@@\n`);
    }
    if (cmd.some((a) => a.includes("hermes"))) return ok(`${JSON.stringify(w.hermes)}\n`);
  }
  return { code: 1, stdout: "", stderr: `unexpected command: ${cmd.join(" ")}` };
}

/** git, as repo.private-untracked runs it: `git -C <root> -c core.fsmonitor=false <subcommand> ...`. */
function fakeGit(w: World, args: string[]): ExecResult {
  if (w.git.fail) return { code: w.git.fail.code, stdout: "", stderr: w.git.fail.stderr };
  const sub = args[args.indexOf("core.fsmonitor=false") + 1];
  if (sub === "rev-parse") return ok(`${w.git.prefix}\n`);
  if (sub === "ls-files") return ok((args.includes("--others") ? w.git.untracked : w.git.tracked).map((f) => `${f}\0`).join(""));
  if (sub === "check-ignore") {
    if (w.git.ignoredBy === undefined) return { code: 1, stdout: "", stderr: "" };
    return args.includes("-q") ? ok("") : ok(`${w.git.ignoredBy}\tprivate/\n`);
  }
  return { code: 1, stdout: "", stderr: `unexpected git command: ${args.join(" ")}` };
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
