/**
 * Host-half tests for the snapshot route.
 *
 * `apply()` runs against a stub ctx, the route handler it registers is invoked
 * with a stub response, and `fetch` is replaced so both upstream readers are
 * exercised without network access. What is under test here is the card
 * payload: which provider resolves to which card, what a failure looks like,
 * and that 赠金 never reaches a card.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const BALANCE_BODY = {
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: '3.17',
    granted_balance: '0.50',
    topped_up_balance: '2.67',
  }],
}

const USAGE_BODY = {
  usage: {
    rolling: { status: 'ok', percent: 5, resetsAt: '2026-10-08T06:09:27.000Z' },
    monthly: { status: 'ok', percent: 42, resetsAt: '2026-10-22T01:02:32.000Z' },
  },
}

/** Replaces `fetch` for one test and hands back the call log plus a restore. */
function stubFetch(responses) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const response = responses[String(url)]
    if (response === undefined) throw new Error(`unexpected fetch: ${url}`)
    if (response.status !== undefined && response.status >= 400) {
      return { ok: false, status: response.status, json: async () => ({}) }
    }
    return { ok: true, status: 200, json: async () => response.body }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/**
 * Applies the plugin against a stub ctx and returns its route plus a snapshot
 * reader. `account` stands in for the harness account service so the account
 * route is exercised without one; leaving it out models a composition that
 * mounts none.
 */
function routeHarness({ resolve, describe, account }) {
  const routes = []
  apply({
    credentials: {
      resolve,
      describe: describe || (async () => ({ configured: true, source: 'stored-file', writable: true })),
    },
    get: (key) => (key === 'deepseekAccount' ? account ?? null : null),
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => { fn(); return () => {} },
  })
  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/usage-meter/snapshot')
  return {
    async read(query = '') {
      let payload = null
      const res = { writeHead() {}, end(body) { payload = JSON.parse(body) } }
      await route.handler({ method: 'GET', url: `/usage-meter/snapshot${query}` }, res)
      return payload
    },
    async method(method) {
      let status = null
      const res = { writeHead(code) { status = code }, end() {} }
      await route.handler({ method, url: '/usage-meter/snapshot' }, res)
      return status
    },
    route,
  }
}

const bothConfigured = async () => ({ value: 'secret' })

test('both providers map to cards, and 赠金 never reaches the balance payload', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({ resolve: bothConfigured })
    const snapshot = await harness.read()

    assert.equal(typeof snapshot.generatedAt, 'number')
    assert.deepEqual(snapshot.cards.map((card) => card.id), ['deepseek-official', 'opencode-go'])

    const deepseek = snapshot.cards[0]
    assert.equal(deepseek.source, 'api-key')
    assert.equal(deepseek.credentialSource, 'stored-file')
    assert.equal(deepseek.credentialWritable, true)
    assert.deepEqual(deepseek.data.wallets, [{ currency: 'CNY', total: '3.17', toppedUp: '2.67' }])
    // 赠金 is promotional, not plan balance: `granted_balance` is not mapped.
    assert.equal('granted' in deepseek.data.wallets[0], false)

    const opencode = snapshot.cards[1]
    assert.deepEqual(opencode.data.windows.map((window) => [window.id, window.percent]),
      [['rolling', 5], ['weekly', null], ['monthly', 42]])
  } finally {
    fetcher.restore()
  }
})

test('an unconfigured reference yields configured:false and no upstream request', async () => {
  const fetcher = stubFetch({
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: async (ref) => (ref === 'DEEPSEEK_API_KEY' ? null : { value: 'secret' }),
    })
    const snapshot = await harness.read()

    const deepseek = snapshot.cards[0]
    assert.equal(deepseek.configured, false)
    assert.equal(deepseek.error, undefined)
    assert.equal(deepseek.data, undefined)
    assert.equal(fetcher.calls.includes('https://api.deepseek.com/user/balance'), false)
    assert.equal(snapshot.cards[1].configured, true)
  } finally {
    fetcher.restore()
  }
})

test('a rejected resolution is reported on its own card only', async () => {
  const fetcher = stubFetch({
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: async (ref) => {
        if (ref === 'DEEPSEEK_API_KEY') throw new Error('credential store unavailable')
        return { value: 'secret' }
      },
    })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].configured, false)
    assert.equal(snapshot.cards[0].error, 'credential store unavailable')
    assert.equal(snapshot.cards[1].configured, true)
  } finally {
    fetcher.restore()
  }
})

test('an upstream rejection keeps the status and leaves the other card intact', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { status: 401 },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({ resolve: bothConfigured })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].error, 'HTTP 401')
    assert.equal(snapshot.cards[0].data, undefined)
    assert.equal(snapshot.cards[1].data.kind, 'quota-windows')
  } finally {
    fetcher.restore()
  }
})

test('the snapshot is cached between reads unless a refresh is asked for', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({ resolve: bothConfigured })
    await harness.read()
    const after_first = fetcher.calls.length
    await harness.read()
    assert.equal(fetcher.calls.length, after_first, 'the second read is served from the cache')
    await harness.read('?refresh=1')
    assert.equal(fetcher.calls.length, after_first * 2, 'a forced refresh re-reads both providers')
  } finally {
    fetcher.restore()
  }
})

test('a describe failure only drops the source fields', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: bothConfigured,
      describe: async () => { throw new Error('no describe here') },
    })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].credentialSource, undefined)
    assert.equal(snapshot.cards[0].credentialWritable, undefined)
    assert.equal(snapshot.cards[0].data.kind, 'balance')
  } finally {
    fetcher.restore()
  }
})

test('only GET reaches the readers', async () => {
  const fetcher = stubFetch({})
  try {
    const harness = routeHarness({ resolve: bothConfigured })
    assert.equal(await harness.method('POST'), 405)
    assert.deepEqual(fetcher.calls, [])
  } finally {
    fetcher.restore()
  }
})

test('the account route supplies the DeepSeek card and skips the API key entirely', async () => {
  const calls = []
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: async (ref) => {
        // Reading the DeepSeek key here would surface as a card error, so the
        // assertions below prove the account route short-circuited it.
        if (ref === 'DEEPSEEK_API_KEY') throw new Error('the API key must not be read when the account answers')
        return { value: 'secret' }
      },
      account: { resolveToken: async (url) => { calls.push(url); return 'grant-token' } },
    })
    const snapshot = await harness.read()

    const deepseek = snapshot.cards[0]
    assert.equal(deepseek.source, 'account')
    assert.equal(deepseek.configured, true)
    assert.equal(deepseek.data.label, 'balance.recharge')
    // The recharge wallet alone: granted credit never reaches a card.
    assert.deepEqual(deepseek.data.wallets, [{ currency: 'CNY', total: '2.67' }])
    assert.equal(deepseek.accountError, undefined)
    assert.deepEqual(calls, ['https://api.deepseek.com/user/balance'])
    assert.equal(snapshot.cards[1].data.kind, 'quota-windows')
  } finally {
    fetcher.restore()
  }
})

test('the account token travels in x-dsh-auth-token and never reaches the card', async () => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers })
    return { ok: true, status: 200, json: async () => BALANCE_BODY }
  }
  try {
    const harness = routeHarness({
      resolve: async () => ({ value: 'api-key' }),
      account: { resolveToken: async () => 'grant-token' },
    })
    const snapshot = await harness.read()

    const call = seen.find((entry) => entry.url === 'https://api.deepseek.com/user/balance')
    assert.equal(call.headers['x-dsh-auth-token'], 'grant-token')
    assert.equal(call.headers.authorization, undefined)
    assert.equal(JSON.stringify(snapshot).includes('grant-token'), false)
  } finally {
    globalThis.fetch = original
  }
})

test('a signed-out account falls back to the API-key card', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: bothConfigured,
      account: { resolveToken: async () => undefined },
    })
    const snapshot = await harness.read()

    const deepseek = snapshot.cards[0]
    assert.equal(deepseek.source, 'api-key')
    assert.equal(deepseek.data.label, 'balance.total')
    assert.deepEqual(deepseek.data.wallets, [{ currency: 'CNY', total: '3.17', toppedUp: '2.67' }])
    assert.equal(deepseek.accountError, undefined)
  } finally {
    fetcher.restore()
  }
})

test('a failed account query falls back and reports the failure on the card', async () => {
  // The two DeepSeek routes share one URL, so this stub separates them by the
  // header each route sends: only the account route carries x-dsh-auth-token.
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const target = String(url)
    if (target === 'https://api.deepseek.com/user/balance' && options.headers['x-dsh-auth-token'] !== undefined) {
      return { ok: false, status: 429, json: async () => ({}) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => (target === 'https://api.deepseek.com/user/balance' ? BALANCE_BODY : USAGE_BODY),
    }
  }
  try {
    const harness = routeHarness({
      resolve: bothConfigured,
      account: { resolveToken: async () => 'grant-token' },
    })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].source, 'api-key')
    assert.equal(snapshot.cards[0].accountError, 'HTTP 429')
    assert.equal(snapshot.cards[0].data.kind, 'balance')
  } finally {
    globalThis.fetch = original
  }
})

test('a throwing token resolution is reported instead of failing the snapshot', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({
      resolve: bothConfigured,
      account: { resolveToken: async () => { throw new Error('account: storage') } },
    })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].source, 'api-key')
    assert.equal(snapshot.cards[0].accountError, 'account: storage')
    assert.equal(snapshot.cards[1].data.kind, 'quota-windows')
  } finally {
    fetcher.restore()
  }
})

test('a composition with no account service still reads the API key', async () => {
  const fetcher = stubFetch({
    'https://api.deepseek.com/user/balance': { body: BALANCE_BODY },
    'https://opencode.ai/zen/go/v1/usage': { body: USAGE_BODY },
  })
  try {
    const harness = routeHarness({ resolve: bothConfigured })
    const snapshot = await harness.read()

    assert.equal(snapshot.cards[0].source, 'api-key')
    assert.equal(snapshot.cards[0].accountError, undefined)
    assert.equal(snapshot.cards[0].data.kind, 'balance')
  } finally {
    fetcher.restore()
  }
})
