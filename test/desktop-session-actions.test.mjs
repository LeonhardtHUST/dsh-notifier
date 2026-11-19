import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { trustedSessionUrl, sessionActions, desktopActionCapabilities, startLinuxActions } from '../src/adapters/desktop-actions.mjs'
import { buildDesktopCommand } from '../src/adapters/desktop.mjs'

const options = { sessionId: 'abc', sessionOrigin: 'http://127.0.0.1:29454', sessionUrl: 'http://127.0.0.1:29454/#dsh-notifier-session=abc' }
const command = buildDesktopCommand('linux', {}, { title: '--evil; $(x)', content: 'body' })
const tick = () => new Promise((resolve) => setImmediate(resolve))
function fake() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.kill = () => { child.killed = true }
  return child
}

test('session URL requires host-derived loopback origin and exact session route without credentials', () => {
  assert.equal(trustedSessionUrl(options), options.sessionUrl)
  for (const patch of [
    { sessionOrigin: undefined }, { sessionUrl: 'dsh://session/abc' },
    { sessionUrl: 'http://127.0.0.1:29455/#dsh-notifier-session=abc' },
    { sessionUrl: 'http://secret@127.0.0.1:29454/#dsh-notifier-session=abc' },
    { sessionUrl: 'http://127.0.0.1:29454/?token=secret#dsh-notifier-session=abc' },
    { sessionUrl: 'http://127.0.0.1:29454/#dsh-notifier-session=other' },
    { sessionOrigin: 'http://attacker.invalid', sessionUrl: 'http://attacker.invalid/#dsh-notifier-session=abc' },
    { sessionOrigin: 'http://127.0.0.1:29454/path' }, { sessionId: '' },
  ]) assert.equal(trustedSessionUrl({ ...options, ...patch }), null)
})

test('capabilities honestly distinguish conditional Linux callbacks and unsupported macOS/Windows mute', () => {
  assert.equal(desktopActionCapabilities('darwin').openSession, 'unsupported')
  assert.equal(desktopActionCapabilities('win32').muteSession, 'unsupported')
  assert.equal(desktopActionCapabilities('linux').muteSession, 'notify-send-actions')
  assert.equal(desktopActionCapabilities('linux').desktopSessionProtocol, false)
  assert.deepEqual(sessionActions({ ...options, onMute() {}, muteMinutes: [0, 5, 999] }).map((a) => a.id), ['open', 'mute-5'])
  assert.deepEqual(sessionActions({ sessionId: 'abc', onMute() {} }).map((a) => a.minutes), [5, 10, 15, 30, 'always'])
})

test('Windows encodes validated URL and uses OS protocol action without registration or callback command', () => {
  const result = buildDesktopCommand('win32', {}, { title: 'hello' }, null, options)
  const script = Buffer.from(result.args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /activationType="protocol"/)
  assert.ok(script.includes(Buffer.from(options.sessionUrl).toString('base64')))
  assert.ok(!script.includes(options.sessionUrl))
  assert.doesNotMatch(script, /New-Item|Set-ItemProperty|CreateShortcut|mute-/)
  const invalid = buildDesktopCommand('win32', {}, {}, null, { ...options, sessionUrl: 'https://evil.invalid' })
  assert.doesNotMatch(Buffer.from(invalid.args.at(-1), 'base64').toString('utf16le'), /activationType/)
})

test('Linux checks CLI flags and preserves option terminator and literal message arguments', async () => {
  assert.equal(await startLinuxActions(command, { ...options }, { run: async () => ({ stdout: '--wait' }) }), false)
  assert.equal(await startLinuxActions(command, { ...options }, { run: async () => { throw Error('missing') } }), false)
  const child = fake()
  let captured
  const result = startLinuxActions(command, options, {
    run: async () => ({ stdout: '--action --wait' }),
    spawn: (file, args, spawnOptions) => { captured = { file, args, spawnOptions }; queueMicrotask(() => child.emit('spawn')); return child },
  })
  assert.equal(await result, true)
  assert.equal(captured.spawnOptions.shell, undefined)
  assert.ok(captured.args.indexOf('--action=open=Open session') < captured.args.indexOf('--'))
  assert.equal(captured.args.at(-2), '--evil; $(x)')
  child.emit('close', 0)
})

test('Linux callback is single-use, scoped and rejects malformed output/nonzero exit', async () => {
  for (const [output, code, expected] of [['mute-5\n', 0, 1], ['mute-5\nopen\n', 0, 0], [' mute-5\n', 0, 0], ['mute-999\n', 0, 0], ['mute-5\n', 1, 0], ['x'.repeat(200), 0, 0]]) {
    const child = fake(), calls = []
    assert.equal(await startLinuxActions(command, { sessionId: 'abc', onMute: (minutes) => calls.push(minutes) }, {
      run: async () => ({ stdout: '--action --wait' }),
      spawn: () => { queueMicrotask(() => child.emit('spawn')); return child },
    }), true)
    child.stdout.emit('data', output)
    child.emit('close', code)
    child.emit('close', code)
    await tick()
    assert.equal(calls.length, expected)
    if (expected) assert.equal(calls[0], 5)
  }
})

test('Linux timeout kills observer and late output cannot mute', async () => {
  const child = fake(), calls = []
  await startLinuxActions(command, { sessionId: 'abc', onMute: (m) => calls.push(m) }, {
    run: async () => ({ stdout: '--action --wait' }),
    spawn: () => { queueMicrotask(() => child.emit('spawn')); return child }, timeoutMs: 5,
  })
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(child.killed, true)
  child.stdout.emit('data', 'mute-5\n'); child.emit('close', 0)
  await tick(); assert.deepEqual(calls, [])
})

test('Linux observer admission is capped and nonzero action CLI falls back without actions', async () => {
  const children = [], fallback = []
  const deps = {
    run: async (file, args) => { if (args[0] === '--help') return { stdout: '--action --wait' }; fallback.push({ file, args }); return {} },
    spawn: () => { const child = fake(); children.push(child); queueMicrotask(() => child.emit('spawn')); return child },
  }
  for (let i = 0; i < 8; i++) assert.equal(await startLinuxActions(command, options, deps), true)
  assert.equal(await startLinuxActions(command, options, deps), false)
  children[0].emit('close', 1)
  for (const child of children.slice(1)) child.emit('close', 0)
  await tick()
  assert.deepEqual(fallback, [{ file: command.file, args: command.args }])
})

test('Linux open passes validated URL as literal argv and callback rejection stays contained', async () => {
  const child = fake(), calls = []
  await startLinuxActions(command, options, {
    run: async (file, args) => { calls.push({ file, args }); return { stdout: '--action --wait' } },
    spawn: () => { queueMicrotask(() => child.emit('spawn')); return child },
  })
  child.stdout.emit('data', 'open\n'); child.emit('close', 0)
  await tick()
  assert.deepEqual(calls.at(-1), { file: 'xdg-open', args: [options.sessionUrl] })
  const other = fake(), warnings = []
  await startLinuxActions(command, { sessionId: 'abc', onMute: async () => { throw Error('private credential') } }, {
    run: async () => ({ stdout: '--action --wait' }), warn: (text) => { warnings.push(text); throw Error('logger broken') },
    spawn: () => { queueMicrotask(() => other.emit('spawn')); return other },
  })
  other.stdout.emit('data', 'mute-always\n'); other.emit('close', 0)
  await tick()
  assert.deepEqual(warnings, ['Desktop notification action failed'])
})

test('real subprocess validates action stdout protocol without shell execution', async () => {
  let invoked
  await new Promise(async (resolve, reject) => {
    try {
      const started = await startLinuxActions(command, { sessionId: 'abc', onMute: (minutes) => { invoked = minutes; resolve() } }, {
        run: async () => ({ stdout: '--action --wait' }),
        spawn: (_file, args, settings) => {
          assert.ok(args.includes('--action=mute-15=Mute 15 min'))
          return spawn(process.execPath, ['-e', 'process.stdout.write("mute-15\\n")'], settings)
        },
      })
      assert.equal(started, true)
    } catch (error) { reject(error) }
  })
  assert.equal(invoked, 15)
})
