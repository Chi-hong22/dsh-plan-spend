/**
 * Usage Meter — host half.
 *
 * Serves one read-only JSON snapshot of the configured providers' plan spend
 * over the harness web server, so the browser half never sees a credential:
 * both the API key and the DeepSeek account grant are resolved here only.
 *
 * Where the numbers come from (all verified against the live services):
 * - DeepSeek official balance, account route: the signed-in DeepSeek account's
 *   grant, obtained through `ctx.deepseekAccount.resolveToken` and sent as
 *   `x-dsh-auth-token` to `GET https://api.deepseek.com/user/balance`. This is
 *   the PREFERRED source because it needs no API key. It deliberately does not
 *   use the account service's own balance query: that one goes to
 *   `platform.deepseek.com`, whose WAF answers non-browser clients with HTTP
 *   429, so it reports a failed balance instead of a number.
 * - DeepSeek official balance, API-key route: the same endpoint with the
 *   `DEEPSEEK_API_KEY` reference, used when no account is signed in or the
 *   account query failed.
 * - OpenCode Go quota: `GET https://opencode.ai/zen/go/v1/usage`, returning the
 *   three usage windows (`rolling` = 5 hours, `weekly`, `monthly`), each with a
 *   `percent` and a `resetsAt` instant. The endpoint reports percentages only —
 *   no used/limit amount — and needs no `x-opencode-session` header.
 *
 * 赠金 is deliberately not part of any card: it is promotional and
 * short-lived, so it is not plan balance. `granted_balance` is never mapped,
 * and the account card reads the recharge wallet (`topped_up_balance`) alone.
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

/** A service looked up by name, absent rather than fatal. */
function safeService(ctx, key) {
  try {
    return (ctx && typeof ctx.get === 'function' ? ctx.get(key) : null) || null
  } catch (error) {
    return null
  }
}

function balanceWallets(body) {
  return Array.isArray(body?.balance_infos) ? body.balance_infos : []
}

/** One wallet amount as the server sent it, or null when the field is absent. */
function amountOf(wallet, field) {
  return typeof wallet?.[field] === 'string' ? wallet[field] : null
}

function currencyOf(wallet) {
  return typeof wallet?.currency === 'string' ? wallet.currency : ''
}

/**
 * One entry per provider the popup can read. `credentialRef` is the POSIX
 * environment name the harness credential store addresses keys by; the two
 * defaults are the ones this profile already configures
 * (`.dsh/.credentials.yaml` → `DEEPSEEK_API_KEY`, `OPENCODEGO_API_KEY`).
 *
 * `source` names the route a card's number came from, so the popup can say so
 * instead of implying every card is authenticated the same way. `readAccount`
 * is the optional account route, tried before the credential route.
 *
 * Adding a provider means adding a reader below and one row here.
 */
const ADAPTERS = [
  {
    id: 'deepseek-official',
    displayName: 'DeepSeek 官方',
    credentialRef: 'DEEPSEEK_API_KEY',
    source: 'api-key',
    read: readDeepSeekBalance,
    readAccount: readAccountBalance,
  },
  {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    credentialRef: 'OPENCODEGO_API_KEY',
    read: readOpencodeQuota,
  },
]

async function fetchJson(url, headers) {
  const response = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/**
 * Shapes `/user/balance` into the API-key card payload: the total balance with
 * its topped-up split. Amounts stay server strings, and `granted_balance` is
 * not mapped on purpose — 赠金 is not plan balance.
 */
async function readDeepSeekBalance(apiKey) {
  const body = await fetchJson(DEEPSEEK_BALANCE_URL, { authorization: `Bearer ${apiKey}` })
  return {
    kind: 'balance',
    label: 'balance.total',
    isAvailable: body?.is_available === true,
    wallets: balanceWallets(body).map((wallet) => ({
      currency: currencyOf(wallet),
      total: amountOf(wallet, 'total_balance'),
      toppedUp: amountOf(wallet, 'topped_up_balance'),
    })),
  }
}

/**
 * Reads the signed-in DeepSeek account's recharge balance through its login
 * grant, which needs no API key.
 *
 * `resolveToken` only hands out a grant for the configured inference origin
 * (`https://api.deepseek.com` by default) and returns undefined when nobody is
 * signed in, so an absent account and an unsupported deployment both land on
 * the API-key fallback rather than on an error.
 *
 * @returns the card payload, or null when there is no account to read.
 */
async function readAccountBalance(ctx) {
  const account = safeService(ctx, 'deepseekAccount')
  if (!account || typeof account.resolveToken !== 'function') return null
  const token = await account.resolveToken(DEEPSEEK_BALANCE_URL)
  if (!token) return null
  const body = await fetchJson(DEEPSEEK_BALANCE_URL, { 'x-dsh-auth-token': token })
  return {
    kind: 'balance',
    label: 'balance.recharge',
    isAvailable: body?.is_available === true,
    // The account route shows the recharge wallet alone: the bonus wallet is
    // the same 赠金 the API-key card deliberately drops.
    wallets: balanceWallets(body).map((wallet) => ({
      currency: currencyOf(wallet),
      total: amountOf(wallet, 'topped_up_balance'),
    })),
  }
}

/** Shapes `/zen/go/v1/usage` into the three quota windows, in display order. */
async function readOpencodeQuota(apiKey) {
  const body = await fetchJson(OPENCODE_USAGE_URL, { authorization: `Bearer ${apiKey}` })
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

/**
 * Which layer supplies a reference and whether this surface may change it,
 * without reading the secret. Best effort: a provider that cannot describe a
 * reference must not fail the card, so any failure just omits the fields.
 */
async function describeCredential(ctx, credentialRef) {
  try {
    const info = await ctx.credentials.describe(credentialRef)
    return info ?? null
  } catch (error) {
    return null
  }
}

function failureMessage(error) {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `请求超时（${REQUEST_TIMEOUT_MS} ms）`
      : error.message
  }
  return String(error)
}

/**
 * The provider's own credential route: one card, `configured: false` when the
 * reference carries no value. Used alone for providers without an account
 * route, and as the fallback for the one that has it.
 */
async function readCredentialCard(ctx, adapter, card) {
  let credential
  try {
    credential = await ctx.credentials.resolve(adapter.credentialRef)
  } catch (error) {
    return { ...card, configured: false, error: failureMessage(error) }
  }
  if (!credential?.value) return { ...card, configured: false }
  const info = await describeCredential(ctx, adapter.credentialRef)
  if (info !== null) {
    if (typeof info.source === 'string') card.credentialSource = info.source
    card.credentialWritable = info.writable === true
  }
  try {
    return { ...card, data: await adapter.read(credential.value) }
  } catch (error) {
    return { ...card, error: failureMessage(error) }
  }
}

/**
 * Reads every configured provider concurrently; one failure never hides
 * another. Where a provider has an account route it is tried first, and a
 * failed account query is reported on the fallback card instead of being
 * swallowed, so "signed out" and "the account query broke" stay
 * distinguishable in the popup.
 */
async function buildSnapshot(ctx) {
  const cards = await Promise.all(ADAPTERS.map(async (adapter) => {
    const card = { id: adapter.id, displayName: adapter.displayName, configured: true }
    if (adapter.source !== undefined) card.source = adapter.source
    let accountError
    if (adapter.readAccount !== undefined) {
      try {
        const account = await adapter.readAccount(ctx)
        if (account !== null) return { ...card, source: 'account', data: account }
      } catch (error) {
        accountError = failureMessage(error)
      }
    }
    const fallback = await readCredentialCard(ctx, adapter, card)
    return accountError === undefined ? fallback : { ...fallback, accountError }
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
