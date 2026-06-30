// @vitest-environment jsdom
/**
 * React-seam integration test — the KEY claim of F2.
 *
 * Mounts F1's `FlowletProvider` + `useFlowletChat` (from `@flowlet/react`,
 * UNCHANGED) wired to the REAL `createFlowletAgent` engine driven by a
 * `MockLanguageModelV3`, and proves the full native human-in-the-loop approval
 * round-trip runs end to end:
 *
 *   sendMessage -> render_ui tool call -> policy pauses at `approval-requested`
 *   -> addToolApprovalResponse -> SDK auto-resubmits -> approved tool executes
 *   -> a `data-ui` DemoCard node renders in the assistant message.
 *
 * Nothing under `@flowlet/react` or `@flowlet/core` is modified — only this
 * package imports them. The mock-model scaffolding mirrors `engine.test.ts`
 * (itself mirroring `@flowlet/core`'s `stub-agent.ts`).
 */

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";
import { FlowletProvider, useFlowletChat } from "@flowlet/react";
import type { UINode } from "@flowlet/core";
import { createFlowletAgent, RENDER_TOOL_NAME } from "./engine";
import type { ApprovalPolicy } from "./policy";

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Offline mock-model scaffolding (mirrors engine.test.ts / stub-agent.ts).
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

/** True once the conversation already contains an assistant tool call. */
function promptHasToolCall(prompt: { role: string; content: unknown }[]): boolean {
  return prompt.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.content) &&
      m.content.some((c) => (c as { type?: string }).type === "tool-call"),
  );
}

/**
 * Mock model: turn 1 streams text + a single render_ui tool call; once the
 * prompt carries that tool call (the post-approval resubmit turn), streams text
 * only and finishes, so the model->tool loop terminates.
 */
function mockModel(call: { toolName: string; input: unknown }): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const chunks: LanguageModelV3StreamPart[] = promptHasToolCall(prompt)
        ? [
            ...textChunks("t-done", "Here is your card."),
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "stop", raw: undefined } },
          ]
        : [
            ...textChunks("t1", "Let me render a card."),
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: call.toolName,
              input: JSON.stringify(call.input),
            },
            { type: "finish", usage: ZERO_USAGE, finishReason: { unified: "tool-calls", raw: undefined } },
          ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** Gate every tool to a human approval — exercises the native HITL path. */
const approvePolicy: ApprovalPolicy = { evaluate: () => "approve" };

// The native ai SDK tool-part type for the engine's render tool.
const RENDER_TOOL_PART = `tool-${RENDER_TOOL_NAME}`;

/**
 * Consumer using F1's `useFlowletChat` hook UNCHANGED: it sends a message,
 * surfaces the native `approval-requested` tool part, answers it via
 * `addToolApprovalResponse`, and renders the resulting `data-ui` node.
 */
function Harness() {
  const chat = useFlowletChat();
  const parts = chat.messages.flatMap((m) => m.parts) as any[];

  // Native ai SDK tool part paused for human approval.
  const approval = parts.find(
    (p) => p.type === RENDER_TOOL_PART && p.state === "approval-requested",
  );
  // Our custom data-ui node, emitted by the approved tool's execution.
  const uiNode = parts.find((p) => p.type === "data-ui") as { data: UINode } | undefined;

  return (
    <div>
      <button onClick={() => chat.sendMessage({ text: "show me a card" })}>send</button>
      {approval && (
        <button
          data-testid="approve"
          onClick={() => chat.addToolApprovalResponse({ id: approval.approval.id, approved: true })}
        >
          approve
        </button>
      )}
      {uiNode && (
        <div data-testid="demo-card" data-name={uiNode.data.name}>
          {(uiNode.data as { props?: { title?: string } }).props?.title}
        </div>
      )}
    </div>
  );
}

describe("React seam: real engine + UNCHANGED F1 provider/hook/transport", () => {
  it("send -> approval-requested -> approve -> renders the DemoCard data-ui node", async () => {
    const agent = createFlowletAgent({
      model: mockModel({
        toolName: RENDER_TOOL_NAME,
        input: { name: "DemoCard", props: { title: "Hi" } },
      }),
      policy: approvePolicy,
    });

    render(
      <FlowletProvider
        agent={agent}
        components={[
          {
            name: "DemoCard",
            description: "demo",
            propsSchema: z.object({ title: z.string() }),
            source: "prewired",
          },
        ]}
      >
        <Harness />
      </FlowletProvider>,
    );

    // 1. Send -> the engine's render tool call pauses for native approval.
    fireEvent.click(screen.getByText("send"));
    await waitFor(() => screen.getByTestId("approve"));

    // 2. Approve -> the SDK auto-resubmits, the approved tool executes, and the
    //    engine writes a data-ui node into the assistant message.
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => screen.getByTestId("demo-card"));

    // 3. The rendered data-ui node IS the DemoCard component node.
    const node = screen.getByTestId("demo-card");
    expect(node.getAttribute("data-name")).toBe("DemoCard");
    expect(node.textContent).toBe("Hi");
  });
});
