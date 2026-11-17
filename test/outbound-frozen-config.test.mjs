// dsh-notifier test/outbound-frozen-config.test.mjs
// 上游 issues #45/#46 回归：OutboundSource 会把出站配置 JSON 克隆后深冻结
// （src/runtime/outbound-source.mjs），适配器运行态（token 管理器 / 限速门 /
// msg_seq / BurntToast 探测 / serverchan 出声闩锁）必须放每适配器私有 WeakMap，
// 不能回写 resolved —— 否则真实路径每次推送都 TypeError，整条渠道静默失效。
//
// 覆盖：真实 source → notifier → adapter 的 cold/hot 流、令牌复用与失效重试、
// 失败重试的 msg_seq 幂等、配置对象间状态隔离/hot replace 替换、desktop 的
// argv-only 子进程 seam（假 spawn，不发真实系统通知）、serverchan 别名提醒一次。
// 全程零真实网络、零真实桌面通知。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createNotifier } from '../src/notify.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createStore } from '../src/inbound/store.mjs'
import * as qqBot from '../src/adapters/qq-bot.mjs'
import * as wecomApp from '../src/adapters/wecom-app.mjs'
import * as desktop from '../src/adapters/desktop.mjs'
import * as serverchan from '../src/adapters/serverchan.mjs'

const MSG = { title: '构建完成', content: '全部用例通过', level: 'active' }

/** 简易 logger：warn 收集到数组（notifier 失败细节从这里可见）。 */
function makeLogger() {
  const warns = []
  return { warns, logger: { warn: (...args) => warns.push(args.join(' ')) } }
}

/** 断言配置对象保持深冻结（修复不得靠解冻/替换可变对象）。 */
function assertFrozen(entry) {
  assert.equal(Object.isFrozen(entry), true, 'source 快照必须保持冻结')
  for (const value of Object.values(entry)) {
    if (value !== null && typeof value === 'object') assert.equal(Object.isFrozen(value), true)
  }
}

/** 请求体 JSON（GET 无 body 返回 null）。 */
function bodyOf(init) {
  try { return JSON.parse(String(init?.body ?? 'null')) } catch { return null }
}

/** 伪造 child_process 子进程：手动 emit 事件，绝无真实进程。 */
function makeFakeChild() {
  const listeners = new Map()
  return {
    stderr: { on: (event, cb) => listeners.set(`stderr:${event}`, cb) },
    on: (event, cb) => listeners.set(event, cb),
    kill: () => {},
    emit: (event, ...args) => listeners.get(event)?.(...args),
  }
}

/** 钉住 process.platform（send 内读它分发），结束恢复。 */
async function withPlatform(platform, fn) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

// ---------------------------------------------------------------- cold flow

test('cold: source 冻结的 qq-bot 配置经 notifier 正常发送；token 复用、msg_seq 递增', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const { warns, logger } = makeLogger()
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, body: bodyOf(init) })
    if (target.includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'TOKEN1', expires_in: 7200 }) }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg-1', timestamp: 1 }) }
  }
  try {
    const source = createOutboundSource([{
      type: 'qq-bot',
      // 生产路径：先 adapter.resolve（composeOutboundChannels/resolveCandidate 同款），
      // 再由 OutboundSource JSON 克隆 + 深冻结。
      config: qqBot.resolve({ appId: 'app-1', appSecret: 'secret-1', groupId: 'group-1', rateMs: 0 }),
    }])
    const config = source.get('qq-bot').config
    assertFrozen(config)

    const notifier = createNotifier({ logger }, source)
    const first = await notifier.notify('qq-bot', MSG)
    const second = await notifier.notify('qq-bot', MSG)

    assert.deepEqual(first, { channel: 'qq-bot', ok: true, skipped: false, error: undefined })
    assert.equal(second.ok, true)
    assert.deepEqual(warns, [], '冻结配置不得触发 any 推送失败告警')

    const tokenCalls = calls.filter((call) => call.url.includes('getAppAccessToken'))
    const messageCalls = calls.filter((call) => call.url.includes('/v2/groups/group-1/messages'))
    assert.equal(tokenCalls.length, 1, '同一活配置的 token 在两次 send 间复用')
    assert.deepEqual(messageCalls.map((call) => call.body.msg_seq), [1, 2], 'msg_seq 按配置对象持久递增')
    assert.equal(messageCalls[0].body.markdown.content, '构建完成\n全部用例通过')
    assertFrozen(config)
    assert.deepEqual(Object.keys(config).sort(), ['apiBase', 'appId', 'appSecret', 'markdown', 'rateMs', 'targetId', 'targetType', 'timeoutMs'], '运行态不得混进 JSON 配置快照')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------- hot flow

test('hot: OutboundConfigService.save 热替换后下一次 send 用新配置，状态按快照替换', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const { warns, logger } = makeLogger()
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    calls.push({ url: target, body: bodyOf(init) })
    if (target.includes('getAppAccessToken')) {
      return { ok: true, status: 200, json: async () => ({ access_token: `TOKEN-${calls.length}`, expires_in: 7200 }) }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'msg-1', timestamp: 1 }) }
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-outbound-frozen-'))
  const store = createStore(join(dir, 'state.json'))
  const source = createOutboundSource([])
  const service = createOutboundConfigService({ store, yamlRows: new Map(), source, allowLegacy: false })
  const notifier = createNotifier({ logger }, source)
  try {
    const saved = service.save('qq-bot', { appId: 'app-1', appSecret: 'secret-1', groupId: 'group-1' })
    assert.equal(saved.applied, true)
    assertFrozen(source.get('qq-bot').config)

    assert.equal((await notifier.notify('qq-bot', MSG)).ok, true)
    const firstSeq = calls.filter((call) => call.url.includes('messages')).at(-1).body.msg_seq
    assert.equal(firstSeq, 1)

    // 只改 groupId：desired 落盘 + 同步热替换 live source（生产路径）
    const replaced = service.save('qq-bot', { groupId: 'group-2' })
    assert.equal(replaced.applied, true)
    assertFrozen(source.get('qq-bot').config)

    assert.equal((await notifier.notify('qq-bot', MSG)).ok, true)
    const messageCalls = calls.filter((call) => call.url.includes('messages'))
    assert.equal(messageCalls.at(-1).url, 'https://api.sgroup.qq.com/v2/groups/group-2/messages')
    assert.equal(messageCalls.at(-1).body.msg_seq, 1, 'hot replace 产生新快照 → 新运行态，seq 从 1 重新起算')
    assert.equal(calls.filter((call) => call.url.includes('getAppAccessToken')).length, 2, '新快照重新换取 token（旧状态不跨快照复用）')
    assert.deepEqual(warns, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ------------------------------------------------------- token reuse / retry

test('wecom-app: 冻结配置复用 token；40014/42001 失效时强制换新并只重试一次', async () => {
  const originalFetch = globalThis.fetch
  const tokenCalls = []
  const sendCalls = []
  let tokenSeq = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('/cgi-bin/gettoken')) {
      tokenSeq += 1
      tokenCalls.push(tokenSeq)
      return { ok: true, status: 200, json: async () => ({ errcode: 0, access_token: `TOKEN${tokenSeq}`, expires_in: 7200 }) }
    }
    sendCalls.push({ url: target, body: bodyOf(init) })
    // 第一次携带 TOKEN1 → 令牌失效；重试携带 TOKEN2 → 成功
    return { ok: true, status: 200, json: async () => (target.includes('access_token=TOKEN1')
      ? { errcode: 42001, errmsg: 'access_token expired' }
      : { errcode: 0, errmsg: 'ok' }) }
  }
  try {
    const source = createOutboundSource([{
      type: 'wecom-app',
      config: wecomApp.resolve({ corpid: 'corp-1', secret: 'secret-1', agentId: 1000002 }),
    }])
    const config = source.get('wecom-app').config
    assertFrozen(config)
    const { logger } = makeLogger()
    const notifier = createNotifier({ logger }, source)

    assert.equal((await notifier.notify('wecom-app', MSG)).ok, true)
    assert.equal(tokenCalls.length, 2, '失效令牌必须作废并重换一次')
    assert.equal(sendCalls.length, 2)
    assert.match(sendCalls[0].url, /access_token=TOKEN1/)
    assert.match(sendCalls[1].url, /access_token=TOKEN2/)
    assert.equal(sendCalls[1].body.text.content, '构建完成\n全部用例通过')

    // 后续发送复用 TOKEN2，不再换 token
    assert.equal((await notifier.notify('wecom-app', MSG)).ok, true)
    assert.equal(tokenCalls.length, 2, '成功后的 token 缓存继续复用')
    assert.equal(sendCalls.length, 3)
    assert.match(sendCalls[2].url, /access_token=TOKEN2/)
    assertFrozen(config)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --------------------------------------------------------------- isolation

test('isolation: 两个同类型活配置各自持有运行态（token / seq 互不串用）', async () => {
  const originalFetch = globalThis.fetch
  let tokenFetches = 0
  const messageSeqs = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.includes('getAppAccessToken')) {
      tokenFetches += 1
      return { ok: true, status: 200, json: async () => ({ access_token: `T${tokenFetches}`, expires_in: 7200 }) }
    }
    messageSeqs.push({ url: target, seq: bodyOf(init).msg_seq })
    return { ok: true, status: 200, json: async () => ({ id: 'm', timestamp: 1 }) }
  }
  try {
    const a = createOutboundSource([{ type: 'qq-bot', config: qqBot.resolve({ appId: 'a', appSecret: 's', groupId: 'ga', rateMs: 0 }) }])
    const b = createOutboundSource([{ type: 'qq-bot', config: qqBot.resolve({ appId: 'b', appSecret: 's', groupId: 'gb', rateMs: 0 }) }])
    assert.notEqual(a.get('qq-bot').config, b.get('qq-bot').config)
    // 交错发送两轮：各自 seq 独立递增，token 各换一次
    await qqBot.send(a.get('qq-bot').config, MSG)
    await qqBot.send(b.get('qq-bot').config, MSG)
    await qqBot.send(a.get('qq-bot').config, MSG)
    await qqBot.send(b.get('qq-bot').config, MSG)
    assert.equal(tokenFetches, 2, '两份配置 = 两个 token 管理器')
    assert.deepEqual(
      messageSeqs.map((entry) => [entry.url.includes('/ga/') ? 'a' : 'b', entry.seq]),
      [['a', 1], ['b', 1], ['a', 2], ['b', 2]],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ------------------------------------------------- desktop subprocess seam

test('desktop(win32): 冻结配置只检查一次 AUMID 快捷方式；argv-only 子进程 seam 不拼 shell', async () => {
  const spawned = []
  const existsChecks = []
  const { logger } = makeLogger()
  const source = createOutboundSource([{ type: 'desktop', config: desktop.resolve({ sound: 'always' }) }])
  const config = source.get('desktop').config
  const decoded = (entry) => {
    const index = entry.args.indexOf('-EncodedCommand')
    return index >= 0 ? Buffer.from(entry.args[index + 1], 'base64').toString('utf16le') : ''
  }
  // 钉住探测依赖的 env，避免宿主 OS/机器环境差异
  const savedEnv = { APPDATA: process.env.APPDATA, ProgramData: process.env.ProgramData, PROGRAMDATA: process.env.PROGRAMDATA }
  process.env.APPDATA = 'C:\\Users\\test\\AppData\\Roaming'
  delete process.env.ProgramData
  process.env.PROGRAMDATA = 'C:\\ProgramData'
  await withPlatform('win32', async () => {
    desktop._setSpawnImpl((file, args) => {
      const child = makeFakeChild()
      spawned.push({ file, args, child })
      queueMicrotask(() => child.emit('close', 0)) // toast 成功
      return child
    })
    desktop._setExistsImpl((file) => { existsChecks.push(file); return true })
    try {
      assertFrozen(config)
      const notifier = createNotifier({ logger }, source)
      assert.equal((await notifier.notify('desktop', MSG)).ok, true)
      assert.equal((await notifier.notify('desktop', MSG)).ok, true)

      assert.equal(spawned.length, 2, '没有探测子进程：每次通知只 spawn 一个 toast')
      assert.equal(existsChecks.length, 1, '同一冻结配置只做一次快捷方式检查（结果缓存）')
      for (const entry of spawned) {
        assert.equal(entry.file, 'powershell.exe')
        assert.ok(Array.isArray(entry.args), '子进程参数必须是 argv 数组（spawn 永不经 shell）')
        assert.ok(entry.args.includes('-NoProfile'))
        assert.ok(entry.args.includes('-EncodedCommand'), 'toast 脚本经 -EncodedCommand 传入')
        // 快捷方式存在 → toast 归属 DSH 桌面应用
        const script = decoded(entry)
        assert.ok(script.includes("$appId='com.deepseek.dsh'"))
        // 用户文本不以明文进脚本：标题/正文只以 base64 出现
        assert.ok(script.includes(Buffer.from(MSG.title, 'utf8').toString('base64')))
        assert.ok(script.includes(Buffer.from(MSG.content, 'utf8').toString('base64')))
        assert.ok(!script.includes(MSG.title))
        assert.ok(!script.includes(MSG.content))
        assert.ok(script.includes('CreateToastNotifier($appId).Show($toast)'))
      }
      assertFrozen(config)
    } finally {
      desktop._setSpawnImpl(null)
      desktop._setExistsImpl(null)
      for (const entry of spawned) entry.child.emit('close', 0) // 清掉超时定时器
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

test('desktop(linux): 冻结配置下恶意标题仍是 argv 字面参数（-- 终结符之后），silent 不 spawn', async () => {
  const spawned = []
  const source = createOutboundSource([{ type: 'desktop', config: desktop.resolve({ sound: 'never' }) }])
  const config = source.get('desktop').config
  await withPlatform('linux', async () => {
    desktop._setSpawnImpl((file, args) => {
      const child = makeFakeChild()
      spawned.push({ file, args, child })
      queueMicrotask(() => child.emit('close', 0))
      return child
    })
    try {
      assertFrozen(config)
      const evil = { title: '-u critical', content: '"; rm -rf /', level: 'active' }
      await desktop.send(config, evil)
      assert.equal(spawned.length, 1)
      assert.equal(spawned[0].file, 'notify-send')
      const ddash = spawned[0].args.indexOf('--')
      assert.ok(ddash > 0)
      assert.equal(spawned[0].args[ddash + 1], '-u critical', '标题按字面参数传给 argv，不被解析成选项')
      assert.equal(spawned[0].args[ddash + 2], '"; rm -rf /')
      assert.equal(typeof spawned[0].args[0], 'string', '参数数组元素均为字符串')
      await desktop.send(config, { ...MSG, silent: true })
      assert.equal(spawned.length, 1, 'silent 直接返回，不 spawn')
      assertFrozen(config)
    } finally {
      desktop._setSpawnImpl(null)
    }
  })
})

// ------------------------------------------------------------- serverchan

test('serverchan: 冻结配置下别名冲突只在首次发送出声一次，端点仍由 key 派生', async () => {
  const originalFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, status: 200, json: async () => ({ code: 0 }) }
  }
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  const { logger } = makeLogger()
  try {
    const source = createOutboundSource([{ type: 'serverchan', config: serverchan.resolve({ sct: 'SCT1', sendKey: 'SK2' }) }])
    const config = source.get('serverchan').config
    assertFrozen(config)
    assert.deepEqual(config.aliasConflict, ['sct', 'sendKey'], '派生的只读冲突名单随 JSON 快照保留')
    const notifier = createNotifier({ logger }, source)
    assert.equal((await notifier.notify('serverchan', MSG)).ok, true)
    assert.equal((await notifier.notify('serverchan', MSG)).ok, true)
    assert.equal(errors.length, 1, '同一活配置只提醒一次（闩锁在 WeakMap，不回写冻结配置）')
    assert.match(errors[0], /优先级取 sct/)
    assert.deepEqual(urls, [
      'https://sctapi.ftqq.com/SCT1.send',
      'https://sctapi.ftqq.com/SCT1.send',
    ])
    assertFrozen(config)
  } finally {
    console.error = originalError
    globalThis.fetch = originalFetch
  }
})

test('serverchan: 单别名配置在冻结快照下不产生别名告警', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) })
  const errors = []
  const originalError = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    const source = createOutboundSource([{ type: 'serverchan', config: serverchan.resolve({ sct: 'SCT1' }) }])
    assertFrozen(source.get('serverchan').config)
    await serverchan.send(source.get('serverchan').config, MSG)
    assert.deepEqual(errors, [])
  } finally {
    console.error = originalError
    globalThis.fetch = originalFetch
  }
})

// --------------------------------------------------- contract guard rails

test('immutability: 四个适配器的 resolve 输出都是纯 JSON 快照，不含运行态字段', () => {
  const resolved = {
    'qq-bot': qqBot.resolve({ appId: 'a', appSecret: 's', groupId: 'g' }),
    'wecom-app': wecomApp.resolve({ corpid: 'c', secret: 's', agentId: 1 }),
    desktop: desktop.resolve({ sound: 'auto' }),
    serverchan: serverchan.resolve({ sct: 'SCT1' }),
  }
  for (const [type, config] of Object.entries(resolved)) {
    assert.deepEqual(JSON.parse(JSON.stringify(config)), config, `${type}: resolve 输出必须可 JSON 序列化`)
    for (const key of Object.keys(config)) {
      assert.doesNotMatch(key, /^_/, `${type}: resolve 不得回填 _ 前缀运行态字段（发现 ${key}）`)
    }
  }
})
