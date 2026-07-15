/** ai-SDK v6-compatible conversation transport (08-ui §3, 03-agent §4). */
import type { VendoApprovalPart } from "@vendoai/core";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVendoContext } from "../context.js";

export type VendoThreadApproval = ToolUIPart | DynamicToolUIPart | VendoApprovalPart;

const THREAD_ID_HEADER = "x-vendo-thread-id";
const THREAD_ID_PATTERN = /^thr_.+$/;

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
    ...(typeof candidate.invalidatedGrant?.id === "string"
      && typeof candidate.invalidatedGrant.grantedAt === "string"
      ? { invalidatedGrant: candidate.invalidatedGrant }
      : {}),
  };
}

/** 08-ui §3 */
export function useVendoThread(threadId?: string) {
  const { client } = useVendoContext();
  const suppliedThreadIdRef = useRef(threadId);
  const activeThreadIdRef = useRef(threadId);
  const [effectiveThreadId, setEffectiveThreadId] = useState(threadId);
  // Keep a server-minted default id across chat rerenders, but reset it when a
  // caller explicitly switches the hook to a different thread prop.
  if (suppliedThreadIdRef.current !== threadId) {
    suppliedThreadIdRef.current = threadId;
    activeThreadIdRef.current = threadId;
    setEffectiveThreadId(threadId);
  }
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `${client.baseUrl.replace(/\/$/, "")}/threads`,
        headers: client.headers,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const returnedThreadId = response.headers.get(THREAD_ID_HEADER);
          if (returnedThreadId !== null && THREAD_ID_PATTERN.test(returnedThreadId)) {
            activeThreadIdRef.current = returnedThreadId;
            setEffectiveThreadId(returnedThreadId);
          }
          return response;
        },
        prepareSendMessagesRequest: ({ messages }) => {
          const message = messages.at(-1);
          if (!message) throw new Error("Cannot send an empty Vendo turn.");
          const activeThreadId = activeThreadIdRef.current;
          return {
            body: activeThreadId === undefined ? { message } : { threadId: activeThreadId, message },
            // No Content-Type here: the transport already sets application/json,
            // and a second value would double the header ("application/json,
            // application/json"), which the wire's CSRF floor rejects (09 §3).
            headers: { ...client.headers },
          };
        },
      }),
    [client],
  );
  const chat = useChat<UIMessage>({
    ...(threadId === undefined ? {} : { id: threadId }),
    messages: [],
    transport,
    // Approval decisions resume the parked turn server-side (03 §4): once every
    // requested approval has a response, send the updated messages back.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });

  useEffect(() => {
    let active = true;
    chat.setMessages([]);
    if (threadId !== undefined) {
      void client.threads
        .list()
        .then(threads => {
          if (!active) return;
          if (!threads.some(thread => thread.id === threadId)) {
            activeThreadIdRef.current = undefined;
            setEffectiveThreadId(undefined);
            return;
          }
          return client.threads.get(threadId).then(thread => {
            if (active) chat.setMessages(thread.messages);
          });
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
    threadId: effectiveThreadId,
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    status: chat.status,
    error: chat.error,
    approvals,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    stop: chat.stop,
  };
}
