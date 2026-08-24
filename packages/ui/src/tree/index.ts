"use client";

/** @vendoai/ui/tree — the format-dispatching tree renderer. */
export { resolvePointer } from "./bindings.js";
export { AppFrame, PinMount, type AppFrameProps } from "./frames.js";
export {
  PayloadView,
  TreeView,
  isActionBinding,
  isHandlerBinding,
  type ParkedPress,
  type PayloadRendererProps,
  type TreeViewProps,
  type WalkTree,
} from "./renderer.js";
/** The interactive payload's shape. The engine behind it is loaded on demand
 *  (screen-engine.ts), so only the contract is public. */
export type { Intent, ScreenInteractive, ScreenQuery } from "./screen-engine.js";
