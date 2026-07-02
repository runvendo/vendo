/**
 * The networked seam: turn an HTTP chat request into the agent's streamed
 * UIMessage response. Factored out of the route so it can be tested with a mock
 * agent (no model, no network). The principal is injected here — this is where
 * the server attaches the Composio identity that the client transport can't.
 *
 * Because the demo agent runs against real Gmail/Calendar connections, the
 * fixed DEMO_PRINCIPAL is only attached for local requests (the demo's primary
 * stage path). Set FLOWLET_DEMO_PUBLIC=1 to intentionally enable it on a
 * reachable deployment.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import { DEMO_PRINCIPAL } from "./principal";
import { cadenceHostToolDefs } from "./host-tools";

interface ChatRequestBody {
  messages?: FlowletUIMessage[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Only expose the real Composio identity to local requests, unless an operator
 *  has explicitly opted a deployment in via FLOWLET_DEMO_PUBLIC=1. */
function principalAllowed(req: Request): boolean {
  if (process.env.FLOWLET_DEMO_PUBLIC === "1") return true;
  const host = req.headers.get("host");
  let hostname = host ? host.split(":")[0] : "";
  if (!hostname) {
    try { hostname = new URL(req.url).hostname; } catch { hostname = ""; }
  }
  return LOCAL_HOSTS.has(hostname!.toLowerCase());
}

export async function handleChat(req: Request, agent: FlowletAgent): Promise<Response> {
  if (!principalAllowed(req)) {
    return Response.json(
      { error: "Flowlet demo agent is restricted to local runs. Set FLOWLET_DEMO_PUBLIC=1 to enable on a deployment." },
      { status: 403 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as ChatRequestBody;
  const messages = body.messages ?? [];
  // A missing/empty/non-array `messages` is a malformed client request. Reject
  // it cleanly — passed through, streamText throws AI_InvalidPromptError.
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }
  const stream = agent.run({
    messages,
    // Cadence's own API surface enters through the caller seam (ENG-202): no
    // execute — the policy gates each call and the BROWSER executes approved
    // ones on the user's session via the SDK's host-tool runner.
    tools: hostToolset(cadenceHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
  });
  return createUIMessageStreamResponse({ stream });
}
