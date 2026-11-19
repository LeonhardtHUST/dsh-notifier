// dsh-notifier event-listener.mjs
// 自动状态推送触发线：监听 session/event（turn/end、approval/asked）与 agent/error 总线，
// 统一走 notifyAll 广播。防抖：turn/end 按 session 做尾沿 10s 合并（同 session 不刷屏）；
// approval/asked 与 agent/error 即时推送。dedup：按 session.id:seq / agent.id:turn:step 去重（24h）。

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { createKeywordFilter, createGraceQueue } from './rules.mjs'
import { createHostEventRegistrar, normalizeSessionEventArgs } from './host-events.mjs'
// 宿主生命周期（todo/goal/survey）：纯映射 + 有界状态，载荷证据见模块头。
import {
  BASELINE_CATEGORIES,
  createGoalLifecycleState,
  createTodoLifecycleState,
  intentOfSurveyToolCall,
  lifecycleStrings,
  mapGoalEvent,
  mapTodoEvent,
  toolResultCallId,
  toolResultKeepsQuestionPending,
  userQuestionReplyCallId,
} from './host/lifecycle.mjs'
// v0.5 状态上报 + 动作闭环
import { createTurnTracker } from './status/turn-tracker.mjs'
import { normalizeInbound, buildActionPayload } from './inbound/_contract.mjs'
import { guardTargets } from './inbound/target-guard.mjs'
// S-05（CWE-200）出站片段脱敏：minimal（默认）打码密钥形态 + 摘录降为 80 字符
import { maskSecrets, normalizeRedaction, MINIMAL_EXCERPT_CHARS } from './redact.mjs'
// lang: 'zh' | 'en' 自动推送文案表（未知值回落 zh）
import { stringsOf } from './strings.mjs'

/** 取会话所属工作区名：cwd 末段，否则 session id。 */
export function workspaceNameOf(session) {
  const cwd = session?.header?.cwd
  return cwd !== undefined && typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : String(session?.id ?? '')
}

/** G-18：6 位十六进制负载摘要（dedup 键追加用，与 wxpusher hash6 同法）。 */
function hash6(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 6)
}

/**
 * 从单条 assistant/message 事件提取文本块（多 text 块拼接后 trim）。
 * 事件形态对齐官方 `packages/core/session/src/types.ts` 的
 * `SessionEventMap['assistant/message'] = { turn, step, message: AssistantMessage, … }`
 * （deepseek-harness master，assistant/message 为 surface 事件，data.message.content 为块数组）。
 * 非 assistant/message / 空内容一律返回 ''（绝无异常抛出路径）。
 */
export function assistantTextOf(event) {
  if (event === null || event === undefined || event?.type !== 'assistant/message') return ''
  const blocks = event.data?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * #32 有界 assistant 文本缓存：sessionId -> 最近一次 assistant/message 的文本。
 * DSH 0.1.2 起 `session.events` getter 已移除（issue #32），turn/end 通知正文与心跳
 * 摘录不再读宿主 session 日志；assistant/message 事件本就流经 session/event 总线，
 * 趁事件到达把文本沉淀进本缓存，通知组装时按 sessionId 取。
 * 宪法#4（状态必须有界）：条目硬上限 maxEntries（缺省 256，会话并发量三个数量级余量），
 * 超限淘汰最旧（Map 插入序）。语义只取「最近一次输出」——正文与摘录都只需要最后一段；
 * 防抖本就按 session 合并（10s 窗），不引入 turn 键（新一轮产出只会让正文带上更新内容，
 * 与既有「最近输出摘录」口径一致）。
 */
export function createAssistantTextCache(maxEntries = 256) {
  const entries = new Map()
  const cap = Math.max(1, Math.trunc(Number(maxEntries)) || 256)
  return {
    /** 记录该会话最近一次输出；空文本 / 无 id 不占条目（get 缺省即 ''，语义等价）。 */
    set(sessionId, text) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (typeof text !== 'string' || text === '') return
      entries.set(sessionId, text)
      if (entries.size > cap) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    /** 取该会话最近一次输出；无条目返回 ''。 */
    get(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return ''
      return entries.get(sessionId) ?? ''
    },
    size() {
      return entries.size
    },
  }
}

/** turn/end reason.kind -> 级别（文案来自 strings 表）。kind 不在官方六值内（插件扩展）返回 undefined 保持沉默。 */
const TURN_END_META = {
  completed: { level: 'active' },
  error: { level: 'timeSensitive' },
  blocked: { level: 'timeSensitive' },
  aborted: { level: 'passive' },
  'max-tokens': { level: 'timeSensitive' },
  interrupted: { level: 'timeSensitive' },
}

/** turn/end reason.kind -> 自动通知类别（已告知主代理：aborted 单独为 session.cancelled）。 */
const TURN_END_CATEGORY = {
  completed: BASELINE_CATEGORIES.TURN_COMPLETED,
  error: BASELINE_CATEGORIES.TURN_ERROR,
  blocked: BASELINE_CATEGORIES.TURN_ERROR,
  aborted: BASELINE_CATEGORIES.TURN_CANCELLED,
  'max-tokens': BASELINE_CATEGORIES.TURN_ERROR,
  interrupted: BASELINE_CATEGORIES.TURN_ERROR,
}

/** 把 session/event 映射为可推送意图；不可推送返回 undefined。
 *  strings 可选（缺省 zh 文案表）——既有调用方零感知，lang 路径显式传入。
 *  category 供 notify 包装按类别做策略/账本（sendOptions.category），未知类别不编造。 */
export function intentOfSessionEvent(event, strings = stringsOf()) {
  switch (event?.type) {
    // v0.5 任务开始（默认关，events.turnStart.enabled === true 才放行）。
    // detail 留空：workspace 由 push 侧组装（intent 是纯函数，不持有 session）。
    case 'turn/start':
      return {
        event: 'turn/start',
        kind: 'start',
        category: BASELINE_CATEGORIES.TURN_START,
        headline: strings.turnStart,
        level: 'passive',
        detail: '',
      }
    case 'turn/end': {
      const kind = event.data?.reason?.kind
      const meta = TURN_END_META[kind]
      if (meta === undefined) return undefined
      let detail = ''
      if (kind === 'error') detail = event.data.reason?.error?.message ?? strings.turnEndDetail.error
      else if (kind === 'blocked') detail = strings.turnEndDetail.blocked
      else if (kind === 'max-tokens') detail = strings.turnEndDetail['max-tokens']
      else if (kind === 'interrupted') detail = strings.turnEndDetail.interrupted
      return {
        event: 'turn/end',
        kind,
        category: TURN_END_CATEGORY[kind],
        headline: strings.turnEndHeadline[kind],
        level: meta.level,
        detail,
      }
    }
    case 'approval/asked': {
      const data = event.data ?? {}
      const tool = typeof data.toolName === 'string' && data.toolName !== ''
        ? strings.approval.toolName(data.toolName)
        : strings.approval.toolFallback
      const reason = typeof data.reason === 'string' && data.reason !== '' ? `${strings.approval.reasonPrefix}${data.reason}` : ''
      return {
        event: 'approval/asked',
        kind: 'approval',
        category: BASELINE_CATEGORIES.APPROVAL,
        headline: strings.approval.headline,
        level: 'timeSensitive',
        detail: strings.approval.detail(tool, reason),
      }
    }
    default:
      return undefined
  }
}

/** 把 agent/error 总线负载映射为推送意图。strings 可选（缺省 zh 文案表）。 */
export function intentOfAgentError(payload = {}, strings = stringsOf()) {
  const error = payload.error
  const detail = error instanceof Error
    ? error.message
    : (typeof error === 'string' ? error : (error?.message ?? strings.agentError.detailFallback))
  return {
    event: 'agent/error',
    kind: 'error',
    category: BASELINE_CATEGORIES.AGENT_ERROR,
    headline: strings.agentError.headline,
    level: 'timeSensitive',
    detail,
  }
}

/** 自动通知来源只占一行；剥除控制/方向字符并避免伪造额外的 [来源] 标签。 */
function titleSourceOf(session, minimal) {
  const clean = (value) => typeof value === 'string'
    ? value.toWellFormed()
      .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, ' ')
      .replace(/\[/g, '(').replace(/\]/g, ')')
      .replace(/\s+/gu, ' ').trim()
    : ''
  let id = ''
  let workspace = ''
  // 宿主元数据不可读时只省略来源，不能让自动通知丢失。
  try {
    const value = session?.id
    if (typeof value === 'string' || typeof value === 'number') id = clean(String(value))
  } catch { /* 无可用 session id */ }
  try {
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') workspace = clean(workspaceNameOf(session))
  } catch { /* 回落短 session id */ }
  const hasWorkspace = workspace !== ''
  let source = hasWorkspace ? workspace : id
  // 新增的宿主数据与正文遵循同一脱敏设置，先打码再截断，避免把密钥截成漏网片段。
  if (minimal) source = maskSecrets(source)
  const chars = Array.from(source)
  if (!hasWorkspace) return chars.slice(0, 8).join('')
  return chars.length > 48 ? `${chars.slice(0, 47).join('')}…` : source
}

/**
 * 组装最终通知消息：标题前缀 + 可选来源标签 + 正文截断（summaryMaxChars）。
 * S-05：redaction: 'minimal'（默认）下，宿主会话数据片段（assistantText 摘录 / 错误全文）
 * 先打码密钥形态、摘录压到 MINIMAL_EXCERPT_CHARS（80）；'extended' 维持原行为。
 * 摘录上限只作用于「宿主数据片段」，intent.detail（自家文案）不额外截短——
 * 总正文仍受 summaryMaxChars（默认 500）钳制。
 */
export function intentToMessage(intent, { assistantText = '', config = {}, session } = {}) {
  const prefix = typeof config.titlePrefix === 'string' ? config.titlePrefix.trim() : ''
  const minimal = normalizeRedaction(config.redaction) === 'minimal'
  const source = titleSourceOf(session, minimal)
  const title = `${prefix.length > 0 ? `${prefix} ` : ''}${source !== '' ? `[${source}] ` : ''}${intent.headline}`
  let excerpt = assistantText
  if (minimal && excerpt.length > MINIMAL_EXCERPT_CHARS) {
    excerpt = excerpt.slice(-MINIMAL_EXCERPT_CHARS) // 尾沿：结论通常在最后
  }
  let content = intent.detail
  if (excerpt.length > 0) content = content.length > 0 ? `${content}\n\n---\n${excerpt}` : excerpt
  if (minimal) content = maskSecrets(content)
  const maxChars = typeof config.summaryMaxChars === 'number' && Number.isFinite(config.summaryMaxChars)
    ? Math.max(0, Math.trunc(config.summaryMaxChars))
    : 500
  if (maxChars > 0 && content.length > maxChars) content = `${content.slice(0, maxChars)}…`
  // Channels validate the payload before accepting it — PushPlus answers
  // `999 发送内容不能为空` — so a turn/end whose detail is empty AND whose
  // assistant excerpt could not be read was rejected outright instead of
  // delivering "task finished".
  if (content.trim().length === 0) {
    content = intent.event === 'turn/end'
      ? `${intent.headline}（无正文摘要）`
      : intent.headline
  }
  return { title, content, level: intent.level }
}

/** 有界 dedup 账本：一个 key 24h 窗口内只放行一次，超出 maxEntries 淘汰最旧。 */
export function createDedupLedger(maxEntries = 1000, windowMs = 24 * 60 * 60 * 1000) {
  const seen = new Map()
  return {
    /** 该 key 可放行则记录并返回 true，窗口内重复返回 false。 */
    test(key) {
      const now = Date.now()
      const previous = seen.get(key)
      if (previous !== undefined && now - previous < windowMs) return false
      seen.set(key, now)
      if (seen.size > maxEntries) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
      return true
    },
    size() {
      return seen.size
    },
  }
}

/** 尾沿防抖：每 key 一个定时器，窗口内连续触发只推送最后一次。
 *  v0.8.7 P1-7（宪法#4 状态必须有界）：timers/pending 以 sessionId 为键，条目靠自己的
 *  定时器到点自清——窗口 `debounceMs` 可配且无上限（config.mjs:207 只钳下限 0），
 *  配成分钟/小时级 + 会话高频轮换时两表可无界堆积（每条还挂一个活定时器）。
 *  补 maxKeys 上限：新 key 撑破上限时**立即触发最旧一条**（提前送达，绝不静默丢弃——
 *  宪法#3；语义退化仅限「本该再等窗口末尾」），并交给调用方 warn。
 * @param {number} [windowMs=10000]
 * @param {object} [options]
 * @param {number} [options.maxKeys=256] - 在途 key 上限（会话并发量的三个数量级余量）
 * @param {(key: string, pendingCount: number) => void} [options.onOverflow] - 提前触发通报（异常被吞）
 */
export function createTrailingDebounce(windowMs = 10000, { maxKeys = 256, onOverflow } = {}) {
  const timers = new Map()
  const pending = new Map()
  const cap = Math.max(1, Math.trunc(Number(maxKeys)) || 256)
  const fireNow = (key) => {
    const timer = timers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(key)
    const fn = pending.get(key)
    pending.delete(key)
    if (typeof fn === 'function') { try { return fn() } catch { /* 任务异常绝不外抛 */ } }
    return undefined
  }
  return {
    schedule(key, task) {
      // 腾位在写入前：只有「新 key」才可能撑破上限（同 key 重排不增长）
      while (!pending.has(key) && pending.size + 1 > cap) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        if (typeof onOverflow === 'function') {
          try { onOverflow(oldest, pending.size) } catch { /* 通报失败不致命 */ }
        }
        fireNow(oldest)
      }
      pending.set(key, task)
      const previous = timers.get(key)
      if (previous !== undefined) clearTimeout(previous)
      timers.set(key, setTimeout(() => {
        timers.delete(key)
        const fn = pending.get(key)
        pending.delete(key)
        if (typeof fn === 'function') fn()
      }, windowMs))
    },
    /** 立即触发所有未到期的 pending 任务（headless 一次性运行退出前 flush 用），返回它们的返回值。 */
    flush() {
      const triggered = []
      for (const [key, fn] of pending) {
        triggered.push(typeof fn === 'function' ? fn() : undefined)
      }
      // v0.8.7（宪法#4）：必须逐个 clearTimeout 再清表——只 `timers.clear()` 会让已挂起的
      // 定时器留在事件循环里（回调本身已是空转，但 Node 进程要等它们全部到点才退出）。
      // debounceMs 配成分钟级 + 有界表满 256 条时，卸载后进程可被吊住整个窗口时长。
      // grace 侧 flush 一直是这么做的（rules.mjs:152），此处对齐。
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
      return triggered
    },
    pendingCount() {
      return pending.size
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      pending.clear()
    },
  }
}

/**
 * 订阅事件总线做自动推送。
 * @param ctx - cordis 上下文（ctx.on + ctx.logger）。
 * @param notifier - createNotifier 返回的 { notifyAll, channels }。
 * @param resolvedConfig - resolveConfig 返回的 { enabled, debounceMs, events, keywords, graceSeconds, ... }。
 * @param {object} [wiring] - v0.3.2 路由装配（全部可选，缺省 = v0.3.0 广播行为，零感知）。
 * @param {ReturnType<typeof import('./routing/agent-router.mjs').createAgentRouter>} [wiring.router]
 *   - agent 路由引擎：事件带 session 时按「会话 diff > 精确 agentId > workspace > 全局池」解析出站目标与 quiet。
 * @param {ReturnType<typeof import('./routing/session-registry.mjs').createSessionRegistry>} [wiring.registry]
 *   - 会话注册表：出站事件时 touch（活跃信号 + 惰性建档兜底，agent/created 未触达的会话也进台账）。
 * @param {() => ReturnType<typeof import('./actions.mjs').createActionDispatcher> | null} [wiring.actions]
 *   - v0.5 动作分发器惰性 getter：stall/心跳通知附带「停止任务」按钮。
 *     惰性求值（而非直传实例）：eventListener 装配早于 inbound 栈（vault/store/通道在其后
 *     才创建），先例 = tool-register 的 channelTypes: () => ...。缺省 = 永不带按钮（v0.4.0 行为）。
 * @param {() => object[]} [wiring.interactive]
 *   - 交互通道原始实例列表惰性 getter（sendActionCard 的投递面）。缺省 = 永不带按钮。
 * @returns 反注册函数。
 */
export function createEventListener(ctx, notifier, resolvedConfig, wiring = {}) {
  const enabled = resolvedConfig.enabled !== false
  // lang 文案表：resolvedConfig.lang 已归一（未知值回落 zh），此处不再兜底
  const strings = stringsOf(resolvedConfig.lang)
  const events = resolvedConfig.events ?? { turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true, subagents: 'root-only' }
  const router = wiring.router ?? null
  // Agent topology is optional across DSH versions. Prefer explicit wiring (useful for
  // assembly/tests), then the listener context. A missing or malformed roots() API is
  // deliberately treated as unknown so notifications fail open rather than disappear.
  const agents = wiring.agents ?? wiring.ctx?.agents ?? ctx?.agents ?? null
  const subagentMode = events.subagents === 'all' ? 'all' : 'root-only'
  const rootAgentIds = () => {
    if (agents === null || typeof agents !== 'object' || typeof agents.roots !== 'function') return null
    try {
      const roots = agents.roots()
      if (roots === null || roots === undefined) return null
      const values = Array.isArray(roots)
        ? roots
        : roots instanceof Map
          ? [...roots.values()]
          : typeof roots === 'object' ? Object.values(roots) : null
      if (values === null) return null
      const ids = new Set()
      for (const root of values) {
        const id = typeof root === 'string' || typeof root === 'number'
          ? root
          : root?.id ?? root?.session?.id
        if (id !== undefined && id !== null) ids.add(String(id))
      }
      // An empty/malformed roots result cannot prove an agent is a subagent;
      // report it as unknown so the notification path remains fail-open.
      return ids.size > 0 ? ids : null
    } catch {
      return null
    }
  }
  const isSubagent = (agentOrSession) => {
    if (subagentMode === 'all') return false
    const id = agentOrSession?.id ?? agentOrSession?.session?.id
    if (id === undefined || id === null) return false
    const roots = rootAgentIds()
    if (roots === null) return false
    return !roots.has(String(id))
  }
  const registry = wiring.registry ?? null
  const busFn = typeof wiring.bus === 'function' ? wiring.bus : null
  // v0.5 动作闭环（全可选、惰性求值；调用点自带 try/catch + null 判定）
  const actionsFn = typeof wiring.actions === 'function' ? wiring.actions : null
  const interactiveFn = typeof wiring.interactive === 'function' ? wiring.interactive : null
  const keywords = createKeywordFilter(resolvedConfig.keywords)
  // 有界防抖（宪法#4）：溢出时提前触发最旧会话的待推送并告警（warn 在下方定义前先声明引用）
  const debounce = createTrailingDebounce(resolvedConfig.debounceMs ?? 10000, {
    onOverflow: (key, size) => warn(`防抖表达上限（在途 ${size} 个会话），提前推送最旧会话 ${key} 的待发通知（合并窗提前收口，不丢通知）`),
  })
  // 空闲宽限窗：turn 结束后等 N 秒再打扰；期间用户输入（user/* 事件）即取消。
  // approval/agent/error 不进宽限窗——它们等人决策，晚到等于没到。
  const grace = createGraceQueue({
    seconds: resolvedConfig.graceSeconds ?? 0,
    onOverflow: (key, size) => warn(`宽限窗表达上限（在途 ${size} 个会话），提前推送最旧会话 ${key} 的待发通知（宽限提前收口，不丢通知）`),
  })
  const dedup = createDedupLedger()
  // #32：turn/end 正文与心跳摘录的有界来源（见 createAssistantTextCache 注释）
  const assistantCache = createAssistantTextCache()
  // 生命周期通知（todo/goal/survey）：文案与有界状态。状态必须在类别开关之前前进，
  // 否则用户稍后打开 changed/paused 时会用旧快照算出错误的「变化」。
  const lifecycleText = lifecycleStrings(resolvedConfig.lang)
  const todoState = createTodoLifecycleState()
  const goalState = createGoalLifecycleState()
  /** 会话标题：优先生效 wiring.sessionTitleOf(session)（装配层注入宿主 title 服务），
   *  其次 session.title / session.header.title，最后 null。任何读取失败都不得阻断通知。 */
  const sessionTitleOf = (session) => {
    try {
      if (typeof wiring.sessionTitleOf === 'function') {
        const value = wiring.sessionTitleOf(session)
        if (typeof value === 'string' && value.trim() !== '') return value
      }
    } catch { /* 标题是元数据，读失败只丢字段 */ }
    try {
      const value = session?.title ?? session?.header?.title
      if (typeof value === 'string' && value.trim() !== '') return value
    } catch { /* 宿主元数据不可读时保持 null */ }
    return null
  }
  /** session.id 的安全读取（数字也接受；空值不塞空串进 sendOptions）。 */
  const sessionIdOf = (session) => {
    try {
      const value = session?.id
      if (typeof value === 'string') return value === '' ? null : value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    } catch { /* 无可用 id */ }
    return null
  }
  const warn = (message) => {
    try { ctx?.logger?.warn?.('[dsh-notifier]', message) } catch { /* 日志失败绝不致命 */ }
  }

  // ---- 待决通知的短延迟收口（approval/survey 假阳性防护）----
  // DSH ApprovalService.request() 先 append `approval/asked`，再跑 waterfall；policy='never'
  // 或 signal 已 abort 时会立刻 append `approval/decided`。若 asked 一到就推送，用户会收到
  // 一条「需要批准」但实际从未等待的通知。这里只做事件层短延迟：asked 按请求 id 挂一个
  // 可取消定时器，decided 同 id 到达即取消；waterfall/回答链完全不变。
  // survey 同理：ask_user_question 的 tool/call 之后若立即 tool/result（无等待/秒回错误），
  // 按 callId 取消，不推送。id-less 的旧形状 approval 保持既有即时行为。
  const settleDelayMs = (() => {
    const value = Number(wiring.lifecycleSettleMs)
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 1500
  })()
  const MAX_PENDING_SETTLES = 256
  const settles = new Map()
  const fireSettle = (key) => {
    const entry = settles.get(key)
    if (entry === undefined) return undefined
    settles.delete(key)
    try { return entry.task() } catch { return undefined }
  }
  const cancelSettle = (key) => {
    const entry = settles.get(key)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    settles.delete(key)
  }
  const scheduleSettle = (key, task) => {
    cancelSettle(key)
    // 测试/显式 0：保持同步即时语义（存量调用方零感知）。
    if (settleDelayMs <= 0) return task()
    while (settles.size >= MAX_PENDING_SETTLES) {
      const oldest = settles.keys().next().value
      if (oldest === undefined) break
      warn(`待决通知表达上限（${MAX_PENDING_SETTLES}），提前处理最旧一条（${oldest.startsWith('approval:') ? 'approval' : 'survey'}）`)
      fireSettle(oldest)
    }
    const timer = setTimeout(() => { fireSettle(key) }, settleDelayMs)
    timer.unref?.()
    settles.set(key, { timer, task })
    return undefined
  }
  const flushSettles = () => {
    const triggered = []
    for (const key of [...settles.keys()]) triggered.push(fireSettle(key))
    return triggered
  }
  const approvalIdOf = (event) => {
    try {
      const id = event?.data?.id
      return typeof id === 'string' && id !== '' ? id : null
    } catch { return null }
  }
  // P1-2 错误可见性（2026-08-20，Trae1）：keywords.regex 开启时，非法正则条目会静默
  // 降级为字面量子串匹配——语义从「正则命中」变「子串包含」，include 规则可能因此
  // 永不命中（通知静默停止）、exclude 规则可能漏拦。降级本身保留（宁可漏拦不炸启动），
  // 但必须让用户看见哪些条目降级了。
  if (Array.isArray(keywords.regexFallbacks) && keywords.regexFallbacks.length > 0) {
    warn(`keywords.regex 中 ${keywords.regexFallbacks.length} 条非法正则已降级为字面量匹配（语义变化，请修正）: ${keywords.regexFallbacks.join(' | ').slice(0, 200)}`)
  }

  /** 事件粒度门：配置关掉的事件线/结束原因直接静默（不占 dedup 名额）。
   *  容忍两种形状：resolveConfig 归一化的 { enabled, kinds } 与原始的 { completed: false } 直传。
   *  生命周期类别全部放行给 notify 的会话通知策略矩阵（唯一权威）；这里只保留
   *  既有 events.* 开关，不引入第二套类别默认值。 */
  const eventAllowed = (intent) => {
    if (intent.event === 'turn/end') {
      const turnEnd = events.turnEnd
      if (turnEnd === false) return false
      if (turnEnd?.enabled === false) return false
      const kinds = turnEnd?.kinds ?? (turnEnd ?? {})
      return kinds[intent.kind] !== false
    }
    // v0.5 任务开始：默认关。旧形状直传（events 无此键）→ undefined !== true → 静默，
    // 既有调用方零感知（resolveConfig 归一后才有 enabled: false / true 之分）。
    if (intent.event === 'turn/start') return events.turnStart?.enabled === true
    if (intent.event === 'approval/asked') return events.approval !== false
    // todo/write、goal/change、survey 的 tool/call：送达由会话通知策略矩阵裁决。
    if (intent.event === 'todo/write' || intent.event === 'goal/change') return true
    if (intent.event === 'tool/call') return true
    return events.agentError !== false
  }

  /**
   * v0.3.2 出站分流：事件带 session 时按解析链算出 { channelTypes, quiet }。
   * router 缺失 / session 无 id / 解析异常一律回落「不过滤、不静音」（广播，向后兼容）。
   */
  const resolveOutboundOf = (session) => {
    if (router === null || session?.id === undefined || session?.id === null) return {}
    try {
      const globalTypes = Array.isArray(notifier?.channels) ? notifier.channels : []
      const resolved = router.resolveOutbound(String(session.id), workspaceNameOf(session), globalTypes)
      return { channelTypes: resolved.channelTypes, quiet: resolved.quiet }
    } catch (error) {
      warn(`出站路由解析失败，本次按全局广播: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  // ---- v0.5 状态上报：文案与动作卡片 ----

  /** 毫秒 → 人读时长（45s / 23m / 2h5m；不足 1s 计 0s）。 */
  const formatDuration = (ms) => {
    const totalSec = Math.max(0, Math.round(Number(ms) / 1000))
    if (totalSec < 60) return `${totalSec}s`
    const min = Math.floor(totalSec / 60)
    if (min < 60) return `${min}m`
    const hour = Math.floor(min / 60)
    return hour > 0 && min % 60 > 0 ? `${hour}h${min % 60}m` : `${hour}h`
  }

  /** longRunning / stall 的正文组装：workspace / sid / 运行时长 / hint（心跳附最近输出摘录）。 */
  const composeStatusBody = (intent, session) => {
    const workspace = workspaceNameOf(session)
    const sid = String(session?.id ?? '')
    const lines = sid !== '' && sid !== workspace ? [`${workspace} / ${sid.slice(0, 8)}`] : [workspace]
    if (intent.info !== undefined && intent.info !== null) {
      lines.push(strings.status.runtimeLine(formatDuration(intent.info.elapsedMs), formatDuration(intent.info.idleMs)))
    }
    if (intent.event === 'stall') {
      lines.push(strings.status.stallHint)
    } else {
      // S-05：minimal（默认）摘录 200→80 + 密钥形态打码；extended 维持原文
      const minimal = normalizeRedaction(resolvedConfig.redaction) === 'minimal'
      const cap = minimal ? MINIMAL_EXCERPT_CHARS : 200
      // #32：从有界缓存取最近输出（不再读宿主 session 日志；session.events 于 DSH 0.1.2 移除）
      let excerpt = assistantCache.get(String(session?.id ?? '')).slice(-cap).trim()
      if (minimal) excerpt = maskSecrets(excerpt)
      if (excerpt !== '') lines.push(`${strings.status.recentOutputPrefix}${excerpt}`)
      lines.push(strings.status.stopHint)
    }
    return lines.join('\n')
  }

  /**
   * 对全部交互通道发动作卡片（stall / 心跳通知的「⏹ 停止任务」按钮）。
   * 尽力而为语义：dispatcher 缺失 / 铸造失败 / 单通道失败 → 静默跳过——通知文本里的
   * 「回复 /stop 取消」hint 已是全通道兜底，卡片是增强 UX 而非依赖路径。
   * `legacyGate` 仅用于没有 canSendRemote 的旧 notifier（存量同步语义）。新 notifier
   * 的铸造前闸在 push() 里统一判定；card 的远端对称抑制留给 notify 包装另行收敛。
   */
  const pushActionCard = (session, message, { legacyGate = true } = {}) => {
    // Presence suppression applies to automatic action cards as well as their text
    // notification; otherwise a remote Stop button would bypass the de-duplication gate.
    if (legacyGate) {
      try { if (typeof notifier?.shouldSuppressRemote === 'function' && notifier.shouldSuppressRemote() === true) return } catch { /* fail open */ }
    }
    const dispatcher = (() => { try { return actionsFn() } catch { return null } })()
    const rawList = (() => { try { return interactiveFn() } catch { return null } })()
    if (dispatcher === null || dispatcher === undefined) return
    if (!Array.isArray(rawList) || rawList.length === 0) return
    const sessionId = String(session?.id ?? '')
    if (sessionId === '') return
    let minted = null
    try { minted = dispatcher.mintAction('turn/cancel', { sessionId }) } catch { /* 铸造失败降级纯文本 */ }
    if (minted === null || minted === undefined) return
    const data = buildActionPayload(minted.key, minted.token)
    for (const raw of rawList) {
      const inbound = normalizeInbound(raw)
      if (inbound === null) continue
      // v0.7 形状守卫：动作卡片与审批卡片同一道防线（跨渠道串门目标 skip）。
      // warn 必传（R5 审查 R5-3-P2-1：null 静默——守卫错杀在这条路径不可观测）
      const targets = inbound.notifyTargets()
      const { kept } = guardTargets(inbound.channel, targets, warn)
      if (kept.length === 0 && targets.length > 0) {
        warn(`动作卡片目标全被形状守卫拦截（${inbound.channel} ${targets.length} 个目标 0 个合格）——请核对通知目标 id 形态`)
      }
      for (const target of kept) {
        // v0.8.4 F-08：发送前先登记来源会话（channel + chatId），dispatch 据此校验点击
        // 来源（转发拒绝）。登记先行避免「已发出卡片但账本无来源」的竞态窗口；发送失败
        // /降级 null 时撤销登记，绝不含糊地放行未知来源。尽力而为：失败不拖累主链路。
        try { dispatcher.markSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 登记失败不致命 */ }
        Promise.resolve(inbound.sendActionCard({
          chatId: target.chatId,
          title: message.title,
          content: message.content,
          actions: [{ label: strings.status.stopActionLabel, data }],
        })).then((card) => {
          if (card === null || card === undefined) {
            try { dispatcher.unmarkSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 撤销失败不致命 */ }
          }
        }).catch(() => {
          try { dispatcher.unmarkSource(minted.key, inbound.channel, String(target.chatId)) } catch { /* 撤销失败不致命 */ }
        })
      }
    }
  }

  // v0.5 turn 跟踪器：心跳/卡住信号源。仅当对应 events 键 enabled 时装定时器
  // （旧形状直传 resolvedConfig——events 无此三键——则 tracker 空转，零感知）。
  // trackerOverrides 为测试注入口（now/定时器/minMs 钳制）；展开在前、显式配置在后，
  // 测试无法覆盖回调与启停语义。
  const heartbeatCfg = events.longRunning?.enabled === true
    ? { firstAfterMs: events.longRunning.firstAfterMs, everyMs: events.longRunning.everyMs }
    : null
  const stallCfg = events.stall?.enabled === true ? { afterMs: events.stall.afterMs } : null
  const statusIntent = (event, headline, level, info) => ({
    event,
    kind: event,
    category: BASELINE_CATEGORIES.STATUS,
    headline,
    level,
    detail: '',
    info,
  })
  const trackerOverrides = (wiring.trackerOverrides !== null && typeof wiring.trackerOverrides === 'object')
    ? wiring.trackerOverrides
    : {}
  const tracker = createTurnTracker({
    ...trackerOverrides,
    heartbeat: heartbeatCfg,
    stall: stallCfg,
    onHeartbeat: (session, info) => push(statusIntent('longRunning', strings.status.longRunningHeadline, 'passive', info), session),
    onStall: (session, info) => push(statusIntent('stall', strings.status.stallHeadline, 'timeSensitive', info), session),
  })

  /** 出站选项：分流/静音 + 通知包装需要的会话元数据与类别。 */
  const deliveryOptionsOf = (intent, session) => {
    const options = resolveOutboundOf(session)
    const sessionId = sessionIdOf(session)
    const category = typeof intent.category === 'string' && intent.category !== '' ? intent.category : undefined
    return {
      ...options,
      ...(sessionId !== null ? { sessionId } : {}),
      sessionTitle: sessionTitleOf(session),
      ...(category !== undefined ? { category } : {}),
      // 远端交互归属：装配层注入的 ownsRemoteAttention 只在 approval/survey 上生效，
      // 返回 true 表示真实 native/approval 控制路由会承载交互卡片；此时会话通知只补本机。
      // 未注入、返回 undefined/false 或抛错都保持原样（仅自有 ask_user 自带 localOnly）。
      ...(intent.localOnly === true || ownsRemoteAttention(intent, session) ? { localOnly: true } : {}),
    }
  }
  /** 只对 approval/survey 询问装配层的远端交互归属；任何异常按「不归属」处理。 */
  function ownsRemoteAttention(intent, session) {
    if (intent.category !== 'session.approval' && intent.category !== 'session.survey') return false
    if (typeof wiring.ownsRemoteAttention !== 'function') return false
    try { return wiring.ownsRemoteAttention(intent, session) === true } catch { return false }
  }

  /** 新的 notify 包装用它判定「该会话是否还允许远端投放」；旧 notifier 无此方法。 */
  const hasRemoteGate = () => {
    try { return typeof notifier?.canSendRemote === 'function' } catch { return false }
  }
  const canSendRemoteNow = (sendOptions) => {
    try { return notifier.canSendRemote(sendOptions) !== false } catch { return true }
  }
  const suppressedRemotely = (outcome) => Array.isArray(outcome?.suppressed) && outcome.suppressed.length > 0

  const push = (intent, session) => {
    // v0.5 状态上报文案组装：turn/start / longRunning / stall 三类 intent 的正文
    // 需要 workspace / 运行时长 / 最近输出，intent 纯函数不持有这些，push 侧组装。
    let message
    if (intent.event === 'turn/start') {
      message = intentToMessage(intent, { assistantText: '', config: resolvedConfig, session })
      message.content = workspaceNameOf(session)
    } else if (intent.event === 'longRunning' || intent.event === 'stall') {
      message = intentToMessage(intent, { assistantText: '', config: resolvedConfig, session })
      message.content = composeStatusBody(intent, session)
    } else {
      // #32：turn/end 正文取有界缓存（assistant/message 事件到达时沉淀；不再读 session.events）
      const assistantText = intent.event === 'turn/end' ? assistantCache.get(String(session?.id ?? '')) : ''
      message = intentToMessage(intent, { assistantText, config: resolvedConfig, session })
    }
    // 关键词规则（include 白名单 / exclude 黑名单，黑名单优先）拦下即静默跳过
    const reason = keywords.why(`${message.title}\n${message.content}`)
    if (reason !== undefined) {
      warn(`关键词规则拦截推送（${reason}）`)
      return Promise.resolve(undefined)
    }
    // v0.3.2：会话活跃信号 + 惰性建档（agent/created 兜底路径）
    if (registry !== null && session?.id !== undefined && session?.id !== null) {
      try { registry.touch(String(session.id)) } catch { /* 台账失败绝不影响推送 */ }
    }
    // 会话元数据与类别走第二参（message 归一化会剥离未知字段；包装器据此记账/静音）。
    const sendOptions = deliveryOptionsOf(intent, session)
    const reportFailure = (error) => {
      warn(`自动推送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    // v0.5 动作闭环：stall / 心跳通知附带「停止任务」按钮（尽力而为，文本 hint 已兜底）。
    const delivery = notifier.notifyAll(message, sendOptions)
    const wantsCard = (intent.event === 'stall' || intent.event === 'longRunning') && actionsFn !== null
    if (!wantsCard) return delivery.catch(reportFailure)
    if (hasRemoteGate()) {
      // 新包装器：先让通知落地，再据真实结果决定是否铸造远端卡片——
      //  · canSendRemote === false（用户静音/仅本机模式）→ 不 mint、不外发；
      //  · 通知结果 suppressed 非空（desktop 已兜住远端）→ 不再发远端卡片。
      return Promise.resolve(delivery).then((outcome) => {
        if (suppressedRemotely(outcome)) return outcome
        if (!canSendRemoteNow(sendOptions)) return outcome
        pushActionCard(session, message, { legacyGate: false })
        return outcome
      }, (error) => {
        reportFailure(error)
        // 通知失败不是「已在本机看到」的证据：仍按远端闸尝试补发卡片。
        if (canSendRemoteNow(sendOptions)) pushActionCard(session, message, { legacyGate: false })
        return undefined
      })
    }
    // 旧 notifier（无 canSendRemote）：保留既有同步卡片路径与旧抑制闸，行为零变化。
    pushActionCard(session, message)
    return Promise.resolve(delivery).catch(reportFailure)
  }

  const sessionListener = (session, event) => {
    if (!enabled) return
    if (session == null || event == null) return
    if (isSubagent(session)) return
    // v0.5：永远最先喂 tracker（独立于 intent 过滤——events.turnEnd 关闭或未知
    // reason.kind 静默时，turn 生命周期的建档/清档仍需发生，否则卡住判定失真）
    tracker.observe(session, event)
    // #32：assistant/message 事件流经同一总线——趁事件到达把文本沉淀进有界缓存，
    // turn/end 正文与心跳摘录改从缓存取（DSH 0.1.2 起 session.events 已移除，issue #32；
    // 有界语义见 createAssistantTextCache）。本条本身不产生推送 intent，缓存即全部作用。
    if (event.type === 'assistant/message') {
      assistantCache.set(String(session?.id ?? ''), assistantTextOf(event))
    }
    // 用户活动信号：任何 user/* 事件（发消息/编辑）都证明人在键盘，取消宽限窗内待发打扰
    if (typeof event.type === 'string' && event.type.startsWith('user/')) {
      grace.activity()
      // timed 提问的 pending 结果之后，用户仍可回答；答案以 user-question-reply 到达时
      // 取消仍在门口的 survey 提醒，避免「已回答还提示等待」。
      const replyCallId = userQuestionReplyCallId(event)
      if (replyCallId !== null) cancelSettle(`survey:${session.id ?? '(anon)'}:${replyCallId}`)
      return
    }
    // 结算信号只用于取消待决提醒，本身不产生通知：
    //  - approval/decided 同 id 到达 = 这次审批从未真正等待（policy=never / 已 abort / 秒决）；
    //  - tool/result 同 callId 且不是 rc.3 timed 提问的 `{pending:true}` = 提问已结算。
    if (event.type === 'approval/decided') {
      const id = approvalIdOf(event)
      if (id !== null) cancelSettle(`approval:${id}`)
      return
    }
    if (event.type === 'tool/result') {
      const callId = toolResultCallId(event)
      if (callId !== null) {
        // timed ask_user_question 的超时结果是 `{ pending: true, callId, message }`：
        // 问题仍可回答，不能取消提醒（下一段 user-question-reply 才是真结算）。
        if (!toolResultKeepsQuestionPending(event, callId)) {
          cancelSettle(`survey:${session.id ?? '(anon)'}:${callId}`)
        }
      }
      return
    }
    // approval/asked：id 缺失的旧形状保持即时推送；带 id 时先挂可取消短延迟。
    if (event.type === 'approval/asked') {
      const intent = intentOfSessionEvent(event, strings)
      if (intent === undefined) return
      if (!eventAllowed(intent)) return
      // G-18：键追加负载摘要，同 seq 但先后请不同工具时不互吞。
      const key = `${session.id ?? '(anon)'}:${event.seq ?? 0}:${hash6(intent.detail)}`
      if (!dedup.test(key)) return
      const id = approvalIdOf(event)
      if (id === null) {
        push(intent, session)
        return
      }
      scheduleSettle(`approval:${id}`, () => push(intent, session))
      return
    }
    // 生命周期线（todo/goal/survey）：先走有界状态与纯映射。载荷畸形只告警不推送，
    // 且不推进状态（避免用坏快照污染下一次 diff）。
    const todoMapped = mapTodoEvent(todoState, String(session.id ?? ''), event, lifecycleText)
    if (todoMapped !== undefined) {
      if (todoMapped.invalid === true) {
        warn('宿主 todo/write 载荷无效（todos 非数组或条目缺 content/status），本次忽略')
        return
      }
      if (todoMapped.intent === undefined) return
      if (!eventAllowed(todoMapped.intent)) return
      const key = `${session.id ?? '(anon)'}:${event.seq ?? 0}`
      if (!dedup.test(key)) return
      push(todoMapped.intent, session)
      return
    }
    const goalMapped = mapGoalEvent(goalState, String(session.id ?? ''), event, lifecycleText)
    if (goalMapped !== undefined) {
      if (goalMapped.invalid === true) {
        warn('宿主 goal/change 载荷无效（缺 operation/goal 快照或字段畸形），本次忽略')
        return
      }
      if (goalMapped.intent === undefined) return
      if (!eventAllowed(goalMapped.intent)) return
      const key = `${session.id ?? '(anon)'}:${event.seq ?? 0}`
      if (!dedup.test(key)) return
      push(goalMapped.intent, session)
      return
    }
    const surveyIntent = intentOfSurveyToolCall(event, lifecycleText)
    if (surveyIntent !== undefined) {
      if (!eventAllowed(surveyIntent)) return
      // 提问的等待身份是 callId，不是 seq：宿主重放同一调用不得重复提醒。
      const key = `survey:${session.id ?? '(anon)'}:${event.data.callId}`
      if (!dedup.test(key)) return
      // 与 approval 同一收口：tool/result 同 callId 在短延迟内到达即取消。
      scheduleSettle(key, () => push(surveyIntent, session))
      return
    }
    const intent = intentOfSessionEvent(event, strings)
    if (intent === undefined) return
    if (!eventAllowed(intent)) return
    // G-18：approval/asked 即时推送键追加负载摘要（hash6(detail)——detail 由 toolName/
    // reason 构成）。宿主重放（同 session 同 seq）但负载不同（先请 toolA 后请 toolB）时
    // 不再互吞；turn 类维持现状——同 seq 即同一事件，负载不参与判定。
    const base = `${session.id ?? '(anon)'}:${event.seq ?? 0}`
    const key = intent.event === 'approval/asked' ? `${base}:${hash6(intent.detail)}` : base
    if (!dedup.test(key)) return
    if (intent.event === 'turn/end' || intent.event === 'turn/start') {
      // turn/end 与 turn/start 共用同一防抖 key（session.id）：10s 内 start→end 连续
      // 时后者替换前者（尾沿合并语义），只发「任务完成」一条；快速连续 turn 同理合并。
      debounce.schedule(String(session.id), () => grace.schedule(String(session.id), () => push(intent, session)))
    } else {
      push(intent, session)
    }
  }

  const errorListener = (payload = {}) => {
    if (!enabled) return
    if (events.agentError === false) return
    const agent = payload.agent
    if (isSubagent(agent)) return
    const agentId = agent?.id ?? agent?.session?.id
    if (agentId === undefined || agentId === null) return
    const key = `agent:${agentId}:${payload.turn ?? 0}:${payload.step ?? 0}`
    if (!dedup.test(key)) return
    push(intentOfAgentError(payload, strings), agent?.session)
  }

  const hostEvents = createHostEventRegistrar(ctx, warn)
  // v0.10 提交7：把宿主事件 registrar 的只读诊断快照外泄给装配层（管理台 /host 的
  // events.received 视图）。快照只含计数+context/scope 状态，无正文/标识符/凭证。
  // 回调接线失败绝不致命（诊断能力降级，事件订阅主链路不受影响）。
  if (typeof wiring.onHostEvents === 'function') {
    try { wiring.onHostEvents(hostEvents) } catch { /* 诊断接线失败不致命 */ }
  }
  const disposeSession = hostEvents.on('session/event', (...args) => {
    const normalized = normalizeSessionEventArgs(args)
    if (normalized === undefined) {
      warn('宿主 session/event 载荷已拒绝（仅接受 (session, event) 或 { session, event }）')
      return
    }
    sessionListener(normalized.session, normalized.event)
  })
  let disposeError = null
  const extraDisposers = []
  disposeError = hostEvents.on('agent/error', errorListener)
  const disposeAgentDisposed = hostEvents.on('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload
      tracker.observeAgentDisposed(agent)
      const bus = busFn !== null ? (() => { try { return busFn() } catch { return null } })() : null
      const agentId = typeof agent?.id === 'string' ? agent.id : typeof agent?.session?.id === 'string' ? agent.session.id : ''
      if (bus !== null && agentId !== '' && typeof bus.abandonByAgent === 'function') {
        try { bus.abandonByAgent(agentId) } catch { }
      }
    })
  if (typeof disposeAgentDisposed === 'function') extraDisposers.push(disposeAgentDisposed)

  // 返回可被 cordis await 的清理：flush 未到期的 turn/end 防抖与宽限窗任务，并等待所有在途推送完成。
  // headless 一次性运行在 appExit 前会 dispose 整个树（5s 宽限），Pending 通知因此能送达。
  return () => {
    const triggered = [...debounce.flush(), ...grace.flush(), ...flushSettles()]
    tracker.dispose() // v0.5：清心跳/卡住定时器
    disposeSession?.()
    disposeError?.()
    for (const dispose of extraDisposers) {
      try { dispose() } catch { /* 反注册失败不致命 */ }
    }
    hostEvents.reportZeroEvents()
    return Promise.allSettled([...triggered, notifier.flush()]).then(() => undefined)
  }
}
