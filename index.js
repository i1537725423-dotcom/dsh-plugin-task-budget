/**
 * dsh-plugin-task-budget —— 本轮任务花费限额（Host 半）
 *
 * 一句话：给每一轮任务（发一条消息 → 这一轮跑完）设一个人民币上限，默认 5 元；
 * 花到上限就拦在下一个模型请求之前，不让它继续烧钱。
 *
 * 三个职责：
 *  1. 记账：听 `session/event`，按 turn 累计 `assistant/message` 里的 TokenUsage，
 *     用 DeepSeek 官方价目表（高峰/空闲两档）折算成人民币。
 *  2. 拦截：`agent/pre-step` 在下一步进入前拒掉（干净停止）；
 *     `llm/stream` 再兜一道，防止任何路径绕过 pre-step 继续发请求。
 *  3. 对外：在本机 webServer 上挂 /task-budget 接口，给浏览器里的 Client 半
 *     读「本轮已花 / 上限 / 开关」，以及改开关与金额。
 *
 * 价格口径（2026-10-29 核对 api-docs.deepseek.com/zh-cn/quick_start/pricing）：
 *   deepseek-flash     缓存命中 0.04/0.02   缓存未命中 2/1   输出 8/4   元每百万 tokens
 *   deepseek-v4-pro    缓存命中 0.30/0.15   缓存未命中 9/4.5 输出 27/13.5
 *   每格「高峰/空闲」；高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00，
 *   其余（含周末）为空闲。法定节假日未内置，仍按工作日高峰计——只会高估，不会低估。
 *
 * 记账是「按 token 估算」，不是平台出账数字；平台 Search/Fetch 按次计费的部分不计入。
 */

import { promises as fsp } from 'node:fs'
import { rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export const HTTP_PREFIX = '/task-budget'
export const HTTP_HEADER = 'x-dsh-task-budget'

const STATE_VERSION = 1

/**
 * 状态与诊断日志放在 $DSH_HOME/task-budget 下。
 * 不写包目录：从 npm / 市场装进来时那是 node_modules，升级重装就没了。
 */
function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'task-budget')
}

/** 元 / 百万 tokens；[高峰, 空闲]。 */
const DEFAULT_RATES = {
  'deepseek-flash': { hit: [0.04, 0.02], miss: [2, 1], out: [8, 4] },
  'deepseek-v4-pro': { hit: [0.3, 0.15], miss: [9, 4.5], out: [27, 13.5] },
}

const DEFAULT_CONFIG = {
  /** 开关默认值：装好即生效。 */
  enabled: true,
  /** 默认上限：5 元。 */
  limitCny: 5,
  /** 允许按模型微调费率；不写就用 DEFAULT_RATES。 */
  rates: DEFAULT_RATES,
  /** 状态文件路径；留空＝$DSH_HOME/task-budget/state.json。 */
  stateFile: '',
  /** 诊断日志路径；留空＝$DSH_HOME/task-budget/diag.log。 */
  diagFile: '',
  /** 是否写诊断日志。 */
  diag: true,
}

const MAX_ENTRIES = 400
const MIN_LIMIT = 0.01
const MAX_LIMIT = 10000

function resolveConfig(raw) {
  const config = {
    enabled: DEFAULT_CONFIG.enabled,
    limitCny: DEFAULT_CONFIG.limitCny,
    rates: { ...DEFAULT_RATES },
    stateFile: '',
    diagFile: '',
    diag: true,
  }
  if (!raw || typeof raw !== 'object') return config

  if (raw.enabled === false) config.enabled = false
  else if (raw.enabled === true) config.enabled = true
  else if (raw.enabled !== undefined) console.warn('[task-budget] enabled 只认 true/false：', raw.enabled)

  if (Number.isFinite(raw.limitCny)) {
    config.limitCny = clampLimit(raw.limitCny)
  } else if (raw.limitCny !== undefined) {
    console.warn('[task-budget] limitCny 需为数字：', raw.limitCny)
  }

  if (typeof raw.stateFile === 'string' && raw.stateFile.trim()) {
    config.stateFile = raw.stateFile.trim()
  }
  if (typeof raw.diagFile === 'string' && raw.diagFile.trim()) {
    config.diagFile = raw.diagFile.trim()
  }
  if (raw.diag === false) config.diag = false

  if (raw.rates && typeof raw.rates === 'object') {
    for (const [model, value] of Object.entries(raw.rates)) {
      const rate = normalizeRate(value)
      if (rate) config.rates[model] = rate
      else console.warn('[task-budget] 费率格式无效，忽略：', model)
    }
  }
  return config
}

function clampLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_CONFIG.limitCny
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(number * 100) / 100))
}

/** 允许 {hit:[高峰,空闲], miss:[...], out:[...]} 或 {hit:数字,...}（单档＝两档同价）。 */
function normalizeRate(value) {
  if (!value || typeof value !== 'object') return undefined
  const pair = (input) => {
    if (Array.isArray(input) && input.length >= 2) {
      const peak = Number(input[0])
      const off = Number(input[1])
      if (Number.isFinite(peak) && Number.isFinite(off)) return [peak, off]
      return undefined
    }
    const single = Number(input)
    if (Number.isFinite(single)) return [single, single]
    return undefined
  }
  const hit = pair(value.hit)
  const miss = pair(value.miss)
  const out = pair(value.out)
  if (!hit || !miss || !out) return undefined
  return { hit, miss, out }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function readBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    let settled = false
    const chunks = []
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limitBytes) {
        settled = true
        chunks.length = 0
        const error = new Error('请求体过大')
        error.code = 'too-large'
        reject(error)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (!settled) reject(error)
    })
  })
}

function hostnameOf(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopbackHostname(hostname) {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost')
  )
}

/** 自定义头 + Origin/Host 双保险，挡住别的网页顺手调本机接口。 */
function fenceRequest(req, ctx) {
  if (String(req.headers[HTTP_HEADER] ?? '') !== '1') return '缺少本机接口请求头'
  let serverHostname = ''
  try {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.getOrigin === 'function') {
      serverHostname = hostnameOf(webServer.getOrigin())
    }
  } catch {
    /* 拿不到 origin 时只放行 loopback */
  }
  const allowed = (hostname) =>
    Boolean(hostname) && (isLoopbackHostname(hostname) || (serverHostname !== '' && hostname === serverHostname))

  const origin = req.headers.origin
  if (origin !== undefined && String(origin) !== 'null' && !allowed(hostnameOf(String(origin)))) {
    return '请求来源不是本机页面'
  }
  const host = req.headers.host
  if (host !== undefined && !allowed(hostnameOf(String(host)))) {
    return '请求主机与本机监听地址不一致'
  }
  return ''
}

/** 北京时间周一至周五 9-12、14-18 为高峰。 */
function isPeakHour(timeMs) {
  const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = shifted.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

function rateForModel(rates, model) {
  const name = String(model || '')
  if (rates[name]) return rates[name]
  const lower = name.toLowerCase()
  if (lower.includes('pro')) return rates['deepseek-v4-pro'] || DEFAULT_RATES['deepseek-v4-pro']
  return rates['deepseek-flash'] || DEFAULT_RATES['deepseek-flash']
}

/**
 * 一次模型调用的人民币成本（元）。
 * TokenUsage.inputTokens 是本次请求的全部提示 tokens，cacheReadTokens 是其中命中缓存的部分。
 */
function costOfUsage(usage, rates, model, timeMs) {
  if (!usage || typeof usage !== 'object') return 0
  const rate = rateForModel(rates, model)
  const slot = isPeakHour(Number.isFinite(timeMs) ? timeMs : Date.now()) ? 0 : 1
  const inputTokens = Number(usage.inputTokens) || 0
  const cacheRead = Number(usage.cacheReadTokens) || 0
  const cacheWrite = Number(usage.cacheWriteTokens) || 0
  const outputTokens = Number(usage.outputTokens) || 0
  const uncached = Math.max(0, inputTokens - cacheRead)
  const cost =
    (uncached * rate.miss[slot] +
      cacheRead * rate.hit[slot] +
      cacheWrite * rate.miss[slot] +
      outputTokens * rate.out[slot]) /
    1_000_000
  return Number.isFinite(cost) && cost > 0 ? cost : 0
}

function formatCny(value) {
  return Number(value || 0).toFixed(2)
}

/**
 * @param {object} ctx Cordis 上下文
 * @param {object} rawConfig cordis.patch.yml 里该行的 config
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const dir = dataDir()
  const stateFile = config.stateFile || path.join(dir, 'state.json')
  const diagFile = config.diagFile || path.join(dir, 'diag.log')

  /** 轻量诊断日志：挂载、同步、非轮询请求；排查「开关点不动」用。 */
  const diag = (line) => {
    if (config.diag === false) return
    void fsp
      .mkdir(path.dirname(diagFile), { recursive: true })
      .then(() => fsp.appendFile(diagFile, `${new Date().toISOString()} ${line}\n`))
      .catch(() => {})
  }

  /** 运行期可变状态；state.json 里存的是用户改过的值。fileMtime 用于多实例/外部改动同步。 */
  const runtime = { enabled: config.enabled, limitCny: config.limitCny, loaded: false, updatedAt: 0, fileMtime: 0 }
  /** sessionId → { turn, spent, exceeded, updatedAt } */
  const entries = new Map()

  let readyResolve
  const ready = new Promise((resolve) => {
    readyResolve = resolve
  })

  async function loadState() {
    try {
      const stat = await fsp.stat(stateFile)
      runtime.fileMtime = stat.mtimeMs
      const text = await fsp.readFile(stateFile, 'utf8')
      const saved = JSON.parse(text)
      if (saved && typeof saved === 'object') {
        if (saved.enabled === true || saved.enabled === false) runtime.enabled = saved.enabled
        if (Number.isFinite(saved.limitCny)) runtime.limitCny = clampLimit(saved.limitCny)
        runtime.updatedAt = Number(saved.updatedAt) || 0
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn('[task-budget] 读取 state.json 失败，用默认值：', error.message || error)
      }
    } finally {
      runtime.loaded = true
      readyResolve()
    }
  }

  /**
   * state.json 是唯一真源：别的实例（或插件重载前后的旧实例）改了它，
   * 本实例每 2 秒对齐一次，保证「界面上的开关」和「真正拦截的那个实例」不会各说各话。
   */
  async function syncStateFromDisk() {
    try {
      const stat = await fsp.stat(stateFile)
      if (stat.mtimeMs <= runtime.fileMtime) return
      const saved = JSON.parse(await fsp.readFile(stateFile, 'utf8'))
      if (saved && typeof saved === 'object') {
        if (saved.enabled === true || saved.enabled === false) runtime.enabled = saved.enabled
        if (Number.isFinite(saved.limitCny)) runtime.limitCny = clampLimit(saved.limitCny)
        if (Number.isFinite(saved.updatedAt)) runtime.updatedAt = saved.updatedAt
      }
      runtime.fileMtime = stat.mtimeMs
      diag(`state synced from disk: enabled=${runtime.enabled} limit=${runtime.limitCny}`)
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn('[task-budget] 同步 state.json 失败：', error.message || error)
      }
    }
  }

  async function saveState() {
    const payload = {
      version: STATE_VERSION,
      enabled: runtime.enabled,
      limitCny: runtime.limitCny,
      updatedAt: Date.now(),
    }
    runtime.updatedAt = payload.updatedAt
    await fsp.mkdir(path.dirname(stateFile), { recursive: true })
    const temp = `${stateFile}.tmp`
    await fsp.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, stateFile)
    try {
      const stat = await fsp.stat(stateFile)
      runtime.fileMtime = stat.mtimeMs
    } catch {
      runtime.fileMtime = 0
    }
  }

  function entryFor(sessionId, turn) {
    let entry = entries.get(sessionId)
    if (!entry || (Number.isFinite(turn) && entry.turn !== turn)) {
      if (entries.size >= MAX_ENTRIES) {
        const oldest = entries.keys().next()
        if (!oldest.done) entries.delete(oldest.value)
      }
      entry = { turn: Number.isFinite(turn) ? turn : 0, spent: 0, exceeded: false, updatedAt: 0 }
      entries.set(sessionId, entry)
    }
    return entry
  }

  function foldEvent(session, event) {
    if (!session || !event || typeof event.type !== 'string') return
    const sessionId = String(session.id || '')
    if (!sessionId) return
    if (event.type === 'turn/start') {
      entryFor(sessionId, event.data && event.data.turn)
      return
    }
    if (event.type === 'assistant/message') {
      const usage = event.data && event.data.usage
      if (!usage) return
      const source = (event.data.message && event.data.message.source) || {}
      const turn = event.data.turn
      const entry = entryFor(sessionId, turn)
      const cost = costOfUsage(usage, config.rates, source.model, event.time)
      if (cost > 0) entry.spent += cost
      entry.updatedAt = Number(event.time) || Date.now()
    }
  }

  /** pre-step 拒掉下一步：干净停止，不会产生红色报错。 */
  function preStep(payload, next) {
    if (!runtime.enabled) return next()
    const sessionId = payload && payload.agent && payload.agent.id ? String(payload.agent.id) : ''
    const entry = sessionId ? entries.get(sessionId) : undefined
    if (!entry || entry.spent < runtime.limitCny) return next()
    entry.exceeded = true
    return { kind: 'reject' }
  }

  /** 兜底：任何还想去请求模型的路径都在这里被挡下。 */
  function streamGuard(options, next) {
    if (!runtime.enabled) return next()
    if (options && options.purpose) return next() // 压缩、标题这类内部调用不拦，只记账
    const sessionId = options && options.sessionId ? String(options.sessionId) : ''
    const entry = sessionId ? entries.get(sessionId) : undefined
    if (!entry || entry.spent < runtime.limitCny) return next()
    entry.exceeded = true
    const error = new Error(
      `已达本轮花费上限 ¥${formatCny(runtime.limitCny)}（本轮已花 ¥${formatCny(entry.spent)}），已自动停止。` +
        '可以在输入框下方把上限调高，或关掉开关后继续。',
    )
    error.code = 'TASK_BUDGET_EXCEEDED'
    throw error
  }

  function snapshot(sessionId) {
    const entry = sessionId ? entries.get(sessionId) : undefined
    const spent = entry ? entry.spent : 0
    return {
      enabled: runtime.enabled,
      limitCny: runtime.limitCny,
      currency: 'CNY',
      spent: Math.round(spent * 10000) / 10000,
      spentText: formatCny(spent),
      limitText: formatCny(runtime.limitCny),
      remaining: Math.max(0, Math.round((runtime.limitCny - spent) * 10000) / 10000),
      turn: entry ? entry.turn : 0,
      exceeded: Boolean(entry && entry.exceeded) || spent >= runtime.limitCny,
      peak: isPeakHour(Date.now()),
      updatedAt: runtime.updatedAt,
    }
  }

  /** 已挂载的服务按 origin 记；同一 origin 不重复挂（重复注册会报 duplicate prefix route）。 */
  let mountedOrigin = null

  function tryMount() {
    let webServer
    try {
      webServer = ctx.get('webServer')
    } catch {
      webServer = undefined
    }
    if (!webServer || typeof webServer.register !== 'function') return false
    let origin = ''
    try {
      if (typeof webServer.getOrigin === 'function') origin = webServer.getOrigin()
    } catch {
      /* 拿不到 origin 不影响挂载 */
    }
    const key = origin || 'unknown'
    if (mountedOrigin === key) return true
    const register = () => {
      const dispose = webServer.register({ kind: 'prefix', path: HTTP_PREFIX, handler: handleRequest })
      mountedOrigin = key
      diag(`mounted ${HTTP_PREFIX} on webServer ${key}`)
      console.info(`[task-budget] 本机接口已挂载：${HTTP_PREFIX} ${key}`)
      return dispose
    }
    try {
      /* 用 effect 注册：插件被卸载/重载时自动注销，不会留下旧的同路径注册。 */
      if (typeof ctx.effect === 'function') ctx.effect(register, `task-budget: routes ${key}`)
      else register()
      return true
    } catch (error) {
      const message = String((error && error.message) || error)
      if (/duplicate prefix route/i.test(message)) {
        /* 这个 origin 上已经有注册（可能是重载前留下的），接管状态、不再重试。 */
        mountedOrigin = key
        diag(`already registered ${HTTP_PREFIX} on ${key}`)
        return true
      }
      diag(`mount failed: ${message}`)
      console.warn('[task-budget] 挂载接口失败：', error)
      return false
    }
  }

  async function handleRequest(req, res) {
    if (!String(req.url || '').includes('/state')) diag(`request ${req.method} ${String(req.url || '')}`)

      try {
        const denied = fenceRequest(req, ctx)
        if (denied) {
          sendJson(res, 403, { ok: false, code: 'forbidden', message: denied })
          return
        }
        await ready
        const url = new URL(String(req.url || ''), 'http://127.0.0.1')
        const action = url.pathname.slice(HTTP_PREFIX.length)
        const method = String(req.method || 'GET').toUpperCase()

        if (action === '/state' && method === 'GET') {
          const sessionId = url.searchParams.get('session') || ''
          sendJson(res, 200, { ok: true, state: snapshot(sessionId) })
          return
        }
        if (action === '/config' && method === 'POST') {
          const text = await readBody(req)
          let body = {}
          try {
            body = text ? JSON.parse(text) : {}
          } catch {
            sendJson(res, 400, { ok: false, code: 'bad-json', message: '请求体不是合法 JSON' })
            return
          }
          if (body && typeof body === 'object') {
            if (typeof body.enabled === 'boolean') runtime.enabled = body.enabled
            if (Number.isFinite(body.limitCny)) runtime.limitCny = clampLimit(body.limitCny)
          }
          await saveState()
          console.info(
            `[task-budget] 设置已更新：${runtime.enabled ? '开' : '关'} · 上限 ¥${formatCny(runtime.limitCny)}`,
          )
          const sessionId = url.searchParams.get('session') || ''
          sendJson(res, 200, { ok: true, state: snapshot(sessionId) })
          return
        }
        if (action === '/status' && method === 'GET') {
          const sessionIds = []
          for (const [id, entry] of entries) {
            sessionIds.push({ session: id, turn: entry.turn, spent: entry.spent, exceeded: entry.exceeded })
          }
          sendJson(res, 200, {
            ok: true,
            enabled: runtime.enabled,
            limitCny: runtime.limitCny,
            stateFile,
            sessions: sessionIds,
          })
          return
        }
        sendJson(res, 404, { ok: false, code: 'not-found', message: `未知接口 ${action}` })
      } catch (error) {
        console.warn('[task-budget] 接口失败：', error)
        sendJson(res, 500, { ok: false, code: 'internal', message: String((error && error.message) || error) })
      }
    }

  if (!tryMount()) {
    diag('webServer 尚未就绪，2 秒后重试挂载')
    console.warn('[task-budget] webServer 尚未就绪，2 秒后重试挂载限额接口')
  }
  /* webServer 可能比插件晚就绪，或被换成一个新实例：每 2 秒核对一次，缺了/换了就补挂。 */
  ctx.effect(() => {
    const timer = setInterval(() => {
      tryMount()
      void syncStateFromDisk()
    }, 2000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'task-budget: webServer mount retry + state sync')

  ctx.on('session/event', foldEvent)
  ctx.on('agent/pre-step', preStep)
  ctx.on('llm/stream', streamGuard)

  void loadState()
  console.info(
    `[task-budget] 已加载：默认${config.enabled ? '开' : '关'} · 上限 ¥${formatCny(config.limitCny)} · 状态文件 ${stateFile}`,
  )
}
