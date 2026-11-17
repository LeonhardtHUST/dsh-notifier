# Workstream: rc3-automation (scoped npm release + upstream sync CI)

- Agent identity: `automation | DeepSeek Harness worker | Windows D:\Projects\GitHub\dsh-notifier`
- Agent: `automation`
- Branch: `codex/rc3-scoped-release` (base `dev`; shared with `codex` release work, no checkout)
- Status: `done`
- Start/end: `2026-11-17 -> active`
- Scope: prepare fork-local GitHub Actions for the scoped npm package `@leonhardthust/dsh-notifier` (main version-change release via OIDC trusted publishing, idempotent recovery, full tests/release guard/pack payload guards) and a daily, non-executing upstream `THEWOLFWALKER/dsh-notifier` dev/main sync that opens a fork-dev PR and dedupes failure issues.

## Plan (ordered)

1. Read `AGENTS.md`, `docs/KNOWLEDGE_BASE.md`, `docs/memory/`, `docs/VERSIONING.md`, current `.github/workflows/ci.yml`, `scripts/verify-release.mjs`, and the npm official trusted-publishing/provenance docs; record the exact current npm requirements.
2. Write this plan before code (this file). Check the worktree/branches first.
3. Implement `scripts/release-automation.mjs` as pure testable policy + thin CLI:
   - identity/scope guard (`@leonhardthust/dsh-notifier`, scope `@leonhardthust`);
   - repository guard (`GITHUB_REPOSITORY === LeonhardtHUST/dsh-notifier`) and branch guard (`main` only);
   - provenance repository field guard (`package.json.repository.url` must be the fork URL);
   - npm CLI gate (trusted publishing needs npm >= 11.5.1, Node >= 22.14; release runs Node 24);
   - tokenless guard (fail if `NPM_TOKEN`/`NODE_AUTH_TOKEN` are present);
   - pack manifest guard (no `.agents/`, `.claude/`, `.codex/`, `.opencode/`, `.github/`, `HANDOFF.md`, `ADAPTER.md`, `examples/`, lockfile, state; require entrypoints/docs);
   - registry idempotency (`GET /@leonhardthust%2Fdsh-notifier/<version>`, 200 => published, 404 => unpublished);
   - release plan: `publish | tag-only | already-released | fail`; never move an existing tag.
4. Implement `.github/workflows/release.yml`:
   - trigger `push` to `main` on `package.json` change plus `workflow_dispatch` (publish boolean, default false);
   - verify job: checkout, Node 24, guard, full `npm test`, `verify-release`, channel matrix, `node --check src/index.mjs`, `npm pack --dry-run --json` + pack guard, registry/plan outputs;
   - publish job: gated so auto-publish stays OFF until repository variable `NPM_AUTO_PUBLISH=true` (post first manual publish), `environment: npm-release`, `id-token: write` + `contents: write`, no token secrets, tag-if-missing -> `npm publish --access public` (provenance is automatic under trusted publishing), post-publish registry assertion, concurrency `npm-release`.
5. Implement `scripts/upstream-sync.mjs`:
   - fixed upstream `THEWOLFWALKER/dsh-notifier`, fork `LeonhardtHUST/dsh-notifier`, target `dev`, sync branch `automation/upstream-sync`;
   - read-only `git ls-remote`/fetch of upstream (no upstream code execution), merge into a local sync branch;
   - re-apply fork overrides: `package.json` name/repository.url, keep fork workflows/scripts/tests/fork docs/workstream; restore those paths from `origin/dev` after merge;
   - no `npm install`, build, or test in the write job; checks happen in the PR's read-only CI;
   - dedupe single open PR (`automation/upstream-sync` -> `dev`), update body instead of opening duplicates;
   - dedupe issue `[automation] upstream sync needs attention` with `@LeonhardtHUST`, mention-neutralised untrusted text, updated in place on conflict/check failure;
   - no `pull_request_target`, no shell interpolation of refs/messages: `execFileSync` args + env only.
6. Implement `.github/workflows/upstream-sync.yml` (daily cron + dispatch + `workflow_run` failure alert):
   - repo guard, least privilege, write perms only in the sync/alert job, default `contents: read`;
   - workflow_run alert never checks out the PR head (reads API only; default-branch script).
7. Add `test/release-automation.test.mjs` and `test/upstream-sync.test.mjs` (hermetic; fake fetch/git temp repos; no network). Keep fixtures inline.
8. Document operator setup in `docs/FORK_RELEASE.md`: exact npm Trusted Publisher UI fields (owner/repo/workflow filename/environment), first-publish window, provenance `repository.url` prerequisite, repo variable gate, recovery runbook, notification expectations (GitHub only), and known limits (README/CHANGELOG still upstream-scoped; tag protection; default-branch requirement).
9. task-9 hardening after independent review (2026-11-17): the npm pack guard now rejects the two repo-only automation tests and `test/host/**`; the release verify job sets `DSH_HOME` under `runner.temp`; publish uses `--ignore-scripts`; the bootstrap runbook now lists the full gate, waits for the Release verify job, and requires an immutable annotated tag; sync error text strips URL userinfo and GitHub token formats before it reaches an issue. Focused tests: 29 pass; payload guard 320 files with host files and automation tests absent.
10. task-10 hardening (2026-11-17): merge/commit identity is injected per command with `-c user.name` / `-c user.email` (no global or local config writes); tests clear global/system config, clear identity env vars, and assert the merge commit author before/after local config stays unset. `PROTECTED_PATHS` now also pins `client.js`, `cordis.patch.yml`, and `test/.npmignore`; the clean-merge test confirms upstream edits to those files are reverted and the PR body says they need a manual port. The `workflow_run` alert also matches `timed_out`, `cancelled`, and `action_required`, and the sync job declares `checks: read` for check-run reads. Focused tests: 30 pass.
11. Validation: focused node tests with hermetic guard, YAML sanity, `node --check` on scripts, full `npm test` if time allows, release guard. Neat-freak self-check, then ask lead for the git index slot; no commit/push/publish/remote changes done here.

## Owned files

- `.github/workflows/release.yml` (new)
- `.github/workflows/upstream-sync.yml` (new)
- `.github/workflows/ci.yml` (only add least-privilege `permissions`)
- `scripts/release-automation.mjs` (new)
- `scripts/upstream-sync.mjs` (new)
- `test/release-automation.test.mjs` (new)
- `test/upstream-sync.test.mjs` (new)
- `docs/FORK_RELEASE.md` (new)
- `.agents/workstreams/rc3-automation.md` (this file)

## Do not touch

`package.json` (name/version/repository are lead-owned), `src/**`, `test/**` other than the two new files, `README*.md`, `CHANGELOG.md`, `HANDOFF.md`, `docs/memory/**`, other `.agents/workstreams/*`.

## Open decisions routed to lead

- `package.json.repository.url` must become the fork URL for npm provenance; lead owns that edit.
- Auto-publish is shipped disabled behind `NPM_AUTO_PUBLISH`; lead enables it after the first manual publish + trusted-publisher setup + 2-day validation window.
- README/CHANGELOG still describe the upstream unscoped package; a fork-facing install note is in `docs/FORK_RELEASE.md`, but user-facing README wording needs a separate decision.

## Validation

```text
node --check scripts/release-automation.mjs
node --check scripts/upstream-sync.mjs
node --import ./test/_hermetic-network-guard.mjs --test test/release-automation.test.mjs test/upstream-sync.test.mjs
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
npm test
```

## Adversarial review

Challenged and fixed during implementation:

- Metadata-only commits on `main` after a release must not republish and must not fail red. `planRelease` now accepts `tagIsAncestor`; a tag behind `HEAD` with the version already on npm is `already-released`. A tag that is not on the release history is still a hard conflict, and an unpublished version whose tag sits behind `HEAD` stops for a human instead of publishing different contents behind an existing tag.
- Registry errors are not unpublished versions. Only HTTP 404 means "not published"; 401/403/429/5xx throw. The post-publish `--require-exists` poll retries 404 for up to 30 s. The latest dist-tag lookup is strict too.
- Auto-publish must stay off until after the first manual publish and trusted-publisher validation. The publish job is gated by repository variable `NPM_AUTO_PUBLISH=true`; manual recovery is an explicit `workflow_dispatch` input and still passes through the `npm-release` environment.
- The first OIDC validation must be a new patch release. Rerunning an already published version can only produce a no-op, so the docs say to validate with `0.14.1` and only then arm the variable.
- Upstream merges never execute upstream code in the write job. The sync job does git plumbing, restores fork-owned paths, pushes the bot branch, and calls the API. If a merge conflicts outside protected paths, it aborts and raises one issue. CI on the pull request is the first place the merged tree runs, and `ci.yml` now declares `contents: read`.
- Fork features survive a merge. `.github/workflows`, both automation scripts, their tests, `docs/FORK_RELEASE.md`, the workstream, and `package.json` identity are restored after the merge; upstream-added workflow files are deleted. Upstream still owns `package.json` version/metadata. The pre-review found that restoration only ran on conflicted paths; `mergeUpstream` now restores on every path, clean or conflicted, and a clean-merge test proves an upstream-added workflow is stripped and a modified `ci.yml` is reverted.
- `package.json` overriding is not just name/repository. It also pins `publishConfig.access=public`, `publishConfig.registry=https://registry.npmjs.org/`, and keeps `docs/FORK_RELEASE.md` in `files`, so an upstream merge cannot drop the fork's publish contract.
- GITHUB_TOKEN-created pushes and pull requests do not start CI runs. The sync job therefore dispatches `ci.yml` with `workflow_dispatch` on the bot branch after pushing (`actions: write`), and `ci.yml` gained a `workflow_dispatch` trigger while staying `contents: read`. The failure alert listens to both `pull_request` and `workflow_dispatch` runs and matches workflow name, workflow path, head repository, head branch, and fork repository. No PAT or long-lived secret is introduced.
- Upstream `main` divergence is no longer silently healthy. When upstream main has commits not contained in upstream dev, the sync raises or updates the alert even when dev is up-to-date, and never closes it as healthy. Fetch, network, push, dispatch, and API failures raise a deduplicated sync-failure issue before the job fails; the catch is in the already loaded script and never executes merged tree code.
- Tokenless release was wrong in the first draft: `actions/setup-node` with `registry-url` exports a placeholder `NODE_AUTH_TOKEN`, which the guard rejects by design. Both `registry-url` inputs were removed; `publishConfig.registry` pins the registry. A static workflow test fails if `registry-url`, secret token references, or token env keys come back.
- The npm payload guard now checks every path segment, not just the top directory. Nested `src/.credentials`, `.env`, `.npmrc`, `node_modules`, and agent directories are rejected from a fake manifest; no real credential file is read.
- Sync entry is safe against local misuse and concurrent bot-branch updates. `assertSyncWorkspace` requires a clean worktree, requires CI or an explicit `UPSTREAM_SYNC_ALLOW_LOCAL=1` opt-in, and verifies `origin` is the fork. The push uses `--force-with-lease` with the bot branch SHA observed before the merge; a concurrent update fails and goes through the notification path. Network git calls have a 120 s timeout, local git calls 60 s, and GitHub API calls 30 s.
- Injection paths were removed. Workflow `run:` blocks take values from `env`, never raw `${{ }}` expressions; git uses `execFileSync` argument arrays; untrusted commit subjects and error text are mention-neutralised, truncated, and rendered in code spans/fences. No `pull_request_target`, no upstream checkout in a write job, no self-approval or auto-merge.
- Tokenless release is enforced by code. `NPM_TOKEN` / `NODE_AUTH_TOKEN` / `NPM_CONFIG__AUTHTOKEN` / `NPM_CONFIG__AUTH` fail the guard; `package.json.repository.url` must equal the fork URL for provenance.
- The pack guard enforces the npm boundary: no `.agents/`, `.github/`, agent tool directories, credential/environment files, `HANDOFF.md`, `ADAPTER.md`, `examples/`, lockfile, state, or automation scripts in the tarball.

Remaining risks recorded for the reviewer: GitHub Actions API semantics cannot be exercised locally (plan/CI gating logic is unit-tested, the YAML is parsed and reviewed, but a real dry-run dispatch is still required). The workflow setting "Allow GitHub Actions to create and approve pull requests" is a remote repo setting the lead enables. Tag protection can block the workflow's tag push. `test/.npmignore` excludes the two repo-only automation tests from the npm payload; final pack shows no automation scripts or tests and keeps `docs/FORK_RELEASE.md`.

## Handoff

Implementation and review revisions are committed as `8c10a60` on `codex/rc3-scoped-release`; no push or publish was performed by this worker. The commit contains the three workflows, both automation scripts, their focused tests, `docs/FORK_RELEASE.md`, and this workstream. Full suite was run separately by lead as 2082/2082 in an isolated temporary `DSH_HOME`. Remaining external checks are GitHub Actions/OIDC and registry publication.

Validation evidence (2026-11-17):

```text
node scripts/release-automation.mjs guard
  -> release guard ok: @leonhardthust/dsh-notifier@0.14.0 from LeonhardtHUST/dsh-notifier@main
node --import ./test/_hermetic-network-guard.mjs --test test/release-automation.test.mjs test/upstream-sync.test.mjs
  -> 30 tests, 30 pass, 0 fail (~30 s; throwaway git repositories, fake fetch, fake manifests)
node --check scripts/release-automation.mjs && node --check scripts/upstream-sync.mjs
  -> clean
python -c "import yaml, glob; ..."  # YAML parse of all .github/workflows/*.yml
  -> ci.yml, release.yml, upstream-sync.yml parse
npm pack --dry-run --json + node scripts/release-automation.mjs pack-check <json>
  -> npm payload guard ok: 320 files, no dev/tool directories; automation scripts/tests and test/host files excluded, docs/FORK_RELEASE.md present
```

Full `npm test` is intentionally deferred to the lead's serial DSH_HOME run (per 2026-11-17 pause on full suites). Commits: `8c10a60` (release + upstream sync automation, task-3/task-9) and `d745f7c` (bot identity, client protection, alert conclusions, task-10). Neither is pushed. Files staged in those commits: `.github/workflows/ci.yml`, `release.yml`, `upstream-sync.yml`, `scripts/release-automation.mjs`, `scripts/upstream-sync.mjs`, `test/release-automation.test.mjs`, `test/upstream-sync.test.mjs`, `docs/FORK_RELEASE.md`, `.agents/workstreams/rc3-automation.md`.

