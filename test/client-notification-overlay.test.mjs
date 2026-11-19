import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function harness({ call, reactive = false, page = { visibilityState: 'visible', hasFocus: () => true }, effects = [] } = {}) {
  let registration
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace("inject: ['slots', 'connection', 'locale', 'layout', 'uiWorkspace'],", "__test: { installSessionActivation, createController, NotificationOverlay, NotificationCard, NotificationSettings, allowsOverlay, overlayOptions, CSS }, inject: ['slots', 'connection', 'locale', 'layout', 'uiWorkspace'],")
  const timers = new Map()
  let timerId = 0
  let hookIndex = 0
  const hookStates = []
  const hookEffects = []
  const pendingEffects = []
  const React = {
    Component: class {}, createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: fn => fn, useMemo: fn => fn(), useRef: value => ({ current: value }),
    useState: value => [value, () => {}], useEffect: fn => effects.push(fn), useSyncExternalStore: (_, read) => read(),
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { registration = value } } }, document: page, setInterval: () => 1, clearInterval() {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId }, clearTimeout: id => timers.delete(id), AbortController, console })
  if (reactive) {
    React.useState = initial => {
      const index = hookIndex++
      if (!(index in hookStates)) hookStates[index] = initial
      return [hookStates[index], value => { hookStates[index] = typeof value === 'function' ? value(hookStates[index]) : value }]
    }
    React.useEffect = (fn, deps) => {
      const index = hookIndex++
      const previous = hookEffects[index]
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) pendingEffects.push(() => {
        previous?.cleanup?.()
        hookEffects[index] = { deps, cleanup: fn() }
      })
    }
  }
  const render = (component, props) => {
    hookIndex = 0
    const tree = component(props)
    pendingEffects.splice(0).forEach(fn => fn())
    return tree
  }
  const mod = registration.factory(name => { assert.equal(name, 'react'); return React })
  const calls = []
  const opened = []
  const ctx = { locale: { current: 'en' }, uiWorkspace: { openSession: id => opened.push(id) }, connection: { rpc: { call: async (_, endpoint, payload) => { calls.push({ endpoint, payload: JSON.parse(JSON.stringify(payload)) }); return { ok: true, value: await call?.(endpoint, payload) } } } } }
  return { ...mod.__test, ctx, calls, opened, timers, effects, render }
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

test('attention remote settings exclude Default and cancellation has a localized label', () => {
  const h = harness(); const rules = Object.fromEntries(['session.approval', 'session.survey', 'session.cancelled'].map(category => [category, { overlay: 'focused', system: 'always', remote: 'always' }]))
  const tree = h.NotificationSettings({ ctx: h.ctx, controller: {}, state: { notifications: view(0, [], { settings: { ...settings, rules } }), busy: {} } })
  const selects = nodes(tree, n => n.type === 'select')
  for (const name of ['Approval required', 'Question required']) {
    const options = selects.find(n => n.props['aria-label'] === `${name}: Remote`).children.flat()
    assert.deepEqual(options.map(n => n.props.value), ['always', 'focused', 'away', 'never'])
  }
  assert.equal(selects.find(n => n.props['aria-label'] === 'Session cancelled: Remote').children.flat().length, 5)
})
test('explicit notification navigation supersedes startup restoration before opening a session', () => {
  const h = harness(); const events = []
  h.ctx.layout = { beginNavigation: () => events.push('cancel startup restoration') }
  h.ctx.uiWorkspace.openSession = id => events.push(`open ${id}`)
  const c = h.createController(h.ctx); c.openNotice(item(1))
  assert.deepEqual(events, ['cancel startup restoration', 'open s1']); c.dispose()
})
test('concurrent focus baselines cannot race duplicate responses or move the cursor backwards', async () => {
  let resolvePending; let count = 0
  const h = harness({ call: () => ++count === 1 ? new Promise(resolve => { resolvePending = resolve }) : view(10) })
  const c = h.createController(h.ctx)
  const initial = c.loadNotifications(); const firstFocus = c.loadNotifications({ baseline: true }); const secondFocus = c.loadNotifications({ baseline: true })
  resolvePending(view(1, [item(1)])); await Promise.all([initial, firstFocus, secondFocus])
  assert.equal(h.calls.length, 2); assert.equal(c.getSnapshot().notifications.cursor, 10); assert.equal(c.getSnapshot().notices.length, 0); c.dispose()
})

test('pointer leave cannot expire a keyboard-focused card or an open mute menu', () => {
  const h = harness({ reactive: true }); const dismissed = []
  const props = { ctx: h.ctx, controller: { dismissNotice: id => dismissed.push(id) }, row: item(1), options: h.overlayOptions({}), minutes: [5], busy: false }
  const render = () => h.render(h.NotificationCard, props)
  let tree = render(); assert.equal(h.timers.size, 1)
  tree.props.onFocus(); tree = render(); assert.equal(h.timers.size, 0)
  tree.props.onMouseEnter(); tree = render(); tree.props.onMouseLeave(); tree = render(); assert.equal(h.timers.size, 0)
  nodes(tree, n => n.type === 'details')[0].props.onToggle({ currentTarget: { open: true } }); tree = render()
  tree.props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); tree = render(); assert.equal(h.timers.size, 0)
  tree.props.onMouseLeave(); tree = render(); assert.equal(h.timers.size, 0)
  nodes(tree, n => n.type === 'details')[0].props.onToggle({ currentTarget: { open: false } }); render(); assert.equal(h.timers.size, 1)
  h.timers.values().next().value(); assert.deepEqual(dismissed, [1])
})
test('failed open and mute remain visible on their card with generic redacted errors', async () => {
  const h = harness({ reactive: true }); const props = { ctx: h.ctx, controller: { openNotice: () => false, muteSession: async () => { throw Error('secret=token') }, dismissNotice() {} }, row: item(1), options: h.overlayOptions({}), minutes: [5], busy: false }
  const render = () => h.render(h.NotificationCard, props)
  let tree = render(); const open = nodes(tree, n => n.props.className === 'dn-noticeOpen')[0]
  assert.match(open.props['aria-label'], /Done/); assert.equal(open.props['aria-describedby'], 'dn-notice-body-1')
  open.props.onClick(); tree = render()
  assert.match(nodes(tree, n => n.props.role === 'alert')[0].children[0], /Action failed/); assert.equal(h.timers.size, 0)
  await nodes(tree, n => n.type === 'button' && n.children[0] === '5 min')[0].props.onClick(); tree = render()
  const message = nodes(tree, n => n.props.role === 'alert')[0].children[0]
  assert.match(message, /retry/); assert.doesNotMatch(message, /secret|token/); assert.equal(h.timers.size, 0)
})

test('placement respects host caption clearance, pointer passthrough and reduced motion', () => {
  const h = harness()
  assert.match(h.CSS, /top:var\(--dsh-frame-overlay-top,20px\)/)
  assert.match(h.CSS, /-webkit-app-region:no-drag/)
  assert.match(h.CSS, /prefers-reduced-motion:reduce\)\{\.dn-notice\{animation:none/)
  assert.equal(h.overlayOptions({ position: 'unsafe', animation: 'unsafe', stackDirection: 'unsafe' }).position, 'top-right')
})
