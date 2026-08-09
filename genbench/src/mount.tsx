/**
 * The browser half of a benchmark page: the PRODUCT's own renderer, mounted the
 * way a host mounts it, with one recorder standing in for the host's tools.
 * Bundled once per run by `render.ts` and inlined into every page.
 */
import {
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
  type Json,
  type ToolOutcome,
  type UIPayload,
  type VendoTheme,
} from "@vendoai/core";
import { applyThemeVars } from "@vendoai/ui/kit";
import { PayloadView } from "@vendoai/ui/tree";
import { useEffect, type JSX } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    /** The one seam every contender's page answers through, injected by
     *  `render.ts` into hand-written and product-rendered pages alike. The
     *  renderer's action dispatch is wired to it below. */
    vendo: {
      calls: Array<{ name: string; args: Json }>;
      callTool(name: string, args: Json): ToolOutcome;
    };
    /** Set once the tree has committed and had two frames to draw. */
    __settled?: boolean;
  }
}

const read = <T,>(id: string): T => JSON.parse(document.getElementById(id)!.textContent!) as T;

applyThemeVars(themeCssVariables(resolveTheme(defaultVendoTheme, read<VendoTheme>("theme"))));
const payload = read<UIPayload>("payload");

function Screen(): JSX.Element {
  // Two frames after the commit: the Kit's charts size themselves off a
  // ResizeObserver, so the frame that mounts one is never the frame that draws it.
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.__settled = true;
      });
    });
  }, []);
  return (
    <PayloadView
      payload={payload}
      components={{}}
      data={(payload as { data?: Record<string, Json> }).data}
      onAction={async ({ action, payload: args }) => window.vendo.callTool(action, args ?? {})}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Screen />);
