/**
 * `useVendoState` — the `$state` binding, in code-land (blueprint §5.4).
 *
 * The same keyed store the renderer resolves `{ $state: "tab" }` against
 * (`@vendoai/ui/kit`'s `useKeyedState`, owned by the provider): one namespace
 * per app instance, `Json` values, `[value, setValue]`. An unwritten key reads
 * as its `initial` — the fallback is a READ, never a write, so mounting a
 * component can never mutate the app's state.
 */

import type { Json } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoApp } from "./app-context.js";

export function useVendoState<T extends Json = Json>(
  key: string,
  initial?: T,
): [T | undefined, (value: T) => void] {
  const { state, setState } = useVendoApp();
  const setValue = useCallback((value: T) => setState(key, value), [setState, key]);
  const held = Object.prototype.hasOwnProperty.call(state, key) ? (state[key] as T) : initial;
  return [held, setValue];
}
