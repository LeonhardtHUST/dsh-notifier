# Workstream: desktop-notify-v0141

- Agent identity: `lead | DSH Agent Teams (Opus lead continued by Sol; three Flash implementers and one Sol read-only reviewer) | Windows 11 26H2, DSH desktop 0.2.2-rc.3`
- Agent: `lead`
- Branch: `codex/desktop-notify-scroll`
- Status: `done`
- Start/end: `2026-11-17 -> 2026-11-18`
- Scope: Fix the Native panel scroll lock and separate local desktop notifications from remote channels, prioritizing Windows 11 and the freedesktop path for GNOME/KDE.
- Plan: inspect host geometry and reference -> implement disjoint adapter/server/client scopes -> independent adversarial review -> repair -> focused/full gates -> source commits -> release metadata -> fork dev/main -> npm OIDC and GitHub Release verification.
- Owned files: `client.js`; `src/adapters/desktop.mjs`; `src/config.mjs`; `src/control-surface/{local,service,channels,outbound-config,activity}.mjs`; `src/index.mjs` wiring; matching tests; release docs/metadata.
- Do not touch: inbound, approval, questions, admin listener bind, running DSH profile, upstream remote.
- Validation: `npm test` 2137 pass / 0 fail / 0 skip (including the final gdbus option terminator); release/host/matrix/syntax guards pass; npm payload guard 322 files, no dev-tool directories; `git diff --check` clean.
- Adversarial review: Sol static review passed after fixing empty base64, YAML zero-option ownership/testing, canonical revoke snapshot resurrection, strict read failures, unsupported/YAML switch guards and public diagnostics. Lead verified source/test diff and ran the commands that the read-only reviewer could not run.
- Device/layout evidence: Windows 11 WinRT send succeeded with DSH AUMID, literal injection payload, silent XML, empty text and maximum-length PowerShell scripts. Browser reproduction of rc3 main geometry: old 1532px content had no scroller; new 565px viewport scrollTop advanced to 400. Linux/installed authenticated Native GUI end-to-end remain unverified.
- Decisions: replace slow Get-StartApps probe with cached Start-menu shortcut existence; do not mutate registry or create shortcuts; preserve resolved defaults only while canonical overlay exists; no new authentication/listener/store.
- Known limits: NotifyIcon fallback cannot enforce mute; Linux freedesktop tests are contract-level; native notification acceptance is not user-visible delivery confirmation.
- Commits/publication: `dc7106c`, `d788898`, `9819e90`, `58507ac`; tag `v0.14.1` immutable at `58507ac`. Fork dev/main pushed, CI Ubuntu/macOS green, OIDC release `44130646586` green after registry propagation recovery, GitHub Release public. Registry integrity matches local pack; SLSA source repository/commit matched; downloaded artifact import smoke passed. No upstream write.
- Handoff: see root HANDOFF and docs/memory/project-state; package version is 0.14.1, target DSH remains exact rc.3. Native configuration saves remain Hot Apply.
