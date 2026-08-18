---
"@vendoai/vendo": patch
---

A texted reply arrives the way a person texts. The channel used to buffer the
whole turn and send one message at the end, so the answer landed as a wall well
after the model had written its first sentence. The model now decides where one
text ends and the next begins — the texting style note teaches a line containing
only `---` as the cut point — and each segment is sent the moment its divider
passes, with the divider itself stripped and never delivered. A reply with no
divider in it is simply one text; there is no structural fallback.

Four latency and reliability fixes ride with it:

- **Prompt-cache warming for texts.** The web has warmed the provider prefix
  since a chat surface opens; a texted conversation never did, so every text in
  a back-and-forth paid a cold prefix. The channel now warms after the reply is
  out — never something the person waits behind.
- **Fewer store trips before the turn starts.** Delivery dedupe and the phone
  lookup are independent questions, so they are asked together instead of one
  after the other, and the delivery-row prune stops running on every single
  message — it re-listed and re-deleted the whole conversation before the turn
  could start, and is now a sweep.
- **A dropped reply is retried, and its loss is said out loud.** The channel
  adapter now uses the same keep-alive connection pool as every other Cloud
  adapter (Node drops an idle socket after ~4s, so a conversation's second text
  paid a fresh TCP+TLS handshake) and retries a failed call three times. A reply
  that still cannot be delivered logs `vendo.channel-reply-lost` at error level
  rather than vanishing; the delivery claim is deliberately not released,
  because replaying the turn would re-run the tool calls it already made.
- **Two rapid texts stay on one thread.** They used to run as concurrent turns
  that each read the link before either wrote its thread back, so each minted
  its own thread and one was orphaned — a forked conversation whose second reply
  had no idea what the person had just said. Turns are now serialized per
  conversation in-process, and the second runs on the thread the first left.
  A YES/NO answering a card deliberately skips that queue: the turn it releases
  is the one holding it.
