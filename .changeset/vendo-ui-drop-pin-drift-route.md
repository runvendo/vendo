---
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

`GET /apps/:id/pin-drift` and the `client.apps.pinDrift()` method that called it
are removed. Neither had a caller: the drift report the drift banner actually
renders is the `pinDrift` array `open()` attaches to the payload, which is
unchanged, as are `POST /apps/:id/rebase-pin` and the fork-pin routes.

No rendered UI changes — the removed client method was never invoked.
