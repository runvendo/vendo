---
"@vendoai/vendo": minor
"@vendoai/harnesses": patch
---

A deployment's users can use the product over text message. `createVendo({ channels: { text: true } })` plus one anchor to `/api/vendo/channels/text/link` is the whole opt-in: a signed-in user opens the anchor, their phone jumps into a prefilled first message, and from then on they text the agent, which acts as them exactly as it does in a web chat — same guard, same threads, same audit. Linking takes two texts because the identity router that binds the phone consumes the first one, so the link page says so and the code is short and unambiguous enough to retype. The phone ↔ user binding lives in the deployment's own store (`vendo_channel_links`, swept by `erase.bySubject`); Vendo Cloud carries the numbers and the delivery and never learns who a phone belongs to. A gated tool call parks as usual and the consent card becomes a text carrying the exact action and arguments — "YES" from the linked phone decides the same approval record the turn is blocked on, so an approval wait is now a per-turn bound (10 minutes on a channel turn, the frozen 90 seconds everywhere else).
