import { describe, expect, it } from "vitest";
import type { HostToolDefinition } from "@flowlet/core";
import { hostToolset, CLIENT_EXECUTOR_MARKER } from "./host-toolset";
import { buildDescriptor } from "./descriptor";

const orderDef: HostToolDefinition = {
  name: "createOrder",
  description: "Place a delivery order",
  inputSchema: {
    type: "object",
    properties: { body: { type: "object", properties: { merchant: { type: "string" } } } },
    required: ["body"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  http: { method: "post", path: "/api/orders", params: [], hasBody: true },
};

const accountsDef: HostToolDefinition = {
  name: "listAccounts",
  description: "List all accounts",
  inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  http: { method: "get", path: "/api/accounts", params: [], hasBody: false },
};

describe("hostToolset", () => {
  const tools = hostToolset([orderDef, accountsDef]);

  it("keys the toolset by definition name", () => {
    expect(Object.keys(tools).sort()).toEqual(["createOrder", "listAccounts"]);
  });

  it("builds no-execute tools (execution happens in the browser)", () => {
    expect(tools["createOrder"]!.execute).toBeUndefined();
    expect(tools["listAccounts"]!.execute).toBeUndefined();
  });

  it("carries the definition's description and JSON input schema", () => {
    const order = tools["createOrder"]!;
    expect(order.description).toBe("Place a delivery order");
    expect(
      (order.inputSchema as { jsonSchema: unknown }).jsonSchema,
    ).toEqual(orderDef.inputSchema);
  });

  it("marks tools client-executed and exposes annotations for the descriptor layer", () => {
    const descriptor = buildDescriptor("createOrder", tools["createOrder"], "caller");
    expect(descriptor.executor).toBe("client");
    expect(descriptor.annotations).toEqual(orderDef.annotations);
    expect(descriptor.hasExecute).toBe(false);
  });

  it("defaults descriptors of ordinary tools to the server executor", () => {
    const descriptor = buildDescriptor("plain", { execute: async () => "x" }, "caller");
    expect(descriptor.executor).toBe("server");
  });

  it("uses a stable marker field name", () => {
    expect(CLIENT_EXECUTOR_MARKER).toBe("flowletExecutor");
    expect(
      (tools["createOrder"] as Record<string, unknown>)[CLIENT_EXECUTOR_MARKER],
    ).toBe("client");
  });
});
