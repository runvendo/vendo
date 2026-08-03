/** THE LAW's predicate is PRESENCE, never the venue label (design §12,
 * clarification 2026-07-31) — proven at the COMPOSED wire.
 *
 * `POST /automations/:appId/enable` resolves `{ venue: "automation",
 * presence: "present" }`: a human is right there clicking. When the predicate
 * ORed the venue in, the enable ceremony's descriptor lookup was filtered by
 * the law and a registered host tool came back as
 * `unknown tool in automation: host_invoices_send` — the ceremony could not ask
 * about the very tools it exists to ask about, which breaks the law's own
 * prescribed prepare-then-human-sends path.
 *
 * This is the narrow regression pin: enable a destructive host tool, get a
 * consent card for it, and the card is addressed to a PRESENT person.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AppDocument } from "@vendoai/core";
import { ADA, createStack, importAutomation, resetFixture, type Stack } from "./harness.js";

const SEND = "host_invoices_send";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("THE LAW: the enable ceremony sees the tools it asks about", () => {
  it("enables an automation declaring a destructive host tool and cards it, instead of 'unknown tool'", async () => {
    await resetFixture();
    stack = await createStack();
    const doc: AppDocument = {
      format: "vendo/app@1",
      id: "app_import_placeholder",
      name: "Law predicate automation",
      trigger: {
        on: { kind: "host-event", event: "law.predicate" },
        run: { kind: "steps", steps: [{ id: "send", tool: SEND, args: { id: "event.id" } }] },
      },
    };
    const { id: appId } = await importAutomation(stack, doc, ADA);

    const response = await stack.wireFetch(`/automations/${appId}/enable`, { method: "POST" }, ADA);
    const body = (await response.json()) as {
      enabled?: boolean;
      missing?: Array<{ call: { tool: string }; ctx?: { venue?: string; presence?: string } }>;
      error?: { message: string };
    };

    // The bug surfaced exactly here: a registered host tool reported as unknown.
    expect(body.error?.message).toBeUndefined();
    expect(response.status).toBe(200);
    expect(body.enabled).toBe(true);

    const card = body.missing?.find((request) => request.call.tool === SEND);
    expect(card).toBeDefined();
    // The ceremony is a ceremony: the card it mints is addressed to a person who
    // is present, in the automation venue. That pair is legal, and it is the
    // pair the old predicate could not represent.
    expect(card?.ctx?.venue).toBe("automation");
    expect(card?.ctx?.presence).toBe("present");
  });
});
