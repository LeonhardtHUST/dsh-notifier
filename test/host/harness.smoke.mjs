#!/usr/bin/env node
// test/host/harness.smoke.mjs — real-host DSH 0.2.2-rc.3 smoke for dsh-notifier.
//
// Run:  node test/host/harness.smoke.mjs
//
// It does NOT use the node:test runner on purpose: `test/host/**` must stay
// OUT of the `npm test` glob (`test/*.test.mjs`), so this is a plain executable
// script that prints a PASS/FAIL summary and exits non-zero on failure.
//
// What it proves, on the installed DSH 0.2.2-rc.3 (Desktop ASAR):
//   A. web profile     — composes the plugin row, boots the web app, serves the
//                        plugin's authenticated /dsh-notifier channel (401/403
//                        without a Connection admission), and logs its own line.
//   B. headless profile — composes no connection/webServer and no PENDING wait,
//                        activates the plugin, registers the notify tool +
//                        ctx.notifier, and delivers a real webhook POST to a
//                        local loopback receiver.
//
// Every DSH_HOME is a throwaway dir under the OS temp scratch root; the daily
// ~/.dsh is refused by the harness. No real provider is called, and no background
// job is started.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DSH_CLI,
  DSH_INSTALL_DIR,
  DSH_NODE_EXECUTABLE,
  HOST_PREREQUISITES,
  REAL_DSH_HOME,
  SCRATCH_ROOT,
  assertNotRealDshHome,
  bootEnv,
  bootProfile,
  dumpConfig,
  hasPnpm,
  installPluginIntoProfile,
  installProbeIntoProfile,
  makeDisposableDshHome,
  readPluginState,
  startLocalReceiver,
} from './harness.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROBE_DIR = join(__dirname, 'fixtures', 'smoke-probe')
const WEB_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
const HEADLESS_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

// ── tiny test reporter ─────────────────────────────────────────────────────
const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
}
function section(title) {
  console.log(`\n=== ${title} ===`)
}
/** strip anything that looks like a secret/token from a log line before print */
function sanitize(s) {
  return String(s)
    .replace(/token=[A-Za-z0-9._~-]+/g, 'token=<redacted>')
    .replace(/\?token=[^\s"']+/g, '?token=<redacted>')
}

/** Read the host version through the ASAR-aware runtime (plain Node cannot). */
function hostVersion() {
  const env = { ...bootEnv(SCRATCH_ROOT) }
  delete env.DSH_HOME
  const run = spawnSync(DSH_NODE_EXECUTABLE, [DSH_CLI, '--version'], {
    env,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  return (run.stdout ?? '').trim().split(/\r?\n/).pop() ?? ''
}

async function main() {
  console.log('dsh-notifier rc.3 real-host harness smoke')
  console.log(`host install : ${DSH_INSTALL_DIR ?? '(not found)'}`)
  console.log(`node runtime : ${DSH_NODE_EXECUTABLE}`)
  console.log(`scratch root : ${SCRATCH_ROOT}`)
  console.log(`pnpm present : ${hasPnpm()}`)

  if (!HOST_PREREQUISITES.ok) {
    console.error('\nSMOKE: SKIP/FAIL — installed DSH 0.2.2-rc.3 not found.')
    console.error('Set DSH_INSTALL_DIR to the @deepseek-ai/dsh package dir and DSH_NODE_EXECUTABLE to the Electron binary.')
    process.exitCode = 1
    return
  }
  console.log(`host version : ${hostVersion() || '(unreadable)'}`)

  const cleanupFns = []
  const homes = []
  let web = null
  let hl = null

  try {
    // ── guard demonstration ────────────────────────────────────────────────
    section('guards')
    let guardOk = false
    try {
      assertNotRealDshHome(REAL_DSH_HOME)
    } catch {
      guardOk = true
    }
    record('refuses to touch the real ~/.dsh', guardOk)
    record('scratch root is disposable (not the real profile)', !applyRealHomeCheck(SCRATCH_ROOT))

    // ── local receiver ─────────────────────────────────────────────────────
    section('local receiver')
    const receiver = await startLocalReceiver()
    cleanupFns.push(() => receiver.close())
    record('loopback receiver listening', receiver.port > 0, `port ${receiver.port}`)

    // ── real Cordis lifecycle-listener contract ─────────────────────────────
    section('real Cordis EventContext (host runtime)')
    const eventHome = makeDisposableDshHome('event-context')
    homes.push(eventHome)
    const eventRun = spawnSync(
      DSH_NODE_EXECUTABLE,
      [join(__dirname, 'event-context.smoke.mjs'), DSH_INSTALL_DIR],
      {
        env: bootEnv(eventHome.home),
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      },
    )
    const eventOutput = `${eventRun.stdout ?? ''}${eventRun.stderr ?? ''}`
    record('real Cordis lifecycle-listener contract passes', eventRun.status === 0,
      `exit ${String(eventRun.status)}${eventRun.error ? ` (${String(eventRun.error.message ?? eventRun.error)})` : ''}`)
    console.log('  --- event-context log (sanitized) ---')
    for (const line of sanitize(eventOutput).split('\n').filter(Boolean).slice(0, 20)) {
      console.log(`    | ${line}`)
    }

    // ── WEB profile ────────────────────────────────────────────────────────
    section('A. web profile boot + /dsh-notifier seam')
    const webHome = makeDisposableDshHome('smoke-web')
    homes.push(webHome)
    installPluginIntoProfile({
      home: webHome.home,
      profile: 'web',
      bundles: WEB_BUNDLES,
      cordisPatchYaml:
        `- id: dsh-notifier\n` +
        `  config:\n` +
        `    enabled: true\n` +
        `    admin:\n` +
        `      enabled: false\n` +
        `    channels: []\n`,
    })
    record('installed dsh-notifier into web profile', existsSync(webHome.home))

    const dump = await dumpConfig({ home: webHome.home, profile: 'web' })
    const dumpHasPlugin = /id:\s*dsh-notifier\b/.test(dump.stdout)
    const dumpSkipping = /skipping profile bundle\s*"dsh-notifier"/.test(dump.stdout + dump.stderr)
    record(
      'dump-config composes dsh-notifier row',
      dumpHasPlugin && !dumpSkipping,
      dumpSkipping ? 'host SKIPPED the bundle (install gate denied)' : `exit ${dump.exitCode}`,
    )

    web = await bootProfile({
      home: webHome.home,
      profile: 'web',
      args: ['--no-open', '--port', '0'],
      timeoutMs: 45000,
    })
    let webUrl = ''
    try {
      webUrl = await web.waitFor(/dsh web: http:\/\/127\.0\.0\.1:\d+/, 30000)
    } catch {
      webUrl = ''
    }
    const urlMatch = /(http:\/\/127\.0\.0\.1:\d+)/.exec(webUrl)
    const baseUrl = urlMatch?.[1] ?? ''

    let seamStatus = 0
    let seamBody = ''
    if (baseUrl !== '') {
      try {
        const response = await fetch(`${baseUrl}/dsh-notifier/smoke-probe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method: 'surface.home', payload: {} }),
          signal: AbortSignal.timeout(10000),
        })
        seamStatus = response.status
        seamBody = (await response.text()).slice(0, 80)
      } catch (error) {
        seamBody = String(error?.message ?? error).slice(0, 80)
      }
    }
    const webOutput = web.output()
    await web.stop()
    web = null
    const webChannel = /\[dsh-notifier\][^\n]*/.test(webOutput)
    const webUrlAdvertised = /dsh web: http:\/\/127\.0\.0\.1:\d+/.test(webOutput)
    record('web boots and plugin line appears', webChannel,
      sanitize((webOutput.match(/\[dsh-notifier\][^\n]*/)?.[0] ?? '').slice(0, 120)))
    record('web server URL advertised', webUrlAdvertised, sanitize(baseUrl))
    record('plugin /dsh-notifier seam is mounted and admits/denies', seamStatus === 401 || seamStatus === 403,
      `HTTP ${seamStatus} ${sanitize(seamBody)}`)
    const webPending = /waiting for services|did not activate/i.test(webOutput)
    record('web has no PENDING/waiting-for-services', !webPending)
    console.log('  --- web boot log (sanitized) ---')
    for (const line of sanitize(webOutput).split('\n').filter(Boolean).slice(0, 14)) {
      console.log(`    | ${line}`)
    }

    // ── HEADLESS profile ───────────────────────────────────────────────────
    section('B. headless profile boot + real notify push')
    const hlHome = makeDisposableDshHome('smoke-headless')
    homes.push(hlHome)
    const hookUrl = receiver.url('/hook')
    installPluginIntoProfile({
      home: hlHome.home,
      profile: 'headless',
      bundles: HEADLESS_BUNDLES,
      cordisPatchYaml:
        `- id: dsh-notifier\n` +
        `  config:\n` +
        `    enabled: true\n` +
        `    admin:\n` +
        `      enabled: false\n` +
        `    channels:\n` +
        `      - type: webhook\n` +
        `        url: '${hookUrl}'\n` +
        `        allowPrivateNetwork: true\n`,
    })
    installProbeIntoProfile({
      home: hlHome.home,
      profile: 'headless',
      probeDir: PROBE_DIR,
    })
    record('installed dsh-notifier + probe into headless profile', existsSync(hlHome.home))

    const hlDump = await dumpConfig({ home: hlHome.home, profile: 'headless' })
    const noConn = !/id:\s*connection\b/.test(hlDump.stdout)
    const noWeb = !/id:\s*webserver\b/i.test(hlDump.stdout)
    const hlSkipping = /skipping profile bundle/i.test(hlDump.stdout + hlDump.stderr)
    record('headless composes no connection/webServer', noConn && noWeb)
    record('headless dump-config has no skipped bundle', !hlSkipping)

    // Boot headless with a benign task. It exits non-zero with MISSING_CREDENTIAL
    // (no LLM key) AFTER the plugin activates and delivers — that is expected.
    hl = await bootProfile({
      home: hlHome.home,
      profile: 'headless',
      args: ['echo hello'],
      timeoutMs: 45000,
    })
    const hlResult = await hl.result()
    const hlOutput = hl.output()

    const activated = /\[dsh-notifier\]\s*已启用渠道/.test(hlOutput)
    const pending = /waiting for services|did not activate|PENDING/i.test(hlOutput)
    record('headless plugin activates (已启用渠道)', activated,
      sanitize((hlOutput.match(/\[dsh-notifier\][^\n]*/)?.[0] ?? '').slice(0, 120)))
    record('headless has NO pending/waiting-for-services', !pending)

    const probePresent = /\[SMOKE-PROBE\] notifier-present \{"present":true\}/.test(hlOutput)
    const probePushOk = /\[SMOKE-PROBE\] push-result .*"ok":true/.test(hlOutput)
    record('probe sees notifier present', probePresent)
    record('probe push reported ok:true', probePushOk)

    const hookHits = receiver.requests.filter((request) => request.path === '/hook')
    record('local receiver got real POST /hook', hookHits.length > 0,
      `${hookHits.length} request(s), exit ${hlResult.exitCode}`)

    await hl.stop()
    hl = null
    console.log('  --- headless boot log (sanitized) ---')
    for (const line of sanitize(hlOutput).split('\n').filter(Boolean).slice(0, 16)) {
      console.log(`    | ${line}`)
    }
    if (hookHits.length > 0) {
      console.log('  --- receiver request[0] ---')
      console.log(`    | ${hookHits[0].method} ${hookHits[0].path} body=${JSON.stringify(hookHits[0].body).slice(0, 200)}`)
    }

    // ── plugin state (read-only) ───────────────────────────────────────────
    section('plugin state (read-only)')
    const stateDir = join(hlHome.home, 'dsh-notifier')
    const state = readPluginState(stateDir)
    record('readPluginState never throws', true, state ? 'state.json present' : 'no state.json')
  } finally {
    // Always tear down the processes and homes we created.
    for (const handle of [web, hl]) {
      if (handle === null) continue
      try { await handle.stop() } catch { /* best effort */ }
    }
    for (const home of homes) {
      try { home.cleanup() } catch { /* best effort */ }
    }
    for (const fn of cleanupFns.reverse()) {
      try { await fn() } catch { /* best effort */ }
    }
  }

  // ── summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((result) => !result.ok)
  console.log('\n=== SUMMARY ===')
  for (const result of results) {
    console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(`SMOKE: FAIL (${failed.length} failing)`)
    process.exitCode = 1
  } else {
    console.log('SMOKE: PASS')
    process.exitCode = 0
  }
}

/** True when p is inside a real DSH home (the guard should always refuse it). */
function applyRealHomeCheck(p) {
  try {
    assertNotRealDshHome(p)
    return false
  } catch {
    return true
  }
}

main().catch((error) => {
  console.error('\nSMOKE: FAIL (unhandled error)')
  console.error(sanitize(error?.stack ?? String(error)))
  process.exitCode = 1
})
