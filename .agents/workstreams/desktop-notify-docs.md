# Workstream: desktop-notify-docs

- Agent identity: `client-impl | deepseek-flash worker | Windows 11, DSH 0.2.2-rc.3`
- Agent: `client-impl`
- Branch: `codex/desktop-notify-scroll`
- Status: `done`
- Start/end: `2026-11-18 -> 2026-11-18`
- Scope: Document the separate desktop-notification entry, the local/remote split, Windows 11 toast without BurntToast, the Linux notify-send/gdbus evidence gap, the silent balloon fallback limit, and the Native scroll fix evidence.
- Plan:
  1. Re-read the six allowed documents from the working tree.
  2. Add the user-facing desktop/remote split, Windows/Linux behavior, and fallback limits to both READMEs.
  3. Record the local.get/local.save DTO, the shared canonical outbound overlay, the YAML-managed disable rule, and the unchanged RPC admission in architecture.
  4. Update diagnostics, release smoke steps, remaining external gates, and recurring risks with verified and open evidence.
- Owned files: `README.md`, `README.zh-CN.md`, `docs/architecture.md`, `docs/OPERATIONS.md`, `docs/TECHNICAL_DEBT.md`, `docs/memory/risks.md`
- Do not touch: `.agents/workstreams/desktop-notify-v0141.md`, `client.js`, `src/`, `test/`, release metadata, `CHANGELOG.md`, `HANDOFF.md`, history/audit documents.
- Validation: manual consistency check against `src/adapters/desktop.mjs`, `src/control-surface/local.mjs`, `src/control-surface/service.mjs`, and `src/control-surface/outbound-config.mjs`; humanizer pass on new prose; no code tests.
- Adversarial review: evidence labels separated (Windows real-machine run versus Linux contract tests only); the balloon fallback's missing audio control stated; version and test-count lines left for the lead.
- Handoff: Docs-only change, no commit. Remaining gaps: one installed-DSH-GUI end-to-end run (direct browser access needs authentication) and one real Linux desktop run.
