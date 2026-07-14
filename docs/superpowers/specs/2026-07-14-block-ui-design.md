# Block: @vendoai/ui — excellent and solid — Design

Date: 2026-07-14
Linear project: [Block: @vendoai/ui — excellent and solid](https://linear.app/runvendo/project/block-vendoaiui-excellent-and-solid-40d466c94497)
Status: approved by Yousef (brainstorm session 2026-07-14)

## Outcome and quality bar

Every shipped surface — thread, overlay, inline slot, full page, ⌘K palette, voice —
reaches host-shipped quality on two axes, in priority order:

1. **Brand-native first**: judged by "could Maple/Cadence have shipped this
   themselves?" The chrome adopts the host brand so deeply Vendo is invisible.
2. **Interaction polish**: streaming feel, motion, states at the level of
   top-tier agent apps (ChatGPT, Claude).

Part of the bar (not the headline): pragmatic accessibility (full keyboard nav,
correct focus traps/restoration, aria on interactive elements, streaming
announcements — no formal WCAG audit) and mobile (small viewports, touch
targets, virtual keyboard).

In scope beyond chrome: **headless hook parity** — every chrome capability
reachable via hooks.

**Cloud-aligned** (standing agenda item) means: surfaces expose the seams Cloud
features will plug into — sharing/publishing affordances, insights
instrumentation points — without building those features.

All solidity axes are in scope and systematically tested: streaming
robustness, extreme content, mobile/responsive, concurrency + lifecycle.

## Grounding

Two examination passes ran before scoping (2026-07-14):

- **Code audit** of `packages/ui` against frozen contract `docs/contracts/08-ui.md`:
  contract-complete, well-tested for security/containment/keyboard/axe, but the
  chrome is a thin rebuild inside a much richer dead design system
  (`chrome-css.ts` designs many affordances with no component). 23 gaps, 4 P0.
- **Browser exam** of both demo hosts (Maple :3000, Cadence :3010) with live
  streaming and screenshots (18 gaps, 4 P0). Evidence in session scratchpad
  `ui-exam/`.

Headline P0s: default thread mints a NEW server thread every turn (model never
sees prior turns); `.vendo-root` breaks the flex height chain so chat pages
brick under real content (approvals + composer unreachable); overlay entry dead
in both demos (`.vendo-launcher` vs `fl-launcher` mismatch) with no supported
overlay API; mobile takeover is dead CSS.

## Structure: three child sessions + parent integration

Parallel child Orca sessions (Fable orchestrators, execution delegated to codex
sol, Opus 4.8 only as usage-limit fallback), staggered starts — Child 1 first
because thread core underlies everything. Parent (this session) owns merges:
`chrome-css.ts` is the known conflict hotspot.

### Child 1 — Thread core & solidity

- **Thread persistence fix, first work item**: agent returns the minted `thr_`
  id (header or stream part), ui hook adopts it. Cross-package (ui + agent +
  wire seam), owned end-to-end here. Additive wire change only.
- Fix the `.vendo-root` height-chain break; scroll management: stick-to-bottom
  during streaming, jump-to-latest.
- Visible error surface + retry/regenerate (today errors go to a
  visually-hidden span).
- Composer: autogrow; type while streaming with **queue semantics** (message
  visibly queues, auto-sends when turn completes; Stop remains the explicit
  interrupt); edit last message; regenerate last response.
- Tool/approval humanization: host-metadata seam for friendly tool
  names/descriptions + ui-side formatting fallback (prettified ids, readable
  arg summaries); collapse repeated tool chips; no raw JSON or lifecycle
  strings shown to end users.
- Streaming polish: caret, generating skeleton.
- Extreme-content solidity: long threads (virtualization / entrance-animation
  stampede), unbroken strings, huge tool outputs, markdown re-parse cost.
- Hooks: `{ data, error, isLoading, refresh }` shape everywhere (today initial
  fetch failures are swallowed); refresh/polling; add missing headless
  coverage (threads list/get/delete, app export/import).

### Child 2 — Surfaces, chrome & brand

- Overlay: supported API (positioned launcher by default, programmatic
  open/close via props/hook, documented customization); portal + body
  scroll-lock + inert background; focus correctness (autofocus composer on
  open, never dump focus to body, restore on close); **conversation persists
  across reopen** (same threadId within session; explicit new-conversation
  affordance; scrim click just hides).
- Palette: singleton keybinding, host-collision-safe. Page: thread sidebar
  refresh. Slot: wire the empty-state CTA, specify the pinned-component path.
- Activity panel rebuild: real table/grid semantics, formatted times,
  end-of-list state.
- Implement the full dead-CSS affordance set: copy message/turn actions,
  code-block copy, drag-drop attach, image attachment previews, toasts,
  waiting-on-you queue, connect tray/dock.
- Brand depth: dark scheme **derived from background luminance** (no new
  contract token; brings the existing `light-dark()` CSS alive); wire inert
  tokens (density, radius small/large, headingFamily, baseSize scaling);
  tokenize hardcoded ok/warn/ceremony colors and mono font; **neutral user
  bubbles** (raw accent never paints large surfaces; accent reserved for send
  button, focus, true accents).
- Mobile takeover: implement the designed-but-dead takeover mode for
  overlay/page/palette; safe-area and virtual-keyboard handling; iOS zoom and
  touch-target fixes.

### Child 3 — Voice v1 (full designed stage)

- Consent bar: approvals reachable in a voice session.
- Mute control, reconnect banner + driver reconnect logic, amplitude-driven
  blob, transcript drawer, view feed.
- Error/timeout states (fixes the infinite "connecting" with no feedback).
- Stage layout integration so it doesn't read bolted-on.

### Parent (this session)

- Child session management, merge discipline, cross-child seam decisions.
- **Demo coverage: every surface mounted on both hosts** (Maple + Cadence each
  mount thread, overlay, slot with a real published app, palette, page,
  voice); rewrite both VendoLayers to the new overlay API; fix Maple's
  theme.json accent to a brand-true value.
- **Permanent Playwright stress suite in CI**: long threads, mid-stream
  network kill, mobile viewports, rapid open/close, dark-brand host,
  theme-token-effectiveness test (would have caught the inert tokens),
  multi-turn persistence test (would have caught the P0).
- **GIF gallery, core set (~14)**: per surface × both hosts happy path, plus
  headline stress GIFs — long-thread scroll + jump-to-latest, mid-stream kill
  + retry, mobile takeover, humanized approval flow, dark-brand host, voice
  session with consent. Captured on real dev servers with live streaming.
- Cloud-alignment check before close; Linear issues (flat list, labeled by
  workstream) kept current.

## Rules

- Contracts in `docs/contracts/` are FROZEN — theme/wire changes additive only.
- Never commit to main; each child works on its own branch/PRs.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before any PR;
  UI changes verified in a real browser with screenshots in the PR.
- Gap-driven redesign allowed: default to polishing what exists; where a
  surface is fundamentally below bar, do a design exploration before rebuild.
- Foundations-block overlap: this project owns the thread-persistence fix
  end-to-end including the agent/wire side.

## Decision log (Yousef, 2026-07-14)

Quality bar: both axes, brand-native first · all six surfaces deep · all four
solidity axes · pragmatic a11y · gap-driven redesign allowed · headless parity
in scope · cloud-aligned = hooks + seams ready · proof = GIFs + CI stress suite
· thread bug fixed here first · dead-CSS set: implement all · dark = derive
from background · voice = full designed v1 · overlay = real API + fix demos ·
tool display = host metadata + fallback · demo coverage = every surface, both
hosts · overlay memory = persist across reopen · composer = type + queue +
edit + regenerate · Maple accent = neutral bubbles AND fix theme.json ·
structure = 3 children + parent · Linear = issues only · send = queue · GIFs =
core set ~14.
