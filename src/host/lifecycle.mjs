// dsh-notifier host/lifecycle.mjs
// DSH 生命周期通知的纯映射层：把已安装宿主真实发布的 session/event 载荷
// 映射为自动通知 intent（不订阅、不发送、不持有宿主对象）。
//
// 宿主证据（已安装 DSH 0.2.2-rc.3，app.asar 源码，2026-11-19 核验）：
//  - `@deepseek-ai/dsh-session/src/known-event-types.ts` 声明 `todo/write`、
//    `goal/change`、`approval/asked`、`approval/decided`。
//  - `@deepseek-ai/dsh-tool-todo/src/types.ts`：`todo/write` 是整表快照
//    `{ todos: [{ content, status: 'pending'|'in_progress'|'completed' }] }`。
//    无条目 id、无 cancelled/paused 状态；「取消」只能表现为上一条列表中存在、
//    新列表中消失，「暂停」只能表现为 in_progress → pending 回退。
//  - `@deepseek-ai/dsh-goal/src/domain.ts`：`goal/change` 是完整快照
//    `{ kind, version, operation, goal, roundsStarted, createdAt, updatedAt }`，
//    operation ∈ create/edit/pause/resume/complete/block/clear；clear 为
//    `{ operation: 'clear', cleared: { id, revision }, clearedAt }`。
//    没有独立的 cancelled 操作，清除（clear）是唯一取消语义。
//  - `@deepseek-ai/dsh-user-approval/src/types.ts`：`approval/asked`
//    为 `{ id, toolName, callId?, reason? }`。
//  - 宿主没有 survey 事件。原生提问是 `ask_user_question`
//    （@deepseek-ai/dsh-tool-ask-user → ctx.userQuestions.ask() →
//    `user-questions/request` waterfall）。这里只被动观察 `tool/call`
//    （name === 'ask_user_question'），不挂 waterfall、不参与回答链。
//
// 设计约束：
//  - 纯函数 + 有界状态（会话数上限），缺失/畸形载荷返回 invalid 而不是抛错；
//  - 未变化的快照不产生通知，因此宿主重放同一事件不会重复打扰；
//  - 条目正文只做有界、去控制字符的短摘录，完整内容仍走既有脱敏/截断链。

const isRecord = (value) => typeof value === 'object' && value !== null

/** 与 event-listener 的 dedup/文案边界一致：条目摘录上限（码点）。 */
const MAX_ITEM_CHARS = 80
const MAX_OBJECTIVE_CHARS = 120
const MAX_LISTED_ITEMS = 3
const MAX_TRACKED_SESSIONS = 256
/** 作为 diff 身份保存的 content 上限（防止畸形超长条目撑爆有界状态）。 */
const MAX_STORED_CHARS = 500
/** 单个会话快照的条目上限（宿主正常列表远小于此；超出按畸形拒绝，不截断造幻影）。 */
const MAX_TODO_ITEMS = 100

const CONTROL_AND_DIRECTION = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g

/** 单行化 + 去控制/方向字符（不截断；保留完整身份文本）。 */
function cleanText(value) {
  if (typeof value !== 'string') return ''
  return value
    .toWellFormed()
    .replace(CONTROL_AND_DIRECTION, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 码点截断（不拆 emoji）。 */
function clipText(text, maxChars) {
  const chars = Array.from(text)
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : text
}

/** 单行化 + 码点截断（通知展示用）。 */
function cleanLine(value, maxChars = MAX_ITEM_CHARS) {
  return clipText(cleanText(value), maxChars)
}

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/**
 * 校验并归一 `todo/write` 的 todos 数组。
 * 宿主侧保证 content 非空唯一、status 三值；任何一条畸形都整表拒绝（返回 null），
 * 避免用不完整列表做 diff 造成幻影「取消」。空数组是合法快照（计划被清空）。
 * @returns {Array<{content: string, status: string}> | null}
 */
export function normalizeTodoList(value) {
  if (!Array.isArray(value)) return null
  if (value.length > MAX_TODO_ITEMS) return null
  const list = []
  const seen = new Set()
  for (const raw of value) {
    if (!isRecord(raw)) return null
    const content = clipText(cleanText(raw.content), MAX_STORED_CHARS)
    const status = typeof raw.status === 'string' ? raw.status : ''
    if (content === '' || !TODO_STATUSES.has(status)) return null
    if (seen.has(content)) return null
    seen.add(content)
    list.push({ content, status })
  }
  return list
}

/**
 * 比较前后两份 todo 快照，返回各生命周期转移。
 * previous === null 表示本进程尚未见过该会话的列表（首写）：所有条目计入 added，
 * 归入 `todo.changed`，默认关闭，不打扰。
 * @param {Array<{content: string, status: string}> | null} previous
 * @param {Array<{content: string, status: string}>} next
 */
export function diffTodoLists(previous, next) {
  const previousMap = new Map((previous ?? []).map((item) => [item.content, item.status]))
  const nextMap = new Map(next.map((item) => [item.content, item.status]))
  const diff = { added: [], started: [], completed: [], cancelled: [], paused: [], reopened: [] }
  for (const item of next) {
    const before = previousMap.get(item.content)
    if (before === undefined) {
      diff.added.push(item.content)
      continue
    }
    if (before === item.status) continue
    if (item.status === 'completed') diff.completed.push(item.content)
    else if (before === 'completed') diff.reopened.push(item.content)
    else if (item.status === 'in_progress') diff.started.push(item.content)
    else diff.paused.push(item.content) // in_progress → pending
  }
  for (const [content, status] of previousMap) {
    if (nextMap.has(content)) continue
    // 已完成条目从列表移除只是清单收敛，不是「取消」。
    if (status !== 'completed') diff.cancelled.push(content)
  }
  return diff
}

/** 转移 → 类别；优先级：完成 > 取消 > 暂停 > 变更。 */
export function todoCategoryOf(diff) {
  if (diff.completed.length > 0) return 'todo.completed'
  if (diff.cancelled.length > 0) return 'todo.cancelled'
  if (diff.paused.length > 0) return 'todo.paused'
  if (diff.added.length > 0 || diff.started.length > 0 || diff.reopened.length > 0) return 'todo.changed'
  return undefined
}

/** 有界会话状态：sessionId -> 最近一次 todo 列表。 */
export function createTodoLifecycleState(maxEntries = MAX_TRACKED_SESSIONS) {
  const cap = Math.max(1, Math.trunc(Number(maxEntries)) || MAX_TRACKED_SESSIONS)
  const lists = new Map()
  const touch = (sessionId) => {
    const previous = lists.get(sessionId)
    lists.delete(sessionId)
    return previous
  }
  return {
    /** 取旧快照并提升为最近使用；无记录返回 null。 */
    peek(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return lists.has(sessionId) ? lists.get(sessionId) : null
    },
    /** 记录最新快照，超上限淘汰最久未使用者。 */
    set(sessionId, list) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      touch(sessionId)
      lists.set(sessionId, list)
      while (lists.size > cap) {
        const oldest = lists.keys().next().value
        if (oldest === undefined) break
        lists.delete(oldest)
      }
    },
    size() {
      return lists.size
    },
  }
}

/** 有界目标状态：sessionId -> 最近已见 goal 修订（防同一快照重复通知）。 */
export function createGoalLifecycleState(maxEntries = MAX_TRACKED_SESSIONS) {
  const cap = Math.max(1, Math.trunc(Number(maxEntries)) || MAX_TRACKED_SESSIONS)
  const seen = new Map()
  return {
    /** 记录并返回该修订是否首次出现。 */
    record(sessionId, revisionKey) {
      if (typeof sessionId !== 'string' || sessionId === '' || typeof revisionKey !== 'string') return true
      const previous = seen.get(sessionId)
      if (previous === revisionKey) return false
      seen.delete(sessionId)
      seen.set(sessionId, revisionKey)
      while (seen.size > cap) {
        const oldest = seen.keys().next().value
        if (oldest === undefined) break
        seen.delete(oldest)
      }
      return true
    },
    size() {
      return seen.size
    },
  }
}

// ---- 文案（zh/en；lang 未知值回落 zh，与 stringsOf 同规则） ----

const ZH = Object.freeze({
  todo: {
    headline: {
      'todo.completed': '✅ 待办完成',
      'todo.cancelled': '🗑 待办取消',
      'todo.changed': '📝 待办更新',
      'todo.paused': '⏸ 待办暂停',
    },
    completed: (items) => `完成：${items}`,
    cancelled: (items) => `取消：${items}`,
    paused: (items) => `暂停：${items}`,
    changed: (parts) => parts.join('；'),
    added: (n) => `新增 ${n} 项`,
    started: (n) => `开始 ${n} 项`,
    reopened: (n) => `重新打开 ${n} 项`,
    more: (n) => `等 ${n} 项`,
    separator: '、',
  },
  goal: {
    headline: {
      'goal.completed': '🎯 目标完成',
      'goal.cancelled': '🎯 目标已取消',
      'goal.changed': '🎯 目标更新',
      'goal.paused': '⏸ 目标暂停',
    },
    objective: (text) => `目标：${text}`,
    phase: (phase) => `阶段：${phase}`,
    rounds: (n) => `已开始轮次：${n}`,
    blocked: (reason) => `受阻原因：${reason}`,
    cleared: () => '当前目标已清除',
    phaseLabel: { active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成' },
  },
  survey: {
    headline: '❓ 需要你回答',
    detail: '有一个问题在等待你的回答，请回到会话处理。',
  },
})

const EN = Object.freeze({
  todo: {
    headline: {
      'todo.completed': '✅ Todo completed',
      'todo.cancelled': '🗑 Todo cancelled',
      'todo.changed': '📝 Todos updated',
      'todo.paused': '⏸ Todo paused',
    },
    completed: (items) => `Completed: ${items}`,
    cancelled: (items) => `Cancelled: ${items}`,
    paused: (items) => `Paused: ${items}`,
    changed: (parts) => parts.join('; '),
    added: (n) => `${n} added`,
    started: (n) => `${n} started`,
    reopened: (n) => `${n} reopened`,
    more: (n) => `and ${n} more`,
    separator: ', ',
  },
  goal: {
    headline: {
      'goal.completed': '🎯 Goal completed',
      'goal.cancelled': '🎯 Goal cancelled',
      'goal.changed': '🎯 Goal updated',
      'goal.paused': '⏸ Goal paused',
    },
    objective: (text) => `Objective: ${text}`,
    phase: (phase) => `Phase: ${phase}`,
    rounds: (n) => `Rounds started: ${n}`,
    blocked: (reason) => `Blocked: ${reason}`,
    cleared: () => 'The current goal was cleared',
    phaseLabel: { active: 'active', paused: 'paused', blocked: 'blocked', complete: 'complete' },
  },
  survey: {
    headline: '❓ Question needs your input',
    detail: 'A question is waiting for your answer. Return to the session to respond.',
  },
})

/** lang 归一：未知值回落 zh（与 strings.mjs 同口径，own-property 校验）。 */
export function lifecycleStrings(lang) {
  return lang === 'en' ? EN : ZH
}

// ---- intent 构造 ----

function listed(items, strings) {
  const shown = items.slice(0, MAX_LISTED_ITEMS).map((item) => clipText(item, MAX_ITEM_CHARS))
  const text = shown.join(strings.todo.separator)
  return items.length > shown.length ? `${text}（${strings.todo.more(items.length - shown.length)}）` : text
}

function todoDetailOf(category, diff, strings) {
  switch (category) {
    case 'todo.completed': return strings.todo.completed(listed(diff.completed, strings))
    case 'todo.cancelled': return strings.todo.cancelled(listed(diff.cancelled, strings))
    case 'todo.paused': return strings.todo.paused(listed(diff.paused, strings))
    default: {
      const parts = []
      if (diff.added.length > 0) parts.push(strings.todo.added(diff.added.length))
      if (diff.started.length > 0) parts.push(strings.todo.started(diff.started.length))
      if (diff.reopened.length > 0) parts.push(strings.todo.reopened(diff.reopened.length))
      return strings.todo.changed(parts)
    }
  }
}

const TODO_LEVEL = {
  'todo.completed': 'active',
  'todo.cancelled': 'passive',
  'todo.changed': 'passive',
  'todo.paused': 'passive',
}

/**
 * 把一条 `todo/write` 映射为 intent。
 * @param {ReturnType<typeof createTodoLifecycleState>} state
 * @param {string} sessionId
 * @param {object} event - 宿主 session/event
 * @param {object} [strings] - lifecycleStrings(...)
 * @returns {{ intent?: object, invalid?: true } | undefined}
 *   非 todo/write 返回 undefined；畸形载荷返回 { invalid: true }（状态不前进）；
 *   无生命周期转移返回 {}。
 */
export function mapTodoEvent(state, sessionId, event, strings = ZH) {
  if (event?.type !== 'todo/write') return undefined
  const list = normalizeTodoList(event?.data?.todos)
  if (list === null) return { invalid: true }
  const previous = state.peek(sessionId)
  const diff = diffTodoLists(previous, list)
  state.set(sessionId, list)
  const category = todoCategoryOf(diff)
  if (category === undefined) return {}
  return {
    intent: {
      event: 'todo/write',
      kind: category,
      category,
      headline: strings.todo.headline[category],
      level: TODO_LEVEL[category],
      detail: todoDetailOf(category, diff, strings),
    },
  }
}

// DSH goal 没有独立的「取消」操作：clear（清空 tombstone）是唯一取消语义。
// block 归入 goal.paused（类别词表没有 goal.blocked）；默认送达策略由会话通知
// 设置矩阵决定——产品默认 pause/block 不打扰，用户可在设置里把 goal.paused 打开。
const GOAL_OPERATION_CATEGORY = {
  complete: 'goal.completed',
  clear: 'goal.cancelled',
  pause: 'goal.paused',
  block: 'goal.paused',
  create: 'goal.changed',
  edit: 'goal.changed',
  resume: 'goal.changed',
}

const GOAL_CATEGORY_LEVEL = {
  'goal.completed': 'active',
  'goal.cancelled': 'passive',
  'goal.changed': 'passive',
  'goal.paused': 'passive',
}

/**
 * 把一条 `goal/change` 映射为 intent。畸形载荷返回 invalid 且不推进去重状态；
 * 同一 goal 修订（含 clear tombstone）只通知一次。
 * @returns {{ intent?: object, invalid?: true } | undefined}
 */
export function mapGoalEvent(state, sessionId, event, strings = ZH) {
  if (event?.type !== 'goal/change') return undefined
  const data = event?.data
  if (!isRecord(data) || typeof data.operation !== 'string') return { invalid: true }
  const category = GOAL_OPERATION_CATEGORY[data.operation]
  if (category === undefined) return { invalid: true }

  let revisionKey
  let lines = []
  if (data.operation === 'clear') {
    const cleared = data.cleared
    if (!isRecord(cleared) || cleared.id === undefined || cleared.revision === undefined) return { invalid: true }
    revisionKey = `clear:${String(cleared.id)}:${String(cleared.revision)}`
    lines = [strings.goal.cleared()]
  } else {
    const goal = data.goal
    if (!isRecord(goal) || goal.id === undefined || goal.revision === undefined) return { invalid: true }
    if (typeof goal.objective !== 'string' || goal.objective.trim() === '') return { invalid: true }
    if (!['active', 'paused', 'blocked', 'complete'].includes(goal.phase)) return { invalid: true }
    revisionKey = `goal:${String(goal.id)}:${String(goal.revision)}`
    lines = [strings.goal.objective(cleanLine(goal.objective, MAX_OBJECTIVE_CHARS))]
    const phaseLabel = strings.goal.phaseLabel[goal.phase] ?? goal.phase
    lines.push(strings.goal.phase(phaseLabel))
    if (Number.isSafeInteger(data.roundsStarted) && data.roundsStarted > 0) {
      lines.push(strings.goal.rounds(data.roundsStarted))
    }
    const reason = goal.blockedReason
    if (isRecord(reason) && typeof reason.message === 'string' && reason.message.trim() !== '') {
      lines.push(strings.goal.blocked(cleanLine(reason.message, MAX_OBJECTIVE_CHARS)))
    }
  }

  if (state.record(sessionId, revisionKey) === false) return {}
  // blocked 是需要人介入的停滞；pause 是用户自己的动作，保持被动。
  const level = data.operation === 'block' ? 'timeSensitive' : GOAL_CATEGORY_LEVEL[category]
  return {
    intent: {
      event: 'goal/change',
      kind: data.operation,
      category,
      headline: strings.goal.headline[category],
      level,
      detail: lines.filter((line) => typeof line === 'string' && line !== '').join('\n'),
    },
  }
}

/**
 * `tool/call` 里被接受的 survey 等待信号：官方 `ask_user_question` 与插件自有 `ask_user`。
 * 不读、不回显 arguments（只报「有一个问题在等待」），避免把提问正文带进通知。
 * 插件自有 `ask_user` 的远程提问由 questions 桥的卡片/编号回复负责，这条通知只补本机
 * 提醒（`localOnly: true`），不让同一问题在远端重复出现；官方工具没有本插件的桥，
 * 按普通会话通知策略投放。
 * @returns {object | undefined} intent
 */
export function intentOfSurveyToolCall(event, strings = ZH) {
  if (event?.type !== 'tool/call') return undefined
  const data = event?.data
  if (!isRecord(data)) return undefined
  if (data.name !== 'ask_user_question' && data.name !== 'ask_user') return undefined
  if (typeof data.callId !== 'string' || data.callId === '') return undefined
  return {
    event: 'tool/call',
    kind: 'survey',
    category: 'session.survey',
    headline: strings.survey.headline,
    level: 'timeSensitive',
    detail: strings.survey.detail,
    ...(data.name === 'ask_user' ? { localOnly: true } : {}),
  }
}

// ---- 类别 ----

/**
 * 生命周期类别只作为 notify 策略矩阵的键名；是否送达、送到 overlay/system/remote
 * 由 `src/control-surface/session-notifications.mjs` 单独裁决。事件层不再保留第二套
 * 默认或显式开关，避免两套权威互相覆盖。
 */

/** 基线自动事件的类别（供 event-listener 统一透传 session 元数据）。 */
export const BASELINE_CATEGORIES = Object.freeze({
  TURN_START: 'session.started',
  TURN_COMPLETED: 'session.completed',
  TURN_ERROR: 'session.error',
  TURN_CANCELLED: 'session.cancelled',
  APPROVAL: 'session.approval',
  AGENT_ERROR: 'session.error',
  STATUS: 'session.status',
})
