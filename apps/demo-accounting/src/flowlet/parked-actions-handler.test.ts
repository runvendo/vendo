import { afterEach, describe, expect, it } from "vitest";
import { automationSpecSchema, hashDescriptor, type AutomationSpec } from "@flowlet/runtime";
import { handleDemoParkedActionsList, handleDemoParkedActionResolve } from "./parked-actions-handler";
import { automationsWorld, CADENCE_SCOPE } from "./automations";

const NOW = "2026-07-04T00:00:00Z";

// Mirrors automations.ts's OWN get_deadlines descriptor exactly (name/source/
// annotations — the only fields hashDescriptor hashes) so a parked action
// seeded here matches the LIVE tool's descriptor at resolve time. The
// singleton world exposes no descriptor lookup for its registered automation
// tools (unlike tool-registry.ts's host-tool resolver), so this is
// reconstructed rather than imported.
const GET_DEADLINES_DESCRIPTOR_HASH = hashDescriptor({
  name: "get_deadlines",
  source: "caller",
  annotations: { readOnlyHint: true },
  hasExecute: true,
  kind: "function",
});

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    headers: { "content-type": "application/json", host: "localhost", ...init.headers },
    ...init,
  });
}

function minimalSpec(): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: { mode: "steps", steps: [{ id: "noop", type: "tool", tool: "get_deadlines", input: {} }] },
  });
}

/** A real, store-registered automation — `resolveParkedAction` looks it up by
 *  id, so a park referencing an id that doesn't exist 404s at that step. */
async function seedAutomationId(): Promise<string> {
  const { store } = automationsWorld();
  const { automation } = await store.create(CADENCE_SCOPE, { spec: minimalSpec(), grants: [] });
  return automation.id;
}

async function seedParkedAction(automationId: string) {
  const { store } = automationsWorld();
  return store.createParkedAction(CADENCE_SCOPE, {
    automationId,
    runId: "demo-run-1",
    stepId: "s1",
    tool: "get_deadlines",
    input: {},
    reason: "ungranted",
    tier: "act",
    descriptorHash: GET_DEADLINES_DESCRIPTOR_HASH,
    requestedAt: NOW,
  });
}

describe("handleDemoParkedActionsList / handleDemoParkedActionResolve", () => {
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.FLOWLET_DEMO_PUBLIC;
  });

  it("lists unresolved parked actions for the demo principal", async () => {
    const { store } = automationsWorld();
    const automationId = await seedAutomationId();
    const action = await seedParkedAction(automationId);
    const other = await seedParkedAction(automationId);
    await store.resolveParkedAction(CADENCE_SCOPE, other.id, "declined", NOW);

    const res = await handleDemoParkedActionsList(req("http://localhost/api/flowlet/parked-actions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: { id: string }[] };
    expect(body.actions.some((a) => a.id === action.id)).toBe(true);
    expect(body.actions.some((a) => a.id === other.id)).toBe(false);
  });

  it("resolves 'yes' by executing through the world's runner", async () => {
    const automationId = await seedAutomationId();
    const action = await seedParkedAction(automationId);
    const res = await handleDemoParkedActionResolve(
      req("http://localhost/api/flowlet/parked-actions/resolve", {
        method: "POST",
        body: JSON.stringify({ actionId: action.id, decision: "yes" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; executed: boolean };
    expect(body).toMatchObject({ ok: true, executed: true });

    const { store } = automationsWorld();
    const resolved = await store.getParkedAction(CADENCE_SCOPE, action.id);
    expect(resolved?.resolution).toBe("approved");
  });

  it("400s a malformed resolve body", async () => {
    const res = await handleDemoParkedActionResolve(
      req("http://localhost/api/flowlet/parked-actions/resolve", {
        method: "POST",
        body: JSON.stringify({ nonsense: true }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404s an unknown actionId on resolve", async () => {
    const res = await handleDemoParkedActionResolve(
      req("http://localhost/api/flowlet/parked-actions/resolve", {
        method: "POST",
        body: JSON.stringify({ actionId: "missing", decision: "yes" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("guards against non-local requests like consent-handler.ts does", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const listRes = await handleDemoParkedActionsList(
      req("https://deployed.example.com/api/flowlet/parked-actions", { headers: { host: "deployed.example.com" } }),
    );
    expect(listRes.status).toBe(403);

    const resolveRes = await handleDemoParkedActionResolve(
      req("https://deployed.example.com/api/flowlet/parked-actions/resolve", {
        method: "POST",
        headers: { host: "deployed.example.com" },
        body: JSON.stringify({ actionId: "x", decision: "yes" }),
      }),
    );
    expect(resolveRes.status).toBe(403);
  });
});
