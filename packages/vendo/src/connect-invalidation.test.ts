import type { Connector, ConnectorAccount } from "@vendoai/actions";
import type { LanguageModel } from "ai";
import type { Principal, RunContext, ToolDescriptor } from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

/**
 * Checker F2: disconnecting a service must take effect IMMEDIATELY.
 *
 * The connect gate reads a 60s per-subject cache of connected toolkits. Left
 * un-invalidated, a disconnect stays invisible for up to a minute: the gate
 * waves the call through, the guard mints an approval, and the user is asked
 * to approve a call that cannot possibly run — the exact failure the gate
 * exists to prevent, inverted.
 */

const principal: Principal = { kind: "user", subject: "user_ada" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_1" };

const GMAIL_SEND: ToolDescriptor = {
  name: "gmail_GMAIL_SEND_EMAIL",
  description: "Send an email",
  inputSchema: { type: "object" },
  risk: "write",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A BYO broker holding ONE active gmail account that `disconnect` removes. */
function brokerWithGmail() {
  let accounts: ConnectorAccount[] = [
    { id: "ca_gmail", connector: "composio", toolkit: "gmail", status: "active" },
  ];
  const executed: string[] = [];
  const connector: Connector = {
    name: "composio",
    descriptors: async () => [GMAIL_SEND],
    execute: async (call) => {
      executed.push(call.tool);
      return { status: "ok", output: { sent: true } };
    },
    toolkitOf: (tool) => (tool.startsWith("gmail_") ? "gmail" : undefined),
    connections: {
      list: async () => accounts,
      initiate: async () => ({ id: "ca_new", redirectUrl: "https://connect.test/x" }),
      status: async () => accounts[0] ?? null,
      disconnect: async (_subject, connectionId) => {
        accounts = accounts.filter((account) => account.id !== connectionId);
      },
      listConnectable: async () => [{ toolkit: "gmail" }],
    },
  };
  return { connector, executed };
}

async function composeVendo(connector: Connector) {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-connect-invalidation-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const vendo = createVendo({
    model: {} as LanguageModel,
    store,
    connectors: [connector],
    principal: vi.fn(async () => principal),
    policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
  });
  await vendo.handler(new Request("http://invalidation.test/api/vendo/status"));
  return vendo;
}

describe("disconnect invalidates the connected-toolkit cache (checker F2)", () => {
  it("a call immediately after disconnect returns connect-required and mints NO approval", async () => {
    const { connector, executed } = brokerWithGmail();
    const vendo = await composeVendo(connector);

    // 1. Connected: the write is guarded, so it parks as an approval. This
    //    also WARMS the 60s cache with "gmail is connected" — the state the
    //    disconnect below has to defeat.
    const before = await vendo.guardedTools.execute(
      { id: "call_before", tool: GMAIL_SEND.name, args: { to: "a@b.c" } },
      ctx,
    );
    expect(before.status).toBe("pending-approval");
    expect(await vendo.guard.approvals.pending(principal)).toHaveLength(1);

    // 2. Disconnect the way the product does — the wire route the connect
    //    dock's "Disconnect" button calls.
    const disconnected = await vendo.handler(new Request(
      "http://invalidation.test/api/vendo/connections/ca_gmail?connector=composio",
      { method: "DELETE", headers: { "content-type": "application/json" } },
    ));
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);

    // 3. Immediately — well inside the 60s TTL — the same call must be
    //    refused with a connect card, and must not mint a SECOND approval.
    const after = await vendo.guardedTools.execute(
      { id: "call_after", tool: GMAIL_SEND.name, args: { to: "a@b.c" } },
      ctx,
    );
    expect(after).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
    expect(await vendo.guard.approvals.pending(principal)).toHaveLength(1);
    // The broker was never asked to run either call.
    expect(executed).toEqual([]);
  });

  it("an unrelated subject's cache entry survives another subject's disconnect", async () => {
    const { connector } = brokerWithGmail();
    const vendo = await composeVendo(connector);
    const other: Principal = { kind: "user", subject: "user_bob" };
    const otherCtx: RunContext = { ...ctx, principal: other };

    // Warm both subjects (the shared broker reports gmail active for anyone).
    await vendo.guardedTools.execute({ id: "c1", tool: GMAIL_SEND.name, args: {} }, ctx);
    await vendo.guardedTools.execute({ id: "c2", tool: GMAIL_SEND.name, args: {} }, otherCtx);

    const disconnected = await vendo.handler(new Request(
      "http://invalidation.test/api/vendo/connections/ca_gmail?connector=composio",
      { method: "DELETE", headers: { "content-type": "application/json" } },
    ));
    expect(disconnected.status, await disconnected.clone().text()).toBe(200);

    // Bob still resolves through his own (still warm) entry: the invalidation
    // is per-subject, never a global cache flush.
    const bob = await vendo.guardedTools.execute({ id: "c3", tool: GMAIL_SEND.name, args: {} }, otherCtx);
    expect(bob.status).toBe("pending-approval");
  });
});
