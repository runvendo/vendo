import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppId } from "@vendoai/core";
import { automationDoc, createStack, ownerCtx, resetFixture, type Stack } from "./harness.js";
import { ADA, enableAndApprove, fixtureInvoices, record, tableCount } from "./support.js";

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

async function externalStack(appId: AppId): Promise<{ stack: Stack; secret: string }> {
  const stack = await createStack({ now: () => NOW });
  await stack.putApp(ADA.subject, automationDoc({
    id: appId,
    trigger: {
      on: { kind: "external", connector: "acme", event: "invoice.paid" },
      run: {
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
    },
  }));
  await enableAndApprove(stack, appId, ownerCtx(ADA.subject, appId));
  const rows = await stack.sql<{ data: unknown }>(
    "SELECT data FROM vendo_records WHERE collection = 'automations:webhook' AND id = $1",
    [appId],
  );
  const secret = record(rows[0]?.data).secret;
  if (typeof secret !== "string" || secret.length === 0) throw new Error("Enable did not mint a webhook secret");
  return { stack, secret };
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
    const appId = "app_webhook_valid";
    const { stack, secret } = await externalStack(appId);
    try {
      const response = await stack.automations.webhook(signedRequest({
        secret,
        id: "delivery_valid",
        body: payload("webhook payload sentinel"),
      }));
      expect(response.status).toBe(200);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
        [appId],
      ))[0]?.count)).toBe(1);
      expect((await fixtureInvoices()).find(({ memo }) => memo === "webhook payload sentinel"))
        .toMatchObject({ amountCents: 4242, customerId: "cus_ada" });
    } finally {
      await stack.close();
    }
  });

  it("rejects missing and garbage signatures with no run and one audit event each", async () => {
    const appId = "app_webhook_invalid";
    const { stack, secret } = await externalStack(appId);
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

  it("rejects a delivery timestamp outside the five-minute window", async () => {
    const appId = "app_webhook_stale";
    const { stack, secret } = await externalStack(appId);
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
    const appId = "app_webhook_dedupe";
    const { stack, secret } = await externalStack(appId);
    try {
      const request = () => signedRequest({ secret, id: "delivery_once", body: payload("dedupe sentinel") });
      expect((await stack.automations.webhook(request())).status).toBe(200);
      expect((await stack.automations.webhook(request())).status).toBe(200);
      expect(Number((await stack.sql<{ count: unknown }>(
        "SELECT COUNT(*)::int AS count FROM vendo_runs WHERE app_id = $1",
        [appId],
      ))[0]?.count)).toBe(1);
    } finally {
      await stack.close();
    }
  });

  it("rejects an unknown source segment with 401 and no dispatch", async () => {
    // 09 §3: the unauthenticated surface of the wire is exactly nothing — an
    // unknown source has no registered verification, so the delivery is
    // unverifiable and is rejected like any other verification failure.
    const appId = "app_webhook_unknown";
    const { stack, secret } = await externalStack(appId);
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
