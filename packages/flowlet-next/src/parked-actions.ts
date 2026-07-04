/**
 * GET /api/flowlet/parked-actions and POST /api/flowlet/parked-actions/resolve
 * (ENG-193 §4.6) — the "Waiting on you" surface's data plane. Thin adapters
 * over the world's runner/store, following consent.ts's own pattern.
 */
import { parkedActionResolutionSchema } from "@flowlet/core";
import type { FlowletAutomationsWorld } from "./world";
import { EMBEDDED_TENANT } from "./policy-stack";

export async function listParkedActionsRoute(
  _req: Request,
  deps: { world: FlowletAutomationsWorld | null; principal: { userId: string } },
): Promise<Response> {
  if (!deps.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
  const scope = { tenantId: EMBEDDED_TENANT, subject: deps.principal.userId };
  const actions = await deps.world.store.listParkedActions(scope, { unresolvedOnly: true });
  return Response.json({ actions });
}

export async function resolveParkedActionRoute(
  req: Request,
  deps: { world: FlowletAutomationsWorld | null; principal: { userId: string } },
): Promise<Response> {
  if (!deps.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const parsed = parkedActionResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed resolve request" }, { status: 400 });
  const scope = { tenantId: EMBEDDED_TENANT, subject: deps.principal.userId };
  const result = await deps.world.runner.resolveParkedAction(
    scope, parsed.data.actionId, parsed.data.decision === "yes" ? "approved" : "declined",
  );
  if (!result.ok) {
    const status = /not found/.test(result.error) ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json(result);
}
