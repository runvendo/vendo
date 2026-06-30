import { useCallback } from "react";
import { useChat } from "@ai-sdk/react";
import type { FlowletUIMessage } from "@flowlet/core";
import { useFlowletContext } from "./provider";

export function useFlowletChat() {
  const { registry, local } = useFlowletContext();
  const chat = useChat<FlowletUIMessage>({ transport: local.transport });

  /** Answer an approval request (the in-memory return channel). */
  const respondToApproval = useCallback(
    (approvalId: string, approved: boolean, editedInput?: unknown) =>
      local.sendClientPart({ type: "data-approval-response", data: { approvalId, approved, editedInput } }),
    [local],
  );

  return { ...chat, registry, respondToApproval };
}
