# TRIAGE — PR #391 AI-review findings (ui-lane-entry scope: vendo-slot|vendo-palette|vendo-overlay)

3 findings fetched (all cubic-dev-ai). Dispositions:

1. **3610569764 · vendo-slot.tsx:150 · P2** — "Suggestion chips lose their prompt
   when only VendoPalette is mounted (palette fallback has no prefill channel)."
   → **REAL.** The `openVendoPalette()` fallback in `suggest()` could never carry
   the prompt — and with the palette now headless it routes straight back to the
   same failed conversation opener (dead code + double dev-warn). Fixed: fallback
   removed; without an overlay the chip is a dev-warned no-op. Fix commit: see
   "ui: AI-review fixes for the entry lane".

2. **3610569769 · vendo-palette.tsx:51 · P2** — "Host-routed command chips leave
   the conversation modal open; close before invoking onCommand."
   → **REAL.** The old palette dialog closed on select; the chip strip didn't,
   so `show-activity`-style host navigation landed behind the open overlay.
   Fixed: new `close` option on the overlay registry; `select()` closes the
   surface before handing the command to `onCommand` (focus restores to the
   invoker). Self-routed default (`new-conversation` without onCommand) keeps
   the surface open — it IS the destination. jsdom + browser tests updated to
   assert close-on-select. Fix commit: see "ui: AI-review fixes for the entry lane".

3. **3610569785 · vendo-overlay.tsx:399 · P3** — "`launcher={{ label: \"\" }}`
   renders an icon-only button with no accessible name."
   → **REAL.** Empty/whitespace labels now collapse to the blob-only orb exactly
   like `null`, which carries the `aria-label="AI agent"` fallback. Regression
   test added. Fix commit: see "ui: AI-review fixes for the entry lane".

Verification: ui jsdom suite 430/430; targeted browser specs (stress, eng-222,
keyboard ⌘K, chrome-behavior chips, verification-eng223, accessibility palette)
all pass locally.

## Related CI fix (same session)

The failing "rapid overlay open/close ghost-dialog" stress spec was **STALE**,
not a regression: it queried the launcher by the old "Vendo" name and the
concurrent-surfaces spec asserted the deleted "Vendo command palette" dialog.
All e2e specs asserting the old palette dialog / launcher name were updated to
the approved one-surface behavior (stress, eng-222, keyboard, chrome-behavior,
accessibility, screenshots, verification-eng223 + harness mounts). Out-of-lane
browser failures observed locally (composer-textarea focus-indicator helper
conflict, voice/stage/activity/scroll specs) belong to the thread/cards/voice
lanes' fallout and were left untouched.
