---
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

The voice stage is removed. `@vendoai/ui` shipped a live WebRTC voice surface —
an animated presence orb, a rolling caption ticker, a transcript drawer, a
consent bar that accepted a spoken "approve", and a `vendo_act` bridge that ran
a real guarded agent turn mid-call. Nothing mounted it: the demo host un-docked
`<VendoStage />` on 2026-07-30, and no example, fixture, or docs host has
rendered it since.

Gone from `@vendoai/ui`: the `@vendoai/ui/voice` entry point in its entirety
(`realtimeVoiceDriver`, `createVoiceActBridge`, `VoiceDriver`,
`VoiceDriverEvent`, `VoiceDriverHandlers`, `VoiceSessionHandle`,
`VoiceSessionView`, `RealtimeVoiceDriverOptions`, `VoiceActBridgeOptions`),
`useVoice` and `UseVoiceResult` from the root entry, `<VendoStage />` from
`@vendoai/ui/chrome`, and the `voice` prop on `VendoProvider`. Gone from
`@vendoai/vendo`: the `useVoice` / `UseVoiceResult` re-exports on
`@vendoai/vendo/react`.

Pre-1.0 hard cut, no deprecation shim. Nothing else changes: the thread
composer keeps its optional `onVoice` callback, so a host that wants a mic
button still gets one and wires it to its own surface.
