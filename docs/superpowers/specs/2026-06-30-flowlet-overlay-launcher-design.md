# Flowlet Overlay + Launcher — Design

Date: 2026-06-30
Surface: Overlay / launcher only. Inherits the locked graphite-glass codex theme from `@flowlet/shell`. Does not touch the shared theme, chat, components, or connection selector.

## Goal

Collapse the current two-surface, two-launcher mess into a single invisible surface: Flowlet is summoned only with **Cmd/Ctrl+K** and otherwise leaves no chrome on the host page. Automation alerts surface on their own as a toast.

## Current state (problem)

- **Two surfaces.** `FlowletDock` — a 440px bottom-right panel with hardcoded white inline styles (off-theme) — and `FlowletOverlay` — the centered Cmd+K modal on the correct graphite-glass theme.
- **Two launchers.** `FlowletLayer` renders its own white "Ask Maple" pill to open the dock; `FlowletOverlay` separately renders an unpositioned `.fl-launcher` pill.
- **The fire alert is trapped.** The "Rule fired → posted to #channel" banner lives inside the dock, so it only shows when the dock is open.

## Decisions

- **No launcher at all.** Flowlet is invisible until summoned with Cmd/Ctrl+K. No pill, no persistent hint.
- **Fire alert becomes a toast.** Bottom-right, graphite-glass themed, auto-dismisses ~5s, click opens the overlay.
- **One surface.** The centered Cmd+K overlay is the only surface. The dock is deleted.
- **Works everywhere**, including `/flowlet` — the pathname special-casing is dropped.
- **Clicking the toast opens chat only.** The toast already carries the fired-event detail; the overlay opens to the normal thread.

## Components

### 1. `FlowletOverlay` (packages/flowlet-shell) — render nothing when closed
- When closed, return `null` instead of the `.fl-launcher` button.
- Keep the Cmd+K toggle, scrim, and centered graphite-glass panel unchanged.
- Add an optional **controlled-open** interface (`open` + `onOpenChange`). When provided, the parent owns open state; when omitted, it falls back to today's internal state. Cmd+K works in both modes. This lets the toast open the overlay.
- **Open animation — "stretch."** The panel grows from a thin centered sliver to full size with a rubber-band overshoot: `scaleX(.06) scaleY(.7)` → `scale(1)`, ~0.5s on `cubic-bezier(.22,1.2,.36,1)`, `transform-origin: center`. Because the panel mounts fresh on open (closed = `null`), this is a `@keyframes` animation on `.fl-overlay-panel` (runs on mount), not a CSS `transition`. The scrim cross-fades in (~0.2s). Close is immediate — panel unmounts, scrim fades out. `prefers-reduced-motion`: skip the stretch, plain fade.
- Backward-compatible and theme-neutral. This is the only change to shared shell code (overlay element + its `.fl-overlay-*` CSS).

### 2. `FlowletToast` (apps/demo-bank) — new
- Standalone, self-positioned `fixed` bottom-right.
- Graphite-glass themed using the shell's CSS vars (`--flowlet-glass`, `--flowlet-blur`, `--flowlet-border-strong`, `--flowlet-shadow`, `--flowlet-fg`) with a green success accent for "rule fired".
- Carries the fired-event detail (channel, merchant, amount, time, offline-fallback note) — the same content `FireBanner` shows today.
- framer-motion enter/exit; auto-dismiss after ~5s; manual dismiss control; clicking the body opens the overlay.

### 3. `FlowletLayer` (apps/demo-bank) — consolidate
- Remove the white "Ask Maple" pill and the `FlowletDock` mount.
- Own the overlay open-state here so the toast can open it (controlled `FlowletOverlay`).
- Render: `FlowletPoller` (drives `fire`) → `FlowletToast` (shows on fire, click opens overlay) + `FlowletOverlay`.
- Drop the `usePathname` / `showDock` gating; overlay, toast, and `SavedViews` mount on every page.
- Keep the backstage keyboard shortcuts (Cmd+Shift+\ inject, Cmd+Shift+. reset) untouched. Reset is keyboard-only now — the dock's reset button is gone and no demo-specific buttons are added to the shared shell.

### 4. Delete `FlowletDock.tsx`
Fully removed; its `FireBanner` content lives on in `FlowletToast`.

## Data flow

`FlowletPoller` → `fire: FireEvent | null` in `FlowletLayer` → `FlowletToast` renders when `fire` is set → auto-dismiss or click clears it / opens overlay → `FlowletOverlay` (controlled `open`) shows the chat thread.

## Out of scope

Shared theme, chat thread, components, connection selector, and the agent/poller wiring are untouched. No changes to fire detection or Slack posting.

## Testing

- Cmd+K toggles the overlay open/closed; nothing renders on the page when closed.
- Opening plays the "stretch" animation; `prefers-reduced-motion` falls back to a fade.
- A fire event shows the toast bottom-right; it auto-dismisses ~5s; clicking it opens the overlay.
- `/flowlet` page still responds to Cmd+K and shows the toast.
- Visual check (render + screenshot) confirms the toast matches the graphite-glass theme.
