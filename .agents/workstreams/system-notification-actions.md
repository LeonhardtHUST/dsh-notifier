# Workstream: system notification actions

- Agent identity: `system-actions | gpt-6.1-sol | Windows shared checkout`
- Agent: `system-actions`
- Branch: `codex/session-notifications`
- Status: `done`
- Start/end: `2026-11-19 -> 2026-11-19`
- Scope: Add native session actions where existing OS interfaces support them; preserve notification-only fallback.
- Plan completed: Inspect installed DSH protocol; confirm trusted URL/options with lead; implement native actions; challenge malformed URLs, action output, capacity and timeouts; run focused/protocol tests and full validation; record device gaps.
- Owned files: `src/adapters/desktop.mjs`, `src/adapters/desktop-actions.mjs`, `test/desktop-session-actions.test.mjs`, `.agents/workstreams/system-notification-actions.md`.
- Do not touch: Other workstreams, HANDOFF, release metadata, OS registry or shortcuts.

## Result and integration contract

`send(resolved, msg, options)` accepts trusted host metadata separately from message data. Open requires `sessionId`, `sessionOrigin` and `sessionUrl`: exact loopback HTTP origin, no userinfo/query, pathname `/`, fragment `#dsh-notifier-session=<encoded sessionId>`. The client workstream consumes that fragment after authentication. Missing trusted origin means no Open button. No credential is placed in a URL.

Windows Toast adds an explicit protocol-activation Open button. Clicking the notification body retains its existing OS/app behavior and does not promise session navigation. The existing balloon fallback has no actions. Windows Mute and macOS osascript actions remain unsupported; no registration, shortcut, callback HTTP server or mandatory dependency was added.

Linux probes notify-send `--action`/`--wait`, then starts an observer capped at eight pending processes and 60 seconds. Exact single-use stdout action IDs open via literal `xdg-open` argv or invoke the captured session-scoped callback. Configured Mute values are restricted to `[5,10,15,30,'always']`. Old CLIs and saturated observers use existing notification-only delivery; nonzero action CLI exit retries without actions. Notification server button support remains best effort; gdbus fallback has no signal observer/actions.

## Evidence and validation

- Installed Desktop `0.2.2-rc.3`, build `6b729fedde0c8fd03af7afdf5a711aa64fe87c3b`: packaged `app.asar/lib/main.js:21634-21637` registers `dsh` but recognizes only exact `dsh://open[/]` to focus the app. It exposes no session deep link.
- `node --test test/desktop-session-actions.test.mjs test/desktop.test.mjs`: 45 pass, 0 fail. Includes an actual Node subprocess emitting the action stdout protocol, injection rejection, exact origin checks, capacity, timeout, callback failure and fallback checks.
- Generated Windows Toast PowerShell parsed through `System.Management.Automation.Language.Parser`: no syntax errors; no notification displayed during validation.
- `npm test`: 2204 total, 2200 pass, 3 fail, 1 skip on the concurrent shared tree. Failures are integration assertions in `public.test.mjs:543` (new desktop channel) and `wiring.route.test.mjs:587,616` (new metadata options), reported to lead. Two earlier runs were stopped after finding and fixing a no-action microtask ordering regression; focused regression suite now passes.
- `node scripts/verify-release.mjs`, `node scripts/gen-channel-matrix.mjs --check`, `node --check src/index.mjs`, owned-file `git diff --check`: pass.

## Review, cleanup and handoff

Self-review fixed logger exception escape, callback mutation races, late output after timeout, old-CLI fallback and the no-action timer regression. Independent review is pending lead scheduling.

Neat-freak checklist read and scoped inventory completed. Root/docs changes, CHANGELOG and durable risk summary are deferred to lead because this worker owns only four files; no unrelated cleanup or HANDOFF edits. Memory tools are unavailable in this worker toolset; this workstream retains the durable protocol facts.

Real-device gaps: Windows Toast button rendering/click-to-authenticated-session, Linux notification server action display/clicks, and macOS notification delivery were not tested in this workstream. Protocol tests do not count as native device verification. Lead must finish integration assertions, client fragment handling, final full suite and independent review before release. Commit: this workstream's scoped implementation commit (see git log). No push.
