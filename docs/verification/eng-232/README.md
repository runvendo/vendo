# ENG-232 — Block: @vendoai/ui GIF gallery

The proof-of-bar GIF set for the ui block, captured with **live streaming** off
the real-browser harness (`packages/ui/e2e/harness`) — the same `@vendoai/ui`
chrome the demo hosts mount, backed by the deterministic wire fixture that
streams exactly like a live agent turn. Reproduce with:

```
node packages/ui/scripts/capture-gallery.mjs            # all beats
node packages/ui/scripts/capture-gallery.mjs voice-consent long-thread-jump
```

## Gallery (12)

| GIF | What it shows |
| --- | --- |
| `thread-streaming.gif` | A turn streaming token-by-token in the thread (Maple brand), settling with copy/regenerate turn actions. |
| `long-thread-jump.gif` | A 400-message thread: windowed render, scroll to the top, jump-to-latest re-sticks. |
| `mid-stream-kill.gif` | A mid-stream connection drop → the visible error banner + Retry (ENG-214 recovery). |
| `humanized-approval.gif` | Humanized tool beats (host metadata, collapsed repeats) + the friendly approval card. |
| `affordances-connect.gif` | The dead-CSS affordance set: code copy, then the connect dock opening its liquid tray. |
| `slot-pinned.gif` | A pinned `vendo-genui/v1` dashboard mounted in the inline slot (the ENG-223 pin path). |
| `palette.gif` | The ⌘K command palette. |
| `mobile-takeover.gif` | The overlay's full-viewport mobile takeover at a 390px phone viewport. |
| `dark-brand.gif` | The workspace on a dark host brand — `--vendo-color-scheme` derived from background (ENG-226). |
| `voice-consent.gif` | The full voice stage: amplitude blob, live captions, session-view feed, and the consent bar with an in-call approval. |
| `voice-drawer.gif` | The voice transcript drawer opening. |
| `activity.gif` | The rebuilt activity panel (real semantics, formatted times). |

## Remaining (parked for an attended capture session)

The spec also calls for the happy-path GIFs captured on **both real dev servers**
(Maple + Cadence via `pnpm --filter demo-bank dev` / `demo-accounting dev`) and a
**live-agent** voice-with-consent GIF (ENG-319: a real realtime agent acting
mid-call, not the harness replay driver). Those need the live model keys + a
realtime mic session and non-deterministic per-beat timing, so they are best
captured attended. The infrastructure is in place:

- `packages/ui/scripts/capture-gallery.mjs` — the harness gallery above.
- `scripts/capture-flow-gif.mjs` — the real-dev-server (Cadence director-mode)
  recordVideo → ffmpeg pattern to extend per host.
- Both hosts are already browser-verified with screenshots in
  `docs/verification/eng-230/`.
