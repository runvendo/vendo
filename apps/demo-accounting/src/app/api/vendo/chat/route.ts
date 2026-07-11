/**
 * POST /api/vendo/chat — streams the Vendo agent over HTTP.
 *
 * The demo has one fixed toolkit set, so a single process-local agent is
 * sufficient.
 */
import { createSteeringTools } from "@vendoai/runtime";
import { cadenceHostToolDefs } from "@/vendo/host-tools";
import { createDemoAgent } from "@/vendo/agent";
import { handleChat } from "@/vendo/chat-handler";
import { demoTools } from "@/vendo/tools";
import { demoStore, CADENCE_SCOPE } from "@/vendo/store";
import { resolveToolDescriptor } from "@/vendo/tool-registry";
import type { VendoAgent } from "@vendoai/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cached: VendoAgent | null = null;

function getAgent(): VendoAgent {
  if (!cached) {
    cached = createDemoAgent({
      extraTools: { ...demoTools() },
      controlTools: {
        ...createSteeringTools({
            principal: CADENCE_SCOPE,
            rules: demoStore.rules,
            grants: demoStore.grants,
            audit: demoStore.audit,
            resolveDescriptor: resolveToolDescriptor,
            knownToolNames: () => [
              ...Object.keys(demoTools()),
              ...cadenceHostToolDefs.map((def) => def.name),
              "GMAIL_SEND_EMAIL",
              "GOOGLECALENDAR_CREATE_EVENT",
            ],
          }),
      },
    });
  }
  return cached;
}

export async function POST(req: Request): Promise<Response> {
  return handleChat(req, getAgent());
}
