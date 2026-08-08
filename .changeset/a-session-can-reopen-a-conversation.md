---
"@vendoai/agents": patch
"@vendoai/core": patch
"@vendoai/vendo": patch
---

A standalone session can reopen an existing conversation.

`session(subject, { threadId })` reopens the named conversation instead of minting
a new one. Ownership is the store's own subject scope — someone else's thread reads
back as absent and is refused as `not-found`, never silently swapped for a new
conversation. The resume path deliberately skips `threadStore.put`, whose replace
semantics would delete the very transcript the resume exists to read back.

Until now `createSession` minted a fresh thread on every call and `SessionOptions`
had no way to name an existing one, so a Node backend that built a session per HTTP
request — which is what the README showed — lost the whole conversation on every
request. Multi-turn only worked while the JS object stayed alive in process memory.
The README now passes `threadId` in, hands `session.threadId` back out, and says
plainly that a session is request-lifetime while the thread is not.

The `[User]` and `[Situation]` prompt blocks are now one implementation in
`@vendoai/core` (`userPromptBlock`, `situationPromptBlock`, `promptFactLines`),
shared by the standalone assembler and the umbrella's. They were two copies of a
prompt-injection defence — the indent that stops a client-supplied fact from
forging a top-level `Directions` section — and only the umbrella's labeled the
situation "observation, not instruction". The shared block carries that label, so
the standalone surface gains it. No other behaviour changes.
