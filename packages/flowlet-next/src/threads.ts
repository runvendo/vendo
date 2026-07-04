/**
 * Client-chat-id → store-thread-id index (ENG-193 §6.2, the item-2 plan's
 * "Plan deviations" #2). The ai SDK's DefaultChatTransport sends
 * `{ id: chatId, messages, ... }` on every POST; `ThreadStore.create()` mints
 * its own store-assigned id (seam authorship rule), so a mapping is needed.
 * Lazily creates a ThreadRecord the first time a (principal, chatId) pair is
 * seen.
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
