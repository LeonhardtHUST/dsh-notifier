import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FORK_REPOSITORY,
  FORK_REPOSITORY_URL,
  MIN_NPM_VERSION,
  PACKAGE_NAME,
  appendGithubOutputs,
  compareSemver,
  fetchRegistryVersion,
  isValidVersion,
  normalizePackPath,
  normalizeRepositoryUrl,
  planRelease,
  repositoryFieldFailures,
  validatePackPayload,
  validateReleaseContext,
  validateTokenlessEnv,
} from '../scripts/release-automation.mjs'

const scopedPackage = (overrides = {}) => ({
  name: PACKAGE_NAME,
  version: '0.14.1',
  repository: { type: 'git', url: FORK_REPOSITORY_URL },
  ...overrides,
})

const context = (overrides = {}) => ({
  packageJson: scopedPackage(),
  branch: 'main',
  repository: FORK_REPOSITORY,
  npmVersion: '11.20.0',
  nodeVersion: '24.4.1',
  env: {},
  ...overrides,
})

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
  json: async () => body,
})

// A plausible `npm pack --dry-run --json` result, reduced to the fields the
// guard reads. Keep this fixture independent from the real package.json so the
// test does not depend on whichever version/name is being released.
const packFixture = (overrides = {}) => ([{
  id: `${PACKAGE_NAME}@0.14.1`,
  name: PACKAGE_NAME,
  version: '0.14.1',
  files: [
    'package.json',
    'src/plugin-entry.mjs',
    'src/index.mjs',
    'test/scoped-package.test.mjs',
    'client.js',
    'cordis.patch.yml',
    'types/index.d.ts',
    'CHANGELOG.md',
    'README.md',
    'docs/guide.md',
  ].map((path) => ({ path, size: 1, mode: 420 })),
  ...overrides,
}])

test('release context accepts the scoped fork package on main', () => {
  const result = validateReleaseContext(context())
  assert.equal(result.ok, true, result.failures.join('\n'))
})

test('release context rejects wrong scope, repository, branch, and tool versions', () => {
  const cases = [
    [{ packageJson: scopedPackage({ name: 'dsh-notifier' }) }, 'name'],
    [{ packageJson: scopedPackage({ name: '@someone/dsh-notifier' }) }, 'scope'],
    [{ packageJson: scopedPackage({ version: 'next' }) }, 'version'],
    [{ repository: 'THEWOLFWALKER/dsh-notifier' }, 'GITHUB_REPOSITORY'],
    [{ branch: 'dev' }, 'main'],
    [{ npmVersion: '10.9.2' }, `npm CLI >= ${MIN_NPM_VERSION}`],
    [{ npmVersion: '' }, 'npm CLI version'],
    [{ nodeVersion: '22.13.0' }, 'Node.js >='],
    [{ packageJson: scopedPackage({ repository: { type: 'git', url: 'https://github.com/THEWOLFWALKER/dsh-notifier.git' } }) }, 'repository.url'],
    [{ packageJson: scopedPackage({ repository: undefined }) }, 'repository.url'],
  ]
  for (const [overrides, marker] of cases) {
    const result = validateReleaseContext(context(overrides))
    assert.equal(result.ok, false, `expected failure for ${marker}`)
    assert.ok(result.failures.some((failure) => failure.includes(marker)), `${marker}: ${result.failures.join('; ')}`)
  }
})

test('tokenless guard rejects npm token environment variables but allows empty values', () => {
  assert.deepEqual(validateTokenlessEnv({ NPM_TOKEN: 'secret', NODE_AUTH_TOKEN: '' }), ['npm_token must not be set: trusted publishing is tokenless'])
  assert.deepEqual(validateTokenlessEnv({ node_auth_token: 'secret' }), ['node_auth_token must not be set: trusted publishing is tokenless'])
  assert.deepEqual(validateTokenlessEnv({ NPM_CONFIG__AUTHTOKEN: 'secret' }), ['npm_config__authtoken must not be set: trusted publishing is tokenless'])
  assert.deepEqual(validateTokenlessEnv({ GITHUB_TOKEN: 'allowed', PATH: 'x' }), [])
})

test('repository URL normalization accepts git/ssh spellings of the fork', () => {
  const expected = FORK_REPOSITORY_URL
  for (const url of [
    expected,
    `${expected}.git`,
    `git+${expected}.git`,
    'git@github.com:LeonhardtHUST/dsh-notifier.git',
    'ssh://git@github.com/LeonhardtHUST/dsh-notifier.git',
    `${expected}/`,
  ]) {
    assert.equal(normalizeRepositoryUrl(url), expected, url)
  }
  assert.deepEqual(repositoryFieldFailures(scopedPackage()), [])
  assert.equal(repositoryFieldFailures(scopedPackage({ repository: {} })).length, 1)
})

test('semver comparison orders stable releases after prereleases', () => {
  assert.equal(compareSemver('11.20.0', '11.5.1'), 1)
  assert.equal(compareSemver('11.5.1', '11.5.1'), 0)
  assert.equal(compareSemver('11.5.1', '12.0.0'), -1)
  assert.equal(compareSemver('0.14.0-rc.1', '0.14.0'), -1)
  assert.equal(compareSemver('0.14.0-rc.2', '0.14.0-rc.1'), 1)
  assert.equal(isValidVersion('0.14.0-rc.1'), true)
  assert.equal(isValidVersion('v0.14.0'), false)
})

test('release plan is derived from registry and tag state', () => {
  const publish = planRelease({ version: '0.14.1', exists: false, tagCommit: '', headCommit: 'abc123' })
  assert.equal(publish.action, 'publish')
  assert.equal(publish.shouldRelease, true)
  assert.equal(publish.tagName, 'v0.14.1')

  const publishTagged = planRelease({ version: '0.14.1', exists: false, tagCommit: 'ABC123', headCommit: 'abc123' })
  assert.equal(publishTagged.action, 'publish')

  const tagOnly = planRelease({ version: '0.14.1', exists: true, tagCommit: '', headCommit: 'abc123' })
  assert.equal(tagOnly.action, 'tag-only')
  assert.equal(tagOnly.shouldRelease, true)

  const already = planRelease({ version: '0.14.1', exists: true, tagCommit: 'abc123', headCommit: 'abc123' })
  assert.equal(already.action, 'already-released')
  assert.equal(already.shouldRelease, false)

  const conflict = planRelease({ version: '0.14.1', exists: true, tagCommit: 'deadbeef', headCommit: 'abc123' })
  assert.equal(conflict.action, 'conflict')
  assert.equal(conflict.shouldRelease, true)
  assert.match(conflict.reason, /never retag/)

  const unpublishedTagConflict = planRelease({ version: '0.14.1', exists: false, tagCommit: 'deadbeef', headCommit: 'abc123' })
  assert.equal(unpublishedTagConflict.action, 'conflict')

  // Metadata-only commits after a release must not republish or fail red.
  const metadataOnly = planRelease({ version: '0.14.1', exists: true, tagCommit: 'abc123', tagIsAncestor: true, headCommit: 'def456' })
  assert.equal(metadataOnly.action, 'already-released')
  assert.equal(metadataOnly.shouldRelease, false)
  assert.match(metadataOnly.reason, /metadata\/docs changed/)

  const unpublishedBehind = planRelease({ version: '0.14.1', exists: false, tagCommit: 'abc123', tagIsAncestor: true, headCommit: 'def456' })
  assert.equal(unpublishedBehind.action, 'conflict')
  assert.match(unpublishedBehind.reason, /publish from the tagged commit/)

  assert.throws(() => planRelease({ version: 'v0.14.1', exists: false, tagCommit: '', headCommit: 'abc123' }), /invalid release version/)
  assert.throws(() => planRelease({ version: '0.14.1', exists: false, tagCommit: '', headCommit: '' }), /head commit/)
})

test('pack payload guard rejects dev/tool directories and missing entrypoints', () => {
  const ok = validatePackPayload(packFixture(), { name: PACKAGE_NAME, version: '0.14.1' })
  assert.equal(ok.ok, true, ok.failures.join('\n'))

  const withForbidden = packFixture()
  withForbidden[0].files.push(
    { path: '.agents/workstreams/rc3-automation.md' },
    { path: '.github/workflows/release.yml' },
    { path: 'HANDOFF.md' },
    { path: 'examples/demo.mjs' },
    { path: 'package-lock.json' },
    { path: 'scripts/release-automation.mjs' },
    { path: 'test/release-automation.test.mjs' },
    { path: 'test/upstream-sync.test.mjs' },
    { path: 'test/host/harness.mjs' },
  )
  const forbidden = validatePackPayload(withForbidden, { name: PACKAGE_NAME, version: '0.14.1' })
  assert.equal(forbidden.ok, false)
  for (const marker of ['.agents', '.github', 'HANDOFF.md', 'examples', 'package-lock.json', 'scripts/release-automation.mjs', 'test/release-automation.test.mjs', 'test/upstream-sync.test.mjs', 'test/host/']) {
    assert.ok(forbidden.failures.some((failure) => failure.includes(marker)), `${marker}: ${forbidden.failures.join('; ')}`)
  }

  const missing = packFixture()
  missing[0].files = missing[0].files.filter((file) => file.path !== 'client.js')
  const missingResult = validatePackPayload(missing, { name: PACKAGE_NAME, version: '0.14.1' })
  assert.equal(missingResult.ok, false)
  assert.ok(missingResult.failures.some((failure) => failure.includes('client.js')))

  const unsafe = packFixture()
  unsafe[0].files.push({ path: '../escape.txt' })
  assert.equal(validatePackPayload(unsafe, { name: PACKAGE_NAME, version: '0.14.1' }).ok, false)

  const mismatched = validatePackPayload(packFixture(), { name: PACKAGE_NAME, version: '0.14.2' })
  assert.equal(mismatched.ok, false)
  assert.ok(mismatched.failures.some((failure) => failure.includes('packed version')))

  const nested = packFixture()
  nested[0].files.push(
    { path: 'src/.credentials' },
    { path: 'src/.env' },
    { path: 'docs/.env.local' },
    { path: 'foo/node_modules/left-pad/index.js' },
    { path: 'src/.agents/notes.md' },
    { path: 'lib/.npmrc' },
  )
  const nestedResult = validatePackPayload(nested, { name: PACKAGE_NAME, version: '0.14.1' })
  assert.equal(nestedResult.ok, false)
  for (const marker of ['.credentials', '.env', 'node_modules', '.agents', '.npmrc']) {
    assert.ok(nestedResult.failures.some((failure) => failure.includes(marker)), `${marker}: ${nestedResult.failures.join('; ')}`)
  }

  assert.equal(normalizePackPath('./package.json'), 'package.json')
  assert.equal(normalizePackPath('package/src/index.mjs'), 'src/index.mjs')
})

test('release workflow stays tokenless and does not reintroduce registry-url', () => {
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.equal(release.includes('registry-url'), false, 'setup-node registry-url injects a NODE_AUTH_TOKEN placeholder')
  assert.equal(/\bsecrets\.(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/.test(release), false, 'release workflow must not read npm token secrets')
  assert.equal(/\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\s*:/.test(release), false, 'release workflow must not set npm token environment variables')
  assert.match(release, /id-token:\s*write/)
  assert.match(release, /environment:\s*npm-release/)
  assert.match(release, /npm publish --access public --ignore-scripts/)
  assert.match(release, /DSH_HOME:\s*\$\{\{\s*github\.workspace\s*\}\}\/\.dsh-ci-home/)

  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /workflow_dispatch:/, 'the sync job dispatches read-only CI explicitly')
  assert.match(ci, /permissions:\s*\n\s*contents:\s*read/)

  const sync = readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8')
  assert.equal(sync.includes('pull_request_target'), false)
  assert.match(sync, /actions:\s*write/)
  assert.match(sync, /workflow_dispatch/)
  assert.match(sync, /head_repository\.full_name/)
  assert.match(sync, /head_branch == 'automation\/upstream-sync'/)
})

test('registry fetch treats 404 as unpublished and other failures as errors', async () => {
  const missing = await fetchRegistryVersion({
    version: '0.14.1',
    fetchImpl: async (url) => {
      assert.match(url, /registry\.npmjs\.org\/%40leonhardthust%2Fdsh-notifier\/0\.14\.1/)
      return response(404)
    },
  })
  assert.deepEqual(missing, {
    exists: false,
    version: '0.14.1',
    url: 'https://registry.npmjs.org/%40leonhardthust%2Fdsh-notifier/0.14.1',
  })

  const published = await fetchRegistryVersion({
    version: '0.14.1',
    fetchImpl: async () => response(200, { name: PACKAGE_NAME, version: '0.14.1' }),
  })
  assert.equal(published.exists, true)

  await assert.rejects(
    fetchRegistryVersion({ version: '0.14.1', fetchImpl: async () => response(500) }),
    /HTTP 500/,
  )
  await assert.rejects(
    fetchRegistryVersion({ version: '0.14.1', fetchImpl: async () => response(200, { version: '9.9.9' }) }),
    /returned version 9\.9\.9/,
  )
})

test('registry fetch retries until a published version is visible', async () => {
  let calls = 0
  const sleeps = []
  const result = await fetchRegistryVersion({
    version: '0.14.1',
    attempts: 3,
    delayMs: 5,
    sleep: async (ms) => { sleeps.push(ms) },
    fetchImpl: async () => {
      calls += 1
      return calls < 3 ? response(404) : response(200, { version: '0.14.1' })
    },
  })
  assert.equal(result.exists, true)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [5, 5])
})

test('GitHub outputs are appended without breaking multiline values', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-output-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'output')
  appendGithubOutputs({ action: 'publish', reason: 'line one\nline two' }, file)
  appendGithubOutputs({ should_release: 'true' }, file)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(lines, ['action=publish', 'reason=line one line two', 'should_release=true'])
  assert.equal(appendGithubOutputs({ ignored: 'x' }, null), false)
})

test('pack guard fixture follows the repo pack JSON shape', (t) => {
  // Guards the fixture itself: npm pack --json emits an array of tarballs with
  // a `files` array; a future npm output change should fail here first.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-pack-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'pack.json')
  writeFileSync(file, JSON.stringify(packFixture()))
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Array.isArray(parsed), true)
  assert.equal(Array.isArray(parsed[0].files), true)
})
