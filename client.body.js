/**
 * Plan Spend — dynamic Cordis plugin, CLIENT half.
 *
 * The whole file body is the plain-JavaScript function body that returns a
 * Cordis Plugin ({ apply(ctx) { ... } }). No imports / TS / JSX allowed:
 * `React` and `styles` arrive from the wrapper that scripts/build-client.mjs
 * generates around this file.
 *
 * --- Where the UI lives ---
 * Two entries, split because the sidebar clips its own overflow:
 * - `sidebar.footer.action` (id 'dsh-plan-spend') holds the trigger. That seat is
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
 * `GET /dsh-plan-spend/snapshot` on the harness web server, owned by this plugin's
 * host half, which also decides which route answered: the signed-in DeepSeek
 * account's login grant, or the `DEEPSEEK_API_KEY` fallback. No credential ever
 * reaches this file; the granted bonus arrives as its own wallet row, so the
 * card can show it without seeing the key.
 *
 * --- Peak / off-peak ---
 * DeepSeek halves its price outside peak hours, and no endpoint reports which
 * side of that line the clock is on, so the DeepSeek card derives it here from
 * the published windows plus the State Council holiday table. A table that no
 * longer covers the current year is reported on the card instead of quietly
 * judging every holiday as peak.
 */
const UM_ROUTE = '/dsh-plan-spend/snapshot'
const UM_REFRESH_MS = 60_000
const UM_SIZE_KEY = 'dsh-plan-spend.size'
// Keys from before the identifier rename: the position is dead and only dropped,
// the size is adopted once so the rename does not reset a user's panel.
const UM_LEGACY_POSITION_KEY = 'usage-meter.position'
const UM_LEGACY_SIZE_KEY = 'usage-meter.size'
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
/** The panel's DOM id, so the trigger can point `aria-controls` at it. */
const UM_PANEL_ID = 'dsh-plan-spend-panel'
/** The heading the dialog is labelled by, instead of a duplicate aria-label. */
const UM_PANEL_TITLE_ID = 'dsh-plan-spend-panel-title'
/** Arrow-key resize step; Shift makes it four times larger. */
const UM_KEYBOARD_RESIZE_STEP = 16

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
  const current = readStoredJson(UM_SIZE_KEY)
  const stored = current || readStoredJson(UM_LEGACY_SIZE_KEY)
  if (!stored) return null
  const width = Number.isFinite(stored.width) && stored.width > 0 ? stored.width : null
  const height = Number.isFinite(stored.height) && stored.height > 0 ? stored.height : null
  const size = width === null && height === null ? null : { width, height }
  // Adopt the pre-rename value under the new key; the mount effect then drops the
  // old one, so clearing the key to reset the panel keeps working.
  if (size && !current) writeStoredJson(UM_SIZE_KEY, size)
  return size
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

/**
 * DeepSeek's peak-price windows as UTC minutes-of-day, half-open [start, end).
 * Official wording (api-docs.deepseek.com/quick_start/pricing, read 2026-10-14):
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday,
 * excluding Chinese public holidays. All other hours are off-peak, including
 * weekends and Chinese public holidays in full." That is Beijing time
 * 09:00-12:00 and 14:00-18:00. It is a pricing policy, not a queryable
 * resource: no endpoint reports the current side of the line.
 */
const UM_PEAK_WINDOWS_UTC = [[60, 240], [360, 600]]

/**
 * How far ahead the next price change is looked for, in days. The longest
 * continuous off-peak stretch of 2026 is the Spring Festival block, 10.63 days
 * (2026-02-13T10:00Z → 2026-02-24T01:00Z, measured over the table below), so
 * this leaves room for a longer merged block without scanning far.
 */
const UM_PEAK_LOOKAHEAD_DAYS = 16

/**
 * The years `UM_CHINA_PUBLIC_HOLIDAYS_UTC` covers. A year missing from this list
 * is reported on the card rather than guessed at, because the holiday clause of
 * the rule cannot be answered without it.
 */
const UM_HOLIDAY_YEARS = [2026]

/**
 * Chinese public holidays as UTC date keys (YYYY-MM-DD).
 *
 * The whole published block is listed, not only the statutory days: the official
 * wording excludes "Chinese public holidays" — the published table — and a block
 * that kept its make-up days at peak price would contradict "Chinese public
 * holidays in full". Source: 国务院办公厅国办发明电〔2025〕7 号 (2026
 * arrangement).
 *
 * Make-up workdays that land on a weekend (2026-02-14, 02-28, 05-09, 10-10
 * Saturdays; 01-04, 09-20 Sundays) are deliberately absent: a weekend is
 * off-peak whether or not it is worked, so no 调休 rule is needed. Append the
 * next year's dates once the State Council publishes them.
 */
const UM_CHINA_PUBLIC_HOLIDAYS_UTC = Object.freeze(new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]))

/** The card the peak row belongs to: the windows are a DeepSeek property. */
const UM_PEAK_CARD_ID = 'deepseek-official'
const UM_DAY_MS = 86_400_000

/** `YYYY-MM-DD` of an instant, in UTC. */
function utcDateKey(instant) {
  const date = new Date(instant)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/**
 * Whether an instant is inside DeepSeek's peak-price window.
 *
 * The holiday test comes first, and a weekend is off-peak whether or not it is
 * worked, so a 调休 workday needs no rule of its own. The windows are compared
 * half-open, so 04:00:00.000 UTC is already off-peak.
 */
function isPeakUtc(instant, holidays = UM_CHINA_PUBLIC_HOLIDAYS_UTC) {
  if (holidays.has(utcDateKey(instant))) return false
  const date = new Date(instant)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  for (const window of UM_PEAK_WINDOWS_UTC) {
    if (minute >= window[0] && minute < window[1]) return true
  }
  return false
}

/**
 * The next instant the price changes and which way it goes.
 *
 * A weekend or holiday has to be skipped as a whole: its 01:00 UTC is not a peak
 * opening, so testing the clock alone would report a transition that never
 * happens.
 */
function nextPeakTransition(instant, holidays = UM_CHINA_PUBLIC_HOLIDAYS_UTC) {
  const peakNow = isPeakUtc(instant, holidays)
  const start = new Date(instant)
  const year = start.getUTCFullYear()
  const month = start.getUTCMonth()
  const day = start.getUTCDate()
  for (let offset = 0; offset <= UM_PEAK_LOOKAHEAD_DAYS; offset++) {
    const probe = new Date(Date.UTC(year, month, day + offset))
    const weekday = probe.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    if (holidays.has(utcDateKey(probe.getTime()))) continue
    for (const window of UM_PEAK_WINDOWS_UTC) {
      for (const edge of [[window[0], true], [window[1], false]]) {
        const at = Date.UTC(year, month, day + offset, 0, edge[0])
        if (at > instant && edge[1] !== peakNow) return { toPeak: edge[1], at }
      }
    }
  }
  // Reached only if the table lists an off-peak block longer than the lookahead.
  // Approximate, but the card keeps rendering instead of throwing.
  return { toPeak: !peakNow, at: instant + UM_PEAK_LOOKAHEAD_DAYS * UM_DAY_MS }
}

/**
 * The year the holiday table no longer covers, or null while it still does.
 * Without this the table would go stale silently and misjudge every holiday as
 * peak — the one failure the peak row cannot show by itself.
 */
function uncoveredHolidayYear(instant) {
  const year = new Date(instant).getUTCFullYear()
  return UM_HOLIDAY_YEARS.indexOf(year) === -1 ? year : null
}

/**
 * Locale-aware text for a failure the host described. The host sends a stable
 * `errorCode` next to its own wording; unknown codes fall back to that wording,
 * so an older or newer half still says something specific.
 */
function failureText(failure, t) {
  if (!failure) return ''
  if (failure.errorCode === 'timeout') return t('error.timeout')
  if (failure.errorCode === 'network') return t('error.network')
  if (failure.errorCode === 'http') {
    return Number.isFinite(failure.status)
      ? t('error.http').replace('{status}', String(failure.status))
      : t('error.httpUnknown')
  }
  return typeof failure.error === 'string' ? failure.error : ''
}

/** Message text of a thrown value, without assuming it is an Error. */
function errorText(error, t) {
  // A rejected fetch carries a bare `TypeError: Failed to fetch`; this is the
  // only layer that knows the locale, so the network case is named here.
  if (error instanceof TypeError) return t('error.network')
  return failureText({
    error: error && error.message ? error.message : String(error),
    errorCode: error && error.errorCode,
    status: error && error.status,
  }, t) || String(error)
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
    wallets.map((wallet) => {
      const bonus = typeof wallet.granted === 'string' ? Number(wallet.granted) : 0
      return React.createElement('div', { className: 'um-balance', key: wallet.currency || 'default' },
        React.createElement('div', { className: 'um-balance-total' },
          React.createElement('span', { className: 'um-balance-label' }, t(data.label || 'balance.total')),
          React.createElement('span', { className: 'um-balance-amount' }, formatAmount(wallet.total, wallet.currency))),
        typeof wallet.toppedUp === 'string'
          ? React.createElement('div', { className: 'um-balance-split' },
            React.createElement('span', null, t('balance.toppedUp') + ' ' + formatAmount(wallet.toppedUp, wallet.currency)))
          : null,
        bonus > 0
          ? React.createElement('div', { className: 'um-balance-total um-balance-granted' },
            React.createElement('span', { className: 'um-balance-label' }, t('balance.granted')),
            React.createElement('span', { className: 'um-balance-amount' }, formatAmount(wallet.granted, wallet.currency)))
          : null,
      )
    }),
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

/**
 * Which layer supplies the API key, and whether this surface could change it.
 * Shown only when the card has something to explain — a failed or missing
 * credential — because that is the case this exists for.
 */
function credentialHint(card, t) {
  if (card.source !== 'api-key') return ''
  if (!card.error && card.configured) return ''
  if (typeof card.credentialSource !== 'string' || card.credentialSource === '') return ''
  const text = t('source.from').replace('{source}', card.credentialSource)
  return card.credentialWritable === false ? text + ' · ' + t('source.readonly') : text
}

/**
 * The peak/off-peak row. The windows are a property of the service rather than
 * of a reading, so it renders even when the balance read failed, and a stale
 * holiday table is reported beside the state it affects.
 */
function PeakRow(props) {
  const { now, t } = props
  const peak = isPeakUtc(now)
  const transition = nextPeakTransition(now)
  const remaining = countdownText(formatCountdown(transition.at, now), t)
  const year = uncoveredHolidayYear(now)
  return React.createElement('div', { className: 'um-peak' },
    React.createElement('div', {
      className: 'um-peak-state' + (peak ? ' um-peak-on' : ''),
      title: t('peak.windows'),
    }, t(peak ? 'peak.peak' : 'peak.offPeak').replace('{time}', remaining)),
    year === null
      ? null
      : React.createElement('div', { className: 'um-warn' },
        t('peak.tableStale').replace('{year}', String(year))),
  )
}

function ProviderCard(props) {
  const { card, t, now } = props
  let body
  if (!card.configured) {
    body = React.createElement('div', { className: 'um-muted' }, t('card.notConfigured'))
  } else if (card.error) {
    body = React.createElement('div', { className: 'um-error' }, failureText(card, t))
  } else if (!card.data) {
    body = React.createElement('div', { className: 'um-muted' }, t('card.noData'))
  } else if (card.data.kind === 'balance') {
    body = React.createElement(BalanceBody, { data: card.data, t })
  } else {
    body = React.createElement(QuotaBody, { data: card.data, t, now })
  }
  const sourceLabel = card.source === 'account'
    ? t('source.account')
    : card.source === 'api-key' ? t('source.apiKey') : ''
  const hint = credentialHint(card, t)
  const accountFailure = typeof card.accountError === 'string'
    ? failureText({
      error: card.accountError,
      errorCode: card.accountErrorCode,
      status: card.accountErrorStatus,
    }, t)
    : ''
  const accountNote = accountFailure
    ? t('source.accountFailed').replace('{error}', accountFailure)
    : ''
  return React.createElement('section', { className: 'um-card' + (card.configured ? '' : ' um-card-off') },
    React.createElement('h4', { className: 'um-card-title' },
      card.displayName,
      sourceLabel ? React.createElement('span', { className: 'um-card-source' }, sourceLabel) : null),
    body,
    card.id === UM_PEAK_CARD_ID ? React.createElement(PeakRow, { now, t }) : null,
    hint ? React.createElement('div', { className: 'um-card-hint' }, hint) : null,
    accountNote ? React.createElement('div', { className: 'um-card-hint' }, accountNote) : null,
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
    'aria-controls': UM_PANEL_ID,
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
  // Only the newest load may publish: the 60s tick, a manual refresh and a
  // reopening can overlap, and an older response must not overwrite a newer one.
  const requestSeq = React.useRef(0)

  React.useEffect(() => store.subscribe(() => {
    setOpen(store.isOpen())
    setRevision(store.revision())
  }), [store])

  // The manual-position feature is gone and the size key was renamed; drop both
  // leftovers once (the size itself was already adopted in readStoredSize).
  React.useEffect(() => {
    dropStoredKey(UM_LEGACY_POSITION_KEY)
    dropStoredKey(UM_LEGACY_SIZE_KEY)
  }, [])

  const load = React.useCallback((force) => {
    const request = requestSeq.current + 1
    requestSeq.current = request
    setState((previous) => ({ ...previous, phase: 'loading' }))
    // One source: the host half reads both routes and decides which one the
    // DeepSeek card speaks for, so this half only renders what it is told.
    fetch(UM_ROUTE + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
      .then((response) => {
        if (response.ok) return response.json()
        // The host explains the failure (`请求超时（15000 ms）`) and names it with
        // an `errorCode`; the panel localizes the code and keeps the text only as
        // a fallback for codes it does not know.
        return response.json()
          .catch(() => null)
          .then((body) => {
            const failure = body && typeof body === 'object' ? body : {}
            const error = new Error(typeof failure.error === 'string' ? failure.error : 'HTTP ' + response.status)
            // An older host sends wording without a code; keep that wording rather
            // than flattening it to a status this half would localize.
            error.errorCode = typeof failure.errorCode === 'string' ? failure.errorCode : undefined
            error.status = Number.isFinite(failure.status) ? failure.status : response.status
            throw error
          })
      })
      .then(
        (data) => {
          if (request === requestSeq.current) setState({ phase: 'ready', data, error: null })
        },
        (error) => {
          if (request !== requestSeq.current) return
          setState((previous) => ({ ...previous, phase: 'failed', error: errorText(error, t) }))
        },
      )
  }, [t])

  React.useEffect(() => {
    if (!open) return undefined
    // The component stays mounted while closed, so `now` survives between
    // openings. Without this the first countdown of a session would be measured
    // from the mount (or the previous opening) and so read long by the whole
    // idle period, contradicting the absolute reset clock beside it.
    setNow(Date.now())
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

  // Focus enters the panel on open and returns to the trigger on close, so Esc
  // does not leave a keyboard user at the top of the document.
  const wasOpen = React.useRef(false)
  React.useEffect(() => {
    if (open) {
      const panel = panelRef.current
      if (panel && typeof panel.focus === 'function') panel.focus()
    } else if (wasOpen.current) {
      const trigger = store.button()
      if (trigger && typeof trigger.focus === 'function') trigger.focus()
    }
    wasOpen.current = open
  }, [open, store])

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

  /**
   * The grip is the only resize affordance, so it also answers the arrow keys:
   * Left/Right change the width, Up/Down the height, Shift takes a bigger step.
   */
  const onHandleKeyDown = (event) => {
    const step = event.shiftKey ? UM_KEYBOARD_RESIZE_STEP * 4 : UM_KEYBOARD_RESIZE_STEP
    const maxWidth = placement ? placement.maxWidth : UM_DEFAULT_SIZE.width
    const maxHeight = placement ? placement.maxHeight : UM_DEFAULT_SIZE.height
    const wanted = { width, height }
    if (event.key === 'ArrowLeft') wanted.width = width - step
    else if (event.key === 'ArrowRight') wanted.width = width + step
    else if (event.key === 'ArrowUp') wanted.height = height + step
    else if (event.key === 'ArrowDown') wanted.height = height - step
    else return
    event.preventDefault()
    const next = {
      width: clamp(wanted.width, UM_MIN_SIZE.width, maxWidth),
      height: clamp(wanted.height, UM_MIN_SIZE.height, maxHeight),
    }
    setSize(next)
    writeStoredJson(UM_SIZE_KEY, next)
  }

  const anchorStyle = placement
    ? {
      left: placement.left + 'px',
      bottom: placement.bottom + 'px',
      maxWidth: placement.maxWidth + 'px',
    }
    : { left: '64px', bottom: '16px' }
  // A stored size can predate this window's placement; clamp the box to the
  // space the layer measured so the panel never hangs past its anchor.
  const panelStyle = {
    width: Math.min(width, placement ? placement.maxWidth : width) + 'px',
    height: Math.min(height, placement ? placement.maxHeight : height) + 'px',
    maxHeight: placement ? placement.maxHeight + 'px' : undefined,
  }

  return React.createElement('div', { className: 'um-anchor', ref: rootRef, style: anchorStyle },
    React.createElement('div', {
      className: 'um-panel' + (resizing ? ' um-panel-resizing' : ''),
      ref: panelRef,
      id: UM_PANEL_ID,
      role: 'dialog',
      tabIndex: -1,
      // Labelled by the visible heading. It is deliberately not aria-modal: the
      // page behind stays operable (outside presses close it), so claiming
      // modality would hide live content from assistive tech.
      'aria-labelledby': UM_PANEL_TITLE_ID,
      style: panelStyle,
    },
      React.createElement('header', { className: 'um-panel-head' },
        React.createElement('span', { className: 'um-panel-title', id: UM_PANEL_TITLE_ID }, t('panel.title')),
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
          ? React.createElement('div', { className: cards.length === 0 ? 'um-error' : 'um-warn' },
            t(cards.length === 0 ? 'panel.failed' : 'panel.stale').replace('{reason}', state.error))
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
        tabIndex: 0,
        onKeyDown: onHandleKeyDown,
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
  'panel.resize': '拖动或方向键调整大小',
  'panel.loading': '正在读取…',
  'panel.failed': '读取失败：{reason}',
  'panel.stale': '刷新失败，显示上次数据：{reason}',
  'error.timeout': '请求超时',
  'error.network': '网络请求失败（本地服务可能未就绪）',
  'error.http': '服务端返回 HTTP {status}',
  'error.httpUnknown': '服务端拒绝了请求',
  'panel.none': '没有已配置的服务商凭据。',
  'card.notConfigured': '未配置凭据，已跳过。',
  'card.noData': '无数据。',
  'source.account': '账号登录',
  'source.apiKey': 'API Key',
  'source.from': '来源：{source}',
  'source.readonly': '只读',
  'source.accountFailed': '账号余额读取失败：{error}',
  'balance.total': '总余额',
  'balance.recharge': '充值余额',
  'balance.toppedUp': '充值',
  'balance.granted': '赠金',
  'balance.empty': '没有余额信息。',
  'balance.unavailable': '余额不足，API 调用可能失败。',
  'window.rolling': '5 小时',
  'window.weekly': '7 天',
  'window.monthly': '每月',
  'quota.remaining': '{time}后重置',
  'quota.resetsAt': '{time}',
  'quota.noReset': '无重置时间',
  'peak.peak': '高峰时段 · 距低谷 {time}',
  'peak.offPeak': '低谷时段 · 距高峰 {time}',
  'peak.windows': '高峰：周一至周五 09:00–12:00、14:00–18:00（北京时间）；周末与中国法定节假日全天均为低谷',
  'peak.tableStale': '节假日表未覆盖 {year} 年，峰谷判定可能不准，请补充数据。',
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
  'panel.resize': 'Drag, or use the arrow keys, to resize',
  'panel.loading': 'Loading…',
  'panel.failed': 'Request failed: {reason}',
  'panel.stale': 'Refresh failed; showing the last values: {reason}',
  'error.timeout': 'The request timed out',
  'error.network': 'Network request failed (the local service may not be ready)',
  'error.http': 'The server returned HTTP {status}',
  'error.httpUnknown': 'The server refused the request',
  'panel.none': 'No configured provider credentials.',
  'card.notConfigured': 'No credential configured; skipped.',
  'card.noData': 'No data.',
  'source.account': 'Account sign-in',
  'source.apiKey': 'API Key',
  'source.from': 'Source: {source}',
  'source.readonly': 'read-only',
  'source.accountFailed': 'Account balance read failed: {error}',
  'balance.total': 'Total',
  'balance.recharge': 'Recharge balance',
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
  'peak.peak': 'Peak · off-peak in {time}',
  'peak.offPeak': 'Off-peak · peak in {time}',
  'peak.windows': 'Peak: Mon–Fri 09:00–12:00 and 14:00–18:00 Beijing time; weekends and Chinese public holidays are off-peak all day',
  'peak.tableStale': 'The holiday table does not cover {year}, so the peak/off-peak state may be wrong. Please add the dates.',
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
.um-card-source { margin-left: 6px; font-weight: 400; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.um-card-hint { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); word-break: break-word; }
.um-balances { display: flex; flex-direction: column; gap: 8px; }
.um-balance-total { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.um-balance-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.um-balance-amount { font-size: 17px; font-weight: 650; font-variant-numeric: tabular-nums; }
.um-balance-split { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.um-balance-granted .um-balance-amount { font-size: 13px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
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
.um-peak { margin-top: 8px; padding-top: 8px; border-top: .5px solid var(--dsw-alias-border-l1); }
.um-peak-state { font-size: 11px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.um-peak-on { color: var(--dsw-alias-state-warning-primary, #f59e0b); }
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
    // register() returns nothing (checked against dsh-client-locale's client
    // half), so the effect has no disposer to hand back; the unique name is the
    // only thing that keeps a reload usable.
    const ns = 'dsh-plan-spend.' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    if (locale) {
      ctx.effect(() => locale.register(ns, 'zh', ZH_DICT), 'dsh-plan-spend: zh dict')
      ctx.effect(() => locale.register(ns, 'en', EN_DICT), 'dsh-plan-spend: en dict')
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
        id: 'dsh-plan-spend',
        order: UM_TRIGGER_ORDER,
      }, (props) => React.createElement(UsageTrigger, {
        t,
        store,
        wide: props ? props.wide : true,
      })))

      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-plan-spend',
        order: UM_PANEL_ORDER,
      }, () => React.createElement(UsagePanel, { t, store })))
    }

    ctx.effect(() => styles.insert(UM_CSS), 'dsh-plan-spend: styles')
  },
}
