/**
 * The browser half of a benchmark page: the PRODUCT's own renderer, mounted the
 * way a host mounts it, with one recorder standing in for the host's tools.
 * Bundled once per run by `render.ts` and inlined into every page.
 */
import {
  type Json,
  type ToolOutcome,
  type UIPayload,
} from "@vendoai/core";
import {
  defaultVendoTheme,
  resolveTheme,
  themeCssVariables,
  type VendoTheme,
} from "@vendoai/apps/contract";
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

/**
 * A screen `PayloadView` has to boot a runtime for before it can paint.
 *
 * The tag is the payload's own: an interactive payload carries `interactive`
 * ({ compiledSource, queries }), and the renderer boots the VM behind that same
 * entry point. Nothing here reaches into it — the bundle already carries whatever
 * `PayloadView` imports.
 */
const interactive = (payload as { interactive?: unknown }).interactive !== undefined;

/**
 * The grace an interactive screen gets on top of its two frames, before the shot
 * is taken and the probe starts pressing.
 *
 * Flat, and only for those payloads. The tempting alternative — settle once the
 * DOM has been quiet for a frame or two — cannot tell "the VM has finished" from
 * "the VM has not started yet", which is precisely the race this exists to lose.
 * A second is nothing against a case that takes minutes, and it is spent by no
 * static screen.
 */
const VM_BOOT_MS = 1_000;

function Screen(): JSX.Element {
  // Two frames after the commit: the Kit's charts size themselves off a
  // ResizeObserver, so the frame that mounts one is never the frame that draws it.
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!interactive) {
          window.__settled = true;
          return;
        }
        setTimeout(() => {
          window.__settled = true;
        }, VM_BOOT_MS);
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
