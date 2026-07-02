import type { Flowlet, FlowletStore } from "./store";

export interface WebStorageOptions {
  /** Scope records (e.g. per user). Default "default". */
  namespace?: string;
  /** Injectable for tests/SSR; defaults to globalThis.localStorage at call time. */
  storage?: Storage;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

/**
 * The real embedded-mode FlowletStore over Web Storage (ENG-183). One key per
 * record under `flowlet:saved:<namespace>:`. Failures are loud: an unavailable
 * or full storage throws — persistence must never silently no-op.
 */
export function createWebStorage(options: WebStorageOptions = {}): FlowletStore {
  const { namespace = "default", now = Date.now } = options;
  const prefix = `flowlet:saved:${namespace}:`;
  const keyOf = (id: string) => prefix + id;

  const storage = (): Storage => {
    const s = options.storage ?? (globalThis as { localStorage?: Storage }).localStorage;
    if (!s) throw new Error("[flowlet] web storage unavailable in this environment");
    return s;
  };

  const read = (key: string): Flowlet | null => {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Flowlet;
    } catch {
      console.warn(`[flowlet] skipping malformed saved flowlet at "${key}"`);
      return null;
    }
  };

  return {
    async list() {
      const s = storage();
      const out: Flowlet[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key !== null && key.startsWith(prefix)) {
          const flowlet = read(key);
          if (flowlet) out.push(flowlet);
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
      const flowlet: Flowlet = { ...draft, createdAt, updatedAt };
      // Quota/security errors propagate to the caller — loud by design.
      storage().setItem(keyOf(draft.id), JSON.stringify(flowlet));
      return flowlet;
    },
    async remove(id) {
      storage().removeItem(keyOf(id));
    },
  };
}
