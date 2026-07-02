# ENG-183 Library UX — proposal (PAUSED for Yousef)

**Status:** Awaiting direction. Nothing here is built. The persistence layer underneath (PR #15) is UI-agnostic and doesn't presuppose any option below.

The library is the personal surface for saved flowlets: list, reopen, rename, pin, delete. Everything it needs already exists behind the seams (`store.list/save/remove`, `useReopenFlowlet`, `prompt`/`pinned`/timestamps on the record).

## Placement — three options

**A. The new-tab page (recommended).** The "+" tab currently opens an empty thread. Make the empty state the library: pinned flowlets first as cards (name, prompt as subtitle, updated-at in quiet mono), then recent; the hero composer stays on top so "new" and "reopen" live in one place. Matches F5's stated design ("a switcher… and the new-tab page opens any saved flowlet into a tab"; tabs are the working set, the library is the catalog). Zero new chrome — it upgrades an existing empty state.

**B. Command palette (Cmd-K) section.** Saved flowlets as a "Reopen" group in the overlay palette, searchable by name/prompt. Cheapest, keyboard-first, but no browsing surface, and rename/pin/delete don't fit a palette row well.

**C. A dedicated "Library" tab/rail.** Always-visible list left of the tab strip. Most discoverable, most chrome — feels heavier than INK/LIFT wants for a v1.

A and B compose: A is the browsing/management surface, B a later accelerator.

## States (option A)

- **Empty:** current greeting + suggestions, plus one quiet line ("Views you build are saved here").
- **Populated:** pinned row (if any), then "Recent" grid of cards. Card = name, one-line prompt, quiet `updated 2h ago` mono metadata. No thumbnails in v1 (a snapshot preview render is possible later via the stage, but heavy).
- **Reopened tab:** snapshot renders instantly; while queries re-run, the tab dot pulses; on fallback, a quiet inline "showing saved data" mono note (the hook already exposes `status`/`refreshing`/`errors` — currently unsurfaced).

## Interactions

- **Reopen:** click card → opens as a tab (existing behavior), library stays on the "+" page.
- **Rename:** inline on the card (pencil on hover → text field; `store.save` with new name).
- **Pin/unpin:** pin glyph on card hover; pinned sorts first (field already persisted).
- **Delete:** overflow menu on card → confirm → `store.remove`; also removes the open tab if any.
- **Tab strip stays as is** (auto-save behavior unchanged); a small "saved" check pulse on the tab when a view is auto-persisted is optional polish.

## Questions for Yousef

1. Placement: A, B, C, or A+B?
2. Should auto-save stay (every rendered view becomes a saved flowlet), or should saving become explicit ("Save" affordance) now that it's permanent storage?
3. Surface the stale-data/"showing saved data" state in v1, or keep silent fallback?
4. Delete confirmation: inline confirm vs. undo toast?
