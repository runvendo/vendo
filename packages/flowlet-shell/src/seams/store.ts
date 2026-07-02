import type { UINode } from "@flowlet/core";

/** A saved flowlet per architecture Decision 6: tree + provenance + name/pin.
 *  Persisted by Flowlet. The bound data queries live INSIDE a generated node's
 *  payload (`queries`), so the record stays a self-contained artifact. */
export interface Flowlet {
  id: string;
  name: string;
  node: UINode;
  /** The user prompt that originally produced the view. */
  prompt?: string;
  pinned?: boolean;
  /** Stamped by the store on first save; preserved on later saves. */
  createdAt?: number;
  updatedAt: number;
}

export type FlowletDraft = Omit<Flowlet, "updatedAt"> & { updatedAt?: number };

/** Flowlet-owned persistence seam. The real client (sharing, cron) lands in F6/F7. */
export interface FlowletStore {
  list(): Promise<Flowlet[]>;
  load(id: string): Promise<Flowlet | null>;
  save(draft: FlowletDraft): Promise<Flowlet>;
  remove(id: string): Promise<void>;
}

let clock = 0;

/** In-memory default. Deterministic clock so tests need no Date.now(). */
export function createLocalStore(seed: Flowlet[] = []): FlowletStore {
  const map = new Map<string, Flowlet>(seed.map((f) => [f.id, f]));
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
      const flowlet: Flowlet = { ...draft, createdAt, updatedAt };
      map.set(flowlet.id, flowlet);
      return flowlet;
    },
    async remove(id) {
      map.delete(id);
    },
  };
}
