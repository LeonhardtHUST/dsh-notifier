// v0.14.1：本机通知（desktop/bell）的 Native 控制面回归。
//
// 覆盖：渠道行的 local/remote scope；local.get 视图（平台信息、sound/count 归一化、
// managedBy yaml/ui/null）；local.save 的启用/关闭语义（复用 outboundConfig 事务）；
// 非法输入的公开错误码；平台探测失败的兜底；service 层 local.get/local.save 信封、
// revision/activity 副作用与 surface.home 的 local 摘要。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOutboundConfigService } from '../src/control-surface/outbound-config.mjs'
import { createOutboundSource } from '../src/runtime/outbound-source.mjs'
import { createLocalNotificationSurface, LOCAL_TYPES } from '../src/control-surface/local.mjs'
import { createChannelProjection } from '../src/control-surface/channels.mjs'
import { createControlSurfaceService } from '../src/control-surface/service.mjs'
import { createSurfaceRevision } from '../src/control-surface/revision.mjs'
import { createSurfaceActivity } from '../src/control-surface/activity.mjs'
import { createSurfaceHealth } from '../src/control-surface/health.mjs'

const PLATFORM_FALLBACK = {
  os: 'other',
  desktop: null,
  support: 'unsupported',
  backend: null,
  detail: { en: 'Platform information unavailable', zh: '无法读取平台信息' },
}

/** 与 config-runtime-truth-v013 同款最小 store：支持 get/transact，durable 语义真实。 */
function memoryStore(initial = {}) {
  let memory = { ...initial }
  return {
    get: (key) => (key in memory ? memory[key] : undefined),
    keys: (prefix = '') => Object.keys(memory).filter((key) => key.startsWith(prefix)),
    transact(mutator) {
      const draft = JSON.parse(JSON.stringify(memory))
      const value = mutator(draft)
      memory = draft
      return { ok: true, committed: true, durable: true, value }
    },
    snapshot: () => JSON.parse(JSON.stringify(memory)),
  }
}

/** 真实 outbound 配置服务 + 记录调用参数的薄 spy（保留原事务语义，不是纯 mock）。 */
function setup({ yaml = new Map(), initial = {}, platformInfo } = {}) {
  const store = memoryStore(initial)
  const source = createOutboundSource([])
  const baseConfig = createOutboundConfigService({
    store,
    yamlRows: yaml,
    source,
    adminEnabled: false,
    allowLegacy: false,
  })
  const calls = { save: [], remove: [] }
  const config = {
    ...baseConfig,
    save(type, patch) {
      calls.save.push({ type, patch })
      return baseConfig.save(type, patch)
    },
    remove(type, options) {
      calls.remove.push({ type, options })
      return baseConfig.remove(type, options)
    },
  }
  const health = createSurfaceHealth()
  const local = createLocalNotificationSurface({ outboundConfig: config, health, platformInfo })
  return { store, source, baseConfig, config, calls, health, local }
}

function makeService({ config = {}, local, health = createSurfaceHealth(), channels, revision = createSurfaceRevision(), activity = createSurfaceActivity(), channelTest } = {}) {
  const projection = () => createChannelProjection({ outboundConfig: config, health })
  return createControlSurfaceService({
    revision,
    channels: channels ?? { list: () => projection().list(), get: (type) => projection().get(type) },
    outboundConfig: config,
    local,
    channelTest,
    tasks: { list: () => [] },
    questions: { list: () => [], settle: () => ({ settled: false }) },
    activity,
    health,
    storageStatus: () => ({ readFailed: false }),
    launchTickets: { mint: () => ({ ticket: 'x', expiresAt: 1 }) },
    adminLocation: () => null,
  })
}

test('渠道行带 local/remote scope：desktop/bell 是本机通知', () => {
  assert.deepEqual([...LOCAL_TYPES], ['desktop', 'bell'])
  const { config, health } = setup()
  const rows = createChannelProjection({ outboundConfig: config, health }).list()
  const byType = new Map(rows.map((row) => [row.type, row]))
  assert.equal(byType.get('desktop').scope, 'local')
  assert.equal(byType.get('bell').scope, 'local')
  assert.equal(byType.get('telegram').scope, 'remote')
  assert.equal(byType.get('wechat').scope, 'remote', '仅入站渠道同样是远程')
  for (const row of rows) assert.ok(row.scope === 'local' || row.scope === 'remote', `${row.type} 缺少 scope`)
})

test('local.get：yaml 管理的 desktop 行 + 未配置的 bell 行 + 平台信息形状', () => {
  const yaml = new Map([['desktop', { type: 'desktop', enabled: true, sound: true }]])
  const { local } = setup({ yaml })
  const view = local.get()

  assert.equal(view.desktop.type, 'desktop')
  assert.equal(view.desktop.enabled, true)
  assert.equal(view.desktop.active, false, '没有运行时实例时 active 必须 false')
  assert.equal(view.desktop.managedBy, 'yaml')
  assert.equal(view.desktop.sound, 'always', 'YAML 裸 true 归一化为 always')
  assert.equal(view.desktop.health.state, 'degraded')

  assert.equal(view.bell.type, 'bell')
  assert.equal(view.bell.enabled, false)
  assert.equal(view.bell.active, false)
  assert.equal(view.bell.managedBy, null)
  assert.equal(view.bell.count, 1)
  assert.equal(view.bell.health.state, 'unconfigured')

  const platform = view.platform
  assert.ok(['windows', 'linux', 'macos', 'other'].includes(platform.os))
  assert.ok(['supported', 'best-effort', 'unsupported'].includes(platform.support))
  assert.ok(platform.desktop === null || ['gnome', 'kde', 'other'].includes(platform.desktop))
  assert.ok(platform.backend === null || typeof platform.backend === 'string')
  assert.equal(typeof platform.detail.en, 'string')
  assert.equal(typeof platform.detail.zh, 'string')
})

test('local.get：UI 覆盖的 sound/count 归一化与 managedBy=ui', () => {
  const ui = setup({
    initial: {
      'channel:desktop:outbound': { sound: false },
      'channel:bell:outbound': { count: 9 },
    },
  })
  const view = ui.local.get()
  assert.equal(view.desktop.managedBy, 'ui')
  assert.equal(view.desktop.sound, 'never', 'false 归一化为 never')
  assert.equal(view.bell.managedBy, 'ui')
  assert.equal(view.bell.count, 5, 'count 钳制到上限 5')

  const weird = setup({
    initial: {
      'channel:desktop:outbound': { sound: 'loud' },
      'channel:bell:outbound': { count: 2.9 },
    },
  })
  const weirdView = weird.local.get()
  assert.equal(weirdView.desktop.sound, 'auto', '非法 sound 回落 auto')
  assert.equal(weirdView.bell.count, 2, 'count 截断为整数')

  const nonNumber = setup({ initial: { 'channel:bell:outbound': { count: '3' } } })
  assert.equal(nonNumber.local.get().bell.count, 1, '非数字 count 默认 1')
})

test('local.save：启用 desktop/bell 产出非空 patch 并热应用', () => {
  const { local, calls, store, source } = setup()

  const desktop = local.save({ type: 'desktop', enabled: true })
  assert.deepEqual(calls.save[0], { type: 'desktop', patch: { sound: 'auto' } })
  assert.deepEqual(store.snapshot()['channel:desktop:outbound'], { sound: 'auto' })
  assert.deepEqual(desktop, { type: 'desktop', enabled: true, applied: true, applyMode: 'hot' })
  assert.equal(source.has('desktop'), true, '启用后运行时同步替换')
  assert.equal(local.get().desktop.active, true)

  const bell = local.save({ type: 'bell', enabled: true, options: { count: 3 } })
  assert.deepEqual(calls.save[1], { type: 'bell', patch: { count: 3 } })
  assert.deepEqual(store.snapshot()['channel:bell:outbound'], { count: 3 })
  assert.deepEqual(bell, { type: 'bell', enabled: true, applied: true, applyMode: 'hot' })
  assert.equal(local.get().bell.count, 3)
})

test('local.save：非法 type/enabled/options → bad-request，且不写盘', () => {
  const { local, calls, store } = setup()
  const invalid = [
    {},
    { type: 'telegram', enabled: true },
    { type: 'desktop' },
    { type: 'desktop', enabled: 'yes' },
    { type: 'desktop', enabled: 1 },
    { type: 'desktop', enabled: true, options: { sound: 'loud' } },
    { type: 'desktop', enabled: true, options: 'quiet' },
    { type: 'bell', enabled: true, options: { count: 0 } },
    { type: 'bell', enabled: true, options: { count: 6 } },
    { type: 'bell', enabled: true, options: { count: 2.5 } },
    { type: 'bell', enabled: true, options: { count: '3' } },
  ]
  for (const payload of invalid) {
    assert.throws(() => local.save(payload), (error) => error?.code === 'bad-request', JSON.stringify(payload))
  }
  assert.deepEqual(calls.save, [])
  assert.deepEqual(store.snapshot(), {})
})

test('local.save：关闭 YAML 管理的本机通知 → not-supported，且不动配置', () => {
  const yaml = new Map([['bell', { count: 2 }]])
  const { local, calls, store } = setup({ yaml })
  assert.throws(() => local.save({ type: 'bell', enabled: false }), (error) => {
    assert.equal(error.code, 'not-supported')
    assert.match(error.message, /cordis\.patch\.yml/)
    return true
  })
  assert.deepEqual(calls.remove, [])
  assert.deepEqual(store.snapshot(), {})
})

test('YAML 无选项行也算 profile 管理：managedBy=yaml，且不能从 UI 关闭', () => {
  const zeroOption = setup({ yaml: new Map([['bell', { type: 'bell', enabled: true }]]) })
  assert.equal(zeroOption.config.baseConfigured('bell'), true, 'YAML 行存在即 profile 配置，与是否有选项无关')
  const view = zeroOption.local.get()
  assert.equal(view.bell.managedBy, 'yaml')
  assert.equal(view.bell.enabled, true)
  assert.throws(() => zeroOption.local.save({ type: 'bell', enabled: false }), (error) => {
    assert.equal(error.code, 'not-supported')
    assert.match(error.message, /cordis\.patch\.yml/)
    return true
  })
  assert.deepEqual(zeroOption.store.snapshot(), {})
})

test('UI 启用的本机通知重启后仍归 UI 管（resolvedRows 不得被误判成 YAML）', () => {
  // 重启后的真实装配：composeOutboundChannels 把 canonical 覆盖合并进 resolved.channels，
  // 于是 resolvedRows 里也有 desktop。它仍必须 managedBy=ui 且可关闭。
  const store = memoryStore({ 'channel:desktop:outbound': { sound: 'auto' } })
  const source = createOutboundSource([{ type: 'desktop', config: { sound: 'auto' } }])
  const config = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    resolvedRows: new Map([['desktop', { sound: 'auto' }]]),
    source,
    adminEnabled: false,
    allowLegacy: false,
  })
  const local = createLocalNotificationSurface({ outboundConfig: config })

  assert.equal(config.baseConfigured('desktop'), false)
  assert.equal(config.overlayConfigured('desktop'), true)
  assert.equal(local.get().desktop.managedBy, 'ui')
  assert.deepEqual(config.raw('desktop'), { sound: 'auto' })
  const result = local.save({ type: 'desktop', enabled: false })
  assert.equal(result.enabled, false)
  assert.equal(Object.prototype.hasOwnProperty.call(store.snapshot(), 'channel:desktop:outbound'), false)
  // 审查项 P1：撤销后启动快照（resolvedRows）不得让配置复活——raw 必须为空。
  assert.deepEqual(config.raw('desktop'), {}, 'revoke 后 raw 不得从 resolvedRows 复活')
  assert.equal(config.describe('desktop').configured, false)
})

test('撤销覆盖后 raw 不复活，但覆盖存在期间保留装配 resolve 默认值（Admin 合并视图兼容）', () => {
  const store = memoryStore({ 'channel:bark:outbound': { key: 'k' } })
  const resolved = { endpoint: 'https://api.day.app/x', key: 'k', timeoutMs: 5000 }
  const source = createOutboundSource([{ type: 'bark', config: resolved }])
  const config = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    resolvedRows: new Map([['bark', resolved]]),
    source,
    adminEnabled: false,
    allowLegacy: false,
  })

  // 覆盖仍在：允许借用启动快照里的 resolve 默认值（Admin 「YAML ⊕ store」合并视图依赖）。
  assert.deepEqual(config.raw('bark'), resolved)
  const removed = config.remove('bark', { mode: 'revoke' })
  assert.equal(removed.deleted, true)
  // 覆盖已撤销：启动快照不得把配置复活。
  assert.deepEqual(config.raw('bark'), {})
  assert.equal(config.describe('bark').configured, false)
})

test('撤销 UI 覆盖后 channels.test 不再发送（raw 为空 → not-configured）', async () => {
  const store = memoryStore({ 'channel:bell:outbound': { count: 3 } })
  const source = createOutboundSource([{ type: 'bell', config: { count: 3 } }])
  const config = createOutboundConfigService({
    store,
    yamlRows: new Map(),
    resolvedRows: new Map([['bell', { count: 3 }]]),
    source,
    adminEnabled: false,
    allowLegacy: false,
  })
  const local = createLocalNotificationSurface({ outboundConfig: config })
  let tested = 0
  const service = makeService({
    config,
    local,
    channelTest: async () => { tested += 1; return { ok: true } },
  })

  const before = await service.call('channels.test', { type: 'bell' })
  assert.equal(before.ok, true)
  assert.equal(tested, 1)

  const disabled = await service.call('local.save', { type: 'bell', enabled: false })
  assert.equal(disabled.ok, true)
  assert.equal(disabled.value.enabled, false)

  const after = await service.call('channels.test', { type: 'bell' })
  assert.equal(after.ok, false)
  assert.equal(after.error.code, 'dsh-notifier/not-configured')
  assert.equal(tested, 1, '撤销后不得再发起测试发送')
})

test('YAML 无选项行：channels.test 以空 raw 调用 channelTest（不再 not-configured）', async () => {
  const yaml = new Map([
    ['desktop', { type: 'desktop', enabled: true }],
    ['bell', { type: 'bell', enabled: true }],
  ])
  const { config, health, local, source } = setup({ yaml })
  source.replace('desktop', { sound: 'auto' })
  source.replace('bell', { count: 1 })
  assert.deepEqual(config.raw('desktop'), {}, '无选项 YAML 行没有可读字段')
  assert.deepEqual(config.raw('bell'), {})
  assert.equal(config.describe('desktop').configured, true, '有效 YAML 行已 resolve 并进入运行时，即使 raw 为空也已配置')
  assert.equal(config.describe('bell').configured, true)

  const calls = []
  const service = makeService({
    config,
    local,
    health,
    channelTest: async (type, raw) => {
      calls.push({ type, raw })
      return { ok: true, detail: 'provider accepted request' }
    },
  })
  const desktop = await service.call('channels.test', { type: 'desktop' })
  assert.equal(desktop.ok, true)
  assert.equal(desktop.value.status, 'accepted')
  const bell = await service.call('channels.test', { type: 'bell' })
  assert.equal(bell.ok, true)
  assert.deepEqual(calls, [
    { type: 'desktop', raw: {} },
    { type: 'bell', raw: {} },
  ], '空 raw 的已配置渠道交给 runChannelTest 用 adapter 默认值 resolve')
})

test('YAML 无选项行：home 投影视为已配置且 summary healthy', async () => {
  const yaml = new Map([
    ['desktop', { type: 'desktop', enabled: true }],
    ['bell', { type: 'bell', enabled: true }],
  ])
  const source = createOutboundSource([
    { type: 'desktop', config: { sound: 'auto' } },
    { type: 'bell', config: { count: 1 } },
  ])
  const config = createOutboundConfigService({
    store: memoryStore(),
    yamlRows: yaml,
    source,
    adminEnabled: false,
    allowLegacy: false,
  })
  const health = createSurfaceHealth()
  const local = createLocalNotificationSurface({ outboundConfig: config, health })
  const service = makeService({ config, local, health })

  const home = await service.call('surface.home')
  assert.equal(home.ok, true)
  assert.equal(home.value.summary.status, 'healthy', '空 raw 的 YAML 渠道不得被谎报为未配置')
  for (const type of ['desktop', 'bell']) {
    const row = home.value.channels.find((entry) => entry.type === type)
    assert.equal(row?.notify.configured, true, `${type} 空 raw 已配置，不得被过滤`)
    assert.equal(row.notify.active, true)
    assert.equal(row.scope, 'local')
  }
})

test('真正未配置且 raw 为空：channels.test 仍拒绝 not-configured', async () => {
  const { config, health, local } = setup()
  let tested = 0
  const service = makeService({
    config,
    local,
    health,
    channelTest: async () => { tested += 1; return { ok: true } },
  })
  assert.equal(config.describe('desktop').configured, false)
  const result = await service.call('channels.test', { type: 'desktop' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'dsh-notifier/not-configured')
  assert.equal(tested, 0, '未配置的零凭证通道不得被误启')
})

test('local.save：关闭 UI 覆写的本机通知 → remove(mode=revoke)', () => {
  const { local, calls, store } = setup({ initial: { 'channel:desktop:outbound': { sound: 'always' } } })
  assert.equal(local.get().desktop.managedBy, 'ui')

  const result = local.save({ type: 'desktop', enabled: false })
  assert.deepEqual(calls.remove, [{ type: 'desktop', options: { mode: 'revoke' } }])
  assert.deepEqual(result, { type: 'desktop', enabled: false, applied: true, applyMode: 'hot' })
  assert.equal(Object.prototype.hasOwnProperty.call(store.snapshot(), 'channel:desktop:outbound'), false)
  assert.equal(local.get().desktop.enabled, false)
})

test('local.save：关闭本来没配置的本机通知是幂等 no-op', () => {
  const { local, calls, store } = setup()
  const result = local.save({ type: 'bell', enabled: false })
  assert.deepEqual(result, { type: 'bell', enabled: false, applied: true, applyMode: 'hot' })
  assert.deepEqual(calls.remove, [])
  assert.deepEqual(store.snapshot(), {})
})

test('状态读取失败：get/save 明确失败，不得把读错当 false 后 no-op 成功', async () => {
  // 审查项 P1：baseConfigured/overlayConfigured 的 store 读取抛错时，若被折叠成 false，
  // disable 会走幂等 no-op 并谎报成功，而运行时可能仍在发送。
  const throwingConfig = {
    baseConfigured() { throw new Error('store unavailable') },
    overlayConfigured() { throw new Error('store unavailable') },
    describe: () => ({ configured: false, active: false }),
    raw: () => ({}),
  }
  const local = createLocalNotificationSurface({ outboundConfig: throwingConfig })
  assert.throws(() => local.get(), (error) => error?.code === 'storage-failed')
  assert.throws(() => local.save({ type: 'desktop', enabled: false }), (error) => error?.code === 'storage-failed')

  const service = makeService({ config: throwingConfig, local })
  const got = await service.call('local.get')
  assert.equal(got.ok, false)
  assert.equal(got.error.code, 'dsh-notifier/storage-failed')
  const disabled = await service.call('local.save', { type: 'desktop', enabled: false })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.code, 'dsh-notifier/storage-failed')
})

test('store.get 抛错：overlayConfigured/local.get/local.save 都 fail-closed（真实配置服务）', async () => {
  // 审查项 P1 补充：local.mjs 的 fail-closed 不能只拦住「fake config 方法抛错」，
  // 真实 outboundConfig 的 safeGet 会吞掉 store.get 异常。来源判据必须走严格读路径。
  const throwingStore = {
    get() { throw new Error('store unavailable') },
    transact() { throw new Error('store unavailable') },
  }
  const config = createOutboundConfigService({
    store: throwingStore,
    yamlRows: new Map(),
    source: createOutboundSource([]),
    adminEnabled: false,
    allowLegacy: false,
  })
  const local = createLocalNotificationSurface({ outboundConfig: config })

  assert.equal(config.baseConfigured('desktop'), false, 'baseConfigured 不读 store，仍能回答')
  assert.throws(() => config.overlayConfigured('desktop'), (error) => error?.code === 'storage-failed')

  // 其余读路径保持既有 safeGet 降级语义，不扩大行为变更面。
  assert.deepEqual(config.raw('desktop'), {})
  assert.equal(config.describe('desktop').configured, false)

  assert.throws(() => local.get(), (error) => error?.code === 'storage-failed')
  assert.throws(() => local.save({ type: 'desktop', enabled: false }), (error) => error?.code === 'storage-failed')

  const service = makeService({ config, local })
  const got = await service.call('local.get')
  assert.equal(got.ok, false)
  assert.equal(got.error.code, 'dsh-notifier/storage-failed')
  const disabled = await service.call('local.save', { type: 'desktop', enabled: false })
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.code, 'dsh-notifier/storage-failed')
})

test('配置来源为空但运行时仍活动：disable 必须失败，不得 no-op 报成功', () => {
  const activeUnmanaged = {
    baseConfigured: () => false,
    overlayConfigured: () => false,
    describe: () => ({ configured: false, active: true }),
    raw: () => ({}),
  }
  const local = createLocalNotificationSurface({ outboundConfig: activeUnmanaged })
  assert.throws(() => local.save({ type: 'bell', enabled: false }), (error) => {
    assert.equal(error.code, 'not-supported')
    assert.match(error.message, /活动/)
    return true
  })
})

test('平台探测抛错/返回垃圾 → 安全兜底，绝不抛', () => {
  const throwing = createLocalNotificationSurface({ platformInfo: () => { throw new Error('probe exploded') } })
  assert.deepEqual(throwing.get().platform, PLATFORM_FALLBACK)

  const nullish = createLocalNotificationSurface({ platformInfo: () => null })
  assert.deepEqual(nullish.get().platform, PLATFORM_FALLBACK)

  const garbage = createLocalNotificationSurface({
    platformInfo: () => ({ os: 'plan9', desktop: 'xfce', support: 'maybe', backend: 42, detail: null }),
  })
  assert.deepEqual(garbage.get().platform, PLATFORM_FALLBACK)

  const valid = createLocalNotificationSurface({
    platformInfo: () => ({ os: 'linux', desktop: 'kde', support: 'supported', backend: 'gdbus', detail: { en: 'KDE Plasma', zh: 'KDE Plasma' } }),
  })
  assert.deepEqual(valid.get().platform, {
    os: 'linux',
    desktop: 'kde',
    support: 'supported',
    backend: 'gdbus',
    detail: { en: 'KDE Plasma', zh: 'KDE Plasma' },
  })

  // 默认路径（适配器导出可能尚未落地）同样不得抛。
  const defaulted = createLocalNotificationSurface({})
  assert.ok(['windows', 'linux', 'macos', 'other'].includes(defaulted.get().platform.os))
})

test('service：local.get/local.save 信封、revision、activity 与 surface.home.local', async () => {
  const { config, health, local } = setup()
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const service = makeService({ config, local, health, revision, activity })

  const got = await service.call('local.get')
  assert.equal(got.ok, true)
  assert.equal(got.value.epoch, revision.current().epoch)
  assert.equal(got.value.revision, revision.current().revision)
  assert.equal(got.value.desktop.type, 'desktop')
  assert.equal(got.value.bell.type, 'bell')
  assert.equal(typeof got.value.platform.os, 'string')

  const beforeRevision = revision.current().revision
  const saved = await service.call('local.save', { type: 'bell', enabled: true, options: { count: 2 } })
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value, { type: 'bell', enabled: true, applied: true, applyMode: 'hot' })
  assert.equal(revision.current().revision, beforeRevision + 1, 'local.save 必须 touch revision')
  assert.equal(revision.current().topic, 'channels')

  const configuration = activity.list({ category: 'configuration' })
  assert.equal(configuration.length, 1)
  assert.match(configuration[0].title.zh, /本机通知设置已更新/)
  assert.match(JSON.stringify(configuration), /bell/)

  const home = await service.call('surface.home')
  assert.equal(home.ok, true)
  assert.deepEqual(home.value.local, {
    platform: { os: got.value.platform.os, support: got.value.platform.support },
    desktop: { enabled: false, active: false },
    bell: { enabled: true, active: true },
  })
  const bellRow = home.value.channels.find((row) => row.type === 'bell')
  assert.equal(bellRow?.scope, 'local')

  const bad = await service.call('local.save', { type: 'telegram', enabled: true })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'dsh-notifier/bad-request')
  assert.equal(revision.current().revision, beforeRevision + 1, '失败不得 touch revision')
  assert.equal(activity.list({ category: 'configuration' }).length, 1, '失败不得写 activity')
})

test('service：YAML 管理的本机通知关闭时 → dsh-notifier/not-supported', async () => {
  const { config, health, local } = setup({ yaml: new Map([['desktop', { sound: 'always' }]]) })
  const revision = createSurfaceRevision()
  const activity = createSurfaceActivity()
  const service = makeService({ config, local, health, revision, activity })

  const result = await service.call('local.save', { type: 'desktop', enabled: false })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'dsh-notifier/not-supported')
  assert.match(result.error.message, /cordis\.patch\.yml/)
  assert.deepEqual(activity.list(), [])
})

test('service：缺少 local 依赖 → local.* not-supported，surface.home 省略 local', async () => {
  const service = makeService({})
  const missing = await service.call('local.get')
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'dsh-notifier/not-supported')
  const missingSave = await service.call('local.save', { type: 'desktop', enabled: true })
  assert.equal(missingSave.ok, false)
  assert.equal(missingSave.error.code, 'dsh-notifier/not-supported')

  const home = await service.call('surface.home')
  assert.equal(home.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call(home.value, 'local'), false)
  assert.equal(home.value.summary.status, 'unconfigured')
  assert.equal(home.value.summary.detail.zh, '尚未配置任何通知方式')
  assert.equal(home.value.summary.detail.en, 'No notification method configured')
})

test('service：local.get 抛错时 surface.home 仍成功，只是省略 local', async () => {
  const service = makeService({
    local: { get() { throw new Error('probe exploded') } },
  })
  const home = await service.call('surface.home')
  assert.equal(home.ok, true)
  assert.equal(Object.prototype.hasOwnProperty.call(home.value, 'local'), false)
  assert.equal(home.value.summary.status, 'unconfigured')
})
