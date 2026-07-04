/**
 * Cadence's `trust` shell seam (ENG-193 §3 Moment 12/§4.3/§6.2): fetches the
 * Trust screen's data from this app's own routes (trust-handler.ts,
 * fade-proposal-handler.ts), mirroring `parked-actions.ts`/`consent.ts`'s
 * plain-fetch style exactly.
 */
import type { TrustAuditRow, TrustGrantRow, TrustRuleRow } from "@flowlet/shell";

async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((body as { error?: string }).error ?? fallback);
  return body;
}

export async function listGrants(): Promise<TrustGrantRow[]> {
  const res = await fetch("/api/flowlet/grants");
  const body = await json<{ grants?: TrustGrantRow[] }>(res, `failed to list grants (${res.status})`);
  return body.grants ?? [];
}

export async function revokeGrant(id: string): Promise<void> {
  const res = await fetch("/api/flowlet/grants/revoke", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
  });
  await json(res, `failed to revoke grant (${res.status})`);
}

export async function queryAudit(opts: { sinceMs: number }): Promise<TrustAuditRow[]> {
  const res = await fetch(`/api/flowlet/audit?sinceMs=${opts.sinceMs}`);
  const body = await json<{ events?: TrustAuditRow[] }>(res, `failed to query audit (${res.status})`);
  return body.events ?? [];
}

export async function listCriticalTools(): Promise<{ name: string }[]> {
  const res = await fetch("/api/flowlet/critical-tools");
  const body = await json<{ tools?: { name: string }[] }>(res, `failed to list critical tools (${res.status})`);
  return body.tools ?? [];
}

export async function listRules(): Promise<TrustRuleRow[]> {
  const res = await fetch("/api/flowlet/rules");
  const body = await json<{ rules?: TrustRuleRow[] }>(res, `failed to list rules (${res.status})`);
  return body.rules ?? [];
}

export async function revokeRule(id: string): Promise<void> {
  const res = await fetch("/api/flowlet/rules/revoke", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
  });
  await json(res, `failed to revoke rule (${res.status})`);
}

export async function resolveFadeProposal(proposalId: string, accept: boolean): Promise<void> {
  const res = await fetch("/api/flowlet/fade-proposal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId, accept }),
  });
  await json(res, `failed to resolve fade proposal (${res.status})`);
}
