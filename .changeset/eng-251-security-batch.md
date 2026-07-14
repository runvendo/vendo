---
"@vendoai/apps": patch
"@vendoai/store": patch
"@vendoai/vendo": patch
---

Security hardening (ENG-251).

- **Run-token anti-replay** (`@vendoai/apps`): run tokens now carry a random `jti`
  nonce. A run's jti is burned when its machine is torn down, so a captured token
  replayed afterwards is rejected at the proxy even though its HMAC and TTL still
  verify — shrinking the replay window from the full 15-minute TTL to the live run.
  A token remains valid for every callback of its own live run (tools, state,
  egress), so legitimate repeated proxy calls are unaffected. A token minted with
  no `jti` fails closed.
- **Timing-safe `/tick` compare** (`@vendoai/vendo`): the `VENDO_TICK_SECRET`
  bearer check used plain string equality (a timing oracle). It now uses a
  WebCrypto HMAC-digest constant-time compare — edge-safe, no `node:crypto`.
- **Bounded ephemeral-subject set** (`@vendoai/store`): the anonymous-visitor
  ephemeral-subject set is now a bounded LRU (10k) instead of growing until
  process restart. The subject registered for the current request is never the
  one evicted.
