/** The effect ledger's re-run guarantee, across a full store reload.
 *
 * `fail-loud.e2e.test.ts` proves a re-run does not repeat a completed effect
 * within one process. That is the easy half: the guard's in-memory ordinal map
 * still holds the failed run's call, so a stale implementation could pass on
 * instance memory alone. THIS suite closes the database and reopens it under a
 * completely fresh guard and engine before re-running, so the only place the
 * receipt can possibly be found is the PERSISTED ledger.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createStore } from "@vendoai/store";
import { createGuard } from "@vendoai/guard";
import { createActions } from "@vendoai/actions";
import { createApps } from "@vendoai/apps";
import { automationsInternals, createAutomations } from "@vendoai/automations";
import {
  appsAutomationsSeam,
  fixtureActAs,
  fixtureBaseUrl,
  fixtureFetch,
  hostTools,
  ownerCtx,
  resetFixture,
  type Stack,
} from "../src/harness.js";
import { ADA, approve, fixtureInvoices, waitForRun } from "../src/support.js";

const MEMO = "ledger-reload";

/** A whole stack over a CALLER-OWNED data dir, so the same database can be
 *  closed and reopened under new instances. The umbrella's own wiring: the
 *  automations engine is composed with no app concepts at all, and the create
 *  operation it owns is what the apps runtime is handed. */
async function compose(dataDir: string): Promise<Stack> {
  const store = createStore({ dataDir });
  await store.ensureSchema();
  const guard = createGuard({ store });
  const actions = createActions({
    tools: hostTools as unknown as Parameters<typeof createActions>[0]["tools"],
    baseUrl: fixtureBaseUrl(),
    actAs: fixtureActAs,
    fetch: fixtureFetch,
  });
  const bound = guard.bind(actions);
  const automations = createAutomations({ tools: bound, guard, store });
  const internals = automationsInternals(automations);
  return {
    store,
    guard,
    bound,
    apps: createApps({
      store,
      guard,
      tools: bound,
      catalog: [],
      automations: appsAutomationsSeam(automations, internals.create),
    }),
    automations,
    create: internals.create,
    runners: internals.runners,
    reconcile: internals.reconcile,
    async putApp(subject, doc) {
      await store.records("vendo_apps").put({ id: doc.id, data: { subject, enabled: false, doc }, refs: { subject } });
    },
    async sql<Row = Record<string, unknown>>(query: string, params?: unknown[]): Promise<Row[]> {
      const raw = store.raw() as { query(q: string, p?: unknown[]): Promise<{ rows: unknown[] }> };
      return (await raw.query(query, params)).rows as Row[];
    },
    // The dataDir outlives this stack on purpose — the suite owns it.
    async close() {
      await store.close();
    },
  };
}

describe("re-run effect ledger — across a store reload", () => {
  beforeEach(resetFixture);

  it("replays the failed run's receipt under a fresh guard that never saw the call", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-rerun-ledger-"));
    const ctx = ownerCtx(ADA.subject);
    try {
      let failedRunId: string;
      let automationId: string;
      const first = await compose(dataDir);
      try {
        const created = await first.create({
          owner: ADA,
          when: { event: "invoice.reload" },
          task: {
            kind: "steps",
            steps: [
              // Lands before the miss — the effect a re-run must NOT repeat.
              { id: "log", tool: "host_invoices_create", args: { customerId: "'cus_ada'", amountCents: "101", memo: `'${MEMO}'` } },
              // The miss: nobody has allowed this one yet.
              { id: "sweep", tool: "host_invoices_update", args: { id: "event.id", memo: `'${MEMO}-swept'` } },
            ],
          },
          authoredBy: "chat",
        }, ctx);
        automationId = created.id;
        const enabled = await first.automations.enable(created.id, ctx);
        // Only the first step is allowed, so the run fails loud at the second.
        await approve(first, enabled.missing.filter((request) => request.call.tool === "host_invoices_create"));

        const [runId] = await first.automations.emit("invoice.reload", { id: "inv_0003" }, ADA);
        if (runId === undefined) throw new Error("emit did not return a run id");
        failedRunId = runId;
        expect((await first.automations.runs.get(runId, ctx))?.status).toBe("error");
        // The first step's effect landed exactly once, and is ledgered.
        expect((await fixtureInvoices()).filter(({ memo }) => memo === MEMO)).toHaveLength(1);
        // Its own reserved table, keyed by the effect key.
        expect(await first.sql("SELECT key FROM vendo_effects")).toHaveLength(1);

        // Allow the missing permission — the same decision door arming uses.
        const captures = await first.sql<{ id: string }>(
          "SELECT id FROM vendo_records WHERE collection = 'automations:captures'",
        );
        const approvalId = captures[0]?.id;
        if (approvalId === undefined) throw new Error("the miss captured no ask");
        await first.guard.approvals.decide(approvalId, { approve: true }, ADA);
      } finally {
        await first.close();
      }

      // A COMPLETELY fresh guard and engine over the same database. Nothing is
      // carried in memory: no ordinal map, no in-flight table, no run state.
      const second = await compose(dataDir);
      try {
        // The record survived the reload too — a re-run is refused unless it is
        // still armed, and nothing in this suite disarmed it.
        expect((await second.automations.get(automationId, ctx))?.armed).toBe(true);

        const rerunId = await second.automations.runs.rerun(failedRunId, ctx);
        expect(rerunId).not.toBe(failedRunId);
        expect((await waitForRun(second, rerunId, ctx, "ok")).automationId).toBe(automationId);

        // The step that was MISSED did its work…
        expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.memo).toBe(`${MEMO}-swept`);
        // …and the step that had already LANDED did not happen again. The only
        // way to know that, here, is the row in `vendo_effects`.
        expect((await fixtureInvoices()).filter(({ memo }) => memo === MEMO)).toHaveLength(1);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
