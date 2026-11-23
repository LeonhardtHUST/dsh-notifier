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
- Commit directly on `main`, one logical concern per commit; the parent agent reviews the diff and test result before the change counts as complete. Temporary experiment branches are deleted once merged.
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

## Single-Repo Release Flow (single main line)

The canonical engineering repository is `THEWOLFWALKER/dsh-notifier` (upstream, attribution and
history). The maintained fork `LeonhardtHUST/dsh-notifier` publishes
`@leonhardthust/dsh-notifier`; its release automation, reviewed upstream sync and OIDC trusted
publishing are documented in [FORK_RELEASE.md](FORK_RELEASE.md). Upstream still runs `dev` plus
`main`; the fork keeps a single long-lived branch:

- `main` — feature work, docs and release metadata land here in small commits; each release is tagged on this same branch and npm publishes from its tree.

Do not create a long-lived `dev` branch or `codex/<topic>` branches. When an experiment needs isolation, branch off `main` temporarily and delete the branch once it is merged. The npm payload is governed independently by `package.json.files` — agent/tool directories (`.agents/`, `.claude/`, `.codex/`, `.opencode/`), contributor-only files (`HANDOFF.md`, `ADAPTER.md`), automation scripts/tests and `test/host/` stay out of the archive. `docs/FORK_RELEASE.md` is explicitly included as the fork publishing and synchronization runbook.

Recommended publish procedure (fork):

```text
# 1. main must be green and clean
git switch main
git status --short --branch        # clean
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check

# 2. tag the reviewed release commit on main and publish through the fork's reviewed workflow
node scripts/verify-release.mjs
git tag v<version>
git push origin main --tags
# publish via the fork's OIDC automation, not a local long-lived npm token
```

Keep `main` reviewable: never force-push over published history. If a published release needs a fix, commit forward on `main` and publish a new version instead of moving the tag.

## Version Bump Checklist

- Bump from a clean `main`; the version change, tag and publish all happen on that branch.
- Update `package.json.version` (currently the scoped fork package).
- Add a top CHANGELOG entry describing behavior, tests, and security/review identifiers when relevant.
- Update the admin UI version string.
- Run the full test suite and update `dshQuality.testCount` only from the actual runner summary.
- Synchronize README release badges/body and `HANDOFF.md` release count references; label any unreleased development baseline separately.
- Run the release guard, host compatibility guard, and channel matrix check.
- Record the final commit, package version, npm registry version, and any real-device gap in `docs/memory/project-state.md`.
