// dsh-notifier test/desktop.test.mjs
// desktop 渠道对抗性测试：命令矩阵纯函数 + 注入防御 + IO 归一（注入 spawn 假体）。
// 红线断言：标题/正文含任意恶意字符也只是字面参数或 base64——args 数组结构上杜绝
// shell 注入，Windows 脚本里不存在把用户文本拼进脚本文本的任何通路。

import test from 'node:test'
import assert from 'node:assert/strict'
import * as desktop from '../src/adapters/desktop.mjs'
import { NotifyError } from '../src/adapters/_shared.mjs'

const MSG = { title: '任务完成', content: 'agent 已结束', level: 'active' }

/** PowerShell 自带 AUMID（探测失败时的兜底；JS 字面量里 \ 要写两个）。 */
const PS_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 解出 -EncodedCommand（UTF-16LE base64）里的脚本文本。 */
function decodeCommand(args) {
  const index = args.indexOf('-EncodedCommand')
  assert.ok(index > 0, '-EncodedCommand 必须存在')
  return Buffer.from(args[index + 1], 'base64').toString('utf16le')
}

/** 从脚本里取出 base64 内联值（FromBase64String('...')）。 */
function inlinedBase64(script) {
  return [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map((match) => match[1])
}

/** 伪 child：stdout/stderr 可手动喂数据，事件可手动触发。 */
function makeFakeChild() {
  const listeners = new Map()
  return {
    stdout: { on: (evt, cb) => listeners.set(`stdout:${evt}`, cb) },
    stderr: { on: (evt, cb) => listeners.set(`stderr:${evt}`, cb) },
    on: (evt, cb) => listeners.set(evt, cb),
    kill: () => {},
    _emit: (evt, ...args) => listeners.get(evt)?.(...args),
    _stdout: (text) => listeners.get('stdout:data')?.(text),
    _stderr: (text) => listeners.get('stderr:data')?.(text),
  }
}

test.afterEach(() => {
  desktop._setSpawnImpl(null)
  desktop._setExistsImpl(null)
})

/** 钉死 process.platform（send 内部读它分发）——三平台 CI runner 行为必须一致。 */
async function withPlatform(platform, fn) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** 推进微任务队列：等探测链走完（探测 → 通知 spawn）而不依赖真实计时器。 */
async function flush() {
  for (let i = 0; i < 25; i += 1) await Promise.resolve()
}

/** 收集 spawn 调用并返回可操纵的假 child。 */
function installRecorder() {
  const spawned = []
  desktop._setSpawnImpl((file, args) => {
    const child = makeFakeChild()
    spawned.push({ file, args, child })
    return child
  })
  return spawned
}

/** 收尾：把还没 close 的假 child 收掉，避免 10s 超时定时器拖住测试进程。 */
function drain(spawned) {
  for (const entry of spawned) entry.child._emit('close', 0)
}

/** 从 toast 命令的脚本里取出内联的 AUMID（$appId='...'）。 */
function toastAppId(entry) {
  const match = decodeCommand(entry.args).match(/\$appId='([^']*)'/)
  return match ? match[1] : null
}

/** 测试用的开始菜单根目录（与宿主 OS 无关：探测只读 process.env 的这两个变量）。 */
const FAKE_APPDATA = 'C:\\Users\\test\\AppData\\Roaming'
const FAKE_PROGRAMDATA = 'C:\\ProgramData'

/** 钉住 AUMID 探测依赖的 env（APPDATA / ProgramData / PROGRAMDATA），结束恢复。 */
async function withWinEnv(fn) {
  const saved = { APPDATA: process.env.APPDATA, ProgramData: process.env.ProgramData, PROGRAMDATA: process.env.PROGRAMDATA }
  process.env.APPDATA = FAKE_APPDATA
  delete process.env.ProgramData
  process.env.PROGRAMDATA = FAKE_PROGRAMDATA
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---------- resolve ----------

test('resolve: sound 钳制合法枚举，默认 auto', () => {
  assert.deepEqual(desktop.resolve({}), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ sound: 'always' }), { sound: 'always' })
  assert.deepEqual(desktop.resolve({ sound: 'never' }), { sound: 'never' })
  assert.deepEqual(desktop.resolve({ sound: 'ALWAYS' }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ sound: true }), { sound: 'always' })
  assert.deepEqual(desktop.resolve({ sound: false }), { sound: 'never' })
  assert.deepEqual(desktop.resolve(null), { sound: 'auto' })
})

test('resolve: appId 仅在合法字符集内透传（引号/换行/超长一律忽略）', () => {
  assert.deepEqual(desktop.resolve({ appId: 'com.deepseek.dsh' }), { sound: 'auto', appId: 'com.deepseek.dsh' })
  assert.deepEqual(desktop.resolve({ appId: PS_AUMID }), { sound: 'auto', appId: PS_AUMID })
  assert.deepEqual(desktop.resolve({ appId: '  com.deepseek.dsh  ' }), { sound: 'auto', appId: 'com.deepseek.dsh' })
  assert.deepEqual(desktop.resolve({ appId: 'a'.repeat(128) }), { sound: 'auto', appId: 'a'.repeat(128) })
  // 非法：单引号、双引号、换行、$(...)、超长、非字符串
  assert.deepEqual(desktop.resolve({ appId: "x'; whoami" }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ appId: 'x"\n' }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ appId: '$(whoami)' }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ appId: 'a'.repeat(129) }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ appId: 42 }), { sound: 'auto' })
  assert.deepEqual(desktop.resolve({ appId: '   ' }), { sound: 'auto' })
  // 128 字符正好合法
})

// ---------- buildDesktopCommand：三平台矩阵 ----------

test('darwin: osascript 脚本含转义标题正文，紧急级带提示音', () => {
  const cmd = desktop.buildDesktopCommand('darwin', { sound: 'auto' }, { ...MSG, level: 'timeSensitive' })
  assert.equal(cmd.file, 'osascript')
  assert.deepEqual(cmd.args, ['-e', 'display notification "agent 已结束" with title "任务完成" sound name "Ping"'])
})

test('darwin: auto 策略下普通级无声；never 一律无声；always 一律有声', () => {
  const quiet = desktop.buildDesktopCommand('darwin', { sound: 'auto' }, MSG)
  assert.ok(!quiet.args[1].includes('sound name'))
  const never = desktop.buildDesktopCommand('darwin', { sound: 'never' }, { ...MSG, level: 'timeSensitive' })
  assert.ok(!never.args[1].includes('sound name'))
  const always = desktop.buildDesktopCommand('darwin', { sound: 'always' }, { ...MSG, level: 'passive' })
  assert.ok(always.args[1].includes('sound name'))
})

test('linux: notify-send 参数含应用名、urgency 与声音 hint，-- 终结符前置', () => {
  const quiet = desktop.buildDesktopCommand('linux', { sound: 'auto' }, MSG)
  assert.equal(quiet.file, 'notify-send')
  assert.deepEqual(quiet.args, ['-a', 'DeepSeek Harness', '-u', 'normal', '-h', 'boolean:suppress-sound:true', '--', '任务完成', 'agent 已结束'])
  // auto 策略：紧急级出声
  const loud = desktop.buildDesktopCommand('linux', { sound: 'auto' }, { ...MSG, level: 'timeSensitive' })
  assert.deepEqual(loud.args, ['-a', 'DeepSeek Harness', '-u', 'critical', '-h', 'string:sound-name:message-new-instant', '--', '任务完成', 'agent 已结束'])
  // urgency 映射不变
  assert.equal(desktop.buildDesktopCommand('linux', {}, { ...MSG, level: 'timeSensitive' }).args[3], 'critical')
  assert.equal(desktop.buildDesktopCommand('linux', {}, { ...MSG, level: 'passive' }).args[3], 'low')
  // never 覆盖 always? 不存在：never 一档已由 soundOn 处理
  assert.equal(desktop.buildDesktopCommand('linux', { sound: 'never' }, { ...MSG, level: 'timeSensitive' }).args[5], 'boolean:suppress-sound:true')
})

test('win32: -EncodedCommand 是 UTF-16LE base64，脚本内用户文本只有 base64 形式', () => {
  const cmd = desktop.buildDesktopCommand('win32', { sound: 'always' }, MSG, 'com.deepseek.dsh')
  assert.equal(cmd.file, 'powershell.exe')
  assert.deepEqual(cmd.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
  const script = decodeCommand(cmd.args)
  const title64 = Buffer.from(MSG.title, 'utf8').toString('base64')
  const body64 = Buffer.from(MSG.content, 'utf8').toString('base64')
  assert.deepEqual(inlinedBase64(script), [title64, body64])
  assert.ok(Buffer.from(inlinedBase64(script)[0], 'base64').toString('utf8') === MSG.title)
  // 明文标题/正文一次都不出现；脚本本身是纯 ASCII
  assert.ok(!script.includes(MSG.title))
  assert.ok(!script.includes(MSG.content))
  assert.match(script, /^[\x20-\x7e\n]*$/)
  // AUMID 是唯一非 base64 的内联值
  assert.ok(script.includes(`$appId='com.deepseek.dsh'`))
  // XML 结构与静音策略
  assert.ok(script.includes('<binding template="ToastGeneric"><text>'))
  assert.ok(script.includes('[System.Security.SecurityElement]::Escape'))
  assert.ok(script.includes('$toast.Group=\'dsh-notifier\''))
  assert.ok(script.includes('$toast.ExpirationTime=[DateTimeOffset]::Now.AddDays(1)'))
  assert.ok(script.includes('CreateToastNotifier($appId).Show($toast)'))
  // Toast Tag：字符集受限、<=64、每次发送唯一
  const tagOf = (decoded) => decoded.match(/\$toast\.Tag='([^']*)'/)[1]
  const tag = tagOf(script)
  const nextTag = tagOf(decodeCommand(desktop.buildDesktopCommand('win32', { sound: 'always' }, MSG, 'com.deepseek.dsh').args))
  assert.match(tag, /^[A-Za-z0-9._ -]{1,64}$/)
  assert.ok(tag.length <= 64)
  assert.notEqual(tag, nextTag, '每次发送的 Tag 必须唯一')
})

test('win32: 静音 audio 仅在 sound off 时出现', () => {
  const loud = decodeCommand(desktop.buildDesktopCommand('win32', { sound: 'always' }, MSG, 'com.deepseek.dsh').args)
  assert.ok(!loud.includes('<audio silent="true"/>'))
  // auto + active = 无声
  const quiet = decodeCommand(desktop.buildDesktopCommand('win32', { sound: 'auto' }, MSG, 'com.deepseek.dsh').args)
  assert.ok(quiet.includes('<audio silent="true"/>'))
  // auto + 紧急级 = 有声
  const urgent = decodeCommand(desktop.buildDesktopCommand('win32', { sound: 'auto' }, { ...MSG, level: 'timeSensitive' }, 'com.deepseek.dsh').args)
  assert.ok(!urgent.includes('<audio silent="true"/>'))
})

test('对抗: 空标题/空正文 → 三平台都可构建（Windows base64 允许空串）', () => {
  const win = desktop.buildDesktopCommand('win32', {}, {}, 'com.deepseek.dsh')
  assert.equal(win.file, 'powershell.exe')
  const script = decodeCommand(win.args)
  assert.deepEqual(inlinedBase64(script), ['', ''], '空标题/正文的 base64 是空串')
  assert.ok(script.includes("FromBase64String('')"))
  assert.equal(script.split('<text>').length - 1, 2, 'XML 仍有两个文本节点')
  const linux = desktop.buildDesktopCommand('linux', {}, {})
  assert.deepEqual(linux.args.slice(-2), ['', ''])
  assert.equal(desktop.buildDesktopCommand('darwin', {}, {}).args[1], 'display notification "" with title ""')
})

test('win32: 最大长度消息的 -EncodedCommand 与整条命令行都在 CreateProcess 上限内', () => {
  const big = { title: '标'.repeat(120), content: '长'.repeat(500), level: 'timeSensitive' }
  const cmd = desktop.buildDesktopCommand('win32', { sound: 'always' }, big, 'com.deepseek.dsh')
  const encoded = cmd.args[cmd.args.indexOf('-EncodedCommand') + 1]
  const commandLineLength = cmd.file.length + cmd.args.reduce((sum, arg) => sum + arg.length + 1, 0)
  // Windows CreateProcess 命令行上限 32767 个 UTF-16 字符；-EncodedCommand 是其子集。
  // 实测最大消息 ~11.2K，留下足够余量。
  assert.ok(encoded.length < 32_767, `EncodedCommand ${encoded.length} 字符`)
  assert.ok(commandLineLength < 32_767, `整条命令行 ${commandLineLength} 字符`)
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/)
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), decodeCommand(cmd.args))
})

test('win32: balloon 回落脚本在 10s 命令超时内收尾（不会弹了通知却误报 TIMEOUT）', () => {
  const script = decodeCommand(desktop.buildDesktopCommand('win32', { sound: 'never' }, MSG, 'com.deepseek.dsh').args)
  assert.ok(script.includes("$icon.ShowBalloonTip(3000)"))
  assert.ok(script.includes('Start-Sleep -Milliseconds 3000'))
  assert.ok(script.includes('$icon.Dispose()'))
  assert.ok(!script.includes('8500'), '旧 8.5s 睡眠 + PS 冷启动会超过 10s 命令超时')
  // 气球也失败时：把 WinRT 原始错误与气球错误一起写 stderr 并 exit 1
  assert.ok(script.includes("$err+' / '+$_.Exception.Message"))
  assert.ok(script.includes('exit 1'))
})

test('win32: probe 不是合法 AUMID 时回落 PowerShell 自带 AUMID（绝不内联任意串）', () => {
  for (const probe of [null, undefined, '', 42, {}, "x'; Remove-Item C:\\"]) {
    const script = decodeCommand(desktop.buildDesktopCommand('win32', {}, MSG, probe).args)
    assert.ok(script.includes(`$appId='${PS_AUMID}'`), `probe=${JSON.stringify(probe)} 应回落 PowerShell AUMID`)
    assert.ok(!script.includes('Remove-Item'))
  }
})

test('未知平台 → unsupported；silent → unsupported=silent', () => {
  assert.ok(desktop.buildDesktopCommand('freebsd', {}, MSG).unsupported.includes('freebsd'))
  assert.equal(desktop.buildDesktopCommand('darwin', {}, { ...MSG, silent: true }).unsupported, 'silent')
})

// ---------- 对抗性：注入与内容边界 ----------

test('对抗: AppleScript 引号/分号注入被转义（脚本为精确字符串）', () => {
  const evil = { title: 'x"; display alert "pwn', content: 'a\\b', level: 'active' }
  const cmd = desktop.buildDesktopCommand('darwin', { sound: 'never' }, evil)
  assert.equal(
    cmd.args[1],
    'display notification "a\\\\b" with title "x\\"; display alert \\"pwn"',
  )
})

test('对抗: Windows 恶意标题（引号/$()/反引号/分号/换行/</text>）不进脚本明文', () => {
  const evilTitle = `'; "$(whoami)" \`id\` ; rm -rf / </text>\n<script>alert(1)</script>`
  const cmd = desktop.buildDesktopCommand('win32', { sound: 'always' }, { title: evilTitle, content: '$(calc) & "quoted"', level: 'active' }, 'com.deepseek.dsh')
  const script = decodeCommand(cmd.args)
  for (const fragment of ['whoami', 'rm -rf', '<script>', '$(', '`id`', 'calc', 'quoted']) {
    assert.ok(!script.includes(fragment), `脚本不得包含明文片段 ${fragment}`)
  }
  // 模板里固定的两处 </text> 之外没有第三处（恶意标题里的已被 base64 吃掉）
  assert.equal(script.split('</text>').length - 1, 2)
  // base64 解码仍是原文本（换行已被 flatten 成空格）
  const decodedTitle = Buffer.from(inlinedBase64(script)[0], 'base64').toString('utf8')
  assert.equal(decodedTitle, evilTitle.replace(/\n/g, ' '))
})

test('对抗: linux 标题以 - 开头仍为字面参数（-- 终结符之后）', () => {
  const cmd = desktop.buildDesktopCommand('linux', {}, { title: '-u critical', content: '-h', level: 'active' })
  const ddash = cmd.args.indexOf('--')
  assert.equal(cmd.args[ddash + 1], '-u critical')
  assert.equal(cmd.args[ddash + 2], '-h')
  assert.ok(Array.isArray(cmd.args))
})

test('对抗: gdbus 字符串按 GVariant 文本转义（" 与 \\），方法实参前置 -- 终结符', () => {
  const cmd = desktop.buildGdbusCommand({ sound: 'always' }, { title: 'he said "hi"', content: 'C:\\tmp\\a\nb', level: 'active' })
  assert.equal(cmd.file, 'gdbus')
  assert.equal(cmd.args[0], 'call')
  assert.equal(cmd.args[1], '--session')
  assert.ok(cmd.args.includes('org.freedesktop.Notifications'))
  // -- 必须紧跟在 --method 值之后：否则 -1（expire_timeout）会被 GOption 当成未知选项
  assert.equal(cmd.args[8], '--')
  assert.equal(cmd.args.indexOf('--'), 8)
  // app_name / icon / summary / body 都是 GVariant 字符串字面量
  assert.equal(cmd.args[9], '"DeepSeek Harness"')
  assert.equal(cmd.args[10], '0')
  assert.equal(cmd.args[11], '""')
  assert.equal(cmd.args[12], '"he said \\"hi\\""')
  assert.equal(cmd.args[13], '"C:\\\\tmp\\\\a b"') // 换行被 flatten 成空格
  assert.equal(cmd.args[14], '[]')
  assert.equal(cmd.args[15], "{'urgency': <byte 1>, 'sound-name': <'message-new-instant'>}")
  assert.equal(cmd.args[16], '-1')
  // 标题以 - 开头也只是引号内的位置实参；body 里的 -1 与 expire_timeout 都不进选项解析
  const dash = desktop.buildGdbusCommand({ sound: 'always' }, { title: '-u critical', content: '-1', level: 'active' })
  const end = dash.args.indexOf('--')
  assert.equal(dash.args[end + 1], '"DeepSeek Harness"')
  assert.equal(dash.args[end + 4], '"-u critical"')
  assert.equal(dash.args[end + 5], '"-1"')
  assert.equal(dash.args.at(-1), '-1')
})

test('gdbus: urgency 字节与静音 hint 按 level/sound 映射', () => {
  const critical = desktop.buildGdbusCommand({ sound: 'never' }, { ...MSG, level: 'timeSensitive' })
  assert.equal(critical.args[15], "{'urgency': <byte 2>, 'suppress-sound': <true>}")
  const low = desktop.buildGdbusCommand({ sound: 'auto' }, { ...MSG, level: 'passive' })
  assert.equal(low.args[15], "{'urgency': <byte 0>, 'suppress-sound': <true>}")
})

test('对抗: 控制字符抹平、超长截断加省略号', () => {
  const cmd = desktop.buildDesktopCommand('linux', {}, { title: 'a\nb\tc\u0000d', content: 'x'.repeat(1000), level: 'active' })
  assert.equal(cmd.args[7], 'a b c d') // flatten 后（-h hint 占两格，-- 在 6）
  assert.ok(cmd.args[8].length <= 500)
  assert.ok(cmd.args[8].endsWith('…'))
})

// ---------- send：IO 归一（注入 spawn 假体） ----------

test('send: 成功路径 → spawn 一次且 file 来自构造器，close(0) 即 resolve', () => withPlatform('linux', async () => {
  const spawned = installRecorder()
  const pending = desktop.send({ sound: 'auto' }, MSG)
  await flush()
  assert.equal(spawned[0].file, 'notify-send')
  spawned[0].child._emit('close', 0)
  await assert.doesNotReject(pending)
  assert.equal(spawned.length, 1)
}))

test('send: 非零退出码 → 公开文案只含命令名，stderr 摘要只进 detail（日志）', () => withPlatform('linux', async () => {
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      child._stderr('boom from stderr')
      child._emit('close', 1)
    })
    return child
  })
  await assert.rejects(
    desktop.send({ sound: 'auto' }, MSG),
    (error) => {
      assert.ok(error instanceof NotifyError)
      assert.equal(error.code, 'API_ERROR')
      // G-53：公开文案（failed[]/审计/健康检查）不得含 stderr 原文
      assert.equal(error.message, '桌面通知命令执行失败：notify-send')
      assert.equal(error.publicMessage, error.message)
      assert.ok(!error.message.includes('boom from stderr'))
      // 诊断摘要只进非公开的 detail（宿主日志）
      assert.equal(error.detail, '桌面通知命令执行失败：notify-send（退出码 1）；stderr: boom from stderr')
      return true
    },
  )
}))

test('send: stderr 的 CLIXML 与绝对路径在 detail 里被剥离/打码（可读信息保留）', () => withPlatform('linux', async () => {
  const noisy = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"><MS><S N="Module">C:\\Program Files\\DeepSeek\\x.psm1</S></MS></Obj>'
    + '<S S="Error">toast render failed: C:\\Program Files\\DeepSeek\\x.exe: access denied_x000D__x000A_</S></Objs>\r\n'
    + 'gdbus failed: /usr/local/bin/gdbus: permission denied\r\n'
    + 'powershell failed: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe: access denied'
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      child._stderr(noisy)
      child._emit('close', 2)
    })
    return child
  })
  await assert.rejects(
    desktop.send({ sound: 'auto' }, MSG),
    (error) => {
      assert.equal(error.message, '桌面通知命令执行失败：notify-send', '公开文案不带任何 stderr')
      assert.ok(!error.detail.includes('CLIXML'), 'PowerShell CLIXML 块必须剥掉')
      assert.ok(!error.detail.includes('Program Files'), 'CLIXML 里的本地路径不得留存')
      assert.ok(!error.detail.includes('x.psm1'), 'CLIXML 里的模块路径不得留存')
      assert.ok(error.detail.includes('toast render failed'), 'CLIXML 里的可读错误行被抽取保留')
      assert.ok(!error.detail.includes('/usr/local/bin'), 'POSIX 绝对路径必须打码')
      assert.ok(!error.detail.includes('WindowsPowerShell'), 'Windows 绝对路径必须打码')
      assert.ok(error.detail.includes('<path>'), '路径替换为 <path> 占位')
      assert.ok(error.detail.includes('permission denied'), '可读的失败原因保留给日志')
      assert.ok(error.detail.includes('access denied'), '盘符路径后的错误描述不被一并吞掉')
      assert.ok(error.detail.includes('退出码 2'))
      assert.ok(error.detail.length <= 230, 'detail 有界')
      return true
    },
  )
}))

test('send: 子进程启动错误同样只公开命令名（原始 message 只进 detail）', () => withPlatform('linux', async () => {
  desktop._setSpawnImpl(() => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      const error = new Error('spawn /usr/bin/notify-send EACCES')
      error.code = 'EACCES'
      child._emit('error', error)
    })
    return child
  })
  await assert.rejects(desktop.send({ sound: 'auto' }, MSG), (error) => {
    assert.ok(error instanceof NotifyError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.message, '桌面通知命令执行失败：notify-send')
    assert.ok(!error.message.includes('/usr/bin'))
    assert.ok(!error.detail.includes('/usr/bin'), '路径打码')
    assert.ok(error.detail.includes('EACCES'), '错误码保留给日志')
    return true
  })
}))

test('send: silent 消息不 spawn', () => withPlatform('linux', async () => {
  let spawned = 0
  desktop._setSpawnImpl(() => { spawned += 1; return makeFakeChild() })
  await desktop.send({ sound: 'auto' }, { ...MSG, silent: true })
  assert.equal(spawned, 0)
}))

test('send: 子进程超时 kill → TIMEOUT（mock timers 推进）', (t) => withPlatform('linux', async () => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  desktop._setSpawnImpl(() => makeFakeChild()) // 永不 close = 卡死命令；首条 notify-send 就超时，不触发回落
  const pending = desktop.send({ sound: 'auto' }, MSG)
  const assertion = assert.rejects(pending, (error) => error instanceof NotifyError && error.code === 'TIMEOUT')
  t.mock.timers.tick(10_000)
  await assertion
}))

test('send(linux): notify-send 缺失（ENOENT）→ 回落 gdbus 成功', () => withPlatform('linux', async () => {
  const spawned = []
  desktop._setSpawnImpl((file, args) => {
    const entry = { file, args, child: makeFakeChild() }
    spawned.push(entry)
    if (file === 'notify-send') {
      queueMicrotask(() => {
        const error = new Error('spawn notify-send ENOENT')
        error.code = 'ENOENT'
        entry.child._emit('error', error)
      })
    } else {
      queueMicrotask(() => entry.child._emit('close', 0))
    }
    return entry.child
  })
  await desktop.send({ sound: 'never' }, MSG)
  assert.deepEqual(spawned.map((entry) => entry.file), ['notify-send', 'gdbus'])
  const expected = desktop.buildGdbusCommand({ sound: 'never' }, MSG)
  assert.deepEqual(spawned[1].args, expected.args)
  drain(spawned)
}))

test('send(linux): notify-send 与 gdbus 都缺失 → NOT_CONFIGURED 带安装指引', () => withPlatform('linux', async () => {
  desktop._setSpawnImpl((file) => {
    const child = makeFakeChild()
    queueMicrotask(() => {
      const error = new Error(`spawn ${file} ENOENT`)
      error.code = 'ENOENT'
      child._emit('error', error)
    })
    return child
  })
  await assert.rejects(
    desktop.send({ sound: 'auto' }, MSG),
    (error) => error instanceof NotifyError
      && error.code === 'NOT_CONFIGURED'
      && error.message.includes('需要 notify-send（libnotify-bin / libnotify）或 gdbus（glib2）'),
  )
}))

test('send(linux): notify-send 真实失败（非 ENOENT）不回落，如实上抛', () => withPlatform('linux', async () => {
  const spawned = installRecorder()
  const pending = desktop.send({ sound: 'auto' }, MSG)
  await flush()
  spawned[0].child._emit('close', 17)
  await assert.rejects(
    pending,
    (error) => error instanceof NotifyError
      && error.code === 'API_ERROR'
      && error.message === '桌面通知命令执行失败：notify-send'
      && error.detail.includes('退出码 17'),
  )
  assert.equal(spawned.length, 1, '退出码失败不是「命令缺失」，不得回落到 gdbus')
}))

test('dshShortcutCandidates: APPDATA 与 ProgramData/PROGRAMDATA 两个开始菜单根，缺失 env 安全', () => {
  assert.deepEqual(desktop.dshShortcutCandidates({ APPDATA: 'C:\\Users\\leon\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' }), [
    'C:\\Users\\leon\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk',
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk',
  ])
  // 真实 Windows env 是 PROGRAMDATA（全大写），大小写兜底同样生效
  assert.deepEqual(desktop.dshShortcutCandidates({ APPDATA: 'C:\\A', PROGRAMDATA: 'C:\\P' }), [
    'C:\\A\\Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk',
    'C:\\P\\Microsoft\\Windows\\Start Menu\\Programs\\DeepSeek Harness.lnk',
  ])
  // 缺失/非法 env → 跳过该根，绝不抛
  assert.deepEqual(desktop.dshShortcutCandidates({}), [])
  assert.deepEqual(desktop.dshShortcutCandidates(null), [])
  assert.deepEqual(desktop.dshShortcutCandidates({ APPDATA: '', ProgramData: 42 }), [])
})

test('send(win32): DSH 开始菜单快捷方式存在 → toast 归属 com.deepseek.dsh，且只 spawn 一个子进程', () => withPlatform('win32', () => withWinEnv(async () => {
  const candidates = desktop.dshShortcutCandidates(process.env)
  const checks = []
  desktop._setExistsImpl((file) => { checks.push(file); return file === candidates[0] })
  const spawned = installRecorder()
  try {
    const pending = desktop.send({ sound: 'always' }, MSG)
    await flush()
    assert.equal(spawned.length, 1, '没有探测子进程，只有真正的一条 toast')
    assert.equal(spawned[0].file, 'powershell.exe')
    assert.equal(toastAppId(spawned[0]), 'com.deepseek.dsh')
    assert.deepEqual(checks, [candidates[0]], '命中首个候选即短路')
    spawned[0].child._emit('close', 0)
    await assert.doesNotReject(pending)
  } finally {
    drain(spawned)
  }
})))

test('send(win32): 快捷方式不存在/存在性检查抛错 → 回落 PowerShell AUMID（探测绝不抛）', () => withPlatform('win32', () => withWinEnv(async () => {
  for (const scenario of ['missing', 'throws']) {
    desktop._setExistsImpl(scenario === 'throws'
      ? () => { throw new Error('exists exploded') }
      : () => false)
    const spawned = installRecorder()
    try {
      const pending = desktop.send({ sound: 'always' }, MSG)
      await flush()
      assert.equal(spawned.length, 1, `${scenario}: 只 spawn toast`)
      assert.equal(toastAppId(spawned[0]), PS_AUMID, `${scenario}: 回落 PowerShell AUMID`)
      spawned[0].child._emit('close', 0)
      await assert.doesNotReject(pending)
    } finally {
      drain(spawned)
    }
  }
})))

test('send(win32): 存在性检查每份 resolved 只做一次，新 resolved 重新检查（冻结配置安全）', () => withPlatform('win32', () => withWinEnv(async () => {
  const checks = []
  desktop._setExistsImpl((file) => { checks.push(file); return true })
  const spawned = installRecorder()
  try {
    const resolved = Object.freeze({ ...desktop.resolve({ sound: 'auto' }) })
    const first = desktop.send(resolved, MSG)
    await flush()
    assert.equal(checks.length, 1, '首次发送检查一次')
    spawned[0].child._emit('close', 0)
    await assert.doesNotReject(first)

    const second = desktop.send(resolved, MSG)
    await flush()
    assert.equal(checks.length, 1, '同一 resolved 复用缓存结果，不再检查')
    spawned[1].child._emit('close', 0)
    await assert.doesNotReject(second)

    const fresh = { ...desktop.resolve({ sound: 'auto' }) }
    const third = desktop.send(fresh, MSG)
    await flush()
    assert.equal(checks.length, 2, '新 resolved 重新检查一次')
    spawned[2].child._emit('close', 0)
    await assert.doesNotReject(third)
    for (const entry of spawned) assert.equal(toastAppId(entry), 'com.deepseek.dsh')
  } finally {
    drain(spawned)
  }
})))

test('send(win32): 显式 appId 生效且不做存在性检查', () => withPlatform('win32', async () => {
  const checks = []
  desktop._setExistsImpl((file) => { checks.push(file); return true })
  const spawned = installRecorder()
  try {
    const pending = desktop.send({ sound: 'always', appId: 'My.Team.App' }, MSG)
    await flush()
    assert.equal(spawned.length, 1, '有显式 appId 时只 spawn toast')
    assert.equal(checks.length, 0, '显式 appId 时不做存在性检查')
    assert.equal(toastAppId(spawned[0]), 'My.Team.App')
    spawned[0].child._emit('close', 0)
    await assert.doesNotReject(pending)
  } finally {
    drain(spawned)
  }
}))



// ---------- desktopPlatformInfo ----------

test('desktopPlatformInfo: win32 release >= 10 → supported windows-toast', () => {
  const info = desktop.desktopPlatformInfo({ platform: 'win32', release: '10.0.26300', env: {} })
  assert.deepEqual(info, {
    os: 'windows',
    desktop: null,
    support: 'supported',
    backend: 'windows-toast',
    detail: { en: 'Windows system notifications (Action Center)', zh: 'Windows 系统通知（操作中心）' },
  })
  const old = desktop.desktopPlatformInfo({ platform: 'win32', release: '6.3.9600', env: {} })
  assert.equal(old.support, 'unsupported')
  assert.equal(old.backend, 'windows-toast')
})

test('desktopPlatformInfo: linux gnome/kde/other/headless', () => {
  const gnome = desktop.desktopPlatformInfo({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'GNOME', DISPLAY: ':0' } })
  assert.equal(gnome.desktop, 'gnome')
  assert.equal(gnome.support, 'supported')
  assert.equal(gnome.backend, 'freedesktop')

  const kde = desktop.desktopPlatformInfo({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'KDE', WAYLAND_DISPLAY: 'wayland-0' } })
  assert.equal(kde.desktop, 'kde')
  assert.equal(kde.support, 'supported')

  const other = desktop.desktopPlatformInfo({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'XFCE', DISPLAY: ':0' } })
  assert.equal(other.desktop, 'other')
  assert.equal(other.support, 'best-effort')
  assert.ok(other.detail.zh.includes('freedesktop'))

  // DESKTOP_SESSION 作为次级线索
  const secondary = desktop.desktopPlatformInfo({ platform: 'linux', env: { XDG_CURRENT_DESKTOP: '', DESKTOP_SESSION: 'kde-plasma', DISPLAY: ':0' } })
  assert.equal(secondary.desktop, 'kde')

  const headless = desktop.desktopPlatformInfo({ platform: 'linux', env: {} })
  assert.equal(headless.support, 'unsupported')
  assert.equal(headless.backend, 'freedesktop')
  assert.ok(headless.detail.zh.includes('无图形会话'))
})

test('desktopPlatformInfo: darwin / 其他平台 / 永不抛', () => {
  const mac = desktop.desktopPlatformInfo({ platform: 'darwin', env: {} })
  assert.equal(mac.os, 'macos')
  assert.equal(mac.support, 'supported')
  assert.equal(mac.backend, 'macos')

  const bsd = desktop.desktopPlatformInfo({ platform: 'freebsd', env: {} })
  assert.deepEqual(bsd, {
    os: 'other',
    desktop: null,
    support: 'unsupported',
    backend: null,
    detail: { en: bsd.detail.en, zh: bsd.detail.zh },
  })
  assert.ok(bsd.detail.zh.includes('freebsd'))

  // 恶意/异常入参也不抛
  const hostile = desktop.desktopPlatformInfo({
    platform: 'linux',
    env: { get XDG_CURRENT_DESKTOP() { throw new Error('boom') } },
  })
  assert.equal(hostile.support, 'unsupported')
  assert.equal(typeof hostile.detail.zh, 'string')
  assert.doesNotThrow(() => desktop.desktopPlatformInfo({ platform: undefined, env: null, release: undefined }))
})

test('desktopPlatformInfo: 每次返回新对象（可安全深冻结/序列化）', () => {
  const first = desktop.desktopPlatformInfo({ platform: 'darwin', env: {} })
  const second = desktop.desktopPlatformInfo({ platform: 'darwin', env: {} })
  assert.notEqual(first, second)
  assert.notEqual(first.detail, second.detail)
  assert.doesNotThrow(() => JSON.stringify(first))
  assert.doesNotThrow(() => Object.freeze(first.detail))
})
