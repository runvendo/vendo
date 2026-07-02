/**
 * Sandbox host bundle for @flowlet/components. Loaded inside the Flowlet stage
 * via blob import(); React resolves through the stage's import map (shared shim).
 * Sets the three globals the stage runtime expects (see stage runtime loadBundle).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@openuidev/react-ui";
import { prewiredImpls } from "../src/impls";
// OpenUI's base stylesheet, inlined as a string (?inline) and injected at
// module eval. Without it every catalog component renders as bare HTML in the
// sandbox: the iframe cannot load external stylesheets (CSP default-src
// 'none'), so the CSS must travel inside the JS artifact. The srcdoc CSP
// allows style-src 'unsafe-inline'.
import openuiCss from "@openuidev/react-ui/index.css?inline";

const openuiStyle = document.createElement("style");
openuiStyle.setAttribute("data-flowlet-openui", "");
openuiStyle.textContent = openuiCss;
document.head.appendChild(openuiStyle);

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
