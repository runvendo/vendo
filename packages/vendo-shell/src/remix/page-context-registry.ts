/**
 * PageContextRegistry (VendoRemix, 2026-07-04 spec): mounted VendoRemix
 * wrappers register here, giving every surface page awareness — plain Cmd+K
 * gets the visible anchors as ambient context, and the scoped overlay resolves
 * its anchor through `get`. One registry per VendoShellProvider instance.
 *
 * Rules (spec-fixed): registration follows mount lifecycle; duplicate ids are
 * last-mount-wins with a dev warning; caps are 32 anchors, 4 KB context per
 * anchor, 16 KB ambient total (largest contexts dropped first, anchors stay
 * listed); ambient never includes DOM snapshots — those travel only on an
 * explicit scoped open.
 */
import type { AnchorRef } from "@vendoai/core";

export const MAX_ANCHORS = 32;
export const PER_ANCHOR_CONTEXT_BYTES = 4 * 1024;
export const AMBIENT_TOTAL_BYTES = 16 * 1024;

export interface AnchorRegistration {
  anchorId: string;
  label?: string;
  context?: unknown;
  /** Captured lazily on scoped open — never read for ambient context. */
  getSnapshot?: () => string | undefined;
}

export interface PageContextRegistry {
  /** Register an anchor; returns its deregister function (call on unmount). */
  register(entry: AnchorRegistration): () => void;
  get(anchorId: string): AnchorRegistration | undefined;
  /** The page's anchors for ambient context: capped, snapshot-free. */
  ambient(): AnchorRef[];
}

const contextBytes = (context: unknown): number =>
  context === undefined ? 0 : JSON.stringify(context)?.length ?? 0;

export function createPageContextRegistry(): PageContextRegistry {
  // Insertion-ordered; re-registration moves the anchor to the back.
  const anchors = new Map<string, AnchorRegistration>();

  return {
    register(entry) {
      if (anchors.has(entry.anchorId)) {
        console.warn(
          `[vendo] duplicate VendoRemix id "${entry.anchorId}" — the last mounted wrapper wins`,
        );
        anchors.delete(entry.anchorId);
      } else if (anchors.size >= MAX_ANCHORS) {
        console.warn(
          `[vendo] more than ${MAX_ANCHORS} VendoRemix anchors mounted; "${entry.anchorId}" is not registered`,
        );
        return () => {};
      }
      anchors.set(entry.anchorId, entry);
      return () => {
        // Only remove if this registration still owns the id (a duplicate may
        // have replaced it; its own deregister must not evict the newcomer).
        if (anchors.get(entry.anchorId) === entry) anchors.delete(entry.anchorId);
      };
    },

    get(anchorId) {
      return anchors.get(anchorId);
    },

    ambient() {
      const refs: AnchorRef[] = [...anchors.values()].map((a) => ({
        anchorId: a.anchorId,
        ...(a.label !== undefined ? { label: a.label } : {}),
        ...(a.context !== undefined && contextBytes(a.context) <= PER_ANCHOR_CONTEXT_BYTES
          ? { context: a.context }
          : {}),
      }));
      // Enforce the total budget by dropping the LARGEST contexts first; the
      // anchors themselves stay listed so the agent still knows they exist.
      let total = refs.reduce((sum, r) => sum + contextBytes(r.context), 0);
      if (total > AMBIENT_TOTAL_BYTES) {
        const bySize = [...refs].sort((a, b) => contextBytes(b.context) - contextBytes(a.context));
        for (const ref of bySize) {
          if (total <= AMBIENT_TOTAL_BYTES) break;
          total -= contextBytes(ref.context);
          delete ref.context;
        }
        console.warn(
          `[vendo] page anchor context exceeds ${AMBIENT_TOTAL_BYTES} bytes; dropping largest contexts from ambient view`,
        );
      }
      return refs;
    },
  };
}
