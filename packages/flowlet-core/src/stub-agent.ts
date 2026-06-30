import { createUIMessageStream, type UIMessageChunk } from "ai";
import type { FlowletAgent, RunInput } from "./agent";
import type { ApprovalResponse } from "./protocol";
import { SCHEMA_VERSION } from "./protocol";
import type { UINode } from "./ui";

/**
 * Scripted development fixture (no LLM). Emits: start -> run info -> text ->
 * approval (pauses) -> [awaits approval-response via onClientPart] -> ui -> finish.
 * The in-memory approval resolver is F1's stand-in for the real networked return channel.
 */
export interface StubAgent extends FlowletAgent {
  respondToApproval(approvalId: string, response: Omit<ApprovalResponse, "approvalId">): void;
}

export function createStubAgent(): StubAgent {
  const pending = new Map<string, (r: ApprovalResponse) => void>();

  function respondToApproval(approvalId: string, response: Omit<ApprovalResponse, "approvalId">) {
    pending.get(approvalId)?.({ approvalId, ...response });
    pending.delete(approvalId);
  }

  function run(input: RunInput): ReadableStream<UIMessageChunk> {
    // Bridge the public onClientPart return channel into the pending-approval map.
    const originalOnClientPart = input.onClientPart;
    input.onClientPart = (part) => {
      originalOnClientPart?.(part);
      if (part.type === "data-approval-response") {
        pending.get(part.data.approvalId)?.(part.data);
        pending.delete(part.data.approvalId);
      }
    };

    return createUIMessageStream<any>({
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({
          type: "data-run",
          transient: true,
          data: { runId: "run-1", threadId: "thread-1", schemaVersion: SCHEMA_VERSION },
        });

        const textId = "t1";
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: "Here is a demo card." });
        writer.write({ type: "text-end", id: textId });

        const approvalId = "approval-1";
        const approved = await new Promise<ApprovalResponse>((resolve) => {
          pending.set(approvalId, resolve);
          writer.write({
            type: "data-approval",
            id: approvalId,
            data: { approvalId, toolCallId: "tool-1", prompt: "Render the demo card?", input: {} },
          });
        });

        if (approved.approved) {
          const node: UINode = {
            id: "ui-1",
            kind: "component",
            source: "prewired",
            name: "DemoCard",
            props: { title: "Hello from Flowlet" },
          };
          writer.write({ type: "data-ui", id: node.id, data: node });
        }

        writer.write({ type: "finish" });
      },
    });
  }

  return { run, respondToApproval };
}
