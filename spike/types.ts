import type { UINode, ActionRequest, ActionResult } from "@flowlet/core";
export type { UINode, ActionRequest, ActionResult };

export interface ThemeTokens { [cssVar: string]: string } // e.g. { "--brand-primary": "#0a7" }
export type StateProjection = Record<string, unknown>;      // scoped, structured-clone-safe only

export interface InitPayload {
  theme: ThemeTokens;
  state: StateProjection;
  bundleSource: string; // the host bundle ESM text, delivered as DATA (not a URL)
  tree: UINode;
}
