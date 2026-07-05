import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import {
  automationSpecSchema,
  type ApprovalPolicy,
  type AutomationSpec,
  type RegisteredTool,
} from "@flowlet/runtime";
import { createConnectionsStore } from "./connections";
import { WORLD_SCOPE } from "./guard";
import { createAutomationsWorld, type FlowletAutomationsWorld } from "./world";
import { handleComposioWebhook, verifyComposioSignature } from "./webhooks";

const STUB_MODEL = { modelId: "stub" } as unknown as LanguageModel;
const allowAll: ApprovalPolicy = { evaluate: () => "allow" };

const NOW_MS = Date.parse("2026-07-04T12:00:00.000Z");
const NOW_SECONDS = String(Math.floor(NOW_MS / 1000));

// The secret as it would arrive from the Composio dashboard (Svix "whsec_"
// convention) — signing itself operates on the base64 part only.
const SECRET_B64 = Buffer.from("unit-test-secret-32-bytes-long!").toString("base64");
const SECRET = `whsec_${SECRET_B64}`;

const CATALOG = [{ id: "gmail", name: "Gmail" }];

function sign(id: string, timestamp: string, body: string, secretB64 = SECRET_B64): string {
  const sig = createHmac("sha256", Buffer.from(secretB64, "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${sig}`;
}

function webhookRequest(opts: {
  id?: string;
  timestamp?: string;
  signature?: string;
  body: string;
  omitHeaders?: boolean;
}): Request {
  const id = opts.id ?? "msg_1";
  const timestamp = opts.timestamp ?? NOW_SECONDS;
  const signature = opts.signature ?? sign(id, timestamp, opts.body);
  return new Request("http://localhost:3000/api/flowlet/webhooks/composio", {
    method: "POST",
    headers: opts.omitHeaders
      ? { host: "localhost:3000" }
      : {
          host: "localhost:3000",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signature,
        },
    body: opts.body,
  });
}

const noopTool: RegisteredTool = {
  descriptor: { name: "noop", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
  execute: async () => ({ ok: true, result: {} }),
};

function composioSpec(triggerSlug: string): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "composio", trigger: triggerSlug },
    execution: {
      mode: "steps",
      steps: [{ id: "s1", type: "tool", tool: "noop", input: {} }],
    },
  });
}

async function makeWorld(): Promise<FlowletAutomationsWorld> {
  return createAutomationsWorld({
    policy: allowAll,
    model: STUB_MODEL,
    scope: WORLD_SCOPE,
    tools: { noop: noopTool },
  });
}

const PAYLOAD = JSON.stringify({
  type: "GMAIL_NEW_GMAIL_MESSAGE",
  connected_account_id: "acct-123",
  data: { subject: "hello" },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleComposioWebhook", () => {
  it("404s when COMPOSIO_WEBHOOK_SECRET is not configured", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const res = await handleComposioWebhook(webhookRequest({ body: PAYLOAD }), {
      world,
      connections,
      env: {},
    });
    expect(res.status).toBe(404);
  });

  it("404s when automations are disabled (world is null)", async () => {
    const connections = createConnectionsStore(CATALOG);
    const res = await handleComposioWebhook(webhookRequest({ body: PAYLOAD }), {
      world: null,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
    });
    expect(res.status).toBe(404);
  });

  it("401s on a bad signature", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const res = await handleComposioWebhook(
      webhookRequest({ body: PAYLOAD, signature: "v1,not-the-real-signature" }),
      { world, connections, env: { COMPOSIO_WEBHOOK_SECRET: SECRET }, nowMs: () => NOW_MS },
    );
    expect(res.status).toBe(401);
  });

  it("401s on a stale timestamp (>5 min old)", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const staleTimestamp = String(Math.floor(NOW_MS / 1000) - 6 * 60);
    const res = await handleComposioWebhook(
      webhookRequest({ body: PAYLOAD, timestamp: staleTimestamp }),
      { world, connections, env: { COMPOSIO_WEBHOOK_SECRET: SECRET }, nowMs: () => NOW_MS },
    );
    expect(res.status).toBe(401);
  });

  it("401s when required headers are missing entirely", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const res = await handleComposioWebhook(webhookRequest({ body: PAYLOAD, omitHeaders: true }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(401);
  });

  it("400s a validly-signed but malformed JSON body", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const body = "not-json{{{";
    const res = await handleComposioWebhook(webhookRequest({ body }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(400);
  });

  it("400s a validly-signed payload with no recognizable trigger fields", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const body = JSON.stringify({ nonsense: true });
    const res = await handleComposioWebhook(webhookRequest({ body }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(400);
  });

  it("200 { skipped: true } for a valid signature but unknown connected account", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG); // no setConnectedAccount call
    const res = await handleComposioWebhook(webhookRequest({ body: PAYLOAD }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true });
  });

  it("200 with fired: 0 when verified + known account but no matching enabled automation", async () => {
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    await connections.setConnectedAccount("gmail", "acct-123");
    // No automation registered for GMAIL_NEW_GMAIL_MESSAGE.
    const res = await handleComposioWebhook(webhookRequest({ body: PAYLOAD }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 0 });
  });

  it("fires the matching enabled automation under the connection's principal, eventId = delivery id", async () => {
    const world = await makeWorld();
    const { automation } = await world.store.create(WORLD_SCOPE, {
      spec: composioSpec("GMAIL_NEW_GMAIL_MESSAGE"),
      grants: [],
    });
    const connections = createConnectionsStore(CATALOG);
    await connections.setConnectedAccount("gmail", "acct-123");

    const res = await handleComposioWebhook(webhookRequest({ id: "msg_delivery_1", body: PAYLOAD }), {
      world,
      connections,
      env: { COMPOSIO_WEBHOOK_SECRET: SECRET },
      nowMs: () => NOW_MS,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, fired: 1 });

    const runs = await world.store.listRuns(WORLD_SCOPE, automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("succeeded");
    expect(runs[0]?.trigger.eventId).toBe("msg_delivery_1");
    expect(runs[0]?.trigger.source).toBe("composio");
  });

  it("redelivery (same webhook-id) is a 200 no-op — runner not re-invoked", async () => {
    const world = await makeWorld();
    const { automation } = await world.store.create(WORLD_SCOPE, {
      spec: composioSpec("GMAIL_NEW_GMAIL_MESSAGE"),
      grants: [],
    });
    const connections = createConnectionsStore(CATALOG);
    await connections.setConnectedAccount("gmail", "acct-123");
    const deps = { world, connections, env: { COMPOSIO_WEBHOOK_SECRET: SECRET }, nowMs: () => NOW_MS };

    const first = await handleComposioWebhook(
      webhookRequest({ id: "msg_dup", body: PAYLOAD }),
      deps,
    );
    expect(first.status).toBe(200);
    const second = await handleComposioWebhook(
      webhookRequest({ id: "msg_dup", body: PAYLOAD }),
      deps,
    );
    expect(second.status).toBe(200);

    const runs = await world.store.listRuns(WORLD_SCOPE, automation.id);
    expect(runs).toHaveLength(1);
  });

  it("warns about the missing secret only once across repeated requests", async () => {
    vi.resetModules();
    const { handleComposioWebhook: freshHandler } = await import("./webhooks");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const world = await makeWorld();
    const connections = createConnectionsStore(CATALOG);
    const deps = { world, connections, env: {} };
    await freshHandler(webhookRequest({ body: PAYLOAD }), deps);
    await freshHandler(webhookRequest({ body: PAYLOAD }), deps);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("verifyComposioSignature", () => {
  it("accepts a signature computed exactly per the documented contract", () => {
    const id = "msg_1";
    const timestamp = NOW_SECONDS;
    const body = PAYLOAD;
    expect(
      verifyComposioSignature({
        id,
        timestamp,
        signature: sign(id, timestamp, body),
        body,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("accepts one matching signature among several space-separated candidates", () => {
    const id = "msg_1";
    const timestamp = NOW_SECONDS;
    const body = PAYLOAD;
    const real = sign(id, timestamp, body);
    expect(
      verifyComposioSignature({
        id,
        timestamp,
        signature: `v1,bogus== ${real}`,
        body,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a signature computed with a different secret", () => {
    const id = "msg_1";
    const timestamp = NOW_SECONDS;
    const body = PAYLOAD;
    const otherSecretB64 = Buffer.from("a-completely-different-secret!!").toString("base64");
    expect(
      verifyComposioSignature({
        id,
        timestamp,
        signature: sign(id, timestamp, body, otherSecretB64),
        body,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body", () => {
    const id = "msg_1";
    const timestamp = NOW_SECONDS;
    expect(
      verifyComposioSignature({
        id,
        timestamp,
        signature: sign(id, timestamp, PAYLOAD),
        body: PAYLOAD + "tampered",
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});
