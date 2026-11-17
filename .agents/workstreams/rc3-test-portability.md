# Workstream: rc3 test portability

- Agent identity: `outbound-fix | deepseek-flash worker | Windows DSH Desktop`
- Agent: `outbound-fix`
- Branch: `codex/rc3-scoped-release` (shared with lead; no checkout)
- Status: done
- Start/end: `2026-11-17 -> 2026-11-17`
- Scope: remove three release-test defects without weakening assertions: two fixed-sleep timing races (`approval.test` escalation, `approval.multi` intended fallback) and one POSIX-only assumption plus legacy state fixture in `store.test`. Production `src/` untouched.
- Plan:
  1. Record the original failures and their mechanism before editing.
  2. Replace wall-clock sleeps used as synchronization with notification event latches (`Promise.withResolvers` plus an optional test-only `onBroadcast` hook on the fake notifier); keep a bounded `withDeadline` guard so a missing event fails loudly instead of hanging.
  3. Raise the intended-fallback rig's approval timeout to 5s so scheduler stalls cannot settle the approval before the numbered reply; keep the 400ms approval timeout elsewhere untouched.
  4. Store S-04: use the current schema fixture and platform-split assertions (POSIX 0644→0600 vs Windows 0666/chmod read-only semantics).
  5. Focused runs, repeated and concurrent, for stability; async-leak check; full suite stays in the lead's isolated serial slot.
- Owned files: `test/approval.test.mjs`, `test/approval.multi.test.mjs`, `test/store.test.mjs`, this workstream.
- Do not touch: production `src/` (store/approval/bus/router), other tests, package/CI/docs/other workstreams.
- Validation: `node --import ./test/_hermetic-network-guard.mjs --test test/approval.test.mjs test/approval.multi.test.mjs test/store.test.mjs`; repeated sequential runs and concurrent load runs; `node --check` on the three tests; no dangling timers (all rigs dispose in `finally`, `withDeadline` clears its timer, process exits normally).
- Adversarial review: the rewritten positive paths now fail loudly if the first escalation broadcast never arrives, the initial approval broadcast never arrives, or the numbered reply no longer decides the intended-fallback approval; the negative window still catches a second escalation firing after a decision; Windows cannot falsely claim POSIX tightening because the assertion forbids mode 0600 there.
- Handoff: fix commit `e71dd66` (`test: make approval/store timing and Windows mode deterministic`); this workstream record is the follow-up docs commit. Not pushed; the lead owns the push. Focused run under a temporary `DSH_HOME`: 59/59 pass. Three target tests never failed in repeated/concurrent stress, but one of 12 concurrent runs reported an unattributable single failure (output had been filtered); that gap is recorded as-is and flakiness is not claimed to be fully eliminated. Scope closed; no further test expansion.

## Original defects (evidence)

1. `test/approval.test.mjs:540` — baseline full run failed at line 555 with `0 !== 1` (expected one first-stage escalation broadcast). The test used `await sleep(150)` between stages at 50/400ms; under parallel-suite CPU starvation the timer may fire after the event loop resumes, so the fixed checkpoint no longer means "first stage fired, second has not".
2. `test/approval.multi.test.mjs:394` — earlier full run failed at line 412 (`assert.equal(await outcome, 'allowed-once')`) with `actual: 'desktop'` while `accepted.ok === true`; the test's reported duration was 1516.98ms, versus 69.62ms when the file runs alone. The test used a fixed 30ms wait against a rig with `timeoutMs: 400` (`makeRig` default, line 129), so the approval timeout could settle the waiter before the numbered reply was processed; the reply was then treated as an already-decided race and the outcome fell back to the desktop.
3. `test/store.test.mjs:80` — baseline full run failed at line 86 with `438 !== 420`: on Windows a normal file is `0666` and `chmod 0644/0600` cannot produce POSIX bits (verified locally: 0644→0666, 0600→0666, 0400→0444). The fixture also wrote `{ k: 1 }` without the current `__schema` marker, so T03 rightly treats `k` as non-authority and the old read assertion no longer described authority state.

## Fix

- `test/approval.test.mjs`: fake notifier gained an optional test-only `onBroadcast` hook; the escalation test awaits the first escalation broadcast through a `Promise.withResolvers` latch (microtask continuation runs before the stage-2 timer callback), then decides, asserts exactly one escalation, and keeps a 500ms negative window. `withDeadline` only guards against hangs.
- `test/approval.multi.test.mjs`: same `onBroadcast` latch for the initial failed-card broadcast, `timeoutMs: 5000` for that rig, `try/finally` dispose. The barrier is the broadcast event, not wall-clock.
- `test/store.test.mjs`: fixture is `{ __schema: { version: 1, namespace: 'dsh-notifier' }, k: 1 }` and `k` is asserted through the authoritative read path; assertions split by platform. POSIX keeps 0644→warn→0600→second boot silent. Windows asserts warn + tightening attempt, explicitly not 0600, file stays readable, and the next boot still detects the non-0600 mode (platform boundary, not a product defect).

## Validation (focused only; full suite is lead-owned)

```text
node --import ./test/_hermetic-network-guard.mjs --test \
  test/approval.test.mjs test/approval.multi.test.mjs test/store.test.mjs
  → 59/59 pass, ~14s

sequential repeat x3 → 59/59 pass each
concurrent load runs (2–4 files-run processes at once) x12 → 59/59 pass in 11 runs;
one run reported 1 failure but only the summary had been captured, so the failing
test could not be identified; every later capture run was green and the three
target tests never failed.
```

Async-leak check: all rigs dispose in `finally`; `withDeadline` clears its timer; the runner exits without lingering handles (repeat runs above completed within normal duration).

Residual: the POSIX store branch cannot execute on this Windows machine (verified semantics differ), so that branch is review-only here and will run in the lead's full suite on the same platform only if CI runs Linux later. No production behavior changed. The earlier failure mechanism matches test wall-clock assumptions; no reply-before-waiter product race was reproduced, and none is claimed fixed.

## Neat-freak

Checklist read; this is a test-only scope, so no docs/memory updates are required here.
