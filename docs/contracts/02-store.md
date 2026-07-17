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
| `vendo_sessions` | `subject, touched_at` | ephemeral (anonymous) session registry (§4): one row per live session, `touched_at` = last activity; read by the TTL sweep |

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
- **Atomic revisions**: ordinary `vendo_records` collections expose the optional `RecordStore.atomic` capability. `insertIfAbsent` uses one `INSERT ... ON CONFLICT DO NOTHING RETURNING` statement; `compareAndSwap` matches the opaque `revision`, increments it, and returns the replacement from one `UPDATE ... RETURNING` statement. PGlite and hosted Postgres share those semantics. Reserved typed-table routes may omit this capability.
- **Encryption at rest**: `encryption.key` encrypts `vendo_secrets.ciphertext` only (AES-256-GCM). App data stays plaintext by design — encrypting it would defeat the page's host-can-query/join promise; at-rest encryption of the database is the host's disk/DB layer. Default-on composition is contracted here and ships in Wave 3: `vendo init` provisions `VENDO_STORE_ENCRYPTION_KEY` in `.env`, `createVendo` reads it from the environment, and AES-GCM binds ciphertext to the secret name as AAD with envelope versioning. Key rotation: out of v0 scope.
- **No tenant axis**: `subject` is the one partition key — the host's stable user id. Multi-tenant hosts scope the same way they scope their own tables: by joining through `subject` and refs.
- **Ephemeral sessions** (kill-list B3): ephemeral principals (`ephemeral: true`) write ORDINARY disk rows under their subject — there is no in-memory overlay, no dual routing, and no per-process session state. What makes a session ephemeral is its registration in `vendo_sessions`; what ends it is the TTL sweep below or adoption on sign-in. Registration is the CALLER's job: `registerEphemeralSubject(store, subject, now?)` upserts the touch row (registration == touch), and the umbrella calls it on every ephemeral-principal request — reads included — so idle time is measured from the last request. Data written for an ephemeral subject that is never registered behaves like durable data (nothing sweeps it); the erase API (§5) remains the cleanup path for such compositions. Because the registry is a table in the same database, sessions survive restarts and are shared across instances — the per-process/sticky-session constraint of the retired overlay is gone.
- **TTL sweep**: `sweepEphemeralSubjects(store, { idleMs, now? })` (async) erases every registered session with `now - touched_at >= idleMs` through the §5 erase cascade — apps, records, blobs, state, threads, grants, approvals, audit, runs, and the `vendo_sessions` row itself — and returns the swept subjects for caller-side cascade (the umbrella forwards them to `agent.evictSubject`, 03 §1). TTL policy is the caller's (the umbrella's `sessions` config); the store stays config-free. The umbrella runs the sweep before the request's touch (evict-on-expiry), so a request arriving past the TTL gets a fresh, empty session. A request whose turn outlives the TTL may be swept mid-turn; its final writes recreate rows under the still-registered-or-re-registered subject and the next sweep collects them — nothing is orphaned (see fail-closed routing below). The overlay-era inflight bracket (`beginEphemeralRequest`/`endEphemeralRequest`), LRU cap (`sessions.maxSessions` / `setSessionCap`), and injected store clock (`setSessionClock`) are retired; the sweep and register calls take `now` as an argument instead.
- **Fail-closed unknown-app routing** (STORE-1): app-scoped (`app:<appId>:<name>`) record and blob WRITES require an existing `vendo_apps` row and fail closed with `not-found` ("session may have expired") when there is none — the app never existed, or its session was swept and the cascade deleted it. Reads on a missing app return empty (a stale client sees an expired session, not an error storm). A write racing a sweep can therefore never recreate app data the cascade cannot reach again; the no-orphan guarantee is structural, not ordering care.
- **Anonymous→signed-in migration** (block-actions spec §C): the first authenticated request carrying a valid anon cookie adopts the anonymous principal's **threads, apps (with their app-scoped record/blob collections, which travel with app ownership), and state** to the real subject (`adoptEphemeralSubject`), clears the cookie, and is idempotent (an unregistered `from` subject returns null). **Grants and approvals deliberately do NOT migrate** — consent doesn't transfer identities; users re-approve — and audit plus run history stay records of what the anonymous principal did: all four are deleted with the session. A state row colliding with one the signed-in subject already owns is skipped, never overwritten. Connected accounts (04 §3.1) are consent-like and do not migrate either — users reconnect.

## 5. Retention and erasure

A store-level erase API is contracted here and ships in Wave 3. It erases by subject (full erasure) or by app, cascading the matching data across all 14 tables, and is exposed on the umbrella. It is the only sanctioned deletion path for audit rows. The ephemeral TTL sweep (§4) is built on the by-subject cascade. Policy engines and schedulers remain out of scope; host SQL remains available for everything else.

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

### 2026-07-17 — Cut orgs-in-OSS (kill-list §A5)

- **Changed:** Removed `vendo_orgs` and `vendo_org_members` from the §2 table map (the ENG-263 rows) and their indexes; the §5 erase-cascade count reverts from 15 to 13 tables, and the org-specific erase-by-subject carve-outs (subject's org memberships; erasing an org subject drops the org) are gone with them. `SCHEMA_VERSION` stays at 3 — the DDL list is idempotent and additive-only, so dropping two `CREATE TABLE` statements needs no version bump; pre-existing dev databases keep the two tables as unused orphans, which this change does not attempt to clean up.
- **Changed:** Removed `orgStore`, `ORG_ROLES`, `OrgRole`, `OrgRow`, `OrgMemberRow` (`helpers/orgs.ts`), `transferAppSubject` (`helpers/subjects.ts` — its only non-test caller was the now-removed `vendo/src/orgs.ts`), and `withOrgMembershipLock`/`lockKeyForId` (`db.ts`) from the package's exports and implementation.
- **Why:** Orgs are Vendo-hosted, not an OSS storage concern (vendo-web console already owns members/roles/invites/keys/usage); the org data layer was built on the superseded doctrine that OSS should carry it.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A5).

### 2026-07-17 — Cut age-based erase (kill-list §A6)

- **Changed:** Removed `byAge(olderThan)` from the store-level erase API (§5). `eraseStore(store)` now exposes only `bySubject(subject)` and `byApp(appId)`; §5's prose no longer describes a retention sweep. `bySubject` and `byApp` are unchanged.
- **Why:** No shipped host called `byAge` — the contract already scopes retention policy and scheduling out of the store (§5: "policy engines and schedulers remain out of scope"), so the sweep was ~50 lines of erase-cascade logic (`GREATEST`/`COALESCE` lifecycle math across 11 tables, plus the overlay mirror) serving a feature no host uses. A host that needs age-based retention still has host SQL available, per §5's existing escape hatch.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A6).

### 2026-07-17 — Cut crypto v1 legacy decrypt and base64 canonicality check (kill-list §A7)

- **Changed:** `decryptSecret` (§4) no longer accepts the `v1` (no-AAD) envelope — only `v2` decrypts; an envelope tagged `v1` (or any tag other than `v2`) now fails with the same generic "Stored secret could not be decrypted" error as any other malformed envelope. `validateEncryptionKey` no longer round-trips the decoded key back through base64 to check canonical encoding; it validates the base64 character set and the decoded byte length (32) only.
- **Why:** v2 was the only envelope this OSS line ever shipped rows in — no v1 rows exist to decrypt, so the legacy branch was dead code carried "just in case" of a migration that never happened. The base64 canonicality round-trip protected against a non-canonical-but-valid-length encoding decoding to the "wrong" 32 bytes depending on stray padding bits — a theoretical concern with no product surface that constructs keys that way (`vendo init` writes canonical `randomBytes(32).toString("base64")`); the byte-length check is the guarantee that actually matters for AES-256-GCM.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A7).

### 2026-07-17 — Ephemeral overlay → disk rows + TTL sweep (kill-list §B3)

- **Changed:** Retired the adapter-level in-memory ephemeral overlay entirely. Ephemeral principals now write ordinary disk rows under their subject; §4's ephemeral bullets are rewritten to the disk model: a `vendo_sessions` registry table (new §2 row: `subject, touched_at`; `SCHEMA_VERSION` 3→4), caller-driven registration (`registerEphemeralSubject(store, subject, now?)`, now async — registration == touch, the umbrella touches per request), and an async TTL sweep (`sweepEphemeralSubjects(store, { idleMs, now? })`) that erases idle sessions through the §5 by-subject cascade and returns the swept subjects. The §5 cascade count grows 13→14 (`vendo_sessions` included). Sessions now survive restarts and are shared across instances — the ENG-237 "per-process registry, sticky sessions, documented not solved" constraint is resolved, not documented.
- **Changed:** Removed the overlay-only API and semantics: `beginEphemeralRequest`/`endEphemeralRequest` (inflight bracket), `evictEphemeralSubject` (synchronous cascade — erase/sweep replace it), `setSessionClock`/`setSessionCap`/`EPHEMERAL_SUBJECT_CAP` (LRU cap; the umbrella's `sessions.maxSessions` knob is retired with it, 09 §2), and `ephemeralOverlaySizes`. Fail-closed unknown-app routing survives as a plain `vendo_apps` existence check on app-scoped writes (tri-state `appEphemerality` collapses to known/unknown). Cross-subject flip refusals and audit append-only now flow through the single guarded-SQL door for ephemeral and durable subjects alike.
- **Changed:** `adoptEphemeralSubject` is rewritten on disk: apps/threads flip their `subject` column (ids are door-guarded PRIMARY KEYs, so nothing can be stolen), state moves with a collision skip, app-scoped records/blobs travel with app ownership untouched, and the dropped categories (grants, approvals, audit, runs of the adopted apps) are deleted with the session registration.
- **Why:** The overlay was ~850 lines of dual memory/disk routing, TTL/LRU registry, inflight brackets, and mirror loops in every store door — all to keep anonymous rows off disk in a database the host already owns. Disk rows + one sweep preserve the product behavior (anonymous create/read, TTL expiry, adopt-on-sign-in, fail-closed stale writes, erase coverage) with one code path.
- **Authorized by:** the Yousef-approved kill-list spec (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §B3).
