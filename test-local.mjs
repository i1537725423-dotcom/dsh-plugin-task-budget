/**
 * 本地自测：不启动 DSH，用假 ctx / 假 HTTP 请求验证记账、拦截、设置接口。
 * 运行：<bundled node> test-local.mjs
 */
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import { apply, HTTP_PREFIX, HTTP_HEADER } from './index.js'

/* 测试用临时状态文件，别动插件目录里的真 state.json */
const STATE_FILE = `/tmp/task-budget-test-${process.pid}.json`

let caseCount = 0
function check(label, actual, expected) {
  caseCount += 1
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} → ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`)
  if (!ok) process.exitCode = 1
}

await fsp.rm(STATE_FILE, { force: true })

const listeners = new Map()
let routeHandler
const fakeWeb = {
  getOrigin: () => 'http://127.0.0.1:62644',
  register: (route) => {
    routeHandler = route.handler
    return () => {}
  },
}
const ctx = {
  get: (name) => (name === 'webServer' ? fakeWeb : undefined),
  on: (name, fn) => {
    const list = listeners.get(name) || []
    list.push(fn)
    listeners.set(name, list)
    return () => {}
  },
  effect: (fn) => {
    fn()
    return () => {}
  },
}

apply(ctx, { enabled: true, limitCny: 5, stateFile: STATE_FILE, diag: false })
await new Promise((resolve) => setTimeout(resolve, 50))

function emit(name, ...args) {
  for (const fn of listeners.get(name) || []) fn(...args)
}

function makeReq({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  process.nextTick(() => {
    if (body) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function callRoute(options) {
  return new Promise((resolve) => {
    const req = makeReq(options)
    const res = {
      statusCode: 0,
      _headers: {},
      setHeader(name, value) {
        this._headers[name] = value
      },
      end(text) {
        resolve({ status: this.statusCode, body: text ? JSON.parse(text) : null })
      },
    }
    routeHandler(req, res)
  })
}

const session = { id: 'session-1' }
const AUTH = { [HTTP_HEADER]: '1', host: '127.0.0.1:62644' }

/* 1. 开一轮；高峰时段（周三 10:00 北京时间）打一发 1M 输入 + 100K 输出 */
const peak = Date.UTC(2026, 9, 28, 2, 0, 0) // 2026-10-28 10:00 北京时间（周三）
emit('session/event', session, { type: 'turn/start', seq: 1, time: peak, data: { turn: 1 } })
emit('session/event', session, {
  type: 'assistant/message',
  seq: 2,
  time: peak,
  data: {
    turn: 1,
    step: 1,
    message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
  },
})

let state = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state?session=session-1`, headers: AUTH })
check('高峰价：1M 输入（未命中 ¥2）+ 100K 输出（¥8/M）', state.body.state.spent, 2.8)
check('未超限', state.body.state.exceeded, false)

/* 2. 没超限时 llm/stream 放行 */
let passed = false
emit('llm/stream', { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'session-1' }, () => {
  passed = true
  return []
})
check('llm/stream 未超限放行', passed, true)

/* 3. 再打一发，累计超过 5 元 */
emit('session/event', session, {
  type: 'assistant/message',
  seq: 3,
  time: peak,
  data: {
    turn: 1,
    step: 2,
    message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
  },
})
state = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state?session=session-1`, headers: AUTH })
check('累计 2.8 + 2 + 8 = 12.8', state.body.state.spent, 12.8)
check('已超限', state.body.state.exceeded, true)

/* 4. 超限后 pre-step 拒绝、llm/stream 抛出 */
let preStepDecision = null
emit('agent/pre-step', { agent: { id: 'session-1' }, messages: [], turn: 1, step: 3 }, () => ({
  kind: 'enter',
  messages: [],
}))
for (const fn of listeners.get('agent/pre-step') || []) {
  const decision = fn({ agent: { id: 'session-1' }, messages: [], turn: 1, step: 3 }, () => ({
    kind: 'enter',
    messages: [],
  }))
  if (decision && decision.kind === 'reject') preStepDecision = decision
}
check('pre-step 拒绝下一步', preStepDecision, { kind: 'reject' })

let threw = null
try {
  emit('llm/stream', { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'session-1' }, () => [])
} catch (error) {
  threw = error
}
check('llm/stream 抛出超限错误', Boolean(threw && threw.code === 'TASK_BUDGET_EXCEEDED'), true)
check('错误文案含上限', /¥5\.00/.test(String(threw && threw.message)), true)

/* 5. 压缩/标题调用不拦 */
let purposePassed = false
emit('llm/stream', { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'session-1', purpose: 'compaction' }, () => {
  purposePassed = true
  return []
})
check('purpose 调用放行', purposePassed, true)

/* 6. 新一轮重置累计 */
emit('session/event', session, { type: 'turn/start', seq: 4, time: peak, data: { turn: 2 } })
state = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state?session=session-1`, headers: AUTH })
check('新一轮累计归零', state.body.state.spent, 0)

/* 7. 改设置：关掉开关、上限 3 元 */
const saved = await callRoute({
  method: 'POST',
  url: `${HTTP_PREFIX}/config?session=session-1`,
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: false, limitCny: 3 }),
})
check('接口返回新状态', saved.body.state.enabled, false)
check('接口返回新上限', saved.body.state.limitCny, 3)
const onDisk = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
check('state.json 落盘', { enabled: onDisk.enabled, limitCny: onDisk.limitCny }, { enabled: false, limitCny: 3 })

/* 8. 关掉后即使超限也放行 */
emit('session/event', session, {
  type: 'assistant/message',
  seq: 5,
  time: peak,
  data: {
    turn: 2,
    step: 1,
    message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 5_000_000, outputTokens: 0 },
  },
})
let offPassed = false
emit('llm/stream', { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 'session-1' }, () => {
  offPassed = true
  return []
})
check('开关关闭时放行', offPassed, true)

/* 9. 空闲时段价格（周六）：输入未命中 ¥1/M、输出 ¥4/M */
emit('session/event', session, { type: 'turn/start', seq: 6, time: peak, data: { turn: 3 } })
const weekend = Date.UTC(2026, 9, 31, 4, 0, 0) // 2026-10-31 12:00 北京时间（周六）
emit('session/event', session, {
  type: 'assistant/message',
  seq: 7,
  time: weekend,
  data: {
    turn: 3,
    step: 1,
    message: { source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 500_000 },
  },
})
state = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state?session=session-1`, headers: AUTH })
check('空闲价：0.5M 未命中 ¥1 + 0.5M 命中 ¥0.02 + 1M 输出 ¥4', state.body.state.spent, 4.51)

/* 10. 外部改 state.json，2 秒内同步到本实例（多实例/旧实例一致性） */
await fsp.writeFile(
  STATE_FILE,
  JSON.stringify({ version: 1, enabled: true, limitCny: 2.5, updatedAt: Date.now() }),
  'utf8',
)
await new Promise((resolve) => setTimeout(resolve, 2600))
state = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state?session=session-1`, headers: AUTH })
check('外部改 state.json 后自动同步开关', state.body.state.enabled, true)
check('外部改 state.json 后自动同步上限', state.body.state.limitCny, 2.5)

/* 11. 接口围栏：不带自定义头拒绝 */
const forbidden = await callRoute({ method: 'GET', url: `${HTTP_PREFIX}/state`, headers: { host: '127.0.0.1:62644' } })
check('无自定义头 403', forbidden.status, 403)

await fsp.rm(STATE_FILE, { force: true })
console.log(`\n${caseCount} 项断言完成，退出码 ${process.exitCode || 0}`)
