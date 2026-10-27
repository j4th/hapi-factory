# Runbook: GitHub Apps and rulesets

hapi uses two GitHub Apps (spec §11.5). Their tokens last one hour, are minted outside the agents, and each covers one repo (spec §4.4):

- **`hapi-planner`** is for Hermes. It pushes `plan/*` branches, opens planning PRs and labels them.
- **`hapi-factory`** is for the host harvester. It pushes `factory/*` branches, opens delivery PRs and labels them.

**Neither App gets administration, a ruleset bypass or merge rights** (spec §11.5: "Neither can merge"; §4.3). Their permissions can't express "no merge": Contents write plus Pull requests write is enough to call GitHub's merge API. So a ruleset enforces it. `main-review` **restricts updates** to `main`: only its bypass actor, the Admin role (you), through a PR, may update `main`, and a merge is an update. An App can't merge even after you approve its PR and `ci` is green. [Check it](#check-it) proves this with a test PR before you rely on it.

Creating Apps and changing repo settings are outward-facing steps, so agents never do them. the operator does them by hand.

This page covers:
- [before you start](#before-you-start);
- [the two Apps](#the-two-apps) and [creating them](#creating-each-app);
- [the rulesets](#the-rulesets): the two on `main`, [code owners](#code-owners-a-second-layer), and [branch and tag scope](#branch-and-tag-scope);
- [checking it all](#check-it), including that an App's merge call is refused;
- [the kill switch](#kill-switch-suspend-an-installation) and [rotating a private key](#rotating-a-private-key).

## Before you start

- **Rulesets need a public repo on GitHub's free plan.** On a private repo they need a paid plan. Make `<your-github-login>/hapi-factory` public first (README, Plan 01 Task 1 step 2), then apply the rulesets.
- **Never install either App on a repo whose rulesets aren't enforced,** such as a private repo on the free plan. With `contents: write` and no rules, an App could push straight to `main`.
- You need the `gh` CLI (`mise install` provides it), logged in as the repo admin.
- The commands on this page use `$OWNER` for the repo's owner. Set it once in the shell you run them in:

  ```bash
  OWNER=<your-github-login>
  ```

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
| Private key | In your secrets store, as `hapi-host-planner-app-private-key` | In your secrets store, as `hapi-host-factory-app-private-key` |
| App ID | In your secrets store, as `hapi-host-planner-app-id` | In your secrets store, as `hapi-host-factory-app-id` |

`hapi token mint` asks for exactly these permissions (`APPS` in `src/forge/github/app-token.ts`), and rejects a token that comes back broader ([docs/secrets.md](../secrets.md#hapi-token-mint)).

Both private keys live only in your secrets store and in the `host` zone's env file, which no container ever gets ([docs/secrets.md](../secrets.md#the-zones-and-their-keys)).

## Creating each App

Do this twice: once for `hapi-planner`, once for `hapi-factory`.

1. Open **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **GitHub App name:** `hapi-planner` (or `hapi-factory`). App names are global on GitHub. If the name is taken, add a suffix; hapi finds the App by its App ID, not its name.
3. **Homepage URL:** `https://github.com/<your-github-login>/hapi-factory`.
4. **Identifying and authorizing users:** leave the callback URL empty. Leave **Request user authorization (OAuth) during installation** and **Enable Device Flow** off. The Apps act only as themselves.
5. **Webhook:** untick **Active**. hapi has no inbound endpoint; the poller polls (spec §9.4).
6. **Permissions:** exactly as [the table above](#the-two-apps). Subscribe to no events.
7. **Where can this GitHub App be installed?** **Only on this account.**
8. **Create GitHub App.** Note the **App ID** on the App's General page.
9. **Private keys → Generate a private key.** Your browser downloads a `.pem` file.
10. **Add both to your secrets store** with `mise run secrets:edit` ([docs/secrets.md](../secrets.md#adding-a-secret)): the PEM file's whole contents as `hapi-host-planner-app-private-key` (or `hapi-host-factory-...`), as a YAML block scalar (`hapi-host-planner-app-private-key: |`, then the PEM's lines indented), and the App ID as `hapi-host-planner-app-id`. `stack/secrets.yaml` already puts both in the `host` zone.
11. **Delete the downloaded key file:** `shred -u ~/Downloads/<app-name>.*.private-key.pem`. Never commit a key, and never paste one into a chat.
12. **Install App → your account → Only select repositories.** Pick only the hapi-managed repos (`$OWNER/hapi-factory` now; `odoo-mcp` later). Never **All repositories**.

## The rulesets

Rulesets are where the "no merge" rule lives. Neither App is a bypass actor in any of them. `hapi audit --repo $OWNER/hapi-factory` checks the live rulesets and both Apps against this page (`github.rulesets`, `github.app-perms`, [docs/audit.md](../audit.md#githubrulesets)), and `tests/docs/rulesets.test.ts` holds the JSON on this page and in the README to the same rules. GitHub shows a ruleset's bypass actors only to a token with write access to it, so the audit's bypass checks use your own token (`--github-token-file`), never an App's: the Apps never get Administration.

### The two rulesets on `main` (Plan 01 Task 1)

The exact commands are in the README, under [Manual setup steps, Plan 01 Task 1](../../README.md#plan-01-task-1-the-github-remote-and-the-main-rulesets). In short:

| Ruleset | Rules | Bypass actors |
|---|---|---|
| `main-protect` | Required status check `ci` (from GitHub Actions only); no force-push; no deletion | **None.** Nobody, you included, merges with `ci` red or missing. |
| `main-review` | Pull request with 1 approving review, from a code owner; **Restrict updates** | The repository Admin role, PR-only. That lets you merge PRs, your own `lane:direct` ones included, since GitHub doesn't let a PR's author approve it. |

They are two rulesets because a ruleset's bypass list covers every rule in it. With `ci` in `main-review`, the Admin bypass would also let a merge through with `ci` red.

**Restrict updates (`{ "type": "update" }`) is what stops an App merging.** GitHub lets only a ruleset's bypass actors push to a ref it restricts, and merging a PR pushes to `main`. An actor with a PR-only bypass can't push directly, but "can choose to bypass any branch protections and merge that pull request" (GitHub's ruleset docs). So:
- **you** merge every PR into `main`, through the Admin bypass, whether or not it has an approval. `main-protect` still applies, because a bypass in one ruleset doesn't carry over to another: you can't merge while `ci` is red or missing;
- **neither App** can merge into, push to or otherwise update `main`, even after your approval and with `ci` green. [Check it](#check-it) step 4 tries the merge API with an App token;
- Restrict updates sits in `main-review`, **never in `main-protect`**. `main-protect` has no bypass actors, so there it would stop every merge, yours included.

If you created `main-review` from an older version of the README, without these two settings, add them: in the UI under **Settings → Rules → Rulesets → main-review** (tick **Restrict updates**, and **Require review from Code Owners** under the pull-request rule), or with `gh`, which reads the ruleset, changes it and writes it back:

```bash
id=$(gh api "repos/$OWNER/hapi-factory/rulesets" --jq '.[] | select(.name == "main-review") | .id')
gh api "repos/$OWNER/hapi-factory/rulesets/$id" \
  --jq '{name, target, enforcement, conditions, bypass_actors,
         rules: ([.rules[] | if .type == "pull_request" then .parameters.require_code_owner_review = true else . end]
                 + (if any(.rules[]; .type == "update") then [] else [{type: "update"}] end))}' \
  | gh api -X PUT "repos/$OWNER/hapi-factory/rulesets/$id" --input -
```

### Code owners: a second layer

`main-review`'s review rule needs one approving review, and GitHub counts an approval from anyone with write access to the repo. An App installation with Pull requests write can submit an approving review; the common Dependabot auto-approve workflow depends on a bot's approval counting. So `hapi-planner` could approve a `hapi-factory` PR. Restrict updates already keeps either App from merging it, but an App's approval still shouldn't count, in case Restrict updates is ever lost.

So `main-review` requires a **code owner's** review, and you are the only code owner. No App is a code owner, so no App's approval counts. **Before you install either App**, add `.github/CODEOWNERS` in a PR of your own (`.github/**` is a protected path):

```text
* @<your-github-login>
```

Your own `lane:direct` PRs still merge through the Admin PR-only bypass.

### Branch and tag scope

Two more rulesets keep the Apps on their own branches and off tags:

- **`agent-branch-scope`** covers every branch except `main`, `plan/**` and `factory/**`. Only the Admin role (you) may create, push or delete those branches. The Apps aren't bypass actors, so they can push only `plan/**` and `factory/**`.
- **`tags-admin-only`**: only the Admin role may create, move or delete tags. Contents write would otherwise let an App create a tag or a release, which can trigger release workflows.

```bash
gh api -X POST "repos/$OWNER/hapi-factory/rulesets" --input - <<'EOF'
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

gh api -X POST "repos/$OWNER/hapi-factory/rulesets" --input - <<'EOF'
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
- a `hapi-planner` token is inside the Hermes container, so Hermes could push a `factory/**` branch. Only you can merge that PR, with `ci` green, and Plan 05's CI checks lane labels and commit trailers.

## Check it

Run these with `$OWNER` set ([before you start](#before-you-start)).

1. **Rulesets:** `gh api "repos/$OWNER/hapi-factory/rulesets"` lists the four rulesets. No `bypass_actors` entry has `"actor_type": "Integration"`, and `main-protect` has none at all.
2. **Branch rules:** `gh api "repos/$OWNER/hapi-factory/rules/branches/main"` shows `update` (from `main-review`) as well as the `ci` check. `gh api "repos/$OWNER/hapi-factory/rules/branches/some-feature"` shows `creation`, `update` and `deletion`. `gh api "repos/$OWNER/hapi-factory/rules/branches/plan%2Fexample"` shows none of them.
3. **A token** ([docs/secrets.md](../secrets.md#hapi-token-mint)), once `hapi secrets resolve` has run:

   ```bash
   hapi token mint --app planner --repo "$OWNER/hapi-factory"      # prints the token file's path
   tok="$XDG_RUNTIME_DIR/hapi/tokens/planner.$OWNER.hapi-factory.token"
   GH_TOKEN="$(cat "$tok")" gh api /installation/repositories --jq '.repositories[].full_name'
   ```

   It prints only `$OWNER/hapi-factory`. Keep the token for the next step.

4. **An App can't merge, even after your approval** (spec §11.5). With the same `hapi-planner` token, open a test PR as the App:

   ```bash
   main=$(GH_TOKEN="$(cat "$tok")" gh api "repos/$OWNER/hapi-factory/git/ref/heads/main" --jq .object.sha)
   GH_TOKEN="$(cat "$tok")" gh api "repos/$OWNER/hapi-factory/git/refs" -f ref=refs/heads/plan/ruleset-check -f sha="$main"
   GH_TOKEN="$(cat "$tok")" gh api -X PUT "repos/$OWNER/hapi-factory/contents/ruleset-check.md" \
     -f message="test: ruleset check" -f branch=plan/ruleset-check -f content="$(printf 'Delete me.\n' | base64)"
   pr=$(GH_TOKEN="$(cat "$tok")" gh api "repos/$OWNER/hapi-factory/pulls" \
     -f title="test: ruleset check" -f head=plan/ruleset-check -f base=main -f body="Delete me." --jq .number)
   ```

   Wait for `ci` to go green on it, and **approve it yourself** in the web UI. Then try to merge it as the App:

   ```bash
   GH_TOKEN="$(cat "$tok")" gh api -X PUT "repos/$OWNER/hapi-factory/pulls/$pr/merge"
   ```

   **Expected: GitHub refuses it** with a repository rule violation, and the PR stays open. Then close the PR without merging, delete the `plan/ruleset-check` branch, and revoke the test token:

   ```bash
   GH_TOKEN="$(cat "$tok")" gh api -X DELETE /installation/token
   rm "$tok"
   ```

   **If the merge goes through, the "Neither can merge" rule doesn't hold.** Stop. Revert the merge in a PR of your own, and suspend both installations ([kill switch](#kill-switch-suspend-an-installation)). Check that `main-review` lists `update` and that the App isn't a bypass actor. Don't unsuspend until the merge call is refused. If no ruleset setting refuses it, record "an App can merge once you have approved and `ci` is green" as a residual risk in the threat model (`docs/security/threat-model.md`, Plan 01 Task 7, spec §11.9), and remove the "no merge rights" claims from this page and the README.

## Kill switch: suspend an installation

Kill switch 2 (spec §11.8). Open **GitHub → Settings → Applications → Installed GitHub Apps → the App → Configure → Suspend**. GitHub then refuses the App's tokens, and `hapi token mint` fails with "the App's installation ... is suspended". Unsuspend it on the same page.

## Rotating a private key

1. On the App's settings page, **Generate a private key**. The old key still works until you delete it.
2. Replace the PEM under `hapi-host-<app>-app-private-key` in your secrets store (`mise run secrets:edit`). Then shred the downloaded file.
3. Run `hapi secrets resolve`, then mint a test token as in [check it](#check-it).
4. **Delete the old key** on the App's settings page.

If a key may have leaked, suspend the installation first, then rotate.
