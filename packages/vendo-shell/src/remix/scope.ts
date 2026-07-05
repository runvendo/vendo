/**
 * Anchor scope store (VendoRemix, 2026-07-04 spec): which anchor, if any,
 * the shared overlay is currently scoped to. A VendoRemix affordance click
 * calls `open(scope)`; the overlay subscribes and opens; closing the overlay
 * clears the scope. External-store shape (not provider state) so a scope
 * change re-renders only the surfaces that subscribe, never the host app.
 */

export interface AnchorScope {
  anchorId: string;
  label?: string;
  context?: unknown;
  /** DOM baseline captured at open time (snapshotElement). */
  snapshot?: string;
  /** The current pin's sealed envelope (remix fast-edits): rides the scoped
   *  send so the server can verify it and offer base:"pin" editing. */
  envelope?: string;
}

export interface ScopeStore {
  /** Scope the shared overlay to an anchor (subscribers open the surface). */
  open(scope: AnchorScope): void;
  clear(): void;
  current(): AnchorScope | null;
  subscribe(listener: () => void): () => void;
}

export function createScopeStore(): ScopeStore {
  let scope: AnchorScope | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());
  return {
    open(next) {
      scope = next;
      notify();
    },
    clear() {
      if (scope === null) return;
      scope = null;
      notify();
    },
    current: () => scope,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
