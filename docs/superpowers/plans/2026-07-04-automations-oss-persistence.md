# Automations OSS Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Version:** v2 — after Codex plan review (2 blockers + 13 majors folded in; notably: build on the EXISTING core `ThreadStore`/`SavedFlowletStore` seams, CTE-based approval claim, async PGlite creation, remember-layer wiring that doesn't exist yet, full-tail routing table).

**Goal:** Make every embedded persistence surface durable (automations, decisions, threads, saved flowlets, connections) on one Postgres-dialect database (PGlite default, `DATABASE_URL` for hosted), make schedules fire without a client, and give Composio triggers a signature-verified OSS webhook path.

**Architecture:** New `@flowlet/store` package owns the Drizzle Postgres schema + boot migrations + durable implementations of the EXISTING seams (`packages/flowlet-core/src/seams/store.ts` defines `ThreadStore`, `SavedFlowletStore`, `AutomationStore`; runtime refines the automation one). `@flowlet/runtime` gains small additive seam methods. `@flowlet/next` wires storage config, full-tail routing, tick service auth, the Composio webhook, thread persistence, `/flowlets` endpoints, and a `startFlowletScheduler()` boot entry consumed from `instrumentation.ts` (added by the CLI codemod).

**Tech Stack:** Drizzle ORM (`drizzle-orm`, `drizzle-kit`), `@electric-sql/pglite`, `pg` (node-postgres), Vitest, Next 16 App Router, croner (existing).

**Reference spec:** `docs/superpowers/specs/2026-07-04-automations-oss-persistence-design.md` (v2). Semantic reference for the store port: `packages/flowlet-runtime/src/automations/store.ts` (`InMemoryAutomationStore`) and its tests.

**Working rules for every task:** TDD (failing test → watch it fail → implement → watch it pass), commit per task, `pnpm typecheck` before each commit. `@flowlet/runtime`'s dependency-guard allowlist is only touched where a task says so. All tables live in the `flowlet` Postgres schema.

---

## Phase 0 — runtime seam prep

### Task 1: Checkpoint versioning in the interpreter

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/interpreter.ts`
- Test: `packages/flowlet-runtime/src/automations/interpreter.test.ts`

- [ ] **Step 1: Failing tests** — (a) a pause produces `checkpoint.v === 1`; (b) resuming with `{ ...valid, v: 2 }` returns a failed result whose error matches `/unsupported checkpoint version/i`; (c) a checkpoint missing `v` fails the same way (nothing durable predates this release).
- [ ] **Step 2: Run** `pnpm --filter @flowlet/runtime test -- interpreter` — new tests FAIL.
- [ ] **Step 3: Implement** — `export const CHECKPOINT_VERSION = 1;`; add `v: CHECKPOINT_VERSION` where the checkpoint object is built (~line 613); at resume entry (~line 573) check the version before casting and return the interpreter's existing failed-run shape with error `` `unsupported checkpoint version ${String(v)} — cannot resume this run` `` on mismatch.
- [ ] **Step 4: Run** — green. **Step 5: Commit** `feat(runtime): version interpreter checkpoints; fail closed on unknown versions`

### Task 2: `listEnabledSchedules` on the engine store seam

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts`
- Test: `packages/flowlet-runtime/src/automations/store.test.ts`

- [ ] **Step 1: Failing test** — two automations under two principals (one `schedule`, one `host_event`); `listEnabledSchedules()` returns exactly the schedule one as `{ automationId, trigger, principal }`; pausing it empties the list.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — interface addition:

```ts
/** Cross-scope listing used ONLY for boot rehydration of the scheduler. */
listEnabledSchedules(): Promise<
  Array<{ automationId: string; trigger: Extract<AutomationSpec["trigger"], { type: "schedule" }>; principal: Principal }>
>;
```

In-memory impl: filter `status === "enabled" && triggerKind === "schedule"`, narrow the trigger via `spec.trigger.type === "schedule"`.
- [ ] **Step 4: Run** — green. **Step 5: Commit** `feat(runtime): listEnabledSchedules store method for boot rehydration`

### Task 3: Atomic approval claim on the seam

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts`, `packages/flowlet-runtime/src/automations/runner.ts`
- Test: `packages/flowlet-runtime/src/automations/store.test.ts`, `packages/flowlet-runtime/src/automations/runner.test.ts`

The runner's existing resume API is `resume(...)` returning `AutomationRun | undefined` (`runner.ts:244`) — **the public API does not change**; only how it takes the pending approval off the run becomes an atomic claim.

- [ ] **Step 1: Failing store test** — drive a run to `waiting_approval` (createRun + `updateRun({ outcome: "waiting_approval", pendingApproval })`); first `claimPendingApproval(scope, runId)` returns the `PendingApproval` and the re-read run has none; second call returns `undefined`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — interface:

```ts
/** Atomically take the pending approval off a run. Exactly one caller wins. */
claimPendingApproval(scope: Principal, runId: string): Promise<PendingApproval | undefined>;
```

In-memory: `mustGetRun`; if no `pendingApproval` return `undefined`; copy it, delete from a new run object, store, return the copy.
- [ ] **Step 4: Failing runner test** — spy store: `resume(...)` goes through `claimPendingApproval`; two concurrent `resume(...)` for the same run (Promise.all) → one proceeds, the other resolves `undefined` (the existing "nothing to resume" contract) and the interpreter runs once.
- [ ] **Step 5: Implement** — runner swaps its read-then-clear for the claim; lost claim → return `undefined`, never execute.
- [ ] **Step 6: Run** `pnpm --filter @flowlet/runtime test -- automations` — green. **Commit** `feat(runtime): atomic pending-approval claim; race-free resume`

### Task 4: One-shot `at` schedules complete durably

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/store.ts` (type), the firing-completion path (find it: `createSchedulerFiringHandler` in `packages/flowlet-runtime/src/automations/tools.ts` or `runner.ts` — read both, put the logic where a firing finalizes)
- Test: `packages/flowlet-runtime/src/automations/runner.test.ts`

The spec trigger has **no `kind` field** — a one-shot is `{ type: "schedule", at: string }` (interval/cron shapes use other fields; check `schema.ts:142` region for the exact union). Detect via `trigger.at !== undefined`.

- [ ] **Step 1: Failing test** — drive a firing of an automation whose trigger is `{ type: "schedule", at: <iso> }` **directly through the runner/firing handler** (do not route through scheduler tick — a past `at` never fires there); after the run finalizes, the automation has `status: "paused"` and `disabledReason: "completed_one_shot"`.
- [ ] **Step 2: Run** — FAIL (incl. the `disabledReason` union type error).
- [ ] **Step 3: Implement** — widen: `disabledReason?: "consecutive_failures" | "completed_one_shot"`; after finalize, when the spec trigger is schedule-with-`at`, `setStatus(scope, id, "paused", { disabledReason: "completed_one_shot" })`.
- [ ] **Step 4: Run** — green. **Commit** `feat(runtime): one-shot schedules pause as completed after firing`

### Task 4b: Explicit unattended-tool rejection at authoring time

**Files:**
- Modify: `packages/flowlet-runtime/src/automations/tools.ts`
- Test: `packages/flowlet-runtime/src/automations/tools.test.ts`

- [ ] **Step 1: Failing test** — authoring `create_automation` with a step referencing a tool NOT in `registeredTools` returns the tools' error shape matching `/server-registered|cannot run unattended/i` and creates nothing.
- [ ] **Step 2: Implement** — in create/update handlers, before store writes: walk the spec for every referenced tool (steps incl. branch/for_each children + agent-step `tools` allowlists), diff against `await registeredTools()`, reject naming the offenders and the fix (`automations.tools`).
- [ ] **Step 3: Run** `pnpm --filter @flowlet/runtime test -- automations/tools` — green. **Commit** `feat(runtime): authoring-time rejection of non-server tools in automations`

### Task 5: Upsert semantics on the EXISTING core ThreadStore seam

**Files:**
- Modify: `packages/flowlet-core/src/seams/store.ts`, `packages/flowlet-runtime/src/embedded/in-memory-store.ts`
- Test: `packages/flowlet-runtime/src/embedded/in-memory-store.test.ts` (or create alongside if missing)

Core already defines `ThreadStore` (`create/get/list/appendMessages/getMessages`) and runtime has an embedded in-memory `Store`. Do NOT invent a parallel seam. Add one **additive** method (frozen-surface rule: additive is allowed; `appendMessages` stays untouched):

- [ ] **Step 1: Failing tests** against the runtime in-memory impl — (a) `upsertMessages` inserts two `FlowletUIMessage`s, `getMessages` returns them in order; (b) re-upserting id 1 with new parts → still 2 messages, parts replaced, order preserved; (c) upsert on an unknown thread id auto-creates the thread row (needed because the client owns thread ids — assert `get` finds it after); (d) scope isolation.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — core interface addition:

```ts
/** Upsert by message id: existing messages keep their position, parts are
 *  replaced wholesale (ai-SDK mutates approval parts on resume — ENG-204).
 *  Unknown threadId auto-creates the thread. */
upsertMessages(scope: Principal, threadId: string, messages: FlowletUIMessage[]): Promise<void>;
```

Runtime in-memory impl: per-thread `Map<messageId, { seq, message }>` + `nextSeq` counter; `getMessages` sorts by seq. Check every other implementor of `ThreadStore` in the repo (`grep -rn "ThreadStore" packages apps`) and add the method there too — the demo apps may have one.
- [ ] **Step 4: Run** — green, plus full `pnpm --filter @flowlet/core --filter @flowlet/runtime typecheck` (interface change ripples). **Commit** `feat(core,runtime): ThreadStore.upsertMessages — resume-safe message persistence`

---

## Phase 1 — the `@flowlet/store` package

### Task 6: Package scaffold + async connection factory + migrations runner

**Files:**
- Create: `packages/flowlet-store/package.json`, `tsconfig.json`, `vitest.config.ts` (copy shapes from `packages/flowlet-runtime`), `src/index.ts`, `src/db.ts`, `drizzle.config.ts`, `src/schema.ts` (starts empty; tables next task), `migrations/.gitkeep`
- Test: `packages/flowlet-store/src/db.test.ts`

**Dependency placement (Codex):** `dependencies`: `drizzle-orm`, `@electric-sql/pglite`, `pg`, `@flowlet/core`, `@flowlet/runtime` (runtime is imported for VALUES — `firingRunId`, `DuplicateRunError`, schema parsing — so it's a real dependency, not dev). `devDependencies`: `drizzle-kit`, `@types/pg`, `vitest`. Register the package in the workspace + turbo pipeline like its siblings.

**Creation is async** (PGlite's documented path is `await PGlite.create(...)`; drizzle's pglite adapter takes the client). The factory memoizes a **promise** per cache key; the resolved handle carries its cache key so migration memoization can't collide across tests.

- [ ] **Step 1: Failing tests** (`db.test.ts`, unique `dataDir: "memory://" + suffix` per test): (a) two `createFlowletDatabase()` calls with the same config resolve to the same handle (promise identity); (b) `migrateFlowletDatabase(handle)` twice resolves (idempotent, memoized per handle); (c) `process.env.VERCEL = "1"` + no connection string → rejects matching `/DATABASE_URL/`; (d) `FLOWLET_DATA_DIR` env is honored when no explicit dataDir; (e) an unwritable dataDir (e.g. a path under a read-only file, `chmod 0444` fixture) rejects loudly matching `/writable/i`.
- [ ] **Step 2: Implement** `src/db.ts`:

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

export interface FlowletDatabaseConfig {
  connectionString?: string;
  pglite?: { dataDir: string };
}

export type FlowletDb =
  | { kind: "pglite"; db: ReturnType<typeof drizzlePglite>; cacheKey: string }
  | { kind: "pg"; db: ReturnType<typeof drizzlePg>; cacheKey: string };

const SERVERLESS_ENVS = ["VERCEL", "CF_PAGES", "AWS_LAMBDA_FUNCTION_NAME"] as const;
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const ADVISORY_LOCK_KEY = 7461001;

interface Registry {
  instances: Map<string, Promise<FlowletDb>>;
  migrated: Map<string, Promise<void>>;
}
const registry: Registry = ((globalThis as Record<string, unknown>)["__flowletStoreRegistry"] ??= {
  instances: new Map(),
  migrated: new Map(),
}) as Registry;

export function createFlowletDatabase(config: FlowletDatabaseConfig = {}): Promise<FlowletDb> {
  const conn = config.connectionString ?? process.env["DATABASE_URL"];
  const dataDir = config.pglite?.dataDir ?? process.env["FLOWLET_DATA_DIR"] ?? ".flowlet/data";
  const cacheKey = conn ?? `pglite:${dataDir}`;
  const existing = registry.instances.get(cacheKey);
  if (existing) return existing;

  const created: Promise<FlowletDb> = (async () => {
    if (conn) return { kind: "pg", db: drizzlePg(new Pool({ connectionString: conn })), cacheKey };
    const onServerless = SERVERLESS_ENVS.find((e) => process.env[e]);
    if (onServerless) {
      throw new Error(
        `[flowlet] PGlite (the zero-config store) cannot run on ${onServerless} — filesystems there are ephemeral. ` +
          `Set DATABASE_URL to a hosted Postgres (Supabase, Neon, …) instead.`,
      );
    }
    if (!dataDir.startsWith("memory://")) {
      fs.mkdirSync(dataDir, { recursive: true }); // throws EACCES/EROFS loudly
      fs.accessSync(dataDir, fs.constants.W_OK);  // "not writable" fails boot, never a silent fallback
    }
    const client = await PGlite.create(dataDir);
    return { kind: "pglite", db: drizzlePglite(client), cacheKey };
  })();
  created.catch(() => registry.instances.delete(cacheKey)); // failed boots retry
  registry.instances.set(cacheKey, created);
  return created;
}

/** Idempotent, race-safe (advisory lock on real PG), memoized per handle. */
export function migrateFlowletDatabase(handle: FlowletDb): Promise<void> {
  const memo = registry.migrated.get(handle.cacheKey);
  if (memo) return memo;
  const run = (async () => {
    if (handle.kind === "pglite") {
      await migratePglite(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
      return;
    }
    await handle.db.execute(sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`);
    try {
      await migratePg(handle.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: "flowlet" });
    } finally {
      await handle.db.execute(sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`);
    }
  })();
  run.catch(() => registry.migrated.delete(handle.cacheKey));
  registry.migrated.set(handle.cacheKey, run);
  return run.catch((err) => {
    throw new Error(
      `[flowlet] migration failed — if this is a permissions error, grant the role CREATE on the database ` +
        `or run migrations out-of-band (autoMigrate: false + migrateFlowletDatabase). Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}
```

(If the installed drizzle version's pglite adapter API differs — e.g. `drizzle({ client })` — follow the installed version's types; check via context7/drizzle docs. Error-wrapping shape: make sure the memoized promise itself isn't the wrapped-rejection one twice — adjust so tests pass with a single clear message.)
- [ ] **Step 3: Run** `pnpm --filter @flowlet/store test -- db` — green (empty migrations dir migrates to nothing).
- [ ] **Step 4: Commit** `feat(store): @flowlet/store scaffold — async connection factory, singleton, race-safe boot migrations`

### Task 7: Schema + generated migration

**Files:**
- Modify: `packages/flowlet-store/src/schema.ts`, `drizzle.config.ts`
- Create: `packages/flowlet-store/migrations/0000_*.sql` (generated)
- Test: `packages/flowlet-store/src/schema.test.ts`

- [ ] **Step 1: Write the schema** — all in `pgSchema("flowlet")`; note `threads.nextSeq` (the race-safe seq allocator) and the `meta` table (scheduler heartbeat — DecisionStore is NOT a junk drawer):

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
  nextSeq: integer("next_seq").notNull().default(0),
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
  record: jsonb("record").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.subject, t.id] })]);

export const connections = flowlet.table("connections", {
  toolkit: text("toolkit").notNull(),
  tenantId: text("tenant_id").notNull(),
  subject: text("subject").notNull(),
  connectedAccountId: text("connected_account_id"),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.subject, t.toolkit] }),
  index("connections_account_idx").on(t.connectedAccountId),
]);

/** Tiny operational KV (scheduler heartbeat, future flags). NOT for domain data. */
export const meta = flowlet.table("meta", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
});
```

- [ ] **Step 2: Generate** — `pnpm --filter @flowlet/store exec drizzle-kit generate` (config: schema → `src/schema.ts`, out → `./migrations`, dialect `postgresql`). Inspect: `CREATE SCHEMA "flowlet"` + all 9 tables. Commit the SQL.
- [ ] **Step 3: Schema test** — migrate a fresh PGlite db; insert+read a row in `automations` and `thread_messages` (bigserial + unique indexes exercised). Green.
- [ ] **Step 4: Commit** `feat(store): flowlet-schema tables + generated initial migration`

### Task 8: `DrizzleAutomationStore` (the port)

**Files:**
- Create: `packages/flowlet-store/src/automation-store.ts`
- Test: `packages/flowlet-store/src/automation-store.test.ts`
- Modify: `packages/flowlet-runtime/src/automations/store.ts` (export the `capStep`/`capEnvelope` helpers so the port reuses them — do not fork truncation semantics)

Implements `AutomationEngineStore` incl. Tasks 2–3 additions. **Behavioral spec = `InMemoryAutomationStore`.** Non-negotiables, each with a test:

1. `save()` validates via `automationSpecSchema.parse`, delegates to `create`, honors paused.
2. Principal scoping on every read/write.
3. `create`/`update` write a version row; `update` bumps `currentVersion`, re-derives the trigger index.
4. `createRun`: `firingRunId` PK; PG unique-violation (code `23505`) → rethrow `DuplicateRunError`.
5. Truncation caps via the runtime-exported helpers.
6. `finalizeRun`: `coarseStatus`, clears `pendingApproval`, counters updated **in the same `db.transaction`**; skipped runs store `[]` steps.
7. `cancelPendingRuns` touches only `waiting_approval` runs of that automation+scope.
8. **`claimPendingApproval` — capture-then-clear in ONE statement** (Codex blocker: a plain `RETURNING pending_approval` returns the new NULL):

```sql
WITH claimed AS (
  SELECT id, pending_approval FROM flowlet.automation_runs
  WHERE id = $1 AND tenant_id = $2 AND subject = $3 AND pending_approval IS NOT NULL
  FOR UPDATE SKIP LOCKED
)
UPDATE flowlet.automation_runs r
SET pending_approval = NULL
FROM claimed
WHERE r.id = claimed.id
RETURNING claimed.pending_approval AS claimed_approval;
```

(via `db.execute(sql\`…\`)`; zero rows → `undefined`.)
9. `listEnabledSchedules` cross-scope select.
10. IDs: `auto-${crypto.randomUUID()}`.

- [ ] **Step 1: Contract tests first** — port every scenario from `packages/flowlet-runtime/src/automations/store.test.ts` to run against `DrizzleAutomationStore` on fresh PGlite (`memory://` + unique suffix per file, migrate in `beforeAll`), plus: duplicate `createRun` → `DuplicateRunError`; `Promise.all` double-claim → exactly one wins.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** method-for-method (one class, one file; mirroring the reference beats artificial splitting). **Step 4: Run** — green; typecheck.
- [ ] **Step 5: Runner-over-Drizzle integration test** (spec requires the engine suites against the durable store): add `packages/flowlet-store/src/runner-integration.test.ts` that assembles the real `AutomationRunner` (+ `createAgentStepRunner` stubbed like `runner.test.ts` does) over `DrizzleAutomationStore` and exercises: one deterministic run end-to-end; one waiting_approval pause → `resume` → completion; counters/disable-threshold behavior. Reuse the fixtures from `runner.test.ts`.
- [ ] **Step 6: Commit** `feat(store): DrizzleAutomationStore — engine-store port, CTE claim, runner integration`

### Task 9: Durable decision/thread/flowlet/connections stores

**Files:**
- Create: `packages/flowlet-store/src/decision-store.ts`, `src/thread-store.ts`, `src/flowlet-registry.ts`, `src/connections-store.ts`
- Test: one `.test.ts` per file

Same TDD loop each. All implement EXISTING seams:

- [ ] **Step 1: `createDrizzleDecisionStore(db, scope)`** → runtime `DecisionStore` (`get`/`set`): upsert on PK conflict; tests: miss → undefined; roundtrip; scope isolation.
- [ ] **Step 2: `createDrizzleThreadStore(db)`** → **core** `ThreadStore` (all six methods incl. Task 5's `upsertMessages`). Seq allocation is race-safe via the `threads.nextSeq` counter (Codex: `MAX(seq)+1` double-allocates under concurrency): inside one transaction, `UPDATE flowlet.threads SET next_seq = next_seq + <n_new>, updated_at = now() WHERE … RETURNING next_seq` reserves a block, then insert new messages with reserved seqs and `ON CONFLICT … DO UPDATE SET message = excluded.message` for existing ids. `create` assigns a `crypto.randomUUID()` id + timestamps (store-owned authorship per the seam doc); `upsertMessages` on unknown thread auto-creates with the given id. Tests: Task 5's cases + two parallel upserts of different messages → distinct seqs, no unique violation.
- [ ] **Step 3: `createDrizzleSavedFlowletStore(db)`** → **core** `SavedFlowletStore` (`save` assigns id+timestamps, `get`, `list` updatedAt-desc, `delete`). The whole `SavedFlowlet` record lives in the `record` jsonb column; `updatedAt` is denormalized as a column for ordering. Tests: authorship rule (caller never supplies id/timestamps), list order, delete.
- [ ] **Step 4: `createDrizzleConnectionsStore(db, scope, catalog)`** — implements the structural shape of `ConnectionsStore` (`packages/flowlet-next/src/connections.ts` — read first; duck-typed locally to avoid a next→store→next cycle) with rows in `connections`, plus the two additions the webhook + integrations flow need:

```ts
/** Record the Composio connected-account id once the OAuth flow lands. */
setConnectedAccount(toolkit: string, connectedAccountId: string): Promise<void>;
/** Webhook routing: which principal owns this connected account? */
findByConnectedAccount(connectedAccountId: string): Promise<{ toolkit: string; principal: Principal } | undefined>;
```

Tests: connect → `connectedToolkits()` includes it after a store rebuild (durability); account mapping roundtrip; unknown account → undefined.
- [ ] **Step 5: Run** all suites — green. Export all from `src/index.ts`. **Commit** `feat(store): durable decision/thread/saved-flowlet/connections stores`

---

## Phase 2 — wiring `@flowlet/next`

### Task 10: Full-tail routing table + storage option

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/options.ts`, `packages/flowlet-next/package.json` (add `@flowlet/store` dependency)
- Test: `packages/flowlet-next/src/handler.test.ts`

- [ ] **Step 1: Failing tests** — a route-resolution test table: `…/api/flowlet/chat` → `chat`; `…/webhooks/composio` → `webhooks/composio`; `…/threads` → `threads`; `…/threads/t1` → `threads/t1`; `…/flowlets/f1/delete` → `flowlets/f1/delete`; and (options) `storage: { connectionString }` / `{ pglite: { dataDir } }` / `false` accepted, `storage: 42` rejected.
- [ ] **Step 2: Implement routing** — replace `subPath` with a resolver that returns the tail AFTER the mount. The mount can't be assumed to be `api/flowlet`; resolve it against a known first-segment set:

```ts
const FIRST_SEGMENTS = new Set(["chat", "action", "integrations", "capabilities", "tick", "webhooks", "threads", "flowlets"]);
/** Everything after the catch-all mount: the suffix starting at the FIRST known segment (scanning right-to-left so a host route named e.g. /threads/... upstream can't confuse it). */
function routeTail(req: Request): string {
  const segments = new URL(req.url).pathname.split("/").filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (FIRST_SEGMENTS.has(segments[i]!)) return segments.slice(i).join("/");
  }
  return segments[segments.length - 1] ?? "";
}
```

Existing cases switch on exact matches (`"chat"`, `"tick"`, …); new multi-segment routes match by pattern (`tail === "webhooks/composio"`, `tail.startsWith("threads/")`, …). Regression tests: all five existing endpoints still route.
- [ ] **Step 3: Implement the option** —

```ts
/** Durable storage. Default: PGlite at .flowlet/data (or DATABASE_URL / FLOWLET_DATA_DIR). `false` = in-memory (tests). */
storage?: false | { connectionString?: string; pglite?: { dataDir: string }; autoMigrate?: boolean };
```

zod mirror, `.strict()`. `autoMigrate` default true; false skips boot migrations (out-of-band via exported `migrateFlowletDatabase`).
- [ ] **Step 4: Run** — green. **Commit** `feat(next): full-tail routing + storage handler option`

### Task 11: Async assembly + durable world + boot warnings

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/world.ts`, `packages/flowlet-next/src/world.test.ts`
- Test: `packages/flowlet-next/src/world.test.ts`, `handler.test.ts`

**The async ripple, enumerated (Codex):** `assemble()` becomes `async assemble(): Promise<State>`; the slot becomes `let assembled: Promise<State> | null`; `const state = () => (assembled ??= assemble())`; both `GET`/`POST` start with `const s = await state()`. `createAutomationsWorld` becomes async (rehydration awaits the store). `world.test.ts:7`-region call sites gain `await`. No other production call sites exist (verify: `grep -rn "createAutomationsWorld\|assemble()" packages apps`).

- [ ] **Step 1: Failing tests** — (a) `createAutomationsWorld` with an injected `store` uses it (spy); (b) `storage: false` + `NODE_ENV=production` → one `console.warn` matching `/in-memory/`; (c) default storage + custom `principal` resolver → one warn matching `/single-tenant/`; (d) `GET /capabilities` resolves after async assembly (smoke for the ripple).
- [ ] **Step 2: Implement** — `resolveStorage(options)`: `false` → null; else `await createFlowletDatabase({...})` + (autoMigrate !== false) `await migrateFlowletDatabase(handle)`. Build `DrizzleAutomationStore` and hand it to the world (`CreateWorldConfig.store?: AutomationEngineStore`, default in-memory). Warnings as one-time flags on the assembled state.
- [ ] **Step 3: Run** `pnpm --filter @flowlet/next test` — full suite green (the ripple breaks things loudly; fix them here, not later).
- [ ] **Step 4: Commit** `feat(next): async assembly; durable engine store wired (PGlite default, DATABASE_URL override)`

### Task 12: Scheduler boot — rehydration, `startFlowletScheduler`, tick service auth, heartbeat

**Files:**
- Create: `packages/flowlet-next/src/boot.ts`
- Modify: `packages/flowlet-next/src/world.ts`, `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/index.ts`
- Test: `packages/flowlet-next/src/boot.test.ts`, extend `handler.test.ts`

- [ ] **Step 1: Failing tests** — (a) world assembly with a durable store seeded with 2 enabled schedules registers both (spy `scheduler.schedule`); (b) `startFlowletScheduler()` twice → one started scheduler (globalThis flag); (c) `FLOWLET_SCHEDULER=external` → no-op; (d) `POST /tick` with header `authorization: Bearer <FLOWLET_TICK_SECRET>` succeeds with no principal; wrong secret → 401; unset secret → existing `resolvePrincipal` path unchanged; (e) a successful tick upserts the `meta` row `scheduler_heartbeat`.
- [ ] **Step 2: Implement** — world assembly ends with `for (const s of await store.listEnabledSchedules()) await scheduler.schedule(s.automationId, toTimeTrigger(s.trigger), s.principal)` (write `toTimeTrigger` mapping the spec trigger to the core `TimeTrigger` — check both shapes and map explicitly). `boot.ts`:

```ts
/** Long-lived Node boot: import { startFlowletScheduler } from "@flowlet/next" in instrumentation.ts. */
export function startFlowletScheduler(options: FlowletHandlerOptions = {}): void {
  if (process.env["FLOWLET_SCHEDULER"] === "external") return;
  const g = globalThis as Record<string, unknown>;
  if (g["__flowletSchedulerStarted"]) return;
  g["__flowletSchedulerStarted"] = true;
  void ensureFlowletState(options).then((s) => s.world?.scheduler.start());
}
```

`ensureFlowletState` = the handler's lazy assembly hoisted into a globalThis registry keyed by a stable options identity (module-scope `Symbol` + the options object reference; handler and boot called with the same options share one world — document that `startFlowletScheduler()` with different options than the route is a misuse that creates a second world, and key the registry so the FIRST assembly wins with a warn). Tick: accept the bearer secret before `resolvePrincipal`; on success write heartbeat (`meta` upsert) when durable.
- [ ] **Step 3: Run** — green. Export `startFlowletScheduler`. **Commit** `feat(next): scheduler boot hook + rehydration + tick service auth + heartbeat`

### Task 13: Composio webhook ingress (+ connected-account capture)

**Files:**
- Create: `packages/flowlet-next/src/webhooks.ts`
- Modify: `packages/flowlet-next/src/handler.ts` (route), `packages/flowlet-next/src/integrations.ts` + `connections.ts` (capture `connectedAccountId` — Codex blocker: today `connect(id)` stores only toolkit ids)
- Test: `packages/flowlet-next/src/webhooks.test.ts`, extend `integrations.test.ts`

- [ ] **Step 1: Connected-account capture first** — read `integrations.ts`/`connections.ts`; wherever the Composio OAuth flow lands a successful connection (the status-poll or callback path), persist the Composio `connectedAccountId` via the store's `setConnectedAccount`. Extend the in-memory `ConnectionsStore` with the same two methods (Task 9 shapes) so both impls satisfy the widened contract. Failing test: after a simulated connect flow, `findByConnectedAccount(accountId)` resolves the toolkit+principal.
- [ ] **Step 2: Research pin (30 min, context7/web):** Composio's current webhook signature scheme (headers, HMAC algo, timestamp format) and trigger payload envelope (delivery id, `connectedAccountId`, trigger slug paths). Record as a comment block atop `webhooks.ts`; the verify helper is isolated so a real captured payload at drill time can correct it cheaply.
- [ ] **Step 3: Failing tests** — matrix: missing `COMPOSIO_WEBHOOK_SECRET` → 404; bad signature → 401; stale timestamp (>5 min) → 401; valid sig + malformed JSON → 400; valid + unknown connected account → 200 `{ skipped: true }`; valid + known account + matching enabled automation → runner fired under the connection's principal, `eventId` = delivery id; redelivery → 200, runner not re-invoked (`DuplicateRunError` swallowed).
- [ ] **Step 4: Implement** `handleComposioWebhook(req, deps)` — `const raw = await req.text()` BEFORE parsing (HMAC over raw bytes), `crypto.timingSafeEqual`; then parse → `findByConnectedAccount` → `findEnabledByTrigger({ kind: "composio", key: slug })` under that principal → envelope → fire via the same pipeline host events use (read `host-events.ts` and reuse its ingest helper if it fits; else call the runner exactly as `createSchedulerFiringHandler` does). Route `webhooks/composio` in the handler.
- [ ] **Step 5: Run** — green. Correct the stale "cloud-only" comment in `in-process-scheduler.ts` (now: "needs a reachable webhook URL — see @flowlet/next webhooks"). **Commit** `feat(next): signature-verified Composio webhook ingress (single-tenant v1)`

### Task 14: Thread persistence through `/chat`

**Files:**
- Modify: `packages/flowlet-next/src/chat.ts`, `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/client/flowlet-root.tsx`
- Test: `packages/flowlet-next/src/chat.test.ts`

`FlowletAgent.run()` returns a plain `ReadableStream` — there is no `onFinish` hook (Codex). Capture the assistant message by TEEING the UIMessage stream and reducing it server-side.

- [ ] **Step 1: Failing tests** — (a) chat with `threadId` upserts incoming client messages pre-stream and the final assistant message post-stream (stub agent emitting a fixed UIMessage-chunk sequence — follow `chat.test.ts`'s existing stubbing; assert by CONSUMING the response body fully, then reading the store); (b) resume re-send with mutated approval parts (same ids) → updated rows, not duplicates; (c) no `threadId` → nothing persisted; (d) `GET threads` lists metadata; `GET threads/<id>` returns seq-ordered messages.
- [ ] **Step 2: Implement** — body gains `threadId?: string`. When present + ThreadStore wired: `await threads.upsertMessages(scope, threadId, body.messages)` pre-stream; then `const [a, b] = stream.tee()` — respond with `a`, and consume `b` through the ai SDK's UIMessage-stream reader (`readUIMessageStream` from `ai` if exported in the installed version — check; else accumulate the chunks and reduce to the final UIMessage per the UIMessage-chunk protocol used in the engine tests) and upsert the terminal assistant message `after` the stream closes (fire-and-forget with error logging — a persistence failure must not kill the response). Add the two GET routes (principal-guarded). `FlowletRoot`: pass `body: { threadId }` on `DefaultChatTransport` (verify the installed ai-SDK supports the static `body` option; it does in v5 — confirm at implementation).
- [ ] **Step 3: Run** — green. **Commit** `feat(next): durable chat threads (upsert-by-message-id, tee-captured assistant turns)`

### Task 15: Saved flowlets — server endpoints + client adapter

**Files:**
- Create: `packages/flowlet-next/src/flowlets.ts`, `packages/flowlet-next/src/client/server-store.ts`
- Modify: `packages/flowlet-next/src/handler.ts`, `packages/flowlet-next/src/client/flowlet-root.tsx`, `packages/flowlet-next/src/capabilities.ts`
- Test: `packages/flowlet-next/src/flowlets.test.ts`, `packages/flowlet-next/src/client/server-store.test.ts`

- [ ] **Step 1: Read seams** — server side implements core `SavedFlowletStore` (Task 9); the CLIENT seam is the shell's `FlowletStore` (`packages/flowlet-shell/src/seams/store.ts` — read it; its `Flowlet` record differs from core's `SavedFlowlet`). The endpoints speak the SHELL record shape (that's what the client stores today; `record` jsonb column holds it verbatim) — implement the server store as a thin registry over the shell shape and note in code that core's `SavedFlowlet` reconciliation happens when cloud lands (don't force a lossy mapping now; YAGNI).
- [ ] **Step 2: Failing endpoint tests** — `GET flowlets` → list; `GET flowlets/<id>` → record or 404; `POST flowlets` (body = draft) → saved with server timestamps; `POST flowlets/<id>/delete` → gone. Principal-guarded like `/chat`.
- [ ] **Step 3: Implement** endpoints over the Drizzle registry.
- [ ] **Step 4: Failing client tests** — `createServerFlowletStore(basePath)` implements the shell seam over `fetch`; a 500 THROWS (web-storage's "failures are loud" contract); happy paths roundtrip.
- [ ] **Step 5: Wire by capability** — `detectCapabilities`/assembly add `storage: boolean`; `flowlet-root.tsx` picks `capabilities?.storage ? createServerFlowletStore(basePath) : createWebStorage(...)`. No localStorage migration in v1 (document in the deploy guide).
- [ ] **Step 6: Run** full `pnpm --filter @flowlet/next test` — green. **Commit** `feat(next): durable saved flowlets — endpoints + server-backed client store`

### Task 16: Decisions actually wired (remember layer + onExecuted)

**Files:**
- Modify: `packages/flowlet-next/src/handler.ts` (assembly), `packages/flowlet-next/src/action.ts`
- Test: extend `handler.test.ts` + `action.test.ts`

Codex ground truth: NO remember layer wraps the policy today, and `/action` never calls `policy.onExecuted` — durable decisions need both ends built, not just swapped.

- [x] **Step 1: Failing tests** — (a) with durable storage, an approved-and-executed action for tool+input X makes the NEXT `policy.evaluate` for identical X return allow (the remember contract) — and still does after rebuilding assembly from the same PGlite dir; (b) a DENIED action never memoizes (re-prompts); (c) without durable storage, behavior is unchanged (no remember layer, or in-memory remember — pick: **in-memory remember when storage off**, keeping semantics uniform; test accordingly).
- [x] **Step 2: Implement** — assembly: `policy = rememberDecisions(basePolicy, { store: decisionStore, policyVersion: <existing constant or "v1"> })` (read `remember.ts` for the exact factory signature); `action.ts`: after a successful approved execution, `await policy.onExecuted?.(ctx)` with the same `PolicyContext` used for evaluate (find the execute-success point, ~line 127 region).
- [x] **Step 3: Run** — green. **Commit** `feat(next): ask-once-remember wired end-to-end with durable decisions`

---

## Phase 3 — install DX, docs, drill

### Task 17: CLI codemod — instrumentation.ts + env docs

**Files:**
- Modify: `packages/flowlet-cli/src/next-wiring.ts` (+ test), `packages/flowlet-cli/src/init.ts` if it orchestrates wiring (read first)
- Test: `packages/flowlet-cli/src/next-wiring.test.ts`

- [ ] **Step 1: Failing tests** — codemod (a) creates `instrumentation.ts` at the detected app root (reuse the route-file root detection) with:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startFlowletScheduler } = await import("@flowlet/next");
    startFlowletScheduler();
  }
}
```

(b) merges into an existing `instrumentation.ts` non-destructively, or writes `instrumentation.flowlet-example.ts` + prints a manual step when it can't (follow the codemod's existing conflict convention); (c) `.env.example` gains commented `DATABASE_URL`, `FLOWLET_DATA_DIR`, `FLOWLET_TICK_SECRET`, `COMPOSIO_WEBHOOK_SECRET`, `FLOWLET_SCHEDULER` entries; (d) idempotent re-run.
- [ ] **Step 2: Implement** in next-wiring's style. **Step 3: Run** `pnpm --filter flowlet-cli test -- next-wiring` — green. **Commit** `feat(cli): init wires instrumentation.ts scheduler boot + storage env docs`

### Task 18: Docs

**Files:**
- Modify: `docs/quickstart.md`
- Create: `docs/persistence-and-deploy.md`

- [ ] **Step 1:** `persistence-and-deploy.md` — succinct: the one storage knob (PGlite default / `DATABASE_URL` / `storage: false`); what persists (all five surfaces); single-writer + single-tenant posture, verbatim honest; scheduler modes (instrumentation auto-start; `FLOWLET_SCHEDULER=external` + `vercel.json` cron and Cloudflare Cron Trigger examples hitting `/tick` with the bearer secret); Composio webhook setup (dashboard URL, secret env, tunnel for local dev); migrations (`autoMigrate: false` + out-of-band path); no localStorage→server flowlet migration in v1.
- [ ] **Step 2:** `quickstart.md` — persistence paragraph + link; endpoint list additions (`webhooks/composio`, `threads`, `flowlets`); `instrumentation.ts` in the init inventory.
- [ ] **Step 3: Commit** `docs: persistence + deploy guide; quickstart updates`

### Task 19: The kill-the-server drill (scripted)

**Files:**
- Create: `scripts/drill-persistence.mjs` (check whether a root `scripts/` exists; else `packages/flowlet-next/scripts/`)

- [ ] **Step 1: Write the script** — drives spec acceptance 1–4 against `apps/demo-bank`: seed deterministically by importing `@flowlet/store` against a temp `FLOWLET_DATA_DIR` (create an automation with a ~1-minute cron trigger + valid grant via `DrizzleAutomationStore` + `computeGrant` from runtime, a saved flowlet, a thread with messages, a decision); boot `next start` (child process, same env); assert via HTTP that state reads back; `SIGKILL`; reboot; re-assert all four surfaces; wait ≤75s with NO client request for the cron to fire (instrumentation boot must start the timer); poll run history via the store; assert a succeeded run honoring the grant (no `waiting_approval`). Exit non-zero on any failed assertion, printing which.
- [ ] **Step 2: Run on PGlite** — fix what breaks (this step finds the real integration bugs; each fix commits in the package it touches).
- [ ] **Step 3: Run with `DATABASE_URL`** on local Docker Postgres (`docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=flowlet postgres:16`) as the Supabase stand-in. Live Supabase + live Composio webhook = release-time on a deployed host (spec items 5–6).
- [ ] **Step 4: Commit** `test: kill-the-server persistence drill script`

### Task 20: Full-repo verification + PR

- [ ] **Step 1:** `pnpm build && pnpm typecheck && pnpm lint && pnpm test` at root — green.
- [ ] **Step 2:** Browser pass (repo rule): run demo-bank, exercise chat + save a flowlet + author an automation, restart the server, screenshot surviving state for the PR.
- [ ] **Step 3:** Open the PR (never merge): spec link, decision summary, drill output, screenshots; call out the Yousef-gated items (last-ticked UI unbuilt, single-tenant posture) and that PR #35 executes separately from its own plan.

---

## Explicitly deferred to their own tracks

- **PR #34** — Yousef reviews/merges; rebase over it if it lands first (watch for handler route/verb additions on `yousefh409/interface` at rebase time — Task 15 note).
- **PR #35 (source-baseline)** — executed from its existing spec+plan on `yousefh409/remix-source-baseline` after this plan completes.
- Live-Supabase + live-Composio drill passes — release-time, deployed host.
- Real-Postgres CI job for the migration/advisory-lock race — add to CI config only if a Postgres service container is already conventional in this repo's CI; otherwise document `docker`-based local verification in the deploy guide and defer the CI wiring (don't invent CI infrastructure mid-plan).
