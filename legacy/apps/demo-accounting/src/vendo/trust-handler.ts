/**
 * GET /api/vendo/grants, POST /api/vendo/grants/revoke,
 * GET /api/vendo/audit, GET /api/vendo/critical-tools (ENG-193 §3 Moment
 * 12/§4.3/§6.2), GET /api/vendo/rules + POST /api/vendo/rules/revoke
 * (ENG-193 item 6 — compiled always-ask rules, mirroring grants exactly) —
 * the Trust screen's data plane, mounted behind this app's own hand-rolled
 * routes.
 */
import { createGrantManager, createRuleManager, dangerTier } from "@vendoai/runtime";
import { demoStore, CADENCE_SCOPE } from "./store";
import { cadenceHostToolDefs } from "./host-tools";
import { hostToolset } from "@vendoai/runtime";
import { resolveToolDescriptor } from "./tool-registry";
import { demoPrincipalAllowed, LOCAL_ONLY_MESSAGE } from "./local-guard";

function scopePreview(scope: { kind: string; constraints?: { path: string; op: string; value: unknown }[]; inputPreview?: string }): string {
  if (scope.kind === "tool") return "any input";
  if (scope.kind === "exact") return `exactly: ${scope.inputPreview}`;
  return (scope.constraints ?? []).map((c) => `${c.path} ${c.op} ${JSON.stringify(c.value)}`).join(" AND ");
}

export async function handleDemoGrantsList(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const standing = await demoStore.grants.list(CADENCE_SCOPE);
  const rows = standing.filter((g) => g.revokedAt === undefined).map((g) => ({
    id: g.id, tool: g.tool, scopePreview: scopePreview(g.scope),
    ...(g.source.kind === "compiled-rule" && g.source.rule ? { plainText: g.source.rule } : {}),
    since: g.grantedAt, source: g.source.kind,
  }));
  return Response.json({ grants: rows });
}

export async function handleDemoGrantsRevoke(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await demoStore.grants.list(CADENCE_SCOPE)).find((g) => g.id === id && g.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live grant "${id}"` }, { status: 404 });
  await createGrantManager({ store: demoStore.grants, audit: demoStore.audit }).revoke(CADENCE_SCOPE, id);
  return Response.json({ ok: true });
}

export async function handleDemoRulesList(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const rows = (await demoStore.rules.list(CADENCE_SCOPE))
    .filter((r) => r.revokedAt === undefined)
    .map((r) => ({ id: r.id, toolPattern: r.toolPattern, plainText: r.plainText, since: r.createdAt }));
  return Response.json({ rules: rows });
}

export async function handleDemoRulesRevoke(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : undefined;
  if (!id) return Response.json({ error: "malformed revoke request" }, { status: 400 });
  const existing = (await demoStore.rules.list(CADENCE_SCOPE)).find((r) => r.id === id && r.revokedAt === undefined);
  if (!existing) return Response.json({ error: `no live rule "${id}"` }, { status: 404 });
  await createRuleManager({ store: demoStore.rules, audit: demoStore.audit }).revoke(CADENCE_SCOPE, id);
  return Response.json({ ok: true });
}

export async function handleDemoAuditQuery(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const url = new URL(req.url);
  const sinceMs = url.searchParams.get("sinceMs");
  const limit = url.searchParams.get("limit");
  const rows = await demoStore.audit.query(CADENCE_SCOPE, {
    ...(sinceMs ? { since: new Date(Number(sinceMs)).toISOString() } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  return Response.json({ events: rows });
}

const hostTools = hostToolset(cadenceHostToolDefs);

export async function handleDemoCriticalTools(req: Request): Promise<Response> {
  if (!demoPrincipalAllowed(req)) return Response.json({ error: LOCAL_ONLY_MESSAGE }, { status: 403 });
  const names = Object.keys(hostTools);
  const tools = names
    .map((name) => ({ name, descriptor: resolveToolDescriptor(name) }))
    .filter((t): t is { name: string; descriptor: NonNullable<ReturnType<typeof resolveToolDescriptor>> } => t.descriptor !== undefined)
    .filter((t) => dangerTier(t.descriptor) === "critical")
    .map((t) => ({ name: t.name }));
  return Response.json({ tools });
}
