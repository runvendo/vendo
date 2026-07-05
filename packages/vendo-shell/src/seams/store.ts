import type { UINode } from "@vendoai/core";

/** A saved vendo per architecture Decision 6: tree + provenance + name/pin.
 *  Persisted by Vendo. The bound data queries live INSIDE a generated node's
 *  payload (`queries`), so the record stays a self-contained artifact. */
export interface Vendo {
  id: string;
  name: string;
  node: UINode;
  /** The user prompt that originally produced the view. */
  prompt?: string;
  pinned?: boolean;
  /** Host-component name → registry version the view was saved against
   *  (ENG-186; see `stampHostComponents`). Absent on trees with no host nodes
   *  and on pre-versioning records — both diff as clean. */
  components?: Record<string, string>;
  /** Stamped by the store on first save; preserved on later saves. */
  createdAt?: number;
  updatedAt: number;
}

export type VendoDraft = Omit<Vendo, "updatedAt"> & { updatedAt?: number };

/** Vendo-owned persistence seam. The real client (sharing, cron) lands in F6/F7. */
export interface VendoStore {
  list(): Promise<Vendo[]>;
  load(id: string): Promise<Vendo | null>;
  save(draft: VendoDraft): Promise<Vendo>;
  remove(id: string): Promise<void>;
}

let clock = 0;

/** In-memory default. Deterministic clock so tests need no Date.now(). */
export function createLocalStore(seed: Vendo[] = []): VendoStore {
  const map = new Map<string, Vendo>(seed.map((f) => [f.id, f]));
  return {
    async list() {
      return [...map.values()];
    },
    async load(id) {
      return map.get(id) ?? null;
    },
    async save(draft) {
      const updatedAt = draft.updatedAt ?? ++clock;
      const createdAt = draft.createdAt ?? map.get(draft.id)?.createdAt ?? updatedAt;
      const vendo: Vendo = { ...draft, createdAt, updatedAt };
      map.set(vendo.id, vendo);
      return vendo;
    },
    async remove(id) {
      map.delete(id);
    },
  };
}
