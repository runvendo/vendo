/**
 * The Cadence demo's Store seam wiring (ENG-193 §6.1/§6.2) — the hand-rolled
 * parallel of what `createFlowletHandler` assembles for `@flowlet/next` hosts
 * (packages/flowlet-next/src/handler.ts); this app hasn't migrated to the
 * handler, so it wires the same in-memory primitives directly.
 *
 * `ThreadStore.create()` mints its own store-assigned id (a deliberate seam
 * rule); the client's stable chat id ("cadence-demo", see FlowletRoot.tsx)
 * is a friendly string, not that id. `resolveThreadRecordId` lazily creates a
 * ThreadRecord the first time a client id is seen and remembers the mapping —
 * same "single-slot cache, rebuilt on demo reset" idea already used for the
 * agent cache in `app/api/flowlet/chat/route.ts`.
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
import { createInMemoryGrantStore, createInMemoryStore, type InMemoryStore } from "@flowlet/runtime";
import type { GrantStore, Principal } from "@flowlet/core";
import { CADENCE_SCOPE } from "./principal";

export interface DemoStore extends InMemoryStore {
  grants: GrantStore;
}

export const demoStore: DemoStore = {
  ...createInMemoryStore(),
  grants: createInMemoryGrantStore(),
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
 *  a reset thread doesn't inherit stale message history. Not yet wired into
 *  `/api/demo/reset` (out of scope for this task's file list) — a reset today
 *  leaves grants/threads/mapping standing across takes; flagged as a known
 *  follow-up. */
export function resetThreadMapping(): void {
  threadIdByClientId.clear();
}

// Re-export for callers that only need the fixed demo principal scope.
export { CADENCE_SCOPE };
