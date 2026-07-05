/**
 * POST /api/vendo/chat over Express: turn the chat request into the agent's
 * streamed UIMessage response. Mirrors demo-bank's networked seam, adapted
 * from fetch Request/Response to Express (the web-Response body is piped).
 *
 * The local-only guard is kept as defense-in-depth: the agent acts on a real
 * mailbox and (via slack_summary) a real Slack workspace. The Host header is
 * client-controlled, so the REAL boundary is the server's loopback-only bind
 * (see server/index.ts); VENDO_DEMO_PUBLIC=1 opts a deployment in explicitly.
 */
import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { createUIMessageStreamResponse } from "ai";
import type { VendoAgent, VendoUIMessage } from "@vendoai/core";
import { hostToolset } from "@vendoai/runtime";
import { gmailHostToolDefs } from "./host-tools";
import { DEMO_PRINCIPAL } from "./principal";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function principalAllowed(req: Request): boolean {
  if (process.env.VENDO_DEMO_PUBLIC === "1") return true;
  const hostname = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
  return LOCAL_HOSTS.has(hostname);
}

export async function handleChat(req: Request, res: Response, agent: VendoAgent): Promise<void> {
  if (!principalAllowed(req)) {
    res.status(403).json({
      error: "Vendo demo agent is restricted to local runs. Set VENDO_DEMO_PUBLIC=1 to enable on a deployment.",
    });
    return;
  }
  const messages = (req.body?.messages ?? []) as VendoUIMessage[];
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
    const readable = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    // handleChat's promise has resolved by the time streaming runs — a late
    // transport error would otherwise be an unhandled 'error' event.
    readable.on("error", (error) => {
      console.error("[vendo] chat stream error:", error);
      res.destroy(error);
    });
    readable.pipe(res);
  } else {
    res.end();
  }
}
