#!/usr/bin/env node
/**
 * Offline store access for the kill-the-server persistence drill
 * (docs/superpowers/plans/2026-07-04-automations-oss-persistence.md Task 19).
 *
 * Deliberately a SEPARATE short-lived process from the orchestrator
 * (drill-persistence.mjs): PGlite is single-process, so the data dir may only
 * be touched here while the demo-bank server (a different process) is down.
 * Each invocation opens the store, does one job, and exits — releasing
 * whatever the PGlite/pg client holds before the caller starts (or restarts)
 * the server.
 *
 * Usage:
 *   node drill-persistence-store.mjs seed             — create the fixtures
 *   node drill-persistence-store.mjs verify <autoId>   — read run history + the decision back
 *
 * Env: FLOWLET_DATA_DIR (PGlite) or DATABASE_URL (Postgres) — same env the
 * server itself resolves storage from (see packages/flowlet-next/src/storage.ts).
 */
import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCOPE,
  DRILL_ECHO_DESCRIPTOR,
  AUTOMATION_SPEC_INPUT,
  FLOWLET_ID,
  THREAD_ID,
  THREAD_MESSAGES,
  DECISION_CONTEXT,
  DECISION_POLICY_VERSION,
} from "./drill-persistence.constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

// @flowlet/runtime's (and transitively @flowlet/core's) dist output uses
// bundler-style extensionless relative imports — only resolvable through a
// bundler or vitest, not plain Node ESM. @flowlet/store depends on
// @flowlet/runtime at runtime (see its package.json), so loading it here
// needs the same normalization a bundler applies. See the hook file's doc
// comment for the full story.
register("./drill-persistence-loader-hook.mjs", import.meta.url);

const storeIndex = path.join(repoRoot, "packages/flowlet-store/dist/index.js");
const runtimeIndex = path.join(repoRoot, "packages/flowlet-runtime/dist/index.js");

const [
  {
    createFlowletDatabase,
    migrateFlowletDatabase,
    DrizzleAutomationStore,
    createDrizzleThreadStore,
    createDrizzleDecisionStore,
    savedFlowlets,
    and,
    eq,
  },
  { automationSpecSchema, computeGrant, canonicalKey },
] = await Promise.all([import(storeIndex), import(runtimeIndex)]);

async function openHandle() {
  const handle = await createFlowletDatabase({});
  await migrateFlowletDatabase(handle);
  return handle;
}

/**
 * Mirrors `createDrizzleFlowletRegistry` (packages/flowlet-next/src/flowlets.ts)
 * against the SAME `saved_flowlets` table — inlined here rather than deep-
 * imported from @flowlet/next's dist, whose compiled relative imports (e.g.
 * "./guard", no ".js") are only resolvable through a bundler, not plain Node
 * ESM (unlike @flowlet/store and @flowlet/runtime, which are written to run
 * standalone). The row shape only needs to match what the `/flowlets` HTTP
 * endpoints read — which table + columns, not which file wrote it.
 */
async function saveFlowletFixture(handle, scope, draft) {
  const updatedAt = draft.updatedAt ?? Date.now();
  const record = { ...draft, updatedAt };
  const updatedAtIso = new Date(updatedAt).toISOString();
  await handle.db
    .insert(savedFlowlets)
    .values({ id: draft.id, tenantId: scope.tenantId, subject: scope.subject, record, updatedAt: updatedAtIso })
    .onConflictDoUpdate({
      target: [savedFlowlets.tenantId, savedFlowlets.subject, savedFlowlets.id],
      set: { record, updatedAt: updatedAtIso },
    });
  return record;
}

async function loadFlowletFixture(handle, scope, id) {
  const rows = await handle.db
    .select()
    .from(savedFlowlets)
    .where(and(eq(savedFlowlets.tenantId, scope.tenantId), eq(savedFlowlets.subject, scope.subject), eq(savedFlowlets.id, id)));
  return rows[0] ? rows[0].record : null;
}

async function seed() {
  const handle = await openHandle();

  const spec = automationSpecSchema.parse(AUTOMATION_SPEC_INPUT);
  const step = spec.execution.mode === "steps" ? spec.execution.steps[0] : null;
  const grant = computeGrant({
    tool: "drill_echo",
    descriptor: DRILL_ECHO_DESCRIPTOR,
    spec,
    step,
    now: new Date().toISOString(),
  });

  const automationStore = new DrizzleAutomationStore(handle);
  const { automation } = await automationStore.create(SCOPE, {
    spec,
    grants: [grant],
    createdBy: "user_edit",
  });

  await saveFlowletFixture(handle, SCOPE, {
    id: FLOWLET_ID,
    name: "Drill flowlet",
    node: { id: "n1", kind: "generated", payload: { text: "drill fixture" } },
    prompt: "seed flowlet for the persistence drill",
  });

  const threads = createDrizzleThreadStore(handle);
  await threads.upsertMessages(SCOPE, THREAD_ID, THREAD_MESSAGES);

  const decisions = createDrizzleDecisionStore(handle, SCOPE);
  await decisions.set(canonicalKey(DECISION_CONTEXT, DECISION_POLICY_VERSION), "approve");

  process.stdout.write(JSON.stringify({ ok: true, automationId: automation.id }) + "\n");
}

async function verify(automationId) {
  if (!automationId) throw new Error("verify requires an automationId argument");
  const handle = await openHandle();

  const automationStore = new DrizzleAutomationStore(handle);
  const runs = await automationStore.listRuns(SCOPE, automationId);

  const decisions = createDrizzleDecisionStore(handle, SCOPE);
  const decision = await decisions.get(canonicalKey(DECISION_CONTEXT, DECISION_POLICY_VERSION));

  const flowlet = await loadFlowletFixture(handle, SCOPE, FLOWLET_ID);

  const threads = createDrizzleThreadStore(handle);
  const messages = await threads.getMessages(SCOPE, THREAD_ID);

  process.stdout.write(JSON.stringify({ ok: true, runs, decision, flowlet, messages }) + "\n");
}

const [, , cmd, arg] = process.argv;
try {
  if (cmd === "seed") await seed();
  else if (cmd === "verify") await verify(arg);
  else throw new Error(`unknown command "${cmd}" — expected "seed" or "verify <automationId>"`);
  process.exit(0);
} catch (err) {
  console.error("[drill-store]", err);
  process.exit(1);
}
