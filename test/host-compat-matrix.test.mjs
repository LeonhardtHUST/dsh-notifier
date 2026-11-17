// DSH host compatibility contract (rc.3 line).
// Locks the agreement between engines.dsh, the @deepseek-ai/dsh-session peer range,
// the DSH host matrix in docs/compatibility-matrix.md, and
// dshWorkshop.compatibility.dshVersions. The same helper backs
// scripts/verify-host-compat.mjs and `npm run verify:release`, so a hand-edited
// manifest can no longer drift from the evidence-backed rows.
//
// rc.3 fact (verified in @deepseek-ai/dsh-app-boot/lib/index.js:1102-1148): an own
// engines.dsh decides alone and peerDependencies are ignored, so both declarations
// must name exactly the verified rows.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostCompatFailures, parseMatrix, parsePeerRange, verifyHostCompat } from '../scripts/verify-host-compat.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const matrix = parseMatrix(readFileSync(resolve(root, 'docs/compatibility-matrix.md'), 'utf8'))

const VERIFIED = ['0.2.2-rc.3']
const EXACT_RANGE = VERIFIED.join(' || ')

test('host compat: the shipped manifest and matrix verify cleanly', () => {
  assert.notEqual(matrix, null, 'docs/compatibility-matrix.md must carry a dsh-host-matrix block')
  assert.deepEqual(hostCompatFailures(root), [])
  assert.deepEqual(verifyHostCompat(packageJson, matrix), [])
})

test('host compat: the peer marker is a real optional @deepseek-ai/dsh* package', () => {
  const range = packageJson.peerDependencies['@deepseek-ai/dsh-session']
  assert.equal(typeof range, 'string')
  assert.equal(matrix.peerPackage, '@deepseek-ai/dsh-session')
  assert.notEqual(matrix.peerPackage, '@deepseek-ai/dsh', 'the bare @deepseek-ai/dsh package does not exist')
  assert.equal(packageJson.peerDependenciesMeta['@deepseek-ai/dsh-session'].optional, true)
})

test('host compat: the peer range is exact or OR-exact, never a guessed range', () => {
  const range = packageJson.peerDependencies['@deepseek-ai/dsh-session']
  assert.equal(range, EXACT_RANGE)
  assert.equal(/[\^~><*]/.test(range), false, 'no caret/tilde/inequality/wildcard guessing')
  assert.deepEqual(parsePeerRange(range), VERIFIED)
})

test('host compat: engines.dsh names exactly the verified rows (the rc.3 gate reads it alone)', () => {
  assert.equal(packageJson.engines.dsh, EXACT_RANGE)
  assert.equal(/[\^~><*]/.test(packageJson.engines.dsh), false, 'no guessed host range')
  assert.deepEqual(parsePeerRange(packageJson.engines.dsh), VERIFIED)
})

test('host compat: the Cordis peer tracks the rc.3 install', () => {
  assert.equal(packageJson.peerDependencies['@deepseek-ai/cordis'], '~4.1.0')
})

test('host compat: dshWorkshop lists exactly the verified rows', () => {
  assert.deepEqual(packageJson.dshWorkshop.compatibility.dshVersions, VERIFIED)
  const verified = matrix.runtimes.filter((row) => row.status === 'verified').map((row) => row.version)
  assert.deepEqual(verified, VERIFIED)
})

test('host compat: the previous rc.5 and historical 0.1.x claims are unverified and excluded', () => {
  for (const version of ['0.2.1-rc.5', '0.1.0-rc.6']) {
    const row = matrix.runtimes.find((entry) => entry.version === version)
    assert.notEqual(row, undefined, `${version} must stay visible as a historical row`)
    assert.notEqual(row.status, 'verified')
    assert.equal(parsePeerRange(packageJson.peerDependencies['@deepseek-ai/dsh-session']).includes(version), false)
    assert.equal(parsePeerRange(packageJson.engines.dsh).includes(version), false)
  }
})

test('host compat: drift is caught — a non-verified runtime must not enter either range', () => {
  const peerDrift = {
    ...packageJson,
    peerDependencies: { ...packageJson.peerDependencies, '@deepseek-ai/dsh-session': `0.2.1-rc.5 || ${EXACT_RANGE}` },
  }
  assert.equal(
    verifyHostCompat(peerDrift, matrix).some((line) => /non-verified runtime 0\.2\.1-rc\.5/.test(line)),
    true,
    'the peer range must never cover the previous rc.5 row',
  )
  const engineDrift = { ...packageJson, engines: { ...packageJson.engines, dsh: `0.1.0-rc.6 || ${EXACT_RANGE}` } }
  assert.equal(
    verifyHostCompat(engineDrift, matrix).some((line) => /non-verified runtime 0\.1\.0-rc\.6/.test(line)),
    true,
    'engines.dsh must never cover the historical 0.1.0-rc.6 row',
  )
})

test('host compat: drift is caught — a verified runtime must be covered by both declarations', () => {
  const peerDrift = {
    ...packageJson,
    peerDependencies: { ...packageJson.peerDependencies, '@deepseek-ai/dsh-session': '0.1.0-rc.6' },
  }
  assert.equal(verifyHostCompat(peerDrift, matrix).some((line) => /verified runtime 0\.2\.2-rc\.3 is not covered/.test(line)), true)
  const engineDrift = { ...packageJson, engines: { ...packageJson.engines, dsh: '0.1.0-rc.6' } }
  assert.equal(verifyHostCompat(engineDrift, matrix).some((line) => /verified runtime 0\.2\.2-rc\.3 is not covered by engines\.dsh/.test(line)), true)
})

test('host compat: drift is caught — a guessed caret range is rejected in both declarations', () => {
  const peerDrift = {
    ...packageJson,
    peerDependencies: { ...packageJson.peerDependencies, '@deepseek-ai/dsh-session': '^0.2.2' },
  }
  assert.equal(verifyHostCompat(peerDrift, matrix).some((line) => /not an exact version/.test(line)), true)
  const engineDrift = { ...packageJson, engines: { ...packageJson.engines, dsh: '^0.2.2' } }
  assert.equal(verifyHostCompat(engineDrift, matrix).some((line) => /engines\.dsh segment is not an exact version/.test(line)), true)
})

test('host compat: drift is caught — engines.dsh and the peer range must agree', () => {
  const drifted = {
    ...packageJson,
    engines: { ...packageJson.engines, dsh: '0.2.1-rc.5' },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /engines\.dsh .* must equal the peer range/.test(line)), true)
})

test('host compat: drift is caught — a missing engines.dsh is reported', () => {
  const drifted = { ...packageJson, engines: { node: '>=22' } }
  assert.equal(verifyHostCompat(drifted, matrix).some((line) => /engines\.dsh must declare/.test(line)), true)
})

test('host compat: drift is caught — the workshop list must match the verified rows', () => {
  const drifted = {
    ...packageJson,
    dshWorkshop: { ...packageJson.dshWorkshop, compatibility: { dshVersions: ['0.1.0-rc.6'] } },
  }
  const failures = verifyHostCompat(drifted, matrix)
  assert.equal(failures.some((line) => /dshVersions must equal the verified matrix rows/.test(line)), true)
})

test('host compat: drift is caught — a missing optional-peer marker or range is reported', () => {
  const noMeta = { ...packageJson, peerDependenciesMeta: {} }
  assert.equal(verifyHostCompat(noMeta, matrix).some((line) => /optional must be true/.test(line)), true)
  const noPeer = { ...packageJson, peerDependencies: { '@deepseek-ai/cordis': '~4.1.0' } }
  assert.equal(verifyHostCompat(noPeer, matrix).some((line) => /is missing/.test(line)), true)
})

test('host compat: index.mjs keeps connection/webServer out of the static inject', () => {
  const source = readFileSync(resolve(root, 'src/index.mjs'), 'utf8')
  const match = /export const inject = (\[[^\]]*\])/.exec(source)
  assert.notEqual(match, null, 'src/index.mjs must export a static inject array')
  const inject = JSON.parse(match[1].replace(/'/g, '"'))
  assert.deepEqual(inject, ['tools', 'agents'], 'connection/webServer are runtime optional deps (issue #49)')
  assert.equal(source.includes("inject(['connection', 'webServer']"), true,
    'the Native Control Surface must stay behind a runtime optional injection')
})

test('host compat: the machine block parser fails closed on absent or malformed input', () => {
  assert.equal(parseMatrix('# no block here'), null)
  assert.equal(parseMatrix('```json dsh-host-matrix\n{ not json\n```'), null)
  assert.deepEqual(parsePeerRange(' 0.2.2-rc.3 || 0.1.0-rc.6 '), ['0.2.2-rc.3', '0.1.0-rc.6'])
})
