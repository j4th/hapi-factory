# Threat model v0

This is hapi-factory's threat model, the `docs/security/threat-model.md` that spec §11.1 and §11.9 name. It covers the **Phase 0 stack as built** (Plan 01) and the **planned Phase 1 flow** (spec §4, §11), with **CSA MAESTRO** as the method: its 7 layers and its 6 steps. Threats carry IDs from the OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10), the OWASP Top 10 for LLM Applications 2025 (LLM01–LLM10), the OWASP MCP Top 10 where it applies, and MITRE ATLAS 2026.09. Controls are grouped under the six domains of the SANS Critical AI Security Guidelines.

- **Version:** v0, 2026-10-27, written in Plan 01 Task 7. The operator owns it.
- **Who's who:** "the operator" is the one person who runs the factory, holds the admin rights, approves and merges. `$OWNER` is the GitHub owner of the repos.

## How to use and update this document

**Reading it.** [The system](#1-the-system) says what is in scope and where the trust boundaries are. [Threats by layer](#4-threats-by-maestro-layer) lists each threat with its catalog IDs and the controls that answer it. [Controls](#6-controls-by-sans-domain) gives every control's spec section, the files that enforce it and its status. [The six residual risks](#7-spec-119-residual-risks) of spec §11.9 and [the other accepted residuals](#8-other-accepted-residuals) each name an owner control and a next level.

**Update it in the same PR as the change**, whenever:
- a zone, container, service or trust domain is added, or changes what it can reach (`stack/compose.yaml`, `policy/trusted_sources.yaml`);
- an MCP server, skill, plugin or tool is added or upgraded (`policy/mcp.yaml`);
- a credential or secret is added, moved to another zone or given a new scope (`stack/secrets.yaml`, an App's permissions, a provider key);
- a control changes status: a plan lands a planned control, or stage b verifies a documented one. Change its row;
- a residual is accepted, changed or retired: add or edit its entry. Any work it defers gets an H number in [the handoffs register](../superpowers/plans/handoffs.md) in the same commit.

**Each control's status is one of four:**
- **enforced**: the named file enforces it and the named test proves it;
- **documented, not verified live (H-xxx)**: written and, where it is code, unit-tested, but never run on the real host or against the real GitHub repo. H-xxx is the check that will;
- **accepted residual**: a known gap, accepted for v1, with its entry below;
- **planned (Plan 0X, H-xxx)**: not built yet; H-xxx is the register item that carries it.

**Anchors are stable.** Spec §11.9's residuals are `#residual-1` to `#residual-6`, in the spec's order. Each register item closed into this document is `#h-NNN`, its H number in lower case. Threat IDs (L1.1, …) and control IDs (AC-1, …) are never reused. `tests/docs/threat-model.test.ts` checks the residual and register anchors, the register's Closed rows, and that every repo path written here exists.

## Contents

1. [The system](#1-the-system) (MAESTRO step 1)
2. [Method and catalogs](#2-method-and-catalogs)
3. [Rule of Two per stage](#3-rule-of-two-per-stage)
4. [Threats by MAESTRO layer](#4-threats-by-maestro-layer) (step 2)
5. [Cross-layer threats](#5-cross-layer-threats) (step 3)
6. [Controls, by SANS domain](#6-controls-by-sans-domain) (step 5)
7. [Spec §11.9 residual risks](#7-spec-119-residual-risks), with [the risk assessment](#risk-assessment) (step 4)
8. [Other accepted residuals](#8-other-accepted-residuals)
9. [Implementation and monitoring](#9-implementation-and-monitoring) (step 6)
10. [Where the build differs from spec §11](#10-where-the-build-differs-from-spec-11)
11. [Sources](#11-sources)

## 1. The system

### In scope

**Built in Plan 01:**
- **The host:** the operator's account, root, and the dedicated `hapi` user with its rootless Docker (`scripts/host-setup.sh`, first run on the real host in stage b, 2026-10-28).
- **The stack**, `stack/compose.yaml`: `hermes` (Hermes v0.22.5, the coordinator), `archon` (Archon 0.12.1, with Pi 1.3.0 in-process as the worker), and one Squid egress proxy per zone (`egress-hermes`, `egress-archon`, `egress-research`), on internal-only networks.
- **Policy**, `policy/`, compiled into every tool's config by `src/generate/` (the gitignored `build/`).
- **Secrets:** the manifest `stack/secrets.yaml`, sops + age by default, and the zone env files on hapi's tmpfs (`src/secrets/`).
- **GitHub:** two Apps and four rulesets, applied by hand on 2026-10-27 from the [GitHub Apps runbook](../runbooks/github-apps.md) (H-074–H-077), and App token minting (`src/forge/github/app-token.ts`).
- **`hapi audit`** (`src/audit/`) and the [kill switches](../runbooks/kill-switches.md).

**Planned for Phase 1** (spec §4.2, §15): hapi-guard and Jev (Plan 02, built; the Plan 02 section below says what is left); the `factory-task` workflow, poller, mirror and harvester (Plan 03, built; [the Plan 03 section](#plan-03-the-run-engine) below says what is left); Hermes's plugins and skills and the research container (Plan 04); the repo contract and CI gates (Plan 05); evals and metrics (Plan 06).

**Out of scope for v0:** the o11y profile (Phase 3), the Claude Code lane (Phase 4), GitLab (Phase 5), and any second trust domain, such as the planned abliteration.ai security work ([its entry](#abliteration-ai)).

### The flow (spec §4.2)

1. The operator talks to Hermes in Slack (Socket Mode: no inbound endpoint).
2. Hermes gets research briefs from hapi-research (web only), writes the plan and work orders on `plan/<feature>`, and opens a planning PR with a 1-hour `hapi-planner` token.
3. The operator reviews and merges it.
4. The host poller sees the merge and fires one Archon run per work order.
5. Archon runs `factory-task`: prepare (strip `.pi/` and `.agents/`), implement (Pi, with hapi-guard), gates, an independent review, and a commit to a local mirror ref.
6. The harvester, deterministic host code with a 1-hour `hapi-factory` token, pushes `factory/<id>` and opens the PR.
7. The operator reviews and merges, with `ci` green.

### Trust zones

| Zone | Runs as | Holds | Way out | Never has |
|---|---|---|---|---|
| The operator | the operator's account, with sudo | repo and App admin, the secrets store and its 10 words, the kill switches | the host's own | — |
| Root | root | the host | — | a reason to act on a path in hapi's home ([AC-2](#61-access-controls)) |
| `hapi` host user | `hapi`, rootless Docker | its copy of the store and its own age key; `host.env` (the App keys); container control | the host's own (switch 4 cuts it) | the operator's credentials and sessions |
| hermes zone | container, uid 10000 | the capped `hapi-hermes` key, the Slack tokens; later a 1-hour planner token (H-098) | `egress-hermes`: T0–T1, model APIs, GitHub, Slack | merge rights, App keys, Archon's or Pi's keys |
| archon zone | container, uid 1001; Pi in-process | the capped `hapi-factory` key, OpenCode Go, the $2 Jev key | `egress-archon`: model APIs and three registries | any forge credential or route, any MCP server, the web |
| research zone | its container arrives in Plan 04 (H-099) | spend-capped, search-only keys (Brave, Exa, Context7) | `egress-research`: any public name, no IP literal, no private range | repo write, a terminal, other zones' keys |
| `host` secrets zone | no container | the App IDs and private keys | — | a container ([AC-5](#61-access-controls)) |
| GitHub | — | the record; the rulesets; the operator's review | — | — |
| Providers | — | Anthropic, OpenCode Go, OpenRouter (Jev), Brave, Exa, Context7, Slack | — | — |

**The trust boundaries:**
- **B1, operator and root → hapi.** hapi runs the agents, so it is less trusted than root. Root never writes, creates, chowns or chmods a path inside hapi's home; it hands bytes over stdin or a `tar` pipe to a process running as hapi (AC-2). `up` and `down` re-exec as hapi with your arguments as argv, never through a login shell (AC-3).
- **B2, hapi → containers.** Rootless Docker and the hardening set (DS-6); each container gets only its zone's env file (AC-5).
- **B3, zone → zone.** Each zone has its own internal network; only the proxies share `outbound`, and can't reach each other on it (DS-1).
- **B4, zone → internet.** The zone's Squid proxy is its only way out (DS-2).
- **B5, factory → GitHub.** App tokens are minted on the host, one repo and one hour at a time (AC-6), and only the operator merges (AC-7). This is the human-approval boundary: nothing inside the Archon container is one, since Pi runs in-process with Archon and any local process can answer Archon's approvals (spec §4.3; [residual 1](#residual-1)).
- **B6, factory → providers.** Capped keys and retention terms (GR-7, DP-10).
- **B7, trust domain → trust domain** (spec §4.4). v1 has one domain, "oss".

### The MAESTRO layers here

| Layer | In hapi-factory |
|---|---|
| L1 Foundation Models | Claude Opus, Sonnet and Haiku 5.5 on the Anthropic API; OpenCode Go's zero-retention models (the portable roster); Jev (`typesafe/jev-*`) through OpenRouter |
| L2 Data Operations | repo content and work orders; research briefs and notes; Hermes's memories and skills; Archon's run DB and worktrees; the MCP lock; the secrets store |
| L3 Agent Frameworks | Hermes, Archon and Pi, with configs generated from `policy/`; hapi-guard and Hermes's plugins (planned); the MCP clients |
| L4 Deployment and Infrastructure | the host, the `hapi` user, rootless Docker, `stack/compose.yaml`, the zone networks and proxies, the tmpfs env files, the images and pins |
| L5 Evaluation and Observability | `hapi audit`; container logs; metrics and evals (Plan 06); the o11y profile (Phase 3) |
| L6 Security and Compliance (vertical) | `policy/` (protected paths, commands, approvals, budgets, trusted sources); the rulesets and CODEOWNERS; secrets management; CI gates; this document |
| L7 Agent Ecosystem | GitHub and the two Apps; Slack; the model and search providers; MCP servers; CodeRabbit (installed on hapi-factory, H-164); other trust domains |

## 2. Method and catalogs

MAESTRO's six steps, and where each one is here:

| Step | Section |
|---|---|
| 1. System Decomposition | [1](#1-the-system) |
| 2. Layer-Specific Threat Modeling | [4](#4-threats-by-maestro-layer) |
| 3. Cross-Layer Threat Identification | [5](#5-cross-layer-threats) |
| 4. Risk Assessment | [the risk assessment](#risk-assessment) in 7 |
| 5. Mitigation Planning | [6](#6-controls-by-sans-domain), [7](#7-spec-119-residual-risks), [8](#8-other-accepted-residuals) |
| 6. Implementation and Monitoring | [9](#9-implementation-and-monitoring) |

**The catalog IDs used**, with their official names (versions and dates in [Sources](#11-sources)):

| Catalog | IDs |
|---|---|
| OWASP Top 10 for Agentic Applications 2026 | ASI01 Agent Goal Hijack; ASI02 Tool Misuse and Exploitation; ASI03 Identity and Privilege Abuse; ASI04 Agentic Supply Chain Vulnerabilities; ASI05 Unexpected Code Execution (RCE); ASI06 Memory & Context Poisoning; ASI07 Insecure Inter-Agent Communication; ASI08 Cascading Failures; ASI09 Human-Agent Trust Exploitation; ASI10 Rogue Agents |
| OWASP Top 10 for LLM Applications 2025 | LLM01:2025 Prompt Injection; LLM02:2025 Sensitive Information Disclosure; LLM03:2025 Supply Chain; LLM04:2025 Data and Model Poisoning; LLM05:2025 Improper Output Handling; LLM06:2025 Excessive Agency; LLM09:2025 Misinformation; LLM10:2025 Unbounded Consumption (LLM07 and LLM08 don't apply here) |
| OWASP MCP Top 10 (2025, beta) | MCP01:2025 Token Mismanagement & Secret Exposure; MCP03:2025 Tool Poisoning; MCP04:2025 Software Supply Chain Attacks & Dependency Tampering; MCP06:2025 Intent Flow Subversion (the project page calls it "Prompt Injection via Contextual Payloads"); MCP08:2025 Lack of Audit and Telemetry; MCP09:2025 Shadow MCP Servers; MCP10:2025 Context Injection & Over-Sharing |
| MITRE ATLAS 2026.09 | AML.T0010.001 AI Supply Chain Compromise: AI Software; AML.T0010.004 AI Supply Chain Compromise: Container Registry; AML.T0010.005 AI Supply Chain Compromise: AI Agent Tool; AML.T0011.001 User Execution: Malicious Package; AML.T0012 Valid Accounts; AML.T0025 Exfiltration via Cyber Means; AML.T0034.002 Cost Harvesting: Agentic Resource Consumption; AML.T0050 Command and Scripting Interpreter; AML.T0051 LLM Prompt Injection (.000 Direct, .001 Indirect); AML.T0053 AI Agent Tool Invocation; AML.T0054 LLM Jailbreak; AML.T0055 Unsecured Credentials; AML.T0060 Publish Hallucinated Entities; AML.T0067 LLM Trusted Output Components Manipulation; AML.T0080 AI Agent Context Poisoning (.000 Memory); AML.T0081 Modify AI Agent Configuration; AML.T0083 Credentials from AI Agent Configuration; AML.T0086 Exfiltration via AI Agent Tool Invocation; AML.T0091.000 Use Alternate Authentication Material: Application Access Token; AML.T0093 Prompt Infiltration via Public-Facing Application; AML.T0101 Data Destruction via AI Agent Tool Invocation; AML.T0105 Escape to Host; AML.T0109 AI Supply Chain Rug Pull; AML.T0110 AI Agent Tool Poisoning (.000 Definition and Instructions, .002 Runtime Response); AML.T0118.000 Autonomous AI Agent Communication: Communication via Shared Artifacts; AML.T0119 Exploit Automated Artifact Processing Pipeline; AML.T0130 AI Agent Response Biasing |

Every ID was looked up in its source on 2026-10-27; none is from memory. Spec §11.1 also names the OWASP LLM Top 10's 2026 crosswalk, the Agentic Skills Top 10 (draft) and OWASP AISVS levels 1–2 for the controls. v0 doesn't use them (H-158, H-159).

## 3. Rule of Two per stage

Spec §11.2, in substance: no stage should hold all three of untrusted input, sensitive access and the power to change state; where one does, its compensating control carries the weight.

| Stage | Untrusted input | Sensitive access | State change | Compensating control | In v0 |
|---|---|---|---|---|---|
| Hermes main session | Yes (chat, PR comments, briefs) | Minimal (planning token, capped key) | Yes (planning branch, messages) | Protected paths, cmd allowlist, PR review | Filename rules IS-2 enforced; hapi-path-guard IS-3 and the allowlist hook IS-4 planned (Plan 04, H-093, H-095); PR review AC-7 enforced (the App's merge refused live, H-078; the live audit in stage b, H-080); the planning token AC-10 planned (Plan 04, H-098) |
| hapi-research | Yes (T3 web) | None | None (returns a brief) | Quarantine and schema | Planned (Plan 04, H-099). It holds spend-capped search keys, so its sensitive access is minimal, not none (H-042, H-083) |
| Archon implement | Repo contents, work order | Capped model keys | Worktree only | Container, egress allowlist, hapi-guard, scope checks, no forge creds | Container DS-6, egress DS-2 and no forge route AC-9 enforced in config, on rootful Docker (stage a) and as hapi on rootless (stage b); hapi-guard DS-16 and the one-container-per-run isolation DS-15, DS-17 enforced in code and tests (Plan 02, H-087, H-182; live model runs in the paid check, Plan 02 Task 11, 2026-10-31); the host-side diff and scope gates on the bundle enforced in code and tests (Plan 03, H-203; the harvester's host gates, `src/engine/harvest.ts`) |
| Review | The diff | Read-only | None | Separate session and model | Enforced in code and tests (Plan 03, H-161): a container of its own that runs no repo code, with the review zone's keys only, on a model other than implement's (`startRun` refuses the same one), and Claude Code's managed settings denying every write, run, fetch and `/proc` read; its verdict is advice (IS-10). Its first live run is the sandbox's (Plan 03 Task 16) |
| Harvester and merge | Indirect | Forge write | Yes | Deterministic code; the operator's approval; required checks | The harvester enforced in code and tests (Plan 03, H-161): deterministic host code that runs no generative model, checks the bundle on the host before any push (H-203), pushes only `factory/<id>`, never forced, and never merges ([Plan 03](#plan-03-the-run-engine)); the approval and `ci` gate AC-7 enforced (the App's merge refused live, H-078; the live audit in stage b, H-080) |

## 4. Threats by MAESTRO layer

Each row: the threat, its catalog IDs, the controls that answer it ([section 6](#6-controls-by-sans-domain) has each control's spec section, enforcing files and status), and the residual entry where some of it is accepted.

### L1 Foundation Models

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L1.1 | Direct prompt injection: text typed or pasted into Hermes's chat steers it | ASI01; LLM01:2025; AML.T0051.000 | AC-12, IS-1, IS-3, IS-4, AC-7 | — |
| L1.2 | Indirect prompt injection: content a model reads (repo files, PR comments, briefs, MCP results) carries instructions | ASI01; LLM01:2025; MCP06:2025; AML.T0051.001 | IS-5, IS-6, IS-7, DS-15, AC-7 | [residual 5](#residual-5), [H-043](#h-043) |
| L1.3 | Jailbreak: a model ignores its instructions, so a rule written only in a prompt is advisory | LLM01:2025; AML.T0054 | Every control sits below the model: GR-1, DS-2, IS-1, AC-7 | — |
| L1.4 | A provider retains or trains on prompts and code | LLM02:2025 | DP-10 | [H-040](#h-040) |
| L1.5 | Hallucinated package or host names (slopsquatting) | ASI04; LLM09:2025; AML.T0060 | GR-4, GR-6, DS-8, DS-2 | — |
| L1.6 | Unbounded consumption: a loop, a long run or a leaked key burns the budget | LLM10:2025; AML.T0034.002 | GR-7, IS-9, DS-16 | [residual 3](#residual-3) |

### L2 Data Operations

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L2.1 | Poisoned memories or skills persist across Hermes sessions | ASI06; LLM04:2025; AML.T0080.000 | IS-1, IS-11, AC-15 | — |
| L2.2 | Repo content (`AGENTS.md`, `.pi/`, `.agents/`, code, docs) steers the worker | ASI01, ASI06; LLM01:2025; AML.T0051.001 | DS-15, DS-11, GR-3, GR-8, IS-5 | [residual 5](#residual-5) |
| L2.3 | A research brief carries injected instructions, biased sources or false claims into planning | ASI01, ASI09; LLM09:2025; AML.T0130 | IS-6, IS-7, AC-7 | [H-043](#h-043) |
| L2.4 | A work order is tampered with: a forge host in `egress_extra`, a second repo | ASI03; AML.T0081 | GR-5, AC-14 | — |
| L2.5 | Pi alters Archon's run records or answers its approvals | ASI07, ASI10; AML.T0081 | AC-7, AC-9 | [residual 1](#residual-1) |
| L2.6 | The secrets store, a machine's age key or the 10 recovery words leak | ASI03; LLM02:2025; AML.T0055 | DP-4, DP-5 | [H-046](#h-046), [H-047](#h-047), [H-137](#h-137) |

### L3 Agent Frameworks

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L3.1 | Hermes's terminal runs a command, or writes a file, that policy forbids (a shell write past the gate) | ASI02, ASI05; LLM05:2025, LLM06:2025; AML.T0053, AML.T0050 | IS-1, IS-2, IS-3, IS-4 | [residual 4](#residual-4) |
| L3.2 | Pi edits a protected path, or destroys data in its worktree | ASI02; LLM06:2025; AML.T0101 | DS-16, DS-15, GR-6 | — |
| L3.3 | A repo's `.pi/` settings make Pi install and run packages | ASI04, ASI05; LLM03:2025; AML.T0011.001 | DS-11, DS-15 | [residual 5](#residual-5) |
| L3.4 | An MCP server's tool descriptions change, or a release is rug-pulled | ASI04; MCP03:2025; AML.T0110.000, AML.T0109 | DS-12, DS-14, IS-8 | [H-049](#h-049) |
| L3.5 | An agent reads its own environment and sends a key out | ASI03; LLM02:2025; MCP01:2025; AML.T0083, AML.T0055 | AC-5, DS-2, GR-7, DP-8 | [residual 3](#residual-3) |
| L3.6 | A hand edit turns Hermes's approvals off, or yolo on, in a deployed config, or a process in the container plants a yolo variable in Hermes's writable `$HERMES_HOME/.env` | ASI10; LLM06:2025; AML.T0081 | GR-1, IS-1, MO-1 | [the audit's gaps](#audit-gaps) (H-190) |
| L3.7 | The in-run review is steered by the diff it reviews | ASI09; LLM01:2025; AML.T0067 | IS-10, AC-7 | [residual 6](#residual-6) |
| L3.8 | A file write to a repo's `.git/config` makes an allowed git command (`git status`, `git diff`) run a program it names (`core.fsmonitor`, `diff.external`, a textconv driver) | ASI05; AML.T0050, AML.T0081 | GR-3, IS-3, IS-4 (H-191) | — |

### L4 Deployment and Infrastructure

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L4.1 | A container escapes to the host | ASI05; AML.T0105 | AC-1, DS-6 | — |
| L4.2 | hapi, which runs the agents, plants a symlink in its home that turns a root write into a root compromise (`~/.bashrc` → `/etc/sudoers`) | ASI03 | AC-2 | — |
| L4.3 | An argument holding `$`, a backtick or a quote is re-parsed on its way to hapi (a login shell) and runs something | ASI05; AML.T0050 | AC-3, AC-4 | — |
| L4.4 | A secret named like a hardening setting (`HTTPS_PROXY`), a loader switch (`LD_PRELOAD`) or an endpoint (`ANTHROPIC_BASE_URL`) changes how a container runs, or where a key goes | ASI03, ASI05; MCP01:2025; AML.T0081 | DP-6, DP-7 | — |
| L4.5 | Traffic leaves a zone some other way: direct, by DNS, to an IP literal, by reverse lookup, or to a private or metadata address | LLM02:2025; AML.T0025, AML.T0086 | DS-1, DS-2, DS-3, DS-4, DS-5 | [H-045](#h-045) |
| L4.6 | Data leaves through an allowed host | ASI02; LLM02:2025; AML.T0086 | DS-2, AC-9 | [residual 2](#residual-2), [H-044](#h-044) |
| L4.7 | The deployed stack drifts from policy: a hand edit, a stale file, a key a tool ignores, a stack started outside `up` | ASI10; AML.T0081 | GR-1, DS-9, DS-10, MO-1 | [the audit's gaps](#audit-gaps) |
| L4.8 | A compromised image, tool or package release | ASI04; LLM03:2025; AML.T0010.004, AML.T0010.001, AML.T0011.001 | DS-7, DS-8 | [H-051](#h-051) |
| L4.9 | A kill switch doesn't stop what it should, when it's needed | ASI08, ASI10 | MO-5 | [not yet verified live](#not-yet-verified-live) |
| L4.10 | A run plants state that outlives it, and a later run or Archon itself executes it: a `.pi/` extension in a reused worktree, `core.fsmonitor` or `core.hooksPath` in `~/.gitconfig` (run by Archon's own git commands), a hook in `~/.claude/settings.json` (later Claude-provider nodes), a modified package in a cache, or another registry in `~/.npmrc`. A poisoned run can plant it and then get itself killed. Plan 02 gives each run a container of its own, so nothing it plants survives it: its `$HOME`, `/.archon`, Pi's directory and clone are tmpfs or per-run volumes removed with it | ASI05, ASI06; LLM03:2025; AML.T0081, AML.T0080.000 | DS-17, DS-15, DS-6 | — |
| L4.11 | A backup or image of hapi's home, a retired disk, or anything that reaches hapi's Docker socket reads every zone's keys from Docker's container config, where they stay until the container is removed | LLM02:2025; AML.T0055 | AC-1, GR-7, MO-5 | [residual 3](#residual-3) (H-189) |

### L5 Evaluation and Observability

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L5.1 | Misuse goes unseen: no trail of tool calls and changes the agents can't edit | ASI10; MCP08:2025 | MO-1, MO-2, MO-6 | [residual 1](#residual-1) |
| L5.2 | The audit reports a pass where it couldn't check | MCP08:2025 | MO-1, MO-3 | [the audit's gaps](#audit-gaps) |
| L5.3 | A key travels in cleartext to the observability store | MCP01:2025; LLM02:2025 | (the o11y profile's own, Phase 3) | [H-048](#h-048) |

### L6 Security and Compliance

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L6.1 | A repo overlay loosens policy | ASI03; AML.T0081 | GR-2 | — |
| L6.2 | An App merges, approves or bypasses a ruleset | ASI03; AML.T0091.000 | AC-7, GR-8 | [H-039](#h-039) |
| L6.3 | A planner token pushes a `factory/**` branch | ASI03; AML.T0091.000 | AC-8, GR-6 | [H-038](#h-038) |
| L6.4 | A minted token comes back broader than requested | ASI03; AML.T0091.000 | AC-6 | — |
| L6.5 | A workflow runs an AI agent with secrets on comment, issue or review triggers | ASI01, ASI03; LLM01:2025; AML.T0119 | MO-1, GR-6 | [the audit's gaps](#audit-gaps) |
| L6.6 | A secret is committed to a repo or its history | LLM02:2025; AML.T0055 | DP-2, DP-12 | — |
| L6.7 | Subscription OAuth is used where the provider's terms forbid it | — | AC-11 | — |
| L6.8 | A commit turns a check off from inside the repo: a mise file that overrides `mise.toml`'s tools or tasks (the gates run `mise run test`), or a gitleaks config, ignore file or inline allow comment | — | GR-3, DS-7, DP-12 | — |

### L7 Agent Ecosystem

| ID | Threat | Catalog | Controls | Residual |
|---|---|---|---|---|
| L7.1 | Anyone who can comment on a PR or issue gets text in front of Hermes | ASI01; LLM01:2025; AML.T0093 | IS-7, AC-12 | [residual 5](#residual-5) |
| L7.2 | A third-party MCP server's rules or results carry instructions | MCP06:2025, MCP10:2025; AML.T0110.002 | IS-6, IS-8, DS-12 | [H-042](#h-042), [H-043](#h-043) |
| L7.3 | An unapproved ("shadow") MCP server is loaded | ASI04; MCP09:2025 | DS-12 | — |
| L7.4 | One trust domain's memories or skills steer another | ASI06, ASI07; AML.T0080 | AC-15 | [abliteration.ai](#abliteration-ai) |
| L7.5 | Slack, a third party, sees code or secrets | LLM02:2025 | DP-11 | — |
| L7.6 | The operator trusts a plausible but wrong PR | ASI09; LLM09:2025; AML.T0067 | AC-7, IS-10, GR-6 | [residual 6](#residual-6) |
| L7.7 | A leaked provider key is used from outside | AML.T0012; LLM10:2025 | GR-7, MO-5 | [residual 3](#residual-3) |
| L7.8 | Hermes and Archon exchange anything but a merged work order | ASI07; AML.T0118.000 | DS-1, AC-16 | [residual 1](#residual-1) |
| L7.9 | CodeRabbit, a third-party App that can write to the repo, is steered or compromised: a PR edits the config it reviews with, an outsider drives its commands, chat learnings bias later reviews, or its own App key leaks | ASI04, ASI09; LLM01:2025; AML.T0010 | AC-17, GR-9, IS-7 | [CodeRabbit](#coderabbit) |

## 5. Cross-layer threats

The chains that cross layers, and what breaks each:

1. **Repo content → worker → allowed host** (L2.2 → L3.5 → L4.6). Text in a target repo tells Pi to send a key or code out. Broken by: stripping `.pi/` and `.agents/` (DS-15), no web for workers (IS-5), an archon allowlist of model APIs and three registries only, with no forge route (DS-2, AC-9), no publish token in any zone, and the caps (GR-7). What's left is [residual 2](#residual-2).
2. **MCP server → research → planning** (L3.4 → L7.2 → L2.3 → L1.2). A poisoned tool result becomes a brief, then a plan. Broken by: the catalog and lock (DS-12, DS-14), the research quarantine and its schema-checked brief (IS-6), the hermes zone's allowlist without T2 or T3 (DS-2), and the planning PR the operator merges (AC-7).
3. **Comment → Hermes → planner token** (L7.1 → L3.1 → L6.3). A PR comment steers Hermes into pushing a `factory/**` branch. Broken by: the injection screen (IS-7), the allowlist hook (IS-4), the operator's merge (AC-7), and Plan 05's lane and trailer check ([H-038](#h-038)).
4. **Pi → Archon state → a run that looks approved** (L2.5 → L5.1). Broken by: the GitHub boundary and the archon zone's lack of forge credentials ([residual 1](#residual-1)); the next level is run events off-box.
5. **Store → every zone** (L2.6 → L3.5 → L7.7). One leaked age key or the words open every zone's keys. Broken by: per-machine keys that are never copied and can be revoked (DP-4), the caps (GR-7), kill switch 1 and rotation ([H-046](#h-046), [H-137](#h-137)).
6. **Container → hapi → root** (L4.1 → L4.2 or L4.3). An escape lands as hapi, not root (AC-1); root never acts on hapi's home (AC-2); and no argument is re-parsed on the way to hapi (AC-3).

## 6. Controls, by SANS domain

The six domains, as SANS's post on its Critical AI Security Guidelines (the v1.1 draft) names them: "Access Controls", "Data Protections", "Secure AI Deployment Strategies and Tools for AI Model Security Scanning", "Inference Security", "Continuous Monitoring" and "Governance, Risk, and Compliance (GRC)". The current v1.4 regroups them into eight categories ([Sources](#11-sources); H-158).

### 6.1 Access Controls

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| AC-1 | The stack runs as the dedicated `hapi` user on rootless Docker, with lingering; on every run, host setup refuses a `hapi` that can become root: one in a root-equivalent group (`docker`, `sudo`, `admin`, `wheel`, `lxd`, `incus-admin`, `libvirt` or `disk`) or with any sudo rule | §4.3, §11.3 | `scripts/host-setup.sh` (`refuse_root_equivalent`); `tests/scripts/host-setup.test.ts`: static checks, and the check itself run with a stub `id` and `sudo` | enforced (live on 2026-10-28, stage b: host setup made `hapi` with a 1,048,576-wide subordinate range, rootless Docker 29.9.2 and lingering, and the Squid rock pulled under it; H-080, H-146(a)); the root-equivalence check documented, not verified live (H-188): it came after stage b and hasn't run on the real host ([not yet verified live](#not-yet-verified-live)). A `hapi` user that predates host setup gets a second range, which is unverified (H-188) |
| AC-2 | Root never writes, creates, chowns or chmods a path inside hapi's home: it hands bytes over stdin or a `tar` pipe to a process running as hapi (`sudo -u hapi -H -- sh -c '<script>'`), so a symlink hapi planted reaches only what hapi could already write | §4.3 | `scripts/host-setup.sh`, `scripts/copy-secrets-to-hapi.sh`; `tests/scripts/hapi-home.test.ts` runs the hapi-side snippets in a temp home and checks the scripts' root-side code and the docs | enforced (live on 2026-10-28, stage b: both scripts ran through the host's real sudo, and a second host setup changed nothing; H-146(d)) |
| AC-3 | `up` and `down` re-exec as hapi with `sudo -u hapi -H -- sh -c '<fixed script>' hapi-stack <args>`: no login shell, no argument in the script, each argument its own argv entry; the user is the one the process runs as, never `$USER` | §4.3, §11.8 | `src/stack/up.ts` (`reexecScript`); `tests/stack/up.test.ts` | enforced |
| AC-4 | The same re-exec through the host's real sudo (`env_reset`, `secure_path`, `use_pty`), and mise quoting the arguments into its task's command line so they reach hapi's `up` as typed | §4.3 | as AC-3 | enforced (live on 2026-10-28, stage b: `mise run up -- --config '/tmp/hapi $HOME test.yaml'` from the operator's account reached hapi's `up`, which named exactly that path; H-146(e)) |
| AC-5 | Each zone container gets only its own zone's env file; `host.env`, which holds the App keys, goes to no container; no zone but `host` holds an App key | §4.3, §11.5 | `stack/compose.yaml`, `stack/secrets.yaml`, `src/secrets/manifest.ts`; `tests/stack/compose.test.ts`, `tests/secrets/manifest.test.ts`, and "zone separation" in `tests/stack/egress.int.test.ts` | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| AC-6 | App tokens: one repo, exactly the App's permissions, one hour, minted on the host; a token that comes back broader, or for other repos, is refused and revoked at once | §4.4, §11.5 | `src/forge/github/app-token.ts`; `tests/forge/app-token.test.ts` (`mintInstallationToken rejects broader permissions`) | enforced; the first live mint (2026-10-27, H-079) got the response its checks expect: one repo, `repository_selection: selected`, no permission beyond the request |
| AC-7 | No App can merge, and only the operator merges: `main-review` restricts updates (only the Admin role, PR-only, may update `main`) and needs a code owner's approval; `main-protect` requires `ci` with no bypass; neither App has Administration or Workflows, or is ever a bypass actor | §5.1, §11.5, §11.9 | README and `docs/runbooks/github-apps.md`; `tests/docs/rulesets.test.ts` holds their JSON to it; the audit's `github.rulesets` and `github.app-perms` check the live repo | enforced (live: the App's merge was refused on 2026-10-27, H-078, and stage b's strict audit on 2026-10-28 passed `github.rulesets` and `github.app-perms`, which read the bypass actors and the Apps' permissions, H-080) |
| AC-8 | The Apps push only `plan/**` and `factory/**` (`agent-branch-scope`), and only the Admin role touches tags (`tags-admin-only`). Once Dependabot is on and the runbook's `refs/heads/dependabot/**/*` exclusion is added, which the audit allows, the Apps can push `dependabot/**` branches too (H-174) | §11.5 | `docs/runbooks/github-apps.md`; `tests/docs/rulesets.test.ts`; the audit's `github.rulesets` checks the live repo | enforced (live on 2026-10-27, H-078: an App's new branch outside `plan/**` and `factory/**` and its new tag were refused by the `creation` rules of `agent-branch-scope` and `tags-admin-only`, as GitHub's rule insights record) |
| AC-9 | The archon zone has no forge credential and no forge route: its allowlist holds no forge host, and the generator refuses one, in any case or as a subdomain | §4.3, §9.4 | `policy/trusted_sources.yaml`, `src/policy/hosts.ts` (`forgeDomain`), `src/generate/egress.ts`; `tests/generate/egress.test.ts` ("the archon zone has no forge route"), `tests/policy/load.test.ts`, `tests/secrets/manifest.test.ts`, and the forge tests in `tests/stack/egress.int.test.ts` | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| AC-10 | Hermes gets a 1-hour `hapi-planner` token per session from a host-side minter, never an App key | §9.1 #7, §11.5 | — | planned (Plan 04, H-098) |
| AC-11 | No subscription OAuth: API keys only; the manifest refuses every `CLAUDE_CODE_` name, `CLAUDE_CODE_OAUTH_TOKEN` included | §3, §11.5 | `src/stack/env.ts` (`CONTROL_ENV_PREFIXES`); `tests/secrets/manifest.test.ts` | enforced |
| AC-12 | Hermes's Slack gateway runs in Socket Mode (no inbound endpoint) and answers only allowlisted member IDs (`SLACK_ALLOWED_USERS`) | §9.1 | `docs/runbooks/slack.md`, `stack/secrets.yaml` | documented, not verified live (H-179): spike T13 saw it hold live for direct messages on 2026-10-28, on the operator's Docker, with `unauthorized_dm_behavior: ignore` set by hand ([spike 06](../spikes/06-hermes-slack-socket-mode.md)); on the real stack, as hapi, stage b saw the operator's DM answered the same day; a stranger's DM on the real stack, a non-allowlisted member's channel messages, and the context of a thread Hermes answers are untested (H-179) |
| AC-13 | No service publishes a port. No Archon server runs at all: a run is one `archon workflow run` in a one-shot container, so no Archon API, web console or port exists. Hermes's API listens on loopback. `hapi run watch` reads the run record and `docker logs`, and publishes nothing | §9.2 | `stack/compose.yaml`, `src/generate/archon.ts`, `src/run/spec.ts`, `src/run/view.ts`; `tests/stack/compose.test.ts`, `tests/generate/archon.test.ts`, `tests/run/spec.test.ts`, `tests/run/view.test.ts`, the loopback tests in `tests/stack/egress.int.test.ts` | enforced in the generated config and the launcher's `docker run` arguments (no `-p`, no server started), on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)). The run-container integration test (`tests/run/run.int.test.ts`) ran it on real Docker. Spec §9.2's "web console only through an SSH tunnel" has nothing to apply to ([spec note](../superpowers/specs/2026-10-26-hapi-factory-design.md)) |
| AC-14 | A work order belongs to exactly one repo (it lives in that repo's `.factory/work/<id>/`); runs queue per repo; no run spans two repos | §4.4 | `src/engine/poll.ts` (one pipeline per repo), `src/run/records.ts` (`forgeRepo`: one live run per GitHub repo, `runs.max_live` in all); `tests/engine/poll.test.ts`, `tests/run/records.test.ts` | enforced in code and tests (Plan 03, H-090): the poller holds the queue and moves one pipeline per repo, and `startRun` admits a run only when no other run of its GitHub repo is live; first live run: the sandbox's (Plan 03 Task 16) |
| AC-15 | Segment by trust domain: a new domain gets its own Hermes profile, Archon container and zone, workspace and cap, and Slack channel | §4.4 | — | planned (Phase 2+, H-127) |
| AC-16 | Hermes can't answer Archon approvals or start runs (`hapi-status` is fixed-argv); runs start only from merges, through the poller | §9.1 #6, §9.4 | `src/engine/poll.ts`, `src/engine/pipeline.ts`, `src/engine/coderabbit.ts`, `src/engine/cli.ts`; `tests/engine/poll.test.ts`, `tests/engine/pipeline.test.ts`, `tests/engine/coderabbit.test.ts`, `tests/engine/cli.test.ts` | the run-engine half enforced in code and tests (Plan 03, H-161). Engine runs start only from: a merge, through the poller; a maintainer's `hapi:rework` label, where the label event's actor is a human with at least triage permission, not an App; at most one automatic CodeRabbit run per PR, on CodeRabbit's own review of the head commit (design §3.6, which changes spec §5.2); and the operator's `hapi retry`, from their own terminal as hapi, which only queues a failed work order again at the same merge commit, at most `runs.max_retries` times, so the run still starts through the poller, within the caps (never in Hermes's allowlist, H-245). First live run: the sandbox's (Plan 03 Task 16). The coordinator half (`hapi-status` fixed-argv, no approvals or run starts from Hermes) is planned (Plan 04, H-162) |
| AC-17 | CodeRabbit is never a merge authority: installed on hapi-factory only (selected repos, never hapi-factory-private), never a ruleset bypass actor or a required check; a merge still needs the operator (Restrict updates, a code owner's review) | §9.6 | The audit's `github.rulesets` fails on any required check but `ci` and on any `Integration` bypass actor; the install scope is the operator's step (H-164) | enforced by the audit, run live with `--repo` in stage b (2026-10-28): `ci` the only required check, no `Integration` bypass actor; the install: documented (H-164) |

### 6.2 Data Protections

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| DP-1 | Secrets fail closed: exactly the configured provider, no fallback; a missing or empty secret, or a provider failure, writes nothing and starts nothing, naming the secret | §11.5 | `src/secrets/provider.ts`, `src/secrets/cli.ts`, `src/stack/up.ts`; `tests/secrets/provider.test.ts`, `tests/stack/up.test.ts` | enforced |
| DP-2 | hapi writes resolved values only to `0600` env files under `$XDG_RUNTIME_DIR/hapi/` (tmpfs), never `/tmp` or the repo; keys and plaintext are refused inside the checkout, `private/` included. Docker keeps a copy: each zone container's env, its zone's secrets included, sits in the container's config on hapi's disk for as long as the container exists, reboots included, until `mise run down` removes it | §11.5 | `src/secrets/files.ts`; `tests/secrets/files.test.ts` | enforced for what hapi writes; Docker's copy is an accepted residual (H-189, beside [residual 3](#residual-3)) |
| DP-3 | Errors name keys, never values | §11.5 | `src/secrets/provider.ts`; `tests/secrets/provider.test.ts` ("a value never appears in an error or in stderr") | enforced |
| DP-4 | The sops + age store: one age key per machine or user, never copied; a recovery recipient wrapped with 10 tool-generated words; post-quantum recipients by default; recipient drift and any non-age master key refused; the key file checked before every decrypt | §11.5 | `src/secrets/recipients.ts`, `src/secrets/recovery.ts`, `src/secrets/lifecycle.ts`, `src/secrets/providers/sops.ts`; `tests/secrets/recipients.test.ts`, `tests/secrets/lifecycle.test.ts`, `tests/secrets/sops.test.ts`, `tests/secrets/sops.int.test.ts` | enforced |
| DP-5 | The real store, and the word prompt on a real terminal (no echo, Ctrl-C restores it, the screen cleared) | §11.5 | `src/secrets/init.ts`, `src/secrets/recovery.ts` (`openTerminal`) | the real store: live since 2026-10-27, and stage b's `secrets:check` found every name (H-068, H-080); the word prompt on a real terminal: documented, not verified live (H-136) |
| DP-6 | The manifest refuses env names that would change a container's behaviour: every name hapi sets itself (`RESERVED_ENV_NAMES`), process-control, config-dir and trust-store names (`CONTROL_ENV_NAMES`, such as `PATH`, `XDG_CONFIG_HOME` and Claude Code's `CLAUDE_CONFIG_DIR`; `CONTROL_ENV_PREFIXES`, such as `LD_`, `NODE_`, `HERMES_` and s6-overlay's `S6_`) and endpoint overrides, which would send a key elsewhere (`CONTROL_ENV_SUFFIXES`) | §11.5 | `src/stack/env.ts` (`reservedEnvRule`), `src/secrets/manifest.ts`; `tests/secrets/manifest.test.ts` | enforced |
| DP-7 | hapi's own settings (proxies, `HOST`, `PI_OFFLINE`, `HERMES_HOME`, …) are in Compose's `environment:`, which beats `env_file`, so no secret can override one | §9.2, §9.3 | `stack/compose.yaml`, `src/stack/env.ts` (`serviceEnvironment`); `tests/stack/compose.test.ts`, "hapi's settings beat the env file" in `tests/stack/egress.int.test.ts` | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| DP-8 | The Jev key is `HAPI_JEV_OPENROUTER_API_KEY`, never `OPENROUTER_API_KEY`, so Pi can't bill model calls to the $2 key; archon's `CLAUDE_API_KEY` is the same secret as its `ANTHROPIC_API_KEY` | §9.5 | `stack/secrets.yaml`; `tests/secrets/manifest.test.ts` | enforced |
| DP-9 | Each MCP server gets only its own key, by reference: `$` refused in urls and literals, `checkOwnRefs` on the output, a per-package env allowlist (`PACKAGE_ENV`) whose secret-looking names are always secrets, and a hard denylist (`FORBIDDEN_ENV`) | §10.1 | `src/policy/mcp.ts`, `src/generate/mcp.ts`, `policy/mcp.yaml`; `tests/policy/mcp.test.ts`, `tests/generate/mcp.test.ts` | enforced |
| DP-10 | Provider data boundary: zero data retention per OpenRouter key by guardrail; OpenCode Go's zero-retention models only, training endpoints blocked | §11.5, §12 | `docs/runbooks/provider-keys.md` | documented, not verified live (H-071, H-072) |
| DP-11 | Slack messages carry links and summaries, never code or secrets | §9.1 | — | planned (Plan 04, H-162) |
| DP-12 | No secret in a repo: gitleaks on every commit's staged changes, and over the whole history in the required `ci` check. The whole-history scan is `ci.yml`'s `secrets` job: `.github/workflows/gates.yml`'s history scan byte for byte but `--config .githooks/gitleaks.toml` (H-241, closed), on its own fresh runner and checkout, where no PR code has run. Both scans name their config (`--config .githooks/gitleaks.toml`) and pass `--ignore-gitleaks-allow`, so neither a `.gitleaks.toml` nor an inline `gitleaks:allow` a commit adds changes what they find; CI also refuses a root `.gitleaksignore`, which gitleaks always reads | §11.7 | `.githooks/pre-commit` and `.githooks/pre-merge-commit` (opt-in, through `core.hooksPath`), `.github/workflows/ci.yml`, `.github/workflows/gates.yml`, `.githooks/gitleaks.toml`; `tests/scripts/githooks.test.ts`, `tests/scripts/ci-workflow.test.ts` | enforced (H-057, H-241): the whole rewritten history was scanned before the first push, and CI scans it on every PR and push to `main`. The hook is opt-in, and it still honours a `.gitleaksignore`; CI is the gate. Its residuals, accepted ([Plan 03](#plan-03-the-run-engine)): gitleaks's default path allowlist and value regexes (H-240), a token outside file contents (H-242), and a PR that edits `.githooks/gitleaks.toml` changes its own scan (H-246) |

### 6.3 Deployment Strategies

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| DS-1 | Internal-only zone networks; only the proxies join `outbound`, with `enable_icc=false`; `up` refuses a zone network that isn't internal or private, and removes what it created | §11.3, §11.4 | `stack/compose.yaml`, `src/stack/up.ts` (`networkProblems`); `tests/stack/compose.test.ts`, `tests/stack/up.test.ts`, `tests/stack/egress.int.test.ts` | enforced on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| DS-2 | Squid is each zone's only way out: default deny, per-zone allowlists generated from policy, names matched without lookups (`-n`), HTTPS tunnels to 443 only; a stopped proxy means no way out, never a bypass | §10, §11.4 | `policy/trusted_sources.yaml`, `src/generate/egress.ts`; `tests/generate/egress.test.ts`, `tests/stack/egress.int.test.ts` (`egress: direct connection is blocked even when proxy is stopped`) | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| DS-3 | No DNS out of a zone network: Docker's resolver answers only the stack's own names there | §11.4 | Docker's internal networks; "no DNS out" in `tests/stack/egress.int.test.ts` | enforced: "no DNS out" passed on rootful Docker 29.9.2 (stage a) and as hapi on rootless Docker 29.9.2 (stage b, 2026-10-28, H-146(c)) |
| DS-4 | The research zone reaches any public name, but never an IP literal (`ip_literal`) or a private range, and plain HTTP only on port 80 | §10.1 | `src/generate/egress.ts`; `tests/generate/egress.test.ts`, `tests/stack/egress.int.test.ts` | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| DS-5 | `to_localnet` in every zone refuses private, loopback, link-local, metadata, NAT64, 6to4, Teredo, IPv4-compatible and site-local addresses, by name too | §11.4 | `src/generate/egress.ts`; `tests/generate/egress.test.ts`, "DNS rebinding (static)" in `tests/stack/egress.int.test.ts` | enforced in the generated config, on rootful Docker (stage a) and as hapi on rootless Docker (stage b, 2026-10-28, H-146(c)) |
| DS-6 | Every container: `cap_drop: [ALL]`, `no-new-privileges`, non-root, read-only root, pid and memory limits, size-capped tmpfs, a health check | §11.3 | `stack/compose.yaml`; `tests/stack/compose.test.ts`, the hardening tests in `tests/stack/egress.int.test.ts` | enforced in `stack/compose.yaml`, on rootful Docker (stage a) and as hapi on rootless Docker (stage b and spike T12, 2026-10-28: no capability had to come back, and each container's cgroup held its pid and memory limits and each tmpfs its size cap, [spike 05](../spikes/05-rootless-images.md)) |
| DS-7 | Every tool, image and package pinned exactly; images by tag and digest; Hermes and Archon only ever built (`pull_policy: build`), so no registry is asked for a `hapi-factory/*` image; only the root `mise.toml` configures mise, so no other mise file can pin or run something else; the root `mise.lock` pins each mise tool's linux-x64 download by sha256, and CI installs with `--locked` | §3, §11.6 | `mise.toml`, `mise.lock`, `stack/compose.yaml`, `stack/hermes/Dockerfile`, `stack/archon/Dockerfile`, `src/audit/checks/pins.ts`, `.github/workflows/ci.yml` (its mise-config step); `tests/stack/compose.test.ts`, `tests/audit/pins.test.ts`, `tests/scripts/ci-workflow.test.ts` | enforced (`pins.versions` reads an install behind BuildKit flags, wrappers and shell keywords; the `RUN` forms it can't read: H-157; the in-run gates' own mise check: enforced, Plan 03, H-194: `factory-task`'s preflight and gates and `factory-verify` run CI's scan before mise runs) |
| DS-8 | A release-age cooldown on every pin. Today only npm has one (`bunfig.toml`, 3 days), and MCP pins wait 14 days by review | §11.6 | `bunfig.toml`, `policy/mcp.yaml` | planned (Plan 05, H-115; the MCP check, H-114) |
| DS-9 | A digest of `build/` labels every container (`org.hapi.build-sha256`), so a policy change reaches the running stack, and the audit can tell which build a container came from | §8.1 | `src/stack/up.ts` (`buildDigest`), `src/audit/checks/generated.ts`; `tests/stack/up.test.ts`, `tests/audit/generated.test.ts` | enforced |
| DS-10 | The dev bypass (`HAPI_ALLOW_CURRENT_USER=1`) warns, on `up` and `down`, and labels every container `org.hapi.dev-override=1` with `org.hapi.started-by`; the audit fails a labelled container on the Docker it reads, and a shell that sets the bypass | §4.3, §11.3 | `src/stack/up.ts` (`currentUserOverride`), `src/audit/checks/runtime.ts`; `tests/stack/up.test.ts`, `tests/audit/runtime.test.ts` | enforced on the auditing user's own Docker. The documented audit runs as hapi and reads hapi's Docker, so it never sees a bypass stack on the operator's own Docker ([the audit's gaps](#audit-gaps), H-193) |
| DS-11 | Pi's environment: `PI_OFFLINE=1` (no repo-settings package install), `PI_TELEMETRY=0`, and `PI_CODING_AGENT_DIR` a 64 MB tmpfs (Pi writes only its cache and sessions there) with `models.json`, `models-store.json` (`{}`), `hapi-guard.json`, `settings.json` and `extensions/` bound read-only into it. `models.json` pins each roster model's whole `cost` and `compat`, `maxTokens` (64000) and the provider's `baseUrl` (`modelOverrides` apply last); hapi-guard compares the whole resolved model with the pin at `session_start` and fails the node on any difference, and on any file in Pi's directory that is not hapi's or Pi's own cache and sessions | §9.3 | `src/generate/archon.ts`, `src/generate/pi.ts`, `src/run/spec.ts`, `src/guard/model.ts`, `stack/compose.yaml`; `tests/generate/archon.test.ts`, `tests/generate/pi.test.ts`, `tests/run/spec.test.ts`, `tests/guard/model.test.ts`, `tests/stack/compose.test.ts`; the audit's `runtime.run-container` (the tmpfs's size, uid and mode, and each bound file read-only) | enforced for `PI_OFFLINE` (spike T8: a target repo's `.pi/` settings listing a package drew no install, 2026-10-28) and `PI_TELEMETRY`, and, since Plan 02 (H-181(a), H-197), for the tmpfs layout and the pins, in tests and in the run-container integration test (`tests/run/run.int.test.ts`: the tmpfs is writable and `models.json` fails with `EROFS`). Pi's directory is writable, so a worker can plant a file there that a later node reads (`models-store.json`, `AGENTS.md`, `SYSTEM.md`, `bin/`); the empty, read-only `models-store.json`, the pins and the `session_start` check answer it ([spike 01](../spikes/01-pi-under-archon.md), [spike 08](../spikes/08-guard-hooks-offline.md), findings 9 and 12). The pins held in the live model runs of the paid check (Plan 02 Task 11, 2026-10-31; [spike 08's live check](../spikes/08-guard-hooks-offline.md#live-check-2026-10-31)) |
| DS-12 | One MCP catalog: exact pins with integrity, advisory floors, a blocklist, read-only tool allowlists, the archon zone refused; the tool-description lock checked offline | §10.1 | `policy/mcp.yaml`, `policy/mcp.lock.json`, `src/policy/mcp.ts`, `src/mcp/lock.ts`; `tests/policy/mcp.test.ts`, `tests/mcp/lock.test.ts`, `tests/audit/mcp.test.ts` | enforced |
| DS-13 | MCP servers launch from per-server images built from committed lockfiles, pinned by digest | §10.1 | — | planned (Plan 04, H-100) |
| DS-14 | A running server's live tool surface is compared with the lock: `hapi mcp verify`, at stack start, and in the audit | §10.1 | `src/mcp/lock.ts`, `src/audit/checks/mcp.ts` | planned (Plan 04, H-101) |
| DS-15 | Per-run isolation: one container per run, with the repo's `.pi/`, `.agents/` and `.archon/` left out of the clone (the launcher's prelude checks the clone out sparse, then strips them again before it reads anything back); the verify and review preludes also leave out what would steer Claude Code (`.claude/`, `CLAUDE.md` and `CLAUDE.local.md` at any depth, and `.mcp.json` at the root), and kill what the workflow left running before they read anything back; Archon's run layer (`--config`) pins `assistants.pi.enableExtensions: true` and `workflows.autoResumeOnQuotaReset: false` over anything a repo says; `/.archon/.env` is bound empty and read-only, and the CLI starts from `/app`, never the clone; non-persistent containers for externally fed sessions | §9.2, §11.3 | `stack/archon/run.sh`, `stack/archon/verify.sh`, `stack/archon/review.sh`, `src/run/spec.ts`, `src/run/lifecycle.ts`, `src/generate/archon.ts`; `tests/run/prelude.test.ts`, `tests/run/spec.test.ts`, `tests/run/lifecycle.test.ts`, `tests/run/run.int.test.ts` | enforced for the run side (Plan 02, H-161's strip moved here, H-182; the spike showed the strip is the only prevention: Archon trusts a repo's `.pi/`, and an unstripped repo extension ran in the Pi worker, [spike 01](../spikes/01-pi-under-archon.md); [spike 07](../spikes/07-run-container.md) ran the strip, the sparse clone and the run layer). Planned for the Hermes side, whose main session reads Slack from a long-lived container (Plan 04, H-200). hapi-guard's `session_start` fails a node whose worktree still holds `.pi/`, `.agents/` or `.archon/` (a backstop, H-181(d)) |
| DS-16 | hapi-guard, Pi's only user extension in a run: protected paths denied for workers (the policy's own matcher, `effectiveModes`, bundled in); the budget (`run_usd`, per enforcer `hard` or `soft`); `max_tokens` clamped; the model pins; secret hygiene (rules 6 and 8); the level-6 gates (bash gate, result screen) through `decide()`; a decision log in `/out`. Its factory never throws (a guard that fails to load fails open, silently), so bad settings fail the node at `session_start` instead | §9.3 | `src/guard/`, `build/pi/hapi-guard.json` from `src/generate/pi.ts`, `src/decide/`; `tests/guard/`, `tests/decide/`, `tests/guard/bundle.test.ts` (the built bundle under Pi's loader flags), `tests/policy/paths.test.ts` | enforced in code and tests (Plan 02, H-087, H-089, H-181(d), H-184); the hooks were checked offline on the pinned image with a fake provider ([spike 08](../spikes/08-guard-hooks-offline.md)). The paid check (Plan 02 Task 11, 2026-10-31; [spike 08's live check](../spikes/08-guard-hooks-offline.md#live-check-2026-10-31)) ran the guard in live model runs on hapi's rootless Docker: the protected-path block, the hard budget stop, and the gates through Jev and through Haiku. **Gaps, each accepted ([the Plan 02 residuals](#plan-02-run-container)):** rule 7 (shell writes to protected paths) is a signal, not a boundary; the budget's ledger and the decision log are files in the worker's own tmpfs and `/out`, which the worker can edit; and rule 8 keeps keys out of casual output only. The boundary for protected files is the host-side diff gate, enforced in code and tests by Plan 03 (H-203, `src/engine/harvest.ts`) |
| DS-17 | Nothing a worker writes outlives its run but the commit the harvester takes: per-run storage dies with the container (`$HOME`, `/.archon` and Pi's directory are tmpfs; `/work` and `/out` are per-run volumes removed with the run), with git and Claude Code config generated fresh and bound read-only, never a persistent `archon-home` volume; a restarted run starts over from a fresh clone; and the host copies out only four named files, each through a helper container with no network and a read-only mount, with a size cap, into a hapi-owned directory; and the run's `/work` and `/out` are bind-backed volumes on the run disk, a filesystem of its own of at most `runs.disk.gb`, apart from Docker's data root, which `hapi run start` checks before every run (`runs.disk.enforcement: hard` by default) and the audit's `runtime.run-disk` holds, so a worker can fill only the run disk, never hapi's Docker data root (H-217) | §9.2, §11.3 | `src/run/spec.ts`, `src/run/copyout.ts`, `src/run/lifecycle.ts`, `src/run/disk.ts`; `tests/run/spec.test.ts`, `tests/run/copyout.test.ts`, `tests/run/lifecycle.test.ts`, `tests/run/disk.test.ts`, `tests/run/run.int.test.ts` | enforced for the run side (Plan 02, H-182, H-088's refusal); the disk cap (Plan 03, H-217), the host-side diff and scope gates on the bundle (H-203), Claude Code's managed settings for the review (H-205) and the harvester (H-161) enforced in code and tests by Plan 03, whose first live run is the sandbox's (Task 16). The long-lived Archon's two volumes are removed once, by the operator ([rollout](../runbooks/runs.md#rollout-on-hapis-checkout)) |

### 6.4 Inference Security

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| IS-1 | Hermes's approvals: `approvals.mode: manual`; cron, unattended and single-query modes `deny`; yolo and `mode: off` forbidden; skill and memory writes need approval; `agent.max_turns` 60; the Kanban dispatcher off (`kanban.dispatch_in_gateway: false`, `dispatch_profiles: []`, no auto-decompose or review dispatch), since it would spawn workers with full terminal access and no approval step | §9.1 | `src/generate/hermes.ts` from `policy/`; `tests/generate/hermes.test.ts` ("hermes flips defaults"); the audit's `runtime.hermes-no-yolo` and `tools.hermes-validate`, `tests/audit/runtime.test.ts` | enforced (but a yolo variable in Hermes's writable `$HERMES_HOME/.env` would get past the audit: H-190, planned, Plan 04): Hermes's own loader reads the generated values as written (`tools.hermes-validate`), and live on 2026-10-28 (spike T9) an interactive approval prompted and a denial held, cron and single-query runs were denied without a prompt, and a memory write was staged for approval. Not for skills: `write_file`, `patch` and the terminal edit a skill's files with `skills.write_approval` on, so the skills directories are hapi-path-guard's (IS-3: planned, Plan 04, H-093) ([spike 02](../spikes/02-hermes-path-guard.md)) |
| IS-2 | Hermes's protected instruction files cover every protected filename (the agent instruction files such as `AGENTS.md` and `CLAUDE.md`, matched in every directory and in any case, `mise.toml` and mise's other config file and lockfile names such as `.mise.toml`, `mise.local.toml`, `mise.*.toml`, `.tool-versions` and `mise.lock`, `.coderabbit.yaml`, `.coderabbit.yml`, `.coderabbit.config.ts`, `.gitleaks.toml` and `.gitleaksignore`); the directory globs, `**/.git/**` and mise's config directories included, are hapi-path-guard's (IS-3) | §8.2, §9.1 | `src/generate/hermes.ts`, `policy/protected_paths.yaml`; `tests/generate/hermes.test.ts`; the audit's `tools.hermes-validate` | enforced for the file tools: Hermes's loader reads the patterns as written (`tools.hermes-validate`), and live on 2026-10-28 (spike T9) `write_file` to `AGENTS.md` and to `mise.toml` prompted and a denial held. Not for the shell: `echo hi > AGENTS.md` wrote it unasked, which is Residual 4 and hapi-cmd-allow's (IS-4: planned, Plan 04, H-095) ([spike 02](../spikes/02-hermes-path-guard.md)) |
| IS-3 | hapi-path-guard: directory globs, shell writes, and `deny` in interactive sessions where policy says deny | §9.1 #1 | — | planned (Plan 04, H-093, H-094) |
| IS-4 | hapi-cmd-allow: a default-deny, fail-closed shell hook on argv-exact rules. The rules and their matcher exist and are tested (`policy/commands.yaml`, `src/policy/commands.ts`, `tests/policy/commands.test.ts`, `tests/fixtures/command-vectors.json`); Plan 01 emits no hook | §9.1 #2 | — | planned (Plan 04, H-095) |
| IS-5 | Workers have no web: the archon zone is T0–T1 plus model APIs and registries, and gets no MCP server, ever | §10, §10.1 | `policy/trusted_sources.yaml`, `src/policy/mcp.ts`; `tests/generate/egress.test.ts`, `tests/policy/mcp.test.ts` ("rejects any server enabled for the archon zone") | enforced |
| IS-6 | The research quarantine: its own container, web tools only, no terminal, no repo write, a schema-validated brief | §9.1 #4, §10 | — | planned (Plan 04, H-099) |
| IS-7 | Untrusted text (queued PR comments, rework comments, CodeRabbit's comments, briefs) is screened and wrapped as quoted data with a warning banner; a signal, never a boundary | §9.5 | — | planned (Plan 04, H-162) |
| IS-8 | MCP servers run `trust: untrusted`, with include-only tool lists, prompts and resources off, elicitation and sampling off | §10.1 | `src/generate/mcp.ts`, `policy/mcp.yaml`; `tests/generate/hermes.test.ts`, `tests/generate/mcp.test.ts` | enforced |
| IS-9 | In-run caps: `run_usd` is enforced per enforcer, each `hard` (stop the run) or `soft` (flag it) in `policy/budgets.yaml`, both `hard` by default and the schema fail-closed; hapi-guard's is hard by default in Pi. Archon bounds a run's nodes, never its dollars: `factory-task`'s `max_work_units` is pinned to its node count (H-204, H-229). Before every run it starts, the poller checks the repo's month (`budgets.repo_monthly_usd`) and the day (`budgets.daily_usd`), hard by default (`budgets.enforcement.poller`), and the automatic, rework and retry counts, always hard (`runs.max_auto_rounds`, `runs.max_rework_rounds`, `runs.max_retries`). Beside Hermes's `max_turns` (IS-1) and Pi's `maxTokens` (DS-11). The audit's `policy.budget-enforcement` fails unless at least one enforcer is hard | §9.2, §9.3 | `policy/budgets.yaml`, `policy/runs.yaml`, `src/guard/budget.ts`, `src/engine/caps.ts`, `archon/workflows/hapi/factory-task.yaml`; `tests/guard/budget.test.ts`, `tests/engine/caps.test.ts`, `tests/policy/load.test.ts`, `tests/audit/policy.test.ts` | enforced for hapi-guard's side (Plan 02, H-087), in tests; the node bound and the poller's caps enforced in code and tests (Plan 03, H-161, H-204, H-229), first live on the sandbox (Plan 03 Task 16). Reported spend is the worker's to forge (H-250), so the provider caps (GR-7) stay the dollar bound. Spike T10 (2026-10-28): Archon's `max_spend_usd` loads and stops a run, but admits each AI attempt while spend is below it, so a run overshoots by up to one node's cost; it bounds nodes, not dollars ([spike 03](../spikes/03-archon-budget-trigger-env.md)). The guard's run total lives in a ledger file in the worker's own tmpfs, which the worker can edit ([the Plan 02 residuals](#plan-02-run-container)), so the provider caps (GR-7) stay the dollar bound |
| IS-10 | The independent review: a separate session, a different model, read-only, advisory | §9.2 | `src/run/kinds.ts` (the review profile), `stack/archon/review.sh`, `src/generate/claude.ts`, `archon/workflows/hapi/factory-review.yaml`; `tests/run/kinds.test.ts`, `tests/run/factory.int.test.ts`, `tests/generate/claude.test.ts` | enforced in code and tests (Plan 03, H-161): a review run is a container of its own that runs no repo code, with the review zone's keys only, on `egress-review`; `startRun` refuses one whose `@review` model is `@implement`'s; Claude Code's managed settings deny every write, run, fetch and `/proc` read; its verdict only caps the PR's ([the Plan 03 section](#plan-03-the-run-engine)). First live run: the sandbox's (Plan 03 Task 16) |
| IS-11 | Skills in three tiers: the factory's own mounted read-only, repo skills changed only by planning PRs, learned skills under write approval and committed by the host | §9.1, §11.6 | — | planned (Plan 04, H-104, H-105, H-106) |

### 6.5 Continuous Monitoring

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| MO-1 | `hapi audit`, the detective control and spec §11.8's "worse controls" measure: config drift, the run container's definition and the running containers, the budget policy, pins, Archon's and Hermes's own validation, the MCP lock, the secrets setup, and each repo's rulesets, App permissions and AI workflows. A skip is never a pass, `--strict` fails every skip, and a check that throws fails | §11.8 | `src/audit/`; `tests/audit/` (`audit detects drift from generated config`, `audit fails on archon parseWarnings`) | enforced |
| MO-2 | The audit run live, as hapi, against the running stack and the real repo (stage b's last step). Until H-101, its one expected fail is `mcp.tool-hashes`, a skip that `--strict` fails (ruling R1: no "expected skip" flag) | §11.8, §15 | `docs/runbooks/stack.md`, `docs/audit.md` | enforced (live on 2026-10-28, stage b: as hapi against the running stack and the real repo, `13 pass, 1 fail, 0 skip`, the one fail the expected `mcp.tool-hashes` (H-101); H-080). Plan 02 replaced `runtime.archon-env` with `runtime.run-container` and added `policy.budget-enforcement`, so the expected result became `14 pass, 1 fail, 0 skip`, which Plan 02's rollout got live on 2026-10-31, as hapi against the running stack ([spike 08's live check](../spikes/08-guard-hooks-offline.md#live-check-2026-10-31)). Plan 03 adds seven checks, so it is now `21 pass, 1 fail, 0 skip` for one `--repo` (`docs/runbooks/stack.md`); that first runs live at Task 16's deploy (`docs/runbooks/engine.md`, Step 4) |
| MO-3 | The audit's known gaps | §11.8 | [their entry](#audit-gaps) | accepted residual |
| MO-4 | Without the operator's token, the audit mints one repo-scoped, read-only installation token (`contents: read`, `metadata: read`), uses it for GETs only, and revokes it (its one POST (mint) and one DELETE (revoke) accepted under ruling R2, least privilege) | §11.5 | `src/audit/checks/github.ts`; `tests/audit/github.test.ts` | enforced (it mints through `mintInstallationToken`, as AC-6, whose response checks the first live mint confirmed, H-079) |
| MO-5 | The kill switches, fastest first, each with what it stops and doesn't, how to confirm and undo it | §11.8 | `docs/runbooks/kill-switches.md` | documented, not verified live (H-160); switch 4 enforced (live on 2026-10-28, stage b: with its rule on, hapi's own request failed at once and Archon's request through its proxy got a 503, and the rule's counter read 69 packets afterwards; after the undo, hapi's traffic worked again and Hermes answered a DM, with no restart; H-146(b)) |
| MO-6 | Run events and traces off the box, in a store the agents can't write (the o11y profile, under its own Unix user) | §4.3, §13.4 | — | planned (Phase 3, H-122) |

### 6.6 Governance, Risk, and Compliance (GRC)

| ID | Control | Spec | Enforced by | Status |
|---|---|---|---|---|
| GR-1 | One policy compiled into every tool's config; the generated files are mounted read-only and a hand edit is detected | §8.1 | `policy/`, `src/generate/`; `tests/generate/` and `tests/audit/generated.test.ts` | enforced |
| GR-2 | A repo overlay may only tighten policy (and add `egress_extra` hosts, never forge hosts) | §8.1 | `src/policy/overlay.ts`; `tests/policy/overlay.test.ts` (`applyOverlay rejects loosening`) | enforced |
| GR-3 | Protected paths per mode, strictest-wins across every matching glob; `.pi/**`, `.archon/**` and git's own files (`**/.git/**`) deny everywhere; every mise config file and lockfile at any depth (a nested `mise.toml` and `mise.lock` included), and gitleaks's config and ignore file, at `mise.toml`'s modes | §8.2 | `policy/protected_paths.yaml`, `src/policy/paths.ts`; `tests/policy/paths.test.ts` | enforced in policy; each enforcement point carries its own status (IS-2, IS-3, DS-16) |
| GR-4 | The approvals list (merge, new dependency, new skill or MCP server, CI workflow change, outbound message, spend above threshold) | §5.2, §11.6 | `policy/approvals.yaml` | planned (Plan 04, H-162; Plan 05, H-163) |
| GR-5 | The work-order schema and validator: `egress_extra` refuses forge hosts (`nonForgeHostList`); at run time, the order is validated before any of its hosts reaches a proxy | §6 | `policy/schemas/work-order.schema.json`, `src/workorder/validate.ts`; `tests/workorder/validate.test.ts` | enforced. The run-time path is a refusal: the launcher rejects a work order with a non-empty `egress_extra` (`src/run/lifecycle.ts`; `tests/run/lifecycle.test.ts`), so no runtime route can bypass `emitEgress`/`checkedHosts` (Plan 02, H-088). A per-run proxy for it is still refused: no v1 work order needs one (H-207) |
| GR-6 | CI gates: gitleaks, Semgrep or Opengrep, OSV-Scanner, zizmor; Actions pinned to SHAs; no AI agent with secrets on PR or issue triggers; the work-order schema; trailers and lane labels on `lane:factory`; the protected-path diff; the MCP scanners | §11.7 | `.github/workflows/ci.yml` (this repo's own CI), `.github/workflows/gates.yml` (the reusable gates a repo made from the contract calls); `tests/scripts/ci-workflow.test.ts` | partly built (Plan 03 Task 5): the reusable gates run the whole-history gitleaks scan, OSV-Scanner, zizmor, the mise-config scan and the `factory/**` trailer check, as `ci / gates`, which the rulesets require; a PR that edits `.github/workflows/` can forge that check (H-239). Semgrep or Opengrep, the work-order schema check, the protected-path diff, the lane labels, the `plan/**` trailers (H-237) and the MCP scanners are planned (Plan 05, H-111, H-112, H-113, H-163) |
| GR-7 | Hard spend caps at the providers: `hapi-hermes` $60, `hapi-factory` $100, `hapi-evals` $40, the default workspace unused; OpenRouter limits that reset daily | §3, §11.5, §12 | `policy/budgets.yaml`, `docs/runbooks/provider-keys.md` | documented, not verified live (H-071; the audit doesn't read them yet, H-151) |
| GR-8 | CODEOWNERS: the operator is the only code owner, so no App's approval counts | §7, §11.9 | `.github/CODEOWNERS`, with `main-review`'s `require_code_owner_review`; `docs/runbooks/github-apps.md` | enforced (live on 2026-10-27, H-078: a `hapi-factory` approval left `reviewDecision` at `REVIEW_REQUIRED`, and the merge box still asked for a code owner's review) |
| GR-9 | CodeRabbit is review-only: `.coderabbit.yaml` turns off every way it writes (approvals, finishing touches, labels, auto-replies, issue features) and keeps chat learnings local and delayed 30 days; the file is a protected path, as are agent instruction files at any depth, since it reviews a PR with that PR's own config and reads them as guidelines | §8.2, §9.6 | `.coderabbit.yaml`, `policy/protected_paths.yaml`; `tests/policy/load.test.ts`, `tests/policy/paths.test.ts` | enforced in config; CodeRabbit's own behaviour: documented, not verified live (H-164) |

## 7. Spec §11.9 residual risks

The six residuals spec §11.9 accepts for v1, in its order. Each names its owner control and its next level.

### Risk assessment

Impact if exploited, likelihood in v0, and the decision. "Low" likelihood means a precondition isn't met yet (the component isn't running, or needs a prior compromise).

| Entry | Impact | Likelihood in v0 | Decision |
|---|---|---|---|
| [Residual 1](#residual-1): Pi in-process with Archon | Medium: local records and approvals, never `main` | Medium | Accept; GitHub is the boundary |
| [Residual 2](#residual-2): egress via allowed hosts | High: code or keys out | Low: needs an injection and a channel | Accept; watch the allowlists |
| [Residual 3](#residual-3): model keys in containers | Medium: bounded by the caps | Medium | Accept |
| [Residual 4](#residual-4): Hermes's gate holes | Medium: caught at the PR | Medium until Plan 04 | Accept until H-093 and H-095 |
| [Residual 5](#residual-5): injection via repo content | High | Medium | Accept with the controls listed |
| [Residual 6](#residual-6): manipulated review | Medium | Medium | Accept: advisory only |
| [H-038](#h-038) | High (a merge without the operator) | Low | Accept |
| [H-039](#h-039) | High (a merge without the operator) | Low | Controlled: AC-7 is enforced (H-078 saw the App's merge refused on 2026-10-27, and stage b's strict audit checked the rest on 2026-10-28, H-080) |
| [H-040](#h-040), [H-042](#h-042), [H-044](#h-044), [H-047](#h-047), [H-048](#h-048), [H-050](#h-050) | Low | Low | Accept |
| [H-043](#h-043), [H-045](#h-045), [H-049](#h-049), [H-051](#h-051) | Medium | Low | Accept; next levels listed |
| [H-041](#h-041) | High (an agent minting its own tokens) | Low | Controlled: AC-5 and AC-6 are enforced |
| [H-046](#h-046), [H-137](#h-137) | High (every zone's keys) | Low | Accept; keys never copied |
| [Plan 03: the run engine](#plan-03-the-run-engine) | Medium: an unattended pipeline that pushes to GitHub, bounded by the host gates, the caps and the operator's merge | Medium: a worker holds keys and a shell, and repo content can steer a model | Accept; the host gates on the bundle, the acceptance tests under `.factory/**`, `ci / gates` and the operator's merge are the boundary |
| [Plan 02: inside the run container](#plan-02-run-container) | Medium: bounded by the run's container, the provider caps and the host-side gates | Medium: a worker already holds the keys and a shell | Accept; the host-side diff gate and the unattended merge rules are the boundary |

<a id="residual-1"></a>
### Residual 1: Pi runs in-process with Archon

Spec §11.9 #1: Pi runs in-process with Archon. It can read Archon state, answer Archon approvals and alter local run records. (Spec §4.3: any local process can answer Archon's approvals, a Pi step through `ARCHON_CLI_COMMAND` included. Spike T10 saw `ARCHON_CLI_COMMAND`, the `bun … cli.ts` command, in a Pi node's shell, [spike 03](../spikes/03-archon-budget-trigger-env.md).)

- **Owner control:** the human boundary is on GitHub, and the archon zone holds no forge credentials. Only the operator merges (AC-7: enforced, the App's merge refused live, H-078, and the live audit in stage b, H-080), and the archon zone has no forge credential or route (AC-9: enforced in config, on rootful Docker (stage a) and as hapi on rootless (stage b)). So a Pi step that approves its own Archon gate, or rewrites a run record, still can't get anything onto `main`. No Archon approval node is a security control (spec §9.2).
- **Next level:** ship run events off-box, to a store the archon zone can't write (MO-6: the o11y collector under its own Unix user, Phase 3, H-122), so a rewritten local record no longer matches the copy.
- **Catalog:** ASI07, ASI10; AML.T0081. **Status:** accepted residual.

<a id="residual-2"></a>
### Residual 2: egress channels via allowed hosts

Spec §11.9 #2 and §11.4: allowed hosts (package registries, smoke hosts, model APIs; for Hermes, GitHub and Slack too) are exfiltration channels. Publishing to a registry would need a token the attacker supplies.

- **Owner control:** default-deny allowlists per zone, generated from `policy/trusted_sources.yaml` (DS-2: enforced in config, on rootful Docker (stage a) and as hapi on rootless (stage b)). The archon zone reaches only the model APIs and three registry hosts, by name, HTTPS only, with no forge route (AC-9); `ip_literal` and `to_localnet` close the address tricks (DS-4, DS-5). No zone holds a registry publish token. A work order adds hosts only through `egress_extra`, which refuses forge hosts (GR-5).
- **Next level:** a read-only method filter on the registries, or pull-through caches (spec §11.4); per-server egress for MCP servers (spec §10.1, phase 2). Unscheduled.
- **Related:** [H-044](#h-044) (the hermes zone reaches the registries too) and [H-045](#h-045) (DNS rebinding). **Catalog:** ASI02; LLM02:2025; AML.T0086, AML.T0025. **Status:** accepted residual.

<a id="residual-3"></a>
### Residual 3: model keys inside containers

Spec §11.9 #3 and §11.5: each container's model keys are in its environment, where the agent, or text that steers it, can read them. Beside it (H-189): Compose hands each zone's env file to Docker as the container's environment (`Config.Env`), which hapi's rootless Docker keeps in the container's config under its data root (`config.v2.json`) while the container exists, reboots included. So every zone's keys are also on hapi's disk, in any backup of hapi's home, and in `docker inspect` for anything that reaches hapi's Docker socket, and a rotated key's old value stays until the container is recreated. `mise run down` removes them. (From Docker's documented design and the containers' restart after a reboot; not checked live.)

- **Owner control:** the providers' spend caps (GR-7: documented, not verified live, H-071; not audited yet, H-151), and egress (DS-2), which limits where a key read in the zone can be sent. Each container gets only its zone's keys (AC-5). The Jev key has its own name and a $2 cap, so Pi can't bill model calls to it (DP-8). No endpoint override can send a key elsewhere (DP-6). Kill switch 1 stops a leaked key at the provider (MO-5).
- **Next level:** a credential-injecting proxy, so no model key is in a container at all (spec §11.5). Unscheduled. For Docker's copy (H-189, Phase 2+): each zone's file mounted read-only (or on a tmpfs) and read by the entrypoint at start, instead of `env_file`, or Docker's data root on encrypted storage.
- **Catalog:** ASI03; LLM02:2025; MCP01:2025; AML.T0055, AML.T0083. **Status:** accepted residual.

<a id="residual-4"></a>
### Residual 4: holes in Hermes's protected-file gate

Spec §11.9 #4: Hermes's protected-file gate has holes: shell writes, and `always` carry-over. A write made through the terminal misses it (upstream #143266; spike T9 saw it on 2026-10-28, when `echo hi > AGENTS.md` and `echo hi > .factory/y` wrote unasked, [spike 02](../spikes/02-hermes-path-guard.md)), an `always` approval carries over, the gate only asks, and its extra patterns match basenames, so a directory glob (`.agents/**`, `.github/**`) can't be expressed. Spike T9 found a sibling hole: `skills.write_approval` covers `skill_manage` only, and `write_file`, `patch` and the terminal edited a skill's files with no approval.

- **Owner control:** hapi-path-guard (IS-3: planned, Plan 04, H-093, H-094), the command allowlist hook (IS-4: planned, Plan 04, H-095) and the PR backstop: CODEOWNERS and the rulesets, so a protected file can't reach `main` without the operator (GR-8: enforced, H-078; AC-7: enforced, the App's merge refused live, H-078, and the live audit in stage b, H-080). Today: the generated filename rules (IS-2) and manual approvals with unattended deny (IS-1), both enforced. Spike T9 tests the gate's mechanics (H-064, H-093).
- **Next level:** make the protected paths read-only at the filesystem in Hermes's working copies (a read-only bind mount, or the vetted bubblewrap plugin, spec §9.1), so no write path, shell or tool, reaches them. Unscheduled.
- **Catalog:** ASI02, ASI05; LLM06:2025; AML.T0053, AML.T0081. **Status:** accepted residual.

<a id="residual-5"></a>
### Residual 5: prompt injection via repo content

Spec §11.9 #5: text in a target repo (`AGENTS.md`, `.pi/`, `.agents/`, code, comments, docs) is context that Hermes and Pi read, and can carry instructions.

- **Owner control:** the spec's four: strip `.pi/` and `.agents/` before Pi runs (DS-15: enforced for the run side, Plan 02; Hermes side planned, H-200); CODEOWNERS on `AGENTS.md` (GR-8: enforced, H-078); workers have no web (IS-5: enforced, the archon zone has T0–T1 only and no MCP server); and the reviewer is advisory (IS-10: enforced in code and tests, Plan 03, H-161), with only the operator merging (AC-7). Also enforced today: `PI_OFFLINE=1`, so a repo's `.pi/` settings can't install packages (DS-11), and `AGENTS.md`, `.pi/**` and `.agents/**` are `deny` for workers in policy (GR-3; Pi's guard is DS-16, enforced, Plan 02 H-087).
- **Next level:** the injection screen over untrusted text (IS-7: planned, Plan 04, H-162; a signal, never a boundary), and Archon honouring Pi's own project trust upstream, so `.pi/` needn't be stripped (spec §9.3). Unscheduled beyond Plan 04.
- **Catalog:** ASI01, ASI06; LLM01:2025; AML.T0051.001. **Status:** accepted residual.

<a id="residual-6"></a>
### Residual 6: LLM review can be manipulated

Spec §11.9 #6: the in-run review (and CodeRabbit, later) reads a diff that the worker wrote and that repo content may have steered, so the review can be manipulated.

- **Owner control:** the review is advisory; the operator merges (AC-7: enforced, the App's merge refused live, H-078, and the live audit in stage b, H-080), with `ci` required and no bypass (`main-protect`). The review runs in a separate session, with a different model, read-only, in a container that runs no repo code (IS-10: enforced in code and tests, Plan 03, H-161). CodeRabbit is never a merge authority or a required check (spec §9.6; AC-17, which the audit checks).
- **Next level:** evals that measure what the review catches against seeded defects (Plan 06's evals and calibration records, H-168), and a second vendor's review (CodeRabbit on hapi-factory since 2026-10-27, H-164; its place in the run loop is H-166), still advisory.
- **Catalog:** ASI09; LLM01:2025; AML.T0051.001, AML.T0067. **Status:** accepted residual.

## 8. Other accepted residuals

The items the handoffs register sent to Plan 01 Task 7 (H-038–H-052, H-137), then the residuals Tasks 5 and 6 left: [the audit's gaps](#audit-gaps), [what isn't verified live yet](#not-yet-verified-live), [CodeRabbit](#coderabbit) and [abliteration.ai](#abliteration-ai). Plan 02 added [what a worker can still do inside its run container](#plan-02-run-container), and Plan 03 [the run engine's](#plan-03-the-run-engine).

<a id="h-038"></a>
### H-038: either App can push either prefix

Both Apps are limited to `plan/**` ∪ `factory/**` (`agent-branch-scope`). Holding an App to its own prefix would make it a bypass actor, which is forbidden, so a `hapi-planner` token in Hermes can push a `factory/**` branch. (The plan's "branches restricted by ruleset to `plan/*`" carries an as-built note saying so: H-081.)

- **Owner control:** only the operator merges, with `ci` green (AC-7: enforced, the App's merge refused live, H-078, and the live audit in stage b, H-080); only the harvester's deterministic code holds `hapi-factory` tokens; the branch-scope rulesets (AC-8: enforced, H-078).
- **Next level:** CI checks lane labels and commit trailers, so a `factory/**` push made with a planner token is caught before merge (GR-6: planned, Plan 05, H-113).
- **Catalog:** ASI03; AML.T0091.000. **Status:** accepted residual.

<a id="h-039"></a>
### H-039: "no App can merge"

The control is `main-review`'s Restrict updates (the `update` rule), with code-owner review as a second layer (AC-7). Its live proof is H-078's App-merge-refusal check, run on 2026-10-27. **Result: refused.** On a test PR with `ci` green, a `hapi-factory` approval and the operator's, `PUT .../pulls/{n}/merge` with a `hapi-planner` token got HTTP 405 ("Repository rule violations found. Cannot update this protected ref."), and GitHub's rule insights (`GET .../rulesets/rule-suites/{id}`) name `main-review`'s `update` rule as the one that failed. `main` didn't move, and the PR was closed unmerged.

- **Owner control:** AC-7, with `tests/docs/rulesets.test.ts` holding the documented JSON to it, and the audit's `github.rulesets` and `github.app-perms`, which passed against the live repo in stage b (2026-10-28, H-080).
- **Next level:** keep running the audit, which checks AC-7's other parts, the bypass actors and the Apps' permissions (in CI once H-154 lands). If a later run of the check lets the merge through: revert it, suspend both installations ([kill switch 2](../runbooks/kill-switches.md#2-suspend-the-github-app-installations)), record "an App can merge once the operator has approved and `ci` is green" as a residual here, and remove the "no merge rights" claims from the README and the GitHub Apps runbook.
- **Catalog:** ASI03; AML.T0091.000. **Status:** enforced (H-078, H-080).

<a id="h-040"></a>
### H-040: Jev and zero data retention

Spec §11.5 enforces zero data retention (ZDR) for every non-Anthropic model. If no Jev endpoint on OpenRouter is zero-retention (H-072), ZDR would fail every Jev call. The documented exception: ZDR off in the `hapi-jev` guardrail only, which keeps its `typesafe/jev-*` model allowlist and the $0.06/day limit ([provider keys](../runbooks/provider-keys.md#hapi-jev-2month)). **Whether it applies: pending (H-072); record the answer here.**

- **Owner control:** a guardrail per key, not the account-wide switch, so no other key is weakened; the model allowlist and the daily limit (DP-10: documented, not verified live, H-071). The exception rests on spec §9.5's v1 boundary: Jev runs on public repos only, whose content is public anyway, and Jev is never a security control.
- **Next level:** verify TypeSafe's and OpenRouter's retention terms before Jev is enabled on any private repo (H-128).
- **Catalog:** LLM02:2025. **Status:** accepted residual, if H-072 finds no ZDR endpoint.

<a id="h-041"></a>
### H-041: App keys only on the host; tokens minted outside the agents

The App IDs and private keys, `hapi-planner`'s included, are in the `host` zone, which no container gets, and App tokens are minted on the host (spec §4.3, §9.1 #7, §11.5). A key in `hermes.env` would let the agent mint its own tokens.

- **Owner control:** AC-5 (enforced: `tests/secrets/manifest.test.ts`, "GitHub App private keys stay in the host zone, never in a container's env file") and AC-6 (enforced). The related name choices are in DP-8: archon's `CLAUDE_API_KEY` is the same secret as its `ANTHROPIC_API_KEY`, and the Jev key is `HAPI_JEV_OPENROUTER_API_KEY`, not `OPENROUTER_API_KEY`, so Pi can't bill `openrouter/` models to the $2 key.
- **Next level:** the host-side minter that gives Hermes its planner token as a read-only file (AC-10: planned, Plan 04, H-098); beyond it, an App key held in a signer that hapi can use but not read (a hardware key or a KMS), unscheduled.
- **Catalog:** ASI03; MCP01:2025; AML.T0055. **Status:** enforced (AC-5, AC-6).

<a id="h-042"></a>
### H-042: the research role holds keys

hapi-research holds spend-capped, search-only keys (Brave, Exa, Context7): a deliberate exception to "no secrets in agent zones" (spec §10.1).

- **Owner control:** caps at each vendor (GR-7, H-071); search-only scope and no repo or forge access; the keys are in the research zone only (AC-5); one MCP secret per server (DP-9).
- **Next level:** per-server isolation (spec §10.1's phase 2 option: each server in its own sandbox with a deny-by-default profile), so one compromised server can't read the other keys. The research container's model key (H-099) is capped too.
- **Catalog:** MCP01:2025; LLM02:2025. **Status:** accepted residual.

<a id="h-043"></a>
### H-043: ContextCrush was fixed server-side

Context7's ContextCrush (CVE-2026-75130, up to 2.1.2) was fixed on Upstash's backend, so no client pin can enforce the fix, and library-owner "rules" can't be switched off client-side: the rules channel stays a live injection path.

- **Owner control:** quarantine. Context7 is in the research zone only (`policy/mcp.yaml`; `tests/policy/mcp.test.ts`), always with an API key and a floor above 2.1.2 (`tests/policy/mcp.test.ts`, "enforces the advisory floor"), with `context7.com` in tier T2 (`policy/trusted_sources.yaml`); but the research zone's proxy allows any public name (DS-4), so nothing at the network level holds Context7 to `context7.com` (H-199). Nothing from the research zone reaches the workers, or the main session, except through a planning PR the operator merges. The container itself is IS-6 (planned, Plan 04, H-099).
- **Next level:** the injection screen over MCP results (IS-7: planned, Plan 04, H-162; spec §10.1 asks Plan 04 to confirm a Hermes post-tool hook can run it), or replacing Context7 with reviewed, hashed local snapshots (T0).
- **Catalog:** ASI04; MCP03:2025, MCP06:2025, MCP10:2025; AML.T0110.002. **Status:** accepted residual.

<a id="h-044"></a>
### H-044: the hermes zone also reaches the registries

A zone's allowlist is its own `hosts` plus its tiers' hosts, so the hermes zone also reaches the T1 package registries: wider than Hermes's original host list. (T2 was later dropped from hermes.)

- **Owner control:** HTTPS only, by name, with IP literals and private ranges refused (DS-2, DS-4, DS-5: enforced in config, on rootful Docker (stage a) and as hapi on rootless (stage b)); Hermes holds no registry publish token; no T2 or T3 for hermes (`tests/policy/mcp.test.ts`, "hermes zone has no T2 sources").
- **Next level:** a hermes allowlist without T1's registries, if planning turns out to need none, or residual 2's read-only method filter. Unscheduled.
- **Catalog:** LLM02:2025; AML.T0086. **Status:** accepted residual.

<a id="h-045"></a>
### H-045: DNS rebinding through the proxy

`to_localnet` is a `dst` ACL, checked when the ACL runs, but Squid connects from its own DNS cache. So a name an attacker controls, with a 0-second TTL, could in principle resolve to a public address for the check and a private one for the connect. It matters most in the research zone, where any name is allowed.

- **Owner control:** `to_localnet` (DS-5: enforced in the generated config, `src/generate/egress.ts`; `tests/generate/egress.test.ts` and "DNS rebinding (static)" in `tests/stack/egress.int.test.ts`, with names planted through `extra_hosts`, H-008), and `ip_literal` (DS-4).
- **Next level:** a rebinding test against a controlled 0-TTL resolver, beside the static test. Unscheduled.
- **Status:** accepted residual.

<a id="h-046"></a>
### H-046: one store reads every zone

Each recipient's age key (or, with bws, the one machine account) decrypts the hermes, archon, research and host values alike.

- **Owner control:** keys are never copied and are checked before every decrypt (owned by the user, no group or other bits, outside the checkout); each machine's key can be revoked on its own; decrypted values exist only in memory, the tmpfs files and Docker's config of each zone container (DP-2, DP-4: enforced; Docker's copy, H-189). hapi's key is hapi's alone.
- **Next level:** a key, or a bws machine account, per zone, so one leak exposes one zone ([docs/secrets.md](../secrets.md#open-items)). Unscheduled.
- **Catalog:** LLM02:2025; AML.T0055. **Status:** accepted residual.

<a id="h-047"></a>
### H-047: sops also tries SSH keys

The sops child also tries `~/.ssh/id_ed25519` and `~/.ssh/id_rsa`. `checkSopsKeys` checks sops's implicit default age key file, but not SSH keys.

- **Owner control:** hapi's store is encrypted to age recipients only, and any other kind of master key is refused (DP-4: `sopsFileProblem`, enforced), so an SSH key opens nothing. sops's default age key file gets the same checks as the configured one (`tests/secrets/sops.test.ts`).
- **Next level:** give every sops child a home with no `.ssh`, or check those files like the age key. Unscheduled.
- **Catalog:** AML.T0055. **Status:** accepted residual.

<a id="h-048"></a>
### H-048: Phoenix MCP over plain HTTP

With the o11y profile on, Hermes's Phoenix MCP server talks to `http://phoenix.hapi.internal:6006` over plain HTTP on the hermes network, carrying the Phoenix VIEWER key.

- **Owner control:** off by default (`enabled_when` o11y; `flags.otel.enabled: false` in `policy/flags.yaml`); a VIEWER-role key; the 23 read-only tools only, with `phoenix-support` denied (`policy/mcp.yaml`; `tests/policy/mcp.test.ts`); the hermes network is internal (DS-1).
- **Next level:** TLS, or a unix socket, between Hermes and Phoenix when the o11y profile is built (Phase 3, H-122, H-123).
- **Catalog:** MCP01:2025; LLM02:2025. **Status:** accepted residual.

<a id="h-049"></a>
### H-049: MCP stdio launch isn't integrity-checked

Until the per-server images, an MCP stdio server launches as `npx --yes <pkg>@<ver>`: `package.integrity` is recorded but not enforced at launch, and the dependency tree resolves from semver ranges.

- **Owner control:** exact pins with recorded integrity, the 14-day cooldown with its security-fix exception, advisory floors and the blocklist (DS-12: enforced). The generators refuse an entry with `image` until image launch is real (`tests/generate/mcp.test.ts`). And no server is launched this way yet: Context7 waits for the research container, Phoenix for the o11y profile.
- **Next level:** per-server images built from committed lockfiles and pinned by digest, before Context7 runs for real (DS-13: planned, Plan 04, H-100).
- **Catalog:** ASI04; LLM03:2025; MCP04:2025; AML.T0010.005, AML.T0011.001. **Status:** accepted residual.

<a id="h-050"></a>
### H-050: the secret-name heuristic

`SECRET_ENV_NAME` (names ending `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL(S)`) misses secret-looking names such as `CONTEXT7_APIKEY` or `X_AUTH`.

- **Owner control:** a server can be given a name only if its package's `PACKAGE_ENV` allowlist lists it, with a kind, and a test forces every secret-looking allowlisted name to kind `secret` (DP-9: `src/policy/mcp.ts`; `tests/policy/mcp.test.ts`).
- **Next level:** the CI MCP scanners (H-111) and the upgrade review ([docs/mcp.md](../mcp.md#adding-or-upgrading-a-server), step 3) check each allowlisted name against the package itself.
- **Status:** accepted residual.

<a id="h-051"></a>
### H-051: no cooldown for mise tools and Actions

`bunfig.toml`'s `minimumReleaseAge` (3 days) covers npm only. A compromised mise tool or Action release has no cooldown window, and several Task 1 pins were under a week old when pinned.

- **Owner control:** exact pins (DS-7: enforced, `pins.versions`); the mise Action's check of the mise binary against its release's signed packslip (CI's log, for mise 2026.10.9); `mise.lock`'s checksums (DS-7), which fail a release file replaced after it was locked, though not one that was bad when locked.
- **Next level:** a release-age cooldown for mise tools and SHA-pinned Actions (DS-8: planned, Plan 05, H-115), and a sha256 for the mise binary (H-116).
- **Catalog:** ASI04; LLM03:2025; AML.T0010.001. **Status:** accepted residual.

<a id="h-052"></a>
### H-052: the fresh-reader check

Task 7 Step 3 asks for a fresh reader to check every spec §11.9 residual against this document: each one present, with an owner control and a next level. The Task 7 reviewer does it, not a subagent the implementer spawns, since the implementer contract forbids spawning one. `tests/docs/threat-model.test.ts` checks the anchors and labels mechanically; the reviewer checks the substance, against [section 7](#7-spec-119-residual-risks) and the map in Task 7's report.

<a id="h-137"></a>
### H-137: the 10 words open everything

The 10 recovery words plus `recovery.age` open the store, every zone included. `recovery.age` is backed up with the store in the private repo, so the words are the only barrier.

- **Owner control:** the words are tool-generated (about 110 bits), behind age's scrypt, and kept apart from `recovery.age` (never in the repo or `private/`); `secrets:drill` proves them; if they're exposed, `secrets:new-recovery`, then reissue every credential, since old copies of the store still open with the old words (DP-4: enforced, `src/secrets/recovery.ts`; `tests/secrets/recovery.test.ts`, `tests/secrets/lifecycle.test.ts`). The prompt on a real terminal is DP-5 (H-136).
- **Next level:** a hardware key, or sops key groups ("any 2 of 3"), instead of one set of words (H-131).
- **Catalog:** AML.T0055. **Status:** accepted residual.

<a id="plan-02-run-container"></a>
### Plan 02: what a worker can still do inside its run container

Plan 02 gives every run a container of its own (DS-6, DS-15, DS-17) and hapi-guard (DS-16). A worker in it is still an LLM-driven shell with a uid, the archon zone's model keys and the zone's egress list. These are the things it can do that the guard does not stop, each accepted for v1. None reaches another run, `main`, or the forge: the container has no forge credential or route (AC-9), and only the operator merges (AC-7).

- **It can tamper with its own run's records.** The worker shares a uid with Archon and the guard, so it can edit Archon's database in `/.archon`, the guard's budget ledger in `/tmp/hapi-guard`, and `transcript.jsonl` and `decisions.jsonl` in `/out`. It cannot reach another run's, because nothing is shared between run containers. So the guard-ran check (design §6a item 7) catches a guard that failed to load, a Pi attempt with no `session_start` record, but not a worker that writes fake `session_start` records: no channel the guard holds is out of the worker's reach. Behind the ledger are the poller's caps, which read the same records (H-250), and the providers' caps.
- **The shell can read its parent's environment.** Rule 8 (the `unset` prefix, and the guard deleting the zone's keys from its own `process.env`) keeps keys out of casual output only: they stay readable through `/proc/<parent>/environ` (spike 08, finding 7). It is not a boundary. The zone's keys are also in the container's configuration (`docker inspect`, `Config.Env`) while it exists, as the `env_file` made them before (spike 07, finding 16; H-189).
- **The shell can call the model APIs itself** with the zone's keys, with `curl` or a script that loads the Pi SDK Archon ships. That is outside Pi's session, so outside the guard's budget. Only the providers' caps (GR-7) and the zone's egress list bound it.
- **Git drivers named in the repo run inside the run.** git's environment config outranks a repo's `.git/config` for the single-valued settings that run a program (`core.hooksPath`, `core.fsmonitor` and the rest of the 13 pairs in the container's environment), so those hold. `diff.external` is single-valued too but has no inert value (an empty one makes every `git diff` fail with `cannot run`), so it stays open, reached by the same `.git/config` write as the name-indexed drivers. Name-indexed drivers (`filter.<name>.*`, `diff.<name>.textconv`, `merge.<name>.driver`) and the first-wins `remote.<name>.uploadpack` can't be neutralised that way. Spike 07 saw Archon's checkout run a planted `filter.x.clean`. The prelude's own `git rev-parse` and `git bundle` also run in the worker-writable clone. Same uid, same container, no escalation; the host reads the bundle only with its own git and hardened flags.
- **A repo's `bunfig.toml` runs for any `bun` the worker starts in the worktree** (a `preload`, spike 07, finding 9). It can't escalate, and Archon starts from `/app`, so Archon's own Bun never reads it.
- **It could fill the host's disk; closed by Plan 03 (H-217).** The run's two volumes, `/work` and `/out`, had no size cap, so a worker could `fallocate` a large file and fill hapi's Docker data root. They are now bind-backed volumes on the run disk, a fixed-size filesystem of its own (`/var/lib/hapi/rundisk`, at most `runs.disk.gb`), apart from Docker's data root, which `hapi run start` checks before every run (`hard` by default) and the audit's `runtime.run-disk` holds (DS-17). A worker can fill only the run disk, which stops new runs until it is emptied, never the stack's disk.
- **`npx` and `uvx` download.** `BUN_OPTIONS=--no-install` stops every `bun` and `bunx` from installing, but not `npx` or `uvx`, which are explicit downloads. They go through the zone's registries (npm, PyPI), which are on its egress list. A package from there runs in the container.
- **Rule 7 is a signal, and it is frozen.** It blocks a `bash` command that plainly writes to a protected path. It reads a file command only at the command position and only its targets, against every directory an earlier `cd` (or `env -C`, `sudo -D`) may have left the command in; it reads `eval`'s, `env -S`'s and `sh -c`'s text again as commands, and a segment led by a wrapper it can't follow (`watch`, `chroot`, `strace`, `parallel`, `su` and the rest of its opaque list) by Plan 02's broad rule (H-223, closed). After Task 10's review it takes no new option specs and no new readers: each round of exact readers opened new gaps while one-token bypasses stayed, so what it still misses is one accepted residual, [H-256](../superpowers/plans/handoffs.md): among others interpreter one-liners, `$VAR` and substitutions inside a word, brace and `$'…'` expansions, find's `-delete`, `-fprint` and `{}`-fed paths, stdin-fed `xargs`, a wrapper's own output file (`strace -o`), `sudo -e`, commands it doesn't read (`rsync`, `tar -x`, wrappers on neither list), git writes it doesn't list (`reset --hard`, `merge`, `clean`), a link the same command makes, a `ln -s TARGET` resolved against the cwd, and a worktree alias outside the worktree. The boundary for protected files is the host-side diff gate on the bundle (Plan 03, H-203).
- **The spend and result records are claims.** The guard's `spend` record (the run's total and turns) and its `result` record (the session's `RESULT:` line) are lines in `/out/decisions.jsonl`, which the worker can edit like any of its records. A forged total that falls can't lower the spend the host reads, since a falling ledger makes it unknown (`spendOfRun`); a rewritten ledger whose totals never fall, or both sources rewritten, can (H-250), and a forged high one only stops the run sooner. A forged `RESULT: done` is a claim the host's diff and verify judge (H-228(b)); the line is also the worker's own words, which the PR fences as its claim.
- **The repo's context file stays below the work order in every request Pi 1.3.0 makes.** hapi-guard moves a repo's `AGENTS.md` out of the system prompt in `before_agent_start`, for the run's requests, retries and tool turns (spike 09, T17). Pi's other requests don't bring it back, as the Task 10 review read the pinned image's dist: a compaction request has its own system prompt, `SUMMARIZATION_SYSTEM_PROMPT`, with no project context (`core/compaction/compaction.js:497-507`, `utils.js:110-133` and `:145`); a cache warm replays the context already stripped (`cache-warmer.js:229-235`, `sdk.js:270`); and later turns reuse the stripped options (`agent-session.js:544-553`). A Pi upgrade could change that, so a tripwire stays behind it: `before_provider_request` fails the node on Pi's own context tags in the system prompt. Compaction requests skip that hook (spike 08, finding 5), so the tripwire doesn't cover them (H-228(a)).
- **The Jev write gate is local.** The credential check on a write is code in the guard (design §3.4), not a model call. The bash gate and the result screen fail closed when no classifier answers, and state over the cap takes the decision file's fallback (block, or wrap), never a pass. They are signals too (spec §9.5).

- **Owner control:** the container (DS-6: no capabilities, no new privileges, read-only root, own network, uid 1001), per-run storage that dies with the run (DS-17), the egress list (DS-2, AC-9), the provider caps (GR-7), and the host treating every output as untrusted data: bundle read with hardened git, status taken from Archon's own record, a copy-out limited to four named files (design §6a item 11). The merge stays the operator's (AC-7).
- **Next level:** the host-side diff and scope gates on the bundle and the disk cap are done (Plan 03, H-203, H-217); a key-injecting model gateway at the egress, so no model key enters the run container (Phase 2+, H-215; spec §11.5); `npx`/`uvx` offline switches, `npm_config_offline` and `UV_OFFLINE` (unverified, Phase 2+, H-216); run events shipped off-box to a store the archon zone can't write (MO-6, Phase 3), so a rewritten local record no longer matches the copy.
- **Catalog:** ASI02, ASI05, ASI06; LLM02:2025, LLM06:2025; AML.T0055, AML.T0086. **Status:** accepted residual.

<a id="plan-03-the-run-engine"></a>
### Plan 03: the run engine

Plan 03 ([the run engine's design](../superpowers/specs/2026-10-31-hapi-factory-03-run-engine-design.md)) turns a merged work order into one factory PR with no human in the loop until that PR: a poller on the host, three containers a run, and a deterministic harvester ([the engine runbook](../runbooks/engine.md)). Its controls, enforced in code and tests, with their first live run the sandbox's (Plan 03 Task 16):

- **Three containers, each with only what its job needs** (design §3.5; `src/run/kinds.ts`). The worker (and a fix) holds the archon zone's model keys and its egress, and no forge credential or route (AC-9). **Verify holds no key at all.** **The review runs no repo code:** its prelude (`stack/archon/review.sh`) runs nothing from the checkout, its Claude Code session has every write, run, fetch and `/proc` read denied by managed settings (`src/generate/claude.ts`), and it holds only the review zone's keys, on `egress-review`, which reaches Anthropic and CodeRabbit alone (IS-10).
- **The verify container's network** (design §3.5, a call flagged to the operator): it joins `egress-archon` only to install from the bundle's lockfile (`bun ci --frozen-lockfile --ignore-scripts`), holds no key for the zone's model APIs, and never reuses the worker's `node_modules`, which could fake a result (its `/work` is fresh).
- **The planner's acceptance tests** at `.factory/work/<id>/acceptance/`: written at planning, approved by the planning PR's merge, out of the worker's reach under `.factory/**` (the host's protected-path gate catches any edit, whatever wrote it), and run by the verify container.
- **`runs.phases.require_acceptance`**, on by default (an overlay may only switch it on): **Ready to merge** needs the acceptance tests to exist and pass; with none, the best verdict is **Needs your decision**, and a failing one makes a draft **Do not merge**, which GitHub refuses to merge.
- **The review zone** (`stack/secrets.yaml`): the `hapi-factory` workspace's key under its two names, and CodeRabbit's dedicated key, never in the archon zone. CodeRabbit's key is the one secret passed in argv, the operator's written exception (2026-11-01), under three tested conditions: its node runs only after the review node has ended, `/proc` reads are denied, and the key is dedicated and revocable ([docs/secrets.md](../secrets.md#threat-notes)). The denial is the review session's: on the host, the CLI's argv is readable by any process that can read `/proc/<pid>/cmdline` for its lifetime (procfs without `hidepid`), so a host that runs other people's code would see it; revoking the dedicated key is the response, and a `hidepid=2` mount of `/proc` on the host narrows it.
- **The harvester, a deterministic writer** (`src/engine/harvest.ts`): it runs no generative model and reads every run's outputs as data. Before any push it checks the bundle with the host's own hardened git (protected paths with the repo's overlay, scope, sizes, and each commit as the commit node makes it: the generated worker identity as author and committer, no raw header beyond tree, parent, author and committer, and the six trailers, each once, and no other, so a worker-written git config can't credit a commit to someone else) and scans every new commit for secrets (the pinned gitleaks over its patches; both zones' exact values, raw and base64, in each commit's patches, raw header (the committer, any extra header and every continuation line included) and message, and in every changed path's name, trees included; and the key formats in each commit's raw header and message and in every changed path's name). Each commit's header and message are read from its own object (`git cat-file --batch`, by its byte lengths), never parsed out of `git log`'s text, so a crafted header line can't hide another header or the message; a commit that fails either check is purged from the scratch, and nothing is pushed. It pushes only `factory/<id>`, never forced, and never merges (H-203).
- **The label-actor check, and the CodeRabbit round's filters** (`src/engine/coderabbit.ts`): a `hapi:rework` label starts a run only when its event's actor is a human with at least triage permission, not an App. The one automatic CodeRabbit round reads only the pinned bot's (user id 136622811) root comments on the head commit the factory pushed, in a review it submitted there, confirmed by its check run, and is off once anyone but the operator, hapi's Apps or CodeRabbit comments or reviews. Each comment reaches a fix run as quoted data (IS-7's wrapper), never as instructions.
- **The harvester's decisions** (design §3.6, "Decisions"; `src/engine/decisions.ts`): typed, advisory `decide()` questions about the redacted diff of a head it will push, asked after the host gates, the secret scan and the PR lookup. An answer can only hold back **Ready to merge** or add a note, and no re-render drops a hold; a failed, skipped or unshown subject holds back **Ready** too. Each call is written down before it is made, and the calls per head are capped (`gates.decisions.max_calls_per_head`). The ledger is host-only and records names and numbers, never the state's text or a key. Jev is asked only for public repos. `gates.decisions.mode: off` is the operator's explicit, visible choice (the PR, the status comment, the run records and the audit's `policy.decision-models` note say so), never a fallthrough.
- **The poller's caps and the queue** (IS-9, AC-14; `src/engine/caps.ts`): the repo's month and the day before every run it starts, the automatic, rework and retry counts always hard, one pipeline per repo and `runs.max_live` in all.
- **The Console limit:** the `hapi-factory` workspace's monthly limit is the one stop no worker can get around (GR-7).

Its residuals, each accepted for v1:

- **A compromised worker can under-report its spend.** The guard's ledger and Archon's total are both writable by the worker, so it can lower what `hapi run list` and the caps count: rewriting the ledger alone, its totals never falling, gives Archon's total when that is lower than the truth, or anything at all when Archon reports none; rewriting both, any value (H-250, as `src/run/spend.ts` states it). The provider's limit bounds it; a metering gateway outside the run is the next level (H-215).
- **`check` re-runs the worker's own tests,** and the worker's code runs where verify writes its results (H-251; Landlock is H-260). So the independent layers are the planner's acceptance tests under `.factory/**` and CI's `ci / gates` on the pushed head.
- **The acceptance tests are only as strong as the planner wrote them,** and the operator's merge of the planning PR is their only review.
- **The verify container runs the worker's code with the archon zone's egress.** It holds no secret to send, and `--ignore-scripts` runs no install script, but a test the worker wrote can reach every host on that allowlist.
- **The smoke sidecar can reach `egress-archon`.** It shares the run's own network with the run and its proxy (Plan 03 Task 9); it holds no key, so all it can send is what the run gave it, to a host on that allowlist (H-283).
- **A worker can commit its own key in an encoding the host's scan doesn't read.** The scan matches both zones' exact values raw and base64, at any alignment, beside gitleaks's rules; hex, URL-encoding, or a key split, reversed or otherwise transformed passes it, and GitHub's push protection and the PR's history scan read no further. Its bound is the key itself: the archon zone's keys are capped and revocable (kill switch 1; H-284).
- **A crash mid-harvest can leave a run's unscanned commits readable.** A crash between the harvester's bundle fetch and its purge (a SIGKILL, a power loss) leaves that run's ref and objects in the work order's scratch; the next clean harvest of another run of the work order compacts only what no ref reaches, then opens the scratch to all, so the leftover commits, never scanned, become readable to that work order's later verify, review or fix containers, a key the worker committed included (H-276).
- **The worker's prelude lacks two things the verify and review preludes have** (H-252): (a) the guarded kill after the workflow ends (`if [ "$$" = 1 ]; then kill -s KILL -- -1 2>/dev/null; fi`), so a worker's leftover processes can still write the clone or `/out` while `stack/archon/run.sh` makes the bundle and reads back; the host reads only what the bundle holds, with its own gates (H-203), so what they change still meets the host's gates, and what they write to `/out` is the worker's own claim, as every run output is; and (b) the worker's clone keeps `CLAUDE.md`, `.claude/` and `.mcp.json` (Pi reads a `CLAUDE.md` as a context file, which hapi-guard moves below the work order, H-228(a)).
- **Some of a run's limits are code, not policy** (H-254): the smoke sidecar's `/tmp` tmpfs and its log caps (`src/run/sidecar.ts`), and the run container's tmpfs sizes (`src/run/spec.ts`), so they are fail-closed defaults with no per-enforcer setting in `policy/` yet. A gap in the limits rule, not in a boundary: each still bounds the run.
- **A hand run binds whatever `--repo` it is given.** The poller's runs start from the credential-free mirror (H-211), but `hapi run start --repo` still binds a working checkout's git dir read-only, so a credential in that checkout's `.git/config` (an `http.extraheader`, a token in a remote URL) is readable by the run. [The runs runbook](../runbooks/runs.md#hapi-run-start) says to pass a bare clone; a refusal of a non-bare `--repo` whose config holds one is H-286.
- **An injection in the diff can steer the advisory review** (the same shape as [residual 6](#residual-6)).
- **An injection in a screened file can steer that file's decision,** so it can miss (today's behaviour) or raise a false alarm (a visible **Needs your decision**); it can't steer another file's screen.
- **The host uses the archon zone's classifier keys, which it shares with workers:** a compromised worker can spend the zone's Jev share and the workspace's limit, which turns every decision to "not screened", and so held (fail-closed; H-269).
- **The classifier sees each screened file's redacted diff and path:** Jev only on public repos, and only for a head about to be published; Haiku otherwise (the provider the guard's gates already use when they are on).
- **With decision models off** (the operator's recipe, [docs/policy.md](../policy.md#running-without-decision-models)), nothing screens a worker's bash calls and tool results, or the diff going into the review, with a classifier: the deterministic rules and the other layers stand alone.
- **Anyone can comment on the PR, and so turn the automatic round off.** That fails safe: the PR waits for the operator.
- **A crashed or stopped tick's tokens stay valid until their hour runs out.** They are in memory only; suspending the Apps' installations stops them (kill switch 2).
- **A stopped tick's own children run on.** The poller's service uses `KillMode=process`, so each run's detached supervisor outlives a stop, and so do the tick's children it hadn't detached (a `git` fetch, a `docker` CLI call, gitleaks), which run to their end unsignalled. A unit of its own for each supervisor would let the service use `mixed` (H-280).
- **Raising `runs.max_live` above 1 needs the run disk's lock revisited.** `mise run down` and every run's finalize share one lock on the run disk, and its wait was sized for one live run (H-282).
- **A skipped `bun.lock` can carry words the diff screen never sees,** within what its structural check admits (H-275); the review and CodeRabbit read the lockfile's diff as data, and verify installs it with `--ignore-scripts`.
- **Rule 7 stays frozen** with its listed bypasses (H-256); the host's protected-path gate on the bundle is the boundary.
- **The history scan's own residuals** (Plan 03 Task 5): a PR allowed to change `.github/workflows/` can forge `ci / gates`, since a personal account has no required workflows (H-239); gitleaks's default path allowlist and its value regexes hide a token in an allowlisted path, or one holding `false` anywhere or starting `true` or ending `null` (H-240); a token outside file contents (a commit message, a file's name, a tag's message) isn't scanned (H-242); and hapi-factory's own `secrets` job reads the PR's own `.githooks/gitleaks.toml`, so a PR that edits it changes its own scan (H-246; DP-12).

- **Owner control:** the containers' split (DS-6, DS-15, DS-17), the host gates on the bundle (H-203), the acceptance tests under `.factory/**`, the advisory verdict, the required `ci / gates` on the pushed head, and the operator's merge (AC-7).
- **Next level:** a key-injecting gateway (H-215), Landlock in verify (H-260), dedicated host classifier keys (H-269), a unit of its own for each supervisor (H-280); on a clean harvest, dropping every leftover run's ref with no clean-scan record before the scratch is compacted and opened (H-276); `run.sh`'s guarded kill and the wider strip, made with their twins in `verify.sh` and `review.sh`, once the operator OKs the protected `stack/archon/run.sh` (H-252); the run's and the sidecar's tmpfs and log caps moved into `policy/runs.yaml` and `policy/sidecars.yaml`, with the operator's OK for those protected files (H-254); `hapi run start` refusing a non-bare `--repo` that holds a credential (H-286); and, for the history scan, the options each of H-239, H-240, H-242 and H-246 names.
- **Catalog:** ASI01, ASI02, ASI06, ASI09; LLM01:2025, LLM02:2025, LLM06:2025, LLM10:2025; AML.T0051.001, AML.T0067. **Status:** the controls are enforced in code and tests; the residuals are accepted.

<a id="audit-gaps"></a>
### The audit's known gaps

`hapi audit` (MO-1) is the detective control. What it can't see yet, each with its register item:
- **H-151:** provider spend limits aren't read by any check.
- **H-152, closed by Plan 02:** Archon ignores an unknown top-level key in its `config.yaml` without a word. The one new key hapi emits, `assistants`, is read back through Archon's own `loadConfig` in `tools.archon-validate`; the next top-level key a plan emits needs its own read-back.
- **H-179(c):** the Hermes config carries no `_config_version` stamp yet, so an old schema and a current one look alike after an upgrade; Plan 04 stamps it (H-153 closed into it).
- **H-154:** the audit doesn't run in this repo's CI yet.
- **H-155:** `repo.ai-workflows` doesn't follow reusable workflows, flag `workflow_run`, read a job's default token permissions or fetch an action's defaults.
- **H-156:** `up` never deletes from `build/`, so a file policy stopped generating stays behind (the audit now fails on it, naming it).
- **H-157:** `pins.versions` can't read a heredoc `RUN` or a downloaded-then-run installer.
- **H-190:** `runtime.hermes-no-yolo` doesn't read `$HERMES_HOME/.env` (`/opt/data/.env`, on the writable `hermes-data` volume), which Hermes v0.22.5 loads at startup over its environment, so a `HERMES_YOLO_MODE` or `HERMES_KANBAN_DISPATCH_IN_GATEWAY` planted there would pass the check.
- **H-238:** no check reads the template lock `hapi new-repo` writes into a repo (`template.lock`, under its `.factory/`), so contract files that drifted from the template aren't reported.
- **H-257:** `policy.budget-enforcement` passes `hapi_guard: soft` with `archon: hard`, though no enforcer then stops a Pi run at `run_usd` (its detail says so).
- **H-193:** `runtime.dev-override` reads only the auditing user's Docker, so the documented audit, as hapi, never sees a dev-bypass stack on the operator's own Docker (DS-10).
- **`mcp.tool-hashes`** stays a skip until the live fetch (H-101; ruling R1), so a strict audit has exactly one expected fail ([the stack runbook](../runbooks/stack.md#5-the-audit)).

**Owner control:** `--strict` makes every skip a fail, and a check that throws fails, so a gap shows as a skip or a fail, never as a pass. **Next level:** each item above. **Status:** accepted residual.

<a id="not-yet-verified-live"></a>
### Not yet verified live

Stage a ran everything on the build host's rootful Docker as an ordinary user, with fake secrets. Stage b (2026-10-28) then ran host setup, the stack as hapi on rootless Docker, its integration tests, kill switch 4 and the strict audit, on the real host and against the real repo (H-080, H-146, H-150; [spike 05](../spikes/05-rootless-images.md)), and those controls' rows now say so. Plan 02's rollout and paid check (2026-10-31) then ran the run container as hapi on rootless Docker, the guard in live model runs, and the strict audit at `14 pass, 1 fail, 0 skip` (MO-2), and removed the old Archon volumes ([spike 08's live check](../spikes/08-guard-hooks-offline.md#live-check-2026-10-31)). What still hasn't run live:
- **H-160:** the kill-switch runbook's other marks: the providers' UI paths, whether a token minted before a suspension is refused, and switch 3's fallback and hard stop (MO-5).
- **H-179:** on the real stack, a stranger's DM, a non-allowlisted member's channel messages, and the context of a thread Hermes answers (AC-12, documented, not verified live; stage b checked only the operator's DM).
- **H-188:** host setup for a `hapi` user that existed before it, whose added subordinate range rootlesskit may not map. AC-1 is enforced for a new `hapi`, all but its root-equivalence check. The same next run is also that check's first live run. It was added after stage b and tested only with a stub `id` and `sudo`: it reads classic sudo's English answer to `sudo -n -l -U hapi`, and stops, asking for a check by hand, on a sudo that words it differently (sudo-rs is believed to match, unchecked).

**Owner control:** the controls stay documented, not enforced, until each check passes. **Next level:** run them, then mark each control here. **Status:** documented, not verified live.

<a id="coderabbit"></a>
### CodeRabbit: a third-party reviewer that can write

CodeRabbit's GitHub App (`coderabbitai`, App ID 347564) holds write access to contents, pull requests, issues, checks, statuses and workflows. It reviews a same-repo PR with that PR branch's own `.coderabbit.yaml`, reads `AGENTS.md`-style files as review guidelines, learns from chat comments, and on a personal-account repo anyone on GitHub can talk to it. In 2025 a researcher ran code on its servers through a PR's linter config and reached its App private key (Kudelski Security, fixed the same day). Two of its writes can't be turned off in config: the "Commit the changes to this branch" checkbox and `@coderabbitai autopilot`, which commit under the GitHub authorization of whoever asked.

- **Owner control:** it can't merge or gate: no bypass, no required check, and the operator's merge needs Restrict updates' bypass and a code owner (AC-17, AC-7). It is review-only, its config and the instruction files it reads are protected paths (GR-9), and its comments are untrusted text (IS-7). The run engine starts at most one automatic fix round from its PR review, reading only the pinned bot's (user id 136622811) root comments on the head commit the factory pushed, confirmed by its check run, each passed to the fix run as quoted data; anyone else on the PR turns the round off (Plan 03, H-166(c); [the Plan 03 section](#plan-03-the-run-engine)). It never sees hapi-factory-private. The operator never ticks the commit checkbox or runs `autopilot` on a factory or planning PR, and CI's trailer check (H-113) catches such a commit. Kill switch 2 suspends it ([docs/runbooks/kill-switches.md](../runbooks/kill-switches.md#2-suspend-the-github-app-installations)).
- **Next level:** H-164's check, with a second account, of which commands an outsider can run; H-168's calibration of the one automatic round from the sandbox's findings (Plan 03 Task 16), and dropping a finding the fix before the PR declined (H-277).
- **Catalog:** ASI04, ASI09; LLM01:2025; AML.T0010. **Status:** accepted residual.

<a id="abliteration-ai"></a>
### abliteration.ai: a separate trust domain

Spec §2 plans abliteration.ai for security-research work, downstream of v1. It is a separate trust domain (spec §4.4): its own Hermes profile and roster, its own capped key and workspace, its own data-boundary review (terms and retention first). It is never available to the default factory rosters, its outputs are untrusted, and its content stays out of public repos unless sanitized.

- **Owner control:** AC-15 (planned, Phase 2+, H-127). In v1 it doesn't exist: no roster, manifest entry or allowlist names it.
- **Next level:** its own threat model, scoped to that domain, before its first key is created.
- **Status:** planned (Phase 2+, H-127).

## 9. Implementation and monitoring

- **Detect:** `hapi audit`, as hapi, with the stack up: at the end of stage b, after every upgrade, and whenever you want to know the stack still matches policy (`mise run audit -- --strict --repo "$OWNER/hapi-factory" --github-token-file <file>`, [docs/audit.md](../audit.md)). In CI once H-154 lands.
- **Respond:** the [kill switches](../runbooks/kill-switches.md), fastest first, then rotation ([docs/secrets.md](../secrets.md#rotating-a-secret)).
- **Prove:** each control's test in [section 6](#6-controls-by-sans-domain) runs in `mise run test` (and `mise run test:int`, `HAPI_INT=1`, for the integration tests).
- **Review this document:** on every trigger in [how to update it](#how-to-use-and-update-this-document), and at the end of each plan, when that plan's planned controls change status (H-161, H-162, H-163). v1 acceptance (Plan 07) brings the catalogs up to date (H-158, H-159).

## 10. Where the build differs from spec §11

The spec's own text is kept; since 2026-10-29 each difference also has an "As built" note beside it in the spec (H-083).
- **§11.8, kill switch 3, "`mise run down` as host admin":** you still run it from your own account, but it re-execs as hapi (`sudo -u hapi -H -- sh -c '<fixed script>'`, AC-3), and the runbook adds a fallback with no checkout or mise and a hard stop of hapi's Docker ([kill switches](../runbooks/kill-switches.md#3-stop-the-stack)).
- **§11.2, hapi-research's "Sensitive access: None":** it holds spend-capped, search-only keys (spec §10.1; [H-042](#h-042)), and will need a capped model key (H-099).
- **§4.3, the Hermes container's "search API key":** the search keys are in the research zone (`stack/secrets.yaml`), as §9.1 #4 and §10.1 say; the hermes zone holds none.
- **§11.3, the "Next level" of "a microVM per run, or one container per run":** one container per run is now the baseline for runs ([the runs runbook](../runbooks/runs.md), DS-15, DS-17). The Hermes main session is still one long-lived container (H-200).
- **§11.3, "Hermes and Archon in separate containers on a private network":** each zone has its own internal network, and only the proxies share `outbound`, so the Hermes and Archon containers can't reach each other at all (DS-1).
- **§11.4, "a default-deny proxy per container":** one per zone; the research zone's isn't default-deny (any public name; IP literals and private ranges refused, DS-4).
- **§11.1, "the six SANS Critical AI Security Guidelines domains":** those are the v1.1 draft's; v1.4 (March 2026) has eight control categories (H-158).

## 11. Sources

Each read on 2026-10-27.

| Source | Version | Where |
|---|---|---|
| CSA MAESTRO (Ken Huang, "Agentic AI Threat Modeling Framework: MAESTRO"): the 7 layers and the 6 steps | blog post, 2025-02-06 | [cloudsecurityalliance.org](https://cloudsecurityalliance.org/blog/2025/02/06/agentic-ai-threat-modeling-framework-maestro) |
| OWASP Top 10 for Agentic Applications 2026: IDs and titles from the document's table of contents (the release post shortens ASI02 to "Tool Misuse") | "Version 2026, December 2025" | [genai.owasp.org](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) |
| OWASP Top 10 for LLM Applications | 2025 | [genai.owasp.org/llm-top-10](https://genai.owasp.org/llm-top-10/). A 2026 edition was announced on 2026-09-01; v0 keeps the 2025 IDs (H-158) |
| OWASP MCP Top 10: the entries at commit 165fe0f of the project repo; MCP06's file is titled "Intent Flow Subversion", the project page "Prompt Injection via Contextual Payloads" | 2025, beta | [owasp.org](https://owasp.org/www-project-mcp-top-10/), [GitHub](https://github.com/OWASP/www-project-mcp-top-10) |
| MITRE ATLAS: every technique ID and name from the release's data file (sha256 `935efa93e28294432d3e2f537eb94991ef8d1f8c58341cd360ea3321ddb66688`) | 2026.09, released 2026-09-15 | [mitre-atlas/atlas-data](https://github.com/mitre-atlas/atlas-data) (dist/v6/ATLAS-2026.09.yaml) |
| SANS Critical AI Security Guidelines: the six domains, as section titles of Rob T. Lee's post "Securing AI in 2025: A Risk-Based Approach to AI Controls and Governance" (2025-03-31), on the v1.1 draft | v1.1 draft | [sans.org](https://www.sans.org/blog/securing-ai-in-2025-a-risk-based-approach-to-ai-controls-and-governance) |
| SANS Critical AI Security Guidelines: eight control categories (Conventional Security Controls; Data Minimization and Obfuscation; AI Supply Chain Management; Data/Model Engineering Controls; Limit Model Behavior; Model I/O Handling; Monitoring; Governance, Risk, Compliance (GRC)) | v1.4, March 2026 | [sans.org](https://www.sans.org/mlp/critical-ai-security-guidelines) |
| GitHub: suspending an installation ("Reviewing and modifying installed GitHub Apps"); "Suspend an app installation" and installation tokens expiring one hour after creation (REST API endpoints for GitHub Apps) | — | [docs.github.com](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps), [REST](https://docs.github.com/en/rest/apps/apps#suspend-an-app-installation) |
| Anthropic: disabling, re-enabling and deleting API keys; workspace spend limits | — | [Authentication](https://platform.claude.com/docs/en/manage-claude/authentication), [Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces) |

What couldn't be confirmed was left out: no OpenCode Go, OpenRouter, Brave, Exa or Context7 UI path for disabling a key (the kill-switch runbook marks them **[verify]**), and whether a GitHub token minted before a suspension is refused (H-160).
