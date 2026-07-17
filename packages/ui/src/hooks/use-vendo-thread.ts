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

/**
 * Director-mode recorder: when `globalThis.__vendoDirectorRecord` is truthy,
 * tee every live stream's SSE `data:` payloads (with elapsed timestamps) into
 * `globalThis.__vendoDirectorRecording`. Each entry converts 1:1 into a
 * ScriptedTransport cue, so a real build replays verbatim. Inert otherwise.
 */
function recordStream(response: Response): void {
  const globals = globalThis as {
    __vendoDirectorRecord?: boolean;
    __vendoDirectorRecording?: Array<{ at: number; chunk: unknown }>;
  };
  if (!globals.__vendoDirectorRecord || !response.body) return;
  const recording = (globals.__vendoDirectorRecording ??= []);
  const startedAt = Date.now();
  const reader = response.clone().body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const pump = (): Promise<void> =>
    reader.read().then(({ done, value }) => {
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split("\n\n");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") continue;
          try {
            recording.push({ at: Date.now() - startedAt, chunk: JSON.parse(data) });
          } catch {
            // Malformed frame: skip — the recording is tooling, never load-bearing.
          }
        }
      }
      return pump();
    });
  void pump().catch(() => undefined);
}

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
  const { client, transport: transportOverride } = useVendoContext();
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
      // Director/replay tooling swaps in a scripted transport at the provider
      // seam; everything downstream is unchanged (the thread is a pure
      // function of the chunk stream).
      transportOverride ?? new DefaultChatTransport<UIMessage>({
        api: `${client.baseUrl.replace(/\/$/, "")}/threads`,
        headers: client.headers,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const returnedThreadId = response.headers.get(THREAD_ID_HEADER);
          if (returnedThreadId !== null && THREAD_ID_PATTERN.test(returnedThreadId)) {
            activeThreadIdRef.current = returnedThreadId;
            setEffectiveThreadId(returnedThreadId);
          }
          recordStream(response);
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
    [client, transportOverride],
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
    // ENG-215 — edit last message: the composer truncates the transcript to
    // before the edited user turn, then re-sends the amended text as a fresh
    // turn (never duplicating what the user originally sent).
    setMessages: chat.setMessages,
    // ENG-214 — retry/regenerate: re-issues the failed (or last) turn from the
    // preserved user message, so a retry never duplicates what the user sent.
    regenerate: chat.regenerate,
    clearError: chat.clearError,
  };
}
