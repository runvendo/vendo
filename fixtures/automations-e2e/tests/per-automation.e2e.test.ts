/** Two automation records of one owner are two automations. Arming one does not
 *  arm the other, disarming one does not disarm the other, and — the one that
 *  matters — a grant minted while arming one never authorizes the other. Under
 *  records that is keyed on the automation id alone: there is no app left to
 *  pair it with, so if authority leaked it would leak here.
 */
import type { CreateAutomationInput, Step } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomation, createStack, ownerCtx, resetFixture } from "../src/harness.js";
import { ADA, approve } from "../src/support.js";

const listStep = { id: "list", tool: "host_invoices_list" };
const sendStep = { id: "send", tool: "host_invoices_send", args: { id: "event.id" } };

/** A disarmed steps record, so arming is a deliberate act this suite can watch. */
const record = (event: string, steps: Step[]): CreateAutomationInput => ({
  owner: ADA,
  when: { event },
  task: { kind: "steps", steps },
  authoredBy: "chat",
  armed: false,
});

describe("two records, one owner", () => {
  beforeEach(resetFixture);

  it("arms and disarms each record on its own", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      const reader = await createAutomation(stack, record("invoice.read", [listStep]), ctx);
      const sender = await createAutomation(stack, record("invoice.send", [sendStep]), ctx);

      const armedState = async () => Object.fromEntries(
        (await stack.automations.list({ owner: ADA.subject }, ctx)).map(({ id, armed }) => [id, armed]),
      );

      expect(await armedState()).toEqual({ [reader.id]: false, [sender.id]: false });

      await stack.automations.enable(reader.id, ctx);
      // Arming one leaves the other exactly as it was.
      expect(await armedState()).toEqual({ [reader.id]: true, [sender.id]: false });

      await stack.automations.enable(sender.id, ctx);
      expect(await armedState()).toEqual({ [reader.id]: true, [sender.id]: true });

      await stack.automations.disable(reader.id, ctx);
      // …and disarming one does not take the other down with it. This is the
      // whole point of the record being the unit.
      expect(await armedState()).toEqual({ [reader.id]: false, [sender.id]: true });

      // The disarmed record does not fire; the armed one still does.
      expect(await stack.automations.emit("invoice.read", { id: "inv_0001" }, ADA)).toEqual([]);
      expect(await stack.automations.emit("invoice.send", { id: "inv_0001" }, ADA)).toHaveLength(1);
    } finally {
      await stack.close();
    }
  });

  it("never lets one record's grant authorize another's", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      // BOTH records declare the SAME tool, so nothing but the automation id can
      // tell their grants apart.
      const alpha = await createAutomation(stack, record("invoice.alpha", [listStep]), ctx);
      const beta = await createAutomation(stack, record("invoice.beta", [listStep]), ctx);

      const armed = await stack.automations.enable(alpha.id, ctx);
      expect(armed.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      await approve(stack, armed.missing);

      // The minted grant names the record it was minted for, and only it — read
      // straight off the column, so a grant whose automation id the store
      // silently dropped could not pass this.
      expect(await stack.sql<{ tool: string; automation_id: string | null }>(
        "SELECT tool, automation_id FROM vendo_grants WHERE subject = $1 ORDER BY tool",
        [ADA.subject],
      )).toEqual([{ tool: "host_invoices_list", automation_id: alpha.id }]);

      // Arming BETA must still ask: alpha's yes was about alpha's steps. A
      // consent moment that silently inherited a sibling's grant would arm a
      // second automation nobody was asked about.
      const second = await stack.automations.enable(beta.id, ctx);
      expect(second.missing.map((request) => request.call.tool)).toEqual(["host_invoices_list"]);
      // …and it is a NEW ask, not alpha's being handed over.
      expect(second.missing.map((request) => request.id))
        .not.toEqual(armed.missing.map((request) => request.id));

      // Re-arming ALPHA asks for nothing: its own grant still covers it.
      expect((await stack.automations.enable(alpha.id, ctx)).missing).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
