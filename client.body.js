/**
 * Plan Spend — dynamic Cordis plugin, CLIENT half.
 *
 * The whole file body is the plain-JavaScript function body that returns a
 * Cordis Plugin ({ apply(ctx) { ... } }). No imports / TS / JSX allowed:
 * `React` and `styles` arrive from the wrapper that scripts/build-client.mjs
 * generates around this file.
 *
 * --- Where the UI lives ---
 * Two seats, both owned by the shipped navigation:
 * - `sidebar.panellist` (id 'dsh-plan-spend', order 20) is the sidebar's own
 *   navigation row, so the entry sits between 自动化任务 (10) and 记忆系统 (30),
 *   collapses to its glyph on the rail, and shows the active state the way the
 *   shipped rows do.
 * - `main` (keyed by the same id) is the middle column's page. Selecting the
 *   row replaces the conversation with the meter page, so the meter can never
 *   overlap what the conversation is showing, and the row behaves exactly like
 *   the shipped rows beside it.
 *
 * --- What the page shows ---
 * The snapshot is re-read on mount and every minute, with a manual refresh in
 * the page header; the countdowns re-tick every 30s while the page is mounted.
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
const UM_PANEL_ID = 'dsh-plan-spend'
/** Sits between 自动化任务 (10) and 记忆系统 (30) in the navigation list. */
const UM_NAV_ORDER = 20
/** The shipped sidebar glyph size; the row is one of the sidebar's own rows. */
const UM_ICON_SIZE = 16

const WINDOW_ORDER = ['rolling', 'weekly', 'monthly']

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
  if (failure.errorCode === 'http' && Number.isFinite(failure.status)) {
    return t('error.http').replace('{status}', String(failure.status))
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
  if (card.error) {
    // The host pairs a failure with its reason; showing "not configured" first
    // would hide the reason it sent alongside.
    body = React.createElement('div', { className: 'um-error' }, failureText(card, t))
  } else if (!card.configured) {
    body = React.createElement('div', { className: 'um-muted' }, t('card.notConfigured'))
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
  const account_failure = failureText(card.accountFailure, t)
  const account_note = account_failure
    ? t('source.accountFailed').replace('{error}', account_failure)
    : ''
  return React.createElement('section', { className: 'um-card' + (card.configured ? '' : ' um-card-off') },
    React.createElement('h4', { className: 'um-card-title' },
      card.displayName,
      sourceLabel ? React.createElement('span', { className: 'um-card-source' }, sourceLabel) : null),
    body,
    card.id === UM_PEAK_CARD_ID ? React.createElement(PeakRow, { now, t }) : null,
    hint ? React.createElement('div', { className: 'um-card-hint' }, hint) : null,
    account_note ? React.createElement('div', { className: 'um-card-hint' }, account_note) : null,
  )
}

/**
 * The `sidebar.panellist` entry: the gauge glyph the navigation row carries.
 * Every row in that list is a single glyph, so the entry renders only the mark
 * and lets the sidebar draw the row, its active state and its label.
 */
function UsageIcon(props) {
  const size = props && props.size ? props.size : UM_ICON_SIZE
  return React.createElement('svg', {
    className: 'um-nav-icon',
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1,
  },
    // The icon set's own gauge glyph: a 16px grid, 1px stroke, a 270° dial with
    // a 45° needle and a filled 1.25r hub, so the row matches the shipped rows.
    React.createElement('path', { d: 'M3.4041 13.096C2.49514 12.187 1.87614 11.0288 1.62537 9.76798C1.37459 8.50716 1.50331 7.20028 1.99525 6.01261C2.48719 4.82494 3.32025 3.80981 4.3891 3.09557C5.45795 2.38134 6.71458 2.00008 8.0001 2C9.28563 2.00008 10.5423 2.38134 11.6111 3.09557C12.68 3.80981 13.513 4.82494 14.005 6.01261C14.4969 7.20028 14.6256 8.50716 14.3748 9.76798C14.1241 11.0288 13.5051 12.187 12.5961 13.096' }),
    React.createElement('path', { d: 'M8 8.49994L11.6114 4.88855' }),
    React.createElement('path', { d: 'M8 9.75C8.69036 9.75 9.25 9.19036 9.25 8.5C9.25 7.80964 8.69036 7.25 8 7.25C7.30964 7.25 6.75 7.80964 6.75 8.5C6.75 9.19036 7.30964 9.75 8 9.75Z', fill: 'currentColor', stroke: 'none' }))
}

/**
 * The `main` entry, keyed by the row's id: selecting the row replaces the
 * conversation with this page, so the meter can never overlap what the
 * conversation is showing.
 */
function UsagePage(props) {
  const { t } = props
  const [state, setState] = React.useState({ phase: 'loading', data: null, error: null })
  const [now, setNow] = React.useState(() => Date.now())
  // Only the newest load may publish: the 60s tick and a manual refresh can
  // overlap, and an older response must not overwrite a newer one.
  const request_seq = React.useRef(0)

  const load = React.useCallback((force) => {
    const request = request_seq.current + 1
    request_seq.current = request
    setState((previous) => ({ ...previous, phase: 'loading' }))
    // One source: the host half reads both routes and decides which one the
    // DeepSeek card speaks for, so this half only renders what it is told.
    fetch(UM_ROUTE + (force ? '?refresh=1' : ''), { headers: { accept: 'application/json' } })
      .then((response) => {
        if (response.ok) return response.json()
        // The host explains the failure (`请求超时（15000 ms）`) and names it with
        // an `errorCode`; the page localizes the code and keeps the text only as
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
          if (request === request_seq.current) setState({ phase: 'ready', data, error: null })
        },
        (error) => {
          if (request !== request_seq.current) return
          setState((previous) => ({ ...previous, phase: 'failed', error: errorText(error, t) }))
        },
      )
  }, [t])

  // The page mounts with the route and unmounts when another row is selected,
  // so one effect owns both the snapshot and the two clocks.
  React.useEffect(() => {
    setNow(Date.now())
    load(false)
    const refresh = setInterval(() => load(false), UM_REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => { clearInterval(refresh); clearInterval(tick) }
  }, [load])

  const cards = state.data && Array.isArray(state.data.cards) ? state.data.cards : []
  const configured = cards.filter((card) => card.configured)
  const stamp = state.data && state.data.generatedAt ? formatClock(state.data.generatedAt) : ''

  return React.createElement('section', {
    className: 'um-page',
    'aria-busy': state.phase === 'loading' ? true : undefined,
  },
    // The page header is the frame's drag handle, like every other panel page.
    React.createElement('header', { className: 'um-page-head', 'data-window-drag': true },
      React.createElement('div', { className: 'um-page-heading' },
        React.createElement('h1', { className: 'um-page-title' }, t('panel.title')),
        stamp
          ? React.createElement('p', { className: 'um-page-intro' }, t('panel.updated').replace('{time}', stamp))
          : null),
      React.createElement('div', { className: 'um-toolbar' },
        React.createElement('button', {
          className: 'um-icon-button',
          type: 'button',
          title: t('panel.refresh'),
          'aria-label': t('panel.refresh'),
          'aria-busy': state.phase === 'loading' ? true : undefined,
          onClick: () => load(true),
        }, '⟳'))),
    React.createElement('div', { className: 'um-page-body' },
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
      cards.length === 0
        ? null
        : React.createElement('div', { className: 'um-page-cards' },
          cards.map((card) => React.createElement(ProviderCard, { key: card.id, card, t, now })))))
}

const ZH_DICT = {
  'button.label': '用量',
  'panel.title': '套餐用量',
  'panel.refresh': '刷新',
  'panel.updated': '更新于 {time}',
  'panel.loading': '正在读取…',
  'panel.failed': '读取失败：{reason}',
  'panel.stale': '刷新失败，显示上次数据：{reason}',
  'error.timeout': '请求超时',
  'error.network': '网络请求失败（本地服务可能未就绪）',
  'error.http': '服务端返回 HTTP {status}',
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
  'panel.title': 'Plan usage',
  'panel.refresh': 'Refresh',
  'panel.updated': 'Updated {time}',
  'panel.loading': 'Loading…',
  'panel.failed': 'Request failed: {reason}',
  'panel.stale': 'Refresh failed; showing the last values: {reason}',
  'error.timeout': 'The request timed out',
  'error.network': 'Network request failed (the local service may not be ready)',
  'error.http': 'The server returned HTTP {status}',
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
.um-nav-icon { flex: none; display: block; }
.um-page { box-sizing: border-box; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 32px; padding: 0 clamp(24px, 4vw, 48px) 48px; overflow: auto; color: var(--dsw-alias-label-primary); }
.um-page > * { width: 100%; max-width: 960px; }
.um-page-head { box-sizing: border-box; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 16px; padding-top: 28px; display: flex; }
[data-platform=darwin] .um-page-head { padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px)); }
.um-page-heading { min-width: 0; }
.um-page-title { margin: 0; font-size: 20px; font-weight: 500; line-height: 28px; }
.um-page-intro { color: var(--dsw-alias-label-secondary); align-items: center; gap: 4px; margin: 4px 0 0; font-size: 13px; line-height: 20px; display: flex; font-variant-numeric: tabular-nums; }
.um-toolbar { white-space: nowrap; flex: none; justify-content: flex-end; align-items: center; gap: 16px; display: flex; }
.um-icon-button { border-radius: var(--dsw-radius-sm, 6px); width: 28px; height: 28px; padding: 0; color: var(--dsw-alias-label-caption, var(--dsw-alias-label-secondary)); cursor: pointer; background: 0 0; border: 0; justify-content: center; align-items: center; display: inline-flex; font-size: 15px; line-height: 1; }
.um-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.um-page-body { display: flex; flex-direction: column; gap: 16px; }
.um-page-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); align-items: start; gap: 16px; }
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
`

return {
  name: 'dsh-plan-spend',
  // Declared on the exported plugin so Cordis withholds `apply` until both are
  // provided. Without it `ctx.get('locale')` can observe a service that is not
  // there yet, which silently degrades `t` into a key-echoing identity function.
  inject: ['slots', 'locale'],
  apply(ctx) {
    const locale = ctx.get('locale')
    // One stable namespace: register hands back an idempotent disposer, so the
    // effect cleanup leaves no empty namespace in the process-wide registry.
    // Both languages go in a single call so a reload cannot half-apply them.
    if (locale) {
      ctx.effect(() => locale.register('dsh-plan-spend', { zh: ZH_DICT, en: EN_DICT }), 'dsh-plan-spend: dictionaries')
    }
    const t = locale ? locale.bind('dsh-plan-spend') : ((key) => key)

    const slots = ctx.get('slots')
    if (slots) {
      // One id, two seats: the navigation row and the keyed page it selects.
      // Selecting the row therefore swaps the conversation out for the page
      // instead of floating over it, exactly like the shipped rows beside it.
      slots.inject('main', () => slots.register({
        name: 'main',
        key: UM_PANEL_ID,
        locale: 'dsh-plan-spend',
      }, UsagePage))

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: UM_PANEL_ID,
        order: UM_NAV_ORDER,
        label: () => t('button.label'),
        locale: 'dsh-plan-spend',
      }, UsageIcon))
    }

    ctx.effect(() => styles.insert(UM_CSS), 'dsh-plan-spend: styles')
  },
}
