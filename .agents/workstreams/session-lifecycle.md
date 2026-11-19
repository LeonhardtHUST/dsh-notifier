# Workstream: session-lifecycle

- Agent identity: `lifecycle | deepseek-flash worker | Windows 11 / DSH 0.2.2-rc.3 Desktop`
- Agent: `lifecycle`
- Branch: `codex/session-notifications`
- Status: active
- Start/end: `2026-11-19 -> active`
- Scope: Adapt real DSH todo/goal/approval/survey lifecycle events into automatic notifications with session metadata and explicit categories, without changing inbound authorization.
- Plan: 1) verify the installed DSH 0.2.2-rc.3 event and tool payloads (session/event vocabulary, todo/goal tools, approval, user-questions); 2) add a pure `src/host/lifecycle.mjs` mapper (todo whole-list diff, goal operation mapping, approval/survey intents); 3) thread `sessionId`/`sessionTitle`/`category` and the remote-card gate through `event-listener.mjs`; 4) cover malformed payloads, cancellation/clear, duplicate events and missing state in a dedicated test file; 5) focused tests plus full `npm test`; 6) adversarial review and workstream close-out.
- Owned files: `.agents/workstreams/session-lifecycle.md`, `src/host-events.mjs`, `src/event-listener.mjs`, `src/host/lifecycle.mjs` (new), `test/session-lifecycle-notifications.test.mjs` (new)
- Do not touch: `src/index.mjs`, `src/notify.mjs`, `src/config.mjs`, `src/strings.mjs`, client/desktop/admin files, approval and question routers, `HANDOFF.md`, release metadata.
- Validation: `node --check src/host/lifecycle.mjs`; `node --check src/event-listener.mjs`; `node --test test/session-lifecycle-notifications.test.mjs test/event-listener.test.mjs test/host-events.test.mjs`; `npm test`; `node scripts/verify-release.mjs`
- Host evidence (installed `@deepseek-ai/dsh@0.2.2-rc.3` in `app.asar`): `dsh-session/src/known-event-types.ts` lists `todo/write`, `goal/change`, `approval/asked`, `approval/decided`. `todo/write` is a whole-list snapshot `{ todos: Array<{ content, status: 'pending'|'in_progress'|'completed' }> }` with no id and no cancelled/paused status; removal from the list is the only cancellation signal. `goal/change` is a full snapshot with `operation: 'create'|'edit'|'pause'|'resume'|'complete'|'block'|'clear'` and a `goal` snapshot (`phase: 'active'|'paused'|'blocked'|'complete'`, `blockedReason?`) or a clear tombstone. `approval/asked` carries `{ id, toolName, callId?, reason? }`. No `survey` event exists in the installed host: `ask_user_question` is `dsh-tool-ask-user` → `ctx.userQuestions.ask()` → `user-questions/request` waterfall, observable via `tool/call`/`tool/result` with `name: 'ask_user_question'`.
- Adversarial review: pending.
- Handoff: pending.
