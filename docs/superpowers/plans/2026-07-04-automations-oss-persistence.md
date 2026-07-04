# Automations OSS Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every embedded persistence surface durable (automations, decisions, threads, saved flowlets, connections) on one Postgres-dialect database (PGlite default, `DATABASE_URL` for hosted), make schedules fire without a client, and give Composio triggers a signature-verified OSS webhook path.

**Architecture:** New `@flowlet/store` package owns the Drizzle Postgres schema + boot migrations + durable seam implementations. `@flowlet/runtime` gains small additive seam methods (rehydration listing, atomic approval claim, checkpoint versioning, ThreadStore interface). `@flowlet/next` wires storage config, full-tail routing, tick service auth, the Composio webhook, thread persistence, `/flowlets` endpoints, and a `startFlowletScheduler()` boot entry consumed from `instrumentation.ts` (added by the CLI codemod).

**Tech Stack:** Drizzle ORM (`drizzle-orm`, `drizzle-kit`), `@electric-sql/pglite`, `pg` (node-postgres), Vitest, Next 16 App Router, croner (existing).

**Reference spec:** `docs/superpowers/specs/2026-07-04-automations-oss-persistence-design.md` (v2). The semantic reference for the store port is `packages/flowlet-runtime/src/automations/store.ts` (`InMemoryAutomationStore`) and its test suite.

**Working rules for every task:** TDD (write the failing test first, watch it fail, implement, watch it pass), commit after each task, `pnpm typecheck` before each commit. Never touch `packages/flowlet-runtime/test/dependency-guard*` allowlists except where a task explicitly says so. The `flowlet` Postgres schema namespaces every table.

---

## Phase 0 — runtime seam prep (no new package yet)

### Task 1: Checkpoint versioning in the interpreter

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/interpreter.ts`
- Test: `packages/flowlet-runtime/src/automations/interpreter.test.ts`

The interpreter's pause checkpoint (`{ stepId, steps, outputs }`) gains a `v: 1` field, and resume validates it: missing/unknown version → the run fails with a clear error instead of silently misresuming.

- [ ] **Step 1: Write the failing tests** — in `interpreter.test.ts`, add: (a) a pause produces `checkpoint.v === 1`; (b) resuming with `checkpoint: { ...valid, v: 2 }` returns a failed result whose error matches `/unsupported checkpoint version/i`; (c) resuming with a checkpoint missing `v` fails the same way (pre-versioning checkpoints are unresumable by definition since nothing durable existed before this release).
- [ ] **Step 2: Run** `pnpm --filter @flowlet/runtime test -- interpreter` — expect the new tests FAIL.
- [ ] **Step 3: Implement** — add `export const CHECKPOINT_VERSION = 1;` in `interpreter.ts`; include `v: CHECKPOINT_VERSION` where the checkpoint object is built (`checkpoint: { ... }` near line 613); at the resume entry (near line 573), before casting, check `(input.resume.checkpoint as { v?: unknown })?.v === CHECKPOINT_VERSION` and return the interpreter's failed-run shape with error `` `unsupported checkpoint version ${String(v)} — cannot resume this run` `` when it isn't. Follow the file's existing failure-result construction (see how step failures finalize).
- [ ] **Step 4: Run** the interpreter suite — all green.
- [ ] **Step 5: Commit** `feat(runtime): version interpreter checkpoints; fail closed on unknown versions`

### Task 2: `listEnabledSchedules` on the engine store seam

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts`
- Test: `packages/flowlet-runtime/src/automations/store.test.ts`

Rehydration needs a cross-scope listing (id, trigger, stored principal). Additive method; the frozen per-scope surface is untouched.

- [ ] **Step 1: Failing test** — create two automations under two different principals (one `schedule` trigger, one `host_event`), then `store.listEnabledSchedules()` returns exactly the schedule one as `{ automationId, trigger, principal: { tenantId, subject } }`; pause it → returns `[]`.
- [ ] **Step 2: Run** `pnpm --filter @flowlet/runtime test -- automations/store` — FAIL.
- [ ] **Step 3: Implement** — add to the `AutomationEngineStore` interface:

```ts
/** Cross-scope listing used ONLY for boot rehydration of the scheduler. */
listEnabledSchedules(): Promise<
  Array<{ automationId: string; trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>; principal: Principal }>
>;
```

and in `InMemoryAutomationStore`: filter `this.automations.values()` for `status === "enabled" && triggerKind === "schedule"`, map to `{ automationId: a.id, trigger: a.spec.trigger, principal: { tenantId: a.tenantId, subject: a.subject } }` (narrow the trigger type via the `type === "schedule"` check).
- [ ] **Step 4: Run** suite — green.
- [ ] **Step 5: Commit** `feat(runtime): listEnabledSchedules store method for boot rehydration`

### Task 3: Atomic approval claim on the seam

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts`, `packages/flowlet-runtime/src/automations/runner.ts`
- Test: `packages/flowlet-runtime/src/automations/store.test.ts`, `packages/flowlet-runtime/src/automations/runner.test.ts`

Approve/decline becomes an atomic claim: exactly one caller wins; the loser gets `undefined`. The runner resumes only from a successful claim.

- [ ] **Step 1: Failing store test** — drive a run into `waiting_approval` (see existing waiting-approval fixtures in `runner.test.ts` for the shape; in the store test build the run via `createRun` + `updateRun({ outcome: "waiting_approval", pendingApproval })`). Then: first `claimPendingApproval(scope, runId)` returns the `PendingApproval` and a re-read run has no `pendingApproval`; second call returns `undefined`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — interface addition:

```ts
/** Atomically take the pending approval off a run. Exactly one caller wins. */
claimPendingApproval(scope: Principal, runId: string): Promise<PendingApproval | undefined>;
```

In-memory impl: `mustGetRun`, if `run.pendingApproval` undefined return undefined; otherwise copy it, `delete next.pendingApproval`, keep `outcome` as-is (finalization decides), store, return the copy. (Single-threaded JS makes the in-memory version trivially atomic; the Drizzle version does it with one conditional `UPDATE … RETURNING` in Task 8.)
- [ ] **Step 4: Failing runner test** — wherever `runner.ts` currently reads `run.pendingApproval` then `updateRun` to clear it (the resume path), assert via a spy store that resume goes through `claimPendingApproval` and that a second concurrent `resumeApproval(...)` for the same run resolves to the existing "already decided" error shape (match the runner's current error convention).
- [ ] **Step 5: Implement** the runner switch to `claimPendingApproval`; a failed claim returns the already-decided error, never re-executes.
- [ ] **Step 6: Run** `pnpm --filter @flowlet/runtime test -- automations` — green. **Commit** `feat(runtime): atomic pending-approval claim; idempotent resume`

### Task 4: One-shot `at` schedules complete durably

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts` (type only), `packages/flowlet-runtime/src/automations/runner.ts` (or the firing handler in `packages/flowlet-runtime/src/automations/tools.ts` — find `createSchedulerFiringHandler` and put the logic where the firing completes)
- Test: `packages/flowlet-runtime/src/automations/runner.test.ts`

- [ ] **Step 1: Failing test** — an automation whose spec trigger is `{ type: "schedule", kind: "at", at: <past-iso> }` (match the real schema field names in `schema.ts`) finishes its run → the automation record now has `status: "paused"` and `disabledReason: "completed_one_shot"`.
- [ ] **Step 2: Run** — FAIL (also a type error: `disabledReason` union).
- [ ] **Step 3: Implement** — widen the type: `disabledReason?: "consecutive_failures" | "completed_one_shot"`. In the firing completion path, after finalize, if the automation's schedule trigger is one-shot (`kind === "at"` — verify the exact discriminator in `schema.ts` and use it), call `setStatus(scope, id, "paused", { disabledReason: "completed_one_shot" })`.
- [ ] **Step 4: Run** suite — green. **Commit** `feat(runtime): one-shot schedules pause as completed after firing`

### Task 4b: Explicit unattended-tool rejection at authoring time

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/tools.ts`
- Test: `packages/flowlet-runtime/src/automations/tools.test.ts`

Automations may only reference server-registered tools (client-executed host tools can't run unattended). Today unknown tools fail late; make the create/update authoring tools reject them upfront with a clear message.

- [ ] **Step 1: Failing test** — authoring `create_automation` with a spec step referencing a tool NOT in `registeredTools` returns the tools' error shape with a message matching `/server-registered|cannot run unattended/i` and does NOT create the automation.
- [ ] **Step 2: Implement** — in the create/update tool handlers, before store writes: collect every `tool` referenced by the spec (walk steps incl. branch/for_each children + agent-step `tools` allowlists), diff against `await registeredTools()`, reject listing the offenders: `` `tool(s) ${names} are not server-registered — client-executed host tools cannot run unattended; register a server tool via automations.tools` ``.
- [ ] **Step 3: Run** `pnpm --filter @flowlet/runtime test -- automations/tools` — green. **Commit** `feat(runtime): authoring-time rejection of non-server tools in automations`

### Task 5: ThreadStore seam in runtime

**Files:**
- Create: `packages/flowlet-runtime/src/threads.ts`
- Modify: `packages/flowlet-runtime/src/index.ts` (export)
- Test: `packages/flowlet-runtime/src/threads.test.ts`

The seam + an in-memory reference implementation (the durable one lands in `@flowlet/store`).

- [ ] **Step 1: Failing test** — upsert two messages, read back seq-ordered; re-upsert message id 1 with new parts → still 2 messages, parts replaced, order unchanged; `listThreads` returns thread metadata sorted by `updatedAt` desc.
- [ ] **Step 2: Run** `pnpm --filter @flowlet/runtime test -- threads` — FAIL.
- [ ] **Step 3: Implement:**

```ts
import type { Principal } from "@flowlet/core";

export interface ThreadMessageRecord {
  /** ai-SDK UIMessage id — the upsert key. */
  id: string;
  /** Whole UIMessage as JSON; parts are replaced wholesale on re-upsert. */
  message: unknown;
}

export interface ThreadRecord {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadStore {
  /** Creates the thread row if missing; upserts each message by id (existing keeps its seq). */
  upsertMessages(scope: Principal, threadId: string, messages: ThreadMessageRecord[]): Promise<void>;
  /** Seq-ordered full history. Empty array for an unknown thread. */
  getMessages(scope: Principal, threadId: string): Promise<ThreadMessageRecord[]>;
  listThreads(scope: Principal): Promise<ThreadRecord[]>;
}

export function createInMemoryThreadStore(now: () => string = () => new Date().toISOString()): ThreadStore {
  interface Row { seq: number; message: unknown }
  const threads = new Map<string, { meta: ThreadRecord; rows: Map<string, Row>; nextSeq: number }>();
  const key = (scope: Principal, threadId: string) => `${scope.tenantId}::${scope.subject}::${threadId}`;
  return {
    async upsertMessages(scope, threadId, messages) {
      const k = key(scope, threadId);
      const t = threads.get(k) ?? {
        meta: { id: threadId, title: null, createdAt: now(), updatedAt: now() },
        rows: new Map<string, Row>(),
        nextSeq: 0,
      };
      for (const m of messages) {
        const existing = t.rows.get(m.id);
        t.rows.set(m.id, { seq: existing?.seq ?? t.nextSeq++, message: m.message });
      }
      t.meta.updatedAt = now();
      threads.set(k, t);
    },
    async getMessages(scope, threadId) {
      const t = threads.get(key(scope, threadId));
      if (!t) return [];
      return [...t.rows.entries()]
        .sort((a, b) => a[1].seq - b[1].seq)
        .map(([id, row]) => ({ id, message: row.message }));
    },
    async listThreads(scope) {
      const prefix = `${scope.tenantId}::${scope.subject}::`;
      return [...threads.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, t]) => t.meta)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
  };
}
```

- [ ] **Step 4: Run** — green. Export from `index.ts`. **Commit** `feat(runtime): ThreadStore seam + in-memory reference`

---

## Phase 1 — the `@flowlet/store` package

### Task 6: Package scaffold + connection factory + migrations runner

**Files:**
- Create: `packages/flowlet-store/package.json`, `tsconfig.json`, `vitest.config.ts` (copy the shape from `packages/flowlet-runtime`'s configs), `src/index.ts`, `src/db.ts`, `drizzle.config.ts`, `src/schema.ts` (tables land next task — start with an empty `flowlet` schema declaration)
- Test: `packages/flowlet-store/src/db.test.ts`

`createFlowletDatabase` resolves: explicit `connectionString` → node-postgres Pool; explicit `pglite: { dataDir }` or nothing → PGlite. Process-wide singleton per resolved target via a `globalThis` registry (HMR-safe). Serverless guard: if no connection string and (`process.env.VERCEL` or `process.env.CF_PAGES` or `process.env.AWS_LAMBDA_FUNCTION_NAME`) → throw with a message naming `DATABASE_URL`. Migrations: `migrate()` behind a per-process promise + `pg_advisory_lock(7461001)` (any stable constant), released after; PGlite path skips the advisory lock (single process by construction).

- [ ] **Step 1:** `package.json` — name `@flowlet/store`, deps: `drizzle-orm`, `@electric-sql/pglite`, `pg`; devDeps: `drizzle-kit`, `@types/pg`, `vitest`, workspace `@flowlet/core` + `@flowlet/runtime`. Match the repo's existing `exports`/`build` conventions (`vite build` vs `tsc` — copy whichever `flowlet-runtime` uses). Add the package to the root workspace + turbo pipeline like the other packages.
- [ ] **Step 2: Failing tests** (`db.test.ts`, PGlite in-memory via `dataDir: "memory://"`): (a) two `createFlowletDatabase()` calls with the same config return the same instance; (b) `migrateFlowletDatabase(db)` twice resolves without error (idempotent); (c) with `process.env.VERCEL = "1"` and no connection string, `createFlowletDatabase()` throws matching `/DATABASE_URL/`.
- [ ] **Step 3: Implement** `src/db.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface FlowletDatabaseConfig {
  connectionString?: string;
  pglite?: { dataDir: string };
}

export type FlowletDb =
  | { kind: "pglite"; db: ReturnType<typeof drizzlePglite> }
  | { kind: "pg"; db: ReturnType<typeof drizzlePg> };

const SERVERLESS_ENVS = ["VERCEL", "CF_PAGES", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const ADVISORY_LOCK_KEY = 7461001;

interface Registry { instances: Map<string, FlowletDb>; migrated: Map<string, Promise<void>> }
const registry: Registry = ((globalThis as Record<string, unknown>)["__flowletStoreRegistry"] ??= {
  instances: new Map(),
  migrated: new Map(),
}) as Registry;

export function createFlowletDatabase(config: FlowletDatabaseConfig = {}): FlowletDb {
  const conn = config.connectionString ?? process.env["DATABASE_URL"];
  const cacheKey = conn ?? `pglite:${config.pglite?.dataDir ?? ".flowlet/data"}`;
  const existing = registry.instances.get(cacheKey);
  if (existing) return existing;

  let created: FlowletDb;
  if (conn) {
    created = { kind: "pg", db: drizzlePg(new Pool({ connectionString: conn })) };
  } else {
    const onServerless = SERVERLESS_ENVS.find((e) => process.env[e]);
    if (onServerless) {
      throw new Error(
        `[flowlet] PGlite (the zero-config store) cannot run on ${onServerless} — filesystems there are ephemeral. ` +
          `Set DATABASE_URL to a hosted Postgres (Supabase, Neon, …) instead.`,
      );
    }
    const dataDir = config.pglite?.dataDir ?? ".flowlet/data";
    created = { kind: "pglite", db: drizzlePglite(new PGlite(dataDir)) };
  }
  registry.instances.set(cacheKey, created);
  return created;
}

/** Idempotent, race-safe (advisory lock on real PG), memoized per process. */
export function migrateFlowletDatabase(handle: FlowletDb, cacheKey = "default"): Promise<void> {
  const memo = registry.migrated.get(cacheKey);
  if (memo) return memo;
  const run = (async () => {
    if (handle.kind === "pglite") {
      await migratePglite(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
      return;
    }
    await handle.db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    try {
      await migratePg(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
    } catch (err) {
      registry.migrated.delete(cacheKey); // let a later boot retry
      throw new Error(
        `[flowlet] migration failed — if this is a permissions error, grant the role CREATE on the database ` +
          `or run migrations out-of-band with autoMigrate: false. Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await handle.db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  })();
  registry.migrated.set(cacheKey, run);
  return run;
}
```

(Adjust imports/API names to the installed drizzle version — check `node_modules/drizzle-orm/pglite` exists after install; if the pglite adapter lives elsewhere, follow the drizzle docs via context7.)
- [ ] **Step 4: Run** `pnpm --filter @flowlet/store test -- db` — green (an empty migrations dir migrates to nothing; commit a `.gitkeep`).
- [ ] **Step 5: Commit** `feat(store): @flowlet/store scaffold — connection factory, singleton, race-safe boot migrations`

### Task 7: Schema + generated migration

**Files:**
- Modify: `packages/flowlet-store/src/schema.ts`, `drizzle.config.ts`
- Create: `packages/flowlet-store/migrations/0000_*.sql` (generated)
- Test: `packages/flowlet-store/src/schema.test.ts`

- [ ] **Step 1: Write the schema** — all tables in `pgSchema("flowlet")`. Columns mirror the seam types (JSON-heavy fields as `jsonb`):

```ts
import { pgSchema, text, integer, boolean, jsonb, timestamp, primaryKey, uniqueIndex, index, bigserial } from "drizzle-orm/pg-core";

export const flowlet = pgSchema("flowlet");

export const automations = flowlet.table("automations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  disabledReason: text("disabled_reason"),
  spec: jsonb("spec").notNull(),
  currentVersion: integer("current_version").notNull(),
  triggerKind: text("trigger_kind").notNull(),
  triggerKey: text("trigger_key"),
  counters: jsonb("counters").notNull(),
  createdFromThreadId: text("created_from_thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [index("automations_scope_idx").on(t.tenantId, t.subject), index("automations_trigger_idx").on(t.triggerKind, t.triggerKey)]);

export const automationVersions = flowlet.table("automation_versions", {
  automationId: text("automation_id").notNull(),
  version: integer("version").notNull(),
  spec: jsonb("spec").notNull(),
  dslVersion: integer("dsl_version").notNull(),
  manifestHash: text("manifest_hash"),
  grants: jsonb("grants").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.automationId, t.version] })]);

export const automationRuns = flowlet.table("automation_runs", {
  id: text("id").primaryKey(), // firingRunId — DB-level double-fire dedup
  automationId: text("automation_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  version: integer("version").notNull(),
  manifestHash: text("manifest_hash"),
  status: text("status").notNull(),
  outcome: text("outcome"),
  trigger: jsonb("trigger").notNull(),
  steps: jsonb("steps").notNull(),
  pendingApproval: jsonb("pending_approval"),
  error: text("error"),
  isTest: boolean("is_test").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
}, (t) => [index("runs_automation_idx").on(t.automationId, t.tenantId, t.subject)]);

export const decisions = flowlet.table("decisions", {
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  canonicalKey: text("canonical_key").notNull(),
  decision: jsonb("decision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.canonicalKey] })]);

export const threads = flowlet.table("threads", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.id] })]);

export const threadMessages = flowlet.table("thread_messages", {
  rowId: bigserial("row_id", { mode: "number" }).primaryKey(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  threadId: text("thread_id").notNull(),
  messageId: text("message_id").notNull(),
  seq: integer("seq").notNull(),
  message: jsonb("message").notNull(),
}, (t) => [
  uniqueIndex("thread_messages_id_uq").on(t.tenantId, t.subject, t.threadId, t.messageId),
  uniqueIndex("thread_messages_seq_uq").on(t.tenantId, t.subject, t.threadId, t.seq),
]);

export const savedFlowlets = flowlet.table("saved_flowlets", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  record: jsonb("record").notNull(), // whole shell Flowlet record (schema-versioned envelope)
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.id] })]);

export const connections = flowlet.table("connections", {
  toolkit: text("toolkit").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  connectedAccountId: text("connected_account_id"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.toolkit] })]);
```

- [ ] **Step 2: Generate the migration** — `drizzle.config.ts` points `schema` at `src/schema.ts`, `out` at `./migrations`, dialect `postgresql`. Run `pnpm --filter @flowlet/store exec drizzle-kit generate`. Inspect the SQL: it must `CREATE SCHEMA "flowlet"` and create all 8 tables. Commit the generated SQL.
- [ ] **Step 3: Failing → passing schema test** — `schema.test.ts`: create a PGlite db, run `migrateFlowletDatabase`, insert + read one row in `automations` and one in `thread_messages` (exercises bigserial + unique indexes). Run `pnpm --filter @flowlet/store test -- schema` — green.
- [ ] **Step 4: Commit** `feat(store): flowlet-schema tables + generated initial migration`

### Task 8: `DrizzleAutomationStore` (the port)

**Files:**
- Create: `packages/flowlet-store/src/automation-store.ts`
- Test: `packages/flowlet-store/src/automation-store.test.ts`

Implements `AutomationEngineStore` (including Tasks 2–3 additions). **The behavioral spec is `InMemoryAutomationStore`** (`packages/flowlet-runtime/src/automations/store.ts`) — port it method-for-method onto Drizzle queries. Non-negotiable semantics to preserve, each with a test:

1. `save()` validates the opaque spec via `automationSpecSchema.parse` and delegates to `create` (+ paused status passthrough).
2. Principal scoping on every read/write (`tenantId`/`subject` columns, not scopeKey strings).
3. `create`/`update` write an `automation_versions` row; `update` bumps `currentVersion` and re-derives the trigger index (`triggerIndex` behavior).
4. `createRun` uses `firingRunId` as the PK; a duplicate insert (catch the PG unique-violation, code `23505`) rethrows `DuplicateRunError`.
5. `capStep`/`capEnvelope` truncation (import `MAX_STEP_OUTPUT_BYTES` etc. from `@flowlet/runtime` — the functions are private, so re-implement by importing the constants and copying the two small helpers, or export them from runtime; prefer exporting from runtime and reusing).
6. `finalizeRun` computes `coarseStatus`, clears `pendingApproval`, and updates counters **in the same transaction** (`db.transaction`); skipped runs store empty steps.
7. `cancelPendingRuns` cancels only `waiting_approval` runs of that automation+scope.
8. `claimPendingApproval` = single conditional `UPDATE flowlet.automation_runs SET pending_approval = NULL WHERE id = $1 AND tenant_id=$2 AND subject=$3 AND pending_approval IS NOT NULL RETURNING pending_approval` — one winner by construction.
9. `listEnabledSchedules` = `SELECT` on status+triggerKind, cross-scope.
10. ID generation: replace the in-memory counter with `auto-${crypto.randomUUID()}`.

- [ ] **Step 1: Write the contract test suite first** — port every scenario in `packages/flowlet-runtime/src/automations/store.test.ts` (all 314 lines) to run against `new DrizzleAutomationStore(createFlowletDatabase({ pglite: { dataDir: "memory://" } }))`, plus new cases for items 4, 6, 8 above (duplicate insert → `DuplicateRunError`; concurrent `claimPendingApproval` via `Promise.all` → exactly one non-undefined). Fresh database per test (`memory://` + unique cacheKey, run migrations in `beforeEach`).
- [ ] **Step 2: Run** — FAIL (class missing).
- [ ] **Step 3: Implement** `DrizzleAutomationStore` method-for-method. Keep it one class in one file; if it passes 500 lines that's acceptable (it mirrors the reference). Reuse `firingRunId`, `DuplicateRunError`, `automationSpecSchema` and the truncation helpers from `@flowlet/runtime` — never fork semantics.
- [ ] **Step 4: Run** the suite — green. `pnpm --filter @flowlet/store typecheck`.
- [ ] **Step 5: Commit** `feat(store): DrizzleAutomationStore — full engine-store port with DB-level dedup + atomic claim`

### Task 9: Durable DecisionStore, ThreadStore, saved-flowlet + connections stores

**Files:**
- Create: `packages/flowlet-store/src/decision-store.ts`, `src/thread-store.ts`, `src/flowlet-registry.ts`, `src/connections-store.ts`
- Test: mirror `.test.ts` per file

Four small stores, same TDD loop each (write tests against the seam contract first, PGlite in-memory, then implement):

- [ ] **Step 1: `createDrizzleDecisionStore(db, scope)`** implements runtime's `DecisionStore` (`get`/`set` by canonical key): `set` = upsert (`onConflictDoUpdate` on the PK); test get-miss → undefined, set→get roundtrip, scope isolation (two scopes, same key, different decisions).
- [ ] **Step 2: `createDrizzleThreadStore(db)`** implements `ThreadStore` (Task 5): `upsertMessages` in one transaction — ensure thread row (insert-on-conflict-nothing, then bump `updatedAt`), for each message `INSERT … ON CONFLICT (tenant,subject,thread,message_id) DO UPDATE SET message = excluded.message` with `seq` allocated as `COALESCE(MAX(seq)+1, 0)` inside the transaction; reads order by `seq`. Port the Task 5 test cases plus: concurrent upserts of different messages produce distinct seqs (run two upserts, assert 2 rows, distinct seq).
- [ ] **Step 3: `createDrizzleFlowletRegistry(db, scope)`** — server registry for saved flowlets storing the shell record as jsonb: `list()` (updatedAt desc), `load(id)`, `save(record)` upsert, `remove(id)`. Match the shell `FlowletStore` seam's method names/shapes exactly (see `packages/flowlet-shell/src/seams/store.ts` — read it first; the record type is `Flowlet`).
- [ ] **Step 4: `createDrizzleConnectionsStore(db, scope, catalog)`** — implements `ConnectionsStore` from `packages/flowlet-next/src/connections.ts` (read it first; keep `connectedToolkits()`/`list()` behavior identical to the in-memory version) with rows in `connections`, plus one addition used by the webhook: `findByConnectedAccount(connectedAccountId)` returning `{ toolkit, principal } | undefined`. NOTE: `ConnectionsStore` lives in `@flowlet/next` — to avoid a circular dependency, define the interface's structural shape locally in `@flowlet/store` (duck-typed; `@flowlet/next` accepts it since the option is validated structurally).
- [ ] **Step 5: Run** all four suites — green. Export everything from `src/index.ts`. **Commit** `feat(store): durable decision/thread/flowlet-registry/connections stores`

---

## Phase 2 — wiring `@flowlet/next`

### Task 10: Full-tail routing + storage option

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/options.ts`
- Test: `packages/flowlet-next/src/handler.test.ts`

- [ ] **Step 1: Failing tests** — (a) a POST to `…/api/flowlet/webhooks/composio` routes distinctly from `…/composio` (assert 404 vs the future handler — for now assert the sub-path resolver returns `"webhooks/composio"`); (b) options accept `storage: { connectionString }`, `storage: { pglite: { dataDir } }`, `storage: false`, and reject `storage: 42`.
- [ ] **Step 2: Implement routing** — replace `subPath` with a resolver that returns the full tail after the catch-all mount. The mount is wherever the route file lives, so derive it: split the pathname, find the last occurrence of a known FIRST segment… simpler and robust: match known endpoints from the END of the path — `const tail = segments.slice(-2).join("/");` then `if (tail === "webhooks/composio") …` else fall back to the last segment for all existing single-segment routes. Keep the old behavior for every current endpoint (regression tests: `chat`, `action`, `tick`, `integrations`, `capabilities` still route).
- [ ] **Step 3: Implement the option** — `options.ts` gains:

```ts
/** Durable storage. Default: PGlite at .flowlet/data (or DATABASE_URL when set). `false` = in-memory (tests). */
storage?: false | { connectionString?: string; pglite?: { dataDir: string }; autoMigrate?: boolean };
```

zod: `z.union([z.literal(false), z.object({ connectionString: z.string().min(1).optional(), pglite: z.object({ dataDir: z.string().min(1) }).strict().optional(), autoMigrate: z.boolean().optional() }).strict()]).optional()`. `autoMigrate: false` skips boot migrations (DDL-gated shops run them out-of-band via the exported `migrateFlowletDatabase`); default true.
- [ ] **Step 4: Run** `pnpm --filter @flowlet/next test -- handler options` — green. **Commit** `feat(next): full-tail routing + storage handler option`

### Task 11: Durable world assembly + boot warnings

**Files:**
- Modify: `packages/flowlet-next/src/world.ts`, `packages/flowlet-next/src/handler.ts`
- Test: `packages/flowlet-next/src/world.test.ts`

- [ ] **Step 1: Failing tests** — (a) `createAutomationsWorld` with a provided `store` uses it (spy: `create` goes through); (b) handler assembly with `storage: false` logs the in-memory production warning when `NODE_ENV === "production"` (spy `console.warn`, match `/in-memory/`); (c) assembly with default storage + a custom `principal` resolver logs the single-tenant warning once (`/single-tenant/`).
- [ ] **Step 2: Implement** — `CreateWorldConfig` gains optional `store?: AutomationEngineStore` (default stays `new InMemoryAutomationStore({})`). In `handler.ts` `assemble()`:

```ts
const storage = resolveStorage(options); // null when options.storage === false
// resolveStorage: options.storage === false → null; otherwise createFlowletDatabase
// with the option's connectionString/pglite (falling back to DATABASE_URL / .flowlet/data)
// and a kicked-off (awaited-on-first-use) migrateFlowletDatabase promise.
```

Store instances built from it: `DrizzleAutomationStore`, decision store (thread/flowlet/connections wired in Tasks 13–15). The engine world gets the durable store; migration completion is awaited before the first request completes (make `assemble` async-safe: keep the lazy `assembled` slot but have `state()` return a promise — adjust call sites; this is the trickiest mechanical change in the plan, keep the diff small and typed).
- [ ] **Step 3:** boot warnings per the spec (in-memory-in-prod; principal-resolver + durable single-tenant note). One-time flags on the assembled state.
- [ ] **Step 4: Run** suite — green. **Commit** `feat(next): durable stores wired through handler assembly (PGlite default, DATABASE_URL override)`

### Task 12: Scheduler boot — rehydration, `startFlowletScheduler`, tick service auth

**Files:**
- Modify: `packages/flowlet-next/src/world.ts`, `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/index.ts`
- Create: `packages/flowlet-next/src/boot.ts`
- Test: `packages/flowlet-next/src/boot.test.ts`, extend `handler.test.ts`

- [ ] **Step 1: Failing tests** — (a) `rehydrateSchedules(world)` registers every row from `listEnabledSchedules` (durable store seeded with 2 schedules → scheduler has both; spy `scheduler.schedule`); (b) `startFlowletScheduler()` twice starts one timer (globalThis singleton — assert via exposed handle identity); (c) with `FLOWLET_SCHEDULER=external` it no-ops; (d) `POST /tick` with `authorization: Bearer <secret>` matching `FLOWLET_TICK_SECRET` succeeds **without** a principal, wrong secret → 401, no secret env + remote → existing guard behavior.
- [ ] **Step 2: Implement** — `world.ts`: after constructing scheduler+runner, `await rehydrateSchedules()` (reads `listEnabledSchedules()`, calls `scheduler.schedule(id, trigger, principal)`); export the world factory as async. `boot.ts`:

```ts
/** Long-lived Node boot hook: import { startFlowletScheduler } from "@flowlet/next" in instrumentation.ts. */
export function startFlowletScheduler(options: FlowletHandlerOptions = {}): void {
  if (process.env["FLOWLET_SCHEDULER"] === "external") return;
  const g = globalThis as Record<string, unknown>;
  if (g["__flowletSchedulerStarted"]) return;
  g["__flowletSchedulerStarted"] = true;
  void ensureFlowletWorld(options).then((world) => world?.scheduler.start());
}
```

where `ensureFlowletWorld` is the (new, exported-for-internal-use) shared lazy assembly used by the handler too — ONE world per process regardless of entry point (move the `assembled` slot into a globalThis-keyed registry keyed by a stable options hash; handler + boot share it). Tick auth: in the `"tick"` case, accept `FLOWLET_TICK_SECRET` bearer before falling back to `resolvePrincipal`; heartbeat: after a successful tick write `lastTickAt` (a tiny `flowlet.meta` key-value insert is overkill — store it on the world object in-process AND, when durable, in the decisions table under a reserved key `["__flowlet","scheduler_heartbeat"]`; keep it simple, it's observability-only).
- [ ] **Step 3: Run** suites — green. Export `startFlowletScheduler` from the package index. **Commit** `feat(next): scheduler boot hook + rehydration + tick service auth + heartbeat`

### Task 13: Composio webhook ingress

**Files:**
- Create: `packages/flowlet-next/src/webhooks.ts`
- Modify: `packages/flowlet-next/src/handler.ts` (route), `packages/flowlet-next/src/integrations.ts` (record `connectedAccountId` on connect — read the file first to find where a successful connection lands)
- Test: `packages/flowlet-next/src/webhooks.test.ts`

- [ ] **Step 1: Research pin (30 min, context7/web):** confirm Composio's current webhook signature scheme (header names, HMAC algorithm, timestamp format) and the trigger payload envelope (where `id`/delivery id, `connectedAccountId`, and the trigger slug live). Record findings as a comment block atop `webhooks.ts`. If documentation is ambiguous, verify against a captured real payload during the acceptance drill and adjust — the verification helper is isolated for exactly this.
- [ ] **Step 2: Failing tests** — matrix: missing `COMPOSIO_WEBHOOK_SECRET` → 404; bad signature → 401; stale timestamp (>5 min) → 401; malformed JSON with valid signature → 400; valid + unknown connected account → 200 `{ skipped: true }`; valid + known account + matching enabled automation → fires runner (spy) under the connection's principal with `eventId` = delivery id; redelivery (same id) → 200, runner NOT re-invoked (DuplicateRunError swallowed).
- [ ] **Step 3: Implement** `handleComposioWebhook(req, deps)` — raw body via `await req.text()` BEFORE JSON.parse (HMAC over raw bytes), `crypto.timingSafeEqual` for compare, then: parse → look up connection by connected-account id → `findEnabledByTrigger({ kind: "composio", key: <trigger slug> })` under that principal → for each, build `TriggerEnvelope { source: "composio", eventId, subject, occurredAt, payload }` → `runner.fire(...)` (match the runner's actual firing API from `createSchedulerFiringHandler` / `host-events.ts` — reuse the host-events ingest helper if it fits). Catch `DuplicateRunError` → treat as success. Route it in `handler.ts` under `webhooks/composio`.
- [ ] **Step 4: Run** — green. Fix the stale "cloud-only" comment in `in-process-scheduler.ts` (now: "needs a reachable webhook URL — see @flowlet/next webhooks"). **Commit** `feat(next): signature-verified Composio webhook ingress (single-tenant v1)`

### Task 14: Thread persistence through `/chat`

**Files:**
- Modify: `packages/flowlet-next/src/chat.ts`, `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/client/flowlet-root.tsx` (send `threadId`)
- Test: `packages/flowlet-next/src/chat.test.ts`

- [ ] **Step 1: Failing tests** — (a) a chat request with `threadId` upserts the incoming client messages into the ThreadStore before streaming and the assistant message after settlement (in-memory ThreadStore + a stub agent that emits a fixed UIMessage stream — follow existing chat.test.ts stubbing patterns); (b) a resumed request re-sending mutated approval messages (same ids, new parts) results in updated rows, not duplicates (assert count + parts); (c) no `threadId` → nothing persisted (back-compat); (d) `GET /threads` lists thread metadata; `GET /threads/<id>` returns seq-ordered messages (route via full-tail: `threads` and `threads/<id>`).
- [ ] **Step 2: Implement** — `ChatRequestBody` gains `threadId?: string`; when present and a ThreadStore is wired: upsert `body.messages` (each `{ id: m.id, message: m }`) pre-stream; wrap the agent stream to capture the final assistant UIMessage on finish (the ai SDK's `createUIMessageStreamResponse` consumes a stream — use the SDK's `onFinish` hook on the stream creation if available in the installed version, else tee the stream; check how the engine exposes run completion) and upsert it. Add the two GET routes. `FlowletRoot`: include `threadId` in the transport body (`DefaultChatTransport({ api, body: { threadId } })` — verify the installed ai-SDK transport supports a static body object; it does via `body` option).
- [ ] **Step 3: Run** — green. **Commit** `feat(next): durable chat threads (upsert-by-message-id, seq-ordered reads)`

### Task 15: Saved flowlets — server endpoints + client adapter

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/client/flowlet-root.tsx`
- Create: `packages/flowlet-next/src/flowlets.ts`, `packages/flowlet-next/src/client/server-store.ts`
- Test: `packages/flowlet-next/src/flowlets.test.ts`, `packages/flowlet-next/src/client/server-store.test.ts`

- [ ] **Step 1: Read** `packages/flowlet-shell/src/seams/store.ts` — the client `FlowletStore` seam (list/load/save/remove + `Flowlet` record). The server endpoints mirror it 1:1 over HTTP.
- [ ] **Step 2: Failing endpoint tests** — `GET /flowlets` → list; `GET /flowlets/<id>` → one or 404; `POST /flowlets` (save, body = record) → saved record with server timestamps; `DELETE` via `POST /flowlets/<id>/delete` (the handler only exports GET/POST — keep the existing convention, don't add a DELETE export without checking how PR #34's toast routes did it; if the handler already gained more verbs on the interface branch, match it at rebase time and note it in the PR).
- [ ] **Step 3: Implement** endpoints over `createDrizzleFlowletRegistry`, principal-guarded like `/chat`.
- [ ] **Step 4: Failing client-adapter tests** — `createServerFlowletStore(basePath)` implements the shell seam against `fetch` (happy paths + a 500 → throws loudly, matching the web-storage seam's "failures are loud" contract). jsdom/fetch-mock per existing client test patterns.
- [ ] **Step 5: Implement + wire** — in `flowlet-root.tsx`, pick the store by capability: the `/capabilities` response gains `storage: boolean` (set true when the handler has durable storage — add to `detectCapabilities`/handler assembly and its test); `storage ? createServerFlowletStore(basePath) : createWebStorage(...)` (existing localStorage behavior is the no-storage fallback, no data migration in v1 — document).
- [ ] **Step 6: Run** both suites + `pnpm --filter @flowlet/next test` full — green. **Commit** `feat(next): durable saved flowlets — /flowlets endpoints + server-backed client store`

### Task 16: Decisions + connections wired durable

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts` (assembly), `packages/flowlet-next/src/default-policy.ts` (accept injected DecisionStore — read first; the remember layer wraps the policy somewhere in assembly), `packages/flowlet-next/src/integrations.ts`
- Test: extend `handler.test.ts`, `integrations.test.ts`

- [ ] **Step 1: Failing tests** — (a) with durable storage, the assembled policy's remember layer round-trips through the Drizzle decision store (approve-once → second identical evaluate auto-allows, then rebuild the world from the same PGlite dir → still auto-allows); (b) connections: connect a toolkit, rebuild world → still connected (`connectedToolkits()` includes it).
- [ ] **Step 2: Implement** — assembly passes `createDrizzleDecisionStore(db, scope)` into the remember wrapper and `createDrizzleConnectionsStore(db, scope, catalog)` as the default connections store when durable (explicit `options.connections` still wins).
- [ ] **Step 3: Run** — green. **Commit** `feat(next): durable approval decisions + integration connections`

---

## Phase 3 — install DX, docs, drill

### Task 17: CLI codemod — instrumentation.ts + env docs

**Files:**
- Modify: `packages/flowlet-cli/src/next-wiring.ts` (+ its test), `packages/flowlet-cli/src/init.ts` if wiring is orchestrated there (read first)
- Test: `packages/flowlet-cli/src/next-wiring.test.ts`

- [ ] **Step 1: Failing tests** — the codemod (a) creates `instrumentation.ts` at the app root (or `src/`, matching where it put the route file — reuse its existing root-detection) with:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startFlowletScheduler } = await import("@flowlet/next");
    startFlowletScheduler();
  }
}
```

(b) merges into an EXISTING `instrumentation.ts` non-destructively (append the import+call inside `register` if present; if the file exists and can't be safely merged, write `instrumentation.flowlet-example.ts` and print a manual step — follow the codemod's existing conflict convention); (c) `.env.example` gains commented `DATABASE_URL`, `FLOWLET_TICK_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `FLOWLET_SCHEDULER` entries.
- [ ] **Step 2: Implement**, matching next-wiring's existing codemod style (idempotent re-runs — running init twice must not duplicate).
- [ ] **Step 3: Run** `pnpm --filter flowlet-cli test -- next-wiring` — green. **Commit** `feat(cli): init wires instrumentation.ts scheduler boot + storage env docs`

### Task 18: Docs

**Files:**
- Modify: `docs/quickstart.md`
- Create: `docs/persistence-and-deploy.md`

- [ ] **Step 1:** `docs/persistence-and-deploy.md` — succinct and direct, covering: the one storage knob (PGlite default / `DATABASE_URL` / `storage: false`); what persists (all five surfaces); single-writer + single-tenant posture (verbatim honest); scheduler modes (instrumentation auto-start vs `FLOWLET_SCHEDULER=external` + Vercel `vercel.json` crons + Cloudflare Cron Trigger examples hitting `/tick` with the bearer secret); Composio webhook setup (dashboard URL, secret env, tunnel note for local dev); migration policy (`autoMigrate` + out-of-band path).
- [ ] **Step 2:** `quickstart.md` — add the persistence paragraph + link; update the endpoints list (`webhooks/composio`, `threads`, `flowlets`); note `instrumentation.ts` in the init output inventory.
- [ ] **Step 3: Commit** `docs: persistence + deploy guide; quickstart updates`

### Task 19: The kill-the-server drill (scripted)

**Files:**
- Create: `scripts/drill-persistence.mjs` (repo root, next to existing scripts if a scripts dir exists — check; else `packages/flowlet-next/scripts/`)
- Test: the script IS the test (exit non-zero on any failed assertion)

- [ ] **Step 1: Write the script** — automates spec acceptance items 1–4 against a target app dir (default: `apps/demo-bank`): boot `next start` (child process) with a temp `FLOWLET_DATA_DIR`; via HTTP: create an automation through the authoring tools (POST /chat is LLM-dependent — instead seed deterministically: add a tiny test-only route? NO — drive the store directly via a seeding script that imports `@flowlet/store` with the same data dir, creating an automation with a 1-minute cron + grant, THEN boot). Assert: `GET`-able state before kill; `SIGKILL` the server; reboot; assert automations/flowlets/threads/decisions all read back; wait ≤75s for the cron to fire with no client connected (poll run history through the store); assert run status succeeded + no `waiting_approval`.
- [ ] **Step 2: Run it** on demo-bank with PGlite. Fix what breaks (this is the step that finds real integration bugs — budget real time; each fix lands as its own commit in the package it touches).
- [ ] **Step 3: Run it** with `DATABASE_URL` pointing at a local Dockerized Postgres (`docker run --rm -p 5433:5432 -e POSTGRES_PASSWORD=flowlet postgres:16`) as the Supabase stand-in; the live Supabase + live Composio webhook passes happen at release time per the spec (deployed host required).
- [ ] **Step 4: Commit** `test: kill-the-server persistence drill script`

### Task 20: Full-repo verification + PR

- [ ] **Step 1:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` at the root — all green (turbo).
- [ ] **Step 2:** Browser pass per repo rules: run demo-bank, exercise chat + save a flowlet + author an automation, restart, screenshot the surviving state (screenshots go in the PR body).
- [ ] **Step 3:** Open the PR (never merge): title `feat: durable persistence + scheduler liveness + Composio webhook ingress (automations OSS release)`, body = spec link, decisions summary, drill output, screenshots, the two Yousef-gated items called out (last-ticked UI unbuilt; single-tenant posture) — and the note that PR #35 executes separately from its own plan.

---

## Explicitly deferred to their own tracks

- **PR #34** — Yousef reviews/merges; this branch rebases if #34 lands first (watch for handler route additions on that branch at rebase time — Task 15 note).
- **PR #35 (source-baseline)** — executed from its existing spec+plan on `yousefh409/remix-source-baseline` after this plan completes.
- Live-Supabase + live-Composio drill passes — release-time, deployed host.
