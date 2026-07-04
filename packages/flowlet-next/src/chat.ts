/**
 * POST /api/flowlet/chat — turn an HTTP chat request into the agent's
 * streamed UIMessage response. History normalization (dangling tool parts,
 * unanswered approvals) is engine-owned; this layer validates the body,
 * resolves the principal, and streams.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletUIMessage, Principal } from "@flowlet/core";
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
  /** Maps the client's chat id to a store thread id (ENG-193 §6.2). */
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

  // NO persistence here — the SINGLE writer for thread messages is the
  // engine's onSettled hook (registered in handler.ts's createAgentCache
  // call). It fires with the FULL settled message list — including the
  // streamed assistant turn and any approval-requested parts — keyed by the
  // threadId below, so the consent endpoint can read this turn's approval
  // part BEFORE the client's next chat turn. Persisting the request body
  // here as well would double-append (and, alone, it misses the streamed
  // turn entirely — review 2026-07-04). The onSettled writer delta-appends
  // on a prefix assumption (single-client v1): the settled list strictly
  // extends what's stored.
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

  return createUIMessageStreamResponse({ stream });
}
