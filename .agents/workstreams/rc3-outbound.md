# Workstream: rc3 outbound immutable config

- Agent identity: `outbound-fix | deepseek-flash worker | Windows DSH Desktop`
- Agent: `outbound-fix`
- Branch: `codex/rc3-scoped-release` (shared with lead; no checkout)
- Status: done
- Start/end: `2026-11-17 -> 2026-11-17`
- Scope: fix upstream issues #45/#46 on the outbound send path. `OutboundSource` keeps JSON-cloning and deep-freezing resolved configs; qq-bot/wecom-app/desktop/serverchan runtime state moves into adapter-private WeakMaps instead of being written back into the frozen config.

## Root cause (reproduced before the fix)

`createOutboundSource()` deep-clones each resolved config with `JSON.parse(JSON.stringify(...))` and deep-freezes it; `createNotifier()` passes that frozen object to `adapter.send()`. Four adapters wrote send-time state into `resolved`, which throws `TypeError: Cannot add property ..., object is not extensible` in strict-mode ESM:

```text
qq-bot     Cannot add property _tokenManager, object is not extensible
wecom-app  Cannot add property _tokenManager, object is not extensible
desktop    Cannot add property __burntToastProbe, object is not extensible
serverchan Cannot add property _aliasConflict, object is not extensible   (multi-alias case)
```

Every send on those channels failed after the config window was frozen, so the bug looked like a total channel outage while the source contract was actually correct.

## Design

1. `resolve()` returns a pure JSON-serializable config snapshot; no `_`-prefixed runtime keys.
2. Each adapter owns a module-private `WeakMap` keyed by the resolved config object: qq-bot `{ tokenManager, rateGate, msgSeq }`; wecom-app `{ tokenManager }`; desktop `{ burntToastProbe }`; serverchan `{ aliasWarned }`.
3. The derived, non-secret serverchan `aliasConflict` name list stays in the snapshot because it must survive the JSON clone for the first send to warn; only the warn latch moved to the WeakMap.
4. Semantics preserved: token cache reuse per live config, wecom 40014/42001 forced refresh retry, qq `msg_seq` frozen during a failed attempt and advanced only after all segments succeed, desktop BurntToast probe once per config, serverchan warning once per config.
5. Hot replace = new resolved object = fresh runtime state (token re-fetch, seq restarts); retries within one send share the config object, so idempotence holds.
6. Freeze not weakened: `src/runtime/outbound-source.mjs` untouched; tests assert snapshots stay frozen after sends.

## Owned files (changed)

`src/adapters/qq-bot.mjs`, `src/adapters/wecom-app.mjs`, `src/adapters/desktop.mjs`, `src/adapters/serverchan.mjs`, `test/adapters.test.mjs` (qq-bot assertions now read request `msg_seq`; the removed internal counter is no longer asserted), `test/outbound-frozen-config.test.mjs` (new, 9 tests), this workstream.

## Validation (focused; full suite runs in the lead's serial slot)

```text
node --import ./test/_hermetic-network-guard.mjs --test test/outbound-frozen-config.test.mjs
  → 9/9 pass
node --import ./test/_hermetic-network-guard.mjs --test \
  test/outbound-frozen-config.test.mjs test/adapters.test.mjs test/desktop.test.mjs \
  test/notify.test.mjs test/outbound-source-v012.test.mjs test/contract.spec.mjs
  → 97/97 pass
node --import ./test/_hermetic-network-guard.mjs --test <13 outbound-focused files incl. assembly/config-runtime-truth>
  → 133/133 pass
node scripts/gen-channel-matrix.mjs --check
  → OK: README 渠道矩阵与注册表一致（28 渠道）
```

## Adversarial review

- Unfreezing/replacing config to hide the bug: rejected; freeze contract untouched and asserted after sends.
- State leaking across hot replace: covered by a real `OutboundConfigService.save()` → `source.replace()` test; the new snapshot re-fetches the token and restarts seq at 1.
- Retry duplication: a failed qq attempt keeps seq frozen; the next send on the same config reuses seq 1 (adapter-level and notifier-level tests).
- Cross-config token reuse: two same-type live configs keep separate token managers and seq counters.
- Desktop: probe once per config, argv-only spawn (no shell), silent sends spawn nothing.
- Serverchan: warning fires exactly once per live config even after the JSON clone.
- Residual: an in-flight send during `source.replace()` finishes on the old snapshot (old state is GC-able); no provider/real-device evidence claimed. #26 QQ label/permission msg_id real-device gap unchanged and not claimed fixed.

## Handoff

Code fix commit: `d4266b3` (this workstream record is the follow-up docs commit); not pushed yet per lead review. Next: task-4 (approval/store portability tests, plus approval.multi timing once lead extends its scope). Doc follow-up outside this scope: `ADAPTER.md` should state `resolved` is an immutable JSON snapshot and send-time state belongs to adapter-private WeakMaps; `HANDOFF.md`/`CHANGELOG.md` remain lead-owned.

## Neat-freak

Checklist read and applied to this scope: durable record only (no chat transcript), absolute date, no duplicate memory. Cross-domain docs above need the lead/owner update; not edited here.
