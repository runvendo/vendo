/** Re-verify round for ff67abc22, the fix for the fire-time and pre-list
 *  sponsorship findings — aimed at the FIX's own seams rather than at the
 *  properties the attack suite already covers.
 *
 *  The claim under test is "every sponsorship read goes through one door
 *  (`sponsorshipState`), which is where the pre-list rekey is migrated". A read
 *  that skips the door does not just miss a row: it answers WHO an automation
 *  runs as and WHETHER it stopped, which are the two sentences a person acts on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AppDocument, AppId } from "@vendoai/core";
import { automationDoc, createStack, ownerCtx, resetFixture, type Stack } from "./harness.js";
import { ADA, BOB, fixtureInvoices } from "./support.js";

const PROBE = "inv_0006";

const probeMemo = async (): Promise<string | undefined> =>
  (await fixtureInvoices()).find((invoice) => invoice.id === PROBE)?.memo;

const touchStep = (memo: string) => ({
  id: "touch",
  tool: "host_invoices_update",
  args: { id: "event.id", memo: `'${memo}'` },
});

/** The pre-list shape of one automation, exactly as it sits in a deployment
 *  today: the app row carries a single `trigger` object and is ARMED with no
 *  per-trigger armed row, and its sponsorship + era rows are keyed by the bare
 *  app id — the key the code used before triggers were a list. */
const seedPreList = async (stack: Stack, input: {
  appId: AppId;
  name: string;
  event: string;
  memo: string;
  status: "active" | "invalidated";
}): Promise<AppDocument> => {
  const now = new Date().toISOString();
  const trigger = {
    on: { kind: "host-event" as const, event: input.event },
    run: { kind: "steps" as const, steps: [touchStep(input.memo)] },
  };
  await stack.sql(
    `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
     VALUES ($1, $2, true, $3::jsonb, $4, $4)`,
    [input.appId, ADA.subject, JSON.stringify({
      format: "vendo/app@1",
      id: input.appId,
      name: input.name,
      trigger,
    }), now],
  );
  await stack.store.records("automations:sponsorships").put({
    id: input.appId,
    data: {
      appId: input.appId,
      sponsor: BOB.subject,
      intentHash: "sha256:whatever-the-old-formula-said",
      status: input.status,
      ...(input.status === "invalidated" ? { reason: "edit", invalidatedAt: now } : {}),
    },
    refs: { subject: BOB.subject, app_id: input.appId },
  });
  await stack.store.records("automations:sponsored").put({
    id: input.appId,
    data: { appId: input.appId, since: now },
    refs: { app_id: input.appId },
  });
  // The document as any reader sees it (read normalization gives the one trigger
  // the id `main`) — what the edit hook is handed.
  return automationDoc({ id: input.appId, name: input.name, trigger });
};

const triggerEntry = async (stack: Stack, appId: AppId) => {
  const listed = await stack.automations.list(ownerCtx(ADA.subject));
  return listed.find((entry) => entry.app.id === appId)?.triggers[0];
};

describe("re-verify — the one-door claim", () => {
  beforeEach(resetFixture);

  it("routes the LIST's sponsorship read through the migrating door too", async () => {
    const stack = await createStack();
    const stoppedApp = "app_prelist_stopped_list";
    const activeApp = "app_prelist_active_list";
    try {
      await seedPreList(stack, {
        appId: stoppedApp,
        name: "Pre-list stopped",
        event: "prelist.stopped",
        memo: "stopped-ran",
        status: "invalidated",
      });
      await seedPreList(stack, {
        appId: activeApp,
        name: "Pre-list active",
        event: "prelist.active",
        memo: "active-ran",
        status: "active",
      });

      // CONTROL: one read through the door (the adoption card) migrates the row,
      // and from then on the list tells the truth — so the row's contents are
      // reachable and correct, and only the path matters below.
      expect((await stack.automations.adoption(stoppedApp, ownerCtx(ADA.subject, stoppedApp)))?.triggerId)
        .toBe("main");
      const migrated = await triggerEntry(stack, stoppedApp);
      expect(migrated?.sponsor?.subject).toBe(BOB.subject);
      expect(migrated?.stopped?.reason).toBe("edit");

      // THE FINDING: the list is the only surface that says who an automation
      // runs as (§13's "runs with Dana's access") and whether it stopped (E8-F2's
      // route back to a paused automation). It reads the sponsorship rows
      // directly by pair key, so for a pre-list row nobody has fired, edited or
      // opened yet it silently answers with the app's OWNER.
      expect((await triggerEntry(stack, activeApp))?.sponsor?.subject).toBe(BOB.subject);
    } finally {
      await stack.close();
    }
  });

  it("still invalidates a forcibly migrated ACTIVE sponsorship on a third party's edit", async () => {
    const stack = await createStack();
    const appId = "app_prelist_active_edit";
    try {
      const doc = await seedPreList(stack, {
        appId,
        name: "Pre-list active",
        event: "prelist.edit",
        memo: "edited-ran",
        status: "active",
      });

      // The edit is the FIRST thing that ever touches this row, so it both
      // migrates and judges it in one call. ADA is not the sponsor.
      await stack.automations.onDocumentEdit(doc, doc, ADA.subject);

      expect(await stack.sql<{ id: string; status: string; sponsor: string }>(
        `SELECT id, data->>'status' AS status, data->>'sponsor' AS sponsor
           FROM vendo_records WHERE collection = 'automations:sponsorships' ORDER BY id`,
      )).toEqual([{ id: `${appId}:main`, status: "invalidated", sponsor: BOB.subject }]);

      // …and the stop is real, not just a row: the automation does not run.
      const [runId] = await stack.automations.emit("prelist.edit", { id: PROBE }, ADA);
      const run = runId === undefined
        ? undefined
        : await stack.automations.runs.get(runId, ownerCtx(ADA.subject, appId));
      expect(run?.status ?? "not-fired").not.toBe("ok");
      expect(await probeMemo()).not.toBe("edited-ran");
    } finally {
      await stack.close();
    }
  });
});
