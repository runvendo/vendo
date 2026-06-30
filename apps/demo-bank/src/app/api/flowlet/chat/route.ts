/**
 * POST /api/flowlet/chat — streams the Flowlet agent over HTTP.
 *
 * The client talks to this via an ai-SDK HTTP transport. The server-only agent
 * (Composio Node internals) is built lazily once and reused — the engine reuses
 * its Composio client across runs, so a singleton is correct.
 */
import { createDemoAgent } from "@/flowlet/agent";
import { handleChat } from "@/flowlet/chat-handler";
import { demoTools } from "@/flowlet/tools";
import type { FlowletAgent } from "@flowlet/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let agent: FlowletAgent | undefined;
function getAgent(): FlowletAgent {
  return (agent ??= createDemoAgent({ extraTools: demoTools() }));
}

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, getAgent());
}
