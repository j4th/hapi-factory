# hapi-factory Plan 01: Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up hapi-factory's Phase 0 on this machine:
- pinned toolchain;
- `policy/` as the single source of truth, compiled into Hermes, Archon, Pi and egress configs;
- Hermes and Archon running in rootless containers under a dedicated `hapi` user, behind default-deny egress;
- secrets from a pluggable provider (sops + age by default);
- GitHub App token minting;
- `mise run audit`;
- threat model v0.

It also runs the design's "verify early" spikes, whose results shape Plans 02–07.

**Architecture:** A single TypeScript CLI (`hapi`, run on Bun) owns policy loading, config generation, secrets, forge tokens and audit. The deployable stack is a Docker Compose project run by rootless Docker as the `hapi` user. Each zone (Hermes, Archon) sits on an `internal` network whose only exit is its own Squid forward proxy, holding a generated hostname allowlist. Nothing here builds factory runs yet; this is the floor the later plans stand on.

**Tech Stack:**
- mise (the only host prerequisite besides Docker)
- Bun + TypeScript (`bun test`)
- `ajv` (JSON Schema 2020-12)
- `yaml`
- Docker Engine rootless + Compose v2
- Squid
- sops + age (the default secret provider; Bitwarden `bws` optional)
- GitHub REST API
- Hermes Agent v0.22.5 (official image)
- Archon v0.12.1 (official image + Pi provider)

**Spec:** `docs/superpowers/specs/2026-10-26-hapi-factory-design.md` (approved 2026-10-26). Supporting evidence: [docs/research/README.md](../../research/README.md), which lists the private research and the conclusions the spec adopted.

## Plan sequence

This is Plan 01 of 07. Each later plan is written after the plans before it finish, using this plan's spike results (Tasks 8–14).

| Plan | Scope | Produces (for later plans) |
|---|---|---|
| **01 Foundations** (this) | Toolchain, policy plus schemas (including work order), generators, secrets, App tokens, stack, egress, audit, threat model v0, spikes | `hapi` CLI; `loadPolicy`, `applyOverlay`, `validateWorkOrder`; `buildAll`; `mintInstallationToken`; `resolveSecrets`; `runAudit`; the running stack; `docs/spikes/*` |
| 02 Worker | `decide()` with the vendored ten-levels Jev client, mock and decision files; the `hapi decide` CLI; the `hapi-guard` Pi extension (protected paths, budgets, request clamps, trace, Jev level-6 gates) | `decide(name, state)`; the hapi-guard package baked into the Archon image |
| 03 Run engine | Archon `factory-task` workflow pack (prepare / strip / scout / implement / retry / gates / review / commit); the forge interface; poller (merge + `hapi:rework`); mirror; harvester; `metrics.json`; commit trailers | The end-to-end run from a merged work order to a delivery PR |
| 04 Coordinator | Hermes plugins `hapi-path-guard` and `hapi-cmd-allow`; skills `hapi-planning`, `new-work-order` and `hapi-research-note` (with citation check); the `hapi-research` profile and **its own container** (native Brave and Exa web backends, Context7 MCP from the Task 3b catalog); freshness job; the `hapi-status` tool; Slack gateway; PR-comment queue plus the injection screen; the three skill tiers and `hapi skill fork\|diff\|promote\|drop` (handoffs H-104–H-109) | Planning PRs from a Slack conversation |
| 05 Repo contract | `templates/repo-contract/`, `mise run new-repo`, the reusable CI workflow (gates, schema, trailers, protected-path diff), `.coderabbit.yaml`, ruleset application | New repos born compliant |
| 06 Evals & metrics | Eval case format and runner, planning eval, `metrics.jsonl`, flags and thresholds, Jev/CodeRabbit calibration records | `mise run eval` |
| 07 v1 acceptance | The Odoo MCP run-through against the spec's v1 definition of done (§15), plus the budget, portable and jev-off runs | v1 done |

Phases 2–5 (mtg brownfield; showcase depth plus VM; more lanes; GitLab) get their own plans after v1.

**Deferred work** lives in [handoffs.md](handoffs.md): every fix, handoff, accepted residual risk, unverified claim and manual step a task pushes to a later task, plan or person, numbered `H-NNN` and grouped by destination. Each task and plan starts by pulling its section into its own steps. Where a section there differs from a task's steps below, the handoff wins.

## Global Constraints

- Linux only. This machine first. Every host action runs as the dedicated `hapi` user, except the one-time `scripts/host-setup.sh`, which the operator runs with sudo.
- Pin every tool, image and plugin: exact versions in `mise.toml`, image digests in `stack/compose.yaml`. Never track `main` or `latest`.
- Hermes: stable tag **v0.22.5**. Archon: **v0.12.1**. The Pi SDK embedded in Archon is **1.3.0**. Any standalone Pi CLI is pinned to **1.3.0** with a separate agent dir.
- No subscription OAuth in Hermes, Pi or Archon. Anthropic Console API keys only.
- Budget ceiling is the $200/month credit. Workspaces and spend limits:
  - `hapi-hermes` **$60**
  - `hapi-factory` **$100**
  - `hapi-evals` **$40**
  - the default workspace is unused.
- Other keys: OpenRouter **$20/month**; the Jev OpenRouter key **$2/month**.
- Per-run target: **≤ $3**.
- Archon env: `HOST=127.0.0.1`, `ARCHON_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`.
- Pi env (inside Archon): `PI_OFFLINE=1`, `PI_TELEMETRY=0`, read-only `PI_CODING_AGENT_DIR`, `models.json` `maxTokens: 64000`.
- Hermes defaults (spec §9.1):

  | Setting | Value |
  |---|---|
  | `skills.write_approval`, `memory.write_approval` | `true` |
  | `skills.guard_agent_created` | `true` |
  | `security.protected_instruction_files` | on |
  | `approvals.mode` | `manual` |
  | `approvals.cron_mode`, `unattended_mode`, `single_query_mode` | `deny` |
  | yolo / `approvals.mode: off` | forbidden |
  | `plugins.isolation` | `host` |
  | `auth.adopt_external_logins` | `false` |
  | `web.keyless_fallback`, `web.keyless_rescue` | `false` |
  | `security.allow_lazy_installs` | `false` |
  | `agent.max_turns` | **60** |
  | every `auxiliary.*` slot, `delegation.model`, `cron.model` | Haiku 5.5 (`claude-haiku-5-5`) |
  | `cache_ttl` | `auto` |
  | `hooks_auto_accept` | `false` |

- Protected paths (spec §8.2), exactly:
  - `AGENTS.md`, `.factory/**`, `.github/**`, `mise.toml`, `.agents/**`: `{interactive: ask, unattended: deny, workers: deny}`
  - `.pi/**`, `.archon/**`: `{interactive: deny, unattended: deny, workers: deny}`
- Repo overlays may only **tighten** policy, except for `egress_extra` additions.
- Secrets come from the configured provider (sops + age by default; Task 4b) at start, into `0600` files under `$XDG_RUNTIME_DIR/hapi/env/`. The repo holds logical names only. Never values in the repo, never in a repo `.env`.
- All forge calls go through `src/forge/` modules. No raw `gh` in scripts, skills or workflows.
- Agents never create repos or merge. GitHub App tokens are 1-hour installation tokens minted outside the agents.
- Agents never do outward-facing or privileged actions: sudo, creating users, repos or Apps, pushing, publishing, or handling real secrets. Each one is written up as an operator step (README "Manual setup steps", a runbook, and the manual-checkpoint section of [handoffs.md](handoffs.md)).
- Every task documents the user-facing surface it adds (commands, config files, generated files, manual steps) in README.md or the relevant `docs/` page, and its reviewer checks that the docs match the code.
- Every deferral lands in [handoffs.md](handoffs.md) in the same commit that defers it. The SDD ledger under `.superpowers/` is scratch: it is gitignored and deleted when the plan finishes.
- Models:
  - `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` (Anthropic);
  - portable: OpenCode Go zero-retention models only.

## Review Focus

1. **Loosening overlays.** A repo's `.factory/config.yaml` that tries to loosen policy (e.g. `AGENTS.md: {interactive: allow}`, or removing a protected path) must be rejected with an error naming the path. It must never be silently merged. Test: Task 2, `applyOverlay rejects loosening`.
2. **A missing secret.** If a secret is missing or the secret provider fails at `mise run up`, nothing starts, and the error names the missing secret key. Containers never start with an empty variable. Test: Task 4, `resolveSecrets fails closed on missing secret`.
3. **The proxy is down or misconfigured.** Zone containers have no direct route out: requests fail, they don't bypass. Test: Task 5, `egress: direct connection is blocked even when proxy is stopped`.
4. **Drift in deployed config.** A hand edit to deployed config (e.g. `approvals.mode: off`, or `HOST=0.0.0.0`) is detected by `mise run audit`, which exits non-zero. Test: Task 6, `audit detects drift from generated config`.
5. **Upstream ignores a generated key** after an upgrade (a renamed key, an Archon parse warning). Audit checks each tool's own validation output, not only our files. Test: Task 6, `audit fails on archon parseWarnings`.
6. **A minted GitHub token comes back broader than requested.** The response's `permissions` or `repositories` must be checked, and anything broader is rejected. Test: Task 4, `mintInstallationToken rejects broader permissions`.

---

### Task 1: Project skeleton and toolchain

**Files:**
- Create:
  - `mise.toml`, `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`
  - `src/cli.ts`, `src/version.ts`
  - `.github/workflows/ci.yml`
  - `README.md`
- Test: `tests/cli.test.ts`
- Commit as-is: `docs/`, `reports/`, `research_notes/`

**Interfaces:**
- Produces:
  - **`hapi` CLI entry** `src/cli.ts`, run as `bun run src/cli.ts <cmd>`, aliased by mise task `hapi`. Subcommand dispatch is `main(argv: string[]): Promise<number>` (the exit code). Later tasks register `policy build`, `workorder validate`, `secrets resolve`, `token mint` and `audit`.
  - **`version.ts`** exports `HAPI_VERSION = "0.1.0"`.
  - **mise tasks** `test`, `lint`, `hapi`, `policy:build`, `audit`, `up`, `down`. Stubs are fine where later tasks fill them in.

- [ ] **Step 1: Write the failing test** `tests/cli.test.ts`:

```ts
import { main } from "../src/cli";
test("prints version", async () => {
  const out: string[] = []; const orig = console.log; console.log = (s) => out.push(String(s));
  expect(await main(["--version"])).toBe(0); console.log = orig;
  expect(out.join("\n")).toContain("0.1.0");
});
test("unknown command exits 2", async () => {
  expect(await main(["nope"])).toBe(2);
});
```

- [ ] **Step 2: Run** `bun test tests/cli.test.ts`. Expected: FAIL, because `../src/cli` isn't found.

- [ ] **Step 3: Implement `main(argv)` in `src/cli.ts`**, with `--version` and a subcommand registry (`register(name, handler)`). Write `mise.toml`:
  - `[tools]` pins exact current stable `bun`, `node`, `uv`, `python`, `gh`, `gitleaks`;
  - `[tasks]` covers `test = "bun test"`, `lint = "bunx tsc --noEmit"`, `hapi = "bun run src/cli.ts"`, and stubs for the others.

  `.gitignore` adds `build/`, `node_modules/`, `.env*` and `spikes/scratch/`. CI runs `mise install && mise run lint && mise run test` on `ubuntu-latest`, with actions pinned to full SHAs.

- [ ] **Step 4: Run** `mise install && mise run test && mise run lint`. Expected: PASS, with 2 tests passing and no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: hapi-factory skeleton, toolchain, CI; add design, recon report and research notes"
```

- [ ] **Step 6: Manual (the operator; outward-facing).** Superseded: the repos were created private and empty, and nothing is pushed until Task 7b is done. The publish sequence (push, make hapi-factory public, the two `main` rulesets) is the register's H-074 and H-075, and README's "Publishing, after Task 7b".

---

### Task 2: Policy files, JSON Schemas, loader, overlay, work-order validator

**Files:**
- Create:
  - policy files: `policy/{protected_paths,commands,trusted_sources,budgets,approvals,roles,flags}.yaml`, `policy/rosters/{budget,anthropic,portable}.yaml`
  - schemas: `policy/schemas/{policy-*,work-order,repo-overlay}.schema.json`
  - `src/policy/types.ts`, `src/policy/load.ts`, `src/policy/overlay.ts`, `src/workorder/validate.ts`
- Test: `tests/policy/load.test.ts`, `tests/policy/overlay.test.ts`, `tests/workorder/validate.test.ts`, fixtures under `tests/fixtures/`

**Interfaces:**
- Produces:
  - **`loadPolicy(dir: string): Policy`** throws `PolicyError { file, path, message }`.
  - **`Policy` fields:**
    - `protectedPaths: Record<glob, {interactive: Mode; unattended: Mode; workers: Mode}>`, where `Mode = "allow"|"ask"|"deny"`;
    - `commands: {hermes: {allow: string[]}; workers: {tools: string[]}}`;
    - `trustedSources: {tiers: Record<"T0"|"T1"|"T2"|"T3", {hosts: string[]}>; zones: Record<ZoneName, {tiers: Tier[]; hosts: string[]; openWeb?: boolean}>}`;
    - `budgets`, `approvals`, `roles`, `rosters: Record<"budget"|"anthropic"|"portable", Roster>`, `flags`.
  - **`ZoneName = "hermes"|"archon"|"research"`.**
  - **`loadOverlay(file): RepoOverlay`** and **`applyOverlay(p: Policy, o: RepoOverlay): Policy`**. The latter throws `PolicyLoosenError { path }`.
  - **`validateWorkOrder(obj: unknown): WorkOrder`** throws `WorkOrderError { path, message }`. `WorkOrder` mirrors spec §6:
    - `id`, `lane`, `workflow`;
    - `risk: "low"|"medium"|"high"`;
    - `roles: {implement: Tier; review: Tier}`, with `Tier = "small"|"medium"|"large"`;
    - `budget: {usd; turns; minutes}`;
    - `pieces: {id; files: string[]; size: "small"|"medium"|"large"}[]`;
    - `verify: {smoke: boolean}`, `egress_extra: string[]`, `trace: {traceparent}`, `sources: string[]`.
  - **Values fixed here (from the spec):**
    - `flags.yaml` exactly as spec §13.3, plus the `jev` and `coderabbit` lines;
    - `budgets.yaml`: `workspaces {hapi-hermes: 60, hapi-factory: 100, hapi-evals: 40}`, `openrouter_monthly_usd: 20`, `jev_monthly_usd: 2`, `run_usd: 3.00`, `hermes_max_turns: 60`;
    - `approvals.yaml`: `[merge, new_dependency, new_skill_or_mcp, ci_workflow_change, outbound_message, spend_above_threshold]`;
    - `anthropic.yaml` roster from spec §12 (implement `claude-opus-5-5` effort low, retry high; review `claude-sonnet-5-5` medium via provider `claude`; small tier `claude-haiku-5-5`);
    - `budget.yaml`: every tier `claude-haiku-5-5`;
    - `portable.yaml`: implement `opencode-go/kimi-k3.1-pro`, review on a different family (`opencode-go/glm-5.3`). Model ids are confirmed against OpenCode Go's list at implementation time.

- [ ] **Step 1: Write the failing tests:**

```ts
// tests/policy/load.test.ts
test("loads repo policy", () => {
  const p = loadPolicy("policy");
  expect(p.protectedPaths["AGENTS.md"]).toEqual({ interactive: "ask", unattended: "deny", workers: "deny" });
  expect(p.protectedPaths[".pi/**"].interactive).toBe("deny");
  expect(p.budgets.workspaces["hapi-factory"]).toBe(100);
  expect(p.flags.jev).toEqual({ enabled: true, fallback: "haiku", via: "openrouter" });
});
test("rejects unknown keys with file and path", () => {
  expect(() => loadPolicy("tests/fixtures/policy-unknown-key")).toThrow(/budgets\.yaml.*\/wokspaces/);
});
// tests/policy/overlay.test.ts
test("applyOverlay tightens", () => { /* overlay adds "src/secrets/**": all deny → present in result */ });
test("applyOverlay rejects loosening", () => {
  expect(() => applyOverlay(p, { protected_paths: { "AGENTS.md": { interactive: "allow" } } }))
    .toThrow(PolicyLoosenError); // message names AGENTS.md
});
test("applyOverlay rejects removing a protected path", () => { /* overlay sets "AGENTS.md": null → PolicyLoosenError */ });
test("applyOverlay allows egress_extra additions", () => { /* egress_extra: ["odoo.internal"] → zones.archon.hosts includes it */ });
// tests/workorder/validate.test.ts
test("accepts spec §6 example", () => { expect(validateWorkOrder(load("tests/fixtures/order-0002.yaml")).id).toBe("0002-search-partners-tool"); });
test("rejects model ids in roles", () => { /* roles.implement: "claude-opus-5-5" → WorkOrderError path /roles/implement */ });
test("rejects malformed traceparent", () => { /* "00-xyz" → path /trace/traceparent */ });
```

- [ ] **Step 2: Run** `bun test tests/policy tests/workorder`. Expected: FAIL, because the modules don't exist.

- [ ] **Step 3: Write the schemas and the policy files with the values above. Implement the loader, overlay and validator** using `ajv` (2020-12, `allErrors`, `additionalProperties: false` everywhere) and `yaml`.
  - **Tightening order:** `allow < ask < deny`. Overlay modes must be ≥ base.
  - **Overlay restrictions:** an overlay may add protected paths and `egress_extra`, and may lower budgets. Anything else is rejected.
  - **Traceparent regex:** `^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$`.

- [ ] **Step 4: Run** `bun test tests/policy tests/workorder`. Expected: PASS.

- [ ] **Step 5: Add `hapi workorder validate <path>`.** It exits 0 and prints the id, or exits 1 and prints `path: message`. Test it in `tests/cli.test.ts` with the fixture. Run `bun test`. Expected: PASS.

- [ ] **Step 6: Commit** `git commit -am "feat(policy): policy files, schemas, loader, tighten-only overlay, work-order validator"`

---

### Task 3: Config generators and `hapi policy build`

**Files:**
- Create: `src/generate/{index,hermes,archon,pi,egress}.ts`
- Test: `tests/generate/*.test.ts`

**Interfaces:**
- Consumes: `Policy` (Task 2).
- Produces:
  - **`buildAll(p: Policy, outDir: string, opts?: {roster?: "budget"|"anthropic"|"portable"}): Promise<string[]>`** returns the paths written. `roster` defaults to `"anthropic"`.
    - `build/hermes/config.yaml`
    - `build/archon/config.yaml`, `build/archon/archon.env`
    - `build/pi/models.json`, `build/pi/hapi-guard.json`
    - `build/egress/{hermes,archon,research}.squid.conf`
  - **Each emitter is pure:** `emitHermes(p): Record<filename, string>`, `emitArchon(p, roster)`, `emitPi(p, roster)`, `emitEgress(p)`, all with the same return shape.
  - **No Hermes hooks are emitted in Plan 01.** The `hapi-cmd-allow` hook script arrives in Plan 04. A `fail_closed` hook pointing at a missing script would block every tool call.
  - **`hapi policy build [--policy dir] [--out dir] [--roster name]`.**

- [ ] **Step 1: Write the failing tests** (parse the emitted YAML/JSON, then assert on it):

```ts
test("hermes flips defaults", () => {
  const c = YAML.parse(emitHermes(p)["config.yaml"]);
  expect(c.skills.write_approval).toBe(true); expect(c.skills.guard_agent_created).toBe(true);
  expect(c.memory.write_approval).toBe(true); expect(c.approvals.mode).toBe("manual");
  expect([c.approvals.cron_mode, c.approvals.unattended_mode, c.approvals.single_query_mode]).toEqual(["deny","deny","deny"]);
  expect(c.plugins.isolation).toBe("host"); expect(c.auth.adopt_external_logins).toBe(false);
  expect(c.web.keyless_fallback).toBe(false); expect(c.web.keyless_rescue).toBe(false);
  expect(c.security.allow_lazy_installs).toBe(false); expect(c.agent.max_turns).toBe(60);
  expect(Object.values(c.auxiliary).every((s: any) => s.model === "claude-haiku-5-5")).toBe(true);
  expect(c.hooks_auto_accept).toBe(false);
});
test("hermes protected_instruction_files lists filename rules", () => { /* includes AGENTS.md */ });
test("archon env is loopback with telemetry off", () => {
  const env = emitArchon(p)["archon.env"];
  expect(env).toMatch(/^HOST=127\.0\.0\.1$/m); expect(env).toMatch(/^ARCHON_TELEMETRY_DISABLED=1$/m); expect(env).toMatch(/^DO_NOT_TRACK=1$/m);
  expect(env).toMatch(/^PI_OFFLINE=1$/m); expect(env).toMatch(/^PI_TELEMETRY=0$/m);
});
test("archon tiers come from the selected roster", () => { /* emitArchon(p, "budget") → every tier model claude-haiku-5-5 */ });
test("pi models.json caps maxTokens at 64000", () => { /* every model entry maxTokens === 64000 */ });
test("pi hapi-guard.json carries workers modes", () => { /* AGENTS.md → "deny"; budgets.run_usd 3 */ });
test("egress archon allowlist is exact and denies by default", () => {
  const conf = emitEgress(p)["archon.squid.conf"];
  expect(conf).toContain("acl allowed dstdomain .api.anthropic.com");
  expect(conf).not.toMatch(/dstdomain .*github\.com/);      // Archon zone has no forge route
  expect(conf.trim().endsWith("http_access deny all")).toBe(true);
});
test("research zone allows open web but blocks private ranges", () => { /* to_localnet deny present */ });
```

- [ ] **Step 2: Run** `bun test tests/generate`. Expected: FAIL.

- [ ] **Step 3: Implement the emitters.**
  - **Hermes key names:** take them from the pinned Hermes v0.22.5 `cli-config.yaml.example`, as quoted in `research_notes/Agentic software factory recon/hermes_agent.md`. Where a key's name differs at the pinned tag, follow the tag and update the test. That's a one-line decision, recorded in the commit message.
  - **Archon tier syntax:** follow `archon_plugins_integration.md` §Q4. Squid configs deny `to_localnet` for every zone and allow `CONNECT` only to allowlisted domains on 443.
  - **Zone hosts from policy:**
    - `archon`: model APIs (`api.anthropic.com`, `openrouter.ai`, `opencode.ai`) plus package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`). **No GitHub hosts.**
    - `hermes`: model APIs, `api.github.com`, `github.com`, and the Slack hosts listed in the policy.

- [ ] **Step 4: Run** `bun test tests/generate`. Expected: PASS.

- [ ] **Step 5: Wire up the build.** Add `hapi policy build` and point mise task `policy:build` at it. Run `mise run policy:build && ls build/*`. Expected: the 9 files above.

- [ ] **Step 6: Commit** `git commit -am "feat(generate): compile policy into Hermes, Archon, Pi and egress configs"`

---

### Task 3b: MCP catalog, advisory floors, tool-description lock, per-zone emission

The spec is §10.1. The evidence is in `research_notes/Hapi factory plugins and o11y/mcp_baseline.md`.

**Files:**
- Create:
  - `policy/mcp.yaml`, `policy/mcp.lock.json`
  - `policy/schemas/policy-mcp.schema.json`, `policy/schemas/mcp-lock.schema.json`
  - `src/policy/mcp.ts`, `src/mcp/lock.ts`, `src/generate/mcp.ts`
- Modify:
  - `src/policy/types.ts`, `src/policy/load.ts` (add `mcp` to `Policy`)
  - `policy/trusted_sources.yaml` (drop T2 from the `hermes` zone; fix the Context7 comment)
  - `src/generate/hermes.ts` (emit `mcp_servers` for the hermes zone), `src/generate/index.ts`
  - `src/cli.ts`
  - `docs/policy.md`, `docs/generated-configs.md`
- Test: `tests/policy/mcp.test.ts`, `tests/mcp/lock.test.ts`, `tests/generate/mcp.test.ts`, plus additions to `tests/generate/hermes.test.ts` and `tests/policy/zones.test.ts`

**Interfaces:**
- Consumes: `loadPolicy`, `zoneHosts`, `forgeDomain`, `emitHermes`, `buildAll` (Tasks 2–3).
- Produces:
  - **`Policy.mcp: {servers: Record<string, McpServer>; blocked: string[]}`**, where `McpServer` is:
    ```
    {zones: ZoneName[];
     transport: "stdio"|"http";
     package?: {name: string; version: string /* exact */; integrity: string /* sha512-… */};
     image?: string /* name@sha256:… */;
     url?: string /* http only, https, first-party */;
     floor?: {min: string; advisory: string} /* our own advisory floor */;
     cooldown_exception?: string /* advisory id */;
     tools: {include: string[]};
     env: Record<string, string> /* ENV → bws key name, or a literal for flags like OTEL_SDK_DISABLED */;
     egress: string[];
     trust: "untrusted";
     elicitation: "deny";
     enabled_when?: "always"|"o11y"}
    ```
  - **`serversForZone(p, zone, opts?: {o11y?: boolean}): [string, McpServer][]`.**
  - **`hashToolSurface(s: {tools: Tool[]; instructions?: string; prompts?: unknown[]; resources?: unknown[]}): string`**: sha256 of canonical JSON, with tools sorted by name.
  - **`verifyLock(p, lock, fetchSurface: (name: string) => Promise<Surface>): Promise<{name: string; status: "ok"|"changed"|"unpinned"; expected?: string; actual: string}[]>`.**
  - **`emitMcpJson(p, zone): string`**: a standard `mcp.json` per zone, written to `build/mcp/<zone>.mcp.json`, for the CI scanners (Plan 05).
  - **`hapi mcp verify`** and **`hapi mcp pin --server <name>`.** `fetchSurface` launches the pinned server inside a throwaway container on its zone's network. The live wiring is in Task 5; unit tests inject fakes.
- **Catalog values (v1):**
  - **`context7`:**
    - zones `[research]`, stdio;
    - package `@upstash/context7-mcp` **4.3.0** with integrity `sha512-fuDt5nWjE5JkAPLjU0m+m0LlJphxyegAvAmcwHoA5jrzAhKo/rVV0RFA8TOwODGdDVdt/nPxNslkxeDIDp/rPA==` (it clears the 14-day cooldown; 4.4.4 doesn't yet);
    - floor `{min: "2.1.3", advisory: "CVE-2026-75130"}`;
    - tools `[resolve-library-id, query-docs]`;
    - env `{CONTEXT7_API_KEY: <bws key name>, OTEL_SDK_DISABLED: "true"}`;
    - egress `[context7.com]`; trust untrusted; elicitation deny; enabled_when always.
  - **`phoenix`:**
    - zones `[hermes]`, stdio, enabled_when `o11y`;
    - package `@arizeai/phoenix-mcp`: the newest version that clears the 14-day cooldown, with its registry integrity (`npm view` via registry.npmjs.org);
    - tools: the 23 read-only tools listed in the research note, **excluding** `phoenix-support`, `upsert-prompt`, `add-prompt-version-tag` and `add-dataset-examples`;
    - env `{PHOENIX_ENDPOINT: <explicit>, PHOENIX_API_KEY: <bws key name, VIEWER role>, PHOENIX_DISCOVER_CONFIG: "false"}`;
    - egress: the Phoenix host only.
  - **`blocked`:** `@modelcontextprotocol/server-brave-search`, `crawl4ai`, `ai.smithery/*`, `@upstash/context7-pi`, `@upstash/context7-admin-mcp` (patterns match package names).
  - **`trusted_sources.yaml`:** the `hermes` zone keeps tiers `[T0, T1]` only (spec §10 as amended).

- [ ] **Step 1: Write the failing tests:**

```ts
test("context7 is research-only and hermes has no MCP outside o11y", () => {
  const p = loadPolicy("policy");
  expect(serversForZone(p, "research").map(([n]) => n)).toEqual(["context7"]);
  expect(serversForZone(p, "hermes")).toEqual([]);
  expect(serversForZone(p, "hermes", { o11y: true }).map(([n]) => n)).toEqual(["phoenix"]);
  expect(serversForZone(p, "archon")).toEqual([]);
});
test("rejects an inexact pin or a missing integrity", () => { /* version "^4.3.0" or "latest" → PolicyError at /mcp/servers/context7/package */ });
test("enforces the advisory floor", () => { /* context7 version 2.1.2 → PolicyError naming CVE-2026-75130 */ });
test("rejects any server enabled for the archon zone", () => { /* zones: [archon] → PolicyError */ });
test("rejects blocked packages", () => { /* package @modelcontextprotocol/server-brave-search → PolicyError */ });
test("rejects write tools for phoenix", () => { /* include upsert-prompt → PolicyError (a write-tool denylist per server) */ });
test("hermes zone has no T2 sources", () => { /* zoneHosts(p,"hermes") excludes context7.com and deepwiki.com */ });
test("hashToolSurface is order-independent and instruction-sensitive", () => { /* reordered tools → same; changed instructions → different */ });
test("verifyLock reports changed, unpinned and ok", async () => { /* fakes */ });
test("emitHermes carries mcp_servers only for enabled hermes-zone servers, with include lists and env by name", () => { /* o11y off → no mcp_servers; on → phoenix only */ });
test("emitMcpJson writes a scanner-compatible file per zone", () => { /* research.mcp.json has context7 with a pinned command */ });
```

- [ ] **Step 2: Run** `bun test tests/policy/mcp.test.ts tests/mcp tests/generate`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Verify the Context7 integrity value against registry.npmjs.org. Fetch Phoenix's newest version that clears the cooldown, and its integrity.
  - Use the Hermes `mcp_servers` keys from the research notes: `command`, `args`, `env` (explicit only), `tools.include`, `trust`.
  - `mcp.lock.json` starts as `{}`, and `verifyLock` treats a missing entry as `unpinned`.

- [ ] **Step 4: Run** the tests. Expected: PASS. Then run `mise run lint && mise run test && mise run policy:build`. Expected: `build/mcp/{hermes,research}.mcp.json` exist.

- [ ] **Step 5: Docs.** Update `docs/policy.md` (mcp.yaml fields, floors, cooldown and exceptions, blocklist, lockfile, `hapi mcp verify|pin`) and `docs/generated-configs.md` (Hermes `mcp_servers`, `build/mcp/*.mcp.json`). Add the spec §10.1 per-layer table to `docs/policy.md`.

- [ ] **Step 6: Commit** `git commit -m "feat(mcp): per-zone pinned MCP catalog with advisory floors, tool-surface lock and emitters"`

---

### Task 4: Secrets from Bitwarden, GitHub App token minting, setup runbooks

**Files:**
- Create:
  - `src/secrets/bws.ts`, `stack/secrets.map.yaml`, `src/forge/github/app-token.ts`
  - runbooks: `docs/runbooks/github-apps.md`, `docs/runbooks/provider-keys.md`
- Test: `tests/secrets/bws.test.ts`, `tests/forge/app-token.test.ts`

**Interfaces:**
- Produces:
  - **`resolveSecrets(map: SecretMap, opts: {bws?: (args: string[]) => Promise<string>, outDir: string}): Promise<Record<zone, string>>`.** It writes `<outDir>/<zone>.env` with mode `0600` and returns the paths. It throws `SecretError { key }` on any miss.
  - **`SecretMap = Record<zone, Record<ENV_NAME, bwsSecretId>>`.**
  - **`mintInstallationToken(o: {appId: string; privateKeyPem: string; installationId: number; repositories: string[]; permissions: Record<string, "read"|"write">; fetch?: typeof fetch; now?: () => number}): Promise<{token: string; expiresAt: string}>`.** Throws `TokenScopeError` if the response's permissions or repositories exceed the request.
  - **`hapi secrets resolve`, `hapi token mint --app planner|factory --repo owner/name`.**

- [ ] **Step 1: Write the failing tests:**

```ts
test("resolveSecrets writes 0600 env files", async () => { /* stub bws returns {"value":"x"}; stat mode & 0o777 === 0o600 */ });
test("resolveSecrets fails closed on missing secret", async () => {
  await expect(resolveSecrets({ archon: { ANTHROPIC_API_KEY: "id-1" } }, { bws: async () => { throw new Error("404"); }, outDir }))
    .rejects.toThrow(/ANTHROPIC_API_KEY/);
  expect(existsSync(join(outDir, "archon.env"))).toBe(false);   // nothing partial left behind
});
test("mintInstallationToken sends scoped request", async () => { /* fake fetch asserts POST /app/installations/123/access_tokens body {repositories:["odoo-mcp"], permissions:{contents:"write", pull_requests:"write"}} and RS256 JWT with iat=now-60, exp=now+540 */ });
test("mintInstallationToken rejects broader permissions", async () => {
  // fake response permissions {contents:"write", administration:"write"}
  await expect(mintInstallationToken({ ...o, fetch: fake })).rejects.toThrow(TokenScopeError);
});
```

- [ ] **Step 2: Run** `bun test tests/secrets tests/forge`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `bws`: shell out to `bws secret get <id> --output json` and read `value`. Resolve everything into memory first, then write the files atomically.
  - JWT: use `crypto.subtle` RS256, with no extra dependency.
  - **Runbooks:**
    - `github-apps.md` covers the exact settings for **`hapi-planner`**: contents write, pull requests write, issues read, metadata read; branches restricted by ruleset to `plan/*`.
    - The same file covers **`hapi-factory`**: contents write, pull requests write, metadata read; `factory/*` branches.
    - Neither App gets administration, a ruleset bypass or merge rights.
    - Both private keys are stored in `bws`.
    - `provider-keys.md` covers creating the Console workspaces and limits above, the OpenRouter keys (`hapi-portable` $20/mo, `hapi-jev` $2/mo), and the OpenCode Go settings (training endpoints blocked, EU/US regions, **Extra Usage off**).

- [ ] **Step 4: Run** `bun test tests/secrets tests/forge`. Expected: PASS.

- [ ] **Step 5: Manual (the operator).** Follow both runbooks. Confirm with `hapi secrets resolve --dry-run`, which lists every key as found without printing values. Expected: all found.

- [ ] **Step 6: Commit** `git commit -am "feat: fail-closed bws secrets, scoped GitHub App token minting, setup runbooks"`

---

### Task 4b: Pluggable secret providers, with sops + age as the default

The spec is §11.5 (as amended for 4b). The operator's call: "portable across secret managers"; "we might as well do sops and age to start; greatly simplifies onboarding and is industry standard now".

**Why:** Task 4 tied the stack to Bitwarden and put per-deployment ids in a file shaped like the repo's template. This task splits secrets into three parts:
- **The manifest:** a committed, public, provider-neutral list of logical names per zone. It holds no ids and no values.
- **The local config:** outside the repo. It picks a provider and binds it.
- **The store:** the provider's data.

**sops + age is the default for everyone.** `bws` stays an optional provider. `env-file` is an explicit, audited downgrade. There is **no automatic fallback**: if the configured provider fails, or any name is missing or empty, nothing is written and nothing starts.

**Files:**
- Create:
  - `stack/secrets.yaml` (the manifest; replaces `stack/secrets.map.yaml`)
  - `policy/schemas/secrets-manifest.schema.json`, `policy/schemas/secrets-config.schema.json` (replace `secrets-map.schema.json`)
  - `src/secrets/manifest.ts`: load and validate the manifest, plus `mcpSecretGaps`, now checked against the manifest
  - `src/secrets/provider.ts`: the `SecretProvider` interface, `SecretError`, `loadSecretsConfig`, `providerFor`, `resolveSecrets`, `checkSecrets`
  - `src/secrets/providers/sops.ts`, `src/secrets/providers/bws.ts` (the Task 4 bws code, moved behind the interface), `src/secrets/providers/env-file.ts`
  - `src/secrets/init.ts`: `hapi secrets init`
  - tests under `tests/secrets/`
- Delete: `src/secrets/bws.ts` (split up as above), `stack/secrets.map.yaml`, `policy/schemas/secrets-map.schema.json`
- Modify:
  - `src/secrets/files.ts`: whole-set swap, stale-file removal, an `XDG_RUNTIME_DIR` check
  - `src/forge/github/app-token.ts`: the new env path, and a revoke fix
  - `src/cli.ts`
  - `src/policy/mcp.ts`, `src/policy/types.ts`, `policy/mcp.yaml`, `policy/schemas/policy-mcp.schema.json`, `src/generate/mcp.ts` and their tests (rename the `bws:` reference prefix to `secret:`)
  - `src/policy/schema.ts` (schema registry)
  - `mise.toml` (controller-authorized: pin sops and age, drop `bitwarden-secrets-manager`, add tasks)
  - `.gitignore`
  - docs: `docs/secrets.md`, `README.md`, the runbooks (`github-apps.md`, `provider-keys.md`, `slack.md`), `docs/mcp.md`, `docs/policy.md`, `docs/generated-configs.md`

**Interfaces:**
- **Manifest** (`stack/secrets.yaml`):
  - Shape: `{<zone>: {<ENV_NAME>: <logical-name>}}`.
  - Zones are exactly `hermes`, `archon`, `research` and `host`.
  - ENV_NAME matches `^[A-Z_][A-Z0-9_]*$`.
  - A logical name matches `^hapi-[a-z0-9]+(-[a-z0-9]+)*$`. One logical name may fill several env vars (archon `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY`).
  - Carry over every Task 4 entry with its current bws key name as the logical name: `hapi-hermes-anthropic-api-key`, …, `hapi-host-factory-app-private-key`. Keep the comments that say where each one comes from.
  - The manifest is the single list of what must exist. A store that lacks a manifest name fails `resolve`, and `check` names it. This replaces Task 4's "keep your copy in sync" step.
- **MCP references:** `bws:<name>` becomes **`secret:<name>`** everywhere: `policy/mcp.yaml`, the schema, `src/policy/mcp.ts`, the emitters, tests and docs. `secretEnvName` is unchanged. `mcpSecretGaps(p, manifest)` checks that the manifest fills every `secret:` reference of the servers each zone loads.
- **Local config:**
  - Path: `--config <path>`, else `$HAPI_SECRETS_CONFIG`, else `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.yaml`. A missing config fails with "no secrets config at <path>: run `mise run secrets:init`".
  - Schema-validated:
    ```yaml
    provider: sops            # sops | bws | env-file
    sops:     { file: <path to secrets.enc.yaml>, age_key_file: <path, optional> }
    bws:      { ids: { <logical-name>: <uuid> } }
    env_file: { file: <path> }
    ```
  - Exactly the selected provider's block is required. A `~` at the start of a path expands to `$HOME`. Relative paths resolve against the config file's directory.
- **`interface SecretProvider { readonly name: "sops"|"bws"|"env-file"; readonly downgrade: boolean; fetch(names: string[]): Promise<Map<string, string>> }`:**
  - Every name asked for is returned, or `fetch` throws `SecretError`.
  - Errors name logical names, files and exit codes, never values. Unknown store entries are ignored by `fetch` and reported by `check`.
- **`resolveSecrets(manifest, provider, opts: {outDir})`:**
  - Fetches the de-duplicated logical names once, then fills every zone's env vars.
  - An empty string counts as missing ("<zone>/<ENV> (<name>) is empty: fill it in with `mise run secrets:edit`").
  - Value validation (`envValueProblem`) is unchanged.
  - Writes the set with `writeSecretFiles` only after every value is good.
- **`checkSecrets(manifest, provider)`:** returns `[{zone, key, name, status: "found"|"missing"|"empty"}]` plus `unknown: string[]` (store names not in the manifest). It never returns values.
- **`describeSecretsConfig(cfg)`:** returns `{provider, downgrade, files: string[]}`. Task 6's audit uses it: `env-file` is reported as a downgrade.
- **CLI:**
  - `hapi secrets resolve [--config <p>] [--dry-run]`. `--dry-run` is the same as `check`.
  - `hapi secrets check [--config <p>]`: exits 1 if anything is missing or empty.
  - `hapi secrets init [--config <p>] [--file <p>] [--age-key <p>]`.
  - `hapi secrets edit [--config <p>]`: sops only; execs `sops edit` on the configured file with stdio inherited and the age key env set.
  - `--map` is removed.
- **mise tasks:** `secrets:init`, `secrets:edit` and `secrets:check`, each a thin wrapper over `hapi secrets …`.

**Provider rules:**
- **sops** (default):
  - Runs `sops decrypt --output-type json <file>` through an injectable `SopsRunner = (args: string[], o: {env: Record<string,string>; stdin?: string}) => Promise<{code: number; stdout: string; stderr: string}>`.
  - The child gets a **minimal env**: `PATH`, `HOME`, `SOPS_AGE_KEY_FILE` when configured, and **`SOPS_DISABLE_VERSION_CHECK=1`** (sops otherwise phones home for a version check). Nothing else is inherited.
  - No value ever goes through argv.
  - The child's stderr is never echoed raw. Report "sops could not decrypt <file> (exit N)" plus the first stderr line, scrubbed of anything after `:` that isn't a path. Follow the bws scrub pattern.
  - **Before decrypting,** parse the raw file as YAML and check that:
    - it has a `sops` metadata block with at least one `age` recipient;
    - every top-level value other than `sops` is a string matching `^ENC\[AES256_GCM,`.

    This refuses a file in which `unencrypted_suffix` or `unencrypted_regex` left a value in plaintext.
  - The decrypted JSON must be a flat object of logical name → string.
- **age key file** (the configured one, else sops's default `${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt`):
  - It must exist, be owned by the current uid and have no group or other permission bits.
  - It must **not** sit inside the hapi-factory checkout, `private/` included: `private/` is pushed to hapi-factory-private next to the encrypted file, and the two together are the plaintext. Find the checkout through an injectable `repoRoot`; the default is `git rev-parse --show-toplevel` from the module's directory.
- **The sops file** may live anywhere, `private/` included (the operator's choice: it's backed up to hapi-factory-private there).
- **bws:**
  - The Task 4 behaviour, unchanged, with ids from `bws.ids`. Placeholder ids are refused, as before.
  - `BWS_ACCESS_TOKEN` comes from the environment only.
  - Document what state bws keeps on disk (check `bws --help` / `bws config --help` for a state-file option). Never run a bws command that touches real secrets.
- **env-file** (downgrade):
  - The file holds `NAME_IN_ENV_FORM=value` lines, where the name is `secretEnvName(logical-name)`. Use `parseEnvFile`.
  - It must be mode 0600, owned by the current uid, and **outside the hapi-factory checkout**, `private/` included, because plaintext would be pushed to the private remote.
  - `downgrade: true`.

**`hapi secrets init`:**
- **Never overwrites anything.** If the config or the sops file exists, stop and point at `hapi secrets check`. Write each file atomically with mode 0600, in directories with mode 0700.
- **The age key:**
  - Reuse the key at the age-key path if it exists, after the checks above; its public key comes from `age-keygen -y <file>`.
  - Otherwise run `age-keygen -o <path>` with the parent directory at 0700. The file must end up 0600.
- **The sops file:**
  - Path: `--file`, default `${XDG_CONFIG_HOME:-$HOME/.config}/hapi/secrets.enc.yaml`.
  - Content: every manifest logical name with the value `""`, built **in memory**, encrypted by piping it through stdin to `sops encrypt --age <recipient> --input-type yaml --output-type yaml …`. Verify the exact stdin and filename flags with the pinned sops's `--help`.
  - **Plaintext never touches disk.**
- **The config:** write `{provider: sops, sops: {file, age_key_file}}`.
- **Then print:**
  - the age public key;
  - "back up <age key path> offline (e.g. in your password manager): without it the encrypted file can't be opened";
  - the next step, `mise run secrets:edit`.

**`src/secrets/files.ts`** (Task 4 security minors):
- Write zone files into a fresh `$XDG_RUNTIME_DIR/hapi/env.<random>/` (0700). Then **swap the whole set at once:**
  1. create a temporary symlink;
  2. `rename` it over `$XDG_RUNTIME_DIR/hapi/env`;
  3. then delete the old generation directory.

  Readers see either the old set or the new one, never a mix. Zone files dropped from the manifest disappear with the old generation.
- Consumers use **`$XDG_RUNTIME_DIR/hapi/env/<zone>.env`**. Update `app-token.ts`'s host.env path and the docs.
- `secureDir` also checks that `XDG_RUNTIME_DIR` itself is a directory owned by the current uid with mode 0700, as systemd creates it.
- `hapi token mint` deletes token files in `hapi/tokens/` older than 1 hour.

**Other folded fixes:**
- `app-token.ts`: a 201 response with a non-empty `token` but no valid `expires_at` revokes the token before throwing, like every other rejected 201.
- Manifest and config errors show a zone segment only if it is one of `SECRET_ZONES`; otherwise `<zone>`. This applies to JSON Pointers and to messages, so a pasted secret is never echoed.
- `docs/secrets.md` describes each step's error accurately: `PolicyError` for schema problems, plain `Error` for `XDG_RUNTIME_DIR`, `SecretError` for provider and store problems.
- `README.md` and `provider-keys.md` summaries say "ZDR enforced unless the documented Jev exception applies".
- `docs/policy.md` stops citing §11.5 for the "monthly cap / 31" rule; it's the runbook's rule.

**Toolchain:**
- Pin `sops` and `age` in `mise.toml`: the newest release of each that is **at least 14 days old** (check release dates with `gh release view` / `gh api repos/getsops/sops/releases` and `FiloSottile/age`). Record versions and dates in the report.
- Remove `bitwarden-secrets-manager` from `[tools]`. The bws section of `docs/secrets.md` shows bws users how to add it in their own gitignored `mise.local.toml`.
- `.gitignore` adds `private/`, `mise.local.toml`, `*.agekey`, `keys.txt` and `secrets.env`.

**Docs:**
- **`docs/secrets.md`** is rewritten around manifest → config → store. It covers:
  - sops onboarding, step by step;
  - backing up the age key;
  - adding a secret: `mise run secrets:edit`, add `<logical-name>: <value>`;
  - adding a new name to the manifest (a PR) and what `check` then reports;
  - rotating the age key: `sops updatekeys` / `sops rotate`;
  - optional bws;
  - the env-file downgrade and why it's audited;
  - the threat notes:
    - the age key is the master key;
    - decrypted values exist only in memory and in the 0600 tmpfs files;
    - each container sees its own zone's values.
- **Runbooks:** every "store it in bws" becomes "add it to your secrets store (`mise run secrets:edit`) as `<logical-name>`".
- **`README.md`:** the setup section gains `mise run secrets:init` / `secrets:edit` / `secrets:check`.
- No personal identifiers anywhere.

- [ ] **Step 1: Write the failing tests:**

```ts
test("the manifest holds logical names only, and covers every MCP secret: reference", () => { /* loadManifest("stack/secrets.yaml"); every value matches the name pattern; mcpSecretGaps(loadPolicy("policy"), m) is [] */ });
test("resolve fails closed when the store lacks a manifest name, and writes nothing", async () => { /* fake provider missing one name → rejects naming zone/ENV and the logical name; no env dir created */ });
test("an empty value counts as missing", async () => {});
test("a value never appears in an error or in stderr", async () => { /* fake store returns 'sk-SECRET-123' with a newline → error lacks the value */ });
test("sops provider: minimal env with SOPS_DISABLE_VERSION_CHECK=1, no value in argv", async () => { /* fake SopsRunner records args/env */ });
test("sops provider refuses a file with a plaintext value or no age recipient", async () => {});
test("age key file: refuses group/other bits, wrong owner, or a path inside the checkout (private/ included)", async () => {});
test("env-file provider: downgrade, refuses a file inside the checkout or not 0600", async () => {});
test("init never overwrites an existing config or sops file", async () => {});
test("init builds the template in memory and pipes it to sops (no plaintext file written)", async () => { /* fake runners; assert stdin carries every manifest name with "" */ });
test("writeSecretFiles swaps the whole set and drops stale zone files", async () => {});
test("secureDir refuses an XDG_RUNTIME_DIR not owned by us or not 0700", async () => {});
test("mint revokes a 201 token that lacks expires_at", async () => {});
test("no automatic fallback: a failing configured provider is the error", async () => {});
// HAPI_INT=1 only: real sops + age round-trip in a temp dir with a throwaway key and a temp HOME
```

- [ ] **Step 2: Run** `bun test tests/secrets tests/forge tests/policy tests/generate`. Expected: FAIL.
- [ ] **Step 3: Implement.** **Safety:**
  - Tests and the implementer **never** read the real `~/.config/sops/age/keys.txt` or `~/.config/hapi/`.
  - Every test injects temp paths, a temp HOME and an empty-ish env.
  - Never run `hapi secrets init`, `edit` or `resolve` against the real HOME.
  - You may run `sops --help`, `age --help`, `age-keygen --help` and `bws … --help`.
- [ ] **Step 4: Run** `mise install`, then `mise run lint && mise run test && HAPI_INT=1 bun test tests/secrets` (the integration round-trip uses throwaway keys only). Expected: PASS, with output free of any test secret value.
- [ ] **Step 5: Manual (the operator, at the checkpoint).** `mise run secrets:init -- --file private/secrets.enc.yaml`, then `mise run secrets:edit`, then `mise run secrets:check`. Expected: all found.
- [ ] **Step 6: Commit** `git commit -m "feat(secrets): pluggable providers with sops+age default, provider-neutral manifest, whole-set env swap"`

---

### Task 4c: Recovery recipient, per-machine keys and secret-store lifecycle

The spec is §11.5. The evidence comes from the ledger's 20:25 research entry and `.superpowers/sdd/…/research-age-key-recovery.json`: three researchers plus three adversarial verifiers, running experiments on sops 3.13.3 / age 1.3.2.

**Why:** Task 4b gives each store exactly one age key, on one machine. If that machine dies, the store is gone.

The standard pattern comes from the sops docs ("multiple master keys", with one key's private half stored offline), age's author and Flux. **It never backs up a key by copying it.** Instead, every store is encrypted to:
- **one key per machine or user**, generated where it lives and never copied (the operator's laptop, the VM, the `hapi` user);
- **one recovery (break-glass) recipient**, whose identity is wrapped with a **tool-generated 10-word passphrase** (about 110 bits, behind scrypt) and stored as `recovery.age` beside the store.

That leaves the end user one backup job: **store 10 words somewhere you won't lose them**, with no product named. The wrapped file is useless without the words, so it may sit in `private/` and be backed up with the store. This is the controller's default; the operator may override it.

**Files:**
- Create:
  - `src/secrets/recipients.ts`: the recipients file, the PQ/classic check, drift against the store
  - `src/secrets/recovery.ts`: generate, wrap and unwrap the recovery identity, and the word list
  - `src/secrets/lifecycle.ts`: `join`, `add-machine`, `recover`, `drill`, `revoke`, `new-recovery`
  - `src/secrets/cli.ts`: every `hapi secrets …` handler, moved out of `provider.ts` to break its import cycle
  - `src/secrets/wordlist.ts`: the vendored list, with its source and license header
  - `policy/schemas/secrets-recipients.schema.json`
  - tests under `tests/secrets/`
- Modify:
  - `src/secrets/init.ts`, `src/secrets/provider.ts`, `src/secrets/providers/sops.ts`, `src/secrets/files.ts`, `src/cli.ts`
  - `mise.toml` (controller-authorized: the new tasks)
  - `docs/secrets.md`, `README.md`, `docs/runbooks/*` where they mention the age key

**Interfaces:**
- **Recipients file** `secrets.recipients.yaml`:
  - It sits beside the store, at the same dir and basename stem, e.g. `private/secrets.recipients.yaml`.
  - Public keys only, schema-validated: `{pq: true, recipients: [{name, kind: "machine"|"recovery", recipient: "age1…", added: <ISO date>}]}`.
  - A `name` matches `^[a-z0-9][a-z0-9-]{0,62}$`.
  - `check` and every lifecycle command compare it with the store's `sops.age[].recipient` metadata, read without decrypting.
  - Drift in either direction is an error that names the extra or missing recipient by name or public key. Public keys are not secret.
- **Post-quantum by default:**
  - Keys come from `age-keygen -pq`: identity `AGE-SECRET-KEY-PQ-1…`, recipient `age1pq1…`.
  - sops silently allows a mix of PQ and classic recipients, which drops PQ protection (age itself refuses a mix). So **`check` and every command refuse a mix.**
  - `pq: false` in the recipients file selects all-classic instead, for P-256 hardware plugins later. It's documented as a trade-off.
  - init reuses an existing age key only if its kind matches `pq`; otherwise it stops with an explanation.
- **Tool resolution:**
  - `age`, `age-keygen` and the bundled `age-plugin-batchpass` must be the **mise-pinned age** (≥ 1.3.2; the distro age 1.1.1 lacks PQ and batchpass).
  - Resolve the install dir once, with `mise where age`, injectable for tests.
  - Put it first on the `PATH` of every age and sops child.
  - Refuse to run if `age --version` reports below the pin.
- **The recovery identity:**
  - Generated with `age-keygen -pq` (or classic when `pq: false`). Its recipient is recorded **at creation**, because `age-keygen -y` can't read a wrapped file.
  - The **passphrase is 10 words** drawn with `crypto.getRandomValues` from a 2048-word list. Use the list age itself uses for `age -p`, if its license allows vendoring (check age's source); otherwise BIP-39 English. Record the source and license in `wordlist.ts`.
  - It's wrapped non-interactively: `AGE_PASSPHRASE_FD=<fd>` + `age -e -j batchpass`. Verify the exact interface against the pinned age's `age-plugin-batchpass` docs and help.
  - The plaintext identity and the words exist **only in memory**, never in argv, env or a file.
- **Words input:**
  - Read from `/dev/tty` (injectable), with echo off where the terminal allows it.
  - Spaces, case and extra whitespace are normalised.
  - Each word is checked against the list, so a typo gets "word 4 is not in the list" instead of a scrypt failure.
- **sops never sees a wrapped identity.** Wrapped identities make sops prompt through gpg-agent or the TTY, and sops's gpg-agent client ignores `GNUPGHOME`. So the tool unwraps the recovery identity itself and hands sops the plain identity in the child's env as **`SOPS_AGE_KEY`**, only for the recover, drill and new-recovery calls. Every sops child env also sets **`GPG_AGENT_INFO=`**, empty.
- **Recipient changes go through `sops --config /dev/null rotate -i --add-age … / --rm-age …`.** That re-keys the data key on every change. `updatekeys` doesn't re-key, and `--config /dev/null` stays. The recipients file is updated in the same step: write it atomically after sops succeeds; if sops fails, leave it untouched.

**Commands** (each also a mise task `secrets:<name>`; `--config` as in Task 4b):
- **`hapi secrets init`** (extends Task 4b):
  1. Creates the machine key (`--name`, default `<hostname>-<user>`, normalised to the name pattern), unless one already exists.
  2. Creates the recovery identity and words in memory.
  3. **Shows the words once**, with the instruction "store these 10 words where you keep things you can't lose (a password manager, paper in a safe, or both). With `recovery.age` they open your secrets if every machine is lost."
  4. **Asks for 2 of the words**, at random positions. A mismatch re-shows the words, up to 3 tries, then aborts.
  5. Only then encrypts the template to **both** recipients, and writes the store, `recovery.age` (0600), the recipients file and the config. Every file write is **no-replace**: `link(tmp, path)` and then `unlink(tmp)`, failing with EEXIST.

  Also:
  - It refuses coinciding paths among config, store, age key, `recovery.age` and the recipients file.
  - An abort at any step writes nothing.
  - `--no-confirm` exists only for tests and non-interactive CI fixtures. It is refused when stdin is a TTY, so a human can't skip the check.
- **`hapi secrets join --store <path to a copy of the store>`:** for a new machine or user.
  - Creates this machine's key (never overwriting one) and its local config.
  - Prints its recipient, plus the exact command to run on a machine that already has access: `mise run secrets:add-machine -- --name <n> --recipient <age1…>`.
  - It doesn't touch the store.
- **`hapi secrets add-machine --name <n> --recipient <age1…>`:**
  - Validates the recipient's form and its PQ kind, and refuses a duplicate name or recipient.
  - Runs `rotate -i --add-age` and updates the recipients file.
- **`hapi secrets recover`:** for a box that has the store, `recovery.age` and the recipients file, but no key that opens them.
  1. Joins (creates this machine's key).
  2. Reads the words and unwraps the recovery identity in memory.
  3. Runs `rotate -i --add-age <this machine>` with `SOPS_AGE_KEY=<recovery identity>`.
  4. Updates the recipients file.

  After that the machine works without the words.
- **`hapi secrets drill`:** proves the backup works.
  - Reads the words and unwraps the recovery identity.
  - Decrypts the store in a child with `HOME` and `XDG_CONFIG_HOME` pointed at a fresh temp dir under `$XDG_RUNTIME_DIR/hapi/`, so no machine key can be loaded, and only `SOPS_AGE_KEY` set.
  - Reports "recovery works: N names readable", never a value. It deletes the temp dir.
  - It writes nothing else.
- **`hapi secrets revoke --name <n>`:**
  - Runs `rotate -i --rm-age <recipient>` and updates the recipients file.
  - It refuses to remove the last `machine` recipient, or the only `recovery` recipient (use `new-recovery`).
  - It prints the order sops documents for a compromised key: "if this key may be compromised, also reissue every credential in the store: copies of the store in git history stay readable by the removed key forever".
- **`hapi secrets new-recovery`:** for when the words are lost or exposed. It needs a working machine key.
  1. Creates a new recovery identity and words, with the same show-and-confirm flow as init.
  2. Adds it with `rotate -i --add-age`, then removes the old one with `--rm-age`.
  3. Replaces `recovery.age` and updates the recipients file. This is the one deliberate replace: back up the old file in memory and restore it if any step fails.
- **`hapi secrets check`** (extends Task 4b):
  - It also reports the recipients: names, kinds, PQ.
  - It **errors** on recipient drift or a PQ/classic mix.
  - It **warns, and still exits 0,** when the store has no `recovery` recipient or `recovery.age` is missing.

**Folded Task 4b minors:**
- **Checkout boundary:** `defaultRepoRoot` runs git with every `GIT_*` env var cleared. It treats as "inside the checkout" both the worktree top level and the **main worktree**, the parent of `git rev-parse --path-format=absolute --git-common-dir`. That way `private/` is still covered when hapi runs from a `.worktrees/` worktree.
- **Stale plaintext files:** `writeSecretFiles` removes, once:
  - Task 4-era `$XDG_RUNTIME_DIR/hapi/{hermes,archon,research,host}.env` regular files;
  - generation dirs not referenced by the `env` symlink, i.e. ones orphaned by a crash.
- **`checkSecrets`** masks unknown names in the API itself (`shownName`), not only in the CLI.
- **README:** step 5 expects every secret found except the three Slack values until Task 13.
- **CLI handlers** move to `src/secrets/cli.ts`, which removes the `provider.ts` ↔ `providers/*` cycle.

**Docs:**
- **`docs/secrets.md`** gets a "Keys and recovery" section, which replaces "back up the age key". It covers:
  - the pattern and why there's no copying;
  - what to store (10 words) and where;
  - each lifecycle command, with a worked example: laptop → VM → `hapi` user;
  - lost key vs compromised key;
  - PQ by default, and its costs: about 5 KB per recipient, and no P-256 hardware plugins;
  - hardware keys, Shamir key groups and cloud KMS as later add-ons, with one line each;
  - the threat notes:
    - the words plus `recovery.age` equal a master key;
    - sops never gets a wrapped key;
    - the gpg-agent isolation.
- **`README.md`:** setup step 3 gains the words step and `secrets:drill`.
- **The runbooks** point to it. `docs/runbooks/stack.md` (Task 5) uses `join` + `add-machine` for the `hapi` user.
- No personal identifiers.

- [ ] **Step 1: Write the failing tests:**

```ts
test("init encrypts to a machine key and a recovery recipient, both PQ, and writes the recipients file", async () => {});
test("init writes nothing if the word confirmation fails or any step aborts", async () => {});
test("init refuses coinciding paths and never replaces a file created after its checks (no-replace write)", async () => {});
test("the words and the plaintext recovery identity never reach argv, env, a file or an error", async () => { /* record every runner call and fs write */ });
test("words are 10 from the 2048-word list via crypto RNG; input normalisation; a non-list word is named by position", () => {});
test("join creates a key and config without touching the store, and prints the add-machine command", async () => {});
test("add-machine and revoke go through rotate with --config /dev/null and keep the recipients file in step; revoke refuses the last machine or the only recovery", async () => {});
test("recover: words → SOPS_AGE_KEY only in the sops child env → rotate --add-age self", async () => {});
test("drill decrypts with an isolated HOME and only the recovery identity, and prints no value", async () => {});
test("check errors on recipient drift or a PQ/classic mix and warns without a recovery recipient", async () => {});
test("every sops child env sets GPG_AGENT_INFO= and SOPS_DISABLE_VERSION_CHECK=1, and PATH starts with the mise age dir", async () => {});
test("defaultRepoRoot covers the main worktree from a linked worktree and ignores GIT_DIR/GIT_WORK_TREE", async () => {});
test("writeSecretFiles removes Task 4-era zone files and orphaned generations", async () => {});
// HAPI_INT=1 only: the full lifecycle with throwaway keys in temp dirs, using the real
// mise-pinned sops and age: init → drill → join(second HOME) → add-machine → resolve as the
// second machine → revoke the first → recover on a third HOME with only the store,
// recovery.age, recipients file and words → new-recovery
```

- [ ] **Step 2: Run** `bun test tests/secrets`. Expected: FAIL.
- [ ] **Step 3: Implement.** The Task 4b safety rules apply unchanged:
  - never touch the real `~/.config/sops`, `~/.config/hapi` or `~/.gnupg`;
  - point HOME, XDG_CONFIG_HOME and XDG_RUNTIME_DIR at temp dirs for every test;
  - keep tests away from the real gpg-agent: `GPG_AGENT_INFO=` and no `$XDG_RUNTIME_DIR/gnupg` socket;
  - write nothing into the repo outside your intended changes.
- [ ] **Step 4: Run** `mise run lint && mise run test && HAPI_INT=1 bun test tests/secrets`. Expected: PASS, with no test word or identity in the output.
- [ ] **Step 5: Manual (the operator, at the checkpoint).** `mise run secrets:init -- --file private/secrets.enc.yaml`. Store the words. Then `secrets:drill` and `secrets:edit`. Later, `join` + `add-machine` for the `hapi` user and the VM.
- [ ] **Step 6: Commit** `git commit -m "feat(secrets): recovery recipient with a 10-word wrapped key, per-machine keys, join/add-machine/recover/drill/revoke"`

---

### Task 5: Host setup and the stack (rootless Docker, internal networks, Squid egress, Hermes, Archon)

**Binding amendments:** [handoffs.md § Plan 01 Task 5](handoffs.md#plan-01-task-5) (H-003–H-022, H-134, H-135) supersedes the steps below where they differ. In short: this task is stage a (proxies, networks and integration tests on the current Docker; no real secrets); five services with `egress-research` and `research-net`; env files at `$XDG_RUNTIME_DIR/hapi/env/<zone>.env`; the `secrets:join` / `add-machine` flow for the `hapi` user.

**Files:**
- Create:
  - `scripts/host-setup.sh`
  - `stack/compose.yaml`, `stack/archon/Dockerfile`, `stack/hermes/Dockerfile`
  - `src/stack/up.ts`
- Test: `tests/stack/egress.int.test.ts` (integration; runs under `mise run test:int`)

**Interfaces:**
- Consumes: `buildAll` (Task 3), `resolveSecrets` (Task 4).
- Produces:
  - **`mise run up`:** policy build → resolve secrets → `docker compose up -d`. If `$USER != hapi`, it re-execs via `sudo -iu hapi`.
  - **`mise run down`.**
  - **Service names:** `hermes`, `archon`, `egress-hermes`, `egress-archon`.
  - **Networks:** `hermes-net` and `archon-net`, both `internal: true`. Only the egress proxies also join `outbound`.
  - **Each zone container** gets `HTTP_PROXY`/`HTTPS_PROXY` pointing at its proxy.
  - **The Archon image** = the pinned `ghcr.io/coleam00/archon` digest + `archon provider add` for Pi at the matching version + baked Python/uv/node toolchains. Runtime needs no GitHub egress. `build/pi` is mounted read-only at `PI_CODING_AGENT_DIR`.
  - **The Hermes image** = the pinned official image. `build/hermes` is mounted as config, and the `local` terminal backend runs inside the container, which is itself the boundary.

- [ ] **Step 1: Write `scripts/host-setup.sh`** (idempotent; the operator runs it once with sudo). It:
  - creates user `hapi`;
  - installs and enables rootless Docker for `hapi` (`dockerd-rootless-setuptool.sh install`, `loginctl enable-linger hapi`);
  - installs mise for `hapi`;
  - clones hapi-factory into `/home/hapi/hapi-factory` from the GitHub remote.

  Run: `sudo scripts/host-setup.sh && sudo -iu hapi docker info --format '{{.SecurityOptions}}'`. Expected: the output contains `rootless`.

- [ ] **Step 2: Write the failing integration tests** `tests/stack/egress.int.test.ts`, using a throwaway `curlimages/curl` container on `archon-net`:

```ts
test("egress: allowed host via proxy succeeds", () => { expect(curlVia("archon", "https://api.anthropic.com")).toMatch(/^HTTP\/\S+ (2|4)\d\d/); });
test("egress: disallowed host via proxy is denied", () => { expect(curlVia("archon", "https://github.com")).toMatch(/403/); });
test("egress: direct connection is blocked even when proxy is stopped", () => {
  stop("egress-archon"); expect(curlDirect("archon-net", "https://api.anthropic.com").ok).toBe(false); start("egress-archon");
});
test("archon listens on loopback only", () => { /* from another container on archon-net, connecting to archon:<server port from Archon's docs at v0.12.1> fails */ });
```

- [ ] **Step 3: Run** `mise run test:int`. Expected: FAIL, because there's no stack yet.

- [ ] **Step 4: Write `stack/compose.yaml`, both Dockerfiles (digest-pinned) and `src/stack/up.ts`** (`up()` calls `buildAll`, then `resolveSecrets`, then `compose up`, and aborts on any error).
  - Add `read_only: true` where the images allow, `cap_drop: [ALL]` and `security_opt: [no-new-privileges:true]` on every service.
  - Env files come from `$XDG_RUNTIME_DIR/hapi/*.env`.

- [ ] **Step 5: Run** `mise run up && mise run test:int`. Expected: PASS (4 tests). Then `docker compose ps` shows all 4 services healthy.

- [ ] **Step 6: Commit** `git commit -am "feat(stack): rootless hapi user, internal-only networks, Squid egress, Hermes and Archon containers"`

---

### Task 6: `mise run audit`

**Binding amendments:** [handoffs.md § Plan 01 Task 6](handoffs.md#plan-01-task-6) (H-023–H-037) supersedes the check list below where they differ: two rulesets on `main`, `runtime.dev-override`, `mcp.tool-hashes`, the secrets-provider downgrade and recipients checks, and `docs/audit.md`.

**Files:**
- Create: `src/audit/{index,types}.ts`, `src/audit/checks/{generated,runtime,pins,github,tools}.ts`
- Test: `tests/audit/*.test.ts`, with fixtures

**Interfaces:**
- Consumes: `loadPolicy`, `buildAll`, `mintInstallationToken`.
- Produces:
  - **`runAudit(ctx: AuditContext): Promise<CheckResult[]>`**, where `CheckResult = {id: string; status: "pass"|"fail"|"skip"; detail: string}`.
  - **`hapi audit [--repo owner/name ...]`** exits 1 if any check fails.
  - **The checks:**
    - **`generated.drift`:** the deployed `/home/hapi/...` configs equal a fresh `buildAll`.
    - **`runtime.archon-env`:** `docker inspect` env contains the Global Constraints' Archon and Pi values.
    - **`runtime.hermes-no-yolo`:** no yolo flag, and `approvals.mode != off` in the effective config.
    - **`pins.versions`:** every `mise.toml` tool and compose image is pinned by version or digest.
    - **`tools.archon-validate`:** `archon validate workflows --json` has no errors **and** an empty `parseWarnings`.
    - **`github.rulesets`:** for each `--repo`, `main` requires 1 approval with no App bypass.
    - **`github.app-perms`:** neither App has administration or a ruleset bypass.
    - **`repo.ai-workflows`:** for each `--repo`, fail on any workflow that runs an AI action with secrets on `issue_comment`, `issues`, `pull_request_review*` or `pull_request_target` triggers.

- [ ] **Step 1: Write the failing tests:**

```ts
test("audit detects drift from generated config", async () => { /* deployed fixture with approvals.mode: off → generated.drift fail, detail names approvals.mode */ });
test("audit fails on archon parseWarnings", async () => { /* fake archon validate output {"errors":[],"parseWarnings":["unknown key foo"]} → tools.archon-validate fail */ });
test("audit flags comment-triggered AI workflow", async () => { /* fixture = mtg's claude.yml → repo.ai-workflows fail */ });
test("audit passes a clean fixture", async () => { /* all pass/skip */ });
```

- [ ] **Step 2: Run** `bun test tests/audit`. Expected: FAIL.

- [ ] **Step 3: Implement the checks.** Command runners and HTTP are injected (`ctx.exec`, `ctx.fetch`) so the tests use fakes.

- [ ] **Step 4: Run** `bun test tests/audit`. Expected: PASS.

- [ ] **Step 5: Run live** `mise run audit`. Expected: exit 0, with every check `pass`, except `skip` for the `github.*` and `repo.*` checks when no `--repo` is given.

- [ ] **Step 6: Commit** `git commit -am "feat(audit): drift, runtime, pins, tool validation, GitHub and AI-workflow checks"`

---

### Task 7: Threat model v0 and kill-switch runbook

**Files:**
- Create: `docs/security/threat-model.md`, `docs/runbooks/kill-switches.md`

- [ ] **Step 1: Write `threat-model.md`** using CSA MAESTRO's 7 layers and 6 steps, scoped to the Phase 0 stack plus the planned Phase 1 flow (spec §4 and §11).
  - For each layer, list threats with **OWASP ASI01–ASI10** IDs, LLM Top 10 IDs and **MITRE ATLAS** technique IDs (e.g. AML.T0080, AML.T0086, AML.T0110), then the control (spec section plus the policy file that enforces it).
  - Include the Rule-of-Two table (spec §11.2) and the six accepted residual risks (spec §11.9), verbatim in substance.
  - Group the controls under the six SANS Critical AI Security Guidelines domains.

- [ ] **Step 2: Write `kill-switches.md`** with exact commands or UI paths, fastest first:
  1. zero or revoke the provider keys;
  2. suspend the GitHub App installations;
  3. `sudo -iu hapi mise run down`;
  4. `sudo nft` / `ufw` drop for uid `hapi`.

- [ ] **Step 3: Verify** by having one fresh reader (a subagent) check every residual risk in spec §11.9 against the threat model. Expected: each appears with an owner control and a "next level" item.

- [ ] **Step 4: Commit** `git commit -am "docs(security): MAESTRO threat model v0 and kill-switch runbook"`

---

### Task 7b: Pre-publish cleanup (private split, sanitize, guardrails, history rewrite)

The repo stays private until this task is done. Its requirements are this text plus the register's [§ Plan 01 Task 7b](handoffs.md#plan-01-task-7b-publishing) (H-054–H-060), H-073, and H-169 (CodeRabbit's threat-model entry, audit checks and kill switch, which must land before the operator installs it, H-164; its config, H-165, is done). It runs after Task 7 and before the operator's publish steps (H-074–H-078). The secrets store, provider keys, Slack app and host setup don't wait on it. Stage b does: `mise run up` refuses an empty secret, the four `host` App values included, and those exist only once the GitHub Apps are made (H-077), which needs hapi-factory public with its rulesets. So stage b (H-080) runs after this task and the publish steps.

**Operator gates.** The steps marked **[operator]** stop and wait for the operator:
- edits to `mise.toml` and `.github/**` (protected paths, `interactive: ask`), so the diff goes to the operator to approve;
- the license choice (H-073);
- the history rewrite (Step 7), which is destructive: it runs only after a backup and the operator's go-ahead at that moment;
- every push, and making the repo public (H-074), which are the operator's.

**Files:**
- Move (untracked from hapi-factory, kept on disk): `research_notes/`, `reports/` → `private/` (its own git repo, remote `hapi-factory-private`, H-054)
- Create: `docs/research/README.md`; a gitleaks pre-commit hook and its install step; `private/personal-strings.txt` and `private/replacements.txt` (private, never in the public tree)
- Modify: the 15 files H-055 lists, README's manual setup steps (H-059), this plan's Task 1 Step 6 (H-059), `src/audit/` (H-058), `.github/workflows/ci.yml` **[operator]** (H-057, H-060), `mise.toml` **[operator]** (H-055's name in its comments), `docs/superpowers/plans/handoffs.md`
- Create **[operator]**: `LICENSE`, and `license` in `package.json` (H-073)

- [ ] **Step 1: Private split (H-054).** `git init private` (if it isn't a repo yet). Move `research_notes/` and `reports/` into it and commit there, locally (no remote yet). In hapi-factory, `git rm -r --cached research_notes reports`. Write `docs/research/README.md`: what research exists, the conclusions that shaped the spec (with spec section numbers), and that the sources are private. No personal data. Point the spec's and this plan's "Supporting evidence is in `reports/` and `research_notes/`" at it.

- [ ] **Step 2: Sanitize (H-055).** The operator's first name becomes "the operator", and the spec's Owner line loses the full name. In commands and examples a reader adapts, the GitHub login becomes `$OWNER` or `<owner>` (as the runbooks and `example-owner` tests already do), but the login itself is not a personal string: it is public by necessity (the repo's URL, the clone command, `.github/CODEOWNERS`), so it stays where the real repo is meant. List every personal string once in `private/personal-strings.txt`, and the replacement for each in `private/replacements.txt` (filter-repo's `--replace-text` format, used in Step 7). Then `git grep -n -i -w -F -f private/personal-strings.txt` (the tracked tree, any case, whole words, as the hooks match) must find nothing. The `mise.toml` comment lines are **[operator]**.

- [ ] **Step 3: Publish instructions (H-059).** Rewrite README's manual setup steps for the real sequence: both repos already exist, private and empty; nothing is pushed until this task is done; then push, make hapi-factory public, and apply the two rulesets (`main-protect`, `main-review`; H-075). Point this plan's Task 1 Step 6 at H-074.

- [ ] **Step 4: Audit check (H-058).** Add `repo.private-untracked` to `runAudit`: it fails if `git ls-files private/` lists anything, or if `.gitignore` doesn't ignore `private/`. Tests with fakes (pass, a tracked file, a missing ignore). Document it in docs/audit.md.

- [ ] **Step 5: Guardrails (H-057, H-060).**
  - A pre-commit hook that runs `gitleaks git --pre-commit --staged --redact` and the personal-strings check (`private/personal-strings.txt`, skipped with a printed notice when `private/` is absent, as in a fresh public clone). Install it with `git config core.hooksPath <dir>`, documented in README.
  - **[operator]** In `.github/workflows/ci.yml`: a full-history gitleaks job (`fetch-depth: 0`, the pinned gitleaks), and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` (H-060).
  - The personal-strings list never goes into the public tree or CI: CI catches secrets, and the hook and Step 7 catch personal strings.

- [ ] **Step 6: License (H-073) [operator].** The operator picks the license; add `LICENSE` and `package.json`'s `license`.

- [ ] **Step 7: History rewrite (H-056) [operator].** Right before the first push, after Steps 1–6 are committed:
  1. Back up first: `git branch backup/pre-filter-repo` and `git bundle create private/pre-filter-repo.bundle --all`.
  2. With the operator's go-ahead, run `git filter-repo --invert-paths --path research_notes --path reports --replace-text private/replacements.txt --replace-message private/replacements.txt` (add `--mailmap private/mailmap` if the operator wants the author and committer email changed, e.g. to their GitHub noreply address) (run from a pinned version, e.g. `uvx git-filter-repo==<version>`; adding it to mise.toml is **[operator]**).
  3. Verify:
     - `gitleaks git --redact` over the whole rewritten history finds nothing;
     - `git log -p --all --format=%B | grep -n -i -w -F -f private/personal-strings.txt` finds nothing (messages and diffs only: `--format=%B` leaves out the author and committer lines, which the operator keeps or rewrites with `--mailmap`);
     - `git log --all -- research_notes reports` is empty;
     - `mise run lint && mise run test` pass.
  4. Remap the SHAs in the register's Closed table from `.git/filter-repo/commit-map`.

- [ ] **Step 8: Hand over to the operator.** The remaining steps are H-074's: push the cleaned history (the operator confirms the first push to each remote), make hapi-factory public, apply the rulesets (H-075), CODEOWNERS (H-076), the Apps (H-077) and the merge-refusal check (H-078), and push `private/` to hapi-factory-private.

- [ ] **Commits:** one per step 1–6, each with the register items it closes. Step 7 rewrites them all.

---

### Tasks 8–14: Verify-early spikes (spec §19)

Each spike works in `spikes/scratch/<n>/` (gitignored, throwaway). It records **result, evidence (commands and output), decision, and the consequence for Plan 0X** in `docs/spikes/NN-<name>.md`, then commits only that note. A spike that disproves a design assumption stops the line. Raise it with the operator before writing the dependent plan.

Spike 2 of spec §19 (Pi config skew) is **resolved by design**: Archon's Pi uses its own read-only `PI_CODING_AGENT_DIR`, and any standalone Pi CLI is pinned to 1.3.0. Nothing to run.

### Task 8: Spike: Pi under Archon (for Plans 02/03)

- [ ] **Step 1:** In the Archon container, create a target worktree containing:
  - a `.pi/extensions/evil.ts` that writes `/tmp/pwned`;
  - a `.pi/settings.json` listing an npm package.

  Add a user-level test extension in the mounted `PI_CODING_AGENT_DIR` that blocks writes to `AGENTS.md` and throws from `before_provider_request` when `FAIL_ME=1`.
- [ ] **Step 2:** Run a one-node Pi workflow with `enableExtensions: true` **after** a bash node that `rm -rf .pi .agents`. Expected:
  - no `/tmp/pwned`;
  - no npm install attempted (Squid log shows no `registry.npmjs.org` hit from install, and `PI_OFFLINE=1` is honored);
  - the user-level extension loaded (its block fires on an `AGENTS.md` write).
- [ ] **Step 3:** Re-run with `FAIL_ME=1`. Expected: the node fails, with the extension error as evidence.
- [ ] **Step 4:** Record the result in `docs/spikes/01-pi-under-archon.md` and commit.

### Task 9: Spike: Hermes path-guard mechanics (for Plan 04)

- [ ] **Step 1:** Write a minimal Python plugin (`plugins.isolation: host`) whose `pre_tool_call` returns an approve decision for writes matching `.factory/**`. Have it log `ctx.current_cron_execution()` and `ctx.session_surface()`.
- [ ] **Step 2:** Test three surfaces:
  - (a) an interactive CLI session writing `.factory/x`: expected to prompt;
  - (b) a cron job doing the same: expected to deny;
  - (c) an interactive `echo hi > .factory/y` via the terminal tool: record whether it's caught (#143266);
  - (d) with `skills.write_approval: true`, whether `write_file`, `patch` or the terminal tool can edit a skill file directly and so skip the approval (an open upstream issue says the generic write tools aren't covered). If they can, Plan 04's hapi-path-guard also protects the skills directories (handoffs H-064, H-093).
- [ ] **Step 3:** Record the result in `docs/spikes/02-hermes-path-guard.md`. If (c) isn't caught, record the fallback for Plan 04: `hapi-cmd-allow` denies shell redirection into protected paths. Commit.

### Task 10: Spike: Archon budget, trigger inputs, env propagation (for Plan 03)

- [ ] **Step 1:** Write a 3-node workflow with `budget: {max_spend_usd: 0.05}`: bash, then a Pi prompt, then bash. Fire it with `archon trigger fire --delivery-id spike-1 --inputs '{"work_order_id":"w1","traceparent":"00-<32hex>-<16hex>-01"}'`.
- [ ] **Step 2:** Expected:
  - the budget is accepted (no load error);
  - the run stops when the budget is hit;
  - the inputs are visible as `$INPUTS_*` in the bash nodes;
  - record whether `WORKFLOW_ID` and any exported `TRACEPARENT` reach Pi's bash (`env | grep -E 'WORKFLOW_ID|TRACEPARENT'` run from within the Pi node).
- [ ] **Step 3:** Record the result in `docs/spikes/03-archon-budget-trigger-env.md` and commit.

### Task 11: Spike: Anthropic history-edit rejection and Agent SDK billing (for Plans 02/03/04)

- [ ] **Step 1:** With the `hapi-evals` key on Haiku 5.5, force Hermes compression (a tiny `compression` threshold) and Pi compaction (a tiny window in a test `models.json`) in short sessions. Record any 4xx mentioning edited history, for Opus 5.5 and Sonnet 5.5 too (≤ $1 total).
- [ ] **Step 2:** Run one Claude-provider Archon node (one short prompt). In the Console, confirm it billed to the `hapi-factory` workspace **API credit**, not the subscription.
- [ ] **Step 3:** Record the result in `docs/spikes/04-anthropic-history-and-billing.md`, including the spend, and commit.

### Task 12: Spike: images under rootless Docker (for Plan 01 Task 5 hardening, and Plans 03/04)

- [ ] **Step 1:** Under `hapi`, run the pinned Hermes and Archon images with `read_only: true` and `cap_drop: ALL`. Record which paths need `tmpfs` or volumes, and any capability that has to come back.
- [ ] **Step 2:** Record the result in `docs/spikes/05-rootless-images.md`. If a hardening option had to be relaxed, update `stack/compose.yaml` in the same commit, with a comment naming the spike.

### Task 13: Spike: Hermes Slack gateway in Socket Mode (for Plan 04)

- [ ] **Step 1:** Create a Slack app in a dedicated workspace with Socket Mode on, and an allowlist containing only the operator's user ID. Start the Hermes gateway inside the stack (Slack hosts already allowlisted).
- [ ] **Step 2:** Expected:
  - DMs from the operator are answered;
  - a second test user is ignored;
  - no inbound port is opened (`ss -ltn` inside the container shows no new listener).
- [ ] **Step 3:** Record the result in `docs/spikes/06-hermes-slack-socket-mode.md` and commit.

### Task 14: Spike: Odoo sidecar for smoke tests (for Plans 03/05/07)

- [ ] **Step 1:** Run the official `odoo` + `postgres` images, digest-pinned, on `archon-net` as `odoo.internal`. Write `spikes/scratch/odoo/seed.py`, which creates 3 partners and 2 posted customer invoices via Odoo's external JSON-RPC API.
- [ ] **Step 2:** From the Archon container, call `res.partner` `search_read` through the external API. Expected: 3 partners. Record startup time and RAM.
- [ ] **Step 3:** Record the result in `docs/spikes/07-odoo-sidecar.md`, including the exact compose snippet Plan 05's template will use, and commit.

---

## Phase 0 done when

- `sudo -iu hapi mise run up` brings up all five services healthy.
- `mise run test` and `mise run test:int` pass.
- `mise run audit` exits 0.
- `docs/security/threat-model.md` exists.
- All seven spike notes are committed, each with a decision and its consequence for the next plans.
- [handoffs.md](handoffs.md) is current: diffed against the SDD ledger before the plan's workspace is deleted, with every open item assigned to a later task, plan or the operator.
