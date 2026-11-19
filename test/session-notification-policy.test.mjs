import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/notify.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createLocalPresence } from '../src/control-surface/presence.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSessionNotifications, MUTES_KEY, sessionLinkOf } from '../src/control-surface/session-notifications.mjs'

function harness() {
  let time = 1_000_000
  let fail = false
  let state = { unrelated: { keep: true } }
  const store = {
    get: key => state[key],
    transact(mutator) {
      const draft = structuredClone(state)
      mutator(draft)
      if (fail) return { committed: false }
      state = draft
      return { committed: true, durable: true }
    },
  }
  const revision = createSurfaceRevision({ epoch: 'test-epoch', now: () => time })
  const presence = createLocalPresence({ store, now: () => time })
  const policy = createSessionNotifications({ store, revision, presence, now: () => time })
  return { store, revision, presence, policy, advance: ms => { time += ms }, failWrites: () => { fail = true } }
}

const meta = { sessionId: 's1', sessionTitle: 'Actual conversation', category: 'session.completed' }
const message = { title: 'Turn complete', content: 'example sk-1234567890abcdefgh' }

function dispatch(policy, { desktopResult, desktopError, types = ['desktop', 'webhook'] } = {}) {
  const sends = []
  const notifier = createNotifier({ logger: { warn() {} } }, types.map(type => ({ type, config: {} })), {
    sessionNotifications: policy,
    adapters: Object.fromEntries(types.map(type => [type, { async send(_config, msg, options) {
      sends.push({ type, msg, options })
      if (type === 'desktop') {
        if (desktopError) throw new Error('local unavailable')
        return desktopResult
      }
    } }])),
  })
  return { notifier, sends }
}

function focus(presence, focused = true, source = 'desktop') {
  presence.report({ focused, visible: true, source })
}

test('baseline never replays; cursor is epoch scoped and payload is sanitized', async () => {
  const { policy, advance } = harness()
  const { notifier, sends } = dispatch(policy)
  await notifier.notifyAll(message, meta)
  assert.equal(sends[0].msg.title, 'Actual conversation · Turn complete')
  assert.equal(sends[0].options.sessionId, 's1')
  assert.equal(policy.get().items.length, 0)
  assert.equal(policy.get({ after: 0, epoch: 'old' }).items.length, 0)
  const view = policy.get({ after: 0, epoch: 'test-epoch' })
  assert.equal(view.items.length, 1)
  assert.equal(view.items[0].body, 'example ***')
  assert.equal(view.items[0].sessionTitle, 'Actual conversation')
  assert.equal(view.items[0].mode, 'focused')
  advance(90_000)
  assert.equal(policy.get({ after: 0, epoch: 'test-epoch' }).items.length, 0)
})

test('one matrix applies to system, remote and renderer overlay modes', async () => {
  const { policy, presence } = harness()
  const { notifier, sends } = dispatch(policy)
  policy.save({ rules: { 'session.completed': { overlay: 'away', system: 'focused', remote: 'away' } } })
  focus(presence)
  await notifier.notifyAll(message, meta)
  assert.deepEqual(sends.map(x => x.type), ['desktop'])
  assert.equal(notifier.canSendRemote(meta), false)
  assert.equal(policy.get({ after: 0, epoch: 'test-epoch' }).items[0].mode, 'away')
  focus(presence, false)
  await notifier.notifyAll(message, meta)
  assert.deepEqual(sends.map(x => x.type), ['desktop', 'webhook'])
  assert.equal(notifier.canSendRemote(meta), true)
})

test('legacy Default needs real local delivery and cannot suppress remote when desktop fails or is unverified', async () => {
  const { policy, presence } = harness()
  focus(presence)
  const accepted = dispatch(policy)
  assert.deepEqual((await accepted.notifier.notifyAll(message, meta)).suppressed, ['webhook'])
  const broken = dispatch(policy, { desktopError: true })
  assert.deepEqual((await broken.notifier.notifyAll(message, meta)).delivered, ['webhook'])
  const uncertain = dispatch(policy, { desktopResult: { acceptance: 'unverified' } })
  assert.deepEqual((await uncertain.notifier.notifyAll(message, meta)).delivered, ['webhook'])
  const none = dispatch(policy, { types: ['webhook'] })
  assert.deepEqual((await none.notifier.notifyAll(message, meta)).delivered, ['webhook'])
})

test('session mute blocks every destination; permanent and expiring mutes are transactional and isolated', async () => {
  const { policy, advance, store } = harness()
  const { notifier, sends } = dispatch(policy)
  await notifier.notifyAll(message, meta)
  policy.save({ muteMinutes: [2, 'always'] })
  assert.throws(() => policy.mute({ sessionId: 's1', minutes: 5 }), { code: 'bad-request' })
  policy.mute({ sessionId: 's1', sessionTitle: 'Spoofed', minutes: 2 })
  assert.equal(store.get(MUTES_KEY)[0].sessionTitle, meta.sessionTitle)
  assert.equal(store.get('unrelated').keep, true)
  sends.length = 0
  const result = await notifier.notifyAll(message, meta)
  assert.deepEqual(result.skipped, ['(session-muted)'])
  assert.equal(notifier.canSendRemote(meta), false)
  assert.equal((await notifier.notify('webhook', message, meta)).skipped, true)
  assert.deepEqual(sends, [])
  await notifier.notifyAll(message, { ...meta, sessionId: 's2' })
  policy.mute({ sessionId: 's2', minutes: 'always' })
  advance(120_000)
  assert.deepEqual(policy.get().muted.map(row => row.sessionId), ['s2'])
  assert.equal(policy.get({ after: 0, epoch: 'test-epoch' }).items.length, 0)
  policy.mute({ sessionId: 's2', minutes: null })
  assert.deepEqual(policy.get().muted, [])
})

test('authenticated service sends validated settings and refuses failed writes', async () => {
  const { policy, revision, failWrites } = harness()
  const rpc = createControlSurfaceService({ revision, sessionNotifications: policy })
  const set = await rpc.call('notifications.save', { rules: { 'todo.changed': { overlay: 'always' } }, overlay: { position: 'bottom-left' } })
  assert.equal(set.value.settings.rules['todo.changed'].overlay, 'always')
  assert.equal(set.value.settings.rules['todo.changed'].system, 'never')
  assert.equal(set.value.settings.overlay.position, 'bottom-left')
  assert.equal(set.value.epoch, 'test-epoch')
  assert.equal((await rpc.call('notifications.save', JSON.parse('{"overlay":{"__proto__":true}}'))).error.code, 'dsh-notifier/bad-request')
  assert.equal((await rpc.call('notifications.mute', { sessionId: 'unknown', minutes: 'always' })).error.code, 'dsh-notifier/not-found')
  failWrites()
  assert.equal((await rpc.call('notifications.save', { overlay: { position: 'top-left' } })).error.code, 'dsh-notifier/storage-failed')
  assert.equal((await rpc.call('notifications.get')).value.settings.overlay.position, 'bottom-left')
})

test('pending input defaults to remote always, keeps action paths in policy, and cannot enter legacy dedup mode', async () => {
  const { policy, presence } = harness()
  focus(presence)
  const { notifier } = dispatch(policy)
  for (const category of ['session.approval', 'session.survey']) {
    assert.deepEqual((await notifier.notifyAll(message, { ...meta, category })).delivered.sort(), ['desktop', 'webhook'])
    assert.throws(() => policy.save({ rules: { [category]: { remote: 'default' } } }), { code: 'bad-request' })
    policy.save({ rules: { [category]: { remote: 'away' } } })
    assert.equal(notifier.canSendRemote({ ...meta, category }), false)
  }
})

test('system links derive only from a live local webserver, never an arbitrary supplied origin', () => {
  assert.deepEqual(sessionLinkOf({ protocol: 'http:', host: '127.0.0.1', port: 29454 }, 's:1'), {
    sessionOrigin: 'http://127.0.0.1:29454', sessionUrl: 'http://127.0.0.1:29454/#dsh-notifier-session=s%3A1',
  })
  assert.deepEqual(sessionLinkOf({ protocol: 'http:', host: 'example.org', port: 29454 }, 's1'), {})
  assert.deepEqual(sessionLinkOf({ protocol: 'http:', host: '127.0.0.1', port: 0 }, 's1'), {})
  assert.deepEqual(sessionLinkOf({ protocol: 'http:', host: '127.0.0.1', port: 29454 }, 'a?b'), {})
})
