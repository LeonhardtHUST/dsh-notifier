#!/usr/bin/env node
// test/host/event-context.smoke.mjs — real-Cordis lifecycle-listener contract check.
//
// Run through the ASAR-aware host runtime (see test/host/README.md):
//   $env:DSH_INSTALL_DIR = <.../@deepseek-ai/dsh>
//   $env:DSH_NODE_EXECUTABLE = <.../DeepSeek Harness.exe>
//   & $env:DSH_NODE_EXECUTABLE $PWD/test/host/event-context.smoke.mjs
//
// It imports the installed @deepseek-ai/cordis (resolved from the DSH install
// anchor) and proves, against a real EventContext:
//   * host-events.mjs returns a Promise while running the listener synchronously;
//   * a legacy host chaining `.catch` on that return value does not crash;
//   * a throwing/rejecting listener is contained and reported;
//   * inbound/conversation.mjs `agent/created` / `agent/disposed` listeners return
//     Promises and keep their synchronous side effects.
//
// This is host-runtime evidence, not an npm-test unit; the plain-Node regression
// lives in test/host-lifecycle-listener.test.mjs.

import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}

function installDirFromArgs() {
  const fromArgv = process.argv[2]
  if (typeof fromArgv === 'string' && fromArgv.trim() !== '') return fromArgv
  const fromEnv = process.env.DSH_INSTALL_DIR
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : null
}

async function main() {
  const installDir = installDirFromArgs()
  if (installDir === null) {
    console.error('event-context.smoke: DSH_INSTALL_DIR (or argv[2]) is required')
    process.exitCode = 1
    return
  }
  const require = createRequire(join(installDir, 'lib', 'bin.js'))
  const cordisPath = require.resolve('@deepseek-ai/cordis')
  const { Context } = await import(pathToFileURL(cordisPath).href)
  const { createHostEventRegistrar } = await import(new URL('../../src/host-events.mjs', import.meta.url).href)
  const { registerConversationRouter } = await import(new URL('../../src/inbound/conversation.mjs', import.meta.url).href)
  const { createInboundBus } = await import(new URL('../../src/inbound/bus.mjs', import.meta.url).href)
  const { createStore } = await import(new URL('../../src/inbound/store.mjs', import.meta.url).href)
  console.log(`cordis: ${cordisPath}`)

  // ── 1. registrar wrapper on a real Cordis context ────────────────────────
  {
    const ctx = new Context()
    const warnings = []
    const registrar = createHostEventRegistrar(ctx, (message) => warnings.push(String(message)))
    let observed = null
    const dispose = registrar.on('agent/disposed', (payload) => {
      observed = payload.agent.id
    })

    const args = [ctx, 'agent/disposed', { agent: { id: 'agent-1' } }]
    const callbacks = ctx.events.dispatch('emit', args)
    record('real Cordis: registrar registers exactly one listener', callbacks.length === 1, `count=${callbacks.length}`)
    const returned = callbacks[0](...args)
    record('real Cordis: listener body ran synchronously', observed === 'agent-1')
    record('real Cordis: wrapper returns a thenable', typeof returned?.then === 'function')
    await returned.catch(() => assert.fail('resolved listener must not reject'))
    record('real Cordis: legacy .catch host does not crash', true)

    // Rejection containment.
    let rejectedRan = false
    const disposeReject = registrar.on('agent/disposed', async () => {
      rejectedRan = true
      const error = new Error('async boom')
      error.name = 'BoomError'
      throw error
    })
    const args2 = [ctx, 'agent/disposed', { agent: { id: 'agent-2' } }]
    const callbacks2 = ctx.events.dispatch('emit', args2)
    await Promise.all(callbacks2.map((callback) => callback(...args2)))
    record('real Cordis: rejecting listener is contained', rejectedRan && warnings.some((line) => /BoomError/.test(line)),
      warnings.join(' | ').slice(0, 120))
    dispose()
    disposeReject()
  }

  // ── 2. direct conversation lifecycle listeners on a real context ─────────
  {
    const stateDir = mkdtempSync(join(tmpdir(), 'dsh-notifier-rc3-event-context-'))
    const store = createStore(join(stateDir, 'state.json'))
    const bus = createInboundBus({ allowUsers: ['42'], store })
    const ctx = new Context()
    const dispose = registerConversationRouter({ ctx, bus, store, logger: null })
    try {
      const createdArgs = [ctx, 'agent/created', { agent: { id: 'session-1' } }]
      const createdCallbacks = ctx.events.dispatch('serial', createdArgs)
      record('real Cordis: conversation registered agent/created', createdCallbacks.length === 1)
      const createdReturned = createdCallbacks[0](...createdArgs)
      record('real Cordis: agent/created listener returns a Promise', typeof createdReturned?.then === 'function')

      const disposedArgs = [ctx, 'agent/disposed', { agent: { id: 'session-1' } }]
      const disposedCallbacks = ctx.events.dispatch('emit', disposedArgs)
      record('real Cordis: conversation registered agent/disposed', disposedCallbacks.length === 1)
      const disposedReturned = disposedCallbacks[0](...disposedArgs)
      record('real Cordis: agent/disposed listener returns a Promise', typeof disposedReturned?.then === 'function')
      await createdReturned
      await disposedReturned
    } finally {
      dispose()
    }
  }

  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} event-context checks passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('event-context.smoke: FAIL')
  console.error(error?.stack ?? String(error))
  process.exitCode = 1
})
