import {
  VENDO_APP_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it } from "vitest";
import { createAutomations } from "../index.js";

// Red-team suite for the external-webhook ingress (07-automations engine.ts).
// A webhook is UNAUTHENTICATED attacker-reachable input that can start an away run
// acting as the app owner. The Standard-Webhooks HMAC over `id.timestamp.rawBody`
// is the ONLY thing standing between the open internet and a run firing as the user.
// Every forgery / replay / oversize / skew / missing-header attempt must fail closed
// with NO run, and an app without a stored secret must be skipped (no bypass).

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

const app = (id: string, trigger: NonNullable<AppDocument["trigger"]>, name = id): AppDocument =>
  ({ format: VENDO_APP_FORMAT, id, name, trigger });

const seedApp = async (store: StoreAdapter, doc: AppDocument, subject = "user_a", enabled = false): Promise<void> => {
  await store.records("vendo_apps").put({ id: doc.id, data: { subject, enabled, doc }, refs: { subject, ...(doc.trigger === undefined ? {} : { trigger_kind: doc.trigger.on.kind }) } });
};

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

const appsDouble = (): AppsRuntime => ({ call: async () => ({ status: "ok", output: {} }) } as AppsRuntime);

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

const externalApp = () => app("app_webhook", {
  on: { kind: "external", connector: "github", event: "push" },
  run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
});

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
  return new Request("https://example.test/api/webhooks/github", {
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

  const buildEnabled = async () => {
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW });
    await seedApp(store, externalApp());
    await engine.enable(externalApp().id, ctx());
    const secret = ((await store.records("automations:webhook").get(externalApp().id))?.data as { secret: string }).secret;
    return { engine, secret };
  };

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
  });

  it("dispatches a run for a correctly-signed, in-window delivery", async () => {
    const { engine, secret } = await buildEnabled();
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_1", String(NOW.getTime() / 1_000), body);

    const response = await engine.webhook(request({ sig, body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    expect(await runCount(store)).toBe(1);
  });

  it("rejects a forged signature with 401 and starts NO run", async () => {
    const { engine } = await buildEnabled();
    const response = await engine.webhook(request({ sig: "AAAAforged", id: "delivery_forged" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });
    expect(await runCount(store)).toBe(0);
    // Rejection audits as an anonymous webhook principal — the owner is never resolved.
    expect(guard.audit.some((event) => event.principal.subject === "webhook:github")).toBe(true);
    expect(guard.audit.some((event) => event.principal.subject === "user_a")).toBe(false);
  });

  it("dedupes a replayed delivery-id — the second delivery starts no second run", async () => {
    const { engine, secret } = await buildEnabled();
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_replay", String(NOW.getTime() / 1_000), body);

    const first = await engine.webhook(request({ sig, id: "delivery_replay", body }));
    expect(first.status).toBe(200);
    const second = await engine.webhook(request({ sig, id: "delivery_replay", body }));
    expect(await second.json()).toEqual({ deduped: true });
    expect(await runCount(store)).toBe(1);
  });

  it("rejects an oversized body (>1 MiB) with 413 and starts no run", async () => {
    const { engine, secret } = await buildEnabled();
    const body = "x".repeat(1024 * 1024 + 1);
    const sig = await sign(secret, "delivery_big", String(NOW.getTime() / 1_000), body);
    const response = await engine.webhook(request({ sig, id: "delivery_big", body }));
    expect(response.status).toBe(413);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects a timestamp skewed more than 5 minutes into the past with 401", async () => {
    const { engine, secret } = await buildEnabled();
    const stale = String(NOW.getTime() / 1_000 - 301);
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_past", stale, body);
    const response = await engine.webhook(request({ sig, id: "delivery_past", timestamp: stale, body }));
    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects a timestamp skewed more than 5 minutes into the future with 401", async () => {
    const { engine, secret } = await buildEnabled();
    const future = String(NOW.getTime() / 1_000 + 400);
    const body = JSON.stringify({ answer: 42 });
    const sig = await sign(secret, "delivery_future", future, body);
    const response = await engine.webhook(request({ sig, id: "delivery_future", timestamp: future, body }));
    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });

  it("rejects deliveries missing any of webhook-id / -timestamp / -signature with 401", async () => {
    const { engine, secret } = await buildEnabled();
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

  it("skips an enabled external app that has NO stored secret (no missing-signature bypass)", async () => {
    // Seed an ENABLED external app but never call enable() → no webhook secret minted.
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW });
    await seedApp(store, externalApp(), "user_a", true);

    // A well-formed but unverifiable delivery cannot match a secret-less app.
    const response = await engine.webhook(request({ sig: "AAAAsomething", id: "delivery_nosecret" }));
    expect(response.status).toBe(401);
    expect(await runCount(store)).toBe(0);
  });
});
