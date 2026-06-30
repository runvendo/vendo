import { describe, it, expect } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import type { FlowletUIMessage } from "@flowlet/core";
import { createDemoAgent } from "./agent";

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function promptHasToolCall(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool-call"),
  );
}

/** Mock model: emits a render_ui call on turn 1, closing text on the follow-up. */
function mockRenderModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const hasCall = promptHasToolCall(prompt as { role: string; content: unknown }[]);
      const chunks: LanguageModelV3StreamPart[] = hasCall
        ? [
            { type: "text-start", id: "d" },
            { type: "text-delta", id: "d", delta: "Here is your view." },
            { type: "text-end", id: "d" },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ]
        : [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "render_ui",
              input: JSON.stringify({ name: "Card", props: { title: "Hello" }, source: "prewired" }),
            },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

async function collectChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("createDemoAgent", () => {
  it("streams a data-ui node when the model calls render_ui", async () => {
    const agent = createDemoAgent({
      model: mockRenderModel(),
      // Stub Composio so the test stays fully offline.
      composioClient: { fetchTools: async () => ({}) },
    });

    const messages: FlowletUIMessage[] = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "Show me a view." }],
      },
    ];

    const stream = agent.run({
      messages,
      tools: {},
      principal: { userId: "flowlet-demo" },
      signal: new AbortController().signal,
    });

    const chunks = (await collectChunks(stream)) as { type?: string }[];
    const hasUi = chunks.some((c) => c.type === "data-ui");
    expect(hasUi).toBe(true);
  });
});
