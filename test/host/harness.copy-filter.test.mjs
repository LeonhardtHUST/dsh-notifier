// Focused guard: a package payload copied into a disposable profile must never
// carry credentials, state or dotenv files, even when they are untracked locally.
// The filter rejects by path name only; this test only needs paths and one normal
// payload file, so it runs without booting DSH.

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCRATCH_ROOT,
  installPluginIntoProfile,
  makeDisposableDshHome,
} from './harness.mjs'

function writeFile(root, rel, content = 'x\n') {
  const target = join(root, rel)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

test('host copy filter refuses sensitive paths by name, at any depth', () => {
  const home = makeDisposableDshHome('copy-filter')
  const src = join(SCRATCH_ROOT, 'copy-filter-src')
  try {
    rmSync(src, { recursive: true, force: true })
    writeFile(src, 'package.json', JSON.stringify({
      name: '@scope/copy-filter-fixture',
      version: '0.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }, null, 2) + '\n')
    writeFile(src, 'cordis.patch.yml', [
      '- insert:',
      "    - id: dsh-notifier",
      "      name: '@scope/copy-filter-fixture'",
      '',
    ].join('\n'))
    writeFile(src, 'index.mjs', 'export const name = "fixture"\n')
    writeFile(src, 'deep/normal.txt')

    // Every one of these must be rejected by name, without reading contents.
    for (const rel of [
      '.env',
      '.env.local',
      '.env.example',
      '.npmrc',
      '.credentials',
      'credentials.json',
      'state.json',
      'bootstrap-paircode.txt',
      'id_rsa',
      'certs/tls.key',
      'certs/tls.pem',
      'secrets/nested/.env',
      'state/live.json',
      '.ssh/config',
      '.gnupg/pubring.kbx',
      'node_modules/dep/index.js',
      '.git/config',
      '.agents/workstream.md',
    ]) writeFile(src, rel)

    const installed = installPluginIntoProfile({
      home: home.home,
      profile: 'copy-filter',
      bundles: ['@deepseek-ai/dsh-base'],
      repoRoot: src,
    })

    assert.ok(existsSync(join(installed.pluginDir, 'index.mjs')))
    assert.ok(existsSync(join(installed.pluginDir, 'deep/normal.txt')))
    assert.ok(existsSync(join(installed.pluginDir, 'cordis.patch.yml')))

    for (const rel of [
      '.env',
      '.env.local',
      '.env.example',
      '.npmrc',
      '.credentials',
      'credentials.json',
      'state.json',
      'bootstrap-paircode.txt',
      'id_rsa',
      'certs/tls.key',
      'certs/tls.pem',
      'secrets/nested/.env',
      'state',
      '.ssh',
      '.gnupg',
      'node_modules',
      '.git',
      '.agents',
    ]) assert.equal(existsSync(join(installed.pluginDir, rel)), false, `${rel} must not be copied`)
  } finally {
    home.cleanup()
    rmSync(src, { recursive: true, force: true })
  }
})
