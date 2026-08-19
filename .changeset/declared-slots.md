---
"@vendoai/apps": minor
"@vendoai/vendo": minor
---

Host-declared slots: `createVendo({ slots })` names the places this deployment always has, instead of waiting for a page to report them.

The slot registry is page-reported and ages out, so an agent-only product — where no page of yours renders a `<VendoSlot>` — had nowhere to pin a generated view. A declared slot never decays and needs no render. Declared and reported slots merge on read, and a declared entry wins over a page report of the same id.
