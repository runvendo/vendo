import { agentRunnerConformance, runConformance } from "@vendoai/core/conformance";
import {
  VENDO_APPS_CREATE_TOOL,
  vendoApprovalRefSchema,
  type ToolDescriptor,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import { buildVendoToolPack } from "./pack.js";
import { VENDO_CREATE_APP_TOOL, VENDO_DELEGATE_TOOL } from "./tool-pack.js";
import {
  boundRegistry,
  ctx,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
  type TestToolImplementation,
} from "./test-helpers.js";

describe("core conformance — AgentRunner seam", () => {
  it("asRunner() passes agentRunnerConformance", async () => {
    const suite = agentRunnerConformance({
      makeRunner: async () => {
        const model = scriptedModel([
          toolCallTurn("conformance_echo", { ping: true }, "call_conformance"),
          textTurn("Echoed the conformance ping once.", "text_conformance"),
        ]);
        const guard = testGuard({});
        return createAgent({ model, tools: boundRegistry({}, guard), guard }).asRunner();
      },
      ctx: ctx({ venue: "automation", presence: "away", sessionId: "run_conformance" }),
    });
    const report = await runConformance(suite);
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

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
    [VENDO_APPS_CREATE_TOOL]: {
      descriptor: packDescriptor(VENDO_APPS_CREATE_TOOL, "read"),
      execute: () => ({ format: "vendo/app@1", id: "app_leaked", name: "leaked", ui: "tree" }),
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
      [VENDO_APPS_CREATE_TOOL]: "ask",
    });
    const registry = boundRegistry(implementations, guard);
    // The REAL runner seam behind vendo_delegate: agent.asRunner() executing
    // over the same guard-bound registry. The scripted model tries one guarded
    // call, sees it park, and finishes.
    const model = scriptedModel([
      toolCallTurn("host_send", { report: "q3" }, "call_delegated_send"),
      textTurn("The send is parked awaiting approval.", "text_delegated"),
    ]);
    const runner = createAgent({ model, tools: registry, guard }).asRunner();
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
      [VENDO_APPS_CREATE_TOOL]: 0,
    });
    expect(JSON.stringify(guard.events)).not.toContain("leaked");
  });
});

it.skip("03-agent §3 clause (4) — catalog + theme summary is assembled for tree venues (Wave 5)", () => {
  // Intentionally visible and skipped until Wave 5 wires catalog/theme into
  // createAgent. Removing the skip before then would contradict the approved
  // staged contract implementation rather than close this Wave 2 test gap.
});
