// v0.8.7 测试：inbound/store 持久化成功/失败的显式传播（对抗评审 Stage-4 P1-2）。
// createStore.set 现在把「写是否真正落盘」作为布尔返回：可写路径返回 true，
// 落盘失败（父路径被常规文件占用，写必然失败）返回 false 而非被静默吞掉——
// 调用方（agent-router.safeSet → admin PATCH control）据此才能把写失败报成 500。

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../src/inbound/store.mjs'

test('set：可写路径持久化成功返回 true，同路径新 store 重启读回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-ok-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  assert.equal(store.set('k', { v: 1 }), true)
  assert.deepEqual(store.get('k'), { v: 1 })
  // 重启：同一文件路径新建 store，读到上次落盘内容（值语义，非仅内存）
  const reloaded = createStore(file)
  assert.deepEqual(reloaded.get('k'), { v: 1 })
})

test('set：父路径被常规文件占用 → 落盘失败返回 false（不抛、不静默吞、不谎报成功）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-fail-'))
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'i am a regular file')
  const store = createStore(join(blocker, 'state.json')) // 父级是普通文件 → 落盘必然失败
  // 失败显式传播：false 让上层（router.safeSet → admin 500）能把写失败与成功区分开，
  // 而不是「重启即丢」还被当作 200。
  assert.equal(store.set('k', { v: 1 }), false)
})

test('v0.13 C2：mutator 失败时 draft 不发布，memory/disk 都保持原样', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-tx-fail-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  assert.equal(store.set('stable', { value: 1 }), true)
  const before = readFileSync(file, 'utf8')
  const result = store.transact((draft) => {
    draft.stable = { value: 2 }
    draft.late = true
    throw new Error('abort')
  })
  assert.equal(result.committed, false)
  assert.equal(store.get('late'), undefined)
  assert.deepEqual(store.get('stable'), { value: 1 })
  assert.equal(readFileSync(file, 'utf8'), before)
})

test('v0.13 C2：live lock 超时返回 STATE_BUSY，绝不 unlocked write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-busy-'))
  const file = join(dir, 'state.json')
  const store = createStore(file)
  assert.equal(store.set('stable', 1), true)
  const lock = `${file}.lock`
  writeFileSync(lock, `${process.pid}:live-test-holder`)
  try {
    const result = store.transact((draft) => { draft.late = true; return true })
    assert.equal(result.committed, false)
    assert.equal(result.code, 'STATE_BUSY')
    assert.equal(store.get('late'), undefined)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { __schema: { version: 1, namespace: 'dsh-notifier' }, stable: 1 })
  } finally {
    try { unlinkSync(lock) } catch {}
  }
})

test('v0.13 C2：每个事务 fresh-read disk，两个 store 的无关 key 不互相覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-fresh-'))
  const file = join(dir, 'state.json')
  const first = createStore(file)
  const second = createStore(file)
  assert.equal(first.set('a', 1), true)
  assert.equal(second.set('b', 2), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { __schema: { version: 1, namespace: 'dsh-notifier' }, a: 1, b: 2 })
  assert.deepEqual(createStore(file).keys().sort(), ['__schema', 'a', 'b'])
})

test('S-04：加载时权限自检——mode 非 0600 → warn + chmod 收紧尝试（失败仅 warn 不阻塞启动）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-store-perm-'))
  const file = join(dir, 'state.json')
  // T03：fixture 必须带当前 schema，否则 k 不是权威记忆（legacy-unknown 读侧 fail-closed）。
  const fixture = { __schema: { version: 1, namespace: 'dsh-notifier' }, k: 1 }
  // 模拟旧版本/umask 异常/手工放宽留下的过宽 mode。Windows 不承载 POSIX 位：
  // 普通文件恒为 0666，chmod 0644/0600 都只切换只读位（实测 0644→0666、0600→0666、0400→0444）。
  writeFileSync(file, JSON.stringify(fixture), { mode: 0o644 })
  chmodSync(file, 0o644)
  const posix = process.platform !== 'win32'
  if (posix) {
    assert.equal(statSync(file).mode & 0o777, 0o644, '前置条件：POSIX 下文件确实过宽')
  } else {
    // 不得把 Windows 的 0666 当作「已过宽到 0644」；能证明的是它不是受保护的 0600
    assert.notEqual(statSync(file).mode & 0o777, 0o600, '前置条件：Windows 下文件不是 0600')
  }
  const warnings = []
  const originalError = console.error
  console.error = (...args) => {
    if (String(args[0]).includes('dsh-notifier/store')) warnings.push(args.join(' '))
  }
  try {
    const store = createStore(file)
    assert.equal(store.get('k'), 1, '权限过宽不阻塞启动读取，且当前 schema 的键按权威读取')
    assert.ok(warnings.some((w) => /权限过宽/.test(w)), `必须 warn 权限过宽（实际：${warnings.join(' | ')}）`)
    assert.ok(warnings.some((w) => /尝试收紧/.test(w)), 'warn 明示正在收紧')
    if (posix) {
      assert.equal(statSync(file).mode & 0o777, 0o600, 'POSIX chmod 收紧为 0600')
    } else {
      // Windows chmod 无法表达 POSIX 0600：只允许断言「尝试过」，绝不谎称权限位已收紧
      assert.notEqual(statSync(file).mode & 0o777, 0o600, 'Windows 不得声称已收紧到 POSIX 0600')
      assert.ok(statSync(file).mode & 0o400, '文件仍可读，自检不改变可读性')
    }
  } finally {
    console.error = originalError
  }
  if (posix) {
    // 已是 0600：再启动零告警（幂等，不刷屏）
    const warnings2 = []
    console.error = (...args) => {
      if (String(args[0]).includes('dsh-notifier/store')) warnings2.push(args.join(' '))
    }
    try {
      createStore(file)
      assert.ok(!warnings2.some((w) => /权限过宽/.test(w)), '0600 现场不重复告警')
    } finally {
      console.error = originalError
    }
  } else {
    // Windows 无法留下 0600：下次启动仍应检测到「过宽」并再次尝试（检测幂等）——
    // 这是平台能力边界，不是告警刷屏缺陷；不声称 POSIX 权限已收紧。
    const warnings2 = []
    console.error = (...args) => {
      if (String(args[0]).includes('dsh-notifier/store')) warnings2.push(args.join(' '))
    }
    try {
      createStore(file)
      assert.ok(warnings2.some((w) => /权限过宽/.test(w)), 'Windows 仍能检测到非 0600 现场')
    } finally {
      console.error = originalError
    }
  }
})
