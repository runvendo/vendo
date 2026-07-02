/**
 * Real AgentStepRunner tests on the ai SDK with a mock model: structured
 * output via the declared JSON schema, and tool-loop execution through the
 * RegisteredTool boundary (ToolCallOutcome results unwrap for the model).
 */
import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createAgentStepRunner } from "./agent-step";
import type { RegisteredTool } from "./interpreter";

function makeTool(name: string): RegisteredTool & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    description: `The ${name} tool`,
    modelInputSchema: { type: "object", properties: { x: { type: "number" } } },
    execute: async (input) => {
      calls.push(input);
      return { ok: true, result: { echoed: input } };
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never;
const stop = { unified: "stop", raw: undefined } as const;
const toolCalls = { unified: "tool-calls", raw: undefined } as const;

describe("createAgentStepRunner", () => {
  it("returns structured output matching the declared schema", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: '{"subject":"Weekly digest","body":"You spent $87."}' }],
        finishReason: stop,
        usage,
        warnings: [],
      }),
    });
    const runner = createAgentStepRunner({ model });
    const output = await runner({
      goal: "Write the digest",
      input: { transactions: [] },
      tools: {},
      maxToolCalls: 3,
      outputSchema: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
      },
    });
    expect(output).toEqual({ subject: "Weekly digest", body: "You spent $87." });
  });

  it("drives the tool loop through RegisteredTool.execute", async () => {
    const echo = makeTool("echo");
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        call += 1;
        if (call === 1) {
          return {
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "tc-1",
                toolName: "echo",
                input: '{"x":42}',
              },
            ],
            finishReason: toolCalls,
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "done" }],
          finishReason: stop,
          usage,
          warnings: [],
        };
      },
    });
    const runner = createAgentStepRunner({ model });
    const output = await runner({
      goal: "Echo the number",
      input: { n: 42 },
      tools: { echo },
      maxToolCalls: 3,
    });
    expect(echo.calls).toEqual([{ x: 42 }]);
    expect(output).toEqual({ text: "done" });
  });
});
