# Wave 4 contract-amendment inventory — session lifecycle for ephemeral principals (ENG-237)

> **STATUS: APPROVED by Yousef, 2026-07-16 — APPLIED.** All 9 items below
> (including the four RECOMMENDATION defaults: 30 min TTL, 60 s sweep
> interval, 10 000 session cap, evict-on-expiry sweep-before-touch ordering)
> were signed off and applied to `docs/contracts/02-store.md`, `03-agent.md`,
> and `09-vendo.md` as their 2026-07-16 amendment entries. This document is
> kept as the amendment's working record; "current text" below quotes the
> pre-amendment frozen text.

Shipped surface being described: TTL session registry + cascading eviction +
fail-closed unknown-app writes in `packages/store/src/ephemeral.ts` /
`records.ts` / `blobs.ts`, `VendoAgent.evictSubject` in `packages/agent`, and
`CreateVendoConfig.sessions` + sweep wiring in `packages/vendo/src/server.ts`.

## 02-store.md

### Item 1 — §4 Semantics, "Ephemeral principals" bullet: overlay lifetime and session registry

- **Current text:** "**Ephemeral principals** (`ephemeral: true`) never touch
  disk: their rows live in an adapter-level, per-process in-memory overlay
  that is dropped by `close()`. Multi-instance deployments therefore split
  anonymous-session state between processes. A real session lifecycle is
  Wave 4 scope and will amend this section again when designed."
- **Needed change:** Overlay lifetime becomes "`close()` OR session eviction
  (TTL idle sweep or cap overflow)". Registered ephemeral subjects form a TTL
  session registry: registration == touch (`registerEphemeralSubject` stamps
  `touchedAt`; every request that resolves the subject re-stamps it), a
  bounded LRU with a parametrizable cap (default 10 000, `EPHEMERAL_SUBJECT_CAP`).
  Remove the trailing "Wave 4 scope … when designed" sentence — this IS that
  amendment.
- **Why:** The shipped code evicts overlay data long before `close()`; the
  frozen text describes only the pre-wave-4 lifetime and explicitly reserved
  this amendment.

### Item 2 — §4 Semantics: idle sweep + inflight bracket (new prose)

- **Current text:** none (the semantics do not exist in the contract).
- **Needed change:** Contract `sweepEphemeralSubjects(store, { idleMs })`:
  evicts every registered subject with `inflight === 0` and
  `now - touchedAt >= idleMs`, returning the evicted subjects for caller-side
  cascade. `beginEphemeralRequest`/`endEphemeralRequest` bracket a request so
  a session is never swept mid-turn (streamed responses hold the bracket until
  the body settles). TTL policy is the caller's (the umbrella's `sessions`
  config); the store stays config-free. Ordering rule: the sweep runs before
  the request's touch (evict-on-expiry), so a request arriving past the TTL
  gets a fresh, empty session — consistent between timer-swept long-lived
  hosts and request-swept serverless hosts.
- **Why:** New store exports with normative concurrency semantics (inflight
  guard, evict-on-expiry) that blocks and hosts can observe.

### Item 3 — §4 Semantics: cascading eviction (new prose)

- **Current text:** none.
- **Needed change:** Contract `evictEphemeralSubject(store, subject)` as a
  synchronous cascade clearing every overlay map of exactly that subject's
  data (apps; state; threads; grants; approvals; audit; runs and app-scoped
  records/blobs via the owned app ids) with no awaits in between, so no
  concurrent request observes a half-evicted session. Cap overflow routes
  through the same cascade (the pre-wave-4 key-only drop — which orphaned
  overlay rows and let an over-cap subject's later writes persist — is gone).
  Memory-only by construction: a registered subject has zero on-disk rows, so
  eviction touches nothing durable.
- **Why:** Eviction atomicity and the cap-overflow cascade are load-bearing
  invariants (STORE-1/STORE-9); the contract must pin them before other blocks
  rely on them.

### Item 4 — §4 Semantics: fail-closed unknown-app routing (new prose)

- **Current text:** none (routing text implies app-scoped collections route by
  the owning app's ephemerality, boolean).
- **Needed change:** App-scoped (`app:<appId>:<name>`) record and blob targets
  resolve tri-state (`appEphemerality`): **ephemeral** (overlay app owned by a
  registered subject) → overlay; **durable** (real `vendo_apps` row) → disk;
  **unknown** (neither — the app never existed or its session was evicted) →
  WRITES fail closed with `not-found` ("session may have expired"), reads
  return empty. A write racing an eviction can therefore never orphan a
  durable row (the STORE-1 leak), structurally rather than by ordering care.
- **Why:** This is the disk-leak guarantee the wave was built around; without
  it the contract permits a silent post-eviction durable write.

### Item 5 — §4 Semantics, multi-instance constraint: lifecycle corollary

- **Current text:** "Multi-instance deployments therefore split
  anonymous-session state between processes." (inside the Item 1 bullet)
- **Needed change:** Keep the constraint and add its lifecycle corollary: the
  registry, TTL clock, and inflight refcounts are all per-process overlay
  state, so multi-instance hosts must pin anonymous traffic to one instance
  (sticky sessions) or accept independent per-instance sessions; eviction on
  one instance is invisible to another, and the fail-closed unknown-app rule
  is what a request landing on the wrong instance observes. Documented, not
  solved, in v0.
- **Why:** Wave 4 makes the existing constraint sharper (a session can now
  disappear mid-conversation on the instance that never saw the traffic);
  hosts need the failure mode named.

## 03-agent.md

### Item 6 — §1 surface: `VendoAgent.evictSubject` (interface listing)

- **Current text:** `export interface VendoAgent { stream(...); threads {
  get/list/delete }; asRunner(): AgentRunner; }` — no eviction member.
- **Needed change:** Add `evictSubject(subject: string): void` to the
  `VendoAgent` interface: drops the subject's in-memory (no-store/BYO
  composition) threads when its ephemeral session is evicted. The umbrella
  calls it for every subject the store's idle sweep returns. Store-backed
  ephemeral threads live in the store overlay (02 §4) and are cascaded there,
  making this a no-op in the composed default.
- **Why:** AGENT-11 — a public interface member shipped on a FROZEN (major-
  gated) surface; the contract text must list it.

### Item 7 — §5 threads prose: eviction cross-reference

- **Current text:** "Threads belong to a principal; `threads.*` never crosses
  subjects. Ephemeral principals' threads live in the store's per-process
  in-memory overlay (02 §4) — not a separate agent-owned map — so
  anon→signed-in migration (02 §4) can move them to the real subject through
  one seam."
- **Needed change:** Append the eviction leg: when a session is evicted
  (02 §4 idle sweep / cap overflow), store-overlay threads go with the store
  cascade, and the umbrella additionally calls `evictSubject` so a no-store
  agent's in-memory threads are dropped in the same pass — no composition
  leaks threads past session eviction.
- **Why:** The frozen prose covers the migration path of ephemeral threads
  but not their end of life; wave 4 defines it.

## 09-vendo.md

(The task scopes 02/03; these two are included because
`CreateVendoConfig.sessions` text lives here — same approval gate.)

### Item 8 — §2 `createVendo` config listing: `sessions` knob

- **Current text:** config listing ends `mcp?: boolean; oauth?: HostOAuthAdapter;`
  — no `sessions` member.
- **Needed change:** Add
  `sessions?: { ttlMs?: number; sweepIntervalMs?: number; maxSessions?: number }`
  (plus the internal test-only `now` seam) with validated defaults: `ttlMs`
  30 min (`0` disables TTL eviction, cap-only), `sweepIntervalMs` 60 s,
  `maxSessions` 10 000. Invalid values throw `VendoError("validation")` at
  compose time. Follow the existing amended-comment convention used for
  `mcp?`/`oauth?`.
- **Why:** A shipped public config surface on the umbrella; the four defaults
  are the RECOMMENDATION items Yousef gates.

### Item 9 — §2 wiring prose: sweep orchestration

- **Current text:** the "Wiring (normative)" paragraph covers tool binding and
  handler adaptation only.
- **Needed change:** Add lifecycle wiring: the umbrella touches the session on
  every ephemeral-principal request, brackets the request (including streamed
  bodies) against the store's inflight refcount, runs an amortized on-request
  sweep plus an unref'd background timer every `sweepIntervalMs` (torn down
  with `store.close()`), and cascades every swept subject into
  `agent.evictSubject`. Store-first ordering is normative: a concurrent
  request fails closed at the store rather than finding agent threads without
  store state.
- **Why:** The umbrella is the only component that sees both store and agent;
  the cascade ordering is a cross-block invariant that belongs in the
  composition contract.
