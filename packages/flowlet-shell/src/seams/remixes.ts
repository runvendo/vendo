/**
 * Remix persistence seam (FlowletRemix, 2026-07-04 spec): the end user's
 * customization of a dev-wrapped host component, one pin per anchor for the
 * current user. Follows the FlowletStore client-seam pattern (seams/store.ts);
 * @flowlet/next's FlowletRoot provides a web-storage-backed client so pins
 * survive reloads without server state.
 */
import type { UINode } from "@flowlet/core";

export interface RemixPin {
  anchorId: string;
  node: UINode;
  /** The user prompt that produced the remix. */
  prompt?: string;
  /** Host-component name → registry version (ENG-186 drift semantics). */
  components?: Record<string, string>;
  /** Server-sealed authored state (remix fast-edits): opaque to the client;
   *  sent with scoped opens so later edits can patch base:"pin". */
  envelope?: string;
  /** Stamped by the store on first pin; preserved on later pins. */
  createdAt?: number;
  updatedAt: number;
}

export type RemixDraft = Omit<RemixPin, "updatedAt"> & { updatedAt?: number };

export interface RemixClient {
  get(anchorId: string): Promise<RemixPin | null>;
  /** Upsert: one pin per anchorId. */
  pin(draft: RemixDraft): Promise<RemixPin>;
  unpin(anchorId: string): Promise<void>;
}

let clock = 0;

/** In-memory default. Deterministic clock so tests need no Date.now(). */
export function createLocalRemixes(seed: RemixPin[] = []): RemixClient {
  const map = new Map<string, RemixPin>(seed.map((p) => [p.anchorId, p]));
  return {
    async get(anchorId) {
      return map.get(anchorId) ?? null;
    },
    async pin(draft) {
      const updatedAt = draft.updatedAt ?? ++clock;
      const createdAt = draft.createdAt ?? map.get(draft.anchorId)?.createdAt ?? updatedAt;
      const pin: RemixPin = { ...draft, createdAt, updatedAt };
      map.set(pin.anchorId, pin);
      return pin;
    },
    async unpin(anchorId) {
      map.delete(anchorId);
    },
  };
}
