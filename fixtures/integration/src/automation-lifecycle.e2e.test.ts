/** J4 — AUTOMATION LIFECYCLE through the composed wire.
 *
 * The automation ENTERS through the public wire: a `.vendoapp` archive carrying an
 * AppDocument with a `trigger` is POSTed to /apps/import (import re-mints the id),
 * then armed with POST /automations/:id/enable — whose grant-capture flow returns
 * one ApprovalRequest per referenced tool. Deciding them over the wire mints
 * standing, app-bound, `source:"automation"` grants (SQL).
 *
 * Both PUBLIC trigger paths are fired:
 *   (a) schedule — a due `at` + POST /tick with the bearer secret;
 *   (b) host-event — `vendo.emit(event, payload, ADA)`.
 * Each away run executes its steps against the REAL host app through `actAs`, so
 * the created invoice is observable on the host API, GET /runs shows "ok" with the
 * step outcomes, and (b) also proves dry-run previews and disable stops firing.
 *
 * Schedule-semantics note: `createVendo` takes no `now`, so the schedule leg uses
 * a PAST `at` (due on the first /tick after enable) rather than an `every`/`cron`
 * that would need real wall-clock minutes to elapse.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AppDocument } from "@vendoai/core";
import {
  ADA,
  createStack,
  decideApprovals,
  hostFetch,
  importAutomation,
  pastAtIso,
  resetFixture,
  waitForRunStatus,
  type Stack,
  type WireApproval,
} from "./harness.js";

const CREATE = "host_invoices_create";

interface Invoice {
  id: string;
  memo: string;
  amountCents: number;
  status: string;
}

async function hostInvoices(): Promise<Invoice[]> {
  const response = await hostFetch("/api/invoices", ADA.subject);
  expect(response.status).toBe(200);
  return ((await response.json()) as { invoices: Invoice[] }).invoices;
}

type TriggerOn = { kind: "schedule"; at: string } | { kind: "host-event"; event: string };

/** A steps automation that creates one invoice from static JSONata args. */
function createInvoiceAutomation(on: TriggerOn, memo: string): AppDocument {
  return {
    format: "vendo/app@1",
    id: "app_import_placeholder", // re-minted by import
    name: "J4 invoice automation",
    trigger: {
      on,
      run: {
        kind: "steps",
        steps: [
          {
            id: "create",
            tool: CREATE,
            args: {
              customerId: "'cus_j4'",
              amountCents: "424242",
              currency: "'USD'",
              memo: `'${memo}'`,
            },
          },
        ],
      },
    },
  };
}

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("J4: automation lifecycle through the composed wire", () => {
  it("(schedule) imports, enables+captures grants, then a due `at` fires on /tick and creates the invoice for real", async () => {
    await resetFixture();
    stack = await createStack();
    const MEMO = "J4 scheduled invoice";

    // --- Import through the wire: import re-mints the id -------------------
    const imported = await importAutomation(
      stack,
      createInvoiceAutomation({ kind: "schedule", at: pastAtIso() }, MEMO),
      ADA,
    );
    expect(imported.id).not.toBe("app_import_placeholder");
    expect(imported.id.startsWith("app_")).toBe(true);
    const appId = imported.id;

    // --- Enable: the capture flow surfaces one approval per referenced tool -
    const enabled = (await (await stack.wireFetch(`/automations/${appId}/enable`, { method: "POST" }, ADA)).json()) as {
      enabled: boolean;
      missing: WireApproval[];
    };
    expect(enabled.enabled).toBe(true);
    expect(enabled.missing.map((request) => request.call.tool)).toEqual([CREATE]);

    // --- Decide approve → standing, app-bound, source:"automation" grants --
    expect((await decideApprovals(stack, enabled.missing.map((request) => request.id), { approve: true }, ADA)).status)
      .toBe(200);
    const grants = await stack.sql<{ subject: string; tool: string; app_id: string; source: string; duration: string }>(
      "SELECT subject, tool, app_id, source, duration FROM vendo_grants WHERE app_id = $1",
      [appId],
    );
    expect(grants).toEqual([
      { subject: ADA.subject, tool: CREATE, app_id: appId, source: "automation", duration: "standing" },
    ]);

    // Nothing has run yet: no invoice with our memo.
    expect((await hostInvoices()).some((invoice) => invoice.memo === MEMO)).toBe(false);

    // --- Fire the schedule: POST /tick with the bearer secret --------------
    const tick = await stack.wireFetch("/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.VENDO_TICK_SECRET}` },
    });
    expect(tick.status).toBe(200);
    const runIds = ((await tick.json()) as { runIds: string[] }).runIds;
    expect(runIds.length).toBe(1);
    const runId = runIds[0]!;

    // --- Observe: run ok, step outcome ok, REAL host side effect ------------
    const run = await waitForRunStatus(stack, runId, ADA, "ok");
    expect(run.appId).toBe(appId);
    expect(run.steps.map(({ id, tool, outcome }) => ({ id, tool, outcome }))).toEqual([
      { id: "create", tool: CREATE, outcome: "ok" },
    ]);

    const created = (await hostInvoices()).filter((invoice) => invoice.memo === MEMO);
    expect(created).toHaveLength(1);
    expect(created[0]?.amountCents).toBe(424242);

    // The away run also lands the run row as ok + is audited under the app.
    expect((await stack.sql<{ status: string }>("SELECT status FROM vendo_runs WHERE id = $1", [runId]))[0]?.status)
      .toBe("ok");
    expect(Number((await stack.sql<{ count: unknown }>(
      "SELECT COUNT(*)::int AS count FROM vendo_audit WHERE kind = 'run' AND app_id = $1",
      [appId],
    ))[0]?.count)).toBeGreaterThanOrEqual(1);

    // GET /automations lists it enabled.
    const list = (await (await stack.wireFetch("/automations", {}, ADA)).json()) as Array<{
      app: { id: string };
      enabled: boolean;
    }>;
    expect(list.find((entry) => entry.app.id === appId)?.enabled).toBe(true);
  });

  it("(host-event) fires via vendo.emit, previews with dry-run, and disable stops firing", async () => {
    await resetFixture();
    stack = await createStack();
    const EVENT = "j4.invoice.ready";
    const MEMO = "J4 host-event invoice";

    const imported = await importAutomation(
      stack,
      createInvoiceAutomation({ kind: "host-event", event: EVENT }, MEMO),
      ADA,
    );
    const appId = imported.id;

    const enabled = (await (await stack.wireFetch(`/automations/${appId}/enable`, { method: "POST" }, ADA)).json()) as {
      enabled: boolean;
      missing: WireApproval[];
    };
    expect(enabled.enabled).toBe(true);
    expect((await decideApprovals(stack, enabled.missing.map((request) => request.id), { approve: true }, ADA)).status)
      .toBe(200);

    // --- dry-run previews the plan WITHOUT executing (07 §1/§5) ------------
    const plan = (await (await stack.wireFetch(`/automations/${appId}/dry-run`, { method: "POST" }, ADA)).json()) as {
      steps: Array<{ id: string; tool: string; wouldAsk: boolean }>;
      grantsMissing: string[];
    };
    expect(plan.steps.map(({ id, tool }) => ({ id, tool }))).toEqual([{ id: "create", tool: CREATE }]);
    // The captured grant covers the step, so nothing is missing / would-ask.
    expect(plan.grantsMissing).toEqual([]);
    expect(plan.steps.every((step) => step.wouldAsk === false)).toBe(true);
    // dry-run executed nothing.
    expect((await hostInvoices()).some((invoice) => invoice.memo === MEMO)).toBe(false);

    // --- Fire the host-event seam: vendo.emit -----------------------------
    const runIds = await stack.vendo.emit(EVENT, { requestedBy: "j4" }, ADA);
    expect(runIds).toHaveLength(1);
    const run = await waitForRunStatus(stack, runIds[0]!, ADA, "ok");
    expect(run.steps.map(({ tool, outcome }) => ({ tool, outcome }))).toEqual([{ tool: CREATE, outcome: "ok" }]);
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);

    // --- disable stops firing: a second emit produces no new run ----------
    expect((await stack.wireFetch(`/automations/${appId}/disable`, { method: "POST" }, ADA)).status).toBe(200);
    const afterDisable = await stack.vendo.emit(EVENT, { requestedBy: "j4-again" }, ADA);
    expect(afterDisable).toEqual([]);
    // Still exactly one invoice from the single pre-disable run.
    expect((await hostInvoices()).filter((invoice) => invoice.memo === MEMO)).toHaveLength(1);
    expect(Number((await stack.sql<{ count: unknown }>(
      "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
      [appId],
    ))[0]?.count)).toBe(1);
  });
});
