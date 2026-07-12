/** ai-SDK v6-compatible conversation transport (08-ui §3, 03-agent §4). */
import type { VendoApprovalPart } from "@vendoai/core";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useEffect, useMemo } from "react";
import { useVendoContext } from "../context.js";

export type VendoThreadApproval = ToolUIPart | DynamicToolUIPart | VendoApprovalPart;

function vendoApproval(part: UIMessage["parts"][number]): VendoApprovalPart | undefined {
  if (part.type !== "data-vendo-approval") return undefined;
  const value = "data" in part ? part.data : part;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<VendoApprovalPart>;
  if (typeof candidate.toolCallId !== "string" || !["read", "write", "destructive"].includes(candidate.risk ?? "")) {
    return undefined;
  }
  return {
    type: "data-vendo-approval",
    toolCallId: candidate.toolCallId,
    risk: candidate.risk as VendoApprovalPart["risk"],
    ...(candidate.approvalId === undefined ? {} : { approvalId: candidate.approvalId }),
  };
}

/** 08-ui §3 */
export function useVendoThread(threadId?: string) {
  const { client } = useVendoContext();
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `${client.baseUrl.replace(/\/$/, "")}/threads`,
        headers: client.headers,
        prepareSendMessagesRequest: ({ messages }) => {
          const message = messages.at(-1);
          if (!message) throw new Error("Cannot send an empty Vendo turn.");
          return {
            body: threadId === undefined ? { message } : { threadId, message },
            headers: { ...client.headers, "Content-Type": "application/json" },
          };
        },
      }),
    [client, threadId],
  );
  const chat = useChat<UIMessage>({
    ...(threadId === undefined ? {} : { id: threadId }),
    messages: [],
    transport,
  });

  useEffect(() => {
    let active = true;
    chat.setMessages([]);
    if (threadId !== undefined) {
      void client.threads
        .get(threadId)
        .then(thread => {
          if (active) chat.setMessages(thread.messages);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [client, threadId, chat.setMessages]);

  const approvals = useMemo<VendoThreadApproval[]>(
    () => {
      const pending: VendoThreadApproval[] = [];
      for (const message of chat.messages) {
        for (const part of message.parts) {
          if (isToolUIPart(part) && part.state === "approval-requested") pending.push(part);
          const approval = vendoApproval(part);
          if (approval !== undefined) pending.push(approval);
        }
      }
      return pending;
    },
    [chat.messages],
  );

  return {
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    status: chat.status,
    approvals,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    stop: chat.stop,
  };
}
