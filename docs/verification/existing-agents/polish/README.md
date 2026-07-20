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

## Fix 2 — build-window 404 console noise

`VendoAppEmbed` polls `GET /apps/:id/open` every 1.2s while the build
streams, and the app record lands only at build completion — so every miss
logged a browser console 404 (meta polling was no alternative: `GET
/apps/:id` 404s identically until the record lands). The wire now answers a
flagged poll (`?pending=1`) with a quiet `200 {kind:"pending"}` for exactly
that expected pre-servable miss; unflagged callers keep the contracted 404,
and every other failure keeps its envelope and status. Against a wire that
predates the flag the embed's catch arm keeps the old polling cadence — the
degradation is only the console noise.

- `polish-2-build-window-quiet.png` — `/byo-embed-building`: the fixture
  lands the build after two missed polls; the bar resolves building → ready
  with the served app inline, and the spec asserts ZERO console errors
  (verified to fail against the unflagged poll).

Guard: the same spec's build-window test, `packages/vendo/src/server.test.ts`
(flag-gated pending vs contracted 404), and the embeds unit suite (every
poll carries `?pending=1`).

Live corroboration (examples/ai-sdk-agent, real model turn, 2026-07-20): a
full "make me a dashboard" build window against the real wire — every poll
`GET …/open?pending=1 → 200`, ZERO browser console errors, and the dashboard
landed inline (~1.8k px island, content-sized — fix 1 holding on a real
generated app).

## Fix 3 — AI SDK quickstart fixed-input overlap

The quickstart's stock input is `fixed bottom-0` and translucent; the stock
container's `py-24` clears chat-text-sized content, but a generated app card
is hundreds of pixels tall and ended up under the input at the bottom of the
scroll (see wave4's `wave4-c1-app-built.png`). Fix: one fenced spacer div in
the marked vendo diff of `app/page.tsx`; the README's diff table documents
it, so the "unmodified starter plus the fenced lines" claim stays honest.
The Mastra example is unaffected — its form is a sticky in-flow footer.

- `polish-3-input-clearance-after.png` — live turn, scrolled to the bottom:
  the last content sits well clear of the fixed input.
