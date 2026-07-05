import type { RemixClient, RemixPin } from "./remixes";

export interface WebRemixesOptions {
  /** Scope records (e.g. per user). Default "default". */
  namespace?: string;
  /** Injectable for tests/SSR; defaults to globalThis.localStorage at call time. */
  storage?: Storage;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/** Bump when the persisted record shape changes incompatibly. */
const SCHEMA_VERSION = 1;

/**
 * The embedded-mode RemixClient over Web Storage, mirroring `createWebStorage`
 * (seams/web-storage.ts): one key per anchor under `flowlet:remix:<namespace>:`,
 * loud failures on unavailable/full storage, versioned envelope with malformed
 * records skipped (a broken pin degrades to the host default, never a crash).
 */
export function createWebRemixes(options: WebRemixesOptions = {}): RemixClient {
  const { namespace = "default", now = Date.now } = options;
  const keyOf = (anchorId: string) => `flowlet:remix:${namespace}:${anchorId}`;

  const storage = (): Storage => {
    const s = options.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) throw new Error("[flowlet] web storage unavailable in this environment");
    return s;
  };

  const read = (key: string): RemixPin | null => {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; record?: RemixPin };
      if (parsed.v === SCHEMA_VERSION && parsed.record) return parsed.record;
      console.warn(`[flowlet] skipping remix pin at "${key}" with unknown schema v${String(parsed.v)}`);
      return null;
    } catch {
      console.warn(`[flowlet] skipping malformed remix pin at "${key}"`);
      return null;
    }
  };

  return {
    async get(anchorId) {
      return read(keyOf(anchorId));
    },
    async pin(draft) {
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? read(keyOf(draft.anchorId))?.createdAt ?? updatedAt;
      const pin: RemixPin = { ...draft, createdAt, updatedAt };
      // Quota/security errors propagate to the caller — loud by design.
      storage().setItem(keyOf(draft.anchorId), JSON.stringify({ v: SCHEMA_VERSION, record: pin }));
      return pin;
    },
    async unpin(anchorId) {
      storage().removeItem(keyOf(anchorId));
    },
  };
}
