/**
 * Client-chat-id → store-thread-id index (ENG-193 §6.2, the item-2 plan's
 * "Plan deviations" #2). The ai SDK's DefaultChatTransport sends
 * `{ id: chatId, messages, ... }` on every POST; `ThreadStore.create()` mints
 * its own store-assigned id (seam authorship rule), so a mapping is needed.
 * Lazily creates a ThreadRecord the first time a (principal, chatId) pair is
 * seen.
 *
 * DOCUMENTED v1 LIMITATION (ENG-193 PR #40 review — item H): `byClientId` is
 * an in-memory `Map`, PROCESS-LOCAL — it does not persist behind whatever
 * `ThreadStore` a host wires (even a durable one). A process restart (or a
 * second instance behind a load balancer) forgets every clientId→storeId
 * mapping: the client resumes with the SAME chatId, `resolve` misses, and a
 * BRAND NEW store thread is minted — silently splitting that conversation's
 * history across two store-side thread ids. Acceptable for v1 (single
 * long-lived process, no restart-preserving story yet); a real fix needs this
 * index to live behind a persistent seam (or be derivable directly from the
 * store, e.g. a store-side lookup keyed by clientId) rather than a local Map.
 * Tracked as a PR follow-up, not fixed here.
 */
import type { Principal, ThreadStore } from "@flowlet/core";

export interface ThreadIndex {
  resolve(scope: Principal, clientId: string): Promise<string>;
}

export function createThreadIndex(threads: ThreadStore): ThreadIndex {
  const byClientId = new Map<string, string>();
  return {
    async resolve(scope, clientId) {
      const key = `${scope.tenantId}::${scope.subject}::${clientId}`;
      const existing = byClientId.get(key);
      if (existing) return existing;
      const record = await threads.create(scope, { title: clientId });
      byClientId.set(key, record.id);
      return record.id;
    },
  };
}
