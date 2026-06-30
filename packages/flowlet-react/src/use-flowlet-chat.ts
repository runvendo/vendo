import { useChat } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import type { FlowletUIMessage } from "@flowlet/core";
import { useFlowletContext } from "./provider";

/**
 * Wraps the ai SDK `useChat` with Flowlet's registry and native human-in-the-loop
 * tool approvals. `addToolApprovalResponse({ id, approved })` answers an
 * `approval-requested` tool part; `sendAutomaticallyWhen` auto-resubmits the turn once
 * all approvals are in, which runs the approved tool and renders its `data-ui` node.
 */
export function useFlowletChat() {
  const { registry, local } = useFlowletContext();
  const chat = useChat<FlowletUIMessage>({
    transport: local.transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  return { ...chat, registry };
}
