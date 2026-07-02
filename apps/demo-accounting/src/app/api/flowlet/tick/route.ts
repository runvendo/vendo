/**
 * POST /api/flowlet/tick — drives the automations scheduler.
 *
 * The InProcessScheduler owns no timer in dev (a Next module singleton must
 * not leak intervals across hot reloads); instead the client layer pings this
 * route periodically and due cron schedules fire. Firing is idempotent per
 * tick window, so overlapping pings are safe.
 *
 * Gated by the SAME locality guard as the chat route (dual-review PR #27): a
 * tick fires REAL granted Gmail/Calendar sends, so an unauthenticated remote
 * POST on a deployment must not be able to trigger them.
 */
import { automationsWorld } from "@/flowlet/automations";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "@/flowlet/local-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  await automationsWorld().tick();
  return Response.json({ ok: true });
}
