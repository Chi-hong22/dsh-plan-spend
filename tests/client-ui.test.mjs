/**
 * Behaviour tests for the client half: the navigation row and the meter page.
 *
 * The client body is loaded exactly as the browser bundle loads it — the bare
 * function body from `client.body.js`, invoked with React and `styles` — and
 * driven through the real registration path: `apply(ctx)` reaches both slot
 * registrations, and each registered component is rendered with its own hook
 * store.
 *
 * The two seats share one id. The sidebar row is what the shell renders for
 * `sidebar.panellist`; the page is the `main` entry that row selects, so the
 * meter replaces the conversation instead of floating above it. The row is
 * handed only the glyph size and its active flag, the page gets `t` from its
 * declared locale, and both are exercised with exactly those props.
 *
 * The hook stores are dispatched the way React does it: the body closes over a
 * single React binding, so each hook call resolves against whichever component
 * a render set as current. Effects are queued and run once the component has
 * rendered, mirroring React's commit-then-effect order — that is what starts
 * the snapshot load and the refresh timers when the page mounts.
 *
 * Covered: both slot contracts, the row's glyph, the page's initial load,
 * manual refresh, timers, the loading state and the rendered card content.
 * Layout, paint and CSS are not observable here.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BODY = readFileSync(new URL('../client.body.js', import.meta.url), 'utf8')

/** The single React binding the body closes over, dispatching to the current component. */
function createReactDispatcher() {
  let current = null
  return {
    setCurrent(store) { current = store },
    api: {
      createElement(type, props, ...children) {
        const child = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
        return { type, props: Object.assign({}, props, { children: child }) }
      },
      useState(initial) { return current.useState(initial) },
      useRef(initial) { return current.useRef(initial) },
      useCallback(callback) { return current.useCallback(callback) },
      useEffect(callback, deps) { return current.useEffect(callback, deps) },
    },
  }
}

/** One component instance's hook store, in the body's hook order. */
function createHookStore(onStateChange) {
  const hooks = []
  let cursor = 0
  let pending = []
  return {
    hooks,
    begin() { cursor = 0 },
    takePending() { const batch = pending; pending = []; return batch },
    hasPending() { return pending.length > 0 },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      return [hooks[index], (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (Object.is(value, hooks[index])) return
        hooks[index] = value
        onStateChange()
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(callback) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = callback
      return hooks[index]
    },
    useEffect(callback, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed = !previous || !previous.deps || !deps || previous.deps.length !== deps.length
        || deps.some((dep, position) => !Object.is(dep, previous.deps[position]))
      if (!changed) return
      hooks[index] = { deps, cleanup: previous ? previous.cleanup : undefined, callback }
      pending.push(index)
    },
  }
}

/** Resolves a registered component element down to the host element tree. */
function renderTree(element) {
  return element && typeof element.type === 'function' ? renderTree(element.type(element.props)) : element
}

/** A localStorage stand-in that records reads, writes and removals. */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    raw: map,
  }
}

/** A document stand-in that records listeners so tests can dispatch and audit them. */
function createDocumentStub() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(listener)
    },
    removeEventListener(type, listener) {
      const set = listeners.get(type)
      if (set) set.delete(listener)
    },
    dispatch(type, event) {
      for (const listener of Array.from(listeners.get(type) || [])) listener(event)
    },
    count() {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
  }
}

/** Loads the plugin body and drives the row plus the page it selects. */
function mountPlugin(storage, options = {}) {
  const react = createReactDispatcher()
  // Timers and fetch are handed to the body, not taken from the globals: a real
  // setInterval would keep the test process alive after the run.
  const timers = new Map()
  let timerId = 0
  const setIntervalStub = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id }
  const clearIntervalStub = (id) => { timers.delete(id) }
  const fetchStub = options.fetch || (() => Promise.reject(new Error('offline in tests')))

  const doc = createDocumentStub()
  const factory = new Function(
    'React', 'styles', 'localStorage', 'setInterval', 'clearInterval', 'fetch', 'document', BODY,
  )
  const plugin = factory(react.api, { insert: () => {} }, storage, setIntervalStub, clearIntervalStub, fetchStub, doc)

  const registered = {}
  const injected = []
  const slots = {
    inject(key, callback) {
      assert.ok(key === 'sidebar.panellist' || key === 'main', `unexpected slot ${key}`)
      injected.push(key)
      callback()
    },
    register(definition, component) {
      registered[definition.name] = { definition, component }
    },
  }
  // A locale stub that actually resolves: `bind` reads whichever dictionary the
  // plugin registered for the active language, so tests can assert real copy.
  const dictionaries = new Map()
  const registrations = []
  const disposers = []
  const activeLanguage = options.language || 'zh'
  const locale = {
    register: (ns, languageOrDictionaries, dictionary) => {
      const pairs = typeof languageOrDictionaries === 'string'
        ? [[languageOrDictionaries, dictionary]]
        : Object.entries(languageOrDictionaries)
      registrations.push({ ns, languages: pairs.map(([language]) => language) })
      for (const [language, entries] of pairs) dictionaries.set(language, entries)
      // The real register returns an idempotent disposer; mirror that so the
      // cleanup path is observable in tests.
      return () => { for (const [language] of pairs) dictionaries.delete(language) }
    },
    bind: () => (key) => {
      const dictionary = dictionaries.get(activeLanguage)
      return dictionary && dictionary[key] !== undefined ? dictionary[key] : key
    },
    getSnapshot: () => ({ active: activeLanguage, revision: 1 }),
  }
  const services = { slots, locale }
  plugin.apply({
    get: (name) => services[name] || null,
    effect: (fn) => { disposers.push(fn()); return () => {} },
  })

  // A navigation row selects a `main` entry by the key it names, so both seats
  // must be registered under one id; the row's order is what places it in the
  // panel list, between the schedule row (10) and the memory row (30).
  assert.deepEqual(registered.main.definition, {
    name: 'main', key: 'dsh-plan-spend', locale: 'dsh-plan-spend',
  })
  const rowDefinition = registered['sidebar.panellist'].definition
  assert.equal(rowDefinition.name, 'sidebar.panellist')
  assert.equal(rowDefinition.id, 'dsh-plan-spend')
  assert.equal(rowDefinition.order, 20)
  assert.equal(rowDefinition.locale, 'dsh-plan-spend')
  assert.equal(typeof rowDefinition.label, 'function', 'the label is resolved per render')

  function createInstance(name, initialProps) {
    let props = initialProps
    let tree = null
    let store = null
    const render = () => {
      react.setCurrent(store)
      store.begin()
      tree = renderTree(registered[name].component(props))
    }
    store = createHookStore(render)
    render()
    return {
      get tree() { return tree },
      get state() { return store },
      setProps(next) { props = Object.assign({}, props, next); render() },
    }
  }

  // The renderer resolves the page's `t` from the declared locale; the row is
  // handed the glyph size and whether its panel is the active one.
  const page = createInstance('main', { t: locale.bind('dsh-plan-spend') })
  const navRow = createInstance('sidebar.panellist', { size: 16, active: false })

  const settleOne = (instance) => {
    for (let guard = 0; guard < 20; guard++) {
      const batch = instance.state.takePending()
      if (batch.length === 0) break
      for (const index of batch) {
        const slot = instance.state.hooks[index]
        if (slot.cleanup) slot.cleanup()
        slot.cleanup = slot.callback() || undefined
      }
    }
  }

  return {
    page,
    row: navRow,
    plugin,
    doc,
    injected,
    registrations,
    disposers,
    label: () => rowDefinition.label(),
    get timers() { return Array.from(timers.values()) },
    /** Commits both components' effects, alternating while they keep re-queueing. */
    settle() {
      for (let guard = 0; guard < 20; guard++) {
        if (!page.state.hasPending() && !navRow.state.hasPending()) break
        settleOne(page)
        settleOne(navRow)
      }
    },
  }
}

/** The page's rendered host tree. */
function pageOf(harness) {
  assert.ok(harness.page.tree, 'the page did not render')
  return harness.page.tree
}

/** The page header's refresh button. */
function refreshOf(harness) {
  return pageOf(harness).props.children[0].props.children[1].props.children
}

test('registers one id as a navigation row and the page it selects', () => {
  const harness = mountPlugin(createStorage())

  // The mount asserts both definitions; what is left to check is that the plugin
  // claims exactly these two seats and registers its dictionary once.
  assert.deepEqual(harness.injected.slice().sort(), ['main', 'sidebar.panellist'])
  assert.equal(harness.registrations.length, 1, 'one dictionary registration')
  assert.deepEqual(harness.registrations[0].languages, ['zh', 'en'])
  assert.equal(harness.label(), '用量')
  assert.equal(harness.doc.count(), 0, 'the page installs no document listeners')
})

test('the row renders only the gauge glyph, sized by the sidebar', () => {
  // The shell's PanelRow draws the label and hands the glyph just a size, so the
  // icon must carry the rail's own 16px (18px when narrow) geometry.
  const harness = mountPlugin(createStorage())
  const glyph = harness.row.tree

  assert.equal(glyph.type, 'svg')
  assert.equal(glyph.props.className, 'um-nav-icon')
  assert.equal(glyph.props.viewBox, '0 0 16 16')
  assert.equal(glyph.props.width, 16)
  assert.equal(glyph.props.height, 16)
  assert.equal(glyph.props.strokeWidth, 1)
  assert.equal(glyph.props.fill, 'none')
  assert.equal(glyph.props.stroke, 'currentColor')
  assert.equal(glyph.props.children.length, 3, 'dial, needle and hub')

  harness.row.setProps({ size: 18, active: true })
  assert.equal(harness.row.tree.props.width, 18)
})

test('mounting the page loads a snapshot and schedules the refresh clocks', () => {
  const calls = []
  const harness = mountPlugin(createStorage(), {
    fetch: (url) => { calls.push(url); return snapshotOf([])() },
  })
  harness.settle()

  assert.deepEqual(calls, ['/dsh-plan-spend/snapshot'], 'the page reads once on mount')
  const intervals = harness.timers.map((timer) => timer.ms).sort((left, right) => left - right)
  assert.deepEqual(intervals, [30_000, 60_000], 'one snapshot refresh, one countdown tick')

  harness.timers.find((timer) => timer.ms === 60_000).callback()
  assert.equal(calls.length, 2, 'the minute tick re-reads the snapshot')
})

test('the page reports loading until the first snapshot arrives', () => {
  const harness = mountPlugin(createStorage(), { fetch: () => new Promise(() => {}) })
  harness.settle()

  assert.equal(pageOf(harness).props['aria-busy'], true)
  assert.match(pageText(harness), /正在读取/)
})

test('the header refresh asks the host to bypass its cache', () => {
  const calls = []
  const harness = mountPlugin(createStorage(), {
    fetch: (url) => { calls.push(url); return snapshotOf([])() },
  })
  harness.settle()
  refreshOf(harness).props.onClick()
  harness.settle()

  assert.deepEqual(calls, ['/dsh-plan-spend/snapshot', '/dsh-plan-spend/snapshot?refresh=1'])
  assert.equal(refreshOf(harness).props['aria-label'], '刷新')
})

test('the heading and the row label come from the plugin dictionary', () => {
  const harness = mountPlugin(createStorage())
  assert.match(pageText(harness), /套餐用量/)

  const english = mountPlugin(createStorage(), { language: 'en' })
  assert.match(pageText(english), /Plan usage/)
  assert.equal(english.label(), 'Usage')

  for (const dispose of english.disposers) if (typeof dispose === 'function') dispose()
  assert.equal(english.label(), 'button.label', 'without a dictionary the key shows through')
})

/** Expands every function component in an element tree, so its text is reachable. */
function expandTree(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(expandTree)
  if (typeof node !== 'object' || node === null) return node
  const element = typeof node.type === 'function' ? expandTree(node.type(node.props)) : node
  if (element === null || typeof element !== 'object' || Array.isArray(element)) return element
  const children = element.props ? element.props.children : undefined
  if (children === undefined) return element
  return Object.assign({}, element, { props: Object.assign({}, element.props, { children: expandTree(children) }) })
}

/** Every string in an element tree, in document order. */
function collectText(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out }
  if (node && typeof node === 'object') collectText(node.props ? node.props.children : null, out)
  return out
}

function pageText(harness) {
  return collectText(expandTree(pageOf(harness))).join(' ')
}

/** Lets the page's single async source settle and re-render. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function snapshotOf(cards) {
  return () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ generatedAt: 1_700_000_000_000, cards }),
  })
}

/** Renders the page against a fixed snapshot. */
function openWithSnapshot(cards) {
  const harness = mountPlugin(createStorage(), { fetch: snapshotOf(cards) })
  harness.settle()
  return harness
}

test('the account card renders the recharge balance and no bonus row when there is none', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'account',
      configured: true,
      data: { kind: 'balance', label: 'balance.recharge', wallets: [{ currency: 'CNY', total: '12.34' }] },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /账号登录/)
  assert.match(text, /充值余额/)
  assert.match(text, /12\.34/)
  assert.doesNotMatch(text, /赠金/, 'no bonus row without a granted wallet')
  assert.doesNotMatch(text, /充值 ¥/, 'the account card carries no topped-up split')
})

test('a granted wallet renders as its own row below the recharge balance', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'account',
      configured: true,
      data: {
        kind: 'balance',
        label: 'balance.recharge',
        wallets: [{ currency: 'CNY', total: '1.12', granted: '0.50' }],
      },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /赠金 ¥0\.50/)
  assert.ok(text.indexOf('充值余额') < text.indexOf('赠金'), 'the bonus row follows the recharge row')
})

test('a granted wallet of zero renders no bonus row', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'account',
      configured: true,
      data: {
        kind: 'balance',
        label: 'balance.recharge',
        wallets: [{ currency: 'CNY', total: '1.12', granted: '0.00' }],
      },
    },
  ])
  await flush()

  assert.doesNotMatch(pageText(harness), /赠金/)
})

test('the API-key card keeps its total and topped-up split', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'api-key',
      configured: true,
      data: {
        kind: 'balance',
        label: 'balance.total',
        wallets: [{ currency: 'CNY', total: '3.17', toppedUp: '2.67' }],
      },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /API Key/)
  assert.match(text, /总余额/)
  assert.match(text, /3\.17/)
  assert.match(text, /充值 ¥2\.67/)
})

test('a failing API-key read reports the credential layer and its writability', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'api-key',
      configured: true,
      error: 'HTTP 401',
      credentialSource: 'environment',
      credentialWritable: false,
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /HTTP 401/)
  assert.match(text, /来源：environment/)
  assert.match(text, /只读/)
})

test('a failed account query is reported once on the fallback card', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      source: 'api-key',
      configured: true,
      accountFailure: { error: 'HTTP 429' },
      data: { kind: 'balance', label: 'balance.total', wallets: [{ currency: 'CNY', total: '3.17' }] },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /3\.17/)
  assert.match(text, /账号余额读取失败：HTTP 429/)
  assert.equal(text.split('账号余额读取失败').length - 1, 1, 'the note is written once')
})

test('an unreadable credential shows its reason instead of "not configured"', async () => {
  const harness = openWithSnapshot([
    {
      id: 'deepseek-official',
      displayName: 'DeepSeek 官方',
      configured: false,
      error: 'credentials: storage',
      errorCode: 'unknown',
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /credentials: storage/)
  assert.doesNotMatch(text, /未配置/)
})

test('host cards render as sent, including the quota windows', async () => {
  const harness = openWithSnapshot([
    {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      configured: true,
      data: { kind: 'quota-windows', windows: [{ id: 'rolling', status: 'ok', percent: 5, resetsAt: null }] },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.match(text, /OpenCode Go/)
  assert.match(text, /5 小时/)
  assert.match(text, /5%/)
})

/**
 * A Date stand-in with a controllable clock. The body resolves `Date` from the
 * global scope on every call, so patching it is enough to make a countdown
 * deterministic without handing the body a clock parameter.
 */
function makeTestDate(clock) {
  const RealDate = globalThis.Date
  return class TestDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.value)
      else super(...args)
    }
    static now() { return clock.value }
  }
}

/** Pins the clock for the duration of `body`, so a rendered countdown is exact. */
async function withClock(iso, body) {
  const clock = { value: Date.parse(iso) }
  const realDate = globalThis.Date
  globalThis.Date = makeTestDate(clock)
  try {
    return await body(clock)
  } finally {
    globalThis.Date = realDate
  }
}

/** The DeepSeek card payload the peak row rides on. */
const DEEPSEEK_BALANCE_CARD = {
  id: 'deepseek-official',
  displayName: 'DeepSeek 官方',
  source: 'api-key',
  configured: true,
  data: { kind: 'balance', label: 'balance.total', wallets: [{ currency: 'CNY', total: '3.17' }] },
}

/** Opens the panel on a DeepSeek card with the clock pinned to one instant. */
function openDeepseekAt(iso) {
  return withClock(iso, async () => {
    const harness = openWithSnapshot([DEEPSEEK_BALANCE_CARD])
    await flush()
    return harness
  })
}

test('the DeepSeek card reports peak hours and the wait for off-peak', async () => {
  // 2026-10-14 is a Wednesday, and 02:00 UTC is inside the 01:00-04:00 window.
  const harness = await openDeepseekAt('2026-10-14T02:00:00Z')
  const text = pageText(harness)
  assert.match(text, /高峰时段/)
  assert.match(text, /2 小时 0 分/)
})

test('off-peak counts down to the next peak opening', async () => {
  const harness = await openDeepseekAt('2026-10-14T05:00:00Z')
  const text = pageText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /1 小时 0 分/)
})

test('the peak window is half-open: 04:00:00 UTC is already off-peak', async () => {
  const harness = await openDeepseekAt('2026-10-14T04:00:00Z')
  assert.match(pageText(harness), /低谷时段/)
})

test('a weekend is off-peak and the countdown skips to Monday', async () => {
  // 2026-10-17 is a Saturday; the next peak opening is Monday 01:00 UTC.
  const harness = await openDeepseekAt('2026-10-17T02:00:00Z')
  const text = pageText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /1 天 23 小时/)
})

test('a make-up workday that lands on a weekend is still off-peak', async () => {
  // 2026-02-14 is a 调休 Saturday. The weekend rule alone settles it, which is
  // why the table needs no workday rule; the next peak is after Spring Festival.
  const harness = await openDeepseekAt('2026-02-14T02:00:00Z')
  const text = pageText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /9 天 23 小时/)
})

test('a public holiday on a weekday is off-peak, and the same weekday after it is peak', async () => {
  // 2026-10-01 (Thursday, National Day) against 2026-10-08 (Thursday, back at work).
  const holiday = await openDeepseekAt('2026-10-01T02:00:00Z')
  assert.match(pageText(holiday), /低谷时段/)

  const workday = await openDeepseekAt('2026-10-08T02:00:00Z')
  assert.match(pageText(workday), /高峰时段/)
})

test('the countdown crosses a holiday block instead of landing inside it', async () => {
  // From inside the National Day block the next peak opening is a week out; a
  // clock-only walk would have called the next 01:00 UTC a transition.
  const harness = await openDeepseekAt('2026-10-01T02:00:00Z')
  assert.match(pageText(harness), /6 天 23 小时/)
})

test('a table that no longer covers the year is reported on the card', async () => {
  // 2027-01-04 is a Monday, so the clock alone would say peak; with no 2027 in
  // the table the holiday clause is unanswerable, and the card says so.
  const harness = await openDeepseekAt('2027-01-04T02:00:00Z')
  const text = pageText(harness)
  assert.match(text, /节假日表未覆盖 2027 年/)
  assert.match(text, /请补充数据/)
})

test('a covered year shows no stale notice', async () => {
  const harness = await openDeepseekAt('2026-10-14T02:00:00Z')
  assert.doesNotMatch(pageText(harness), /节假日表/)
})

test('the peak row belongs to the DeepSeek card alone', async () => {
  const harness = openWithSnapshot([
    {
      id: 'opencode-go',
      displayName: 'OpenCode Go',
      configured: true,
      data: { kind: 'quota-windows', windows: [{ id: 'rolling', status: 'ok', percent: 5, resetsAt: null }] },
    },
  ])
  await flush()

  const text = pageText(harness)
  assert.doesNotMatch(text, /高峰时段/)
  assert.doesNotMatch(text, /低谷时段/)
})

test('a failed load shows the reason the host reported, not a bare status', async () => {
  const harness = mountPlugin(createStorage(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: '请求超时（15000 ms）' }),
    }),
  })
  harness.settle()
  await flush()

  const text = pageText(harness)
  assert.match(text, /读取失败：请求超时（15000 ms）/)
  assert.doesNotMatch(text, /HTTP 500/, 'the status is not surfaced when the host explained itself')
})

test('a refresh failure keeps the last snapshot and labels it stale', async () => {
  let online = true
  const harness = mountPlugin(createStorage(), {
    fetch: () => (online
      ? Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          generatedAt: 1_700_000_000_000,
          cards: [{
            id: 'deepseek-official',
            displayName: 'DeepSeek 官方',
            source: 'account',
            configured: true,
            data: { kind: 'balance', label: 'balance.recharge', wallets: [{ currency: 'CNY', total: '12.34' }] },
          }],
        }),
      })
      : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: 'HTTP 503' }) })),
  })
  harness.settle()
  await flush()
  assert.match(pageText(harness), /12\.34/)

  online = false
  harness.timers.find((timer) => timer.ms === 60_000).callback()
  await flush()

  const text = pageText(harness)
  assert.match(text, /12\.34/, 'the last good numbers stay on screen')
  assert.match(text, /刷新失败，显示上次数据：HTTP 503/)
  assert.doesNotMatch(text, /读取失败/)
})

test('an unreachable host is reported in the panel language', async () => {
  const harness = mountPlugin(createStorage(), {
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  })
  harness.settle()
  await flush()

  const text = pageText(harness)
  assert.match(text, /网络请求失败/)
  assert.doesNotMatch(text, /Failed to fetch/)
})

test('a coded host failure is localized from the code, not its wording', async () => {
  const harness = mountPlugin(createStorage(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'HTTP 502', errorCode: 'http', status: 502 }),
    }),
  })
  harness.settle()
  await flush()

  assert.match(pageText(harness), /读取失败：服务端返回 HTTP 502/)
})

test('the same code reads in English when that is the panel language', async () => {
  const harness = mountPlugin(createStorage(), {
    language: 'en',
    fetch: () => Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'HTTP 502', errorCode: 'http', status: 502 }),
    }),
  })
  harness.settle()
  await flush()

  assert.match(pageText(harness), /Request failed: The server returned HTTP 502/)
})

test('an unknown code falls back to the host wording', async () => {
  const harness = mountPlugin(createStorage(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: '凭据存储不可用', errorCode: 'unknown' }),
    }),
  })
  harness.settle()
  await flush()

  assert.match(pageText(harness), /读取失败：凭据存储不可用/)
})

test('a coded card failure is localized in the card', async () => {
  const harness = openWithSnapshot([{
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    source: 'api-key',
    configured: true,
    error: 'HTTP 401',
    errorCode: 'http',
    status: 401,
  }])
  await flush()

  assert.match(pageText(harness), /服务端返回 HTTP 401/)
})

test('a coded account failure is localized inside the account note', async () => {
  const harness = openWithSnapshot([{
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    source: 'api-key',
    configured: true,
    data: { kind: 'balance', label: 'balance.total', wallets: [] },
    accountFailure: { error: 'HTTP 429', errorCode: 'http', status: 429 },
  }])
  await flush()

  assert.match(pageText(harness), /账号余额读取失败：服务端返回 HTTP 429/)
})


test('a slower earlier response cannot overwrite the newer snapshot', async () => {
  const pending = []
  const harness = mountPlugin(createStorage(), {
    fetch: () => new Promise((resolve) => { pending.push(resolve) }),
  })
  const card = (total) => ({
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    configured: true,
    data: { kind: 'balance', label: 'balance.total', wallets: [{ currency: 'CNY', total }] },
  })

  harness.settle()
  assert.equal(pending.length, 1, 'the page loads on mount')

  refreshOf(harness).props.onClick()
  harness.settle()
  assert.equal(pending.length, 2)

  pending[1]({ ok: true, json: () => Promise.resolve({ generatedAt: 1_700_000_000_000, cards: [card('later')] }) })
  await flush()
  assert.match(pageText(harness), /later/)

  pending[0]({ ok: true, json: () => Promise.resolve({ generatedAt: 1_600_000_000_000, cards: [card('earlier')] }) })
  await flush()
  assert.match(pageText(harness), /later/)
  assert.doesNotMatch(pageText(harness), /earlier/)
})
