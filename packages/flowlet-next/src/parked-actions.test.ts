import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { automationSpecSchema, hashDescriptor, type AutomationSpec, type RegisteredTool } from "@flowlet/runtime";
import { createAutomationsWorld } from "./world";
import { defaultFlowletPolicy } from "./default-policy";
import { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";

const PRINCIPAL = { userId: "u1" };
const SCOPE = { tenantId: "flowlet-embedded", subject: "u1" };
const NOW = "2026-07-04T00:00:00Z";

function makeTool(name: string): RegisteredTool & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    execute: async (input) => {
      calls.push(input);
      return { ok: true, result: { done: true } };
    },
  };
}

function makeWorld(tools: Record<string, RegisteredTool> = {}) {
  return createAutomationsWorld({
    policy: defaultFlowletPolicy,
    model: { modelId: "stub" } as unknown as LanguageModel,
    scope: SCOPE,
    tools,
  });
}

function minimalSpec(): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [{ id: "noop", type: "tool", tool: "send_email", input: {} }],
    },
  });
}

function req(body: unknown): Request {
  return new Request("http://localhost:3000/api/flowlet/parked-actions/resolve", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3000" },
  });
}

describe("parked-actions routes", () => {
  it("GET lists unresolved parked actions for the principal", async () => {
    const world = makeWorld();
    const draft = {
      automationId: "a1", runId: "r1", stepId: "s1", tool: "x",
      input: {}, reason: "ungranted" as const, tier: "act" as const,
      descriptorHash: "hash-1", requestedAt: NOW,
    };
    await world.store.createParkedAction(SCOPE, draft);
    const toResolve = await world.store.createParkedAction(SCOPE, { ...draft, stepId: "s2" });
    await world.store.resolveParkedAction(SCOPE, toResolve.id, "declined", NOW);

    const res = await listParkedActionsRoute(new Request("http://localhost:3000/api/flowlet/parked-actions"), {
      world, principal: PRINCIPAL,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: unknown[] };
    expect(body.actions).toHaveLength(1);
  });

  it("404s the list route when automations are disabled (world is null)", async () => {
    const res = await listParkedActionsRoute(new Request("http://localhost:3000/api/flowlet/parked-actions"), {
      world: null, principal: PRINCIPAL,
    });
    expect(res.status).toBe(404);
  });

  it("POST resolve 'yes' executes via the world's runner and returns { ok: true, executed: true }", async () => {
    const tool = makeTool("send_email");
    const world = makeWorld({ send_email: tool });
    const { automation } = await world.store.create(SCOPE, { spec: minimalSpec(), grants: [] });
    const action = await world.store.createParkedAction(SCOPE, {
      automationId: automation.id, runId: "r1", stepId: "s1", tool: "send_email",
      input: { to: "a@b.com" }, reason: "ungranted", tier: "act",
      descriptorHash: hashDescriptor(tool.descriptor), requestedAt: NOW,
    });

    const res = await resolveParkedActionRoute(req({ actionId: action.id, decision: "yes" }), {
      world, principal: PRINCIPAL,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; executed: boolean };
    expect(body).toMatchObject({ ok: true, executed: true });
    expect(tool.calls).toHaveLength(1);
  });

  it("400s a malformed resolve body", async () => {
    const world = makeWorld();
    const res = await resolveParkedActionRoute(req({ nonsense: true }), { world, principal: PRINCIPAL });
    expect(res.status).toBe(400);
  });

  it("404s an unknown actionId", async () => {
    const world = makeWorld();
    const res = await resolveParkedActionRoute(req({ actionId: "missing", decision: "yes" }), {
      world, principal: PRINCIPAL,
    });
    expect(res.status).toBe(404);
  });

  it("404s the resolve route when automations are disabled (world is null)", async () => {
    const res = await resolveParkedActionRoute(req({ actionId: "x", decision: "yes" }), {
      world: null, principal: PRINCIPAL,
    });
    expect(res.status).toBe(404);
  });
});
