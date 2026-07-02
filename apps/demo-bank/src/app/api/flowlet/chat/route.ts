/**
 * POST /api/flowlet/chat — streams the Flowlet agent over HTTP.
 *
 * The agent's available tools MUST track the demo connection store. We can't use
 * a single singleton: each agent instance has its OWN internal Composio ingestion
 * cache (engine.ts memoizes by userId for the agent's lifetime), so an agent
 * built before a toolkit was connected never picks the new toolkit up.
 *
 * Instead we cache agents in a Map keyed by the sorted connected-toolkit list.
 * When the user connects e.g. gmail, the key changes, so a FRESH agent is built
 * that ingests gmail — and that's what makes a just-connected tool actually work.
 */
import { createDemoAgent } from "@/flowlet/agent";
import { handleChat } from "@/flowlet/chat-handler";
import { demoTools } from "@/flowlet/tools";
import { automationsWorld, automationsGeneration } from "@/flowlet/automations";
import { connectedToolkits } from "@/flowlet/connections-store";
import type { FlowletAgent } from "@flowlet/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const agents = new Map<string, FlowletAgent>();

function getAgent(): FlowletAgent {
  const toolkits = connectedToolkits();
  // Key by connected toolkits AND the automations-world generation: a demo
  // reset recreates the world, and cached agents must not hold the dead store.
  const key = `${automationsGeneration()}:${toolkits.slice().sort().join(",")}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = createDemoAgent({
      extraTools: { ...demoTools(), ...automationsWorld().authoringTools() },
      toolkits,
    });
    agents.set(key, agent);
  }
  return agent;
}

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, getAgent());
}
