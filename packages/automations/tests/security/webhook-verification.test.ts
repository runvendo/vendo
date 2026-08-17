import {
  type ApprovalId,
  type AuditEvent,
  type AutomationRecord,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { beforeEach, describe, expect, it } from "vitest";
import { automationsInternals, createAutomations, type AutomationsEngine } from "../../src/index.js";
import { AUTOMATIONS } from "../../src/types.js";

// Red-team suite for the external-webhook ingress (07-automations).
// A webhook is UNAUTHENTICATED attacker-reachable input that can start an away run
// acting as the record's owner. The Standard-Webhooks HMAC over `id.timestamp.rawBody`
// is the ONLY thing standing between the open internet and a run firing as the user.
// Every forgery / replay / oversize / skew / missing-header attempt must fail closed
// with NO run, and a record without a stored secret must be skipped (no bypass).
//
// The secret is a FIELD on the record now, minted once by the create op and never
// rotated by a replace — so it is verified per RECORD: a signature that verifies
// for one automation says nothing about another's.

const NOW = new Date("2026-07-12T12:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "read_data",
  description: "Read data",
  inputSchema: { type: "object" },
  risk: "read",
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();
  async check(): Promise<{ action: "run"; decidedBy: "default" }> { return { action: "run", decidedBy: "default" }; }
  async report(event: AuditEvent): Promise<void> { this.audit.push(structuredClone(event)); }
  async directions(): Promise<string[]> { return []; }
  onApprovalDecision(cb: (id: ApprovalId, approved: boolean) => void): () => void { this.callbacks.add(cb); return () => this.callbacks.delete(cb); }
}

const registry = (
  descriptors: ToolDescriptor[] = [],
  execute: (call: ToolCall, runCtx: RunContext) => Promise<ToolOutcome> = async () => ({ status: "ok", output: {} }),
): ToolRegistry => ({ async descriptors() { return descriptors; }, execute });

/** Real HMAC-SHA256 signer over `id.timestamp.body`, key = base64url secret. */
const sign = async (secret: string, deliveryId: string, timestamp: string, body: string): Promise<string> => {
  let normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  normalized += "=".repeat((4 - normalized.length % 4) % 4);
  const keyBytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${deliveryId}.${timestamp}.${body}`)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const AUTOMATION_ID = "atm_webhook";

const request = (
  opts: { sig?: string; id?: string; timestamp?: string; body?: string; headers?: Record<string, string | undefined> },
): Request => {
  const headers: Record<string, string> = {};
  const id = opts.id ?? "delivery_1";
  const timestamp = opts.timestamp ?? String(NOW.getTime() / 1_000);
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) if (v !== undefined) headers[k] = v;
  } else {
    headers["webhook-id"] = id;
    headers["webhook-timestamp"] = timestamp;
    if (opts.sig !== undefined) headers["webhook-signature"] = `v1,${opts.sig}`;
  }
  return new Request("https://example.test/api/vendo/webhooks/github", {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ answer: 42 }),
  });
};

const runCount = async (store: StoreAdapter): Promise<number> =>
  (await store.records("vendo_runs").list()).records.length;

describe("webhook signature verification", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;
  let engine: AutomationsEngine;

  /** An armed external record, and the secret the create op minted for it. The
   *  secret is read off the stored ROW: `list`/`get` redact it, precisely because a
   *  live HMAC key in a listing is a key that has been published. */
  const buildArmed = async (): Promise<string> => {
    await automationsInternals(engine).create(
      {
        id: AUTOMATION_ID,
        owner: ctx().principal,
        authoredBy: "chat",
        when: { webhook: "github" },
        task: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
      },
      ctx(),
    );
    const row = (await store.records(AUTOMATIONS).get(AUTOMATION_ID))?.data as AutomationRecord;
    if (row.webhookSecret === undefined) throw new Error("create minted no webhook secret");
    return row.webhookSecret;
  };

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
    engine = createAutomations({ tools: registry([readTool]), guard, store, now: () => NOW });
  });

  it("dispatches a run for a correctly-signed, in-window delivery", async () => {
    const secret = await buildArmed();
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_1", String(NOW.getTime() / 1_000), body);

    const response = await engine.webhook(request({ sig, body }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    expect(await runCount(store)).toBe(1);
  });

  it("rejects a forged signature with 401 and starts NO run", async () => {
    await buildArmed();

    const response = await engine.webhook(request({ sig: "AAAAforged", id: "delivery_forged" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });
    expect(await runCount(store)).toBe(0);
    // Rejection audits as an anonymous webhook principal — the owner is never
    // resolved. Reserved namespace: webhook principals mint as vendo:webhook:<source>.
    expect(guard.audit.some((event) => event.principal.subject === "vendo:webhook:github")).toBe(true);
    expect(guard.audit.some((event) => event.principal.subject === "user_a")).toBe(false);
  });

  it("rejects a signature minted for ANOTHER record's secret", async () => {
    // Per-RECORD verification is the whole point of the secret being a field: one
    // automation's key must not open another's door.
    const secret = await buildArmed();
    await automationsInternals(engine).create(
      {
        id: "atm_webhook_other",
        owner: ctx("user_b").principal,
        authoredBy: "chat",
        when: { webhook: "stripe" },
        task: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
      },
      ctx("user_b"),
    );
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_cross", String(NOW.getTime() / 1_000), body);

    // Signed with github's key, delivered to stripe's door.
    const response = await engine.webhook(new Request("https://example.test/api/vendo/webhooks/stripe", {
      method: "POST",
      headers: {
        "webhook-id": "delivery_cross",
        "webhook-timestamp": String(NOW.getTime() / 1_000),
        "webhook-signature": `v1,${sig}`,
      },
      body,
    }));

    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("dedupes a replayed delivery-id — the second delivery starts no second run", async () => {
    const secret = await buildArmed();
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_replay", String(NOW.getTime() / 1_000), body);

    const first = await engine.webhook(request({ sig, id: "delivery_replay", body }));
    expect(first.status).toBe(200);
    const second = await engine.webhook(request({ sig, id: "delivery_replay", body }));

    expect(await second.json()).toEqual({ deduped: true });
    expect(await runCount(store)).toBe(1);
  });

  it("rejects an oversized body (>1 MiB) with 413 and starts no run", async () => {
    const secret = await buildArmed();
    const body = "x".repeat(1024 * 1024 + 1);
    const sig = await sign(secret, "delivery_big", String(NOW.getTime() / 1_000), body);

    const response = await engine.webhook(request({ sig, id: "delivery_big", body }));

    expect(response.status).toBe(413);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects a timestamp skewed more than 5 minutes into the past with 401", async () => {
    const secret = await buildArmed();
    const stale = String(NOW.getTime() / 1_000 - 301);
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_past", stale, body);

    const response = await engine.webhook(request({ sig, id: "delivery_past", timestamp: stale, body }));

    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects a timestamp skewed more than 5 minutes into the future with 401", async () => {
    const secret = await buildArmed();
    const future = String(NOW.getTime() / 1_000 + 400);
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_future", future, body);

    const response = await engine.webhook(request({ sig, id: "delivery_future", timestamp: future, body }));

    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects deliveries missing any of webhook-id / -timestamp / -signature with 401", async () => {
    const secret = await buildArmed();
    const timestamp = String(NOW.getTime() / 1_000);
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_1", timestamp, body);

    const missingId = await engine.webhook(request({ headers: { "webhook-timestamp": timestamp, "webhook-signature": `v1,${sig}` }, body }));
    expect(missingId.status).toBe(401);
    const missingTs = await engine.webhook(request({ headers: { "webhook-id": "delivery_1", "webhook-signature": `v1,${sig}` }, body }));
    expect(missingTs.status).toBe(401);
    const missingSig = await engine.webhook(request({ headers: { "webhook-id": "delivery_1", "webhook-timestamp": timestamp }, body }));
    expect(missingSig.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("skips an armed external record that has NO stored secret (no missing-signature bypass)", async () => {
    // A hand-written row: armed and external, but carrying no secret the door could
    // ever verify against. It must be SKIPPED, never treated as unverified-but-ok.
    const record: AutomationRecord = {
      id: "atm_secretless",
      owner: ctx().principal,
      when: { kind: "external", connector: "github", event: "push" },
      task: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
      armed: true,
      authoredBy: "chat",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    await store.records(AUTOMATIONS).put({
      id: record.id,
      data: record,
      refs: { subject: record.owner.subject, when_kind: record.when.kind },
    });

    const response = await engine.webhook(request({ sig: "AAAAsomething", id: "delivery_nosecret" }));

    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });
});
