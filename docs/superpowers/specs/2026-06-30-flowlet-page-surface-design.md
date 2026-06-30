# Flowlet Page surface — design

Date: 2026-06-30
Branch: yousefh409/flowlet-page
Scope: the dedicated full-page Flowlet surface at `/flowlet`

## Problem

The `/flowlet` route renders the chat as a small bordered card floating in a large
empty white box. It reads as a widget dropped onto a page, not a product surface.
Concretely:

- You have to scroll the page to reach the composer; content runs off-screen.
- The chat does not hold a constant size — the outer container grows and the whole
  page scrolls instead of the message list scrolling inside a fixed frame.
- The chat sits inside its own card inside the page (card-in-card), so it never
  feels like the page itself.

## Goals

- The chat IS the page — ingrained directly into the surface, no outer card,
  no border/shadow wrapper around the thread.
- A fixed-height surface that fills the viewport below Maple's topbar. No
  page-level scroll, nothing off-screen. Only the message list scrolls; the tab
  strip stays pinned at top, the connection rail + composer stay pinned at bottom.
- The chat is full-width (not a centered reading column).
- A tab strip is the top row of the surface: a live `Chat` tab, one tab per
  flowlet the user has built this session, and a `＋` to start fresh.

## Non-goals / locked constraints (owned elsewhere — inherited, not redesigned)

- The global graphite + soft-glass theme (`@flowlet/shell` styles).
- The chat thread internals, the composer, the components, the automation card,
  the connection rail and selector — the shared spine.
- The empty/landing state (greeting + suggestion chips) is the inherited Landing.
- No title or subtitle header on the page — the tab strip is the topmost element.

## Design

### Layout

The page is a full-height flex column that exactly fills the space inside Maple's
centered main area, below the topbar. From top to bottom:

1. **Tab strip** — a quiet underline-style row sitting directly on the page
   background (no tab "cards"). The active tab is marked with a graphite underline.
   Tabs: `Chat`, then one per saved flowlet (each with a small status dot), then
   a trailing `＋`.
2. **Body** — fills remaining height. Only this region's message list scrolls.
   - When `Chat` is active: the inherited thread (message list + connection rail +
     composer). Full width. Composer pinned at the bottom.
   - When a saved-flowlet tab is active: that generated view rendered full-page.
     The live `Chat` stays mounted but hidden so its session persists in the
     background.

Generated UI views remain bordered component cards inside the thread — those are
real components and keep their own surfaces. Everything else (thread text, rail,
composer) sits ingrained on the page surface.

### Tab model

- **Chat** — the one live working thread. Always present, leftmost.
- **Saved flowlets** — every generated component view that appears in the thread is
  auto-captured as a tab (deduped by node id), reusing the existing FlowletSaver
  watch pattern. A saved tab reopens that view rendered full-page.
- **＋** — starts a fresh chat: clears the live thread back to the greeting +
  suggestions, switches focus to the `Chat` tab. Saved-flowlet tabs persist across
  the reset (they live in page-level state, not in the thread).

One live chat at a time. `＋` replaces the current conversation; it does not open
additional parallel chat tabs.

### Sizing & scroll (the bug fix)

The page root is sized to the available viewport height and clips its overflow.
Within it, the tab strip and the rail+composer are fixed-height; the message list
takes the remaining space and is the only scroll container. This removes the
page-level scroll and the off-screen composer, and keeps the chat a constant size
regardless of conversation length. The current brittle `calc(100vh - 220px)` magic
number is replaced with a robust full-height flex model.

### Data flow

- Saved flowlets are derived from the page thread's messages by watching for
  `data-ui` component parts (the same approach as `FlowletSaver`), accumulated into
  page-level state and deduped by node id so they survive a `＋` reset.
- The `＋` reset clears the thread via the chat hook's `setMessages([])` (carried
  through `useFlowletThread`), so no provider remount or thread-id juggling is
  needed.
- The page keeps its own working thread, independent of the floating dock / Cmd+K
  overlay thread, so `＋` never wipes a conversation started elsewhere.

## Components / files

- `apps/demo-bank/src/app/flowlet/page.tsx` — the route. Replaces the header +
  bordered-box markup with the full-height ingrained surface and mounts the page
  body inside the existing `FlowletRoot`.
- A small page-local body component (inside `FlowletRoot`) that uses the chat hook
  to read messages, manages tab state (active tab + accumulated saved flowlets),
  and renders either the inherited thread or a saved view.
- `packages/flowlet-shell/src/elements/FlowletPage.tsx` — the shell's generic Page
  element is reconciled with this model so it is no longer an unused divergent
  variant: it carries the same ingrained, full-height, tabbed structure (live
  thread + saved-view tabs + reset) rather than spawning a fresh provider per tab.
- `FlowletLayer` already hides the floating dock on `/flowlet`; no change needed
  beyond what exists.

## States to cover

- Fresh `Chat` tab, no messages → inherited Landing (greeting + suggestions).
- Active conversation with several generated views → tabs accumulate; switching
  tabs swaps the body; `Chat` keeps its scroll position and session.
- `＋` from any state → blank `Chat`, saved tabs intact.
- Long conversation → message list scrolls internally; composer stays pinned; no
  page-level scroll.

## Verification

- Render `/flowlet` in the running app and screenshot: confirm no page scroll, the
  composer is visible without scrolling, the surface fills the viewport, and the
  chat is ingrained (no card-in-card).
- Drive a short conversation that produces a generated view; confirm a saved tab
  appears, reopens the view, and survives `＋`.
- Confirm the message list (not the page) is the scroll container with a long
  thread.
