/**
 * Flowlet React shim — the ONE React for a shared-React stage.
 *
 * This module is built as a self-contained ESM file and delivered into the
 * sandbox as a blob: URL. The sandbox's import map points "react",
 * "react-dom/client", and "react/jsx-runtime" at this blob URL so that every
 * host bundle resolves to the same module cache entry.
 *
 * window.__reactShimLoadCount is incremented once per module load; with proper
 * import-map caching it should stay at 1 across all bundle imports.
 */
(globalThis as any).__reactShimLoadCount =
  ((globalThis as any).__reactShimLoadCount || 0) + 1;

// Re-export everything host bundles may need from the three React packages.
export { default } from "react";
export * from "react";
export { createRoot } from "react-dom/client";
// jsx / jsxs are used by the automatic JSX runtime transform.
export { jsx, jsxs } from "react/jsx-runtime";
