import {
  convertToModelMessages,
  createUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type UIMessageChunk,
} from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import type { FlowletAgent, RunInput } from "./agent";
import { SCHEMA_VERSION } from "./protocol";
import type { FlowletUIMessage } from "./protocol";
import type { UINode } from "./ui";

const TOOL_NAME = "renderDemoCard";
const DEMO_TITLE = "Hello from Flowlet";

/** Minimal, type-correct usage scaffolding for the mock model's `finish` part. */
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

/** True when the conversation carries a DENIED tool execution — the resume
 *  after the user clicks Decline (`tool-result` with `execution-denied`). */
function promptHasDenial(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some((c) => {
        const part = c as { type?: string; output?: { type?: string } };
        return part.type === "tool-result" && part.output?.type === "execution-denied";
      }),
  );
}

/**
 * Scripted development fixture (no LLM). Drives the ai SDK's native human-in-the-loop
 * tool approval: turn 1 streams text + a `needsApproval` tool call (the SDK pauses at
 * `approval-requested`); after the client approves, the SDK re-invokes `run` with the
 * approval in the messages, the tool executes, and the tool emits a `data-ui` DemoCard
 * node. The mock model emits the tool call only on the first turn (it sees no prior
 * tool call), then text-only, so the loop terminates.
 */
export function createStubAgent(): FlowletAgent {
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const chunks: LanguageModelV3StreamPart[] = promptHasDenial(prompt)
        ? [
            ...textChunks("t-denied", "No problem — I won't render the card."),
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ]
        : promptHasToolCall(prompt)
        ? [
            ...textChunks("t-done", "Here is your demo card."),
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ]
        : [
            ...textChunks("t1", "Let me render a demo card."),
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: TOOL_NAME,
              input: JSON.stringify({ title: DEMO_TITLE }),
            },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    return createUIMessageStream<FlowletUIMessage>({
      execute: async ({ writer }) => {
        const renderDemoCard = tool({
          description: "Render a demo card in the UI.",
          inputSchema: z.object({ title: z.string() }),
          needsApproval: true,
          // Runs only after the client approves. Emits our custom data-ui UINode.
          execute: async ({ title }) => {
            const node: UINode = {
              id: "ui-1",
              kind: "component",
              source: "prewired",
              name: "DemoCard",
              props: { title },
            };
            writer.write({ type: "data-ui", id: node.id, data: node });
            return "rendered";
          },
        });

        const result = streamText({
          model,
          tools: { [TOOL_NAME]: renderDemoCard },
          messages: await convertToModelMessages(input.messages),
          abortSignal: input.signal,
          stopWhen: stepCountIs(5),
        });

        // Run identity rides as ai SDK message metadata (attached on `start`),
        // replacing the old custom data-run part. `originalMessages` mirrors the
        // real engine: an approval-resume continues the paused assistant message
        // instead of appending a replayed duplicate.
        writer.merge(
          result.toUIMessageStream({
            originalMessages: input.messages,
            messageMetadata: ({ part }) =>
              part.type === "start"
                ? { runId: "run-1", threadId: "thread-1", schemaVersion: SCHEMA_VERSION }
                : undefined,
          }),
        );
      },
    });
  }

  return { run };
}
