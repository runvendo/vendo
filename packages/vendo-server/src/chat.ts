/**
 * POST /api/vendo/chat — turn an HTTP chat request into the agent's
 * streamed UIMessage response. History normalization (dangling tool parts,
 * unanswered approvals) is engine-owned; this layer validates the body,
 * resolves the principal, and streams.
 *
 * Durable threads: the client's thread id (`threadId`, falling back to the
 * ai SDK Chat's own `id`) resolves through the ThreadIndex to a store
 * thread. Three writers cooperate, idempotently by message id:
 *
 *   1. Pre-stream, the incoming client messages are UPSERTED (so a resume's
 *      mutated approval parts are captured even if the run never settles).
 *   2. The engine's onSettled hook (registered in fetch-handler.ts) persists
 *      each SETTLED run's full message list — including the streamed
 *      assistant turn and approval-requested parts the consent endpoint
 *      reads — via `replaceMessages` when the store has it, else an
 *      append-only prefix delta.
 *   3. The terminal assistant message is captured by TEEING the response
 *      stream and upserted by id — this covers stores WITHOUT
 *      `replaceMessages` on continuation turns (where the prefix delta
 *      misses in-place revisions). Upsert-by-id makes 2 and 3 converge
 *      instead of duplicating.
 *
 * Persistence failures are logged, never surfaced to the caller — a store
 * outage must not break chat.
 */
import { createUIMessageStreamResponse, readUIMessageStream, type UIMessageChunk } from "ai";
import type {
  VendoAgent,
  VendoUIMessage,
  Principal,
  RemixSourceResolver,
  ThreadStore,
} from "@vendoai/core";
import { hostToolset, type RemixSealer } from "@vendoai/runtime";
import type { HostToolDefinition } from "@vendoai/core";
import { resolvePrincipal, threadScope } from "./guard";
import type { ThreadIndex } from "./threads";
import { applyVerifiedPinBase, enrichAnchorSources } from "./remix-enrich";
import type { VendoHandlerOptions } from "./options";
import { devTelemetry } from "./telemetry-dev";

interface ChatRequestBody {
  /** The ai SDK Chat's own id (DefaultChatTransport's default body key — see
   *  the ENG-193 item-2 plan's "Plan deviations" #2). Falls back to a fixed
   *  thread when a caller (tests, an older client) omits it. */
  id?: string;
  messages?: VendoUIMessage[];
  /** Client-owned thread id (VendoRoot's transport body). Preferred over
   *  `id` when present — surfaces sharing a threadId share one conversation. */
  threadId?: string;
}

export interface ChatDeps {
  /** The agent cache may key off an async connections store, so this may
   *  return a promise; a synchronous getter also works. */
  getAgent: () => VendoAgent | Promise<VendoAgent>;
  hostTools: HostToolDefinition[];
  options: VendoHandlerOptions;
  /** False when no model key is configured → chat answers 503 instead of streaming a provider error. */
  chatEnabled: boolean;
  /** Maps the client's chat id to a store thread id (ENG-193 §6.2). */
  threadIndex: ThreadIndex;
  /** Durable (or in-memory) thread persistence. Optional — deps built before
   *  thread persistence existed keep working with no request-side writes
   *  (the engine's onSettled hook still persists settled runs). */
  threads?: ThreadStore;
  /** Server-side anchor source lookup (remix-fidelity). Client-supplied
   *  `scoped.remixSource` is stripped regardless. */
  resolveRemixSource?: RemixSourceResolver;
  /** Verifies client-carried pin envelopes into `scoped.pinBase` (remix
   *  fast-edits). Absent → envelopes are dropped, pin editing unavailable. */
  remixSealer?: RemixSealer;
}

/** Reduces the UIMessage-chunk stream to its terminal message and upserts it.
 *  Runs detached from the response (fire-and-forget): errors are logged, not
 *  thrown — a persistence hiccup must never surface as a chat failure. */
async function captureAssistantTurn(
  stream: ReadableStream<UIMessageChunk>,
  threads: ThreadStore,
  scope: Principal,
  threadId: string,
): Promise<void> {
  try {
    let last: VendoUIMessage | undefined;
    for await (const message of readUIMessageStream({ stream })) {
      last = message as VendoUIMessage;
    }
    if (last) await threads.upsertMessages(scope, threadId, [last]);
  } catch (err) {
    console.error("[vendo] failed to persist the assistant turn:", err);
  }
}

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  // Capability-additive: without a model key, chat is DISABLED. Answer cleanly
  // instead of letting the provider throw mid-stream. A host that injects its
  // own `model` (which may key off something else) opts out by setting
  // chatEnabled true.
  if (!deps.chatEnabled) {
    return Response.json(
      {
        error:
          "chat is unavailable — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY",
      },
      { status: 503 },
    );
  }
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const messages = body.messages ?? [];
  // A missing/empty/non-array `messages` is a malformed client request.
  // Reject it cleanly — passed through, streamText throws and can take the
  // whole server process down.
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }

  // One identity space: VendoRoot sends an explicit client-owned
  // `threadId`; the ai SDK transport always sends `id`. Both resolve through
  // the same ThreadIndex so the consent endpoint (which resolves `id`) and
  // the /threads routes land on the same store thread.
  const clientThreadId =
    typeof body.threadId === "string" && body.threadId.length > 0
      ? body.threadId
      : typeof body.id === "string" && body.id.length > 0
        ? body.id
        : "default";
  const scope: Principal = threadScope(guard.principal);
  const threadRecordId = await deps.threadIndex.resolve(scope, clientThreadId);

  const threads = deps.threads;
  if (threads) {
    // Pre-stream: capture the client's messages as sent — including a
    // resume's mutated approval parts on a message id already on file — even
    // if the run below never completes. Upsert-by-id, so the engine's
    // onSettled writer (the settled-list persister) never double-appends.
    // Logged-not-thrown, like every other writer in this file: a store blip
    // must not 500 the chat (the module contract — persistence failures are
    // never surfaced to the caller).
    try {
      await threads.upsertMessages(scope, threadRecordId, messages);
    } catch (err) {
      console.error("[vendo] failed to persist the incoming client messages:", err);
    }
  }

  if (process.env.NODE_ENV !== "production") {
    try {
      void devTelemetry().track("agent_run", {});
    } catch {
      // Telemetry is best-effort and must not affect the chat response.
    }
  }

  const stream = (await deps.getAgent()).run({
    // Enrichment strips client-supplied source/pinBase and confines the raw
    // envelope to the last user message; verification then converts it into
    // a trusted `pinBase` (or drops it) BEFORE the engine sees anything.
    messages: applyVerifiedPinBase(
      enrichAnchorSources(messages, deps.resolveRemixSource ?? (() => undefined)),
      deps.remixSealer,
      guard.principal.userId,
    ),
    // The app's own API surface enters through the caller seam: no execute —
    // the policy gates each call and the BROWSER executes approved ones on
    // the user's session via the SDK's host-tool runner.
    tools: hostToolset(deps.hostTools),
    principal: guard.principal,
    signal: req.signal,
    threadId: threadRecordId,
  });

  if (threads) {
    const [forClient, forCapture] = stream.tee();
    void captureAssistantTurn(forCapture, threads, scope, threadRecordId);
    return createUIMessageStreamResponse({ stream: forClient });
  }
  return createUIMessageStreamResponse({ stream });
}
