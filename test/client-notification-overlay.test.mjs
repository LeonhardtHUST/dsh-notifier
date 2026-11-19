import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function harness({ call, page = { visibilityState: 'visible', hasFocus: () => true }, effects = [] } = {}) {
  let registration
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace("inject: ['slots', 'connection', 'locale', 'layout', 'uiWorkspace'],", "__test: { installSessionActivation, createController, NotificationOverlay, NotificationCard, NotificationSettings, allowsOverlay, overlayOptions, CSS }, inject: ['slots', 'connection', 'locale', 'layout', 'uiWorkspace'],")
  const timers = new Map()
  let timerId = 0
  const React = {
    Component: class {}, createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: fn => fn, useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: value => [value, () => {}], useEffect: fn => effects.push(fn), useSyncExternalStore: (_, read) => read(),
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value } } }, document: page, setInterval: () => 1, clearInterval() {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id), AbortController, console })
  const mod = registration.factory(name => { assert.equal(name, 'react'); return React })
  const calls = []
  const opened = []
  const ctx = { locale: { current: 'en' }, uiWorkspace: { openSession: id => opened.push(id) }, connection: { rpc: { call: async (_, endpoint, payload) => { calls.push({ endpoint, payload: JSON.parse(JSON.stringify(payload)) }); return { ok: true, value: await call?.(endpoint, payload) } } } } }
  return { ...mod.__test, ctx, calls, opened, timers, effects }
}
const settings = { rules: { 'session.completed': { overlay: 'focused', system: 'always', remote: 'default' } }, overlay: { position: 'top-right', animation: 'down', stack: true, stackDirection: 'down' }, muteMinutes: [5, 30, 'always'] }
const item = (id, mode = 'focused', sessionId = 's1') => ({ id, sessionId, sessionTitle: 'Session', title: 'Done', body: 'Result', category: 'session.completed', mode, createdAt: Date.now() })
const view = (cursor, items = [], extra = {}) => ({ epoch: 'e1', revision: cursor, cursor, settings, muted: [], items, ...extra })
function nodes(tree, predicate) { const found = []; function walk(n) { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) return n.forEach(walk); if (predicate(n)) found.push(n); walk(n.children) } walk(tree); return found }

test('overlay baseline never replays; incremental requests carry epoch and cursor, deduplicate and cap', async () => {
  let response = view(1, [item(1)])
  const h = harness({ call: () => response }); const c = h.createController(h.ctx)
  await c.loadNotifications(); assert.equal(c.getSnapshot().notices.length, 0)
  response = view(6, [1, 2, 3, 4, 5, 6].map(id => item(id)))
  await c.loadNotifications(); assert.deepEqual(h.calls[1].payload, { after: 1, epoch: 'e1' })
  assert.deepEqual(Array.from(c.getSnapshot().notices, row => row.id), [6, 5, 4, 3])
  await c.loadNotifications(); assert.equal(c.getSnapshot().notices.length, 4)
  response = view(7, [item(7)], { settings: { ...settings, overlay: { stack: false } } })
  await c.loadNotifications(); assert.deepEqual(Array.from(c.getSnapshot().notices, row => row.id), [7]); c.dispose()
})
test('renderer uses its own live focus and visibility for every delivery mode', () => {
  const h = harness(); const page = { visibilityState: 'visible', hasFocus: () => false }
  assert.equal(h.allowsOverlay('focused', page), false); assert.equal(h.allowsOverlay('away', page), true)
  assert.equal(h.allowsOverlay('always', page), true); assert.equal(h.allowsOverlay('never', page), false)
  page.visibilityState = 'hidden'; assert.equal(h.allowsOverlay('always', page), false)
  assert.equal(h.allowsOverlay('focused', { visibilityState: 'visible', hasFocus() { throw Error('focus unavailable') } }), false)
})
test('restart, fresh baseline and muted sessions cannot replay or leak old notifications', async () => {
  let response = view(0); const h = harness({ call: () => response }); const c = h.createController(h.ctx)
  await c.loadNotifications(); response = view(1, [item(1)]); await c.loadNotifications(); assert.equal(c.getSnapshot().notices.length, 1)
  response = view(1, [item(1)], { epoch: 'e2' }); await c.loadNotifications(); assert.equal(c.getSnapshot().notices.length, 0)
  response = view(2, [item(2)], { muted: [{ sessionId: 's1', until: null }] }); await c.loadNotifications(); assert.equal(c.getSnapshot().notices.length, 0)
  response = view(3, [item(3)]); await c.loadNotifications({ baseline: true }); assert.equal(c.getSnapshot().notices.length, 0); c.dispose()
})
test('session actions invoke real UI navigation and exact mute RPC, and dispose safely', async () => {
  const h = harness({ call: () => view(1) }); const c = h.createController(h.ctx)
  c.openNotice(item(1)); assert.deepEqual(h.opened, ['s1'])
  await c.muteSession('s1', 'always'); assert.deepEqual(h.calls[0], { endpoint: 'notifications.mute', payload: { sessionId: 's1', minutes: 'always' } })
  await c.muteSession('s1', null); assert.equal(h.calls.findLast(row => row.endpoint === 'notifications.mute').payload.minutes, null)
  await c.saveNotifications({ overlay: { position: 'bottom-left' } }); assert.equal(h.calls.find(row => row.endpoint === 'notifications.save').payload.overlay.position, 'bottom-left')
  c.dispose()
})
test('card menu is keyboard native, timeout is cleaned up, body navigation is separate from mute', async () => {
  const h = harness(); const actions = []; const controller = { dismissNotice: id => actions.push(['dismiss', id]), openNotice: row => actions.push(['open', row.id]), muteSession: async (id, minutes) => actions.push(['mute', id, minutes]) }
  const tree = h.NotificationCard({ ctx: h.ctx, controller, row: item(1), options: h.overlayOptions({}), minutes: [5, 'always'], busy: false })
  assert.equal(nodes(tree, n => n.type === 'details').length, 1)
  nodes(tree, n => n.props.className === 'dn-noticeOpen')[0].props.onClick(); assert.deepEqual(actions[0], ['open', 1])
  await nodes(tree, n => n.type === 'button' && n.children[0] === 'Always')[0].props.onClick()
  assert.deepEqual(actions[1], ['mute', 's1', 'always'])
  const cleanup = h.effects.at(-1)(); assert.equal(h.timers.size, 1); cleanup(); assert.equal(h.timers.size, 0)
})
test('Native settings offer all category destinations and muted-session unmute action', () => {
  const h = harness(); const tree = h.NotificationSettings({ ctx: h.ctx, controller: {}, state: { notifications: view(0, [], { muted: [{ sessionId: 's1', sessionTitle: 'Session', until: null }] }), busy: {} } })
  const selects = nodes(tree, n => n.type === 'select')
  assert.equal(selects.length, 6)
  assert.equal(selects.find(n => n.props['aria-label'] === 'Session completed: Remote').children.flat().length, 5)
  assert.equal(nodes(tree, n => n.type?.name === 'Button' && n.children.includes('Unmute')).length, 1)
})
test('plugin-owned activation waits for authenticated baseline, validates ID and strips only its own fragment', async () => {
  const h = harness(); const opened = []; const listeners = new Map(); const replaced = []
  let resolveReady
  const ready = new Promise(resolve => { resolveReady = resolve })
  const view = { location: { hash: '#dsh-notifier-session=session-1', pathname: '/app', search: '?local=1' }, history: { state: { x: 1 }, replaceState: (...args) => replaced.push(args) }, addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key) }
  const cleanup = h.installSessionActivation({ loadNotifications: () => ready, openNotice: row => { opened.push(row.sessionId); return true } }, view)
  assert.equal(opened.length, 0); resolveReady(); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(opened, ['session-1']); assert.equal(replaced[0][2], '/app?local=1')
  view.location.hash = '#dsh-notifier-session=https%3A%2F%2Fevil.example'; await listeners.get('hashchange')(); assert.equal(opened.length, 1)
  view.location.hash = '#other-fragment'; await listeners.get('hashchange')(); assert.equal(replaced.length, 1)
  cleanup(); assert.equal(listeners.size, 0)
})

test('placement respects host caption clearance, pointer passthrough and reduced motion', () => {
  const h = harness()
  assert.match(h.CSS, /top:var\(--dsh-frame-overlay-top,20px\)/)
  assert.match(h.CSS, /-webkit-app-region:no-drag/)
  assert.match(h.CSS, /prefers-reduced-motion:reduce\)\{\.dn-notice\{animation:none/)
  assert.equal(h.overlayOptions({ position: 'unsafe', animation: 'unsafe', stackDirection: 'unsafe' }).position, 'top-right')
})
