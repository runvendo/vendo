import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "./server.js";

// Existing-agents Lane B — the wire surface over the parked-BYO-call seam:
// `vendo.guardedTools` is the parking registry the tool pack executes through,
// `GET /approvals/:id` answers <VendoApprovalEmbed>'s "what happened to
// apr_x?", and the amortized on-request sweep expires orphaned parked calls on
// the injected session clock.

const principal: Principal = { kind: "user", subject: "user_byo_wire" };
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_byo_wire",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function tempStore(): Promise<VendoStore> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-byo-wire-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.ensureSchema().catch(() => undefined);
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return store;
}

function messagingHost(): {
  tools: ToolRegistry;
  delivered: Array<{ clientId: string; body: string }>;
} {
  const delivered: Array<{ clientId: string; body: string }> = [];
  const descriptor: ToolDescriptor = {
    name: "host_sendClientMessage",
    description: "Message a client about their account",
    inputSchema: {
      type: "object",
      properties: { clientId: { type: "string" }, body: { type: "string" } },
      required: ["clientId", "body"],
    },
    risk: "write",
  };
  return {
    delivered,
    tools: {
      async descriptors() {
        return [descriptor];
      },
      async execute(call) {
        const { clientId, body } = call.args as { clientId: string; body: string };
        delivered.push({ clientId, body });
        return { status: "ok", output: { delivered: true } };
      },
    },
  };
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`https://host.test/api/vendo${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function setup(options: { parkedCallTtlMs?: number; clock?: () => number } = {}): Promise<{
  vendo: Vendo;
  host: ReturnType<typeof messagingHost>;
}> {
  const store = await tempStore();
  const host = messagingHost();
  const vendo = createVendo({
    model: {} as LanguageModel,
    principal: async () => principal,
    store,
    policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
    ...(options.parkedCallTtlMs === undefined
      ? {}
      : { approvals: { parkedCallTtlMs: options.parkedCallTtlMs } }),
    ...(options.clock === undefined
      ? {}
      : { sessions: { ttlMs: 0, sweepIntervalMs: 1, now: options.clock } }),
  });
  vendo.actions.add(host.tools);
  // The wire awaits schema readiness itself; the direct guardedTools park in
  // these tests happens before any request, so await it here.
  await store.ensureSchema();
  return { vendo, host };
}

async function park(vendo: Vendo, callId: string): Promise<string> {
  const outcome = await vendo.guardedTools.execute(
    { id: callId, tool: "host_sendClientMessage", args: { clientId: "cli_1", body: "Send the report" } },
    ctx,
  );
  if (outcome.status !== "pending-approval") throw new Error(`expected park, got ${outcome.status}`);
  return outcome.approvalId;
}

describe.sequential("existing-agents — the BYO approval wire surface", () => {
  it("serves pending → decide → executed through GET /approvals/:id", async () => {
    const { vendo, host } = await setup();
    const approvalId = await park(vendo, "call_wire_1");

    const pending = await vendo.handler(request("GET", `/approvals/${approvalId}`));
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(pendingBody.state).toBe("pending");
    expect(pendingBody.request.call.tool).toBe("host_sendClientMessage");

    const decided = await vendo.handler(
      request("POST", "/approvals/decide", { ids: [approvalId], decision: { approve: true } }),
    );
    expect(decided.status).toBe(200);
    expect(host.delivered).toEqual([{ clientId: "cli_1", body: "Send the report" }]);

    const resolved = await vendo.handler(request("GET", `/approvals/${approvalId}`));
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toEqual({
      state: "executed",
      outcome: { status: "ok", output: { delivered: true } },
    });
  });

  it("serves declined after a deny and 404 for unknown ids", async () => {
    const { vendo, host } = await setup();
    const approvalId = await park(vendo, "call_wire_2");

    await vendo.handler(
      request("POST", "/approvals/decide", { ids: [approvalId], decision: { approve: false } }),
    );
    expect(host.delivered).toHaveLength(0);
    const resolved = await vendo.handler(request("GET", `/approvals/${approvalId}`));
    expect(await resolved.json()).toEqual({ state: "declined" });

    expect((await vendo.handler(request("GET", "/approvals/apr_missing"))).status).toBe(404);
  });

  it("expires an orphaned parked call via the on-request sweep and serves expired", async () => {
    let at = Date.now();
    const { vendo, host } = await setup({ parkedCallTtlMs: 10_000, clock: () => at });
    const approvalId = await park(vendo, "call_wire_3");

    // Past the parked TTL: the next request's amortized sweep denies it.
    // Re-anchor on the real clock — parkedAt is stamped when the park lands,
    // which under suite load can be seconds after this test's first Date.now().
    at = Date.now() + 11_000;
    expect((await vendo.handler(request("GET", "/status"))).status).toBe(200);

    const resolved = await vendo.handler(request("GET", `/approvals/${approvalId}`));
    expect(await resolved.json()).toEqual({ state: "expired" });
    expect(host.delivered).toHaveLength(0);
  });
});
