/**
 * The networked seam: turn an HTTP chat request into the agent's streamed
 * UIMessage response. Factored out of the route so it can be tested with a mock
 * agent (no model, no network). The principal is injected here — this is where
 * the server attaches the Composio identity that the client transport can't.
 *
 * Because the demo agent is allow-all and runs against real Gmail/Slack
 * connections, the fixed DEMO_PRINCIPAL is only attached for local requests
 * (the demo's primary stage path). Set FLOWLET_DEMO_PUBLIC=1 to intentionally
 * enable it on a reachable deployment. This keeps a stray preview URL from
 * driving the agent against those connections.
 */
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import { DEMO_PRINCIPAL } from "./principal";
import { mapleHostToolDefs } from "./host-tools";

interface ChatRequestBody {
  messages?: FlowletUIMessage[];
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Repair dangling tool calls in client-supplied history. An aborted stream (tab
 * closed, navigation, error mid-turn) can leave an assistant tool part stuck in
 * an input-* state; converted to a model message that is a `tool_use` with no
 * `tool_result`, which the provider rejects — poisoning EVERY later turn of the
 * thread. Mark such parts failed so they convert to an error tool_result and the
 * conversation stays usable.
 */
function repairDanglingToolParts(messages: FlowletUIMessage[]): FlowletUIMessage[] {
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const parts = message.parts.map((rawPart) => {
      const part = rawPart as { type: string; state?: string };
      if (
        part.type.startsWith("tool-") &&
        (part.state === "input-streaming" || part.state === "input-available")
      ) {
        changed = true;
        return {
          ...rawPart,
          state: "output-error",
          errorText: "Interrupted — this call never finished.",
        } as typeof rawPart;
      }
      return rawPart;
    });
    return changed ? { ...message, parts } : message;
  });
}

/** Only expose the real Composio identity to local requests, unless an operator
 *  has explicitly opted a deployment in via FLOWLET_DEMO_PUBLIC=1. */
function principalAllowed(req: Request): boolean {
  if (process.env.FLOWLET_DEMO_PUBLIC === "1") return true;
  // Prefer the Host header (authoritative for the served origin); fall back to
  // the request URL's hostname when it is absent.
  const host = req.headers.get("host");
  let hostname = host ? host.split(":")[0] : "";
  if (!hostname) {
    try { hostname = new URL(req.url).hostname; } catch { hostname = ""; }
  }
  return LOCAL_HOSTS.has(hostname.toLowerCase());
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
  // A missing/empty/non-array `messages` is a malformed client request (e.g. a
  // stray regenerate on a cleared thread, or `{messages: {}}`). Reject it
  // cleanly — passed through, streamText throws AI_InvalidPromptError and can
  // take the whole server process down.
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages must be a non-empty array" }, { status: 400 });
  }
  const stream = agent.run({
    messages: repairDanglingToolParts(messages),
    // Maple's own API surface enters through the caller seam (ENG-202): no
    // execute — the policy gates each call and the BROWSER executes approved
    // ones on the user's session via the SDK's host-tool runner.
    tools: hostToolset(mapleHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: req.signal,
  });
  return createUIMessageStreamResponse({ stream });
}
