// Disposable DSH 0.2.2-rc.3 test harness for dsh-notifier (Windows / ASAR-aware).
//
// Goals (see test/host/README.md):
//   * Every DSH_HOME we create lives under a scratch root in the OS temp dir and is
//     disposable. The real ~/.dsh is refused before any write.
//   * A profile is installed through the host's OWN profile-bundle path:
//     profiles/<name>/package.json `dsh.profile.bundles` + the plugin payload under
//     profiles/<name>/node_modules/<bundle row name>. The row name is read from the
//     package's bundle patch, so the scoped package identity works without editing
//     package.json.name.
//   * The installed Desktop CLI lives inside app.asar, which plain Node cannot read.
//     Booting therefore spawns DSH_NODE_EXECUTABLE with ELECTRON_RUN_AS_NODE=1 (the
//     Electron runtime is ASAR-aware), never a Node from PATH.
//   * Booting has a bounded timeout and a guaranteed kill (Windows tree kill), so no
//     orphan process survives a failed smoke.
//   * A loopback HTTP receiver records the real outbound POST used by the smoke.
//
// This module has NO side effects on import. It only touches paths under the scratch
// root (and reads the repo) and refuses anything reaching the real ~/.dsh.

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── fixed locations ────────────────────────────────────────────────────────
// test/host/harness.mjs -> repo root is two levels up.
const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(__dirname, '..', '..')

/** Coordinates of the installed DSH host; resolved without reading inside ASAR. */
function detectInstallDir() {
  const fromEnv = process.env.DSH_INSTALL_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const candidates = []
    if (typeof localAppData === 'string' && localAppData.trim() !== '') {
      candidates.push(join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh'))
    }
    for (const candidate of candidates) {
      if (existsSync(join(candidate, 'lib', 'bin.js'))) return candidate
    }
  }
  return null
}

/** The running Electron executable (GUI subsystem on Windows), or a plain node. */
function detectNodeExecutable(installDir) {
  const fromEnv = process.env.DSH_NODE_EXECUTABLE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  if (installDir !== null) {
    // <root>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh -> <root>
    const root = resolve(installDir, '..', '..', '..', '..', '..')
    const candidate = join(root, 'DeepSeek Harness.exe')
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

/** Absolute install directory of @deepseek-ai/dsh, or null when undetectable. */
export const DSH_INSTALL_DIR = detectInstallDir()

/** Electron executable used to boot the ASAR-hosted CLI. */
export const DSH_NODE_EXECUTABLE = detectNodeExecutable(DSH_INSTALL_DIR)

/** The pinned CLI entrypoint (inside app.asar on Desktop). */
export const DSH_CLI = DSH_INSTALL_DIR !== null ? join(DSH_INSTALL_DIR, 'lib', 'bin.js') : null

/** The ONLY directory we are ever allowed to create DSH_HOMEs under. */
export const SCRATCH_ROOT = resolve(
  process.env.DSH_NOTIFIER_HOST_SCRATCH ?? join(tmpdir(), 'dsh-notifier-rc3-scratch'),
)

/** Every real profile home on this machine; any path resolution landing here throws. */
export const REAL_DSH_HOMES = [homedir(), process.env.HOME, process.env.USERPROFILE]
  .filter((value) => typeof value === 'string' && value.trim() !== '')
  .map((value) => resolve(value, '.dsh'))
  .filter((value, index, all) => all.indexOf(value) === index)

/** Back-compat alias used by the smoke's guard demonstration. */
export const REAL_DSH_HOME = REAL_DSH_HOMES[0] ?? join(homedir(), '.dsh')

export const HOST_PREREQUISITES = {
  ok: DSH_INSTALL_DIR !== null && DSH_CLI !== null,
  installDir: DSH_INSTALL_DIR,
  nodeExecutable: DSH_NODE_EXECUTABLE,
}

// ── path guards ────────────────────────────────────────────────────────────

/** True when `child` is the same as, or nested under, `root` (both resolved). */
function isInside(root, child) {
  const r = resolve(root)
  const c = resolve(child)
  if (c === r) return true
  return c.startsWith(r + sep)
}

/** Throws unless `p` is strictly inside the scratch root. */
export function assertInsideScratch(p) {
  if (!isInside(SCRATCH_ROOT, p)) {
    throw new Error(
      `refusing path outside scratch root: ${p} is not under ${SCRATCH_ROOT}`,
    )
  }
}

/**
 * Throws if `p` resolves to any real ~/.dsh (or anything inside it). Called by
 * every write helper so a typo can never damage the maintainer's live profile.
 */
export function assertNotRealDshHome(p) {
  const resolved = resolve(p)
  for (const realHome of REAL_DSH_HOMES) {
    if (isInside(realHome, resolved)) {
      throw new Error(
        `refusing to touch the real DSH home (${realHome}); got ${resolved}`,
      )
    }
  }
  return resolved
}

/** Combined guard used by every mutating helper. */
function guardWritePath(p) {
  assertNotRealDshHome(p)
  assertInsideScratch(p)
  return resolve(p)
}

// ── makeDisposableDshHome ──────────────────────────────────────────────────

/**
 * Create a disposable DSH_HOME under the scratch root.
 *
 * @param {string} name short slug, e.g. "smoke-web"
 * @param {{ reset?: boolean }} [opts] reset=true (default) removes a previous
 *        home of the same name first, so reruns start clean.
 * @returns {{ home: string, name: string, cleanup: () => void }}
 */
export function makeDisposableDshHome(name, opts = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name))) {
    throw new Error(`invalid home name (use [A-Za-z0-9._-]): ${name}`)
  }
  const reset = opts.reset !== false
  const home = join(SCRATCH_ROOT, `dshhome-${name}`)
  // Guard BEFORE any filesystem mutation.
  guardWritePath(home)
  if (reset && existsSync(home)) {
    guardWritePath(home)
    rmSync(home, { recursive: true, force: true })
  }
  mkdirSync(home, { recursive: true })
  return {
    home,
    name,
    cleanup() {
      guardWritePath(home)
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// ── installPluginIntoProfile ───────────────────────────────────────────────

/** Read a package's declared bundle patch file (relative to the package dir). */
function readBundlePatchPath(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const patch = pkg?.dsh?.bundle?.patch
  if (typeof patch !== 'string') return null
  return join(pkgDir, patch)
}

/** First inserted row `name` in a bundle patch; used as the profile-installed path. */
function readBundleRowName(pkgDir) {
  const patchPath = readBundlePatchPath(pkgDir)
  if (patchPath === null || !existsSync(patchPath)) return null
  const match = /^\s*name:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(readFileSync(patchPath, 'utf8'))
  return match === null ? null : match[1]
}

/**
 * Copy a package directory into a profile's node_modules, skipping heavyweight,
 * dev-tool and sensitive entries. We copy (not symlink) so the profile is
 * self-contained and a later repo edit cannot bleed into a frozen home.
 *
 * The sensitive-path filter is name-only: it never reads a file to decide. It
 * refuses credentials/state/secrets even when they are untracked, so a local
 * `.env` or `state.json` can never enter a disposable profile payload.
 */
const COPY_SKIP_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.agents',
  '.claude',
  '.codex',
  '.opencode',
  'state',
  '.ssh',
  '.gnupg',
])
const COPY_SENSITIVE_NAMES = new Set([
  '.npmrc',
  '.yarnrc',
  '.pypirc',
  '.netrc',
  '.credentials',
  'credentials',
  'credentials.json',
  'state.json',
  'bootstrap-paircode.txt',
  'id_rsa',
  'id_ed25519',
])
const COPY_SENSITIVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx']

function isSensitivePackageName(name) {
  const lower = name.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (COPY_SENSITIVE_NAMES.has(lower)) return true
  return COPY_SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

function isBlockedPackagePath(rel) {
  const segments = rel.split(sep).filter((segment) => segment !== '')
  return segments.some((segment) => {
    const lower = segment.toLowerCase()
    return COPY_SKIP_SEGMENTS.has(lower) || isSensitivePackageName(lower)
  })
}

function copyPackageInto(destDir, srcDir) {
  guardWritePath(destDir)
  cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(srcDir, src)
      if (rel === '') return true
      return !isBlockedPackagePath(rel)
    },
  })
}

/**
 * Install the dsh-notifier plugin (this repo) into a profile using the host's
 * profile-bundle path.
 *
 * Layout produced under <home>/profiles/<profile>/:
 *   package.json        { dsh.profile.bundles: [...defaults, <bundle row name>] }
 *   cordis.yml          [] (empty root; the tree is composed from patches)
 *   cordis.patch.yml    [] (profile patch layer; caller may override)
 *   node_modules/<bundle row name>/ the plugin payload (copied from <pkgDir>)
 *
 * The bundle row name comes from the package's own bundle patch, so a scoped
 * package name (e.g. @scope/name) resolves without editing package.json.name.
 *
 * @param {object} o
 * @param {string} o.home            DSH_HOME (must be inside scratch)
 * @param {string} o.profile         profile name, e.g. "web" / "headless"
 * @param {string[]} o.bundles       base bundle names WITHOUT the plugin,
 *                                   e.g. ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]
 * @param {string} [o.repoRoot]      source repo (default REPO_ROOT)
 * @param {string} [o.linkMode]      "copy" (default) | "symlink"
 * @param {string} [o.cordisPatchYaml] contents for the profile cordis.patch.yml
 *                                     (default "[]\n")
 * @returns {{ profileDir, pluginDir, bundleRowName, packageJsonPath, patchPath }}
 */
export function installPluginIntoProfile({
  home,
  profile,
  bundles,
  repoRoot = REPO_ROOT,
  linkMode = 'copy',
  cordisPatchYaml = '[]\n',
}) {
  if (!home) throw new Error('installPluginIntoProfile: home is required')
  if (!profile) throw new Error('installPluginIntoProfile: profile is required')
  if (!Array.isArray(bundles) || bundles.length === 0) {
    throw new Error('installPluginIntoProfile: bundles must be a non-empty array')
  }
  guardWritePath(home)
  guardWritePath(join(home, 'profiles', profile))

  const bundleRowName = readBundleRowName(repoRoot)
  if (bundleRowName === null) {
    throw new Error(`expected a bundle patch row name in ${join(repoRoot, 'package.json')}`)
  }
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
    throw new Error('expected the repo package.json to declare a package name')
  }

  const profileDir = join(home, 'profiles', profile)
  const nmDir = join(profileDir, 'node_modules')
  const pluginDir = join(nmDir, ...bundleRowName.split('/'))
  mkdirSync(nmDir, { recursive: true })

  // Profile manifest — bundles = base bundles + our bundle row.
  const profilePkg = {
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles, bundleRowName] } },
  }
  guardWritePath(join(profileDir, 'package.json'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(profilePkg, null, 2) + '\n')

  // Root entry list (unused; the tree is composed from patch layers).
  guardWritePath(join(profileDir, 'cordis.yml'))
  writeFileSync(
    join(profileDir, 'cordis.yml'),
    '# dsh profile root — composed from bundle patches + cordis.patch.yml.\n[]\n',
  )

  // Profile patch layer.
  guardWritePath(join(profileDir, 'cordis.patch.yml'))
  writeFileSync(join(profileDir, 'cordis.patch.yml'), cordisPatchYaml)

  // Plugin payload into the profile's node_modules (bundle row path).
  if (linkMode === 'symlink') {
    guardWritePath(pluginDir)
    symlinkSync(resolve(repoRoot), pluginDir, 'dir')
  } else {
    copyPackageInto(pluginDir, resolve(repoRoot))
  }

  // Sanity: the copied payload must declare its bundle patch.
  const bp = readBundlePatchPath(pluginDir)
  if (!bp || !existsSync(bp)) {
    throw new Error(`installed plugin payload is missing its dsh.bundle.patch (${bp})`)
  }

  return {
    profileDir,
    pluginDir,
    bundleRowName,
    packageJsonPath: join(profileDir, 'package.json'),
    patchPath: join(profileDir, 'cordis.patch.yml'),
  }
}

/**
 * Copy a *separate* probe plugin package into a profile's node_modules and
 * append it to the profile bundle list.
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.profile
 * @param {string} o.probeDir   directory containing the probe package
 * @returns {{ pluginDir: string }}
 */
export function installProbeIntoProfile({ home, profile, probeDir }) {
  guardWritePath(join(home, 'profiles', profile))
  const probePkg = JSON.parse(readFileSync(join(probeDir, 'package.json'), 'utf8'))
  const probeName = probePkg.name
  const profileDir = join(home, 'profiles', profile)
  const profilePkgPath = join(profileDir, 'package.json')
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  if (!profilePkg.dsh.profile.bundles.includes(probeName)) {
    profilePkg.dsh.profile.bundles.push(probeName)
    guardWritePath(profilePkgPath)
    writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + '\n')
  }
  const pluginDir = join(profileDir, 'node_modules', probeName)
  copyPackageInto(pluginDir, probeDir)
  return { pluginDir }
}

// ── boot environment ───────────────────────────────────────────────────────

/**
 * Build a minimal, allowlisted env for a booted dsh child. We deliberately do
 * NOT forward the parent's full environment (no secrets leak). Only the OS
 * plumbing Electron/Node need, a harmless HOME pointer, and DSH_HOME are set.
 */
export function bootEnv(home) {
  const env = {
    DSH_HOME: home,
    // Deterministic, no-color, no proxy surprises.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // The Desktop CLI is ASAR-hosted; run its Electron binary as Node.
    ELECTRON_RUN_AS_NODE: '1',
  }
  const passthrough = process.platform === 'win32'
    ? ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    : ['PATH', 'HOME', 'TMPDIR', 'LANG']
  for (const key of passthrough) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return env
}

// ── process helpers ────────────────────────────────────────────────────────

/**
 * Kill a child and, on Windows, its whole tree. The Electron-as-node CLI may
 * have a short-lived wrapper process, so tree kill is the safe default.
 */
function killTree(child, { force = false } = {}) {
  if (child === null || child === undefined || child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  try {
    process.kill(force ? -child.pid : -child.pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    try { child.kill(force ? 'SIGKILL' : 'SIGTERM') } catch { /* already gone */ }
  }
}

/** One bounded, environment-isolated dsh invocation with guaranteed cleanup. */
function spawnDsh({ home, args, env = bootEnv(home) }) {
  guardWritePath(home)
  const child = spawn(DSH_NODE_EXECUTABLE, [DSH_CLI, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return child
}

// ── dumpConfig ─────────────────────────────────────────────────────────────

/**
 * Run `dsh --profile <profile> --dump-config` and return the composed tree.
 *
 * @returns {Promise<{ exitCode:number, stdout:string, stderr:string }>}
 */
export function dumpConfig({ home, profile, timeoutMs = 60000 }) {
  guardWritePath(home)
  return new Promise((resolveP) => {
    let child
    try {
      child = spawnDsh({ home, args: ['--profile', profile, '--dump-config'] })
    } catch (error) {
      resolveP({ exitCode: null, stdout: '', stderr: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => killTree(child, { force: true }), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolveP({ exitCode: null, stdout, stderr: stderr + String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveP({ exitCode: code, stdout, stderr })
    })
  })
}

// ── bootProfile ────────────────────────────────────────────────────────────

/**
 * Spawn the real dsh CLI against a disposable profile with a bounded timeout
 * and a guaranteed kill. Returns a handle whose `waitFor(pattern)` awaits a
 * regex/string match against the accumulated stdout+stderr, and whose
 * `result()` resolves once the process exits (or is killed).
 *
 * @param {object} o
 * @param {string} o.home
 * @param {string} o.profile
 * @param {string[]} [o.args]      app args after the profile
 * @param {number} [o.timeoutMs]   hard kill deadline (default 45000)
 * @param {object} [o.env]         extra env (merged over bootEnv)
 * @returns {Promise<{ pid:number, stdout:string, stderr:string,
 *                     exitCode:number|null, killed:boolean,
 *                     waitFor:(p:RegExp|string, ms?:number)=>Promise<string>,
 *                     output:()=>string, result:()=>Promise<object>,
 *                     stop:()=>Promise<void> }>}
 */
export function bootProfile({
  home,
  profile,
  args = [],
  timeoutMs = 45000,
  env = {},
}) {
  guardWritePath(home)
  return new Promise((resolveP, rejectP) => {
    let child
    try {
      child = spawnDsh({ home, args: ['--profile', profile, ...args], env: { ...bootEnv(home), ...env } })
    } catch (error) {
      rejectP(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let killedByUs = false
    let settled = false

    const output = () => stdout + stderr

    const hardTimer = setTimeout(() => {
      killedByUs = true
      killTree(child, { force: true })
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))

    const exitPromise = new Promise((res) => {
      child.on('close', (code, signal) => {
        clearTimeout(hardTimer)
        if (settled) return
        settled = true
        res({
          exitCode: code,
          signal: signal ?? null,
          killed: killedByUs,
          stdout,
          stderr,
        })
      })
      child.on('error', (err) => {
        clearTimeout(hardTimer)
        if (settled) return
        settled = true
        res({ exitCode: null, signal: null, killed: killedByUs, stdout, stderr, error: String(err) })
      })
    })

    function waitFor(pattern, ms = timeoutMs) {
      const re = pattern instanceof RegExp ? pattern : new RegExp(escapeRe(pattern))
      return new Promise((res, rej) => {
        const check = () => re.exec(output())
        const now = check()
        if (now) {
          res(now[0])
          return
        }
        let done = false
        const iv = setInterval(() => {
          if (done) return
          const m = check()
          if (m) {
            done = true
            clearInterval(iv)
            clearTimeout(t)
            res(m[0])
          }
        }, 50)
        const t = setTimeout(() => {
          if (done) return
          done = true
          clearInterval(iv)
          rej(new Error(`waitFor timed out after ${ms}ms waiting for ${re}`))
        }, ms)
      })
    }

    async function stop() {
      if (settled) return
      killedByUs = true
      killTree(child)
      // Give the close event a bounded window; then force the tree down.
      const handle = exitPromise
      const timedOut = await Promise.race([
        handle.then(() => false),
        new Promise((res) => setTimeout(() => res(true), 3000)),
      ])
      if (timedOut) killTree(child, { force: true })
      await exitPromise.catch(() => undefined)
    }

    resolveP({
      pid: child.pid,
      get stdout() {
        return stdout
      },
      get stderr() {
        return stderr
      },
      killed: () => killedByUs,
      waitFor,
      output,
      result: () => exitPromise,
      stop,
    })
  })
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── startLocalReceiver ─────────────────────────────────────────────────────

/**
 * A loopback HTTP server that records received requests.
 *
 * Behaviour modes:
 *   * default        — parse JSON body, reply 200 { ok:true }, record.
 *   * { slowMs }     — sleep before reading the body (stall the sender).
 *   * { stallBody }  — never end the response (hold the socket open).
 *   * { redirectTo } — reply 302 with a Location header.
 *
 * @param {object} [opts]
 * @param {number} [opts.slowMs=0]
 * @param {boolean} [opts.stallBody=false]
 * @param {string} [opts.redirectTo]  when set, every request 302-redirects here
 * @param {number} [opts.status=200]  success status for normal replies
 * @returns {Promise<object>} { port, url(path), requests, server, close() }
 */
export function startLocalReceiver(opts = {}) {
  const { slowMs = 0, stallBody = false, redirectTo, status = 200 } = opts
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    const record = (body) => {
      requests.push({
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body,
        at: new Date().toISOString(),
      })
    }

    req.on('data', (c) => chunks.push(c))
    req.on('error', () => {})

    const respond = () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsed = raw
      try {
        parsed = raw.length ? JSON.parse(raw) : null
      } catch {
        /* keep raw string */
      }
      record(parsed)

      if (redirectTo) {
        res.writeHead(302, { Location: redirectTo })
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }

    if (stallBody) {
      // Record the admission but never finish the response.
      record(null)
      return
    }
    if (slowMs > 0) {
      setTimeout(respond, slowMs)
    } else {
      respond()
    }
  })

  return new Promise((resolveP, rejectP) => {
    server.on('error', rejectP)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolveP({
        port,
        url: (path = '/') => `http://127.0.0.1:${port}${path}`,
        requests,
        server,
        close: () =>
          new Promise((res) => {
            server.close(() => res())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

// ── readPluginState ────────────────────────────────────────────────────────

/**
 * Read <dir>/state.json if present. NEVER writes. Returns null when absent.
 * @param {string} dir
 * @returns {object|null}
 */
export function readPluginState(dir) {
  const p = join(dir, 'state.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

// ── misc helpers ───────────────────────────────────────────────────────────

/** True when pnpm resolves on PATH. */
export function hasPnpm() {
  const separator = process.platform === 'win32' ? ';' : ':'
  return (process.env.PATH ?? '').split(separator).filter(Boolean).some((dir) => {
    for (const name of ['pnpm', 'pnpm.cmd', 'pnpm.exe']) {
      if (existsSync(join(dir, name))) return true
    }
    return false
  })
}

/** First path segment of the scratch root, for log display only. */
export function scratchLabel() {
  return basename(SCRATCH_ROOT)
}

export const constants = {
  REPO_ROOT,
  SCRATCH_ROOT,
  REAL_DSH_HOMES,
  DSH_INSTALL_DIR,
  DSH_CLI,
  DSH_NODE_EXECUTABLE,
}

export default {
  makeDisposableDshHome,
  installPluginIntoProfile,
  installProbeIntoProfile,
  dumpConfig,
  bootProfile,
  bootEnv,
  startLocalReceiver,
  readPluginState,
  assertInsideScratch,
  assertNotRealDshHome,
  hasPnpm,
  constants,
}
