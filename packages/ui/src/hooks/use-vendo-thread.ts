/** ai-SDK v6-compatible conversation transport (08-ui §3, 03-agent §4). */
import { riskLabelSchema, withTurnHeartbeat, type BeatPhase, type VendoApprovalPart } from "@vendoai/core";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVendoProvider } from "../context.js";
import { currentSituation } from "../situation.js";
import { publishThreadRun, retireThreadRun, type VendoBeat } from "../chrome/run-activity.js";

export type VendoThreadApproval = ToolUIPart | DynamicToolUIPart | VendoApprovalPart;

const THREAD_ID_HEADER = "x-vendo-thread-id";
const THREAD_ID_PATTERN = /^thr_.+$/;

/**
 * §3.4's status channel, RECEIVED.
 *
 * The part name is written out rather than imported: `VENDO_STATUS_PART` lives
 * in @vendoai/harnesses, and @vendoai/ui may depend on core alone
 * (scripts/dependency-guard.mjs). The producer pins the same literal on the
 * wire in packages/harnesses/src/runtime.test.ts.
 *
 * THE CHANNEL IS `onData`, NOT A `parts.tsx` BRANCH. A transient data chunk is
 * handed to `onData` and `break`s before the SDK pushes anything into
 * `state.message.parts` (ai@6.0.28, dist/index.mjs ~5140) — which is exactly
 * what §3.4 asks for: a beat in `parts` would be persisted history, and beats
 * are ephemeral by construction.
 */
const VENDO_STATUS_PART = "data-vendo-status";

/** The six, as a runtime set. A `Record<BeatPhase, …>` so the build breaks if
    §3.4's closed union ever gains or loses a member. */
const BEAT_PHASES: Record<BeatPhase, true> = {
  understanding: true,
  planning: true,
  assembling: true,
  building: true,
  checking: true,
  finishing: true,
};

/**
 * A beat is words on a screen, so the LABEL is the whole requirement — a chunk
 * without one is simply not a beat. `phase` and `appId` are dropped when
 * unusable rather than repaired: a seventh phase, or a phase for a beat that
 * carried none, would make the receiver the author of a fact the harness never
 * sent.
 *
 * The label itself is NOT rewritten. Ruling 14 (consumer-voice.ts) settled that
 * a regex set may not be the runtime authority for what a person may read — as
 * a gate it deleted good host copy while admitting raw JSON. The beat text rules
 * bind the PRODUCER; here the label is passed through as sent.
 */
function vendoBeat(chunk: { type: string; data?: unknown }): VendoBeat | undefined {
  if (chunk.type !== VENDO_STATUS_PART) return undefined;
  if (typeof chunk.data !== "object" || chunk.data === null) return undefined;
  const candidate = chunk.data as { label?: unknown; phase?: unknown; appId?: unknown };
  if (typeof candidate.label !== "string" || candidate.label.trim().length === 0) return undefined;
  return {
    label: candidate.label,
    ...(typeof candidate.phase === "string" && Object.hasOwn(BEAT_PHASES, candidate.phase)
      ? { phase: candidate.phase as BeatPhase }
      : {}),
    ...(typeof candidate.appId === "string" ? { appId: candidate.appId } : {}),
  };
}

/** Stable identity so an idle turn never re-renders a beat reader. */
const NO_BEATS: readonly VendoBeat[] = [];

function vendoApproval(part: UIMessage["parts"][number]): VendoApprovalPart | undefined {
  if (part.type !== "data-vendo-approval") return undefined;
  const value = "data" in part ? part.data : part;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<VendoApprovalPart>;
  if (typeof candidate.toolCallId !== "string" || !riskLabelSchema.safeParse(candidate.risk).success) {
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
  const { client, transport: transportOverride, captureScreen } = useVendoProvider();
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
          // The transport's only GET is `reconnectToStream`'s, and the SDK THROWS
          // on any answer that is neither ok nor 204 — which would turn "this
          // wire has no resume route" (an older deployment) into a failed
          // thread. From the client's side that is the same fact as "nothing to
          // resume", so it is answered the same way.
          if ((init?.method ?? "GET").toUpperCase() === "GET" && !response.ok) {
            return new Response(null, { status: 204 });
          }
          const returnedThreadId = response.headers.get(THREAD_ID_HEADER);
          if (returnedThreadId !== null && THREAD_ID_PATTERN.test(returnedThreadId)) {
            activeThreadIdRef.current = returnedThreadId;
            setEffectiveThreadId(returnedThreadId);
          }
          // ENG-353: beat /threads/:id/heartbeat while this turn streams so
          // the server can idle-abort the turn if this tab closes on a
          // runtime that never surfaces the disconnect (`next dev`).
          return withTurnHeartbeat(response, {
            baseUrl: client.baseUrl.replace(/\/$/, ""),
            headers: client.headers,
          });
        },
        prepareSendMessagesRequest: ({ messages }) => {
          const message = messages.at(-1);
          if (!message) throw new Error("Cannot send an empty Vendo turn.");
          const activeThreadId = activeThreadIdRef.current;
          // Spec 2026-08-05 §2/§3 — the [Situation] channel rides the send:
          // published host data plus the screen snapshot, this turn only. The
          // server re-caps it at the same 8 KB and puts it on ctx.context.
          const situation = currentSituation(captureScreen);
          return {
            body: {
              ...(activeThreadId === undefined ? {} : { threadId: activeThreadId }),
              message,
              ...(situation === undefined ? {} : { context: situation }),
            },
            // No Content-Type here: the transport already sets application/json,
            // and a second value would double the header ("application/json,
            // application/json"), which the wire's CSRF floor rejects (09 §3).
            headers: { ...client.headers },
          };
        },
      }),
    [client, transportOverride, captureScreen],
  );
  const [beats, setBeats] = useState<readonly VendoBeat[]>(NO_BEATS);
  const chat = useChat<UIMessage>({
    ...(threadId === undefined ? {} : { id: threadId }),
    messages: [],
    transport,
    // Approval decisions resume the parked turn server-side (03 §4): once every
    // requested approval has a response, send the updated messages back.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: chunk => {
      const beat = vendoBeat(chunk);
      if (beat !== undefined) setBeats(current => [...current, beat]);
    },
  });
  const running = chat.status === "submitted" || chat.status === "streaming";
  // Beats belong to the RUNNING turn: clearing on the settle (rather than on the
  // next turn's start) is one rule that answers both halves of §3.4's ephemeral
  // law — a finished turn narrates nothing, and the next turn therefore starts
  // empty without a reset that could race the first beat off the wire.
  useEffect(() => {
    if (!running) setBeats(NO_BEATS);
  }, [running]);

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
            if (!active) return;
            chat.setMessages(thread.messages);
            // Stream resume (blueprint §4.1 item 5). A turn still streaming has
            // no persisted assistant row yet, so its transcript ends on the
            // user's message — and a reload mid-turn would otherwise paint that
            // question and nothing else, forever. Resume ONLY then: a transcript
            // that already ends in an assistant reply is a completed turn, and
            // asking the SDK to resume onto it makes it treat that finished
            // message as the in-flight one and repaint it empty. AFTER
            // setMessages, never before: the SDK resumes onto the last message,
            // so the transcript has to have landed first. Nothing in flight on
            // the server → 204 → no-op.
            if (thread.messages.at(-1)?.role === "user") chat.resumeStream();
          });
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [client, threadId, chat.setMessages, chat.resumeStream]);

  // LANE D (spec §2) — surfaces OUTSIDE the conversation (the launcher pill,
  // the badge) must be able to narrate a run whose state lives in here: the
  // panel hides itself on close and keeps streaming, and the pill is in a
  // different React tree. Every thread surface publishes its turn to the
  // run-activity store, keyed per hook instance so an idle surface can never
  // clobber a running one.
  const runKey = useRef(Symbol("vendo-run")).current;
  useEffect(() => () => retireThreadRun(runKey), [runKey]);
  useEffect(() => {
    publishThreadRun(runKey, { threadId: effectiveThreadId, status: chat.status, messages: chat.messages, beats });
  }, [runKey, effectiveThreadId, chat.status, chat.messages, beats]);

  // §10.2 — offer the user's words to the turn already running. The route's own
  // answer is the ONLY signal: there is no capability to ask about and nothing to
  // validate up front, so `false` (a turn that ended, a thread with none in
  // flight, a wire without the route) simply means the caller keeps the message.
  //
  // On a landing the words become a normal user turn HERE too, under the id the
  // server persisted them with — one row, one bubble, and a reload that reads
  // back exactly what the live screen showed.
  const steer = useCallback(async (text: string): Promise<boolean> => {
    const id = activeThreadIdRef.current;
    if (id === undefined) return false;
    const messageId = globalThis.crypto.randomUUID();
    const base = client.baseUrl.replace(/\/$/, "");
    const landed = await globalThis
      .fetch(`${base}/threads/${encodeURIComponent(id)}/steer`, {
        method: "POST",
        headers: { ...client.headers, "content-type": "application/json" },
        body: JSON.stringify({ text, messageId }),
      })
      .then(response => (response.ok ? response.json() as Promise<{ landed?: boolean }> : undefined))
      .catch(() => undefined);
    if (landed?.landed !== true) return false;
    chat.setMessages(current => {
      // BEFORE this turn's reply, which is where the server puts it: the runtime
      // appends to the turn's own message list and the stream adds the reply
      // last, so live order and persisted order agree and a reload never jumps.
      const at = current.at(-1)?.role === "assistant" ? current.length - 1 : current.length;
      return [
        ...current.slice(0, at),
        { id: messageId, role: "user", parts: [{ type: "text", text }] },
        ...current.slice(at),
      ];
    });
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setMessages is stable; the ref carries the live thread id
  }, [client]);

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
    /** §3.4 — the running turn's beats, oldest first; empty once it settles. */
    beats,
    sendMessage: chat.sendMessage,
    /** §10.2 — hand words to the turn in flight; answers whether they landed. */
    steer,
    status: chat.status,
    error: chat.error,
    approvals,
    addToolApprovalResponse: chat.addToolApprovalResponse,
    stop: chat.stop,
    // Rejoin a turn still streaming on the server (`GET /threads/:id/stream`).
    // Called for you on mount; exposed for a surface that reconnects on its own
    // (a tab waking from background, a socket the browser dropped).
    resumeStream: chat.resumeStream,
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
