# @vendoai/store — persistence under everything

Status: FROZEN (wave-2 gate passed by Yousef, 2026-07-11). Changes now require a major. One job: implement core's `StoreAdapter` on Postgres. Stay boring: Postgres-only, PGlite zero-config default, same schema on real Postgres in prod. One adapter, no matrix. Depends on core + drivers (`pg`, `@electric-sql/pglite`).

## 1. Public API

```ts
import type { StoreAdapter, SecretsProvider } from "@vendoai/core";

export function createStore(config?: {
  /** Postgres connection string. Omitted → PGlite at `dataDir`. */
  url?: string;
  /** PGlite directory; default ".vendo/data". Ignored when url is set. */
  dataDir?: string;
  /** At-rest encryption for stored secret values (vendo_secrets). Omitted → stored-secret reads/writes unavailable. */
  encryption?: { key: string };            // 32-byte key, base64; AES-256-GCM
}): VendoStore;

export interface VendoStore extends StoreAdapter {
  ensureSchema(): Promise<void>;   // idempotent migration to this version's schema (vendo_meta.schema_version)
  close(): Promise<void>;
  raw(): unknown;                  // the underlying pg/PGlite client — host escape hatch, not covered by semver
}

/** Secrets providers (core seam). */
export function envSecrets(prefix?: string): SecretsProvider;                       // default: process.env
export function storeSecrets(store: VendoStore): SecretsProvider;                  // encrypted vendo_secrets table

/** The sanctioned write path for encrypted stored secrets. */
export function secretStore(store: VendoStore): {
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
};
```

## 2. The table map (public contract)

The page makes this public: "everything lives in the host's own DB under a `vendo_` prefix → host can query/join/back up their users' apps like any other tables." Table names and the columns below are contract; additional columns may appear within the version train. All JSON is `jsonb`.

| Table | Key columns (stable) | Holds |
| --- | --- | --- |
| `vendo_meta` | `key, value` | schema version, boot id |
| `vendo_apps` | `id, subject, enabled, doc, trigger_kind, created_at, updated_at` | each user's app: document (core §9) + ownership (core §10) — no installs table; the app row IS the user's copy |
| `vendo_records` | `collection, id, data, refs, created_at, updated_at, revision` | app data collections; `refs` GIN-indexed for host joins; `revision` backs optional atomic writes |
| `vendo_blobs` | `namespace, key, bytes, content_type, created_at` | `files` storage kind, exports, screenshots |
| `vendo_state` | `app_id, subject, data, updated_at` | the built-in per-user-per-app `state` singleton |
| `vendo_threads` | `id, subject, messages, created_at, updated_at` | conversation threads (03 §5) |
| `vendo_grants` | `id, subject, tool, descriptor_hash, scope, duration, context_key, app_id, source, granted_at, revoked_at, expires_at` | permission grants (core §5) |
| `vendo_approvals` | `id, subject, request, status, decided_at, created_at` | approval queue (05 §1) |
| `vendo_audit` | `id, at, kind, subject, venue, presence, app_id, tool, event` | append-only audit log (core §7): routing rejects `put` for an existing id and refuses `delete`; contracted here, enforced in Wave 3; erasure is only through the store erase API (§5) |
| `vendo_runs` | `id, app_id, trigger, status, record, started_at, finished_at` | automation run records (07 §5) |
| `vendo_secrets` | `name, ciphertext, created_at` | optional encrypted secret values (`storeSecrets`) |
| `vendo_mcp_clients` | `id, data, refs, created_at, updated_at` | MCP client state (wave 6, additive — door-owned, shapes block-internal to `@vendoai/mcp`) |
| `vendo_mcp_grants` | `id, data, refs, created_at, updated_at` | MCP grant state (wave 6, additive — door-owned, shapes block-internal to `@vendoai/mcp`) |
| `vendo_orgs` | `id, name, created_at, updated_at` | orgs (v3, ENG-263): Vendo-owned org rows; the org's subject is `vendo:org:<id>` (01-core §2) |
| `vendo_org_members` | `org_id, subject, role, added_at` | org membership (v3, ENG-263): roles `owner`/`admin`/`member`; the store enforces role validity and never orphans an org of its last owner |

The two org tables — `vendo_orgs` (organizations, real `kind:"org"` principals, 01 §2) and `vendo_org_members` (membership, roles `owner`/`admin`/`member` — members run, admins approve and manage) — are added to the map by the ENG-263 implementation (PR #277) together with their key columns and the erase-cascade coverage the map is conformance-tested against (§5). This PR carries the surrounding prose only; PR #277 owns the map rows and the §5 count so the conformance test and the doc land atomically.

Host-entity refs are the join surface: `SELECT ... FROM invoices i JOIN vendo_records r ON r.refs @> jsonb_build_object('invoice_id', i.id)` (containment, so the GIN index is actually used).

## 3. Collection naming convention

Reserved-collection routing is THE sanctioned cross-block persistence seam. Blocks persist through core's `StoreAdapter.records()` / `blobs()` interface; dedicated block rows use reserved `vendo_*` collection names with `records()`, and the store routing layer maps them to the dedicated tables in §2. The reserved routing list mirrors `RESERVED_COLLECTIONS` in `packages/store/src/routing.ts`:

- `vendo_grants`
- `vendo_approvals`
- `vendo_audit`
- `vendo_threads`
- `vendo_runs`
- `vendo_apps`
- `vendo_state`

The door-owned `vendo_mcp_clients` and `vendo_mcp_grants` collections likewise route to their dedicated tables, with door-internal JSON shapes. The old typed-helper architecture is retired; reserved routing is the block seam.

The `vendo_apps` route synthesizes `subject` and the optional `trigger_kind` derived from `doc.trigger.on.kind` as filterable refs.

Reserved routes are a trusted-backend boundary, not an authorization gate: the store validates routed shapes, then trusts the caller. App and sandbox code must never receive a `StoreAdapter`; the umbrella gives it only to trusted blocks, including the door, and guard remains the authorization boundary.

For non-reserved names, `records()` remains app data and collection names are otherwise opaque. The app-data convention (contract, so hosts can query) is:

- App storage collections: `app:<appId>:<name>` (e.g. `app:app_9f2:notes`)

## 4. Semantics

- **PGlite default**: no `url` → embedded Postgres at `.vendo/data`; kill-the-server durability applies (fsync on write).
- **Same schema everywhere**: one DDL, no dialect switches. `ensureSchema()` is the only migration entry point, keyed by `vendo_meta.schema_version`, forward-only within the version train.
- **Atomic claims**: generic and door-owned record tables implement core's optional `RecordStore.claim` as one `UPDATE ... WHERE data/refs match RETURNING` or `DELETE ... RETURNING` statement. Consumers that require single-use state fail closed when an alternate adapter omits the capability.
- **Atomic revisions**: ordinary `vendo_records` collections expose the optional `RecordStore.atomic` capability. `insertIfAbsent` uses one `INSERT ... ON CONFLICT DO NOTHING RETURNING` statement; `compareAndSwap` matches the opaque `revision`, increments it, and returns the replacement from one `UPDATE ... RETURNING` statement. PGlite, hosted Postgres, and the ephemeral overlay share those semantics. Reserved typed-table routes may omit this capability.
- **Encryption at rest**: `encryption.key` encrypts `vendo_secrets.ciphertext` only (AES-256-GCM). App data stays plaintext by design — encrypting it would defeat the page's host-can-query/join promise; at-rest encryption of the database is the host's disk/DB layer. Default-on composition is contracted here and ships in Wave 3: `vendo init` provisions `VENDO_STORE_ENCRYPTION_KEY` in `.env`, `createVendo` reads it from the environment, and AES-GCM binds ciphertext to the secret name as AAD with envelope versioning. Key rotation: out of v0 scope.
- **No tenant axis**: `subject` is the one partition key — the host's stable user id. Multi-tenant hosts scope the same way they scope their own tables: by joining through `subject` and refs.
- **Ephemeral principals** (`ephemeral: true`) never touch disk: their rows live in an adapter-level, per-process in-memory overlay whose lifetime is `close()` OR session eviction (TTL idle sweep or cap overflow — ENG-237). Registered ephemeral subjects form a TTL session registry: registration == touch (`registerEphemeralSubject` stamps `touchedAt`; every request that resolves the subject re-stamps it), bounded LRU with a parametrizable cap (default 10 000, `EPHEMERAL_SUBJECT_CAP`; `setSessionCap` sets the default the overlay enforces — the umbrella wires `sessions.maxSessions` there, 09 §2). The registry, TTL clock, and inflight refcounts are all per-process overlay state, so multi-instance hosts must pin anonymous traffic to one instance (sticky sessions) or accept independent per-instance sessions; eviction on one instance is invisible to another, and the fail-closed unknown-app rule below is what a request landing on the wrong instance observes. Documented, not solved, in v0.
- **Idle sweep and inflight bracket** (ENG-237): `sweepEphemeralSubjects(store, { idleMs })` evicts every registered subject with `inflight === 0` and `now - touchedAt >= idleMs`, returning the evicted subjects for caller-side cascade (the umbrella forwards them to `agent.evictSubject`, 03 §1). `beginEphemeralRequest`/`endEphemeralRequest` bracket a request so a session is never swept mid-turn — streamed responses hold the bracket until the body settles. TTL policy is the caller's (the umbrella's `sessions` config); the store stays config-free. Ordering rule: the sweep runs before the request's touch (evict-on-expiry), so a request arriving past the TTL gets a fresh, empty session — consistent between timer-swept long-lived hosts and request-swept serverless hosts.
- **Cascading eviction** (ENG-237): `evictEphemeralSubject(store, subject)` synchronously clears every overlay map of exactly that subject's data — apps; state; threads; grants; approvals; audit; runs and app-scoped records/blobs via the owned app ids — with no awaits in between, so no concurrent request observes a half-evicted session. Cap overflow routes through the same cascade (never a key-only drop) and never evicts an inflight subject: the registry temporarily exceeds the cap instead. Memory-only by construction: while a subject is registered none of its writes reach disk, so an evicted session has zero on-disk rows and eviction touches nothing durable.
- **Fail-closed unknown-app routing** (ENG-237, STORE-1): app-scoped (`app:<appId>:<name>`) record and blob targets resolve tri-state (`appEphemerality`) — **ephemeral** (overlay app owned by a registered subject) routes to the overlay; **durable** (real `vendo_apps` row) routes to disk; **unknown** (neither — the app never existed or its ephemeral session was evicted) fails WRITES closed with `not-found` ("session may have expired") while reads return empty. A write racing an eviction can therefore never orphan a durable row; the disk-leak guarantee is structural, not ordering care.
- **Anonymous→signed-in migration** (ENG-263, block-actions spec §C — ships with that PR): the first authenticated request carrying a valid anon cookie migrates the anonymous principal's **threads, apps, and state** to the real subject, clears the cookie, and is idempotent. **Grants and approvals deliberately do NOT migrate** — consent doesn't transfer identities; users re-approve. Connected accounts (04 §3.1) are consent-like and do not migrate either — users reconnect. Together with the TTL eviction lifecycle above (ENG-237), this is the designed session lifecycle the ephemeral bullet originally reserved.

## 5. Retention and erasure

A store-level erase API is contracted here and ships in Wave 3. It erases by subject (full erasure), by app, or by age, cascading the matching data across all 15 tables, and is exposed on the umbrella. (Erase-by-subject removes the subject's org memberships; erasing an org subject removes the org and all its memberships. Full erasure wins over the last-owner storage invariant — an erased owner may leave an org ownerless.) It is the only sanctioned deletion path for audit rows. Policy engines and schedulers remain out of scope; host SQL remains available for everything else.

## Amendments

### 2026-07-14 — Routed block persistence, erasure, and secure composition

- **Changed:** Retired the typed-helper architecture and made reserved-collection routing through core's `StoreAdapter` the sanctioned cross-block persistence seam, including its trusted-backend boundary.
- **Changed:** Contracted append-only `vendo_audit` routing for Wave 3 and made the erase API its only deletion path.
- **Changed:** Added `secretStore` as the sanctioned secret-write surface and restored `vendo_grants.context_key` to the public table map.
- **Changed:** Contracted the by-subject / by-app / by-age erase API and its 13-table cascade for Wave 3, exposed through the umbrella.
- **Changed:** Contracted default-on encryption composition, secret-name AAD, and envelope versioning for Wave 3.
- **Changed:** Corrected ephemeral-overlay lifetime to `close()` and recorded the per-process multi-instance constraint; full session lifecycle design remains Wave 4 work.
- **Why:** The shipped routing and secret surfaces had overtaken the frozen typed-helper text, while retention, audit deletion, encryption defaults, and anonymous-session lifetime needed the approved foundations contracts before later implementation waves.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-14 — Atomic record claims

- **Changed:** Added the optional `RecordStore.claim` capability and required the concrete Postgres store to implement compare-and-replace or compare-and-delete in one statement for generic and door-owned record tables.
- **Why:** Authorization codes and refresh-token rotation need database-level single-use guarantees across non-sticky multi-instance MCP deployments.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-14 — Atomic record revisions

- **Changed:** Added opaque `VendoRecord.revision` tokens and optional `RecordStore.atomic.insertIfAbsent` / `compareAndSwap` operations for ordinary record collections.
- **Why:** Multi-instance automation schedulers need database-level first-writer and cursor-advance exclusion while third-party adapters retain the prior single-instance fallback.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-14 — Additive app trigger ref

- **Changed:** Added the optional derived `trigger_kind` ref to `vendo_apps`, matching the ENG-254 routed-store index used by automations tick and emit queries.
- **Approved by:** Yousef, 2026-07-14.

### 2026-07-15 — Org tables and anonymous migration (ENG-263, parent ENG-264)

- **Changed:** Described `vendo_orgs` + `vendo_org_members` (roles owner/admin/member) — the Vendo-owned home of real org principals; activation key-gated (01 §2, 04 §5). The actual §2 map rows (`vendo_orgs`: id, name, created_at, updated_at; `vendo_org_members`: org_id, subject, role, added_at, PK(org_id,subject), idx subject), the §5 count (13→15), and the erase-cascade coverage are added by PR #277 (ENG-263) so the doc and the conformance test land atomically. Erase rule (PR #277): erase-by-subject drops that subject's memberships; erasing `vendo:org:<id>` drops the org row plus all its members; full subject erasure overrides the last-owner invariant. Schema version advances to 3.
- **Changed:** Contracted the anonymous→signed-in migration semantics in §4: threads/apps/state migrate on first authenticated request with a valid anon cookie, idempotent, cookie cleared; grants, approvals, and connected accounts never migrate (users reconnect).
- **Why:** The block-actions spec locks full org semantics in Vendo-owned tables and closes the silent loss of anonymous work on sign-in. **This PR carries prose; the §2 rows + §5 count ship in PR #277. Land the two coherently — whichever merges second rebases.**
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

### 2026-07-16 — Ephemeral session lifecycle (ENG-237, wave 4)

- **Changed:** §4 ephemeral-overlay lifetime becomes `close()` OR session eviction; registered subjects form a TTL session registry (registration == touch, bounded LRU, parametrizable cap via `setSessionCap` wired from the umbrella's `sessions.maxSessions`), and the multi-instance constraint gains its lifecycle corollary (per-process registry/clock/refcounts; sticky routing or independent sessions; documented, not solved, in v0).
- **Changed:** §4 contracts the idle sweep (`sweepEphemeralSubjects` — idle + not-inflight only, returns evicted subjects for the umbrella's store→agent cascade), the request inflight bracket (`beginEphemeralRequest`/`endEphemeralRequest`, held until streamed bodies settle), and the evict-on-expiry ordering rule (sweep before touch, consistent across timer-swept and request-swept hosts).
- **Changed:** §4 contracts synchronous cascading eviction (`evictEphemeralSubject` clears every overlay map for exactly one subject, no awaits; cap overflow cascades and never evicts an inflight subject) and fail-closed unknown-app routing (`appEphemerality` tri-state: unknown-app writes throw `not-found`, reads return empty — the structural STORE-1 no-leak guarantee).
- **Why:** Wave 4 (PR #301) shipped the session lifecycle this section reserved; the frozen text still described the pre-lifecycle overlay. Defaults approved with the amendment: 30 min TTL, 60 s sweep interval, 10 000 session cap, evict-on-expiry ordering.
- **Approved by:** Yousef, 2026-07-16 (inventory: `docs/superpowers/specs/2026-07-16-wave4-contract-amendment-inventory.md`).
