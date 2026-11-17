import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('scoped release identifies the fork and public registry explicitly', () => {
  assert.equal(pkg.name, '@leonhardthust/dsh-notifier')
  assert.equal(pkg.repository.url, 'https://github.com/LeonhardtHUST/dsh-notifier')
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' })
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [])
})

test('bundle resolves the scoped package while retaining the established plugin row', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /^\s+- id: dsh-notifier\s*$/m)
  assert.match(patch, /^\s+name: ['"]@leonhardthust\/dsh-notifier['"]\s*$/m)
  assert.doesNotMatch(patch, /^\s+name: ['"]dsh-notifier['"]\s*$/m)
})
