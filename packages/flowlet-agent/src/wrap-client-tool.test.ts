import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { wrapClientTool } from "./wrap-client-tool";
import { buildToolset } from "./toolset";
import { hostToolset } from "./host-toolset";
import type { HostToolDefinition } from "@flowlet/core";
import type { ApprovalPolicy, ApprovalDecision } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import { FlowletError } from "./errors";

const PRINCIPAL = { userId: "user-1" };

function clientDescriptor(name: string): ToolDescriptor {
  return {
    name,
    source: "caller",
    annotations: { readOnlyHint: false },
    hasExecute: false,
    kind: "function",
    executor: "client",
  };
}

function fixedPolicy(decision: ApprovalDecision): ApprovalPolicy {
  return { evaluate: () => decision };
}

const bareTool: Tool = { description: "no execute", inputSchema: undefined as never };

describe("wrapClientTool", () => {
  it("maps policy 'approve' to needsApproval=true", async () => {
    const wrapped = wrapClientTool({
      name: "createOrder",
      tool: bareTool,
      descriptor: clientDescriptor("createOrder"),
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
    });
    const needsApproval = wrapped.needsApproval as (input: unknown) => Promise<boolean>;
    await expect(needsApproval({})).resolves.toBe(true);
  });

  it("maps policy 'allow' to needsApproval=false", async () => {
    const wrapped = wrapClientTool({
      name: "listAccounts",
      tool: bareTool,
      descriptor: clientDescriptor("listAccounts"),
      policy: fixedPolicy("allow"),
      principal: PRINCIPAL,
    });
    const needsApproval = wrapped.needsApproval as (input: unknown) => Promise<boolean>;
    await expect(needsApproval({})).resolves.toBe(false);
  });

  it("fails closed on policy 'deny': needsApproval throws a policy error", async () => {
    const wrapped = wrapClientTool({
      name: "createTransfer",
      tool: bareTool,
      descriptor: clientDescriptor("createTransfer"),
      policy: fixedPolicy("deny"),
      principal: PRINCIPAL,
    });
    const needsApproval = wrapped.needsApproval as (input: unknown) => Promise<boolean>;
    await expect(needsApproval({})).rejects.toThrow(FlowletError);
    await expect(needsApproval({})).rejects.toThrow(/denied/);
  });

  it("never adds an execute (the browser owns execution)", () => {
    const wrapped = wrapClientTool({
      name: "createOrder",
      tool: bareTool,
      descriptor: clientDescriptor("createOrder"),
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
    });
    expect(wrapped.execute).toBeUndefined();
  });

  it("refuses a tool that carries an execute (contradicts client execution)", () => {
    const serverTool: Tool = {
      ...bareTool,
      execute: async () => "server ran",
    };
    expect(() =>
      wrapClientTool({
        name: "bad",
        tool: serverTool,
        descriptor: { ...clientDescriptor("bad"), hasExecute: true },
        policy: fixedPolicy("allow"),
        principal: PRINCIPAL,
      }),
    ).toThrow(/execute/);
  });
});

describe("buildToolset with client-executed tools", () => {
  const orderDef: HostToolDefinition = {
    name: "createOrder",
    description: "Place a delivery order",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    http: { method: "post", path: "/api/orders", params: [], hasBody: false },
  };

  it("registers marked client tools instead of skipping them", () => {
    const skipped: string[] = [];
    const tools = buildToolset({
      sources: [{ source: "caller", tools: hostToolset([orderDef]) }],
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
      onSkip: (name) => skipped.push(name),
    });
    expect(skipped).toEqual([]);
    expect(tools["createOrder"]).toBeDefined();
    expect(tools["createOrder"]!.execute).toBeUndefined();
    expect(typeof tools["createOrder"]!.needsApproval).toBe("function");
  });

  it("still fails closed on UNMARKED no-execute tools", () => {
    const skipped: string[] = [];
    const tools = buildToolset({
      sources: [{ source: "caller", tools: { orphan: bareTool } }],
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
      onSkip: (name) => skipped.push(name),
    });
    expect(skipped).toEqual(["orphan"]);
    expect(tools["orphan"]).toBeUndefined();
  });
});
