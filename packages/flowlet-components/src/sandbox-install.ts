/**
 * installFlowletHost — everything a sandbox host bundle entry must do, in one
 * call. A host app's bundle entry becomes:
 *
 *   import { installFlowletHost } from "@flowlet/components/sandbox";
 *   import { myHostImpls } from "../src/flowlet/host-components/impls";
 *   installFlowletHost(myHostImpls);
 *
 * Build it with `flowletHostPreset` from `@flowlet/stage/build` (externalizes
 * React so the stage's import map supplies the shared shim) and hand the
 * artifact to the stage as `bundleSource`.
 *
 * What it wires (the stage runtime's loadBundle contract):
 *  - window.__React / window.__createRoot — the shared React instance;
 *  - window.__FLOWLET_HOST__ — the pre-wired catalog merged with the host's
 *    own components (host names win; colliding with the catalog is allowed
 *    and shadows it deliberately);
 *  - window.__FLOWLET_THEME_WRAP__ — mounts OpenUI's ThemeProvider around the
 *    tree when the init payload carries a componentTheme;
 *  - OpenUI's base stylesheet, injected inline (the iframe cannot load
 *    external CSS under its CSP).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";
import { ThemeProvider } from "@openuidev/react-ui";
import openuiCss from "@openuidev/react-ui/index.css?inline";
import { prewiredImpls } from "./impls";

declare global {
  interface Window {
    __React: typeof React;
    __createRoot: typeof createRoot;
    __FLOWLET_HOST__: Record<string, unknown>;
    __FLOWLET_THEME_WRAP__?: (blob: unknown, children: unknown) => unknown;
  }
}

export function installFlowletHost(hostImpls: Record<string, ComponentType<Record<string, unknown>>> = {}): void {
  window.__React = React;
  window.__createRoot = createRoot;
  window.__FLOWLET_HOST__ = { ...prewiredImpls, ...hostImpls };

  window.__FLOWLET_THEME_WRAP__ = (blob, children) => {
    const b = blob as { mode?: "light" | "dark"; theme?: Record<string, unknown> } | undefined;
    return React.createElement(
      ThemeProvider,
      { mode: b?.mode ?? "light", lightTheme: b?.theme, darkTheme: b?.theme },
      children as React.ReactNode,
    );
  };

  const style = document.createElement("style");
  style.setAttribute("data-flowlet-openui", "");
  style.textContent = openuiCss;
  document.head.appendChild(style);
}
