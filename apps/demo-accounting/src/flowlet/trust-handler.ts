/**
 * GET /api/flowlet/grants, POST /api/flowlet/grants/revoke,
 * GET /api/flowlet/audit, GET /api/flowlet/critical-tools (ENG-193 §3 Moment
 * 12/§4.3/§6.2) — the Trust screen's data plane, mounted behind this app's
 * own hand-rolled routes.
 */
import { createGrantManager, dangerTier } from "@flowlet/runtime";
import { demoStore, CADENCE_SCOPE } from "./store";
import { automationsWorld } from "./automations";
import { cadenceHostToolDefs } from "./host-tools";
import { hostToolset } from "@flowlet/runtime";
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
    id: g.id, tool: g.tool, scopePreview: scopePreview(g.scope), since: g.grantedAt, source: g.source.kind,
  }));
  const automations = await automationsWorld().store.list(CADENCE_SCOPE);
  for (const automation of automations) {
    const version = await automationsWorld().store.getVersion(CADENCE_SCOPE, automation.id, automation.currentVersion);
    for (const grant of version?.grants ?? []) {
      rows.push({
        id: undefined, tool: grant.tool, scopePreview: "runs as agreed",
        since: grant.grantedAt, source: "automation", automationName: automation.name,
      } as never);
    }
  }
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
  const names = [...new Set([...Object.keys(hostTools), ...Object.keys(automationsWorld().authoringTools())])];
  const tools = names
    .map((name) => ({ name, descriptor: resolveToolDescriptor(name) }))
    .filter((t): t is { name: string; descriptor: NonNullable<ReturnType<typeof resolveToolDescriptor>> } => t.descriptor !== undefined)
    .filter((t) => dangerTier(t.descriptor) === "critical")
    .map((t) => ({ name: t.name }));
  return Response.json({ tools });
}
