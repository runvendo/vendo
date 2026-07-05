/**
 * POST /api/vendo/resume — approve/deny a run paused on approval, from the
 * approval toast. Unknown or already-settled runs answer `stale` (the toast
 * flips to its stale state) instead of erroring. Locality-guarded: resuming
 * fires REAL granted sends, exactly like tick.
 */
import { automationsWorld } from "@/vendo/automations";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "@/vendo/local-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    runId?: unknown;
    approved?: unknown;
    stepId?: unknown;
  };
  if (typeof body.runId !== "string" || body.runId.length === 0) {
    return Response.json({ error: "runId is required" }, { status: 400 });
  }
  const world = automationsWorld();
  const run = await world.runner.resume(
    world.scope,
    body.runId,
    body.approved === true,
    typeof body.stepId === "string" ? body.stepId : undefined,
  );
  if (!run) return Response.json({ stale: true });
  return Response.json({ run: { id: run.id, status: run.status, outcome: run.outcome ?? null } });
}
