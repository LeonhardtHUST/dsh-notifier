# Architecture

## Product And UX Contract

The system is designed around the user's task, not around an internal feature inventory. A new capability should reduce user effort, make state and failure understandable, and remain safe under interruption or partial availability. Prefer progressive disclosure, sensible defaults, explicit status, reversible actions, and actionable errors. Rich functionality is welcome when it composes cleanly with existing flows; complexity that cannot be explained or maintained is a design defect.

All implementation work follows a written plan and an adversarial review loop: plan the smallest useful slice, implement it, challenge assumptions and failure paths, revise the code, then validate focused behavior and the full contract. Long-range roadmap items stay staged and evidence-driven; do not build speculative infrastructure ahead of a demonstrated need.

The sub-agent console and any admin-facing GUI are part of DSH, not a separate product. They must reuse the visual tokens, density, navigation, feedback states, responsive behavior, and interaction grammar already established in `src/admin/ui.mjs`. New screens may add domain-specific information architecture, but they must not create a competing visual language or decorative dashboard style.

The approved future product direction is documented in `docs/architecture-roadmap.md`: a personal-mode-first cross-IM control plane with a unified control core and native channel renderers. That roadmap is planning state only; current runtime behavior remains defined by `src/` and tests.

## Runtime Shape

`src/index.mjs` is the Cordis plugin assembly root. It resolves configuration, creates the shared state store, overlays admin-managed credentials when enabled, builds the notifier, and then wires optional services. The session notification policy owns the overlay/system/remote decision matrix and the bounded overlay feed; `src/host/lifecycle.mjs` maps host todo/goal/approval/survey payloads to the policy categories. Pure "decision" stages of assembly — the outbound credential overlay, the admin token strategy, and the six-channel inbound enable signals — live as documented in `src/assembly/*.mjs` (`outbound.mjs`, `admin-token.mjs`, `inbound-signals.mjs`, `inbound-channels.mjs`); `index.mjs` calls them and wires the results in place. The actions/approval/questions interaction lifecycles share one state ledger (`src/interaction/ledger.mjs`, `createInteractionLedger`) with decision-field names preserved per chain (`outcome` vs `decision`); per-chain `latestPendingFor` heuristics stay local. Inbound content normalizes to a unified text/image/file shape via `src/inbound/message.mjs` (`normalizeInboundMessage`, text-compatible); the WeChat iLink provider is isolated under `src/channels/wechat-ilink/` and enters through a compatibility facade, with account-scoped cursor/context state and protocol evidence labels. QQ C2C image parsing is wired into the inbound gateway, and QQ/WeChat iLink/DingTalk image paths are contract-tested; none has real-device evidence. Disposal is collected and executed in reverse assembly order.

```text
Cordis context
  -> config.mjs
  -> store / ledger / routing registry
  -> src/assembly/*.mjs (outbound/admin decisions, inbound signals and channel registry)
  -> createNotifier (adapters + level routing + segmentation + retry)
  -> session notification policy (overlay/system/remote matrix, mutes, bounded feed)
  -> host lifecycle mapper (todo/goal/approval/survey categories)
  -> event-listener (automatic events + turn tracker)
  -> tools (notify, notify_test, ask_user)
  -> inbound identity/pairing/bus/token stack
  -> approval/actions/questions/conversation bridges
  -> admin API/UI/SSE and scan handlers
```

## Outbound Flow

1. `resolveConfig()` validates rows, resolves `${ENV:NAME}`, and skips invalid channels without aborting startup.
2. `createNotifier()` normalizes messages and resolves level routing.
3. `routeTargets()` selects enabled channel instances; optional agent/session routing filters the result.
4. `sendSegmented()` splits long Unicode text. A partial segmented failure is marked `noRetry` so already delivered pieces are not replayed.
5. Retry policy is level-dependent: time-sensitive retries most, active retries once, passive does not retry by default.
6. Broadcast outcomes feed the ledger, admin event hub, and optional `dsh-notifier/sent` emission independently.

## Local Notification Surface

Desktop notification and terminal bell rows carry `scope: 'local'`; every other channel row is `scope: 'remote'`. `src/control-surface/local.mjs` turns the two local rows into a switch-and-options view without adding a second write path:

- `local.get` returns `{ epoch, revision, platform: { os, desktop, support, backend, detail: { en, zh } }, desktop: { type, enabled, active, managedBy, sound, health }, bell: { type, enabled, active, managedBy, count, health } }`.
- `local.save` accepts `{ type: 'desktop' | 'bell', enabled, options? }` (`sound` for desktop, `count` for bell) and returns `{ type, enabled, applied, applyMode }`.
- `surface.home` adds a reduced `local` summary (`platform.os/support`, `desktop.enabled/active`, `bell.enabled/active`). If the local projection fails, the field is omitted instead of failing the home projection.

The surface reuses the canonical outbound overlay `channel:<type>:outbound` and the shared outbound transaction (validate, resolve, persist, hot swap). There is no separate local-notification store and no second runtime authority. Disabling revokes the overlay. A row configured in `cordis.patch.yml` is the base configuration: it reports `managedBy: 'yaml'`, the Native UI disables the control, and `local.save` with `enabled: false` fails with the public code `dsh-notifier/not-supported`. The read that decides whether an overlay can be revoked is fail-closed: a store read error surfaces as `storage-failed` instead of "nothing configured", so a revoke cannot report success while an unread overlay later returns.

`local.get` and `local.save` are methods on the existing Native connection RPC channel. They use the same admission and envelope as `channels.*`, and add no authentication mode, no HTTP route, and no listener. The loopback Advanced Console and its Bearer gate are unchanged.

## Session Notification Policy

`src/control-surface/session-notifications.mjs` owns one decision for session-scoped notifications. `decide(meta)` takes `{ sessionId, sessionTitle, category }` and returns the overlay mode, whether the local rows may send (`system`), whether ordinary remote rows may send (`remote`), whether Follow presence should defer remote targets (`suppressRemote`), the active mute state and the configured mute durations.

`src/notify.mjs` applies that decision. Local channel types (`desktop`, `bell`) consult `system`; every other enabled channel consults `remote`. `notifyAll` publishes the overlay copy once, injects the session title into the message title, and falls back to the legacy `suppressRemote` option only when no decision exists. Session mutes are checked again immediately before each adapter send, so a mute written while a broadcast is in flight still blocks delivery. A desktop result of `unverified` or `suppressed` is not acceptance: Follow presence cannot drop the deferred remote targets, but the live mute check still applies.

Policy categories are `session.started`, `session.completed`, `session.cancelled`, `session.error`, `session.status`, `session.message`, `session.approval`, `session.survey`, and the todo/goal completed, cancelled, changed and paused rows. Defaults keep attention remote: approval, survey and manual messages are Always; ordinary session events and todo/goal completion use Follow presence; todo/goal changed and paused are off. `default` is rejected for approval and survey by save validation and by the UI. The event listener still applies the existing `events.turnStart`, `events.approval` and `events.agentError` switches before this policy, so the matrix routes emitted events and never acts as a second event enable switch.

`src/host/lifecycle.mjs` maps host payloads to those categories. `todo/write` is a whole-list snapshot with `pending`, `in_progress` and `completed` only; an incomplete item that disappears is cancelled and `in_progress → pending` is paused. `goal/change` maps `complete` to completed, `clear` to cancelled, `pause` and `block` to paused, and `create`, `edit` and `resume` to changed. No survey event exists on the host, so the mapper observes `tool/call` for `ask_user_question` and for the notifier's own `ask_user`. The notifier-owned path is local-only. For host approval/survey requests, a bounded exact call claim by the active remote bridge also makes the generic notice local-only. A claim indicates the bridge is handling the request, not a provider receipt. Approval `asked` events and survey tool calls are held for 1.5 seconds; a matching `approval/decided`, `tool/result` or `user-question-reply` cancels the reminder. An approval event without an id keeps the immediate path. A timed `ask_user_question` result with `{ pending: true }` or `TOOL_OUTCOME_UNKNOWN` keeps it pending.

The overlay feed is in-memory and bounded: 100 items, 90 seconds, a monotonically increasing cursor, and a revision epoch. `get({ after, epoch })` returns items only when the cursor belongs to the current epoch; a stale or missing epoch returns an empty page instead of replaying history. Titles are masked, stripped of control/format characters, and capped at 160 characters. Bodies are masked and capped at 2000 characters. Muting a session removes its queued items and filters future ones; `observe` keeps a bounded session-title map so a mute row survives without the feed.

`notifications.get`, `notifications.save` and `notifications.mute` are methods on the authenticated Native connection RPC channel opened by `src/control-surface/service.mjs`. They reuse the existing admission and envelope, add no HTTP route or authentication mode, and return the current revision/epoch with the value. Settings and mutes live under `local:session-notifications` and `local:session-mutes` and are written through the shared store transaction; a failed commit returns `storage-failed` and leaves the previous value.

System actions stay inside existing OS contracts. `sessionLinkOf` builds an origin only from the host's actual bound loopback web server, never from an incoming Host header. `src/adapters/desktop-actions.mjs` revalidates the exact origin, path `/` and the plugin-owned fragment before exposing Open. Windows uses toast `protocol` activation with that URL; Linux uses `notify-send --action` and `--wait` observers (eight pending processes, 60-second TTL) and reports an unverified receipt; macOS gets no actions. The installed Desktop app has no session deep link (`dsh://open` only focuses the app), so no desktop IPC or file-based activation is claimed.

## Inbound Trust Flow

```text
provider payload
  -> normalizeInbound / channel-specific authentication
  -> inbound bus deduplication
  -> identity allows(channel, userId)
  -> command / approval / question / conversation consumer
  -> token or trusted reply validation
  -> first-arrival settlement
  -> agent action or desktop fallback
```

The empty identity table is a guided bootstrap state: registration commands remain available, while normal business messages remain denied until pairing succeeds. Pairing codes are hashed, short-lived, rate-limited, and auditable. The guided bootstrap code is delivered through `<stateDir>/bootstrap-paircode.txt` (mode `0600`, rewritten on re-mint, deleted as soon as the code is redeemed/expired/revoked or the instance boots outside the guided state); logs and stderr carry only the file path, never the code itself. Failed pairing attempts — including submissions of an already expired code — count toward the per-`(channel, userId)` lockout, so an expired code cannot be used to pump unlimited re-mints. Callback/action/question tokens are single-use and source-scoped when a source chat is recorded. Source scoping is fail-closed on the click side since 2026-08-24 (batch C1 / P1-4): when a Telegram short reference carries an origin chat, or a Feishu card value carries `srcChat`, a callback whose own chat id cannot be read (deleted message, malformed payload, missing `context.open_chat_id`) is rejected with "go back to the original chat" instead of being allowed through. The reference is not consumed and the waiter is not settled, so the original card stays usable inside its TTL. Cards minted before the metadata existed (no origin / empty `srcChat`) keep the legacy warn-and-allow path, bounded by the 15-minute reference TTL.

Question numbered fallbacks carry target-scoped `hintTargets` records. A reply can settle only when `(channel,userId,chatId)` exactly matches a pushed card or a confirmed per-target `sendText`; a same-user wrong-chat reply is consumed with an instruction to return to the original chat and does not settle. Missing `chatId`, legacy channel-only `hintChannels`, cross-channel messages, and unconfirmed/partial delivery remain fail-closed. A channel-level `notifyAll().delivered` result is intentionally insufficient to establish a specific chat's receipt.

## Routing

Outbound resolution layers are, in order: session diff, exact agent id, workspace entry, global enabled channel pool. `channels` and `quiet` are resolved independently. Inbound resolution uses explicit conversation binding, channel default, unique active agent, then latest active session.

Persistent route keys are `route:agents`, `route:channels`, `route:sessions`, and `bind:*` compatibility records. The route CLI and admin API use the same router setters; they must not write these tables directly.

## State And Files

The shared file is `<stateDir>/state.json` (default `$DSH_HOME/dsh-notifier/state.json`, then `~/.dsh/dsh-notifier/state.json`). The store uses dirty-key merge, a lock file, mtime convergence reads, 0600 best effort permissions, and corruption backup before self-healing.

Other durable files include `ledger.jsonl`, `ledger-state.json`, and `admin-audit.jsonl` in the same state directory when those features are enabled. Credentials are masked in admin responses and must never be copied into docs, tests, or logs.

Every state key family and every in-process learning table must have a bound and a reclamation path. Persistent families are reclaimed by the `sweepOnce` pass in `src/index.mjs` (dedup window, resolved approvals/actions/questions, orphan pending rows, observe-mode retention) or by their owner's lifecycle (`bind:*` follows session-registry reclamation, `wechat:<accountId>:ctx:` caps at 256 uids; legacy `wechat:ctx:` remains for compatibility callers). In-process tables use `src/inbound/_bounded.mjs`: `setBounded` evicts the oldest entry past the cap and refreshes an updated key's freshness (LRU touch), and `createThrottledWarn` keeps eviction visible without flooding logs. Current caps are 1024 for the dingtalk (`sessionWebhooks`, `chatSenders`, `seenMsgIds`) and qq (`targetKinds`, `msgSeqs`) tables, and 256 in-flight keys for the debounce and grace queues, which fire the oldest entry early rather than dropping it. Eviction must always degrade into an existing fallback path, never into a lost notification.

## Admin Boundary

The server is a zero-dependency `node:http` wrapper around `admin/api.mjs`. It is loopback-only, requires `Authorization: Bearer`, caps request bodies at 1 MiB, caps SSE connections, and maps business errors to safe status/message responses. The UI is embedded in `src/admin/ui.mjs`; the API and CLI share the same router/store semantics.

## Extension Boundaries

- Add fixed HTTP notification channels to `src/adapters/spec-channels.mjs` plus a fixture; use a code adapter only for token exchange or multi-step control flow.
- Keep the adapter contract `resolve(cfg) -> resolved` and `send(resolved, msg) -> Promise`; the desktop adapter also accepts an optional third `options` argument for trusted session actions. Adapters without it keep the existing two-argument call.
- Inbound channels implement the shared contract and may expose optional action/question card methods; callers must always retain text/number fallbacks. The QQ transport uses explicit `INTERACTION_CREATE` key/token callbacks for single-chat cards; group targets remain text-only. Approval/question decisions stay in the shared Control Core, and `approval.parallel` is an explicit opt-in (default off) with fail-closed rejection handling.
- QQ single-chat native buttons and QQ group text fallback are contract-tested only; QQ/WeChat iLink/DingTalk image envelopes are wired and contract-tested, while real provider payload/device behavior remains unverified. The loopback Web/admin surface now offers a 阶段 2A `ask_user` settlement entry (choose/reject through Control Core, masked snapshot, Bearer-gated; see `src/questions/router.mjs` facade); desktop still has none, so dual-end sharing is not claimed.
- Other plugins consume the injected `notifier` service and `dsh-notifier/sent` event; they must declare static injection and must not push from a sent-event handler.
- Future bidirectional channels must keep transport, control semantics, and native rendering separate. External SDKs are optional and lazy-loaded only after license, maintenance, security, and dependency review; unlicensed or `UNLICENSED` code is not copied.
