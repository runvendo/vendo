/**
 * Rule lifecycle API (ENG-193 §4.8/item-6) — the ONLY paths that create or
 * revoke a compiled always-ask rule. Unlike `grant-manager.ts`, rule creation
 * has no criticality refusal to make: a tighten rule only ever ADDS
 * friction, so nothing is unsafe about it targeting any tool, including a
 * critical one — asking about something that already always asks is a
 * harmless no-op, not a hole. Every operation still leaves an audit trail.
 */
import type { AuditLog, CompiledRule, CompiledRuleStore, Principal } from "@flowlet/core";

type RuleDraft = Omit<CompiledRule, "id" | "tenantId" | "subject" | "createdAt" | "revokedAt">;

export function createRuleManager(deps: {
  store: CompiledRuleStore;
  audit: AuditLog;
  now?: () => string;
}) {
  const clock = deps.now ?? (() => new Date().toISOString());
  return {
    async create(principal: Principal, draft: RuleDraft): Promise<CompiledRule> {
      const rule = await deps.store.create(principal, draft);
      await deps.audit.append({
        at: clock(), principal, kind: "rule_created",
        ruleId: rule.id, toolPattern: rule.toolPattern, plainText: rule.plainText,
      });
      return rule;
    },
    async revoke(principal: Principal, id: string): Promise<void> {
      const existing = (await deps.store.list(principal)).find((r) => r.id === id);
      await deps.store.revoke(principal, id);
      // Audit only a real state change — mirrors grant-manager.ts's own rule.
      if (existing && existing.revokedAt === undefined) {
        await deps.audit.append({
          at: clock(), principal, kind: "rule_revoked", ruleId: id, toolPattern: existing.toolPattern,
        });
      }
    },
  };
}
