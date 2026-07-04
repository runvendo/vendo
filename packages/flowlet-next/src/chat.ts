/**
 * POST /api/flowlet/chat — turn an HTTP chat request into the agent's
 * streamed UIMessage response. History normalization (dangling tool parts,
 * unanswered approvals) is engine-owned; this layer validates the body,
 * resolves the principal, and streams.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletUIMessage, Principal, ThreadStore } from "@flowlet/core";
import type { FlowletAgent } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import type { HostToolDefinition } from "@flowlet/core";
import { resolvePrincipal } from "./guard";
import { EMBEDDED_TENANT } from "./policy-stack";
import type { ThreadIndex } from "./threads";
import type { FlowletHandlerOptions } from "./options";

interface ChatRequestBody {
  /** The ai SDK Chat's own id (DefaultChatTransport's default body key — see
   *  the ENG-193 item-2 plan's "Plan deviations" #2). Falls back to a fixed
   *  thread when a caller (tests, an older client) omits it. */
  id?: string;
  messages?: FlowletUIMessage[];
}

export interface ChatDeps {
  getAgent: () => FlowletAgent;
  hostTools: HostToolDefinition[];
  options: FlowletHandlerOptions;
  /** False when no model key is configured → chat answers 503 instead of streaming a provider error. */
  chatEnabled: boolean;
  /** Store seam wiring for thread persistence (ENG-193 §6.2). */
  threads: ThreadStore;
  threadIndex: ThreadIndex;
}

export async function handleChat(req: Request, deps: ChatDeps): Promise<Response> {
  // Capability-additive: without a model key, chat is DISABLED. Answer cleanly
  // instead of letting the provider throw mid-stream. A host that injects its
  // own `model` (which may key off something else) opts out by setting
  // chatEnabled true.
  if (!deps.chatEnabled) {
    return Response.json(
      { error: "chat is unavailable — set ANTHROPIC_API_KEY" },
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

  const clientThreadId = typeof body.id === "string" && body.id.length > 0 ? body.id : "default";
  const scope: Principal = { tenantId: EMBEDDED_TENANT, subject: guard.principal.userId };
  const threadRecordId = await deps.threadIndex.resolve(scope, clientThreadId);

  const stream = deps.getAgent().run({
    messages,
    // The app's own API surface enters through the caller seam: no execute —
    // the policy gates each call and the BROWSER executes approved ones on
    // the user's session via the SDK's host-tool runner.
    tools: hostToolset(deps.hostTools),
    principal: guard.principal,
    signal: req.signal,
    threadId: threadRecordId,
  });

  // Persist the received turn to the Store seam, keyed by the client's chat
  // id (ENG-193 §6.2 — the consent endpoint's "load the thread's messages"
  // step reads this). Persisting what the client SENT — not the streamed
  // reply — is deliberate and sufficient: the client resends the FULL history
  // every turn (deviation #2), so by the time a consent POST for this turn's
  // approval card arrives, the card's own approval-requested part has
  // already been received in the /chat body that produced its stream.
  //
  // Adaptation note (review follow-up): the engine's onSettled/onFinish hook
  // now carries the FULL updated message list (not just the new turn) once a
  // caller supplies `originalMessages` — but that hook is fixed once per
  // cached agent (createAgentCache), with no per-request threadId to key
  // persistence by, so it isn't the right seam for this. Persisting the
  // client-sent `messages` (already the full stateless history by the
  // transport's own contract) is the simplest correct form here. Because
  // ThreadStore.appendMessages is append-only (no replace, by the frozen Store
  // seam), "wholesale replace" is expressed as append-the-new-suffix: read
  // what's already stored and append only what's beyond it, which — given the
  // client always resends the same prior messages verbatim — is equivalent to
  // a full overwrite without ever duplicating a prior turn.
  void (async () => {
    try {
      const existing = await deps.threads.getMessages(scope, threadRecordId);
      const toAppend = messages.slice(existing.length);
      if (toAppend.length > 0) {
        await deps.threads.appendMessages(scope, threadRecordId, toAppend);
      }
    } catch (err) {
      console.error("[flowlet] thread persistence failed:", err);
    }
  })();

  return createUIMessageStreamResponse({ stream });
}
