import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import {
  automationSpecSchema,
  MAX_TRIGGER_PAYLOAD_BYTES,
  TriggerPayloadTooLargeError,
  type ApprovalPolicy,
  type AutomationSpec,
  type RegisteredTool,
} from "@vendoai/runtime";
import {
  createVendoFetchHandler,
  ensureVendoState,
  ingestVendoEvent,
  resetVendoBootRegistry,
} from "./fetch-handler.js";

const STUB_MODEL = { modelId: "stub" } as unknown as LanguageModel;
const ALLOW_ALL: ApprovalPolicy = { evaluate: () => "allow" };

function req(pathname: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    headers: { host: "localhost:3000", "content-type": "application/json" },
    ...init,
  });
}

function vendoDirWithEvents(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "vendo-events-")), ".vendo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "tools.json"),
    JSON.stringify({
      version: 1,
      tools: [],
      events: [
        {
          name: "transaction.created",
          description: "A card transaction was created.",
        },
      ],
    }),
  );
  return dir;
}

function captureTool(name: string) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    execute: async (input) => {
      calls.push(input as Record<string, unknown>);
      return { ok: true, result: { done: true } };
    },
  };
  return tool;
}

function transactionSpec(): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Large transaction",
    description: "Notify for large transactions.",
    prompt: "Notify for large transactions.",
    trigger: { type: "host_event", event: "transaction.created" },
    if: "trigger.amount > 75",
    execution: {
      mode: "steps",
      steps: [
        {
          id: "record",
          type: "tool",
          tool: "record_sale",
          input: { text: "{{ trigger.merchant }}" },
        },
      ],
    },
  });
}

async function setup(opts: { principal?: () => null; bootKey?: string } = {}) {
  const tool = captureTool("record_sale");
  const options = {
    vendoDir: vendoDirWithEvents(),
    model: STUB_MODEL,
    policy: ALLOW_ALL,
    storage: false as const,
    automations: { tools: { record_sale: tool } },
    ...(opts.principal ? { principal: opts.principal } : {}),
    ...(opts.bootKey ? { bootKey: opts.bootKey } : {}),
  };
  const state = await ensureVendoState(options);
  if (!state.world) throw new Error("expected automations world");
  const { automation } = await state.world.store.create(state.worldScope, {
    spec: transactionSpec(),
    grants: [],
  });
  const handler = createVendoFetchHandler(options);
  return { handler, state, automation, tool, options };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetVendoBootRegistry();
});

describe("host event ingest", () => {
  it("fires matching host_event automations with the event payload in trigger scope", async () => {
    const { handler, state, automation, tool } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          name: "transaction.created",
          eventId: "txn-1",
          payload: { amount: 88, merchant: "Acme" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, eventId: "txn-1", matched: 1, fired: 1 });
    expect(tool.calls).toEqual([{ text: "Acme" }]);
    const runs = await state.world!.store.listRuns(state.worldScope, automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger.payload).toEqual({ amount: 88, merchant: "Acme" });
  });

  it("keeps a non-matching guard from executing steps", async () => {
    const { handler, state, automation, tool } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          name: "transaction.created",
          eventId: "txn-low",
          payload: { amount: 12, merchant: "Corner Shop" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(tool.calls).toHaveLength(0);
    const runs = await state.world!.store.listRuns(state.worldScope, automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.outcome).toBe("skipped");
  });

  it("rejects unknown event names with the declared event list", async () => {
    const { handler } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          name: "invoice.paid",
          eventId: "invoice-1",
          payload: { amount: 100 },
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown host event "invoice.paid"',
      declaredEvents: ["transaction.created"],
    });
  });

  it("requires a non-empty eventId on HTTP ingest", async () => {
    const { handler } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          name: "transaction.created",
          payload: { amount: 100 },
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "eventId is required and must be a non-empty string",
    });
  });

  it("rejects event ingest bodies over the route cap before parsing", async () => {
    const { handler, state, automation, tool } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "content-type": "application/json",
          "content-length": String(MAX_TRIGGER_PAYLOAD_BYTES + 4_097),
        },
        body: JSON.stringify({
          name: "transaction.created",
          eventId: "txn-content-length",
          payload: { amount: 100, merchant: "Acme" },
        }),
      }),
    );

    expect(res.status).toBe(413);
    expect(tool.calls).toHaveLength(0);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(0);
  });

  it("rejects over-cap trigger payloads instead of guarding against raw input", async () => {
    const { handler, state, automation, tool } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        body: JSON.stringify({
          name: "transaction.created",
          eventId: "txn-too-large",
          payload: {
            amount: 100,
            merchant: "x".repeat(MAX_TRIGGER_PAYLOAD_BYTES),
          },
        }),
      }),
    );

    expect(res.status).toBe(413);
    expect(tool.calls).toHaveLength(0);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(0);
  });

  it("dedupes duplicate eventId deliveries through deterministic run ids", async () => {
    const { handler, state, automation, tool } = await setup();
    const body = JSON.stringify({
      name: "transaction.created",
      eventId: "txn-dup",
      payload: { amount: 90, merchant: "Acme" },
    });

    const first = await handler(req("/api/vendo/events/ingest", { method: "POST", body }));
    const second = await handler(req("/api/vendo/events/ingest", { method: "POST", body }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, matched: 1, fired: 1 });
    expect(await second.json()).toMatchObject({ ok: true, matched: 1, fired: 0 });
    expect(tool.calls).toHaveLength(1);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(1);
  });

  it("allows bearer-authenticated service ingest without resolving a request principal", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "s3cret");
    const { handler, tool } = await setup({ principal: async () => null });

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "content-type": "application/json",
          authorization: "Bearer s3cret",
        },
        body: JSON.stringify({
          name: "transaction.created",
          eventId: "txn-service",
          payload: { amount: 95, merchant: "Acme" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(tool.calls).toHaveLength(1);
  });

  it("401s a wrong bearer without falling through to the principal guard", async () => {
    vi.stubEnv("VENDO_TICK_SECRET", "s3cret");
    const { handler } = await setup();

    const res = await handler(
      req("/api/vendo/events/ingest", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          "content-type": "application/json",
          authorization: "Bearer wrong",
        },
        body: JSON.stringify({
          name: "transaction.created",
          payload: { amount: 95, merchant: "Acme" },
        }),
      }),
    );

    expect(res.status).toBe(401);
  });

  it("programmatic ingest shares the boot-registry world by bootKey", async () => {
    const { state, automation, tool } = await setup({ bootKey: "events-programmatic" });

    const result = await ingestVendoEvent(
      "transaction.created",
      { amount: 110, merchant: "Programmatic" },
      { bootKey: "events-programmatic", eventId: "txn-programmatic" },
    );

    expect(result.fired).toBe(1);
    expect(tool.calls).toEqual([{ text: "Programmatic" }]);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(1);
  });

  it("allows programmatic ingest without eventId but returns a generated non-dedupe id", async () => {
    const { state, automation, tool } = await setup({ bootKey: "events-generated-id" });

    const result = await ingestVendoEvent(
      "transaction.created",
      { amount: 110, merchant: "Generated" },
      { bootKey: "events-generated-id" },
    );

    expect(result.eventId).toMatch(/^generated:transaction\.created:/);
    expect(result.fired).toBe(1);
    expect(tool.calls).toEqual([{ text: "Generated" }]);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(1);
  });

  it("rejects over-cap programmatic payloads before creating a run", async () => {
    const { state, automation, tool } = await setup({ bootKey: "events-programmatic-cap" });

    await expect(
      ingestVendoEvent(
        "transaction.created",
        { amount: 110, merchant: "x".repeat(MAX_TRIGGER_PAYLOAD_BYTES) },
        { bootKey: "events-programmatic-cap", eventId: "txn-programmatic-cap" },
      ),
    ).rejects.toBeInstanceOf(TriggerPayloadTooLargeError);

    expect(tool.calls).toHaveLength(0);
    expect(await state.world!.store.listRuns(state.worldScope, automation.id)).toHaveLength(0);
  });
});
