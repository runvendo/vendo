/** An automation is an app with a LIST of triggers, and everything is keyed per
 *  (app, trigger). Two things have to hold for that to be true rather than
 *  merely typed:
 *
 *   1. A document stored BEFORE the list existed still loads, lists, arms and
 *      fires — as the trigger `main` it always meant. This suite writes that row
 *      with raw SQL on purpose: going through the record door would normalize it
 *      on the way IN, and then the test would prove nothing about the rows that
 *      are actually sitting in a deployment's database today.
 *   2. Two triggers of one app are two automations. Arming one does not arm the
 *      other, disarming one does not disarm the other, and — the one that
 *      matters — a grant minted while arming one never authorizes the other.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { automationDoc, createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, approve } from "../src/support.js";

const listStep = { id: "list", tool: "host_invoices_list" };
const sendStep = { id: "send", tool: "host_invoices_send", args: { id: "event.id" } };

describe("pre-list documents (migration)", () => {
  beforeEach(resetFixture);

  it("loads, lists, arms and fires a stored single-`trigger` document as `main`", async () => {
    const stack = await createStack();
    try {
      const appId = "app_legacy_shape";
      // The PRE-LIST shape, byte for byte as it sits in a deployment today: one
      // `trigger` object, no trigger id anywhere.
      const legacyDoc = {
        format: "vendo/app@1",
        id: appId,
        name: "Legacy chaser",
        trigger: {
          on: { kind: "host-event", event: "invoice.legacy" },
          run: { kind: "steps", steps: [listStep] },
        },
      };
      const now = new Date().toISOString();
      await stack.sql(
        `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
         VALUES ($1, $2, false, $3::jsonb, $4, $4)`,
        [appId, ADA.subject, JSON.stringify(legacyDoc), now],
      );
      // The row really is still the old shape in the database — if this fails,
      // the rest of the test is checking a document something already migrated.
      const stored = await stack.sql<{ has_trigger: boolean; has_triggers: boolean }>(
        `SELECT doc ? 'trigger' AS has_trigger, doc ? 'triggers' AS has_triggers
           FROM vendo_apps WHERE id = $1`,
        [appId],
      );
      expect(stored[0]).toEqual({ has_trigger: true, has_triggers: false });

      // LOADS + LISTS: read normalization gives it the one trigger it meant.
      const listed = await stack.automations.list(ownerCtx(ADA.subject));
      expect(listed).toHaveLength(1);
      expect(listed[0]?.app.id).toBe(appId);
      expect(listed[0]?.triggers.map(({ trigger, enabled }) => ({ id: trigger.id, enabled })))
        .toEqual([{ id: "main", enabled: false }]);

      // ARMS: under the id read normalization gave it, with no migration step.
      const enabled = await stack.automations.enable(appId, "main", ownerCtx(ADA.subject, appId));
      expect(enabled.enabled).toBe(true);
      expect(enabled.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      await approve(stack, enabled.missing);

      const armed = await stack.automations.list(ownerCtx(ADA.subject));
      expect(armed[0]?.triggers.map(({ trigger, enabled: on }) => ({ id: trigger.id, enabled: on })))
        .toEqual([{ id: "main", enabled: true }]);

      // FIRES: end to end, through the real emit path, and the run says which
      // trigger ran.
      const ids = await stack.automations.emit("invoice.legacy", { id: "inv_1" }, ADA);
      expect(ids).toHaveLength(1);
      const run = await stack.automations.runs.get(ids[0]!, ownerCtx(ADA.subject, appId));
      expect(run?.triggerId).toBe("main");
      expect(run?.status).toBe("ok");
    } finally {
      await stack.close();
    }
  });

  it("keeps firing a pre-list row that was armed before triggers were a list", async () => {
    const stack = await createStack();
    try {
      const appId = "app_legacy_armed";
      // enabled = true and NO per-trigger armed row: exactly the state a
      // deployment's already-armed automation is in the moment this ships. It
      // must not go quietly dark.
      const legacyDoc = {
        format: "vendo/app@1",
        id: appId,
        name: "Legacy armed",
        trigger: {
          on: { kind: "host-event", event: "invoice.armed" },
          run: { kind: "steps", steps: [listStep] },
        },
      };
      const now = new Date().toISOString();
      await stack.sql(
        `INSERT INTO vendo_apps (id, subject, enabled, doc, created_at, updated_at)
         VALUES ($1, $2, true, $3::jsonb, $4, $4)`,
        [appId, ADA.subject, JSON.stringify(legacyDoc), now],
      );
      // Nothing has written a per-trigger armed row for it — that is the state
      // under test, not an accident of setup.
      expect(await stack.sql(
        "SELECT id FROM vendo_records WHERE collection = 'automations:armed'",
      )).toEqual([]);

      const ids = await stack.automations.emit("invoice.armed", { id: "inv_2" }, ADA);
      expect(ids).toHaveLength(1);
      const run = await stack.automations.runs.get(ids[0]!, ownerCtx(ADA.subject, appId));
      expect(run?.triggerId).toBe("main");
    } finally {
      await stack.close();
    }
  });
});

describe("two triggers, one app", () => {
  beforeEach(resetFixture);

  const twoTriggerDoc = (appId: string) => automationDoc({
    id: appId,
    name: "Two ways",
    triggers: [
      {
        id: "reader",
        on: { kind: "host-event", event: "invoice.read" },
        run: { kind: "steps", steps: [listStep] },
      },
      {
        id: "sender",
        on: { kind: "host-event", event: "invoice.send" },
        run: { kind: "steps", steps: [sendStep] },
      },
    ],
  });

  it("arms and disarms each trigger on its own", async () => {
    const stack = await createStack();
    try {
      const appId = "app_two_triggers";
      await stack.putApp(ADA.subject, twoTriggerDoc(appId));
      const ctx = ownerCtx(ADA.subject, appId);

      const armedState = async () =>
        (await stack.automations.list(ownerCtx(ADA.subject)))[0]?.triggers
          .map(({ trigger, enabled }) => [trigger.id, enabled]);

      expect(await armedState()).toEqual([["reader", false], ["sender", false]]);

      await stack.automations.enable(appId, "reader", ctx);
      // Arming one leaves the other exactly as it was.
      expect(await armedState()).toEqual([["reader", true], ["sender", false]]);

      await stack.automations.enable(appId, "sender", ctx);
      expect(await armedState()).toEqual([["reader", true], ["sender", true]]);

      await stack.automations.disable(appId, "reader", ctx);
      // …and disarming one does not take the other down with it. This is the
      // whole point of keying arming per (app, trigger).
      expect(await armedState()).toEqual([["reader", false], ["sender", true]]);

      // The disarmed trigger does not fire; the armed one still does.
      expect(await stack.automations.emit("invoice.read", { id: "inv_1" }, ADA)).toEqual([]);
      expect(await stack.automations.emit("invoice.send", { id: "inv_1" }, ADA)).toHaveLength(1);
    } finally {
      await stack.close();
    }
  });

  it("never lets one trigger's grant authorize another's", async () => {
    const stack = await createStack();
    try {
      const appId = "app_two_grants";
      // BOTH triggers declare the SAME tool, so nothing but the trigger id can
      // tell their grants apart: if authority leaked, it would leak here.
      await stack.putApp(ADA.subject, automationDoc({
        id: appId,
        name: "Same tool twice",
        triggers: [
          {
            id: "alpha",
            on: { kind: "host-event", event: "invoice.alpha" },
            run: { kind: "steps", steps: [listStep] },
          },
          {
            id: "beta",
            on: { kind: "host-event", event: "invoice.beta" },
            run: { kind: "steps", steps: [listStep] },
          },
        ],
      }));
      const ctx = ownerCtx(ADA.subject, appId);

      const alpha = await stack.automations.enable(appId, "alpha", ctx);
      expect(alpha.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      await approve(stack, alpha.missing);

      // The minted grant names the trigger it was minted for, and only it —
      // read straight off the column, so a grant whose trigger id the store
      // silently dropped could not pass this.
      const grants = await stack.sql<{ tool: string; trigger_id: string | null }>(
        `SELECT tool, trigger_id
           FROM vendo_grants WHERE subject = $1 AND app_id = $2 ORDER BY tool`,
        [ADA.subject, appId],
      );
      expect(grants).toEqual([{ tool: "host_invoices_list", trigger_id: "alpha" }]);

      // Arming BETA must still ask: alpha's yes was about alpha's steps. A
      // consent moment that silently inherited a sibling's grant would arm a
      // second automation nobody was asked about.
      const beta = await stack.automations.enable(appId, "beta", ctx);
      expect(beta.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      // …and it is a NEW ask, not alpha's being handed over.
      expect(beta.missing.map((request) => request.id))
        .not.toEqual(alpha.missing.map((request) => request.id));

      // Re-arming ALPHA asks for nothing: its own grant still covers it.
      expect((await stack.automations.enable(appId, "alpha", ctx)).missing).toEqual([]);
    } finally {
      await stack.close();
    }
  });

  it("gives each trigger its own sponsorship, so editing one leaves the other running", async () => {
    const stack = await createStack();
    try {
      const appId = "app_two_sponsors";
      await stack.putApp(ADA.subject, twoTriggerDoc(appId));
      const ctx = ownerCtx(ADA.subject, appId);
      await approve(stack, (await stack.automations.enable(appId, "reader", ctx)).missing);
      await approve(stack, (await stack.automations.enable(appId, "sender", ctx)).missing);

      const rows = await stack.sql<{ id: string; trigger_id: string }>(
        `SELECT id, data->>'triggerId' AS trigger_id
           FROM vendo_records WHERE collection = 'automations:sponsorships' ORDER BY id`,
      );
      expect(rows).toEqual([
        { id: `${appId}:reader`, trigger_id: "reader" },
        { id: `${appId}:sender`, trigger_id: "sender" },
      ]);
    } finally {
      await stack.close();
    }
  });
});
