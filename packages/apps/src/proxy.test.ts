import type { RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { describe, expect, it, vi } from "vitest";
import { createApps } from "./index.js";
import {
  basicLanguageModel,
  bindTools,
  fakeSandbox,
  guardFixture,
  memoryStore,
  seedAppRow,
} from "./testing/index.js";

const model = basicLanguageModel();
const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const json = async (response: Response): Promise<unknown> => response.json() as Promise<unknown>;

describe("machine tool proxy", () => {
  it("runs granted tools, returns critical approval outcomes, and scopes state to the token app", async () => {
    const descriptors: ToolDescriptor[] = [
      { name: "host_x", description: "Read x", inputSchema: { type: "object" }, risk: "read" },
      { name: "host_critical", description: "Critical mutation", inputSchema: { type: "object" }, risk: "write", critical: true },
    ];
    const rawTools: ToolRegistry = {
      async descriptors() { return descriptors; },
      async execute(call, runCtx) {
        return { status: "ok", output: { tool: call.tool, args: call.args, ctx: runCtx } };
      },
    };
    const guard = guardFixture();
    const approvalDecision = vi.fn();
    guard.onApprovalDecision(approvalDecision);
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard,
      tools: bindTools(guard, rawTools),
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model,
    });
    const app = await runtime.create({ prompt: "Machine app" }, ctx);
    await seedAppRow(store, { ...app, ui: "http", secrets: ["API_KEY"] }, ctx.principal.subject);

    await expect(runtime.open(app.id, ctx)).resolves.toMatchObject({ kind: "resuming" });
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const machine = [...sandbox.machines.values()].at(-1);
    expect(machine).toBeDefined();
    const token = machine?.env.VENDO_RUN_TOKEN;
    expect(token).toBeTypeOf("string");
    expect(machine?.env).toMatchObject({ PORT: "8080", VENDO_PROXY_URL: "https://proxy.test" });

    const ok = await runtime.proxy.handler(new Request(`${machine?.env.VENDO_PROXY_URL}/tools/host_x`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: { x: 1 } }),
    }));
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({
      status: "ok",
      output: {
        tool: "host_x",
        args: { x: 1 },
        ctx: {
          principal: { kind: "user", subject: "user_ada" },
          venue: "app",
          presence: "present",
          appId: app.id,
        },
      },
    });

    const critical = await runtime.proxy.handler(new Request(`${machine?.env.VENDO_PROXY_URL}/tools/host_critical`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: {} }),
    }));
    const criticalOutcome = await json(critical) as { status: string; approvalId?: string };
    expect(criticalOutcome).toMatchObject({ status: "pending-approval", approvalId: expect.any(String) });
    guard.decide(criticalOutcome.approvalId ?? "", true);
    expect(approvalDecision).toHaveBeenCalledWith(criticalOutcome.approvalId, true);

    const putState = await runtime.proxy.handler(new Request("https://proxy.test/state", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ selected: "a" }),
    }));
    expect(putState.status).toBe(200);
    expect(await store.records("vendo_state").get(`${app.id}:user_ada`)).toMatchObject({ data: { selected: "a" } });

    await store.records("vendo_state").put({
      id: "app_other:user_ada",
      data: { selected: "other" },
      refs: { subject: "user_ada", app_id: "app_other" },
    });
    const getState = await runtime.proxy.handler(new Request("https://proxy.test/state?appId=app_other", {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(await json(getState)).toEqual({ selected: "a" });
  });

  it("rejects bad tokens, unsupported routes, and non-json mutation bodies", async () => {
    const runtime = createApps({
      store: memoryStore(),
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      catalog: [],
      model,
    });
    const badToken = await runtime.proxy.handler(new Request("https://proxy.test/state", {
      headers: { authorization: "Bearer forged.token" },
    }));
    expect(badToken.status).toBe(401);
    expect(await json(badToken)).toMatchObject({ error: { code: "unauthorized" } });

    const noRoute = await runtime.proxy.handler(new Request("https://proxy.test/unknown"));
    expect(noRoute.status).toBe(404);

    const wrongType = await runtime.proxy.handler(new Request("https://proxy.test/tools/host_x", {
      method: "POST",
      headers: { authorization: "Bearer forged.token", "content-type": "text/plain" },
      body: "{}",
    }));
    expect(wrongType.status).toBe(400);
  });

  it("rejects oversized state bodies without persisting them", async () => {
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      sandbox,
      proxyUrl: "https://proxy.test",
      catalog: [],
      model,
    });
    const app = await runtime.create({ prompt: "Bounded state" }, ctx);
    await seedAppRow(store, { ...app, ui: "http" }, ctx.principal.subject);
    await runtime.open(app.id, ctx);
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const token = [...sandbox.machines.values()].at(-1)?.env.VENDO_RUN_TOKEN;

    const response = await runtime.proxy.handler(new Request("https://proxy.test/state", {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(256 * 1024) }),
    }));

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({ error: { code: "validation" } });
    expect(await store.records("vendo_state").get(`${app.id}:${ctx.principal.subject}`)).toBeNull();
  });

  it("injects opaque secret handles without ever reading or exposing values", async () => {
    const get = vi.fn(async () => "REAL_SECRET_SENTINEL");
    const sandbox = fakeSandbox();
    const store = memoryStore();
    const runtime = createApps({
      store,
      guard: guardFixture(),
      tools: { async descriptors() { return []; }, async execute() { return { status: "blocked", reason: "no" }; } },
      sandbox,
      secrets: { get },
      catalog: [],
      model,
    });
    const app = await runtime.create({ prompt: "Secret app" }, ctx);
    await seedAppRow(
      store,
      { ...app, ui: "http", secrets: ["STRIPE_KEY", "OTHER_KEY"] },
      ctx.principal.subject,
    );

    await runtime.open(app.id, ctx);
    await vi.waitFor(() => expect(sandbox.machines.size).toBe(1));
    const env = [...sandbox.machines.values()].at(-1)?.env;
    expect(env?.STRIPE_KEY).toMatch(/^vendo-secret:STRIPE_KEY:[0-9a-f]{8}$/);
    expect(env?.OTHER_KEY).toMatch(/^vendo-secret:OTHER_KEY:[0-9a-f]{8}$/);
    expect(Object.values(env ?? {})).not.toContain("REAL_SECRET_SENTINEL");
    expect(env).not.toHaveProperty("VENDO_PROXY_URL");
    expect(get).not.toHaveBeenCalled();
  });
});
