// dsh-notifier adapter: desktop
// 本地渠道：调用操作系统原生桌面通知（v0.4.0 新增，与 bell 平级的零凭证渠道）。
// 第一性原则：跨平台通知最成熟的实现就是 OS 自带的命令——macOS osascript、
// Linux notify-send（libnotify）/ gdbus、Windows 自带的 WinRT Toast API；插件零运行时
// 依赖、零 vendored 二进制，只做「命令拼装 + 失败归一」。
//
// v0.14.1 重做 Windows 路径：原实现依赖 BurntToast PowerShell 模块，默认机器上没人装，
// 「开箱即用」承诺不成立。改为 Windows PowerShell 5.1 直接调系统自带的 WinRT Toast API
// （必须用 powershell.exe：pwsh 7 无法加载 ContentType=WindowsRuntime 类型）。
// Windows toast approach adapted from SingleOne/dsh-notify-center (MIT)。
// 与参考实现的刻意差异：不写注册表、不创建快捷方式——AUMID 只做「探测 + 回落」，
// 优先 DSH 桌面应用已注册的 com.deepseek.dsh，其次 Windows PowerShell 自带的 AUMID。
//
// 对抗性防御（本文件的安全底线）：
//   - 一律 spawn(file, argsArray)，永不 shell:true / 模板拼 shell——标题/正文含任意
//     字符（引号、$(...)、; rm -rf）也只是字面参数，注入在结构上不可能；
//   - Windows 脚本经 -EncodedCommand（UTF-16LE base64）传入，标题/正文先编码成
//     UTF-8 base64 再在 PS 内解码，并做 [SecurityElement]::Escape XML 转义——脚本里
//     拼接进用户文本的通路为零，唯一内联的字面量是 base64（[A-Za-z0-9+/=]）、
//     净化后的 AUMID 和 Toast Tag，三者都在构建时断言字符集；
//   - osascript 的 AppleScript 字面量做转义（\ 与 " 各自转义，控制字符抹平）；
//   - notify-send 标题/正文前置 -- 终结符，防标题以 - 开头被解析成选项；
//   - gdbus 的每个字符串实参按 GVariant 文本语法用双引号包裹，转义 \ 与 "；
//   - 标题/正文长度钳制（通知中心的实际显示上限），超长不报错只截断；
//   - 子进程 10s 超时 kill（PowerShell 冷启动偶发卡死防御），绝不悬挂通知流程；
//   - 诊断分层（G-53）：命令失败的公开文案只含命令名（`桌面通知命令执行失败：<file>`）；
//     stderr 摘要剥掉 PowerShell CLIXML、绝对路径打码并截断到 200 字符后只进
//     NotifyError.detail（宿主日志），不进 failed[]/审计/管理台等用户可见表面；
//   - 命令缺失（ENOENT）抛中文 NotifyError：Linux 先回落 gdbus，两者皆无才报错——
//     渠道级失败可见但不影响其他渠道（notify.mjs 每渠道独立 try/catch）。
//
// 语义对接（与其他渠道同规矩）：
//   - msg.silent === true 直接返回——静默推送的本地等价物就是不打扰；
//   - level → 紧迫度映射（Linux -u critical/normal/low；macOS 紧急级带提示音）；
//   - sound 配置：'auto'（默认，仅 timeSensitive 出声）/ 'always' / 'never'。
//     Windows 用 <audio silent="true"/> 关声；Linux 用 -h boolean:suppress-sound:true
//     或 -h string:sound-name:message-new-instant；
//   - 可选 appId：Windows toast 归属的应用（AUMID），非法值静默忽略回落到探测。

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NotifyError, ERROR_CODES } from './_shared.mjs'
import { trustedSessionUrl, sessionActions, sessionIsMuted, desktopActionCapabilities, startLinuxActions } from './desktop-actions.mjs'

export const type = 'desktop'
export { desktopActionCapabilities }

/** 子进程硬超时（ms）：PowerShell 冷启动偶发慢，10s 足够且绝不悬挂调用方。 */
const COMMAND_TIMEOUT_MS = 10_000

/** 标题/正文长度钳制（通知中心实际显示上限量级；分段由上游 segment 负责，这里只防极端值）。 */
const TITLE_MAX = 120
const BODY_MAX = 500

/** level → libnotify urgency 映射（timeSensitive 视作最高档）。 */
const URGENCY_OF = { timeSensitive: 'critical', active: 'normal', passive: 'low' }

/** freedesktop urgency 字节值（gdbus hints 用）。 */
const GDBUS_URGENCY = { critical: 2, normal: 1, low: 0 }

/** 通知归属的应用名（Linux -a / gdbus app_name）。 */
const APP_NAME = 'DeepSeek Harness'

/** macOS 提示音名（系统自带音效，紧急级默认用它）。 */
const MAC_SOUND = 'Ping'

/**
 * AUMID 合法字符集：Windows 应用标识的常见形态（包名、`{GUID}\path`、可执行名）。
 * 只允许这些字符，才能安全内联进 PowerShell 单引号字面量（' 不在集合内）。
 */
const APP_ID_RE = /^[A-Za-z0-9._{}\\ -]{1,128}$/

/** DSH 桌面应用的 AUMID（安装器写在开始菜单快捷方式上；快捷方式存在才用）。 */
const DSH_AUMID = 'com.deepseek.dsh'

/** Windows PowerShell 5.1 自带的已注册 AUMID（探测失败时的兜底，toast 归到 PowerShell）。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * base64 字符集断言：内联进 PS 脚本的编码值只能是这些字符。
 * 允许空串（空标题/空正文 → `FromBase64String('')` 在 PowerShell 里返回空字节数组），
 * 否则空标题会撞断言把整条桌面通知打挂。
 */
const BASE64_RE = /^[A-Za-z0-9+/=]*$/

/** Toast Tag 净化后的字符集（Windows 侧 Tag 上限 64 字符）。 */
const TAG_RE = /^[A-Za-z0-9._ -]{1,64}$/

// 运行态与配置分离（上游 issues #45/#46）：出站配置由 OutboundSource JSON 克隆后
// 深冻结，send 期间往 resolved 写探测缓存会 TypeError。AUMID 探测结果按 resolved
// 对象身份存进模块私有 WeakMap：同一份活配置只探测一次，hot replace 生成新对象后
// 重新探测（与「配置热重载会重新 resolve」语义一致）。
const runtimeStates = new WeakMap()

/** 非对象的 resolved（调用方误传 null）也给一份私有状态，绝不让 WeakMap 抛。 */
const fallbackState = { aumidProbe: undefined }

function stateOf(resolved) {
  if (resolved === null || typeof resolved !== 'object') return fallbackState
  let state = runtimeStates.get(resolved)
  if (state === undefined) {
    state = { aumidProbe: undefined }
    runtimeStates.set(resolved, state)
  }
  return state
}

/**
 * 校验并归一化配置；桌面渠道无凭证，sound 钳制合法枚举，appId 只在合法时透传。
 * G-64：布尔形态显式解析——YAML 裸 `sound: true/false` 首版被静默吞成 auto，
 * 用户写 false 却照样在紧急级出声是反直觉的。true→always / false→never 语义
 * 与三态枚举自然对齐；其余非法值回落 auto（默认策略），不因拼错炸掉桌面通知。
 * appId 非法（含引号/换行/超长）一律忽略——构建时的探测兜底比报错更稳。
 * @returns {{ sound: 'auto'|'always'|'never', appId?: string }}
 */
export function resolve(cfg = {}) {
  const raw = cfg?.sound
  let sound = 'auto'
  if (raw === true) sound = 'always'
  else if (raw === false) sound = 'never'
  else if (raw === 'always' || raw === 'never') sound = raw
  const resolved = { sound }
  const appId = typeof cfg?.appId === 'string' ? cfg.appId.trim() : ''
  if (appId !== '' && APP_ID_RE.test(appId)) resolved.appId = appId
  return resolved
}

/** 提示音策略：never 关 / always 开 / auto 仅紧急级。 */
function soundOn(resolved, msg) {
  if (resolved?.sound === 'never') return false
  if (resolved?.sound === 'always') return true
  return msg?.level === 'timeSensitive'
}

/** 控制字符抹平（通知横幅不支持换行/控制字符；AppleScript 字面量更不允许裸换行）。 */
function flatten(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

/** 长度钳制：超长截断加省略号，不报错（通知场景宁可截断不可失败）。 */
function clampText(value, max) {
  const text = flatten(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** AppleScript 双引号字面量转义：先 \ 后 "（入参已 clampText 钳制过的文本）。 */
function asq(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

/**
 * GVariant 文本语法的字符串字面量：双引号包裹，转义 \ 与 "。
 * gdbus 把每个实参当 GVariant 文本解析，标题/正文因此必须自己加引号；
 * 入参已经过 flatten（无控制字符），这两处转义就足够。
 */
function gv(value) {
  return `"${String(value ?? '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** UTF-8 → base64（PS 内用 UTF8.GetString(FromBase64String(...)) 还原）。 */
function base64Utf8(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64')
}

/** PowerShell 脚本 → -EncodedCommand 形参（UTF-16LE base64）。 */
function encodePowerShell(script) {
  return Buffer.from(String(script ?? ''), 'utf16le').toString('base64')
}

/** AUMID 净化：合法则原样用，否则回落到 PowerShell 自带 AUMID。 */
function sanitizeAumid(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text !== '' && APP_ID_RE.test(text) ? text : POWERSHELL_AUMID
}

/** Toast Tag：唯一、字符集受限、<=64 字符（Windows 侧要求）。 */
function toastTag() {
  const stamp = Date.now().toString(36)
  const noise = Math.random().toString(36).slice(2, 10)
  return (`dshn-${stamp}-${noise}`).slice(0, 64)
}

/**
 * 构建 Windows 端 toast 脚本（纯字符串拼装，无 IO）。
 * 用户文本只以 base64 形式进入脚本：这是「永远不把标题/正文拼进脚本」的结构保证。
 * 内联的字面量只有三类：base64 编码、净化后的 AUMID、净化后的 Toast Tag——
 * 构建前逐个断言字符集，越界即抛（不可达的防御，宁可失败也不产出可疑脚本）。
 */
function buildWindowsScript(title, body, aumid, tag, sound, sessionUrl = null) {
  const titleB64 = base64Utf8(title)
  const bodyB64 = base64Utf8(body)
  if (!BASE64_RE.test(titleB64) || !BASE64_RE.test(bodyB64) || !APP_ID_RE.test(aumid) || !TAG_RE.test(tag)) {
    throw new NotifyError('桌面通知脚本构建失败（内部字符集断言未通过）', ERROR_CODES.API_ERROR)
  }
  // 静音策略：sound off 时用 <audio silent="true"/>（系统 toast 默认会响提示音）
  const audio = sound ? '' : '<audio silent="true"/>'
  // URL already passed exact local-origin/session-route validation. Still encode it
  // before PS interpolation and XML-escape after decoding.
  const urlB64 = base64Utf8(sessionUrl ?? '')
  const actionLines = sessionUrl ? [
    `  $u=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${urlB64}'))`,
    '  $eu=[System.Security.SecurityElement]::Escape($u)',
    '  $actions=\'<actions><action content="Open session" activationType="protocol" arguments="\'+$eu+\'"/></actions>\'',
  ] : ["  $actions=''"]
  // WinRT toast：Show() 正常返回即视为已被系统接收（accepted），不再补固定睡眠——
  // 早先的 Start-Sleep 300ms 只是让 PowerShell 进程多活 300ms，白白拉长每次发送的可见返回延迟。
  // WinRT 抛错才走 System.Windows.Forms 气球（NotifyIcon）。两点平台事实：
  //   1) 气球没有音量/静音 API——sound:'never' 在这条回落路径上仍可能发系统默认提示音；
  //   2) 显示 3s 后 Dispose：含 PowerShell 冷启动（实测 ~4s）总耗时 ~7s，仍在 10s 命令
  //      超时内。早先用 8.5s 睡眠，总耗时 ~12s 会被 kill，通知已弹出却被误报 TIMEOUT。
  // 该 3s 等待与 10s 超时保护都保留：只去掉 toast 成功路径上的固定等待。
  return [
    "$ErrorActionPreference='Stop'",
    `$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${titleB64}'))`,
    `$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${bodyB64}'))`,
    `$appId='${aumid}'`,
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime] | Out-Null',
    '  $et=[System.Security.SecurityElement]::Escape($t)',
    '  $eb=[System.Security.SecurityElement]::Escape($b)',
    ...actionLines,
    `  $xmlText='<toast><visual><binding template="ToastGeneric"><text>'+$et+'</text><text>'+$eb+'</text></binding></visual>${audio}'+$actions+'</toast>'`,
    '  $xml=New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $xml.LoadXml($xmlText)',
    '  $toast=[Windows.UI.Notifications.ToastNotification]::new($xml)',
    `  $toast.Tag='${tag}'`,
    "  $toast.Group='dsh-notifier'",
    '  $toast.ExpirationTime=[DateTimeOffset]::Now.AddDays(1)',
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)',
    '} catch {',
    '  $err=$_.Exception.Message',
    '  try {',
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    Add-Type -AssemblyName System.Drawing',
    '    $icon=New-Object System.Windows.Forms.NotifyIcon',
    '    $icon.Icon=[System.Drawing.SystemIcons]::Information',
    '    $icon.BalloonTipIcon=[System.Windows.Forms.ToolTipIcon]::Info',
    '    $icon.BalloonTipTitle=$t.Substring(0,[Math]::Min($t.Length,63))',
    '    $icon.BalloonTipText=$b.Substring(0,[Math]::Min($b.Length,255))',
    '    $icon.Visible=$true',
    '    $icon.ShowBalloonTip(3000)',
    '    Start-Sleep -Milliseconds 3000',
    '    $icon.Dispose()',
    '  } catch {',
    "    [Console]::Error.Write($err+' / '+$_.Exception.Message)",
    '    exit 1',
    '  }',
    '}',
  ].join('\n')
}

/**
 * 纯命令构造器（单测核心）：按平台产出 { file, args } 或 { unsupported }。
 * 不做任何 IO——平台的可用性探测（Windows AUMID）由 send 层缓存后经 probe 传入。
 * @param {string} platform - process.platform（注入便于测试）。
 * @param {object} resolved - resolve() 产物。
 * @param {object} msg - { title, content, level, silent }。
 * @param {string|null} probe - Windows AUMID（win32 用；非非空字符串时回落 PowerShell AUMID）。
 * @returns {{ file: string, args: string[] } | { unsupported: string, hint?: string }}
 */
export function buildDesktopCommand(platform, resolved, msg, probe = null, options = {}) {
  if (msg?.silent === true) return { unsupported: 'silent' }
  const title = clampText(msg?.title, TITLE_MAX)
  const body = clampText(msg?.content, BODY_MAX)
  const sound = soundOn(resolved, msg)
  if (platform === 'darwin') {
    // display notification "正文" with title "标题" [sound name "Ping"]
    let script = `display notification "${asq(body)}" with title "${asq(title)}"`
    if (sound) script += ` sound name "${MAC_SOUND}"`
    return { file: 'osascript', args: ['-e', script] }
  }
  if (platform === 'linux') {
    // -a 应用名 / -u 紧迫度 / -h 声音 hint / -- 终结选项（防标题以 - 开头被当参数）
    const hint = sound ? 'string:sound-name:message-new-instant' : 'boolean:suppress-sound:true'
    return {
      file: 'notify-send',
      args: ['-a', APP_NAME, '-u', URGENCY_OF[msg?.level] ?? 'normal', '-h', hint, '--', title, body],
    }
  }
  if (platform === 'win32') {
    const aumid = sanitizeAumid(probe)
    const script = buildWindowsScript(title, body, aumid, toastTag(), sound, trustedSessionUrl(options))
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)],
    }
  }
  return { unsupported: `平台 ${String(platform)} 无原生桌面通知支持（可用：macOS/Linux/Windows）` }
}

/**
 * Linux 回落命令：notify-send 缺失时走 freedesktop D-Bus 接口（gnome/kde 默认带 gdbus）。
 * 纯函数、可单测。gdbus 把每个实参按 GVariant 文本解析，故字符串自己加双引号并转义。
 * `--` 终结符必需：gdbus 用 GOption 解析命令行（g_option_context_parse），方法实参里的
 * `-1`（expire_timeout）会被当成未知选项直接报错；`--` 之后一律按位置实参处理。
 * @returns {{ file: string, args: string[] }}
 */
export function buildGdbusCommand(resolved, msg) {
  const title = clampText(msg?.title, TITLE_MAX)
  const body = clampText(msg?.content, BODY_MAX)
  const sound = soundOn(resolved, msg)
  const urgency = GDBUS_URGENCY[URGENCY_OF[msg?.level] ?? 'normal'] ?? 1
  const hints = sound
    ? `{'urgency': <byte ${urgency}>, 'sound-name': <'message-new-instant'>}`
    : `{'urgency': <byte ${urgency}>, 'suppress-sound': <true>}`
  return {
    file: 'gdbus',
    args: [
      'call',
      '--session',
      '--dest', 'org.freedesktop.Notifications',
      '--object-path', '/org/freedesktop/Notifications',
      '--method', 'org.freedesktop.Notifications.Notify',
      '--',
      gv(APP_NAME), '0', gv(''), gv(title), gv(body), '[]', hints, '-1',
    ],
  }
}

/** 命令缺失时的中文指引（按命令给出可执行的下一步）。 */
function missingGuidance(file) {
  if (file === 'powershell.exe') return 'Windows 桌面通知依赖系统自带的 Windows PowerShell 5.1，请检查 PATH，或改用 bell / 浏览器通知'
  if (file === 'notify-send') return '需要 notify-send（libnotify-bin / libnotify）'
  if (file === 'gdbus') return '需要 gdbus（glib2）'
  if (file === 'osascript') return 'macOS 桌面通知依赖系统自带的 osascript'
  return '请检查系统 PATH 或改用其他渠道'
}

/**
 * 子进程 stderr 的脱敏摘要（只进 NotifyError.detail = 日志，绝不进公开文案/审计）：
 *   - PowerShell 原生 stderr 是 CLIXML 序列化：先把其中 <S S="Error"> 的可读文本抽出来，
 *     再把整段 CLIXML 外壳（模块名/脚本源码/路径）剥掉——既不丢失败原因，也不带路径；
 *   - 绝对路径打码为 <path>（Windows 盘符路径 + POSIX 绝对路径；不碰 URL 的 ://）；
 *   - 空白折叠、200 字符截断。排障够用，但不把机器内部路径带出日志层。
 */
const DIAGNOSTIC_MAX = 200

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }

/** CLIXML 里的 <S S="Error">…</S> 是可读错误行；解码 XML 实体与 _x000D_/_x000A_ 换行标记。 */
function clixmlErrorText(text) {
  const parts = []
  for (const match of String(text).matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)) {
    parts.push(
      match[1]
        .replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => XML_ENTITIES[entity] ?? entity)
        .replace(/_x000D_|_x000A_/g, ' '),
    )
  }
  return parts.join(' ')
}

function safeDiagnostic(value) {
  let text = String(value ?? '')
  try {
    if (/#<\s*CLIXML/i.test(text)) {
      const extracted = clixmlErrorText(text)
      text = `${text.replace(/#<\s*CLIXML[\s\S]*?(?:<\/Objs>|$)/gi, ' ')} ${extracted}`
    }
    // Windows 盘符路径：止于「: 空格」或行尾（文件名不含 ':'，所以不会吞掉后面的错误描述）
    text = text.replace(/[A-Za-z]:\\[^\r\n"']*?(?=:\s|$)/gm, '<path>')
    text = text.replace(/(?<![:/\w])\/(?:[\w.-]+\/)*[\w.-]+/g, '<path>')
    text = text.replace(/\s+/g, ' ').trim()
  } catch {
    return ''
  }
  return text.length > DIAGNOSTIC_MAX ? `${text.slice(0, DIAGNOSTIC_MAX - 1)}…` : text
}

/**
 * 跑一条子命令：resolve/reject 归一——ENOENT 抛中文 NOT_CONFIGURED（附 missing 标记，
 * 供 Linux 回落判定），非零退出码抛 API_ERROR，超时 kill 抛 TIMEOUT。
 * 诊断分层（G-53）：公开文案只含命令名（不含 stderr/底层 message——PowerShell 的
 * CLIXML 与本地路径不得经通知审计外泄）；stderr 只经 safeDiagnostic 进 detail（日志）。
 * stdout 一并收集：Windows AUMID 探测要读 ps 的输出。探测调用方自己把失败折叠。
 * @param {{ timeoutMs?: number }} [options] - 单次命令超时（缺省 COMMAND_TIMEOUT_MS）。
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCommand(file, args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawnImpl(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      rejectPromise(new NotifyError(`桌面通知命令执行失败：${file}`, ERROR_CODES.NETWORK_ERROR, {
        detail: `桌面通知命令执行失败：${file}（${safeDiagnostic(reason)}）`,
      }))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已退出 */ }
      rejectPromise(new NotifyError(`桌面通知命令超时（${timeoutMs}ms）：${file}`, ERROR_CODES.TIMEOUT))
    }, timeoutMs)
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    child.on('error', (error) => {
      const notFound = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      if (notFound) {
        const missing = new NotifyError(`系统缺少 ${file}：${missingGuidance(file)}`, ERROR_CODES.NOT_CONFIGURED)
        missing.missing = file
        finish(rejectPromise, missing)
        return
      }
      const reason = error instanceof Error ? error.message : String(error)
      finish(rejectPromise, new NotifyError(`桌面通知命令执行失败：${file}`, ERROR_CODES.NETWORK_ERROR, {
        detail: `桌面通知命令执行失败：${file}（${safeDiagnostic(reason)}）`,
      }))
    })
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('close', (code) => {
      if (code === 0) {
        finish(resolvePromise, { code, stdout, stderr })
      } else {
        const diagnostic = safeDiagnostic(stderr)
        finish(rejectPromise, new NotifyError(`桌面通知命令执行失败：${file}`, ERROR_CODES.API_ERROR, {
          detail: `桌面通知命令执行失败：${file}（退出码 ${code}）${diagnostic !== '' ? `；stderr: ${diagnostic}` : ''}`,
        }))
      }
    })
  })
}

/** DSH 桌面安装器创建的开始菜单快捷方式名（其 AUMID 属性即 com.deepseek.dsh）。 */
const DSH_SHORTCUT = 'DeepSeek Harness.lnk'

/**
 * DSH 桌面快捷方式的候选路径（当前用户与全体用户两个开始菜单目录）。
 * 纯函数，env 注入便于测试。
 */
export function dshShortcutCandidates(env = process.env) {
  const roots = [env?.APPDATA, env?.ProgramData ?? env?.PROGRAMDATA]
    .filter((value) => typeof value === 'string' && value !== '')
  return roots.map((root) => path.win32.join(root, 'Microsoft', 'Windows', 'Start Menu', 'Programs', DSH_SHORTCUT))
}

/**
 * 每份 resolved 只探测一次：开始菜单里有 DSH 桌面快捷方式就用 com.deepseek.dsh
 * （toast 显示为 DeepSeek Harness 并带它的图标），否则回落 PowerShell 自带 AUMID。
 * 只做文件存在性检查：早先用 Get-StartApps 查询，实测 11–17s，首条通知会被拖住。
 * 探测本身绝不抛。
 */
function probeAumid() {
  try {
    return dshShortcutCandidates(process.env).some((file) => existsImpl(file)) ? DSH_AUMID : POWERSHELL_AUMID
  } catch {
    return POWERSHELL_AUMID
  }
}

/** 选定本次发送的 AUMID：显式配置优先，否则用（缓存的）探测结果。 */
async function aumidFor(resolved) {
  const explicit = resolved !== null && typeof resolved === 'object' ? resolved.appId : undefined
  if (typeof explicit === 'string' && APP_ID_RE.test(explicit)) return explicit
  const state = stateOf(resolved)
  if (state.aumidProbe === undefined) state.aumidProbe = probeAumid()
  return state.aumidProbe
}

/**
 * 发送桌面通知。silent 直接跳过。
 * - Windows：AUMID 每份 resolved 只探测一次并缓存在运行态 WeakMap；toast 脚本经
 *   -EncodedCommand 传入，用户文本只以 base64 进脚本（见 buildWindowsScript）。
 * - Linux：先 notify-send；命令不存在（ENOENT）则回落 gdbus D-Bus 调用；两者都没有
 *   才抛 NOT_CONFIGURED（文案给出安装指引）。
 * - macOS：osascript（行为与原实现一致）。
 * @returns {Promise<void>} 失败一律抛 NotifyError（中文指引），由上层渠道级 try/catch 兜住。
 */
export async function send(resolved, msg, options = {}) {
  const platform = process.platform
  if (msg?.silent === true) return
  if (sessionIsMuted(options)) return { acceptance: 'suppressed' }
  if (platform === 'win32') {
    const command = buildDesktopCommand(platform, resolved, msg, await aumidFor(resolved), options)
    if (sessionIsMuted(options)) return { acceptance: 'suppressed' }
    await runCommand(command.file, command.args)
    return
  }
  if (platform === 'linux') {
    const primary = buildDesktopCommand(platform, resolved, msg)
    if (sessionActions(options).length > 0 && await startLinuxActions(primary, options, {
      run: runCommand, spawn: spawnImpl,
      warn: (text) => { try { console.error(`[dsh-notifier] ${text}`) } catch { /* diagnostics only */ } },
    })) return { acceptance: 'unverified' }
    if (sessionIsMuted(options)) return { acceptance: 'suppressed' }
    try {
      await runCommand(primary.file, primary.args)
      return
    } catch (error) {
      // 只有「notify-send 不存在」才回落；真正执行失败（退出码/超时）如实上抛
      if (!(error instanceof NotifyError) || error.code !== ERROR_CODES.NOT_CONFIGURED || error.missing !== 'notify-send') throw error
    }
    const fallback = buildGdbusCommand(resolved, msg)
    if (sessionIsMuted(options)) return { acceptance: 'suppressed' }
    try {
      await runCommand(fallback.file, fallback.args)
    } catch (error) {
      if (error instanceof NotifyError && error.code === ERROR_CODES.NOT_CONFIGURED) {
        throw new NotifyError(
          '需要 notify-send（libnotify-bin / libnotify）或 gdbus（glib2）；GNOME 与 KDE Plasma 默认都带其一',
          ERROR_CODES.NOT_CONFIGURED,
        )
      }
      throw error
    }
    return
  }
  const command = buildDesktopCommand(platform, resolved, msg)
  if (command.unsupported !== undefined) {
    throw new NotifyError(command.hint ?? command.unsupported, ERROR_CODES.NOT_CONFIGURED)
  }
  await runCommand(command.file, command.args)
}

/**
 * 平台能力描述（供管理台/UI 展示，纯函数、绝不抛）：
 * 返回 { os, desktop, support, backend, detail: { en, zh } } 的普通对象，
 * 每次调用都是新对象（可安全深冻结或直接序列化）。
 * @param {{ platform?: string, env?: object, release?: string }} [options]
 */
export function desktopPlatformInfo({ platform = process.platform, env = process.env, release = os.release() } = {}) {
  try {
    if (platform === 'win32') {
      const major = Number.parseInt(String(release ?? '').split('.')[0], 10)
      const supported = Number.isFinite(major) && major >= 10
      return {
        os: 'windows',
        desktop: null,
        support: supported ? 'supported' : 'unsupported',
        backend: 'windows-toast',
        detail: supported
          ? { en: 'Windows system notifications (Action Center)', zh: 'Windows 系统通知（操作中心）' }
          : { en: 'Native toasts need Windows 10 or later', zh: '原生系统通知需要 Windows 10 及以上版本' },
      }
    }
    if (platform === 'linux') {
      const current = String(env?.XDG_CURRENT_DESKTOP ?? '').toLowerCase()
      const session = String(env?.DESKTOP_SESSION ?? '').toLowerCase()
      let desktop = 'other'
      if (current.includes('gnome') || session.includes('gnome')) desktop = 'gnome'
      else if (current.includes('kde') || session.includes('kde')) desktop = 'kde'
      const graphical = [env?.DBUS_SESSION_BUS_ADDRESS, env?.DISPLAY, env?.WAYLAND_DISPLAY].some((value) => typeof value === 'string' && value !== '')
      if (!graphical) {
        return {
          os: 'linux',
          desktop,
          support: 'unsupported',
          backend: 'freedesktop',
          detail: { en: 'No graphical session; use a remote notification channel instead', zh: '无图形会话，请改用远程通知渠道' },
        }
      }
      const supported = desktop === 'gnome' || desktop === 'kde'
      return {
        os: 'linux',
        desktop,
        support: supported ? 'supported' : 'best-effort',
        backend: 'freedesktop',
        detail: supported
          ? { en: 'Linux desktop notifications (notify-send / libnotify)', zh: 'Linux 桌面通知（notify-send / libnotify）' }
          : { en: 'Desktop environment not specifically adapted; trying the freedesktop standard', zh: '未针对该桌面环境适配，按 freedesktop 标准尝试' },
      }
    }
    if (platform === 'darwin') {
      return {
        os: 'macos',
        desktop: null,
        support: 'supported',
        backend: 'macos',
        detail: { en: 'macOS Notification Center (osascript)', zh: 'macOS 通知中心（osascript）' },
      }
    }
    return {
      os: 'other',
      desktop: null,
      support: 'unsupported',
      backend: null,
      detail: { en: `No native desktop notification backend for ${String(platform)}`, zh: `平台 ${String(platform)} 无原生桌面通知支持（可用：macOS/Linux/Windows）` },
    }
  } catch {
    return {
      os: 'other',
      desktop: null,
      support: 'unsupported',
      backend: null,
      detail: { en: 'Desktop notification capability could not be determined', zh: '无法判断桌面通知能力' },
    }
  }
}

/** 测试注入缝：替换 spawn 实现（仅测试使用，生产恒为 node:child_process.spawn）。 */
export let spawnImpl = spawn
export function _setSpawnImpl(fn) {
  spawnImpl = typeof fn === 'function' ? fn : spawn
}

/** 测试注入缝：替换快捷方式存在性检查（生产恒为 node:fs.existsSync）。 */
export let existsImpl = existsSync
export function _setExistsImpl(fn) {
  existsImpl = typeof fn === 'function' ? fn : existsSync
}
