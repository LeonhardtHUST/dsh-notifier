# Project state

## Current state type:state

- 2026-11-23: `0.15.1` is published — tag `v0.15.1` at `8961617497e87d43e742b0da98a64e31277ff257`, [GitHub Release](https://github.com/LeonhardtHUST/dsh-notifier/releases/tag/v0.15.1), npm latest `0.15.1`. The registry tarball is 334 files and its SHA-512 (`sha512-Fb/qgTSyK4+gLzlMa9NSsuKjuVxQ/BLLjbj2M0zCJvnNBrb2mr3L7FHwqzyncfHzb7BA6A4QFMphrcxouk1/GQ==`) matches a local `npm pack`. OIDC publish succeeded on the first run; only the immediate post-publish registry check failed on propagation and passed on rerun.
- The host requirement moved from exact `0.2.2-rc.3` to exact `0.2.2-rc.5` (installed Desktop build, Cordis 4.1.0); `src/` and `client.js` are unchanged because all 22 host seams still match. 0.15.0 remains the feature line for event-specific overlay/system/remote rules, session mutes, the actionable overlay and platform-dependent system actions.
- The fork has one long-lived branch, `main`; `dev` and every `codex/*` branch were deleted locally and on `origin`. Divergent history is preserved as tags `archive/v0.13.1-release`, `archive/core-distillation-v015`, `archive/thewolfwalker-patch-2`. Specify `gh -R LeonhardtHUST/dsh-notifier`; never push to `THEWOLFWALKER/dsh-notifier`.
- Node `>=22`, ESM, zero mandatory runtime dependencies, no build. 28 outbound adapters (two local) and six inbound control transports.

## Validation type:progress

- Host smoke on the installed rc.5: `node test/host/harness.smoke.mjs` 19/19 (web route 401 behind Connection admission, headless activation plus a real local webhook POST, Cordis event-context 9/9). The same run first reproduced the manifest gate: `engines.dsh: 0.2.2-rc.3` made the rc.5 host skip the bundle without an exemption request; the rc.5 declaration fixed it.
- Isolated Windows suite: 2231 total, 2230 passed, 0 failed, 1 Windows symlink skip; release, host-compatibility, matrix and npm payload guards passed. CI: macOS green; Ubuntu aborted `test/desktop-session-actions.test.mjs` ("real subprocess validates action stdout protocol", `cancelled 1`, 0 fail, 2230 pass) — the same failure exists on the 0.15.0 release commit (2026-11-19), so it is pre-existing. Cause: the observer unrefs both its child and its TTL timer, so a fast Linux runner drains the loop before the child's `close` arrives and `node --test` cancels the pending test. The test now holds one ref'd guard timer; product behavior is unchanged.
- Prior Windows 11 26H2 evidence covers native Toast sending, not the 0.15.0 OS action buttons. Linux has contract evidence only. Authenticated installed Desktop rendering/navigation and real OS action delivery remain unverified.

## Durable boundaries

- State files contain credentials and bindings; use store transactions and locking, never hand-edit a live state file. Canonical channel UI state is `channel:<type>:outbound`.
- Inbound identity is composite and source-bound. Unknown source, expired token, timeout and callback failures remain fail-closed. An attention handler's call claim is not a delivery receipt.
- Do not claim Desktop `ask_user` settlement parity or infer actual OS device behavior from contract tests. Version and compatibility authority remain the manifest and source/tests.

## Next step type:goal

With permission, install the npm artifact in a separate test environment. Exercise the authenticated overlay and Settings names, Windows click navigation, and Linux GNOME/KDE action/mute callbacks. Do not restart the active session automatically.
