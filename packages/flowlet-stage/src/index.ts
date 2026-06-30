import type { ActionRequest, ActionResult } from "@flowlet/core";
export * from "./protocol";
export * from "./bridge";
export { STAGE_RUNTIME_SRC } from "./runtime";

/** CSS-variable brand tokens, e.g. { "--brand-primary": "#0a7" }. */
export type ThemeTokens = Record<string, string>;

/** Scoped, structured-clone-safe state slice projected into the stage. */
export type StateProjection = Record<string, unknown>;

/** A resolved host/prewired component implementation (framework type kept opaque here). */
export type ComponentImpl = unknown;

/**
 * The stage capabilities F3a provides and F3b's renderer consumes. Frozen from the
 * F3a spike (spec §7). `subscribe` is provisional — not exercised by the spike.
 */
export interface StageCapabilities {
  resolveComponent(name: string, source: "prewired" | "host"): ComponentImpl | undefined;
  theme: ThemeTokens;
  getState(): Readonly<StateProjection>;
  subscribe(cb: () => void): () => void;
  dispatch(action: ActionRequest): Promise<ActionResult>;
}
