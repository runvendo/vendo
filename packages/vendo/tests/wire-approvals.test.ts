/**
 * The umbrella's approvals/grants area after it became a DELEGATE to
 * @vendoai/guard's one permission wire. Driven whole — the real composition,
 * the real guard, a real park through `vendo.guardedTools` — because what is at
 * risk in a delegation is precisely that the umbrella's OWN extras get lost:
 * the `?org=` cloud clamp on all five routes, and the BYO `GET /approvals/:id`
 * the shared wire does not have.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const principal: Principal = { kind: "user", subject: "user_approvals_wire" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_approvals_wire" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-approvals-wire-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

const descriptor: ToolDescriptor = {
  name: "host_send_report",
  description: "Send a report",
  inputSchema: { type: "object", properties: { body: { type: "string" } } },
  risk: "write",
};

const host: ToolRegistry = {
  async descriptors() {
    return [descriptor];
  },
  async execute(toolCall) {
    return { status: "ok", output: { sent: toolCall.args } };
  },
};

async function setup(): Promise<Vendo> {
  const store = await tempStore();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } },
  });
  vendo.actions.add(host);
  await store.ensureSchema();
  return vendo;
}

/** The wire's CSRF gate wants `application/json` on every mutation, body or no. */
const request = (method: string, path: string, body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    ...(["POST", "PUT", "PATCH", "DELETE"].includes(method)
      ? { headers: { "content-type": "application/json" } }
      : {}),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function park(vendo: Vendo, callId: string): Promise<string> {
  const outcome = await vendo.guardedTools.execute(
    { id: callId, tool: descriptor.name, args: { body: "the report" } },
    ctx,
  );
  if (outcome.status !== "pending-approval") throw new Error(`expected a park, got ${outcome.status}`);
  return outcome.approvalId;
}

describe.sequential("the umbrella's approvals and grants wire", () => {
  it("serves the five shared routes off the real guard, park to grant to revoke", async () => {
    const vendo = await setup();
    const approvalId = await park(vendo, "call_five_1");

    const pending = await vendo.handler(request("GET", "/approvals"));
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject([{ id: approvalId }]);

    const decided = await vendo.handler(request("POST", "/approvals/decide", {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    expect(decided.status).toBe(200);

    const listed = await vendo.handler(request("GET", "/grants"));
    expect(listed.status).toBe(200);
    const grants = await listed.json() as Array<{ id: string; tool: string }>;
    expect(grants).toMatchObject([{ tool: descriptor.name }]);

    const revoked = await vendo.handler(request("DELETE", `/grants/${grants[0]!.id}`));
    expect(revoked.status).toBe(200);
    expect(await vendo.guard.grants.list(principal)).toMatchObject([{ revokedAt: expect.any(String) }]);

    // "I take that back" on the decision itself — the other durable answer.
    const denied = await park(vendo, "call_five_2");
    await vendo.handler(request("POST", "/approvals/decide", { ids: [denied], decision: { approve: false } }));
    const takenBack = await vendo.handler(request("DELETE", `/approvals/${denied}`));
    expect(takenBack.status).toBe(200);
  });

  it("still refuses an org-scoped request on EVERY one of the five", async () => {
    const vendo = await setup();
    const approvalId = await park(vendo, "call_org_1");

    const responses = await Promise.all([
      vendo.handler(request("GET", "/approvals?org=org_x")),
      vendo.handler(request("DELETE", `/approvals/${approvalId}?org=org_x`)),
      vendo.handler(request("POST", "/approvals/decide", { ids: [approvalId], decision: { approve: true }, org: "org_x" })),
      vendo.handler(request("GET", "/grants?org=org_x")),
      vendo.handler(request("DELETE", "/grants/grt_x?org=org_x")),
    ]);

    expect(responses.map((response) => response.status)).toEqual([402, 402, 402, 402, 402]);
    // Refused, not half-done: the ask is still pending.
    expect(await vendo.guard.approvals.pending(principal)).toHaveLength(1);
  });

  it("still serves the umbrella's OWN per-approval read, which the shared wire has not got", async () => {
    const vendo = await setup();
    const approvalId = await park(vendo, "call_byo_1");

    const read = await vendo.handler(request("GET", `/approvals/${approvalId}`));

    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: "pending", request: { call: { tool: descriptor.name } } });
    // Owner-scoped, and an unknown id is indistinguishable from a foreign one.
    expect((await vendo.handler(request("GET", "/approvals/apr_nope"))).status).toBe(404);
  });

  it("keeps refusing a decide with no ids and an unknown grant", async () => {
    const vendo = await setup();

    expect((await vendo.handler(request("POST", "/approvals/decide", { ids: [] }))).status).toBe(400);
    expect((await vendo.handler(request("POST", "/approvals/decide", { ids: ["apr_x"] }))).status).toBe(400);
    expect((await vendo.handler(request("DELETE", "/grants/grt_nope"))).status).toBe(404);
  });
});
