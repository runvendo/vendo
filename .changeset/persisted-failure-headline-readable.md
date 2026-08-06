---
"@vendoai/ui": patch
---

A persisted turn failure reads whole after a reload.

The failure's headline rendered through the build beat's label — `white-space:
nowrap` + `text-overflow: ellipsis` — inside a block capped at `max-width: 92%`
of a turn that is itself shrink-to-fit. The percentage therefore resolved
against a width the block's own text had just set, so the box came out narrower
than the headline it contained and the ellipsis ate the end: a reloaded failure
with no detail line under it read "The response didn't f…" (144px of a 159px
sentence). The turn already caps at 92% of the list, so the inner cap is gone
and a failure headline now wraps instead of clipping — it is content, not a
progress line. No copy, color or component changed.
