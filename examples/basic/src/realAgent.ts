/**
 * Offline real-agent wiring for the basic example.
 *
 * `createExampleAgent()` returns a genuine `createFlowletAgent` instance driven
 * entirely by scripted mock models — no network or API keys required.
 *
 * - The main model emits a `render_view` tool call on turn 1 and closing text on
 *   the follow-up turn (identical pattern to `@flowlet/core`'s stub-agent).
 * - The judge model always returns "allow", so the policy clears every tool call
 *   automatically — no human-approval prompt is shown.
 * - An `echo` tool illustrates registering app-defined in-process tools.
 */

import {
  createFlowletAgent,
  composePolicy,
  naturalLanguagePolicy,
  RENDER_VIEW_TOOL_NAME,
} from "@flowlet/agent";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { tool } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers (mirrored from @flowlet/core stub-agent for the same pattern)
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 0, text: 0, reasoning: 0 },
} as const;

function textChunks(id: string, text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

/** True once the conversation already contains an assistant tool call (post turn 1). */
function promptHasToolCall(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool-call"),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a Flowlet agent wired entirely offline with mock models.
 *
 * Turn 1: the main model emits text + a `render_view` tool call rendering a
 * minimal generated view (a single Text node). Because the policy returns
 * "allow" (judge model is scripted to return "allow"), `wrapTool` sets
 * `needsApproval` to false and the SDK executes the tool in the same run
 * without pausing.
 *
 * Turn 2: the main model (seeing the prior tool call in the history) emits
 * closing text and finishes.
 */
export function createExampleAgent() {
  // Main driver model — emits render_view on first turn, text on follow-up.
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const hasCall = promptHasToolCall(
        prompt as { role: string; content: unknown }[],
      );
      const chunks: LanguageModelV3StreamPart[] = hasCall
        ? [
            ...textChunks("t-done", "Here is your component from the real agent."),
            {
              type: "finish",
              usage: ZERO_USAGE,
              finishReason: { unified: "stop", raw: undefined },
            },
          ]
        : [
            ...textChunks("t1", "Let me render a component for you."),
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: RENDER_VIEW_TOOL_NAME,
              input: JSON.stringify({
                formatVersion: "flowlet-genui/v1",
                root: "r",
                nodes: [
                  {
                    id: "r",
                    component: "Text",
                    props: { text: "Hello from the real agent" },
                  },
                ],
              }),
            },
            {
              type: "finish",
              usage: ZERO_USAGE,
              finishReason: { unified: "tool-calls", raw: undefined },
            },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });

  // Judge model — always returns "allow" so the demo auto-renders without a prompt.
  const judgeModel = new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => ({
      content: [{ type: "text", text: "allow" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: ZERO_USAGE,
      warnings: [],
    }),
  });

  // Composed policy: natural-language guardrail rules evaluated by the judge.
  // The judge returning "allow" means every tool call proceeds automatically.
  const policy = composePolicy(
    naturalLanguagePolicy(
      ["Never delete production data without approval"],
      judgeModel,
    ),
  );

  // Trivial in-process tool to show app-defined tools alongside the engine tools.
  const echoTool = tool({
    description: "Echoes the given message back to the caller.",
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => message,
  });

  return createFlowletAgent({ model, policy, tools: { echo: echoTool } });
}
