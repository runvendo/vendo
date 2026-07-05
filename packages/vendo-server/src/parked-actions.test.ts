import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { automationSpecSchema, hashDescriptor, type AutomationSpec, type RegisteredTool } from "@vendoai/runtime";
import { createAutomationsWorld } from "./world";
import { defaultVendoPolicy } from "./default-policy";
import { listParkedActionsRoute, resolveParkedActionRoute } from "./parked-actions";

const PRINCIPAL = { userId: "u1" };
const SCOPE = { tenantId: "vendo-embedded", subject: "u1" };
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
    policy: defaultVendoPolicy,
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
  return new Request("http://localhost:3000/api/vendo/parked-actions/resolve", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", host: "localhost:3000" },
  });
}

describe("parked-actions routes", () => {
  it("GET lists unresolved parked actions for the principal", async () => {
    const world = await makeWorld();
    const draft = {
      automationId: "a1", runId: "r1", stepId: "s1", tool: "x",
      input: {}, reason: "ungranted" as const, tier: "act" as const,
      descriptorHash: "hash-1", requestedAt: NOW,
    };
    await world.store.createParkedAction(SCOPE, draft);
    const toResolve = await world.store.createParkedAction(SCOPE, { ...draft, stepId: "s2" });
    await world.store.resolveParkedAction(SCOPE, toResolve.id, "declined", NOW);

    const res = await listParkedActionsRoute(new Request("http://localhost:3000/api/vendo/parked-actions"), {
      world, principal: PRINCIPAL,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: unknown[] };
    expect(body.actions).toHaveLength(1);
  });

  it("404s the list route when automations are disabled (world is null)", async () => {
    const res = await listParkedActionsRoute(new Request("http://localhost:3000/api/vendo/parked-actions"), {
      world: null, principal: PRINCIPAL,
    });
    expect(res.status).toBe(404);
  });

  it("POST resolve 'yes' executes via the world's runner and returns { ok: true, executed: true }", async () => {
    const tool = makeTool("send_email");
    const world = await makeWorld({ send_email: tool });
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
    const world = await makeWorld();
    const res = await resolveParkedActionRoute(req({ nonsense: true }), { world, principal: PRINCIPAL });
    expect(res.status).toBe(400);
  });

  it("404s an unknown actionId", async () => {
    const world = await makeWorld();
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

  it("REVIEW FOLLOW-UP: routes scope by the WORLD's fixed scope, not the per-request principal — a custom-principal mount still sees and can resolve rows the world parked", async () => {
    const tool = makeTool("send_email");
    const world = await makeWorld({ send_email: tool });
    const { automation } = await world.store.create(SCOPE, { spec: minimalSpec(), grants: [] });
    // The parked row lives under the WORLD's own scope, as the runner always
    // creates it (single-tenant, world.ts's documented model) — NOT under
    // whatever a custom `principal` resolver might return per request.
    const action = await world.store.createParkedAction(SCOPE, {
      automationId: automation.id, runId: "r1", stepId: "s1", tool: "send_email",
      input: { to: "a@b.com" }, reason: "ungranted", tier: "act",
      descriptorHash: hashDescriptor(tool.descriptor), requestedAt: NOW,
    });

    // A DIFFERENT resolved principal than the world's own scope subject
    // (simulating a custom multi-tenant `principal` resolver) — the row must
    // still be visible and resolvable, because the routes key off
    // `world.scope`, not this value.
    const customPrincipal = { userId: "custom-user-not-the-world-subject" };

    const listRes = await listParkedActionsRoute(
      new Request("http://localhost:3000/api/vendo/parked-actions"),
      { world, principal: customPrincipal },
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { actions: { id: string }[] };
    expect(listBody.actions.map((a) => a.id)).toContain(action.id);

    const resolveRes = await resolveParkedActionRoute(req({ actionId: action.id, decision: "yes" }), {
      world, principal: customPrincipal,
    });
    expect(resolveRes.status).toBe(200);
    const resolveBody = (await resolveRes.json()) as { ok: boolean; executed: boolean };
    expect(resolveBody).toMatchObject({ ok: true, executed: true });
    expect(tool.calls).toHaveLength(1);
  });
});
