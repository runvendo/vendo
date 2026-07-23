---
"@vendoai/apps": patch
"@vendoai/ui": patch
---

Empty-states batch — a fresh install's FIRST generated app now renders well
with no bindable host data. Generation always emits the requested component
bound to its tool (the Kit renders the designed empty state) instead of
omitting it or writing prose into a tile; the no-data explanation is one
consolidated "About this view" note, charts route to the Kit, and the app
name is a <=40-char display title (validated on create) instead of the
request echoed back. The Kit stat tile shows a compact em dash for empty
values and truncates prose-length text into a tooltip, empty label/value
pairs render an em dash, and the in-thread app panel scrolls its top into
view when a live build settles. The create-app tool description also stops
callers baking pre-computed figures or branding into the prompt.
