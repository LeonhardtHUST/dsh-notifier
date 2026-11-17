import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function fakeReact() {
  const noop = () => {}
  class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(patch) { this.state = { ...this.state, ...patch } }
  }
  return {
    Component,
    createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
    useCallback(fn) { return fn },
    useEffect() {},
    useMemo(fn) { return fn() },
    useRef(value) { return { current: value } },
    useState(value) { return [typeof value === 'function' ? value() : value, noop] },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
}

function textOf(node) {
  const chunks = []
  const visit = value => {
    if (value === null || value === undefined || value === false) return
    if (typeof value === 'string' || typeof value === 'number') { chunks.push(String(value)); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value === 'object') visit(value.children)
  }
  visit(node)
  return chunks.join('')
}

function collect(node, predicate) {
  const out = []
  const visit = value => {
    if (value === null || value === undefined || value === false) return
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value !== 'object') return
    if (predicate(value)) out.push(value)
    visit(value.children)
  }
  visit(node)
  return out
}

function loadModule({ rpcCall } = {}) {
  let source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  source = source.replace(
    "return {\n      inject: ['slots', 'connection', 'locale', 'layout'],",
    "return {\n      __test: { createController, launchAdvancedConsole, QuestionCard, TaskRow, ChannelRow, ActivityRow, LocalView, LocalRow, HomeView, ChannelsView, MainPanel, isLocalRow },\n      inject: ['slots', 'connection', 'locale', 'layout'],",
  )
  assert.match(source, /__test:/)
  let registration
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } }, open() { return null } },
    document: {
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
      head: { appendChild() {} },
      createElement() { return { dataset: {}, textContent: '', remove() {} } },
    },
    setInterval() { return 1 }, clearInterval() {}, setTimeout, clearTimeout, AbortController, console,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(registration.id, packageJson.name, 'host client graph keys factories by the npm package name')
  assert.equal(registration.id, '@leonhardthust/dsh-notifier')
  const mod = registration.factory(name => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require ${name}`)
  })
  const ctx = {
    locale: { resolveText(value) { return typeof value === 'string' ? value : value?.en ?? '' } },
    connection: { rpc: { call: rpcCall ?? (async () => ({ ok: true, value: { revision: 0 } })) } },
  }
  return { mod, ctx }
}

test('client module registers the four intended DSH slots', () => {
  const { mod } = loadModule()
  assert.deepEqual(Array.from(mod.inject), ['slots', 'connection', 'locale', 'layout'])
  const registrations = []
  const effects = []
  const ctx = {
    effect(fn) { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    locale: { register() { return () => {} }, bind() { return key => key }, subscribe() { return () => {} }, resolveText(v) { return typeof v === 'string' ? v : v?.en ?? '' } },
    layout: { selectPanel() {} },
    connection: { rpc: { async call() { return { ok: true, value: { revision: 0 } } } } },
    slots: { inject(_name, fn) { return fn() }, register(options, component) { registrations.push({ options, component }); return () => {} } },
  }
  mod.apply(ctx)
  assert.deepEqual(registrations.map(x => x.options.name).sort(), ['main', 'plugins.bundle.activation', 'plugins.bundle.config', 'sidebar.panellist'])
  assert.equal(registrations.find(x => x.options.name === 'main').options.key, 'dsh-notifier')
  const panellist = registrations.find(x => x.options.name === 'sidebar.panellist')
  assert.equal(panellist.options.id, 'dsh-notifier')
  // 宿主 resolveSlotLabel 只对函数求值：label 必须是 thunk（对象会被当 React child 渲染并崩掉 sidebar）
  assert.equal(typeof panellist.options.label, 'function')
  assert.equal(panellist.options.label(), 'Notify & Control')
  for (const d of effects.reverse()) d()
})

test('advanced console keeps popup handle, severs opener, renders disabled state', async () => {
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, location: { replaced: null, replace(url) { this.replaced = url } } }
  const { mod } = loadModule()
  const calls = []
  const result = mod.__test.launchAdvancedConsole(
    { async createStandaloneLaunch() { return { available: false, reason: 'disabled' } } },
    key => key,
    { open(url, target, features) { calls.push({ url, target, features }); return popup } },
  )
  assert.equal(result.opened, true)
  assert.equal(popup.opener, null)
  assert.deepEqual(calls[0], { url: 'about:blank', target: '_blank', features: undefined })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(popup.document.body.textContent, 'advancedDisabled')
  assert.equal(popup.location.replaced, null)
})

test('advanced console navigates the retained popup on successful launch', async () => {
  const popup = { opener: {}, document: { title: '', body: { textContent: '' } }, location: { replaced: null, replace(url) { this.replaced = url } } }
  const { mod } = loadModule()
  mod.__test.launchAdvancedConsole(
    { async createStandaloneLaunch() { return { available: true, url: 'http://127.0.0.1:8104/#ticket=fake' } } },
    key => key,
    { open() { return popup } },
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(popup.opener, null)
  assert.equal(popup.location.replaced, 'http://127.0.0.1:8104/#ticket=fake')
})

test('question conflict race normalizes to alreadyHandled and refreshes home', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(channel, endpoint) {
      calls.push({ channel, endpoint })
      if (endpoint === 'questions.settle') return { ok: false, error: { code: 'dsh-notifier/conflict', message: 'already handled' } }
      if (endpoint === 'surface.home') return { ok: true, value: { revision: 3, summary: { status: 'healthy', detail: 'ok' }, questions: [], tasks: [], channels: [], activity: [] } }
      return { ok: true, value: { revision: 3 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  const result = await controller.settleQuestion('q1', 'reject', [])
  assert.deepEqual({ settled: result.settled, alreadyHandled: result.alreadyHandled }, { settled: false, alreadyHandled: true })
  assert.equal(calls.filter(x => x.endpoint === 'surface.home').length, 1)
  controller.dispose()
})

test('controller treats epoch change as restart and clears old revision/cache truth', async () => {
  let epoch = 'epoch-a'
  let revision = 9
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'surface.home') return { ok: true, value: { epoch, revision, summary: {}, questions: [], tasks: [], channels: [], activity: [] } }
      if (endpoint === 'channels.list') return { ok: true, value: { epoch, revision, channels: [{ type: 'telegram' }] } }
      if (endpoint === 'channels.get') return { ok: true, value: { epoch, revision, channel: { type: payload.type } } }
      return { ok: true, value: { epoch, revision } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadHome()
  await controller.loadChannels()
  assert.equal(controller.getSnapshot().revision, 9)
  epoch = 'epoch-b'
  revision = 1
  await controller.loadHome()
  const restarted = controller.getSnapshot()
  assert.equal(restarted.epoch, 'epoch-b')
  assert.equal(restarted.revision, 1, '新 epoch 的低 revision 不得被旧进程高 revision 压住')
  assert.equal(restarted.channels, null, 'epoch 变化必须清除旧进程缓存')
  controller.dispose()
})

test('channel navigation clears previous channel before the next request resolves', async () => {
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      if (endpoint === 'channels.get') return { ok: true, value: { epoch: 'e', revision: 1, channel: { type: payload.type } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  controller.navigate({ kind: 'channel', type: 'telegram' })
  await controller.loadChannel('telegram')
  assert.equal(controller.getSnapshot().channel.channel.type, 'telegram')
  controller.navigate({ kind: 'channel', type: 'feishu' })
  assert.equal(controller.getSnapshot().channel, null, 'B 详情加载前不得短暂显示 A 的数据')
  controller.dispose()
})

test('frozen Question/Task/Channel/Activity view fields render exactly', () => {
  const { mod, ctx } = loadModule()
  const t = key => key
  const question = mod.__test.QuestionCard({
    ctx, t, busy: false,
    controller: { async settleQuestion() { return { settled: true, alreadyHandled: false } } },
    question: {
      ref: 'q1', question: { en: 'Choose', zh: '选择' }, context: { en: 'Context', zh: '上下文' }, multiple: true, status: 'pending',
      options: [{ value: 'a', label: { en: 'Alpha', zh: '甲' } }, { value: 'b', label: { en: 'Beta', zh: '乙' } }],
    },
  })
  assert.match(textOf(question), /Alpha/)
  assert.match(textOf(question), /Beta/)
  assert.match(textOf(question), /submit/)
  assert.doesNotMatch(textOf(question), /undefined/)

  const expired = mod.__test.QuestionCard({ ctx, t, busy: false, controller: {}, question: { ref: 'q2', question: 'Expired Q', multiple: false, status: 'expired', expiresText: '1 min ago', options: [] } })
  assert.match(textOf(expired), /expired/)
  assert.doesNotMatch(textOf(expired), /reject/)

  const task = mod.__test.TaskRow({ ctx, task: { taskRef: 'task-1', workspace: 'ws', status: 'running', attention: false, boundChannels: ['telegram'], lastActivityAt: '2026-09-25T00:00:00.000Z', relativeTime: '2 min ago' } })
  assert.match(textOf(task), /2 min ago/)
  assert.doesNotMatch(textOf(task), /2026-09-25T00:00:00/)

  const channel = mod.__test.ChannelRow({ ctx, t, onOpen() {}, channel: { type: 'telegram', label: 'Telegram', capabilities: { notify: true, control: true }, health: { state: 'healthy' } } })
  assert.match(textOf(channel), /healthy/)

  const activity = mod.__test.ActivityRow({ ctx, item: { id: 'a1', at: '2026-09-25T00:00:00.000Z', timeText: 'just now', level: 'warn', title: 'Delivery warning' } })
  assert.match(textOf(activity), /just now/)
  assert.match(textOf(activity), /Delivery warning/)
  assert.doesNotMatch(textOf(activity), /2026-09-25T00:00:00/)
})

test('local preferences load into the snapshot and reset with epoch changes', async () => {
  let epoch = 'epoch-a'
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      if (endpoint === 'local.get') return { ok: true, value: { epoch, revision: 2, desktop: { type: 'desktop', enabled: true } } }
      if (endpoint === 'surface.home') return { ok: true, value: { epoch, revision: 2, summary: {}, questions: [], tasks: [], channels: [], activity: [] } }
      return { ok: true, value: { epoch, revision: 2 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.loadLocal()
  assert.equal(controller.getSnapshot().local.desktop.enabled, true)
  epoch = 'epoch-b'
  await controller.loadHome()
  assert.equal(controller.getSnapshot().local, null, 'epoch 变化必须清除本机通知快照')
  controller.dispose()
})

test('saveLocal posts the exact payload and reloads local state', async () => {
  const calls = []
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint, payload) {
      calls.push({ endpoint, payload })
      if (endpoint === 'local.get') return { ok: true, value: { epoch: 'e', revision: 1, desktop: { type: 'desktop', enabled: true, sound: 'always' } } }
      return { ok: true, value: { type: payload.type, enabled: payload.enabled, applied: true, applyMode: 'hot' } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await controller.saveLocal('desktop', true, { sound: 'always' })
  const saveIndex = calls.findIndex(call => call.endpoint === 'local.save')
  const reloadIndex = calls.findIndex(call => call.endpoint === 'local.get')
  assert.ok(saveIndex >= 0 && reloadIndex > saveIndex, 'saveLocal 必须先保存再重读本机状态')
  assert.equal(JSON.stringify(calls[saveIndex].payload), JSON.stringify({ type: 'desktop', enabled: true, options: { sound: 'always' } }))
  assert.equal(controller.getSnapshot().local.desktop.sound, 'always')
  controller.dispose()
})

test('saveLocal rethrows the server error and still reloads local state', async () => {
  let localReads = 0
  const { mod, ctx } = loadModule({
    async rpcCall(_channel, endpoint) {
      if (endpoint === 'local.save') return { ok: false, error: { code: 'dsh-notifier/not-supported', message: 'managed by yaml' } }
      if (endpoint === 'local.get') { localReads += 1; return { ok: true, value: { epoch: 'e', revision: 1 } } }
      return { ok: true, value: { epoch: 'e', revision: 1 } }
    },
  })
  const controller = mod.__test.createController(ctx)
  await assert.rejects(
    () => controller.saveLocal('desktop', false, undefined),
    error => error.code === 'dsh-notifier/not-supported',
  )
  assert.equal(localReads, 1, '保存失败后仍要重读本机状态，避免界面停在旧开关上')
  controller.dispose()
})

test('MainPanel owns the scroll container the host does not provide', () => {
  const state = {
    view: { kind: 'home' },
    home: null, channels: null, local: null, tasks: null, activity: null, channel: null,
    busy: {}, error: null, connectionState: 'connected',
  }
  const controller = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    startWait() {},
    loadHome: async () => {},
    refreshCurrent() {},
    navigate() {},
    reportError() {},
  }
  const { mod, ctx } = loadModule()
  const tree = mod.__test.MainPanel({ controller, ctx })
  assert.equal(tree.props.className, 'dn-scroll')
  assert.equal(tree.props.key, 'home:', '视图身份变化必须重建滚动容器（回到顶部）')
})

test('HomeView lists only remote channels and always offers the desktop row', () => {
  const { mod } = loadModule()
  const state = {
    home: {
      summary: {},
      questions: [],
      tasks: [],
      channels: [
        { type: 'telegram', label: 'Telegram' },
        { type: 'desktop', scope: 'local' },
        { type: 'bell', scope: 'local' },
        { type: 'slack', scope: 'local' },
      ],
      activity: [],
    },
    busy: {},
    connectionState: 'connected',
  }
  const controller = { loadHome: async () => {}, reportError() {}, navigate() {}, refreshCurrent() {} }
  const tree = mod.__test.HomeView({ ctx: { locale: { resolveText: value => value } }, controller, state, t: key => key })
  const channelRows = collect(tree, node => node.type === mod.__test.ChannelRow)
  assert.deepEqual(channelRows.map(row => row.props.channel.type), ['telegram'])
  const localRows = collect(tree, node => node.type === mod.__test.LocalRow)
  assert.equal(localRows.length, 1)
  assert.equal(localRows[0].props.local, null, '旧服务端没有 home.local 时仍要渲染桌面通知行')
})

test('ChannelsView filters local rows out of the remote list', () => {
  const { mod } = loadModule()
  const state = {
    channels: { channels: [{ type: 'telegram' }, { type: 'desktop', scope: 'local' }, { type: 'bell' }] },
    view: { kind: 'channels' },
    busy: {},
    error: null,
  }
  const controller = { loadChannels: async () => {}, reportError() {}, navigate() {} }
  const tree = mod.__test.ChannelsView({ ctx: {}, controller, state, t: key => key })
  const rows = collect(tree, node => node.type === mod.__test.ChannelRow)
  assert.deepEqual(rows.map(row => row.props.channel.type), ['telegram'])
})

test('LocalView reflects desktop state in switch, sound radios, and yaml management', () => {
  const { mod } = loadModule()
  const ctx = { locale: { resolveText: value => value } }
  const t = key => key
  const controller = { loadLocal: async () => {}, saveLocal: async () => {}, testChannel: async () => ({ status: 'delivered' }), reportError() {}, navigate() {} }
  const base = {
    platform: { os: 'windows', support: 'supported', detail: 'Windows 11' },
    desktop: { type: 'desktop', enabled: true, active: true, managedBy: 'ui', sound: 'auto', health: {} },
    bell: { type: 'bell', enabled: false, active: false, managedBy: null, count: 1, health: {} },
  }
  const render = local => mod.__test.LocalView({ ctx, controller, t, state: { local, busy: {}, error: null } })

  const switchesOf = tree => collect(tree, node => node.props?.role === 'switch')
  const desktopSwitch = tree => switchesOf(tree).find(node => node.props['aria-label'] === 'desktopToggle')

  const tree = render(base)
  assert.equal(desktopSwitch(tree).props['aria-checked'], 'true')
  assert.equal(desktopSwitch(tree).props.disabled, false)
  assert.deepEqual(collect(tree, node => node.props?.role === 'radio').map(node => node.props.key), ['auto', 'always', 'never'])

  const unsupported = render({ ...base, platform: { ...base.platform, support: 'unsupported', detail: '' }, desktop: { ...base.desktop, enabled: false } })
  assert.equal(desktopSwitch(unsupported).props.disabled, true, '不支持的平台不能新开启')
  assert.match(textOf(unsupported), /desktopUnsupported/)

  const yaml = render({ ...base, desktop: { ...base.desktop, managedBy: 'yaml' } })
  assert.equal(desktopSwitch(yaml).props.disabled, true, 'YAML 托管时不能在本机界面关闭')
  assert.match(textOf(yaml), /managedByYaml/)
})

test('LocalView only blocks turning desktop notifications on for unsupported platforms', () => {
  const { mod } = loadModule()
  const ctx = { locale: { resolveText: value => value } }
  const t = key => key
  const saves = []
  const controller = {
    loadLocal: async () => {},
    saveLocal: (...args) => { saves.push(args); return Promise.resolve({}) },
    testChannel: async () => ({ status: 'delivered' }),
    reportError() {},
    navigate() {},
  }
  const local = {
    platform: { os: 'other', support: 'unsupported', detail: '' },
    desktop: { type: 'desktop', enabled: true, active: false, managedBy: 'ui', sound: 'auto', health: {} },
    bell: { type: 'bell', enabled: false, active: false, managedBy: null, count: 1, health: {} },
  }
  const desktopSwitchOf = tree => collect(tree, node => node.props?.role === 'switch').find(node => node.props['aria-label'] === 'desktopToggle')

  const enabledTree = mod.__test.LocalView({ ctx, controller, t, state: { local, busy: {}, error: null } })
  const enabledSwitch = desktopSwitchOf(enabledTree)
  assert.equal(enabledSwitch.props.disabled, false, '平台不支持但通知已开启时必须允许关闭，否则用户被锁死')
  enabledSwitch.props.onClick()
  assert.deepEqual(saves[0], ['desktop', false, undefined], '关闭不应携带 options')

  const offTree = mod.__test.LocalView({
    ctx, controller, t,
    state: { local: { ...local, desktop: { ...local.desktop, enabled: false } }, busy: {}, error: null },
  })
  assert.equal(desktopSwitchOf(offTree).props.disabled, true, '不支持的平台不能新开启')
})

test('LocalView disables the YAML-managed bell switch and says why', () => {
  const { mod } = loadModule()
  const ctx = { locale: { resolveText: value => value } }
  const t = key => key
  const controller = { loadLocal: async () => {}, saveLocal: async () => {}, testChannel: async () => ({}), reportError() {}, navigate() {} }
  const local = {
    platform: { os: 'linux', support: 'supported', detail: 'Linux' },
    desktop: { type: 'desktop', enabled: false, active: false, managedBy: null, sound: 'auto', health: {} },
    bell: { type: 'bell', enabled: true, active: true, managedBy: 'yaml', count: 1, health: {} },
  }
  const tree = mod.__test.LocalView({ ctx, controller, t, state: { local, busy: {}, error: null } })
  const bellSwitch = collect(tree, node => node.props?.role === 'switch').find(node => node.props['aria-label'] === 'bellTitle')
  assert.equal(bellSwitch.props.disabled, true, 'YAML 托管的终端响铃不能在界面关闭')
  assert.match(textOf(tree), /managedByYaml/, '禁用要给出原因，而不是点了报错')
})

test('ChannelsView offers a way out of setup and back to the channel list', () => {
  const { mod } = loadModule()
  const controller = { loadChannels: async () => {}, reportError() {}, navigate() {} }
  const backLinks = tree => collect(tree, node => node.type === 'button' && node.props?.className === 'dn-link')
    .filter(button => textOf(button).includes('←'))

  const setupTree = mod.__test.ChannelsView({
    ctx: {}, controller, t: key => key,
    state: { channels: { channels: [] }, view: { kind: 'channels', setup: true }, busy: {}, error: null },
  })
  assert.equal(backLinks(setupTree).length, 1, '设置流程必须能退回远程通知渠道列表')

  const listTree = mod.__test.ChannelsView({
    ctx: {}, controller, t: key => key,
    state: { channels: { channels: [] }, view: { kind: 'channels' }, busy: {}, error: null },
  })
  assert.equal(backLinks(listTree).length, 1, '远程通知渠道列表必须能返回首页')
})

test('isLocalRow trusts scope and falls back to type for older servers', () => {
  const { mod } = loadModule()
  assert.equal(mod.__test.isLocalRow({ type: 'desktop' }), true)
  assert.equal(mod.__test.isLocalRow({ type: 'bell' }), true)
  assert.equal(mod.__test.isLocalRow({ type: 'telegram', scope: 'local' }), true)
  assert.equal(mod.__test.isLocalRow({ type: 'telegram', scope: 'remote' }), false)
  assert.equal(mod.__test.isLocalRow(null), false)
})

test('panel scroll CSS keeps the host page pattern', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.dn-scroll\{[^}]*flex:1 1 auto;width:100%/, '主面板是 flex 子项，滚动容器必须撑满可用高度')
  assert.match(source, /\.dn-scroll\{[^}]*height:100%[^}]*overflow-y:auto/)
  assert.match(source, /\.dn-scroll\{[^}]*overscroll-behavior:contain/)
  assert.match(source, /@media\(prefers-reduced-motion:reduce\)\{[\s\S]*?\.dn-switch,\.dn-switchThumb\{transition:none\}/)
})

test('static safety invariants remain true', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /const RPC_CHANNEL = '\/dsh-notifier'/)
  assert.doesNotMatch(source, /Authorization|Bearer|channels\.scan|esbuild|react-dom/)
  assert.doesNotMatch(source, /'_blank', 'noopener'/)
  assert.match(source, /windowObject\.open\('about:blank', '_blank'\)/)
  assert.match(source, /popup\.opener = null/)
  assert.match(source, /'aria-label': t\('advanced'\)/)
  assert.match(source, /task\?\.relativeTime/)
  assert.match(source, /item\?\.timeText/)
  assert.match(source, /question\?\.multiple === true/)
  assert.match(source, /option\.value/)
  assert.match(source, /channel\?\.health\?\.state/)
  assert.match(source, /class ErrorBoundary extends Component/)
  assert.match(source, /data-error-code/)
  assert.match(source, /if \(fields\[key\]\?\.secret === true\) delete nextDirection\[key\]/)
})
