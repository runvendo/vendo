/**
 * POST /api/flowlet/chat — streams the Flowlet agent over HTTP.
 *
 * Agents are cached by the automations-world generation: a demo reset
 * recreates the world, and cached agents must not hold the dead store's
 * authoring tools. (No connect flow here — the Composio toolkit set is fixed,
 * so the generation is the only cache key.)
 */
import { createSteeringTools } from "@flowlet/runtime";
import { cadenceHostToolDefs } from "@/flowlet/host-tools";
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
        // ENG-193 PR #40 review (item A): demoTools() (the app's OWN
        // in-process host tools) stays OUT of controlTools — mixing it in
        // let host tools ride the judge/breaker control-plane exemption.
        extraTools: { ...demoTools() },
        controlTools: {
          ...automationsWorld().authoringTools(),
          // ENG-193 item 6: conversational steering — same static
          // single-tenant registration the authoring tools above use.
          ...createSteeringTools({
            principal: CADENCE_SCOPE,
            rules: demoStore.rules,
            grants: demoStore.grants,
            audit: demoStore.audit,
            resolveDescriptor: resolveToolDescriptor,
            // FALSE-ASSURANCE FIX (review follow-up): every tool name
            // `always_ask_before` can validate a glob against. Host tools +
            // authoring-tool verbs, plus the two Composio names this demo's
            // automation closed world actually knows about (`automations.ts`'s
            // `registered` map) — the real schema for anything beyond those
            // is only fetched live, per-turn, from Composio's MCP, so it
            // can't be enumerated statically here (same limitation
            // `tool-registry.ts`'s own docstring already calls out).
            knownToolNames: () => [
              ...Object.keys(demoTools()),
              ...Object.keys(automationsWorld().authoringTools()),
              // Host tools (sendClientMessage, listClients, …): a glob like
              // "send*" must validate against these too (PR #40 review fix).
              ...cadenceHostToolDefs.map((def) => def.name),
              "GMAIL_SEND_EMAIL",
              "GOOGLECALENDAR_CREATE_EVENT",
            ],
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
