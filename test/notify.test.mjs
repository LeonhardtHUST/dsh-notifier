import test from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier, createEventNotifier } from '../src/notify.mjs'
import { resolveConfig, ADAPTERS } from '../src/config.mjs'

/** 构造一个可注入 fetch 的 webhook 渠道 notifier。 */
function makeNotifier(channels, logger = { warn() {} }) {
  const resolved = resolveConfig({ channels })
  assert.equal(resolved.skipped.length, 0)
  return createNotifier({ logger }, resolved.channels)
}

/**
 * 远程抑制测试用 notifier：真实路由/配置，只把 desktop 适配器换成间谍，
 * 避免单元测试真的弹系统通知。webhook 仍走测试自己的 fetch stub。
 */
function makeSuppressNotifier(channels, desktopCalls = []) {
  const resolved = resolveConfig({ channels })
  assert.equal(resolved.skipped.length, 0)
  return createNotifier({ logger: { warn() {} } }, resolved.channels, {
    adapters: {
      ...ADAPTERS,
      desktop: { send: async () => { desktopCalls.push(1); return { ok: true } } },
    },
  })
}

const WARN = []

function webhookChannel(url) {
  return { type: 'webhook', url }
}

test('notify 到未配置渠道：静默跳过 + warn，不 send', async () => {
  const warns = []
  const notifier = createNotifier({ logger: { warn: (...a) => warns.push(a.join(' ')) } }, [])
  const result = await notifier.notify('telegram', { title: 't', content: 'c' })
  assert.equal(result.skipped, true)
  assert.equal(result.ok, false)
  assert.match(warns.join(' '), /telegram.*未配置/)
})

test('notify 定向结果内部审计一次并保留 ledger/hub 兼容 record', async () => {
  const records = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'SECRET adapter body' })
  try {
    const resolved = resolveConfig({ channels: [webhookChannel('http://x/hook')] })
    const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels, { onSend: (record) => records.push(record) })
    const result = await notifier.notify('webhook', { title: '标题🍅', content: '机密正文' }, { source: { kind: 'plugin', name: 'test' } })
    assert.equal(result.ok, false)
    assert.equal(records.length, 1)
    assert.equal(records[0].channel, 'webhook')
    assert.deepEqual(records[0].message, { title: '标题🍅', content: '机密正文', level: undefined, group: undefined })
    assert.equal(records[0].failed.length, 1)
    assert.equal(records[0].failed[0].channel, 'webhook')
    assert.match(records[0].failed[0].error, /HTTP 500/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notify directed unconfigured path audits exactly once', async () => {
  const records = []
  const notifier = createNotifier({ logger: { warn() {} } }, [], { onSend: (record) => records.push(record) })
  const result = await notifier.notify('telegram', { title: 't', content: 'c' }, { source: { kind: 'plugin', name: 'test' } })
  assert.equal(result.skipped, true)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].skipped, ['(telegram)'])
  assert.equal(records[0].channel, 'telegram')
})

test('audit sink failure is isolated from delivery and later sinks', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  try {
    const resolved = resolveConfig({ channels: [webhookChannel('http://x/hook')] })
    const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels, {
      onSend: (record) => {
        seen.push(record)
        throw new Error('sink failure')
      },
    })
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    // v0.13（R4）：accepted = provider 已接受；confirmed = 显式回执（webhook 无回执）；
    // delivered 保留为 legacy 别名（== accepted）。
    assert.deepEqual(result, { ok: true, accepted: ['webhook'], confirmed: [], delivered: ['webhook'], skipped: [], failed: [] })
    assert.equal(seen.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notify 到已配置渠道：请求体含 title/content', async () => {
  let seen
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = { url, body: JSON.parse(init.body) }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([webhookChannel('http://public-hook.test/hook')])
    const result = await notifier.notify('webhook', { title: '标题', content: '正文', level: 'critical' })
    assert.equal(result.ok, true)
    assert.equal(seen.body.title, '标题')
    assert.equal(seen.body.content, '正文')
    assert.equal(seen.body.level, 'critical')
    assert.ok(typeof seen.body.timestamp === 'string')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notify 失败返回 failed 结果而不是抛出', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'internal' })
  try {
    const notifier = makeNotifier([webhookChannel('http://x/hook')])
    const result = await notifier.notify('webhook', { title: 't', content: 'c' })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /HTTP 500/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll 广播所有已启用渠道', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(url)
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([
      webhookChannel('http://a/hook'),
      webhookChannel('http://b/hook'),
    ])
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.delivered.length, 2)
    assert.deepEqual(seen.sort(), ['http://a/hook', 'http://b/hook'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll: 一个渠道失败不影响其它渠道', async () => {
  const seen = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    seen.push(url)
    if (url.includes('fail')) return { ok: false, status: 500, text: async () => 'boom' }
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeNotifier([
      webhookChannel('http://fail/hook'),
      webhookChannel('http://good/hook'),
    ])
    const result = await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(result.delivered.length, 1)
    assert.deepEqual(result.delivered, ['webhook'])
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /HTTP 500/)
    assert.equal(result.ok, false)
    assert.equal(seen.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyAll: 无已启用渠道时返回空结果并 warn', async () => {
  const warns = []
  const notifier = createNotifier({ logger: { warn: (...a) => warns.push(a.join(' ')) } }, [])
  const result = await notifier.notifyAll({ title: 't', content: 'c' })
  assert.deepEqual(result, { ok: false, accepted: [], confirmed: [], delivered: [], skipped: [], failed: [] })
  assert.match(warns.join(' '), /未配置任何已启用渠道/)
})

test('channelCount 与 channels 暴露', () => {
  const notifier = makeNotifier([webhookChannel('http://a/hook'), webhookChannel('http://b/hook')])
  assert.equal(notifier.channelCount, 2)
  assert.deepEqual(notifier.channels, ['webhook', 'webhook'])
})

test('flush 等待在途推送完成（headless 退出前送达）', async () => {
  let resolveSend
  let called = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    called += 1
    return new Promise((resolve) => {
      resolveSend = () => resolve({ ok: true, status: 200, json: async () => ({}) })
    })
  }
  try {
    const notifier = makeNotifier([webhookChannel('http://a/hook')])
    const promise = notifier.notifyAll({ title: 't', content: 'c' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(called, 1)
    const flushed = notifier.flush()
    let flushResolved = false
    flushed.then(() => { flushResolved = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(flushResolved, false, '在途 fetch 未完成时 flush 不应 resolve')
    resolveSend()
    await flushed
    assert.equal(flushResolved, true)
    await promise
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('suppressRemote：desktop 目标存在时只发本机，远程渠道进 suppressed', async () => {
  const desktopCalls = []
  const remoteCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    remoteCalls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeSuppressNotifier([
      webhookChannel('http://remote/hook'),
      { type: 'desktop', sound: 'never' },
    ], desktopCalls)
    const outcome = await notifier.notifyAll({ title: 't', content: 'c' }, { suppressRemote: true })
    assert.equal(desktopCalls.length, 1, 'desktop 必须继续投递')
    assert.deepEqual(remoteCalls, [], '远程渠道不得收到请求')
    assert.deepEqual(outcome.accepted, ['desktop'])
    assert.deepEqual(outcome.delivered, ['desktop'])
    assert.deepEqual(outcome.suppressed, ['webhook'])
    assert.equal(outcome.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('suppressRemote：没有 desktop 目标时远程发送逐字节不变', async () => {
  const remoteCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    remoteCalls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeSuppressNotifier([webhookChannel('http://remote/hook')])
    const outcome = await notifier.notifyAll({ title: 't', content: 'c' }, { suppressRemote: true })
    assert.deepEqual(remoteCalls, ['http://remote/hook'], 'desktop 未启用时绝不能吞掉远程通知')
    assert.deepEqual(outcome.accepted, ['webhook'])
    assert.deepEqual(outcome.suppressed, [])
    assert.equal(outcome.ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('suppressRemote：只有本地 bell（没有 desktop）同样不抑制远程', async () => {
  const remoteCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    remoteCalls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeSuppressNotifier([
      { type: 'bell', count: 1 },
      webhookChannel('http://remote/hook'),
    ])
    const outcome = await notifier.notifyAll({ title: 't', content: 'c' }, { suppressRemote: true })
    assert.deepEqual(remoteCalls, ['http://remote/hook'])
    assert.ok(outcome.accepted.includes('webhook'))
    assert.deepEqual(outcome.suppressed, [], 'bell 不是可见的桌面通知，不能作为抑制前提')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('suppressRemote：quiet 优先，既不发送桌面也不发送远程', async () => {
  const desktopCalls = []
  const remoteCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    remoteCalls.push(String(url))
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const notifier = makeSuppressNotifier([
      webhookChannel('http://remote/hook'),
      { type: 'desktop', sound: 'never' },
    ], desktopCalls)
    const outcome = await notifier.notifyAll({ title: 't', content: 'c' }, { quiet: true, suppressRemote: true })
    assert.deepEqual(outcome.skipped, ['(quiet)'])
    assert.deepEqual(desktopCalls, [])
    assert.deepEqual(remoteCalls, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('createEventNotifier：命中策略时补 suppressRemote，getter 抛错按不抑制处理', async () => {
  const calls = []
  const base = {
    notifyAll(message, options) { calls.push(options); return Promise.resolve({ ok: true }) },
    flush() { return Promise.resolve() },
    channels: ['telegram'],
    channelCount: 1,
  }
  const on = createEventNotifier(base, () => true)
  await on.notifyAll({ title: 't' }, { channelTypes: ['telegram'] })
  assert.deepEqual(calls[0], { channelTypes: ['telegram'], suppressRemote: true })

  const broken = createEventNotifier(base, () => { throw new Error('presence broke') })
  await broken.notifyAll({ title: 't' }, { channelTypes: ['telegram'] })
  assert.deepEqual(calls[1], { channelTypes: ['telegram'] }, 'presence 故障绝不影响通知主链路')

  const off = createEventNotifier(base, () => false)
  await off.notifyAll({ title: 't' })
  assert.equal(Object.prototype.hasOwnProperty.call(calls[2], 'suppressRemote'), false)
  assert.deepEqual(off.channels, ['telegram'])
  assert.equal(off.channelCount, 1)
})

test('suppressRemote 的 suppressed 只出现在显式请求抑制的结果与审计里', async () => {
  const records = []
  const desktopCalls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) })
  try {
    const resolved = resolveConfig({ channels: [webhookChannel('http://remote/hook'), { type: 'desktop', sound: 'never' }] })
    const notifier = createNotifier({ logger: { warn() {} } }, resolved.channels, {
      adapters: { ...ADAPTERS, desktop: { send: async () => { desktopCalls.push(1); return { ok: true } } } },
      onSend: (record) => records.push(record),
    })
    await notifier.notifyAll({ title: 't', content: 'c' })
    assert.equal(Object.prototype.hasOwnProperty.call(records[0], 'suppressed'), false, '未请求抑制时结果形状不变')
    await notifier.notifyAll({ title: 't', content: 'c' }, { suppressRemote: true })
    assert.deepEqual(records[1].suppressed, ['webhook'])
    assert.equal(desktopCalls.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// S-02：urlguard DNS 恒公网夹具（假域名不打真网，见 helpers/urlguard-public.mjs）
import './helpers/urlguard-public.mjs'
