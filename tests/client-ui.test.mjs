/**
 * Behaviour tests for the client half: the sidebar trigger and the panel.
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
 * keeps the panel outside the sidebar column, the rail (compact) trigger, and
 * the resize grip's corner, sign, bounds and persistence. Layout, paint and CSS
 * are not observable here.
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

/**
 * The sidebar chain the placement walk climbs: button → actions → foot area →
 * sidebar column → frame, plus the overlay layer whose parent is the frame.
 * `settingsArea` is the account row this plugin aligns against; `settingsRow:
 * false` models a composition that never registers one.
 */
function createSidebarDom({
  columnRight = 280,
  buttonBottom = 744,
  accountInset = 4,
  accountLabelInset = 44,
  settingsRow = true,
} = {}) {
  const frame = fakeBox(FRAME)
  const column = fakeBox({ left: 0, top: 0, right: columnRight, bottom: buttonBottom })
  column.parentElement = frame
  const footArea = fakeBox()
  footArea.parentElement = column
  const actions = fakeBox({ left: 0, top: 0, right: columnRight, bottom: buttonBottom })
  actions.parentElement = footArea
  // The shipped row carries `margin: 4px -2px`, so its border box starts at -2.
  const button = fakeBox({ left: -2, top: buttonBottom - 44, right: 118, bottom: buttonBottom })
  button.parentElement = actions

  const label = fakeBox({ left: accountLabelInset, top: 0, right: accountLabelInset + 60, bottom: 20 })
  const avatar = fakeBox({ left: accountInset, top: 0, right: accountInset + 32, bottom: 32 })
  avatar.nextElementSibling = label
  const accountButton = {
    children: [avatar],
    getBoundingClientRect: () => ({ left: -2, top: 0, right: columnRight, bottom: 44, width: columnRight + 2, height: 44 }),
  }
  const settingsArea = {
    parentElement: footArea,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: columnRight, bottom: buttonBottom, width: columnRight, height: buttonBottom }),
    querySelector: (selector) => (selector === 'button' ? accountButton : null),
  }
  footArea.children = settingsRow ? [actions, settingsArea] : [actions]

  const layer = fakeBox(FRAME)
  layer.parentElement = frame
  const panelNode = { isPanel: true }
  return {
    frame, column, footArea, actions, settingsArea, accountButton, avatar, label,
    button, layer, panelNode, columnRight, buttonBottom,
  }
}

/** Loads the plugin body and drives both registered components. */
function mountPlugin(storage, dom = createSidebarDom()) {
  const react = createReactDispatcher()
  // Timers and fetch are handed to the body, not taken from the globals: a real
  // setInterval would keep the test process alive after the run.
  const timers = new Map()
  let timerId = 0
  const setIntervalStub = (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id }
  const clearIntervalStub = (id) => { timers.delete(id) }
  const fetchStub = () => Promise.reject(new Error('offline in tests'))

  const doc = createDocumentStub()
  const factory = new Function(
    'React', 'styles', 'localStorage', 'setInterval', 'clearInterval', 'fetch', 'document', BODY,
  )
  const plugin = factory(react.api, { insert: () => {} }, storage, setIntervalStub, clearIntervalStub, fetchStub, doc)

  const registered = {}
  const slots = {
    inject(key, callback) {
      assert.ok(key === 'sidebar.footer.action' || key === 'shell.overlay', `unexpected slot ${key}`)
      callback()
    },
    register(definition, component) {
      registered[definition.name] = { definition, component }
    },
  }
  plugin.apply({
    get: (name) => (name === 'slots' ? slots : null),
    effect: (fn) => { fn(); return () => {} },
  })

  assert.deepEqual(registered['sidebar.footer.action'].definition, {
    name: 'sidebar.footer.action', id: 'usage-meter', order: 20,
  })
  assert.deepEqual(registered['shell.overlay'].definition, {
    name: 'shell.overlay', id: 'usage-meter', order: 30,
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

  const trigger = createInstance('sidebar.footer.action', { wide: true })
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
     * Commits the fake sidebar DOM: the trigger's button, the overlay layer the
     * anchor measures against, and the panel box the dismiss test inspects.
     */
    installDom() {
      trigger.tree.props.ref.current = dom.button
      const anchor = panel.tree
      if (!anchor) return
      anchor.props.ref.current = { offsetParent: dom.layer }
      anchor.props.children.props.ref.current = {
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
        contains: (node) => node === dom.panelNode,
      }
    },
    openPanel() {
      trigger.tree.props.onClick()
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

test('registers a trigger in the sidebar footer and a panel in the overlay', () => {
  const harness = mountPlugin(createStorage())
  assert.equal(harness.panel.tree, null, 'the panel starts closed')
  assert.equal(harness.trigger.tree.props['aria-expanded'], false)
  assert.match(harness.trigger.tree.props.className, /um-button/)
})

test('the plugin declares the services it reads, so Cordis waits for them', () => {
  // Without this the locale service can be missing at apply time, which turns
  // every t() lookup into the raw key.
  const harness = mountPlugin(createStorage())
  assert.equal(harness.plugin.name, 'dsh-plan-spend')
  assert.deepEqual(harness.plugin.inject, ['slots', 'locale'])
})

test('the trigger follows the rail: icon-only when the sidebar is narrow', () => {
  const harness = mountPlugin(createStorage())
  assert.ok(!/um-button-compact/.test(harness.trigger.tree.props.className))

  harness.trigger.setProps({ wide: false })
  assert.match(harness.trigger.tree.props.className, /um-button-compact/)
})

test('opening places the panel just outside the sidebar column', () => {
  const harness = mountPlugin(createStorage(), createSidebarDom({ columnRight: 280, buttonBottom: 744 }))
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = anchorOf(harness).props.style
  // left = column right (280) + gap (10); bottom = layer bottom (800) - button bottom (744).
  assert.equal(style.left, '290px')
  assert.equal(style.bottom, '56px')
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
  harness.trigger.setProps({ wide: false })
  harness.settle()

  assert.equal(anchorOf(harness).props.style.left, '66px')
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
  assert.equal(harness.trigger.tree.props['aria-expanded'], false)
})

test('dragging the top-right grip grows the panel away from the sidebar and stores it', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()
  installPanelBox(harness, { width: 330, height: 360 })

  // The grip is top-right, so outward is right and up.
  dragGrip(harness, { x: 100, y: 100 }, { x: 150, y: 60 })

  assert.equal(storage.raw.get('usage-meter.size'), JSON.stringify({ width: 380, height: 400 }))
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
  assert.equal(storage.raw.get('usage-meter.size'), JSON.stringify({ width: 260, height: 160 }))

  installPanelBox(harness, { width: 330, height: 360 })
  dragGrip(harness, { x: 0, y: 0 }, { x: 5000, y: -5000 })
  assert.equal(storage.raw.get('usage-meter.size'), JSON.stringify({ width: 902, height: 736 }))
})

test('a grip drag below the threshold stores nothing', () => {
  const storage = createStorage()
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()
  installPanelBox(harness, { width: 330, height: 360 })

  dragGrip(harness, { x: 100, y: 100 }, { x: 101, y: 99 })
  assert.equal(storage.raw.has('usage-meter.size'), false)
})

test('a stored size is applied on open', () => {
  const storage = createStorage({ 'usage-meter.size': JSON.stringify({ width: 420, height: 300 }) })
  const harness = mountPlugin(storage)
  harness.installDom()
  harness.settle()
  harness.openPanel()

  const style = panelOf(harness).props.style
  assert.deepEqual({ width: style.width, height: style.height }, { width: '420px', height: '300px' })
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

test('the trigger renders an icon plus a label, and drops the label in the rail', () => {
  const harness = mountPlugin(createStorage())
  const children = harness.trigger.tree.props.children
  assert.equal(children[0].type, 'svg', 'the icon leads the row')
  assert.equal(children[0].props.className, 'um-button-icon')
  // The glyph occupies the shipped account avatar's box (32x32).
  assert.equal(children[0].props.width, 32)
  assert.equal(children[0].props.height, 32)
  assert.equal(children[1].type, 'span', 'the wide row carries a label')

  harness.trigger.setProps({ wide: false })
  assert.equal(harness.trigger.tree.props.children[1], null, 'the rail keeps the icon only')
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
  assert.equal(harness.trigger.tree.props['aria-expanded'], false)
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

test('the row measures the account row and aligns its icon and label to it', () => {
  // Account avatar at 4, its label at 44; this button's border box starts at -2.
  const dom = createSidebarDom({ accountInset: 4, accountLabelInset: 44 })
  const harness = mountPlugin(createStorage(), dom)
  harness.installDom()
  harness.settle()

  // paddingLeft = 4 - (-2); labelMargin = (44 - 4) - 32.
  assert.deepEqual(harness.trigger.tree.props.style, { paddingLeft: '6px', gap: '0px' })
  assert.deepEqual(harness.trigger.tree.props.children[1].props.style, { marginLeft: '8px' })
})

test('a different account inset is followed instead of assumed', () => {
  const dom = createSidebarDom({ accountInset: 14, accountLabelInset: 62 })
  const harness = mountPlugin(createStorage(), dom)
  harness.installDom()
  harness.settle()

  assert.equal(harness.trigger.tree.props.style.paddingLeft, '16px')
  assert.equal(harness.trigger.tree.props.children[1].props.style.marginLeft, '16px')
})

test('without an account row the stylesheet defaults stand in', () => {
  const harness = mountPlugin(createStorage(), createSidebarDom({ settingsRow: false }))
  harness.installDom()
  harness.settle()

  assert.equal(harness.trigger.tree.props.style, undefined)
  assert.equal(harness.trigger.tree.props.children[1].props.style, undefined)
})

test('the rail ignores the measured insets and centres the glyph', () => {
  const harness = mountPlugin(createStorage())
  harness.installDom()
  harness.settle()
  assert.ok(harness.trigger.tree.props.style, 'the wide row is aligned')

  harness.trigger.setProps({ wide: false })
  harness.settle()

  assert.equal(harness.trigger.tree.props.style, undefined, 'the rail keeps its own centred box')
  assert.equal(harness.trigger.tree.props.children[1], null)
})
