/**
 * GET /api/flowlet/deliveries?since=<cursor> — the FlowletToasts feed: in-app
 * Channels deliveries (automation completions + approval requests) retained by
 * the world's InAppChannels. Same locality guard as chat/tick: run summaries
 * must not leak to unauthenticated remote callers.
 */
import { automationsWorld } from "@/flowlet/automations";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "@/flowlet/local-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const world = automationsWorld();
  const raw = Number(new URL(req.url).searchParams.get("since") ?? "0");
  const since = Number.isFinite(raw) && raw >= 0 ? raw : 0;
  return Response.json({ deliveries: world.channels.listSince(world.scope, since) });
}
