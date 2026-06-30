/**
 * The networked seam: turn an HTTP chat request into the agent's streamed
 * UIMessage response. Factored out of the route so it can be tested with a mock
 * agent (no model, no network). The principal is injected here — this is where
 * the server attaches the Composio identity that the client transport can't.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { DEMO_PRINCIPAL } from "./principal";

interface ChatRequestBody {
  messages?: FlowletUIMessage[];
}

export async function handleChat(req: Request, agent: FlowletAgent): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const messages = body.messages ?? [];
  const stream = agent.run({
    messages,
    tools: {},
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
  });
  return createUIMessageStreamResponse({ stream });
}
