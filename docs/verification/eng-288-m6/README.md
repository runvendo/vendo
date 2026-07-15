# ENG-288 M6 — remix parity + in-client promotion on the real Maple host

Captured 2026-07-15 with headless Chromium against `apps/demo-bank` running
under `next dev` — the REAL demo host, REAL Auth.js login, REAL wire routes,
and Maple's REAL Anthropic model performing every create/edit. Nothing is
scripted or mocked: the fork-pin, the probe component, and the drop-back edit
all go through the live model edit path (retried up to 3× because a real model
occasionally emits an invalid plan; every landed state is asserted before it
counts).

## Demo capture 2 — Maple remix journey with visual parity

`maple-remix-parity.mjs`:

1. **Host original** — Maple's home page renders `NetWorthView`
   (`src/components/home/net-worth-view.tsx`) with live seeded data
   (`01-host-original.png`).
2. The user asks Vendo for an app on `/vendo/apps`, then asks it to **remix
   the net-worth card**. The real model emits `fork-pin` for the sync-captured
   slot `MapleNetWorthCard`; the app's pin records the baseline hash.
3. **Remixed render** — the forked pin renders inside the double-iframe CSP
   jail from the genuinely captured source
   (`apps/demo-bank/.vendo/remixable/MapleNetWorthCard.json`) with
   seed-matching `sampleProps` (`02-remixed-jail.png`).

Evidence: `parity-side-by-side.png` (**left = host original, right = remixed
jail render**), `remix-journey-1..3-*.png`, `maple-remix-journey.gif`.

**Parity verdict (honest):** widths equalized to ≤2px by the script; ffmpeg
SSIM over the pair is **0.913** (1.0 = byte-identical). Same layout, colors,
copy, chart geometry, and interactive range control. The two visible residuals:

- **Fonts.** The host renders next/font Inter; the jail has no network
  (`connect-src 'none'`, `font-src data:`), so `var(--font-inter, system-ui)`
  falls back to the system stack. Metrics are near-identical; glyph shapes
  differ slightly.
- **Height.** The jail's measured content box lands 6px shorter than the host
  card (370.5 vs 364), which shifts the chart rows the SSIM compares.

## Demo capture 3 — in-client promotion end-to-end

`maple-inclient-promotion.mjs` — the locked venue model (06-apps §9) enforced
on the real host, with a live authority probe (a generated `FetchProbe` button
that runs `fetch('/login', { credentials: 'same-origin' })` from inside the
app):

1. **Before approval** (`promotion-1-jail-fetch-blocked.png`): the forked card
   and probe render in the sandboxed jail; the probe reports
   `fetch: FAILURE (CSP)`.
2. **Ship-diff** (`promotion-2-ship-diff.png`): the Apps page's ship-review
   panel (`GET /apps/:id/ship-diff`) shows the pinned fork against its
   captured baseline hash plus the net-new generated `FetchProbe` — the exact
   delta an approval pins.
3. **Injected approval → host-page mount**
   (`promotion-3-inclient-mounted.png`): the documented dev seam
   (`POST /api/vendo/dev/inclient-approval`, owner session) pins the current
   version hash; on reopen the components mount NATIVELY in the host page —
   `[data-vendo-inclient-mount]` present, **zero iframes** in the surface, and
   the same probe now reports `fetch: SUCCESS (host authority)`.
4. **New version drops back, loudly**
   (`promotion-4-dropback-notice.png`): one more model edit (a rename) changes
   the version hash; the surface returns to the jail with the in-surface
   notice "In-client approval invalidated … until the new version is
   re-approved", and the probe fails under the CSP again.

Evidence: the four beats above and `maple-inclient-promotion.gif`.

## Cadence wiring

`cadence-dashboard-missing-docs-hero.png` — the Cadence dashboard rendering
the extracted, remixable `MissingDocsHero`
(`apps/demo-accounting/src/components/dashboard/missing-docs-hero.tsx`, slot
`CadenceMissingDocsHero`) in its real position, visually unchanged. Its
baseline captures with no unresolved pins (`vendo sync` exit 0).

## Run them

From the repository root after `pnpm install && pnpm build`, with `ffmpeg` on
PATH. Source the shared keys without printing them:

```sh
set -a
source /Users/yousefh/orca/workspaces/flowlet/.env
set +a
node docs/verification/eng-288-m6/maple-remix-parity.mjs
node docs/verification/eng-288-m6/maple-inclient-promotion.mjs
```

Each script boots its own Maple dev server (ports 3111/3112), parks the demo's
gitignored PGlite scratch dir (`apps/demo-bank/.vendo/data`) in the OS tmpdir
first — an uncleanly killed dev server leaves PGlite unrecoverable — creates
and deletes its own app, exits nonzero on any failed assertion, and overwrites
the evidence files on success.
