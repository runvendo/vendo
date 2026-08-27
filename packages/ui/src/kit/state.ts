/**
 * The keyed `$state` store — ONE implementation, two venues.
 *
 * `$state` is a tree binding (`core/genui/tree-node.ts`), and the renderer
 * resolves it against a keyed `Record<string, Json>` owned by
 * `StatefulTreeView`. A code-land app needs the same store with the same
 * semantics, so it lives HERE — in the bundle both venues already share, the
 * way `reshape` does — instead of being written twice.
 *
 * Semantics (the renderer's, unchanged): one namespace per instance, `Json`
 * values, last write wins per key, and other keys stand.
 */

import type { Json } from "@vendoai/core";
import { useCallback, useRef, useState } from "react";

/** A `$state` namespace: keys the tree (or the app's code) binds to. */
export type KeyedState = Record<string, Json>;

/** The store, as a hook: `[state, setKey]`. */
export function useKeyedState(): [KeyedState, (key: string, value: Json) => void] {
  const [state, setState] = useState<KeyedState>({});
  // The ref carries the pending value so two writes in one tick compose
  // instead of the second overwriting the first.
  const latest = useRef(state);
  const setKey = useCallback((key: string, value: Json) => {
    const next = { ...latest.current, [key]: value };
    latest.current = next;
    setState(next);
  }, []);
  return [state, setKey];
}
