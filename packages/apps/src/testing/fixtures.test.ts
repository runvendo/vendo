import type {
  RunContext,
  ToolCall,
  ToolDescriptor,
  ToolRegistry,
} from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { fakeSandbox, type MachineApp } from "./fake-sandbox.js";
import { bindTools, guardFixture } from "./guard-fixture.js";
import { memoryStore } from "./memory-store.js";

const decoder = new TextDecoder();

const jsonBody = (bytes: Uint8Array): unknown => JSON.parse(decoder.decode(bytes)) as unknown;

describe("memory store fixture", () => {
  it("round-trips records with refs, ids, and cursor pagination", async () => {
    const store = memoryStore();
    const records = store.records("orders");
    const first = await records.put({ id: "b", data: { total: 20 }, refs: { customer: "cus_1", region: "west" } });
    await records.put({ id: "a", data: { total: 10 }, refs: { customer: "cus_1", region: "east" } });
    await records.put({ id: "c", data: { total: 30 }, refs: { customer: "cus_2" } });

    const updated = await records.put({ id: "b", data: { total: 21 }, refs: { customer: "cus_1", region: "west" } });
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt > first.updatedAt).toBe(true);
    expect(await records.get("b")).toEqual(updated);

    const filtered = await records.list({ refs: { customer: "cus_1" }, ids: ["a", "b", "c"] });
    expect(filtered.records.map((record) => record.id)).toEqual(["a", "b"]);

    const pageOne = await records.list({ limit: 2 });
    expect(pageOne.records.map((record) => record.id)).toEqual(["c", "a"]);
    expect(pageOne.cursor).toBeTypeOf("string");
    const pageTwo = await records.list({ limit: 2, cursor: pageOne.cursor });
    expect(pageTwo.records.map((record) => record.id)).toEqual(["b"]);
    expect(pageTwo.cursor).toBeUndefined();
  });

  it("round-trips blobs and lists them by prefix", async () => {
    const blobs = memoryStore().blobs("attachments");
    await blobs.put("invoices/a.txt", new TextEncoder().encode("hello"), { contentType: "text/plain" });
    await blobs.put("other/b.bin", new Uint8Array([9]));

    const stored = await blobs.get("invoices/a.txt");
    expect(stored?.contentType).toBe("text/plain");
    expect(decoder.decode(stored?.bytes)).toBe("hello");
    expect(await blobs.list("invoices/")).toEqual(["invoices/a.txt"]);

    await blobs.delete("invoices/a.txt");
    expect(await blobs.get("invoices/a.txt")).toBeNull();
  });
});

describe("fake sandbox fixture", () => {
  it("preserves env, files, and the machine app across snapshot and resume", async () => {
    const adapter = fakeSandbox();
    const machine = await adapter.create({
      env: { PORT: "3000", FEATURE: "on" },
    });
    await machine.files.write("/app/message.txt", "before");
    const response = await machine.request({
      method: "POST",
      path: "/fn/greet",
      headers: { "x-test": "yes" },
      body: JSON.stringify({ args: { name: "Ada" } }),
    });
    expect(jsonBody(response.body)).toEqual({
      result: {
        name: "greet",
        args: { name: "Ada" },
        env: { PORT: "3000", FEATURE: "on" },
        headers: { "x-test": "yes" },
      },
    });

    const snapshot = await machine.snapshot();
    await machine.files.write("/app/message.txt", "after");
    const resumed = await adapter.resume(snapshot);
    expect(decoder.decode(await resumed.files.read("/app/message.txt"))).toBe("before");
    const resumedResponse = await resumed.request({ method: "POST", path: "/fn/env", body: "{\"args\":{}}" });
    expect(jsonBody(resumedResponse.body)).toMatchObject({ result: { env: { FEATURE: "on" } } });
  });

  it("dispatches request() to the installed machine handler", async () => {
    const handler = vi.fn<MachineApp>((request) => ({
      status: 201,
      headers: { "x-handler": "installed" },
      body: `handled ${request.method} ${request.path}`,
    }));
    const adapter = fakeSandbox({ app: handler });
    const machine = await adapter.create({ env: {} });
    const response = await machine.request({ method: "PATCH", path: "/custom" });

    expect(handler).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    expect(decoder.decode(response.body)).toBe("handled PATCH /custom");
    expect(adapter.machines.get(machine.id)?.requests).toHaveLength(1);
  });
});

describe("guard fixture", () => {
  const critical: ToolDescriptor = {
    name: "host_payments_send",
    description: "Send a payment",
    inputSchema: { type: "object" },
    risk: "destructive",
    critical: true,
  };
  const blocked: ToolDescriptor = {
    name: "host_private_read",
    description: "Read private data",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const normal: ToolDescriptor = {
    name: "host_weather_read",
    description: "Read weather",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const ctx: RunContext = {
    principal: { kind: "user", subject: "user_1" },
    venue: "app",
    presence: "present",
    sessionId: "session_1",
  };
  const call = (tool: string): ToolCall => ({ id: `call_${tool}`, tool, args: { city: "Oakland" } });
  const registry: ToolRegistry = {
    async descriptors() {
      return [critical, blocked, normal];
    },
    async execute(toolCall) {
      return { status: "ok", output: { called: toolCall.tool } };
    },
  };

  it("asks for critical tools, blocks programmed tools, and runs by default", async () => {
    const guard = guardFixture({ rules: { host_private_read: "block" } });
    const criticalDecision = await guard.check(call(critical.name), critical, ctx);
    expect(criticalDecision.action).toBe("ask");

    const bound = bindTools(guard, registry);
    expect(await bound.execute(call(blocked.name), ctx)).toEqual({
      status: "blocked",
      reason: "Programmed block for host_private_read",
    });
    expect(await bound.execute(call(normal.name), ctx)).toEqual({
      status: "ok",
      output: { called: normal.name },
    });
    expect(guard.audit.map((event) => event.outcome)).toEqual(["blocked", "ok"]);
  });

  it("parks away asks and fires approval-decision callbacks", async () => {
    const guard = guardFixture({ rules: { host_weather_read: "ask" } });
    const callback = vi.fn();
    guard.onApprovalDecision(callback);
    const bound = bindTools(guard, registry);
    const away = { ...ctx, presence: "away" as const };

    const outcome = await bound.execute(call(normal.name), away);
    expect(outcome.status).toBe("pending-approval");
    if (outcome.status !== "pending-approval") throw new Error("Expected pending approval");
    expect(guard.approvals.map((approval) => approval.id)).toEqual([outcome.approvalId]);

    guard.decide(outcome.approvalId, true);
    expect(callback).toHaveBeenCalledWith(outcome.approvalId, true);
    expect(guard.approvals).toEqual([]);
  });
});
