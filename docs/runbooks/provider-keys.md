# Runbook: provider keys and spend caps

Every model and search key hapi uses, where to get it, the cap to set on it, and where it goes. **Hard caps live at the provider** (spec §12). Archon's budgets and hapi-guard are only the in-run caps. The numbers come from `policy/budgets.yaml` and the Global Constraints of Plan 01. The ceiling is the $200/month Anthropic credit.

These are outward-facing steps, so the operator does them by hand. First set up your secrets store once (`mise run secrets:init`, then store its 10 recovery words: [getting started](../secrets.md#getting-started-with-sops--age)); each machine or user that needs the store gets its own key, never a copy ([keys and recovery](../secrets.md#keys-and-recovery)). Then, for each key:
1. Create it as below, with its cap.
2. Add it to your secrets store (`mise run secrets:edit`) as the logical name given here ([docs/secrets.md](../secrets.md#adding-a-secret)).
3. Never paste a key into a chat, an issue or a file in the repo.

When every key is stored, run `mise run secrets:check` ([docs/secrets.md](../secrets.md#hapi-secrets-check)). Every key should say `found`.

| Key | Cap | Zone / env var | Logical name |
|---|---|---|---|
| Anthropic, workspace `hapi-hermes` | $60/month | `hermes` / `ANTHROPIC_API_KEY` | `hapi-hermes-anthropic-api-key` |
| Anthropic, workspace `hapi-factory` | $100/month | `archon` / `ANTHROPIC_API_KEY` and `CLAUDE_API_KEY` | `hapi-archon-anthropic-api-key` |
| Anthropic, workspace `hapi-evals` | $40/month | Not in the manifest yet: the evals plan adds it | |
| OpenCode Go | The plan's monthly limits, Extra Usage off | `archon` / `OPENCODE_API_KEY` | `hapi-archon-opencode-api-key` |
| OpenRouter `hapi-jev` | $0.06/day, reset daily (at most $1.86 a month, under the $2 cap); ZDR enforced unless the documented Jev exception applies ([below](#hapi-jev-2month)) | `archon` / `HAPI_JEV_OPENROUTER_API_KEY` | `hapi-archon-jev-openrouter-api-key` |
| OpenRouter `hapi-portable` | $0.64/day, reset daily (at most $19.84 a month, under the $20 cap); ZDR enforced | Not needed in v1 ([below](#hapi-portable-20month-not-needed-in-v1)) | |
| Brave Search | A spend cap, if your plan has one | `research` / `BRAVE_SEARCH_API_KEY` | `hapi-research-brave-search-api-key` |
| Exa | A spend cap, if offered | `research` / `EXA_API_KEY` | `hapi-research-exa-api-key` |
| Context7 | A spend cap, if your plan has one | `research` / `HAPI_MCP_CONTEXT7_API_KEY` | `hapi-mcp-context7-api-key` |

## Anthropic Console workspaces

API keys only. **Never subscription OAuth** in Hermes, Pi or Archon (Global Constraints): it bills as extra usage, or worse.

1. In the Anthropic Console, under **Settings → Workspaces**, create three workspaces: **`hapi-hermes`**, **`hapi-factory`** and **`hapi-evals`**.
2. Give each a **monthly spend limit** in its limits settings:

   | Workspace | Limit | Used by |
   |---|---|---|
   | `hapi-hermes` | **$60** | The Hermes container |
   | `hapi-factory` | **$100** | The Archon container: Pi and Archon's `claude` nodes |
   | `hapi-evals` | **$40** | Evals (a later plan) |

   That is $200, the monthly credit.
3. **Leave the default workspace unused.** Its spend can't be capped (spec §11.5), so create no key in it.
4. Create **one API key in each workspace**, named after it:
   - the `hapi-hermes` key → `hapi-hermes-anthropic-api-key`;
   - the `hapi-factory` key → `hapi-archon-anthropic-api-key`. The manifest gives this one secret to both `ANTHROPIC_API_KEY` (Pi reads it) and `CLAUDE_API_KEY` (Archon's `claude` nodes read it).
   - Create the `hapi-evals` key when evals arrive.

When a workspace hits its limit, Anthropic answers 429 `enforced_spend_limit_reached`. hapi treats that as terminal and never retries it (spec §12).

## OpenCode Go

OpenCode Go serves the `portable` roster (spec §12; `policy/rosters/portable.yaml`). Pi and Hermes are its validated clients.

1. Subscribe to **Go** ($10/month) at opencode.ai, in a workspace for hapi only. OpenCode Go workspaces are single-member.
2. In its settings:
   - **keep training endpoints blocked.** That is the default; the Muse Spark contributor models train on your data.
   - **keep the allowed regions to the EU and the US** (the default).
   - **turn Extra Usage off**, so the plan's monthly limit is a hard cap.
3. **Use only zero-retention models.** The `portable` roster lists GLM-5.3 Flash, GLM-5.3 and Kimi K3.1 Pro: 0-day retention and no training, checked against https://opencode.ai/docs/go/ on 2026-10-26. Don't add the GPT, Grok or Claude Haiku endpoints (30-day retention), or DeepSeek (its zero-retention agreement is renewed monthly).
4. Create an **API key** → `hapi-archon-opencode-api-key`.

The plan's 5-hour (20%) and weekly (50%) allowances can run out. Then fall back to the `budget` roster (`mise run policy:build -- --roster budget`).

## OpenRouter

Spec §11.5 sets two rules for every OpenRouter key:
- **One key per role, with a daily `limit`.** The monthly caps (spec §3, `policy/budgets.yaml`) become a per-key credit limit that **resets daily**: the monthly cap divided by 31, rounded down to the cent. A leaked key can then spend one day's share, not the whole month's at once. OpenRouter resets daily limits at midnight UTC, and refuses a key's requests once it is over its limit, until the reset.
- **Zero data retention (ZDR) is enforced** for every non-Anthropic model. Enforce it **per key, with a guardrail**, not with the account-wide ZDR switch: a guardrail applies to the keys it's assigned to, so an exception for one key (Jev, below) never weakens another. Leave the account-wide switch off, and give every hapi key its own guardrail when you create it. With ZDR enforced, OpenRouter routes a request only to endpoints with a zero-retention policy, and fails it if there are none.

### `hapi-jev` ($2/month)

The Jev decision model (spec §9.5) is reached through OpenRouter, on its own key with a tiny cap. The key sits in the Archon zone, where Pi can read it, so the cap bounds what a leak costs.

1. In OpenRouter's **Settings → API Keys**, create a key named **`hapi-jev`**.
2. Set its **credit limit to $0.06**, resetting **daily**. That is at most $1.86 in a 31-day month, under Jev's $2 cap. When a day's limit runs out, `decide()` falls back as on any Jev error: a Haiku 5.5 classifier, then the decision file's default (spec §9.5).
3. In OpenRouter's **Guardrails** settings, create a guardrail named **`hapi-jev`** and assign it to the `hapi-jev` key:
   - **allowed models:** only the Jev models (`typesafe/jev-*`) that hapi's decision files use, so a leaked key can't call any other model;
   - **enforce zero data retention** for every provider group (Anthropic, OpenAI, Google, xAI and other);
   - **no training on your data:** don't allow paid endpoints that train on prompts.
4. **Check that Jev has a ZDR endpoint.** Open the Jev model's page on OpenRouter and check its providers' data policies: does any endpoint have zero data retention? (OpenRouter's ZDR preview, `GET /api/v1/endpoints/zdr`, lists every endpoint left under ZDR, but it needs a management key; if you use it, don't put the key on a command line.)
   - **If a Jev endpoint is zero-retention,** you're done: with ZDR enforced, Jev calls go only there.
   - **If none is,** ZDR fails every Jev call. Then Jev is a **documented exception** to the ZDR rule: turn off ZDR enforcement in the `hapi-jev` guardrail only, keep its model allowlist and the daily limit, and record the exception in the threat model (`docs/security/threat-model.md`, Plan 01 Task 7). The exception rests on spec §9.5's data boundary: Jev sees decision state (comment text, diff summaries, file contents for the scout pass, failure logs), and in v1 it runs **on public repos only**, whose content is public anyway.
5. Add the key to your secrets store → `hapi-archon-jev-openrouter-api-key`. The manifest puts it in `HAPI_JEV_OPENROUTER_API_KEY`, not `OPENROUTER_API_KEY`, so Pi never uses it for model calls ([docs/secrets.md](../secrets.md#the-zones-and-their-keys)).

Either way, Jev's retention terms (TypeSafe's and OpenRouter's) must be verified before Jev is enabled on a private repo (spec §9.5).

### `hapi-portable` ($20/month): not needed in v1

`policy/budgets.yaml` keeps `openrouter_monthly_usd: 20` for an OpenRouter-backed roster. In v1 the `portable` roster runs on OpenCode Go instead, so this key isn't in the manifest. If a roster ever uses `openrouter/` models:
1. create a key named **`hapi-portable`** with a **$0.64** credit limit, resetting **daily** (at most $19.84 in a 31-day month, under the $20 cap);
2. create a guardrail named **`hapi-portable`** that enforces zero data retention for every provider group, allows only the roster's models, and doesn't allow training on prompts, and assign it to the key (spec §11.5: ZDR for every non-Anthropic model). No exception applies to this key;
3. add `OPENROUTER_API_KEY` to the `archon` zone of `stack/secrets.yaml` (a PR), with a logical name such as `hapi-archon-openrouter-api-key`, and add that name to your store.

## Search keys: Brave, Exa, Context7

All three go to the research zone only (spec §10.1): **spend-capped, search-only** keys, with no repo or forge access. Use an account that is for hapi only, not a personal one, and give each key only search and read scopes where the vendor offers scopes.

- **Brave Search API** (Hermes's search backend). In the Brave Search API dashboard, subscribe to a search plan, create an API key, and set a monthly spending limit if your plan offers one. → `hapi-research-brave-search-api-key`.
- **Exa** (Hermes's contents, or extract, backend). In the Exa dashboard, create an API key. Exa is pay-as-you-go with monthly free credits. Set a usage limit if the dashboard offers one; otherwise check the usage page after the first runs. → `hapi-research-exa-api-key`.
- **Context7** (the `context7` MCP server in `policy/mcp.yaml`). In the Context7 dashboard, create an API key, with a spend cap if your plan has one. The server always runs with a key, because anonymous callers can be sent a setup elicitation. → `hapi-mcp-context7-api-key`. That logical name is fixed by `policy/mcp.yaml` (`secret:hapi-mcp-context7-api-key`), and its env var is `HAPI_MCP_CONTEXT7_API_KEY`.

## Kill switch: zero or revoke the keys

Kill switch 1, the fastest (spec §11.8): set a workspace's spend limit to $0, or revoke its key, in the Anthropic Console. Revoke the OpenCode Go, OpenRouter and search keys in their dashboards. Then rotate ([docs/secrets.md](../secrets.md#rotating-a-secret)).
