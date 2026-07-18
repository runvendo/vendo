/** @vendoai/ui/tree — the format-dispatching tree renderer. */
export * from "./bindings.js";
export * from "./branded.js";
export * from "./frames.js";
export * from "./host-mount.js";
export * from "./jail/JailedComponent.js";
export * from "./primitives.js";
export * from "./renderer.js";
// Side-effect import: registers the vendo-genui/v2 renderer in the dispatch
// registry so PayloadView resolves v2 payloads.
import "./renderer-v2.js";
