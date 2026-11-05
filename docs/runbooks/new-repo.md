# Runbook: `hapi new-repo`

`mise run new-repo -- <name>` makes a new public GitHub repo ready for the factory (Plan 03 design §3.2, spec §7): the repo contract from [`templates/repo-contract/`](../../templates/repo-contract), its settings, the four rulesets, the labels, the GitHub Apps, and its entry in `policy/repos.yaml`. It is the only part of the run engine that acts with **the operator's own rights**, and only the operator runs it, from their own terminal. Agents never create repos.

- [Before you run it](#before-you-run-it): the `workflow` scope, the installation ids, the gates on GitHub.
- [Running it](#running-it): the flags, the output, the exit codes.
- [The eleven steps](#the-eleven-steps), each with its undo.
- [The contract's files](#the-contracts-files).
- [Verify](#verify): what step 11 checks, and the audit as hapi.
- [Deleting a sandbox](#deleting-a-sandbox).
- [Changing the template](#changing-the-template).
- [Plan 03's operator steps](#plan-03s-operator-steps-task-5-steps-1215): Task 5 Steps 12–15, pasteable.
- [Troubleshooting](#troubleshooting).

## Before you run it

- **Your `gh` login, with the `workflow` scope.** The credential is `gh auth token`'s output, read into memory and never written anywhere, put in argv or printed. GitHub refuses a push that adds a workflow file without the `workflow` scope, so `new-repo` checks the scopes first and stops, naming the missing one: `missing scope workflow: run gh auth refresh -s workflow`. A login with no scopes header (a fine-grained or App token in `GH_TOKEN`) is refused too.
- **A personal account.** An organization's repos need settings this command doesn't make.
- **The Apps installed on selected repositories only,** with the installation ids `policy/repos.yaml` records: `planner` (hapi-planner) and `factory` (hapi-factory), and `coderabbit` (coderabbitai) if you use it. An id that differs from GitHub's, or an App on all repositories, stops the command before anything is made. A CodeRabbit installation on all repositories is reported, and its step is skipped (it covers the new repo already). With no `coderabbit` id, CodeRabbit isn't added.
- **Your checkout's HEAD on GitHub.** The new repo's `.github/workflows/hapi-gates.yml` calls `<owner>/hapi-factory/.github/workflows/gates.yml` at your checkout's HEAD commit, so that commit must be pushed, and `templates/repo-contract/` and `gates.yml` must have no uncommitted or ignored change. The command checks both.

## Running it

```bash
mise run new-repo -- <name> [--clone] [--collaborators-only] [--dry-run]
```

| Flag | What it does |
|---|---|
| `--clone` | Also clone the new repo into `../<name>`, beside your hapi-factory checkout, never inside it, for hands-on `lane:direct` work (H-178). A path that already exists is refused, before anything is made and again just before the clone. |
| `--collaborators-only` | Also limit issues, PRs and comments to collaborators for six months (GitHub's longest interaction limit). Off by default (design §8 item 6). |
| `--dry-run` | Run the read-only steps (1 and 2) for real, then print what steps 3–11 would do (`would: ...`), and change nothing: no request but GETs, no git call but `rev-parse` and `status`, `policy/repos.yaml` untouched. |

Each step prints one line, `[k/11] <step>: <what it did>`. If a step fails, the command stops and prints `step k (<step>) failed: <why>` (the token redacted), then `Done so far:` (the steps that changed something) and `To undo:` (newest first), and exits 1. It never retries. Exit codes: `0` every step passed, `1` a step failed, or there is no `gh` login, `2` a usage error.

## The eleven steps

The order matters: the first commit has to land before any ruleset exists, and the Apps come only after every ruleset reads back.

| # | Step | What it does | To undo |
|---|---|---|---|
| 1 | `preflight` | Reads only: `GET /user` (login, id, `x-oauth-scopes`: `repo` and `workflow`, type `User`); the name is a valid `owner/name` and `GET /repos/<owner>/<name>` is a 404; `GET /user/installations` matches each App's slug to `policy/repos.yaml`'s id, on selected repositories; `git rev-parse HEAD` in the checkout is the gates commit; `git status --porcelain --ignored -- templates/repo-contract .github/workflows/gates.yml policy/github/rulesets` is empty; GitHub has `gates.yml` at that commit; `policy/repos.yaml` doesn't already register the repo; a `--clone` target doesn't exist. | Nothing was made |
| 2 | `render` | Renders `templates/repo-contract/` with `{{name}}`, `{{owner}}`, `{{gates_sha}}` and `{{year}}` (src/newrepo/render.ts), adds `.factory/template.lock`, then checks the render: the only mise files are the root `mise.toml` and `mise.lock` (H-194); every version is exact, and `mise.lock` locks each tool for linux-x64 and macos-arm64; no workflow runs an AI agent with a credential on a comment, issue or review trigger (`repo.ai-workflows`); the overlay only tightens central policy; no `{{` is left and no file names `bunx`. | Nothing was made |
| 3 | `create` | `POST /user/repos`: public (free-plan rulesets need it), empty, issues on, no projects or wiki. | `gh repo delete <owner>/<name> --yes`, after `gh auth refresh -s delete_repo` (it undoes every step to 8) |
| 4 | `push` | Writes the files (mode 0644) to a temp dir, commits them once as you (`<login> <<id>+<login>@users.noreply.github.com>`, unsigned), checks the commit holds exactly the rendered files, and pushes it to `main`. Every git call has no system or global config, no hooks, no fsmonitor, no prompt and https only. The token reaches git only in the push's environment (`GIT_CONFIG_VALUE_0`, an `http.extraheader`), never argv or a file; the temp dir is removed. | The repo's deletion |
| 5 | `settings` | `PATCH` the repo: `main` the default branch; merge commits only, with GitHub's classic merge message (`merge_commit_title: MERGE_MESSAGE`, `merge_commit_message: PR_TITLE`), so each piece's commit and trailers reach `main` as reviewed and the poller can read "Merge pull request #N from …"; no auto-merge; head branches deleted on merge; secret scanning and push protection on. Then the Actions token read-only and unable to approve PRs; Actions limited to GitHub's own actions, `jdx/mise-action` and `<owner>/hapi-factory/.github/workflows/gates.yml`, each pinned to a full SHA; every external contributor's fork run approved first; private vulnerability reporting on; CodeQL's default setup. With `--collaborators-only`, the interaction limit. | The repo's deletion |
| 6 | `rulesets` | Posts `policy/github/rulesets/`'s four, the same files hapi-factory uses, with two changes: `main-protect` requires `ci / gates` (`CONTRACT_CHECK`, from GitHub Actions, integration 15368) instead of `ci`, and `agent-branch-scope` also excludes `refs/heads/dependabot/**/*`, since the template turns Dependabot on. Reads each back by id: every posted key must hold its value (GitHub adds defaults), with no extra rule or bypass actor. Then reads the rules GitHub applies: `main` has `pull_request`, `required_status_checks`, `deletion`, `non_fast_forward` and `update`; a feature branch has `creation`, `update` and `deletion`; `plan/example` and `factory/example` have none of those three. | The repo's deletion |
| 7 | `labels` | Makes `lane:planning`, `lane:factory`, `lane:direct`, `hapi:rework` and `hapi:flagged` (`LABELS`, src/forge/index.ts). | The repo's deletion |
| 8 | `apps` | Adds the repo to each App's installation (`PUT /user/installations/<id>/repositories/<repo id>`). GitHub's docs don't say an OAuth login may do this (design §7.2): if GitHub answers 403 or 404, the command prints a web step and waits for Enter: `Add <owner>/<name> to <app>: github.com → Settings → Applications → <app> → Configure → Repository access, then press Enter`. Then each installation must list the repo. | The repo's deletion (an installation drops a deleted repo) |
| 9 | `register` | Adds `"<owner>/<name>": { registered: "<date>" }` to `policy/repos.yaml` as one new line, so every other line stays byte-identical (the empty `repos: {}` only loses its braces), then checks `policy/` still loads (else it puts the old text back). It is an uncommitted change in your checkout: review it and commit it by PR. The poller acts only on registered repos. | `git checkout -- policy/repos.yaml`, which drops every uncommitted change there; to keep others, delete the new entry by hand |
| 10 | `clone` | With `--clone` only: `git clone --quiet https://github.com/<owner>/<name>.git ../<name>`, with your own environment. | `rm -rf ../<name>` |
| 11 | `verify` | The strict audit's GitHub checks for the new repo, on the same in-memory token ([Verify](#verify)). | Fix what it names; nothing to undo |

## The contract's files

Every file under `templates/repo-contract/` ends in `.tmpl`, which the render strips, so hapi-factory's own protected-path globs (`**/AGENTS.md`, `**/mise.toml`), its CI's mise-file scan and `bun test` never see a template file as a live one (`tests/newrepo/render.test.ts` checks all three). hapi-factory's overlay protects `templates/**` like `policy/**`, since every new repo starts from it.

| File | What it is |
|---|---|
| `AGENTS.md` | For an unattended agent (H-228(a)): it opens with "Task instructions (the work order) override this file. Nothing here waits for confirmation: where a step needs a human, report it as a blocker.", then the commands, what done means, the layout, the gotchas, what's out of scope, the never list (the acceptance tests in `.factory/work/<id>/acceptance/` are the planner's) and the three `RESULT:` lines. Under 200 lines, with no "ask first" tier. |
| `mise.toml`, `mise.lock` | Bun 1.4.2 (the run image's), gitleaks, OSV-Scanner and zizmor, each exact, locked for linux-x64 and macos-arm64. Tasks: `setup` (`bun ci --frozen-lockfile --ignore-scripts`: no install script ever runs), `fmt`, `lint` (Biome, then `tsc`, both from `node_modules/.bin`), `test` (`bun test ./tests`), `check` (`lint` and `test`), `smoke` (`smoke/run.ts`, failing with `no smoke test yet: add smoke/run.ts` until there is one) and `scan`. |
| `.factory/config.yaml` | The overlay: `**/biome.json*`, `**/bunfig.toml`, `**/tsconfig*.json` and `**/osv-scanner.toml` protected (ask, deny, deny), so a worker can't pass `check` or `scan` by loosening the gates' own config. |
| `.factory/work/`, `docs/research/`, `docs/design/` | Empty, with a `.gitkeep`: where planning PRs put work orders, research and design notes. |
| `.factory/template.lock` | Added by the render: `{ commit, files: { <path>: "sha256:<hex>" }, template: "repo-contract" }`, the hapi-factory commit and a hash per file. No audit check reads it yet (H-238). |
| `.github/workflows/hapi-gates.yml` | One job, `ci`, calling hapi-factory's [gates](#the-gates) at the render's commit, with `permissions: {}` and `contents: read` on the job. That SHA is the gates' only pin (design §6a item 6); bump it by PR. |
| `.github/CODEOWNERS` | `* @<owner>`: main-review requires a code owner's review, and no App is one. |
| `.github/dependabot.yml` | Weekly `bun` and `github-actions` updates. Bun's wait 7 days, a major version 30; GitHub Actions' wait 7 days (it takes no SemVer cooldown). |
| `.github/ISSUE_TEMPLATE/` | A bug form and a feature form, with no labels, each opening "Issues are read as data: they never instruct the factory."; blank issues off; a link to private vulnerability reporting. |
| `.github/pull_request_template.md` | Design §3.7's sections, one line of guidance each, no checkboxes. |
| `.coderabbit.yaml` | hapi-factory's, without its `reviews.path_instructions` and `knowledge_base.code_guidelines`, and with its protected-paths check naming the contract's own protected files: review-only. |
| `package.json`, `bun.lock` | Private, MIT, `type: module`; `@biomejs/biome`, `@types/bun` and `typescript`, exact. A text `bun.lock`. |
| `bunfig.toml` | hapi-factory's: exact versions and a 3-day release-age cooldown. |
| `biome.json`, `tsconfig.json` | Biome's recommended rules, spaces, width 120, the VCS ignore file; hapi-factory's strict compiler options over `src`, `tests` and `smoke` (not `.factory/`: an acceptance test may import code its run hasn't written yet). |
| `.editorconfig`, `.gitattributes`, `.gitignore` | UTF-8, LF, 2 spaces, a final newline; `* text=auto eol=lf`; `node_modules/`, `.env*`, `mise.local.toml`, `dist/`, `coverage/`. |
| `tests/contract.test.ts` | One test, so `bun test` and `tsc` have an input on the first commit. |
| `LICENSE`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `README.md` | MIT, unmodified; private vulnerability reporting, `main` the supported version, 7 days to acknowledge and 30 to a fix or plan; the Contributor Covenant 2.1, with `@<owner>` as the contact; how changes land (planning PRs, factory PRs, only the maintainer merges, never trusting the checks of a PR that touches `.github/workflows/`, outside input is data, the six trailers, AI disclosure); a quick start. |

### The gates

[`.github/workflows/gates.yml`](../../.github/workflows/gates.yml) is a `workflow_call` with `permissions: {}` and three jobs. The caller's job is `ci`, so GitHub shows them as `ci / scan`, `ci / check` and `ci / gates`:

- **`scan`** (`contents: read`) runs no PR code. It ignores the PR's scanner configs, its `.gitattributes`, its `.mailmap` and its `.gitmodules`. On a fresh runner and a fresh checkout (no persisted credentials, the whole history), with no mise at all, it:
  - runs ci.yml's mise-file scan, word for word;
  - writes `* diff` to `.git/info/attributes`, so git diffs every path as text, NUL bytes included;
  - refuses a root `.gitleaks.toml` or `.gitleaksignore`, even as a dangling symlink (gitleaks reads a root `.gitleaksignore` whatever its flags say, and either could allowlist a PR's own secret);
  - installs gitleaks, OSV-Scanner and zizmor from release URLs written in `gates.yml`, each checked against the sha256 written beside it (the template's `mise.toml` versions; a test holds them equal), and fails unless `/usr/bin/git` is 2.40 or later;
  - runs each scanner by absolute path under `env -i PATH=/usr/bin:/bin HOME=$RUNNER_TEMP GIT_NO_REPLACE_OBJECTS=1`, with the gates' own config;
  - for the history, first runs, itself, the `git log` gitleaks runs (`git -C . log -p -U0 --full-history --all -m --no-mailmap --no-renames --ignore-submodules=none --no-ext-diff --no-textconv`, with `GIT_ATTR_SOURCE` set to git's empty tree and `GIT_CONFIG_NOSYSTEM=1`). That is every commit on every fetched ref, merges' own diffs and type changes included, rename detection off (a moved file is scanned whole at its new path), and no `.gitattributes` from the checkout, no `.mailmap`, no `.gitmodules` and no `/etc/gitconfig`. A non-zero exit or any byte on stderr fails the step, since gitleaks 8.30.1 ignores git's exit status and logs some git errors only as warnings;
  - then runs gitleaks, with the same log options and environment, `--config` (its default rules) and inline allows ignored. A finding, any ERR line, any WRN line but its `leaks found: N`, or a scan of 0 commits fails the step. The guards read the saved log as text, even with a NUL byte in it (`grep -a`). gitleaks's output, like the dry run's git stderr, is shown between a random `::stop-commands::` token and its end, so a file name a PR picks can't issue a workflow command;
  - runs OSV-Scanner with an empty `--config` over `bun.lock`, and zizmor with `--no-config --no-ignores`, online, on the job's read-only token;
  - last, on a pull request from a `factory/**` branch, checks that every commit carries `Work-Order`, `Hapi-Run`, `Trace-Id`, `Agent` and `Model` trailers and `Hapi-Lane: factory` (H-113's factory half), with git run the same clean way.
  - **Known residual (H-240):** gitleaks's default path allowlist, which `[extend] useDefault = true` keeps, never reports a token while it sits in `*.png`, `*.pdf`, `node_modules/`, `package-lock.json`, `yarn.lock`, `go.sum`, `vendor/modules.txt`, a path containing `gitleaks.toml`, a `venv/lib/` or `*.dist-info/` tree and the like (H-240 has the full list). Moved anywhere else, it is scanned there in full (`--no-renames`).
  - **Known residual (H-242):** only file contents are scanned. A token in a commit message, a file name or an annotated tag's message isn't reported.
- **`check`** (`contents: read`) runs the PR's code: ci.yml's mise-file scan, mise-action (pinned), ci.yml's mise-config check, then `mise install --locked && mise run check`. It runs on its own runner, so nothing it does reaches `scan`. No step installs packages itself, and the caller's `setup` runs no install script.
- **`gates`** (`permissions: {}`, no checkout) passes only when `scan` and `check` both succeeded. It runs even when one failed (`if: always()`), since GitHub reports a job skipped for a failed need as a success.

`ci / scan` and `ci / check` show on every PR beside `ci / gates`, but aren't required: `ci / gates` stands for both.

**The check's name, `CONTRACT_CHECK`:** the caller's job is `ci` and the aggregator `gates`, so GitHub reports `ci / gates` (src/forge/index.ts). `main-protect` requires it, from GitHub Actions, and `github.rulesets` requires exactly `ci / gates` of a repo `policy/repos.yaml` registers and exactly `ci` of any other (hapi-factory's own). Task 5 Step 15 confirms the name on the sandbox's first run (design §7.3); if GitHub reports another, `CONTRACT_CHECK` becomes that name and the sandbox's `main-protect` is applied again.

**What a green `ci / gates` can't prove (H-239):** on a pull request GitHub runs the PR's own copy of `.github/workflows/hapi-gates.yml`, so a PR that changes `.github/workflows/` can replace the gates with a job named `ci / gates` that only runs `true`. A personal account has no required workflows to stop it. The defences today: a fork's workflow runs wait for your approval (step 5), and neither of hapi's Apps has the Workflows permission, so neither can push such a change. So never approve a fork's run, and never trust its `ci / gates`, when the PR touches `.github/workflows/`: read the workflow change itself. Short of that, a green `ci / gates` is evidence only as far as the PR leaves its checks alone: `ci / scan` is the gates' own, from hapi-factory, but `ci / check` runs the PR's own `mise` tasks and configs, so a PR that changes `mise.toml`, `mise.lock`, `biome.json*`, `bunfig.toml`, `tsconfig*.json`, `osv-scanner.toml` or its tests changes what `check` means; read those changes as closely.

**Your own commits on a factory PR** need the six trailers too: `scan`'s trailer check reads every commit on a `factory/**` branch, and main-protect has no bypass, so a commit of yours without them, or the merge commit GitHub's **Update branch** or **Resolve conflicts** makes, leaves the PR unmergeable. Commit or resolve locally with them, or close the PR and land the change yourself ([the engine's runbook](engine.md#the-operator-always-wins); a gate rule for your own commits is H-295).

## Verify

Step 11 runs the strict audit for the new repo, with your `gh` login held in memory, and only these checks ([docs/audit.md](../audit.md)): `github.rulesets` (the four rulesets, `ci / gates` required), `github.repo-settings` (step 5's settings), `github.labels` and `repo.ai-workflows`. One fail fails the step. Your login is the repo's admin, so GitHub shows it every field, bypass actors included.

**What step 11 can't check:** that each App's token covers the new repo and nothing more (design §3.2 step 8). That proof is `github.app-perms`, which needs the App keys, so it runs as hapi, in hapi's checkout, with the stack's secrets resolved. First become hapi:

```bash
sudo -iu hapi
```

Then, as hapi, run this one line on its own (pasted with other lines, its `read` would take the next line as the token). It asks for your own token for the repo, a fine-grained one with Administration and Contents read-only ([GitHub credentials](../audit.md#github-credentials)), and writes it to a `0600` file without echoing it:

```bash
(umask 077; mkdir -p ~/.config/hapi; rm -f ~/.config/hapi/audit-token; IFS= read -rsp 'token: ' t && printf '%s\n' "$t" > ~/.config/hapi/audit-token)
```

Then edit the `OWNER` line once (your GitHub login), and paste the rest. The last line deletes the token file.

```bash
OWNER=<your GitHub login>
REPO=hapi-sandbox-fortune
export XDG_RUNTIME_DIR=/run/user/$(id -u)
cd ~/hapi-factory
mise run audit -- --strict --repo "$OWNER/$REPO" --github-token-file ~/.config/hapi/audit-token
rm -f ~/.config/hapi/audit-token
```

For another repo, set `REPO` to its name. `github.app-perms` passes when both Apps have only the runbook's permissions, are installed on selected repositories and are no ruleset's bypass actor.

## Deleting a sandbox

`gh` can't delete a repo until you give it the `delete_repo` scope, which it lacks by default. It is a runbook step, not a command:

```bash
gh auth refresh -s delete_repo
OWNER="$(gh api user --jq .login)"
gh repo delete "$OWNER/<name>" --yes
```

Then open a PR that drops its `policy/repos.yaml` entry, and remove `../<name>` if you cloned it.

## Changing the template

The template is a protected path (`templates/**`, hapi-factory's overlay): change it by PR, like `policy/`. A repo already made keeps its own copy; its `hapi-gates.yml` SHA is bumped by its own PR.

When a pin changes (`mise.toml`'s tools, `package.json`'s dependencies), regenerate both locks from a scratch render, outside the checkout, never with an install script running in it:

1. Render the template into a scratch dir (as `tests/newrepo/render.test.ts` does, with `renderTemplate`).
2. There, `bun install --ignore-scripts` with Bun 1.4.2, and `mise lock --platform linux-x64,macos-arm64`.
3. Copy `mise.lock` to `templates/repo-contract/mise.lock.tmpl`, and `bun.lock` to `bun.lock.tmpl` with its workspace's `"name"` set back to `"{{name}}"`.
4. In the scratch render, `mise install --locked && mise run check && mise run scan`, and `zizmor --offline .github`; then `mise run test` in hapi-factory.

Biome formats Markdown and YAML too, so keep the template's files as `mise run fmt` leaves them: `.github/**`, `.factory/**` and `.coderabbit.yaml` are protected in the new repo, and a worker's `fmt` must find nothing to change there.

## Plan 03's operator steps (Task 5, Steps 12–15)

Run these in your own terminal, in your hapi-factory checkout on `plan/03-run-engine`, never in an agent's session. Paste back what each step asks for.

**Step 12: add the `workflow` scope to your `gh` login.** Paste back the scopes line; it must list `repo` and `workflow`.

```bash
gh auth refresh -s workflow
gh auth status 2>&1 | grep -i 'token scopes'
```

**Step 13: CodeRabbit's installation id in `policy/repos.yaml`.** The first command lists every installation your login can see; check that `hapi-planner` and `hapi-factory` show the ids `policy/repos.yaml` already holds. The rest records coderabbitai's id, if it is installed, and shows the change.

```bash
gh api /user/installations \
  --jq '.installations[] | [.app_slug, .id, .repository_selection] | @tsv'
CR_ID="$(gh api /user/installations \
  --jq '.installations[] | select(.app_slug == "coderabbitai") | .id')"
[[ "$CR_ID" =~ ^[0-9]+$ ]] \
  && sed -i "s|^  # coderabbit: <id> .*|  coderabbit: $CR_ID     # coderabbitai|" \
    policy/repos.yaml
git diff policy/repos.yaml
```

Paste back both outputs. If the first command fails, that is the live answer to design §7.2's read: take each id from the end of the App's Configure URL (Settings → Applications → Installed GitHub Apps → Configure), and paste the error too.

**Step 14: apply hapi-factory's `main-review` again, with `require_last_push_approval`.** Paste back `true`, or your decision not to.

```bash
OWNER="$(gh api user --jq .login)"
id="$(gh api "repos/$OWNER/hapi-factory/rulesets" \
  --jq '.[] | select(.name == "main-review") | .id')"
gh api -X PUT "repos/$OWNER/hapi-factory/rulesets/$id" \
  --input policy/github/rulesets/main-review.json \
  --jq '.rules[] | select(.type == "pull_request") | .parameters.require_last_push_approval'
```

**Step 15: make the sandbox.** The first two lines are the personal-strings check over everything the push would publish, commit messages included: it should print `0`, and the push runs only then. The dry run changes nothing; the second `new-repo` makes the repo and clones it into `../hapi-sandbox-fortune`.

```bash
n="$(git log -p main..plan/03-run-engine \
  | grep -c -i -w -f private/personal-strings.txt)"
echo "personal strings: $n"
[ "$n" = 0 ] && git push origin plan/03-run-engine
mise run new-repo -- hapi-sandbox-fortune --clone --dry-run
mise run new-repo -- hapi-sandbox-fortune --clone
```

Once the sandbox's first gates run has finished (its first push to `main` starts it), read its check run and the registration:

```bash
OWNER="$(gh api user --jq .login)"
gh api "repos/$OWNER/hapi-sandbox-fortune/commits/main/check-runs" \
  --jq '.check_runs[] | [.name, .app.id, .conclusion] | @tsv'
git diff policy/repos.yaml
```

Paste back: the count; both `new-repo` outputs; the check-run line (expected: `ci / gates	15368	success`); the diff; and whether step 8 asked for a web step. Then the registration is committed on this branch, with `tests/policy/load.test.ts`'s `loads the repo registry and the sidecars exactly` pin updated to the new `repos` entry (and to Step 13's `installations`) and `mise run test` green: a protected-file commit, which needs your OK. Run the personal-strings check again before that commit is pushed.

## Troubleshooting

- **`missing scope workflow`:** `gh auth refresh -s workflow` (Step 12).
- **`GET /user returned no x-oauth-scopes header`:** a `GH_TOKEN` or `GITHUB_TOKEN` in your shell holds a fine-grained or App token, which `gh auth token` prints first. Unset it, or run `gh auth login`.
- **`... installation is <n>, but policy/repos.yaml says <m>`:** the id in `policy/repos.yaml` is stale; fix it by PR (a protected file).
- **`GitHub has no .github/workflows/gates.yml in <owner>/hapi-factory at <sha>`:** push your checkout's HEAD first.
- **`templates/repo-contract, .github/workflows/gates.yml or policy/github/rulesets has changes git hasn't committed`:** commit or remove them: the repo is rendered, and its rulesets posted, from what HEAD holds.
- **`policy/repos.yaml already registers <owner>/<name>`:** a stale entry, from a sandbox deleted before; drop it by PR, then run the command again.
- **The web step at step 8:** add the repo on github.com as the prompt says, then press Enter; the step checks the installation lists it. With no terminal (a pipe, CI), the step fails rather than going on unconfirmed.
- **`the rules GitHub applies aren't the contract's`:** a ruleset didn't take as posted. The repo exists, so delete it ([above](#deleting-a-sandbox)) and run the command again once the cause is fixed.
- **Step 11 fails `github.repo-settings`:** the detail names each setting and its value. CodeQL's default setup runs asynchronously and isn't part of the check.
