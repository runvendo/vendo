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
 *    own components (a host name colliding with a catalog component THROWS —
 *    silent shadowing would desync the sandbox from the registry/prompt);
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

export interface InstallFlowletHostOptions {
  /**
   * Host CSS injected into the sandbox document alongside OpenUI's stylesheet.
   * Registered host components that rely on app classes (Tailwind utilities,
   * design-system CSS) ship the rules they need here — the manual form of what
   * the ENG-197 extractor will eventually emit automatically.
   */
  css?: string;
}

export function installFlowletHost(
  hostImpls: Record<string, ComponentType<Record<string, unknown>>> = {},
  options: InstallFlowletHostOptions = {},
): void {
  // Fail fast on catalog collisions: a host registration silently shadowing a
  // catalog component would desync the sandbox from the registry/prompt.
  for (const name of Object.keys(hostImpls)) {
    if (name in prewiredImpls) {
      throw new Error(
        `installFlowletHost: host component "${name}" collides with a catalog component — rename it (e.g. prefix with your app name)`,
      );
    }
  }

  window.__React = React;
  window.__createRoot = createRoot;
  window.__FLOWLET_HOST__ = { ...prewiredImpls, ...hostImpls };

  if (options.css) {
    const hostStyle = document.createElement("style");
    hostStyle.setAttribute("data-flowlet-host-css", "");
    hostStyle.textContent = options.css;
    document.head.appendChild(hostStyle);
  }

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
