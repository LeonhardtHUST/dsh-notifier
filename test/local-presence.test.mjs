// v0.14.2：本地 presence / 远程抑制策略的纯契约测试。
//
// 覆盖：
//  - 默认策略全开 + 持久化合并 + 非法写入拒绝；
//  - focus 证据（可见+聚焦）只在新鲜期内抑制，失焦/隐藏立即解除；
//  - web 不能声明 OS 解锁/唤醒能力；unlock 证据必须显式声明能力，且绝不从 focus 推断；
//  - 宿主唤醒（timer gap）证据的窗口期；
//  - 存储写失败 → storage-failed，不谎报成功。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHostWakeProbe,
  createLocalPresence,
  createWakeDetector,
  POLICY_KEY,
} from '../src/control-surface/presence.mjs'

function memoryStore(initial = {}) {
  let memory = { ...initial }
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    transact(mutator) {
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

test('默认策略 focus/unlock/wake 全开，保存后持久化并可被新实例读回', () => {
  const store = memoryStore()
  const presence = createLocalPresence({ store })
  assert.deepEqual(presence.policy(), { focus: true, unlock: true, wake: true })

  const saved = presence.savePolicy({ focus: false, unlock: false })
  assert.deepEqual(saved, {
    saved: true,
    policy: { focus: false, unlock: false, wake: true },
    applied: true,
    applyMode: 'hot',
  })
  assert.deepEqual(store.snapshot()[POLICY_KEY], { focus: false, unlock: false, wake: true })

  const reloaded = createLocalPresence({ store })
  assert.deepEqual(reloaded.policy(), { focus: false, unlock: false, wake: true })
})

test('策略写入拒绝未知键/非布尔/空对象；存储失败返回 storage-failed', () => {
  const presence = createLocalPresence({ store: memoryStore() })
  for (const patch of [{ focus: 'yes' }, { unknown: true }, {}, null, []]) {
    assert.throws(() => presence.savePolicy(patch), (error) => error?.code === 'bad-request', JSON.stringify(patch))
  }
  assert.deepEqual(presence.policy(), { focus: true, unlock: true, wake: true }, '失败不得改内存策略')

  const throwing = createLocalPresence({
    store: { get: () => undefined, transact() { throw new Error('disk full') } },
  })
  assert.throws(() => throwing.savePolicy({ wake: false }), (error) => {
    assert.equal(error.code, 'storage-failed')
    assert.match(error.message, /未落盘/)
    return true
  })
  assert.deepEqual(throwing.policy(), { focus: true, unlock: true, wake: true })
})

test('损坏的持久化策略回落安全默认（布尔键才生效）', () => {
  const presence = createLocalPresence({
    store: memoryStore({ [POLICY_KEY]: { focus: false, unlock: 'no', wake: null, junk: 1 } }),
  })
  assert.deepEqual(presence.policy(), { focus: false, unlock: true, wake: true })
})

test('focus 证据：可见+聚焦才抑制；失焦/隐藏立即解除；过期自动 unknown', () => {
  let clock = 10_000
  const presence = createLocalPresence({
    store: memoryStore(),
    now: () => clock,
    focusFreshMs: 1_000,
  })

  let view = presence.report({ source: 'web', visible: true, focused: true })
  assert.equal(view.suppressing, true)
  assert.deepEqual(view.reasons, ['focus'])
  assert.equal(view.evidence.focus, 'focused')
  assert.equal(view.evidence.source, 'web')

  clock += 1_001
  assert.equal(presence.shouldSuppressRemote().suppress, false, '证据过期必须解除，崩溃的客户端不能永久抑制')
  assert.equal(presence.view().evidence.focus, 'unknown')

  presence.report({ source: 'web', visible: true, focused: false })
  assert.equal(presence.shouldSuppressRemote().suppress, false)
  assert.equal(presence.view().evidence.focus, 'away')

  presence.report({ source: 'web', visible: false, focused: true })
  assert.equal(presence.shouldSuppressRemote().suppress, false, '隐藏但 focused 的异常组合不得当作在前台')
  assert.equal(presence.view().evidence.focus, 'away')
})

test('web 不能伪造 OS 解锁/唤醒能力；unlock 必须有显式能力证据', () => {
  const presence = createLocalPresence({ store: memoryStore() })
  assert.throws(() => presence.report({ source: 'web', capabilities: { unlock: true } }), (error) => {
    assert.equal(error.code, 'bad-request')
    assert.match(error.message, /web/)
    return true
  })
  assert.throws(() => presence.report({ source: 'web', unlocked: true }), (error) => error?.code === 'bad-request')
  assert.throws(() => presence.report({ source: 'web', woke: true }), (error) => error?.code === 'bad-request')

  // focus 证据绝不自动变成 unlock 证据。
  const focused = presence.report({ source: 'web', visible: true, focused: true })
  assert.equal(focused.evidence.unlocked, null, 'web 永远不知道解锁状态，返回 null 而不是 false')
  assert.equal(focused.capabilities.unlock, false)

  // 只有桌面客户端显式声明 unlock 能力后，unlocked 才被接受并参与抑制。
  const desk = presence.report({
    source: 'desktop',
    visible: true,
    focused: false,
    capabilities: { unlock: true },
    unlocked: true,
  })
  assert.equal(desk.evidence.unlocked, true)
  assert.deepEqual(desk.reasons, ['unlock'])
  assert.equal(presence.shouldSuppressRemote().suppress, true)
})

test('unlock 证据有新鲜期；关闭 unlock 策略后不再抑制', () => {
  let clock = 0
  const presence = createLocalPresence({
    store: memoryStore(),
    now: () => clock,
    unlockFreshMs: 5_000,
  })
  presence.report({ source: 'desktop', capabilities: { unlock: true }, unlocked: true })
  assert.deepEqual(presence.shouldSuppressRemote().reasons, ['unlock'])
  clock = 5_001
  assert.equal(presence.shouldSuppressRemote().suppress, false)

  presence.report({ source: 'desktop', capabilities: { unlock: true }, unlocked: true })
  presence.savePolicy({ unlock: false })
  assert.equal(presence.shouldSuppressRemote().suppress, false, '策略关闭后证据仍在也不得抑制')
})

test('唤醒证据：markWake 后窗口期内抑制，过期解除；策略关闭后失效', () => {
  let clock = 0
  const presence = createLocalPresence({
    store: memoryStore(),
    now: () => clock,
    wakeWindowMs: 300_000,
  })
  presence.markWake(1_000)
  clock = 2_000
  assert.deepEqual(presence.shouldSuppressRemote().reasons, ['wake'])
  assert.equal(presence.view().evidence.wake, true)

  clock = 301_001
  assert.equal(presence.shouldSuppressRemote().suppress, false)
  assert.equal(presence.view().evidence.wake, false)

  presence.markWake(clock)
  presence.savePolicy({ wake: false })
  assert.equal(presence.shouldSuppressRemote().suppress, false)
})

test('wake detector：长间隙判定为唤醒，正常间隔不误报', () => {
  const detector = createWakeDetector({ gapMs: 1_000 })
  detector.reset(0)
  assert.equal(detector.observe(500), false)
  assert.equal(detector.observe(1_200), false, '500ms 间隔正常')
  assert.equal(detector.observe(3_000), true, '1800ms 间隙 = 挂起后恢复')
  assert.equal(detector.observe(3_200), false)
})

test('host wake probe 在间隙出现时回调 onWake，且 dispose 后停止', async () => {
  let clock = 0
  let wakes = 0
  const probe = createHostWakeProbe({
    now: () => clock,
    intervalMs: 1,
    gapMs: 100,
    onWake: () => { wakes += 1 },
  })
  clock = 5_000
  await new Promise((resolve) => setTimeout(resolve, 30))
  probe.dispose()
  assert.ok(wakes >= 1, '挂起间隙应触发 onWake')
})

test('presence 报告形状守卫：非对象、非法 source/字段类型 → bad-request', () => {
  const presence = createLocalPresence({ store: memoryStore() })
  for (const payload of [null, [], 'x', { source: 'server', visible: true }, { visible: 'yes' }, { focused: 1 }, { visible: true, capabilities: 'x' }]) {
    assert.throws(() => presence.report(payload), (error) => error?.code === 'bad-request', JSON.stringify(payload))
  }
  assert.throws(() => presence.report({}), (error) => error?.code === 'bad-request', '空报告不得刷新证据')
})
