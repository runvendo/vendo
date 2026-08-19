/**
 * The standalone agent's conversation, in a page — one `agentHandler()` mount,
 * stock `useChat`, nothing of its own kept in the browser.
 *
 * It is `useVendoThread`'s thinner sibling: no provider, no client, no embed
 * chrome, no situation channel — just the transport, the thread id round-trip,
 * and the two things a host has to render for an agent that asks permission.
 *
 * NOTHING IS STORED HERE. The conversation's id round-trips on the response
 * header and is handed back through `onThreadId` for the host to keep wherever
 * it already keeps route state; the transcript — pending approvals included —
 * is read back from the server, which is what makes `interruptions` survive a
 * reload without this hook owning a byte of browser storage.
 */
import type { Decisions, Interruption, Json } from "@vendoai/core";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  getToolName,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** Written out rather than imported, for the reason `use-vendo-thread.ts` (its
    own copy) states: the literal is defined in @vendoai/harnesses beside the
    wire that stamps it, and @vendoai/ui may depend on core and apps alone
    (scripts/dependency-guard.mjs). */
const THREAD_ID_HEADER = "x-vendo-thread-id";

export interface UseVendoChatOptions {
  /** Where `agentHandler()` is mounted — `"/api/agent"`. */
  api: string;
  /** Reopen this conversation; omit for a new one. */
  threadId?: string;
  /** The id the server minted, the moment it lands. Keep it where your app
   *  already keeps route state — this hook keeps nothing. */
  onThreadId?: (threadId: string) => void;
}

export function useVendoChat({ api, threadId, onThreadId }: UseVendoChatOptions) {
  const base = api.replace(/\/$/, "");
  // The live id: a ref because the transport closure reads it per request, and
  // state because the caller renders it.
  const activeThreadId = useRef(threadId);
  const [effectiveThreadId, setEffectiveThreadId] = useState(threadId);
  const announce = useRef(onThreadId);
  announce.current = onThreadId;

  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: `${base}/threads`,
        fetch: async (input, init) => {
          const response = await globalThis.fetch(input, init);
          const returned = response.headers.get(THREAD_ID_HEADER);
          if (returned !== null && returned !== activeThreadId.current) {
            activeThreadId.current = returned;
            setEffectiveThreadId(returned);
            announce.current?.(returned);
          }
          return response;
        },
        prepareSendMessagesRequest: ({ messages }) => {
          const message = messages.at(-1);
          if (message === undefined) throw new Error("Cannot send an empty Vendo turn.");
          const id = activeThreadId.current;
          return { body: { ...(id === undefined ? {} : { threadId: id }), message } };
        },
      }),
    [base],
  );

  const chat = useChat<UIMessage>({
    ...(threadId === undefined ? {} : { id: threadId }),
    messages: [],
    transport,
  });

  const { setMessages } = chat;
  // Reopening reads the transcript back through the mount's own route, which is
  // the whole durability story: an approval parked before a reload comes back in
  // the messages, so `interruptions` below is populated again with no client
  // state to have lost.
  useEffect(() => {
    if (threadId === undefined) return undefined;
    // Switching conversations moves the live id too — after the early return, so
    // a server-minted id is never clobbered by the prop that never carried one.
    activeThreadId.current = threadId;
    setEffectiveThreadId(threadId);
    let active = true;
    void globalThis
      .fetch(`${base}/threads/${encodeURIComponent(threadId)}`)
      .then(response => (response.ok ? response.json() as Promise<{ messages: UIMessage[] }> : undefined))
      .then(thread => {
        if (active && thread !== undefined) setMessages(thread.messages);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [base, threadId, setMessages]);

  /** What this conversation is waiting on a person for, in the vocabulary the
   *  server speaks (`Interruption`) rather than the SDK's part shape. */
  const interruptions = useMemo<Interruption[]>(() => {
    const pending: Interruption[] = [];
    for (const message of chat.messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || part.state !== "approval-requested") continue;
        pending.push({
          id: part.approval.id,
          type: "approval",
          toolCall: { id: part.toolCallId, tool: getToolName(part), args: part.input as Json },
        });
      }
    }
    return pending;
  }, [chat.messages]);

  /**
   * Answer what the turn is waiting on, keyed by {@link Interruption.id}.
   *
   * The decision goes to the mount's PERMISSION wire, not to the SDK's local
   * approval channel, because the guard's decision is the thing that unblocks
   * the turn: a parked call is sitting on a waiter that only
   * `guard.approvals.decide` resolves. Flipping the part in the browser instead
   * changes what the page draws and nothing about what the agent is doing, and
   * the turn goes on to expire unanswered — which is exactly what the browser
   * seam test caught. Once the guard is told, the turn carries on and its own
   * stream reports the call's outcome, so nothing here has to patch the
   * transcript.
   *
   * Two requests at most: the wire decides a BATCH, so the ids are grouped by
   * verdict rather than answered one at a time.
   */
  const resume = useCallback(
    async (decisions: Decisions): Promise<void> => {
      for (const approve of [true, false]) {
        const verdict = approve ? "approve" : "deny";
        // v1 mints the approval arm only — `input` is wire-defined and unemitted
        // (packages/core/src/turn-result.ts) — so an `{ answers }` decision has
        // no interruption here to answer.
        const ids = Object.entries(decisions).filter(([, decision]) => decision === verdict).map(([id]) => id);
        if (ids.length === 0) continue;
        const response = await globalThis.fetch(`${base}/approvals/decide`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ids, decision: { approve } }),
        });
        // A refusal — 409 for an approval already answered or long expired — has
        // to reach the caller: swallowed, the page draws the decision as landed
        // while the turn stays parked until it expires, which is the very thing
        // going to the guard at all was meant to prevent.
        if (!response.ok) throw new Error(`Vendo could not record the ${verdict} decision (${response.status}).`);
      }
    },
    [base],
  );

  return {
    threadId: effectiveThreadId,
    messages: chat.messages,
    sendMessage: chat.sendMessage,
    status: chat.status,
    error: chat.error,
    /** Pending, and durable across a reload — read back from the server. */
    interruptions,
    resume,
    stop: chat.stop,
  };
}
