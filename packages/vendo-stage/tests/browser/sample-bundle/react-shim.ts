/**
 * Vendo React shim — the ONE React for a shared-React stage.
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
// `export *` from CJS React is dropped by the lib build's interop (the built
// file ends up exporting only `default`), so any bundle with a static named
// import (`import { PureComponent } from "react"` — recharts does) fails to
// link. Explicit names survive the build; keep this list the public surface.
export {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} from "react";
export { createRoot } from "react-dom/client";
// The import map points "react-dom" here too; recharts/OpenUI import these.
// (No findDOMNode: React 19 removed it and no bundle imports it.)
export { createPortal, flushSync } from "react-dom";
// jsx / jsxs are used by the automatic JSX runtime transform.
export { jsx, jsxs } from "react/jsx-runtime";
