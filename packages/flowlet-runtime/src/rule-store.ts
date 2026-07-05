/**
 * In-memory CompiledRuleStore — the embedded seam slot and test double
 * (ENG-193 §4.8/item-6). Mirrors `createInMemoryGrantStore`'s shape exactly;
 * rules are soft-revoked (revokedAt), never deleted — the Trust screen and
 * audit both want the row.
 */
import type { CompiledRule, CompiledRuleStore, Principal } from "@flowlet/core";

export function createInMemoryCompiledRuleStore(opts: { now?: () => string } = {}): CompiledRuleStore {
  const clock = opts.now ?? (() => new Date().toISOString());
  const rows = new Map<string, CompiledRule>();
  let seq = 0;
  const owned = (scope: Principal, r: CompiledRule) =>
    r.tenantId === scope.tenantId && r.subject === scope.subject;

  return {
    async create(scope, draft) {
      const rule: CompiledRule = {
        ...draft,
        id: `rule-${++seq}`,
        tenantId: scope.tenantId,
        subject: scope.subject,
        createdAt: clock(),
      };
      rows.set(rule.id, rule);
      return rule;
    },
    async list(scope) {
      return [...rows.values()].filter((r) => owned(scope, r));
    },
    async revoke(scope, id) {
      const r = rows.get(id);
      if (r && owned(scope, r) && r.revokedAt === undefined) {
        rows.set(id, { ...r, revokedAt: clock() });
      }
    },
  };
}
