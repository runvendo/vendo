/**
 * POST /api/flowlet/chat — turn an HTTP chat request into the agent's
 * streamed UIMessage response. History normalization (dangling tool parts,
 * unanswered approvals) is engine-owned; this layer validates the body,
 * resolves the principal, and streams.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import type { HostToolDefinition } from "@flowlet/core";
import { resolvePrincipal } from "./guard";
import type { FlowletHandlerOptions } from "./options";

interface ChatRequestBody {
  messages?: FlowletUIMessage[];
}

export interface ChatDeps {
  getAgent: () => FlowletAgent;
  hostTools: HostToolDefinition[];
  options: FlowletHandlerOptions;
  /** False when no model key is configured → chat answers 503 instead of streaming a provider error. */
  chatEnabled: boolean;
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

  const stream = deps.getAgent().run({
    messages,
    // The app's own API surface enters through the caller seam: no execute —
    // the policy gates each call and the BROWSER executes approved ones on
    // the user's session via the SDK's host-tool runner.
    tools: hostToolset(deps.hostTools),
    principal: guard.principal,
    signal: req.signal,
  });
  return createUIMessageStreamResponse({ stream });
}
