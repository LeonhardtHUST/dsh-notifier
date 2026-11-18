// dsh-notifier notify.mjs
// 统一前端 API：notify(channel, msg) 单渠道 / notifyAll(msg) 广播。
// 共用 adapter 注册表（config.mjs 解析出的已启用渠道），未配置的渠道静默跳过并在日志提示。

import { ADAPTERS, normalizeMessage, channelResult } from './config.mjs'
import { resolveRouting, routeTargets, retryPolicyOf, sendWithRetry, normalizeLevel } from './routing.mjs'
import { sendSegmented } from './inbound/segment.mjs'
import { isConfirmedReceipt } from './delivery-evidence.mjs'

/** 本地（不出网）通知类型：远程抑制命中时这些目标继续投递。 */
const LOCAL_CHANNEL_TYPES = Object.freeze(['desktop', 'bell'])
const LOCAL_TYPES = new Set(LOCAL_CHANNEL_TYPES)

/**
 * 创建一个 notifier：内部持有「已启用渠道」列表。
 * @param ctx - cordis 插件上下文（提供 logger）。
 * @param channels - resolveConfig 返回的已启用渠道 [{ type, config }]。
 * @param {object} [options]
 * @param {object} [options.routing] - routing 配置原值（resolveRouting 解析）；未配置时广播全部渠道（基线行为）。
 * @param {object} [options.retry] - 重试覆盖（{ enabled?, attempts?, backoffMs? }）；仅配置 routing 后生效。
 * @param {object} [options.segment] - 出站分段（{ enabled?, maxCodepoints? }）；默认开、1200 码点。
 * @param {(record: object) => void} [options.onSend] - 每次发送结束的回调（通知账本/事件用）。
 * @returns { notify, notifyAll, flush, channelCount }
 */
export function createNotifier(ctx, channels, options = {}) {
  const logger = ctx?.logger
  const warn = (...args) => {
    try { logger?.warn?.('[dsh-notifier]', ...args) } catch { /* 日志失败绝不致命 */ }
  }
  // Test seam only: production always uses the registry. Tests replace a single
  // local adapter (desktop) so suppression can be exercised without spawning OS
  // notification processes.
  const adapters = (options.adapters !== null && typeof options.adapters === 'object') ? options.adapters : ADAPTERS
  const routing = options.routing !== undefined ? resolveRouting(options.routing) : resolveRouting()
  const channelsNow = () => {
    if (channels !== null && typeof channels === 'object' && typeof channels.snapshot === 'function') {
      try {
        const value = channels.snapshot()
        return Array.isArray(value) ? value : []
      } catch { return [] }
    }
    return Array.isArray(channels) ? channels : []
  }
  const segment = (options.segment !== null && typeof options.segment === 'object')
    ? options.segment
    : { enabled: true, maxCodepoints: 1200 }

  const audit = (message, outcome, extra = {}) => {
    if (typeof options.onSend !== 'function') return
    const record = { time: extra.time ?? new Date().toISOString(), message, ...outcome }
    if (extra.source !== null && typeof extra.source === 'object') record.source = extra.source
    if (typeof extra.channel === 'string' && extra.channel !== '') record.channel = extra.channel
    try { options.onSend(record) } catch { /* audit failure never affects delivery */ }
  }

  /** 包装单渠道发送：分段开启且超预算时切段顺序送达，任一段失败即整体失败。 */
  const sendOne = async (type, config, msg) => {
    const adapter = adapters[type]
    if (segment.enabled === false) return adapter.send(config, msg)
    let last
    const outcome = await sendSegmented(async (piece) => {
      last = await adapter.send(config, piece)
      return last
    }, msg, { maxCodepoints: segment.maxCodepoints })
    if (outcome.error === null) return last
    if (outcome.sent > 0) {
      // v0.6.3：部分送达标记 noRetry——重试单元若仍是「整条消息」，已送达的
      // 前 N 段会被重发（timeSensitive 3 次尝试 = 同通知收到多份前半段轰炸）。
      // 重试层见 routing.sendWithRetry 对 noRetry 的短路。
      const partial = new Error(`分段送达中断：${outcome.sent}/${outcome.total} 段成功`)
      partial.cause = outcome.error
      partial.noRetry = true
      throw partial
    }
    throw outcome.error
  }

  // v0.13（C11.5 / R4）：只有适配器返回显式回执才算「确认送达」；其余成功一律只是
  // 「provider accepted」（请求已被提供方接受，无端到端送达证据）。词汇权威见 delivery-evidence.mjs。
  const confirmedOf = isConfirmedReceipt

  // 在途推送账本：flush 时等待它们完成（headless 一次性运行退出前也能送达）。
  const inFlight = new Set()
  const track = (promise) => {
    inFlight.add(promise)
    promise.then(() => inFlight.delete(promise), () => inFlight.delete(promise))
    return promise
  }

  /** 等待所有在途推送完成（进程退出 / 插件卸载前的 flush）。 */
  async function flush() {
    await Promise.allSettled([...inFlight])
  }

  /** 单渠道推送：未配置/未知渠道静默跳过 + warn 提示；已配置渠道失败返回 failed 结果（不抛出，供工具渲染中文反馈）。 */
  async function notify(channel, msg, sendOptions = {}) {
    const type = typeof channel === 'string' ? channel.trim() : ''
    const normalized = normalizeMessage(msg)
    const entry = channelsNow().find((item) => item.type === type)
    if (entry === undefined) {
      warn(`渠道 "${type || '(空)'}" 未配置，已跳过推送（可用类型：${Object.keys(adapters).join('/')}）`)
      const result = channelResult(type || '(空)', 'skipped')
      audit(normalized, { ok: false, accepted: [], confirmed: [], delivered: [], skipped: [`(${result.channel})`], failed: [] }, { source: sendOptions?.source, channel: result.channel })
      return result
    }
    return track((async () => {
      try {
        const sent = await sendOne(type, entry.config, normalized)
        const confirmed = confirmedOf(sent)
        const result = channelResult(type, 'sent')
        // delivered 是 legacy 别名（== accepted）；accepted/confirmed 才是有证据强度的语义。
        audit(normalized, {
          ok: true,
          accepted: [type],
          confirmed: confirmed ? [type] : [],
          delivered: [type],
          skipped: [],
          failed: [],
        }, { source: sendOptions?.source, channel: type })
        return result
      } catch (error) {
        // G-53 分层：failed[].error / audit 记公开文案（无响应体/网络原文）；
        // 完整 detail 只进 warn 日志（宿主 logger + 排障可见，不进事件/工具反馈）。
        const publicText = error instanceof Error ? (error.publicMessage ?? error.message) : String(error)
        const internalDetail = error instanceof Error ? (error.detail ?? error.message) : String(error)
        warn(`渠道 "${type}" 推送失败: ${internalDetail}`)
        const result = channelResult(type, 'failed', error)
        audit(normalized, { ok: false, accepted: [], confirmed: [], delivered: [], skipped: [], failed: [{ channel: type, error: publicText }] }, { source: sendOptions?.source, channel: type })
        return result
      }
    })())
  }

  /**
   * 广播到路由命中的渠道：按 level 走路由矩阵（未配置时全部渠道，向后兼容）；每渠道独立 try/catch，互不拖累。
   * v0.3.2 出站分流（可选 options，与全局 level 路由是 AND 关系）：
   *  - channelTypes：agent/会话路由解析出的目标类型集合；命中 level 路由后再按此过滤
   *    （未传/非数组 = 不过滤，全量广播——旧调用方零感知）。
   *  - quiet：true = 本次静音——不走任何渠道发送，但仍写通知账本（skipped 标 '(quiet)'）。
   * @param {object} msg - 通知消息（normalizeMessage 归一）。
   * @param {{ channelTypes?: string[], quiet?: boolean, suppressRemote?: boolean }} [options] - v0.3.2 分流选项。
   *   - suppressRemote: true 时，若目标中存在 desktop，则丢弃远程目标（保留 desktop/bell）。
   *     desktop 未命中时保持原样，绝不把用户唯一能收到的远程通知吞掉。
   */
  async function notifyAll(msg, sendOptions = {}) {
    const normalized = normalizeMessage(msg)
    const quiet = sendOptions?.quiet === true
    const filterTypes = Array.isArray(sendOptions?.channelTypes) ? sendOptions.channelTypes : null
    // v0.6 来源标注（设计稿 §2.3）：source 只并入 onSend record（账本/事件可见），
    // 不进返回值（notify.test 全形状 deepEqual 守着）、不进渠道 msg（normalizeMessage 剥离契约不变）。
    const source = sendOptions?.source
    const sourceExtra = (source !== null && typeof source === 'object') ? { source } : {}
    if (quiet) {
      // 静音不等于没发生：账本照记（delivered 空、skipped 标记），方便晨报反映被静音的流量
      const quietOutcome = { ok: true, accepted: [], confirmed: [], delivered: [], skipped: ['(quiet)'], failed: [] }
      audit(normalized, quietOutcome, { source: sourceExtra.source })
      return quietOutcome
    }
    const currentChannels = channelsNow()
    if (currentChannels.length === 0) {
      warn('未配置任何已启用渠道，notifyAll 无操作')
      return { ok: false, accepted: [], confirmed: [], delivered: [], skipped: [], failed: [] }
    }
    const targets = routeTargets(routing, currentChannels, normalized)
      .filter((target) => filterTypes === null || filterTypes.includes(target.type))
    // v0.6.3 空目标可见化（审查 R1 P1-2）：路由矩阵/分流过滤后目标为空时，原实现
    // delivered/failed/skipped 三空 + ok:true + 零日志——agent 绑定的渠道后来被禁用/
    // routing 渠道名拼错时，通知（含 timeSensitive 审批提醒）静默消失且账本记成功，
    // 排障完全误导。现在 warn + skipped 标记（ok 语义不变：无失败即 true）。
    if (targets.length === 0) {
      const hint = filterTypes !== null
        ? `分流过滤（channelTypes: [${filterTypes.join(', ')}]）后无目标`
        : '路由矩阵（routing 配置）未命中任何已启用渠道'
      warn(`notifyAll 目标为空：${hint}（可用渠道：${currentChannels.map((entry) => entry.type).join('/') || '无'}）`)
      const emptyOutcome = { ok: true, accepted: [], confirmed: [], delivered: [], skipped: ['(no-targets)'], failed: [] }
      audit(normalized, emptyOutcome, { source: sourceExtra.source })
      return emptyOutcome
    }
    // v0.14.2 远程抑制：用户在本机时（窗口焦点/解锁/唤醒）只保留本地通知。
    // 关键安全门：只有目标里确实存在 desktop 渠道才丢弃远程目标。desktop 未启用
    // （或本次路由没命中 desktop）时行为与旧版逐字节一致——绝不因为一个开关
    // 把用户唯一能收到的远程通知吞掉。
    const suppressRemote = sendOptions?.suppressRemote === true
    const suppressed = []
    let suppressedTargets = []
    let activeTargets = targets
    if (suppressRemote && targets.some((target) => target.type === 'desktop')) {
      const remote = targets.filter((target) => !LOCAL_TYPES.has(target.type))
      if (remote.length > 0) {
        activeTargets = targets.filter((target) => LOCAL_TYPES.has(target.type))
        suppressedTargets = remote
        for (const target of remote) suppressed.push(target.type)
      }
    }
    const accepted = []
    const confirmed = []
    const failed = []
    const skipped = []
    const retry = routing.configured
      ? retryPolicyOf(normalizeLevel(normalized.level), options.retry)
      : { attempts: 1, backoffMs: 0 }
    const batch = activeTargets.map(async (target) => {
      try {
        const sent = await sendWithRetry(
          () => sendOne(target.type, target.entry.config, target.message),
          { ...retry, onRetry: (attempt, error) => warn(`渠道 "${target.type}" 第 ${attempt} 次失败，准备重试: ${error instanceof Error ? error.message : String(error)}`) },
        )
        accepted.push(target.type)
        if (confirmedOf(sent)) confirmed.push(target.type)
      } catch (error) {
        // G-53：同 notify()——公开文案进 failed[]，内部细节只进日志。
        const publicText = error instanceof Error ? (error.publicMessage ?? error.message) : String(error)
        const internalDetail = error instanceof Error ? (error.detail ?? error.message) : String(error)
        warn(`渠道 "${target.type}" 推送失败: ${internalDetail}`)
        failed.push({ channel: target.type, error: publicText })
      }
    })
    await track(Promise.all(batch))
    // If the local desktop path failed, restore suppressed remote targets. The local
    // presence policy is a de-duplication preference, not permission to lose every
    // copy of an important notification.
    if (suppressRemote && suppressedTargets.length > 0 && failed.some((item) => item.channel === 'desktop')) {
      const fallback = await Promise.all(suppressedTargets.map(async (target) => {
        try {
          const sent = await sendWithRetry(
            () => sendOne(target.type, target.entry.config, target.message),
            { ...retry, onRetry: (attempt, error) => warn(`渠道 "${target.type}" 远程兜底第 ${attempt} 次失败: ${error instanceof Error ? error.message : String(error)}`) },
          )
          accepted.push(target.type)
          if (confirmedOf(sent)) confirmed.push(target.type)
          return null
        } catch (error) {
          const publicText = error instanceof Error ? (error.publicMessage ?? error.message) : String(error)
          failed.push({ channel: target.type, error: publicText })
          return target.type
        }
      }))
      const failedFallback = new Set(fallback.filter(Boolean))
      for (let i = suppressed.length - 1; i >= 0; i -= 1) {
        if (!failedFallback.has(suppressed[i])) suppressed.splice(i, 1)
      }
    }
    const outcome = {
      ok: failed.length === 0,
      // v0.13（C11.5 / R4）：accepted = provider 已接受请求；confirmed = 有显式回执。
      // delivered 保留为 legacy 别名（== accepted），消费方不得据此宣称「已确认送达」。
      accepted,
      confirmed,
      delivered: accepted,
      skipped,
      failed,
      // 只有显式请求抑制时出现：账本/活动页可解释「为什么只有本机收到」。
      ...(suppressRemote ? { suppressed } : {}),
    }
    audit(normalized, outcome, { source: sourceExtra.source })
    return outcome
  }

  return {
    notify,
    notifyAll,
    flush,
    get channelCount() { return channelsNow().length },
    get channels() { return channelsNow().map((entry) => entry.type) },
  }
}

/**
 * 给事件监听器用的 notifier 视图：命中本地 presence 抑制策略时，给 notifyAll
 * 带上 suppressRemote:true。真正的目标过滤与「必须存在 desktop」门在 notifyAll
 * 内部完成——这个包装器单独不可能吞掉远程通知（desktop 未启用时 notifyAll 原样发送）。
 *
 * getter 抛错一律按「不抑制」处理：presence 只是增强能力，绝不能影响通知主链路。
 * @param {{ notifyAll: Function, flush: Function, channels: string[] }} notifier
 * @param {() => boolean} [shouldSuppressRemote]
 */
export function createEventNotifier(notifier, shouldSuppressRemote) {
  const suppressed = () => {
    try {
      return typeof shouldSuppressRemote === 'function' && shouldSuppressRemote() === true
    } catch {
      return false
    }
  }
  return Object.freeze({
    notifyAll(message, options = {}) {
      const next = suppressed() ? { ...options, suppressRemote: true } : options
      return notifier.notifyAll(message, next)
    },
    shouldSuppressRemote: suppressed,
    flush() { return notifier.flush() },
    get channels() { return notifier.channels },
    get channelCount() { return notifier.channelCount },
  })
}
