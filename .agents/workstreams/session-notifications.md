# Workstream: Session notification policy and integration

- Agent identity: `lead | DSH development team | Windows`
- Agent: `lead`
- Branch: `codex/session-notifications` (base `origin/dev`, `bf477ed`)
- Status: `done`
- Start/end: `2026-11-19 -> 2026-11-19`
- Scope: Unify overlay, system and remote session policy; add transactional mutes and bounded overlay delivery.
- Plan executed: Verify rc.3 host/OS seams; implement category modes and mutes; integrate session sources and exact attention ownership; independently review, revise and validate.
- Owned files: `src/control-surface/session-notifications.mjs`, `src/control-surface/service.mjs`, `src/notify.mjs`, `src/index.mjs`, `src/tool-register.mjs`, controlled attention delivery paths, focused policy tests, and `HANDOFF.md`.
- Validation: Isolated `npm test`: 2229 total, 2228 pass, 0 fail, 1 existing Windows symlink skip. Release guard, 28-channel matrix, `node --check src/index.mjs`, `node --check client.js` and `git diff --check origin/dev` passed. Linux subprocess action protocol and Windows XML are covered by contract tests.
- Adversarial review: Closed Linux spawn-as-acceptance, timed survey pending, focus/reload cursor, incorrect attention mode choice, keyboard/menu auto-dismiss, and hidden action error findings. Exact bridge ownership is neither receipt evidence nor authorization. Verified rc.3 Desktop custom-protocol forwarding by shipped source, not GUI automation. No new dependency, listener or authentication mode.
- Handoff: Core integration `c945d13`; UI review closeout `914a4fc`; docs `d6206bf`. Worktree is a development branch only; real Windows click, Linux desktop actions and authenticated UI remain unverified. See `HANDOFF.md` and `docs/memory/risks.md`. Neat-freak tracked documentation tiers synced; AGENTS/CLAUDE unchanged, published test and version facts preserved. Plugin memory tools are not exposed in this preset.
