/**
 * The Trust screen's read/write endpoints (ENG-193 §3 Moment 12/§4.3/§6.2):
 * GET /grants (federated — standing GrantStore rows + read-only automation-
 * version rows, per spec §4.3's own federation language), POST /grants/revoke,
 * GET /audit (query), GET /critical-tools (static per-request, no store),
 * GET /rules + POST /rules/revoke (ENG-193 item 6 — compiled always-ask
 * rules, mirroring grants list/revoke exactly).
 * Thin adapters over the runtime/store primitives, following consent.ts's
 * own pattern in this package.
 */
import type { AuditLog, CompiledRuleStore, GrantStore, Principal } from "@vendoai/core";
import { createGrantManager, createRuleManager, dangerTier, type ToolDescriptor } from "@vendoai/runtime";
import type { VendoAutomationsWorld } from "./world";

export interface TrustGrantRow {
  id?: string;
  tool: string;
  scopePreview: string;
  /** ENG-193 item 6: for a compiled-rule-sourced grant, the user's own
   *  loosen-rule phrasing (the grant's `source.rule`), e.g. "don't ask about
   *  invoices" — preferred over `scopePreview` when present so the Trust
   *  screen matches the spec's own Moment 12 mock copy. */
  plainText?: string;
  since: string;
  source: "chat" | "fade" | "compiled-rule" | "automation";
  automationName?: string;
}

/** ENG-193 item 6 — a compiled "always ask before X" rule (Trust screen row). */
export interface TrustRuleRow {
  id: string;
  toolPattern: string;
  plainText: string;
  since: string;
}

function scopePreview(scope: { kind: string; constraints?: { path: string; op: string; value: unknown }[]; inputPreview?: string }): string {
  if (scope.kind === "tool") return "any input";
  if (scope.kind === "exact") return `exactly: ${scope.inputPreview}`;
  return (scope.constraints ?? []).map((c) => `${c.path} ${c.op} ${JSON.stringify(c.value)}`).join(" AND ");
}

export async function listGrantsRoute(
  _req: Request,
  deps: { grants: GrantStore; world: VendoAutomationsWorld | null; principal: Principal },
): Promise<Response> {
  const standing = await deps.grants.list(deps.principal);
  const rows: TrustGrantRow[] = standing
    .filter((g) => g.revokedAt === undefined)
    .map((g) => ({
      id: g.id, tool: g.tool, scopePreview: scopePreview(g.scope),
      ...(g.source.kind === "compiled-rule" && g.source.rule ? { plainText: g.source.rule } : {}),
      since: g.grantedAt, source: g.source.kind,
    }));

  if (deps.world) {
    // Finding 7 (mirrors parked-actions.ts's own documented fix): the
    // automations world is single-tenant with a FIXED scope set at
    // construction (`world.scope`) — every automation and its grants live
    // there, never under whatever a custom multi-tenant `principal` resolver
    // returns per request. Querying by `deps.principal` here looked up an
    // empty per-user scope that never has (and can never get) any automation
    // rows, making the Trust screen's Automations section permanently empty
    // for a custom-principal mount. Standing chat grants (above) are
    // unaffected — those correctly stay scoped to `deps.principal`.
    const automations = await deps.world.store.list(deps.world.scope);
    for (const automation of automations) {
      const version = await deps.world.store.getVersion(deps.world.scope, automation.id, automation.currentVersion);
      for (const grant of version?.grants ?? []) {
        rows.push({
          tool: grant.tool, scopePreview: "runs as agreed",
          since: grant.grantedAt, source: "automation", automationName: automation.name,
        });
      }
    }
  }
  return Response.json({ grants: rows });
}

export async function revokeGrantRoute(
  req: Request,
  deps: { grants: GrantStore; audit: AuditLog; principal: Principal },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await deps.grants.list(deps.principal)).find((g) => g.id === id && g.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live grant "${id}"` }, { status: 404 });
  await createGrantManager({ store: deps.grants, audit: deps.audit }).revoke(deps.principal, id);
  return Response.json({ ok: true });
}

export async function listRulesRoute(
  _req: Request,
  deps: { rules: CompiledRuleStore; principal: Principal },
): Promise<Response> {
  const rows: TrustRuleRow[] = (await deps.rules.list(deps.principal))
    .filter((r) => r.revokedAt === undefined)
    .map((r) => ({ id: r.id, toolPattern: r.toolPattern, plainText: r.plainText, since: r.createdAt }));
  return Response.json({ rules: rows });
}

export async function revokeRuleRoute(
  req: Request,
  deps: { rules: CompiledRuleStore; audit: AuditLog; principal: Principal },
): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await deps.rules.list(deps.principal)).find((r) => r.id === id && r.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live rule "${id}"` }, { status: 404 });
  await createRuleManager({ store: deps.rules, audit: deps.audit }).revoke(deps.principal, id);
  return Response.json({ ok: true });
}

export async function queryAuditRoute(
  req: Request,
  deps: { audit: AuditLog; principal: Principal },
): Promise<Response> {
  const url = new URL(req.url);
  const sinceMs = url.searchParams.get("sinceMs");
  const limit = url.searchParams.get("limit");
  const rows = await deps.audit.query(deps.principal, {
    ...(sinceMs ? { since: new Date(Number(sinceMs)).toISOString() } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  return Response.json({ events: rows });
}

export async function listCriticalToolsRoute(
  _req: Request,
  deps: { toolNames: string[]; resolveDescriptor: (name: string) => ToolDescriptor | undefined },
): Promise<Response> {
  const tools = [...new Set(deps.toolNames)]
    .map((name) => ({ name, descriptor: deps.resolveDescriptor(name) }))
    .filter((t): t is { name: string; descriptor: ToolDescriptor } => t.descriptor !== undefined)
    .filter((t) => dangerTier(t.descriptor) === "critical")
    .map((t) => ({ name: t.name }));
  return Response.json({ tools });
}
