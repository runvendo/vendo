---
"@vendoai/vendo": minor
"@vendoai/apps": minor
"@vendoai/ui": minor
---

Built apps: rendering a sealed bundle. An app whose artifact is a seal opens as `{kind:"bundle", entry}` and is served by the new `GET /apps/:id/bundle/:hash` — the sealed bytes inline in their own document, behind `Content-Security-Policy: default-src 'none'` as a real header, so the frame makes no network request at all. `@vendoai/ui` renders it in an iframe sandboxed `allow-scripts` with no `allow-same-origin`, which makes the app's origin opaque: brand tokens are posted in at render rather than baked into the seal, and host data reaches the app through one door only — a postMessage call that lands on the same guarded tool path a screen's press does, with the viewer's own permissions.
