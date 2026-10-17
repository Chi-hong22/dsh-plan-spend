/**
 * Behaviour tests for the client half: the sidebar navigation row and the panel.
 *
 * The client body is loaded exactly as the browser bundle loads it — the bare
 * function body from `client.body.js`, invoked with React and `styles` — and
 * driven through the real registration path: `apply(ctx)` reaches both slot
 * registrations, and each registered component is rendered with its own hook
 * store.
 *
 * The hook stores are dispatched the way React does it: the body closes over a
 * single React binding, so each hook call resolves against whichever component
 * a render set as current. Effects are queued and run after the fake DOM has
 * been installed, mirroring React's commit-then-effect order; that is what lets
 * the placement measurement feed the panel geometry.
 *
 * Covered: both slot contracts, the open/close path, the placement rule that
 * keeps the panel outside the sidebar column and below the conversation header,
 * the rail's 18px glyph, and the resize grip's corner, sign, bounds and
 * persistence. Layout, paint and CSS are not observable here.
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BODY = readFileSync(new URL('../client.body.js', import.meta.url), 'utf8')
const FRAME = { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }

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

function fakeBox({ left = 0, top = 0, right = 0, bottom = 0 } = {}) {
  const box = {
    parentElement: null,
    getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }),
    contains: (node) => node === box,
  }
  return box
}

/** A document stand-in that records listeners so tests can dispatch and audit them. */
function createDocumentStub() {
  const listeners = new Map()
  const doc = {
    /** Conversation bodies on screen, i.e. what placement may anchor its top to. */
    conversationBodies: [],
    querySelectorAll(selector) {
      return selector === '[data-conversation-content]' ? doc.conversationBodies : []
    },
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
  return doc
}

/**
 * A ResizeObserver stand-in: it records what the panel watches and lets a test
 * deliver the notification a browser sends when a watched box changes size.
 */
function installResizeObserver() {
  const previous = globalThis.ResizeObserver
  const observers = []
  class Stub {
    constructor(callback) {
      this.callback = callback
      this.targets = new Set()
      observers.push(this)
    }
    observe(target) { this.targets.add(target) }
    unobserve(target) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
  }
  globalThis.ResizeObserver = Stub
  return {
    /** Delivers the notification a browser sends when `target` changes size. */
    flush(target) {
      for (const observer of observers) {
        if (observer.targets.has(target)) observer.callback([{ target }], observer)
      }
    },
    restore() {
      if (previous === undefined) delete globalThis.ResizeObserver
      else globalThis.ResizeObserver = previous
    },
  }
}

/**
 * The sidebar chain the placement walk climbs: button → actions → foot area →
 * sidebar column → frame, plus the overlay layer whose parent is the frame.
 */
function createSidebarDom({ columnRight = 280, buttonBottom = 744 } = {}) {
  const frame = fakeBox(FRAME)
  const column = fakeBox({ left: 0, top: 0, right: columnRight, bottom: buttonBottom })
  column.parentElement = frame
  const footArea = fakeBox()
  footArea.parentElement = column
  const actions = fakeBox({ left: 0, top: 0, right: columnRight, bottom: buttonBottom })
  actions.parentElement = footArea
  const button = fakeBox({ left: 0, top: buttonBottom - 44, right: 118, bottom: buttonBottom })
  button.parentElement = actions
  // The row is a real button in the sidebar: the shell's own handler is
  // delegated at the React root, so the row carries the listeners the entry
  // adds and the attributes it publishes.
  button.attributes = new Map()
  button.listeners = new Set()
  button.shellSelects = 0
  button.setAttribute = (name, value) => { button.attributes.set(name, String(value)) }
  button.removeAttribute = (name) => { button.attributes.delete(name) }
  button.addEventListener = (type, listener) => { if (type === 'click') button.listeners.add(listener) }
  button.removeEventListener = (type, listener) => { if (type === 'click') button.listeners.delete(listener) }
  button.dispatchClick = () => {
    const event = {
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
    }
    for (const listener of Array.from(button.listeners)) listener(event)
    // A stopped click never reaches the shell, which would select a panel by id.
    if (!event.propagationStopped) button.shellSelects += 1
    return event
  }
  footArea.children = [actions]

  const layer = fakeBox(FRAME)
  layer.parentElement = frame
  const panelNode = { isPanel: true }
  return {
    frame, column, footArea, actions,
    button, layer, panelNode, columnRight, buttonBottom,
  }
}

/** Loads the plugin body and drives both registered components. */
function mountPlugin(storage, dom = createSidebarDom(), options = {}) {
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
  const slots = {
    inject(key, callback) {
      assert.ok(key === 'sidebar.panellist' || key === 'shell.overlay', `unexpected slot ${key}`)
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
  // The account namespace is optional in a composition, so it is offered the way
  // the runtime offers it: as `remote.account`, or under its own dotted key.
  const services = { slots, locale }
  plugin.apply({
    get: (name) => services[name] || null,
    effect: (fn) => { disposers.push(fn()); return () => {} },
  })

  const rowEntry = registered['sidebar.panellist'].definition
  assert.equal(rowEntry.name, 'sidebar.panellist')
  assert.equal(rowEntry.id, 'dsh-plan-spend')
  assert.equal(rowEntry.order, 20, 'the row sits where the shipped rows do')
  assert.equal(rowEntry.locale, 'dsh-plan-spend')
  assert.equal(typeof rowEntry.label, 'function', 'the shell names the row from the dictionary')
  assert.deepEqual(registered['shell.overlay'].definition, {
    name: 'shell.overlay', id: 'dsh-plan-spend', order: 30,
  })

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

  const trigger = createInstance('sidebar.panellist', { size: 16, active: false })
  const panel = createInstance('shell.overlay', {})

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

  const harness = {
    trigger,
    panel,
    plugin,
    doc,
    dom,
    registered,
    registrations,
    disposers,
    get timers() { return Array.from(timers.values()) },
    /** Commits both components' effects, alternating while they keep re-queueing. */
    settle() {
      for (let guard = 0; guard < 20; guard++) {
        if (!trigger.state.hasPending() && !panel.state.hasPending()) break
        settleOne(trigger)
        settleOne(panel)
      }
    },
    /**
     * Commits the fake sidebar DOM: the row the glyph renders into, the overlay
     * layer the anchor measures against, and the panel box the dismiss test
     * inspects.
     */
    installDom() {
      dom.button.focus = () => { dom.focused = 'button' }
      // The glyph finds its row through `closest`, the way the browser would.
      trigger.tree.props.ref.current = {
        closest: (selector) => (selector === 'button' ? dom.button : null),
      }
      const anchor = panel.tree
      if (!anchor) return
      anchor.props.ref.current = { offsetParent: dom.layer }
      anchor.props.children.props.ref.current = {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        contains: (node) => node === dom.panelNode,
        focus: () => { dom.focused = 'panel' },
      }
    },
    /** Puts a conversation body on screen, as the shell does below its header. */
    installConversation({ left = 280, top = 96 } = {}) {
      const box = { left, top }
      doc.conversationBodies.length = 0
      doc.conversationBodies.push({
        getBoundingClientRect: () => ({ left: box.left, top: box.top, right: FRAME.right, bottom: FRAME.bottom, width: FRAME.right - box.left, height: FRAME.bottom - box.top }),
      })
      return {
        element: doc.conversationBodies[0],
        /** Moves the body the way a header that grows with the tab strip does. */
        move({ top: nextTop = box.top, left: nextLeft = box.left } = {}) { box.top = nextTop; box.left = nextLeft },
      }
    },
    /** Clicks the sidebar row, which is also the panel's trigger. */
    clickRow() {
      return dom.button.dispatchClick()
    },
    openPanel() {
      harness.clickRow()
      harness.installDom()
      harness.settle()
    },
  }
  return harness
}

function anchorOf(harness) {
  const anchor = harness.panel.tree
  assert.ok(anchor, 'the panel is closed')
  return anchor
}

function panelOf(harness) {
  return anchorOf(harness).props.children
}

function handleOf(harness) {
  const children = panelOf(harness).props.children
  const handle = children[children.length - 1]
  assert.match(handle.props.className, /um-resize/)
  return handle
}

function installPanelBox(harness, size) {
  panelOf(harness).props.ref.current = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size.width, height: size.height, right: size.width, bottom: size.height }),
    contains: (node) => node === harness.dom.panelNode,
  }
}

function pointerEvent(x, y, pointerId = 1) {
  return {
    button: 0,
    pointerId,
    clientX: x,
    clientY: y,
    preventDefault: () => {},
    currentTarget: { setPointerCapture: () => {}, releasePointerCapture: () => {} },
  }
}

function dragGrip(harness, from, to) {
  const handle = handleOf(harness)
  handle.props.onPointerDown(pointerEvent(from.x, from.y))
  handle.props.onPointerMove(pointerEvent(to.x, to.y))
  handle.props.onPointerUp(pointerEvent(to.x, to.y))
}

test('the row is a sidebar nav entry that opens a panel in the overlay', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  assert.equal(harness.panel.tree, null, 'the panel starts closed')
  // The shell owns the button around the glyph, so the state is published on
  // that element rather than on a node the entry renders itself.
  assert.equal(harness.dom.button.attributes.get('aria-expanded'), 'false')
  assert.equal(harness.dom.button.attributes.has('aria-controls'), false, 'no dangling IDREF while closed')
  assert.equal(harness.dom.button.attributes.get('aria-haspopup'), 'dialog')
  assert.equal(harness.trigger.tree.props['aria-hidden'], 'true', 'the row already carries the label')
})

test('registers both dictionaries once under a stable namespace and disposes them', () => {
  const harness = mountPlugin(createStorage())
  assert.equal(harness.registrations.length, 1, 'registration is one call, not one per language')
  assert.equal(harness.registrations[0].ns, 'dsh-plan-spend', 'the namespace is stable across reloads')
  assert.deepEqual([...harness.registrations[0].languages].sort(), ['en', 'zh'])
  const label = harness.registered['sidebar.panellist'].definition.label
  assert.equal(label(), '用量', 'the row is named from the dictionary')

  for (const dispose of harness.disposers) if (typeof dispose === 'function') dispose()
  assert.equal(label(), 'button.label', 'disposal drops the dictionaries')
})

test('the plugin declares the services it reads, so Cordis waits for them', () => {
  // Without this the locale service can be missing at apply time, which turns
  // every t() lookup into the raw key.
  const harness = mountPlugin(createStorage())
  assert.equal(harness.plugin.name, 'dsh-plan-spend')
  assert.deepEqual(harness.plugin.inject, ['slots', 'locale'])
})

test('the glyph follows the slot size the shell hands the row', () => {
  const harness = mountPlugin(createStorage())
  assert.equal(harness.trigger.tree.props.width, 16)

  // A narrow sidebar hands the row an 18px glyph.
  harness.trigger.setProps({ size: 18 })
  assert.equal(harness.trigger.tree.props.width, 18)
  assert.equal(harness.trigger.tree.props.height, 18)
})

test('opening places the panel just outside the sidebar column', () => {
  const harness = mountPlugin(createStorage(), createSidebarDom({ columnRight: 280, buttonBottom: 744 }))
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = anchorOf(harness).props.style
  // left = column right (280) + gap (10); top = column top - layer top + gap (10).
  assert.equal(style.left, '290px')
  assert.equal(style.top, '10px')
  // maxWidth = 1200 - 290 - 8.
  assert.equal(style.maxWidth, '902px')
  assert.equal(panelOf(harness).props.children[0].props.children.length, 4, 'header keeps title, stamp and two buttons')
})

test('the panel re-places when the sidebar changes width while open', () => {
  const dom = createSidebarDom({ columnRight: 280, buttonBottom: 744 })
  const harness = mountPlugin(createStorage(), dom)
  harness.installDom()
  harness.settle()
  harness.openPanel()
  assert.equal(anchorOf(harness).props.style.left, '290px')

  // The rail collapses the column to 56px; only the button element moves.
  dom.column.getBoundingClientRect = () => ({ left: 0, top: 0, right: 56, bottom: 744, width: 56, height: 744 })
  harness.trigger.setProps({ size: 18 })
  harness.settle()

  assert.equal(anchorOf(harness).props.style.left, '66px')
})
test('clicking the row toggles the panel instead of selecting a panel by id', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()

  // The shell's own handler selects the row's id as a main panel and throws
  // when none is registered, so the entry stops the click before it gets there.
  const event = harness.clickRow()
  harness.settle()
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.propagationStopped, true)
  assert.equal(harness.dom.button.shellSelects, 0, 'the shell never selects this row')
  assert.ok(harness.panel.tree, 'the panel opens')

  harness.clickRow()
  harness.settle()
  assert.equal(harness.panel.tree, null, 'a second click closes it')
})

test('the panel top edge lands below the conversation tabs, not beside the header', () => {
  const harness = mountPlugin(createStorage())
  harness.installConversation({ top: 96 })
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = anchorOf(harness).props.style
  assert.equal(style.top, '106px', 'the conversation body top (96) plus the gap (10)')
  assert.equal(style.left, '290px', 'the column is still the horizontal anchor')
  // The panel never grows past the layer: 800 - top (106) - edge margin (8).
  assert.equal(panelOf(harness).props.style.maxHeight, '686px')
})

test('the panel re-anchors when the conversation body moves under it', () => {
  const harness = mountPlugin(createStorage())
  const body = harness.installConversation({ top: 96 })
  harness.installDom()
  harness.settle()
  const observer = installResizeObserver()
  try {
    harness.openPanel()
    assert.equal(anchorOf(harness).props.style.top, '106px', 'the body top (96) plus the gap (10)')

    // The tab strip appears with the first message and pushes the body down,
    // which is the layout change the panel has to follow.
    body.move({ top: 128 })
    observer.flush(body.element)
    harness.settle()

    assert.equal(anchorOf(harness).props.style.top, '138px', 'the body top (128) plus the gap (10)')
  } finally {
    observer.restore()
  }
})

test('closing from the header hides the panel', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  harness.openPanel()
  assert.ok(harness.panel.tree, 'the panel is open')

  const header = panelOf(harness).props.children[0]
  header.props.children[3].props.onClick()
  harness.settle()

  assert.equal(harness.panel.tree, null)
  assert.equal(harness.dom.button.attributes.get('aria-expanded'), 'false')
})

test('dragging the bottom-right grip grows the panel and stores it', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()
  installPanelBox(harness, { width: 330, height: 360 })

  // The grip is bottom-right, so outward is right and down.
  dragGrip(harness, { x: 100, y: 100 }, { x: 150, y: 140 })

  assert.equal(storage.raw.get('dsh-plan-spend.size'), JSON.stringify({ width: 380, height: 400 }))
  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '380px', height: '400px' })
})

test('the grip respects the minimum size and the placement bounds', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  installPanelBox(harness, { width: 330, height: 360 })
  dragGrip(harness, { x: 0, y: 0 }, { x: -500, y: 500 })
  assert.equal(storage.raw.get('dsh-plan-spend.size'), JSON.stringify({ width: 260, height: 782 }))

  installPanelBox(harness, { width: 330, height: 360 })
  dragGrip(harness, { x: 0, y: 0 }, { x: 5000, y: -5000 })
  assert.equal(storage.raw.get('dsh-plan-spend.size'), JSON.stringify({ width: 902, height: 160 }))
})

test('a grip drag below the threshold stores nothing', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()
  installPanelBox(harness, { width: 330, height: 360 })

  dragGrip(harness, { x: 100, y: 100 }, { x: 101, y: 99 })
  assert.equal(storage.raw.has('dsh-plan-spend.size'), false)
})

test('a stored size is applied on open', () => {
  const storage = createStorage({ 'dsh-plan-spend.size': JSON.stringify({ width: 420, height: 300 }) })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '420px', height: '300px' })
})

test('a size stored before the rename is adopted under the new key and dropped', () => {
  const storage = createStorage({ 'usage-meter.size': JSON.stringify({ width: 410, height: 290 }) })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '410px', height: '290px' })
  assert.equal(storage.raw.get('dsh-plan-spend.size'), JSON.stringify({ width: 410, height: 290 }))
  assert.equal(storage.raw.has('usage-meter.size'), false)
})

test('an unreadable current size resets the panel instead of resurrecting the old key', () => {
  const storage = createStorage({
    'dsh-plan-spend.size': '{not json',
    'usage-meter.size': JSON.stringify({ width: 410, height: 290 }),
  })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '330px', height: '360px' })
  assert.equal(storage.raw.has('usage-meter.size'), false, 'the old key is still cleaned up')
  assert.equal(storage.raw.has('dsh-plan-spend.size'), true, 'the unreadable current key is left in place')
})

test('the retired manual-position key is dropped once', () => {
  const storage = createStorage({ 'usage-meter.position': JSON.stringify({ x: 10, y: 20 }) })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()

  assert.equal(storage.raw.has('usage-meter.position'), false)
})

test('the refresh and countdown timers live only while the panel is open', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  assert.equal(harness.timers.length, 0, 'no timer runs while the panel is closed')

  harness.openPanel()
  assert.deepEqual(harness.timers.map((timer) => timer.ms).sort((a, b) => a - b), [30_000, 60_000])

  const header = panelOf(harness).props.children[0]
  header.props.children[3].props.onClick()
  harness.settle()
  assert.equal(harness.timers.length, 0, 'closing clears both timers')
})

test('the row shows the same 16px gauge glyph as the sidebar navigation', () => {
  const harness = mountPlugin(createStorage())
  const tree = harness.trigger.tree
  assert.equal(tree.type, 'svg', 'the entry is the glyph and nothing else')
  assert.equal(tree.props.className, 'um-nav-icon')
  assert.equal(tree.props.viewBox, '0 0 16 16')
  assert.equal(tree.props.width, 16)
  assert.equal(tree.props.height, 16)
  assert.equal(tree.props.strokeWidth, 1)
  assert.equal(tree.props.children.length, 3, 'arc, needle and hub')
})

test('Escape closes the panel', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  harness.openPanel()
  assert.ok(harness.panel.tree, 'the panel is open')

  harness.doc.dispatch('keydown', { key: 'Escape' })
  harness.settle()

  assert.equal(harness.panel.tree, null)
  assert.equal(harness.dom.button.attributes.get('aria-expanded'), 'false')
})

test('a press outside the panel closes it; inside or on the trigger it does not', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  harness.openPanel()

  harness.doc.dispatch('pointerdown', { target: harness.dom.panelNode })
  harness.settle()
  assert.ok(harness.panel.tree, 'a press inside the panel must not close it')

  harness.doc.dispatch('pointerdown', { target: harness.dom.button })
  harness.settle()
  assert.ok(harness.panel.tree, 'a press on the trigger must not close it — its click toggles')

  harness.doc.dispatch('pointerdown', { target: { isOutside: true } })
  harness.settle()
  assert.equal(harness.panel.tree, null, 'a press anywhere else closes it')
})

test('the dismiss listeners exist only while the panel is open', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  assert.equal(harness.doc.count(), 0, 'no listener while closed')

  harness.openPanel()
  assert.equal(harness.doc.count(), 2, 'keydown plus pointerdown')

  const header = panelOf(harness).props.children[0]
  header.props.children[3].props.onClick()
  harness.settle()
  assert.equal(harness.doc.count(), 0, 'closing removes both')
})

test('the entry paints only the glyph and leaves the row to the shell', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  // No own style, label or click handler: the shell's .panelRow owns all three.
  assert.equal(harness.trigger.tree.props.style, undefined)
  assert.equal(harness.trigger.tree.props.onClick, undefined)
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

function panelText(harness) {
  return collectText(expandTree(panelOf(harness))).join(' ')
}

/** Lets the panel's single async source settle and re-render. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function snapshotOf(cards) {
  return () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ generatedAt: 1_700_000_000_000, cards }),
  })
}

/** Opens the panel against a fixed snapshot. */
function openWithSnapshot(cards) {
  const harness = mountPlugin(createStorage(), createSidebarDom(), { fetch: snapshotOf(cards) })
  harness.installDom()
  harness.settle()
  harness.openPanel()
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

  const text = panelText(harness)
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

  const text = panelText(harness)
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

  assert.doesNotMatch(panelText(harness), /赠金/)
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

  const text = panelText(harness)
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

  const text = panelText(harness)
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

  const text = panelText(harness)
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

  const text = panelText(harness)
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

  const text = panelText(harness)
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

test('opening the panel re-reads the clock instead of reusing the mount reading', async () => {
  // The panel component stays mounted while closed, so its `now` state survives
  // between openings. A long-lived page therefore opens with a `now` from the
  // mount; unless the open effect refreshes it, the first countdown is inflated
  // by the whole idle period.
  const clock = { value: Date.parse('2026-10-12T06:52:04Z') }
  const realDate = globalThis.Date
  globalThis.Date = makeTestDate(clock)
  try {
    const harness = mountPlugin(createStorage(), createSidebarDom(), {
      fetch: snapshotOf([
        {
          id: 'opencode-go',
          displayName: 'OpenCode Go',
          configured: true,
          data: {
            kind: 'quota-windows',
            windows: [{ id: 'rolling', status: 'ok', percent: 3, resetsAt: '2026-10-12T13:00:00Z' }],
          },
        },
      ]),
    })
    harness.installDom()
    harness.settle()

    // Three idle hours between the mount and the open. The reset is 3h07m away.
    clock.value = Date.parse('2026-10-12T09:52:04Z')
    harness.openPanel()
    await flush()

    const text = panelText(harness)
    assert.match(text, /3 小时 7 分后重置/)
    assert.doesNotMatch(text, /6 小时 7 分/, 'the countdown must not include the idle hours')
  } finally {
    globalThis.Date = realDate
  }
})

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
  const text = panelText(harness)
  assert.match(text, /高峰时段/)
  assert.match(text, /2 小时 0 分/)
})

test('off-peak counts down to the next peak opening', async () => {
  const harness = await openDeepseekAt('2026-10-14T05:00:00Z')
  const text = panelText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /1 小时 0 分/)
})

test('the peak window is half-open: 04:00:00 UTC is already off-peak', async () => {
  const harness = await openDeepseekAt('2026-10-14T04:00:00Z')
  assert.match(panelText(harness), /低谷时段/)
})

test('a weekend is off-peak and the countdown skips to Monday', async () => {
  // 2026-10-17 is a Saturday; the next peak opening is Monday 01:00 UTC.
  const harness = await openDeepseekAt('2026-10-17T02:00:00Z')
  const text = panelText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /1 天 23 小时/)
})

test('a make-up workday that lands on a weekend is still off-peak', async () => {
  // 2026-02-14 is a 调休 Saturday. The weekend rule alone settles it, which is
  // why the table needs no workday rule; the next peak is after Spring Festival.
  const harness = await openDeepseekAt('2026-02-14T02:00:00Z')
  const text = panelText(harness)
  assert.match(text, /低谷时段/)
  assert.match(text, /9 天 23 小时/)
})

test('a public holiday on a weekday is off-peak, and the same weekday after it is peak', async () => {
  // 2026-10-01 (Thursday, National Day) against 2026-10-08 (Thursday, back at work).
  const holiday = await openDeepseekAt('2026-10-01T02:00:00Z')
  assert.match(panelText(holiday), /低谷时段/)

  const workday = await openDeepseekAt('2026-10-08T02:00:00Z')
  assert.match(panelText(workday), /高峰时段/)
})

test('the countdown crosses a holiday block instead of landing inside it', async () => {
  // From inside the National Day block the next peak opening is a week out; a
  // clock-only walk would have called the next 01:00 UTC a transition.
  const harness = await openDeepseekAt('2026-10-01T02:00:00Z')
  assert.match(panelText(harness), /6 天 23 小时/)
})

test('a table that no longer covers the year is reported on the card', async () => {
  // 2027-01-04 is a Monday, so the clock alone would say peak; with no 2027 in
  // the table the holiday clause is unanswerable, and the card says so.
  const harness = await openDeepseekAt('2027-01-04T02:00:00Z')
  const text = panelText(harness)
  assert.match(text, /节假日表未覆盖 2027 年/)
  assert.match(text, /请补充数据/)
})

test('a covered year shows no stale notice', async () => {
  const harness = await openDeepseekAt('2026-10-14T02:00:00Z')
  assert.doesNotMatch(panelText(harness), /节假日表/)
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

  const text = panelText(harness)
  assert.doesNotMatch(text, /高峰时段/)
  assert.doesNotMatch(text, /低谷时段/)
})

test('a failed load shows the reason the host reported, not a bare status', async () => {
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: '请求超时（15000 ms）' }),
    }),
  })
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()

  const text = panelText(harness)
  assert.match(text, /读取失败：请求超时（15000 ms）/)
  assert.doesNotMatch(text, /HTTP 500/, 'the status is not surfaced when the host explained itself')
})

test('a refresh failure keeps the last snapshot and labels it stale', async () => {
  let online = true
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
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
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()
  assert.match(panelText(harness), /12\.34/)

  online = false
  harness.timers.find((timer) => timer.ms === 60_000).callback()
  await flush()

  const text = panelText(harness)
  assert.match(text, /12\.34/, 'the last good numbers stay on screen')
  assert.match(text, /刷新失败，显示上次数据：HTTP 503/)
  assert.doesNotMatch(text, /读取失败/)
})

test('an unreachable host is reported in the panel language', async () => {
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  })
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()

  const text = panelText(harness)
  assert.match(text, /网络请求失败/)
  assert.doesNotMatch(text, /Failed to fetch/)
})

test('a coded host failure is localized from the code, not its wording', async () => {
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'HTTP 502', errorCode: 'http', status: 502 }),
    }),
  })
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()

  assert.match(panelText(harness), /读取失败：服务端返回 HTTP 502/)
})

test('the same code reads in English when that is the panel language', async () => {
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    language: 'en',
    fetch: () => Promise.resolve({
      ok: false,
      status: 502,
      json: () => Promise.resolve({ error: 'HTTP 502', errorCode: 'http', status: 502 }),
    }),
  })
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()

  assert.match(panelText(harness), /Request failed: The server returned HTTP 502/)
})

test('an unknown code falls back to the host wording', async () => {
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    fetch: () => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: '凭据存储不可用', errorCode: 'unknown' }),
    }),
  })
  harness.installDom()
  harness.settle()
  harness.openPanel()
  await flush()

  assert.match(panelText(harness), /读取失败：凭据存储不可用/)
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

  assert.match(panelText(harness), /服务端返回 HTTP 401/)
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

  assert.match(panelText(harness), /账号余额读取失败：服务端返回 HTTP 429/)
})


test('opening the panel moves focus into it and closing returns it to the row', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  harness.openPanel()

  assert.equal(harness.dom.focused, 'panel')

  harness.clickRow()
  harness.settle()
  assert.equal(harness.dom.focused, 'button')
})

test('the row points at the dialog it controls, which is labelled by its heading', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const panel = panelOf(harness)
  assert.equal(panel.props.id, 'dsh-plan-spend-panel')
  assert.equal(panel.props.tabIndex, -1)
  assert.equal(harness.dom.button.attributes.get('aria-controls'), 'dsh-plan-spend-panel')

  const heading = panel.props.children[0].props.children[0]
  assert.equal(heading.props.id, 'dsh-plan-spend-panel-title')
  assert.equal(panel.props['aria-labelledby'], 'dsh-plan-spend-panel-title')
  assert.equal(panel.props['aria-modal'], undefined, 'the panel is a non-modal popover')

  const grip = handleOf(harness)
  assert.equal(grip.props.role, 'separator')
  assert.equal(grip.props['aria-valuenow'], 330)
  assert.equal(grip.props['aria-valuemin'], 260)
  assert.match(grip.props['aria-valuetext'], /330 × 360/)
})

test('the grip resizes with the arrow keys and stores the result', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  assert.equal(handleOf(harness).props.tabIndex, 0)

  const prevented = []
  handleOf(harness).props.onKeyDown({
    key: 'ArrowRight',
    shiftKey: false,
    preventDefault: () => prevented.push('right'),
  })
  harness.settle()
  assert.deepEqual(prevented, ['right'])
  assert.equal(panelOf(harness).props.style.width, '346px')

  handleOf(harness).props.onKeyDown({ key: 'ArrowDown', shiftKey: false, preventDefault: () => {} })
  harness.settle()
  assert.equal(panelOf(harness).props.style.height, '376px')
  assert.equal(storage.raw.get('dsh-plan-spend.size'), JSON.stringify({ width: 346, height: 376 }))

  handleOf(harness).props.onKeyDown({ key: 'ArrowRight', shiftKey: true, preventDefault: () => {} })
  harness.settle()
  assert.equal(panelOf(harness).props.style.width, '410px')
})

/** The header's refresh button (title, stamp, refresh, close). */
function refreshButton(harness) {
  return panelOf(harness).props.children[0].props.children[2]
}

test('a stored size larger than the measured placement is clamped on screen', () => {
  const storage = createStorage({ 'dsh-plan-spend.size': JSON.stringify({ width: 1000, height: 1000 }) })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '902px', height: '782px' })
})

test('a slower earlier response cannot overwrite the newer snapshot', async () => {
  const pending = []
  const harness = mountPlugin(createStorage(), createSidebarDom(), {
    fetch: () => new Promise((resolve) => { pending.push(resolve) }),
  })
  const card = (total) => ({
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    configured: true,
    data: { kind: 'balance', label: 'balance.total', wallets: [{ currency: 'CNY', total }] },
  })

  harness.installDom()
  harness.settle()
  harness.openPanel()
  assert.equal(pending.length, 1)

  refreshButton(harness).props.onClick()
  harness.settle()
  assert.equal(pending.length, 2)

  pending[1]({ ok: true, json: () => Promise.resolve({ generatedAt: 1_700_000_000_000, cards: [card('later')] }) })
  await flush()
  assert.match(panelText(harness), /later/)

  pending[0]({ ok: true, json: () => Promise.resolve({ generatedAt: 1_600_000_000_000, cards: [card('earlier')] }) })
  await flush()
  assert.match(panelText(harness), /later/)
  assert.doesNotMatch(panelText(harness), /earlier/)
})