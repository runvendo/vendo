/** FLOW 1 — chat-authored schedule, end to end through `vendo_automate`.
 *
 * The seam, unmocked on both sides. PRODUCER: the real chat tool, executed
 * through the real apps agent-tool registry — the same registry the model is
 * handed — which calls the ONE create operation. CONSUMER: the real
 * `automations.list`/`get` reads the record back, the real `enable` captures
 * the owner's consent, and the real `tick` fires it into a real run row against
 * the live fixture host. A suite that wrote through the tool and read back
 * through the tool's own return value would prove nothing: the envelope is
 * checked AND the store is read.
 *
 * The unit is a RECORD, not an app. `vendo_automate` creates an app-less
 * automation, which is the case a per-app model could not express at all.
 */
import {
  AUTOMATIONS_DOCS_URL,
  VENDO_AUTOMATE_TOOL,
  VENDO_AUTOMATION_REF_KIND,
  vendoAutomationRefSchema,
} from "@vendoai/core";
import type { ToolRegistry, VendoAutomationRef } from "@vendoai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, BOB, approve, fixtureInvoices, record, runCount, tableCount } from "../src/support.js";

const chat = (stack: Stack): ToolRegistry => stack.apps.agentTools();

const automate = async (
  stack: Stack,
  args: Record<string, unknown>,
  subject = ADA.subject,
): Promise<VendoAutomationRef> => {
  const outcome = await chat(stack).execute(
    { id: `call_${args.task as string}`, tool: VENDO_AUTOMATE_TOOL, args },
    ownerCtx(subject),
  );
  if (outcome.status !== "ok") throw new Error(`vendo_automate failed: ${JSON.stringify(outcome)}`);
  // Parsed with core's OWN schema, not cast: the envelope is what the chat lane
  // and the embed both read, so a producer that drifts from it fails here
  // rather than in a browser.
  return vendoAutomationRefSchema.parse(outcome.output) as VendoAutomationRef;
};

describe("chat-authored automations (vendo_automate)", () => {
  beforeEach(resetFixture);

  it("arms a schedule from words, stores it as the owner's record, and the tick fires it", async () => {
    let clock = new Date("2026-08-03T07:00:00.000Z");
    const stack = await createStack({ now: () => clock });
    try {
      const ctx = ownerCtx(ADA.subject);
      const ref = await automate(stack, {
        when: "0 9 * * 1-5",
        task: "list the invoices that went overdue overnight and note them",
      });

      // The envelope the model and the embed both read.
      expect(ref.kind).toBe(VENDO_AUTOMATION_REF_KIND);
      expect(ref.armed).toBe(true);
      expect(ref.summary.trim()).not.toBe("");
      // Next run is COMPUTED on read from the cron, never a stored column — so
      // it is pinned by its SHAPE (09:00 UTC, Mon–Fri) rather than an instant:
      // the engine's injected clock does not reach croner here, and asserting an
      // absolute date would only be pinning today's date.
      const next = new Date(ref.nextRunAt!);
      expect(ref.nextRunAt).toMatch(/T09:00:00\.000Z$/);
      expect(next.getUTCDay()).toBeGreaterThanOrEqual(1);
      expect(next.getUTCDay()).toBeLessThanOrEqual(5);

      // And the same automation read back through the engine's own door.
      const stored = await stack.automations.get(ref.automationId, ctx);
      expect(stored).toMatchObject({
        id: ref.automationId,
        owner: { kind: "user", subject: ADA.subject },
        when: { kind: "schedule", cron: "0 9 * * 1-5" },
        authoredBy: "chat",
        armed: true,
      });
      // The record carries NO app reference of any kind — the layering flip.
      expect(Object.keys(record(stored)).some((key) => key.toLowerCase().includes("app"))).toBe(false);

      // Deployment-wide list, filtered by owner, is the same one row.
      expect((await stack.automations.list({ owner: ADA.subject }, ctx)).map(({ id }) => id))
        .toEqual([ref.automationId]);
      expect(await stack.automations.list({ owner: BOB.subject }, ownerCtx(BOB.subject))).toEqual([]);

      // Consent: the goal it authored needs the owner's grants before it can run
      // with nobody watching.
      await approve(stack, (await stack.automations.enable(ref.automationId, ctx)).missing);

      // FIRES: through the real tick, once per due window.
      clock = new Date("2026-08-03T09:00:30.000Z");
      const fired = await stack.automations.tick(clock);
      expect(fired).toHaveLength(1);
      expect((await stack.automations.runs.get(fired[0]!, ctx))?.automationId).toBe(ref.automationId);
      expect(await stack.automations.tick(clock)).toEqual([]);
      expect(await runCount(stack, ref.automationId)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("accepts every `when` shape the sheet ships and normalizes each to its stored form", async () => {
    const stack = await createStack({ now: () => new Date("2026-08-03T07:00:00.000Z") });
    try {
      const ctx = ownerCtx(ADA.subject);
      const cases = [
        [{ every: "15m" }, { kind: "schedule", every: "15m" }],
        [{ at: "2026-09-01T09:00:00.000Z" }, { kind: "schedule", at: "2026-09-01T09:00:00.000Z" }],
        [{ event: "payment.failed" }, { kind: "host-event", event: "payment.failed" }],
        // `{ webhook }` normalizes onto the SAME external union the connector
        // triggers always used — one stored vocabulary, five authoring shapes.
        [{ webhook: "stripe" }, { kind: "external", connector: "stripe" }],
      ] as const;

      for (const [when, expected] of cases) {
        const ref = await automate(stack, { when, task: `handle ${JSON.stringify(when)}` });
        expect((await stack.automations.get(ref.automationId, ctx))?.when).toEqual(expected);
        // Event and webhook records have no next run to state.
        if (expected.kind !== "schedule") expect(ref.nextRunAt).toBeUndefined();
        // `at` is the one shape whose next run is exact — handed back verbatim.
        if ("at" in when) expect(ref.nextRunAt).toBe(when.at);
      }
      expect(await tableCount(stack, "vendo_automations")).toBe(cases.length);
    } finally {
      await stack.close();
    }
  });

  it("refuses a schedule that is not one, in words, and stores nothing", async () => {
    const stack = await createStack();
    try {
      const outcome = await chat(stack).execute(
        { id: "call_bad_cron", tool: VENDO_AUTOMATE_TOOL, args: { when: "every monday", task: "do the thing" } },
        ownerCtx(ADA.subject),
      );
      expect(outcome.status).toBe("error");
      if (outcome.status !== "error") throw new Error("unreachable");
      expect(outcome.error.code).toBe("validation");
      // What/why/did-you-mean/docs — the refusal is a sentence a person can act
      // on, not a type name. The URL is core's ONE constant, so a moved docs
      // page cannot leave four packages pointing at a 404.
      expect(outcome.error.message).toContain("every monday");
      expect(outcome.error.message).toContain(AUTOMATIONS_DOCS_URL);
      expect(await tableCount(stack, "vendo_automations")).toBe(0);
    } finally {
      await stack.close();
    }
  });

  it("runs a steps task the chat authored against the live host, as the owner", async () => {
    const stack = await createStack();
    try {
      const ctx = ownerCtx(ADA.subject);
      // The chat tool authors goals; the steps door is the same create op, and
      // this is the leg that proves the run really reaches the host.
      const created = await stack.create({
        owner: ADA,
        when: { event: "invoice.chat-swept" },
        task: {
          kind: "steps",
          steps: [{ id: "sweep", tool: "host_invoices_update", args: { id: "event.id", memo: "'chat-swept'" } }],
        },
        authoredBy: "chat",
      }, ctx);
      await approve(stack, (await stack.automations.enable(created.id, ctx)).missing);

      const [runId] = await stack.automations.emit("invoice.chat-swept", { id: "inv_0003" }, ADA);
      expect((await stack.automations.runs.get(runId!, ctx))?.status).toBe("ok");
      expect((await fixtureInvoices()).find(({ id }) => id === "inv_0003")?.memo).toBe("chat-swept");
    } finally {
      await stack.close();
    }
  });

  it("never lets one person's chat author another person's automation", async () => {
    const stack = await createStack();
    try {
      const ref = await automate(stack, { when: "0 9 * * *", task: "ada's own digest" });
      // Bob's chat cannot see it, cannot get it, and cannot turn it on.
      expect(await stack.automations.list({}, ownerCtx(BOB.subject))).toEqual([]);
      expect(await stack.automations.get(ref.automationId, ownerCtx(BOB.subject))).toBeNull();
      await expect(stack.automations.enable(ref.automationId, ownerCtx(BOB.subject)))
        .rejects.toMatchObject({ code: "not-found" });
    } finally {
      await stack.close();
    }
  });
});
