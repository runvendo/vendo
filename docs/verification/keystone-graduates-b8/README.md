# Pin ceremony — live proof (Keystone graduates B8)

`apps/demo-bank` (Maple) run locally against the patched `@vendoai/ui`, driven
headless, real Anthropic model, real generated app, real click on "Pin to
dashboard". Frames captured at 0.12× animation playback so the 480ms sequence is
visible; the durations in `live-run.txt` are what Chromium's own animation
timeline reported at full speed.

| frame | what it shows |
| --- | --- |
| `01-panel-dismissed-ghost-lifted.png` | the panel is already gone and the ghost is parked over where the card was — nothing has moved yet |
| `02-ghost-in-flight.png` | the ghost crossing the bare page toward the slot, which was scrolled into view |
| `03-settle-pulse.png` | the ring pulse over the slot, the app landed |
| `04-pinned.png` | the slot holding the pinned view |

`live-run.txt` — per-frame DOM state (ghost / stage / ring / panel visibility /
the ghost's live transform), the browser-reported animation durations, and the
measured time from click to a filled slot (**33ms**, against the 5000ms poll
this replaces).

`live-run-reduced-motion.txt` — the same run under
`prefers-reduced-motion: reduce`: no ghost, no flight, one 180ms pulse, panel
dismissed, slot filled in 32ms.
