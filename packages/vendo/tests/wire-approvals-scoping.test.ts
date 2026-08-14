/**
 * ADVERSARIAL CHECK on the umbrella's delegated approvals/grants area: two real
 * people over one real composition. The delegation moved the subject scoping out
 * of this file, so the thing worth proving here is that it did not go missing on
 * the way — on every one of the five, and on the umbrella's own BYO read.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal, RunContext, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createStore, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

const alice: Principal = { kind: "user", subject: "user_alice_check" };
const bob: Principal = { kind: "user", subject: "user_bob_check" };
const ctx: RunContext = { principal: alice, venue: "chat", presence: "present", sessionId: "session_check" };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

/** One deployment, two visitors: the `x-subject` header says which. */
async function setup(): Promise<Vendo> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-approvals-check-"));
  const store: VendoStore = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    async principal(request) {
      return request.headers.get("x-subject") === "bob" ? bob : alice;
    },
    store,
    guard: { policy: { rules: [{ match: { risk: "write" }, action: "ask" }] } },
  });
  vendo.actions.add(host);
  await store.ensureSchema();
  return vendo;
}

const request = (method: string, path: string, as: "alice" | "bob" = "alice", body?: unknown): Request =>
  new Request(`https://host.test/api/vendo${path}`, {
    method,
    headers: {
      "x-subject": as,
      ...(["POST", "PUT", "PATCH", "DELETE"].includes(method) ? { "content-type": "application/json" } : {}),
    },
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

describe.sequential("CHECK: the umbrella's five routes are still owner-scoped after delegating", () => {
  it("hands Bob none of Alice's asks, and lets him decide or take back none of them", async () => {
    const vendo = await setup();
    const approvalId = await park(vendo, "call_check_1");

    expect(await (await vendo.handler(request("GET", "/approvals", "bob"))).json()).toEqual([]);

    const stolen = await vendo.handler(request("POST", "/approvals/decide", "bob", {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    expect(stolen.status).toBe(404);

    expect((await vendo.handler(request("DELETE", `/approvals/${approvalId}`, "bob"))).status).toBe(404);
    // The umbrella's OWN per-approval read, which the shared wire has not got.
    expect((await vendo.handler(request("GET", `/approvals/${approvalId}`, "bob"))).status).toBe(404);

    expect(await vendo.guard.approvals.pending(alice)).toHaveLength(1);
    expect(await vendo.guard.grants.list(bob)).toEqual([]);
  });

  it("hands Bob none of Alice's grants, and lets him revoke none of them", async () => {
    const vendo = await setup();
    const approvalId = await park(vendo, "call_check_2");
    await vendo.handler(request("POST", "/approvals/decide", "alice", {
      ids: [approvalId],
      decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    }));
    const [grant] = await vendo.guard.grants.list(alice);

    expect(await (await vendo.handler(request("GET", "/grants", "bob"))).json()).toEqual([]);
    expect((await vendo.handler(request("DELETE", `/grants/${grant!.id}`, "bob"))).status).toBe(404);

    const [still] = await vendo.guard.grants.list(alice);
    expect(still!.id).toBe(grant!.id);
    expect(still!.revokedAt).toBeUndefined();
  });
});
