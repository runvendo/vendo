import { describe, expect, it } from "vitest";
import type { Tool } from "ai";
import { wrapClientTool } from "./wrap-client-tool";
import { buildToolset } from "./toolset";
import { hostToolset } from "./host-toolset";
import type { HostToolDefinition } from "@vendoai/core";
import type { ApprovalPolicy, ApprovalDecision, PolicyContext } from "./policy";
import type { ToolDescriptor } from "./descriptor";
import { VendoError } from "./errors";
import { createRunPolicyContext } from "./policy/run-context";
import { setEscalationReason } from "./policy/escalation";

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
    const needsApproval = wrapped.needsApproval as (
      input: unknown,
      options: { toolCallId: string },
    ) => Promise<boolean>;
    await expect(needsApproval({}, { toolCallId: "call-test" })).resolves.toBe(true);
  });

  it("maps policy 'allow' to needsApproval=false", async () => {
    const wrapped = wrapClientTool({
      name: "listAccounts",
      tool: bareTool,
      descriptor: clientDescriptor("listAccounts"),
      policy: fixedPolicy("allow"),
      principal: PRINCIPAL,
    });
    const needsApproval = wrapped.needsApproval as (
      input: unknown,
      options: { toolCallId: string },
    ) => Promise<boolean>;
    await expect(needsApproval({}, { toolCallId: "call-test" })).resolves.toBe(false);
  });

  it("fails closed on policy 'deny': needsApproval throws a policy error", async () => {
    const wrapped = wrapClientTool({
      name: "createTransfer",
      tool: bareTool,
      descriptor: clientDescriptor("createTransfer"),
      policy: fixedPolicy("deny"),
      principal: PRINCIPAL,
    });
    const needsApproval = wrapped.needsApproval as (
      input: unknown,
      options: { toolCallId: string },
    ) => Promise<boolean>;
    await expect(needsApproval({}, { toolCallId: "call-test" })).rejects.toThrow(VendoError);
    await expect(needsApproval({}, { toolCallId: "call-test" })).rejects.toThrow(/denied/);
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

  it("writes ONE data-consent part at needsApproval time for a non-read tool, decision 'approve'", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
      writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-1", messages: [] } as never);
    expect(writes).toEqual([
      { type: "data-consent", id: "consent-call-1", data: { toolCallId: "call-1", tier: "act", unverified: false } },
    ]);
  });

  it("writes the data-consent part even when the decision is 'allow' (receipts, Moment 2)", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: fixedPolicy("allow"),
      principal: PRINCIPAL,
      writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-2", messages: [] } as never);
    expect(writes).toHaveLength(1);
    expect((writes[0] as { data: { tier: string } }).data.tier).toBe("act");
  });

  it("writes NOTHING for a read-tier tool", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const readDescriptor: ToolDescriptor = {
      ...clientDescriptor("get_x"),
      annotations: { readOnlyHint: true },
    };
    const wrapped = wrapClientTool({
      name: "get_x",
      tool: bareTool,
      descriptor: readDescriptor,
      policy: fixedPolicy("allow"),
      principal: PRINCIPAL,
      writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-3", messages: [] } as never);
    expect(writes).toHaveLength(0);
  });

  it("works with no writer at all (no card client, no crash)", async () => {
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
    });
    await expect(wrapped.needsApproval!({}, { toolCallId: "call-4", messages: [] } as never)).resolves.toBe(true);
  });

  it("a throwing writer still resolves needsApproval normally (consent write must never break the tool call)", async () => {
    const writer = {
      write: () => {
        throw new Error("stream torn down");
      },
    } as never;
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: fixedPolicy("approve"),
      principal: PRINCIPAL,
      writer,
    });
    await expect(
      wrapped.needsApproval!({}, { toolCallId: "call-5", messages: [] } as never),
    ).resolves.toBe(true);
  });

  it("threads request/provenance/counters from a RunPolicyContext into evaluate", async () => {
    const seen: PolicyContext[] = [];
    const spyPolicy: ApprovalPolicy = { evaluate: (ctx) => { seen.push(ctx); return "allow"; } };
    const runContext = createRunPolicyContext({ text: "email jim", messageId: "m1" });
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: spyPolicy,
      principal: PRINCIPAL,
      runContext,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-6", messages: [] } as never);
    expect(seen[0]!.request).toEqual({ text: "email jim", messageId: "m1" });
    expect(seen[0]!.counters).toEqual({ toolCallsThisTurn: 1, perTool: { send_email: 1 } });
    expect(seen[0]!.provenance).toEqual({ taintedSources: [] });
  });

  it("writes the escalation reason onto the data-consent part when the policy stamped one", async () => {
    const writes: unknown[] = [];
    const writer = { write: (part: unknown) => writes.push(part) } as never;
    const reasonPolicy: ApprovalPolicy = {
      evaluate(ctx) {
        setEscalationReason(ctx, "an email I read asked for this");
        return "approve";
      },
    };
    const wrapped = wrapClientTool({
      name: "send_email",
      tool: bareTool,
      descriptor: clientDescriptor("send_email"),
      policy: reasonPolicy,
      principal: PRINCIPAL,
      writer,
    });
    await wrapped.needsApproval!({}, { toolCallId: "call-7", messages: [] } as never);
    expect(writes).toEqual([
      { type: "data-consent", id: "consent-call-7", data: { toolCallId: "call-7", tier: "act", unverified: false, reason: "an email I read asked for this" } },
    ]);
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
