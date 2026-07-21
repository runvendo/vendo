# Gesture-owned forking — browser verification (2026-07-21)

PR evidence for the remix redesign: the fork is gesture-owned and engine-executed
(deterministic, no model call); the model lost the fork decision entirely.
Production boots only (`next build && next start`), dedicated headless Playwright,
one host at a time, servers killed and orphans reaped after.

## Cadence (demo-accounting, :3300) — the UI gesture

- `cadence-1-before.png` — dashboard with the original host hero in its stat cell.
- `cadence-2-after-gesture.png` — after ONE click on the slot's Remix affordance:
  the engine forked `CadenceMissingDocsHero` deterministically (no model call),
  slot discovery mounted the pinned app in place (expanded row), pin recorded
  `{slot, base sha256:d79ae241…}`, ship-diff EMPTY (0 bytes — an unedited fork is
  an empty delta).
- Clicking Remix on the now-filled slot opens the overlay composer PREFILLED
  (never auto-sent) — instructions ride an ordinary edit.

## Maple (demo-bank, :3100) — the wire gesture + the one-shot journey

- `maple-2-plain-wire-fork.png` — `POST /apps/fork-pin {slot: "MapleNetWorthCard"}`
  answered in <100ms; the fork renders pixel-faithful (animated $54,907.15 total,
  green change badge, working 1W/1M/3M/1Y/All switcher, area chart) from the
  captured sample seed. Ship-diff empty.
- `maple-3-oneshot-fork-modify.png` — the previously-impossible one-shot
  "remix X so that Y" journey in ONE wire call:
  `POST /apps/fork-pin {slot, instruction: "make the change badge purple instead
  of green"}` → deterministic fork + ONE scoped edit (79.9s total). Badge renders
  purple; everything else faithful.
- `maple-shipdiffs.json` — both app documents' ship-diffs. The one-shot app's pin
  delta is a minimal 545-byte diff: exactly the two `POS`/`POS_BG` color constants
  (+ one clarifying comment), host comments preserved — no comment-stripping noise.

Known pre-existing console error on every app open (remix eval finding F5, not
introduced here): the jail stylesheet `/vendo/tailwindcss` blocked by
`style-src` CSP.
