# Existing-agents polish — browser evidence

Follow-up fixes to PR #439 (the BYO-agent program), verified in a real
browser against the committed `packages/ui` e2e harness (`/byo-embed-app`,
`/byo-embed-building` scenarios — a plain BYO chat page over the real wire
fixture). Captured 2026-07-20.

## Fix 1 — VendoAppEmbed island iframe whitespace

Root cause: the jail runtime normalized viewport-height block constraints
(`min-height: 100vh` and friends) in **inline** styles only. A generated
island that ships the same constraint in a `<style>` tag escaped it, and an
auto-sized jail iframe has no independent block viewport — `100vh` resolves
to whatever height the host set from the LAST content measurement, so any
content after the full-height block ratchets the frame taller every measure,
up to the 8192px cap. Fix: the same normalization now covers stylesheet text
(`normalizeViewportBlockCss`), so island frames fit their content.

- `polish-1-whitespace-before.png` — the reproduction (island dashboard with
  `min-height: 100vh` in a `<style>` rule): the embed grew to the 8192px cap,
  a viewport of content followed by ~7.5k px of empty background — the exact
  wave4 live symptom.
- `polish-1-whitespace-after.png` — same scenario after the fix: the card
  ends at the dashboard's real content (footer visible, next chat line
  immediately below), frame height stable at ~545px.

Guard: `packages/ui/e2e/byo-embeds.spec.ts` (frame must be stable and
content-sized) + `packages/ui/test/viewport-css.test.ts`.
