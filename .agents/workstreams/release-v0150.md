# Workstream: Notification 0.15.0 release

- Agent identity: `lead | DSH development team | Windows`
- Agent: `lead`
- Branch: `codex/session-notifications` → fork `dev` → fork `main`
- Status: `active`
- Start/end: `2026-11-19 -> active`
- Scope: Deliver the reviewed session-notification work with localized DSH Settings display names and publish the next minor release.
- Plan: (1) Confirm remote ancestry, version availability and OIDC workflow. (2) Independently verify localized metadata stays in npm payload and internal identity stays stable. (3) Sync version/count/docs, run isolated full suite, compatibility and pack guards, then push fast-forward to fork `dev` and `main`. (4) Monitor GitHub Actions, verify immutable tag and registry provenance, create GitHub Release and verify registry artifact; record only confirmed state.
- Owned files: version fields in `package.json` after metadata handoff, `src/admin/ui/markup.mjs`, release docs, `HANDOFF.md`, `docs/memory/project-state.md`.
- Do not touch: Live DSH profile, upstream, old tags or trust configuration.
- Validation: isolated `npm test`, release/host/channel matrix/syntax, pack dry run, origin branch/tag checks, OIDC runner and npm registry verification.
- Adversarial review: Check name/ID compatibility, locale export/pack, stale README version markers, release integrity and actual registry state before claiming publication.
- Handoff: In progress.
