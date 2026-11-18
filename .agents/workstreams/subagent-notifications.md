# Workstream: subagent notifications

- Agent identity: `subagent-filter-impl | DeepSeek Harness worker | Windows`
- Agent: `subagent-filter-impl`
- Branch: `codex/desktop-notify-scroll`
- Status: done
- Start/end: `2026-11-18 -> 2026-11-18`
- Scope: Default event notifications to root agents while retaining all/off compatibility and fail-open topology detection.
- Plan: Normalize `events.subagents`; use `ctx.agents.roots()` in event listener; filter known non-roots; add focused config/listener tests; run validation and commit.
- Owned files: `src/config.mjs`, `src/event-listener.mjs`, `test/config.test.mjs`, `test/event-listener.test.mjs`, `.agents/workstreams/subagent-notifications.md`
- Do not touch: Other source, test, documentation, release, or handoff files.
- Validation: `node --test test/config.test.mjs test/event-listener.test.mjs` — 64 passed; `npm test` — 2139 passed, 1 unrelated existing failure in `test/public.test.mjs` (desktop channel appears in expected channel list).
- Adversarial review: Unknown/missing/throwing/empty roots snapshots remain fail-open; `all` permits subagents and `off` keeps root-only compatibility.
- Handoff: Root-only normalization and listener filtering are complete. Focused tests pass. Full suite reached 2139/2140; unrelated `public.test.mjs` failure concerns concurrent local/remote desktop worktree changes. Commit follows.
