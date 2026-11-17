#!/usr/bin/env node
// Release automation policy for the fork-published scoped package.
//
// The package is published from the fork `LeonhardtHUST/dsh-notifier` under the
// scope `@leonhardthust`. npm trusted publishing (OIDC) requires the workflow to
// run on GitHub-hosted runners, npm CLI >= 11.5.1 / Node >= 22.14, and
// `package.json#repository.url` to match the GitHub repository that triggers the
// publish. This module keeps those facts machine-checked instead of documented.

import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const PACKAGE_NAME = '@leonhardthust/dsh-notifier'
export const PACKAGE_SCOPE = '@leonhardthust'
export const FORK_REPOSITORY = 'LeonhardtHUST/dsh-notifier'
export const FORK_REPOSITORY_URL = 'https://github.com/LeonhardtHUST/dsh-notifier'
export const RELEASE_BRANCH = 'main'
export const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
export const MIN_NPM_VERSION = '11.5.1'
export const MIN_NODE_VERSION = '22.14.0'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const TOKEN_ENV_NAMES = ['npm_token', 'node_auth_token', 'npm_config__authtoken', 'npm_config__auth']

export const FORBIDDEN_PACK_DIRECTORIES = [
  '.agents',
  '.claude',
  '.codex',
  '.opencode',
  '.github',
  'examples',
  'node_modules',
  'state',
]
// Any path segment, not just the top directory. A stray `src/.credentials` or a
// nested `node_modules` would otherwise slip through the allowlist expansion.
export const FORBIDDEN_PACK_SEGMENTS = [
  '.agents',
  '.claude',
  '.codex',
  '.opencode',
  '.credentials',
  '.env',
  '.github',
  '.npmrc',
  'node_modules',
]
export const FORBIDDEN_PACK_FILES = [
  'HANDOFF.md',
  'ADAPTER.md',
  'package-lock.json',
  '.npmrc',
  'scripts/release-automation.mjs',
  'scripts/upstream-sync.mjs',
  'test/release-automation.test.mjs',
  'test/upstream-sync.test.mjs',
]
export const FORBIDDEN_PACK_PREFIXES = ['test/host/']
export const REQUIRED_PACK_FILES = [
  'package.json',
  'src/plugin-entry.mjs',
  'client.js',
  'cordis.patch.yml',
  'types/index.d.ts',
  'CHANGELOG.md',
  'README.md',
  'docs/guide.md',
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function readPackageJson(cwd = root) {
  return JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
}

export function isValidVersion(version) {
  return typeof version === 'string' && SEMVER.test(version)
}

export function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(version ?? ''))
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

// Stable semver comparison with numeric prerelease identifiers. Enough for the
// CLI version gates (npm / node); not a full range resolver.
export function compareSemver(left, right) {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) throw new Error(`invalid semver comparison: ${left} / ${right}`)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

export function normalizeRepositoryUrl(value) {
  let url = String(value ?? '').trim()
  if (!url) return ''
  url = url.replace(/^git\+/, '')
  url = url.replace(/^git@github\.com:/i, 'https://github.com/')
  url = url.replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
  url = url.replace(/\.git$/i, '')
  url = url.replace(/\/+$/, '')
  return url
}

export function repositoryFieldFailures(packageJson, expectedUrl = FORK_REPOSITORY_URL) {
  const actual = normalizeRepositoryUrl(packageJson?.repository?.url)
  if (actual === normalizeRepositoryUrl(expectedUrl)) return []
  return [
    `package.json repository.url must be ${expectedUrl} for npm provenance, found ${actual || '<missing>'}`,
  ]
}

export function validateTokenlessEnv(env = process.env) {
  const failures = []
  const lowered = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]))
  for (const name of TOKEN_ENV_NAMES) {
    const value = lowered.get(name)
    if (typeof value === 'string' && value.trim() !== '') {
      failures.push(`${name} must not be set: trusted publishing is tokenless`)
    }
  }
  return failures
}

export function validateReleaseContext({
  packageJson,
  branch,
  repository,
  npmVersion,
  nodeVersion,
  env = process.env,
}) {
  const failures = []
  if (packageJson?.name !== PACKAGE_NAME) {
    failures.push(`package.json name must be ${PACKAGE_NAME}, found ${packageJson?.name ?? '<missing>'}`)
  }
  const scope = typeof packageJson?.name === 'string' ? packageJson.name.split('/')[0] : ''
  if (scope !== PACKAGE_SCOPE) failures.push(`package name scope must be ${PACKAGE_SCOPE}, found ${scope || '<missing>'}`)
  if (!isValidVersion(packageJson?.version)) failures.push(`package.json version is invalid: ${packageJson?.version ?? '<missing>'}`)
  if (repository !== FORK_REPOSITORY) failures.push(`GITHUB_REPOSITORY must be ${FORK_REPOSITORY}, found ${repository || '<missing>'}`)
  if (branch !== RELEASE_BRANCH) failures.push(`releases must run from ${RELEASE_BRANCH}, found ${branch || '<missing>'}`)
  failures.push(...repositoryFieldFailures(packageJson))
  if (!npmVersion || !parseSemver(npmVersion)) {
    failures.push('npm CLI version could not be detected')
  } else if (compareSemver(npmVersion, MIN_NPM_VERSION) < 0) {
    failures.push(`npm CLI >= ${MIN_NPM_VERSION} is required for trusted publishing, found ${npmVersion}`)
  }
  if (!nodeVersion || !parseSemver(nodeVersion)) {
    failures.push('Node.js version could not be detected')
  } else if (compareSemver(nodeVersion, MIN_NODE_VERSION) < 0) {
    failures.push(`Node.js >= ${MIN_NODE_VERSION} is required for npm trusted publishing, found ${nodeVersion}`)
  }
  failures.push(...validateTokenlessEnv(env))
  return { ok: failures.length === 0, failures }
}

export function registryVersionUrl(name, version) {
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
}

export function registryPackumentUrl(name) {
  return `${REGISTRY_ORIGIN}/${encodeURIComponent(name)}`
}

function responseStatus(response) {
  return Number(response?.status ?? 0)
}

async function readJsonBody(response) {
  if (typeof response?.json === 'function') return response.json()
  if (typeof response?.text === 'function') {
    const text = await response.text()
    return text === '' ? null : JSON.parse(text)
  }
  return null
}

// Returns { exists, version }. A 404 is the normal pre-release answer for a new
// package/version; every other failure is surfaced instead of being mistaken
// for "unpublished".
export async function fetchRegistryVersion({
  name = PACKAGE_NAME,
  version,
  fetchImpl = globalThis.fetch,
  attempts = 1,
  delayMs = 0,
  sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
} = {}) {
  if (!version) throw new Error('version is required')
  const url = registryVersionUrl(name, version)
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const init = { headers: { accept: 'application/json' } }
      if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(15000)
      const response = await fetchImpl(url, init)
      const status = responseStatus(response)
      if (status === 404) {
        // A 404 is the expected pre-release answer. With retries enabled (the
        // post-publish check) keep polling until the registry exposes it.
        if (attempt === attempts) return { exists: false, version, url }
        lastError = new Error(`${name}@${version} is not visible on the registry yet`)
      } else if (response?.ok !== true || status < 200 || status >= 300) {
        lastError = new Error(`registry check failed for ${name}@${version}: HTTP ${status}`)
      } else {
        const body = await readJsonBody(response)
        if (body && typeof body.version === 'string' && body.version !== version) {
          throw new Error(`registry returned version ${body.version} for ${name}@${version}`)
        }
        return { exists: true, version, url }
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
    if (attempt < attempts && delayMs > 0) await sleep(delayMs)
  }
  throw lastError ?? new Error(`registry check failed for ${name}@${version}`)
}

export async function fetchRegistryLatest({
  name = PACKAGE_NAME,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = registryPackumentUrl(name)
  const init = { headers: { accept: 'application/vnd.npm.install-v1+json, application/json' } }
  if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(15000)
  const response = await fetchImpl(url, init)
  const status = responseStatus(response)
  if (status === 404) return null
  if (response?.ok !== true || status < 200 || status >= 300) {
    throw new Error(`registry latest check failed for ${name}: HTTP ${status}`)
  }
  const body = await readJsonBody(response)
  return typeof body?.['dist-tags']?.latest === 'string' ? body['dist-tags'].latest : null
}

// Release plan is derived from published state, never from a local flag, so a
// rerun of the same commit is idempotent and a manual recovery cannot duplicate
// a version. An existing tag is never moved.
export function planRelease({ version, exists, tagCommit, tagIsAncestor = false, headCommit }) {
  if (!isValidVersion(version)) throw new Error(`invalid release version: ${version}`)
  if (!headCommit) throw new Error('head commit is required')
  const head = String(headCommit).trim().toLowerCase()
  const tag = tagCommit ? String(tagCommit).trim().toLowerCase() : ''
  const tagName = `v${version}`
  const tagMatchesHead = tag !== '' && tag === head
  const tagBehindHead = tag !== '' && !tagMatchesHead && tagIsAncestor === true
  if (tag !== '' && !tagMatchesHead && !tagBehindHead) {
    return {
      action: 'conflict',
      shouldRelease: true,
      tagName,
      reason: `tag ${tagName} points at ${tag.slice(0, 12)}, which is not on the release history of ${head.slice(0, 12)}; never retag a published version`,
    }
  }
  if (exists === true) {
    if (tagMatchesHead || tagBehindHead) {
      return {
        action: 'already-released',
        shouldRelease: false,
        tagName,
        reason: tagBehindHead
          ? `${version} is already on npm and tagged behind ${head.slice(0, 12)}; only metadata/docs changed since the release`
          : `${version} is already on npm and tagged at ${head.slice(0, 12)}`,
      }
    }
    return { action: 'tag-only', shouldRelease: true, tagName, reason: `${version} is already on npm but ${tagName} is missing; create the tag without republishing` }
  }
  if (tagMatchesHead || tag === '') {
    return {
      action: 'publish',
      shouldRelease: true,
      tagName,
      reason: tagMatchesHead
        ? `${version} is not on npm yet; tag ${tagName} already points at the release commit`
        : `${version} is not on npm yet; create ${tagName} and publish`,
    }
  }
  // Unpublished version whose tag sits on an older commit: publishing HEAD
  // would put different contents behind an existing tag, so stop for a human.
  return {
    action: 'conflict',
    shouldRelease: true,
    tagName,
    reason: `tag ${tagName} points at ${tag.slice(0, 12)} but ${version} is unpublished; publish from the tagged commit or resolve the tag before releasing ${head.slice(0, 12)}`,
  }
}

export function normalizePackPath(value) {
  return String(value ?? '').replace(/^\.\//, '').replace(/^package\//, '').replace(/\\/g, '/')
}

export function validatePackPayload(manifest, { name = PACKAGE_NAME, version } = {}) {
  const failures = []
  const entries = Array.isArray(manifest) ? manifest : [manifest]
  const tarball = entries.find((entry) => entry && Array.isArray(entry.files))
  if (!tarball) return { ok: false, failures: ['npm pack manifest has no files array'], files: [] }
  if (tarball.name && tarball.name !== name) failures.push(`packed name is ${tarball.name}, expected ${name}`)
  if (version && tarball.version && tarball.version !== version) {
    failures.push(`packed version is ${tarball.version}, expected ${version}`)
  }
  const files = tarball.files.map((file) => normalizePackPath(file?.path)).filter(Boolean)
  if (files.length === 0) failures.push('npm payload is empty')
  for (const file of files) {
    if (file.startsWith('/') || file.includes('..') || file.includes('\\')) {
      failures.push(`npm payload path is unsafe: ${file}`)
      continue
    }
    const top = file.split('/')[0]
    if (FORBIDDEN_PACK_DIRECTORIES.includes(top) && (file === top || file.startsWith(`${top}/`))) {
      failures.push(`npm payload must not include ${top}/ (${file})`)
    }
    const offendingSegment = file.split('/').find((segment) => (
      FORBIDDEN_PACK_SEGMENTS.includes(segment)
      || segment.startsWith('.env.')
    ))
    if (offendingSegment) failures.push(`npm payload must not include ${offendingSegment} (${file})`)
    if (file.endsWith('.npmrc') || file.endsWith('.env') || file.endsWith('.credentials')) {
      failures.push(`npm payload must not include credentials/environment file ${file}`)
    }
    if (FORBIDDEN_PACK_FILES.includes(file)) failures.push(`npm payload must not include ${file}`)
    if (FORBIDDEN_PACK_PREFIXES.some((prefix) => file.startsWith(prefix))) {
      failures.push(`npm payload must not include host harness files (${file})`)
    }
  }
  for (const required of REQUIRED_PACK_FILES) {
    if (!files.includes(required)) failures.push(`npm payload is missing ${required}`)
  }
  return { ok: failures.length === 0, failures, files }
}

export function appendGithubOutputs(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return false
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '').replace(/\r?\n/g, ' ')}`)
  appendFileSync(outputPath, `${lines.join('\n')}\n`)
  return true
}

function readNpmVersion() {
  try {
    // npm is a .cmd shim on Windows; Node refuses to spawn .cmd files without a
    // shell, so use a fixed, non-interpolated shell command there.
    const output = process.platform === 'win32'
      ? execSync('npm --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : execFileSync('npm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return output.trim()
  } catch {
    const match = /npm\/(\d+\.\d+\.\d+)/.exec(process.env.npm_config_user_agent ?? '')
    return match?.[1] ?? ''
  }
}

function releaseContextFromEnv(packageJson, env = process.env) {
  return {
    packageJson,
    branch: env.GITHUB_REF_NAME,
    repository: env.GITHUB_REPOSITORY,
    npmVersion: readNpmVersion(),
    nodeVersion: process.version.replace(/^v/, ''),
    env,
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, argument] = argv
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: node scripts/release-automation.mjs <guard|version|registry-check|pack-check|plan> [args]')
    return 0
  }

  if (command === 'guard') {
    const packageJson = readPackageJson()
    const result = validateReleaseContext(releaseContextFromEnv(packageJson))
    if (!result.ok) {
      console.error('release guard failed:')
      for (const failure of result.failures) console.error(`- ${failure}`)
      return 1
    }
    console.log(`release guard ok: ${packageJson.name}@${packageJson.version} from ${process.env.GITHUB_REPOSITORY}@${process.env.GITHUB_REF_NAME}`)
    return 0
  }

  if (command === 'version') {
    const packageJson = readPackageJson()
    if (!isValidVersion(packageJson.version)) {
      console.error(`package.json version is invalid: ${packageJson.version ?? '<missing>'}`)
      return 1
    }
    appendGithubOutputs({ version: packageJson.version, tag_name: `v${packageJson.version}` })
    console.log(packageJson.version)
    return 0
  }

  if (command === 'registry-check') {
    const packageJson = readPackageJson()
    if (!isValidVersion(packageJson.version)) {
      console.error(`package.json version is invalid: ${packageJson.version ?? '<missing>'}`)
      return 1
    }
    const requireExists = argv.includes('--require-exists')
    const attempts = requireExists ? 6 : 1
    const state = await fetchRegistryVersion({
      name: packageJson.name,
      version: packageJson.version,
      attempts,
      delayMs: requireExists ? 5000 : 0,
    })
    const latest = await fetchRegistryLatest({ name: packageJson.name })
    appendGithubOutputs({ exists: String(state.exists), latest: latest ?? '' })
    console.log(`registry ${packageJson.name}@${packageJson.version}: ${state.exists ? 'published' : 'not published'}${latest ? ` (latest ${latest})` : ''}`)
    if (requireExists && !state.exists) {
      console.error(`published version ${packageJson.version} did not appear on the registry`)
      return 1
    }
    return 0
  }

  if (command === 'pack-check') {
    if (!argument) {
      console.error('pack-check requires the npm pack --json output path')
      return 2
    }
    const packageJson = readPackageJson()
    let manifest
    try {
      manifest = JSON.parse(readFileSync(resolve(argument), 'utf8'))
    } catch (error) {
      console.error(`cannot read npm pack manifest: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    const result = validatePackPayload(manifest, { name: packageJson.name, version: packageJson.version })
    if (!result.ok) {
      console.error('npm payload guard failed:')
      for (const failure of result.failures) console.error(`- ${failure}`)
      return 1
    }
    console.log(`npm payload guard ok: ${result.files.length} files, no dev/tool directories`)
    return 0
  }

  if (command === 'plan') {
    const env = process.env
    const packageJson = readPackageJson()
    let plan
    try {
      plan = planRelease({
        version: env.VERSION ?? packageJson.version,
        exists: env.VERSION_EXISTS === 'true',
        tagCommit: env.TAG_COMMIT ?? '',
        tagIsAncestor: env.TAG_IS_ANCESTOR === 'true',
        headCommit: env.HEAD_COMMIT,
      })
    } catch (error) {
      console.error(`cannot plan release: ${error instanceof Error ? error.message : String(error)}`)
      return 1
    }
    appendGithubOutputs({
      action: plan.action,
      should_release: String(plan.shouldRelease),
      tag_name: plan.tagName,
      reason: plan.reason,
    })
    console.log(`release plan: ${plan.action} (${plan.reason})`)
    return plan.action === 'conflict' ? 1 : 0
  }

  console.error(`unknown command: ${command}`)
  return 2
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
