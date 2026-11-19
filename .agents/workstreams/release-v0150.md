# Workstream: Notification 0.15.0 release

- Agent identity: `lead | DSH development team | Windows`
- Agent: `lead`
- Branch: `codex/session-notifications` → fork `dev` → fork `main`
- Status: `done`
- Start/end: `2026-11-19 -> 2026-11-19`
- Scope: Deliver the reviewed session-notification work with localized DSH Settings display names and publish the next minor release.
- Plan: (1) Confirm remote ancestry, version availability and OIDC workflow. (2) Independently verify localized metadata stays in npm payload and internal identity stays stable. (3) Sync version/count/docs, run isolated full suite, compatibility and pack guards, then push fast-forward to fork `dev` and `main`. (4) Monitor GitHub Actions, verify immutable tag and registry provenance, create GitHub Release and verify registry artifact; record only confirmed state.
- Owned files: version fields in `package.json` after metadata handoff, `src/admin/ui/markup.mjs`, release docs, `HANDOFF.md`, `docs/memory/project-state.md`.
- Do not touch: Live DSH profile, upstream, old tags or trust configuration.
- Validation: isolated `npm test`, release/host/channel matrix/syntax, pack dry run, origin branch/tag checks, OIDC runner and npm registry verification.
- Adversarial review: Check name/ID compatibility, locale export/pack, stale README version markers, release integrity and actual registry state before claiming publication.
- Handoff: Locale implementation `2679ad0`; release `7d72ba3`, tagged `v0.15.0`, fast-forwarded into `origin/dev` then `origin/main`. Local suite 2231 total, 2230 pass, 0 fail, 1 Windows symlink skip; release/host/matrix/pack checks passed. GitHub Release and npm latest verified; OIDC run `44495546848` passed after npm propagated the first successful publication. Published tarball SHA-512 validated, 334 files, both localized titles and SLSA provenance source checked. No live profile change or authenticated Desktop rendering claim. Repo handoff and project memory updated; plugin memory tools were not exposed.
