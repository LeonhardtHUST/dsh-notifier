import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const LOCALE_EXPORT = './locale/*.json'
const TITLES = { en: 'Notification', zh: '消息通知' }

/** Resolve a package subpath the way Node's export map does, including one `*`. */
function exportTarget(request) {
  for (const [key, target] of Object.entries(packageJson.exports ?? {})) {
    const star = key.indexOf('*')
    if (star === -1) {
      if (key === request) return target
      continue
    }
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue
    return target.replace('*', request.slice(prefix.length, request.length - suffix.length))
  }
  return undefined
}

test('locale metadata stays exported, packaged and behind the unchanged plugin identity', () => {
  assert.equal(packageJson.name, '@leonhardthust/dsh-notifier')
  assert.equal(packageJson.exports?.['.'], './src/plugin-entry.mjs')
  assert.equal(packageJson.exports?.[LOCALE_EXPORT], './locale/*.json')
  assert.equal(packageJson.files.includes('locale/*.json'), true)
})

test('host-style resource resolution finds both locales and their localized text', () => {
  const directory = resolve(root, 'locale')
  const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  assert.deepEqual(files, ['en.json', 'zh.json'])

  const descriptions = []
  for (const file of files) {
    const language = file.slice(0, -'.json'.length)
    assert.match(language, /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u)
    assert.equal(existsSync(resolve(directory, file)), true)

    const request = `${packageJson.name}/locale/${file}`
    const subpath = `./${request.slice(packageJson.name.length + 1)}`
    const target = exportTarget(subpath)
    assert.equal(target, `./locale/${file}`, `${subpath} must resolve through the export map`)
    assert.equal(fileURLToPath(import.meta.resolve(request)), resolve(root, target))

    const meta = JSON.parse(readFileSync(resolve(root, target), 'utf8')).meta
    assert.equal(meta.title, TITLES[language])
    assert.equal(typeof meta.description, 'string')
    assert.ok(meta.description.trim().length > 0)
    assert.ok(meta.description.length <= 200, 'description must stay short')
    assert.equal(Object.hasOwn(meta, 'detail'), false)
    descriptions.push(meta.description)
  }
  assert.notEqual(descriptions[0], descriptions[1])
})
