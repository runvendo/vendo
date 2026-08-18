/**
 * The SEAM: turn-tools previews through `previewApproval` and dispatches
 * through `guardedCall` moments later, and the REAL guard is what has to
 * recognize the two as one logical call. A double with an opinion about
 * previews would prove nothing here — the whole question is whether the
 * descriptor, the ctx and the call id that reach `previewCheck` are the ones
 * that reach `bind().execute`, so both sides are real.
 */
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { RunContext, ToolCall, ToolDescriptor, ToolRegistry } from "@vendoai/core";
import { createGuard, type Judge } from "@vendoai/guard";
import { describe, expect, it } from "vitest";
import { createTurnTools } from "../src/turn-tools.js";
import { ctx } from "../src/test-doubles.test-util.js";

const writeTool: ToolDescriptor = {
  name: "host_write",
  description: "writes something",
  inputSchema: { type: "object", additionalProperties: true },
  risk: "write",
};

function hostTools(): ToolRegistry & { executions: ToolCall[] } {
  const executions: ToolCall[] = [];
  return {
    executions,
    async descriptors() {
      return [writeTool];
    },
    async execute(call: ToolCall, _runCtx: RunContext) {
      executions.push(call);
      return { status: "ok" as const, output: { done: true } };
    },
  };
}

/** Every real evaluation reaches the judge — no rules, no grants — so its count
 *  IS the number of times the pipeline ran. */
function countingJudge(): Judge & { decisions: number } {
  return {
    decisions: 0,
    async decide(this: { decisions: number }) {
      this.decisions += 1;
      return { action: "run" as const, rationale: "counted" };
    },
  } as Judge & { decisions: number };
}

function turn(judge: Judge) {
  const guard = createGuard({ store: memoryStoreAdapter(), judge });
  const tools = hostTools();
  return {
    tools,
    turnTools: createTurnTools({
      registry: guard.bind(tools),
      guard,
      ctx: ctx(),
      interactive: true,
      mirror: () => undefined,
    }),
  };
}

describe("one harness tool call evaluates the guard once", () => {
  it("previews and dispatches on ONE pipeline pass, and still runs the tool once", async () => {
    const judge = countingJudge();
    const { tools, turnTools } = turn(judge);

    await expect(turnTools.call("host_write", { value: 1 })).resolves.toMatchObject({ status: "ok" });

    expect(judge.decisions).toBe(1);
    expect(tools.executions).toHaveLength(1);
    turnTools.dispose();
  });

  it("evaluates every call in the turn — the verdict is per call, never a turn-wide one", async () => {
    const judge = countingJudge();
    const { tools, turnTools } = turn(judge);

    await turnTools.call("host_write", { value: 1 });
    await turnTools.call("host_write", { value: 2 });

    expect(judge.decisions).toBe(2);
    expect(tools.executions).toHaveLength(2);
    turnTools.dispose();
  });
});
