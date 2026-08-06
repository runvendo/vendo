---
"@vendoai/store": minor
"@vendoai/vendo": minor
---

Transcripts and harness state ride StoreOps, so a hosted store can serve a
harness turn.

`threadMessageStore` and `harnessStateStore` opened with `dbFor(store)` and threw
"Unknown VendoStore handle" for anything `@vendoai/store` did not mint — which is
every key-only deployment. So `storeServesHarnessTurns` answered false for them
and the host silently fell back to the legacy chat path: hosted deployments could
not use `harness:` at all.

- `VendoStore` gains an optional `ops?: StoreOps`. The Cloud `hostedStore` already
  exposed one, so it satisfies the member with no change.
- One internal selector, `backendOf`, decides for every store-shaped helper: the
  SQL handle when there is one (same database, one hop shorter), the store's own
  32-op surface when there is not, and a named `not-implemented` refusal only when
  the store offers neither. Nothing above the store package can tell the two
  apart — no caller changed.
- Transcripts ride the wire as-is: `transcripts.putMessage` for the write,
  `transcripts.getThread` for the read, ownership enforced against the thread
  record's subject exactly as the SQL join enforces it against `vendo_threads`.
  A foreign or absent thread reads as empty and refuses writes, as it does
  locally. A guarded (`expectedRevision`) edit has no wire expression and is
  refused loudly rather than downgraded to last-write-wins; no runtime caller
  asks for one.
- Harness state rides the wire's `harness` family under the SAME slot the SQL
  half uses (`harness_state:<threadId>`, keyed by the thread's owner), so §1.3's
  rules — one slot per thread, a foreign harness destroying rather than shadowing
  it, the slot dying with its thread — hold on both backends.

The harness-turn refusal now names both options instead of only SQL, and the
route probe accepts an ops-capable store.

Proven where it counts: one behavioral suite for each helper runs against three
backends (real Postgres/PGlite, core's `memoryStoreOps`, and the local 32-op
backend), and a live seam test writes through the real helper over a real
`hostedStore` against the real console and reads it back on a second,
freshly-constructed client — no stub on either side.

Known gap, recorded as a live `it.fails` rather than a comment: the console's
`transcripts.putMessage` appends instead of editing by id, so re-writing an
already persisted message (the approval flip) is refused there. The fix is
console-side; the local backends already do the right thing.
