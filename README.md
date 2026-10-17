# @chi-hong22/dsh-plan-spend

A usage popup for the DSH Web GUI: the "Usage" sidebar navigation row opens a
panel showing the plan spend of the **configured** providers.

## What it shows

| Provider | Source | Rendered |
|---|---|---|
| DeepSeek official | the DeepSeek **account sign-in**: the host half asks `ctx.deepseekAccount.resolveToken` for the grant and calls `GET https://api.deepseek.com/user/balance` with `x-dsh-auth-token`; falls back to the same endpoint with `DEEPSEEK_API_KEY` | recharge balance (server precision kept), the topped-up split on the fallback card, the bonus wallet when the account holds one, the sufficiency flag, which route the number came from, and the **peak / off-peak** window with its next switch |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 5-hour / 7-day / monthly used percentage, progress bar, reset countdown |

**赠金 (granted credit) gets its own row.** It is promotional and short-lived,
so it is not plan balance and does not count towards the recharge balance: when
the account actually holds some, the card adds a 赠金 line under the recharge
balance and hides it again at zero. Both routes map `granted_balance`; the
account card's headline figure still comes from `topped_up_balance` alone.

**Known limitation**: the OpenCode Go usage endpoint returns percentages and
reset instants only — no used/limit amounts. That column is therefore
percent-only; the exact dollar figures live in the OpenCode console.

## Peak and off-peak (DeepSeek official)

DeepSeek bills two rates, and off-peak is half the peak price, so the DeepSeek
card carries one more row: whether the current moment is peak or off-peak, and
how long until the next switch.

There is **no endpoint** that reports the current window — the rule lives in a
footnote on the pricing page — so this row derives it client-side from the
published rule:

- **Peak**: Monday–Friday `09:00–12:00` and `14:00–18:00` Beijing time (UTC
  `01:00–04:00` and `06:00–10:00`), **excluding Chinese public holidays**.
- **Everything else is off-peak**: `12:00–14:00`, the night, **all weekend**, and
  **public holidays in full**.

How the derivation is pinned down:

- **Weekends are always off-peak**, so a make-up workday that lands on a Saturday
  or Sunday needs no extra modelling — the weekend rule already calls it off-peak.
- The holiday set is therefore the **whole published State Council arrangement**
  (including workdays folded into a holiday, such as 2 January for New Year), not
  just the 11 statutory days; otherwise peak would reappear mid-holiday.
- Lookups use **UTC date keys**: every peak window lies inside UTC `00:00–16:00`
  and everything outside a window is off-peak, so a UTC-date lookup and a
  Beijing-date lookup agree.
- The windows are **half-open**: `04:00:00` sharp is already off-peak.

### The holiday table needs upkeep

The table is `UM_CHINA_PUBLIC_HOLIDAYS_UTC` in `client.body.js` (33 days for
2026, from State Council notice 国办发明电〔2025〕7 号); the years it covers are
listed in `UM_HOLIDAY_YEARS`. Each **fourth quarter**, once the State Council
publishes the next year's arrangement, append that year's date keys and the year
itself.

When the table does not cover the current year the card says so outright — the
holiday table does not cover that year, add the data — because in that state
every weekday statutory holiday would be scored as peak, and **a wrong number
stated silently is worse than a missing one declared**. A covered year shows no
notice at all.

## Install

```sh
dsh plugin --profile <profile> add github:Chi-hong22/dsh-plan-spend
```

> The `desktop` profile is owned by the Electron application: the CLI refuses it
> with `profile "desktop" is managed exclusively by the Electron application`.
> Install through the GUI plugin page instead.

Verify the mount:

```sh
dsh --profile <profile> --dump-config | grep dsh-plan-spend
```

## Configuration

The plugin has no config. It decides which providers to show from whether their
credential is configured; the reference names live in the `ADAPTERS` table in
`index.js`:

| Provider | Credential ref (POSIX environment name) |
|---|---|
| DeepSeek official | `DEEPSEEK_API_KEY` |
| OpenCode Go | `OPENCODEGO_API_KEY` |

Credentials resolve through `ctx.credentials.resolve()`; the source precedence
is documented by `@deepseek-ai/dsh-credentials-local` (launch environment →
stored file → project `.env` → harness home `.env`). **An unconfigured provider
issues no request** and renders as "no credential configured; skipped".

The API-key row is the **fallback**. The DeepSeek card is normally read in this
half from the signed-in DeepSeek account: `ctx.deepseekAccount.resolveToken`
hands out the stored grant for the configured inference origin
(`https://api.deepseek.com`), and that token goes to the same `/user/balance`
endpoint as `x-dsh-auth-token`. No API key is needed, and the grant never
reaches the browser. When the account cannot answer (signed out, no account
provider in this composition, or the query failed) the API-key card stands in
and names its own route; a failed account query is reported on that fallback
card, so "signed out" and "the query broke" stay distinguishable.

The account service's own balance query is deliberately **not** used: it goes to
`platform.deepseek.com`, whose WAF answers non-browser clients with HTTP 429,
so it reports a failed balance instead of a number.

A failed or missing API-key read also reports the effective credential's
**source layer** and whether this surface could write it
(`ctx.credentials.describe`), because "I saved a key and it still unauthorised"
is almost always a read-only launch-environment value winning over the stored
one.

Adding a provider = one row in `ADAPTERS` plus one reader function.

## Placement and sizing

The plugin registers two seats:

- **`sidebar.panellist`** (id `dsh-plan-spend`, order 20): the row. That seat is
  the sidebar's own navigation list, so the shell draws the button, its glyph
  box, its label, its active state and its collapsed rail; the entry only renders
  the gauge glyph at the size the shell hands down — **16px** on the sidebar,
  **18px** on the collapsed rail (`{ size, active }`) — and adds no pixels of its
  own. Clicking the row would normally make the shell select `dsh-plan-spend` as
  a main panel and throw, because none is registered, so the glyph stops the
  click on the row element before React's delegated handler sees it and toggles
  the panel instead.
- **`shell.overlay`** (id `dsh-plan-spend`): the panel. The frame-wide layer sits
  outside every column, so the panel renders *beside* the sidebar instead of
  being clipped by the sidebar's `overflow: hidden`.

**Placement**: the panel measures the frame-level column that holds the row (by
climbing the DOM to the frame's direct child, never by hashed class name) and
anchors its left edge 10px past that column's right edge. Its top edge follows
the conversation body instead of the workspace: the first
`[data-conversation-content]` beside the sidebar is the scroll area that sits
directly below the conversation header and its dialog/trajectory tabs, so the
panel starts 10px below *that* top and never covers the header or the tabs. With
no conversation on screen it falls back to the column's own top. It re-measures
when it opens, when the overlay resizes, and whenever that body changes size: a
header that grows as the tabs appear pushes the panel down with the body instead
of leaving it over the header.

**Dismissal**: the row again, the panel's `×`, `Esc`, or a press anywhere
outside the panel all close it.

**Resizing**: the grip sits in the panel's **bottom-right** corner — the one
farthest from the top anchor — dragging right grows the width and dragging down
grows the height. The size is stored under `dsh-plan-spend.size` and is bounded by the
panel minimum and the overlay bounds.

**Keyboard**: opening moves focus into the panel, and `Esc` closes it and hands
focus back to the row. `Tab` reaches the grip; the arrow keys resize in 16px
steps, and holding `Shift` makes each step four times larger.

To return to the default size, clear `dsh-plan-spend.size`. After editing the
source run `npm run build` to regenerate `client.js`; that file is a build
artifact — do not edit it directly.

> The browser picks up a new `client.js` only after a **page refresh**: replacing
> package code is not part of DSH's ordinary start/stop sync.

## The client half must export `inject`

The plugin object returned by `client.body.js` carries `inject: ['slots', 'locale']`
so Cordis withholds `apply` until both services are provided. Without it
`ctx.get('locale')` can read `undefined` and `t` **silently degrades to echoing
the key** — the UI then shows `button.label`, `panel.title`, `window.rolling`
while the data and layout stay perfectly correct, which reads like an unrelated
bug. Every shipped client half (`dsh-client-ui-sidebar`, `dsh-client-ui-cordis`)
exports `inject`; do the same.

The host half likewise reads the account service through `ctx.get` instead of
declaring it in `inject`: a composition that mounts no account provider must
still mount the meter, with the API-key card in charge.

## Security boundary

- API keys are used in the host half only and **never reach the browser**; the
  browser reads same-origin JSON.
- `GET /dsh-plan-spend/snapshot` is a named route on the harness web server with
  **no additional authentication**. When the web server binds `0.0.0.0`, anyone
  on the same network can read the balance and quota numbers (never the keys).
  Loopback-only use is unaffected.

## Layout

```
index.js             host half: credential resolution + both upstream calls + 30s cache + route
client.body.js       client half source (bare function body, no imports/JSX)
client.js            build artifact, generated by scripts/build-client.mjs
cordis.patch.yml     bundle patch: inserts one row into a profile
locale/              display name/description the plugin manager reads (en, zh)
scripts/build-client.mjs
scripts/render-client.mjs   template shared by the build and the drift test
scripts/probe-sources.ps1   one-shot probe: verify both upstreams without the plugin
tests/client-ui.test.mjs    row/placement/resize/peak + card tests (npm test)
tests/host-snapshot.test.mjs  host route payload tests (npm test)
tests/build-drift.test.mjs  client.js must match client.body.js (npm test)
tests/plugin-meta.test.mjs  localized display metadata (npm test)
.github/workflows/test.yml  CI: npm test + rebuild drift check
```

## License

MIT
