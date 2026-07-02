/**
 * POST /api/flowlet/chat — streams the Flowlet agent over HTTP.
 *
 * Agents are cached by the automations-world generation: a demo reset
 * recreates the world, and cached agents must not hold the dead store's
 * authoring tools. (No connect flow here — the Composio toolkit set is fixed,
 * so the generation is the only cache key.)
 */
import { createDemoAgent } from "@/flowlet/agent";
import { handleChat } from "@/flowlet/chat-handler";
import { demoTools } from "@/flowlet/tools";
import { automationsWorld, automationsGeneration } from "@/flowlet/automations";
import type { FlowletAgent } from "@flowlet/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const agents = new Map<number, FlowletAgent>();

function getAgent(): FlowletAgent {
  const key = automationsGeneration();
  let agent = agents.get(key);
  if (!agent) {
    agent = createDemoAgent({
      extraTools: { ...demoTools(), ...automationsWorld().authoringTools() },
    });
    agents.set(key, agent);
  }
  return agent;
}

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, getAgent());
}
