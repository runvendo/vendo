import { createActions, createConnectGate, type Connector } from "@vendoai/actions";
import type { Principal, RunContext, ToolDescriptor } from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import { createGuard } from "@vendoai/guard";
import { describe, expect, it, vi } from "vitest";

/** Criterion 11 (discovery-discipline): dispatching a tool call for an
 * UNCONNECTED brokered service returns the connect-required flow without any
 * approval being minted — the connect gate rules before the guard is ever
 * consulted. The exact composition createVendo uses:
 * connectGate.bind(guard.bind(actions)). */

const principal: Principal = { kind: "user", subject: "user_ada" };
const ctx: RunContext = { principal, venue: "chat", presence: "present", sessionId: "session_1" };

const GMAIL_DESCRIPTOR: ToolDescriptor = {
  name: "gmail_GMAIL_SEND_EMAIL",
  description: "Send an email",
  inputSchema: { type: "object" },
  risk: "write",
};

function brokeredConnector(executed: string[]): Connector {
  return {
    name: "composio",
    descriptors: async () => [GMAIL_DESCRIPTOR],
    execute: async (call) => {
      executed.push(call.tool);
      return { status: "ok", output: { sent: true } };
    },
    toolkitOf: (tool) => (tool.startsWith("gmail_") ? "gmail" : undefined),
  };
}

async function compose(connected: boolean) {
  const executed: string[] = [];
  const actions = createActions({ connectors: [brokeredConnector(executed)] });
  const guard = createGuard({
    store: memoryStoreAdapter(),
    policy: { rules: [{ match: { risk: "write" }, action: "ask" }] },
  });
  const isConnected = vi.fn(async () => connected);
  const gate = createConnectGate({
    toolkitOf: (tool) => actions.connectorToolkit(tool),
    isConnected,
  });
  const bound = gate.bind(guard.bind(actions));
  return { bound, guard, executed, isConnected };
}

describe("connect gate before guard (criterion 11)", () => {
  it("unconnected: connect-required returns, the approvals store stays UNTOUCHED, nothing executes", async () => {
    const { bound, guard, executed } = await compose(false);

    const outcome = await bound.execute({ id: "call_1", tool: GMAIL_DESCRIPTOR.name, args: {} }, ctx);
    expect(outcome).toMatchObject({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail" },
    });
    expect(executed).toEqual([]);
    await expect(guard.approvals.pending(principal)).resolves.toEqual([]);
  });

  it("REGRESSION — connected + write still asks: the approval flow is intact", async () => {
    const { bound, guard, executed } = await compose(true);

    const outcome = await bound.execute({ id: "call_2", tool: GMAIL_DESCRIPTOR.name, args: {} }, ctx);
    expect(outcome).toMatchObject({ status: "pending-approval" });
    expect(executed).toEqual([]);
    const pending = await guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.call.tool).toBe(GMAIL_DESCRIPTOR.name);
  });

  it("host tools (no toolkit) pass the gate regardless of connection state", async () => {
    const { bound, isConnected } = await compose(false);
    // Unknown to the connector's toolkitOf → ungated; the guard answers
    // not-found because no such tool exists, but no connect card appears.
    const outcome = await bound.execute({ id: "call_3", tool: "host_do_thing", args: {} }, ctx);
    expect(outcome.status).not.toBe("connect-required");
    expect(isConnected).not.toHaveBeenCalled();
  });
});
