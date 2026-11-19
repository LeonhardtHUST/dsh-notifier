// Session actions use only native notification contracts. No registered handlers,
// shell commands, callback URLs, credentials or additional runtime dependencies.
const MUTE_PRESETS = Object.freeze([5, 10, 15, 30, 'always'])
const MAX_PENDING = 8
const ACTION_TTL_MS = 60_000
let pending = 0

/** A caller must supply a host-derived origin, not one taken from notification data. */
export function trustedSessionUrl(options = {}) {
  try {
    if (typeof options.sessionId !== 'string' || !options.sessionId || options.sessionId.length > 256) return null
    if (typeof options.sessionUrl !== 'string' || typeof options.sessionOrigin !== 'string') return null
    const origin = new URL(options.sessionOrigin)
    const url = new URL(options.sessionUrl)
    if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)) return null
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    if (url.origin !== origin.origin || url.username || url.password || url.search) return null
    // Plugin-owned fragment is consumed after authentication by the native client.
    if (url.hash !== `#dsh-notifier-session=${encodeURIComponent(options.sessionId)}` || url.pathname !== '/') return null
    return url.href
  } catch { return null }
}

export function sessionActions(options = {}) {
  if (!options || typeof options !== 'object') return []
  const actions = []
  const url = trustedSessionUrl(options)
  if (url) actions.push({ id: 'open', label: 'Open session', url })
  if (typeof options.sessionId === 'string' && options.sessionId && options.sessionId.length <= 256 && typeof options.onMute === 'function') {
    const requested = Array.isArray(options.muteMinutes) ? options.muteMinutes : MUTE_PRESETS
    for (const minutes of MUTE_PRESETS) {
      if (requested.includes(minutes)) actions.push({ id: `mute-${minutes}`, label: minutes === 'always' ? 'Mute this session' : `Mute ${minutes} min`, minutes })
    }
  }
  return actions
}

export function desktopActionCapabilities(platform) {
  return {
    openSession: platform === 'win32' ? 'trusted-web-url' : platform === 'linux' ? 'notify-send-actions' : 'unsupported',
    muteSession: platform === 'linux' ? 'notify-send-actions' : 'unsupported',
    // Installed Desktop dsh://open only focuses the app, never a session.
    desktopSessionProtocol: false,
  }
}

/**
 * libnotify actions are conditional on both CLI flags and notification server.
 * Return after spawning; the bounded observer never blocks notification delivery.
 * Only exact, single-line action IDs from this child can invoke a closure callback.
 */
export async function startLinuxActions(command, options, { run, spawn, warn = () => {}, timeoutMs = ACTION_TTL_MS } = {}) {
  const actions = sessionActions(options)
  const onMute = options?.onMute
  const report = (text) => { try { warn(text) } catch { /* diagnostics must not escape listeners */ } }
  if (!actions.length || pending >= MAX_PENDING) return false
  try {
    const help = await run('notify-send', ['--help'])
    if (!help.stdout.includes('--action') || !help.stdout.includes('--wait')) return false
  } catch { return false }
  // Recheck after the asynchronous probe to enforce the observer cap under bursts.
  if (pending >= MAX_PENDING) return false
  pending++
  return new Promise((resolve) => {
    let child, timer, done = false, started = false, output = '', overflow = false
    const finish = (ok) => {
      if (done) return false
      done = true
      clearTimeout(timer)
      pending--
      if (!started) resolve(ok)
      return true
    }
    const args = [...command.args]
    const end = args.indexOf('--')
    args.splice(end, 0, '--wait', ...actions.map((action) => `--action=${action.id}=${action.label}`))
    try {
      child = spawn(command.file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      timer = setTimeout(() => {
        if (!finish(false)) return
        try { child.kill() } catch { /* already exited */ }
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on('data', (chunk) => {
        if (output.length + String(chunk).length > 128) overflow = true
        else output += String(chunk)
      })
      child.on('spawn', () => { if (done) return; started = true; child.unref?.(); resolve(true) })
      child.on('error', () => { if (finish(false) && started) report('Desktop notification action observer failed') })
      child.on('close', (code) => {
        if (!finish(code === 0)) return
        if (code !== 0) {
          if (started) Promise.resolve().then(() => run(command.file, command.args)).catch(() => report('Desktop notification fallback failed'))
          return
        }
        if (overflow) return
        const action = actions.find((entry) => output === `${entry.id}\n` || output === entry.id)
        if (!action) return
        Promise.resolve().then(async () => {
          if (action.id === 'open') await run('xdg-open', [action.url])
          else await onMute(action.minutes)
        }).catch(() => report('Desktop notification action failed'))
      })
    } catch { finish(false) }
  })
}
