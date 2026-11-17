#!/usr/bin/env node
// Fork-local upstream sync automation.
//
// Design constraint: this script may run in a GitHub Actions job that holds a
// write-scoped token, so it must never execute upstream code. It only performs
// git plumbing (fetch/merge/push), restores fork-owned paths, and talks to the
// GitHub REST API. The merged tree is exercised for the first time by the pull
// request's read-only CI.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FORK_REPOSITORY = 'LeonhardtHUST/dsh-notifier'
export const UPSTREAM_REPOSITORY = 'THEWOLFWALKER/dsh-notifier'
export const TARGET_BRANCH = 'dev'
export const SYNC_BRANCH = 'automation/upstream-sync'
export const SYNC_WORKFLOW_FILE = 'upstream-sync.yml'
export const FORK_PACKAGE_NAME = '@leonhardthust/dsh-notifier'
export const FORK_PACKAGE_REPOSITORY_URL = 'https://github.com/LeonhardtHUST/dsh-notifier'
export const FORK_PACKAGE_REGISTRY = 'https://registry.npmjs.org/'
export const FORK_PACKAGE_FILES = ['docs/FORK_RELEASE.md']
export const SYNC_BOT_NAME = 'dsh-notifier-sync[bot]'
export const SYNC_BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com'
const GIT_IDENTITY_ARGS = ['-c', `user.name=${SYNC_BOT_NAME}`, '-c', `user.email=${SYNC_BOT_EMAIL}`]
export const ISSUE_TITLE = '[automation] upstream sync needs attention'
export const ISSUE_MARKER = '<!-- dsh-notifier-upstream-sync -->'
export const PR_MARKER = '<!-- dsh-notifier-upstream-sync-pr -->'
export const MENTION = '@LeonhardtHUST'
export const GIT_NETWORK_TIMEOUT_MS = 120_000
export const GIT_LOCAL_TIMEOUT_MS = 60_000
export const API_TIMEOUT_MS = 30_000

const NETWORK_GIT_COMMANDS = new Set(['fetch', 'push', 'ls-remote', 'pull', 'clone'])

// Paths whose fork-specific content must survive every upstream merge. The
// package manifest is handled separately so upstream version bumps still flow
// while the scoped name and fork repository URL stay pinned.
export const PROTECTED_PATHS = [
  '.github/workflows',
  'client.js',
  'cordis.patch.yml',
  'scripts/release-automation.mjs',
  'scripts/upstream-sync.mjs',
  'test/.npmignore',
  'test/release-automation.test.mjs',
  'test/upstream-sync.test.mjs',
  'docs/FORK_RELEASE.md',
  '.agents/workstreams/rc3-automation.md',
]

export class UpstreamSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'UpstreamSyncError'
    this.code = code
    this.details = details
  }
}

export function validateSyncContext({ repository, upstreamRepository, targetBranch }) {
  const failures = []
  if (repository !== FORK_REPOSITORY) failures.push(`repository must be ${FORK_REPOSITORY}, found ${repository || '<missing>'}`)
  if (upstreamRepository !== UPSTREAM_REPOSITORY) failures.push(`upstream must be ${UPSTREAM_REPOSITORY}, found ${upstreamRepository || '<missing>'}`)
  if (targetBranch !== TARGET_BRANCH) failures.push(`sync target must be ${TARGET_BRANCH}, found ${targetBranch || '<missing>'}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(SYNC_BRANCH)) failures.push(`sync branch name is unsafe: ${SYNC_BRANCH}`)
  return failures
}

// Untrusted strings (upstream commit subjects, API messages) are rendered into
// issue/PR bodies. Strip control characters, truncate, and defuse @mentions so a
// commit message cannot page arbitrary GitHub users.
export function neutralizeMentions(value, { maxLength = 4000 } = {}) {
  let text = String(value ?? '')
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  text = text.replace(/@/g, '@\u200B')
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`
  return text
}

// Error text can contain an authenticated remote URL. Strip userinfo and common
// GitHub token formats before the text reaches an issue or a log line.
export function redactUrlCredentials(value) {
  let text = String(value ?? '')
  text = text.replace(/(https?:\/\/)([^/\s@]+)@/gi, '$1[redacted]@')
  text = text.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
  return text
}

export function isProtectedPath(path) {
  const normalized = String(path ?? '').replace(/^\.\//, '')
  if (normalized === 'package.json') return true
  return PROTECTED_PATHS.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`))
}

// Keep the fork identity while letting upstream own version/dependencies/files.
export function applyForkOverrides(packageJsonText, {
  name = FORK_PACKAGE_NAME,
  repositoryUrl = FORK_PACKAGE_REPOSITORY_URL,
  registry = FORK_PACKAGE_REGISTRY,
  access = 'public',
  packageFiles = FORK_PACKAGE_FILES,
} = {}) {
  const packageJson = JSON.parse(String(packageJsonText))
  packageJson.name = name
  const existingRepository = packageJson.repository
  packageJson.repository = {
    ...(existingRepository && typeof existingRepository === 'object' ? existingRepository : {}),
    type: existingRepository?.type ?? 'git',
    url: repositoryUrl,
  }
  // The fork publishes publicly from the official registry. Upstream does not
  // need these fields, so they are pinned here instead of being left to a merge.
  const publishConfig = packageJson.publishConfig && typeof packageJson.publishConfig === 'object'
    ? packageJson.publishConfig
    : {}
  packageJson.publishConfig = { ...publishConfig, access, registry }
  if (Array.isArray(packageJson.files)) {
    const files = [...packageJson.files]
    for (const file of packageFiles) if (!files.includes(file)) files.push(file)
    packageJson.files = files
  }
  return `${JSON.stringify(packageJson, null, 2)}\n`
}

function git(cwd, args, { allowFailure = false } = {}) {
  const networkCall = NETWORK_GIT_COMMANDS.has(args[0])
  const timeout = networkCall ? GIT_NETWORK_TIMEOUT_MS : GIT_LOCAL_TIMEOUT_MS
  // Merge/commit identity is injected per command, never written to the user's
  // global or repository config. A GitHub runner checkout has no identity.
  const fullArgs = args[0] === 'merge' || args[0] === 'commit' ? [...GIT_IDENTITY_ARGS, ...args] : args
  try {
    const stdout = execFileSync('git', fullArgs, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      killSignal: 'SIGTERM',
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        // Abort a stalled HTTP transfer instead of leaving the job hanging.
        GIT_HTTP_LOW_SPEED_LIMIT: '1000',
        GIT_HTTP_LOW_SPEED_TIME: '60',
      },
    })
    return { status: 0, stdout: String(stdout), stderr: '' }
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 1
    const stderr = String(error?.stderr ?? error?.message ?? '')
    const timedOut = error?.code === 'ETIMEDOUT' || error?.killed === true
    const message = timedOut
      ? `git ${args[0]} timed out after ${timeout} ms`
      : `git ${args[0]} failed (${status}): ${redactUrlCredentials(stderr).trim().slice(0, 1000)}`
    if (allowFailure) return { status, stdout: String(error?.stdout ?? ''), stderr: message }
    throw new UpstreamSyncError('git', message, { args, status, timedOut })
  }
}

function revParse(cwd, ref) {
  return git(cwd, ['rev-parse', ref]).stdout.trim()
}

export function assertSyncWorkspace({ cwd = process.cwd(), env = process.env } = {}) {
  const failures = []
  const status = git(cwd, ['status', '--porcelain'], { allowFailure: true })
  if (status.status !== 0) {
    failures.push('not a usable git worktree')
  } else if (status.stdout.trim() !== '') {
    failures.push('working tree is not clean; refusing to checkout -B or reset --hard over local changes')
  }
  const runningInCi = env.GITHUB_ACTIONS === 'true' || env.CI === 'true'
  if (!runningInCi && env.UPSTREAM_SYNC_ALLOW_LOCAL !== '1') {
    failures.push('refusing to run outside CI without UPSTREAM_SYNC_ALLOW_LOCAL=1')
  }
  const remote = git(cwd, ['remote', 'get-url', 'origin'], { allowFailure: true })
  const origin = remote.stdout.trim()
  if (remote.status !== 0 || !origin) {
    failures.push('origin remote is missing')
  } else if (!/github\.com[:/]LeonhardtHUST\/dsh-notifier(?:\.git)?$/i.test(origin)) {
    failures.push(`origin must be the fork ${FORK_REPOSITORY}, found ${origin}`)
  }
  if (failures.length > 0) throw new UpstreamSyncError('workspace', failures.join('; '))
  return { clean: true }
}

// Never use a bare --force for the bot branch: another actor may have updated
// it since this run started, and their commit should not be dropped silently.
export function buildPushArgs({ branch = SYNC_BRANCH, expectedSha = '' } = {}) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) throw new Error(`unsafe branch name: ${branch}`)
  if (expectedSha && !/^[0-9a-f]{40,64}$/i.test(expectedSha)) throw new Error(`invalid expected sha: ${expectedSha}`)
  if (expectedSha) {
    return ['push', `--force-with-lease=refs/heads/${branch}:${expectedSha}`, 'origin', `HEAD:refs/heads/${branch}`]
  }
  // The branch did not exist when the run started. A non-force push fails if
  // another actor creates it concurrently, which is the safe outcome.
  return ['push', 'origin', `HEAD:refs/heads/${branch}`]
}

function existingBasePath(cwd, baseRef, path) {
  const result = git(cwd, ['cat-file', '-t', `${baseRef}:${path}`], { allowFailure: true })
  return result.status === 0 ? result.stdout.trim() : ''
}

// Restore every tracked path under `path` from the fork base. Upstream-added
// files under protected directories are deleted before the fork copy is checked
// out, so upstream cannot smuggle a new workflow/script in through a clean merge.
export function restorePathsFromBase(cwd, baseRef, paths = PROTECTED_PATHS) {
  const restored = []
  for (const path of paths) {
    const type = existingBasePath(cwd, baseRef, path)
    if (!type) {
      git(cwd, ['rm', '-r', '--ignore-unmatch', '-f', '-q', '--', path], { allowFailure: true })
      continue
    }
    if (type === 'tree') {
      git(cwd, ['rm', '-r', '--ignore-unmatch', '-f', '-q', '--', path], { allowFailure: true })
      git(cwd, ['checkout', baseRef, '--', path])
    } else {
      git(cwd, ['checkout', baseRef, '--', path])
    }
    restored.push(path)
  }
  return restored
}

function applyForkOverridesToTree(cwd) {
  const file = resolve(cwd, 'package.json')
  const original = readFileSync(file, 'utf8')
  const updated = applyForkOverrides(original)
  if (updated !== original) writeFileSync(file, updated)
}

// Merge `upstreamRef` into a fresh sync branch based on `baseRef`. Returns
// `up-to-date` without side effects when upstream is already contained.
export function mergeUpstream({ cwd, baseRef = `refs/remotes/origin/${TARGET_BRANCH}`, upstreamRef = 'refs/remotes/upstream/dev' }) {
  const contained = git(cwd, ['merge-base', '--is-ancestor', upstreamRef, baseRef], { allowFailure: true })
  if (contained.status === 0) return { status: 'up-to-date' }

  git(cwd, ['checkout', '-B', SYNC_BRANCH, baseRef])
  const merge = git(cwd, ['merge', '--no-ff', '--no-commit', upstreamRef], { allowFailure: true })
  let conflicts = []
  if (merge.status !== 0) {
    conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout
      .split('\n').map((line) => line.trim()).filter(Boolean)
    const unprotected = conflicts.filter((path) => !isProtectedPath(path))
    if (unprotected.length > 0) {
      git(cwd, ['merge', '--abort'], { allowFailure: true })
      git(cwd, ['checkout', '--force', baseRef], { allowFailure: true })
      throw new UpstreamSyncError('conflict', `upstream merge conflicts outside fork-owned paths: ${unprotected.join(', ')}`, { conflicted: unprotected })
    }
    if (conflicts.includes('package.json')) {
      // Upstream owns version/metadata. Take its side, then re-pin fork identity.
      git(cwd, ['checkout', '--theirs', '--', 'package.json'])
    }
  }

  // Restore fork-owned paths on every merge path. A clean merge can still add a
  // new upstream workflow or edit an existing one, so conflict-only restoration
  // would let upstream code into the fork without review.
  const restored = restorePathsFromBase(cwd, baseRef, PROTECTED_PATHS)
  applyForkOverridesToTree(cwd)
  for (const path of conflicts) git(cwd, ['add', '--', path])
  git(cwd, ['add', '-A'])
  const staged = git(cwd, ['diff', '--cached', '--quiet'], { allowFailure: true })
  if (staged.status === 0) {
    git(cwd, ['reset', '--hard', baseRef], { allowFailure: true })
    return { status: 'up-to-date', restored }
  }

  const upstreamSha = revParse(cwd, upstreamRef)
  git(cwd, ['commit', '-m', `chore(sync): merge upstream dev @ ${upstreamSha.slice(0, 12)}`])
  const head = revParse(cwd, 'HEAD')
  const changedFiles = git(cwd, ['diff', '--name-only', baseRef, 'HEAD']).stdout
    .split('\n').map((line) => line.trim()).filter(Boolean)
  if (changedFiles.length === 0) {
    git(cwd, ['reset', '--hard', baseRef], { allowFailure: true })
    return { status: 'up-to-date', restored }
  }
  return { status: 'merged', head, upstreamSha, changedFiles, conflicts, restored }
}

export function buildPullRequestBody({
  upstreamSha,
  baseSha,
  commits = [],
  changedFiles = [],
  conflicts = [],
  upstreamMain = '',
  upstreamMainAhead = false,
} = {}) {
  const lines = [
    PR_MARKER,
    '## Automated upstream sync',
    '',
    `- Upstream: \`${UPSTREAM_REPOSITORY}@${String(upstreamSha ?? '').slice(0, 12)}\` (\`dev\`)`,
    `- Fork base: \`${String(baseSha ?? '').slice(0, 12)}\` (\`dev\`)`,
    `- Merged commits: ${commits.length}`,
    `- Changed files: ${changedFiles.length}`,
  ]
  if (conflicts.length > 0) lines.push(`- Protected conflicts auto-resolved: ${neutralizeMentions(conflicts.join(', '), { maxLength: 500 })}`)
  lines.push(
    `- Upstream \`main\`: ${upstreamMain ? `\`${String(upstreamMain).slice(0, 12)}\`` : 'unavailable'}${upstreamMainAhead ? ' (has commits not in `dev`)' : ' (contained in `dev`)'}`,
    '',
    'Fork-owned files are restored after the merge: `package.json` keeps the scoped name and fork repository URL; workflows, release/upstream-sync scripts, their tests, and `docs/FORK_RELEASE.md` stay fork-owned. `client.js`, `cordis.patch.yml`, and `test/.npmignore` also stay fork-owned; port upstream changes to them by hand.',
    '',
    'Security: the sync job only performed git plumbing. The merged tree runs for the first time in this pull request\'s read-only CI.',
  )
  if (commits.length > 0) {
    lines.push('', '### Upstream commits', '')
    for (const commit of commits.slice(0, 20)) lines.push(`- \`${codeSpan(commit, 200)}\``)
    if (commits.length > 20) lines.push(`- … and ${commits.length - 20} more`)
  }
  if (changedFiles.length > 0) {
    lines.push('', '### Changed files', '')
    for (const file of changedFiles.slice(0, 50)) lines.push(`- \`${codeSpan(file, 300)}\``)
    if (changedFiles.length > 50) lines.push(`- … and ${changedFiles.length - 50} more`)
  }
  lines.push('', 'Merge only after reviewing the diff and a green CI run. Do not push upstream.')
  return lines.join('\n')
}

function codeSpan(value, maxLength = 300) {
  return neutralizeMentions(value, { maxLength }).replace(/`/g, "'")
}

export const ISSUE_KINDS = {
  conflict: 'Upstream merge has conflicts outside fork-owned paths.',
  'ci-failure': 'The automated upstream sync pull request failed CI.',
  'sync-failure': 'The automated upstream sync could not complete (fetch, push, or GitHub API failure).',
  'main-divergence': 'Upstream main has commits that are not contained in upstream dev; the fork dev sync cannot include them.',
  success: 'The automated upstream sync is healthy again.',
}

// Decide whether the sync is healthy enough to close the alert. main divergence
// is never treated as healthy, even when upstream dev has nothing left to merge.
export function syncAlertKind({ checksState = 'unknown', upstreamMainAhead = false } = {}) {
  if (checksState === 'failure') return 'ci-failure'
  if (upstreamMainAhead) return 'main-divergence'
  return null
}

export function failureIssueKind(error) {
  return error instanceof UpstreamSyncError && error.code === 'conflict' ? 'conflict' : 'sync-failure'
}

export function buildIssueBody({
  kind = 'conflict',
  repository = FORK_REPOSITORY,
  prUrl = '',
  runUrl = '',
  detail = '',
  upstreamSha = '',
  now = new Date(),
} = {}) {
  const summary = ISSUE_KINDS[kind] ?? ISSUE_KINDS.conflict
  const lines = [
    ISSUE_MARKER,
    `${MENTION} ${summary}`,
    '',
    `- Repository: \`${repository}\``,
    `- Kind: \`${kind}\``,
    `- Upstream: \`${UPSTREAM_REPOSITORY}@${String(upstreamSha ?? '').slice(0, 12)}\``,
    `- Sync branch: \`${SYNC_BRANCH}\` -> \`${TARGET_BRANCH}\``,
    `- Updated: ${now instanceof Date ? now.toISOString() : String(now)}`,
  ]
  if (prUrl) lines.push(`- Sync PR: ${prUrl}`)
  if (runUrl) lines.push(`- Workflow run: ${runUrl}`)
  if (detail) lines.push('', '### Detail', '', '```text', neutralizeMentions(detail, { maxLength: 3500 }).replace(/```/g, '` ` `'), '```')
  lines.push(
    '',
    'Next steps: inspect the branch/PR diff, resolve the conflict manually, or wait for the next daily run. This issue is updated in place; it is closed automatically when the sync is healthy again.',
    '',
    'Notification scope: GitHub only (an @mention notification). Email depends on the repository watcher\'s GitHub notification settings.',
  )
  return lines.join('\n')
}

function apiJson(response) {
  if (typeof response?.json === 'function') return response.json()
  if (typeof response?.text === 'function') {
    return response.text().then((text) => (text === '' ? null : JSON.parse(text)))
  }
  return Promise.resolve(null)
}

export function createGithubClient({
  repository = FORK_REPOSITORY,
  token,
  fetchImpl = globalThis.fetch,
  apiBase = 'https://api.github.com',
} = {}) {
  if (!repository) throw new UpstreamSyncError('github-api', 'repository is required')
  if (!token) throw new UpstreamSyncError('github-api', 'GH_TOKEN is required')
  const [owner] = repository.split('/')

  async function request(method, path, body) {
    const init = {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'dsh-notifier-release-automation',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
    if (typeof AbortSignal?.timeout === 'function') init.signal = AbortSignal.timeout(API_TIMEOUT_MS)
    const response = await fetchImpl(`${apiBase}${path}`, init)
    const parsed = await apiJson(response).catch(() => null)
    if (response?.ok !== true) {
      const message = parsed?.message ?? `HTTP ${response?.status ?? 0}`
      throw new UpstreamSyncError('github-api', `${method} ${path} failed: ${message}`, { status: response?.status })
    }
    return parsed
  }

  async function findOpenPullRequest({ headBranch = SYNC_BRANCH, baseBranch = TARGET_BRANCH } = {}) {
    const head = encodeURIComponent(`${owner}:${headBranch}`)
    const base = encodeURIComponent(baseBranch)
    const pulls = await request('GET', `/repos/${repository}/pulls?state=open&head=${head}&base=${base}&per_page=10`)
    return Array.isArray(pulls) && pulls.length > 0 ? pulls[0] : null
  }

  async function upsertPullRequest({ headBranch = SYNC_BRANCH, baseBranch = TARGET_BRANCH, title, body, existing = null } = {}) {
    if (existing?.number) {
      return request('PATCH', `/repos/${repository}/pulls/${existing.number}`, { title, body })
    }
    return request('POST', `/repos/${repository}/pulls`, {
      title,
      head: headBranch,
      base: baseBranch,
      body,
      maintainer_can_modify: true,
    })
  }

  async function commentAndClosePullRequest({ number, comment }) {
    if (comment) await request('POST', `/repos/${repository}/issues/${number}/comments`, { body: comment })
    return request('PATCH', `/repos/${repository}/pulls/${number}`, { state: 'closed' })
  }

  async function findIssueByTitle(title) {
    const query = encodeURIComponent(`repo:${repository} is:issue in:title "${title}"`)
    const result = await request('GET', `/search/issues?q=${query}&per_page=10`)
    const items = Array.isArray(result?.items) ? result.items : []
    return items.find((item) => item.title === title && !item.pull_request) ?? null
  }

  async function upsertIssue({ title = ISSUE_TITLE, body } = {}) {
    const existing = await findIssueByTitle(title)
    if (existing?.number) {
      return request('PATCH', `/repos/${repository}/issues/${existing.number}`, { title, body, state: 'open' })
    }
    return request('POST', `/repos/${repository}/issues`, { title, body })
  }

  async function commentAndCloseIssue({ number, comment }) {
    if (comment) await request('POST', `/repos/${repository}/issues/${number}/comments`, { body: comment })
    return request('PATCH', `/repos/${repository}/issues/${number}`, { state: 'closed' })
  }

  async function checkState(sha) {
    if (!sha) return { state: 'unknown', failed: [] }
    const result = await request('GET', `/repos/${repository}/commits/${sha}/check-runs?per_page=100&filter=latest`)
    const runs = Array.isArray(result?.check_runs) ? result.check_runs : []
    if (runs.length === 0) return { state: 'pending', failed: [] }
    const failed = runs
      .filter((run) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(run.conclusion))
      .map((run) => run.name)
    if (failed.length > 0) return { state: 'failure', failed }
    const pending = runs.some((run) => run.status !== 'completed' || run.conclusion === null)
    if (pending) return { state: 'pending', failed: [] }
    return { state: 'success', failed: [] }
  }

  async function dispatchCi(ref = SYNC_BRANCH) {
    // workflow_dispatch is the documented exception to the GITHUB_TOKEN rule
    // that token-created events do not start new workflow runs.
    return request('POST', `/repos/${repository}/actions/workflows/ci.yml/dispatches`, { ref })
  }

  return {
    repository,
    request,
    findOpenPullRequest,
    upsertPullRequest,
    commentAndClosePullRequest,
    findIssueByTitle,
    upsertIssue,
    commentAndCloseIssue,
    checkState,
    dispatchCi,
  }
}

async function closeIssueIfOpen(client) {
  const issue = await client.findIssueByTitle(ISSUE_TITLE)
  if (!issue || issue.state === 'closed') return null
  await client.commentAndCloseIssue({ number: issue.number, comment: 'Upstream sync is healthy again; closing the automation alert. It will reopen if a new failure needs attention.' })
  return issue.number
}

async function raiseIssue(client, { kind, upstreamSha, prUrl, runUrl, detail }) {
  const body = buildIssueBody({ kind, prUrl, runUrl, detail, upstreamSha })
  const issue = await client.upsertIssue({ title: ISSUE_TITLE, body })
  console.log(`upstream sync issue #${issue.number}: ${issue.html_url ?? ''}`)
  return issue
}

function upstreamCommits(cwd, baseRef, upstreamRef) {
  const output = git(cwd, ['log', '--format=%h %s', '--max-count=200', `${baseRef}..${upstreamRef}`], { allowFailure: true })
  if (output.status !== 0) return []
  return output.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

export async function syncUpstream({
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const repository = env.FORK_REPOSITORY ?? ''
  const upstreamRepository = env.UPSTREAM_REPOSITORY ?? UPSTREAM_REPOSITORY
  const targetBranch = env.SYNC_TARGET_BRANCH ?? TARGET_BRANCH
  const failures = validateSyncContext({ repository, upstreamRepository, targetBranch })
  if (failures.length > 0) throw new UpstreamSyncError('context', failures.join('; '))
  if (!env.GH_TOKEN) throw new UpstreamSyncError('context', 'GH_TOKEN is required to open the sync PR or alert issue')

  // The sync branch is prepared with checkout -B and reset --hard. Refuse to do
  // that over uncommitted local work, and require an explicit local opt-in.
  assertSyncWorkspace({ cwd, env })

  const client = createGithubClient({ repository, token: env.GH_TOKEN, fetchImpl })
  const upstreamUrl = `https://github.com/${UPSTREAM_REPOSITORY}.git`
  let baseSha = ''
  let upstreamSha = ''
  let upstreamMain = ''
  let upstreamMainAhead = false
  let divergence = ''

  try {
    // Read-only probe; no upstream code is checked out or executed here.
    git(cwd, ['fetch', '--no-tags', upstreamUrl, '+refs/heads/dev:refs/remotes/upstream/dev', '+refs/heads/main:refs/remotes/upstream/main'])
    git(cwd, ['fetch', 'origin', `+refs/heads/${targetBranch}:refs/remotes/origin/${targetBranch}`])

    const baseRef = `refs/remotes/origin/${targetBranch}`
    const upstreamRef = 'refs/remotes/upstream/dev'
    const upstreamMainRef = 'refs/remotes/upstream/main'
    baseSha = revParse(cwd, baseRef)
    upstreamSha = revParse(cwd, upstreamRef)
    upstreamMain = revParse(cwd, upstreamMainRef)
    upstreamMainAhead = git(cwd, ['merge-base', '--is-ancestor', upstreamMainRef, upstreamRef], { allowFailure: true }).status !== 0
    divergence = upstreamMainAhead
      ? `upstream main ${upstreamMain.slice(0, 12)} has commits not contained in upstream dev ${upstreamSha.slice(0, 12)}; the dev sync cannot include them. Review upstream main/release changes and port them deliberately.`
      : ''
    // Record the branch head this run is based on. The push below only succeeds
    // if the remote still points at this commit.
    const remoteBranch = git(cwd, ['ls-remote', '--heads', 'origin', `refs/heads/${SYNC_BRANCH}`])
    const expectedBranchSha = (remoteBranch.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase()
    const existingPr = await client.findOpenPullRequest({ headBranch: SYNC_BRANCH, baseBranch: targetBranch })
    const merge = mergeUpstream({ cwd, baseRef, upstreamRef })

    if (merge.status === 'up-to-date') {
      if (existingPr?.number) {
        await client.commentAndClosePullRequest({
          number: existingPr.number,
          comment: 'Upstream `dev` is fully merged into this branch; closing the automated sync PR.',
        })
      }
      let issue = null
      let closedIssue = null
      const alertKind = syncAlertKind({ upstreamMainAhead })
      if (alertKind) {
        // main divergence is never silently reported as healthy, even when dev
        // has nothing left to merge.
        issue = await raiseIssue(client, { kind: alertKind, upstreamSha: upstreamMain, detail: divergence })
      } else {
        closedIssue = await closeIssueIfOpen(client)
      }
      return {
        status: 'up-to-date',
        upstreamSha,
        baseSha,
        upstreamMain,
        upstreamMainAhead,
        closedIssue,
        issueNumber: issue?.number ?? null,
      }
    }

    // The checkout keeps credentials in the local git config (never on argv), so
    // the push does not expose the token in a process list or log line.
    git(cwd, buildPushArgs({ branch: SYNC_BRANCH, expectedSha: expectedBranchSha }))
    const commits = upstreamCommits(cwd, baseRef, upstreamRef)
    const body = buildPullRequestBody({
      upstreamSha,
      baseSha,
      commits,
      changedFiles: merge.changedFiles,
      conflicts: merge.conflicts,
      upstreamMain,
      upstreamMainAhead,
    })
    const pr = await client.upsertPullRequest({
      headBranch: SYNC_BRANCH,
      baseBranch: targetBranch,
      title: 'chore(sync): merge upstream dev',
      body,
      existing: existingPr,
    })
    // GITHUB_TOKEN-created pushes and pull requests do not start other
    // workflows, so the read-only CI is dispatched explicitly on the bot branch.
    await client.dispatchCi(SYNC_BRANCH)
    const checks = await client.checkState(pr?.head?.sha ?? merge.head)
    let issue = null
    if (checks.state === 'failure') {
      issue = await raiseIssue(client, {
        kind: 'ci-failure',
        upstreamSha,
        prUrl: pr?.html_url,
        detail: [`Failing checks: ${checks.failed.join(', ')}`, divergence].filter(Boolean).join('\n'),
      })
    } else if (upstreamMainAhead) {
      issue = await raiseIssue(client, { kind: 'main-divergence', upstreamSha: upstreamMain, prUrl: pr?.html_url, detail: divergence })
    } else {
      // The merge is clean and the branch is in sync; no stale alert should linger.
      await closeIssueIfOpen(client)
    }
    return {
      status: 'proposed',
      upstreamSha,
      baseSha,
      upstreamMain,
      upstreamMainAhead,
      prNumber: pr?.number ?? null,
      prUrl: pr?.html_url ?? '',
      checkState: checks.state,
      issueNumber: issue?.number ?? null,
    }
  } catch (error) {
    // Best-effort alert for fetch, network, push, dispatch, and API failures.
    // The catch lives in the already loaded original script; nothing from the
    // merged tree is executed to report the failure.
    if (!error.notified) {
      const kind = failureIssueKind(error)
      try {
        await raiseIssue(client, { kind, upstreamSha: upstreamSha || upstreamMain, detail: redactUrlCredentials(error.message) })
        error.notified = true
      } catch (notifyError) {
        console.error(`cannot raise upstream sync alert: ${notifyError instanceof Error ? notifyError.message : String(notifyError)}`)
      }
    }
    throw error
  }
}

export async function notifyCiFailure({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const repository = env.FORK_REPOSITORY ?? ''
  const failures = validateSyncContext({
    repository,
    upstreamRepository: env.UPSTREAM_REPOSITORY ?? UPSTREAM_REPOSITORY,
    targetBranch: env.SYNC_TARGET_BRANCH ?? TARGET_BRANCH,
  })
  if (failures.length > 0) throw new UpstreamSyncError('context', failures.join('; '))
  if (!env.GH_TOKEN) throw new UpstreamSyncError('context', 'GH_TOKEN is required to update the alert issue')
  const client = createGithubClient({ repository, token: env.GH_TOKEN, fetchImpl })
  const pr = await client.findOpenPullRequest({ headBranch: SYNC_BRANCH, baseBranch: TARGET_BRANCH })
  const issue = await raiseIssue(client, {
    kind: 'ci-failure',
    upstreamSha: env.UPSTREAM_SHA ?? '',
    prUrl: pr?.html_url ?? '',
    runUrl: env.RUN_URL ?? '',
    detail: env.RUN_ID ? `CI run ${env.RUN_ID} failed for the upstream sync pull request` : 'CI failed for the upstream sync pull request',
  })
  return { status: 'alerted', prNumber: pr?.number ?? null, issueNumber: issue.number }
}

async function main(argv = process.argv.slice(2)) {
  const [command] = argv
  if (!command || command === 'help' || command === '--help') {
    console.log('usage: node scripts/upstream-sync.mjs <sync|notify-ci-failure>')
    return 0
  }
  if (command === 'sync') {
    const result = await syncUpstream()
    console.log(`upstream sync: ${result.status}${result.prUrl ? ` ${result.prUrl}` : ''}${result.checkState ? ` (checks: ${result.checkState})` : ''}`)
    return 0
  }
  if (command === 'notify-ci-failure') {
    const result = await notifyCiFailure()
    console.log(`upstream sync alert: issue #${result.issueNumber}`)
    return 0
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
