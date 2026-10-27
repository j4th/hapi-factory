# Runbook: GitHub Apps and rulesets

hapi uses two GitHub Apps (spec §11.5). Their tokens last one hour, are minted outside the agents, and each covers one repo (spec §4.4):

- **`hapi-planner`** is for Hermes. It pushes `plan/*` branches, opens planning PRs and labels them.
- **`hapi-factory`** is for the host harvester. It pushes `factory/*` branches, opens delivery PRs and labels them.

**Neither App gets administration, a ruleset bypass or merge rights.** The rulesets below are what stop an App merging: a PR into `main` needs your approval and a green `ci`.

Creating Apps and changing repo settings are outward-facing steps, so agents never do them. the operator does them by hand.

This page covers:
- [before you start](#before-you-start);
- [the two Apps](#the-two-apps) and [creating them](#creating-each-app);
- [the rulesets](#the-rulesets): the two on `main`, [closing the App-approval gap](#close-the-app-approval-gap), and [branch and tag scope](#branch-and-tag-scope);
- [checking it all](#check-it);
- [the kill switch](#kill-switch-suspend-an-installation) and [rotating a private key](#rotating-a-private-key).

## Before you start

- **Rulesets need a public repo on GitHub's free plan.** On a private repo they need a paid plan. Make `j4th/hapi-factory` public first (README, Plan 01 Task 1 step 2), then apply the rulesets.
- **Never install either App on a repo whose rulesets aren't enforced,** such as a private repo on the free plan. With `contents: write` and no rules, an App could push straight to `main`.
- You need the `gh` CLI (`mise install` provides it), logged in as the repo admin.

## The two Apps

Set these permissions **exactly**. Everything not listed is **No access**, including every organization and account permission.

| Repository permission | `hapi-planner` | `hapi-factory` | Why |
|---|---|---|---|
| Contents | Read and write | Read and write | Push the App's own branches |
| Pull requests | Read and write | Read and write | Open PRs, and label them: GitHub accepts Pull requests write for labels on a PR |
| Issues | Read-only | No access | The planner reads issues for context. Neither App writes them. |
| Metadata | Read-only | Read-only | Mandatory for every App |
| Administration | **No access** | **No access** | Neither App may change settings or rulesets |
| Workflows | **No access** | **No access** | Without it, GitHub refuses any push that changes `.github/workflows/` |

| | `hapi-planner` | `hapi-factory` |
|---|---|---|
| Used by | Hermes. A host helper mints a 1-hour token per session, outside the container (spec §9.1, `hapi-gh-token`). | The harvester, a host script run by the `hapi` user (spec §9.4) |
| Branches | `plan/*` | `factory/*` |
| Private key | In bws, as `hapi-host-planner-app-private-key` | In bws, as `hapi-host-factory-app-private-key` |
| App ID | In bws, as `hapi-host-planner-app-id` | In bws, as `hapi-host-factory-app-id` |

`hapi token mint` asks for exactly these permissions (`APPS` in `src/forge/github/app-token.ts`), and rejects a token that comes back broader ([docs/secrets.md](../secrets.md#hapi-token-mint)).

Both private keys live only in Bitwarden and in the `host` zone's env file, which no container ever gets ([docs/secrets.md](../secrets.md#the-zones-and-their-keys)).

## Creating each App

Do this twice: once for `hapi-planner`, once for `hapi-factory`.

1. Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **GitHub App name:** `hapi-planner` (or `hapi-factory`). App names are global on GitHub. If the name is taken, add a suffix; hapi finds the App by its App ID, not its name.
3. **Homepage URL:** `https://github.com/j4th/hapi-factory`.
4. **Identifying and authorizing users:** leave the callback URL empty. Leave **Request user authorization (OAuth) during installation** and **Enable Device Flow** off. The Apps act only as themselves.
5. **Webhook:** untick **Active**. hapi has no inbound endpoint; the poller polls (spec §9.4).
6. **Permissions:** exactly as [the table above](#the-two-apps). Subscribe to no events.
7. **Where can this GitHub App be installed?** **Only on this account.**
8. **Create GitHub App.** Note the **App ID** on the App's General page.
9. **Private keys → Generate a private key.** Your browser downloads a `.pem` file.
10. **Store both in Bitwarden** ([docs/secrets.md](../secrets.md#filling-in-the-map-the operator)): the PEM file's whole contents as `hapi-host-planner-app-private-key` (or `hapi-host-factory-...`), and the App ID as `hapi-host-planner-app-id`. Put both ids in the `host` zone of `stack/secrets.map.yaml`.
11. **Delete the downloaded key file:** `shred -u ~/Downloads/<app-name>.*.private-key.pem`. Never commit a key, and never paste one into a chat.
12. **Install App → your account → Only select repositories.** Pick only the hapi-managed repos (`j4th/hapi-factory` now; `odoo-mcp` later). Never **All repositories**.

## The rulesets

Rulesets are where the "no merge" rule lives. Neither App is a bypass actor in any of them. Task 6's `hapi audit` checks this (`github.rulesets`, `github.app-perms`).

### The two rulesets on `main` (Plan 01 Task 1)

The exact commands are in the README, under [Manual setup steps, Plan 01 Task 1](../../README.md#plan-01-task-1-the-github-remote-and-the-main-rulesets). In short:

| Ruleset | Rules | Bypass actors |
|---|---|---|
| `main-protect` | Required status check `ci` (from GitHub Actions only); no force-push; no deletion | **None.** Nobody, you included, merges with `ci` red or missing. |
| `main-review` | Pull request with 1 approving review | The repository Admin role, PR-only. That lets you merge your own `lane:direct` PRs, since GitHub doesn't let a PR's author approve it. |

They are two rulesets because a ruleset's bypass list covers every rule in it. With `ci` in `main-review`, the Admin bypass would also let a merge through with `ci` red.

### Close the App-approval gap

**Do this before you install either App.** `main-review` asks for one approving review, and GitHub counts an approval from anyone with write access to the repo. An App installation with Pull requests write can submit an approving review; the common Dependabot auto-approve workflow depends on a bot's approval counting. So `hapi-planner` could approve a `hapi-factory` PR, and then either App (Contents write) could merge it as soon as `ci` is green.

To close it, require a **code owner's** review, and make yourself the only code owner. No App is a code owner, so no App's approval counts.

1. Add `.github/CODEOWNERS`, in a PR of your own (`.github/**` is a protected path):

   ```text
   * @j4th
   ```

2. Turn on **Require review from Code Owners** in `main-review`. In the UI: **Settings → Rules → Rulesets → main-review → Require a pull request before merging → Require review from Code Owners**. Or with `gh`, which reads the ruleset, changes that one field and writes it back:

   ```bash
   id=$(gh api repos/j4th/hapi-factory/rulesets --jq '.[] | select(.name == "main-review") | .id')
   gh api "repos/j4th/hapi-factory/rulesets/$id" \
     --jq '{name, target, enforcement, conditions, bypass_actors,
            rules: [.rules[] | if .type == "pull_request" then .parameters.require_code_owner_review = true else . end]}' \
     | gh api -X PUT "repos/j4th/hapi-factory/rulesets/$id" --input -
   ```

Your own `lane:direct` PRs still merge through the Admin PR-only bypass.

### Branch and tag scope

Two more rulesets keep the Apps on their own branches and off tags:

- **`agent-branch-scope`** covers every branch except `main`, `plan/**` and `factory/**`. Only the Admin role (you) may create, push or delete those branches. The Apps aren't bypass actors, so they can push only `plan/**` and `factory/**`.
- **`tags-admin-only`**: only the Admin role may create, move or delete tags. Contents write would otherwise let an App create a tag or a release, which can trigger release workflows.

```bash
gh api -X POST repos/j4th/hapi-factory/rulesets --input - <<'EOF'
{
  "name": "agent-branch-scope",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": {
    "include": ["~ALL"],
    "exclude": ["~DEFAULT_BRANCH", "refs/heads/plan/**", "refs/heads/factory/**"] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ]
}
EOF

gh api -X POST repos/j4th/hapi-factory/rulesets --input - <<'EOF'
{
  "name": "tags-admin-only",
  "target": "tag",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~ALL"], "exclude": [] } },
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "rules": [ { "type": "creation" }, { "type": "update" }, { "type": "deletion" } ]
}
EOF
```

`actor_id` 5 is the repository Admin role. These commands follow GitHub's REST docs, but nobody has run them yet. If GitHub rejects a field, set up the same rulesets in the UI. If you turn on Dependabot version updates, add `refs/heads/dependabot/**` to `agent-branch-scope`'s `exclude`, or Dependabot can't push its branches.

**What rulesets can't do: keep each App to its own prefix.** GitHub rulesets can only say "nobody but the bypass actors". "Only `hapi-planner` may push `plan/**`" would need `hapi-planner` as a bypass actor on a `plan/**` ruleset, and no App is ever a bypass actor. So either App can push either prefix. In practice:
- only the harvester's deterministic code holds `hapi-factory` tokens, and it pushes `factory/<id>` only;
- a `hapi-planner` token is inside the Hermes container, so Hermes could push a `factory/**` branch. That PR still needs your approval and a green `ci`, and Plan 05's CI checks lane labels and commit trailers.

## Check it

1. **Rulesets:** `gh api repos/j4th/hapi-factory/rulesets` lists the four rulesets. No `bypass_actors` entry has `"actor_type": "Integration"`, and `main-protect` has none at all.
2. **Branch rules:** `gh api repos/j4th/hapi-factory/rules/branches/some-feature` shows `creation`, `update` and `deletion`. `gh api repos/j4th/hapi-factory/rules/branches/plan%2Fexample` shows none of them.
3. **A token** ([docs/secrets.md](../secrets.md#hapi-token-mint)), once `hapi secrets resolve` has run:

   ```bash
   hapi token mint --app planner --repo j4th/hapi-factory      # prints the token file's path
   GH_TOKEN="$(cat "$XDG_RUNTIME_DIR/hapi/tokens/planner.j4th.hapi-factory.token")" \
     gh api /installation/repositories --jq '.repositories[].full_name'
   ```

   It prints only `j4th/hapi-factory`. Then revoke the test token:

   ```bash
   GH_TOKEN="$(cat "$XDG_RUNTIME_DIR/hapi/tokens/planner.j4th.hapi-factory.token")" gh api -X DELETE /installation/token
   rm "$XDG_RUNTIME_DIR/hapi/tokens/planner.j4th.hapi-factory.token"
   ```

4. **A test PR** from a `plan/` branch: it can't merge without your approval, and an approval from the other App doesn't count.

## Kill switch: suspend an installation

Kill switch 2 (spec §11.8). Open **GitHub → Settings → Applications → Installed GitHub Apps → the App → Configure → Suspend**. GitHub then refuses the App's tokens, and `hapi token mint` fails with "the App's installation ... is suspended". Unsuspend it on the same page.

## Rotating a private key

1. On the App's settings page, **Generate a private key**. The old key still works until you delete it.
2. Put the new PEM in the existing bws secret (`hapi-host-<app>-app-private-key`). Its id doesn't change, so the map doesn't either. Then shred the downloaded file.
3. Run `hapi secrets resolve`, then mint a test token as in [check it](#check-it).
4. **Delete the old key** on the App's settings page.

If a key may have leaked, suspend the installation first, then rotate.
