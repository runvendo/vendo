/**
 * The Cadence demo's Store seam wiring (ENG-193 §6.1/§6.2) — the hand-rolled
 * parallel of what `createVendoHandler` assembles for `vendo/server` hosts
 * (packages/vendo-server/src/route-handler.ts); this app hasn't migrated to
 * the handler, so it wires the same in-memory primitives directly.
 *
 * `ThreadStore.create()` mints its own store-assigned id (a deliberate seam
 * rule); the client's stable chat id ("cadence-demo", see VendoRoot.tsx)
 * is a friendly string, not that id. `resolveThreadRecordId` lazily creates a
 * ThreadRecord the first time a client id is seen and remembers the mapping —
 * same "single-slot cache, rebuilt on demo reset" idea already used for the
 * agent cache in `app/api/vendo/chat/route.ts`.
 *
 * Imports `CADENCE_SCOPE` from `./principal` — deliberately NOT from
 * `./automations` (which also re-exports it), to avoid a module cycle:
 * `policy.ts` (ENG-193 item 2, Task 7) imports `demoStore` from this module,
 * and `automations.ts` imports `demoPolicy` from `policy.ts`. If this module
 * depended on `automations.ts` too, the graph would close a cycle
 * (`policy → store → automations → policy`) that deadlocks mid-initialization
 * (`demoPolicy` would still be undefined when `automations.ts`'s top-level
 * `createAutomationsWorld()` call reads it). `principal.ts` is a
 * dependency-free leaf, so routing through it breaks the cycle.
 */
import { createConsentLedger, createFadeTracker, createInMemoryCompiledRuleStore, createInMemoryGrantStore, createInMemoryStore, type ConsentLedger, type FadeTracker, type InMemoryStore } from "@vendoai/runtime";
import type { CompiledRuleStore, GrantStore, Principal } from "@vendoai/core";
import { CADENCE_SCOPE } from "./principal";

export interface DemoStore extends InMemoryStore {
  grants: GrantStore;
  /** ENG-193 item 6 — compiled always-ask rules (conversational steering). */
  rules: CompiledRuleStore;
  fadeTracker: FadeTracker;
  /** Review follow-up — per-(principal, toolCallId) consent idempotency,
   *  constructed ONCE here alongside every other singleton this module owns. */
  consentSeen: ConsentLedger;
}

export const demoStore: DemoStore = {
  ...createInMemoryStore(),
  grants: createInMemoryGrantStore(),
  rules: createInMemoryCompiledRuleStore(),
  fadeTracker: createFadeTracker(),
  consentSeen: createConsentLedger(),
};

const threadIdByClientId = new Map<string, string>();

/** Resolve (creating on first sight) the store-assigned ThreadRecord id for a
 *  client-stable chat id, scoped by principal. */
export async function resolveThreadRecordId(scope: Principal, clientId: string): Promise<string> {
  const key = `${scope.tenantId}::${scope.subject}::${clientId}`;
  const existing = threadIdByClientId.get(key);
  if (existing) return existing;
  const record = await demoStore.threads.create(scope, { title: clientId });
  threadIdByClientId.set(key, record.id);
  return record.id;
}

/** Reset hook for the demo's `Cmd/Ctrl+Shift+.` reseed — clears the mapping so
 *  a reset thread doesn't inherit stale message history (wired into
 *  `/api/demo/reset` via `resetDemoStore`). */
export function resetThreadMapping(): void {
  threadIdByClientId.clear();
}

/**
 * Full demo-take reset (`/api/demo/reset`): clear the thread mapping and
 * revoke every standing grant, so the next take starts with a clean consent
 * story. Deliberately works WITHIN the existing store objects rather than
 * replacing them: `policy.ts` captured `demoStore.grants`/`demoStore.audit`
 * by reference at module load (inside `grantPolicy`/`auditPolicy`), so
 * swapping the objects would split the world — the policy suppressing off one
 * grant store while consent mints into another. Grants are soft-revoked (the
 * GrantStore seam has no delete); old ThreadRecords are simply orphaned by
 * the cleared mapping (the seam has no delete either — the next chat mints a
 * fresh thread); the audit log intentionally survives resets (append-only by
 * design).
 *
 * `demoStore.fadeTracker` is deliberately NOT reset here either (ENG-193
 * §4.4) — same "audit log intentionally survives resets" reasoning: a fresh
 * take should still show fades already learned this session as a demo
 * feature, not a bug. Flip this if the runbook wants a clean-slate reset
 * instead — flag for Yousef at review, since this is a demo-choreography
 * call, not an architecture one.
 */
export async function resetDemoStore(): Promise<void> {
  resetThreadMapping();
  const grants = await demoStore.grants.list(CADENCE_SCOPE);
  await Promise.all(grants.map((g) => demoStore.grants.revoke(CADENCE_SCOPE, g.id)));
  // ENG-193 item 6: rules reset like grants (a rule is standing, agreed-to
  // policy state, exactly like a grant — not a learned-signal counter like
  // the fadeTracker, which intentionally survives).
  const rules = await demoStore.rules.list(CADENCE_SCOPE);
  await Promise.all(rules.map((r) => demoStore.rules.revoke(CADENCE_SCOPE, r.id)));
}

// Re-export for callers that only need the fixed demo principal scope.
export { CADENCE_SCOPE };
