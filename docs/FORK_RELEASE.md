# Fork release and upstream sync

This fork, `LeonhardtHUST/dsh-notifier`, publishes the scoped package `@leonhardthust/dsh-notifier`. The upstream project `THEWOLFWALKER/dsh-notifier` stays canonical for source and attribution. Development happens on `dev`; releases happen on `main`. Upstream changes arrive through reviewed pull requests to `dev`.

## What the automation does

`.github/workflows/release.yml` runs the full release gate on `main` when `package.json` changes, or when a maintainer starts it manually. The publish job uses npm trusted publishing (OIDC) only. It never reads an `NPM_TOKEN` or `NODE_AUTH_TOKEN`, and the release guard fails if either variable is set. The workflow deliberately omits `actions/setup-node`'s `registry-url` input because that input exports a placeholder `NODE_AUTH_TOKEN`; `publishConfig.registry` in `package.json` pins the registry instead.

`.github/workflows/upstream-sync.yml` checks upstream `dev` and `main` once a day. It merges upstream `dev` into `automation/upstream-sync` and opens or updates a pull request against `dev`. It never pushes to `dev` or `main`, never publishes, and never runs upstream code in a job that holds a write token. After pushing the bot branch it dispatches the read-only CI workflow on that branch with `workflow_dispatch`, because GitHub does not start workflow runs from `GITHUB_TOKEN`-created pushes or pull requests. The pull request is for human review; the bot never approves or merges it.

## One-time npm setup

The package must exist on npm before a trusted publisher can be configured. That first publish has to be manual.

1. Run the full release gate locally on `main`:

   ```text
   npm test
   node scripts/verify-release.mjs
   node scripts/gen-channel-matrix.mjs --check
   npm pack --dry-run --json
   ```

   Push `main` with the release metadata, then wait for the `Verify release candidate` job in the Release workflow to pass. Do not publish while that job is red.

2. Publish the first scoped version from `main` with your npm login and 2FA:

   ```text
   npm publish --access public --ignore-scripts
   ```

   This bootstrap release has no trusted-publisher provenance. It only creates the package and the first version. The current target is `0.14.0`.

3. Create the immutable annotated tag for the bootstrap version:

   ```text
   git tag -a v0.14.0 -m "dsh-notifier 0.14.0"
   git push origin v0.14.0
   ```

   You can also let the Release workflow create a missing tag by dispatching it with `publish: true`; when the version is already on npm, that run is tag-only and does not republish. Once a `v*` tag exists, never move or recreate it.

4. Add the trusted publisher for the fork. Use either the official CLI (npm 11.15.0 or later) or the npmjs.com package settings. Both create the same trust relationship.

   CLI:

   ```text
   npm trust github @leonhardthust/dsh-notifier --file release.yml --repo LeonhardtHUST/dsh-notifier --env npm-release --allow-publish
   npm trust list @leonhardthust/dsh-notifier
   ```

   The CLI needs write access to the package and account-level 2FA. `--allow-publish` is required. `--file` takes a filename only and must include `.yml`.

   Web UI: npmjs.com, then the package, then Settings, then Trusted publishing, then Add trusted publisher, then GitHub Actions.

   | Field | Value |
   | --- | --- |
   | Organization or user | `LeonhardtHUST` |
   | Repository | `dsh-notifier` |
   | Workflow filename | `release.yml` |
   | Environment name | `npm-release` |
   | Allowed actions | Allow npm publish |

   Trusted publishers created after 2026-09-03 allow `npm stage publish` by default. Direct `npm publish` does not work unless "Allow npm publish" is selected.

5. A new trusted publisher must complete its first OIDC publish within two days. After that window it expires, and you have to delete and recreate it.

6. Validate the configuration with the next patch release, not by rerunning the same version. A rerun of an already published version is a no-op and proves nothing about OIDC. The first trusted-publishing release should be a new version such as `0.14.1`.

7. After the first OIDC publish succeeds, confirm that npm shows provenance for that version. Then set the repository variable `NPM_AUTO_PUBLISH` to `true`. Until that variable is set, pushes to `main` run the gates but stop before publishing. Manual dispatch with `publish: true` still works for recovery and goes through the `npm-release` environment.

8. Optional hardening: in the package settings, set Publishing access to "Require two-factor authentication and disallow tokens", and revoke any unused automation tokens. Do not store npm tokens in this repository.

## Repository settings

In Settings, Actions, General, Workflow permissions:

- Leave the default workflow token read-only. The workflows request scoped write permissions only in the jobs that need them.
- Enable "Allow GitHub Actions to create and approve pull requests". Without it the sync job cannot open its pull request.
- The default branch must contain the workflows. Daily schedules only run workflows from the default branch, which is `main` here.

The sync automation creates a pull request for a human to review. It never approves, merges, or enables auto-merge for its own pull request.

Optional: create the `npm-release` environment with required reviewers so every publish waits for approval. You can also add tag protection for `v*` tags. If tag protection blocks pushes from `GITHUB_TOKEN`, create the release tag locally instead of through the workflow.

## Release workflow behavior

The verify job checks the package name and scope, the GitHub repository, the `main` branch, `package.json.repository.url`, npm and Node versions, tokenless environment, the full test suite, the release guard, the channel matrix, `src/index.mjs`, the npm pack payload, registry state, and the release tag.

The publish job runs only when a release is needed and either a maintainer dispatched it with `publish: true` or the `NPM_AUTO_PUBLISH` variable is `true`. It uses the `npm-release` environment, `id-token: write` for OIDC, and `contents: write` for the tag.

State handling:

| Registry | Tag | Action |
| --- | --- | --- |
| version missing | missing | create annotated tag, publish |
| version missing | at the release commit | publish |
| version present | missing | create the tag only |
| version present | at the release commit | no-op |
| version present | behind the release commit | no-op, because only metadata or docs changed after the release |
| version present | not on the release history | fail, never retag |
| version missing | behind the release commit | fail, publish from the tagged commit or fix the tag first |

Manual recovery after a failed run: Actions, Release, Run workflow, branch `main`, `publish: true`. The workflow re-reads registry state, skips an existing version, creates a missing tag, and verifies the published version. Concurrent runs share the `npm-release` concurrency group, so they run one at a time.

The first trusted-publishing run for an existing bootstrap version is a tag-only run if you dispatch `publish: true` before the next version is published.

## Upstream sync behavior

The sync workflow runs at 06:17 UTC every day, on manual dispatch, and when CI for the sync pull request fails.

1. Fetch upstream `dev` and `main` without checking out upstream code, and compare their commit ids.
2. Create or reset `automation/upstream-sync` from the fork `dev` head.
3. Merge upstream `dev` with a merge commit.
4. Restore fork-owned paths on every merge path, clean or conflicted, and re-pin `package.json` identity, public publish config, and the `docs/FORK_RELEASE.md` payload entry while keeping upstream version and metadata.
5. Push the branch and open or update the one open pull request against `dev`.
6. Dispatch the read-only CI workflow on `automation/upstream-sync` with `workflow_dispatch`.

Entry guards: the sync refuses a dirty worktree and refuses to run outside GitHub Actions unless `UPSTREAM_SYNC_ALLOW_LOCAL=1` is set explicitly. It records the bot branch head before merging and pushes with `--force-with-lease`, so a concurrent update fails the run instead of being dropped. Network git operations time out after 120 s, local git operations after 60 s, and GitHub API calls after 30 s. A timeout takes the same issue notification path as any other failure.

Fork-owned paths restored after the merge:

- `.github/workflows`
- `scripts/release-automation.mjs`
- `scripts/upstream-sync.mjs`
- `test/release-automation.test.mjs`
- `test/upstream-sync.test.mjs`
- `docs/FORK_RELEASE.md`
- `.agents/workstreams/rc3-automation.md`
- `package.json` name, repository URL, public publish config, and the `docs/FORK_RELEASE.md` files entry

Restoration runs even when the merge has no conflicts. A clean merge can still add or edit a workflow file, so conflict-only restoration would let upstream code into the fork without review.

If upstream `main` has commits that are not contained in upstream `dev`, the sync raises or updates the alert even when `dev` has nothing left to merge. It never reports `up-to-date` as healthy while that divergence exists. Port those changes deliberately; the automation never merges `main`.

Fetch, network, push, dispatch, and GitHub API failures are caught inside the already loaded sync script, which raises the same deduplicated issue before the job fails. The catch does not execute anything from the merged tree.

Conflicts inside the fork-owned paths are resolved in favor of the fork. Conflicts anywhere else stop the merge and create or update one issue, `[automation] upstream sync needs attention`, which mentions `@LeonhardtHUST`. The same issue is updated in place and closed when the sync becomes healthy again.

CI failure alerts come from the `workflow_run` trigger. They match the `CI` workflow, `.github/workflows/ci.yml`, the fork head repository, the `automation/upstream-sync` head branch, and either a pull request or a dispatched run. The alert job reads the pull request through the GitHub API and never checks out the pull request head. Notification is a GitHub issue mention only. Email delivery depends on the watcher's GitHub notification settings.

Upstream changes to workflow files, release scripts, or their tests need a manual port. The daily sync will not overwrite them.

## Troubleshooting

`ENEEDAUTH` during publish: the trusted publisher fields must match exactly, including the `release.yml` filename, the `npm-release` environment, and the repository owner and name. The workflow must run on a GitHub-hosted runner with `id-token: write`.

`E422` about provenance or repository information: `package.json.repository.url` must be `https://github.com/LeonhardtHUST/dsh-notifier`. The release guard checks this before the publish job starts.

The sync job cannot create a pull request: enable "Allow GitHub Actions to create and approve pull requests". Also check that the `dev` branch exists and the pull request API scope is available to `GITHUB_TOKEN`.

The workflow does not run on schedule: confirm `release.yml` and `upstream-sync.yml` are present on `main`.

## Official references

- npm trusted publishing: https://docs.npmjs.com/trusted-publishers
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- npm trust CLI: https://docs.npmjs.com/cli/v12/commands/npm-trust
- npm trusted publishing announcement: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- GitHub token event rules: https://docs.github.com/en/actions/using-workflows/triggering-a-workflow#triggering-a-workflow-from-a-workflow
- GitHub token permissions: https://docs.github.com/en/actions/security-guides/automatic-token-authentication
