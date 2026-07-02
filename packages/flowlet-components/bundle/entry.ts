/**
 * Sandbox host bundle for @flowlet/components. Loaded inside the Flowlet stage
 * via blob import(); React resolves through the stage's import map (shared shim).
 * Sets the three globals the stage runtime expects (see stage runtime loadBundle).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@openuidev/react-ui";
import { prewiredImpls } from "../src/impls";

declare global {
  interface Window {
    __React: typeof React;
    __createRoot: typeof createRoot;
    __FLOWLET_HOST__: Record<string, unknown>;
    __FLOWLET_THEME_WRAP__?: (blob: any, children: any) => any;
  }
}

window.__React = React;
window.__createRoot = createRoot;
window.__FLOWLET_HOST__ = prewiredImpls as Record<string, unknown>;

// Opaque-to-the-stage theme wrapper: the generic runtime mounts this around the
// rendered tree when an init payload carries `componentTheme`. Keeps @flowlet/stage
// decoupled from @flowlet/components/OpenUI — only this bundle knows the shape.
window.__FLOWLET_THEME_WRAP__ = (blob, children) =>
  React.createElement(
    ThemeProvider,
    { mode: blob?.mode ?? "light", lightTheme: blob?.theme, darkTheme: blob?.theme },
    children,
  );
