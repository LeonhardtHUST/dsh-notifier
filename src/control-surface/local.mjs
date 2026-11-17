// dsh-notifier v0.14.1 — local notification surface.
//
// 本地通知（desktop / bell）复用与远程渠道同一套 outbound 配置事务（validate → resolve →
// 持久化 canonical overlay → 同步热替换运行时），但对外只暴露「开关 + 少量选项」：桌面
// 通知没有凭证，用户不需要看见字段表。本模块只补三层视图语义，不另建写入路径：
//   - enabled   = desired state（该本地渠道是否已配置）；
//   - active    = runtime truth（运行时是否真正在线，取不到即 false，绝不冒充）；
//   - managedBy = yaml（profile 文件配置，UI 不能关闭）/ ui（canonical 覆盖）/ null。
//
// 平台信息来自桌面适配器的 desktopPlatformInfo，在调用时读取而不是模块加载时读取：
// 适配器尚未提供该导出（或探测本身抛错）时，本模块依旧可加载，并折叠成安全兜底。
// 平台探测失败绝不能让 Native 面板或 surface.home 一起失败。

import * as desktopAdapter from '../adapters/desktop.mjs'
import { healthView } from './health.mjs'

/** 本地（不出网）通知类型：OS 桌面通知与终端响铃。 */
export const LOCAL_TYPES = Object.freeze(['desktop', 'bell'])

const OS_VALUES = new Set(['windows', 'linux', 'macos', 'other'])
const DESKTOP_VALUES = new Set(['gnome', 'kde', 'other'])
const SUPPORT_VALUES = new Set(['supported', 'best-effort', 'unsupported'])
const SOUNDS = new Set(['auto', 'always', 'never'])

function badRequest(message) {
  return Object.assign(new Error(message), { code: 'bad-request' })
}

function notSupported(message) {
  return Object.assign(new Error(message), { code: 'not-supported' })
}

function storageFailed(message, cause) {
  return Object.assign(new Error(message), { code: 'storage-failed', cause })
}

/** 平台信息不可用时的唯一兜底形状（与 desktopPlatformInfo 的契约一致，绝不抛）。 */
function platformFallback() {
  return {
    os: 'other',
    desktop: null,
    support: 'unsupported',
    backend: null,
    detail: { en: 'Platform information unavailable', zh: '无法读取平台信息' },
  }
}

/** 归一化平台信息：只保留契约内字段，越界值降级为兜底值——不把适配器内部形状泄给客户端。 */
function normalizePlatform(value) {
  const fallback = platformFallback()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  const detail = value.detail
  return {
    os: OS_VALUES.has(value.os) ? value.os : 'other',
    desktop: DESKTOP_VALUES.has(value.desktop) ? value.desktop : null,
    support: SUPPORT_VALUES.has(value.support) ? value.support : 'unsupported',
    backend: typeof value.backend === 'string' && value.backend !== '' ? value.backend : null,
    detail: {
      en: typeof detail?.en === 'string' && detail.en !== '' ? detail.en : fallback.detail.en,
      zh: typeof detail?.zh === 'string' && detail.zh !== '' ? detail.zh : fallback.detail.zh,
    },
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function createLocalNotificationSurface({ outboundConfig, health, platformInfo } = {}) {
  const config = outboundConfig

  const read = (fn, fallback) => {
    try { return typeof fn === 'function' ? fn() : fallback } catch { return fallback }
  }

  const describeOf = (type) => {
    const value = read(() => config?.describe?.(type), null)
    return isPlainObject(value) ? value : {}
  }
  const rawOf = (type) => {
    const value = read(() => config?.raw?.(type), null)
    return isPlainObject(value) ? value : {}
  }
  /**
   * 配置来源探测（baseConfigured / overlayConfigured）：
   * v0.14.1（审查项 P1）——读失败绝不能折叠成 false。false 会让 UI 把「读不到来源」
   * 当成「没有配置」，进而把 disable 走成幂等 no-op 并谎报成功，而运行时可能仍在发送。
   * 这里把失败升级为 storage-failed，由 service 映射成公开错误码暴露给客户端；
   * 能力本身缺席（旧 fake/旧服务没有该方法）仍按 false 处理，保持兼容。
   */
  const readConfigured = (type, method) => {
    const probe = config?.[method]
    if (typeof probe !== 'function') return false
    try {
      return probe.call(config, type) === true
    } catch (cause) {
      throw storageFailed('本机通知配置来源读取失败，无法确认该渠道是否可安全关闭', cause)
    }
  }
  const baseConfigured = (type) => readConfigured(type, 'baseConfigured')
  const overlayConfigured = (type) => readConfigured(type, 'overlayConfigured')

  const managedByOf = (type) => {
    if (baseConfigured(type)) return 'yaml'
    return overlayConfigured(type) ? 'ui' : null
  }

  const healthOf = (type, desc, enabled) => {
    const evidence = read(() => health?.snapshot?.(type), null)
    try {
      return healthView({ configured: enabled, active: desc.active === true, health: evidence })
    } catch {
      return healthView({ configured: false, active: false, health: null })
    }
  }

  /** desktop sound 视图：true→always / false→never / 合法枚举保留 / 其余→auto。 */
  const soundOf = () => {
    const raw = rawOf('desktop').sound
    if (raw === true) return 'always'
    if (raw === false) return 'never'
    if (raw === 'always' || raw === 'never') return raw
    return 'auto'
  }

  /** bell count 视图：非数字→1，其余截断并钳制到 1..5。 */
  const countOf = () => {
    const raw = rawOf('bell').count
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 1
    return Math.min(5, Math.max(1, Math.trunc(raw)))
  }

  const platformView = () => {
    try {
      const probe = typeof platformInfo === 'function'
        ? platformInfo
        : desktopAdapter?.desktopPlatformInfo
      if (typeof probe !== 'function') return platformFallback()
      return normalizePlatform(probe())
    } catch {
      return platformFallback()
    }
  }

  const rowOf = (type) => {
    const desc = describeOf(type)
    const managedBy = managedByOf(type)
    // enabled 不用 describe.configured：重启后 canonical 覆盖会随装配进入 resolvedRows，
    // revoke 之后 describe 仍会读到那份启动快照，表现为「关了又自己开」。真实来源只有
    // YAML 行与 UI 覆盖两种，二者都不存在就是没启用。
    const enabled = managedBy !== null
    return {
      type,
      enabled,
      active: desc.active === true,
      managedBy,
      health: healthOf(type, desc, enabled),
      ...(type === 'desktop' ? { sound: soundOf() } : { count: countOf() }),
    }
  }

  /** save 的 options 校验与 patch 构造：永远产出非空 patch，使渠道真正变为「已配置」。 */
  const patchOf = (type, options) => {
    const opts = options === undefined || options === null ? {} : options
    if (!isPlainObject(opts)) throw badRequest('options 必须是对象')
    if (type === 'desktop') {
      const raw = opts.sound
      if (raw === undefined) return { sound: 'auto' }
      if (!SOUNDS.has(raw)) throw badRequest('sound 必须是 auto、always 或 never')
      return { sound: raw }
    }
    const raw = opts.count
    if (raw === undefined) return { count: 1 }
    if (!Number.isInteger(raw) || raw < 1 || raw > 5) throw badRequest('count 必须是 1-5 的整数')
    return { count: raw }
  }

  return {
    get() {
      return { platform: platformView(), desktop: rowOf('desktop'), bell: rowOf('bell') }
    },

    save(input = {}) {
      const type = typeof input?.type === 'string' ? input.type.trim() : ''
      if (!LOCAL_TYPES.includes(type)) throw badRequest(`未知的本机通知类型 "${String(input?.type ?? '')}"`)
      const enabled = input?.enabled
      if (typeof enabled !== 'boolean') throw badRequest('enabled 必须是布尔值')

      let result = null
      let enabledAfter = false
      if (enabled === true) {
        if (typeof config?.save !== 'function') throw notSupported('本机通知配置写入能力不可用')
        // 成功落盘即 desired state 为「已配置」，无需再探测来源（探测失败也不能把
        // 已经提交的保存说成失败，更不能再读一次 store 制造不一致）。
        result = config.save(type, patchOf(type, input?.options))
        enabledAfter = true
      } else if (baseConfigured(type)) {
        // profile 文件里的启用态不归 UI 管：删掉覆盖层没有意义，下次启动仍会从 YAML 复活。
        throw notSupported('该本机通知由配置文件（cordis.patch.yml）启用，请在配置文件中移除')
      } else if (overlayConfigured(type)) {
        if (typeof config?.remove !== 'function') throw notSupported('本机通知配置删除能力不可用')
        result = config.remove(type, { mode: 'revoke' })
        enabledAfter = false
      } else {
        // 找不到任何可撤销来源。运行时若仍在活动，说明配置态与运行态不一致：此时绝
        // 不能把 disable 当幂等 no-op 报成功，否则用户以为关了、通知还在发。
        if (describeOf(type).active === true) {
          throw notSupported('该本机通知运行时仍处于活动状态，但找不到可撤销的配置；请重启宿主后再试')
        }
        // 否则：本来就没有配置，disable 是幂等 no-op（不写盘、不 touch revision）。
      }

      return {
        type,
        enabled: enabledAfter,
        applied: result?.applied !== false,
        applyMode: typeof result?.applyMode === 'string' && result.applyMode !== '' ? result.applyMode : 'hot',
      }
    },
  }
}
