/** @vendoai/ui/tree — the format-dispatching tree renderer. */
export * from "./bindings.js";
export * from "./frames.js";
export * from "./host-mount.js";
export * from "./renderer.js";
/** The interactive payload's shape. The engine behind it is loaded on demand
 *  (screen-engine.ts), so only the contract is public. */
export type { Intent, ScreenInteractive, ScreenQuery } from "./screen-engine.js";
