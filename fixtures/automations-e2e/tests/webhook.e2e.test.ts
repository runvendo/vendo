/** External deliveries, unmocked on both sides. The record is written through
 * the one create door as `{ webhook: "acme" }` — which normalizes onto the same
 * stored external union the connector triggers always used — and its HMAC key
 * is minted AT CREATE and belongs to that record alone. Verification is
 * therefore per record: there is no source-wide secret any more, and `list`/
 * `get` redact the key so only the webhook door ever sees it.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AutomationId } from "@vendoai/core";
import { createStack, ownerCtx, resetFixture, type Stack } from "../src/harness.js";
import { ADA, enableAndApprove, fixtureInvoices, runCount, tableCount, webhookSecret } from "../src/support.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

function signedRequest(input: {
  source?: string;
  secret: string;
  id: string;
  timestamp?: string;
  body: string;
  signature?: string;
  includeSignature?: boolean;
}): Request {
  const timestamp = input.timestamp ?? String(Math.floor(NOW.getTime() / 1000));
  const signature = input.signature ?? createHmac("sha256", Buffer.from(input.secret, "base64url"))
    .update(`${input.id}.${timestamp}.${input.body}`)
    .digest("base64");
  const headers = new Headers({
    "content-type": "application/json",
    "webhook-id": input.id,
    "webhook-timestamp": timestamp,
  });
  if (input.includeSignature !== false) headers.set("webhook-signature", `v1,${signature}`);
  return new Request(`http://vendo.local/api/vendo/webhooks/${input.source ?? "acme"}`, {
    method: "POST",
    headers,
    body: input.body,
  });
}

async function externalStack(): Promise<{ stack: Stack; id: AutomationId; secret: string }> {
  const stack = await createStack({ now: () => NOW });
  const ctx = ownerCtx(ADA.subject);
  const created = await stack.create({
    owner: ADA,
    when: { webhook: "acme" },
    task: {
      kind: "steps",
      steps: [{
        id: "create",
        tool: "host_invoices_create",
        args: {
          customerId: "event.customerId",
          amountCents: "event.amountCents",
          currency: "event.currency",
          memo: "event.memo",
        },
      }],
    },
    authoredBy: "chat",
  }, ctx);
  await enableAndApprove(stack, created.id, ctx);
  return { stack, id: created.id, secret: await webhookSecret(stack, created.id) };
}

const payload = (memo: string): string => JSON.stringify({
  event: "invoice.paid",
  customerId: "cus_ada",
  amountCents: 4242,
  currency: "USD",
  memo,
});

describe("external webhook verification and dispatch", () => {
  beforeEach(resetFixture);

  it("accepts a valid signature, creates a run, and exposes the event payload to steps", async () => {
    const { stack, id, secret } = await externalStack();
    try {
      // The key the door verifies against is the record's own, and nobody who
      // reads the record can see it.
      expect((await stack.automations.get(id, ownerCtx(ADA.subject)))?.webhookSecret).toBeUndefined();

      const response = await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_valid",
        body: payload("webhook payload sentinel"),
      }));
      expect(response.status).toBe(200);
      expect(await runCount(stack, id)).toBe(1);
      expect((await fixtureInvoices()).find(({ memo }) => memo === "webhook payload sentinel"))
        .toMatchObject({ amountCents: 4242, customerId: "cus_ada" });
    } finally {
      await stack.close();
    }
  });

  it("rejects missing and garbage signatures with no run and one audit event each", async () => {
    const { stack, secret } = await externalStack();
    try {
      const runsBefore = await tableCount(stack, "vendo_runs");
      const auditBefore = await tableCount(stack, "vendo_audit");
      expect((await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_missing",
        body: payload("missing"),
        includeSignature: false,
      }))).status).toBe(401);
      expect((await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_garbage",
        body: payload("garbage"),
        signature: "not-a-valid-signature",
      }))).status).toBe(401);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect(await tableCount(stack, "vendo_audit")).toBe(auditBefore + 2);
    } finally {
      await stack.close();
    }
  });

  it("rejects unverified invalid JSON as an authentication failure", async () => {
    const { stack, secret } = await externalStack();
    try {
      const runsBefore = await tableCount(stack, "vendo_runs");
      const auditBefore = await tableCount(stack, "vendo_audit");
      const response = await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_invalid_json",
        body: "{not-json",
        signature: "not-a-valid-signature",
      }));
      expect(response.status).toBe(401);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
      expect(await tableCount(stack, "vendo_audit")).toBe(auditBefore + 1);
    } finally {
      await stack.close();
    }
  });

  it("rejects a delivery timestamp outside the five-minute window", async () => {
    const { stack, secret } = await externalStack();
    try {
      const runsBefore = await tableCount(stack, "vendo_runs");
      const stale = String(Math.floor((NOW.getTime() - 6 * 60_000) / 1000));
      const response = await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_stale",
        timestamp: stale,
        body: payload("stale"),
      }));
      expect(response.status).toBe(401);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
    } finally {
      await stack.close();
    }
  });

  it("dedupes repeated delivery ids", async () => {
    const { stack, id, secret } = await externalStack();
    try {
      const request = () => signedRequest({ secret, id: "delivery_once", body: payload("dedupe sentinel") });
      expect((await stack.automations.webhook(request())).status).toBe(200);
      expect((await stack.automations.webhook(request())).status).toBe(200);
      // Deduped by (automation, delivery-id): the second delivery is answered,
      // and fires nothing.
      expect(await runCount(stack, id)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("rejects an unknown source segment with 401 and no dispatch", async () => {
    // 09 §3: the unauthenticated surface of the wire is exactly nothing — no
    // record is registered for that source, so there is no key the delivery
    // could be verified against and it is rejected like any other verification
    // failure.
    const { stack, secret } = await externalStack();
    try {
      const runsBefore = await tableCount(stack, "vendo_runs");
      const response = await stack.automations.webhook(signedRequest({
        source: "unknown",
        secret,
        id: "delivery_unknown",
        body: payload("unknown"),
      }));
      expect(response.status).toBe(401);
      expect(await tableCount(stack, "vendo_runs")).toBe(runsBefore);
    } finally {
      await stack.close();
    }
  });
});
