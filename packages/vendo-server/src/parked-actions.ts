/**
 * GET /api/vendo/parked-actions and POST /api/vendo/parked-actions/resolve
 * (ENG-193 §4.6) — the "Waiting on you" surface's data plane. Thin adapters
 * over the world's runner/store, following consent.ts's own pattern.
 *
 * SCOPING (review follow-up): these routes key off the WORLD's own fixed
 * scope (`world.scope`), NOT the per-request principal `resolvePrincipal`
 * resolved for this call. `world.ts` is explicit that the automations world
 * is single-tenant — every automation run and every parked row it creates
 * lives under ONE fixed scope set at construction time (see
 * `createAutomationsWorld`'s `config.scope`, wired in handler.ts as
 * `{ tenantId: "vendo-embedded", subject: DEFAULT_PRINCIPAL.userId }`).
 * A host with a custom multi-tenant `principal` resolver still gates WHO may
 * hit this endpoint (via `resolvePrincipal` upstream in handler.ts), but the
 * rows themselves must be read/resolved under the world's own scope — using
 * the caller's resolved principal instead would look up an empty per-user
 * scope that never has (and can never get) any parked rows, making "Waiting
 * on you" permanently empty and unresolvable for every custom-principal
 * mount. This is the SAME declared single-tenant follow-up steering tools
 * already carry in handler.ts (PRINCIPAL ASYMMETRY comment) — multi-user
 * automation isolation needs a per-user world/store, not a per-request scope
 * swap here.
 */
import { parkedActionResolutionSchema } from "@vendoai/core";
import type { VendoAutomationsWorld } from "./world";

export async function listParkedActionsRoute(
  _req: Request,
  deps: { world: VendoAutomationsWorld | null; principal: { userId: string } },
): Promise<Response> {
  if (!deps.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
  const actions = await deps.world.store.listParkedActions(deps.world.scope, { unresolvedOnly: true });
  return Response.json({ actions });
}

export async function resolveParkedActionRoute(
  req: Request,
  deps: { world: VendoAutomationsWorld | null; principal: { userId: string } },
): Promise<Response> {
  if (!deps.world) return Response.json({ error: "automations are disabled" }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const parsed = parkedActionResolutionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "malformed resolve request" }, { status: 400 });
  const result = await deps.world.runner.resolveParkedAction(
    deps.world.scope, parsed.data.actionId, parsed.data.decision === "yes" ? "approved" : "declined",
  );
  if (!result.ok) {
    const status = /not found/.test(result.error) ? 404 : 409;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json(result);
}
