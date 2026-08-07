/** J10 — MULTI-TENANT CONCURRENCY: isolation holds under a real race.
 *
 * N distinct signed-in tenants drive chat + apps + automations THROUGH THE WIRE
 * concurrently (Promise.all — genuinely interleaved on one composed umbrella and
 * one shared store), then the suite asserts the one-security-rule ownership
 * boundary survived the race:
 *
 *   - each tenant's thread / app / automation-run is visible ONLY to that tenant,
 *   - no tenant can open another tenant's app or run over the wire,
 *   - the store's per-subject row counts are exactly right (no cross-write), and
 *   - each tenant's away automation produced exactly ITS invoice, once.
 *
 * This also pins the automations tick/emit path under concurrency (the surface
 * the perf lane is changing): N concurrent `vendo.emit`s must each fan out to
 * exactly the emitting principal's enabled app.
 *
 * Model note: the shared scripted model is a single FIFO, so a concurrent turn
 * that pulled a multi-part (tool→generate→text) sequence could interleave across
 * requests. The chat leg therefore uses a SINGLE identical text turn per tenant
 * (one pull each, order-independent); apps + automations enter through the
 * model-free wire paths (/apps/import, enable/approve, vendo.emit).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AppDocument, Principal } from "@vendoai/core";
import {
  createStack,
  decideApprovals,
  hostFetch,
  importAutomation,
  loginCookie,
  readSse,
  resetFixture,
  textTurn,
  waitForRunStatus,
  type Stack,
  type WireApproval,
} from "./harness.js";

const CREATE = "host_invoices_create";
const EVENT = "j10.tenant.tick";

const TENANTS: Principal[] = [
  { kind: "user", subject: "user_ada" },
  { kind: "user", subject: "user_bob" },
  { kind: "user", subject: "user_cleo" },
  { kind: "user", subject: "user_dan" },
];

/** A tenant-tagged single-node app document (no trigger). */
function tenantApp(subject: string): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_placeholder",
    name: `App for ${subject}`,
    tree: {
      formatVersion: "vendo-genui/v2",
      root: "root",
      nodes: [
        { id: "root", component: "Stack", source: "prewired", children: ["t"] },
        { id: "t", component: "Text", source: "prewired", props: { text: `Owned by ${subject}` } },
      ],
    },
  } as AppDocument;
}

/** A tenant-tagged host-event automation that creates one invoice. */
function tenantAutomation(subject: string): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_placeholder",
    name: `Automation for ${subject}`,
    trigger: {
      on: { kind: "host-event", event: EVENT },
      run: {
        kind: "steps",
        steps: [{
          id: "create",
          tool: CREATE,
          args: { customerId: "'cus_j10'", amountCents: "111", currency: "'USD'", memo: `'J10 ${subject}'` },
        }],
      },
    },
  } as AppDocument;
}

async function hostInvoiceMemos(subject: string): Promise<string[]> {
  const response = await hostFetch("/api/invoices", subject);
  const invoices = ((await response.json()) as { invoices: Array<{ memo: string }> }).invoices;
  return invoices.map((invoice) => invoice.memo);
}

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J10: multi-tenant isolation holds under concurrent chat/apps/automations", () => {
  it("keeps every tenant's threads, apps, and away runs private through a real race", async () => {
    await resetFixture();
    // Pre-warm each tenant's host login cookie SEQUENTIALLY so the concurrent
    // phases below stress the fast in-process VENDO wire (the isolation surface
    // under test) rather than firing N cold logins at the host dev server at once.
    for (const tenant of TENANTS) await loginCookie(tenant.subject);
    // One identical text turn per tenant chat call (order-independent single pull).
    stack = await createStack({ turns: TENANTS.map((_, index) => textTurn("Working on it.", `t_${index}`)) });

    // --- Phase 1: chat + app import, all tenants at once ----------------------
    const created = await Promise.all(TENANTS.map(async (tenant, index) => {
      const chat = await readSse(await stack.wireFetch("/threads", {
        method: "POST",
        body: JSON.stringify({
          threadId: `thr_${tenant.subject}`,
          message: { id: `u_${index}`, role: "user", parts: [{ type: "text", text: `Hi from ${tenant.subject}` }] },
        }),
      }, tenant));
      expect(chat.raw.includes("Working on it.")).toBe(true);
      const app = await importAutomation(stack, tenantApp(tenant.subject), tenant);
      return { tenant, appId: app.id };
    }));
    const appIdBySubject = new Map(created.map(({ tenant, appId }) => [tenant.subject, appId]));

    // --- Phase 2: import+enable+approve+fire an automation, all at once --------
    const runs = await Promise.all(TENANTS.map(async (tenant) => {
      const automation = await importAutomation(stack, tenantAutomation(tenant.subject), tenant);
      const enabled = (await (await stack.wireFetch(`/automations/${automation.id}/enable`, { method: "POST" }, tenant)).json()) as {
        enabled: boolean;
        missing: WireApproval[];
      };
      expect(enabled.enabled).toBe(true);
      await decideApprovals(stack, enabled.missing.map((request) => request.id), { approve: true }, tenant);
      const runIds = await stack.vendo.emit(EVENT, { by: tenant.subject }, tenant);
      expect(runIds).toHaveLength(1);
      const run = await waitForRunStatus(stack, runIds[0]!, tenant, "ok");
      return { tenant, automationId: automation.id, runId: run.id };
    }));

    // --- Isolation: each tenant sees ONLY its own thread / app / run ----------
    for (const { tenant } of created) {
      const threads = (await (await stack.wireFetch("/threads", {}, tenant)).json()) as Array<{ id: string }>;
      expect(threads.map((thread) => thread.id)).toEqual([`thr_${tenant.subject}`]);

      const apps = (await (await stack.wireFetch("/apps", {}, tenant)).json()) as Array<{ id: string }>;
      const ownAppId = appIdBySubject.get(tenant.subject)!;
      expect(apps.map((app) => app.id)).toContain(ownAppId);
      // None of the OTHER tenants' apps are visible.
      for (const other of created) {
        if (other.tenant.subject === tenant.subject) continue;
        expect(apps.map((app) => app.id)).not.toContain(other.appId);
      }
    }

    // --- Cross-tenant negative: cannot open another tenant's app or run -------
    const [first, second] = created;
    const crossApp = await stack.wireFetch(`/apps/${second!.appId}/open`, {}, first!.tenant);
    expect(crossApp.ok).toBe(false);
    const otherRun = runs.find((run) => run.tenant.subject === second!.tenant.subject)!;
    const crossRun = await stack.wireFetch(`/runs/${otherRun.runId}`, {}, first!.tenant);
    expect(crossRun.ok).toBe(false);

    // --- Store-level counts: exactly one owned row per tenant, no cross-write --
    const appRows = await stack.sql<{ subject: string; count: number }>(
      "SELECT subject, COUNT(*)::int AS count FROM vendo_apps GROUP BY subject",
    );
    // 2 apps per tenant (the plain app + the automation app document).
    for (const tenant of TENANTS) {
      expect(Number(appRows.find((row) => row.subject === tenant.subject)?.count)).toBe(2);
    }
    // vendo_runs is keyed by app_id; a run's owner is its app's subject.
    const runRows = await stack.sql<{ subject: string; count: number }>(
      "SELECT a.subject AS subject, COUNT(*)::int AS count FROM vendo_runs r JOIN vendo_apps a ON a.id = r.app_id GROUP BY a.subject",
    );
    for (const tenant of TENANTS) {
      expect(Number(runRows.find((row) => row.subject === tenant.subject)?.count)).toBe(1);
    }

    // --- Each away automation produced exactly ITS invoice, once --------------
    const memos = await hostInvoiceMemos("user_ada");
    for (const tenant of TENANTS) {
      expect(memos.filter((memo) => memo === `J10 ${tenant.subject}`)).toHaveLength(1);
    }
  });
});
