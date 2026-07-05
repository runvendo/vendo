import React from "react";

/**
 * Sample stand-in for the real @vendoai/components ThemeProvider contract.
 *
 * The stage runtime, when an init payload carries an opaque `componentTheme`,
 * mounts the host bundle's `window.__VENDO_THEME_WRAP__(blob, children)` around
 * the rendered tree (see runtime.ts buildElement). Here we implement that wrapper
 * with a tiny React context so a component nested in the tree can read a value
 * out of the opaque blob — proving the runtime↔bundle wrap contract end-to-end in
 * a real browser without pulling in OpenUI.
 */
export const SampleThemeContext = React.createContext<{ marker?: string } | null>(null);

/** Registered host component that surfaces `blob.marker` from the wrap context. */
export function ThemeProbe() {
  const ctx = React.useContext(SampleThemeContext);
  return <span data-theme-marker>{ctx?.marker ?? ""}</span>;
}

/**
 * Installs the bundle-supplied theme wrapper the runtime looks for. Uses the
 * bundle's own React so context identity matches the ThemeProbe consumer.
 */
export function installThemeWrap(): void {
  (globalThis as any).__VENDO_THEME_WRAP__ = (
    blob: unknown,
    children: React.ReactNode,
  ) => React.createElement(SampleThemeContext.Provider, { value: blob as { marker?: string } }, children);
}
