/**
 * Sandbox host bundle for @flowlet/components. Loaded inside the Flowlet stage
 * via blob import(); React resolves through the stage's import map (shared shim).
 * Sets the three globals the stage runtime expects (see stage runtime loadBundle).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { prewiredImpls } from "../src/impls";

declare global {
  interface Window {
    __React: typeof React;
    __createRoot: typeof createRoot;
    __FLOWLET_HOST__: Record<string, unknown>;
  }
}

window.__React = React;
window.__createRoot = createRoot;
window.__FLOWLET_HOST__ = prewiredImpls as Record<string, unknown>;
