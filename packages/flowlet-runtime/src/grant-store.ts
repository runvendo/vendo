/**
 * In-memory GrantStore — the embedded seam slot and the test double
 * (ENG-193 §6.1). Cloud Postgres lands behind the same @flowlet/core
 * interface. Grants are soft-revoked (revokedAt), never deleted: the Trust
 * screen and audit both want the row.
 */
import type { GrantStore, PermissionGrant, Principal } from "@flowlet/core";

export function createInMemoryGrantStore(opts: { now?: () => string } = {}): GrantStore {
  const clock = opts.now ?? (() => new Date().toISOString());
  const rows = new Map<string, PermissionGrant>();
  let seq = 0;
  const owned = (scope: Principal, g: PermissionGrant) =>
    g.tenantId === scope.tenantId && g.subject === scope.subject;

  return {
    async create(scope, draft) {
      const grant: PermissionGrant = {
        ...draft,
        id: `grant-${++seq}`,
        tenantId: scope.tenantId,
        subject: scope.subject,
        grantedAt: clock(),
      };
      rows.set(grant.id, grant);
      return grant;
    },
    async list(scope) {
      return [...rows.values()].filter((g) => owned(scope, g));
    },
    async revoke(scope, id) {
      const g = rows.get(id);
      if (g && owned(scope, g) && g.revokedAt === undefined) {
        rows.set(id, { ...g, revokedAt: clock() });
      }
    },
    async findForTool(scope, tool) {
      return [...rows.values()].filter(
        (g) => owned(scope, g) && g.tool === tool && g.revokedAt === undefined,
      );
    },
  };
}
