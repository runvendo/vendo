import type { ToolDescriptor } from "@vendoai/core";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import {
  boundRegistry,
  ctx,
  readSse,
  scriptedModel,
  testGuard,
  textTurn,
  toolCallTurn,
} from "./test-helpers.js";

const descriptor: ToolDescriptor = {
  name: "dump",
  description: "Return a large payload.",
  inputSchema: { type: "object", additionalProperties: false },
  risk: "read",
};

describe("context engineering", () => {
  it("truncates ok tool outputs past toolOutputCap before they reach the model", async () => {
    const bigValue = "x".repeat(500);
    const model = scriptedModel([
      toolCallTurn(descriptor.name, {}, "call_dump"),
      textTurn("Summarized.", "text_dump_done"),
    ]);
    const guard = testGuard({ [descriptor.name]: "run" });
    const tools = boundRegistry({
      [descriptor.name]: { descriptor, execute: async () => ({ bigValue }) },
    }, guard);
    const agent = createAgent({ model, tools, guard, context: { toolOutputCap: 100 } });

    const response = await agent.stream({
      threadId: "thr_cap",
      message: { id: "user_cap", role: "user", parts: [{ type: "text", text: "Dump it" }] },
      ctx: ctx(),
    });
    const { parts } = await readSse(response);

    const output = parts.find((part) => part.type === "tool-output-available")?.output as {
      status: string;
      output: { truncated: boolean; chars: number; preview: string };
    };
    expect(output.status).toBe("ok");
    expect(output.output.truncated).toBe(true);
    expect(output.output.chars).toBeGreaterThan(500);
    expect(output.output.preview).toHaveLength(100);
    expect(JSON.stringify(model.prompts[1])).not.toContain(bigValue);
  });

  it("masks a thrown model error on the wire instead of leaking its message", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error("SECRET_INTERNAL_DETAIL");
      },
    });
    const guard = testGuard({});
    const agent = createAgent({ model, tools: boundRegistry({}, guard), guard });

    const response = await agent.stream({
      threadId: "thr_error",
      message: { id: "user_error", role: "user", parts: [{ type: "text", text: "Hi" }] },
      ctx: ctx(),
    });
    const raw = await response.text();

    expect(raw).not.toContain("SECRET_INTERNAL_DETAIL");
    const errorFrames = raw
      .split("\n\n")
      .filter((block) => block.startsWith("data: {") && (JSON.parse(block.slice(6)) as { type?: string }).type === "error");
    expect(errorFrames.length).toBeGreaterThan(0);
  });
});
