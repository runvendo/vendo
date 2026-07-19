---
"@vendoai/ui": minor
---

Voice v1, the full designed stage (ENG-229): resilient realtime driver
(connect timeout, bounded reconnect with fresh re-dial, mute via track.enabled,
live amplitude, humanized failure messages) and the rebuilt `VendoStage` —
amplitude-driven blob, two-row sticky captions, transcript drawer, consent bar
(approvals decidable mid-call, with receipts), renderer-backed session-view
feed with slide focus + dots, reconnecting/error banners with Retry, and exit
settle choreography (`onSessionEnd`). `useVoice()` additionally returns
`error`, `muted`, `setMuted`, `amplitude`, and `views`.
