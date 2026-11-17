import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  FORK_PACKAGE_FILES,
  FORK_PACKAGE_NAME,
  FORK_PACKAGE_REGISTRY,
  FORK_PACKAGE_REPOSITORY_URL,
  FORK_REPOSITORY,
  ISSUE_KINDS,
  ISSUE_TITLE,
  ISSUE_MARKER,
  PR_MARKER,
  PROTECTED_PATHS,
  SYNC_BRANCH,
  SYNC_BOT_EMAIL,
  SYNC_BOT_NAME,
  UPSTREAM_REPOSITORY,
  UpstreamSyncError,
  applyForkOverrides,
  assertSyncWorkspace,
  buildIssueBody,
  buildPullRequestBody,
  buildPushArgs,
  createGithubClient,
  failureIssueKind,
  isProtectedPath,
  mergeUpstream,
  neutralizeMentions,
  notifyCiFailure,
  redactUrlCredentials,
  syncAlertKind,
  validateSyncContext,
} from '../scripts/upstream-sync.mjs'

function git(cwd, args, { allowFailure = false, identity = false } = {}) {
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(cwd, '.git', 'testconfig'),
  }
  delete env.GIT_AUTHOR_NAME
  delete env.GIT_AUTHOR_EMAIL
  delete env.GIT_COMMITTER_NAME
  delete env.GIT_COMMITTER_EMAIL
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  delete env.GIT_INDEX_FILE
  // Fixture setup only. Production merge/commit identity is injected by the
  // script under test; this flag is never used by the merge assertions.
  const identityArgs = identity ? ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com'] : []
  try {
    const stdout = execFileSync('git', [
      ...identityArgs,
      '-c', 'commit.gpgsign=false',
      '-c', 'core.autocrlf=false',
      ...args,
    ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env })
    return { status: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    if (allowFailure) {
      return { status: typeof error?.status === 'number' ? error.status : 1, stdout: String(error?.stdout ?? ''), stderr: String(error?.stderr ?? '') }
    }
    throw new Error(`git ${args.join(' ')} failed: ${String(error?.stderr ?? error?.message ?? '')}`)
  }
}

function write(cwd, file, content) {
  const target = join(cwd, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function commitAll(cwd, message) {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-m', message], { identity: true })
}

function tempRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-sync-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  git(dir, ['init', '-b', 'main'])
  writeFileSync(join(dir, '.git', 'testconfig'), '')
  return dir
}

const basePackageJson = (overrides = {}) => JSON.stringify({
  name: 'dsh-notifier',
  version: '0.13.1',
  description: 'base',
  repository: { type: 'git', url: `https://github.com/${UPSTREAM_REPOSITORY}.git` },
  files: ['src', 'client.js'],
  ...overrides,
}, null, 2)

function seedForkRepo(t) {
  const cwd = tempRepo(t)
  write(cwd, 'package.json', basePackageJson())
  write(cwd, 'src/a.mjs', 'export const a = 1\n')
  write(cwd, 'src/fork-base.mjs', 'export const base = 1\n')
  write(cwd, '.github/workflows/ci.yml', 'name: CI-base\n')
  write(cwd, 'scripts/release-automation.mjs', '// base\n')
  commitAll(cwd, 'base')

  git(cwd, ['checkout', '-b', 'dev'])
  write(cwd, 'package.json', basePackageJson({ name: FORK_PACKAGE_NAME, description: 'fork' }))
  write(cwd, 'package.json', basePackageJson({ name: FORK_PACKAGE_NAME, description: 'fork', repository: { type: 'git', url: FORK_PACKAGE_REPOSITORY_URL } }))
  write(cwd, '.github/workflows/ci.yml', 'name: CI-fork\n')
  write(cwd, '.github/workflows/release.yml', 'name: Release-fork\n')
  write(cwd, 'scripts/release-automation.mjs', '// fork\n')
  write(cwd, 'src/fork.mjs', 'export const fork = true\n')
  commitAll(cwd, 'fork')

  git(cwd, ['checkout', '-b', 'upstream-dev', 'main'])
  write(cwd, 'package.json', basePackageJson({ version: '0.14.1', description: 'upstream' }))
  write(cwd, 'src/upstream.mjs', 'export const upstream = true\n')
  write(cwd, '.github/workflows/ci.yml', 'name: CI-upstream\n')
  write(cwd, '.github/workflows/upstream-added.yml', 'name: Upstream-added\n')
  write(cwd, 'scripts/release-automation.mjs', '// upstream\n')
  commitAll(cwd, 'upstream')
  git(cwd, ['checkout', 'dev'])
  return cwd
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  }
}

test('sync context is pinned to the fork, upstream, and dev', () => {
  assert.deepEqual(validateSyncContext({ repository: FORK_REPOSITORY, upstreamRepository: UPSTREAM_REPOSITORY, targetBranch: 'dev' }), [])
  const failures = validateSyncContext({ repository: 'someone/else', upstreamRepository: 'evil/repo', targetBranch: 'main' })
  assert.equal(failures.length, 3)
  assert.ok(failures.some((failure) => failure.includes(FORK_REPOSITORY)))
  assert.ok(failures.some((failure) => failure.includes(UPSTREAM_REPOSITORY)))
  assert.ok(failures.some((failure) => failure.includes('dev')))
})

test('protected paths cover fork workflows, automation, and the package manifest', () => {
  for (const path of PROTECTED_PATHS) assert.equal(isProtectedPath(path), true, path)
  assert.equal(isProtectedPath('.github/workflows/release.yml'), true)
  assert.equal(isProtectedPath('package.json'), true)
  for (const path of ['client.js', 'cordis.patch.yml', 'test/.npmignore']) assert.equal(isProtectedPath(path), true, path)
  assert.equal(isProtectedPath('src/index.mjs'), false)
  assert.equal(isProtectedPath('docs/FORK_RELEASE.md.bak'), false)
})

test('fork overrides keep upstream version/metadata and re-pin identity', () => {
  const input = JSON.stringify({
    name: 'dsh-notifier',
    version: '0.14.1',
    repository: { type: 'git', url: `https://github.com/${UPSTREAM_REPOSITORY}.git`, directory: 'sub' },
    publishConfig: { access: 'restricted' },
    files: ['src'],
  }, null, 2)
  const output = JSON.parse(applyForkOverrides(input))
  assert.equal(output.name, FORK_PACKAGE_NAME)
  assert.equal(output.version, '0.14.1')
  assert.equal(output.repository.url, FORK_PACKAGE_REPOSITORY_URL)
  assert.equal(output.repository.directory, 'sub')
  assert.equal(output.publishConfig.access, 'public')
  assert.equal(output.publishConfig.registry, FORK_PACKAGE_REGISTRY)
  assert.deepEqual(output.files, ['src', ...FORK_PACKAGE_FILES])
})

test('sync alert policy never treats main divergence as healthy', () => {
  assert.equal(syncAlertKind({ checksState: 'failure', upstreamMainAhead: true }), 'ci-failure')
  assert.equal(syncAlertKind({ checksState: 'success', upstreamMainAhead: true }), 'main-divergence')
  assert.equal(syncAlertKind({ checksState: 'none', upstreamMainAhead: true }), 'main-divergence')
  assert.equal(syncAlertKind({ checksState: 'success', upstreamMainAhead: false }), null)
  assert.equal(failureIssueKind(new UpstreamSyncError('conflict', 'x')), 'conflict')
  assert.equal(failureIssueKind(new UpstreamSyncError('git', 'x')), 'sync-failure')
  assert.match(ISSUE_KINDS['main-divergence'], /main has commits/)
})

test('untrusted text cannot mention third parties', () => {
  assert.equal(neutralizeMentions('@octocat please look'), '@\u200Boctocat please look')
  assert.equal(neutralizeMentions('a\u0000b\u0007c'), 'abc')
  assert.equal(neutralizeMentions('x'.repeat(50), { maxLength: 10 }), `${'x'.repeat(9)}…`)
  const issue = buildIssueBody({ kind: 'conflict', detail: '@evil inject' })
  assert.ok(issue.includes(ISSUE_MARKER))
  assert.ok(issue.includes('@LeonhardtHUST'))
  assert.equal(issue.includes('@evil'), false)
  assert.match(issue, /GitHub only/)
  const pr = buildPullRequestBody({ upstreamSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), commits: ['abc @evil commit'], changedFiles: ['src/x.mjs'] })
  assert.ok(pr.includes(PR_MARKER))
  assert.equal(pr.includes('@evil'), false)
  assert.match(pr, /read-only CI/)
  assert.match(pr, /client\.js/)
  assert.match(pr, /port upstream changes to them by hand/)
})

test('a clean upstream merge restores fork-owned paths and keeps upstream source', (t) => {
  const cwd = seedForkRepo(t)
  const result = mergeUpstream({ cwd, baseRef: 'dev', upstreamRef: 'upstream-dev' })
  assert.equal(result.status, 'merged')

  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  assert.equal(packageJson.name, FORK_PACKAGE_NAME)
  assert.equal(packageJson.version, '0.14.1')
  assert.equal(packageJson.description, 'upstream')
  assert.equal(packageJson.repository.url, FORK_PACKAGE_REPOSITORY_URL)

  assert.equal(existsSync(join(cwd, 'src/upstream.mjs')), true)
  assert.equal(existsSync(join(cwd, 'src/fork.mjs')), true)
  assert.equal(existsSync(join(cwd, '.github/workflows/release.yml')), true)
  assert.equal(existsSync(join(cwd, '.github/workflows/upstream-added.yml')), false)
  assert.equal(readFileSync(join(cwd, '.github/workflows/ci.yml'), 'utf8'), 'name: CI-fork\n')
  assert.equal(readFileSync(join(cwd, 'scripts/release-automation.mjs'), 'utf8'), '// fork\n')
  assert.ok(result.changedFiles.includes('src/upstream.mjs'))
  assert.ok(result.changedFiles.includes('package.json'))
  assert.equal(result.changedFiles.includes('.github/workflows/ci.yml'), false)
  assert.equal(result.changedFiles.includes('scripts/release-automation.mjs'), false)
  assert.ok(result.conflicts.includes('package.json'), `conflicts: ${result.conflicts.join(', ')}`)
  assert.equal(git(cwd, ['status', '--porcelain']).stdout.trim(), '')
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']).stdout.trim().split(' ')
  assert.equal(parents.length, 3, 'merge commit should have two parents')
})

test('error text never carries remote credentials or GitHub tokens', () => {
  const url = 'fatal: unable to access https://x-access-token:ghs_supersecret1234567890@github.com/LeonhardtHUST/dsh-notifier.git'
  const redacted = redactUrlCredentials(url)
  assert.equal(redacted.includes('ghs_supersecret'), false)
  assert.match(redacted, /https:\/\/\[redacted\]@github\.com/)
  assert.equal(redactUrlCredentials('token ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), false)
  assert.equal(redactUrlCredentials('no secret here'), 'no secret here')
})

test('CI failure alert also covers timeout, cancel, and action-required conclusions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/upstream-sync.yml', import.meta.url), 'utf8')
  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required']) {
    assert.match(workflow, new RegExp(`conclusion == '${conclusion}'`), conclusion)
  }
  assert.match(workflow, /head_repository\.full_name/)
  assert.match(workflow, /head_branch == 'automation\/upstream-sync'/)
  assert.match(workflow, /checks:\s*read/, 'check-runs reads need checks: read when permissions are explicit')
})

test('sync entry refuses dirty worktrees, non-CI runs, and foreign origins', (t) => {
  const cwd = tempRepo(t)
  git(cwd, ['remote', 'add', 'origin', `https://github.com/${FORK_REPOSITORY}.git`])
  assert.deepEqual(assertSyncWorkspace({ cwd, env: { GITHUB_ACTIONS: 'true' } }), { clean: true })
  assert.deepEqual(assertSyncWorkspace({ cwd, env: { UPSTREAM_SYNC_ALLOW_LOCAL: '1' } }), { clean: true })

  write(cwd, 'dirty.txt', 'local work\n')
  assert.throws(
    () => assertSyncWorkspace({ cwd, env: { GITHUB_ACTIONS: 'true' } }),
    (error) => error.code === 'workspace' && /not clean/.test(error.message),
  )
  rmSync(join(cwd, 'dirty.txt'))

  assert.throws(
    () => assertSyncWorkspace({ cwd, env: {} }),
    (error) => error.code === 'workspace' && /UPSTREAM_SYNC_ALLOW_LOCAL=1/.test(error.message),
  )
  git(cwd, ['remote', 'set-url', 'origin', `https://github.com/${UPSTREAM_REPOSITORY}.git`])
  assert.throws(
    () => assertSyncWorkspace({ cwd, env: { GITHUB_ACTIONS: 'true' } }),
    (error) => error.code === 'workspace' && /origin must be the fork/.test(error.message),
  )
})

test('bot branch push uses force-with-lease with the observed commit', () => {
  const sha = 'a'.repeat(40)
  assert.deepEqual(buildPushArgs({ branch: SYNC_BRANCH, expectedSha: sha }), [
    'push',
    `--force-with-lease=refs/heads/${SYNC_BRANCH}:${sha}`,
    'origin',
    `HEAD:refs/heads/${SYNC_BRANCH}`,
  ])
  assert.deepEqual(buildPushArgs({ branch: SYNC_BRANCH }), ['push', 'origin', `HEAD:refs/heads/${SYNC_BRANCH}`])
  assert.equal(buildPushArgs({ branch: SYNC_BRANCH, expectedSha: sha }).includes('--force'), false)
  assert.throws(() => buildPushArgs({ branch: 'bad branch' }), /unsafe branch/)
  assert.throws(() => buildPushArgs({ branch: SYNC_BRANCH, expectedSha: 'not-a-sha' }), /invalid expected sha/)
})

test('a clean upstream merge still strips upstream-added workflows and restores fork package fields', (t) => {
  const cwd = tempRepo(t)
  write(cwd, 'package.json', basePackageJson({ files: ['src'], publishConfig: { access: 'restricted' } }))
  write(cwd, 'src/a.mjs', 'export const a = 1\n')
  write(cwd, 'client.js', '// fork client\n')
  write(cwd, 'cordis.patch.yml', 'fork: true\n')
  write(cwd, 'test/.npmignore', 'host/\n')
  write(cwd, '.github/workflows/ci.yml', 'name: CI-base\n')
  commitAll(cwd, 'base')

  git(cwd, ['checkout', '-b', 'dev'])
  write(cwd, '.github/workflows/release.yml', 'name: Release-fork\n')
  write(cwd, 'src/fork.mjs', 'export const fork = true\n')
  commitAll(cwd, 'fork')

  git(cwd, ['checkout', '-b', 'upstream-dev', 'main'])
  write(cwd, 'package.json', basePackageJson({ version: '0.14.1' }))
  write(cwd, '.github/workflows/ci.yml', 'name: CI-upstream\n')
  write(cwd, '.github/workflows/upstream-added.yml', 'name: Upstream-added\n')
  write(cwd, 'src/upstream.mjs', 'export const upstream = true\n')
  write(cwd, 'client.js', '// upstream client\n')
  write(cwd, 'cordis.patch.yml', 'upstream: true\n')
  write(cwd, 'test/.npmignore', 'upstream/\n')
  commitAll(cwd, 'upstream')
  git(cwd, ['checkout', 'dev'])

  // The runner has no local or global git identity; only the script's injected
  // bot identity may make the merge commit.
  assert.notEqual(git(cwd, ['config', '--local', 'user.name'], { allowFailure: true }).status, 0)
  assert.notEqual(git(cwd, ['config', '--local', 'user.email'], { allowFailure: true }).status, 0)

  const result = mergeUpstream({ cwd, baseRef: 'dev', upstreamRef: 'upstream-dev' })
  assert.equal(result.status, 'merged')
  assert.deepEqual(result.conflicts, [])
  assert.equal(git(cwd, ['config', '--local', 'user.name'], { allowFailure: true }).status !== 0, true)
  assert.equal(git(cwd, ['log', '-1', '--format=%an <%ae>|%cn <%ce>']).stdout.trim(), `${SYNC_BOT_NAME} <${SYNC_BOT_EMAIL}>|${SYNC_BOT_NAME} <${SYNC_BOT_EMAIL}>`)

  assert.equal(existsSync(join(cwd, '.github/workflows/upstream-added.yml')), false)
  assert.equal(readFileSync(join(cwd, '.github/workflows/ci.yml'), 'utf8'), 'name: CI-base\n')
  assert.equal(existsSync(join(cwd, '.github/workflows/release.yml')), true)
  assert.equal(existsSync(join(cwd, 'src/upstream.mjs')), true)
  assert.equal(readFileSync(join(cwd, 'client.js'), 'utf8'), '// fork client\n')
  assert.equal(readFileSync(join(cwd, 'cordis.patch.yml'), 'utf8'), 'fork: true\n')
  assert.equal(readFileSync(join(cwd, 'test/.npmignore'), 'utf8'), 'host/\n')

  const packageJson = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  assert.equal(packageJson.name, FORK_PACKAGE_NAME)
  assert.equal(packageJson.version, '0.14.1')
  assert.equal(packageJson.repository.url, FORK_PACKAGE_REPOSITORY_URL)
  assert.equal(packageJson.publishConfig.access, 'public')
  assert.equal(packageJson.publishConfig.registry, FORK_PACKAGE_REGISTRY)
  assert.ok(packageJson.files.includes('docs/FORK_RELEASE.md'))
  assert.equal(result.changedFiles.includes('.github/workflows/ci.yml'), false)
  assert.equal(result.changedFiles.includes('.github/workflows/upstream-added.yml'), false)
  assert.ok(result.changedFiles.includes('src/upstream.mjs'))
})

test('a conflict outside fork-owned paths aborts without leaving a dirty tree', (t) => {
  const cwd = tempRepo(t)
  write(cwd, 'src/conflict.mjs', 'export const value = 1\n')
  commitAll(cwd, 'base')
  git(cwd, ['checkout', '-b', 'dev'])
  write(cwd, 'src/conflict.mjs', 'export const value = 2\n')
  commitAll(cwd, 'fork')
  git(cwd, ['checkout', '-b', 'upstream-dev', 'main'])
  write(cwd, 'src/conflict.mjs', 'export const value = 3\n')
  commitAll(cwd, 'upstream')
  git(cwd, ['checkout', 'dev'])

  assert.throws(
    () => mergeUpstream({ cwd, baseRef: 'dev', upstreamRef: 'upstream-dev' }),
    (error) => error instanceof UpstreamSyncError && error.code === 'conflict',
  )
  assert.equal(git(cwd, ['status', '--porcelain']).stdout.trim(), '')
  assert.equal(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), 'dev')
})

test('when upstream is already contained the merge reports up-to-date', (t) => {
  const cwd = tempRepo(t)
  write(cwd, 'src/a.mjs', 'export const a = 1\n')
  commitAll(cwd, 'base')
  git(cwd, ['checkout', '-b', 'dev'])
  git(cwd, ['checkout', '-b', 'upstream-dev'])
  git(cwd, ['checkout', 'dev'])
  assert.equal(mergeUpstream({ cwd, baseRef: 'dev', upstreamRef: 'upstream-dev' }).status, 'up-to-date')
})

test('pull request upsert updates an existing sync PR instead of opening another', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    if ((init.method ?? 'GET') === 'GET') return response(200, [{ number: 7, html_url: 'https://example/pr/7', head: { sha: 'abc' } }])
    return response(200, { number: 7, html_url: 'https://example/pr/7', head: { sha: 'abc' } })
  }
  const client = createGithubClient({ repository: FORK_REPOSITORY, token: 'test-token', fetchImpl })
  const existing = await client.findOpenPullRequest({ headBranch: SYNC_BRANCH, baseBranch: 'dev' })
  assert.equal(existing.number, 7)
  assert.ok(calls[0].url.includes(`head=${encodeURIComponent(`LeonhardtHUST:${SYNC_BRANCH}`)}`))
  await client.upsertPullRequest({ headBranch: SYNC_BRANCH, baseBranch: 'dev', title: 'sync', body: 'body', existing })
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  assert.ok(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/pulls/7')))
})

test('CI is dispatched explicitly for the bot branch', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, signal: init.signal })
    return response(204)
  }
  const client = createGithubClient({ repository: FORK_REPOSITORY, token: 'test-token', fetchImpl })
  await client.dispatchCi(SYNC_BRANCH)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.ok(calls[0].url.endsWith('/actions/workflows/ci.yml/dispatches'))
  assert.deepEqual(calls[0].body, { ref: SYNC_BRANCH })
  assert.equal(typeof calls[0].signal?.aborted, 'boolean', 'API calls must carry a timeout signal')
})

test('issue upsert reopens and updates the deduplicated issue in place', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    if ((init.method ?? 'GET') === 'GET') return response(200, { items: [{ number: 9, title: ISSUE_TITLE, state: 'closed' }] })
    return response(200, { number: 9, html_url: 'https://example/issues/9' })
  }
  const client = createGithubClient({ repository: FORK_REPOSITORY, token: 'test-token', fetchImpl })
  await client.upsertIssue({ title: ISSUE_TITLE, body: 'updated body' })
  assert.equal(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/issues')).length, 0)
  const patch = calls.find((call) => call.method === 'PATCH' && call.url.endsWith('/issues/9'))
  assert.equal(patch.body.state, 'open')
  assert.equal(patch.body.body, 'updated body')
})

test('check state aggregates failing, pending, and successful runs', async () => {
  const makeFetch = (runs) => async () => response(200, { check_runs: runs })
  const client = (runs) => createGithubClient({ repository: FORK_REPOSITORY, token: 't', fetchImpl: makeFetch(runs) })
  assert.deepEqual(await client([{ name: 'test', status: 'completed', conclusion: 'success' }]).checkState('abc'), { state: 'success', failed: [] })
  assert.deepEqual(
    await client([{ name: 'test', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'failure' }]).checkState('abc'),
    { state: 'failure', failed: ['lint'] },
  )
  assert.deepEqual(await client([{ name: 'test', status: 'in_progress', conclusion: null }]).checkState('abc'), { state: 'pending', failed: [] })
  assert.deepEqual(await client([]).checkState('abc'), { state: 'pending', failed: [] })
  assert.deepEqual(await client([]).checkState(''), { state: 'unknown', failed: [] })
})

test('CI failure alert finds the open sync PR and upserts the issue', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    if (url.includes('/pulls?')) return response(200, [{ number: 12, html_url: 'https://example/pr/12', head: { sha: 'abc' } }])
    if (url.includes('/search/issues')) return response(200, { items: [] })
    if (url.endsWith('/issues') && init.method === 'POST') return response(200, { number: 31, html_url: 'https://example/issues/31' })
    return response(500)
  }
  const result = await notifyCiFailure({
    env: {
      FORK_REPOSITORY,
      UPSTREAM_REPOSITORY,
      SYNC_TARGET_BRANCH: 'dev',
      GH_TOKEN: 'test-token',
      RUN_URL: 'https://github.com/LeonhardtHUST/dsh-notifier/actions/runs/1',
      RUN_ID: '1',
    },
    fetchImpl,
  })
  assert.equal(result.issueNumber, 31)
  const created = calls.find((call) => call.method === 'POST' && call.url.endsWith('/issues'))
  assert.ok(created.body.body.includes('https://github.com/LeonhardtHUST/dsh-notifier/actions/runs/1'))
  assert.ok(created.body.body.includes('@LeonhardtHUST'))
})
