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
| `vendo_orgs` | `id, name, created_at` | organizations (ENG-263, additive — real `kind:"org"` principals, 01 §2; key-gated activation) |
| `vendo_org_members` | `org_id, subject, role, created_at` | org membership, roles `owner`/`admin`/`member` — members run, admins approve and manage (ENG-263, additive) |

The two org tables ship with ENG-263 (block-actions spec §C); key-column names above are confirmed against that implementation before this amendment merges.

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
- **Ephemeral principals** (`ephemeral: true`) never touch disk: their rows live in an adapter-level, per-process in-memory overlay that is dropped by `close()`. Multi-instance deployments therefore split anonymous-session state between processes. A real session lifecycle is Wave 4 scope and will amend this section again when designed.
- **Anonymous→signed-in migration** (ENG-263, block-actions spec §C — ships with that PR): the first authenticated request carrying a valid anon cookie migrates the anonymous principal's **threads, apps, and state** to the real subject, clears the cookie, and is idempotent. **Grants and approvals deliberately do NOT migrate** — consent doesn't transfer identities; users re-approve. Connected accounts (04 §3.1) are consent-like and do not migrate either — users reconnect. This is the designed session lifecycle the previous bullet reserved.

## 5. Retention and erasure

A store-level erase API is contracted here and ships in Wave 3. It erases by subject (full erasure), by app, or by age, cascading the matching data across all 13 tables, and is exposed on the umbrella. It is the only sanctioned deletion path for audit rows. Policy engines and schedulers remain out of scope; host SQL remains available for everything else.

## Amendments

### 2026-07-15 — Org tables and anonymous migration (ENG-263, parent ENG-264)

- **Changed:** Added `vendo_orgs` + `vendo_org_members` to the public table map (roles owner/admin/member) — the Vendo-owned home of real org principals; activation key-gated (01 §2, 04 §5).
- **Changed:** Contracted the anonymous→signed-in migration semantics in §4: threads/apps/state migrate on first authenticated request with a valid anon cookie, idempotent, cookie cleared; grants, approvals, and connected accounts never migrate.
- **Why:** The block-actions spec locks full org semantics in Vendo-owned tables and closes the silent loss of anonymous work on sign-in. **Ships with ENG-263 — merge of this amendment waits for that PR; key columns confirmed against the implementation at land time.**
- **Authorized by:** the Yousef-approved block-actions design spec (`docs/superpowers/specs/2026-07-14-block-actions-design.md`).

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
