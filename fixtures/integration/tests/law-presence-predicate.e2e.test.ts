/** THE LAW's predicate is PRESENCE, never the venue label (design §12,
 * clarification 2026-07-31) — proven at the COMPOSED wire.
 *
 * `POST /automations/:id/enable` resolves `{ venue: "automation",
 * presence: "present" }`: a human is right there clicking. When the predicate
 * ORed the venue in, the enable ceremony's descriptor lookup was filtered by
 * the law and a registered host tool came back as
 * `unknown tool in automation: host_invoices_send` — the ceremony could not ask
 * about the very tools it exists to ask about, which breaks the law's own
 * prescribed prepare-then-human-sends path.
 *
 * This is the narrow regression pin: enable an automation declaring a
 * destructive host tool and the ceremony goes THROUGH — the 200 is what proves
 * it saw the tool — and the cards it does mint are addressed to a PRESENT
 * person.
 *
 * The destructive tool itself is deliberately not among them. Arming captures
 * only what a standing grant could satisfy, and THE LAW refuses a destructive
 * away call whatever anyone answered, so a card for `host_invoices_send` would
 * promise something no firing will honour. Hence the second declared step: a
 * read the ceremony really does card, which is what carries the present-person
 * assertion the old predicate could not represent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ADA, createAutomation, createStack, resetFixture, type Stack } from "../src/harness.js";

const SEND = "host_invoices_send";
const LIST = "host_invoices_list";

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe("THE LAW: the enable ceremony sees the tools it asks about", () => {
  it("enables an automation declaring a destructive host tool and cards it, instead of 'unknown tool'", async () => {
    await resetFixture();
    stack = await createStack();
    const { id } = await createAutomation(stack, {
      owner: ADA,
      when: { event: "law.predicate" },
      task: {
        kind: "steps",
        steps: [
          { id: "list", tool: LIST },
          { id: "send", tool: SEND, args: { id: "event.id" } },
        ],
      },
    });

    const response = await stack.wireFetch(`/automations/${id}/enable`, { method: "POST" }, ADA);
    const body = (await response.json()) as {
      enabled?: boolean;
      missing?: Array<{ call: { tool: string }; ctx?: { venue?: string; presence?: string } }>;
      error?: { message: string };
    };

    // The bug surfaced exactly here: a registered host tool reported as unknown.
    expect(body.error?.message).toBeUndefined();
    expect(response.status).toBe(200);
    expect(body.enabled).toBe(true);

    // The ceremony SAW the destructive tool — the 200 above is that proof — and
    // still mints no card for it: a standing grant could never authorize it
    // away, so asking would be a question with no true answer.
    expect(body.missing?.some((request) => request.call.tool === SEND)).toBe(false);

    const card = body.missing?.find((request) => request.call.tool === LIST);
    expect(card).toBeDefined();
    // The ceremony is a ceremony: the card it mints is addressed to a person who
    // is present, in the automation venue. That pair is legal, and it is the
    // pair the old predicate could not represent.
    expect(card?.ctx?.venue).toBe("automation");
    expect(card?.ctx?.presence).toBe("present");
  });
});
