---
"@vendoai/core": minor
"@vendoai/agent": minor
"@vendoai/harnesses": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

A streaming turn never goes silent, and a turn whose client vanished can be
rejoined.

**SSE keepalive.** A turn's first byte waits on a provider call and a slow tool
streams nothing for its whole duration, so the wire could sit quiet long enough
for a proxy or a browser to drop the connection. Every turn response now leads
with an SSE comment frame and gets one per 15s of silence. `@vendoai/core` gains
`withSseKeepalive`, `startSseKeepalive`, `SSE_KEEPALIVE_FRAME` and
`DEFAULT_SSE_KEEPALIVE_INTERVAL_MS`; both engines' responses use it, and the
`vendo try` dev server's own copy is gone.

Hosts may notice: **the SSE body now contains comment frames.** They are ignored
by the SSE grammar, so `useChat`, `DefaultChatTransport` and any spec-compliant
parser see an unchanged message sequence — but a hand-rolled reader that assumes
every frame starts with `data: ` needs to skip lines beginning with `:`. This is
not a new event: there is no new `HarnessEvent` member and no new
`data-vendo-*` part.

**Stream resume.** The client half already shipped in `ai@6`
(`ChatTransport.reconnectToStream`, which `useChat().resumeStream()` calls) and
had no server to talk to, so a reload mid-turn painted the user's question and
nothing else. The wire gains `GET /threads/:id/stream` — the SDK's own URL,
method and 204 contract — serving the turn from the start of the stream and then
following it live. Recording is per-turn, in memory, byte-capped, and dropped 30s
after the turn settles; the persisted transcript remains the durable record.

`useVendoThread` now resumes automatically after it loads a thread's transcript,
and returns `resumeStream()` for surfaces that reconnect on their own.
