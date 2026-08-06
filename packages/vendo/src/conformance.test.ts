import {
  VENDO_MAKE_TOOL,
  vendoApprovalRefSchema,
  type AgentRunner,
  type ToolDescriptor,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildVendoToolPack } from "./pack.js";
import { VENDO_CREATE_APP_TOOL, VENDO_DELEGATE_TOOL } from "./tool-pack.js";
import {
  boundRegistry,
  ctx,
  testGuard,
  type TestToolImplementation,
} from "./agent-doubles.test-util.js";

describe("tool-pack conformance — every pack tool routes through the guard", () => {
  const packDescriptor = (name: string, risk: ToolDescriptor["risk"]): ToolDescriptor => ({
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    risk,
  });
  const implementations: Record<string, TestToolImplementation> = {
    host_lookup: { descriptor: packDescriptor("host_lookup", "read"), execute: () => ({ leaked: true }) },
    host_send: { descriptor: packDescriptor("host_send", "write"), execute: () => ({ leaked: true }) },
    [VENDO_MAKE_TOOL]: {
      descriptor: packDescriptor(VENDO_MAKE_TOOL, "read"),
      execute: () => ({ id: "app_leaked", title: "leaked", status: "ready", say: "leaked" }),
    },
  };
  const inputFor = (name: string): unknown => {
    if (name === VENDO_CREATE_APP_TOOL) return { prompt: "an approval-gated app" };
    if (name === VENDO_DELEGATE_TOOL) return { task: "send the report" };
    return {};
  };

  it("ask-everything policy: no pack tool executes; each call parks and returns the approval envelope", async () => {
    const guard = testGuard({
      host_lookup: "ask",
      host_send: "ask",
      [VENDO_MAKE_TOOL]: "ask",
    });
    const registry = boundRegistry(implementations, guard);
    // The runner seam behind vendo_delegate, exercised over the pack's OWN
    // registry so the delegated call meets the same guard every other pack tool
    // does. The shipped motor is `awayRunner`, which needs a SQL store this
    // in-memory suite has no business booting — it is proven on the real thing
    // in delegate.test.ts and by agentRunnerConformance in automations-e2e.
    const delegatedCall = { id: "call_delegated_send", tool: "host_send", args: { report: "q3" } };
    const runner: AgentRunner = async (task, runCtx) => ({
      status: "ok",
      summary: "The send is parked awaiting approval.",
      toolCalls: [{ call: delegatedCall, outcome: (await task.tools.execute(delegatedCall, runCtx)).status }],
    });
    const pack = await buildVendoToolPack({ registry, runner });
    expect(pack.map((tool) => tool.name).sort()).toEqual([
      VENDO_CREATE_APP_TOOL,
      VENDO_DELEGATE_TOOL,
      "vendo_host_lookup",
      "vendo_host_send",
    ]);

    for (const tool of pack) {
      const output = await tool.execute(inputFor(tool.name), { ctx: ctx() });
      if (tool.name === VENDO_DELEGATE_TOOL) {
        const result = output as { status: string; refs: unknown[] };
        expect(result.status).toBe("ok");
        expect(result.refs).toHaveLength(1);
        vendoApprovalRefSchema.parse(result.refs[0]);
      } else {
        vendoApprovalRefSchema.parse(output);
      }
    }

    // The guard held EVERY call — nothing reachable from the pack executed.
    expect(registry.invocations).toEqual({
      host_lookup: 0,
      host_send: 0,
      [VENDO_MAKE_TOOL]: 0,
    });
    expect(JSON.stringify(guard.events)).not.toContain("leaked");
  });
});
