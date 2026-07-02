/**
 * POST /api/flowlet/tick — drives the automations scheduler.
 *
 * The InProcessScheduler owns no timer in dev (a Next module singleton must
 * not leak intervals across hot reloads); instead the client layer pings this
 * route periodically and due cron schedules fire. Firing is idempotent per
 * tick window, so overlapping pings are safe.
 */
import { automationsWorld } from "@/flowlet/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  await automationsWorld().tick();
  return Response.json({ ok: true });
}
