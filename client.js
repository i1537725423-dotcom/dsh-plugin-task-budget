/**
 * dsh-plugin-task-budget —— 本轮任务花费限额（Client 半）
 *
 * 输入框下方状态栏最右侧一枚极简控件：小开关 + 「¥已花/上限」。
 *   - 点开关：直接开关限额（写回本机 /task-budget/config）
 *   - 点金额：就地展开输入框，改上限并保存
 * 数字来自 Host 半的记账（按 token × DeepSeek 价目表折算人民币），约 2 秒轮询一次。
 *
 * 视觉：不写标签、不带图标，字体颜色跟随同一行的其他条目；开关打开时轨道为深灰。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-task-budget',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const API = '/task-budget'
    const REQUEST_HEADERS = { 'x-dsh-task-budget': '1' }
    const POLL_MS = 2000
    const NS = 'task-budget'
    const STYLE_ID = 'dsh-plugin-task-budget/pill.css'

    /* 文本颜色沿用内置状态栏胶囊的 tertiary；开关打开＝深灰轨道（不用品牌蓝） */
    const CSS = [
      '.dsh-tb-anchor{min-width:0;margin-left:auto;justify-content:flex-end;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dsh-tb-switch{box-sizing:border-box;position:relative;flex:none;width:20px;height:12px;border-radius:6px;border:none;padding:0;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease}',
      '.dsh-tb-switch[data-on=true]{background:#4a4a4a}',
      '.dsh-tb-switch:disabled{opacity:.5;cursor:default}',
      '.dsh-tb-knob{position:absolute;top:1.5px;left:1.5px;width:9px;height:9px;border-radius:50%;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.2);transition:transform .15s ease}',
      '.dsh-tb-switch[data-on=true] .dsh-tb-knob{transform:translateX(8px)}',
      '.dsh-tb-amount{box-sizing:border-box;max-width:100%;color:inherit;font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;padding:1px 2px;display:inline-flex;align-items:center;cursor:pointer;border-radius:var(--dsw-radius-sm,6px)}',
      '.dsh-tb-amount:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tb-amount[data-tone=exceeded]{color:var(--dsw-alias-state-error-primary)}',
      '.dsh-tb-amount[data-tone=off]{opacity:.65}',
      '.dsh-tb-editor{display:inline-flex;align-items:center;gap:4px}',
      '.dsh-tb-input{box-sizing:border-box;width:60px;height:20px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums}',
      '.dsh-tb-input:focus{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:0}',
      '.dsh-tb-btn{box-sizing:border-box;height:20px;padding:0 7px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
      '.dsh-tb-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsh-tb-btn[data-primary=true]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.dsh-tb-btn:disabled{opacity:.5;cursor:default}',
    ].join('')

    const DICTS = {
      zh: {
        'title.on': '本轮花费上限已开启，点金额可改',
        'title.off': '本轮花费上限已关闭，点金额可开启或改',
        'title.exceeded': '已达本轮上限，任务已自动停止；可调高上限或关掉开关',
        'switch.on': '花费上限开关（已开启）',
        'switch.off': '花费上限开关（已关闭）',
        save: '保存',
        cancel: '取消',
        editorLabel: '上限',
        failed: '限额接口未就绪',
      },
      en: {
        'title.on': 'Turn spending cap is on; click the amount to change it',
        'title.off': 'Turn spending cap is off; click the amount to turn one on',
        'title.exceeded': 'Turn cap reached; the run was stopped automatically',
        'switch.on': 'Spending cap switch (on)',
        'switch.off': 'Spending cap switch (off)',
        save: 'Save',
        cancel: 'Cancel',
        editorLabel: 'Limit',
        failed: 'Budget endpoint unavailable',
      },
    }

    const runtime = { ctx: null }

    function translate(key) {
      try {
        const ctx = runtime.ctx
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') {
          const value = ctx.locale.bind(NS)(key)
          if (typeof value === 'string' && value && value !== key) return value
        }
      } catch {
        /* 文案服务没起来时用内置中文 */
      }
      return DICTS.zh[key] !== undefined ? DICTS.zh[key] : key
    }

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-task-budget'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function registerLocale(ctx) {
      const disposers = []
      for (const [locale, dict] of Object.entries(DICTS)) {
        try {
          const dispose = ctx.locale.register(NS, locale, dict)
          if (typeof dispose === 'function') disposers.push(dispose)
        } catch (error) {
          console.warn('[task-budget] 注册文案失败：', locale, error)
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已经释放 */
          }
        }
      }
    }

    async function fetchState(sessionId) {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`${API}/state${query}`, { headers: REQUEST_HEADERS, cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error((payload && payload.message) || `HTTP ${response.status}`)
      }
      return payload.state
    }

    async function saveConfig(sessionId, patch) {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
      const response = await fetch(`${API}/config${query}`, {
        method: 'POST',
        headers: { ...REQUEST_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error((payload && payload.message) || `HTTP ${response.status}`)
      }
      return payload.state
    }

    function useLocaleVersion(ctx) {
      const [, force] = useState(0)
      useEffect(() => {
        if (!ctx || !ctx.locale || typeof ctx.locale.subscribe !== 'function') return undefined
        return ctx.locale.subscribe(() => force((n) => n + 1))
      }, [ctx])
    }

    function BudgetControl(props) {
      const ctx = props.ctx
      const sessionId = props.sessionId || ''
      useLocaleVersion(ctx)

      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState('5')
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let alive = true
        const read = async () => {
          if (document.visibilityState === 'hidden') return
          try {
            const next = await fetchState(sessionId)
            if (!alive) return
            setState(next)
            setError('')
          } catch (failure) {
            if (!alive) return
            setError(String((failure && failure.message) || failure))
          }
        }
        void read()
        const timer = setInterval(() => void read(), POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [sessionId])

      const enabled = Boolean(state && state.enabled)
      const exceeded = Boolean(state && state.exceeded)
      const ready = Boolean(state)
      const spentText = state ? state.spentText : '—'
      const limitText = state ? state.limitText : '—'

      async function update(patch) {
        setBusy(true)
        try {
          const next = await saveConfig(sessionId, patch)
          setState(next)
          setError('')
          return next
        } catch (failure) {
          setError(String((failure && failure.message) || failure))
          return null
        } finally {
          setBusy(false)
        }
      }

      async function toggle() {
        if (!ready || busy) return
        await update({ enabled: !enabled })
      }

      async function commit() {
        const amount = Number.parseFloat(draft)
        if (!Number.isFinite(amount) || amount <= 0) return
        const next = await update({ limitCny: Math.min(10000, Math.max(0.01, amount)) })
        if (next) setEditing(false)
      }

      function beginEdit() {
        if (!ready) return
        setDraft(state && Number.isFinite(state.limitCny) ? String(state.limitCny) : '5')
        setEditing(true)
      }

      const tone = exceeded ? 'exceeded' : enabled ? '' : 'off'
      const title = error
        ? `${translate('failed')}：${error}`
        : exceeded
          ? translate('title.exceeded')
          : enabled
            ? translate('title.on')
            : translate('title.off')

      return h(
        'span',
        { className: 'dsh-tb-anchor', 'data-composer-stat': 'task-budget' },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-tb-switch',
            'data-on': enabled ? 'true' : 'false',
            role: 'switch',
            'aria-checked': enabled ? 'true' : 'false',
            title: enabled ? translate('switch.on') : translate('switch.off'),
            disabled: !ready || busy,
            onClick: () => void toggle(),
          },
          h('span', { className: 'dsh-tb-knob' }),
        ),
        editing
          ? h(
              'span',
              { className: 'dsh-tb-editor' },
              h('input', {
                className: 'dsh-tb-input',
                type: 'number',
                min: '0.1',
                step: '0.5',
                inputMode: 'decimal',
                'aria-label': translate('editorLabel'),
                value: draft,
                autoFocus: true,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void commit()
                  if (event.key === 'Escape') setEditing(false)
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-tb-btn',
                  'data-primary': 'true',
                  disabled: busy,
                  onClick: () => void commit(),
                },
                translate('save'),
              ),
              h(
                'button',
                { type: 'button', className: 'dsh-tb-btn', disabled: busy, onClick: () => setEditing(false) },
                translate('cancel'),
              ),
            )
          : h(
              'button',
              {
                type: 'button',
                className: 'dsh-tb-amount',
                'data-tone': tone,
                title,
                onClick: () => beginEdit(),
              },
              `¥${spentText}/${limitText}`,
            ),
      )
    }

    function apply(ctx) {
      runtime.ctx = ctx
      ensureStyles()
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => registerLocale(ctx), 'task-budget: locale dictionaries')
      } else {
        registerLocale(ctx)
      }
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'task-budget', order: 90, label: '' },
          (props) => h(BudgetControl, { ...(props || {}), ctx }),
        ),
      )
    }

    const inject = ['slots', 'locale']
    const module = { exports: { apply, inject, BudgetControl } }
    return module.exports
  },
})
