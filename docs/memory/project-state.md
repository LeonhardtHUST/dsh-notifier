# Project state

## Current state type:state

- 2026-11-23: `0.15.1` is prepared on `main` and **not yet published**; npm latest and tag `v0.15.0` (`7d72ba31b2f45f2799afacb8aeca6ea2d1eaca9c`) are unchanged. The host requirement moved from exact `0.2.2-rc.3` to exact `0.2.2-rc.5` (installed Desktop build, Cordis 4.1.0); `src/` and `client.js` are unchanged because all 22 host seams still match.
- 0.15.0 remains the shipped feature line: event-specific overlay/system/remote rules, session mutes, a title-bar-safe actionable overlay and platform-dependent system actions. See [HANDOFF](../../HANDOFF.md) for implementation commits and outstanding device verification.
- The fork has one long-lived branch, `main`; `dev` and every `codex/*` branch were deleted locally and on `origin`. Divergent history is preserved as tags `archive/v0.13.1-release`, `archive/core-distillation-v015`, `archive/thewolfwalker-patch-2`. Specify `gh -R LeonhardtHUST/dsh-notifier`; never push to `THEWOLFWALKER/dsh-notifier`.
- Node `>=22`, ESM, zero mandatory runtime dependencies, no build. 28 outbound adapters (two local) and six inbound control transports.

## Validation type:progress

- Host smoke on the installed rc.5: `node test/host/harness.smoke.mjs` 19/19 (web route 401 behind Connection admission, headless activation plus a real local webhook POST, Cordis event-context 9/9). The same run first reproduced the manifest gate: `engines.dsh: 0.2.2-rc.3` made the rc.5 host skip the bundle without an exemption request; the rc.5 declaration fixed it.
- Isolated Windows suite: see `HANDOFF.md` for the current total; release, host-compatibility, matrix and npm payload guards passed.
- Prior Windows 11 26H2 evidence covers native Toast sending, not the 0.15.0 OS action buttons. Linux has contract evidence only. Authenticated installed Desktop rendering/navigation and real OS action delivery remain unverified.

## Durable boundaries

- State files contain credentials and bindings; use store transactions and locking, never hand-edit a live state file. Canonical channel UI state is `channel:<type>:outbound`.
- Inbound identity is composite and source-bound. Unknown source, expired token, timeout and callback failures remain fail-closed. An attention handler's call claim is not a delivery receipt.
- Do not claim Desktop `ask_user` settlement parity or infer actual OS device behavior from contract tests. Version and compatibility authority remain the manifest and source/tests.

## Next step type:goal

With permission, install the npm artifact in a separate test environment. Exercise the authenticated overlay and Settings names, Windows click navigation, and Linux GNOME/KDE action/mute callbacks. Do not restart the active session automatically.
