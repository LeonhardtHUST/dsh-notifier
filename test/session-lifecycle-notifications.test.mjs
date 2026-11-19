// dsh-notifier session-lifecycle-notifications tests
// 覆盖已安装 DSH 0.2.2-rc.3 真实载荷：todo/write 整表快照、goal/change 快照与
// clear tombstone、approval/asked、ask_user_question 的 tool/call；以及缺失/畸形、
// 取消/清除、宿主重放重复、类别开关与远程动作卡片闸。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventListener } from '../src/event-listener.mjs'
import {
  diffTodoLists,
  lifecycleStrings,
  normalizeTodoList,
  toolResultCallId,
  toolResultKeepsQuestionPending,
  userQuestionReplyCallId,
} from '../src/host/lifecycle.mjs'

// ---------------------------------------------------------------- helpers

function fakeCtx(warnings = []) {
  const listeners = {}
  return {
    listeners,
    warnings,
    ctx: {
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      on(event, fn) {
        ;(listeners[event] ??= []).push(fn)
        return () => {}
      },
    },
  }
}

function makeSession(id = 's1', extra = {}) {
  return { id, header: { cwd: '/tmp/ws', ...(extra.header ?? {}) }, ...extra }
}

/** 记录 notifyAll 的消息、第二参结果；默认返回无 suppressed。 */
function makeNotifier({ suppressed = [], canSendRemote = null } = {}) {
  const messages = []
  const calls = []
  const notifier = {
    async notifyAll(message, options = {}) {
      messages.push(message)
      calls.push(options)
      return { ok: true, delivered: ['telegram'], failed: [], ...(suppressed.length > 0 ? { suppressed } : {}) }
    },
    flush: async () => {},
  }
  if (canSendRemote !== null) notifier.canSendRemote = canSendRemote
  return { notifier, messages, calls }
}

function rig(resolved = {}, wiring = {}, notifierOptions = {}) {
  const { ctx, listeners, warnings } = fakeCtx()
  const { notifier, messages, calls } = makeNotifier(notifierOptions)
  const dispose = createEventListener(ctx, notifier, {
    enabled: true,
    debounceMs: 0,
    summaryMaxChars: 500,
    titlePrefix: '',
    ...resolved,
  }, { lifecycleSettleMs: 0, ...wiring })
  return {
    listeners,
    warnings,
    messages,
    calls,
    dispose,
    emit(session, event) { listeners['session/event'][0](session, event) },
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

/** 官方 todo_write 载荷。 */
const todoEvent = (seq, todos) => ({ type: 'todo/write', seq, data: { todos } })

/** 官方 goal/change 快照载荷。 */
function goalEvent(seq, operation, phase, extra = {}) {
  const goal = {
    id: 'goal-1',
    revision: seq,
    objective: 'ship the lifecycle notifications',
    phase,
    maxGoalRounds: 5,
  }
  return {
    type: 'goal/change',
    seq,
    data: {
      kind: 'goal/change',
      version: 1,
      operation,
      goal,
      roundsStarted: extra.roundsStarted ?? 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000 + seq,
      ...(extra.blockedReason !== undefined ? { goal: { ...goal, blockedReason: extra.blockedReason } } : {}),
    },
  }
}

// ---------------------------------------------------------------- pure mapping

test('normalizeTodoList：接受官方三态；空数组合法；缺 content/status 或重复整表拒绝', () => {
  assert.deepEqual(normalizeTodoList([{ content: ' a ', status: 'pending' }]), [{ content: 'a', status: 'pending' }])
  assert.deepEqual(normalizeTodoList([]), [])
  assert.equal(normalizeTodoList(undefined), null)
  assert.equal(normalizeTodoList('nope'), null)
  assert.equal(normalizeTodoList([{ content: '', status: 'pending' }]), null)
  assert.equal(normalizeTodoList([{ content: 'a', status: 'cancelled' }]), null)
  assert.equal(normalizeTodoList([{ content: 'a', status: 'pending' }, { content: 'a', status: 'completed' }]), null)
  // 有界状态：超长条目按身份上限存储（截断只影响展示），超大列表整表拒绝而不是截断造幻影。
  const longTail = 'x'.repeat(300)
  const list = normalizeTodoList([
    { content: `${longTail}-one`, status: 'pending' },
    { content: `${longTail}-two`, status: 'pending' },
  ])
  assert.equal(list.length, 2, '共享前缀但尾不同的条目不得被当成重复')
  assert.ok(list[0].content.length <= 500)
  assert.equal(normalizeTodoList(Array.from({ length: 101 }, (_, i) => ({ content: `t${i}`, status: 'pending' }))), null)
})

test('diffTodoLists：完成/取消（移除未完成）/暂停（in_progress→pending）/重新打开', () => {
  const previous = [
    { content: 'A', status: 'pending' },
    { content: 'B', status: 'in_progress' },
    { content: 'C', status: 'completed' },
  ]
  const diff = diffTodoLists(previous, [
    { content: 'A', status: 'completed' }, // 完成
    { content: 'B', status: 'pending' }, // 暂停
    { content: 'D', status: 'in_progress' }, // 新增
  ])
  assert.deepEqual(diff.completed, ['A'])
  assert.deepEqual(diff.paused, ['B'])
  assert.deepEqual(diff.cancelled, [], '已完成的条目被移除不是取消')
  assert.deepEqual(diff.added, ['D'])
  assert.deepEqual(diffTodoLists([], []), { added: [], started: [], completed: [], cancelled: [], paused: [], reopened: [] })
  assert.deepEqual(diffTodoLists(null, [{ content: 'A', status: 'pending' }]).added, ['A'], '首写视为新增')
  assert.deepEqual(diffTodoLists([{ content: 'A', status: 'completed' }], [{ content: 'A', status: 'in_progress' }]).reopened, ['A'])
})

test('lifecycleStrings：en 输出英文，未知 lang 回落 zh', () => {
  assert.equal(lifecycleStrings('en').todo.headline['todo.completed'], '✅ Todo completed')
  assert.equal(lifecycleStrings('zh').todo.headline['todo.completed'], '✅ 待办完成')
  assert.equal(lifecycleStrings('xx').todo.headline['todo.completed'], '✅ 待办完成')
  assert.equal(lifecycleStrings('en').goal.headline['goal.paused'], '⏸ Goal paused')
  assert.equal(lifecycleStrings('en').survey.headline, '❓ Question needs your input')
})

test('tool/result 形状：rc.3 timed 提问的 {pending:true,callId} 仍是等待，答案/错误才是结算', () => {
  const result = (payload, isError = false, callId = 'c1') => ({
    type: 'tool/result',
    data: { message: { toolCallId: callId, isError, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
  })
  assert.equal(toolResultCallId(result({ pending: true, callId: 'c1' })), 'c1')
  assert.equal(toolResultCallId({ type: 'tool/result', data: { message: { source: { callId: 'c2' } } } }), 'c2')
  assert.equal(toolResultCallId({ type: 'tool/result', data: {} }), null)
  assert.equal(toolResultCallId({ type: 'tool/call', data: { callId: 'c3' } }), null)

  assert.equal(toolResultKeepsQuestionPending(result({ pending: true, callId: 'c1', message: 'continue' }), 'c1'), true)
  assert.equal(toolResultKeepsQuestionPending(result({ answers: [{ id: 'q1', selected: ['yes'] }] }), 'c1'), false)
  assert.equal(toolResultKeepsQuestionPending(result({ pending: true, callId: 'c1' }, true), 'c1'), true, '宿主只看 pending，isError 不推翻')
  assert.equal(toolResultKeepsQuestionPending(result({ pending: true, callId: 'other' }), 'c1'), true, '宿主不比对 callId')
  assert.equal(toolResultKeepsQuestionPending({
    type: 'tool/result',
    data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' }, message: { toolCallId: 'c1', content: [] } },
  }, 'c1'), true, '结果未知仍可回答')
  assert.equal(toolResultKeepsQuestionPending(result('not-json'), 'c1'), false)
  assert.equal(toolResultKeepsQuestionPending(result({ pending: true, callId: 'c1' }), undefined), true)

  assert.equal(userQuestionReplyCallId({
    type: 'user/message',
    data: { source: { kind: 'user-question-reply', callId: 'c1', outcome: 'answered' } },
  }), 'c1')
  assert.equal(userQuestionReplyCallId({ type: 'user/message', data: { source: { kind: 'user' } } }), null)
  assert.equal(userQuestionReplyCallId({ type: 'assistant/message', data: {} }), null)
})

// ---------------------------------------------------------------- todo lifecycle

test('todo 生命周期：首写(changed)、完成、取消（移除未完成）逐次产出；已完成的移除不再通知', () => {
  const r = rig()
  const session = makeSession('todo-s1')

  r.emit(session, todoEvent(1, [
    { content: '写测试', status: 'pending' },
    { content: '跑回归', status: 'pending' },
  ]))
  assert.equal(r.messages.length, 1)
  assert.equal(r.calls[0].category, 'todo.changed', '首写是整表新增；默认是否送达由 notify 策略矩阵决定')
  assert.match(r.messages[0].content, /新增 2 项/)

  r.emit(session, todoEvent(2, [
    { content: '写测试', status: 'completed' },
    { content: '跑回归', status: 'pending' },
  ]))
  assert.equal(r.messages.length, 2)
  assert.equal(r.calls[1].category, 'todo.completed')
  assert.equal(r.calls[1].sessionId, 'todo-s1')
  assert.match(r.messages[1].title, /待办完成/)
  assert.match(r.messages[1].content, /写测试/)

  r.emit(session, todoEvent(3, [{ content: '写测试', status: 'completed' }]))
  assert.equal(r.messages.length, 3)
  assert.equal(r.calls[2].category, 'todo.cancelled', '未完成的条目消失 = 取消')
  assert.match(r.messages[2].content, /跑回归/)

  // 只剩已完成条目后再清空：清单收敛，不是取消。
  r.emit(session, todoEvent(4, []))
  assert.equal(r.messages.length, 3)
})

test('todo：changed/paused 正常产出；开始与暂停分别归类', () => {
  const r = rig()
  const session = makeSession('todo-s2')
  r.emit(session, todoEvent(1, [{ content: 'A', status: 'in_progress' }]))
  assert.equal(r.calls[0].category, 'todo.changed', '首写新增')
  r.emit(session, todoEvent(2, [{ content: 'A', status: 'pending' }]))
  assert.equal(r.calls[1].category, 'todo.paused')
  r.emit(session, todoEvent(3, [{ content: 'A', status: 'in_progress' }]))
  assert.equal(r.calls[2].category, 'todo.changed', 'pending→in_progress 归为变更')
})

test('todo 畸形载荷：不推送、告警、且不污染后续 diff', () => {
  const r = rig()
  const session = makeSession('todo-s3')
  r.emit(session, todoEvent(1, [{ content: 'A', status: 'pending' }])) // changed 正常产出，状态已记录
  assert.equal(r.messages.length, 1)
  r.emit(session, todoEvent(2, 'not-an-array'))
  assert.equal(r.messages.length, 1)
  const invalidWarnings = r.warnings.filter((warning) => /todo\/write 载荷无效/.test(warning))
  assert.equal(invalidWarnings.length, 1)
  // 坏载荷不得推进状态：A 仍然是 pending，从 pending→completed 必须能识别。
  r.emit(session, todoEvent(3, [{ content: 'A', status: 'completed' }]))
  assert.equal(r.messages.length, 2)
  assert.equal(r.calls[1].category, 'todo.completed')
})

test('todo 宿主重放（同 seq 同载荷）只通知一次；不同会话各自记账', () => {
  const r = rig()
  const session = makeSession('todo-s4')
  const first = todoEvent(1, [{ content: 'A', status: 'pending' }])
  const done = todoEvent(2, [{ content: 'A', status: 'completed' }])
  r.emit(session, first)
  r.emit(session, done)
  r.emit(session, done)
  assert.equal(r.messages.length, 2, '首写 + 完成各一次，重放不重复')
  const other = makeSession('todo-s5')
  r.emit(other, todoEvent(1, [{ content: 'A', status: 'pending' }]))
  r.emit(other, todoEvent(2, [{ content: 'A', status: 'completed' }]))
  assert.equal(r.messages.length, 4, '另一个会话各自的完成状态独立记账')
})

// ---------------------------------------------------------------- goal lifecycle

test('goal：create→changed，complete→完成，clear tombstone→取消，重复修订只通知一次', () => {
  const r = rig()
  const session = makeSession('goal-s1')
  r.emit(session, goalEvent(1, 'create', 'active'))
  assert.equal(r.messages.length, 1)
  assert.equal(r.calls[0].category, 'goal.changed')

  const complete = goalEvent(2, 'complete', 'complete')
  r.emit(session, complete)
  assert.equal(r.messages.length, 2)
  assert.equal(r.calls[1].category, 'goal.completed')
  assert.match(r.messages[1].title, /目标完成/)
  assert.match(r.messages[1].content, /ship the lifecycle notifications/)
  assert.match(r.messages[1].content, /已完成/)

  r.emit(session, complete) // 同一修订、不同 seq 的重放
  assert.equal(r.messages.length, 2, '同一 goal 修订不重复通知')

  r.emit(session, {
    type: 'goal/change',
    seq: 3,
    data: { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-1', revision: 2 }, clearedAt: 1_700_000_000_500 },
  })
  assert.equal(r.messages.length, 3)
  assert.equal(r.calls[2].category, 'goal.cancelled')
  assert.match(r.messages[2].content, /清除/)
})

test('goal：pause/block 归入 paused；block 为 timeSensitive 且带受阻原因', () => {
  const r = rig()
  const session = makeSession('goal-s2')
  r.emit(session, goalEvent(1, 'create', 'active'))
  assert.equal(r.calls[0].category, 'goal.changed')

  r.emit(session, goalEvent(2, 'pause', 'paused'))
  assert.equal(r.calls[1].category, 'goal.paused')
  assert.equal(r.messages[1].level, 'passive')

  r.emit(session, goalEvent(3, 'block', 'blocked', {
    blockedReason: { code: 'needs-input', message: '需要用户确认数据库迁移' },
  }))
  assert.equal(r.calls[2].category, 'goal.paused')
  assert.equal(r.messages[2].level, 'timeSensitive')
  assert.match(r.messages[2].content, /需要用户确认数据库迁移/)

  r.emit(session, goalEvent(4, 'resume', 'active'))
  assert.equal(r.calls[3].category, 'goal.changed')
})

test('goal 畸形载荷：缺 operation / 快照字段畸形 → 告警且不推送', () => {
  const r = rig()
  const session = makeSession('goal-s3')
  r.emit(session, { type: 'goal/change', seq: 1, data: { operation: 'nope' } })
  r.emit(session, { type: 'goal/change', seq: 2, data: { operation: 'complete', goal: { id: 'g', revision: 1 } } })
  r.emit(session, { type: 'goal/change', seq: 3, data: { operation: 'clear' } })
  assert.equal(r.messages.length, 0)
  const invalidWarnings = r.warnings.filter((warning) => /goal\/change 载荷无效/.test(warning))
  assert.equal(invalidWarnings.length, 3)
})

// ---------------------------------------------------------------- approval + survey

test('approval/asked：携带 session.approval 类别、sessionId 与注入的 sessionTitle', () => {
  const r = rig({}, { sessionTitleOf: () => '部署会话' })
  const session = makeSession('ap-s1')
  r.emit(session, { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } })
  assert.equal(r.messages.length, 1)
  assert.equal(r.calls[0].category, 'session.approval')
  assert.equal(r.calls[0].sessionId, 'ap-s1')
  assert.equal(r.calls[0].sessionTitle, '部署会话')
  r.emit(session, { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } })
  assert.equal(r.messages.length, 1, '同 seq 重放不重复')
})

test('survey：官方 ask_user_question 与插件自有 ask_user 都提醒；自有工具只发本机', () => {
  const r = rig()
  const session = makeSession('survey-s1')
  const argumentsText = JSON.stringify({ questions: [{ id: 'q1', question: 'SECRET_QUESTION_TEXT' }] })
  r.emit(session, { type: 'tool/call', seq: 1, data: { turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: argumentsText } })
  assert.equal(r.messages.length, 1)
  assert.equal(r.calls[0].category, 'session.survey')
  assert.equal(r.calls[0].localOnly, undefined, '官方提问按普通策略投放')
  assert.match(r.messages[0].title, /需要你回答/)
  assert.doesNotMatch(r.messages[0].content, /SECRET_QUESTION_TEXT/, '不回显原始问题参数')
  assert.equal(r.messages[0].level, 'timeSensitive')

  // 同一 callId 的宿主重放（新 seq）不重复提醒。
  r.emit(session, { type: 'tool/call', seq: 2, data: { callId: 'call-1', name: 'ask_user_question', arguments: argumentsText } })
  assert.equal(r.messages.length, 1)

  // 插件自有 ask_user：remote 由 questions 桥的卡片/编号回复负责，这条只补本机提醒。
  r.emit(session, { type: 'tool/call', seq: 3, data: { callId: 'call-2', name: 'ask_user', arguments: '{}' } })
  assert.equal(r.messages.length, 2)
  assert.equal(r.calls[1].category, 'session.survey')
  assert.equal(r.calls[1].localOnly, true)

  // 其他工具 / tool/result 都不产生 survey 通知。
  r.emit(session, { type: 'tool/call', seq: 4, data: { callId: 'call-3', name: 'bash', arguments: '{}' } })
  r.emit(session, { type: 'tool/result', seq: 5, data: { callId: 'call-1', message: {} } })
  assert.equal(r.messages.length, 2)
})

test('survey：缺 callId 的 tool/call 不推送', () => {
  const r = rig()
  const session = makeSession('survey-s2')
  r.emit(session, { type: 'tool/call', seq: 1, data: { name: 'ask_user_question', arguments: '{}' } })
  r.emit(session, { type: 'tool/call', seq: 2, data: { callId: '', name: 'ask_user_question', arguments: '{}' } })
  assert.equal(r.messages.length, 0)
})

test('sessionTitle：wiring getter 抛错/缺失时回落 session.title、header.title、null', () => {
  const cases = [
    { wiring: { sessionTitleOf: () => { throw new Error('title service down') } }, session: makeSession('t1', { title: 'session-title' }), expected: 'session-title' },
    { wiring: {}, session: makeSession('t2', { header: { cwd: '/tmp/ws', title: 'header-title' } }), expected: 'header-title' },
    { wiring: {}, session: makeSession('t3'), expected: null },
  ]
  for (const { wiring, session, expected } of cases) {
    const r = rig({}, wiring)
    r.emit(session, { type: 'approval/asked', seq: 1, data: {} })
    assert.equal(r.messages.length, 1, '标题读取失败绝不能丢通知')
    assert.equal(r.calls[0].sessionTitle, expected)
  }
})

// ---------------------------------------------------------------- approval/survey false-positive settle

test('approval 假阳性防护：asked 后立即 decided 不推送；没有 decided 才在延迟后推送', async () => {
  const r = rig({}, { lifecycleSettleMs: 20 })
  const session = makeSession('ap-settle')
  r.emit(session, { type: 'approval/asked', seq: 1, data: { id: 'ap-1', toolName: 'bash' } })
  r.emit(session, { type: 'approval/decided', seq: 2, data: { id: 'ap-1', outcome: 'rejected' } })
  await tick(40)
  assert.equal(r.messages.length, 0, 'policy=never/abort 的秒决审批从未真正等待，不通知')

  r.emit(session, { type: 'approval/asked', seq: 3, data: { id: 'ap-2', toolName: 'bash' } })
  assert.equal(r.messages.length, 0, '短延迟窗口内不推送')
  await tick(40)
  assert.equal(r.messages.length, 1, '窗口后仍无 decided → 真实等待，推送')
  assert.equal(r.calls[0].category, 'session.approval')

  // decided 晚到只取消待决定时器，不回撤已送达的通知。
  r.emit(session, { type: 'approval/decided', seq: 4, data: { id: 'ap-2', outcome: 'allowed-once' } })
  assert.equal(r.messages.length, 1)
})

test('survey 假阳性防护：tool/call 后立即 tool/result 不推送；没有结果才在延迟后推送', async () => {
  const r = rig({}, { lifecycleSettleMs: 20 })
  const session = makeSession('survey-settle')
  const call = (seq, callId) => ({ type: 'tool/call', seq, data: { callId, name: 'ask_user_question', arguments: '{}' } })
  const result = (seq, callId) => ({ type: 'tool/result', seq, data: { message: { toolCallId: callId } } })

  r.emit(session, call(1, 'c1'))
  r.emit(session, result(2, 'c1'))
  await tick(40)
  assert.equal(r.messages.length, 0, '没有进入等待的提问不通知')

  r.emit(session, call(3, 'c2'))
  await tick(40)
  assert.equal(r.messages.length, 1, '真实等待在窗口后推送')
  assert.equal(r.calls[0].category, 'session.survey')

  // 自有 ask_user 同样适用：即时 tool/result 取消，真实等待只发本机。
  r.emit(session, { type: 'tool/call', seq: 4, data: { callId: 'c3', name: 'ask_user', arguments: '{}' } })
  r.emit(session, result(5, 'c3'))
  await tick(40)
  assert.equal(r.messages.length, 1, '自有 ask_user 秒回不 notify')
  r.emit(session, { type: 'tool/call', seq: 6, data: { callId: 'c4', name: 'ask_user', arguments: '{}' } })
  await tick(40)
  assert.equal(r.messages.length, 2)
  assert.equal(r.calls[1].localOnly, true, '自有 ask_user 的远端流程归 questions 桥')
})

test('dispose 会 flush 未到期的待决提醒（进程退出前不丢真实等待）', async () => {
  const r = rig({}, { lifecycleSettleMs: 60000 })
  r.emit(makeSession('ap-dispose'), { type: 'approval/asked', seq: 1, data: { id: 'ap-9', toolName: 'bash' } })
  assert.equal(r.messages.length, 0)
  await r.dispose()
  assert.equal(r.messages.length, 1, 'dispose flush 待决审批提醒')
})

test('timed 提问 pending 结果保留提醒；随后回答或普通答案才取消', async () => {
  const r = rig({}, { lifecycleSettleMs: 30 })
  const session = makeSession('survey-pending')
  const call = (seq, callId) => ({ type: 'tool/call', seq, data: { callId, name: 'ask_user_question', arguments: '{}' } })
  const pendingResult = (seq, callId) => ({
    type: 'tool/result',
    seq,
    data: { message: { toolCallId: callId, content: [{ type: 'text', text: JSON.stringify({ pending: true, callId, message: 'still answerable' }) }] } },
  })

  r.emit(session, call(1, 'p1'))
  r.emit(session, pendingResult(2, 'p1')) // timeout=1 在 1500ms 前返回 pending
  await tick(60)
  assert.equal(r.messages.length, 1, 'pending 结果不是结算，提醒照发')

  // pending 之后用户回答：user-question-reply 同 callId 取消门口提醒。
  r.emit(session, call(3, 'p2'))
  r.emit(session, {
    type: 'user/message',
    seq: 4,
    data: { source: { kind: 'user-question-reply', callId: 'p2', outcome: 'answered' } },
  })
  await tick(60)
  assert.equal(r.messages.length, 1, '回答到达即取消')

  // 普通答案批（非 pending）仍是结算。
  r.emit(session, call(5, 'p3'))
  r.emit(session, {
    type: 'tool/result',
    seq: 6,
    data: { message: { toolCallId: 'p3', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q', selected: ['yes'] }] }) }] } },
  })
  await tick(60)
  assert.equal(r.messages.length, 1, '普通答案取消')

  // 结果未知（TOOL_OUTCOME_UNKNOWN）与宿主 projection 同口径，按仍可回答处理。
  r.emit(session, call(7, 'p4'))
  r.emit(session, {
    type: 'tool/result',
    seq: 8,
    data: { error: { code: 'TOOL_OUTCOME_UNKNOWN' }, message: { toolCallId: 'p4', content: [] } },
  })
  await tick(60)
  assert.equal(r.messages.length, 2, '结果未知不取消提醒')
})

test('ownsRemoteAttention：只询问 approval/survey；true 时 localOnly；异常/未定义按不归属', () => {
  const seen = []
  const r = rig({}, {
    ownsRemoteAttention: (intent) => {
      seen.push(intent.category)
      return intent.category === 'session.approval'
    },
  })
  const session = makeSession('owns-1')
  r.emit(session, todoEvent(1, [{ content: 'A', status: 'pending' }]))
  r.emit(session, todoEvent(2, [{ content: 'A', status: 'completed' }]))
  r.emit(session, { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } })
  r.emit(session, { type: 'tool/call', seq: 2, data: { callId: 'c1', name: 'ask_user_question', arguments: '{}' } })
  assert.deepEqual(seen, ['session.approval', 'session.survey'], 'todo 不查询远端归属')
  assert.equal(r.calls.find((call) => call.category === 'session.approval').localOnly, true)
  assert.equal(r.calls.find((call) => call.category === 'session.survey').localOnly, undefined)

  for (const owning of [() => undefined, () => false, () => { throw new Error('route down') }]) {
    const rigged = rig({}, { ownsRemoteAttention: owning })
    rigged.emit(makeSession('owns-2'), { type: 'approval/asked', seq: 1, data: { toolName: 'bash' } })
    assert.equal(rigged.messages.length, 1, '归属查询失败绝不能丢通知')
    assert.equal(rigged.calls[0].localOnly, undefined)
  }
})

// ---------------------------------------------------------------- status action-card gate

function fakeTimers(startMs = 1_000_000) {
  let seq = 0
  let nowMs = startMs
  const timers = new Map()
  return {
    now: () => nowMs,
    advance(ms) {
      nowMs += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= nowMs)
        if (due.length === 0) break
        for (const [id, timer] of due) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    setTimeoutFn(fn, ms) {
      seq += 1
      timers.set(seq, { at: nowMs + ms, fn })
      return seq
    },
    clearTimeoutFn(id) {
      timers.delete(id)
    },
  }
}

function stallRig({ canSendRemote, suppressed = [] }) {
  const warnings = []
  const calls = []
  const minted = []
  const cards = []
  const timers = fakeTimers()
  let notifyResolve
  const notifier = {
    notifyAll: async (message, options = {}) => {
      calls.push({ message, options })
      await new Promise((resolve) => { notifyResolve = resolve })
      return { ok: true, delivered: ['desktop'], failed: [], ...(suppressed.length > 0 ? { suppressed } : {}) }
    },
    flush: async () => {},
  }
  if (canSendRemote !== undefined) notifier.canSendRemote = canSendRemote
  const dispatcher = {
    mintAction: (kind, payload) => {
      minted.push({ kind, payload })
      return { key: `act:${kind}:dead`, token: 'tok.sig' }
    },
    markSource() {},
    unmarkSource() {},
  }
  const rawChannel = {
    channel: 'telegram',
    notifyTargets: () => [{ chatId: '10086', userId: 'u1' }],
    sendActionCard: async (payload) => { cards.push(payload); return { messageId: 'm1' } },
  }
  const { ctx, listeners } = fakeCtx(warnings)
  const dispose = createEventListener(ctx, notifier, {
    enabled: true, debounceMs: 0, summaryMaxChars: 100, titlePrefix: '',
    events: {
      turnStart: { enabled: false },
      turnEnd: { enabled: true, kinds: {} }, approval: true, agentError: true,
      longRunning: { enabled: false, firstAfterMs: 900_000, everyMs: 900_000 },
      stall: { enabled: true, afterMs: 600_000 },
    },
  }, {
    actions: () => dispatcher,
    interactive: () => [rawChannel],
    trackerOverrides: { now: timers.now, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn, minMs: 1 },
  })
  const emit = (session, event) => listeners['session/event'][0](session, event)
  return {
    emit, timers, dispose, warnings, calls, minted, cards,
    release: () => { notifyResolve?.() },
  }
}

test('stall 卡片闸：canSendRemote=false 时不铸造；通知 settled 后才决定；suppressed 时不重复远端', async () => {
  // 1) 用户静音/仅本机：不 mint、不外发，但文本通知照发。
  {
    const r = stallRig({ canSendRemote: () => false })
    r.emit(makeSession('stall-muted'), { type: 'turn/start', seq: 1 })
    r.timers.advance(600_000)
    await tick(5)
    assert.equal(r.calls.length, 1, '文本通知仍交给包装器判定')
    assert.equal(r.calls[0].options.category, 'session.status')
    assert.equal(r.calls[0].options.sessionId, 'stall-muted')
    assert.equal(r.minted.length, 0, 'canSendRemote=false 绝不铸远端 token')
    assert.equal(r.cards.length, 0)
    r.release()
    await tick(5)
    assert.equal(r.minted.length, 0)
    r.dispose()
  }
  // 2) desktop 已兜住远端（suppressed 非空）：不再发远端卡片。
  {
    const r = stallRig({ canSendRemote: () => true, suppressed: ['telegram'] })
    r.emit(makeSession('stall-suppressed'), { type: 'turn/start', seq: 1 })
    r.timers.advance(600_000)
    await tick(5)
    assert.equal(r.minted.length, 0, '通知结果 suppressed 非空 → 不铸造')
    r.release()
    await tick(5)
    assert.equal(r.minted.length, 0)
    r.dispose()
  }
  // 3) 仍允许远端且未被抑制：通知 settled 后才铸造卡片。
  {
    const r = stallRig({ canSendRemote: (options) => {
      assert.equal(options.category, 'session.status')
      return true
    } })
    r.emit(makeSession('stall-open'), { type: 'turn/start', seq: 1 })
    r.timers.advance(600_000)
    await tick(5)
    assert.equal(r.calls.length, 1)
    assert.equal(r.minted.length, 0, '通知未 settle 前不铸造')
    r.release()
    await tick(5)
    assert.equal(r.minted.length, 1)
    assert.deepEqual(r.minted[0].payload, { sessionId: 'stall-open' })
    assert.equal(r.cards.length, 1)
    assert.equal(r.cards[0].actions[0].label, '⏹ 停止任务')
    r.dispose()
  }
})
