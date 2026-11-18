// dsh-notifier v0.14.2 — local presence and remote-suppression policy.
//
// Why this exists: when the user is already at this computer, the local desktop
// notification is enough. Remote channels exist for when they are away. The policy
// below lets the Native panel decide "the user is here, keep it local" without
// changing what happens on machines where desktop notifications are not enabled.
//
// Capability honesty (important):
//   * `focus` is window evidence: the DSH page is visible AND focused. The web
//     build can report that from `document.visibilityState` / `window.hasFocus()`.
//   * `unlock` is an OS capability. A browser cannot see the lock screen, and the
//     DSH Desktop renderer exposes no power/session bridge today, so the web client
//     never declares it. The server accepts unlock evidence only when a client
//     explicitly declares the capability; focus is never converted into an unlock
//     claim.
//   * `wake` comes from the local host process. A suspended host returns from
//     `setInterval` with a large gap; that gap is real local evidence that the
//     machine slept, not an OS API claim. The probe is deliberately unref'ed so it
//     can never keep a headless process alive.
//
// The policy lives under its own store key (`local:remote-suppression`) so
// enabling/disabling the desktop channel never rewrites it, and every write goes
// through the existing durable transaction (setDurable) used by channel overrides.

import { transactDurable } from '../inbound/store.mjs'

export const POLICY_KEY = 'local:remote-suppression'
export const POLICY_KEYS = Object.freeze(['focus', 'unlock', 'wake'])
// Default on, per the product requirement: while the user is present, remote
// channels stay quiet. The gate is still "desktop notifications are actually
// enabled"; see notify.mjs `suppressRemote`.
export const DEFAULT_SUPPRESSION = Object.freeze({ focus: true, unlock: true, wake: true })
export const DEFAULT_FOCUS_FRESH_MS = 2 * 60_000
export const DEFAULT_UNLOCK_FRESH_MS = 5 * 60_000
export const DEFAULT_WAKE_WINDOW_MS = 5 * 60_000
export const DEFAULT_WAKE_GAP_MS = 90_000
export const DEFAULT_WAKE_INTERVAL_MS = 15_000

const SOURCES = new Set(['web', 'desktop'])
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'bad-request' })
}

function storageFailed(message, cause) {
  return Object.assign(new Error(message), { code: 'storage-failed', cause })
}

/** Normalize persisted policy: known booleans win, everything else keeps the safe default. */
function normalizePolicy(value) {
  const raw = isPlainObject(value) ? value : {}
  const policy = { ...DEFAULT_SUPPRESSION }
  for (const key of POLICY_KEYS) {
    if (typeof raw[key] === 'boolean') policy[key] = raw[key]
  }
  return policy
}

function normalizeMs(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback
}

/**
 * @param {object} [options]
 * @param {object} [options.store] - state store (get + transact). Missing store still
 *   offers defaults and rejects writes (storage-failed), so the Native panel keeps working.
 * @param {() => number} [options.now] - clock injection for tests.
 * @param {number} [options.focusFreshMs] - focus evidence older than this is "unknown";
 *   a crashed/minimized client must not keep suppressing remote notifications forever.
 * @param {number} [options.unlockFreshMs] - freshness window for capability-gated unlock evidence.
 * @param {number} [options.wakeWindowMs] - how long after a detected host wake we stay local.
 */
export function createLocalPresence({
  store,
  now = Date.now,
  focusFreshMs = DEFAULT_FOCUS_FRESH_MS,
  unlockFreshMs = DEFAULT_UNLOCK_FRESH_MS,
  wakeWindowMs = DEFAULT_WAKE_WINDOW_MS,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const focusWindow = normalizeMs(focusFreshMs, DEFAULT_FOCUS_FRESH_MS)
  const unlockWindow = normalizeMs(unlockFreshMs, DEFAULT_UNLOCK_FRESH_MS)
  const wakeWindow = normalizeMs(wakeWindowMs, DEFAULT_WAKE_WINDOW_MS)
  const at = () => {
    const value = Number(clock())
    return Number.isFinite(value) ? value : Date.now()
  }

  const readStoredPolicy = () => {
    try {
      return normalizePolicy(typeof store?.get === 'function' ? store.get(POLICY_KEY) : undefined)
    } catch {
      // A broken read must not take the Native panel down. Suppression defaults stay
      // on, but the desktop channel gate in notify.mjs still protects delivery.
      return { ...DEFAULT_SUPPRESSION }
    }
  }

  let policy = readStoredPolicy()
  // Evidence is intentionally in-memory only: presence is live state, not config.
  let evidence = {
    source: null,
    focused: false,
    visible: false,
    receivedAt: null,
    unlocked: null,
    unlockedAt: null,
    capabilities: { focus: false, unlock: false, wake: false },
  }
  let wokeAt = null

  const freshAt = (stamp, windowMs, atNow) => stamp !== null && atNow >= stamp && atNow - stamp <= windowMs

  function shouldSuppressRemote(atNow = at()) {
    const reasons = []
    if (policy.focus === true
      && freshAt(evidence.receivedAt, focusWindow, atNow)
      && evidence.focused === true
      && evidence.visible === true) {
      reasons.push('focus')
    }
    if (policy.unlock === true
      && evidence.capabilities.unlock === true
      && evidence.unlocked === true
      && freshAt(evidence.unlockedAt, unlockWindow, atNow)) {
      reasons.push('unlock')
    }
    if (policy.wake === true && freshAt(wokeAt, wakeWindow, atNow)) {
      reasons.push('wake')
    }
    return { suppress: reasons.length > 0, reasons }
  }

  function view(atNow = at()) {
    const focusFresh = freshAt(evidence.receivedAt, focusWindow, atNow)
    const unlockFresh = freshAt(evidence.unlockedAt, unlockWindow, atNow)
    const wakeFresh = freshAt(wokeAt, wakeWindow, atNow)
    const suppression = shouldSuppressRemote(atNow)
    return {
      policy: { ...policy },
      evidence: {
        focus: focusFresh ? (evidence.focused === true && evidence.visible === true ? 'focused' : 'away') : 'unknown',
        // null means "this client cannot know"; never fabricate a lock state.
        unlocked: evidence.capabilities.unlock === true ? (unlockFresh && evidence.unlocked === true) : null,
        wake: wakeFresh,
        source: evidence.source,
        at: evidence.receivedAt === null ? null : new Date(evidence.receivedAt).toISOString(),
      },
      capabilities: {
        focus: evidence.capabilities.focus === true,
        unlock: evidence.capabilities.unlock === true,
        // The host wake probe ships with this plugin; the client does not need a bridge.
        wake: true,
      },
      suppressing: suppression.suppress,
      reasons: suppression.reasons,
    }
  }

  /**
   * Accept one presence report from the Native client. Every field is validated;
   * a malformed report is rejected (bad-request) instead of silently widening the
   * suppression gate.
   */
  function report(input) {
    if (!isPlainObject(input)) throw badRequest('presence 必须是对象')
    const source = input.source === undefined ? 'web' : input.source
    if (!SOURCES.has(source)) throw badRequest('source 必须是 web 或 desktop')

    const rawCapabilities = input.capabilities === undefined ? {} : input.capabilities
    if (!isPlainObject(rawCapabilities)) throw badRequest('capabilities 必须是对象')
    for (const key of Object.keys(rawCapabilities)) {
      if (!['focus', 'unlock', 'wake'].includes(key) || typeof rawCapabilities[key] !== 'boolean') {
        throw badRequest('capabilities 只接受 focus/unlock/wake 布尔值')
      }
    }

    const visibleProvided = input.visible !== undefined
    const focusedProvided = input.focused !== undefined
    if (visibleProvided && typeof input.visible !== 'boolean') throw badRequest('visible 必须是布尔值')
    if (focusedProvided && typeof input.focused !== 'boolean') throw badRequest('focused 必须是布尔值')

    const capabilities = {
      focus: rawCapabilities.focus === true || visibleProvided || focusedProvided,
      unlock: rawCapabilities.unlock === true,
      wake: rawCapabilities.wake === true,
    }
    // The web build has only visibility/focus evidence. Refuse capability claims it
    // cannot back; accepting them would be exactly the fabricated OS capability the
    // design forbids.
    if (source === 'web' && (capabilities.unlock || capabilities.wake)) {
      throw badRequest('web 界面不能声明系统解锁/唤醒能力（只有焦点证据可用）')
    }

    let unlocked
    if (input.unlocked !== undefined) {
      if (typeof input.unlocked !== 'boolean') throw badRequest('unlocked 必须是布尔值')
      if (capabilities.unlock !== true) throw badRequest('unlocked 需要先声明 unlock 能力')
      unlocked = input.unlocked
    }
    let woke
    if (input.woke !== undefined) {
      if (typeof input.woke !== 'boolean') throw badRequest('woke 必须是布尔值')
      if (capabilities.wake !== true) throw badRequest('woke 需要先声明 wake 能力')
      woke = input.woke
    }
    if (!visibleProvided && !focusedProvided && unlocked === undefined && woke === undefined) {
      throw badRequest('presence 至少需要一个证据字段')
    }

    const reportAt = at()
    // `focused` without an explicit visibility defaults to visible; a hidden page
    // cannot be treated as "user is looking at it".
    const focusReported = visibleProvided || focusedProvided
    const visible = visibleProvided ? input.visible : (focusedProvided ? true : evidence.visible)
    const focused = focusedProvided ? (input.focused === true && visible === true) : (evidence.focused && visible)
    evidence = {
      source,
      focused,
      visible,
      // Focus freshness only advances on a focus report. An unlock/wake-only report
      // must not keep stale focus evidence alive.
      receivedAt: focusReported ? reportAt : evidence.receivedAt,
      unlocked: unlocked === undefined ? evidence.unlocked : unlocked,
      unlockedAt: unlocked === undefined ? evidence.unlockedAt : reportAt,
      capabilities,
    }
    if (woke === true) wokeAt = reportAt
    return view(reportAt)
  }

  function savePolicy(patch) {
    if (!isPlainObject(patch)) throw badRequest('policy 必须是对象')
    const keys = Object.keys(patch)
    if (keys.length === 0) throw badRequest('policy 至少需要一个字段')
    for (const key of keys) {
      if (!POLICY_KEYS.includes(key)) throw badRequest(`未知的抑制策略字段 "${key}"`)
      if (typeof patch[key] !== 'boolean') throw badRequest(`${key} 必须是布尔值`)
    }
    // Transactional read-modify-write: merge on the current draft so two hosts
    // changing different policy keys cannot erase each other, and unrelated
    // state keys are untouched (store lock/merge behavior stays authoritative).
    let committed = null
    if (typeof store?.transact === 'function') {
      const result = transactDurable(store, (draft) => {
        const next = { ...normalizePolicy(draft[POLICY_KEY]) }
        for (const key of keys) next[key] = patch[key]
        draft[POLICY_KEY] = next
        committed = next
        return true
      })
      if (result.committed !== true) throw storageFailed('远程抑制设置写入失败：未落盘，已保留当前设置')
    } else {
      const next = { ...policy }
      for (const key of keys) next[key] = patch[key]
      const written = (() => {
        try { return typeof store?.set === 'function' ? store.set(POLICY_KEY, next) !== false : false } catch { return false }
      })()
      if (written !== true) throw storageFailed('远程抑制设置写入失败：未落盘，已保留当前设置')
      committed = next
    }
    policy = { ...committed }
    return { saved: true, policy: { ...policy }, applied: true, applyMode: 'hot' }
  }

  /** Mark a host wake detected by `createHostWakeProbe`. */
  function markWake(atNow = at()) {
    const value = Number(atNow)
    wokeAt = Number.isFinite(value) ? value : at()
  }

  return {
    policy: () => ({ ...policy }),
    view,
    report,
    savePolicy,
    shouldSuppressRemote,
    markWake,
  }
}

/**
 * Pure wake-gap detector: one long timer gap means the host process was suspended.
 * Kept separate from the interval so tests can drive timestamps without wall clocks.
 */
export function createWakeDetector({ gapMs = DEFAULT_WAKE_GAP_MS } = {}) {
  const gap = normalizeMs(gapMs, DEFAULT_WAKE_GAP_MS)
  let last = null
  return {
    /** Observe a timestamp; true when the gap since the previous observation proves sleep. */
    observe(atNow) {
      const value = Number(atNow)
      if (!Number.isFinite(value)) return false
      const woke = last !== null && value - last > gap
      last = value
      return woke
    },
    reset(atNow) {
      const value = Number(atNow)
      last = Number.isFinite(value) ? value : null
    },
    gapMs: gap,
  }
}

/**
 * Host wake probe. The interval is unref'ed: it must never keep a headless DSH
 * process alive, and it only feeds local suppression state (no I/O, no logging).
 */
export function createHostWakeProbe({
  now = Date.now,
  intervalMs = DEFAULT_WAKE_INTERVAL_MS,
  gapMs = DEFAULT_WAKE_GAP_MS,
  onWake = null,
} = {}) {
  const clock = typeof now === 'function' ? now : Date.now
  const detector = createWakeDetector({ gapMs })
  detector.reset(clock())
  const timer = setInterval(() => {
    const current = clock()
    if (!detector.observe(current)) return
    try { onWake?.(current) } catch { /* wake bookkeeping never breaks the host */ }
  }, normalizeMs(intervalMs, DEFAULT_WAKE_INTERVAL_MS))
  // Node timers are objects; browser-shaped shims may return numbers.
  if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  return {
    detector,
    dispose() {
      clearInterval(timer)
    },
  }
}
