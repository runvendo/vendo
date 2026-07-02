/**
 * POST /api/flowlet/chat over Express: turn the chat request into the agent's
 * streamed UIMessage response. Mirrors demo-bank's networked seam, adapted
 * from fetch Request/Response to Express (the web-Response body is piped).
 *
 * The local-only guard is kept verbatim: the agent acts on a real mailbox and
 * (via slack_summary) a real Slack workspace, so a stray reachable deployment
 * must not drive it. FLOWLET_DEMO_PUBLIC=1 opts a deployment in explicitly.
 */
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { createUIMessageStreamResponse } from "ai";
import type { FlowletAgent, FlowletUIMessage } from "@flowlet/core";
import { hostToolset } from "@flowlet/runtime";
import { gmailHostToolDefs } from "./host-tools";
import { DEMO_PRINCIPAL } from "./principal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function principalAllowed(req: Request): boolean {
  if (process.env.FLOWLET_DEMO_PUBLIC === "1") return true;
  const hostname = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
  return LOCAL_HOSTS.has(hostname);
}

export async function handleChat(req: Request, res: Response, agent: FlowletAgent): Promise<void> {
  if (!principalAllowed(req)) {
    res.status(403).json({
      error: "Flowlet demo agent is restricted to local runs. Set FLOWLET_DEMO_PUBLIC=1 to enable on a deployment.",
    });
    return;
  }
  const messages = (req.body?.messages ?? []) as FlowletUIMessage[];
  // Malformed/empty `messages` would take the model loop down — reject cleanly.
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty array" });
    return;
  }

  // Abort the agent run when the browser disconnects mid-stream.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const stream = agent.run({
    messages,
    // The app's own API enters through the caller seam (ENG-202): no execute —
    // the policy gates each call and the BROWSER executes approved ones.
    tools: hostToolset(gmailHostToolDefs),
    principal: DEMO_PRINCIPAL,
    signal: abort.signal,
  });

  const response = createUIMessageStreamResponse({ stream });
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body) {
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
  } else {
    res.end();
  }
}
