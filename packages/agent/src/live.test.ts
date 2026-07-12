import { anthropic } from "@ai-sdk/anthropic";
import { describe, expect, it } from "vitest";
import { createAgent } from "./index.js";
import { boundRegistry, ctx, readSse, testGuard } from "./test-helpers.js";

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("agent live model", () => {
  it("runs a real echo tool and finishes a text response", async () => {
    const guard = testGuard({ echo: "run" });
    const tools = boundRegistry({
      echo: {
        descriptor: {
          name: "echo",
          description: "Return the supplied text exactly so the user can see it.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          risk: "read",
        },
        execute: async (args) => ({ echoed: (args as { text: string }).text }),
      },
    }, guard);
    const agent = createAgent({
      model: anthropic("claude-haiku-4-5-20251001"),
      tools,
      guard,
      system: {
        instructions: "For this test, always call the available echo tool exactly once before answering in text.",
      },
    });

    const response = await agent.stream({
      threadId: "thr_live_echo",
      message: {
        id: "user_live_echo",
        role: "user",
        parts: [{ type: "text", text: "Use the echo tool with the text vendo-live, then tell me what it returned." }],
      },
      ctx: ctx(),
    });

    expect(response.status).toBe(200);
    const { rawFrames, parts } = await readSse(response);
    expect(rawFrames.at(-1)).toBe("data: [DONE]\n\n");
    expect(parts.some((part) =>
      part.type === "tool-output-available"
      && (part.output as { status?: string } | undefined)?.status === "ok"
    )).toBe(true);
    const text = parts
      .filter((part) => part.type === "text-delta")
      .map((part) => String(part.delta ?? ""))
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
