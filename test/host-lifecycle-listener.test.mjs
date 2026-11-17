// Focused regression for the host-event listener contract (#46 side finding).
//
// Two invariants are locked here:
//   1. host-events.mjs always returns a Promise from a registered listener while
//      keeping the listener's synchronous side effects synchronous (a host that
//      calls `callback(...).catch(...)` must not crash on `undefined`).
//   2. the direct `agent/created` / `agent/disposed` listeners in
//      inbound/conversation.mjs follow the same contract.
//
// The EventContext double below mirrors Cordis dispatch semantics the host relies
// on (callback registration + callback invocation); the real-Cordis variant is
// exercised by test/host/event-context.smoke.mjs on the installed host.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostEventRegistrar } from '../src/host-events.mjs'
import { registerConversationRouter } from '../src/inbound/conversation.mjs'
import { createInboundBus } from '../src/inbound/bus.mjs'
import { createStore } from '../src/inbound/store.mjs'

// Keep defaultStateDir()/store fallbacks away from the developer's real ~/.dsh.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-notifier-host-events-'))

/** Minimal Cordis-like EventContext: on() returns a disposer, dispatch() invokes. */
function fakeContext() {
  const hooks = new Map()
  const ctx = {
    hooks,
    /** Mirror the host's `ctx.events.dispatch('emit', args)` callback enumeration. */
    callbacks(event) {
      return [...(hooks.get(event) ?? [])].map((entry) => entry.handler)
    },
    on(event, handler, options) {
      const list = hooks.get(event) ?? []
      list.push({ handler, options })
      hooks.set(event, list)
      return () => {
        hooks.set(event, (hooks.get(event) ?? []).filter((entry) => entry.handler !== handler))
      }
    },
  }
  return ctx
}

function registrarRig() {
  const ctx = fakeContext()
  const warnings = []
  const registrar = createHostEventRegistrar(ctx, (message) => warnings.push(String(message)))
  return { ctx, warnings, registrar }
}

test('host events: a sync listener runs synchronously and returns a thenable for .catch hosts', async () => {
  const { ctx, registrar } = registrarRig()
  let observed = null
  const dispose = registrar.on('agent/disposed', (payload) => {
    observed = payload.agent.id
  })

  const [callback] = ctx.callbacks('agent/disposed')
  assert.equal(typeof callback, 'function')

  const returned = callback({ agent: { id: 'agent-1' } })
  assert.equal(observed, 'agent-1', 'the listener body must run before the wrapper returns (no microtask deferral)')
  assert.equal(typeof returned?.then, 'function', 'the wrapper must return a Promise for legacy .catch hosts')

  // An old host that chains `.catch` directly must work; awaiting must settle.
  await returned.catch(() => {
    assert.fail('a resolved listener must not reject')
  })
  dispose()
  assert.equal(ctx.callbacks('agent/disposed').length, 0, 'the disposer removes the registration')
})

test('host events: a throwing sync listener is contained and reported, never thrown to the host', async () => {
  const { ctx, warnings, registrar } = registrarRig()
  const dispose = registrar.on('session/event', () => {
    throw new TypeError('sync boom')
  })

  const [callback] = ctx.callbacks('session/event')
  const returned = callback({ id: 's1' }, { type: 'turn/start', seq: 1 })
  assert.equal(typeof returned?.then, 'function')
  await returned
  assert.equal(warnings.some((line) => /宿主事件处理失败/.test(line)), true)
  dispose()
})

test('host events: a rejecting listener is contained (no unhandled rejection) and reported', async () => {
  const { ctx, warnings, registrar } = registrarRig()
  const dispose = registrar.on('agent/error', async () => {
    const error = new Error('async boom')
    error.name = 'BoomError'
    throw error
  })

  const [callback] = ctx.callbacks('agent/error')
  const returned = callback({ agent: { id: 'agent-2' } })
  assert.equal(typeof returned?.then, 'function')
  await returned // must resolve, not reject
  assert.equal(warnings.some((line) => /BoomError/.test(line)), true)
  dispose()
})

test('host events: lifecycle payloads survive the wrapper (no argument loss)', async () => {
  const { ctx, registrar } = registrarRig()
  const seen = []
  const dispose = registrar.on('agent/disposed', (payload) => {
    seen.push(payload.agent.id)
    return undefined
  })
  const [callback] = ctx.callbacks('agent/disposed')
  await callback({ agent: { id: 'agent-3' } })
  await callback({ agent: { id: 'agent-4' } })
  assert.deepEqual(seen, ['agent-3', 'agent-4'])
  dispose()
})

test('conversation lifecycle: agent/created and agent/disposed listeners run synchronously and return thenables', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-conv-lifecycle-'))
  const store = createStore(join(stateDir, 'state.json'))
  const bus = createInboundBus({ allowUsers: ['42'], store })
  const ctx = fakeContext()
  let rootsCalls = 0
  ctx.agents = {
    get: () => undefined,
    list: () => [],
    roots: () => {
      rootsCalls += 1
      return []
    },
  }

  const dispose = registerConversationRouter({ ctx, bus, store, logger: null })
  try {
    const created = ctx.callbacks('agent/created')
    const disposed = ctx.callbacks('agent/disposed')
    assert.equal(created.length, 1)
    assert.equal(disposed.length, 1)

    const createdReturned = created[0]({ agent: { id: 'session-1' } })
    assert.equal(rootsCalls, 1, 'the created listener body runs synchronously (root check included)')
    assert.equal(typeof createdReturned?.then, 'function', 'agent/created must return a Promise')

    const disposedReturned = disposed[0]({ agent: { id: 'session-1' } })
    assert.equal(typeof disposedReturned?.then, 'function', 'agent/disposed must return a Promise')
    await Promise.all([createdReturned, disposedReturned])
  } finally {
    dispose()
  }
})
