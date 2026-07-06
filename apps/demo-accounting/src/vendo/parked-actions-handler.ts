/**
 * GET /api/vendo/parked-actions and POST /api/vendo/parked-actions/resolve
 * (ENG-193 §4.6) — the "Waiting on you" surface's data plane, mounted behind
 * this app's own hand-rolled routes the same way every other Vendo route
 * here is a thin adapter over a testable handler function (see
 * consent-handler.ts). The `vendo/server` production mount of the SAME
 * runtime logic lives in packages/vendo-server/src/parked-actions.ts; this app
 * hasn't migrated to the handler ("Plan deviations" #1).
 */
import { parkedActionResolutionSchema } from "@vendoai/core";
import { automationsWorld, CADENCE_SCOPE } from "./automations";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

export async function handleDemoParkedActionsList(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const actions = await automationsWorld().store.listParkedActions(CADENCE_SCOPE, { unresolvedOnly: true });
  return Response.json({ actions });
}

export async function handleDemoParkedActionResolve(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) {
    return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const parsed = parkedActionResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed resolve request" }, { status: 400 });
  const result = await automationsWorld().runner.resolveParkedAction(
    CADENCE_SCOPE, parsed.data.actionId, parsed.data.decision === "yes" ? "approved" : "declined",
  );
  if (!result.ok) {
    const status = /not found/.test(result.error) ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json(result);
}
