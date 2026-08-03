# `<Remixable>` — browser verification (2026-08-01)

Keystone graduates §B7. The affordance wired onto Maple's own **Top Merchants**
card (`apps/demo-bank/src/app/insights/page.tsx`) and driven headlessly against
the patched workspace `@vendoai/ui`, at 1440×1000.

Measured, not eyeballed — every line below is a computed style or a measured
rect read out of the live page:

| State | Reading |
| --- | --- |
| Rest | wrapper has no `data-vendo-revealed`; seed `opacity: 0.32`; pill `opacity: 0`, `pointer-events: none` |
| Hover | wrapper revealed; pill `opacity: 1`; seed `opacity: 0` (the seed has become the pill) |
| Grace, 80ms after the pointer leaves | still revealed — this is the travel to the pill |
| Grace, 480ms after | released |
| Keyboard | `.fl-remix-pill` takes focus directly and the focus alone reveals it |
| Click | composer value `""`; chip `aria-label="Remixing: Top Merchants"`, text `REMIXING Top Merchants ×`; **zero** `POST /api/vendo/threads` |
| Chip placement | 13px from the panel's top, 13px from its left — level with the panel's ✕/＋/expand controls (12px) |
| Send | the turn's text is exactly `group these by merchant\n\nRemixing the "Top Merchants" component on this page.`; the chip is gone (0 in the DOM) |
| Reduced motion | pill `transition-duration: 0s` (the guarded rule dropped out) and `opacity: 1` measured 60ms after hover — it snapped |

Captures (gitignored per `docs/verification/README.md`; kept in the lane
worktree as `proof/remix-proof-*.png`):

- `1-rest` — the muted ✦ alone in the card's top-right corner.
- `2-hover` — the ✦ Remix pill in the same corner, on the same optical centre.
- `3-attached` — the panel open on its landing with an empty composer and the
  `REMIXING · Top Merchants` chip pinned top-left, level with the header controls.
- `4-keyboard-focus` — the pill revealed by focus, with its focus ring.
- `5-reduced-motion-hover` — the same bloomed state, reached with no travel.

The driver is `proof/remix-proof.mjs` in the lane worktree; the host was
`pnpm --filter demo-bank dev` on :3100 against the patched workspace packages.

Unit coverage is `packages/ui/test/chrome/remixable.test.tsx` (13 cases: rest
state, bloom, grace hold, grace cancel, focus reveal, empty-composer open,
attach-and-clear on send, empty-draft guard, dismiss, failed-attachment
restore, draft preservation, dev warning, the programmatic seam) plus the reduced-motion CSS assertion and
the `Remixable` entry in `test/ssr.test.tsx`.
