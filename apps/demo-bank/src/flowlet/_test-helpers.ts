/**
 * Shared offline test fixtures for the Flowlet demo wiring. Not a test file
 * (no `.test.ts` suffix) so vitest won't execute it; imported by the real tests.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ComposioClient } from "@flowlet/agent";

export const ZERO_USAGE = {
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

/** Mock model: emits a `render_view` call on turn 1, closing text on the follow-up. */
export function mockRenderModel() {
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
              toolName: "render_view",
              input: JSON.stringify({
                formatVersion: "flowlet-genui/v1",
                root: "r",
                nodes: [{ id: "r", component: "Text", source: "prewired", props: { text: "hi" } }],
              }),
            },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** Composio client stub that exposes no tools — keeps tests fully offline. */
export const stubComposioClient: ComposioClient = {
  fetchTools: async () => ({}),
  authorize: async () => ({ redirectUrl: null, connectedAccountId: "ca_stub" }),
  connectionStatus: async () => "active",
  hasActiveConnection: async () => true,
};
