/**
 * Usage Meter — dynamic Cordis plugin, CLIENT half.
 *
 * The whole file body is the plain-JavaScript function body that returns a
 * Cordis Plugin ({ apply(ctx) { ... } }). No imports / TS / JSX allowed:
 * `React` and `styles` arrive from the wrapper that scripts/build-client.mjs
 * generates around this file.
 *
 * --- Where the UI lives ---
 * Two entries, split because the sidebar clips its own overflow:
 * - `sidebar.footer.action` (id 'usage-meter') holds the trigger. That seat is
 *   the sidebar's own action row and hands each entry `{ wide }`, so the button
 *   follows the collapse/expand rail without any listener of ours. The row sits
 *   directly above the shell's account/settings row: `sidebar.settings` is a
 *   single-seat slot owned by the shipped settings UI, so a same-row seat beside
 *   the account panel does not exist and taking that one would shadow it.
 * - `shell.overlay` holds the panel. The layer is frame-wide and outside every
 *   column, so the panel can render beside the sidebar instead of clipping
 *   inside it.
 *
 * --- Placement ---
 * The panel measures the frame-level column that holds the button (the sidebar,
 * found structurally rather than by class name) and anchors its left edge just
 * past that column's right edge, with its bottom at the button's bottom. Its
 * size is user-resizable and remembered; the grip sits in the corner farthest
 * from the button.
 *
 * --- Where the numbers come from ---
 * `GET /usage-meter/snapshot` on the harness web server, owned by this plugin's
 * host half. No credential ever reaches this file.
 */
const UM_ROUTE = '/usage-meter/snapshot'
const UM_REFRESH_MS = 60_000
const UM_SIZE_KEY = 'usage-meter.size'
const UM_LEGACY_POSITION_KEY = 'usage-meter.position'
const UM_MIN_SIZE = { width: 260, height: 160 }
const UM_DEFAULT_SIZE = { width: 330, height: 360 }
const UM_EDGE_MARGIN_PX = 8
const UM_PANEL_GAP_PX = 10
const UM_RESIZE_THRESHOLD_PX = 3
const UM_TRIGGER_ORDER = 20
const UM_PANEL_ORDER = 30
/** The shipped account avatar's box; this row's glyph matches it. */
const UM_ICON_SIZE = 32
const UM_LABEL_GAP_PX = 8

const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function readStoredJson(key) {
  try {
    if (typeof localStorage === 'undefined') return null
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch (error) {
    return null
  }
}

function writeStoredJson(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    // A storage that rejects writes must not break the meter.
  }
}

function dropStoredKey(key) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch (error) {
    // Same as above: storage is optional.
  }
}

function readStoredSize() {
  const stored = readStoredJson(UM_SIZE_KEY)
  if (!stored) return null
  const width = Number.isFinite(stored.width) && stored.width > 0 ? stored.width : null
  const height = Number.isFinite(stored.height) && stored.height > 0 ? stored.height : null
  return width === null && height === null ? null : { width, height }
}

function formatCountdown(target, now) {
  if (typeof target !== 'number' || !Number.isFinite(target)) return ''
  const delta = target - now
  if (delta <= 0) return ''
  const minutes = Math.floor(delta / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days > 0) return { days, hours: hours % 24 }
  if (hours > 0) return { hours, minutes: minutes % 60 }
  return { minutes: Math.max(1, minutes) }
}

function formatAmount(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return '—'
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
  return symbol + amount
}

function formatClock(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Percent → accent token, so a nearly exhausted allowance reads at a glance. */
function percentTone(percent) {
  if (percent === null) return 'var(--dsw-alias-label-secondary)'
  if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #ef4444)'
  if (percent >= 70) return 'var(--dsw-alias-state-warning-primary, #f59e0b)'
  return 'var(--dsw-alias-brand-primary, #3b82f6)'
}

function countdownText(parts, t) {
  if (!parts) return ''
  if (parts.days !== undefined) return t('reset.daysHours').replace('{d}', String(parts.days)).replace('{h}', String(parts.hours))
  if (parts.hours !== undefined) return t('reset.hoursMinutes').replace('{h}', String(parts.hours)).replace('{m}', String(parts.minutes))
  return t('reset.minutes').replace('{m}', String(parts.minutes))
}

/**
 * The two entries are separate registrations in separate trees, so they share
 * one plain store: the trigger owns the button element and the open flag, the
 * panel only reads them. `revision` lets the trigger ask for a re-measure when
 * the sidebar changes width without the frame resizing.
 */
function makeMeterStore() {
  const state = { open: false, button: null, revision: 0 }
  const listeners = new Set()
  const emit = () => { for (const listener of Array.from(listeners)) listener() }
  return {
    isOpen: () => state.open,
    button: () => state.button,
    revision: () => state.revision,
    setButton: (element) => { state.button = element },
    toggle: () => { state.open = !state.open; state.revision += 1; emit() },
    close: () => { if (!state.open) return; state.open = false; state.revision += 1; emit() },
    touch: () => { state.revision += 1; emit() },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

/**
 * Places the panel just outside the frame-level column that holds the button.
 * The column is found by climbing the DOM to the frame's direct child, so the
 * decision never depends on hashed class names or on the sidebar's width.
 */
function measurePlacement(buttonEl, layerEl) {
  if (!buttonEl || !layerEl) return null
  const buttonRect = buttonEl.getBoundingClientRect()
  if (buttonRect.width === 0 && buttonRect.height === 0) return null
  const layerRect = layerEl.getBoundingClientRect()
  const frame = layerEl.parentElement
  const boundary = frame || layerEl
  let column = buttonEl
  while (column.parentElement && column.parentElement !== boundary) column = column.parentElement
  const columnRect = column.getBoundingClientRect()
  const left = Math.round(Math.max(0, columnRect.right - layerRect.left + UM_PANEL_GAP_PX))
  const bottom = Math.round(Math.max(0, layerRect.bottom - buttonRect.bottom))
  return {
    left,
    bottom,
    maxWidth: Math.max(UM_MIN_SIZE.width, Math.round(layerRect.width - left - UM_EDGE_MARGIN_PX)),
    maxHeight: Math.max(UM_MIN_SIZE.height, Math.round(layerRect.height - bottom - UM_EDGE_MARGIN_PX)),
  }
}

function samePlacement(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.left === b.left && a.bottom === b.bottom && a.maxWidth === b.maxWidth && a.maxHeight === b.maxHeight
}

function firstSizedChild(element) {
  for (const child of Array.from(element.children || [])) {
    if (child.getBoundingClientRect().width > 0) return child
  }
  return null
}

function nextSizedSibling(element) {
  let node = element.nextElementSibling
  while (node) {
    if (node.getBoundingClientRect().width > 0) return node
    node = node.nextElementSibling
  }
  return null
}

/**
 * Aligns this row with the account row below it.
 *
 * The shipped account launcher owns its own leading inset and label offset, and
 * the action row is a shared seat this plugin does not own — so the insets are
 * measured off the sibling row instead of hard-coded, and whatever that row
 * decides (32px avatar, a wider inset, another occupant to its left) this row
 * follows. Returns null whenever the sibling row is not there yet, which leaves
 * the CSS defaults in place.
 */
function measureRowInsets(buttonEl) {
  const actions = buttonEl ? buttonEl.parentElement : null
  const footArea = actions ? actions.parentElement : null
  if (!actions || !footArea) return null
  const settingsArea = Array.from(footArea.children).find((row) => row !== actions)
  if (!settingsArea || typeof settingsArea.querySelector !== 'function') return null
  // The account launcher is the first button in that row, ahead of any indicator.
  const accountButton = settingsArea.querySelector('button')
  if (!accountButton) return null
  const lead = firstSizedChild(accountButton)
  if (!lead) return null
  const label = nextSizedSibling(lead)
  const iconLeft = lead.getBoundingClientRect().left
  const buttonLeft = buttonEl.getBoundingClientRect().left
  const insets = { paddingLeft: Math.round(iconLeft - buttonLeft) }
  if (label) {
    insets.labelMargin = Math.round(label.getBoundingClientRect().left - iconLeft - UM_ICON_SIZE)
  }
  return insets
}

function sameInsets(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return a.paddingLeft === b.paddingLeft && a.labelMargin === b.labelMargin
}

function BalanceBody(props) {
  const { data, t } = props
  const wallets = data.wallets || []
  if (wallets.length === 0) return React.createElement('div', { className: 'um-muted' }, t('balance.empty'))
  return React.createElement('div', { className: 'um-balances' },
    wallets.map((wallet) => React.createElement('div', { className: 'um-balance', key: wallet.currency || 'default' },
      React.createElement('div', { className: 'um-balance-total' },
        React.createElement('span', { className: 'um-balance-label' }, t('balance.total')),
        React.createElement('span', { className: 'um-balance-amount' }, formatAmount(wallet.total, wallet.currency))),
      React.createElement('div', { className: 'um-balance-split' },
        React.createElement('span', null, t('balance.toppedUp') + ' ' + formatAmount(wallet.toppedUp, wallet.currency)),
        React.createElement('span', null, t('balance.granted') + ' ' + formatAmount(wallet.granted, wallet.currency))),
    )),
    data.isAvailable === false
      ? React.createElement('div', { className: 'um-warn' }, t('balance.unavailable'))
      : null,
  )
}

function WindowRow(props) {
  const { window, t, now } = props
  const percent = window.percent
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent))
  const tone = percentTone(percent)
  const resetAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN
  const remaining = Number.isFinite(resetAt) ? countdownText(formatCountdown(resetAt, now), t) : ''
  const resetLabel = Number.isFinite(resetAt)
    ? t('quota.resetsAt').replace('{time}', formatClock(resetAt))
    : ''
  return React.createElement('div', { className: 'um-window' },
    React.createElement('div', { className: 'um-window-head' },
      React.createElement('span', { className: 'um-window-name' }, t('window.' + window.id)),
      React.createElement('span', { className: 'um-window-percent', style: { color: tone } },
        percent === null ? '—' : percent + '%')),
    React.createElement('div', { className: 'um-bar' },
      React.createElement('div', { className: 'um-bar-fill', style: { width: width + '%', background: tone } })),
    React.createElement('div', { className: 'um-window-foot' },
      React.createElement('span', null, remaining ? t('quota.remaining').replace('{time}', remaining) : t('quota.noReset')),
      resetLabel ? React.createElement('span', { className: 'um-window-reset' }, resetLabel) : null),
  )
}

function QuotaBody(props) {
  const { data, t, now } = props
  const byId = {}
  for (const window of data.windows || []) byId[window.id] = window
  return React.createElement('div', { className: 'um-windows' },
    WINDOW_ORDER.map((id) => React.createElement(WindowRow, {
      key: id,
      window: byId[id] || { id, status: 'unknown', percent: null, resetsAt: null },
      t,
      now,
    })),
  )
}

function ProviderCard(props) {
  const { card, t, now } = props
  let body
  if (!card.configured) {
    body = React.createElement('div', { className: 'um-muted' }, t('card.notConfigured'))
  } else if (card.error) {
    body = React.createElement('div', { className: 'um-error' }, card.error)
  } else if (!card.data) {
    body = React.createElement('div', { className: 'um-muted' }, t('card.noData'))
  } else if (card.data.kind === 'balance') {
    body = React.createElement(BalanceBody, { data: card.data, t })
  } else {
    body = React.createElement(QuotaBody, { data: card.data, t, now })
  }
  return React.createElement('section', { className: 'um-card' + (card.configured ? '' : ' um-card-off') },
    React.createElement('h4', { className: 'um-card-title' }, card.displayName),
    body,
  )
}

/** The `sidebar.footer.action` entry: the trigger that opens and closes the panel. */
function UsageTrigger(props) {
  const { t, store, wide } = props
  const [open, setOpen] = React.useState(() => store.isOpen())
  const [insets, setInsets] = React.useState(null)
  const buttonRef = React.useRef(null)

  React.useEffect(() => store.subscribe(() => setOpen(store.isOpen())), [store])
  React.useEffect(() => {
    store.setButton(buttonRef.current)
    store.touch()
    return () => store.setButton(null)
  }, [store, wide])

  // Line this row up with the account row below it. The account launcher mounts
  // in the same commit, but a late registration would land after this effect, so
  // one frame later is measured again before giving up.
  React.useEffect(() => {
    const measure = () => {
      const next = measureRowInsets(buttonRef.current)
      if (next) setInsets((current) => (sameInsets(current, next) ? current : next))
    }
    measure()
    if (typeof requestAnimationFrame !== 'function') return undefined
    const frame = requestAnimationFrame(measure)
    return () => { if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame) }
  }, [wide])

  const compact = wide === false
  // The row mirrors the shipped account launcher (padding 6, radius 12, gap 8,
  // 14/22 type) and the glyph is 32x32 — the avatar's own box — so the button
  // reads as a sibling of the account row below it.
  const buttonStyle = insets && !compact
    ? { paddingLeft: insets.paddingLeft + 'px', gap: '0px' }
    : undefined
  const labelStyle = insets && !compact && insets.labelMargin !== undefined
    ? { marginLeft: insets.labelMargin + 'px' }
    : undefined

  return React.createElement('button', {
    ref: buttonRef,
    type: 'button',
    className: 'um-button' + (compact ? ' um-button-compact' : '') + (open ? ' um-button-open' : ''),
    style: buttonStyle,
    title: t('button.title'),
    'aria-label': t('button.title'),
    'aria-expanded': open,
    'aria-haspopup': 'dialog',
    onClick: () => store.toggle(),
  },
    React.createElement('svg', {
      className: 'um-button-icon',
      viewBox: '0 0 20 20',
      width: UM_ICON_SIZE,
      height: UM_ICON_SIZE,
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1,
      strokeLinecap: 'round',
    },
      React.createElement('path', { d: 'M3.6 15a7.2 7.2 0 1 1 12.8 0' }),
      React.createElement('path', { d: 'M10 11.6l3.4-3.4' })),
    compact ? null : React.createElement('span', { className: 'um-button-label', style: labelStyle }, t('button.label')))
}

/** The `shell.overlay` entry: the panel, rendered outside the sidebar's column. */
function UsagePanel(props) {
  const { t, store } = props
  const [open, setOpen] = React.useState(() => store.isOpen())
  const [revision, setRevision] = React.useState(() => store.revision())
  const [state, setState] = React.useState({ phase: 'idle', data: null, error: null })
  const [now, setNow] = React.useState(() => Date.now())
  const [placement, setPlacement] = React.useState(null)
  const [size, setSize] = React.useState(readStoredSize)
  const [resizing, setResizing] = React.useState(false)
  const rootRef = React.useRef(null)
  const panelRef = React.useRef(null)
  const resizeRef = React.useRef(null)

  React.useEffect(() => store.subscribe(() => {
    setOpen(store.isOpen())
    setRevision(store.revision())
  }), [store])

  // The manual-position feature is gone; drop its leftover key once.
  React.useEffect(() => { dropStoredKey(UM_LEGACY_POSITION_KEY) }, [])

  const load = React.useCallback((force) => {
    setState((previous) => ({ ...previous, phase: 'loading' }))
    fetch(UM_ROUTE + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error('HTTP ' + response.status))))
      .then((data) => setState({ phase: 'ready', data, error: null }))
      .catch((error) => setState({ phase: 'failed', data: null, error: error && error.message ? error.message : String(error) }))
  }, [])

  React.useEffect(() => {
    if (!open) return undefined
    load(false)
    const refresh = setInterval(() => load(false), UM_REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => { clearInterval(refresh); clearInterval(tick) }
  }, [open, load])

  /**
   * Esc and a press anywhere outside the panel both dismiss it. The trigger is
   * excluded from the outside test so its own click still performs the toggle
   * rather than closing and immediately reopening.
   */
  React.useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined
    const onKeyDown = (event) => { if (event.key === 'Escape') store.close() }
    const onPointerDown = (event) => {
      const target = event.target
      if (!target) return
      const panelEl = panelRef.current
      if (panelEl && typeof panelEl.contains === 'function' && panelEl.contains(target)) return
      const buttonEl = store.button()
      if (buttonEl && typeof buttonEl.contains === 'function' && buttonEl.contains(target)) return
      store.close()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, store])

  // Re-measure on open, on a sidebar width change, and on a frame resize.
  React.useEffect(() => {
    if (!open) return undefined
    const layerEl = rootRef.current ? rootRef.current.offsetParent : null
    if (!layerEl) return undefined
    const measure = () => {
      const next = measurePlacement(store.button(), layerEl)
      if (next) setPlacement((current) => (samePlacement(current, next) ? current : next))
    }
    measure()
    // The sidebar rows may still be settling when the panel first opens, and a
    // layer-only ResizeObserver never sees an internal row shift; one frame later
    // the geometry is final, so the anchor lands exactly on the button.
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(measure) : null
    const cancel = () => {
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
    }
    if (typeof ResizeObserver === 'undefined') return cancel
    const observer = new ResizeObserver(measure)
    observer.observe(layerEl)
    return () => { observer.disconnect(); cancel() }
  }, [open, revision, store])

  /**
   * The grip sits in the panel's top-right corner — the one farthest from the
   * button — so dragging right grows the width and dragging up grows the height
   * while the left/bottom anchoring keeps the panel clear of the sidebar.
   */
  const onHandlePointerDown = (event) => {
    if (event.button !== 0) return
    const el = panelRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
      moved: false,
      width: rect.width,
      height: rect.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const onHandlePointerMove = (event) => {
    const drag = resizeRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < UM_RESIZE_THRESHOLD_PX && Math.abs(dy) < UM_RESIZE_THRESHOLD_PX) return
    drag.moved = true
    setResizing(true)
    const maxWidth = placement ? placement.maxWidth : UM_DEFAULT_SIZE.width
    const maxHeight = placement ? placement.maxHeight : UM_DEFAULT_SIZE.height
    drag.width = clamp(Math.round(drag.startWidth + dx), UM_MIN_SIZE.width, Math.max(UM_MIN_SIZE.width, maxWidth))
    drag.height = clamp(Math.round(drag.startHeight - dy), UM_MIN_SIZE.height, Math.max(UM_MIN_SIZE.height, maxHeight))
    setSize({ width: drag.width, height: drag.height })
  }

  const onHandlePointerUp = (event) => {
    const drag = resizeRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    resizeRef.current = null
    setResizing(false)
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) { /* already released */ }
    if (drag.moved) writeStoredJson(UM_SIZE_KEY, { width: drag.width, height: drag.height })
  }

  if (!open) return null

  const cards = state.data && Array.isArray(state.data.cards) ? state.data.cards : []
  const configured = cards.filter((card) => card.configured)
  const width = (size && size.width) || UM_DEFAULT_SIZE.width
  const height = (size && size.height) || UM_DEFAULT_SIZE.height

  const anchorStyle = placement
    ? {
      left: placement.left + 'px',
      bottom: placement.bottom + 'px',
      maxWidth: placement.maxWidth + 'px',
    }
    : { left: '64px', bottom: '16px' }
  const panelStyle = {
    width: width + 'px',
    height: height + 'px',
    maxHeight: placement ? placement.maxHeight + 'px' : undefined,
  }

  return React.createElement('div', { className: 'um-anchor', ref: rootRef, style: anchorStyle },
    React.createElement('div', {
      className: 'um-panel' + (resizing ? ' um-panel-resizing' : ''),
      ref: panelRef,
      role: 'dialog',
      'aria-label': t('panel.title'),
      style: panelStyle,
    },
      React.createElement('header', { className: 'um-panel-head' },
        React.createElement('span', { className: 'um-panel-title' }, t('panel.title')),
        React.createElement('span', { className: 'um-panel-stamp' },
          state.data && state.data.generatedAt ? formatClock(state.data.generatedAt) : ''),
        React.createElement('button', {
          className: 'um-icon-btn',
          title: t('panel.refresh'),
          'aria-label': t('panel.refresh'),
          onClick: () => load(true),
        }, '⟳'),
        React.createElement('button', {
          className: 'um-icon-btn',
          title: t('panel.close'),
          'aria-label': t('panel.close'),
          onClick: () => store.close(),
        }, '×')),
      React.createElement('div', { className: 'um-panel-body' },
        state.phase === 'loading' && cards.length === 0
          ? React.createElement('div', { className: 'um-muted' }, t('panel.loading'))
          : null,
        state.phase === 'failed'
          ? React.createElement('div', { className: 'um-error' }, t('panel.failed') + '：' + state.error)
          : null,
        state.phase !== 'failed' && state.phase !== 'loading' && configured.length === 0
          ? React.createElement('div', { className: 'um-muted' }, t('panel.none'))
          : null,
        cards.map((card) => React.createElement(ProviderCard, { key: card.id, card, t, now })),
      ),
      React.createElement('div', {
        className: 'um-resize' + (resizing ? ' um-resize-active' : ''),
        title: t('panel.resize'),
        'aria-label': t('panel.resize'),
        role: 'separator',
        onPointerDown: onHandlePointerDown,
        onPointerMove: onHandlePointerMove,
        onPointerUp: onHandlePointerUp,
        onPointerCancel: onHandlePointerUp,
      }),
    ),
  )
}

const ZH_DICT = {
  'button.label': '用量',
  'button.title': '查看套餐用量',
  'panel.title': '套餐用量详细',
  'panel.refresh': '刷新',
  'panel.close': '关闭',
  'panel.resize': '拖动可调整大小',
  'panel.loading': '正在读取…',
  'panel.failed': '读取失败',
  'panel.none': '没有已配置的服务商凭据。',
  'card.notConfigured': '未配置凭据，已跳过。',
  'card.noData': '无数据。',
  'balance.total': '总余额',
  'balance.toppedUp': '充值',
  'balance.granted': '赠送',
  'balance.empty': '没有余额信息。',
  'balance.unavailable': '余额不足，API 调用可能失败。',
  'window.rolling': '5 小时',
  'window.weekly': '7 天',
  'window.monthly': '每月',
  'quota.remaining': '{time}后重置',
  'quota.resetsAt': '{time}',
  'quota.noReset': '无重置时间',
  'reset.daysHours': '{d} 天 {h} 小时',
  'reset.hoursMinutes': '{h} 小时 {m} 分',
  'reset.minutes': '{m} 分钟',
}

const EN_DICT = {
  'button.label': 'Usage',
  'button.title': 'View plan usage',
  'panel.title': 'Plan usage',
  'panel.refresh': 'Refresh',
  'panel.close': 'Close',
  'panel.resize': 'Drag to resize',
  'panel.loading': 'Loading…',
  'panel.failed': 'Request failed',
  'panel.none': 'No configured provider credentials.',
  'card.notConfigured': 'No credential configured; skipped.',
  'card.noData': 'No data.',
  'balance.total': 'Total',
  'balance.toppedUp': 'Topped up',
  'balance.granted': 'Granted',
  'balance.empty': 'No balance information.',
  'balance.unavailable': 'Balance is insufficient; API calls may fail.',
  'window.rolling': '5 hours',
  'window.weekly': '7 days',
  'window.monthly': 'Monthly',
  'quota.remaining': 'resets in {time}',
  'quota.resetsAt': '{time}',
  'quota.noReset': 'no reset time',
  'reset.daysHours': '{d}d {h}h',
  'reset.hoursMinutes': '{h}h {m}m',
  'reset.minutes': '{m}m',
}

const UM_CSS = `
.um-button { box-sizing: border-box; cursor: pointer; flex: 1; min-width: 0; margin: 4px -2px; padding: 6px; display: flex; align-items: center; gap: ${UM_LABEL_GAP_PX}px; overflow: hidden; border: none; border-radius: 12px; background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 14px; line-height: 22px; user-select: none; -webkit-user-select: none; }
.um-button:hover, .um-button-open { background: var(--dsw-alias-interactive-bg-hover) }
.um-button-compact { flex: none; width: 40px; height: 40px; margin: 0; padding: 4px; justify-content: center; gap: 0; }
.um-button-icon { flex: none; display: block; width: 32px; height: 32px; }
.um-button-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.um-anchor { position: absolute; pointer-events: none; z-index: 1; }
.um-panel { pointer-events: auto; position: relative; display: flex; flex-direction: column; min-width: 260px; min-height: 160px; overflow: hidden; border: .5px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; box-shadow: 0 8px 28px rgba(15, 23, 42, .22); color: var(--dsw-alias-label-primary); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.um-panel-resizing { user-select: none; -webkit-user-select: none; }
.um-panel-head { display: flex; align-items: center; gap: 8px; padding: 9px 26px 9px 14px; border-bottom: .5px solid var(--dsw-alias-border-l1); flex: none; }
.um-panel-title { font-weight: 600; font-size: 13px; }
.um-panel-stamp { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-variant-numeric: tabular-nums; }
.um-icon-btn { border: none; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; font-size: 14px; line-height: 18px; padding: 0 4px; border-radius: 5px; }
.um-icon-btn:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.um-panel-body { flex: 1; min-height: 0; padding: 10px 12px 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.um-card { border: .5px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 9px 11px 11px; background: var(--dsw-alias-bg-base); }
.um-card-off { opacity: .6; }
.um-card-title { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.um-balances { display: flex; flex-direction: column; gap: 8px; }
.um-balance-total { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.um-balance-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.um-balance-amount { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.um-balance-split { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.um-windows { display: flex; flex-direction: column; gap: 10px; }
.um-window-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.um-window-name { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.um-window-percent { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.um-bar { height: 6px; margin: 5px 0 4px; border-radius: 3px; background: var(--dsw-alias-bg-skeleton, rgba(127, 127, 127, .18)); overflow: hidden; }
.um-bar-fill { height: 100%; border-radius: 3px; transition: width 200ms ease; }
.um-window-foot { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.um-window-reset { opacity: .75; }
.um-muted { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.um-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #ef4444); word-break: break-word; }
.um-warn { margin-top: 8px; font-size: 11px; color: var(--dsw-alias-state-warning-primary, #f59e0b); }
.um-resize { position: absolute; right: 0; top: 0; width: 18px; height: 18px; z-index: 2; opacity: .45; cursor: nesw-resize; touch-action: none; transition: opacity 120ms ease; border-right: 2px solid var(--dsw-alias-label-tertiary, #94a3b8); border-top: 2px solid var(--dsw-alias-label-tertiary, #94a3b8); border-top-right-radius: 11px; }
.um-resize:hover, .um-resize-active { opacity: 1; }
`

return {
  name: 'dsh-plan-spend',
  // Declared on the exported plugin so Cordis withholds `apply` until both are
  // provided. Without it `ctx.get('locale')` can observe a service that is not
  // there yet, which silently degrades `t` into a key-echoing identity function.
  inject: ['slots', 'locale'],
  apply(ctx) {
    const locale = ctx.get('locale')
    // Unique per-apply namespace: the locale registry is process-wide and a
    // stale registration of the stable name would throw ("already has locale").
    const ns = 'usage-meter.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    if (locale) {
      ctx.effect(() => locale.register(ns, 'zh', ZH_DICT), 'usage-meter: zh dict')
      ctx.effect(() => locale.register(ns, 'en', EN_DICT), 'usage-meter: en dict')
    }
    const t = locale ? locale.bind(ns) : ((key) => key)
    const store = makeMeterStore()

    const slots = ctx.get('slots')
    if (slots) {
      // The sidebar clips its own overflow, so the trigger and the panel are
      // separate registrations: the trigger in the sidebar's action row, the
      // panel in the frame-wide overlay beside that column.
      slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action',
        id: 'usage-meter',
        order: UM_TRIGGER_ORDER,
      }, (props) => React.createElement(UsageTrigger, {
        t,
        store,
        wide: props ? props.wide : true,
      })))

      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'usage-meter',
        order: UM_PANEL_ORDER,
      }, () => React.createElement(UsagePanel, { t, store })))
    }

    ctx.effect(() => styles.insert(UM_CSS), 'usage-meter: styles')
  },
}
