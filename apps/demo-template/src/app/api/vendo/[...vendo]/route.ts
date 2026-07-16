import { nextVendoHandler } from "@vendoai/vendo/server";
import { getCapsGuard, isAgentRunRequest, type CapsRefusal } from "@/server/caps";
import { vendo } from "@/vendo/server";

// ============================================================================
// PLUMBING — DO NOT MODIFY PER PROSPECT.
// This route meters the demo's caps (turns, spend, expiry). It is the only
// thing bounding cost/abuse on an open demo link running on OUR Anthropic
// key. Creator agents customize src/vendo/server.ts's CREATOR SEAM and the
// visible product under src/app — never this file or src/server/caps.ts.
// ============================================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = nextVendoHandler(vendo);

function refusalResponse(refusal: CapsRefusal): Response {
  return Response.json(refusal.body, { status: refusal.status });
}

// Thin wrapper: all cap logic lives in src/server/caps.ts. Expiry refuses
// every Vendo wire request (410; visible pages still render); the turn/spend
// caps gate only the agent-run request (POST /api/vendo/threads — see the
// discriminator comment on isAgentRunRequest).
function guarded(method: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const guard = getCapsGuard();
    const expired = guard.refuseIfExpired();
    if (expired !== null) return refusalResponse(expired);
    if (isAgentRunRequest(request.method, new URL(request.url).pathname)) {
      const refusal = await guard.consumeTurn();
      if (refusal !== null) return refusalResponse(refusal);
    }
    return method(request);
  };
}

export const GET = guarded(handler.GET);
export const POST = guarded(handler.POST);
export const DELETE = guarded(handler.DELETE);
