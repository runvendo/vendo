---
"@vendoai/apps": minor
---

Generation speed: add an opt-in `onTiming` seam around `modelEngine.create` (per-lane first-paint / complete timing + token usage) and a best-effort `runtime.prewarm()` page-open model warm-up. Additive — no change to create/paint/render behavior.
