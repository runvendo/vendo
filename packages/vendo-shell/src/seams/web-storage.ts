import type { Vendo, VendoStore } from "./store";

export interface WebStorageOptions {
  /** Scope records (e.g. per user). Default "default". */
  namespace?: string;
  /** Injectable for tests/SSR; defaults to globalThis.localStorage at call time. */
  storage?: Storage;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * The real embedded-mode VendoStore over Web Storage (ENG-183). One key per
 * record under `vendo:saved:<namespace>:`. Failures are loud: an unavailable
 * or full storage throws — persistence must never silently no-op.
 */
/** Bump when the persisted record shape changes incompatibly; readers skip
 *  (and warn about) versions they don't know rather than mis-parsing them. */
const SCHEMA_VERSION = 1;

export function createWebStorage(options: WebStorageOptions = {}): VendoStore {
  const { namespace = "default", now = Date.now } = options;
  const prefix = `vendo:saved:${namespace}:`;
  const keyOf = (id: string) => prefix + id;

  const storage = (): Storage => {
    const s = options.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) throw new Error("[vendo] web storage unavailable in this environment");
    return s;
  };

  const read = (key: string): Vendo | null => {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; record?: Vendo } & Vendo;
      // Versioned envelope ({v, record}); bare records predate it (schema v1).
      if (parsed.v === undefined) return parsed as Vendo;
      if (parsed.v === SCHEMA_VERSION && parsed.record) return parsed.record;
      console.warn(`[vendo] skipping saved vendo at "${key}" with unknown schema v${String(parsed.v)}`);
      return null;
    } catch {
      console.warn(`[vendo] skipping malformed saved vendo at "${key}"`);
      return null;
    }
  };

  return {
    async list() {
      const s = storage();
      const out: Vendo[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key !== null && key.startsWith(prefix)) {
          const vendo = read(key);
          if (vendo) out.push(vendo);
        }
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async load(id) {
      return read(keyOf(id));
    },
    async save(draft) {
      const updatedAt = draft.updatedAt ?? now();
      const createdAt = draft.createdAt ?? read(keyOf(draft.id))?.createdAt ?? updatedAt;
      const vendo: Vendo = { ...draft, createdAt, updatedAt };
      // Quota/security errors propagate to the caller — loud by design.
      storage().setItem(keyOf(draft.id), JSON.stringify({ v: SCHEMA_VERSION, record: vendo }));
      return vendo;
    },
    async remove(id) {
      storage().removeItem(keyOf(id));
    },
  };
}
