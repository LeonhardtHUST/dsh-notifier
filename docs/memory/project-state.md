# Project state

## Current state type:state

- 2026-11-19: `@leonhardthust/dsh-notifier@0.15.0` is npm latest and [published on GitHub](https://github.com/LeonhardtHUST/dsh-notifier/releases/tag/v0.15.0). Immutable tag `v0.15.0` points at `7d72ba31b2f45f2799afacb8aeca6ea2d1eaca9c`; fork `dev` and `main` contain it. DSH plugin settings display `Notification` / `消息通知` without changing npm, patch or runtime identity.
- 0.15.0 adds event-specific overlay/system/remote rules, session mutes, a title-bar-safe actionable overlay and platform-dependent system actions. See [HANDOFF](../../HANDOFF.md) for implementation commits and outstanding device verification.
- DSH requirement remains exact `0.2.2-rc.3`; Node `>=22`, ESM, zero mandatory runtime dependencies, no build. 28 outbound adapters (two local) and six inbound control transports.
- Work lands in fork `dev`; releases use fork `main`. Specify `gh -R LeonhardtHUST/dsh-notifier`; never push to `THEWOLFWALKER/dsh-notifier`.

## Validation type:progress

- Isolated Windows suite: 2231 total, 2230 passed, 0 failed, 1 Windows symlink skip; release, host-compatibility, matrix and npm payload guards passed. The installed rc.3 resolver returned both names without metadata diagnostics, independently of live GUI rendering.
- [Release run 44495546848](https://github.com/LeonhardtHUST/dsh-notifier/actions/runs/44495546848) succeeded on attempt 2, after the first OIDC upload succeeded but the immediate registry check missed propagation. No duplicate publish or retag. Registry tarball SHA-512 matches npm integrity, 334 files, both locale resources present; SLSA provenance names the exact source commit.
- Prior Windows 11 26H2 evidence covers native Toast sending, not the 0.15.0 OS action buttons. Linux has contract evidence only. Authenticated installed Desktop rendering/navigation and real OS action delivery remain unverified.

## Durable boundaries

- State files contain credentials and bindings; use store transactions and locking, never hand-edit a live state file. Canonical channel UI state is `channel:<type>:outbound`.
- Inbound identity is composite and source-bound. Unknown source, expired token, timeout and callback failures remain fail-closed. An attention handler's call claim is not a delivery receipt.
- Do not claim Desktop `ask_user` settlement parity or infer actual OS device behavior from contract tests. Version and compatibility authority remain the manifest and source/tests.

## Next step type:goal

With permission, install the npm artifact in a separate test environment. Exercise the authenticated overlay and Settings names, Windows click navigation, and Linux GNOME/KDE action/mute callbacks. Do not restart the active session automatically.
