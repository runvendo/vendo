# @vendoai/store — persistence under everything

Status: DRAFT (wave 2). One job: implement core's `StoreAdapter` on Postgres. Stay boring: Postgres-only, PGlite zero-config default, same schema on real Postgres in prod. One adapter, no matrix. Depends on core + drivers (`pg`, `@electric-sql/pglite`).

## 1. Public API

```ts
import type { StoreAdapter, SecretsProvider } from "@vendoai/core";

export function createStore(config?: {
  /** Postgres connection string. Omitted → PGlite at `dataDir`. */
  url?: string;
  /** PGlite directory; default ".vendo/data". Ignored when url is set. */
  dataDir?: string;
  /** At-rest encryption for app data + secrets. Omitted → plaintext (documented, not a silent default). */
  encryption?: { key: string };            // 32-byte key, base64; AES-256-GCM
  /** Audit retention: prune vendo_audit rows older than N days on ensureSchema()/maintenance(). Default: keep forever. */
  auditRetentionDays?: number;
}): VendoStore;

export interface VendoStore extends StoreAdapter {
  ensureSchema(): Promise<void>;   // idempotent migration to this version's schema (vendo_meta.schema_version)
  maintenance(): Promise<void>;    // retention pruning, vacuum-adjacent housekeeping
  close(): Promise<void>;
  raw(): unknown;                  // the underlying pg/PGlite client — host escape hatch, not covered by semver
}

/** Secrets providers (core seam). */
export function envSecrets(prefix?: string): SecretsProvider;                       // default: process.env
export function storeSecrets(store: VendoStore): SecretsProvider;                  // encrypted vendo_secrets table
```

## 2. The table map (public contract)

The page makes this public: "everything lives in the host's own DB under a `vendo_` prefix → host can query/join/back up their users' apps like any other tables." Table names and the columns below are contract; additional columns may appear within the version train. All JSON is `jsonb`.

| Table | Key columns (stable) | Holds |
| --- | --- | --- |
| `vendo_meta` | `key, value` | schema version, boot id |
| `vendo_apps` | `id, tenant_id, owner_subject, doc, created_at, updated_at` | app documents (core §9), one row per app |
| `vendo_installs` | `id, app_id, tenant_id, subject, source, enabled, installed_at` | install records (core §10) |
| `vendo_records` | `collection, id, tenant_id, data, refs, created_at, updated_at` | app data collections; `refs` GIN-indexed for host joins |
| `vendo_blobs` | `namespace, key, bytes, content_type, created_at` | `files` storage kind, exports, screenshots |
| `vendo_state` | `install_id, subject, data, updated_at` | the built-in per-user-per-app `state` singleton |
| `vendo_threads` | `id, tenant_id, subject, messages, created_at, updated_at` | conversation threads (03 §5) |
| `vendo_grants` | `id, tenant_id, subject, tool, descriptor_hash, scope, duration, install_id, source, granted_at, revoked_at, expires_at` | permission grants (core §5) |
| `vendo_approvals` | `id, tenant_id, subject, request, status, decided_at, created_at` | approval queue (05 §4) |
| `vendo_audit` | `id, at, kind, tenant_id, subject, venue, presence, install_id, tool, event` | append-only audit log (core §7) |
| `vendo_runs` | `id, install_id, tenant_id, trigger, status, record, started_at, finished_at` | automation run records (07 §5) |
| `vendo_secrets` | `name, tenant_id, ciphertext, created_at` | optional encrypted secret values (`storeSecrets`) |

Host-entity refs are the join surface: `SELECT ... FROM invoices i JOIN vendo_records r ON r.refs->>'invoice_id' = i.id`.

## 3. Collection naming convention

The adapter treats collection names as opaque. Callers compose them; the convention (contract, so hosts can query):

- App storage collections: `app:<installId>:<name>` (e.g. `app:ins_9f2:notes`)
- Block-owned collections use the block name: guard, automations, agent persist through the same adapter using the dedicated tables above — `records()` is for app data; the dedicated tables are reached through block-specific store APIs internal to this package (exported for blocks, not documented for hosts beyond the table map).

⚑ Blocks reach their dedicated tables through typed helpers this package exports (`grantStore(store)`, `auditStore(store)`, `approvalStore(store)`, `threadStore(store)`, `runStore(store)`, `appStore(store)`, `installStore(store)`, `stateStore(store)`) — each a thin CRUD/query surface over one table, all speaking core types. These helpers are the real persistence API the other blocks consume; `records()`/`blobs()` serve app data. Full signatures mirror core types 1:1 (create/get/list/query/revoke-style verbs, no surprises).

## 4. Semantics

- **PGlite default**: no `url` → embedded Postgres at `.vendo/data`; kill-the-server durability applies (fsync on write).
- **Same schema everywhere**: one DDL, no dialect switches. `ensureSchema()` is the only migration entry point, keyed by `vendo_meta.schema_version`, forward-only within the version train.
- **Encryption at rest**: when `encryption.key` is set, `vendo_records.data`, `vendo_state.data`, and `vendo_secrets.ciphertext` are AES-256-GCM encrypted. `refs` stay plaintext (they exist to be joined). Key rotation: out of v0 scope, flagged.
- **Tenancy**: every row carries `tenant_id`; single-tenant hosts never see it (default "default").
- **Ephemeral principals** (`ephemeral: true`) never touch disk: adapter-level in-memory overlay for their rows, dropped at session end.
- **Retention**: per-org retention policies are Cloud; OSS gets `auditRetentionDays` only.
