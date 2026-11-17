# Versioning And Release Integrity

This project has had version-split incidents before. The rule is now: one engineering tree, one package version, one release gate.

## Canonical Layers

1. `package.json.version` is the semantic version authority for the published package `@leonhardthust/dsh-notifier`.
2. `CHANGELOG.md` must contain the matching `## [version]` entry.
3. `src/admin/ui.mjs` must display the same version.
4. README badges/body, `HANDOFF.md`, and `dshQuality.testCount` must agree on the published release baseline; unreleased development counts are documented separately and must not change the release guard count.
5. `package.json.files` defines the npm payload. The engineering archive is not the npm payload; contributor-only files such as `docs/FORK_RELEASE.md` stay out unless listed.

`node scripts/verify-release.mjs` checks these invariants. A release is blocked when it fails.

## Commit Protocol

- Import or recover a source baseline in its own commit.
- Make runtime changes, tests, docs, and metadata in logically separate commits where practical.
- Do not publish from a dirty tree or from a `file:` installation.
- Use `codex/<topic>` branches for agent work; merge only after the parent agent reviews the diff and test result.
- Tag the exact release commit after the guard passes. Never retag a version with different source contents.

## Release Gate

```text
git status --short --branch          # must be clean before publish
npm test                             # full behavior contract
node scripts/verify-release.mjs      # version/docs/payload invariants
node scripts/gen-channel-matrix.mjs --check
npm pack --dry-run --json            # inspect actual npm file list
```

After publishing, verify in a disposable host profile, not only in the source tree:

```text
npm view @leonhardthust/dsh-notifier version
npm ls @leonhardthust/dsh-notifier
dsh plugin add @leonhardthust/dsh-notifier@<version> --profile <profile>
```

Restart DSH and verify the UI version, startup assembly markers, one outbound test, and one inbound command. A registry install is the real-machine baseline; a local `file:` install is for temporary development only.

## Artifact Comparison

The repository archive may include contributor-only files such as `HANDOFF.md`, `ADAPTER.md`, design notes, screenshots, and CI. The npm package intentionally excludes those. Compare manifests and hashes before release, but do not make the npm archive the source of truth.

## Single-Repo Release Flow (main + dev)

The canonical engineering repository is `THEWOLFWALKER/dsh-notifier` (upstream, attribution and
history). The maintained fork `LeonhardtHUST/dsh-notifier` publishes
`@leonhardthust/dsh-notifier`; its release automation, reviewed upstream sync and OIDC trusted
publishing are documented in [FORK_RELEASE.md](FORK_RELEASE.md). Both repositories follow the
same two-branch discipline:

- `dev` — development branch. Active engineering happens here (features, `codex/*` topics); every change lands on `dev` first.
- `main` — release branch. Only reviewed, published versions live here; tagged at each release; npm publishes from this branch's tree.

Never develop on `main`. The npm payload is governed independently by `package.json.files` — agent/tool directories (`.agents/`, `.claude/`, `.codex/`, `.opencode/`) and contributor-only files (`HANDOFF.md`, `ADAPTER.md`, `docs/FORK_RELEASE.md`) never enter the npm archive.

Recommended publish procedure (fork):

```text
# 1. dev must be green and clean
git checkout dev
git status --short --branch        # clean
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check

# 2. bring main forward to the reviewed dev head, tag, and publish through the fork's reviewed workflow
git checkout main
git merge --ff-only dev            # keep main pinned to a reviewed dev head
node scripts/verify-release.mjs
git tag v<version>
git push origin main --tags
# publish via the fork's OIDC automation, not a local long-lived npm token
```

Keep `main` pinned to a reviewed `dev` head. Never force-push over published history; if drift appears, reconcile forward from `dev`.

## Version Bump Checklist

- Update `package.json.version` (currently the scoped fork package).
- Add a top CHANGELOG entry describing behavior, tests, and security/review identifiers when relevant.
- Update the admin UI version string.
- Run the full test suite and update `dshQuality.testCount` only from the actual runner summary.
- Synchronize README release badges/body and `HANDOFF.md` release count references; label any unreleased development baseline separately.
- Run the release guard, host compatibility guard, and channel matrix check.
- Record the final commit, package version, npm registry version, and any real-device gap in `docs/memory/project-state.md`.
