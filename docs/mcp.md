# MCP servers

An MCP server puts text into an agent's context. So each one is two risks at once (spec §10.1):
- a **supply-chain** risk: it is code we run;
- an **untrusted-input** source: its tool descriptions, instructions and results are text the model reads.

One catalog, [`policy/mcp.yaml`](../policy/mcp.yaml), says which layer gets which server, pinned exactly. `hapi policy build` compiles it into Hermes's `mcp_servers` and into a standard `mcp.json` per zone for the CI scanners. [`policy/mcp.lock.json`](../policy/mcp.lock.json) pins each server's tool descriptions, so a changed description fails closed.

This page covers:
- [what each layer gets](#what-each-layer-gets-v1);
- [how to add or upgrade a server](#adding-or-upgrading-a-server);
- [the release cooldown and its security-fix exception](#the-release-cooldown-and-the-security-fix-exception);
- [advisory floors](#advisory-floors) and [the tool-description lock](#the-tool-description-lock);
- [the CI scanners](#the-ci-scanners).

Every field of `mcp.yaml`, the checks the loader runs and the `hapi mcp` commands are in [docs/policy.md](policy.md#mcpyaml). The generated files are in [docs/generated-configs.md](generated-configs.md#buildmcpmcpjson). The design is spec §10.1; the evidence (pins, integrities, tool names, env vars) is `research_notes/Hapi factory plugins and o11y/mcp_baseline.md`.

## What each layer gets (v1)

| Layer / zone | MCP servers | Notes |
|---|---|---|
| `hapi-research` (`research` zone, its own container) | **Context7** (`@upstash/context7-mcp` 4.3.0, T2) | The only general docs server with version-addressed library ids and a pinnable local client. Library-owner and teamspace "rules" can't be switched off client-side, so it stays quarantined: egress `context7.com` only, always with an API key, `OTEL_SDK_DISABLED=true`, and no proxy or URL overrides beyond the zone's own. |
| Hermes main session (`hermes` zone) | **None**, unless the observability profile runs. Then **Arize Phoenix MCP** (`@arizeai/phoenix-mcp` 4.3.16, stdio) | A VIEWER-role key, `PHOENIX_DISCOVER_CONFIG=false`, an explicit `PHOENIX_ENDPOINT`, the 23 read-only tools only. `phoenix-support` is denied, because it forwards queries to a third party. |
| Archon Pi workers and Claude review nodes (`archon` zone) | **None, ever.** The schema rejects a server that lists the archon zone. | Workers see T0–T1 only. Docs reach them as research notes and reviewed, hashed snapshots. |
| Claude Code lane (phase 4) | Generated from the same catalog, with `--strict-mcp-config` | Context7 only under research-zone quarantine. |

"The observability profile runs" means `flags.otel.enabled: true` in `policy/flags.yaml` (or the `o11y` build option in code). It is off by default.

**Web search is not an MCP server.** The research zone uses Hermes's native `web_search` and `web_extract` (Brave for search, Exa contents or Firecrawl for extract). They have a fixed, Hermes-owned schema, so there is no vendor tool text to change under us. Spec §10.1 lists the servers deliberately left out of v1 (GitHub, search MCPs, the reference servers, Playwright, gateways) and why.

**Blocked by name:** `@modelcontextprotocol/server-brave-search`, `crawl4ai`, `ai.smithery/*`, `@upstash/context7-pi` and `@upstash/context7-admin-mcp`. The loader rejects a server whose package matches one.

## Adding or upgrading a server

Adding or upgrading a server is `new_skill_or_mcp`, one of the approvals that always need the operator (`policy/approvals.yaml`). So it is a **planning PR**, reviewed like any other policy change. In that PR:

1. **Say why**, and which zone needs it. Prefer a native tool where one exists (spec §10.1 "Native vs MCP"). The archon zone gets none.
2. **Pick the pin.** Take the newest release that is at least 14 days old ([cooldown](#the-release-cooldown-and-the-security-fix-exception)), and its registry integrity:

   ```bash
   npm view @upstash/context7-mcp time --json            # release dates
   npm view @upstash/context7-mcp@4.3.0 dist.integrity   # sha512-...
   ```

   Write both in the entry, with the release date in a comment.
3. **Read the package** (the tarball, or the tagged source). List every tool it registers:
   - read-only tools go in `tools.include`;
   - write tools, and tools that send data to a third party, go in `tools.deny`;
   - list every env var it reads, and add the ones it needs to its entry in **`PACKAGE_ENV`** (`src/policy/mcp.ts`), the [env allowlist](policy.md#the-env-allowlist). Each is a `secret` (a bws reference), a `flag` (a literal from the values you list) or an `endpoint` (a literal URL whose host must be one of the entry's `egress` hosts). A server gets only the names listed there, so leave out anything that redirects its traffic or loads extra files. The loader also has a hard denylist for every server (proxies, `NODE_*`, `NPM_*`, `LD_*`, `PATH`, `HOME`, `CONTEXT7_API_URL`, `PHOENIX_CLIENT_HEADERS`, `DANGEROUSLY_READ_README_FILES` and more); never put one of these on an allowlist.
4. **Add a floor** for any advisory the scanners don't track ([advisory floors](#advisory-floors)).
5. **Give it its own bws key**, if it needs a secret: `env: { SOME_API_KEY: bws:hapi-mcp-<name> }`. Never write a secret as a literal: the loader rejects a literal under a `secret` name, and under any name ending in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL(S)`. Each key belongs to one server, and the loader rejects a key two servers share. Storing the secret in Bitwarden is a manual step for the operator. The generated configs reference it as `${HAPI_MCP_<NAME>}`, so add that env var, with the secret's bws id, to the server's zone in `stack/secrets.map.yaml`. `hapi secrets resolve` and a unit test both fail until you do ([docs/secrets.md](secrets.md#the-secrets-map-stacksecretsmapyaml)). Never write `$` anywhere else in the entry: Hermes expands `${...}` in a server's url, headers, args and env, so it would pull in another secret. The loader rejects `$` in a `url` or an env literal, and the generators reject any `$` in their output other than the server's own references.
6. **List its egress hosts.** In v1, egress is per zone, so the zone's proxy is the real boundary. The list is for review, and for per-server isolation in phase 2.
7. **Check it:** `mise run test && mise run policy:build`. The loader checks every rule on [docs/policy.md](policy.md#mcpyaml).
8. **Pin its surface:** `hapi mcp pin --server <name>`, and commit `policy/mcp.lock.json` in the same PR. The reviewer reads the recorded tool descriptions, instructions, prompts and resources there. (The live fetch arrives in Plan 01 Task 5. Until then the command exits 1.)

**An upgrade** is the same PR with a new version and integrity. Re-read the env vars the new version reads (step 3), and update `PACKAGE_ENV` if they changed. The old lock entry was recorded for the old pin, so the server is `unpinned` until step 8 is done again.

**Removing a server** removes its entry from `mcp.yaml`, its `PACKAGE_ENV` entry and its lock entry, in one PR. A lock entry left behind is `orphaned`, and `hapi mcp verify` fails on it.

## The release cooldown and the security-fix exception

**Pins wait 14 days** after release. A compromised release usually gets caught and pulled within that window. On 2026-10-26 that is why Context7 is pinned at 4.3.0 (2026-10-09) rather than 4.4.4 (2026-10-19), and Phoenix MCP at 4.3.16 (2026-10-09) rather than 4.3.17 (2026-10-21).

**The security-fix exception:** a release that fixes a vulnerability in every older version may skip the cooldown. Record why in the entry's `cooldown_exception`, as the advisory id:

```yaml
cooldown_exception: GHSA-v38p-wf49-hx2j   # e.g. mcp-server-fetch 2026.10.24: every earlier release has the IDNA guard bypass
```

The loader runs offline and has no release dates, so it can't check the cooldown itself. The planning PR's reviewer checks it against the release-date comment.

## Advisory floors

Some advisories have no OSV record, so OSV-based scanners stay silent about them. For those, the entry carries **our own floor**:

```yaml
floor: { min: "2.1.3", advisory: CVE-2026-75130 }
```

The loader rejects a pinned version below `min`, naming the advisory:

```text
policy/mcp.yaml: /servers/context7/package/version: 2.1.2 is below this server's advisory floor 2.1.3 (CVE-2026-75130); pin 2.1.3 or later
```

Context7's ContextCrush (CVE-2026-75130, ≤ 2.1.2) was fixed on Upstash's **backend** on 2026-02-23, so a client pin can't enforce the fix. The floor stops an old client coming back; the research-zone quarantine is the real control, because the rules channel stays a live injection path.

## The tool-description lock

A server can change its tool descriptions or instructions in a release, or at any time if it is remote, and the model reads that text. Neither Hermes's schema cache nor Pi pins it. So:

- **`hapi mcp pin --server <name>`** records the server's raw surface (its `tools/list` result, `instructions`, prompts and resources), the pin it was recorded for, and the surface's hash in `policy/mcp.lock.json`.
- **`hapi mcp verify`** fetches every catalog server's live surface and compares hashes. It exits 1 if any server has `changed` or is `unpinned`, and prints the re-pin commands. It also exits 1 if the lock has an `orphaned` entry, for a server no longer in the catalog. It never launches that server; it says to remove the entry.
- The hash ignores order (tools sorted by name; prompts and resources sorted too) and nothing else. One changed character of a description, a schema or the instructions is a different hash.
- `fetchSurface` launches the pinned server in a throwaway container on its zone's network. **Plan 01 Task 5** wires it; until then both commands exit 1. Spec §10.1 also has stack start-up and `hapi audit` (Task 6's `mcp.tool-hashes` check) fail closed on drift.
- Re-approving a change is a planning PR: re-pin, and commit the lock. A remote-only endpoint changes without a release, so each change to one is a review event.

## The CI scanners

Plan 05 runs these on every change to `policy/mcp.yaml` or `policy/mcp.lock.json`, in this order:

1. **Cisco `mcp-scanner`**, offline YARA and static checks over the lockfile's tools, prompts and resources. It never runs a server.
2. **Snyk Agent Scan**, in a sandbox with egress limits, fed `build/mcp/<zone>.mcp.json`. It does run the servers, and it uploads their descriptions to Snyk.
3. **Our advisory-floor check:** `loadPolicy`, through `mise run test` and `mise run policy:build`.

`build/mcp/<zone>.mcp.json` lists the zone's whole catalog, o11y-gated servers included, because the scanners vet what may run. Secrets appear only as `${HAPI_MCP_...}` references.

**Scanners are a floor, not a verdict.** Pattern rules miss novel poisoning. The human gate is the planning PR, and nothing from the research zone reaches the workers without one.

## Open items

- **Per-server images, and integrity at launch.** The generated command is `npx --yes <package>@<version>`. It pins the package's version, but:
  - **`package.integrity` is recorded but not yet enforced at launch.** npx resolves `<package>@<version>` from the registry and never compares it with the catalog's integrity.
  - **It doesn't pin the dependency tree.** The package's own dependencies resolve at start-up, from their semver ranges.
  - It fetches at start-up, which an internal-only network can't do.

  Spec §10.1 wants one image per server, built from a committed lockfile and pinned by digest (the entry's `image`). **Plan 04's per-server lockfile images are required before Context7 runs for real.** Until image launch lands, the generators refuse an entry that sets `image` (so `hapi policy build` fails), because the npx command would ignore the image: the entry would look pinned by digest and still run unpinned.
- **The Phoenix endpoint.** The catalog points Phoenix MCP at `http://phoenix.hapi.internal:6006`. The observability profile must serve Phoenix under that name on the hermes network, or change the entry. The hermes proxy refuses private addresses, so the profile also gives the Hermes container a direct route to that one host.
- **Hermes keys.** The `mcp_servers` keys follow Hermes v0.22.5's docs: `command`, `args`, `env`, `tools.include`, `tools.prompts`, `tools.resources`, `elicitation.enabled` and `sampling.enabled`. `trust` comes from the research notes (`hermes_agent.md`). Task 6's audit checks Hermes's own validation output, which shows any key Hermes ignores.
