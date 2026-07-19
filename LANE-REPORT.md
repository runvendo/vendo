# LANE-REPORT — ui-lane-entry

Lane: entry & discoverability (vendo-trigger, launcher pill + whisper, vendo-palette ⌘K,
vendo-slot, mobile takeover entry). Canvas: `design-canvas/` in this worktree (git-excluded),
served at http://localhost:4784/ — `index.html` (baseline), `options.html` (Round 1),
`round2.html` (Round 2), `round3.html` (converged picks, live-configurable demos).

Converged 2026-07-19 after three rounds. Trigger and the mobile-takeover interaction model
were reviewed and left as-is (only the surfaces below change).

---

## Converged picks

### 1. Launcher — morph-blob pill, white-label (Round 2 "L-B" + Round 3 refinements)

- Replace the sparkle icon in the corner pill with the **morph-blob mark**: a small
  accent-colored blob that continuously morphs shape (CSS border-radius keyframes, ~7s
  loop, quickens to ~2.4s on hover; static circle under `prefers-reduced-motion`).
- **No product mention anywhere by default.** Default label: **"AI agent"**.
- Host-configurable: any label string; `null`/empty → blob-only circular orb; an `icon`
  slot accepts a host element (e.g. their logo) in place of the blob.
- Pill geometry/material unchanged (glass-strong, 999px radius, existing shadow/border).

### 2. ⌘K — the palette dialog is deleted; ⌘K opens the conversation overlay (Round 2 "P-C")

- `VendoPalette` stops rendering its own combobox dialog. The ⌘K hotkey (and the palette
  opener seam) route to `openVendoConversation()` — one surface to learn.
- Commands render as a **chip strip pinned above the overlay composer** (New chat ·
  <generated apps> · Activity). Typed text that matches nothing is simply the message —
  no "No matching commands" state exists anymore.
- **Compact when empty** (Round 3 whitespace feedback): with no conversation, the panel is
  content-sized (~260px: greeting, chip strip, composer) — no dead glass. It animates to
  full height (~430px transition on `height`, reduced-motion: instant) when the first
  message lands.
- Mobile: compact **bottom sheet** (grab bar, greeting, chips, composer) over the visible
  host page when empty; becomes the existing full-bleed takeover once a conversation is
  active. Keyboard-inset behavior unchanged.

### 3. Slot empty state — accent invitation + suggestion chips (Round 2 "S-A × S-D")

- Surface: faint accent wash (accent 7%→2% gradient over surface), accent-tinted border,
  ghost skeleton kept behind at 35% opacity so it still reads as "a view goes here".
- Content (all host-configurable, defaults below): title **"This space builds itself"**,
  subtitle **"describe a view — it renders here, live on your data"**, an eyebrow
  **"Try one"** over **three host-aware suggestion chips**, and a primary
  **"Design a view"** button.
- **No icon by default** (Yousef rejected both the blob tile and the sparkle tile);
  optional `mark: "none" | "sparkle" | "tile"` prop, default `"none"`.
- Variant A (chips + primary button) is the default; Variant B (chips-first with a quiet
  "or describe your own…" link) stays available behind a prop.
- Chip tap → `openVendoConversation({ prompt, send: false })` (prefill, never auto-send).
  Button → opens the overlay composer focused (was: opened the palette).
- Mobile: chips full-width, ≥40px targets; otherwise identical.

## Customization requirement (Yousef, explicit)

"User should be able to customize a lot of this stuff." Every user-facing string and
affordance above is a host prop with white-label defaults (no Vendo mention):

```ts
// VendoOverlay (extends existing launcher prop)
launcher?: "bottom-right" | "bottom-left" | "none" | {
  position?: "bottom-right" | "bottom-left";
  label?: string | null;        // default "AI agent"; null → blob-only orb
  icon?: ReactNode;             // replaces the blob (host logo etc.)
}
commands?: VendoCommand[];      // chip strip above the composer (replaces palette list)
compactEmpty?: boolean;         // default true

// VendoSlot (new empty-state config; existing props unchanged)
emptyState?: {
  title?: string;               // "This space builds itself"
  subtitle?: string;            // "describe a view — it renders here, live on your data"
  suggestions?: string[];       // 3 host-aware prompts; generic fallbacks otherwise
  ctaLabel?: string;            // "Design a view"
  layout?: "button" | "chips-first";   // default "button" (Variant A)
  mark?: "none" | "sparkle" | "tile";  // default "none"
}
```

Suggestions should be loadable from `.vendo/greeting.json`-style config alongside the
greeting prompts (same host-aware pipeline).

## Exact code-change list (implementation wave, branch yousefh409/ui-brainstorm)

1. **packages/ui/src/chrome/chrome-css.ts**
   - Add `.fl-launcher-blob` morph keyframes (+ hover speed-up, reduced-motion static
     circle) and blob-only orb padding variant.
   - Add compact-empty overlay styles: `.fl-overlay-panel.fl-empty { height: <compact> }`
     with height transition; drop the msglist top mask in compact; mobile
     `.fl-overlay-panel.fl-takeover.fl-empty` bottom-sheet variant (rounded top, grab bar,
     auto height, host visible behind) — reuses existing z-index/scrim rules.
   - Add slot invitation styles: accent-wash surface, title/sub/eyebrow, suggestion chips,
     primary button; keep `.fl-slot-skel` (render at .35 opacity, no blur/mask change).
   - Add overlay chip-strip styles (horizontal scroll, 38–44px targets on coarse).
   - Do **not** remove `.fl-picker*` — shared by connect-dock/tray; only the palette's
     usage goes away.
2. **packages/ui/src/chrome/vendo-overlay.tsx**
   - Launcher markup: blob span + label from the extended `launcher` prop (default
     "AI agent", `null` → orb, `icon` slot). Remove the sparkle SVG + "Vendo" text.
   - Accept `commands` (or read them via a registry from VendoPalette hosts) and render
     the chip strip above the thread composer; chip activation = command routing
     (`new-conversation` → epoch bump; others → host `onCommand`).
   - Empty-state signal: stamp `fl-empty` on the panel while the thread has no turns
     (needs a lightweight `onConversationState` callback from `VendoThread` or a
     data-attribute the panel can observe); remove it on first send → height transition.
3. **packages/ui/src/chrome/vendo-palette.tsx**
   - Delete the dialog/combobox rendering + takeover portal usage. Keep the component as
     a headless keybinding registrar: hotkey → `openVendoConversation()`; `commands` are
     forwarded to the overlay chip strip; `onCommand` unchanged. Keep
     `registerPaletteOpener` seam working (slot CTA → overlay).
   - a11y: combobox/listbox semantics go away; overlay's existing dialog semantics carry.
4. **packages/ui/src/chrome/palette-hotkey.ts** — `openVendoPalette()` becomes an alias
   for the overlay opener (API kept for compatibility; dev-warn if no overlay mounted).
5. **packages/ui/src/chrome/vendo-slot.tsx**
   - Replace the ghost CTA block with the invitation markup (title/sub/chips/button from
     `emptyState` config, defaults above, mark default "none").
   - Chip handler `openVendoConversation({ prompt, send: false })`; CTA button opens the
     overlay (composer focused) instead of `openVendoPalette()`.
   - Keep skeleton, loading state, filled state, remix affordance untouched.
6. **packages/ui/src/chrome/discoverability.ts** — export the generic suggestion
   fallbacks next to `defaultVendoGreeting` so slot + greeting share one source.
7. **Tests** — palette tests rewritten for headless behavior (hotkey routes to overlay,
   no dialog in DOM); overlay tests for label config/blob/compact-grow; slot tests for
   emptyState config + chip prefill; a11y pass on the removed combobox.
8. **Docs** — `docs/` chrome pages for launcher/palette/slot config; contracts 08-ui §4
   currently describes the palette as an ARIA combobox — needs a parent-session decision
   (contracts are unfrozen in v2, but the parent owns contract edits).

## Flags for the parent session

- **Whisper strings still say "Ask Vendo…"** (`vendo-overlay.tsx` whisper + greeting
  fallback intro). Out of my named scope this round, but the white-label rule logically
  extends to them — recommend making whisper/greeting copy configurable with neutral
  defaults in the same wave.
- `defaultVendoTheme` blue-vs-black discrepancy: untouched per brief §9 (parent owns).
- Removing the palette dialog changes 08-ui §4 contract wording (combobox) — parent to
  bless the contract edit.
- The compact-empty overlay needs an "is thread empty" seam from `VendoThread` — small
  API addition, coordinate with ui-lane-thread so it composes with their composer work.

---

## IMPLEMENTED (2026-07-19, commits eb379737 · 02ea42d9 · 77996b2a · cff73834)

All three picks landed on yousefh409/ui-lane-entry on top of the merged parent
branch (black default accent + renderer forming-skeletons). ui tests 404/404,
vendo integration tests 590/590, build/typecheck green. Playground screenshots
scenario-overlay-launcher + scenario-slot-empty recaptured via the Orca
embedded browser; compact-empty → grow-on-send exercised live. The thread
empty-state seam resolved as CSS :has(.fl-landing) — no thread API and no
cross-lane coordination needed. Not pushed; parent merges.
