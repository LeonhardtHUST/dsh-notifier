const PUBLIC_ERROR_CODES = new Set([
  'bad-request', 'not-found', 'not-configured', 'not-supported',
  'storage-failed', 'conflict', 'host-unavailable', 'internal',
])
import { inboundApplyMode, isHotApplied } from './apply-mode.mjs'
import { isConfirmedReceipt } from '../delivery-evidence.mjs'
import { redactDiagnosticValue } from '../security/diagnostic.mjs'
import { isStorageUntrusted } from '../inbound/store.mjs'

function normalizeCode(error) {
  const raw = String(error?.code ?? 'internal').replace(/^dsh-notifier\//, '')
  return PUBLIC_ERROR_CODES.has(raw) ? raw : 'internal'
}
function failure(error) {
  const code = normalizeCode(error)
  return {
    ok: false,
    error: {
      code: `dsh-notifier/${code}`,
      message: code === 'internal' ? '内部错误' : String(error?.message ?? code).slice(0, 300),
      details: {},
    },
  }
}
const ok = (value) => ({ ok: true, value })

function summaryOf(channelRows, questionRows, storageStatus = {}) {
  if (isStorageUntrusted(storageStatus)) return {
    status: 'attention',
    detail: storageStatus?.corrupt === true || storageStatus?.status === 'corrupt'
      ? { en: 'Persistent state is corrupt; writes are blocked until repaired', zh: '持久化状态已损坏，修复前禁止写入' }
      : { en: 'Persistent state could not be read', zh: '持久化状态读取失败' },
  }
  // T03：旧 schema 隔离 → 明确提示重新配置/重新配对，不把旧数据当权威。
  if (storageStatus?.schema?.legacy === true) return {
    status: 'attention',
    detail: {
      en: 'Stored state uses an old schema; its bindings, pending items and pairing are not trusted — re-configure or re-pair. The original file was preserved.',
      zh: '旧数据 schema：其中的绑定/待决/配对不作为权威，请重新配置或重新配对。原文件已保留。',
    },
  }
  const configured = channelRows.some((row) => row?.notify?.configured === true)
  if (!configured) return {
    status: 'unconfigured',
    // v0.14.1：本地桌面通知也是一等通知方式，文案不再只说「渠道」。
    detail: { en: 'No notification method configured', zh: '尚未配置任何通知方式' },
  }
  const degraded = channelRows.find((row) => row?.health?.state === 'degraded')
  const inactive = channelRows.find((row) => row?.notify?.configured === true && row?.notify?.active !== true)
  if (questionRows.length > 0 || inactive || degraded) return {
    status: 'attention',
    detail: {
      en: questionRows.length > 0
        ? `${questionRows.length} question(s) need attention`
        : inactive
          ? `${inactive.type} is configured but inactive`
          : `${degraded.type} recently failed`,
      zh: questionRows.length > 0
        ? `${questionRows.length} 个问题待处理`
        : inactive
          ? `${inactive.type} 已配置但运行时未激活`
          : `${degraded.type} 最近发送失败`,
    },
  }
  return {
    status: 'healthy',
    detail: { en: 'Notification control plane is ready', zh: '通知控制面运行正常' },
  }
}

function testResult(result) {
  const at = new Date().toISOString()
  if (result?.ok === true) {
    // v0.12.1（P1-06 / D1 / D2）：provider 接受请求不等于端到端送达。
    const confirmed = isConfirmedReceipt(result)
    const detail = result?.detail ?? (confirmed
      ? { en: 'Delivered', zh: '已送达' }
      : { en: 'Sent to the provider — confirm receipt on your device', zh: '已发送到提供方，请到客户端确认收到' })
    return {
      status: confirmed ? 'delivered' : 'accepted',
      delivered: confirmed,
      confirmed,
      accepted: true,
      detail: redactDiagnosticValue(detail),
      providerDetail: redactDiagnosticValue(result?.detail ?? null),
      reasonCode: null,
      at,
    }
  }
  const safeDetail = redactDiagnosticValue(result?.detail ?? '')
  const text = typeof safeDetail === 'string' ? safeDetail : JSON.stringify(safeDetail)
  const lower = text.toLowerCase()
  const reasonCode = /auth|token|secret|401|403/.test(lower) ? 'auth-failed'
    : /timeout|超时/.test(lower) ? 'timeout'
      : /network|fetch|dns|socket|网络/.test(lower) ? 'network-error'
        : 'provider-error'
  return {
    status: 'unknown',
    delivered: false,
    accepted: false,
    reasonCode,
    detail: text || { en: 'Delivery failed', zh: '发送失败' },
    providerDetail: safeDetail || null,
    at,
  }
}

export function createControlSurfaceService({
  revision,
  channels,
  outboundConfig,
  saveInbound,
  channelTest,
  tasks,
  questions,
  activity,
  health,
  storageStatus,
  launchTickets,
  adminLocation,
  local,
  sessionNotifications,
} = {}) {
  const revisionView = () => {
    const current = revision.current()
    return { epoch: current.epoch, revision: current.revision }
  }
  const call = async (method, payload = {}, signal) => {
    try {
      if (method === 'surface.home') {
        const channelRows = channels.list()
        const taskRows = tasks.list()
        const questionRows = questions.list()
        const activityRows = activity.list({ limit: 5 })
        const value = {
          ...revisionView(),
          summary: summaryOf(channelRows, questionRows, typeof storageStatus === 'function' ? storageStatus() : storageStatus),
          storage: typeof storageStatus === 'function' ? storageStatus() : (storageStatus ?? { readFailed: false }),
          questions: questionRows.slice(0, 3),
          tasks: taskRows.slice(0, 5),
          channels: channelRows.filter((row) => row.notify?.configured || row.control?.configured).slice(0, 5),
          activity: activityRows,
        }
        // v0.14.1：本地通知摘要（平台支持 + desktop/bell 开关）。任何异常都只是
        // 省略该字段——平台探测失败不能拖垮整个 home 投影。
        try {
          const localView = typeof local?.get === 'function' ? local.get() : null
          if (localView !== null && typeof localView === 'object') {
            value.local = {
              platform: {
                os: localView.platform?.os ?? 'other',
                support: localView.platform?.support ?? 'unsupported',
              },
              desktop: {
                enabled: localView.desktop?.enabled === true,
                active: localView.desktop?.active === true,
              },
              bell: {
                enabled: localView.bell?.enabled === true,
                active: localView.bell?.active === true,
              },
            }
          }
        } catch { /* local projection is optional */ }
        return ok(value)
      }

      if (method === 'surface.wait') {
        const before = Number(payload?.after ?? 0)
        const value = await revision.wait({ after: before, timeoutMs: payload?.timeoutMs, signal })
        return ok({
          epoch: value.epoch,
          revision: value.revision,
          changed: value.revision > before,
          ...(value.topic ? { topic: value.topic } : {}),
          ...(value.capacity === true ? { capacity: true, retryAfterMs: Math.max(500, Number(value.retryAfterMs) || 1_000) } : {}),
        })
      }

      if (method === 'channels.list') {
        return ok({ ...revisionView(), channels: channels.list() })
      }

      if (method === 'channels.get') {
        const channel = channels.get(payload?.type)
        if (channel === null) {
          const error = new Error(`未知渠道 "${String(payload?.type ?? '')}"`)
          error.code = 'not-found'
          throw error
        }
        return ok({ ...revisionView(), channel })
      }

      if (method === 'channels.save') {
        const direction = String(payload?.direction ?? '')
        let result
        if (direction === 'outbound') {
          result = outboundConfig.save(payload?.type, payload?.patch)
        } else if (direction === 'inbound') {
          if (typeof saveInbound !== 'function') {
            const error = new Error('入站配置写入能力不可用')
            error.code = 'not-supported'
            throw error
          }
          const saved = await saveInbound(payload?.type, payload?.patch)
          if (saved?.saved !== true) {
            const error = new Error('入站配置写入失败：未落盘，已保留当前状态')
            error.code = 'storage-failed'
            throw error
          }
          result = {
            saved: true,
            applied: isHotApplied('inbound'),
            applyMode: inboundApplyMode(),
            configRevision: Number(saved?.configRevision) || 0,
          }
        } else {
          const error = new Error('direction 必须是 outbound 或 inbound')
          error.code = 'bad-request'
          throw error
        }
        revision.touch('channels')
        activity.record('configuration', 'channel-saved', {
          channel: String(payload?.type ?? ''),
          direction,
          saved: result.saved === true,
          hotApplied: result.applied === true,
        })
        return ok(result)
      }

      if (method === 'channels.test') {
        const type = String(payload?.type ?? '')
        const raw = outboundConfig.raw(type)
        // v0.14.1（复审 P2）：YAML 无选项行 raw 为空，但渠道确实由 profile 配置并运行。
        // 只有「raw 为空且 describe 也不认为已配置」才拒绝——绝不误启真正未配置的
        // 零凭证通道；空 raw 的已配置渠道交给 runChannelTest 用 adapter 默认值 resolve。
        const desc = (() => {
          try { return outboundConfig.describe?.(type) ?? null } catch { return null }
        })()
        const rawEmpty = raw === null || Object.keys(raw).length === 0
        if (raw === null || (rawEmpty && desc?.configured !== true)) {
          const error = new Error(`渠道 "${type}" 未配置`)
          error.code = 'not-configured'
          throw error
        }
        const rawResult = await channelTest(type, raw)
        const safeRawResult = redactDiagnosticValue(rawResult, raw)
        health.recordTest(type, safeRawResult)
        revision.touch('health')
        const value = testResult(safeRawResult)
        const action = value.status === 'delivered' ? 'channel-test-ok'
          : value.status === 'accepted' ? 'channel-test-accepted'
            : 'channel-test-failed'
        activity.record('notification', action, {
          channel: type,
          status: value.status === 'unknown' ? 'failed' : 'ok',
          reason: value.status === 'unknown' ? value.detail : null,
        })
        return ok(value)
      }

      if (method === 'local.get') {
        if (typeof local?.get !== 'function') {
          const error = new Error('本机通知能力不可用')
          error.code = 'not-supported'
          throw error
        }
        return ok({ ...revisionView(), ...local.get() })
      }

      if (method === 'local.save') {
        if (typeof local?.save !== 'function') {
          const error = new Error('本机通知能力不可用')
          error.code = 'not-supported'
          throw error
        }
        // local.save 内部复用 outboundConfig 的 validate/resolve/持久化/热替换事务；
        // 失败时保留 .code，由本层映射成公开错误码（不泄露内部细节）。
        const result = local.save(payload ?? {})
        revision.touch('channels')
        activity.record('configuration', 'local-notification-saved', {
          channel: String(payload?.type ?? ''),
          enabled: payload?.enabled === true,
          hotApplied: result?.applied === true,
        })
        return ok(result)
      }

      // v0.14.2：本地 presence 证据（窗口焦点/可见性；unlock/wake 可选且必须声明能力）。
      // 只更新内存证据，不 touch revision——客户端会周期性上报，不能让长轮询被刷屏。
      if (method === 'local.presence.report') {
        if (typeof local?.reportPresence !== 'function') {
          const error = new Error('本机 presence 上报能力不可用')
          error.code = 'not-supported'
          throw error
        }
        const suppression = local.reportPresence(payload ?? {})
        return ok({ ...revisionView(), suppression })
      }

      // v0.14.2：远程抑制策略（focus/unlock/wake）持久化。策略在不启用桌面通知时
      // 也不改变远程发送（真正的门在 notifyAll 的 suppressRemote 过滤里）。
      if (method === 'local.policy.save') {
        if (typeof local?.savePolicy !== 'function') {
          const error = new Error('远程抑制策略能力不可用')
          error.code = 'not-supported'
          throw error
        }
        const result = local.savePolicy(payload ?? {})
        revision.touch('channels')
        activity.record('configuration', 'local-suppression-saved', {
          saved: result?.saved === true,
          hotApplied: result?.applied === true,
        })
        return ok(result)
      }

      if (['notifications.get', 'notifications.save', 'notifications.mute'].includes(method)) {
        const operation = method.slice('notifications.'.length)
        if (typeof sessionNotifications?.[operation] !== 'function') {
          throw Object.assign(new Error('会话通知设置不可用'), { code: 'not-supported' })
        }
        const value = sessionNotifications[operation](payload ?? {})
        return ok({ ...revisionView(), ...value })
      }

      if (method === 'tasks.list') {
        return ok({ ...revisionView(), tasks: tasks.list() })
      }

      if (method === 'questions.list') {
        return ok({ ...revisionView(), questions: questions.list() })
      }

      if (method === 'questions.settle') {
        const value = questions.settle(payload)
        revision.touch('questions')
        activity.record('control', 'question-settled', { action: payload?.action ?? 'unknown', status: 'ok' })
        return ok(value)
      }

      if (method === 'activity.list') {
        return ok({ ...revisionView(), items: activity.list(payload) })
      }

      if (method === 'standalone.createLaunch') {
        const location = typeof adminLocation === 'function' ? adminLocation() : null
        if (!location?.port) return ok({ available: false, reason: 'disabled' })
        const minted = launchTickets.mint()
        return ok({
          available: true,
          url: `http://${location.address || '127.0.0.1'}:${location.port}/#ticket=${encodeURIComponent(minted.ticket)}`,
        })
      }

      const error = new Error(`未知方法 "${String(method)}"`)
      error.code = 'bad-request'
      throw error
    } catch (error) {
      return failure(error)
    }
  }
  return { call }
}
