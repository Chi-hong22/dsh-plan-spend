# dsh-plan-spend

A usage popup for the DSH Web GUI: one "Usage" chip in the frame-wide overlay
opens a panel showing the plan spend of the **configured** providers.

## What it shows

| Provider | Source | Rendered |
|---|---|---|
| DeepSeek official | `GET https://api.deepseek.com/user/balance` | total wallet balance (server precision kept), topped-up and granted split, sufficiency flag |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 5-hour / 7-day / monthly used percentage, progress bar, reset countdown |

**Known limitation**: the OpenCode Go usage endpoint returns percentages and
reset instants only — no used/limit amounts. That column is therefore
percent-only; the exact dollar figures live in the OpenCode console.

## Install

```sh
dsh plugin --profile <profile> add github:Chi-hong22/dsh-plan-spend
```

> The `desktop` profile is owned by the Electron application: the CLI refuses it
> with `profile "desktop" is managed exclusively by the Electron application`.
> Install through the GUI plugin page instead.

Verify the mount:

```sh
dsh --profile <profile> --dump-config | grep usage-meter
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

Adding a provider = one row in `ADAPTERS` plus one reader function.

## Placement and sizing

The plugin registers two seats:

- **`sidebar.footer.action`** (id `usage-meter`): the trigger. That seat is the
  sidebar's own action row and hands each entry `{ wide }`, so the button
  follows the collapse/expand rail by itself (icon-only when `wide === false`).
- **`shell.overlay`** (id `usage-meter`): the panel. The frame-wide layer sits
  outside every column, so the panel renders *beside* the sidebar instead of
  being clipped by the sidebar's `overflow: hidden`.

**Placement**: the panel measures the frame-level column that holds the button
(by climbing the DOM to the frame's direct child, never by hashed class name),
anchors its left edge 10px past that column's right edge and its bottom at the
button's bottom, then grows upward. A sidebar width change re-measures.

> One deviation worth knowing: `sidebar.settings` (the account row) is a
> **single** seat already owned by the shipped account/settings UI, so taking it
> would shadow that UI (`replaceRisk: shadows-shipped-ui`). `.footArea` is a
> column with `footerActions` above `settingsArea`, so the button lands in the
> row **above** the account row rather than at its right in the same row.

**Button styling** mirrors the shipped account launcher — `padding: 6px`,
`border-radius: 12px`, `gap: 8px`, `font-size: 14px/22px`, row margin `4px -2px`,
hover `--dsw-alias-interactive-bg-hover`; the glyph is **32×32**, the avatar's own
box; in the rail it becomes a centred `40×40` icon.

**Alignment with the account row is measured, not assumed**: on mount the row
takes the sibling account row, finds its first `button`, then that button's first
sized child (the avatar) and the next sized sibling (its label), and converts
both left edges into this row's `padding-left` and the label's `margin-left`.
Whatever inset that row actually uses, this one follows; with no account row the
stylesheet defaults stand. The rail opts out and keeps its own centred box.

**Dismissal**: the trigger again, the panel's `×`, `Esc`, or a press anywhere
outside the panel all close it.

**Resizing**: the grip sits in the panel's **top-right** corner — the one
farthest from the button — dragging right grows the width and dragging up grows
the height. The size is stored under `usage-meter.size` and is bounded by the
panel minimum and the overlay bounds.

To return to the default size, clear `usage-meter.size`. After editing the
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
## Security boundary

- API keys are used in the host half only and **never reach the browser**; the
  browser reads same-origin JSON.
- `GET /usage-meter/snapshot` is a named route on the harness web server with
  **no additional authentication**. When the web server binds `0.0.0.0`, anyone
  on the same network can read the balance and quota numbers (never the keys).
  Loopback-only use is unaffected.

## Layout

```
index.js             host half: credential resolution + both upstream calls + 30s cache + route
client.body.js       client half source (bare function body, no imports/JSX)
client.js            build artifact, generated by scripts/build-client.mjs
cordis.patch.yml     bundle patch: inserts one row into a profile
scripts/build-client.mjs
scripts/probe-sources.ps1   one-shot probe: verify both upstreams without the plugin
tests/client-ui.test.mjs    trigger/placement/resize behaviour tests (npm test)
```

## License

MIT
