/**
 * POST /api/flowlet/chat — streams the Flowlet agent over HTTP.
 *
 * Agents are cached by the automations-world generation: a demo reset
 * recreates the world, and cached agents must not hold the dead store's
 * authoring tools. (No connect flow here — the Composio toolkit set is fixed,
 * so the generation is the only cache key.)
 */
import { createSteeringTools } from "@flowlet/runtime";
import { createDemoAgent } from "@/flowlet/agent";
import { handleChat } from "@/flowlet/chat-handler";
import { demoTools } from "@/flowlet/tools";
import { automationsWorld, automationsGeneration } from "@/flowlet/automations";
import { demoStore, CADENCE_SCOPE } from "@/flowlet/store";
import { resolveToolDescriptor } from "@/flowlet/tool-registry";
import type { FlowletAgent } from "@flowlet/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single-slot cache rebuilt when the automations world changes (a demo reset
// bumps the generation). Keeping only the CURRENT agent — not a keyed Map —
// means a reset drops the old world's agent (and its Composio cache) instead
// of leaking one per reset, and no stale-world agent lingers (dual-review #27).
let cached: { gen: number; agent: FlowletAgent } | null = null;

function getAgent(): FlowletAgent {
  const gen = automationsGeneration();
  if (!cached || cached.gen !== gen) {
    cached = {
      gen,
      agent: createDemoAgent({
        extraTools: {
          ...demoTools(),
          ...automationsWorld().authoringTools(),
          // ENG-193 item 6: conversational steering — same static
          // single-tenant registration the authoring tools above use.
          ...createSteeringTools({
            principal: CADENCE_SCOPE,
            rules: demoStore.rules,
            grants: demoStore.grants,
            audit: demoStore.audit,
            resolveDescriptor: resolveToolDescriptor,
          }),
        },
      }),
    };
  }
  return cached.agent;
}

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, getAgent());
}
