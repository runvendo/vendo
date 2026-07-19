---
"@vendoai/ui": minor
---

Voice live pipeline — the realtime tool-call bridge (ENG-319). The realtime
driver gains an optional `act: VoiceToolBridge`: its `tools` ride the provider
`session.update` and every model function call funnels through `onToolCall`,
whose resolved value returns to the model as the function output. The shipped
`createVoiceActBridge({ client })` exposes one `vendo_act` tool that runs a REAL
guarded agent turn per call over `POST /threads` — minted views stream into the
stage feed via `VoiceActSession.emitView`, parked guard approvals reach the
stage consent bar (ENG-229), and the turn resumes through the existing
assistant-upsert approval-response path with the guard authoritative over
execution. No new server surface, no wire change; Maple's voice driver is wired
to it. Additive 08-ui amendment parked for Yousef sign-off.
