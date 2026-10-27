# Research behind the design

The design spec ([docs/superpowers/specs/2026-10-26-hapi-factory-design.md](../superpowers/specs/2026-10-26-hapi-factory-design.md)) rests on research done before it was written. This page says what that research covered and which of its conclusions the spec adopted, by section.

**The sources are private.** The notes also hold the operator's own context (accounts, machines, other projects), so they live in the operator's private repo, not here. Every fact in them is dated, mostly 2026-10-26. Check a fact against its primary source before you rely on it: these tools change weekly.

## What was researched

A recon report and seventeen notes (2026-10-26), plus the CodeRabbit research (2026-10-27). Each gives its sources, versions and an evidence label per claim (verified in source or docs, vendor claim, secondary, inference). Several went through an adversarial fact-check pass, and the corrections were applied.

| Topic | What it covers |
|---|---|
| Recon report | The whole four-layer factory: coordinator, run mover, worker, decision support. It ends in ten design implications and the decisions only the operator could make. |
| Hermes Agent | Hermes v0.22.5 as the coordinator: its security model, defaults, subagents, profiles, skills and memory. |
| Hermes plugins | Which Hermes plugins, skills and MCP entries to adopt; its protected-instruction gate and approval modes. |
| Hermes skill versioning | How skills, including self-written ones, are versioned and reviewed. |
| Run mover | Archon v0.12.1 against Hermes Kanban and super-simple-software-factory (SSSF). |
| Archon integration | Archon's providers, triggers, observability and hardening. |
| SSSF and Jev | The SSSF pattern and the ten-levels-of-jev repos. |
| Pi and worker harnesses | Pi v1.4.0 as the worker, Claude Code as the swappable lane, a harness-neutral work order. |
| Pi extensions | Pi extensions and packages for the worker inside Archon. |
| Factory landscape | Peer factories, task-state options and decision-support patterns. |
| Model sizing and cost | Model choice per role, effort, caching and spend control. |
| Provider subscriptions | Coding plans that can legitimately power an unattended factory. |
| Security frameworks | OWASP (LLM, Agentic, MCP), CSA MAESTRO, NIST, MITRE ATLAS, SLSA and SANS SEC545. |
| Security controls | Concrete controls and tools per layer, on Linux. |
| Web, search and docs | Trusted search, fetch and documentation sources for agents. |
| MCP baseline | The baseline MCP servers per zone, each fact-checked. |
| Observability | The optional self-hosted observability stack. |
| sops + age recovery | Key backup, recovery and multi-machine patterns for the secrets store. |
| CodeRabbit (2026-10-27) | Its tiers, GitHub permissions, write features, configuration, CLI, data handling and open-source adoption. The register's H-164 to H-172 carry what it found. |

## The conclusions the spec adopted

| Conclusion | Spec |
|---|---|
| Hermes sits in front of the factory, not inside it: intake, brainstorming and scheduling, no repo-write credentials, its risky defaults turned off on day one. Its own security policy says the operating system is the only boundary against an adversarial model. | §4.1, §9.1, §11.5 |
| One component owns run state. Archon is the run engine: the most complete multi-harness option, but it churns every minor release and needs hardening (its server binds every interface by default). SSSF is the pattern library, after a documented runaway run cost one user $182.83. | §4.2, §9.2 |
| Pi is the default worker and has no permission system, so the boundary is a container, a guard extension and protected paths. Pi loads `AGENTS.md`-style context files even in an untrusted repo. Claude Code is the later lane. | §8.2, §9.3, §11.3 |
| Verification stays out of the worker's reach: gates in deterministic code, required checks, a separate reviewer and a human merge. About half of agent PRs that pass tests are still unmergeable, and self-grading skews positive. | §5.2, §11.7 |
| Start on a strong model at low effort, escalate only on failure, use a small model for side tasks, cache from day one, and split models only where evals show savings. | §12 |
| Dollar caps live at the provider, backed by run budgets in code and low turn limits; each role gets its own capped key. No harness enforces dollars reliably. | §11.5, §12 |
| Only a quarantined research role touches the open web. Everyone else gets pinned, first-party sources and one pinned search backend. | §10, §10.1, §11.2 |
| The security boundary is the OS, the network and identity: the Rule of Two per stage, sandboxed workers, default-deny egress, short-lived injected credentials and human approval at a short fixed list. Adaptive attacks beat detectors, and every framework surveyed converges on structural controls. | §11.1–§11.4 |
| Pin every version, upgrade on a schedule behind evals, and keep the durable assets as files in the repo. | §3, §11.6, §14, §17 |
| Jev is one decision signal, and the factory must work without it. | §9.5 |
| Self-written skills are a persistence vector: every write is reviewed. | §9.1 |
| Secrets live in one sops + age file with a recovery key; machine keys are never copied. | §11.5 ([docs/secrets.md](../secrets.md)) |
| CodeRabbit is an advisory second-vendor reviewer, review-only, never a merge authority or a required check, and its config is a protected path. | §8.2, §9.6 |
