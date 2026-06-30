import type { UINode } from "@flowlet/core";

/** A saved flowlet: a generated UI node plus identity. Persisted by Flowlet. */
export interface Flowlet {
  id: string;
  name: string;
  node: UINode;
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
      const flowlet: Flowlet = { ...draft, updatedAt: draft.updatedAt ?? ++clock };
      map.set(flowlet.id, flowlet);
      return flowlet;
    },
    async remove(id) {
      map.delete(id);
    },
  };
}
