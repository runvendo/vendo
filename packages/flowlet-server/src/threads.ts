/**
 * Client-chat-id → store-thread-id index (ENG-193 §6.2, the item-2 plan's
 * "Plan deviations" #2). The ai SDK's DefaultChatTransport sends
 * `{ id: chatId, messages, ... }` on every POST; `ThreadStore.create()` mints
 * its own store-assigned id (seam authorship rule), so a mapping is needed.
 * Lazily creates a ThreadRecord the first time a (principal, chatId) pair is
 * seen.
 *
 * RESTART-SAFE (durable-persistence rework of ENG-193 PR #40 review item H):
 * the mapping is now DERIVED FROM THE STORE instead of living in a
 * process-local Map. `ThreadStore.upsertMessages` auto-creates a thread
 * under a caller-supplied id (the additive seam member the durable stores
 * implement), so the index simply adopts the client id AS the store thread
 * id: a restart (or a second instance behind a load balancer) resolves the
 * SAME client id to the SAME thread rows. The Map remains only as a
 * per-process memo to skip the existence check on the hot path.
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
      const memo = byClientId.get(key);
      if (memo) return memo;
      const existing = await threads.get(scope, clientId);
      if (!existing) {
        // First write mints the thread under the CLIENT-OWNED id (empty
        // upsert = auto-create), so the mapping is reconstructible from the
        // store alone after a restart.
        await threads.upsertMessages(scope, clientId, []);
      }
      byClientId.set(key, clientId);
      return clientId;
    },
  };
}
