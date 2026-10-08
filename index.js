/**
 * Usage Meter — host half.
 *
 * Serves one read-only JSON snapshot of the configured providers' plan spend
 * over the harness web server, so the browser half never sees a credential:
 * the API key is resolved through `ctx.credentials` and used here only.
 *
 * Where the numbers come from (both verified against the live services):
 * - DeepSeek official balance: `GET https://api.deepseek.com/user/balance`,
 *   returning `is_available` plus one entry per currency with
 *   `total_balance` / `granted_balance` / `topped_up_balance`.
 * - OpenCode Go quota: `GET https://opencode.ai/zen/go/v1/usage`, returning the
 *   three usage windows (`rolling` = 5 hours, `weekly`, `monthly`), each with a
 *   `percent` and a `resetsAt` instant. The endpoint reports percentages only —
 *   no used/limit amount — and needs no `x-opencode-session` header.
 *
 * A provider whose credential reference is not configured yields a card with
 * `configured: false` instead of a request, which is what makes the popup
 * follow the configured providers.
 *
 * Route: `GET /usage-meter/snapshot` (`?refresh=1` bypasses the cache).
 */
export const name = 'dsh-plan-spend'

export const inject = ['webServer', 'credentials']

const ROUTE = '/usage-meter/snapshot'
const CACHE_TTL_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/**
 * One entry per provider the popup can read. `credentialRef` is the POSIX
 * environment name the harness credential store addresses keys by; the two
 * defaults are the ones this profile already configures
 * (`.dsh/.credentials.yaml` → `DEEPSEEK_API_KEY`, `OPENCODEGO_API_KEY`).
 *
 * Adding a provider means adding a reader below and one row here.
 */
const ADAPTERS = [
  {
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    credentialRef: 'DEEPSEEK_API_KEY',
    read: readDeepSeekBalance,
  },
  {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    credentialRef: 'OPENCODEGO_API_KEY',
    read: readOpencodeQuota,
  },
]

async function fetchJson(url, apiKey) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** Shapes `/user/balance` into the card payload. Amounts stay server strings. */
async function readDeepSeekBalance(apiKey) {
  const body = await fetchJson(DEEPSEEK_BALANCE_URL, apiKey)
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
  return {
    kind: 'balance',
    isAvailable: body?.is_available === true,
    wallets: infos.map((wallet) => ({
      currency: typeof wallet?.currency === 'string' ? wallet.currency : '',
      total: typeof wallet?.total_balance === 'string' ? wallet.total_balance : null,
      granted: typeof wallet?.granted_balance === 'string' ? wallet.granted_balance : null,
      toppedUp: typeof wallet?.topped_up_balance === 'string' ? wallet.topped_up_balance : null,
    })),
  }
}

/** Shapes `/zen/go/v1/usage` into the three quota windows, in display order. */
async function readOpencodeQuota(apiKey) {
  const body = await fetchJson(OPENCODE_USAGE_URL, apiKey)
  const usage = body?.usage ?? {}
  const windows = ['rolling', 'weekly', 'monthly'].map((id) => {
    const window = usage[id] ?? {}
    return {
      id,
      status: typeof window.status === 'string' ? window.status : 'unknown',
      percent: typeof window.percent === 'number' ? window.percent : null,
      resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
    }
  })
  return { kind: 'quota-windows', windows }
}

function failureMessage(error) {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `请求超时（${REQUEST_TIMEOUT_MS} ms）`
      : error.message
  }
  return String(error)
}

/** Reads every configured provider concurrently; one failure never hides another. */
async function buildSnapshot(ctx) {
  const cards = await Promise.all(ADAPTERS.map(async (adapter) => {
    const card = { id: adapter.id, displayName: adapter.displayName, configured: true }
    let credential
    try {
      credential = await ctx.credentials.resolve(adapter.credentialRef)
    } catch (error) {
      return { ...card, configured: false, error: failureMessage(error) }
    }
    if (!credential?.value) return { ...card, configured: false }
    try {
      return { ...card, data: await adapter.read(credential.value) }
    } catch (error) {
      return { ...card, error: failureMessage(error) }
    }
  }))
  return { generatedAt: Date.now(), cards }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx) {
  let cache = { value: null, at: 0 }
  let inflight = null

  /**
   * One snapshot per cache window, and one in flight at a time: the popup's
   * refresh button and its timer cannot stampede the two upstream services.
   */
  async function snapshot(force) {
    if (!force && cache.value !== null && Date.now() - cache.at < CACHE_TTL_MS) return cache.value
    if (inflight !== null) return inflight
    const run = buildSnapshot(ctx)
    inflight = run
    try {
      const value = await run
      cache = { value, at: Date.now() }
      return value
    } finally {
      if (inflight === run) inflight = null
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const url = new URL(req.url ?? ROUTE, 'http://localhost')
        sendJson(res, 200, await snapshot(url.searchParams.get('refresh') === '1'))
      } catch (error) {
        sendJson(res, 500, { error: failureMessage(error) })
      }
    },
  }), 'usage-meter: snapshot route')
}
