import { transactDurable } from '../inbound/store.mjs'
import { maskSecrets } from '../redact.mjs'

export const SETTINGS_KEY = 'local:session-notifications'
export const MUTES_KEY = 'local:session-mutes'
export const DESTINATIONS = Object.freeze(['overlay', 'system', 'remote'])
export const CATEGORIES = Object.freeze([
  'session.approval', 'session.survey', 'session.completed', 'session.cancelled', 'session.error',
  'session.started', 'session.status', 'session.message',
  'todo.completed', 'todo.cancelled', 'todo.changed', 'todo.paused',
  'goal.completed', 'goal.cancelled', 'goal.changed', 'goal.paused',
])
const MODES = ['always', 'focused', 'away', 'never']
const DEFAULT_MUTE_MINUTES = Object.freeze([5, 10, 15, 30, 'always'])
const DEFAULT_OVERLAY = Object.freeze({ position: 'top-right', animation: 'down', stack: true, stackDirection: 'down' })
const OVERLAY_OPTIONS = {
  position: ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'],
  animation: ['up', 'down', 'left', 'right', 'fade', 'none'],
  stack: [true, false],
  stackDirection: ['down', 'up'],
}
const DEFAULT_RULES = Object.fromEntries(CATEGORIES.map(category => {
  const off = category.startsWith('todo.') || category.startsWith('goal.')
    ? category.endsWith('.changed') || category.endsWith('.paused')
    : false
  return [category, off ? { overlay: 'never', system: 'never', remote: 'never' }
    : { overlay: 'focused', system: 'always', remote: ['session.message', 'session.approval', 'session.survey'].includes(category) ? 'always' : 'default' }]
}))
const MUTE_LIMIT = 250
const FEED_LIMIT = 100
const FEED_TTL = 90_000
const own = (value, key) => Object.hasOwn(value, key)
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const issue = (code, message) => Object.assign(new Error(message), { code })
const bad = message => issue('bad-request', message)
const isAttention = category => category === 'session.approval' || category === 'session.survey'
const validMode = (value, dest, category) => MODES.includes(value) || (dest === 'remote' && value === 'default' && !isAttention(category))
const validMinutes = value => value === 'always' || (Number.isInteger(value) && value >= 1 && value <= 10_080)
export const validSessionId = value => typeof value === 'string' && /^[\p{L}\p{N}_-][\p{L}\p{N}_.:-]{0,159}$/u.test(value)
const bounded = (value, limit) => typeof value === 'string' ? value.slice(0, limit).trim() : ''
const cleanTitle = value => typeof value === 'string'
  ? bounded(maskSecrets(value).replace(/[\p{Cc}\p{Cf}]/gu, ' '), 160) : ''
const titleFor = (sessionId, title) => cleanTitle(title) || sessionId

function normalizeSettings(value) {
  const raw = record(value)
  const rules = {}
  for (const category of CATEGORIES) {
    const row = record(record(raw.rules)[category])
    rules[category] = Object.fromEntries(DESTINATIONS.map(dest => [dest,
      validMode(row[dest], dest, category) ? row[dest] : DEFAULT_RULES[category][dest]]))
  }
  const overlay = { ...DEFAULT_OVERLAY }
  for (const [key, allowed] of Object.entries(OVERLAY_OPTIONS)) {
    const candidate = record(raw.overlay)[key]
    if (allowed.includes(candidate)) overlay[key] = candidate
  }
  const muteMinutes = Array.isArray(raw.muteMinutes) && raw.muteMinutes.length > 0 && raw.muteMinutes.length <= 8
    && raw.muteMinutes.every(validMinutes) ? [...new Set(raw.muteMinutes)] : [...DEFAULT_MUTE_MINUTES]
  return { rules, overlay, muteMinutes }
}

function validatePatch(patch) {
  if (!object(patch) || Object.keys(patch).length === 0) throw bad('通知设置不能为空')
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'muteMinutes') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 8 || !value.every(validMinutes)
        || new Set(value).size !== value.length) throw bad('静音档位须为 1–10080 分钟或 always，最多 8 个且不能重复')
    } else if (key === 'overlay') {
      if (!object(value) || !Object.keys(value).length || Object.entries(value).some(([name, item]) => (
        !own(OVERLAY_OPTIONS, name) || !OVERLAY_OPTIONS[name].includes(item)
      ))) throw bad('浮层设置无效')
    } else if (key === 'rules') {
      if (!object(value) || !Object.keys(value).length) throw bad('通知规则不能为空')
      for (const [category, row] of Object.entries(value)) {
        if (!CATEGORIES.includes(category) || !object(row) || !Object.keys(row).length ||
          Object.entries(row).some(([dest, mode]) => !DESTINATIONS.includes(dest) || !validMode(mode, dest, category))) {
          throw bad('通知类别、投递方式或焦点规则无效')
        }
      }
    } else throw bad('未知的通知设置项')
  }
}

export function modeAllows(mode, focused) {
  return mode === 'always' || (mode === 'focused' && focused === true) || (mode === 'away' && focused !== true)
}

/** Build only from the actual Host listener, never from an incoming HTTP Host header. */
export function sessionLinkOf(server, sessionId) {
  if (!validSessionId(sessionId) || server?.protocol !== 'http:' || !Number.isInteger(server.port)
    || server.port < 1 || server.port > 65_535 || !['127.0.0.1', '::1'].includes(server.host)) return {}
  const host = server.host === '::1' ? '[::1]' : server.host
  const sessionOrigin = new URL(`http://${host}:${server.port}`).origin
  return { sessionOrigin, sessionUrl: `${sessionOrigin}/#dsh-notifier-session=${encodeURIComponent(sessionId)}` }
}

function activeMute(value, at) {
  return validSessionId(value?.sessionId) && (value.until === null || (Number.isSafeInteger(value.until) && value.until > at))
}

function activeMutes(raw, at) {
  return Array.isArray(raw) ? raw.filter(value => activeMute(value, at)).slice(-MUTE_LIMIT).map(value => ({
    sessionId: value.sessionId, sessionTitle: titleFor(value.sessionId, value.sessionTitle), until: value.until,
  })) : []
}

/** One policy/state owner for overlay, OS and ordinary remote session notifications. */
export function createSessionNotifications({ store, revision, presence, now = Date.now, sessionActions, warn } = {}) {
  const feed = []
  let cursor = 0
  let disposed = false
  const knownTitles = new Map()
  const report = () => { try { warn?.('Session notification preferences could not be read') } catch {} }
  const read = key => { try { return store?.get?.(key) } catch { report(); return undefined } }
  const isMuted = (sessionId, at = now()) => {
    const mutes = read(MUTES_KEY)
    return Array.isArray(mutes) && mutes.some(row => row?.sessionId === sessionId && activeMute(row, at))
  }
  const prune = at => {
    while (feed.length > FEED_LIMIT || (feed.length && at - feed[0].createdAt >= FEED_TTL)) feed.shift()
  }
  const epoch = () => revision?.current?.()?.epoch
  const touch = () => { if (!disposed) revision?.touch?.('notifications') }

  function get({ after, epoch: requestedEpoch } = {}) {
    const at = now()
    prune(at)
    const settings = normalizeSettings(read(SETTINGS_KEY))
    const muted = activeMutes(read(MUTES_KEY), at)
    const blocked = new Set(muted.map(row => row.sessionId))
    const hasCursor = Number.isSafeInteger(after) && after >= 0 && after <= cursor && requestedEpoch === epoch()
    return { settings, muted, cursor, items: hasCursor ? feed.filter(item => item.id > after && !blocked.has(item.sessionId))
      .flatMap(item => {
        const mode = settings.rules[item.category].overlay
        return mode === 'never' ? [] : [{ ...item, mode }]
      }) : [] }
  }

  function transaction(mutator) {
    if (disposed) throw issue('not-supported', '通知设置已卸载')
    let refused
    const result = transactDurable(store, draft => {
      try { mutator(draft) } catch (error) { refused = error; throw error }
      return true
    })
    if (refused) throw refused
    if (!result.committed) throw issue('storage-failed', '通知设置未保存：无法持久化')
    touch()
    return get()
  }

  function save(patch) {
    validatePatch(patch)
    return transaction(draft => {
      const settings = normalizeSettings(draft[SETTINGS_KEY])
      for (const [category, row] of Object.entries(patch.rules ?? {})) Object.assign(settings.rules[category], row)
      Object.assign(settings.overlay, patch.overlay)
      if (patch.muteMinutes) settings.muteMinutes = [...patch.muteMinutes]
      draft[SETTINGS_KEY] = settings
    })
  }

  function mute(input, preferredTitle) {
    if (!object(input) || !validSessionId(input.sessionId) || !own(input, 'minutes') ||
      !(input.minutes === null || validMinutes(input.minutes))) throw bad('无效的会话或静音时长')
    const { sessionId, minutes } = input
    const at = now()
    const result = transaction(draft => {
      const rows = activeMutes(draft[MUTES_KEY], at)
      const existing = rows.find(row => row.sessionId === sessionId)
      const next = rows.filter(row => row.sessionId !== sessionId)
      if (minutes !== null) {
        if (!normalizeSettings(draft[SETTINGS_KEY]).muteMinutes.includes(minutes)) throw bad('此静音档位已变更')
        if (!existing && !knownTitles.has(sessionId) && !preferredTitle) throw issue('not-found', '没有此会话的通知可静音')
        if (next.length >= MUTE_LIMIT) throw issue('conflict', '已达静音会话上限，请先取消部分静音')
        next.push({ sessionId, sessionTitle: titleFor(sessionId, cleanTitle(preferredTitle) || knownTitles.get(sessionId) || existing?.sessionTitle),
          until: minutes === 'always' ? null : at + minutes * 60_000 })
      }
      draft[MUTES_KEY] = next
    })
    // Never resurrect already hidden notifications if a mute is subsequently removed or expires.
    if (minutes !== null) {
      for (let i = feed.length - 1; i >= 0; i--) if (feed[i].sessionId === sessionId) feed.splice(i, 1)
    }
    return result
  }

  function decide(meta) {
    if (disposed || !validSessionId(meta?.sessionId) || !CATEGORIES.includes(meta?.category)) return null
    const { sessionId, category } = meta
    const settings = normalizeSettings(read(SETTINGS_KEY))
    const rules = settings.rules[category]
    const presenceView = presence?.view?.()
    const focused = presenceView?.evidence?.focus === 'focused'
    const localEvidence = presenceView?.evidence?.source === 'desktop' || presenceView?.reasons?.includes('wake')
    const sessionTitle = titleFor(sessionId, meta.sessionTitle)
    const muted = isMuted(sessionId)
    return {
      sessionId, sessionTitle, category, muted,
      overlay: muted ? 'never' : rules.overlay,
      system: !muted && modeAllows(rules.system, focused),
      remote: !muted && (rules.remote === 'default' || modeAllows(rules.remote, focused)),
      suppressRemote: !muted && rules.remote === 'default' && localEvidence === true && presenceView?.suppressing === true,
      muteMinutes: settings.muteMinutes,
    }
  }

  function observe(decision) {
    if (decision.muted) return
    knownTitles.delete(decision.sessionId)
    knownTitles.set(decision.sessionId, decision.sessionTitle)
    if (knownTitles.size > 2 * MUTE_LIMIT) knownTitles.delete(knownTitles.keys().next().value)
  }

  function publish(decision, message) {
    if (disposed || decision.overlay === 'never') return false
    const at = now()
    feed.push({ id: ++cursor, sessionId: decision.sessionId, sessionTitle: decision.sessionTitle, category: decision.category,
      title: cleanTitle(message.title), body: bounded(maskSecrets(message.content), 2000),
      level: bounded(message.level, 32), createdAt: at })
    prune(at)
    touch()
    return true
  }

  function deliveryOptions(decision) {
    let open = {}
    try { open = sessionActions?.(decision.sessionId) ?? {} } catch { /* textual delivery remains available */ }
    return {
      ...open, sessionId: decision.sessionId, sessionTitle: decision.sessionTitle, muteMinutes: [...decision.muteMinutes],
      onMute: minutes => {
        if (minutes === null || !decision.muteMinutes.includes(minutes)) return false
        try { mute({ sessionId: decision.sessionId, minutes }, decision.sessionTitle); return true } catch { return false }
      },
      isMuted: () => disposed || isMuted(decision.sessionId),
    }
  }

  return { get, save, mute, decide, observe, publish, deliveryOptions, isMuted, dispose() { disposed = true; feed.length = 0; knownTitles.clear() } }
}
