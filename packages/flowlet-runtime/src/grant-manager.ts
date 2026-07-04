/**
 * Grant lifecycle API (ENG-193 §4.3/§6.2): the ONLY paths that create or
 * revoke grants. Creation refuses critical tools (invariant §8.3 for chat —
 * the caller passes `critical` from the live descriptor tier) and both
 * operations leave an audit trail. The consent channel (item 2) is the sole
 * caller of `create` in production.
 */
import type { AuditLog, GrantStore, PermissionGrant, Principal } from "@flowlet/core";

type GrantDraft = Omit<PermissionGrant, "id" | "tenantId" | "subject" | "grantedAt" | "revokedAt">;

export function scopePreview(scope: PermissionGrant["scope"]): string {
  switch (scope.kind) {
    case "tool":
      return "any input";
    case "exact":
      return `exactly: ${scope.inputPreview}`;
    case "constrained":
      return scope.constraints.map((c) => `${c.path} ${c.op} ${JSON.stringify(c.value)}`).join(" AND ");
  }
}

export function createGrantManager(deps: {
  store: GrantStore;
  audit: AuditLog;
  now?: () => string;
}) {
  const clock = deps.now ?? (() => new Date().toISOString());
  return {
    async create(
      principal: Principal,
      draft: GrantDraft,
      opts: { critical?: boolean } = {},
    ): Promise<PermissionGrant> {
      if (opts.critical === true) {
        throw new Error(`refusing grant for critical tool "${draft.tool}" — critical is never grantable`);
      }
      const grant = await deps.store.create(principal, draft);
      await deps.audit.append({
        at: clock(), principal, kind: "grant_created",
        grantId: grant.id, tool: grant.tool, scopePreview: scopePreview(grant.scope),
      });
      return grant;
    },
    async revoke(principal: Principal, id: string): Promise<void> {
      const existing = (await deps.store.list(principal)).find((g) => g.id === id);
      await deps.store.revoke(principal, id);
      if (existing) {
        await deps.audit.append({
          at: clock(), principal, kind: "grant_revoked", grantId: id, tool: existing.tool,
        });
      }
    },
  };
}
